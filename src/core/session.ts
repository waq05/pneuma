/**
 * 轻量会话存储：内存里就是 OpenAI 协议消息数组（llm 层零转换），磁盘上是
 * append-only JSONL（~/.dsc/sessions/<cwd 压缩>/<id>.jsonl）。恢复 = 逐行
 * 重放。对应 dsh 的 session-persistence-jsonl 的个人版最小实现——没有
 * 修复/投影/ignorable 语义（个人版不需要）。
 *
 * @module dsc/core/session
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, promises as fsp, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatContentPart, ChatMessage, ToolCall } from './llm.js'
import type { ApprovalPolicy, ApprovalReviewer, CollaborationMode, EffortLevel, PlanHistoryItem, PlanView, SandboxMode, TodoItemView, ToolPresentationView } from '../contract.js'
import type { GoalSnapshot } from './goal.js'
import { stripBaseline, type FileChangeSummary } from './tools.js'
import { summarizeChange } from './tools/fs-tools.js'
import { dropSessionMeta, patchSessionMeta, readSessionMeta } from './session-meta.js'
import type { SessionMetaRecord } from './session-meta.js'
import { acquireLock, withExclusiveLock, type FileLock } from './lockfile.js'
import { dscPath } from './path-policy.js'
import { fileHandleText, parseAttachmentUrl, resolveImageForRequest, type UserFileAttachment } from './attachments.js'
import { REVIEW_FINDINGS_OPEN, TEAMMATE_REPORT_OPEN } from './team-board.js'

/** 会话元数据（jsonl 首行 + 列表投影）。 */
export interface SessionMeta {
  id: string
  cwd: string
  createdAt: number
  /** 首条用户消息截断（会话列表展示用），无用户消息时 undefined。 */
  title?: string
}

/** 一条请求注入备忘（note 记录的内存形状）。 */
export interface SessionNote {
  id: string
  text: string
  ts?: number
}

/**
 * 收件箱条目的来源（对照 dsh 的「用户消息 vs 带来源的持久消息」）。
 *
 *   - `'user'`：用户亲手打的字（含界面提交、老调用点缺省）——出账前画输入框下方的
 *     「排队消息」条，可以编辑 / 撤掉 / 插话；
 *   - `'notice'`：机器发起的唤醒（队友汇报、后台作业完成、目标续跑、定时补投……）——
 *     出账前画输入框上方的只读「待投递通知」条，不给人编辑 / 撤掉 / 插话。
 *
 * 两条路落库后都是同一条 `user` 消息（模型侧无差别），但来源**要**跟着落库
 * （{@link SessionRecord} 的 `origin` 字段，只有 `'notice'` 才写）：出账那一刻界面靠它
 * 把这批消息画成内部触发行，重开历史会话时靠同一个字段还原——不落库的话，机器通知会
 * 长成一个能编辑、能再发一遍的用户气泡（2026-11-02 报障：后台作业完成通知就是这么冒出来的）。
 * 协议侧不受影响：`ChatMessage.origin` 在发请求前被剥掉（见 core/llm 的 serializeMessages）。
 */
export type InboxOrigin = 'user' | 'notice'

/** 收件箱里的一条：正文 + 可选图 + 可选文件 + 可选来源（缺省按 `'user'` 算，老状态条目兼容）。 */
export interface AsyncInboxItem {
  text: string
  images?: string[]
  /** 视频 / 通用文件（图片仍走 `images`）。 */
  files?: UserFileAttachment[]
  /** 来源；老状态条目没有这个字段，读时按 `'user'` 兜底。 */
  origin?: InboxOrigin
}

/**
 * 组装一条用户消息的协议形态。
 *
 * 图片引用在这里读成 data URL（老会话的 data URL 原样过），视频 / 文件则把「路径 + 元数据」
 * 拼进正文——模型侧没有文件内容块，给它一个可读、可复现的句柄才是 dsh 对非图片附件的做法。
 * 只在这一处拼：实时写入与历史重放走同一个函数，两条路不会漂。
 *
 * 附件对象被删掉（用户手清 `~/.dsc/attachments`、换机器拷会话）不能让整个会话打不开：
 * 读不出来的那张图换成一行「图片已丢失」的说明，其余照常重放——与 dsh「历史读取失败
 * 以错误呈现、而不是给错误字节」同一个方向，代价更小。
 */
function userContent(text: string, images?: string[], files?: UserFileAttachment[]): string | ChatContentPart[] {
  const handle = files === undefined || files.length === 0 ? '' : fileHandleText(files)
  const parts: ChatContentPart[] = []
  const missing: string[] = []
  const push = (url: string): void => {
    try {
      parts.push({ type: 'image_url', image_url: { url: resolveImageForRequest(url) } })
    } catch {
      missing.push((parseAttachmentUrl(url) ?? url).slice(0, 12))
    }
  }
  if (images !== undefined) for (const url of images) push(url)
  // 视频关键帧跟着视频一起进这一次请求：模型看得到画面，日志只记引用，界面只画视频卡。
  if (files !== undefined) {
    for (const file of files) {
      if (file.frames === undefined) continue
      for (const frame of file.frames) push(frame)
    }
  }
  const lost = missing.length === 0 ? '' : `\n\n[图片已丢失：${missing.join('、')}]`
  const body = `${handle === '' ? text : `${text}\n\n${handle}`}${lost}`
  if (parts.length === 0) return body
  return [{ type: 'text', text: body }, ...parts]
}

type SessionRecord =
  | ({ type: 'meta' } & SessionMeta)
  /**
   * 下面四条都带 `ts`：这条记录写入磁盘的时刻（毫秒 epoch），同时也是内存里
   * 那条消息 `ChatMessage.ts` 的来源。为什么记在会话日志里而不是另存一份：
   * 恢复会话是逐行重放 jsonl，只有行内自带时间，历史消息才说得清「几点发的」，
   * 界面的每轮用时也才算得出来（见 contract.ts 的 TranscriptEntry.ts）。
   * 老日志没有这个字段，重放时按 undefined 处理。
   */
  /**
   * `origin` 只在机器发起的投递（`'notice'`）上写：人打的字不写，老日志里也根本没有这个
   * 字段，两边都按缺省的 `'user'` 读。它落库的唯一用途是重放时认出「这不是人打的字」
   * （见 {@link InboxOrigin} 的注释），请求侧由 serializeMessages 剥掉。
   */
  | { type: 'user'; text: string; images?: string[]; files?: UserFileAttachment[]; ts?: number; origin?: InboxOrigin }
  | { type: 'assistant'; text: string; reasoning: string; toolCalls?: ToolCall[]; ts?: number }
  | {
      type: 'tool'
      callId: string
      name: string
      text: string
      images?: string[]
      /**
       * 成功的 write / edit 附带的实际改动（轮尾「文件已更改」卡的数据源）。
       * 只活在日志里：内存的协议消息不带（透传给端点会被挑剔的网关判 400），
       * 恢复会话时经 {@link Session.fileChanges} 旁路还原成条目。老日志没有这个字段。
       *
       * 单个文件写单值（与老日志同形），一次调用改多个文件（PTC 的 run_code）写数组；
       * 读回时两种都认。
       */
      changes?: FileChangeSummary | FileChangeSummary[]
      /**
       * dsh 插件给的卡片数据（presentCall / presentResult / presentationMeta 的产物）。
       * 与 changes 同一条旁路：只活在日志里，恢复会话时经 Session.presentations 还原。
       */
      presentation?: ToolPresentationView
      error?: string
      ts?: number
    }
  | {
      type: 'summary'
      text: string
      /**
       * 摘要之外保留了尾部多少条消息（内存里的 `kept.length - 1`）。
       * 磁盘是 append-only，摘要之前的原始记录一条都没删，重放时只能靠这个数字
       * 知道该从末尾留下多少条（{@link Session.load} 的 `case 'summary'`）。
       * 老日志没有这个字段，按 0 处理。
       */
      keep?: number
      ts?: number
    }
  /**
   * 会话状态（模式、清单、计划、目标……）：一条记录一个条目，谁的功能谁自己写。
   * 存储层不认识具体功能，`id` 与负载类型见 {@link SessionStateMap}。
   */
  | { type: 'state'; id: string; payload: unknown }
  /**
   * 「回到某一条用户消息之前重来」（2026-11-03）：界面上的「编辑并重发」不再分叉新会话，
   * 而是在**当前会话里**把这条消息及其之后的内容作废，再按改过的文字重发。
   *
   * 日志仍是 append-only：一条记录都不删，靠这条 `rewind` 声明「从这里往后作废」。
   * `keep` = 保留几条**人打的**用户消息（`origin: 'notice'` 的机器投递不算），
   * 重放时遇到它就把已经读到的消息截到第 keep 条用户消息之前（见 load 的 `case 'rewind'`）。
   *
   * 老构建读到此类型会静默跳过（load 的 switch 没有 default），只会多看到被作废的那段
   * 历史——比读不出会话好。
   */
  | { type: 'rewind'; keep: number; ts?: number }
  /**
   * 请求注入备忘（Model-visible ⟺ logged 的补丁）：插件投影往请求体里塞的、日志上
   * 本来没有的内容（LSP 写后诊断、生命周期钩子的话术）在此留底。备忘不进请求消息流、
   * 不参与重放折叠，恢复会话后经 `session.notes` 读出——模型看到的东西因此能从
   * 日志完整重建。老构建读到此类型会静默跳过（load 的 switch 没有 default）。
   */
  | { type: 'note'; id: string; text: string; ts?: number }
  /**
   * 下面四种是早先「一种功能一条记录」的写法，已经不再写入，
   * 只为读得回老会话日志而留着（{@link Session.load} 的兼容分支）。
   */
  | { type: 'mode'; mode: CollaborationMode }
  | { type: 'todo'; items: TodoItemView[] }
  | { type: 'plan'; plan: PlanView }
  | { type: 'goal'; goal: GoalSnapshot }

