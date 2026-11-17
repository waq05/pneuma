/**
 * 共享任务板与信箱：队友之间协调用的两个明文文件。
 *
 * dsh 把协调状态存在 Lead 的会话日志里（它有会话事件体系）；dsc 没有那套东西，
 * 所以这里直接落两个文件，你能用编辑器双击打开看：
 *
 * - `~/.dsc/team/boards/<会话 id>.json` —— 任务板：三态 + 单调 revision + CAS 抢单 +
 *   依赖图 + 写作用域告警。板子按会话各一块（对照 dsh 团队挂在 lead 会话之下）：
 *   切到别的会话就是另一块板，互不见。写作用域只是提醒，不是锁：两个任务的作用域
 *   重叠时照样允许开工，重叠会被记进 warnings，最后由 Lead 看 diff 裁决。
 * - `~/.dsc/team/inbox/<队友名>.jsonl` —— 传话台账：要给队友的话先追加一条文件，
 *   再交给它的循环。队友正在干活时，这条话排在它当前回合之后被看到。
 *
 * @module dsc/core/team-board
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TeamActivityView, TeamBoardView, TeamTaskNoteView } from '../contract.js'
import { dscPath } from './path-policy.js'

/** 团队目录（任务板 + 信箱）。 */
export const TEAM_ROOT = dscPath('team')
/** 任务板目录（每个会话一块板）。 */
export const BOARDS_DIR = join(TEAM_ROOT, 'boards')
/** 信箱目录（每个队友一个 jsonl）。 */
export const INBOX_DIR = join(TEAM_ROOT, 'inbox')

/**
 * 队友干完活投给父会话的那条汇报，正文固定以这个开头。
 *
 * 为什么要有它、而不是两处各写一份字面量：adapter 靠这个前缀把这条消息认出来
 * （跟压缩摘要的 `SUMMARY_BANNER` 同一个套路），认出后给条目打 `internal` 标记，
 * 界面就不再把它当「人打的字」渲染（对照 dsh 的 turn-trigger 节点：非人发起的
 * 唤醒消息渲染成一行可展开的「子任务状态更新」，不是用户气泡）。
 * 插件与 adapter 共用同一个常量，改一处漏一处就会出现「汇报又原样冒出来」。
 */
export const TEAMMATE_REPORT_OPEN = '<teammate-report '

/**
 * 审查队友收工投给发起会话的那条 findings，正文固定以这个开头。
 *
 * 与 {@link TEAMMATE_REPORT_OPEN} 同一个套路、同一份理由：adapter 靠前缀认出它、
 * 给条目打 `internal` 标记，界面就不把整段 `<review-findings …>` 当「人打的字」
 * 原样渲染（那是审查队友的机器汇报，不是用户发言）。插件与 adapter 共用这一份字面量。
 */
export const REVIEW_FINDINGS_OPEN = '<review-findings '

/** 任务状态机：pending → in_progress → completed，只有三态，没有中间态。 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']

/** 任务板上限，防一个模型一口气写 500 条把文件灌爆。 */
const MAX_TASKS = 256
/** 信箱单条消息长度上限。 */
const MAX_INBOX_CHARS = 8000
/** 每个任务保留的进展条数上限（新的在前，写档时截断）。 */
export const MAX_NOTES_PER_TASK = 20
/** 板级活动时间线的条数上限（新的在前，写档时截断）。 */
export const MAX_ACTIVITY = 200
/** 一条进展正文的长度上限。 */
const MAX_NOTE_CHARS = 2000
/** 一条活动摘要的长度上限：活动是索引，正文留在任务进展里。 */
const MAX_ACTIVITY_CHARS = 400

/** 一条任务进展：谁在什么时候写了什么（`notes` 新的在前）。 */
export interface TeamTaskNote {
  at: number
  by: string
  text: string
}

/** 板级活动类型（与契约 `TeamActivityView.kind` 同一套字面量）。 */
export type TeamActivityKind = 'create' | 'claim' | 'note' | 'complete' | 'release' | 'message'

