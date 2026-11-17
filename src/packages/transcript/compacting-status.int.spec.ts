/**
 * 压缩活动行与占用刷新（迁自 `scripts/compacting-status-test.mjs`）。
 *
 * ## 这一层为什么必须单独一张网
 *
 * 这两件事都是「事件 → 快照字段」的约定，没有任何纯函数能保证它：压缩插件发的
 * `dsc/compacting` / `dsc/context-used` 若没被转录插件接住，界面就还是一片安静、百分比
 * 还是停在压缩前——而这恰恰是用户最初报的那个现象。
 *
 * 验四件事：
 *   ① 开始压缩 → 快照 `status.compactingSince` 是数字；结束 → 字段消失（不残留）；
 *   ② 别的会话开始的压缩，不改当前会话的字段（后台 agent 压缩不该冒到当前视图）；
 *   ③ `dsc/context-used` 把 `status.contextUsed` 换掉（压完百分比立刻动）；
 *   ④ 别的会话的读数不覆盖当前会话。
 *
 * 另外两条由真压缩补上（原探针是源码文本断言，这里换成行为）：
 *   ⑤ 真跑一次压缩，`dsc/compacting` 真的成对发出、压完真的补一发估算读数；
 *   ⑥ 压缩**失败**（摘要压不小）时字段也被清掉——「失败质量」只能靠 `finally` 保证，
 *      只验成功路径的话，「只在成功时清」的实现照样能绿。
 *
 * ## 迁移时删掉的一条
 *
 * 原探针第 [5] 节还有一条 `壳按 compactingSince 画状态行`（读界面壳 `ui.tsx` 的源码，
 * 断言 `/compactingSince !== null[\s\S]*?TurnStatusLine/`）。那是界面半的渲染约定，
 * integration 层没有接缝（要渲 ink 组件），按本批规矩不搬，缺口记进 P7 的未覆盖清单，
 * 归属 ui/tui 层。
 *
 * @module dsc/packages/transcript/compacting-status.int.spec
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-compacting-')

/** 一次工具调用（压缩会话时用来把工具配对切在中间之外）。 */
interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface Services {
  transcript: { getSnapshot(): { status: { compactingSince?: number; contextUsed?: number } } }
  session: {
    current(): {
      filePath: string
      appendUser(text: string): void
      appendAssistant(text: string, reasoning: string, calls: ToolCall[]): void
    }
  }
  compact: { run(): Promise<void> }
  on(event: string, listener: (...args: unknown[]) => void): () => void
  emit(event: string, ...args: unknown[]): void
}

let llm: FakeLLM
let kernel: BootedKernel
let services: Services

/** 一条够长的正文：30 条就能把「最近 20 条」之外的区间顶出来。 */
const LONG = '错'.repeat(400)
/** 摘要正文：必须显著短于被折掉的历史，否则压缩会判「没有意义」。 */
const SHORT_SUMMARY = '【假摘要】这段历史已压缩'

