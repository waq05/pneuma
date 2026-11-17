/**
 * 运行时请求 invariant：真内核那一半（迁自 `scripts/request-invariant-test.mjs` 的 [2]–[6]）。
 *
 * 被测的是接线，不是判定本身（判定口径在 `src/core/request-invariant.spec.ts`）：
 * 循环在「组装完 messages、交给 stream 之前」校验一次；不一致经 `dsc/notice` 报出、
 * 按会话去重、**不阻断请求**。对应 dsh 的 agent-loop invariant（逐字节相等即 fail），
 * dsc 的取舍是只报不杀。
 *
 * 四段：
 *   ① 健康回合零误报（含工具调用那一步，两条请求都要过校验）；
 *   ② 非纯投影（往系统提示塞随机数）→ 报一次，同形状第二回合不再报；
 *   ③ 就地改输入 → 报一次，理由点明「就地」；
 *   ④ 组装与发送之间往会话日志插一条 → 报一次，位置指到第 3 条；
 *   ⑤ 坏投影撤掉后回到零误报。
 *
 * 为什么每条都要断言「回合照常收尾 + 请求照常发出」：校验的价值在于只报不杀。
 * 只要它开始拦请求，这些用例会先红在「请求没发出去」上。
 *
 * 按 D25：这一层跑的是混合平面（宿主来自 src、插件来自 lib），改完 src 必须
 * `pnpm run build` 再跑，否则内核跑的仍是旧 lib，用例会假绿。
 *
 * @module dsc/tests/integration/request-invariant.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface PromptService {
  registerProjection(
    id: string,
    fn: (messages: ChatMessage[]) => ChatMessage[],
  ): () => void
}

interface SessionView {
  messages: ChatMessage[]
}

interface ProbeContext {
  on(event: 'dsc/notice', listener: (text: string) => void): () => void
  prompt: PromptService
  tools: { register(entry: unknown): () => void }
  session: { current(): SessionView }
}

let llm: FakeLLM
let kernel: BootedKernel
let probe: ProbeContext
/** 本会话所有 invariant 提醒（其它插件的 notice 不算）。 */
const notices: string[] = []

/** 记一条 notice：只收 request-invariant 报的那一类（文本带 invariant）。 */
function collectNotice(text: string): void {
  if (typeof text === 'string' && text.includes('invariant')) notices.push(text)
}

/** 跑一个真回合，返回这一回合真的发出去的模型请求数。失败时抛出内核给的那条错。 */
async function runTurn(text: string): Promise<number> {
  const before = llm.requestCount
  await kernel.runTurn(text)
  return llm.requestCount - before
}

beforeAll(async () => {
  // 第一轮要一次工具调用：有第二步请求才看得到「校验在每次请求上都跑」。
  llm = await fakeLLM({ turns: [{ toolCall: { name: 'echo', args: {} } }, '收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  probe = kernel.ctx as unknown as ProbeContext
  probe.on('dsc/notice', collectNotice)
  probe.tools.register({
    name: 'echo',
    description: '测试用只读工具',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => 'echoed',
  })
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

describe('① 健康回合：一条误报都没有', () => {
  let requests = 0

  beforeAll(async () => {
    requests = await runTurn('健康回合')
  })

  test('健康回合正常收尾，且真的发了请求（含工具调用那一步）', () => {
    expect(requests).toBeGreaterThanOrEqual(2)
  })

  test('健康回合零误报（没有 invariant notice）', () => {
    expect(notices).toEqual([])
  })
})

describe('② 坏投影一：非纯（往系统提示塞随机数）', () => {
  let offRandom: () => void

  beforeAll(() => {
    offRandom = probe.prompt.registerProjection('bad-random', (messages) => {
      if (messages.length === 0) return messages
      const head = messages[0]!
      const text = typeof head.content === 'string' ? head.content : ''
      return [{ ...head, content: `${text}\nnonce:${Math.random()}` }, ...messages.slice(1)]
    })
  })

  afterAll(() => {
    offRandom()
  })

  test('非纯投影：回合仍正常收尾（校验不阻断），请求仍照发', async () => {
    expect(await runTurn('非纯投影一')).toBeGreaterThanOrEqual(1)
  })

  test('非纯投影：报了一条 notice，且带条数与 role（第 1 条 / system）', () => {
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('第 1 条')
    expect(notices[0]).toContain('system')
  })

  test('非纯投影：第二回合同形状不再报（按会话去重，不刷屏）', async () => {
    expect(await runTurn('非纯投影二')).toBeGreaterThanOrEqual(1)
    expect(notices).toHaveLength(1)
  })
})

describe('③ 坏投影二：就地改输入', () => {
  let offMutate: () => void

  beforeAll(() => {
    offMutate = probe.prompt.registerProjection('bad-mutate', (messages) => {
      const head = messages[0]
      if (head !== undefined && typeof head.content === 'string') head.content = `${head.content}\nMUTATED`
      return messages
    })
  })

  afterAll(() => {
    offMutate()
  })

  test('就地改输入：回合正常收尾，报了一条新 notice 且点明「就地改写」', async () => {
    expect(await runTurn('就地改输入')).toBeGreaterThanOrEqual(1)
    expect(notices).toHaveLength(2)
    expect(notices[1]).toContain('就地')
  })
})

describe('④ 坏投影三：组装与发送之间往会话日志插一条', () => {
  let offInsert: () => void
  let inserted = false

  beforeAll(() => {
    offInsert = probe.prompt.registerProjection('bad-insert', (messages) => {
      // 模拟「组装与发送之间会话日志被动了」：投影第一次跑时往 messages 插一条。
      // 发送侧在它之前就组装好了（不含这条），重建侧从日志现状派生（含这条）→ 对不上。
      if (!inserted) {
        inserted = true
        probe.session.current().messages.splice(1, 0, { role: 'user', content: '组装与发送之间插进来的' })
      }
      return messages
    })
  })

  afterAll(() => {
    offInsert()
    // 收拾插进去的那条，别让它污染后面的断言（它在 index 1）。
    const live = probe.session.current().messages
    if (live[1]?.content === '组装与发送之间插进来的') live.splice(1, 1)
  })

  test('插一条：回合正常收尾，报了一条新 notice 且位置命中第 3 条', async () => {
    expect(await runTurn('组装与发送之间插一条')).toBeGreaterThanOrEqual(1)
    expect(notices).toHaveLength(3)
    expect(notices[2]).toContain('第 3 条')
  })
})

describe('⑤ 坏投影撤掉后：回到零误报', () => {
  test('回归回合正常收尾，不再新增 notice', async () => {
    expect(await runTurn('回归干净')).toBeGreaterThanOrEqual(1)
    expect(notices).toHaveLength(3)
  })
})
