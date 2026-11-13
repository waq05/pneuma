/**
 * todo 节流提醒的**注入节流**（迁自 `scripts/todo-reminder-cadence-test.mjs` 第 [7] 节）。
 *
 * ## 这一段为什么必须起真内核
 *
 * 「提醒每 8 轮才响一次，中间整整一个周期一条都没有」是投影在**同一条会话的连续多轮**上
 * 才显出来的性质。台账（`core/todo-reminder-cadence.ts`）的纯逻辑在
 * `src/core/todo-reminder-cadence.spec.ts` 里已经逐条钉过，但「投影真的把台账接上了」只有
 * 走真投影链才验得到：拆掉台账，它会从「只注入 2 次」变成「越过后每跳一条」。
 *
 * ## 为什么前半段跑真回合、后半段直接驱动投影
 *
 * 前半段（第 1..9 轮）跑真内核 + 假模型端点，抓每一次**真实请求体**：首次注入落在第 9 轮、
 * 位置在请求末尾，这一段只有真回合才验得到，顺带证明「注入不改会话日志」。
 *
 * 后半段（第 10..17 轮）改用 `prompt.rewrite` 直接驱动**同一条会话的真投影链**：台账是
 * 按会话 id、按轮号记账的，第二轮周期要等到第 17 轮才该响——真跑 8 个回合只是让同一个
 * 判据多绕一圈模型，换来 10 秒开销与 60s 预算风险（实测撞过一次），不加信息量。
 *
 * ## 为什么把别的会发请求的插件都关掉
 *
 * 前半段的判据落在「第几次请求」上。长期记忆会在回合收尾多发一次请求、标题插件会自己起
 * 一轮——序号一乱，断言看起来就像「提醒乱发」。harness 默认关了 memory / sandbox /
 * session-title，这里与探针同一份清单。
 *
 * ## 迁移时删掉的五条
 *
 * 原探针第 [6] 节是五条**源码文本断言**（投影 import 了台账、构造了台账、`due` 在试注入
 * 之前、「没补就原样返回」在 `mark` 之前、`mark` 在 append 之后）。它们钉的是字符位置，
 * 按本批规矩不搬；其语义由本文件的两段覆盖：第一段验「真注入了才有下一周期的等待」，
 * 第二段验「周期刻度由台账决定」。
 *
 * @module dsc/tests/integration/todo-reminder-cadence.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { countRounds } from '@pneuma/runtime/core/todo-reminder-cadence.js'
import { TODO_REMINDER_TEXT } from '@pneuma/runtime/core/todo-reminder.js'
import {
  bootKernel,
  fakeLLM,
  readSessionJsonl,
  tempHome,
  type BootedKernel,
  type FakeLLM,
} from '../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-todo-cadence-')

/** 默认每 8 轮提醒一次：第 9 轮首次、第 17 轮再次。 */
const EVERY_ROUNDS = 8
/** 真回合跑到第几轮：第 9 轮正好是首次注入，再多两轮证明「注入之后会沉下去」。 */
const REAL_TURNS = 11

/**
 * 预置插件清单：harness 的三条（memory / sandbox / session-title）。
 *
 * 必须在 `bootKernel` 之前写：harness 只在文件不存在时才铺默认清单（它不覆盖调用方预置的）。
 */
mkdirSync(join(home.home, '.dsc'), { recursive: true })
writeFileSync(
  join(home.home, '.dsc', 'plugins.json'),
  `${JSON.stringify(
    {
      version: 1,
      entries: [
        { file: 'memory', config: { enabled: false } },
        { file: 'sandbox', disabled: true },
        { file: 'session-title', disabled: true },
      ],
    },
    null,
    2,
  )}\n`,
  'utf8',
)

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface SessionView {
  meta: { id: string; cwd: string }
}

interface Services {
  session: { current(): SessionView & { filePath: string; messages: readonly ChatMessage[] } }
  prompt: { rewrite(messages: ChatMessage[], session: SessionView): ChatMessage[] }
}

