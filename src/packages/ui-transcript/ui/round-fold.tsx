/**
 * 整轮过程折叠（桌面渲染层 `round-fold.tsx` + `fold-policy.ts` 的同构移植）：
 * 每一轮「哪些条目算过程、能不能折、收尾状态」的一次性预算、总开关行组件、四档能力表。
 *
 * 「过程区」是「用户消息之后、这一轮最后一个过程条目（thinking / tool）」的那段。
 * 终点为什么不取「最后一条定稿正文」：最后一条正文之后再出现工具调用，说明那句正文只是
 * 过程中的一句交代，不是最终回答——拿它当终点会把后面真正的过程漏在折叠区间之外
 * （2026-11-06 报障：收起态下「用时 36 秒」下面还挂着 4 条思考与一条进行中的命令）。
 * 只有「最后一条正文之后没有任何过程行」时，终点才退回那条正文之前，最终回答永不被藏。
 * 三类条目不进组：plan（审批流的一部分）、最终回答（区间之外）、直播轮里的直播尾。
 *
 * @module dsc-ui-shell/plugins/transcript/round-fold
 */
import { useCallback, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createT, type TranscriptEntry } from '@dsc/ui'
import { IconChevronDown } from '@dsc/ui'
import { formatDuration, roundDuration, type RoundInfo } from './timing'
import { clearFold, clearFoldPrefix, readFold, writeFold } from './fold-state'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 过程折叠程度（UiProcessFold 的四档；契约里定义，这里本地复述一份取值）。 */
export type ProcessFold = 'compact' | 'standard' | 'detailed' | 'verbose'

/**
 * 折叠时机（设置 `ui.collapseTiming`；契约里定义，这里本地复述一份取值）。
 *
 * - `completion`（默认）：这一轮跑完就收起；
 * - `next-input`：跑完的**最后一轮**先摊着，等下一轮进来、它不再是最后一轮，才收起。
 */
export type CollapseTiming = 'completion' | 'next-input'

/**
 * 收起之后显示哪些回复（设置 `ui.foldedReplies`；契约里定义，这里本地复述一份取值）。
 *
 * - `all`：有正文的助手步骤不算过程，留在屏幕上；它里面的思考与工具仍算过程；
 * - `final`（默认，2026-11-07 起）：中间夹着的阶段性正文跟着过程一起藏，只留这一轮最后那条正文。
 *   收紧成这个默认，是因为「全部回复」下一个长任务的十几段中途说明会全摊在屏幕上，收起等于没收。
 */
export type FoldedReplies = 'all' | 'final'

/** 一个档位开启哪几项能力。 */
export interface ProcessFoldPolicy {
  /** 定稿轮把过程收成一行「用时 X」总开关。 */
  foldTurns: boolean
  /**
   * 阶段分组：全部轮给组头（collapsed）/ 只有历史轮给组头（history——跑动中的轮
   * 不分组，直播里那一段由状态行承载）/ 不给组头（none）。
   */
  stepGrouping: 'collapsed' | 'history' | 'none'
  /** 运行中的组头显示实时任务详情。 */
  liveDetail: boolean
  /** 定稿的思考行显示首行摘要预览。 */
  reasoningPreview: boolean
}

/** 四档各自开哪几项能力（与桌面端逐格对应）。 */
export const PROCESS_FOLD_POLICIES: Readonly<Record<ProcessFold, ProcessFoldPolicy>> = {
  // 紧凑档不带定稿思考的摘要预览（2026-11-07 改回 dsh 的口径：settledReasoningPreview=false，
  // presentation-policy.ts:26-32）。10-30 到 11-06 之间这一格是开的，背景是当时思考行独立
  // 挂在组外，关掉之后屏幕上只剩「思考 ∨」；现在思考行进组，收起态的组头已经替它说了
  // 「这一阶段干了什么」，摘要再单独露一行反而把组头挤回碎片。想要看某条思考，点开组头
  // 再点那条思考即可。这一格单独回滚不会影响其他三档。
  compact: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: false, reasoningPreview: false },
  standard: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: true, reasoningPreview: true },
  detailed: { foldTurns: true, stepGrouping: 'history', liveDetail: true, reasoningPreview: true },
  verbose: { foldTurns: false, stepGrouping: 'none', liveDetail: false, reasoningPreview: true },
}

