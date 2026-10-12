/**
 * 整轮过程折叠（桌面渲染层 `round-fold.tsx` + `fold-policy.ts` 的同构移植）：
 * 每一轮「哪些条目算过程、能不能折、收尾状态」的一次性预算、总开关行组件、四档能力表。
 *
 * 「过程区」是「用户消息之后、这一轮最后一条定稿正文之前」的那段。三类条目不进组：
 * plan（审批流的一部分）、本轮最后一条定稿 text（最终回答）、直播轮里的直播尾。
 *
 * @module dsc-ui-shell/plugins/transcript/round-fold
 */
import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { TranscriptEntry } from '@dsc/ui'
import { IconChevronDown } from '@dsc/ui'
import { formatDuration, roundDuration, type RoundInfo } from './timing'

/** 过程折叠程度（UiProcessFold 的四档；契约里定义，这里本地复述一份取值）。 */
export type ProcessFold = 'compact' | 'standard' | 'detailed' | 'verbose'

/** 一个档位开启哪几项能力。 */
export interface ProcessFoldPolicy {
  /** 定稿轮把过程收成一行「用时 X」总开关。 */
  foldTurns: boolean
  /**
   * 阶段分组：全部轮给组头 / 只有历史轮给组头 / 不给组头。
   * 壳还没搬阶段组（process-groups 的大件），三档暂时都按 none 走——
   * 整轮折叠不依赖它，档位差异先体现在 foldTurns 上。
   */
  stepGrouping: 'collapsed' | 'history' | 'none'
  /** 运行中的组头显示实时任务详情。 */
  liveDetail: boolean
  /** 定稿的思考行显示首行摘要预览。 */
  reasoningPreview: boolean
}

/** 四档各自开哪几项能力（与桌面端逐格对应）。 */
export const PROCESS_FOLD_POLICIES: Readonly<Record<ProcessFold, ProcessFoldPolicy>> = {
  compact: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: false, reasoningPreview: false },
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
  /** 组内最后一条可折叠条目的下标（含）。 */
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
    // 本轮最后一条定稿正文（从后往前找，找到就走）；它之后（含它自己）都不折叠。
    let answerIndex = -1
    for (let at = round.endIndex; at > round.startIndex; at -= 1) {
      const entry = entries[at]
      if (entry !== undefined && entry.kind === 'text' && entry.id >= 0) {
        answerIndex = at
        break
      }
    }
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
      if (answerIndex >= 0 && at >= answerIndex) continue
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
    props.endReason === 'aborted' ? '已停止' : props.endReason === 'error' ? '过程失败' : used === null ? '已完成' : `用时 ${used}`
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
            ? '这一轮被中断，过程保持展开'
            : props.endReason === 'error'
              ? '这一轮跑挂了，过程保持展开'
              : '这一轮没有可折叠的过程内容'
          : props.open
            ? '收起这一轮的过程（思考与工具调用）'
            : '展开这一轮的过程（思考与工具调用）'
      }
      onClick={props.onToggle}
      onKeyDown={toggle}
    >
      <span className="turn-fold-label">{label}</span>
      {props.disabled ? null : <IconChevronDown size={11} className="turn-fold-chevron" />}
    </button>
  )
}

/** 一次折叠开合的记忆（`fold-state.ts` 的对等物）：整轮折叠的用户手动开合按轮记。
 *
 * map 存的是「**手动展开**」标记（存在=true）。默认收起是空表——「收起」不需要记，
 * 记展开就够（旧界面的 fold-state 也是这个语义：没有存档 = 按默认态走）。 */
export function useTurnFoldMemory(): {
  isOpen(roundIndex: number): boolean
  set(roundIndex: number, open: boolean): void
} {
  const [state, setState] = useState<Map<number, boolean>>(() => new Map())
  return {
    isOpen: (roundIndex) => state.get(roundIndex) === true,
    set: (roundIndex, open) => {
      setState((current) => {
        const next = new Map(current)
        if (open) next.set(roundIndex, true)
        else next.delete(roundIndex)
        return next
      })
    },
  }
}
