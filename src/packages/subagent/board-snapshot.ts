/**
 * 任务板快照：**易变段**的正文与「什么时候该注入」的纯逻辑。
 *
 * ## 为什么要有这个模块
 *
 * 团队板的数据（任务、进展、活动、队友状态）每轮都可能变。2026-11 用户报障：它原先
 * 由 `boardPromptText()` 拼进**系统提示词**的 `team` 段，于是每次请求的系统提示 hash
 * 都不同——转录里连着冒出三张「系统提示」卡，服务端前缀缓存（`core/llm.ts:777` 的
 * 头部断点）每轮作废，实测命中率只剩约 50%。
 *
 * 修法是把稳定段与易变段分开：系统提示的 `team` 段只留介绍与规矩（逐字常量），看板
 * 数据改走投影注入到请求尾部，并且**只有看板真的变了才注入**。于是多数轮次里系统提示
 * 与消息前缀都不动，缓存能继续命中。
 *
 * 这个文件只放纯函数与台账（不碰 ctx、不读盘），投影本体在 `index.ts` 注册；拆开是为了
 * 让「正文格式 / 长度上限 / 水位判据」能被单元测试直读。
 *
 * @module @pneuma/subagent/board-snapshot
 */
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import type { TeamActivity, TeamBoard, TeamTask } from '@pneuma/runtime/core/team-board.js'
import { isReady } from '@pneuma/runtime/core/team-board.js'

/** 快照正文的限量：任务/活动条数与总字符数（注入在每次请求尾部，太肥会拖慢每一跳）。 */
export const BOARD_SNAPSHOT_LIMITS = {
  /** 最多列几条任务（按板上顺序，新的板子通常先列正在做的）。 */
  tasks: 10,
  /** 最多列几条最近活动。 */
  activity: 8,
  /** 注入正文总字符上限（UTF-16 code unit，与系统提示其他「字数」同一口径）。 */
  chars: 1500,
  /** 每条任务「最新进展」截断长度。 */
  noteChars: 80,
  /** 每条活动正文截断长度（活动正文上限 400，注入里再收紧，好让 8 条都装得下）。 */
  activityChars: 80,
} as const

/** 快照正文的固定开头（模型与人都靠它认出「这是程序附的最新看板」）。 */
export const BOARD_SNAPSHOT_HEAD = '# 共享任务板快照'

/**
 * 上下文注入卡上的类别（`ContextInjectionView.kind`）。
 *
 * 契约里的已知类别表（`CONTEXT_INJECTION_KINDS`）没有这一项，但字段类型是 string：
 * 表外的类别照样能记卡，界面按通用「上下文注入」画，不丢数据（见 `contract/transcript.ts`
 * 的注释）。为这次修复不改契约，先按字面量用；界面要中文标签时再加常量。
 */
export const BOARD_SNAPSHOT_KIND = 'team-board'

/** 快照第一段的说明：点明它不是用户发言、完整内容去哪儿看。 */
const SNAPSHOT_HINT = '（程序在看板变化后自动附上的最新快照，不是用户发言；完整内容用 team_task list / action=activity 查）'

/** 正文被限量砍过时的收尾提示。 */
const TRUNCATED_HINT = '（快照已截断，其余任务与活动用 team_task list / action=activity 看）'

/** 一条任务摘要（队友提示词、Lead 板子快照、`team_task list` 共用同一份格式）。 */
export function taskDigestLine(board: TeamBoard, task: TeamTask, noteChars = 80): string {
  const flags = [
    isReady(board, task) ? '可开工' : '',
    task.assignee === null ? '' : `绑定 ${task.assignee}`,
    task.blockedReason === null ? '' : `卡住：${task.blockedReason.replace(/\s+/g, ' ').slice(0, 80)}`,
  ].filter((part) => part !== '')
  const note = task.notes[0]
  const latest =
    note === undefined || noteChars <= 0
      ? ''
      : `｜最新进展（${note.by}）：${note.text.replace(/\s+/g, ' ').slice(0, noteChars)}`
  return `- ${task.id} [${task.status}${flags.length === 0 ? '' : ` · ${flags.join(' · ')}`}] ${task.subject}${task.owner === null ? '' : ` @${task.owner}`}${latest}`
}

