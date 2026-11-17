/**
 * 上下文注入卡的合并规则（迁自 `scripts/context-injection-merge-test.mjs`）。
 *
 * 要守的现象（2026-11-11 报障）：一次多步回合里每一步请求都会重报一次注入清单，而清单会在
 * A（环境快照 + 模式 + 沙箱）与 B（A 再多一条重复调用提醒）之间交替。修之前是「跟最近一条
 * 注入卡比」——A 出现时最近那条是 B，必然不等，于是每一跳都新长一张卡，16 步的回合落 8 张
 * 几乎一样的卡。
 *
 * 修后的口径：
 *   1. 只在**这一轮**里找同 `parts` 的卡片，找到就刷新时刻、次数 +1（不新建）；
 *   2. 轮与轮之间不合并（`user` / `turn/end` 是边界；正文与工具行不是边界）；
 *   3. 次数 `count` 是记账读数，不参与「条目内容是否变了」的判等；
 *   4. 空清单照旧不建条目——那只是这一轮什么都没注入。
 *
 * ## 为什么这是 unit 层
 *
 * 被测的是 `adapter/transcript.ts` 的 `reduce`：它只吃事件、只吐条目，不碰网络、不碰磁盘、
 * 不需要内核装配。事件流是**按真现场的形状手写的**（每步夹着工具行），这正是要钉的形状。
 *
 * @module dsc/adapter/transcript.spec
 */
import { describe, expect, test } from 'vitest'
import type { ContextInjectionView } from '../contract.js'
import type { CoreEvent } from '../core/events.js'
import { sameEntries } from '../packages/transcript/index.js'
import { Transcript } from './transcript.js'

/** 注入清单 A：环境快照 + 模式 + 沙箱（三类的组合）。 */
const A: ContextInjectionView[] = [
  { kind: 'env-facts', source: 'env-facts', where: 'user-tail', chars: 908, preview: '环境事实' },
  { kind: 'mode', source: 'mode', where: 'system', chars: 85, preview: '当前模式' },
  { kind: 'sandbox', source: 'sandbox', where: 'system', chars: 445, preview: '沙箱档位' },
]

/** 注入清单 B：A 再多一条重复调用提醒（现场 A / B 交替的来源）。 */
const B: ContextInjectionView[] = [
  ...A,
  { kind: 'repeat-reminder', source: 'repeat-reminder', where: 'user-tail', chars: 42, preview: '提醒' },
]

/** 一类注入卡（只挑渲染要用的字段，断言直接读）。 */
function cards(transcript: Transcript): Array<{ parts: ContextInjectionView[]; count: number; id: unknown; ts: unknown }> {
  return transcript.entries
    .filter((entry) => entry.kind === 'context-injection')
    .map((entry) => ({ parts: entry.parts, count: entry.count ?? 1, id: entry.id, ts: entry.ts }))
}

/**
 * 走一步真实回合的条目顺序：提示卡 → 注入卡 → 正文 → 工具调用 → 工具结果。
 *
 * 为什么中间要夹工具行：现场就是这样（`loop.ts` 每跳发一次请求，两次请求之间必然有上一次
 * 的助手消息与工具结果）。合并判据若把工具行当轮界，每跳都会断开——这是必须钉住的形状。
 */
function step(transcript: Transcript, parts: ContextInjectionView[], callId: string, ts: number): void {
  transcript.reduce({ type: 'prompt/used', prompt: { hash: 'h1', chars: 4400, sections: [] } }, ts)
  transcript.reduce({ type: 'context/injected', parts }, ts)
  transcript.reduce({ type: 'delta', kind: 'text', text: '读文件。' }, ts)
  transcript.reduce({ type: 'message', text: '读文件。', reasoning: '' }, ts)
  transcript.reduce({ type: 'tool/call', callId, name: 'read', args: '{}' }, ts)
  transcript.reduce({ type: 'tool/result', callId, text: 'ok' }, ts)
}

/** 开局一条用户消息：这一轮从这开始。 */
function startTurn(transcript: Transcript, text: string, ts: number): void {
  transcript.reduce({ type: 'user', text }, ts)
}

describe('① 同一轮里 A、A、A（中间隔着工具行）→ 一张卡，次数 3', () => {
  test('工具行不打断这一轮：只剩 1 张卡、次数 3、时刻刷新、id 不变', () => {
    const transcript = new Transcript()
    startTurn(transcript, '开始', 1000)
    step(transcript, A, 'c1', 1010)
    const firstId = cards(transcript)[0]?.id
    step(transcript, A, 'c2', 1020)
    step(transcript, A, 'c3', 1030)

    const list = cards(transcript)
    expect(list).toHaveLength(1)
    expect(list[0]?.count).toBe(3)
    // 时刻刷新到最后一次出现：界面按它显示「最近一次注入」。
    expect(list[0]?.ts).toBe(1030)
    // id 不换：React 的 key 稳定，展开态不重置。
    expect(list[0]?.id).toBe(firstId)
  })
})