/** 取某个档位的能力表；没传档位按标准档走。 */
export function processFoldPolicy(fold: ProcessFold | undefined): ProcessFoldPolicy {
  return PROCESS_FOLD_POLICIES[fold ?? 'standard']
}

/** 独立条目（不进过程区、收起整轮也不许藏的类型；对照 dsh 的 TURN_PROCESS_INDEPENDENT_KINDS）。 */
export const TURN_INDEPENDENT: ReadonlySet<TranscriptEntry['kind']> = new Set([
  'user',
  'plan',
  'system',
  'turn-end',
  'turn-max-tokens',
  // 系统提示卡与上下文注入卡（2026-11-10）：它们是**请求侧**的读数，不是这一轮的执行步骤。
  // 不放进这张表的话，一条落在过程区区间里的注入卡会跟着整轮一起被藏掉——而它恰恰是
  // 「模型当时收到了什么」的唯一线索，收起来之后用户再也找不到（与 system 同一条理由）。
  'system-prompt',
  'context-injection',
])

/**
 * 一轮过程区的折叠情况。
 */
export interface RoundFold {
  /** 轮次序号（0 基）：存展开态时要用它拼键。 */
  roundIndex: number
  /**
   * 过程区的起点（读数，不是藏不藏的判据）。
   *
   * 这一条是「过程区从哪一行开始」的读数：它可能是一条最终被留在外面的正文
   * （foldedReplies=all），所以不能拿它当「从这里开始藏」用——那件事看 {@link hidden}。
   * -1 = 这一轮没有过程内容。
   */
  startIndex: number
  /**
   * 过程区的终点（读数，含）。
   *
   * 终点认「这一轮最后一个过程条目（thinking / tool）」，不是「最后一条正文之前」：
   * 正文之后还有工具调用时，那句正文只是过程中的交代，后面那一段同样要收起来。
   */
  endIndex: number
  /**
   * 收起后**真正要藏起来**的下标集合（含）。
   *
   * 为什么从「连续区间」改成「集合」（2026-11-06）：foldedReplies=all 时中间那几段正文
   * 要留在屏幕上，藏起来的行于是被正文切成好几段——一段连续区间表达不了这件事。
   * 区间（startIndex / endIndex）保留下来当过程区的读数，藏不藏一律以这个集合为准。
   */
  hidden: ReadonlySet<number>
  /** 过程区里有没有可折的内容（= {@link hidden} 非空）。没有时照样画总开关，只是画成不可点的。 */
  hasContent: boolean
  /** 这一轮可不可以折整轮（= 这一档允许整轮折叠）。 */
  foldable: boolean
  /** 跑动中：整组强制展开、连总开关都不画。 */
  running: boolean
  /**
   * 这一轮**不能**折整轮，但总开关照画（画成不可点的）。
   * 三种情况：轮中途插过话、这一轮被中断（aborted）、这一轮跑挂了（error）。
   */
  blocked: boolean
  /** 让这一轮不能折的那个原因；正常结束或还在跑的轮是 undefined。 */
  endReason: string | undefined
  /** 这是不是最新一轮（collapseTiming=next-input 的默认展开就认它，见 {@link turnDefaultOpen}）。 */
  latest: boolean
}

/**
 * 把每一轮的过程区折叠情况算成一张表（下标 = round.index）。
 *
 * 同时这也让「开关画了、组内却没条目」这种不一致根本不可能发生。
 */