beforeAll(async () => {
  // 压缩请求是这一趟的**第一发**请求（没有先跑回合），所以第 1 轮就是短摘要；
  // 第 2 轮是超长摘要，留给失败那一段。
  llm = await fakeLLM({ turns: [SHORT_SUMMARY, 'z'.repeat(60_000), '收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  services = kernel.ctx as unknown as Services
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

/** 往当前会话里灌一段够长、可压缩的历史（30 条消息，压缩点落在最近 20 条之外）。 */
function fillHistory(): void {
  const session = services.session.current()
  for (let index = 0; index < 15; index += 1) {
    session.appendUser(`第 ${String(index)} 问 ${LONG}`)
    session.appendAssistant(`第 ${String(index)} 答 ${LONG}`, '', [])
  }
}

describe('① 字段语义：开始有、结束清', () => {
  test('压缩前没有 compactingSince', () => {
    expect(services.transcript.getSnapshot().status.compactingSince).toBeUndefined()
  })

  test('开始压缩后拿到开始时刻（数字）', () => {
    // 界面只认「有没有值 + 值是多少」；给 null 或字符串会让状态行画不出来。
    services.emit('dsc/compacting', true, services.session.current().filePath)
    expect(typeof services.transcript.getSnapshot().status.compactingSince).toBe('number')
  })

  test('结束后字段被清掉（界面不会一直转圈）', () => {
    services.emit('dsc/compacting', false, services.session.current().filePath)
    expect(services.transcript.getSnapshot().status.compactingSince).toBeUndefined()
  })
})

describe('② 别的会话的压缩不冒到当前视图', () => {
  /** 一条与当前会话无关的路径（后台 agent 的会话文件）。 */
  const other = join(home.home, 'session-other.jsonl')

  test('当前会话没有冒出一条别人的压缩状态', () => {
    // 判据是路径而不是布尔：不带路径的广播会让侧栏里所有会话一起转圈。
    services.emit('dsc/compacting', true, other)
    expect(services.transcript.getSnapshot().status.compactingSince).toBeUndefined()
  })

  test('清掉别人的状态也不影响当前会话（幂等）', () => {
    services.emit('dsc/compacting', false, other)
    expect(services.transcript.getSnapshot().status.compactingSince).toBeUndefined()
  })
})

describe('③ 压完的估算读数立刻进快照', () => {
  test('contextUsed 换成了估算值', () => {
    services.emit('dsc/context-used', 4321, services.session.current().filePath)
    expect(services.transcript.getSnapshot().status.contextUsed).toBe(4321)
  })

  test('别人的读数不覆盖当前会话', () => {
    services.emit('dsc/context-used', 999_999, join(home.home, 'session-other.jsonl'))
    expect(services.transcript.getSnapshot().status.contextUsed).toBe(4321)
  })
})

describe('④ 真压缩：事件成对发出、压完补一发估算读数', () => {
  /** 这一段时间里 `dsc/compacting` 的取值序列。 */
  let compactingEvents: boolean[] = []
  /** 这一段时间里 `dsc/context-used` 的读数。 */
  let usedEvents: number[] = []

  test('压缩成功：compacting 先 true 后 false，结束时字段归零', async () => {
    const offCompacting = services.on('dsc/compacting', (...args) => {
      compactingEvents.push(args[0] as boolean)
    })
    const offUsed = services.on('dsc/context-used', (...args) => {
      usedEvents.push(args[0] as number)
    })
    fillHistory()
    usedEvents = []
    try {
      await services.compact.run()
    } finally {
      offCompacting()
      offUsed()
    }
    expect(compactingEvents).toEqual([true, false])
    expect(services.transcript.getSnapshot().status.compactingSince).toBeUndefined()
  })

  test('压完发了一发估算读数（正数，界面的百分比立刻动）', () => {
    // 压缩本身不发对话请求，读数只能由压缩插件补；不补就停在压缩前的百分比。
    expect(usedEvents.length).toBeGreaterThanOrEqual(1)
    expect(usedEvents[0]).toBeGreaterThan(0)
  })

  test('账真的动了：历史被换成摘要（不是 noop）', () => {
    // 防「事件发了但什么都没压」：首条必须是摘要正文，且条数远少于灌进去的 30 条。
    const messages = (services.session.current() as unknown as { messages: Array<{ content?: unknown }> }).messages
    expect(String(messages[0]?.content)).toContain('【假摘要】')
    expect(messages.length).toBeLessThan(30)
  })
})

describe('⑤ 压缩失败：字段照样被清（finally 那条的唯一行为证据）', () => {
  /** 失败那一次的 `dsc/compacting` 序列。 */
  let compactingEvents: boolean[] = []
  /** 失败之后收到的通知正文。 */
  let notices: string[] = []

  test('摘要压不小 → 压缩失败，但 compactingSince 不残留', async () => {
    const offCompacting = services.on('dsc/compacting', (...args) => {
      compactingEvents.push(args[0] as boolean)
    })
    const offNotice = services.on('dsc/notice', (...args) => {
      notices.push(String(args[0]))
    })
    // 再灌一段：这次摘要模型回 6 万字，比被折掉的历史还长，压缩会判「没有意义」。
    fillHistory()
    try {
      await services.compact.run()
    } finally {
      offCompacting()
      offNotice()
    }
    expect(notices.some((text) => text.includes('压缩失败'))).toBe(true)
  })

  test('失败之后状态行归零（界面不会一直转圈）', () => {
    // 只验成功路径的话，「只在成功时清」的实现照样绿；失败路径才是 finally 的用处。
    expect(compactingEvents).toEqual([true, false])
    expect(services.transcript.getSnapshot().status.compactingSince).toBeUndefined()
  })
})
