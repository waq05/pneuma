/**
 * 对话区的时间口径（桌面渲染层 `turn-timing.ts` 的同构移植）：每轮的起止时刻、
 * 进行中状态行的两行文案。
 *
 * 三个底层格式化（`entryTs` / `formatClock` / `formatDuration`）已搬去平台层
 * （`platform/time.ts`）——轨迹页要读同一份，这里只转出去保持调用点不变。
 * 数据缺口的口径见那边的注释：拿不到时间就返回 null，界面不画，绝不显示 NaN。
 *
 * @module dsc-ui-shell/plugins/transcript/timing
 */
import type { TranscriptEntry } from '@dsc/ui'
import { entryTs } from '../../platform/time'

// 平台层的读数原样转出（消息流内部的 import 不变）。
export { entryTs, formatClock, formatDuration } from '../../platform/time'

/** 一轮对话：一条用户消息 → 模型回复结束（中间的工具调用也算这一轮）。 */
export interface RoundInfo {
  /** 轮次编号（0 基，与右缘刻度一一对应）。 */
  index: number
  /** 用户消息在 entries 里的下标（跳转锚点就是它）。 */
  startIndex: number
  /** 这一轮最后一条条目在 entries 里的下标（还没回复时等于 startIndex）。 */
  endIndex: number
  /** 用户消息那一刻；缺 ts → null。 */
  startTs: number | null
  /**
   * 这一轮的结束时刻：从末条目往前走，取最后一条带 ts 的条目（中间缺 ts 的跳过）。
   * 一条都没带 ts → null，界面降级成「只显示开始时间」。
   */
  endTs: number | null
  /** 这一轮有没有助手侧的内容（回复、思考、工具卡都算）。 */
  answered: boolean
}

/**
 * 把 entries 切成一轮一轮：遇到一条用户消息就开一轮，其后属于模型的条目都归它，
 * 直到下一条用户消息。
 *
 * 两类条目不参与「这一轮有几条、到哪结束」：开场那条 system 提示、轮次之后冒出来的
 * system 条目（错误、宿主通知）。**轮中途插话**（steering）不另起一轮，留在原轮里。
 */
export function roundInfos(entries: readonly TranscriptEntry[]): RoundInfo[] {
  const rounds: RoundInfo[] = []
  let current: RoundInfo | null = null
  entries.forEach((entry, index) => {
    if (entry.kind === 'user') {
      if (entry.steering === true && current !== null) {
        current.endIndex = index
        const steeringTs = entryTs(entry)
        if (steeringTs !== null) current.endTs = steeringTs
        return
      }
      current = {
        index: rounds.length,
        startIndex: index,
        endIndex: index,
        startTs: entryTs(entry),
        endTs: null,
        answered: false,
      }
      rounds.push(current)
      return
    }
    if (current === null || entry.kind === 'system') return
    current.endIndex = index
    current.answered = true
    const ts = entryTs(entry)
    if (ts !== null) current.endTs = ts
  })
  for (const round of rounds) {
    // 结束时刻早于开始时刻说明日志时间乱序：按「拿不到」处理，界面只显示开始时间。
    if (round.endTs !== null && round.startTs !== null && round.endTs < round.startTs) round.endTs = null
  }
  return rounds
}

/** 这一轮的用时（毫秒）；两头只要有一头没有 ts 就是 null。 */
export function roundDuration(round: RoundInfo): number | null {
  if (round.startTs === null || round.endTs === null) return null
  const ms = round.endTs - round.startTs
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/** 这一轮是从哪一刻开始的：取最后一条**非插话**的用户消息的 ts（状态行计时用）。 */
export function turnStartedAt(entries: readonly TranscriptEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.kind === 'user' && entry.steering !== true) return entryTs(entry)
  }
  return null
}

/** 进行中状态行的两行文案：阶段说明 + 当前活动名。 */
export interface LiveActivity {
  /** 第一行：阶段说明（随阶段变化）。 */
  stage: string
  /** 第二行：当前活动名（正在思考 / 正在调用 read_file / 正在输出回复）。 */
  activity: string
}

/**
 * 从快照能看到的线索推导「现在在干什么」：直播尾思考 → 分析请求；直播尾正文 → 整理回复；
 * 有 running 的工具卡 → 正在调用那个工具（用真名）；其余按 turnState 兜底。
 * 回合已结束（idle）返回 null：状态行该消失。
 */
export function liveActivity(
  entries: readonly TranscriptEntry[],
  turnState: string,
): LiveActivity | null {
  if (turnState === 'idle') return null
  if (turnState === 'awaiting-approval') {
    return { stage: '等待你的确认', activity: '有一条工具调用等你批准' }
  }
  const tail = entries[entries.length - 1]
  if (tail !== undefined && tail.id < 0 && tail.kind === 'thinking') {
    return { stage: '正在分析请求', activity: '正在思考' }
  }
  if (tail !== undefined && tail.id < 0 && tail.kind === 'text') {
    return { stage: '正在整理回复', activity: '正在输出回复' }
  }
  const running = [...entries]
    .reverse()
    .find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> =>
        entry.kind === 'tool' && (entry.call.status === 'running' || entry.call.status === 'preparing'),
    )
  if (running !== undefined) {
    return {
      stage: '正在执行工具',
      // 「准备中」是模型还在吐参数、「正在调用」是工具真的开跑了——两句话不同
      activity:
        running.call.status === 'preparing' ? `正在准备 ${running.call.name}` : `正在调用 ${running.call.name}`,
    }
  }
  if (turnState === 'working') return { stage: '正在执行工具', activity: '正在执行工具' }
  return { stage: '正在分析请求', activity: '正在思考' }
}