/** 一次真实请求的判定：请求序号（1 起）、这一跳的轮号、有没有带提醒。 */
interface RequestVerdict {
  request: number
  rounds: number
  reminder: boolean
}

let llm: FakeLLM
let kernel: BootedKernel
let services: Services

/**
 * 已经跑到第几轮。
 *
 * 为什么要记：integration project 开了 `retry: 1`。一条用例红了会被重跑一遍，而这里的用例
 * 会**推进会话**——重跑时再跑一遍同样的回合，请求序号就漂了，后面的断言全部错位成假失败。
 * 每个阶段只推进到「自己需要的那一轮」为止，重试时不再推进。
 */
let turnsDone = 0

/** 推进到第 `target` 轮（已经过了就什么都不做）。 */
async function ensureTurns(target: number): Promise<void> {
  for (let turn = turnsDone + 1; turn <= target; turn += 1) await kernel.runTurn(`第 ${String(turn)} 轮`)
  turnsDone = Math.max(turnsDone, target)
}

beforeAll(async () => {
  llm = await fakeLLM({
    turns: [{ toolCall: { name: 'todo_write', args: { todos: [{ content: '跑完 18 轮', status: 'in_progress' }] } } }, '收到'],
  })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  services = kernel.ctx as unknown as Services
  // 第 1 轮就立好清单；之后每轮一次请求，到第 9 轮正好攒够 8 轮。
  await ensureTurns(REAL_TURNS)
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

/** 到目前为止每一次会话请求的判定（标题请求不计入 `bodies`）。 */
function verdicts(): RequestVerdict[] {
  return llm.bodies.map((body, index) => {
    const messages = body as ChatMessage[]
    return {
      request: index + 1,
      rounds: countRounds(messages),
      reminder: messages.some((message) => message.role === 'user' && message.content === TODO_REMINDER_TEXT),
    }
  })
}

/** 第 `request` 次请求的消息数组（1 起）。 */
function bodyOf(request: number): ChatMessage[] {
  return llm.bodies[request - 1] as ChatMessage[]
}

describe('① 真回合：首次注入恰好落在第 9 轮', () => {
  test('11 轮发出 12 次会话请求（第 1 轮 2 次：带 todo_write 与收尾）', () => {
    // 请求条数本身是判据的前提：多一条（别的插件插进来）后面所有「第几次」都错位。
    expect(llm.bodies).toHaveLength(REAL_TURNS + 1)
  })

  test('第 1..9 次请求一条都没有（前 8 轮不早发）', () => {
    expect(verdicts().filter((item) => item.request <= 9).every((item) => item.reminder === false)).toBe(true)
  })

  test('第 10 次请求（轮号 9）带上提醒，且只带一条', () => {
    const verdict = verdicts().find((item) => item.request === 10)
    expect(verdict?.rounds).toBe(9)
    expect(verdict?.reminder).toBe(true)
    expect(bodyOf(10).filter((message) => message.role === 'user' && message.content === TODO_REMINDER_TEXT)).toHaveLength(1)
  })

  test('提醒就是请求最后一条（环境快照之后那个位置），正文一字不差', () => {
    // 位置错一格（插在 env 快照之前）模型读到的是「用户先提醒、再给环境」，语义就变了。
    const messages = bodyOf(10)
    expect(messages.at(-1)?.role).toBe('user')
    expect(messages.at(-1)?.content).toBe(TODO_REMINDER_TEXT)
  })

  test('注入之后的两轮（第 11、12 次请求）立刻沉下去', () => {
    // 「越过阈值之后每跳都补」的缺陷恰好落在这段：改前第 11、12 次请求各带一条。
    const after = verdicts().filter((item) => item.request >= 11)
    expect(after).toHaveLength(2)
    expect(after.every((item) => item.reminder === false)).toBe(true)
  })
})

describe('② 真投影链：第二周期到第 17 轮才响', () => {
  /**
   * 造一份「正好第 `round` 轮」的请求：开场写了一次 todo_write，其后 `round − 1` 条 assistant。
   *
   * 用真投影链（`prompt.rewrite`）跑这份历史，等于让内核走一次「组装完请求、马上要发」的
   * 那一刻——台账是同一个、会话是同一个，差别只是不真的打模型。
   */
  function historyAtRound(round: number): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'user', content: '第一步' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'todo_write', arguments: '{}' } }],
      },
      { role: 'tool', content: '清单已更新（1/1 完成）', tool_call_id: 'c1' },
    ]
    for (let index = 0; index < round - 1; index += 1) messages.push({ role: 'assistant', content: `第 ${String(index + 1)} 轮` })
    return messages
  }

  /** 真投影链跑一份历史，返回它有没有被补上提醒。 */
  function projectedRound(round: number): boolean {
    const session = services.session.current()
    const out = services.prompt.rewrite(historyAtRound(round), session)
    return out.some((message) => message.role === 'user' && message.content === TODO_REMINDER_TEXT)
  }

  test('第 10..16 轮：整个周期内一条都没有', () => {
    // 台账上次记账在轮号 9；10..16 每轮与它的差都小于 8，所以一次都不该响。
    const rounds = [10, 11, 12, 13, 14, 15, 16]
    const fired = rounds.filter((round) => projectedRound(round))
    expect(fired).toEqual([])
  })

  test('第 17 轮（9+8）又响一次', () => {
    expect(projectedRound(17)).toBe(true)
  })

  test('再下一轮（第 18 轮）又沉下去', () => {
    // 第 17 轮真补了才记账；没记账的话这里会连响。
    expect(projectedRound(18)).toBe(false)
  })
})

