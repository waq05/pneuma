/**
 * 整轮折叠的「藏哪些行」预算器与档位表（ui 层）。
 *
 * 来源：
 * - `scripts/ui-round-fold-tail-test.mjs` 第 [1]–[5] 段（2026-11-06 报障的缺陷一：总开关
 *   朝下、过程行却露在外面）；
 * - `scripts/ui-fold-combo-test.mjs` 第 [1][2] 段（四档过程折叠 × foldedReplies ×
 *   collapseTiming = 16 格组合矩阵，2026-11-06 的两个新设置项）；
 * - `scripts/ui-fold-prefs-test.mjs` 第 [7] 段（四档 policy 表逐字未变）。
 *
 * 口径（改动落在 `round-fold.tsx`）：
 * - `foldedReplies` 决定**正文算不算过程**：all 档里范围内的正文不进 `fold.hidden`，留在
 *   屏幕上；final 档里它跟着思考与工具一起藏。这一轮最后一条正文始终在范围之外。
 * - `collapseTiming` 决定**最新一轮的默认展开态**：next-input 下它默认摊着，其余照旧收起。
 * - 四档只影响「整轮折不折」：verbose 档 foldTurns=false，于是它不画总开关、也不藏任何行。
 *
 * `buildRoundFolds` 是纯计算，这里直接 import 产品源码跑——不是复制一份规则。原探针为
 * 跑 .tsx 自带的 JSX 转译钩子与 `@dsc/ui` 桩，在 ui project（jsdom + react 插件 + 别名）
 * 里都不需要。`ui-fold-combo` / `ui-fold-prefs` 里钉渲染接线（render.tsx / ui.tsx /
 * fold-seats.tsx 的取法文本）的断言不迁，归组件渲染批。
 *
 * @module dsc-ui-transcript/ui/round-fold.spec
 */
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '@dsc/ui'
import type { FoldedReplies, ProcessFold } from './round-fold.js'
import { buildRoundFolds, PROCESS_FOLD_POLICIES, processFoldPolicy, turnDefaultOpen } from './round-fold.js'

/** 造一条条目：id 给正数（定稿），过程行用 kind 区分。 */
let seq = 0
const entry = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry
const text = (body: string): TranscriptEntry => entry('text', { text: body })
const think = (body: string): TranscriptEntry => entry('thinking', { text: body })
const tool = (name: string, status = 'done'): TranscriptEntry =>
  entry('tool', { call: { callId: `c${String(seq)}`, name, argsText: '{"command":"pnpm build"}', status } })

/** 造一轮：从 0 开始，到 entries.length - 1 结束（这些用例都只有一轮）。 */
const oneRound = (entries: TranscriptEntry[]): Parameters<typeof buildRoundFolds>[1] =>
  [{ index: 0, startIndex: 0, endIndex: entries.length - 1, startTs: 1, endTs: 2, answered: true }]

/** 跑一次预算器，取第 0 轮（默认 foldedReplies=all；要 final 就显式传）。 */
const foldOf = (entries: TranscriptEntry[], options: { foldedReplies?: FoldedReplies } = {}) =>
  buildRoundFolds(entries, oneRound(entries), {
    foldTurns: true,
    live: false,
    lastRoundIndex: 0,
    ...options,
  }).get(0)

/** 集合按下标升序打印/比对：Set 的插入顺序在这里等价于升序，但断言不该依赖它。 */
const listOf = (set: ReadonlySet<number>): string => JSON.stringify([...set].sort((left, right) => left - right))

// ── 正文 → 4 条思考 → 1 条 running 工具（报障现场） ────────────────────────────

