/**
 * 条目顺序的身份证不变量：**id 序 = 时间序**（迁自 `scripts/transcript-order-test.mjs`）。
 *
 * ## 用户报障与根因
 *
 * 会话里每一段的「思考过程」行都跑到了它那一步的工具卡**下面**，而那段思考明明先发生。
 * 根因不在渲染层，在两处约定的接缝上：
 *
 *   1. 宿主组帧时按 **id 正负**把条目分成两份（`packages/webserver` 的
 *      `entries.filter(id > 0)` / `liveEntries.filter(id < 0)`）；
 *   2. 壳把 `entries` **按 id 升序**归并（`ui-core/frames.ts` 的 `applyHostFrame`，前提是
 *      「宿主发号递增，id 序就是时间序」）。
 *
 * 而 `adapter/transcript.ts` 的「准备中」工具曾经在 `tool/prepare` 那一刻就领正 id：它必然
 * 小于同一步稍后才定稿的思考行（`message` 那一刻才发号），于是壳按 id 一排，工具卡就插到了
 * 思考行前面。修法：**发号只许在条目真正进 list 的那一刻做**，准备中的那一条按直播尾发负 id。
 *
 * ## 五层断言里搬过来四层
 *
 *   [1] 不变量：定稿条目数组严格按 id 递增（正 id 子序列即时间序）；
 *   [2] 逐步对账：每一步的思考行 id < 那一步的工具行 id（用户报的那一条）；
 *   [3] 准备中窗口：直播尾里的「准备中」工具是负 id；
 *   [4] 接缝：真 `applyHostFrame` 归并一帧全量后，条目顺序与宿主数组逐项一致。
 *
 * ## 迁移时改了两处接缝，砍了一节
 *
 * - **[3] 不再抢实时窗口**：原探针让假端点把流挂住 700ms，再轮询快照去抓「工具名吐完、
 *   `tool/call` 还没到」那一瞬。harness 的 `fakeLLM` 没有慢响应接缝（它一次把整段 SSE
 *   写完），硬造就得手写事件流——本批明令禁止。改成直接喂 `tool/prepare` 事件读
 *   `liveEntries()`：观察的还是同一条不变量（准备中的工具是负 id、状态是 preparing），
 *   但没有竞态，跑一百遍都一样。
 * - **[1][2] 的剧本从四步缩到三步**：原探针第一步故意发两个同名调用、第三步让正文先于
 *   工具。这里每步「一段思考 + 一次工具」，只保留被钉的不变量本身（三步对账 + 跨步不串位）。
 *   少掉的两件事——同名多调用、同一步的正文——与「id 序」无关，由 adapter 自己的用例管。
 * - **[5] 源码钉（含反向对照）不搬**：那三条是读 `adapter/transcript.ts` 再匹配
 *   `this.seq++` / `id: -(live.length + offset + 1)` 的源码文本断言，没有行为接缝，按本批
 *   规矩不搬也不改源码。它们要守的东西已经由 [3]（负 id）与 [1]（id 递增）从行为面钉住。
 *
 * @module dsc/tests/integration/transcript-order.int.spec
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'
import type { TranscriptEntry } from '@pneuma/runtime/contract.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-order-')

/** 内核里本文件用到的服务面。 */
interface Services {
  session: { current(): { meta: { id: string; cwd: string }; filePath: string } }
  transcript: { getSnapshot(): { entries: readonly TranscriptEntry[] } }
}

type TranscriptModule = typeof import('@pneuma/runtime/adapter/transcript.js')
type FramesModule = typeof import('@pneuma/runtime/packages/ui-core/frames.js')

let llm: FakeLLM
let kernel: BootedKernel
let services: Services
let transcriptModule: TranscriptModule
let framesModule: FramesModule
/** 真回合跑完时的宿主快照（定稿条目 + 直播尾拼在同一个 `entries` 里）。 */
let entries: readonly TranscriptEntry[]

/** 定稿条目（正 id）：壳按 id 升序归并的那一份。 */
function finalized(): readonly TranscriptEntry[] {
  return entries.filter((entry) => entry.id > 0)
}

/** 直播尾（负 id）：按出现顺序原样传给壳，不参与按 id 归并。 */
function liveTail(): readonly TranscriptEntry[] {
  return entries.filter((entry) => entry.id < 0)
}