/**
 * 会话日志里的「状态」条目表：id → 那个功能点存的负载。
 *
 * 这些内容不发进请求体（协议里没有它们的位置），但恢复历史会话时必须在场。
 * 功能点想加自己的状态就用声明合并加一行，不必回来改存储层：
 * `declare module '../core/session.js' { interface SessionStateMap { memory: MyRecord } }`。
 */
export interface SessionStateMap {
  /**
   * 权限三项（approval / sandbox / permission-presets 写；按会话隔离，2026-10-28）。
   * 缺项（null）= 还没钉过，读取方补默认值并钉住；钉住后改偏好不影响这个会话。
   */
  permissions: { sandbox: SandboxMode | null; policy: ApprovalPolicy | null; reviewer: ApprovalReviewer | null }
  /** 协作模式（mode 插件写）。 */
  mode: CollaborationMode
  /**
   * 模式（presets 插件写）：这一轮模型是谁、手上有什么。
   * 存的只是模式名，具体规格每次现读文件——所以改完模式文件不用重开会话。
   */
  preset: string
  /** 任务清单整表，最后一条生效（todo 插件写）。 */
  todos: TodoItemView[]
  /** 最近一份计划及其评审结果（plan 插件写）。 */
  plan: PlanView
  /**
   * 本会话提交过的计划目录（plan 插件追加，面板「计划」区按会话出条目）。
   *
   * 与 `plan` 分开：那条只留最后一份（恢复会话时的挂起卡靠它），这份是**追加式**
   * 的账——批过拒过都留下，跨重启还在。文件系统里的 `.dsc/plans/` 没有会话归属，
   * 分不出哪份是谁交的，归属就记在这里。
   */
  plans: { items: PlanHistoryItem[] }
  /**
   * 会话目标快照（goal 插件写）。
   *
   * **可以是 null**：用户在目标条上点 ✕ 清空时，插件往日志追加一条 `null`。
   * 日志是 append-only、最后一条生效，于是恢复会话读到 null 就是「这个会话没有目标」。
   * 早期版本清空时不写这一条，导致清掉的目标重启后又冒出来（2026-11-02 报障）。
   */
  goal: GoalSnapshot | null
  /**
   * T39：这份会话用的模型（llm 插件在 /model 切换与设默认时写）。恢复会话优先
   * 取它，而不是回落配置默认——会话进行到一半换过的模型不该被「重启」冲掉。
   */
  model: { provider: string; model: string; effort?: EffortLevel }
  /**
   * 自我改进的记账（self-improve 插件写）：本轮复盘到哪个轮次、本会话读过哪些技能。
   *
   * 形状故意留成 `unknown`：core 层不该认识插件层的类型（依赖方向反过来就成环），
   * 读回来时由 `core/learnings/store.ts` 的 `normalizeLearningsState` 兜底。
   */
  learnings: unknown
  /**
   * 最近一次请求使用的系统提示词全文（agent 插件写，hash 去重——变了才写一条）。
   * 系统提示不进 user/assistant 消息流，靠这条状态记录补上「模型看到的提示词」：
   * 恢复会话后最后一条就是当前生效的那份（Model-visible ⟺ logged 的提示词半边）。
   */
  'system-prompt': { hash: string; text: string }
  /**
   * 最近一次请求附给模型的环境快照全文（prompt 插件的 env-facts 投影写，hash 去重）。
   * 2026-10-03 起环境事实不再进系统提示词，这份条目就是「模型当时看到的环境」的留痕。
   */
  'env-facts': { hash: string; text: string }
  /**
   * 异步输入收件箱（loop 写）：回合跑动中到达、还没落到对话历史的输入
   * （轮中途插话、后台作业完成通知、队友汇报、定时补投……）。它们不能直接 appendUser——
   * 若此刻还有没落结果的 tool 调用，就会插在 tool_calls 和结果中间，网关按
   * 「结果必须紧跟 tool_calls」判 400（0.6.47 修的夹层）。对照 dsh 的
   * next-step inbox：到达与入史拆成两段，步骤边界才出账。
   *
   * `origin` 记这条是用户来源还是机器来源：出账前界面据此分两条带画（用户输入画
   * 输入框下方的队列条、机器通知画输入框上方的只读通知条，见 {@link InboxOrigin}）；
   * 出账后两者都落成同一条 `user` 消息，来源不再有用。
   */
  'async-inbox': { items: AsyncInboxItem[] }
}

/**
 * 用户拒绝某次工具调用时，写进那条工具结果的固定回执文案（由 loop 的拒绝分支产出）。
 * 2026-02 之前的日志没有单独记 `error` 字段，{@link Session.load} 靠这句话把
 * 「已拒绝」的状态补回来；之后的日志直接读 `error`，这句话只用来兜老数据。
 */
export const REJECTED_TOOL_TEXT = '用户拒绝了这次工具调用。'

/** 工具结果的异常标记：`rejected` = 用户拒绝，`tool-error` = 工具执行报错（loop 写入）。 */
const REJECTED_TOOL_ERROR = 'rejected'

/**
 * T32：中断回合的合成闭合文案。进程在「assistant 的 tool_calls 已落盘、工具结果
 * 还没写」之间被杀，恢复时给每个孤儿调用补一条这样的结果并落盘（dsh repair.ts 的
 * interruptedTurnClosers 同款语义）——模型必须知道「这个调用已发起、结果未知」，
 * 才能决定是先核查还是重试；只读调用可直接重试，有副作用的必须先核实。
 */
const INTERRUPTED_TOOL_TEXT =
  '[回合被打断] 这个工具调用已经发起，但 Pneuma 没来得及记录它的结果——它可能已经产生了' +
  '副作用（写文件、跑命令、发请求）。先核查实际状态（读文件、查进程、看输出），再决定下一步：' +
  '只读调用可以直接重试；有副作用的调用在核实之前不要盲目重跑。'

/** 压缩 cwd 为目录名：`C:\Users\waq` → `C-Users-waq`。 */
export function slugCwd(cwd: string): string {
  return cwd.replace(/[\\/:]+/g, '-')
}

export function sessionsRoot(): string {
  return dscPath('sessions')
}

/** T30：拿会话写租约；被别的进程占着就抛明确错误（桌面端与 TUI 同开一个工作区的保护）。 */
function takeWriteLease(file: string): FileLock {
  const lease = acquireLock(file)
  if (lease === null) {
    throw new Error(
      `这份会话已在另一个 Pneuma 窗口打开：${basename(file)}（同一份会话日志同时只允许一处写入，先关掉那边再试）`,
    )
  }
  return lease
}

/**
 * T31：meta 首行损坏时的抢救。id 用文件名（uuid），createdAt 用文件诞生时间，
 * cwd 从内容里的绝对路径反推：真正的 cwd 一定是这些路径的祖先，且它的 slug 必须
 * 等于日志所在目录名（`sessions/<slugCwd(cwd)>/<uuid>.jsonl` 的布局）——两个条件
 * 夹出来的 cwd 是准的；一条绝对路径都找不到才退到最长公共目录，再不行就抛错
 * （文件保留在原位，交给上层的明确报错）。
 */