describe('过程范围与隐藏集合', () => {
  const entries = [
    entry('user', { text: '帮我改一下折叠' }),
    text('先说改法：过程整组收起，只留一行总开关。'),
    think('思考一：先看区间是怎么算的。'),
    think('思考二：终点取的是最后一条正文。'),
    think('思考三：正文之后的工具就漏在外面了。'),
    think('思考四：改成取最后一个过程条目。'),
    tool('bash', 'running'),
  ]
  const runningAt = entries.length - 1

  test('过程范围算得出来（hasContent 由隐藏集合决定）', () => {
    expect(foldOf(entries, { foldedReplies: 'final' })?.hasContent).toBe(true)
  })

  test('范围终点 = 那条 running 工具的下标（正文之后的过程行不再漏在外面）', () => {
    expect(foldOf(entries, { foldedReplies: 'final' })?.endIndex).toBe(runningAt)
  })

  test('final：running 工具与阶段性正文都在集合里', () => {
    const final = foldOf(entries, { foldedReplies: 'final' })
    expect(final?.hidden.has(runningAt)).toBe(true)
    expect(final?.hidden.has(1)).toBe(true)
  })

  test('final：集合 = 范围里除用户消息外的每一条', () => {
    expect(listOf(foldOf(entries, { foldedReplies: 'final' })?.hidden ?? new Set())).toBe('[1,2,3,4,5,6]')
    expect(foldOf(entries, { foldedReplies: 'final' })?.hidden.has(0)).toBe(false)
  })

  test('整轮可折（没有 interrupted / error 标记）', () => {
    const final = foldOf(entries, { foldedReplies: 'final' })
    expect(final?.foldable).toBe(true)
    expect(final?.running).toBe(false)
    expect(final?.blocked).toBe(false)
  })

  test('all：阶段性正文不进集合，思考与工具照旧藏，范围读数不变', () => {
    const all = foldOf(entries, { foldedReplies: 'all' })
    expect(all?.hidden.has(1)).toBe(false)
    expect([2, 3, 4, 5, 6].every((at) => all?.hidden.has(at) === true)).toBe(true)
    expect(all?.startIndex).toBe(1)
    expect(all?.endIndex).toBe(runningAt)
    expect(listOf(all?.hidden ?? new Set())).not.toBe(listOf(foldOf(entries, { foldedReplies: 'final' })?.hidden ?? new Set()))
  })
})

describe('最终回答不许被藏', () => {
  test('过程 → 正文结尾：范围终点停在最后一条过程条目上，正文不在集合里', () => {
    const entries = [entry('user', { text: '问一句' }), think('先想一下。'), tool('read'), text('最终回答：计划卡不折叠。')]
    const answerAt = entries.length - 1
    const final = foldOf(entries, { foldedReplies: 'final' })
    expect(final?.endIndex).toBe(answerAt - 1)
    expect(final?.hidden.has(answerAt)).toBe(false)
    expect(listOf(final?.hidden ?? new Set())).toBe('[1,2]')
    // all：这一轮本来就没夹正文，集合与 final 相同。
    expect(listOf(foldOf(entries, { foldedReplies: 'all' })?.hidden ?? new Set())).toBe(listOf(final?.hidden ?? new Set()))
  })

  test('同一轮里夹了两段正文：阶段性正文被藏、最终回答不藏', () => {
    const entries = [entry('user', { text: '问' }), think('想'), text('阶段交代'), text('最终回答')]
    const final = foldOf(entries, { foldedReplies: 'final' })
    expect(final?.endIndex).toBe(2)
    expect(final?.hidden.has(2)).toBe(true)
    expect(final?.hidden.has(3)).toBe(false)
    const all = foldOf(entries, { foldedReplies: 'all' })
    expect(all?.hidden.has(2)).toBe(false)
    expect(all?.hidden.has(1)).toBe(true)
  })

  test('整轮只有一条正文、没有过程行：两档都无可藏，开关画成不可点', () => {
    const onlyText = [entry('user', { text: '问' }), text('答')]
    const emptyAll = foldOf(onlyText, { foldedReplies: 'all' })
    expect(emptyAll?.hidden.size).toBe(0)
    expect(emptyAll?.hasContent).toBe(false)
    const emptyFinal = foldOf(onlyText, { foldedReplies: 'final' })
    // 一条正文的轮里，它就是最终回答（endLimit 停在它之前），所以两档都没得藏——旧行为不变。
    expect(emptyFinal?.hidden.size).toBe(0)
    expect(emptyFinal?.hasContent).toBe(false)
  })

  test('整轮没有正文（问答中途中断）：整轮都是过程，终点就是最后一条', () => {
    const noAnswer = [entry('user', { text: '问' }), think('想'), tool('read', 'running'), think('再想')]
    const tail = foldOf(noAnswer, { foldedReplies: 'all' })
    expect(tail?.startIndex).toBe(1)
    expect(tail?.endIndex).toBe(3)
    expect(listOf(tail?.hidden ?? new Set())).toBe('[1,2,3]')
  })
})

describe('正文把隐藏集合切成两段（all 档的结构性变化）', () => {
  const entries = [
    entry('user', { text: '跑一圈' }),
    tool('read'),
    text('先读到了配置，里面的日志级别是 info。'),
    tool('bash'),
  ]

  test('all：两条工具在集合里、中间那句正文不在，集合不是连续区间', () => {
    const all = foldOf(entries, { foldedReplies: 'all' })
    expect(all?.hidden.has(1)).toBe(true)
    expect(all?.hidden.has(2)).toBe(false)
    expect(all?.hidden.has(3)).toBe(true)
    expect(listOf(all?.hidden ?? new Set())).not.toBe('[1,2,3]')
  })

  test('final：同一轮全藏，两档的范围读数一致', () => {
    const all = foldOf(entries, { foldedReplies: 'all' })
    const final = foldOf(entries, { foldedReplies: 'final' })
    expect(listOf(final?.hidden ?? new Set())).toBe('[1,2,3]')
    expect(all?.endIndex).toBe(final?.endIndex)
    expect(all?.startIndex).toBe(final?.startIndex)
  })
})