export function buildRoundFolds(
  entries: readonly TranscriptEntry[],
  rounds: readonly RoundInfo[],
  options: {
    foldTurns: boolean
    live: boolean
    lastRoundIndex: number
    /** 收起之后显示哪些回复（默认 final，与 settings 的出厂口径一致）。 */
    foldedReplies?: FoldedReplies
  },
): Map<number, RoundFold> {
  const out = new Map<number, RoundFold>()
  // 「有正文的助手步骤不算过程」是 all 档的定义；final 档里它跟着过程一起藏。
  const keepReplies = (options.foldedReplies ?? 'final') === 'all'
  for (const round of rounds) {
    // 本轮最后一条定稿正文（从后往前找，找到就走）：**只有它后面再没有过程行时**，
    // 它才是最终回答。
    let answerIndex = -1
    // 本轮最后一个过程条目（thinking / tool）：过程区真正的终点。
    let lastProcessIndex = -1
    for (let at = round.endIndex; at > round.startIndex; at -= 1) {
      const entry = entries[at]
      if (entry === undefined) continue
      if (lastProcessIndex < 0 && (entry.kind === 'thinking' || entry.kind === 'tool')) lastProcessIndex = at
      if (answerIndex < 0 && entry.kind === 'text' && entry.id >= 0) answerIndex = at
      if (answerIndex >= 0 && lastProcessIndex >= 0) break
    }
    /**
     * 折叠区间的终点（含）。
     *
     * 正文之后还有过程行（lastProcessIndex > answerIndex）⇒ 那条正文不是最终回答，
     * 终点就取最后那条过程行——中间夹着的阶段性正文也一起算过程，跟着整轮收起。
     * 正文之后没有过程行 ⇒ 退回旧口径：终点停在最后一条正文之前，最终回答一个字都不藏。
     * 一轮里没有定稿正文（answerIndex < 0）⇒ 整轮都是过程，终点取轮末。
     */
    const endLimit =
      lastProcessIndex > answerIndex
        ? lastProcessIndex
        : answerIndex >= 0
          ? answerIndex - 1
          : round.endIndex
    let startIndex = -1
    let endIndex = -1
    let hasLiveEntry = false
    /** 轮内插过话（steering）——插过话的轮不给整轮折叠。 */
    let hasSteering = false
    /** 轮尾标记给的结束原因。只有中断 / 失败才落这一条。 */
    let endReason: string | undefined
    for (let at = round.startIndex + 1; at <= round.endIndex; at += 1) {
      const entry = entries[at]
      if (entry === undefined) continue
      if (entry.id < 0) hasLiveEntry = true
      if (entry.kind === 'user' && entry.steering === true) hasSteering = true
      if (entry.kind === 'turn-end') endReason = entry.reason
      if (entry.kind !== 'thinking' && entry.kind !== 'tool' && entry.kind !== 'text') continue
      // 只算到 endLimit（见上面那段）：最终回答排在最后一条过程之后时，这里天然把它排除在外。
      if (at > endLimit) continue
      if (startIndex < 0) startIndex = at
      endIndex = at
    }
    /**
     * 收起后要藏的下标：过程区范围内、且不是独立条目的行。
     *
     * foldedReplies=all 时正文不进集合——有正文的助手步骤是给用户看的话，哪怕它后面
     * 紧跟着工具调用也不藏（它只是「过程里的一句交代」，但仍然是话）；这一轮**最后一条**
     * 正文本来就在范围之外（见上面的 endLimit），一个字都不藏。
     */
    const hidden = new Set<number>()
    if (startIndex >= 0) {
      for (let at = startIndex; at <= endIndex; at += 1) {
        const entry = entries[at]
        if (entry === undefined) continue
        if (TURN_INDEPENDENT.has(entry.kind)) continue
        // 「全部回复」档留下的是**回复**；过程正文（调工具之前的那句前言）不算回复，
        // 它跟思考、工具同属过程，收起整轮时一起藏（2026-11-07 起，见 contract 的 text 分支）。
        if (keepReplies && entry.kind === 'text' && entry.process !== true) continue
        hidden.add(at)
      }
    }
    out.set(round.index, {
      roundIndex: round.index,
      startIndex,
      endIndex,
      hidden,
      // 有正文可留的 all 档里，「这一轮只有正文」就没什么可折的：照样画总开关，画成不可点。
      hasContent: hidden.size > 0,
      foldable: options.foldTurns,
      // 跑动中的两种形态都算「这一轮还没收尾」：出现了直播条目（id<0），或者这就是最后一轮
      // 而回合还没结束，或者用户刚发完消息、助手一个字都还没回（answered 为假）。
      running: hasLiveEntry || (options.live && round.index === options.lastRoundIndex) || !round.answered,
      blocked: hasSteering || endReason === 'aborted' || endReason === 'error',
      endReason,
      latest: round.index === options.lastRoundIndex,
    })
  }
  return out
}