function salvageMeta(file: string, lines: string[]): SessionMeta {
  const paths = new Set<string>()
  for (const line of lines) {
    if (!line.startsWith('{"type":"')) continue
    let record: { type?: string; changes?: { path?: unknown }[]; payload?: unknown }
    try {
      record = JSON.parse(line) as { type?: string; changes?: { path?: unknown }[]; payload?: unknown }
    } catch {
      continue // 坏行跳过：抢救靠的是幸存的记录
    }
    if (record.type === 'tool' && Array.isArray(record.changes)) {
      for (const change of record.changes) {
        if (change !== null && typeof change === 'object' && typeof change.path === 'string' && change.path !== '') {
          paths.add(change.path)
        }
      }
    }
    if (record.type === 'state' && record.payload !== null && typeof record.payload === 'object') {
      const planFile = (record.payload as { file?: unknown }).file
      if (typeof planFile === 'string' && planFile !== '') paths.add(planFile)
    }
  }
  const dirName = basename(dirname(file))
  let cwd: string | null = null
  for (const path of paths) {
    if (!isAbsolute(path)) continue
    let dir = dirname(path)
    for (let depth = 0; depth < 12; depth += 1) {
      if (slugCwd(dir) === dirName) {
        cwd = dir
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (cwd !== null) break
  }
  if (cwd === null) cwd = commonDirectory(paths)
  if (cwd === null) {
    throw new Error(`会话文件头损坏，且无法从内容推断工作目录（文件保留在原位，没有动它）：${file}`)
  }
  let createdAt = Date.now()
  try {
    const born = statSync(file).birthtimeMs
    if (Number.isFinite(born) && born > 0) createdAt = Math.floor(born)
  } catch {
    // 取不到诞生时间就用现在：只影响列表里的「创建时间」展示
  }
  return { id: basename(file, '.jsonl'), cwd, createdAt }
}

/** 一组绝对路径的最长公共目录（大小写不敏感）；没有绝对路径返回 null。 */
function commonDirectory(paths: Iterable<string>): string | null {
  const dirs = [...paths].filter((p) => isAbsolute(p)).map((p) => dirname(p))
  if (dirs.length === 0) return null
  let candidate = dirs[0]!
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  for (const dir of dirs) {
    while (!same(dir, candidate) && !dir.toLowerCase().startsWith(candidate.toLowerCase() + sep)) {
      const parent = dirname(candidate)
      if (parent === candidate) return null
      candidate = parent
    }
  }
  return candidate
}

/**
 * 这条用户消息是不是「人打的」。
 *
 * 三类不算：机器投递的唤醒（`origin: 'notice'`，2026-11-02）、队友汇报与审查结论
 * （正文以 `<teammate-report ` / `<review-findings ` 开头，见 `core/team-board.ts`）。
 *
 * 为什么存储层要认这三类：界面上它们画成一行触发行 / 一张结论卡，**不开一轮对话**；
 * 「编辑并重发」把「界面上第几轮」换算成消息下标时，两边必须是同一套判据，否则会
 * 截到错的位置（少算=没截干净，多算=把还在用的历史截掉）。
 */
function isHumanUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  if (message.origin === 'notice') return false
  const text =
    typeof message.content === 'string'
      ? message.content
      : (message.content?.find((part) => part.type === 'text')?.text ?? '')
  return !text.startsWith(TEAMMATE_REPORT_OPEN) && !text.startsWith(REVIEW_FINDINGS_OPEN)
}

/**
 * 「第 keep 条**人打的**用户消息」在消息数组里的下标（0 基）；没有这一条返回 -1。
 *
 * 为什么只数人打的：机器投递的通知与队友汇报在界面上都是一行触发行，不开一轮对话；
 * 把界面上的「第几轮」换算成消息下标时，两种口径必须一致（判据见
 * {@link isHumanUserMessage}，界面对应 `entry.internal !== true`）。
 *
 * @param messages - 协议消息（`Session.messages` 或重放中的中间结果）。
 * @param keep - 要保留几轮用户消息：下标落在这条消息上，它本身是要被作废的那条。
 */
function cutIndexBeforeUser(messages: readonly ChatMessage[], keep: number): number {
  let seen = 0
  for (let index = 0; index < messages.length; index += 1) {
    if (!isHumanUserMessage(messages[index]!)) continue
    if (seen === keep) return index
    seen += 1
  }
  return -1
}

/** 一个会话：内存消息 + 磁盘日志。 */
export class Session {
  readonly meta: SessionMeta
  /** 协议消息（不含 system prompt；system 由 loop 在请求组装时加头）。 */
  readonly messages: ChatMessage[] = []
  private readonly file: string
  /** 写入流。新会话在第一条日志真正落盘之前是 null，所以没发过消息的会话不留文件。 */
  private stream: ReturnType<typeof createWriteStream> | null = null
  /** meta 首行是否已经写进磁盘。 */
  private metaWritten: boolean
  /**
   * 还没落盘时攒下的 state 记账记录。
   *
   * 为什么要有这块缓冲：新会话一建出来，权限与模型插件就立刻补默认值，原先它们
   * 各写一条 state 就把文件建了出来——用户只是点了「新会话」、一个字都没发，磁盘
   * 和列表里却多了一条空会话。记账先攒在内存里，等第一条真正的日志（user /
   * assistant / tool / summary / note）落地时，再按 meta → 攒下的记录 → 这一条
   * 的顺序一次写出；会话 id 与路径仍由 create 当场定下，侧栏、轨迹、用量照旧按
   * sessionId 取值，不依赖文件是否存在。
   */
  private pendingState: Array<Extract<SessionRecord, { type: 'state' }>> = []
  /**
   * 只改了内存、还没落盘的状态（id → 负载）：读路径补默认值用。
   *
   * 为什么（2026-11-03「点一下老会话时间就变刚刚」）：权限三项在**读**的时候补钉
   * （见 core/permission-scope），以前一补就写盘，于是「只是点开看一眼」也会把
   * 会话文件改一遍。改成先记在这里，等下一次真正要写日志（用户说话、切档位）时
   * 跟着那一条一起落盘——同一进程里读到的值立刻生效，不会跟着偏好漂。
   */
  private readonly deferredState = new Map<string, unknown>()
  /**
   * T30 写租约：一份会话日志同一时刻只允许一个进程写。桌面端与 TUI 从同一份
   * `.last-session` 取默认会话，没有这层时两边会交错 append、重放串线。
   * 只读打开（队友运行记录的 peek、load-bench）可以不租（`load` 的 `lease: false`）。
   */
  private lease: FileLock | null
  /**
   * 工具调用的异常标记（callId → `rejected` / `tool-error`）。
   * OpenAI 协议里没有这个概念，所以它不挂在 `messages` 上（否则会被发进请求体），
   * 只在 jsonl 的 tool 记录里存一份，重放历史时单独交给 transcript 决定卡片状态。
   */
  readonly toolErrors = new Map<string, string>()
  /**
   * 成功的 write / edit 的实际改动（callId → 变更摘要清单），轮尾「文件已更改」卡的数据源。
   * 与 toolErrors 同一条旁路：不挂 `messages`（协议消息透传给端点），只在 jsonl 的
   * tool 记录里存一份，重放历史时单独交给 transcript 折成 `kind: 'changes'` 条目。
   *
   * 为什么是清单（2026-10-30）：PTC 的 `run_code` 一次调用能改好几个文件；以前这里只收
   * 单个 `changes`，多文件场景要么丢、要么只剩最后一个。
   */
  readonly fileChanges = new Map<string, FileChangeSummary[]>()
  /**
   * dsh 插件给的卡片数据（callId → 卡片视图），与 fileChanges 同一条旁路：
   * 只活在日志里，重放历史时交给 transcript 折成 tool/presentation 事件。
   */
  readonly presentations = new Map<string, ToolPresentationView>()
  /**
   * 回合内文件基线（codex `TurnDiffTracker` 的同款思路）：本回合第一次动某个文件时
   * 记下「动之前的全文」，回合收尾用它和盘上现值重算一份聚合 diff——同一文件改
   * 多刀时，界面只出一份「回合开始 vs 终态」的准确差异，而不是各刀差异的拼盘。
   * 不落盘：回合结束即清，重启后轮尾卡回退逐刀合并显示。
   */
  private turnBaselines = new Map<string, string>()
  /** 本回合动过的文件（按首次触碰顺序，轮尾聚合 diff 按这个顺序显示）。 */
  private turnTouched: string[] = []
  /**
   * 会话状态条目（见 {@link SessionStateMap}）。
   * 不发进请求体，恢复历史会话时由 {@link Session.load} 逐行填回来。
   */
  private readonly stateById = new Map<string, unknown>()
  /** 请求注入备忘（note 记录）；恢复会话时从日志重放回来，经 {@link notes} 读出。 */
  private readonly noteLog: SessionNote[] = []

  private constructor(
    meta: SessionMeta,
    file: string,
    initialMessages: ChatMessage[] = [],
    restored = false,
    state?: ReadonlyMap<string, unknown>,
    initialNotes: SessionNote[] = [],
    lease: FileLock | null = null,
  ) {
    this.meta = meta
    this.file = file
    this.messages.push(...initialMessages)
    this.metaWritten = restored
    this.lease = lease
    if (state !== undefined) for (const [id, payload] of state) this.stateById.set(id, payload)
    this.noteLog.push(...initialNotes)
  }

  /**
   * 新建会话：只在内存里，第一条日志写下去时磁盘上才出现这个文件。
   * @param file - 指定落盘路径（队友日志住在 `.teammates` 下，不进会话列表）；省略走默认。
   */
  static create(cwd: string, file?: string): Session {
    const meta: SessionMeta = { id: randomUUID(), cwd, createdAt: Date.now() }
    const target = file ?? join(sessionsRoot(), slugCwd(cwd), `${meta.id}.jsonl`)
    return new Session(meta, target, [], false, undefined, [], takeWriteLease(target))
  }

  /**
   * 从 jsonl 重放恢复（system prompt 照样由 loop 加头）。
   * @param keepPath - true = 后续追加写回读进来的这个路径。
   *                   省略时按会话根目录重算路径（归档区里的文件因此会被"搬回"活动区，
   *                   这是历史行为，只有读别人家的日志才需要传 true）。
   * @param options.lease - 是否拿写租约（T30）。缺省 true = 拿（恢复要接着写，写的人
   *                        还负责把中断回合修复落盘）；只读重放（队友记录的 peek）传 false。
   */
  static load(file: string, keepPath = false, options: { lease?: boolean } = {}): Session {
    const lease = options.lease === false ? null : takeWriteLease(file)
    try {
      return Session.buildFromLog(file, keepPath, lease)
    } catch (error) {
      lease?.release()
      throw error
    }
  }

  /** T30/T31/T32 的装配核心：读日志 → 逐行重放 →（头坏了就抢救）→（握着租约就修复中断回合）。 */
  private static buildFromLog(file: string, keepPath: boolean, lease: FileLock | null): Session {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    let meta: SessionMeta | undefined
    const messages: ChatMessage[] = []
    const toolErrors = new Map<string, string>()
    const fileChanges = new Map<string, FileChangeSummary[]>()
    const presentations = new Map<string, ToolPresentationView>()
    /** 已应答过的 callId（首条为准）。 */
    const repliedCalls = new Set<string>()
    const state = new Map<string, unknown>()
    const notes: SessionNote[] = []
    for (const line of lines) {
      let record: SessionRecord
      try {
        record = JSON.parse(line) as SessionRecord
      } catch {
        continue
      }
      switch (record.type) {
        case 'meta':
          meta = { id: record.id, cwd: record.cwd, createdAt: record.createdAt }
          break
        case 'user':
          messages.push({
            role: 'user',
            content: userContent(record.text, record.images, record.files),
            ...(record.files === undefined || record.files.length === 0 ? {} : { files: record.files }),
            // 老日志没有 ts：这里就是 undefined，界面据此降级（不显示时间/用时）
            ...(record.ts === undefined ? {} : { ts: record.ts }),
            // 机器投递的通知（老日志没有这个字段，按人打的字读）
            ...(record.origin === 'notice' ? { origin: record.origin } : {}),
          })
          break
        case 'assistant': {
          messages.push({
            role: 'assistant',
            content: record.text,
            ...(record.reasoning !== '' ? { reasoning_content: record.reasoning } : {}),
            ...(record.toolCalls !== undefined && record.toolCalls.length > 0
              ? {
                  tool_calls: record.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function' as const,
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : {}),
            ...(record.ts === undefined ? {} : { ts: record.ts }),
          })
          break
        }
        case 'tool': {
          // 同一个 callId 只应答一次：重复记录（中断修复的合成件 + 被打断回合晚到的
          // 真实结果，见 plugins/session 的同路径短路）从第二条起整个跳过——内存与
          // 之后的每一次请求都不再见到它；日志保持 append-only，不改写历史。
          if (repliedCalls.has(record.callId)) break
          repliedCalls.add(record.callId)
          const content: ChatContentPart[] | string =
            record.images !== undefined && record.images.length > 0
              ? [
                  { type: 'text', text: record.text },
                  ...record.images.map((url): ChatContentPart => ({ type: 'image_url', image_url: { url } })),
                ]
              : record.text
          messages.push({
            role: 'tool',
            content,
            tool_call_id: record.callId,
            ...(record.ts === undefined ? {} : { ts: record.ts }),
          })
          // 状态取自 error 字段；早于该字段的老日志按固定回执文案把「已拒绝」补回来
          const error = record.error ?? (record.text === REJECTED_TOOL_TEXT ? REJECTED_TOOL_ERROR : undefined)
          if (error !== undefined) toolErrors.set(record.callId, error)
          // 老日志写的是单值，新日志写数组：两种都收（同一份记录不会两个形状都有）
          if (record.changes !== undefined) {
            fileChanges.set(record.callId, Array.isArray(record.changes) ? record.changes : [record.changes])
          }
          if (record.presentation !== undefined) presentations.set(record.callId, record.presentation)
          break
        }
        case 'summary': {
          // 摘要之前的原始记录还留在磁盘上（append-only），逐条读回来等于这次压缩白做；
          // 所以这里把已经读到的消息换成「摘要 + 末尾 keep 条」。尾部必须在清空之前取。
          // 老日志没有 keep 字段，按 0 走：结果是「摘要 + 摘要之后的记录」。这是刻意的向后兼容，
          // 比把摘要之前的原文整段读回来（压缩等于没压）好得多。
          const keep = record.keep ?? 0
          const tail = keep > 0 ? messages.slice(-keep) : []
          messages.length = 0
          messages.push({
            role: 'user',
            content: record.text,
            ...(record.ts === undefined ? {} : { ts: record.ts }),
          })
          messages.push(...tail)
          break
        }
        case 'state':
          state.set(record.id, record.payload)
          break
        case 'rewind': {
          // 「从这里往后作废」（编辑并重发）：截到第 keep 条人打的用户消息之前。
          // 序号越界（老日志被别的东西改过）就当没看见——宁可多显示一段历史，也不能
          // 把正常内容截没。
          const keep = Number.isFinite(record.keep) && record.keep >= 0 ? Math.floor(record.keep) : 0
          const cut = cutIndexBeforeUser(messages, keep)
          if (cut >= 0) messages.length = cut
          break
        }
        case 'note':
          notes.push({ id: record.id, text: record.text, ts: record.ts })
          break
        // ↓ 老会话日志的兼容分支（这四种记录已不再写入），按现在的条目名归位
        case 'mode':
          state.set('mode', record.mode)
          break
        case 'todo':
          state.set('todos', record.items)
          break
        case 'plan':
          state.set('plan', record.plan)
          break
        case 'goal':
          state.set('goal', record.goal)
          break
      }
    }
    // T31：meta 首行损坏（半截 JSON）不等于整个会话报废——从内容抢救一份 meta，
    // 抢救不出来才报错（文件原样保留，绝不静默回落「开新会话」让用户无感知丢会话）。
    if (meta === undefined) meta = salvageMeta(file, lines)
    const session = new Session(
      meta,
      keepPath ? file : join(sessionsRoot(), slugCwd(meta.cwd), `${meta.id}.jsonl`),
      messages,
      true,
      state,
      notes,
      lease,
    )
    for (const [callId, error] of toolErrors) session.toolErrors.set(callId, error)
    for (const [callId, change] of fileChanges) session.fileChanges.set(callId, change)
    for (const [callId, presentation] of presentations) session.presentations.set(callId, presentation)
    // T32：修复只在「我们是写租约持有人」时做——修复要落盘，只读重放（队友记录 peek）不动它。
    if (lease !== null) {
      session.repairInterruptedTurns()
      // 收件箱遗债：入箱后没等到边界就重启/切换的异步输入。修复完历史必然闭合，
      // 直接落库（dsh 的收件箱是持久投影，重启后同样要交货）。来源跟着走：
      // 机器投递的那几条不能因为「重启过一次」就变回人打的字（见 InboxOrigin）。
      for (const item of session.takeAsyncInbox()) session.appendUser(item.text, item.images, item.files, item.origin)
    }
    return session
  }

  /**
   * 追加用户消息。带图时消息以多模态 content 数组落库（要模型声明了照片输入才发得出去；
   * JSONL 记 text + images 两个字段，跟工具结果带图的写法一致）。
   *
   * `ts` 只写一份给内存与磁盘共用：界面按它显示「这条消息几点发的」，
   * 也是这一轮「用时」的起点（见 contract.ts 的 TranscriptEntry.ts）。
   *
   * @param origin - 谁发起的这条（缺省 `'user'`）。只有 `'notice'`（机器投递）会写进日志，
   *   界面与重放据此把它画成内部触发行而不是用户气泡（见 {@link InboxOrigin}）。
   */
  appendUser(text: string, images?: string[], files?: UserFileAttachment[], origin: InboxOrigin = 'user'): void {
    const withImages = images !== undefined && images.length > 0
    const withFiles = files !== undefined && files.length > 0
    const notice = origin === 'notice'
    const ts = Date.now()
    this.messages.push({
      role: 'user',
      content: userContent(text, images, files),
      ...(withFiles ? { files } : {}),
      ...(notice ? { origin } : {}),
      ts,
    })
    this.write({
      type: 'user',
      text,
      ...(withImages ? { images } : {}),
      ...(withFiles ? { files } : {}),
      ...(notice ? { origin } : {}),
      ts,
    })
  }

  /**
   * 作废第 keep 条用户消息及其之后的一切（「编辑并重发」用，2026-11-03）。
   *
   * 语义：保留前 keep 条人打的用户消息与它们各自的回答，从第 keep 条（0 基）开始整段丢掉，
   * 之后由调用方 appendUser 把改过的文字重新写进去。**日志一个字都不删**——落一条
   * `rewind` 记录声明「从这里往后作废」，重放按同一条规则截断（见 load 的 `case 'rewind'`）。
   *
   * @param keep - 保留几轮（人打的用户消息条数）。
   * @returns false = 这条消息已经不在会话里（序号越界），调用方应当如实回报而不是硬改。
   */
  rewindToUser(keep: number): boolean {
    const cut = cutIndexBeforeUser(this.messages, keep)
    if (cut < 0) return false
    const dropped = this.messages.splice(cut)
    // 被丢掉那段的工具派生状态（错误标记 / 改动清单 / 卡片）一并清掉：它们按 callId 存，
    // 作用域只到那些消息为止，留着就是纯占内存（同一个 callId 不会再来一次）。
    const kept = new Set<string>()
    for (const message of this.messages) {
      if (message.role === 'tool' && message.tool_call_id !== undefined) kept.add(message.tool_call_id)
      for (const call of message.tool_calls ?? []) kept.add(call.id)
    }
    const forget = (callId: string): void => {
      this.toolErrors.delete(callId)
      this.fileChanges.delete(callId)
      this.presentations.delete(callId)
    }
    for (const message of dropped) {
      if (message.role === 'tool' && message.tool_call_id !== undefined && !kept.has(message.tool_call_id)) forget(message.tool_call_id)
      for (const call of message.tool_calls ?? []) if (!kept.has(call.id)) forget(call.id)
    }
    this.write({ type: 'rewind', keep, ts: Date.now() })
    return true
  }

  appendAssistant(text: string, reasoning: string, toolCalls: ToolCall[]): void {
    const ts = Date.now()
    this.messages.push({
      role: 'assistant',
      content: text,
      ...(reasoning !== '' ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
      ts,
    })
    this.write({
      type: 'assistant',
      text,
      reasoning,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ts,
    })
  }

  /**
   * 追加工具结果。output 为对象时支持附带图像（data URL），消息以多模态
   * content 数组落库（需端点支持视觉；JSONL 记录 text + images 两字段）。
   * error 是展示状态标记（`rejected` / `tool-error`），随 jsonl 一起落盘，
   * 但不进协议消息——重放历史时由 {@link Session.toolErrors} 提供给界面。
   */
  appendTool(
    callId: string,
    name: string,
    output: string | {
      text: string
      images?: string[]
      changes?: FileChangeSummary | FileChangeSummary[]
      presentation?: ToolPresentationView
    },
    error?: string,
  ): void {
    // 同一个 callId 已经有结果就不落第二条：中断修复补过「结果未知」合成件之后，
    // 被打断那一轮晚到的真实结果会走到这里——写下去就是协议上的重复应答（下一次
    // 请求被网关 400）。界面上的实时结果照常由调用方的 tool/result 事件展示。
    if (this.messages.some((message) => message.role === 'tool' && message.tool_call_id === callId)) return
    const ts = Date.now()
    const text = typeof output === 'string' ? output : output.text
    const images = typeof output === 'string' ? undefined : output.images
    const changes = typeof output === 'string' ? undefined : output.changes
    const presentation = typeof output === 'string' ? undefined : output.presentation
    const content: string | ChatContentPart[] =
      images !== undefined && images.length > 0
        ? [
            { type: 'text', text },
            ...images.map((url): ChatContentPart => ({ type: 'image_url', image_url: { url } })),
          ]
        : text
    this.messages.push({ role: 'tool', content, tool_call_id: callId, ts })
    if (error !== undefined) this.toolErrors.set(callId, error)
    // baseline（改前全文）是循环回合基线记账的内存字段，进不了日志与旁路：
    // 两处都在入口剥掉，上游忘了剥也漏不出去。
    const cleanList = changes === undefined ? [] : (Array.isArray(changes) ? changes : [changes]).map(stripBaseline)
    if (cleanList.length > 0) this.fileChanges.set(callId, cleanList)
    if (presentation !== undefined) this.presentations.set(callId, presentation)
    this.write({
      type: 'tool',
      callId,
      name,
      text,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      // 内存消息不带 changes（协议消息透传给端点，多字段可能被挑剔的网关判 400）；
      // 它只活在日志里，恢复会话时经 fileChanges 旁路还原成轮尾卡。
      ...(cleanList.length === 0 ? {} : { changes: cleanList.length === 1 ? cleanList[0]! : cleanList }),
      ...(presentation !== undefined ? { presentation } : {}),
      ...(error !== undefined ? { error } : {}),
      ts,
    })
  }

  /**
   * 循环在每次成功的 write / edit 落库时调：本回合首次触碰这个文件就记下「动之前的全文」
   * 当基线，之后同文件的再改不动它（要的正是回合起点，不是各刀起点）。
   */
  recordTurnChange(path: string, baseline: string): void {
    if (this.turnBaselines.has(path)) return
    this.turnBaselines.set(path, baseline)
    this.turnTouched.push(path)
  }

  /**
   * 回合收尾的聚合改动：逐个「本回合动过的文件」读盘上现值，与基线重算一份 diff。
   * 读不到（被删/被挪）或算不出差异（改了又改回去）的文件跳过；取完基线即清空。
   * 产物不带 baseline（剥干净才进事件），落盘也由调用方自理——聚合 diff 不落 jsonl。
   */
  async takeTurnChanges(): Promise<FileChangeSummary[]> {
    const touched = this.turnTouched
    this.turnTouched = []
    const baselines = this.turnBaselines
    this.turnBaselines = new Map()
    const files: FileChangeSummary[] = []
    for (const path of touched) {
      const baseline = baselines.get(path) ?? ''
      const current = await fsp.readFile(path, 'utf8').catch(() => null)
      if (current === null) continue
      const change = summarizeChange(path, baseline, current)
      if (change !== undefined) files.push(stripBaseline(change))
    }
    return files
  }

  /**
   * T32：中断回合的修复。恢复会话时扫一遍消息，最后一个带 tool_calls 的 assistant
   * 若有配不上结果的调用，就各补一条「已发起、结果未知」的合成结果并落盘——模型据此
   * 知道这个调用可能已有副作用，先核查再决定重试。落盘之后孤儿不再存在，重复恢复幂等。
   * 只在握着写租约时调用（修复要写盘）；尾巴之前的孤儿（不该出现）仍由请求侧的
   * sanitizeToolOrphans 兜底。
   */
  private repairInterruptedTurns(): void {
    const answered = new Set<string>()
    for (const message of this.messages) {
      if (message.role === 'tool' && message.tool_call_id !== undefined) answered.add(message.tool_call_id)
    }
    let last = -1
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]!
      if (message.role === 'assistant' && message.tool_calls !== undefined && message.tool_calls.length > 0) {
        last = index
        break
      }
      if (message.role === 'user') break // 回到用户消息还没见着带调用的 assistant：没有待修复的尾巴
    }
    if (last < 0) return
    for (const call of this.messages[last]!.tool_calls!) {
      if (answered.has(call.id)) continue
      this.appendTool(call.id, call.function.name, INTERRUPTED_TOOL_TEXT)
    }
  }

  /**
   * 压缩落库：内存里换成「摘要 + 保留的尾部」，磁盘上追加一条 summary 记录。
   *
   * `keep` 记下保留了多少条尾部消息：日志是 append-only，摘要之前的原始记录一条都不会删，
   * 重放时只能靠这个数字知道该从磁盘记录构建出的消息里留下末尾几条
   * （见 {@link Session.load} 的 `case 'summary'`）。
   * @param summaryText - 摘要正文（第一条保留消息的 content）。
   * @param kept - 压缩后内存里要留的消息，第一条就是摘要本身。
   */
  replaceWithSummary(summaryText: string, kept: ChatMessage[]): void {
    // 摘要那条是压缩现场新造的，补一个落盘时刻；尾部那些本来就在内存里，保持原时间不变
    // （不然压缩会把历史消息的时间全刷成「现在」）。
    const ts = Date.now()
    for (const message of kept) if (message.ts === undefined) message.ts = ts
    this.messages.length = 0
    this.messages.push(...kept)
    // 尾部不重新写盘：那得把 tool 记录的 name 字段反推回来，得不偿失。
    // kept[0] 是摘要本身，所以减一才是尾部条数。
    this.write({ type: 'summary', text: summaryText, keep: Math.max(kept.length - 1, 0), ts })
  }

  /**
   * 读一个会话状态条目（恢复历史会话时由日志重放填回）。
   * @param id - 条目名，见 {@link SessionStateMap}。
   * @returns 这个功能点最后写进去的负载；没写过就是 undefined。
   */
  state<K extends keyof SessionStateMap>(id: K): SessionStateMap[K] | undefined {
    // 负载从磁盘 JSON 里来，读的时候不重新校验（各功能点自己负责读懂自己存的东西，
    // 例如 GoalStore.restore 会挑坏值），这里只做条目名的查表。
    return this.stateById.get(id as string) as SessionStateMap[K] | undefined
  }

  /**
   * 写一个会话状态条目：内存里换掉，磁盘上追加一条（日志是 append-only，最后一条生效）。
   * @param id - 条目名，见 {@link SessionStateMap}。
   * @param payload - 这个功能点自己的负载。
   */
  appendState<K extends keyof SessionStateMap>(id: K, payload: SessionStateMap[K]): void {
    this.stateById.set(id as string, payload)
    // 这个 id 之前攒着的默认值被真实写入顶掉了，别再跟着下一条日志重复落一遍
    this.deferredState.delete(id as string)
    this.write({ type: 'state', id: String(id), payload })
  }

  /**
   * 只改内存里的状态，等下一次真正写日志时再落盘（读路径补默认值专用）。
   *
   * 与 {@link appendState} 的区别：这里的值由后续写盘顺带带出，所以「只打开一次
   * 会话、什么都没做」不会再改动文件（mtime 不变，侧栏的「最近使用」也就不会跳）。
   * 同一进程里读到的值立刻生效，和落过盘没有区别。
   */
  setState<K extends keyof SessionStateMap>(id: K, payload: SessionStateMap[K]): void {
    this.stateById.set(id as string, payload)
    this.deferredState.set(id as string, payload)
  }

  /**
   * 异步输入入箱：回合跑动中到达的输入先在这里排队（state 条目持久化，重启不丢），
   * 等 loop 在步骤边界/回合收尾时出账落库。见 {@link SessionStateMap} 的
   * `async-inbox` 注释。
   * @param origin - 这条是用户来源还是机器来源（缺省 `'user'`，老调用点行为不变）。
   *   只有 `'notice'` 会被记进条目（`'user'` 保持条目形状与老状态一致，读时兜底）。
   */
  enqueueAsync(text: string, images?: string[], origin: InboxOrigin = 'user', files?: UserFileAttachment[]): void {
    const current = this.state('async-inbox')?.items ?? []
    this.appendState('async-inbox', {
      items: [
        ...current,
        {
          text,
          ...(images !== undefined && images.length > 0 ? { images } : {}),
          ...(files !== undefined && files.length > 0 ? { files } : {}),
          ...(origin === 'notice' ? { origin } : {}),
        },
      ],
    })
  }

  /**
   * 收件箱只读快照：界面照它画输入框下方的「排队消息」条（用户来源）与输入框上方的
   * 「待投递通知」条（机器来源）。只偷看，不取货也不动日志——取货是 {@link takeAsyncInbox}。
   */
  asyncInbox(): ReadonlyArray<AsyncInboxItem> {
    return this.state('async-inbox')?.items ?? []
  }

  /**
   * 改一条排队中的异步输入（正文换掉，图片与来源不动）。越界或改成空白当空操作。
   * @returns 是否真的改了（调用方据此决定要不要让界面刷新）。
   */
  editAsync(index: number, text: string): boolean {
    const items = [...this.asyncInbox()]
    const current = items[index]
    if (current === undefined || text.trim() === '') return false
    const keptImages = current.images !== undefined && current.images.length > 0 ? current.images : undefined
    items[index] = {
      text,
      ...(keptImages === undefined ? {} : { images: keptImages }),
      ...(current.origin === undefined ? {} : { origin: current.origin }),
    }
    this.appendState('async-inbox', { items })
    return true
  }

  /** 撤掉一条排队中的异步输入（还没出账，撤了就等于没发过）。 */
  removeAsync(index: number): boolean {
    const items = [...this.asyncInbox()]
    if (items[index] === undefined) return false
    items.splice(index, 1)
    this.appendState('async-inbox', { items })
    return true
  }

  /**
   * 把一条排队输入提到队首（插话用，0.6.67）：回合被 {@link MiniAgent.cancel} 打断后
   * 收尾出账，队首那条先落库，模型下一句话就先看到它。
   */
  promoteAsync(index: number): boolean {
    const items = [...this.asyncInbox()]
    const current = items[index]
    if (current === undefined) return false
    // 已经在队首：没有可提前的，算「已经就位」（不写日志）
    if (index === 0) return true
    items.splice(index, 1)
    this.appendState('async-inbox', { items: [current, ...items] })
    return true
  }

  /**
   * 收件箱出账：取走全部排队中的异步输入并清空条目。空箱是常见路径，不动日志。
   * 取走后由调用方负责 appendUser 落库（顺序上保证 tool 结果已闭合）。
   */
  takeAsyncInbox(): AsyncInboxItem[] {
    const items = this.state('async-inbox')?.items ?? []
    if (items.length > 0) this.appendState('async-inbox', { items: [] })
    return items
  }

  /** 已记录的请求注入备忘（note 记录），按写入顺序；恢复会话时从日志重放回来。 */
  notes(): readonly SessionNote[] {
    return this.noteLog
  }

  /**
   * 追加一条请求注入备忘（note 记录）：投影往请求体里塞的、日志上本来没有的内容
   * 必须在此留底，模型看到的东西才能从日志完整重建（dsh 的 Model-visible ⟺ logged）。
   * 备忘不参与重放折叠，界面暂不显示；多次调用按顺序各留一条。
   * @param id - 注入来源的投影名（例如 `lsp-write-diagnostics`）。
   * @param text - 注入的原文。
   */
  appendNote(id: string, text: string): void {
    const ts = Date.now()
    this.noteLog.push({ id, text, ts })
    this.write({ type: 'note', id, text, ts })
  }

  close(): void {
    this.stream?.end()
    this.stream = null
    // T30：写租约随会话关闭一起还（切会话、退出都会走到这）
    this.lease?.release()
    this.lease = null
    // 回合基线是纯内存的回合内状态：会话关掉（/new、/resume 切走）就没有意义了
    this.turnBaselines = new Map()
    this.turnTouched = []
  }

  /** 日志有没有落盘：新建但还没发过消息的会话为 false（磁盘上没有它的文件）。 */
  get persisted(): boolean {
    return this.metaWritten
  }

  get filePath(): string {
    return this.file
  }

  private write(record: SessionRecord): void {
    // 还没说过话：state 这类记账先攒着，别为了补一个默认值就在磁盘上建出空会话
    if (this.metaWritten !== true && record.type === 'state') {
      this.pendingState.push(record)
      return
    }
    // 第一条真正的日志顺带补上 meta 首行：jsonl 的 append-only 顺序不能变。
    // 攒下的记账紧跟在 meta 后面、按产生顺序写出——恢复时会逐条重放、最后一条
    // 生效，顺序反了就会读到错的默认值。
    if (this.metaWritten !== true) {
      this.metaWritten = true
      const stream = this.streamFor()
      stream.write(`${JSON.stringify({ type: 'meta', ...this.meta })}\n`)
      for (const pending of this.pendingState) stream.write(`${JSON.stringify(pending)}\n`)
      this.pendingState.length = 0
    }
    // 读路径攒下的默认值跟着这一条一起落盘：顺序在触发它的记录之前，重放时最后一条
    // 生效，与「先补钉、再做事」的因果一致。
    if (this.deferredState.size > 0) {
      const stream = this.streamFor()
      for (const [id, payload] of this.deferredState) {
        stream.write(`${JSON.stringify({ type: 'state', id, payload })}\n`)
      }
      this.deferredState.clear()
    }
    this.streamFor().write(`${JSON.stringify(record)}\n`)
  }

  /** 第一条日志要落盘时才建工作区目录、开写入流。 */
  private streamFor(): ReturnType<typeof createWriteStream> {
    if (this.stream === null) {
      mkdirSync(dirname(this.file), { recursive: true })
      const stream = createWriteStream(this.file, { flags: 'a', encoding: 'utf8' })
      // 磁盘满/权限错的 error 事件没人接会让进程以未捕获异常崩掉（2026-09-29）：
      // 丢掉这条流，下一条日志重新开——丢一条记录好过崩掉整个宿主。
      stream.on('error', () => {
        if (this.stream === stream) this.stream = null
      })
      this.stream = stream
    }
    return this.stream
  }
}

/**
 * 列表投影的一行：读一个 jsonl 文件得到的元数据 + sidecar 属性 + 文件路径。
 * `updatedAt` 是「最后一步」的时刻（最后一条带 `ts` 的对话记录，见
 * {@link lastActivityAt}），是「最近使用」的排序依据；文件 mtime 只用来做读盘缓存的键。
 */
export interface SessionListItem {
  /** 会话 uuid。 */
  id: string
  cwd: string
  /** 创建时间（meta 首行）。 */
  createdAt: number
  /** 最后一步的时刻：最后一条带 `ts` 的对话记录；老日志没有 ts 时回落文件 mtime。 */
  updatedAt: number
  /** 展示标题：用户改过的标题优先，否则首条用户消息截断。 */
  title?: string
  /** 置顶时间；有值即置顶。 */
  pinnedAt?: number
  /** 归档时间；只在归档列表里有值。 */
  archivedAt?: number
  /** jsonl 的绝对路径（UI 侧的会话 id 就是它）。 */
  path: string
}

/** 归档区与回收站（都在 ~/.dsc 下，点开头的名字让正常列表自然跳过）。 */
export function archivedRoot(): string {
  return join(sessionsRoot(), '.archived')
}

export function trashRoot(): string {
  return dscPath('.trash')
}

/** 回收站保留天数：超期的文件在下次访问归档区时清掉。 */
const TRASH_RETENTION_DAYS = 30

/** 列出全部会话（正常区；归档区与回收站不在内）。 */
export function listSessions(): SessionListItem[] {
  return scanSessions(sessionsRoot(), readSessionMeta())
}

/** 列出归档会话，按归档时间倒序；顺手清一次过期的回收站文件。 */
export function listArchivedSessions(): SessionListItem[] {
  sweepTrash()
  const metas = readSessionMeta()
  return scanSessions(archivedRoot(), metas)
    .map((item) => ({ ...item, archivedAt: metas[item.id]?.archivedAt ?? item.updatedAt }))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

/**
 * 扫一个根目录下的 `<工作目录名>/<uuid>.jsonl`。
 * 跳过点开头的条目（`.archived` 归档区）和非目录（`meta.json` sidecar），
 * 单个文件读失败只丢这一条，不影响整个列表。
 */
function scanSessions(root: string, metas: Record<string, SessionMetaRecord>): SessionListItem[] {
  if (!existsSync(root)) return []
  const out: SessionListItem[] = []
  for (const dir of readdirSync(root)) {
    if (dir.startsWith('.')) continue
    const dirPath = join(root, dir)
    if (!statSync(dirPath).isDirectory()) continue
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.jsonl')) continue
      // 文件名就是 `<uuid>.jsonl`，sidecar 按 uuid 存，所以按文件名取属性
      const item = readSessionFile(join(dirPath, file), metas[basename(file, '.jsonl')])
      if (item !== null) out.push(item)
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 文件里有没有一条真正的对话记录（user 或 assistant）。
 *
 * 只有 meta 与 state 记账的文件是「点了新会话、一个字没发」留下的（缓冲上线之前的
 * 存量文件、以及插件补默认值写出来的旧文件）：它们不该在列表里占一行。记录都由本
 * 模块写出，type 永远是第一个键，所以按行首前缀判断就够，不用逐行 JSON.parse。
 */
function hasConversation(lines: string[]): boolean {
  return lines.some((line) => line.startsWith('{"type":"user"') || line.startsWith('{"type":"assistant"'))
}

/**
 * 侧栏一行的读盘缓存（2026-11-03）：键 = 文件路径 + 侧栏属性（标题/置顶），
 * 值 = 上次的 mtime、大小与读出来的那一行。
 *
 * 为什么加：`listSessions()` 每次都把**每个会话文件的整份内容**读一遍（只为拿 meta 行
 * 与第一条用户消息），实测 76 条会话要 120–150ms；而界面**每点一次会话**就会
 * `refreshSessions` 重扫一次——这一下比读会话本身还贵，且完全没必要：切会话不会
 * 改动任何文件。
 *
 * 认 mtime + 大小：会话在长（append），那一条自己会失效重读；其余几十条一个字节没变，
 * 直接复用。标题/置顶存在 meta.json sidecar 里、不碰 jsonl，所以把它们一起编进键，
 * 改完名字立刻能看到（代价是这条会多读一次，改名是低频动作）。
 */
const sessionRowCache = new Map<string, { mtimeMs: number; size: number; item: SessionListItem | null }>()

/** 读一个会话文件的前几行 + mtime；首行不是 meta（损坏/空文件）时尽量抢救（T31）。 */
function readSessionFile(filePath: string, sidecar?: SessionMetaRecord): SessionListItem | null {
  let stat: Stats
  try {
    stat = statSync(filePath)
  } catch {
    return null
  }
  const key = `${filePath}\u0000${sidecar?.title ?? ''}\u0000${sidecar?.autoTitle ?? ''}\u0000${String(sidecar?.pinnedAt ?? '')}`
  const cached = sessionRowCache.get(key)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.item
  const item = readSessionFileUncached(filePath, stat.mtimeMs, sidecar)
  // 上限只是防御：正常是一个工作目录几十到几百条会话。
  if (sessionRowCache.size > 512) sessionRowCache.clear()
  sessionRowCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, item })
  return item
}

/** 读尾部找「最后一句话」时的窗口：state 记账一条不到 1KB，512KB 够翻过一大批。 */
const TAIL_SCAN_CHARS = 512 * 1024

/**
 * 「最近使用」的时刻 = 最后一条带 `ts` 的记录，不是文件 mtime。
 *
 * 为什么（2026-11-03 用户报障「点一下会话，时间就变刚刚」）：mtime 只说明「这个文件
 * 刚被写过」。权限三项的默认值、模型档位这些记账都会在**打开会话**时补写一条
 * `state`，于是老会话被点开一次，侧栏时间就跳到「刚刚」——可它一个字都没多。
 * 界面要的是「最后一步是什么时候」，所以取最后一条带 `ts` 的对话记录
 * （user / assistant / tool / summary / rewind / note 都带），没有 `ts` 的 state
 * 记账自然被跳过。
 *
 * 老日志（`ts` 字段引入之前）整份都找不到 ts：回落到 mtime，至少排序不乱。
 * 只扫尾部：append-only 的日志里最后一条记录必定贴着文件尾，单独一段够用；
 * 万一最后一条本身超过窗口被切碎，解析失败就当没看见，继续往前找。
 *
 * @param text - 会话文件全文（调用方已经读出来了，不再读第二次）。
 * @param fallback - 找不到任何 `ts` 时用它（调用方传 mtime）。
 */
function lastActivityAt(text: string, fallback: number): number {
  const tail = text.length > TAIL_SCAN_CHARS ? text.slice(text.length - TAIL_SCAN_CHARS) : text
  const lines = tail.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    // 便宜的先筛：没有 ts 字样的行（state 记账都是这种）直接跳过，不做 JSON.parse
    if (!line.includes('"ts"')) continue
    try {
      const record = JSON.parse(line) as { ts?: unknown }
      if (typeof record.ts === 'number' && Number.isFinite(record.ts)) return record.ts
    } catch {
      // 窗口起点切碎的半行、坏行：跳过，继续往前找
    }
  }
  return fallback
}

/** {@link readSessionFile} 的真读：mtime 由调用方传进来，省一次 stat。 */
function readSessionFileUncached(filePath: string, mtimeMs: number, sidecar?: SessionMetaRecord): SessionListItem | null {
  try {
    const text = readFileSync(filePath, 'utf8')
    const head = text.split(/\r?\n/, 200)
    // 一条对话记录都没有：不进列表（T31「头行损坏也露脸」只放过真有对话的文件）。
    // 这里只读了前 200 行，state 攒得多时首条用户消息可能被挤出窗口；真截断了就
    // 把整份再看一眼，免得一条正常会话从列表里凭空消失。
    if (!hasConversation(head) && (head.length < 200 || !hasConversation(text.split(/\r?\n/)))) {
      return null
    }
    let record: SessionRecord | undefined
    try {
      record = JSON.parse(head[0] ?? '') as SessionRecord
    } catch {
      record = undefined
    }
    if (record?.type === 'meta') {
      const derived = head.find((line) => line.startsWith('{"type":"user"'))
      // T16：展示链 用户改名 → 自动生成 → 首条用户消息截断
      const title = sidecar?.title
        ?? sidecar?.autoTitle
        ?? (derived !== undefined
          ? (JSON.parse(derived) as { text: string }).text.replace(/\s+/g, ' ').trim().slice(0, 60)
          : undefined)
      return {
        id: record.id,
        cwd: record.cwd,
        createdAt: record.createdAt,
        updatedAt: lastActivityAt(text, mtimeMs),
        ...(title !== undefined ? { title } : {}),
        ...(sidecar?.pinnedAt !== undefined ? { pinnedAt: sidecar.pinnedAt } : {}),
        path: filePath,
      }
    }
    // T31：头行坏了的会话也要在列表里露脸（不然用户连「打开它」的入口都没有）。
    // id 取文件名、标题取幸存的首条用户消息、cwd 从幸存的改动路径反推；推不出 cwd
    // 就给空串（列表照常显示，真去打开时会拿到「头损坏」的明确报错）。
    const paths = new Set<string>()
    // T16：展示链 用户改名 → 自动生成 → 首条用户消息截断
    let title: string | undefined = sidecar?.title ?? sidecar?.autoTitle
    for (const line of head) {
      if (!line.startsWith('{"type":"')) continue
      try {
        const parsed = JSON.parse(line) as { type?: string; text?: unknown; changes?: { path?: unknown }[] }
        if (title === undefined && parsed.type === 'user' && typeof parsed.text === 'string' && parsed.text !== '') {
          title = parsed.text.replace(/\s+/g, ' ').trim().slice(0, 60)
        }
        if (Array.isArray(parsed.changes)) {
          for (const change of parsed.changes) {
            if (change !== null && typeof change === 'object' && typeof change.path === 'string' && change.path !== '') {
              paths.add(change.path)
            }
          }
        }
      } catch {
        // 坏行跳过
      }
    }
    let createdAt = statSync(filePath).birthtimeMs
    if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = statSync(filePath).mtimeMs
    return {
      id: basename(filePath, '.jsonl'),
      cwd: commonDirectory(paths) ?? '',
      createdAt,
      updatedAt: lastActivityAt(text, mtimeMs),
      ...(title !== undefined ? { title } : {}),
      ...(sidecar?.pinnedAt !== undefined ? { pinnedAt: sidecar.pinnedAt } : {}),
      path: filePath,
    }
  } catch {
    return null
  }
}

/**
 * 队友（子智能体）运行记录的根目录。它放在会话根目录下的 `.teammates`，
 * 于是会话列表扫不到它（scanSessions 跳过点开头的条目），
 * 但路径校验仍认它是"自己家的日志"，桌面端可以只读打开它。
 */
export function teammateRoot(): string {
  return join(sessionsRoot(), '.teammates')
}

/** 会话文件必须落在 sessions 根下（归档区也算），才允许被这些操作碰到。 */
function assertSessionFile(filePath: string): string {
  const root = sessionsRoot()
  const resolved = join(filePath)
  if (!resolved.startsWith(root + '\\') && !resolved.startsWith(root + '/')) {
    throw new Error(`会话路径不在 ${root} 下：${filePath}`)
  }
  if (!resolved.endsWith('.jsonl') || !existsSync(resolved)) {
    throw new Error(`会话文件不存在：${filePath}`)
  }
  // 队友的运行记录是只读史料：归档、永久删除、分叉都不许对它下手。
  for (const sep of ['\\', '/']) {
    if (resolved.startsWith(teammateRoot() + sep)) {
      throw new Error(`这是队友的运行记录，不能归档、永久删除或分叉：${basename(filePath)}`)
    }
  }
  return resolved
}

/** 再加一条：只有活动区的会话能被归档，归档区里的要走恢复。 */
function assertLiveSessionFile(filePath: string): string {
  const resolved = assertSessionFile(filePath)
  if (resolved.startsWith(archivedRoot() + '\\') || resolved.startsWith(archivedRoot() + '/')) {
    throw new Error(`这个会话已经在归档区：${basename(filePath)}`)
  }
  return resolved
}

/** 把会话从当前位置移到 `from` 下同名层级，返回新路径。 */
function moveSessionFile(filePath: string, toRoot: string): string {
  const target = join(toRoot, basename(dirname(filePath)), basename(filePath))
  mkdirSync(dirname(target), { recursive: true })
  renameSync(filePath, target)
  return target
}

/** 归档一个会话：移进 `.archived/<工作目录名>/`，并在 sidecar 记归档时间。 */
export function archiveSession(filePath: string): string {
  const source = assertLiveSessionFile(filePath)
  // T30：挪文件之前拿写租约——另一个窗口正开着它就明确拒绝，而不是把人家手里的路径挪没
  return withExclusiveLock(source, busyLeaseMessage(source), () => {
    const target = moveSessionFile(source, archivedRoot())
    patchSessionMeta(uuidOf(source), { archivedAt: Date.now() })
    return target
  })
}

/** 恢复一个归档会话：移回正常区，清掉归档时间。 */
export function restoreSession(archivedPath: string): string {
  const source = join(archivedPath)
  if (!source.startsWith(archivedRoot()) || !existsSync(source)) throw new Error(`归档会话不存在：${archivedPath}`)
  return withExclusiveLock(source, busyLeaseMessage(source), () => {
    const target = moveSessionFile(source, sessionsRoot())
    patchSessionMeta(uuidOf(source), { archivedAt: null })
    return target
  })
}

/**
 * 永久删除一个会话：移进回收站 `.trash/<工作目录名>/`，超过
 * {@link TRASH_RETENTION_DAYS} 天后由 {@link sweepTrash} 清掉。
 * 会话内容不再出现在任何列表里，但文件还在磁盘上可手工救回。
 */
export function purgeSession(filePath: string): string {
  // 归档区和活动区都删得掉：设置页传进来的路径就在 .archived/ 里
  const source = assertSessionFile(filePath)
  return withExclusiveLock(source, busyLeaseMessage(source), () => {
    const target = moveSessionFile(source, trashRoot())
    dropSessionMeta(uuidOf(source))
    return target
  })
}

/** 清掉回收站里超过保留期的文件（按 mtime 判断），失败的文件留着下次再清。 */
export function sweepTrash(): number {
  const root = trashRoot()
  if (!existsSync(root)) return 0
  const deadline = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let removed = 0
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir)
    if (!statSync(dirPath).isDirectory()) continue
    for (const file of readdirSync(dirPath)) {
      const filePath = join(dirPath, file)
      try {
        if (statSync(filePath).mtimeMs >= deadline) continue
        unlinkSync(filePath)
        removed += 1
      } catch {
        // 被别的程序占用就留着下次清
      }
    }
  }
  return removed
}

