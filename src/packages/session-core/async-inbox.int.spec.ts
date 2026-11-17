/**
 * 异步输入收件箱（迁自 `scripts/async-inbox-test.mjs`）。
 *
 * 事故形状：回合跑动中到达的 user 输入（轮中途插话、后台作业完成通知）原先直接
 * `appendUser`——若此刻还有没落结果的 tool 调用（最典型：调用正等审批），消息就插在
 * `tool_calls` 和它的结果中间，DeepSeek 网关按「结果必须紧跟 tool_calls」判 400，
 * 这条会话之后每轮请求都被拒（卡死）。修法：跑动中改入箱（`async-inbox` 状态条目
 * 持久化），步骤边界 / 回合收尾才落库；加载时清遗债；请求侧邻接重排兜底存量。
 *
 * ## 为什么用注入 `stream` 的 MiniAgent，而不是起内核 + 假端点
 *
 * 这一层要钉的是**循环里的入箱时序**（谁先进箱、谁在哪个边界出账），不是 HTTP。
 * 原探针就是直接 `new MiniAgent(deps, session)`，`stream` 是注入的一个函数——这是
 * 循环自己的公开缝，不是测试自己搭的旁路。用假端点反而要赌「哪个请求先到」。
 *
 * 隔离：每条用例自己的工作目录（`mkdtempSync`），真实 `~/.dsc` 一个字节都不动。
 *
 * @module dsc/packages/session-core/async-inbox.int.spec
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { sanitizeToolOrphansWithReport } from '../../core/llm.js'
import { Session } from '../../core/session.js'
import { MiniAgent } from './loop.js'

/** 循环发出来的一条事件：本文件只读 `type` / `text` / `steering` / `origin`。 */
interface SeenEvent {
  type: string
  text?: string
  steering?: boolean
  origin?: string
}

/** 一条会话里某角色消息的正文（多模态消息只取文本段）。 */
function textOf(message: { role: string; content: unknown }): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type: string; text: string } => (part as { type?: string }).type === 'text')
      .map((part) => part.text)
      .join('')
  }
  return ''
}

/** 各角色的正文清单，按消息顺序。 */
function textsOf(session: Session, role: string): string[] {
  return session.messages.filter((message) => message.role === role).map((message) => textOf(message))
}

/** 消息角色序列（一条逗号分隔的串，红了能直接看出先后）。 */
function rolesOf(session: Session): string {
  return session.messages.map((message) => message.role).join(',')
}

/** 等到条件成立；超时返回 false（由断言报出可读错误）。 */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 新建一个工作目录 + 会话文件。 */
function newSession(name: string): { session: Session; work: string; file: string } {
  const work = mkdtempSync(join(tmpdir(), `dsc-inbox-${name}-`))
  const file = join(work, `${name}.jsonl`)
  return { session: Session.create(work, file), work, file }
}

