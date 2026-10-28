/**
 * 契约分域：approval
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/approval
 */
import type { ApprovalPolicy, ApprovalReviewer, CollaborationMode } from './mode.js'
import type { DiffHunkView } from './transcript.js'

/**
 * 审批卡内嵌的「将做的改动」（codex 审批弹窗内嵌 diff 的同位能力）：宿主在弹卡前
 * 读盘上现值、按工具语义推演出这次 write / edit 将产生的差异。
 * 算不出来（非 write/edit、参数不齐）时整个字段缺省。
 */
export interface ApprovalDiffView {
  /** 目标绝对路径。 */
  path: string
  added: number
  removed: number
  /** 推演出的差异段（与 ChangedFileView.hunks 同一形状，审批卡直接渲染）。 */
  hunks: DiffHunkView[]
  /** true = hunks 超行数预算被砍过尾。 */
  truncated?: boolean
  /** `added` = 新建文件（改前不存在 / 从空串起算）；`modified` = 改已有文件。 */
  status: 'added' | 'modified'
  /** true = 盘上现值没读到（工作区外 / 文件还不存在），差异是从参数推算的。 */
  fellBack?: boolean
  /** 仅 edit：old 在盘上匹配不到 / 匹配多处——照参数执行会失败，卡片要提示。 */
  mismatch?: 'missing' | 'ambiguous'
}

/**
 * 模型这次在请求「放宽沙箱」（工具参数里带了成对的 sandbox_permissions + justification）。
 * 卡片上要摊开说清批的是什么——不然「这次允许」批下去的是一句看不懂的话。
 */
export interface ApprovalEscalationView {
  /** 请求放宽到哪一档。 */
  permission: 'workspace-write' | 'danger-full-access'
  /** 模型填的持续意图（once / session）；真正生效的授权档位永远是用户在卡上点的那个。 */
  scope: 'once' | 'session'
  /** 为什么必须写到范围之外（模型给的一句话）。 */
  justification: string
  /** 这一档的人话说明（「留在沙箱内，只放宽这一次的写边界」这类）。 */
  effect: string
}

/** 待用户决定的工具审批请求（视图投影）。 */
export interface ApprovalRequestView {
  /** adapter 内部关联 id；answerApproval 不需要它（同一时刻至多一个挂起审批）。 */
  id: string
  toolName: string
  /**
   * 参数摘要（单行、已截断、已遮红）。
   *
   * 命令类工具给的是**命令原文**，不是 JSON：`{"command":"…"}` 这层壳只增加噪音，
   * 而卡上那一行本来就要给人读。
   */
  argsSummary: string
  /**
   * 这次调用「要干什么」的中文一句话（0.7.1）：命令类解读命令，写类说清动哪个文件。
   * 卡片把它画在工具名下面——不用读命令行，也知道点「允许」是放行什么。缺省 = 认不出来。
   */
  meaning?: string
  /** 为什么要问：命中的危险模式或规则，中文一句话。 */
  reason: string
  /** 风险档位：critical 表示只有它不会被任何自动档带走。 */
  risk: 'low' | 'medium' | 'high' | 'critical'
  /** 「永久允许」将往 `~/.dsc/policy.rules` 写的前缀；null = 这个动作不许持久化。 */
  suggestedRule: string[] | null
  /** true = 命中硬地板，界面不该给出任何放行按钮。 */
  hardline: boolean
  /** 这张卡允许哪些授权档位（危险动作会把 always 摘掉）。 */
  scopes: Array<'once' | 'session' | 'always'>
  /** 当前权限模式、审阅者与协作模式（卡片上说明现在是哪一档、谁来审）。 */
  policy: ApprovalPolicy
  reviewer: ApprovalReviewer
  mode: CollaborationMode
  /** 发起审批的会话 jsonl 路径（0.6.49）：后台会话的卡弹到当前视图时，界面据此标注「来自哪个会话」。 */
  sessionPath?: string
  /** write / edit 的「将做的改动」；其他工具或推演不出时缺省。 */
  diff?: ApprovalDiffView
  /** 模型这次在请求放宽沙箱；没请求时缺省（卡片上就不画那一段）。 */
  escalation?: ApprovalEscalationView
}

/**
 * 审批应答。
 *   allow-once    只放过这一次；
 *   allow-session 同一会话内同类动作不再问（按会话 id 键控，切会话失效）；
 *   allow-always  往 `~/.dsc/policy.rules` 追加一条前缀规则（危险动作不给这个选项）；
 *   reject        拒。
 */
export type ApprovalAnswer = 'allow-once' | 'allow-session' | 'allow-always' | 'reject'