/**
 * 收起整轮的默认展开态（render.tsx 的兜底值来源，**不做定时器**）。
 *
 * 参考实现（dsh 的 `ChatNodeSeat.tsx:61-72` 与 `stores.ts:36-44` 的 turnProcessOpen）：
 * 用户手点过的选择优先；没点过时，只有「最新一轮 + collapseTiming=next-input」默认展开。
 * 于是跑完的最后一轮先摊着，下一轮一进来它不再是最后一轮，兜底当场翻成收起——不需要
 * 「等下一轮再发一个定时器去收」那一步。
 *
 * @param collapseTiming 设置里的折叠时机
 * @param latest 这一轮是不是最新一轮（{@link RoundFold.latest}）
 */
export function turnDefaultOpen(collapseTiming: CollapseTiming, latest: boolean): boolean {
  return collapseTiming === 'next-input' && latest
}

/**
 * 整轮过程折叠的总开关行：一行左对齐的小字按钮，「用时 X」（算不出用时就是「已完成」，
 * 绝不显示 NaN）+ 行尾箭头，整行可点。
 *
 * 三种结束状态各有一句话：被中断说「已停止」、跑挂说「过程失败」，其余才报到「用时 X」。
 * 后两种把这一行画成不可点的，因为那一轮的过程要一直摊着给用户看。
 */
export function TurnFoldRow(props: {
  open: boolean
  round: RoundInfo
  disabled: boolean
  endReason: string | undefined
  onToggle(): void
}): ReactNode {
  const used = formatDuration(roundDuration(props.round))
  const label =
    props.endReason === 'aborted'
      ? t('transcript.fold.stopped')
      : props.endReason === 'error'
        ? t('transcript.fold.failed')
        : used === null
          ? t('transcript.fold.done')
          : t('transcript.fold.duration', { duration: used })
  const toggle = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    props.onToggle()
  }
  return (
    <button
      type="button"
      className="turn-fold"
      // 展开态走 data-open，样式里靠它转箭头
      data-open={props.open ? '1' : undefined}
      data-round-index={props.round.index}
      data-turn-blocked={props.disabled ? '1' : undefined}
      disabled={props.disabled}
      // 不可折时这一行只是抬头：报一句「这一轮收成什么样」，不给开合承诺
      aria-expanded={props.disabled ? undefined : props.open}
      data-tip={
        props.disabled
          ? props.endReason === 'aborted'
            ? t('transcript.fold.tipAborted')
            : props.endReason === 'error'
              ? t('transcript.fold.tipError')
              : t('transcript.fold.tipEmpty')
          : props.open
            ? t('transcript.fold.tipCollapse')
            : t('transcript.fold.tipExpand')
      }
      onClick={props.onToggle}
      onKeyDown={toggle}
    >
      <span className="turn-fold-label">{label}</span>
      {props.disabled ? null : <IconChevronDown size={11} className="turn-fold-chevron" />}
    </button>
  )
}