/** 回收站里还留着多少个待清理文件（归档页拿来显示）。 */
export function countTrashFiles(): number {
  const root = trashRoot()
  if (!existsSync(root)) return 0
  let count = 0
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir)
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) continue
    count += readdirSync(dirPath).filter((file) => file.endsWith('.jsonl')).length
  }
  return count
}

/**
 * 把日志里的 `rewind` 指令**应用**到原始行上：返回「作废之后还剩哪些行」。
 *
 * 为什么需要它：`rewind` 是「从这里往后作废」的一条声明，内存与重放都认（见
 * {@link Session.rewindToUser} 与 load 的 `case 'rewind'`），但还有几条读盘的路是
 * **逐行扫原文**的——分叉、分叉菜单、标题推导。不在这里把 rewind 应用一遍，那些路就会
 * 把已经被作废的消息当成还在：分叉菜单里列着它们，从那里分叉出来的新会话还会把
 * `rewind` 记录一起带过去，重放时再把自己截空（2026-11-03 审查抓到）。
 *
 * 结果里的 `rewind` 记录本身不再保留：它已经生效了，留着会让下游再截一次。
 * 越界的 keep（比人打的消息还多）按「没看见」处理，与 load 同一条兜底。
 *
 * @param lines - 一份 jsonl 切出来的行（不含空行）。
 */