describe('多轮互不干扰 + 最新一轮的默认展开', () => {
  const entries = [
    entry('user', { text: '第一问' }),
    think('一想'),
    tool('read'),
    text('第一答'),
    entry('user', { text: '第二问' }),
    text('第二答的一半'),
    think('二想'),
    tool('bash', 'running'),
  ]
  const rounds = [
    { index: 0, startIndex: 0, endIndex: 3, startTs: 1, endTs: 2, answered: true },
    { index: 1, startIndex: 4, endIndex: 7, startTs: 3, endTs: 4, answered: true },
  ]
  const folds = buildRoundFolds(entries, rounds, { foldTurns: true, live: false, lastRoundIndex: 1, foldedReplies: 'final' })
  const first = folds.get(0)
  const second = folds.get(1)

  test('两轮的集合各自收在自己的范围内', () => {
    expect(listOf(first?.hidden ?? new Set())).toBe('[1,2]')
    expect(listOf(second?.hidden ?? new Set())).toBe('[5,6,7]')
    expect([...(first?.hidden ?? [])].every((at) => at < 4)).toBe(true)
    expect([...(second?.hidden ?? [])].every((at) => at > 3)).toBe(true)
  })

  test('只有最后一轮带 latest 标记', () => {
    expect(first?.latest).toBe(false)
    expect(second?.latest).toBe(true)
  })

  test('completion：两轮的默认态都是收起；next-input：最新一轮默认展开', () => {
    expect(turnDefaultOpen('completion', first?.latest === true)).toBe(false)
    expect(turnDefaultOpen('completion', second?.latest === true)).toBe(false)
    expect(turnDefaultOpen('next-input', second?.latest === true)).toBe(true)
    expect(turnDefaultOpen('next-input', first?.latest === true)).toBe(false)
  })
})

// ── 16 格组合矩阵（fold × foldedReplies × collapseTiming） ─────────────────────