/**
 * 一行活动摘要（队友提示词与 Lead 板子快照共用）。
 * @param textChars - 正文截断长度；0（缺省）= 不截断（`team_task activity` 要全文）
 */
export function activityDigestLine(entry: TeamActivity, textChars = 0): string {
  const clock = new Date(entry.at)
  const hh = String(clock.getHours()).padStart(2, '0')
  const mm = String(clock.getMinutes()).padStart(2, '0')
  const text =
    textChars > 0 && entry.text.length > textChars ? `${entry.text.slice(0, textChars)}…` : entry.text
  return `- ${hh}:${mm} ${entry.by} ${entry.kind}${entry.taskId === undefined ? '' : ` ${entry.taskId}`}：${text}`
}

/**
 * 看板水位：用它判断「这份快照是不是已经给模型看过了」。
 *
 * 三个分量缺一不可：
 * - `revision`：任务的新建/认领/结项/进展/阻塞/绑定都走 CAS，改动必涨；
 * - `activity.length`：队友互发消息这类**纯活动追加不动 revision**，只看 revision 会漏；
 * - 最新一条活动的 `at`：活动条数会被 {@link MAX_ACTIVITY} 封顶（200），到顶后条数不再
 *   增长、只换内容，靠它兜住那一截。
 */
export function boardSnapshotWatermark(board: TeamBoard): string {
  return `${String(board.revision)}:${String(board.activity.length)}:${String(board.activity[0]?.at ?? 0)}`
}

/** 拼一份快照正文（限量见 {@link BOARD_SNAPSHOT_LIMITS}）。 */
export function boardSnapshotText(board: TeamBoard): string {
  // 顺序口径（重放必须可复现）：任务按**板上顺序**（create 只追加、id 单调；改状态/绑定
  // 不换位，删除也不会把后建的挪到前面），活动本来就按时间新的在前（`appendActivity` 用
  // unshift）。两者都不放相对时间/随机量，同一块板算两次逐字相同。
  const taskLines = board.tasks
    .slice(0, BOARD_SNAPSHOT_LIMITS.tasks)
    .map((task) => taskDigestLine(board, task, BOARD_SNAPSHOT_LIMITS.noteChars))
  const activityLines = board.activity
    .slice(0, BOARD_SNAPSHOT_LIMITS.activity)
    .map((entry) => activityDigestLine(entry, BOARD_SNAPSHOT_LIMITS.activityChars))

  const render = (tasks: readonly string[], activity: readonly string[], dropped: boolean): string => {
    const blocks = [
      `${BOARD_SNAPSHOT_HEAD}（第 ${String(board.revision)} 版）\n${SNAPSHOT_HINT}`,
      tasks.length === 0 ? '板上还没有任务。' : `板上的任务（含负责人与最新进展）：\n${tasks.join('\n')}`,
      `最近活动（新的在前）：\n${activity.length === 0 ? '- （暂无）' : activity.join('\n')}`,
    ]
    const text = blocks.join('\n\n')
    return dropped ? `${text}\n${TRUNCATED_HINT}` : text
  }

  // 超长时先丢活动尾部（活动是索引，正文在任务进展里），再丢任务尾部；都丢光还超
  // （单行过长）才硬截断。任何一步都把结尾提示接上，读的人知道「这里不是全部」。
  const tasks = [...taskLines]
  const activity = [...activityLines]
  let dropped = false
  let text = render(tasks, activity, dropped)
  while (text.length > BOARD_SNAPSHOT_LIMITS.chars && activity.length > 0) {
    activity.pop()
    dropped = true
    text = render(tasks, activity, dropped)
  }
  while (text.length > BOARD_SNAPSHOT_LIMITS.chars && tasks.length > 0) {
    tasks.pop()
    dropped = true
    text = render(tasks, activity, dropped)
  }
  if (text.length > BOARD_SNAPSHOT_LIMITS.chars) {
    const room = Math.max(0, BOARD_SNAPSHOT_LIMITS.chars - TRUNCATED_HINT.length - 2)
    text = `${text.slice(0, room)}…${TRUNCATED_HINT}`
  }
  return text
}

/** 这条会话已经走到第几轮：历史里有几条 assistant 消息（0 基）。 */
export function countRounds(messages: readonly ChatMessage[]): number {
  let rounds = 0
  for (const message of messages) {
    if (message.role === 'assistant') rounds += 1
  }
  return rounds
}