function applyRewinds(lines: readonly string[]): string[] {
  const out: string[] = []
  /** 保留下来的行里，每条**人打的**用户消息落在 `out` 的哪个下标（0 基，按消息序）。 */
  const humanAt: number[] = []
  for (const line of lines) {
    if (!line.startsWith('{"type":"')) {
      out.push(line)
      continue
    }
    let record: SessionRecord
    try {
      record = JSON.parse(line) as SessionRecord
    } catch {
      out.push(line)
      continue
    }
    if (record.type === 'rewind') {
      const keep = Number.isFinite(record.keep) && record.keep >= 0 ? Math.floor(record.keep) : 0
      const cut = humanAt[keep]
      if (cut !== undefined) {
        out.length = cut
        humanAt.length = keep
      }
      continue
    }
    if (record.type === 'user' && record.origin !== 'notice' && !record.text.startsWith(TEAMMATE_REPORT_OPEN) && !record.text.startsWith(REVIEW_FINDINGS_OPEN)) {
      humanAt.push(out.length)
    }
    out.push(line)
  }
  return out
}

/**
 * 分叉一个会话：复制日志到第 `beforeUserMessage` 条用户消息之前，
 * 首行 meta 换成新 uuid 与新创建时间，返回新文件路径。
 *
 * @param filePath 源会话 jsonl 路径
 * @param beforeUserMessage 以 0 起算的用户消息序号，分叉结果不含这一条及其之后
 */
