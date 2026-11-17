/**
 * 一步请求的三个墙钟读数（迁自 `scripts/throughput-test.mjs` 第 1–4 节）。
 *
 * ## 事故形状（为什么要有这一条）
 *
 * 旧口径是「快照间隔里累计输出 token 的增量 ÷ 真实流逝时间」，分母里混着首字等待、
 * 工具执行与等下一个请求的空转，数字系统性偏低、还随快照节奏抖。0.6.67 起换成 dsh 的
 * 口径：**整个会话累计**的「输出 token ÷ 纯解码时间（第一口输出 → 定稿）」，且分子分母
 * 成对取（只有拿到第一口、又有服务端 output token 的请求才算）。
 *
 * 本文件钉住**测量端**：
 *
 *   ① 三个读数都量到了（`llmMs` / `ttftMs` / `decodeMs`），且 `llmMs ≈ ttft + decode`；
 *   ② 只出工具调用、不吐正文的一步，工具名也算第一口（否则这一步没有首字时刻）；
 *   ③ 始终没吐字 → 只报 `llmMs`；usage 为 null → 一个 usage 事件都不发；
 *   ④ 工具耗时（发起 → 结果）；打断时补的合成结果没有起点，不报耗时。
 *
 * ## 为什么保留上界、但改成关系式
 *
 * 原探针写的是 `llmMs <= 600`（绝对毫秒）。写进 vitest 后这类「机器一忙就红」的绝对
 * 上界是 flaky 的直接来源，所以这里只留 `llmMs - (ttft + decodeMs) <= 600` 与
 * `>= -10`：它守的是「llmMs 不是从很远的地方开始量的」这个语义，与机器快慢无关。
 * 下界（≥25ms）保留——它验的是「读数真的量到了那段时间」，不是速度数值。
 *
 * ## 层与隔离
 *
 * 归 unit：直接构造真 `MiniAgent` + 假 stream，不起内核、不装插件。临时 HOME 仍然要换
 * （`tempHome` 必须在任何内核模块被加载之前跑，`Session` 的派生路径都从它算）。
 *
 * @module @pneuma/session-core/tests/step-timing.spec
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { CoreEvent } from '@pneuma/runtime/core/events.js'
import type { StreamHandlers, StreamRequest, StreamResult } from '@pneuma/runtime/core/llm.js'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import { tempHome } from '../../../../tests/harness.js'

/** 临时主目录：`Session` 的会话根、租约都从它派生（真实 `~/.dsc` 不动）。 */
const home = tempHome('dsc-step-timing-')

type LoopModule = typeof import('../loop.js')
type SessionModule = typeof import('@pneuma/runtime/core/session.js')
type AgentInstance = InstanceType<LoopModule['MiniAgent']>
/** 会话实例的类型：`Session` 的构造器是私有的，只能经 `create` / `load` 拿实例。 */
type SessionInstance = ReturnType<SessionModule['Session']['create']>

/** 一具跑得起来的 agent 壳：假 stream、真会话（每个用例自己的临时工作目录）。 */
interface AgentHarness {
  agent: AgentInstance
  events: CoreEvent[]
  session: SessionInstance
}

/** 假的流式应答：按需吐字、按需要工具、按需给 usage。 */
type FakeStream = (api: string, request: StreamRequest, handlers: StreamHandlers) => Promise<StreamResult>

let MiniAgent: LoopModule['MiniAgent']
let Session: SessionModule['Session']

beforeAll(async () => {
  MiniAgent = (await import('../loop.js')).MiniAgent
  Session = (await import('@pneuma/runtime/core/session.js')).Session
})

afterAll(() => {
  home.restore()
})

/** 睡一会儿（这些用例的时间读数全靠它制造可观测的间隔）。 */
const sleep = (ms: number): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

/** 等回合收尾；3 秒还没完就报错（别让一条用例挂到 hook 超时）。 */
async function settle(agent: AgentInstance): Promise<void> {
  const deadline = Date.now() + 3_000
  while (agent.isRunning) {
    if (Date.now() > deadline) throw new Error('回合 3 秒内没有收尾')
    await sleep(10)
  }
}

