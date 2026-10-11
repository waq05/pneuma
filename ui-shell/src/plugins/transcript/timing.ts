/**
 * 对话区的时间口径（桌面渲染层 `turn-timing.ts` 的同构移植）：每轮的起止时刻、
 * 时刻与用时的格式化、进行中状态行的两行文案。
 *
 * 数据缺口（这一块的难点）：transcript 条目上的 `ts` 是可选的——2026-09 之前的会话
 * 日志没记时间。所以这里每个函数对「没有 ts」「ts 不是有限数」「用时算出来是负的」
 * 一律返回 null，由界面决定「不画」。绝不显示 NaN，也不拿「现在」冒充历史时刻。
 *
 * @module dsc-ui-shell/plugins/transcript/timing
 */
import type { TranscriptEntry } from '@dsc/ui'

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

/** 取出条目上可信的时间戳；没有或不是有限正数就是 null。 */
export function entryTs(entry: TranscriptEntry | undefined): number | null {
  if (entry === undefined) return null
  const ts = entry.ts
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : null
}

/** 毫秒时间戳 → 本机时区的 `HH:mm`；拿不到合法时间戳返回 null。 */
export function formatClock(ts: number | null): string | null {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return null
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return null
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * 毫秒 → 「2分41秒」/「8秒」/「1时02分05秒」。
 * 不足 1 秒也写「1秒」：真实耗时可以是 400ms，写「0秒」看着像坏了。
 */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  const total = Math.max(1, Math.round(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${String(hours)}时${pad(minutes)}分${pad(seconds)}秒`
  if (minutes > 0) return `${String(minutes)}分${String(seconds)}秒`
  return `${String(seconds)}秒`
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