describe('③ 不改日志：提醒只存在于请求体', () => {
  /** 所有轮跑完之后的 jsonl 记录。 */
  let records: Array<Record<string, unknown>>

  beforeAll(async () => {
    // 上报闸会写一条 context-injected 记录；写流是异步的，等它出现再读。
    const deadline = Date.now() + 5_000
    for (;;) {
      records = readSessionJsonl(services.session.current().filePath)
      if (records.some((record) => record.type === 'state' && record.id === 'context-injected')) break
      if (Date.now() > deadline) break
      await new Promise((resolveTick) => setTimeout(resolveTick, 40))
    }
  })

  test('会话日志（内存）里没有这条提醒', () => {
    const messages = services.session.current().messages
    expect(messages.some((message) => message.content === TODO_REMINDER_TEXT)).toBe(false)
  })

  test('会话 jsonl 里没有把提醒当成消息落盘', () => {
    const asMessage = records.some(
      (record) =>
        (record.type === 'user' || record.type === 'assistant') &&
        JSON.stringify(record).includes(TODO_REMINDER_TEXT),
    )
    expect(asMessage).toBe(false)
  })

  test('带 todo-reminder 的注入记录仍是 1 条（上报闸按「内容没变就不记」）', () => {
    // 正文固定，所以两次注入只该记一条：卡片语义是「这一跳新增了什么」，不是每跳一条流水。
    const withTodo = records.filter((record) => {
      const parts = (record['payload'] as { parts?: Array<{ kind?: unknown }> } | undefined)?.parts ?? []
      return parts.some((part) => part.kind === 'todo-reminder')
    })
    expect(withTodo).toHaveLength(1)
  })

  test('注入记录里记的是提醒的来源与位置', () => {
    const withTodo = records.filter((record) => {
      const parts = (record['payload'] as { parts?: Array<{ kind?: unknown }> } | undefined)?.parts ?? []
      return parts.some((part) => part.kind === 'todo-reminder')
    })
    for (const record of withTodo) {
      const parts = (record['payload'] as { parts: Array<Record<string, unknown>> }).parts
      const part = parts.find((item) => item['kind'] === 'todo-reminder')
      expect(part?.['source']).toBe('todo-reminder')
      expect(part?.['where']).toBe('user-tail')
      expect(part?.['preview']).toBe(TODO_REMINDER_TEXT)
    }
  })
})