/** 一个跑得起来的 agent 壳。 */
function makeAgent(options: { tools?: ToolEntry[]; stream: FakeStream }): AgentHarness {
  const work = mkdtempSync(join(tmpdir(), 'dsc-step-timing-work-'))
  const session = Session.create(work, join(work, 's.jsonl'))
  const events: CoreEvent[] = []
  const agent = new MiniAgent(
    {
      route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
      systemPrompt: () => ({ text: '', sections: [] }),
      tools: () => options.tools ?? [],
      guards: {
        gate: async () => ({ action: 'pass' as const }),
        observe: (_name: string, text: string) => text,
      },
      emit: (event: CoreEvent) => events.push(event),
      stream: options.stream,
    },
    session,
  )
  return { agent, events, session }
}

/** usage 事件（按发出顺序）。 */
function usageEvents(events: CoreEvent[]): Array<Extract<CoreEvent, { type: 'usage' }>> {
  return events.filter((event): event is Extract<CoreEvent, { type: 'usage' }> => event.type === 'usage')
}

/** tool/result 事件（按发出顺序）。 */
function toolResults(events: CoreEvent[]): Array<Extract<CoreEvent, { type: 'tool/result' }>> {
  return events.filter((event): event is Extract<CoreEvent, { type: 'tool/result' }> => event.type === 'tool/result')
}

describe('① 一步请求的三个墙钟读数', () => {
  let harness: AgentHarness

  beforeAll(async () => {
    harness = makeAgent({
      stream: async (_api, _request, handlers) => {
        await sleep(40)
        handlers.onDelta('text', '你')
        await sleep(40)
        handlers.onDelta('text', '好')
        return {
          text: '你好',
          reasoning: '',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 7 },
          finishReason: 'stop',
        }
      },
    })
    harness.agent.followup('说点什么')
    await settle(harness.agent)
  })

  afterAll(() => {
    harness.agent.dispose()
  })

  test('一步请求报了一条 usage（输出 token 与服务端上报一致）', () => {
    const usage = usageEvents(harness.events).at(-1)
    expect(usage?.outputTokens).toBe(7)
  })

  test('首字延迟量在第一口输出上（≥25ms）', () => {
    const usage = usageEvents(harness.events).at(-1)
    expect(usage?.ttftMs ?? -1).toBeGreaterThanOrEqual(25)
  })

  test('解码期量在第一口输出到定稿之间（≥25ms）', () => {
    const usage = usageEvents(harness.events).at(-1)
    expect(usage?.decodeMs ?? -1).toBeGreaterThanOrEqual(25)
  })

  test('LLM 耗时 = 首字延迟 + 解码期（关系式，±10ms 取时刻误差；上界也按关系式）', () => {
    const usage = usageEvents(harness.events).at(-1)
    const llmMs = usage?.llmMs ?? -1
    const measured = (usage?.ttftMs ?? 0) + (usage?.decodeMs ?? 0)
    expect(llmMs).toBeGreaterThanOrEqual(measured - 10)
    // 多出来的只是「发出 → 首口」与「首口 → 定稿」之间的调度空隙；上限 600ms 是原先
    // 绝对上界的同义改写：不钉机器快慢，只钉 llmMs 不是从很远的地方开始量的。
    expect(llmMs - measured).toBeLessThanOrEqual(600)
  })
})

describe('② 只出工具调用（不吐正文）时，工具名算第一口输出', () => {
  let harness: AgentHarness

  beforeAll(async () => {
    /** 这一次请求是第几步（第一步要工具，第二步收尾，否则回合顶成死循环）。 */
    let calls = 0
    harness = makeAgent({
      stream: async (_api, _request, handlers) => {
        calls += 1
        await sleep(40)
        handlers.onToolPrepare?.('bash')
        const toolCalls = calls === 1 ? [{ id: 't1', name: 'bash', arguments: '{}' }] : []
        return {
          text: calls === 1 ? '' : '好了',
          reasoning: '',
          toolCalls,
          usage: { inputTokens: 10, outputTokens: 4 },
          finishReason: calls === 1 ? 'tool_calls' : 'stop',
        }
      },
    })
    harness.agent.followup('跑一条命令')
    await settle(harness.agent)
    await sleep(20)
  })

  afterAll(() => {
    harness.agent.dispose()
  })

  test('具名工具增量也算首字（ttftMs 有值）', () => {
    const usage = usageEvents(harness.events)[0]
    expect(usage?.ttftMs ?? -1).toBeGreaterThanOrEqual(25)
  })

  test('只出工具调用同样有解码期', () => {
    const usage = usageEvents(harness.events)[0]
    expect(usage?.decodeMs ?? -1).toBeGreaterThanOrEqual(0)
  })
})