const ACTIVITY_KINDS: readonly TeamActivityKind[] = ['create', 'claim', 'note', 'complete', 'release', 'message']

/** 板级活动：谁在什么时候做了什么（`activity` 新的在前）。 */
export interface TeamActivity {
  at: number
  by: string
  /** 关联的任务 id；纯消息等没有关联时为 undefined。 */
  taskId?: string
  kind: TeamActivityKind
  text: string
}

export interface TeamTask {
  id: string
  subject: string
  description: string
  status: TaskStatus
  /** 认领它的队友名；null = 没人认领。 */
  owner: string | null
  /** 依赖的任务 id；全部 completed 才算 ready。 */
  blockedBy: string[]
  /** 打算改的路径前缀（只用于重叠告警，不是锁）。 */
  writeScopes: string[]
  createdAt: number
  updatedAt: number
  /**
   * 进展记录：谁在什么时候做到哪一步（新的在前，最多 {@link MAX_NOTES_PER_TASK} 条）。
   *
   * 为什么挂在任务上而不是塞进 description：description 是任务书（写一次就基本不动），
   * 进展是流水（每次推进都追加）。混在一起前者会被后来的进展淹没，模型也分不清
   * 「原始要求」与「最新状态」。
   */
  notes: TeamTaskNote[]
  /** 卡住的原因；null = 没卡（状态机仍是三态，不引入第四态）。 */
  blockedReason: string | null
  /** 绑定的队友名（spawn 带 `task_id` 时自动填）；null = 未绑定。 */
  assignee: string | null
}

export interface TeamBoard {
  version: 1
  /** 每次成功变更 +1；变更方必须报出自己看到的版本，不匹配就拒绝（CAS）。 */
  revision: number
  tasks: TeamTask[]
  /**
   * 全板活动时间线（新的在前，最多 {@link MAX_ACTIVITY} 条）。
   *
   * 纯活动追加（例如队友互发消息）**不动 revision**：它不改变任务状态，若也走 CAS
   * 会让正在改任务的队友因为「别人刚发了条消息」而全部被打回。
   */
  activity: TeamActivity[]
}

function emptyBoard(): TeamBoard {
  return { version: 1, revision: 0, tasks: [], activity: [] }
}