describe('② 同一轮里 A、B、A → 两张卡', () => {
  test('A 被 B 隔开也并回同一张：A 两张、B 一次，顺序按首次出现', () => {
    const transcript = new Transcript()
    startTurn(transcript, '开始', 2000)
    step(transcript, A, 'c1', 2010)
    step(transcript, B, 'c2', 2020)
    step(transcript, A, 'c3', 2030)

    const list = cards(transcript)
    expect(list).toHaveLength(2)
    expect(list[0]?.parts).toHaveLength(3)
    expect(list[0]?.count).toBe(2)
    expect(list[1]?.parts).toHaveLength(4)
    expect(list[1]?.count).toBe(1)
    expect(list.map((card) => card.parts.length)).toEqual([3, 4])
  })
})

describe('③ 跨轮不合并', () => {
  test('中间隔一条 user → 两张卡；上一轮那张次数不再涨，下一轮从 1 数', () => {
    const transcript = new Transcript()
    startTurn(transcript, '第一轮', 3000)
    step(transcript, A, 'c1', 3010)
    step(transcript, A, 'c2', 3020)
    transcript.reduce({ type: 'turn/end', reason: 'completed' }, 3030)
    startTurn(transcript, '第二轮', 3040)
    step(transcript, A, 'c3', 3050)

    const list = cards(transcript)
    expect(list).toHaveLength(2)
    expect(list[0]?.count).toBe(2)
    expect(list[1]?.count).toBe(1)
  })
})

describe('④ 现场形态：16 步、两轮、A / B 交替', () => {
  /** 一轮里跑若干步，指定第几步换成 B（带重复调用提醒）。 */
  function runRound(transcript: Transcript, text: string, startTs: number, atB: Set<number>, from: number, to: number): void {
    startTurn(transcript, text, startTs)
    for (let index = from; index <= to; index += 1) {
      step(transcript, atB.has(index) ? B : A, `c${String(index)}`, startTs + index)
    }
  }

  test('16 步两轮只落 4 张卡，次数分别是 7 / 3 / 5 / 1（修前是 8 张）', () => {
    const transcript = new Transcript()
    const atB = new Set([4, 6, 9, 16])
    runRound(transcript, '第一轮', 4000, atB, 1, 10)
    transcript.reduce({ type: 'turn/end', reason: 'completed' }, 4011)
    runRound(transcript, '第二轮', 4020, atB, 11, 16)

    const list = cards(transcript)
    expect(list).toHaveLength(4)
    expect(list.map((card) => card.count)).toEqual([7, 3, 5, 1])
  })

  test('④b 提醒正文不同的三条注入落 3 张卡（内容不同，不许并）', () => {
    // 真机第一轮的三条提醒正文并不相同：第 4 跳温和版、第 6 跳「连续调用了 5 次」、
    // 第 9 跳「连续调用了 8 次」。合并判据只认同 `parts`，所以真机是 6 张（不是 4 张）——
    // 这不是漏并，是三条不同的注入内容各留一张；并掉会让读者以为模型只收到过一种提醒。
    const once = (preview: string): ContextInjectionView => ({
      kind: 'repeat-reminder',
      source: 'repeat-reminder',
      where: 'user-tail',
      chars: 84,
      preview,
    })
    const B5 = [...A, once('（提醒：工具 read 已经用完全相同的参数连续调用了 5 次。')]
    const B8 = [...A, once('（提醒：工具 read 已经用完全相同的参数连续调用了 8 次。')]

    const transcript = new Transcript()
    startTurn(transcript, '开始', 4500)
    step(transcript, A, 'c1', 4510)
    step(transcript, B5, 'c2', 4520)
    step(transcript, B8, 'c3', 4530)

    const list = cards(transcript)
    expect(list).toHaveLength(3)
    expect(list.map((card) => card.count)).toEqual([1, 1, 1])
  })
})

describe('⑤ count 不进内容判等，但 parts 变了要判得出来', () => {
  /** 造一份「用户消息 + 若干次注入」的转录，返回它的条目。 */
  function replay(parts: ContextInjectionView[], times: number): Transcript {
    const transcript = new Transcript()
    startTurn(transcript, '开始', 1000)
    for (let index = 0; index < times; index += 1) {
      transcript.reduce({ type: 'context/injected', parts }, 2000 + index)
    }
    return transcript
  }

  test('count 不同仍判内容相同（重复打开会话不整表重建）', () => {
    expect(sameEntries(replay(A, 6).entries, replay(A, 1).entries)).toBe(true)
  })

  test('parts 变了就判内容不同（这条不是恒真）', () => {
    expect(sameEntries(replay(A, 6).entries, replay(B, 1).entries)).toBe(false)
  })

  test('条目数不同判内容不同（判等没有放松成长度也忽略）', () => {
    const live = replay(A, 1)
    live.reduce({ type: 'context/injected', parts: B }, 3000)
    expect(sameEntries(replay(A, 1).entries, live.entries)).toBe(false)
  })
})

describe('⑥ 空清单照旧不建条目', () => {
  test('空 parts 的 reduce 没有可见变化，条目数不变', () => {
    const transcript = new Transcript()
    startTurn(transcript, '开始', 5000)
    const before = transcript.entries.length
    const changed = transcript.reduce({ type: 'context/injected', parts: [] } as CoreEvent, 5010)
    expect(changed).toBe(false)
    expect(transcript.entries).toHaveLength(before)
  })
})