describe('③ 没拿到第一口 / 没有 usage 时的降级', () => {
  describe('始终没吐字', () => {
    let harness: AgentHarness

    beforeAll(async () => {
      harness = makeAgent({
        stream: async () => {
          await sleep(30)
          return {
            text: '',
            reasoning: '',
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 0 },
            finishReason: 'stop',
          }
        },
      })
      harness.agent.followup('空跑')
      await settle(harness.agent)
    })

    afterAll(() => {
      harness.agent.dispose()
    })

    test('只报 llmMs（量到了「发出 → 定稿」）', () => {
      const usage = usageEvents(harness.events).at(-1)
      expect(usage?.llmMs ?? -1).toBeGreaterThanOrEqual(20)
    })

    test('不报首字延迟与解码期（没有可信的终点，不编 0）', () => {
      const usage = usageEvents(harness.events).at(-1)
      expect(usage?.ttftMs).toBeUndefined()
      expect(usage?.decodeMs).toBeUndefined()
    })
  })

  test('usage 为 null 时不发 usage 事件', async () => {
    const harness = makeAgent({
      stream: async () => {
        await sleep(10)
        return { text: '没带用量', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      },
    })
    harness.agent.followup('不带用量的端点')
    await settle(harness.agent)
    expect(usageEvents(harness.events)).toHaveLength(0)
    harness.agent.dispose()
  })
})

describe('④ 工具耗时（发起 → 结果），打断补的合成结果不报', () => {
  test('跑过的工具调用带耗时（≥25ms）', async () => {
    const slow: ToolEntry = {
      name: 'slow',
      description: '',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      run: async () => {
        await sleep(40)
        return 'ok'
      },
    }
    const harness = makeAgent({
      tools: [slow],
      stream: async (_api, _request) => {
        // 只有第一步要工具，第二步收尾——否则假 stream 每步都回调用，回合不会停。
        const first = toolResults(harness.events).length === 0
        return {
          text: first ? '' : '完成',
          reasoning: '',
          toolCalls: first ? [{ id: 't1', name: 'slow', arguments: '{}' }] : [],
          usage: null,
          finishReason: first ? 'tool_calls' : 'stop',
        }
      },
    })
    harness.agent.followup('跑一下')
    await settle(harness.agent)
    const results = toolResults(harness.events)
    expect(results).toHaveLength(1)
    expect(results[0]?.ms ?? -1).toBeGreaterThanOrEqual(25)
    harness.agent.dispose()
  })

  describe('第一条调用在跑时用户打断（第二条还没开始）', () => {
    let harness: AgentHarness
    /** 打断后补出来的两条结果（按发出顺序）。 */
    let results: Array<Extract<CoreEvent, { type: 'tool/result' }>>

    beforeAll(async () => {
      const slowWrite: ToolEntry = {
        name: 'slow_write',
        description: '',
        parameters: { type: 'object', properties: {} },
        risk: 'write',
        run: async () => {
          await sleep(80)
          return 'ok'
        },
      }
      harness = makeAgent({
        tools: [slowWrite],
        stream: async () => {
          // 第一条调用在跑的时候用户打断：第二条还没开始，收尾时补一条合成结果。
          setTimeout(() => {
            harness.agent.cancel()
          }, 20)
          return {
            text: '',
            reasoning: '',
            toolCalls: [
              { id: 't1', name: 'slow_write', arguments: '{}' },
              { id: 't2', name: 'slow_write', arguments: '{}' },
            ],
            usage: null,
            finishReason: 'tool_calls',
          }
        },
      })
      harness.agent.followup('改两处')
      await settle(harness.agent)
      results = toolResults(harness.events)
    })

    afterAll(() => {
      harness.agent.dispose()
    })

    test('跑过的那条有耗时（≥25ms）', () => {
      const started = results.find((event) => event.callId === 't1')
      expect(started?.ms ?? -1).toBeGreaterThanOrEqual(25)
    })

    test('打断补的合成结果没有耗时（没有起点就不报）', () => {
      const synthesized = results.find((event) => event.callId === 't2')
      expect(synthesized?.ms).toBeUndefined()
      expect(synthesized?.text).toBe('用户取消，调用未执行')
    })
  })
})