/**
 * 折叠开合的双层记忆：React state 管「点一下当场重画」，fold-state（进程内的存档）管
 * 「重挂后读回来」——键由 turnFoldKey / stepGroupFoldKey 拼（会话 id + 轮 + 组首行身份），
 * 切会话重挂时展开态原样回来。
 *
 * `clearPrefixes` 是「整轮收起复位」用的（2026-11-10 改，对齐 dsh）：一条轮**从展开变成
 * 收起**的那一刻，把这一轮里所有行与阶段组的展开存档抹掉，它们于是回到各自的默认收起态。
 *
 * 为什么不是「轮一收尾就复位」（改成现在这条之前是那样）：跑动中用户点开的思考/组，在
 * 一轮正常结束、还没被收起的时候就被写回收起，等于替用户做了一次手动收起；参考实现对
 * 这件事的口径是「整轮被折叠隐藏时才复位内部」（`ChatNodeSeat.tsx:122-131` 的
 * disclosureReset 只在 `processHidden && hiddenOrCollapsing` 时推进）。
 */
export function useFoldMemory(): {
  open(key: string, fallback: boolean): boolean
  set(key: string, open: boolean): void
  reset(keys: readonly string[]): void
  clear(keys: readonly string[]): void
  clearPrefixes(prefixes: readonly string[]): void
} {
  const [map, setMap] = useState<Record<string, boolean>>({})
  const open = useCallback(
    (key: string, fallback: boolean): boolean => map[key] ?? readFold(key, fallback),
    [map],
  )
  const set = useCallback((key: string, next: boolean): void => {
    writeFold(key, next)
    setMap((current) => ({ ...current, [key]: next }))
  }, [])
  const reset = useCallback((keys: readonly string[]): void => {
    if (keys.length === 0) return
    for (const key of keys) writeFold(key, false)
    setMap((current) => {
      let next = current
      for (const key of keys) {
        if (next[key] === undefined) continue
        if (next === current) next = { ...current }
        delete next[key]
      }
      return next
    })
  }, [])
  /**
   * 抹掉存档而不是写一个值：抹掉之后这一条重新由兜底（设置里的默认态）决定。
   *
   * 为什么收起时机要它：next-input 下跑完的最后一轮该**默认摊着**，那是兜底算出来的；
   * 收尾复位如果照 completion 档写一个 false，就等于替用户做了「手动收起」的选择，
   * 之后下一轮进来它也不会再回到兜底。抹掉之后兜底随「是不是最新一轮」自然翻面。
   */
  const clear = useCallback((keys: readonly string[]): void => {
    if (keys.length === 0) return
    for (const key of keys) clearFold(key)
    setMap((current) => {
      let next = current
      for (const key of keys) {
        if (next[key] === undefined) continue
        if (next === current) next = { ...current }
        delete next[key]
      }
      return next
    })
  }, [])
  /**
   * 按前缀抹掉一批（整轮收起时清这一轮里的行与组，见模块注释）。
   *
   * 为什么按前缀：一轮里有多少条思考/工具/阶段组是渲染期现算的，发起复位的地方拿不到
   * 那份清单；而存档键形状固定（`会话id:r<轮>:…` 与 `会话id:step:r<轮>:…`）。
   */
  const clearPrefixes = useCallback((prefixes: readonly string[]): void => {
    if (prefixes.length === 0) return
    clearFoldPrefix(prefixes)
    setMap((current) => {
      let next = current
      for (const key of Object.keys(current)) {
        if (!prefixes.some((prefix) => key.startsWith(prefix))) continue
        if (next === current) next = { ...current }
        delete next[key]
      }
      return next
    })
  }, [])
  return useMemo(() => ({ open, set, reset, clear, clearPrefixes }), [open, set, reset, clear, clearPrefixes])
}