describe('① 工具执行期间到达的机器通知：落库在 tool 结果之后', () => {
  const events: SeenEvent[] = []
  let session: Session
  let agent: MiniAgent
  let modelCalls = 0
  /** 工具执行期间拍下的现场：已入箱、还没画气泡。 */
  let duringTool: { userEvents: number; inboxEvents: number; inbox: string[] } | null = null

  beforeAll(async () => {
    const created = newSession('tool-window')
    session = created.session
    agent = new MiniAgent(
      {
        route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
        systemPrompt: () => ({ text: '', sections: [] }),
        tools: () => [
          {
            name: 'slow_thing',
            description: '',
            parameters: { type: 'object', properties: {} },
            risk: 'read',
            run: async () => {
              // 工具还在跑（等价于调用正等审批）：此刻作业完成通知到达。
              // 带 'notice'：只有机器来源才会在步骤边界出账，见 describe ⑧。
              agent.followup('后台作业 job-1 成功完成。', undefined, 'notice')
              duringTool = {
                userEvents: events.filter((event) => event.type === 'user').length,
                inboxEvents: events.filter((event) => event.type === 'inbox').length,
                inbox: session.asyncInbox().map((item) => item.text),
              }
              return 'ok'
            },
          },
        ],
        guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
        emit: (event) => events.push(event as SeenEvent),
        stream: async () => {
          modelCalls += 1
          if (modelCalls === 1) {
            return {
              text: '',
              reasoning: '',
              toolCalls: [{ id: 't1', name: 'slow_thing', arguments: '{}' }],
              usage: null,
              finishReason: 'tool_calls',
            }
          }
          return { text: 'done', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
        },
      },
      session,
    )
    agent.followup('开跑')
    await until(() => !agent.isRunning, 10_000)
  })

  test('通知落在 tool 结果之后（不在 call 与结果中间）', () => {
    // 顺序错了就是 0.6.46 那次「每轮都 400」的形状：user 夹在 assistant(tool_calls) 与 tool 之间。
    expect(rolesOf(session)).toBe('user,assistant,tool,user,assistant')
  })

  test('通知正文原样落库', () => {
    expect(textsOf(session, 'user')[1]).toBe('后台作业 job-1 成功完成。')
  })

  test('出账后收件箱清空', () => {
    expect(session.state('async-inbox')?.items ?? []).toHaveLength(0)
  })

  test('入箱期间不画气泡（user 事件只发了「开跑」那条）', () => {
    expect(duringTool?.userEvents).toBe(1)
  })

  test('入箱期间快照队列读得到这条', () => {
    expect(duringTool?.inbox).toEqual(['后台作业 job-1 成功完成。'])
  })

  test('入箱发了 inbox 事件（快照据此重画队列条）', () => {
    expect(duringTool?.inboxEvents).toBe(1)
  })

  test('user 事件每条消息只发一次（都在出账时发）', () => {
    const userEvents = events.filter((event) => event.type === 'user')
    expect(userEvents.map((event) => event.text)).toEqual(['开跑', '后台作业 job-1 成功完成。'])
  })

  test('步骤边界出账的通知带 steering 标记（并进本轮）', () => {
    const userEvents = events.filter((event) => event.type === 'user')
    expect(userEvents[1]?.steering).toBe(true)
  })
})

describe('③ 模型收尾流式期间到达的插话 → 收尾出账 + 补一轮', () => {
  let session: Session
  let agent: MiniAgent
  const events: SeenEvent[] = []
  let modelCalls = 0

  beforeAll(async () => {
    session = newSession('stream-tail').session
    agent = new MiniAgent(
      {
        route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
        systemPrompt: () => ({ text: '', sections: [] }),
        tools: () => [],
        guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
        emit: (event) => events.push(event as SeenEvent),
        stream: async () => {
          modelCalls += 1
          if (modelCalls === 1) {
            // 最后一轮流式期间用户插话：本轮已经来不及带上了
            setTimeout(() => agent.followup('等等，还有一件事'), 0)
            await new Promise((resolve) => setTimeout(resolve, 10))
            return { text: '第一轮答案', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
          }
          return { text: '补轮答复', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
        },
      },
      session,
    )
    agent.followup('问点什么')
    await until(() => !agent.isRunning, 10_000)
    // 收尾还有一段异步补轮，等它把第二轮跑完。
    await until(() => modelCalls >= 2, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test('插话不丢：收尾出账后补了一轮', () => {
    expect(modelCalls).toBe(2)
  })

  test('插话落在第一轮答案之后，第二轮答复也落了库', () => {
    expect(textsOf(session, 'user')[1]).toBe('等等，还有一件事')
    expect(textsOf(session, 'assistant')[1]).toBe('补轮答复')
    expect(rolesOf(session)).toBe('user,assistant,user,assistant')
  })

  test('收尾出账的那条不算轮中途插话（不带 steering）', () => {
    const userEvents = events.filter((event) => event.type === 'user')
    expect(userEvents[1]?.steering).toBeUndefined()
  })
})

describe('④ 入箱后没出账就重开日志 → 加载时清遗债', () => {
  test('遗债在加载时落库，收件箱清空', async () => {
    const { session, file } = newSession('reload')
    session.appendUser('第一条')
    session.enqueueAsync('欠的输入')
    session.enqueueAsync('带图的欠债', ['data:image/png;base64,AAA'])
    // 写走的是缓冲流，重开前先收流；冲刷是异步的，立刻重开读不到刚写的内容。
    session.close()
    await new Promise((resolve) => setTimeout(resolve, 120))

    const reopened = Session.load(file, true)
    expect(textsOf(reopened, 'user')).toEqual(['第一条', '欠的输入', '带图的欠债'])
    expect(reopened.state('async-inbox')?.items ?? []).toHaveLength(0)
    reopened.close()
  })
})

describe('⑤ turn/end 监听里紧跟的 followup 不丢', () => {
  let session: Session
  let modelCalls = 0

  beforeAll(async () => {
    session = newSession('turn-end').session
    let agent: MiniAgent
    agent = new MiniAgent(
      {
        route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
        systemPrompt: () => ({ text: '', sections: [] }),
        tools: () => [],
        guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
        emit: (event) => {
          // 关窗场景：turn/end 到达那一刻 running 仍为 true，此刻 followup 最容易丢。
          if (event.type === 'turn/end' && modelCalls === 1) agent.followup('紧跟着的追问')
        },
        stream: async () => {
          modelCalls += 1
          return { text: `答案${modelCalls}`, reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
        },
      },
      session,
    )
    agent.followup('第一问')
    await until(() => !agent.isRunning, 10_000)
    await until(() => modelCalls >= 2, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test('turn/end 后立刻 followup：补轮跑起来', () => {
    expect(modelCalls).toBe(2)
  })

  test('追问落在第一答之后且被回复', () => {
    expect(textsOf(session, 'user')[1]).toBe('紧跟着的追问')
    expect(textsOf(session, 'assistant')[1]).toBe('答案2')
  })

  test('收件箱无残留', () => {
    expect(session.state('async-inbox')?.items ?? []).toHaveLength(0)
  })
})

describe('⑥ 存量夹层日志 → sanitize 邻接重排', () => {
  /** 一份 0.6.46 真实会话的形状：user 通知夹在 tool_calls 与结果中间。 */
  const LINES = (cwd: string): Array<Record<string, unknown>> => [
    { type: 'meta', id: 'sandwich', cwd, createdAt: Date.now() },
    { type: 'user', text: '开跑' },
    { type: 'assistant', text: '', reasoning: '', toolCalls: [{ id: 'call_q', name: 'bash', arguments: '{}' }] },
    { type: 'user', text: '后台作业 job-2 成功完成。' },
    { type: 'tool', callId: 'call_q', name: 'bash', text: '用户拒绝了这次工具调用。' },
    { type: 'user', text: '怎么了' },
  ]

  let session: Session
  let report: ReturnType<typeof sanitizeToolOrphansWithReport>['report']
  let messages: ReturnType<typeof sanitizeToolOrphansWithReport>['messages']
  let originalLength = 0

  beforeAll(() => {
    const work = mkdtempSync(join(tmpdir(), 'dsc-inbox-sandwich-'))
    const file = join(work, 's4.jsonl')
    writeFileSync(file, `${LINES(work).map((line) => JSON.stringify(line)).join('\n')}\n`)
    session = Session.load(file, true)
    originalLength = session.messages.length
    ;({ messages, report } = sanitizeToolOrphansWithReport(session.messages))
  })

  test('重排后 tool_calls 紧跟 tool 结果（没有缝）', () => {
    const seam = messages.findIndex(
      (message, index) =>
        index < messages.length - 1 && (message.tool_calls?.length ?? 0) > 0 && messages[index + 1]?.role !== 'tool',
    )
    expect(seam).toBe(-1)
  })

  test('重排记账 = 1 条', () => {
    expect(report.reordered).toBe(1)
  })

  test('重排不丢消息（条数不变）', () => {
    expect(messages).toHaveLength(originalLength)
  })

  test('重排后顺序 = call,结果,通知,提问', () => {
    expect(messages.map((message) => message.role).join(',')).toBe('user,assistant,tool,user,user')
  })
})

describe('⑦ 队列条的三动作：编辑 / 删除 / 插话', () => {
  let session: Session
  let agent: MiniAgent
  const events: SeenEvent[] = []
  let modelCalls = 0
  let secondAndThirdQueued = false

  beforeAll(async () => {
    session = newSession('queue-actions').session
    agent = new MiniAgent(
      {
        route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
        systemPrompt: () => ({ text: '', sections: [] }),
        tools: () => [],
        guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
        emit: (event) => events.push(event as SeenEvent),
        stream: async () => {
          modelCalls += 1
          if (modelCalls === 1) {
            // 第一轮流得慢：这中间用户又发了两条，都进收件箱
            setTimeout(() => {
              agent.followup('第二条')
              agent.followup('第三条')
            }, 0)
            await new Promise((resolve) => setTimeout(resolve, 40))
            return { text: '第一答', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
          }
          return { text: '第二答', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
        },
      },
      session,
    )
    agent.followup('第一条')
    // 等两条都入箱：此时队列该有 2 条、对话里还看不见它们。
    secondAndThirdQueued = await until(() => session.asyncInbox().length >= 2, 5_000)
  })

  test('入箱期间队列条读得到两条，对话里没有它们', () => {
    expect(secondAndThirdQueued).toBe(true)
    expect(session.asyncInbox().map((item) => item.text)).toEqual(['第二条', '第三条'])
    expect(textsOf(session, 'user')).toEqual(['第一条'])
  })

  test('编辑改的是收件箱那一条；空白正文不接受', () => {
    expect(agent.editQueued(1, '第三条（改过）')).toBe(true)
    expect(session.asyncInbox()[1]?.text).toBe('第三条（改过）')
    expect(agent.editQueued(1, '   ')).toBe(false)
    expect(session.asyncInbox()[1]?.text).toBe('第三条（改过）')
  })

  test('删除撤掉一条；越界的编辑/删除是空操作', () => {
    expect(agent.removeQueued(0)).toBe(true)
    expect(session.asyncInbox().map((item) => item.text)).toEqual(['第三条（改过）'])
    expect(agent.editQueued(9, 'x')).toBe(false)
    expect(agent.removeQueued(9)).toBe(false)
  })

  test('插话打断当前回合，之后模型接着答了新一轮', async () => {
    expect(agent.steerQueued(0)).toBe(true)
    await until(() => !agent.isRunning, 10_000)
    await until(() => modelCalls >= 2, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(modelCalls).toBe(2)
    expect(textsOf(session, 'assistant')).toEqual(['第一答', '第二答'])
  })

  test('被删掉的那条一条都没进对话', () => {
    expect(textsOf(session, 'user')).toEqual(['第一条', '第三条（改过）'])
  })

  test('插话出账后队列清空；回合没在跑时插话是空操作', () => {
    expect(session.asyncInbox()).toHaveLength(0)
    expect(agent.steerQueued()).toBe(false)
  })

  test('插话那条是收尾出账（属于新一轮，不带 steering）', () => {
    const steered = events.filter((event) => event.type === 'user').at(-1)
    expect(steered?.text).toBe('第三条（改过）')
    expect(steered?.steering).toBeUndefined()
  })
})

describe('⑧ 步骤边界只出账通知，用户排队的留在收件箱里', () => {
  let session: Session
  let agent: MiniAgent
  const events: SeenEvent[] = []
  /** 通知在步骤边界出账的那一刻拍下的现场。 */
  let boundary: { inbox: string[]; steering?: boolean; inMessages: string[] } | null = null

  beforeAll(async () => {
    session = newSession('boundary').session
    agent = new MiniAgent(
      {
        route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
        systemPrompt: () => ({ text: '', sections: [] }),
        tools: () => [
          {
            name: 'slow_thing',
            description: '',
            parameters: { type: 'object', properties: {} },
            risk: 'read',
            run: async () => {
              // 同一次工具执行里：用户回车排队（缺省来源 'user'）+ 后台作业完成通知。
              agent.followup('我排队的这句')
              agent.followup('后台作业 job-7 成功完成。', undefined, 'notice')
              return 'ok'
            },
          },
        ],
        guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
        emit: (event) => {
          const seen = event as SeenEvent
          events.push(seen)
          if (seen.type === 'user' && seen.origin === 'notice') {
            boundary = {
              inbox: session.asyncInbox().map((item) => item.text),
              steering: seen.steering,
              inMessages: textsOf(session, 'user'),
            }
          }
        },
        stream: async () => {
          const call = events.filter((event) => event.type === 'message').length
          if (call === 0) {
            return {
              text: '',
              reasoning: '',
              toolCalls: [{ id: 't7', name: 'slow_thing', arguments: '{}' }],
              usage: null,
              finishReason: 'tool_calls',
            }
          }
          return { text: '收到', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
        },
      },
      session,
    )
    agent.followup('开跑')
    await until(() => !agent.isRunning, 10_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  test('步骤边界出账后用户那条仍在收件箱里（长度不变、位置仍是队首）', () => {
    expect(boundary?.inbox).toEqual(['我排队的这句'])
  })

  test('同一次边界上作业通知已经落库并进本轮（带 steering）', () => {
    expect(boundary?.inMessages).toEqual(['开跑', '后台作业 job-7 成功完成。'])
    expect(boundary?.steering).toBe(true)
  })

  test('收尾才出账用户那条：顺序在通知之后', () => {
    expect(textsOf(session, 'user')).toEqual(['开跑', '后台作业 job-7 成功完成。', '我排队的这句'])
  })

  test('收尾出账的用户条目不带 steering（属于下一轮，不是插话）', () => {
    const tail = events.filter((event) => event.type === 'user').at(-1)
    expect(tail?.text).toBe('我排队的这句')
    expect(tail?.steering).toBeUndefined()
  })

  test('收尾出账后队列清空', () => {
    expect(session.asyncInbox()).toHaveLength(0)
  })
})