describe('16 格组合矩阵：foldedReplies 只管正文，四档只管折不折', () => {
  /** 两轮的样张（所有档位共用，才好逐格对比）。 */
  const entries = [
    entry('user', { text: '第一问' }),
    text('先读了一遍配置，日志级别是 info。'),
    think('想一想怎么改。'),
    tool('read'),
    text('改好了。'),
    entry('user', { text: '第二问' }),
    think('再想一下。'),
    tool('bash'),
  ]
  const rounds = [
    { index: 0, startIndex: 0, endIndex: 4, startTs: 1, endTs: 2, answered: true },
    { index: 1, startIndex: 5, endIndex: 7, startTs: 3, endTs: 4, answered: true },
  ]
  const LAST = rounds.length - 1
  /** 期望：all 档范围内正文不进集合，final 档进；两份样张的静态范围与这些下标无关。 */
  const expectedHidden: Record<FoldedReplies, { first: number[]; second: number[] }> = {
    all: { first: [2, 3], second: [6, 7] },
    final: { first: [1, 2, 3], second: [6, 7] },
  }

  /** 一档一档跑：返回两轮的「渲染层实际会藏的下标」与默认展开态。 */
  const runCombo = (fold: ProcessFold, foldedReplies: FoldedReplies, collapseTiming: 'completion' | 'next-input') => {
    const folds = buildRoundFolds(entries, rounds, {
      foldTurns: processFoldPolicy(fold).foldTurns,
      live: false,
      lastRoundIndex: LAST,
      foldedReplies,
    })
    const rowOf = (roundIndex: number) => {
      const value = folds.get(roundIndex)
      // 渲染体 inFold 的口径：这一档允许整轮折叠（foldable）才藏；verbose 档一个都不藏。
      return {
        hidden: value?.foldable === true ? [...value.hidden].sort((a, b) => a - b) : [],
        hasContent: value?.hasContent === true,
        foldable: value?.foldable === true,
        latest: value?.latest === true,
        defaultOpen: turnDefaultOpen(collapseTiming, value?.latest === true),
        // 总开关行画不画（render.tsx 的 showFoldRow：可折的档位 + 已经收尾的轮）。
        row: value?.foldable === true,
      }
    }
    return { first: rowOf(0), second: rowOf(1) }
  }

  test('16 格逐格断言（4 档 × 2 回复档 × 2 时机）', () => {
    const folds = ['compact', 'standard', 'detailed', 'verbose'] as const
    const replies = ['all', 'final'] as const
    const timings = ['completion', 'next-input'] as const
    let cells = 0
    for (const fold of folds) {
      for (const foldedReplies of replies) {
        for (const collapseTiming of timings) {
          cells += 1
          const label = `${fold}/${foldedReplies}/${collapseTiming}`
          const got = runCombo(fold, foldedReplies, collapseTiming)
          const foldable = processFoldPolicy(fold).foldTurns
          // 隐藏集合：只有 verbose 档是空的（它不折整轮），其余三档按 foldedReplies 走。
          const wantFirst = foldable ? expectedHidden[foldedReplies].first : []
          const wantSecond = foldable ? expectedHidden[foldedReplies].second : []
          expect(got.first.hidden, `${label} · 第 1 轮藏的下标`).toEqual(wantFirst)
          expect(got.second.hidden, `${label} · 第 2 轮藏的下标`).toEqual(wantSecond)
          // 默认展开：只有「最新一轮 + next-input」为真。verbose 档不画总开关、整轮摊着，
          // 这个兜底值用不上，但纯函数照样按时机算（口径单一，渲染层才不用再分一份）。
          expect(got.second.defaultOpen, `${label} · 第 2 轮默认展开`).toBe(collapseTiming === 'next-input')
          expect(got.first.defaultOpen, `${label} · 第 1 轮不会默认展开`).toBe(false)
          // 总开关行：可折的档位才画。
          expect(got.first.row && got.second.row, `${label} · 总开关行按档位画`).toBe(foldable)
          // 最终回答（第 1 轮下标 4）永远不在集合里。
          expect(got.first.hidden.includes(4), `${label} · 最终回答不进隐藏集合`).toBe(false)
        }
      }
    }
    expect(cells).toBe(16)
  })

  test('同档只换 foldedReplies：第 1 轮多藏那句阶段性正文（下标 1），第 2 轮集合不变', () => {
    const allStandard = runCombo('standard', 'all', 'completion')
    const finalStandard = runCombo('standard', 'final', 'completion')
    expect(allStandard.first.hidden.includes(1)).toBe(false)
    expect(finalStandard.first.hidden.includes(1)).toBe(true)
    // 只影响正文，不影响思考与工具：行数正好差 1。
    expect(finalStandard.first.hidden.length).toBe(allStandard.first.hidden.length + 1)
    expect(finalStandard.second.hidden).toEqual(allStandard.second.hidden)
  })

  test('同档只换 collapseTiming：藏的下标一个没变，只有默认展开态变', () => {
    const completion = runCombo('detailed', 'all', 'completion')
    const nextInput = runCombo('detailed', 'all', 'next-input')
    expect(nextInput.first.hidden).toEqual(completion.first.hidden)
    expect(nextInput.second.hidden).toEqual(completion.second.hidden)
    expect(completion.second.defaultOpen).toBe(false)
    expect(nextInput.second.defaultOpen).toBe(true)
    // 历史轮两种时机都收起（它不再是最后一轮）。
    expect(completion.first.defaultOpen).toBe(false)
    expect(nextInput.first.defaultOpen).toBe(false)
  })
})

// ── 四档 policy 表（ui-fold-prefs [7]：本次只动「默认展开」的跟随，不碰过程折叠策略） ──

describe('PROCESS_FOLD_POLICIES 四档能力表', () => {
  // 2026-11-07：compact 的 reasoningPreview 改回 false（回到 dsh 的 settledReasoningPreview=false）。
  // 思考行收在阶段组里，这一格管的是「组展开后那条思考行要不要预览首行」，dsh 的紧凑档不给预览。
  test('四档能力表内容与顺序未变', () => {
    expect(PROCESS_FOLD_POLICIES).toEqual({
      compact: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: false, reasoningPreview: false },
      standard: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: true, reasoningPreview: true },
      detailed: { foldTurns: true, stepGrouping: 'history', liveDetail: true, reasoningPreview: true },
      verbose: { foldTurns: false, stepGrouping: 'none', liveDetail: false, reasoningPreview: true },
    })
  })

  test('processFoldPolicy 认识四档，缺档时给 standard 兜底（settings 的出厂口径）', () => {
    expect(processFoldPolicy('standard')).toBe(PROCESS_FOLD_POLICIES.standard)
    expect(processFoldPolicy('compact')).toBe(PROCESS_FOLD_POLICIES.compact)
    expect(processFoldPolicy('detailed')).toBe(PROCESS_FOLD_POLICIES.detailed)
    expect(processFoldPolicy('verbose')).toBe(PROCESS_FOLD_POLICIES.verbose)
    expect(processFoldPolicy(undefined)).toBe(PROCESS_FOLD_POLICIES.standard)
  })
})
