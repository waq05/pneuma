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
import { readFold, writeFold } from './fold-state'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 过程折叠程度（UiProcessFold 的四档；契约里定义，这里本地复述一份取值）。 */
export type ProcessFold = 'compact' | 'standard' | 'detailed' | 'verbose'

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
  // 紧凑档也带摘要（2026-10-30 用户拍板）：这一档管的是「定稿的回合收成一行用时」，
  // 它不该顺手把行内摘要一起删掉——摘要回答的是「这条思考讲了什么」，与整轮折不折是两件事。
  // 删掉之后紧凑档的过程行只剩「思考 ∨」「工具调用 · run_code」这种没有内容的标题，
  // 用户的原话是「现在的思考行没有思考摘要显示」。
  compact: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: false, reasoningPreview: true },
  standard: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: true, reasoningPreview: true },
  detailed: { foldTurns: true, stepGrouping: 'history', liveDetail: true, reasoningPreview: true },
  verbose: { foldTurns: false, stepGrouping: 'none', liveDetail: false, reasoningPreview: true },
}

/** 取某个档位的能力表；没传档位按标准档走。 */
export function processFoldPolicy(fold: ProcessFold | undefined): ProcessFoldPolicy {
  return PROCESS_FOLD_POLICIES[fold ?? 'standard']
}

/**
 * 一轮过程区的折叠情况。
 */
export interface RoundFold {
  /** 轮次序号（0 基）：存展开态时要用它拼键。 */
  roundIndex: number
  /** 总开关行画在这一条前面（= 组内第一条可折叠条目）；-1 = 这一轮没有过程内容。 */
  startIndex: number
  /**
   * 组内最后一条可折叠条目的下标（含）。
   *
   * 终点认「这一轮最后一个过程条目（thinking / tool）」，不是「最后一条正文之前」：
   * 正文之后还有工具调用时，那句正文只是过程中的交代，后面那一段同样要收起来。
   */
  endIndex: number
  /** 过程区里有没有可折的内容。没有时照样画总开关，只是画成不可点的。 */
  hasContent: boolean
  /** 这一轮可不可以折整轮（= 有过程内容）。 */
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
}

/**
 * 把每一轮的过程区折叠情况算成一张表（下标 = round.index）。
 *
 * 同时这也让「开关画了、组内却没条目」这种不一致根本不可能发生。
 */
export function buildRoundFolds(
  entries: readonly TranscriptEntry[],
  rounds: readonly RoundInfo[],
  options: { foldTurns: boolean; live: boolean; lastRoundIndex: number },
): Map<number, RoundFold> {
  const out = new Map<number, RoundFold>()
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
    const hasContent = startIndex >= 0
    out.set(round.index, {
      roundIndex: round.index,
      startIndex,
      endIndex,
      hasContent,
      foldable: options.foldTurns,
      // 跑动中的两种形态都算「这一轮还没收尾」：出现了直播条目（id<0），或者这就是最后一轮
      // 而回合还没结束，或者用户刚发完消息、助手一个字都还没回（answered 为假）。
      running: hasLiveEntry || (options.live && round.index === options.lastRoundIndex) || !round.answered,
      blocked: hasSteering || endReason === 'aborted' || endReason === 'error',
      endReason,
    })
  }
  return out
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
 * 折叠开合的双层记忆（旧桌面版 ChatView 的同款组合）：React state 管「点一下当场重画」，
 * fold-state（进程内的存档）管「重挂后读回来」——键由 turnFoldKey / stepGroupFoldKey
 * 拼（会话 id + 轮 + 组），切会话重挂时展开态原样回来。
 *
 * reset 是「轮收尾复位」用的：一轮从跑动落到定稿那一刻，把整轮与它下面所有阶段组的
 * 开合写回默认（收起）——旧版语义「收起整轮会重置内部组及推理、工具的开合」。
 */
export function useFoldMemory(): {
  open(key: string, fallback: boolean): boolean
  set(key: string, open: boolean): void
  reset(keys: readonly string[]): void
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
  return useMemo(() => ({ open, set, reset }), [open, set, reset])
}