export function forkSession(filePath: string, beforeUserMessage: number): string {
  const source = assertLiveSessionFile(filePath)
  // 先应用 rewind：被作废的那段既不该出现在分叉菜单里，也不该被复制进新会话
  // （带着 rewind 记录复制的话，新会话重放时又会把自己截空——2026-11-03 审查抓到）。
  const lines = applyRewinds(readFileSync(source, 'utf8').split(/\r?\n/).filter((line) => line !== ''))
  const first = JSON.parse(lines[0] ?? '') as SessionRecord
  if (first.type !== 'meta') throw new Error(`源会话首行不是 meta：${basename(source)}`)
  let seen = 0
  let cut = lines.length
  let found = false
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index].startsWith('{"type":"user"')) continue
    if (seen === beforeUserMessage) {
      cut = index
      found = true
      break
    }
    seen += 1
  }
  if (!found) {
    // 哨兵：beforeUserMessage 等于用户消息总数 = 整本分叉（/fork 命令与选择器
    // Ctrl+F 都传 listUserMessages().length）——保留到文件末尾，含最后的回复与工具记录。
    if (seen === beforeUserMessage) {
      cut = lines.length
    } else {
      throw new Error(`这个会话没有第 ${beforeUserMessage + 1} 条用户消息，只有 ${seen} 条`)
    }
  }
  if (cut <= 1) throw new Error('分叉点之前没有任何消息，新会话会是空的')
  const meta: SessionMeta = { id: randomUUID(), cwd: first.cwd, createdAt: Date.now() }
  const target = join(sessionsRoot(), slugCwd(first.cwd), `${meta.id}.jsonl`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify({ type: 'meta', ...meta })}\n${lines.slice(1, cut).join('\n')}\n`, 'utf8')
  patchSessionMeta(meta.id, { forkedFrom: first.id })
  return target
}

/** 读一个会话里的用户消息（分叉菜单用它选分叉位置，下标一一对应）。 */
export function readUserMessages(filePath: string): string[] {
  // 同样先应用 rewind：分叉菜单里不该列出已经被「编辑重发」作废的消息
  const lines = applyRewinds(readFileSync(filePath, 'utf8').split(/\r?\n/))
  const out: string[] = []
  for (const line of lines) {
    if (!line.startsWith('{"type":"user"')) continue
    try {
      const record = JSON.parse(line) as { text: string }
      out.push(record.text.replace(/\s+/g, ' ').trim().slice(0, 50))
    } catch {
      // 坏行跳过，不影响其余可选位置
    }
  }
  return out
}

/** 文件名就是 `<uuid>.jsonl`，取 uuid 用来写 sidecar。 */
export function uuidOf(filePath: string): string {
  return basename(filePath, '.jsonl')
}

/** T30：会话库操作撞上「另一个窗口开着它」时的统一说法。 */
function busyLeaseMessage(filePath: string): string {
  return `会话正在另一个 Pneuma 窗口使用，先关掉那边再操作：${basename(filePath)}`
}


/** 记录/读取 last-session 指针（--resume 无参时的目标）。 */
const LAST_FILE = dscPath('.last-session')

export function saveLastSession(session: Session): void {
  mkdirSync(dscPath(), { recursive: true })
  writeFileSync(LAST_FILE, session.filePath, 'utf8')
}

export function loadLastSessionPath(): string | null {
  if (!existsSync(LAST_FILE)) return null
  return readFileSync(LAST_FILE, 'utf8').trim() || null
}