/** 读档时把一条进展归一：正文空的丢弃（不拿坏数据污染提示词）。 */
function normalizeNote(raw: unknown): TeamTaskNote | null {
  if (raw === null || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const text = typeof item.text === 'string' ? item.text.trim() : ''
  if (text === '') return null
  return {
    at: typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0 ? Math.floor(item.at) : Date.now(),
    by: typeof item.by === 'string' && item.by !== '' ? item.by : 'unknown',
    text: text.slice(0, MAX_NOTE_CHARS),
  }
}

/** 读档时把一条活动归一：不认识的 kind / 空正文都丢弃。 */
function normalizeActivity(raw: unknown): TeamActivity | null {
  if (raw === null || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const kind = ACTIVITY_KINDS.includes(item.kind as TeamActivityKind) ? (item.kind as TeamActivityKind) : null
  const text = typeof item.text === 'string' ? item.text.trim() : ''
  if (kind === null || text === '') return null
  const taskId = typeof item.taskId === 'string' && item.taskId !== '' ? item.taskId : undefined
  return {
    at: typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0 ? Math.floor(item.at) : Date.now(),
    by: typeof item.by === 'string' && item.by !== '' ? item.by : 'unknown',
    ...(taskId === undefined ? {} : { taskId }),
    kind,
    text: text.slice(0, MAX_ACTIVITY_CHARS),
  }
}

/** 往板级活动时间线追加一条（纯内存；调用方负责 writeBoard）。 */
export function appendActivity(
  board: TeamBoard,
  entry: { by: string; kind: TeamActivityKind; text: string; taskId?: string },
): void {
  const text = entry.text.replace(/\s+/g, ' ').trim().slice(0, MAX_ACTIVITY_CHARS)
  if (text === '') return
  const taskId = entry.taskId === undefined || entry.taskId === '' ? undefined : entry.taskId
  board.activity.unshift({
    at: Date.now(),
    by: entry.by.trim() === '' ? 'unknown' : entry.by.trim(),
    ...(taskId === undefined ? {} : { taskId }),
    kind: entry.kind,
    text,
  })
  if (board.activity.length > MAX_ACTIVITY) board.activity.length = MAX_ACTIVITY
}

/** 往一个任务上追加一条进展（纯内存；调用方负责 writeBoard）。 */
function pushNote(task: TeamTask, by: string, text: string): TeamTaskNote {
  const body = text.trim().slice(0, MAX_NOTE_CHARS)
  const note: TeamTaskNote = { at: Date.now(), by: by.trim() === '' ? 'unknown' : by.trim(), text: body }
  task.notes.unshift(note)
  if (task.notes.length > MAX_NOTES_PER_TASK) task.notes.length = MAX_NOTES_PER_TASK
  return note
}

/**
 * 旁路追加一条板级活动（队友互发消息这类不做 CAS 的记录用）。
 *
 * 只追加活动、**不动 revision**，也不改任务：正在改任务的队友不会因为这条消息被 CAS 打回。
 */
export function recordBoardActivity(
  sessionId: string,
  entry: { by: string; kind: TeamActivityKind; text: string; taskId?: string },
): void {
  const board = readBoard(sessionId)
  appendActivity(board, entry)
  writeBoard(sessionId, board)
}

/** 一个会话的任务板文件路径（会话 id 只出现在 uuid 里，仍按文件名安全字符再滤一遍）。 */
export function boardFile(sessionId: string): string {
  const safe = sessionId.replace(/[^\w-]/g, '_')
  return join(BOARDS_DIR, `${safe === '' ? 'unknown' : safe}.json`)
}

/** 读一块任务板（文件缺失或损坏都退回空板，绝不因为板子坏了起不来）。 */
export function readBoard(sessionId: string): TeamBoard {
  const file = boardFile(sessionId)
  try {
    if (!existsSync(file)) return emptyBoard()
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { revision?: unknown; tasks?: unknown; activity?: unknown }
    const revision = typeof doc.revision === 'number' && doc.revision >= 0 ? Math.floor(doc.revision) : 0
    const rawTasks = Array.isArray(doc.tasks) ? doc.tasks : []
    const tasks: TeamTask[] = []
    for (const raw of rawTasks) {
      if (raw === null || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const id = String(item.id ?? '')
      if (id === '') continue
      const status = STATUSES.includes(item.status as TaskStatus) ? (item.status as TaskStatus) : 'pending'
      tasks.push({
        id,
        subject: String(item.subject ?? ''),
        description: String(item.description ?? ''),
        status,
        owner: typeof item.owner === 'string' && item.owner !== '' ? item.owner : null,
        blockedBy: Array.isArray(item.blockedBy)
          ? [...new Set(item.blockedBy.filter((dep): dep is string => typeof dep === 'string' && dep !== ''))]
          : [],
        writeScopes: Array.isArray(item.writeScopes)
          ? item.writeScopes.filter((scope): scope is string => typeof scope === 'string' && scope !== '')
          : [],
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        // 老文件没有这几项：补默认值，不 bump version（版本号只表达「板子结构约定」）
        notes: Array.isArray(item.notes)
          ? item.notes.map(normalizeNote).filter((note): note is TeamTaskNote => note !== null).slice(0, MAX_NOTES_PER_TASK)
          : [],
        blockedReason:
          typeof item.blockedReason === 'string' && item.blockedReason.trim() !== ''
            ? item.blockedReason.trim().slice(0, MAX_NOTE_CHARS)
            : null,
        assignee: typeof item.assignee === 'string' && item.assignee !== '' ? item.assignee : null,
      })
    }
    const rawActivity = Array.isArray(doc.activity) ? doc.activity : []
    const activity = rawActivity
      .map(normalizeActivity)
      .filter((entry): entry is TeamActivity => entry !== null)
      .slice(0, MAX_ACTIVITY)
    return { version: 1, revision, tasks, activity }
  } catch {
    return emptyBoard()
  }
}

function writeBoard(sessionId: string, board: TeamBoard): void {
  mkdirSync(BOARDS_DIR, { recursive: true })
  // 截断集中在写盘这一处：内存里可以临时超限，落盘的永远是约定上限
  const trimmed: TeamBoard = {
    ...board,
    tasks: board.tasks.map((task) => ({ ...task, notes: task.notes.slice(0, MAX_NOTES_PER_TASK) })),
    activity: board.activity.slice(0, MAX_ACTIVITY),
  }
  writeFileSync(boardFile(sessionId), `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8')
}

/** 路径前缀规范化：统一成正斜杠、去掉首尾斜杠，空串表示「整个工作目录」。 */
export function normalizeScope(scope: string): string {
  return scope.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '')
}

/**
 * 这些作用域会不会碰到别人正在改的地方。
 * @param excludeId - 跟本任务自己比没有意义，跳过这个 id。
 */
export function scopeWarnings(board: TeamBoard, scopes: readonly string[], excludeId: string): string[] {
  const mine = scopes.map(normalizeScope)
  if (mine.length === 0) return []
  const warnings: string[] = []
  for (const other of board.tasks) {
    if (other.id === excludeId || other.status === 'completed') continue
    for (const raw of other.writeScopes) {
      const theirs = normalizeScope(raw)
      for (const ours of mine) {
        const overlaps = ours === theirs || ours === '' || theirs === '' || ours.startsWith(`${theirs}/`) || theirs.startsWith(`${ours}/`)
        if (overlaps) {
          warnings.push(`${other.id}（${other.owner ?? '未认领'}，${other.status}）的作用域 ${theirs || '<整个工作目录>'} 与本次的 ${ours || '<整个工作目录>'} 重叠`)
        }
      }
    }
  }
  return [...new Set(warnings)]
}

/** 依赖图检查：禁自环、禁指向不存在的任务、禁成环。 */
function assertDependencies(board: TeamBoard, id: string, deps: readonly string[]): void {
  for (const dep of deps) {
    if (dep === id) throw new Error(`任务 ${id} 不能依赖自己`)
    if (!board.tasks.some((task) => task.id === dep)) {
      throw new Error(`依赖的任务 ${dep} 不存在（先 team_task list 确认 id）`)
    }
  }
  // 沿依赖链往下走，回到自己就是环
  const seen = new Set<string>()
  const walk = (at: string): void => {
    if (at === id) throw new Error(`依赖会成环：${id} → … → ${id}`)
    if (seen.has(at)) return
    seen.add(at)
    const task = board.tasks.find((candidate) => candidate.id === at)
    for (const dep of task?.blockedBy ?? []) walk(dep)
  }
  for (const dep of deps) walk(dep)
}

/** 一个任务现在能不能开工（pending 且所有依赖都已 completed）。 */
export function isReady(board: TeamBoard, task: TeamTask): boolean {
  if (task.status !== 'pending' || task.owner !== null) return false
  return task.blockedBy.every((dep) => board.tasks.find((task2) => task2.id === dep)?.status === 'completed')
}

/** 下一个任务 id（t1、t2…单调递增，删过的号不回收）。 */
function nextTaskId(board: TeamBoard): string {
  let max = 0
  for (const task of board.tasks) {
    const digits = Number.parseInt(task.id.replace(/^t/i, ''), 10)
    if (Number.isFinite(digits) && digits > max) max = digits
  }
  return `t${max + 1}`
}

/** 新建任务的输入。 */
export interface BoardCreateInput {
  subject: string
  description?: string
  /** 建完就挂在这个名字下（claim_now 用）；只写 owner，不改状态。 */
  owner?: string
  /** 直接绑定队友名。 */
  assignee?: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
  /** 做这件事的人（写进 activity 署名）；缺省用 owner，再缺省 lead。 */
  actor?: string
}

/** 新建任务（不需要 CAS：新增不会覆盖别人的改动）。带上写回后的板，紧接着要认领它才不用再读一遍。 */
export function boardCreate(
  sessionId: string,
  input: BoardCreateInput,
): { task: TeamTask; warnings: string[]; board: TeamBoard } {
  const board = readBoard(sessionId)
  if (board.tasks.length >= MAX_TASKS) {
    throw new Error(`任务板已有 ${board.tasks.length} 条，达到上限 ${MAX_TASKS}；先清掉已完成的任务`)
  }
  const subject = input.subject.replace(/\s+/g, ' ').trim()
  if (subject === '') throw new Error('任务标题不能为空')
  const now = Date.now()
  const actor = (input.actor ?? input.owner ?? 'lead').trim() || 'lead'
  const task: TeamTask = {
    id: nextTaskId(board),
    subject: subject.slice(0, 120),
    description: (input.description ?? '').trim().slice(0, 2000),
    status: 'pending',
    owner: input.owner !== undefined && input.owner !== '' ? input.owner : null,
    blockedBy: [...new Set(input.blockedBy ?? [])].filter((dep) => dep !== ''),
    writeScopes: [...new Set((input.writeScopes ?? []).map(normalizeScope))].filter((scope) => scope !== ''),
    createdAt: now,
    updatedAt: now,
    notes: [],
    blockedReason: null,
    assignee: input.assignee !== undefined && input.assignee !== '' ? input.assignee : null,
  }
  assertDependencies(board, task.id, task.blockedBy)
  const warnings = scopeWarnings(board, task.writeScopes, task.id)
  board.tasks.push(task)
  appendActivity(board, { by: actor, kind: 'create', text: `建了 ${task.id}：${task.subject}`, taskId: task.id })
  board.revision += 1
  writeBoard(sessionId, board)
  return { task, warnings, board }
}

/** 任务板变更动作。 */
export type BoardAction =
  | 'claim'
  | 'release'
  | 'complete'
  | 'reopen'
  | 'set_dependencies'
  | 'delete'
  | 'note'
  | 'block'
  | 'unblock'
  | 'assign'

/** 变更动作的附加数据。 */
export interface BoardUpdatePayload {
  /** claim 的认领者。 */
  owner?: string
  /** set_dependencies 的新依赖清单。 */
  blockedBy?: readonly string[]
  /** note / block / unblock / complete 的正文（complete 时作为终稿摘要写进 notes）。 */
  text?: string
  /** assign 的绑定对象；`null` 或空串 = 解绑。 */
  assignee?: string | null
  /** 做这件事的人（写进进展与活动的署名）；缺省沿用 owner，再缺省 unknown。 */
  by?: string
}

/**
 * 改一条任务。调用方必须带上自己看到的 board revision，
 * 不匹配就抛错——两个队友同时抢同一个任务是常态，先到先得靠的就是这一条。
 *
 * 每个成功动作都会在板级 `activity` 里留一条记录（新的在前），任务上的改动按动作
 * 分别落在状态/负责人/进展（notes）/卡住原因（blockedReason）/绑定（assignee）上。
 */
export function boardUpdate(
  sessionId: string,
  id: string,
  expectedRevision: number,
  action: BoardAction,
  payload?: BoardUpdatePayload,
): { board: TeamBoard; task: TeamTask } {
  const board = readBoard(sessionId)
  if (expectedRevision !== board.revision) {
    throw new Error(
      `任务板在你读它之后被别人改过了（你报的是第 ${expectedRevision} 版，现在第 ${board.revision} 版）。先 team_task list 再决定`,
    )
  }
  const index = board.tasks.findIndex((task) => task.id === id)
  if (index < 0) throw new Error(`任务板上没有 ${id}`)
  // 深拷贝一层 notes：校验失败抛错时不能把改动漏进 board.tasks
  const task: TeamTask = { ...board.tasks[index]!, notes: [...board.tasks[index]!.notes] }
  const actor = (payload?.by ?? payload?.owner ?? '').trim() || 'unknown'

  switch (action) {
    case 'claim': {
      const owner = (payload?.owner ?? '').trim()
      if (owner === '') throw new Error('claim 要带上认领人（队友名）')
      if (task.status === 'completed') throw new Error(`${id} 已经完成了，不用再认领`)
      if (task.owner !== null && task.owner !== owner) {
        throw new Error(`${id} 已经被 ${task.owner} 认领了，换一个任务或先 team_task list`)
      }
      const pendingDeps = task.blockedBy.filter(
        (dep) => board.tasks.find((candidate) => candidate.id === dep)?.status !== 'completed',
      )
      if (pendingDeps.length > 0) {
        throw new Error(`${id} 还在等这些依赖完成：${pendingDeps.join('、')}`)
      }
      task.owner = owner
      task.status = 'in_progress'
      // spawn 带 task_id 时一次 CAS 里连绑定一起做掉；普通 claim 不改已有的绑定
      if (payload?.assignee !== undefined) {
        task.assignee = payload.assignee === null || payload.assignee.trim() === '' ? null : payload.assignee.trim()
      }
      appendActivity(board, {
        by: actor,
        kind: 'claim',
        text: `${actor} 认领了 ${id}${task.assignee === null ? '' : `（绑定 ${task.assignee}）`}`,
        taskId: id,
      })
      break
    }
    case 'release':
      if (task.status === 'completed') throw new Error(`${id} 已经完成了，release 没有意义`)
      task.owner = null
      task.status = 'pending'
      appendActivity(board, { by: actor, kind: 'release', text: `${actor} 释放了 ${id}`, taskId: id })
      break
    case 'complete': {
      if (task.status === 'pending') throw new Error(`${id} 还没人认领，先 claim 再 complete`)
      const summary = (payload?.text ?? '').trim()
      if (summary !== '') pushNote(task, actor, summary)
      task.status = 'completed'
      appendActivity(board, {
        by: actor,
        kind: 'complete',
        text: `${actor} 完成了 ${id}${summary === '' ? '' : `：${summary.replace(/\s+/g, ' ').slice(0, 120)}`}`,
        taskId: id,
      })
      break
    }
    case 'reopen':
      task.status = 'pending'
      task.owner = null
      appendActivity(board, { by: actor, kind: 'release', text: `${actor} 重新打开了 ${id}`, taskId: id })
      break
    case 'note': {
      const text = (payload?.text ?? '').trim()
      if (text === '') throw new Error('note 要带上 text（进展写了什么）')
      pushNote(task, actor, text)
      appendActivity(board, {
        by: actor,
        kind: 'note',
        text: `${actor} 写了 ${id} 的进展：${text.replace(/\s+/g, ' ').slice(0, 120)}`,
        taskId: id,
      })
      break
    }
    case 'block': {
      const reason = (payload?.text ?? '').trim()
      if (reason === '') throw new Error('block 要带上 text（卡在哪里）')
      task.blockedReason = reason.slice(0, MAX_NOTE_CHARS)
      pushNote(task, actor, `[卡住] ${reason}`)
      appendActivity(board, {
        by: actor,
        kind: 'note',
        text: `${actor} 标记 ${id} 卡住：${reason.replace(/\s+/g, ' ').slice(0, 120)}`,
        taskId: id,
      })
      break
    }
    case 'unblock': {
      if (task.blockedReason === null) throw new Error(`${id} 没有被标记卡住，不用解除`)
      const why = (payload?.text ?? '').trim()
      pushNote(task, actor, `[解除] ${why === '' ? '阻塞已解除' : why}`)
      task.blockedReason = null
      appendActivity(board, { by: actor, kind: 'note', text: `${actor} 解除了 ${id} 的卡住`, taskId: id })
      break
    }
    case 'assign': {
      const raw = payload?.assignee
      if (raw === undefined) throw new Error('assign 要带上 assignee（队友名；空串或 null 表示解绑）')
      const assignee = raw === null ? '' : raw.trim()
      task.assignee = assignee === '' ? null : assignee
      appendActivity(board, {
        by: actor,
        kind: assignee === '' ? 'release' : 'claim',
        text: assignee === '' ? `${actor} 解除了 ${id} 的绑定` : `${actor} 把 ${id} 绑定给 ${assignee}`,
        taskId: id,
      })
      break
    }
    case 'set_dependencies': {
      const deps = [...new Set(payload?.blockedBy ?? [])].filter((dep) => dep !== '')
      assertDependencies(board, id, deps)
      task.blockedBy = deps
      appendActivity(board, {
        by: actor,
        kind: 'note',
        text: `${actor} 更新了 ${id} 的依赖：${deps.join('、') || '（无）'}`,
        taskId: id,
      })
      break
    }
    case 'delete': {
      const dependents = board.tasks.filter((candidate) => candidate.id !== id && candidate.blockedBy.includes(id))
      if (dependents.length > 0) {
        throw new Error(`${dependents.map((entry) => entry.id).join('、')} 还依赖 ${id}，先改掉它们的依赖`)
      }
      board.tasks.splice(index, 1)
      appendActivity(board, { by: actor, kind: 'release', text: `${actor} 删除了 ${id}：${task.subject}`, taskId: id })
      board.revision += 1
      writeBoard(sessionId, board)
      return { board, task }
    }
    default:
      throw new Error(`未知动作 ${action satisfies never}`)
  }

  task.updatedAt = Date.now()
  board.tasks[index] = task
  board.revision += 1
  writeBoard(sessionId, board)
  return { board, task }
}

/** 把一块任务板清空（设置页「清空任务板」按钮用；不动队友的运行记录）。 */
export function resetBoard(sessionId: string): number {
  const board = readBoard(sessionId)
  const count = board.tasks.length
  board.tasks = []
  // 活动时间线引用的是任务 id，任务都清了还留着它只会让界面画出悬空条目
  board.activity = []
  board.revision += 1
  writeBoard(sessionId, board)
  return count
}

/**
 * 任务板 → 契约只读投影（`TeamService.board()` 与提示词共用这一份）。
 *
 * 只在这里拼一次 `latestNote / noteCount / blockedReason / assignee / activity`：
 * 宿主服务、状态面板、提示词三处各自拼一遍就会三套口径。
 */
export function boardViewOf(board: TeamBoard): TeamBoardView {
  return {
    revision: board.revision,
    tasks: board.tasks.map((task) => {
      const latestNote: TeamTaskNoteView | null = task.notes[0] ?? null
      return {
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
        owner: task.owner,
        blockedBy: [...task.blockedBy],
        writeScopes: [...task.writeScopes],
        ready: isReady(board, task),
        latestNote,
        noteCount: task.notes.length,
        blockedReason: task.blockedReason,
        assignee: task.assignee,
      }
    }),
    activity: board.activity.map((entry): TeamActivityView => ({
      at: entry.at,
      by: entry.by,
      ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
      kind: entry.kind,
      text: entry.text,
    })),
  }
}

/** 一个队友的信箱文件路径。 */
function inboxFile(teammate: string): string {
  return join(INBOX_DIR, `${teammate.replace(/[^\w-]/g, '_')}.jsonl`)
}

/**
 * 往传话台账追加一条（调用方负责紧接着把它投给那个队友的循环）。
 * @throws 内容为空，或超过单条长度上限时抛错。
 */
export function inboxAppend(teammate: string, text: string): void {
  const body = text.trim()
  if (body === '') throw new Error('要传的话不能是空的')
  if (body.length > MAX_INBOX_CHARS) throw new Error(`一条消息最长 ${MAX_INBOX_CHARS} 字，这条有 ${body.length} 字`)
  mkdirSync(INBOX_DIR, { recursive: true })
  appendFileSync(inboxFile(teammate), `${JSON.stringify({ at: Date.now(), text: body })}\n`, 'utf8')
}

/** 读一个队友信箱里的全部消息（按写入顺序）。 */
export function inboxRead(teammate: string): string[] {
  try {
    if (!existsSync(inboxFile(teammate))) return []
    return readFileSync(inboxFile(teammate), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => {
        try {
          return String((JSON.parse(line) as { text?: string }).text ?? '')
        } catch {
          return line
        }
      })
      .filter((text) => text !== '')
  } catch {
    return []
  }
}