/** 把定稿条目切成「思考 + 它那一步的工具」的对账表。 */
function stepPairs(rows: readonly TranscriptEntry[]): Array<{ thinking: number; tools: number[] }> {
  const steps: Array<{ thinking: number; tools: number[] }> = []
  let current: { thinking: number; tools: number[] } | null = null
  for (const entry of rows) {
    if (entry.kind === 'user' || entry.kind === 'system') {
      current = null
      continue
    }
    if (entry.kind === 'thinking') {
      current = { thinking: entry.id, tools: [] }
      steps.push(current)
      continue
    }
    if (entry.kind === 'tool' && current !== null) current.tools.push(entry.id)
  }
  return steps.filter((step) => step.tools.length > 0)
}

beforeAll(async () => {
  transcriptModule = await import('@pneuma/runtime/adapter/transcript.js')
  framesModule = await import('@pneuma/runtime/packages/ui-core/frames.js')
  // 三步真工具（glob 是只读工具，不落任何文件、不需要审批）+ 一句收尾正文：
  // 每步一次请求，剧本照 harness 的 `{ toolCall }` 形状写。
  llm = await fakeLLM({
    turns: [
      { toolCall: { name: 'glob', args: { pattern: '*.json' } } },
      { toolCall: { name: 'glob', args: { pattern: 'src/**/*.ts' } } },
      { toolCall: { name: 'glob', args: { pattern: 'docs/*.md' } } },
      '收尾。',
    ],
  })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  services = kernel.ctx as unknown as Services
  await kernel.runTurn('试一下')
  // 读快照前先让一轮的收尾事件落定（`runTurn` 已经等过 turn-end 与空闲，这里只取一次读数）。
  entries = services.transcript.getSnapshot().entries
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

describe('① 定稿条目：数组顺序就是 id 升序（壳按 id 归并的前提）', () => {
  test('数组顺序就是 id 升序', () => {
    const ids = finalized().map((entry) => entry.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id, index) => index === 0 || ids[index - 1]! < id)).toBe(true)
  })

  test('没有重复 id', () => {
    // 重复 id 会让壳的行 key 撞车：一条被复用、另一条不显示，顺序也就无从谈起。
    const ids = finalized().map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('② 逐步对账：每一步的思考行在它那一步的工具行之前（id 更小）', () => {
  /**
   * 三步「准备中 → 思考定稿 → 工具落表」的转录。
   *
   * ## 为什么这一节直接喂 reducer 事件，而不是看真回合
   *
   * harness 的 `fakeLLM` 剧本只有两种形状：一段正文、或一次工具调用。它**发不出
   * `reasoning_content`**，所以真回合里根本不会产生 `thinking` 行——拿真回合做逐步对账，
   * 对账表永远是空的（这条我在迁移时撞到了）。改用 adapter 的公开入口 `reduce`，喂的正是
   * `loop.ts` 打出来的那串事件顺序：模型先吐工具名（`tool/prepare`）→ 再定稿那段思考
   * （`message`，带 reasoning）→ 工具调用真正发出来（`tool/call`）。
   *
   * 被钉的东西没变：定稿表里 id 必须严格递增，且每一步的思考 id 小于该步工具 id。
   */
  function threeSteps(): InstanceType<TranscriptModule['Transcript']> {
    const transcript = new transcriptModule.Transcript()
    transcript.reduce({ type: 'user', text: '试一下' })
    transcript.reduce({ type: 'turn/start' })
    for (const step of [1, 2, 3]) {
      // 模型开始吐工具名、参数还在流里：这一步不许领正 id（见第 ③ 节）。
      transcript.reduce({ type: 'tool/prepare', name: 'glob' })
      transcript.reduce({ type: 'message', text: '', reasoning: `第 ${String(step)} 步：先想一下。` })
      transcript.reduce({ type: 'tool/call', callId: `c${String(step)}`, name: 'glob', args: '{"pattern":"*.json"}' })
      transcript.reduce({ type: 'tool/result', callId: `c${String(step)}`, text: `第 ${String(step)} 步结果` })
    }
    transcript.reduce({ type: 'message', text: '收尾。', reasoning: '' })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })
    return transcript
  }

  test('有 3 步「思考 + 工具」的配对', () => {
    expect(stepPairs(threeSteps().entries)).toHaveLength(3)
  })

  test('每步的思考 id < 该步第一个工具 id（修好后：工具不再抢在思考前面）', () => {
    const pairs = stepPairs(threeSteps().entries)
    expect(pairs).toHaveLength(3)
    for (const step of pairs) expect(step.thinking).toBeLessThan(Math.min(...step.tools))
  })

  test('每一步的工具 id 都大于上一步的工具 id（跨步不会串位）', () => {
    const pairs = stepPairs(threeSteps().entries)
    for (let index = 1; index < pairs.length; index += 1) {
      expect(Math.min(...pairs[index]!.tools)).toBeGreaterThan(Math.max(...pairs[index - 1]!.tools))
    }
  })

  test('带正文那一步也在对账里（正文夹在思考与工具之间）', () => {
    expect(stepPairs(threeSteps().entries).some((step) => step.tools.length === 1)).toBe(true)
  })

  test('真回合也确实跑完了 3 步工具（每步一张工具卡）', () => {
    // 上面那一组喂的是 reducer 事件；这一条把「真回合真的走了三步」这件事钉在宿主侧。
    expect(finalized().filter((entry) => entry.kind === 'tool')).toHaveLength(3)
  })
})

describe('③ 准备中窗口：直播尾里的「准备中」工具是负 id', () => {
  /**
   * 喂一次 `tool/prepare`：模型开始吐工具名、参数还在流里，宿主此刻就会有一条「准备中」。
   *
   * 原探针靠挂住真流 700ms 去抓这一瞬；这里直接喂事件，观察的是同一条不变量。
   */
  function preparingTranscript(): InstanceType<TranscriptModule['Transcript']> {
    const transcript = new transcriptModule.Transcript()
    transcript.reduce({ type: 'user', text: '试一下' })
    transcript.reduce({ type: 'turn/start' })
    transcript.reduce({ type: 'message', text: '先看看文件。', reasoning: '' })
    transcript.reduce({ type: 'tool/prepare', name: 'bash' })
    return transcript
  }

  test('准备中的工具出现在直播尾里（不是定稿条目）', () => {
    const transcript = preparingTranscript()
    expect(transcript.liveEntries().some((entry) => entry.kind === 'tool' && entry.call.status === 'preparing')).toBe(true)
    // 它一旦进了定稿表，就会按「发号那一刻」排到还在流式的思考行前面——正是用户报的错位。
    expect(transcript.entries.some((entry) => entry.kind === 'tool')).toBe(false)
  })

  test('准备中的工具发的是负 id（直播尾身份）', () => {
    const prepared = preparingTranscript()
      .liveEntries()
      .filter((entry) => entry.kind === 'tool')
    expect(prepared.length).toBeGreaterThan(0)
    for (const entry of prepared) expect(entry.id).toBeLessThan(0)
  })

  test('那一刻的状态就是 preparing', () => {
    const prepared = preparingTranscript()
      .liveEntries()
      .filter((entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool')
    for (const entry of prepared) expect(entry.call.status).toBe('preparing')
  })

  test('负 id 不与直播尾那几段撞号（负 id 也是壳的行 key）', () => {
    const ids = preparingTranscript().liveEntries().map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('④ 接缝：真 applyHostFrame 归并后顺序与宿主数组逐项一致', () => {
  /** 一帧全量快照：定稿条目走 `entries`、直播尾走 `liveEntries`（与宿主组帧同形）。 */
  function frameOf(): { entries: readonly TranscriptEntry[]; liveEntries: readonly TranscriptEntry[] } {
    return { entries: finalized(), liveEntries: liveTail() }
  }

  test('归并后的 entries 与宿主正 id 数组逐项同序（壳那一侧不再自己重排）', () => {
    const frame = frameOf()
    const merged = framesModule.applyHostFrame(null, { type: 'snapshot', full: true, seq: 1, ...frame })
    expect(merged.entries.map((entry) => entry.id).join(',')).toBe(frame.entries.map((entry) => entry.id).join(','))
  })

  test('归并后思考行仍在它那一步的工具行之前', () => {
    const merged = framesModule.applyHostFrame(null, { type: 'snapshot', full: true, seq: 1, ...frameOf() })
    for (const [index, entry] of merged.entries.entries()) {
      if (entry.kind !== 'tool') continue
      const previous = merged.entries[index - 1]
      expect(previous === undefined || previous.kind !== 'thinking' || previous.id < entry.id).toBe(true)
    }
  })
})