/**
 * 「用户轮」的键：会话历史里 user 消息的条数 + 最后一条 user 的落库时刻。
 *
 * 为什么要单独一个键：注入不落会话历史（投影注入、只进请求），所以板子长时间不变时，
 * 模型在后续轮次里**手里没有那份快照**。用户每开一个新回合（含队友汇报、用户插话这类
 * 会落成 user 消息的输入），模型就是重新开一段上下文——这时把最新快照再给一次成本几乎
 * 为零：新的用户消息本来就不在上一轮的缓存前缀里，快照跟着它进尾部，不会击穿前缀。
 * 同一用户回合内部（工具步骤之间）仍然只看水位，不重复注入。
 *
 * 取 `session.messages`（日志原文）而不是投影链里那份请求：env-facts / 待办提醒 / 本投影
 * 都往请求尾部追加 user 消息，混进来会让「轮」每步都变。日志里的 user 才是真人（或后台
 * 输入）发的话。
 *
 * @param messages - 会话历史（`session.messages`）
 */
export function userTurnKey(messages: readonly ChatMessage[]): string {
  let count = 0
  let lastTs = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    count += 1
    if (typeof message.ts === 'number') lastTs = message.ts
  }
  return `${String(count)}:${String(lastTs)}`
}

/** 一条会话上一次注入快照时的水位与轮号。 */
interface SnapshotSeen {
  mark: string
  round: number
  /** 注入时的用户轮键（{@link userTurnKey}）。 */
  userKey: string
}

/**
 * 注入节流台账：按会话记住「上一次真注入快照时的水位、轮号与用户轮键」。
 *
 * 判据不是「这份正文出现过没有」（注入不落历史，查不到），而是三个触发条件：
 * - **换了用户轮** → 该注入：新回合开新上下文，模型需要当前看板（成本近零，见
 *   {@link userTurnKey} 的说明）；
 * - **水位变了** → 该注入（看板有新进展）；
 * - 水位没变、还是同一轮的重复派生 → 也要注入：回合环在请求发出前会把投影链再跑一遍做
 *   invariant 校验（`packages/session-core/loop.ts:611`），两遍必须给出同一份请求，否则
 *   会误报「日志 + 投影链对不上」；流中断后的整轮重试同理。
 * - 以上都不成立（同一用户轮、水位没变、到了下一工具轮） → 不注入。
 * - 轮号倒退（历史被压缩/重放） → 当首次，重新注入一次。
 *
 * 只活内存：进程重启后一律当「首次」，宁可多注入一次，也不要让模型拿着过期的板子
 * 做决定（与 `core/todo-reminder-cadence.ts` 同一条取舍）。
 */
export class BoardSnapshotWatermark {
  /** 会话 id → 上一次真注入时的水位、轮号与用户轮键。 */
  private readonly seen = new Map<string, SnapshotSeen>()

  /**
   * 这一跳该不该注入快照。
   * @param sessionId - 会话 id（`session.meta.id`）；不同会话互不影响
   * @param mark - 当前看板水位（{@link boardSnapshotWatermark}）
   * @param round - 这一跳的轮号（{@link countRounds}）
   * @param userKey - 用户轮键（{@link userTurnKey}）
   */
  due(sessionId: string, mark: string, round: number, userKey: string): boolean {
    const prev = this.seen.get(sessionId)
    if (prev === undefined) return true
    // 新用户轮：模型重新开一段上下文，把当前看板交给它（尾部注入，不击穿前缀缓存）。
    if (prev.userKey !== userKey) return true
    // 轮号倒退：历史被压缩过，之前记的轮号已经不在同一条数轴上了 → 当首次。
    if (prev.round > round) return true
    // 看板变了 → 必须注入最新快照。
    if (prev.mark !== mark) return true
    // 同一轮的重复派生（invariant 校验 / 整轮重试）：必须给同一个答案。
    return prev.round === round
  }

  /**
   * 记下这一跳真的注入了快照。
   * 表满时整表清掉（与 todo 的节流台账同一条取舍）：清完所有会话按「首次」重来一次。
   */
  mark(sessionId: string, mark: string, round: number, userKey: string): void {
    if (this.seen.size >= 64 && !this.seen.has(sessionId)) this.seen.clear()
    this.seen.set(sessionId, { mark, round, userKey })
  }
}
