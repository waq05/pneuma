/**
 * 契约分域：transcript
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/transcript
 */
import type { UserFileAttachment } from '../core/attachments.js'
import type { PlanView } from './task.js'

/**
 * 一次工具调用的展示状态。
 *
 * `preparing` = 模型已经开始吐这个工具的名字、参数还没到齐（对照 dsh 的 `preparing` 阶段）。
 * 那一行不解析参数、不可展开，只是告诉用户「接下来要干这件事」。它随后会被升级成 `running`。
 */
export type ToolStatus = 'preparing' | 'running' | 'done' | 'failed' | 'rejected'

/** 工具卡片视图：参数原文 +（完成后的）结果摘要。 */
export interface ToolCallView {
  callId: string
  name: string
  /** 模型产出的原始 arguments JSON 字符串（截断由 UI 决定）。 */
  argsText: string
  /** 工具结果文本（可能为空：无结果或尚未完成）。 */
  resultText?: string
  status: ToolStatus
  /**
   * 这次调用发起的时刻（epoch ms）：宿主收到 `tool/call` 那一刻。
   *
   * 为什么不复用条目上的 `ts`：`ts` 的口径是「这条条目最后一次被写入的时刻」，
   * 拿到结果时会被刷成结果时刻（见 adapter/transcript.ts 的 `tool/result` 分支），
   * 光凭它算不出这次调用从头到尾花了多久。发起时刻因此单独存一份，只写一次不再改。
   *
   * 为什么是可选的：2026-09 之前的会话日志没记时间，重放老会话时拿不到——
   * 界面据此不显示耗时，绝不拿「现在」冒充历史时刻。
   */
  startedAt?: number
  /**
   * 这次调用从发起到结果回来花掉的毫秒数（结果到达时刻 − `startedAt`）。
   *
   * 口径：`done` / `failed` / `rejected` 一视同仁都算——跑挂了、被审批拒掉、用户中途
   * 打断的工具调用同样占用了这段时间，轨迹页的时间线要如实显示。只有还停在 `running`
   * （结果没回来）时才没有这个数。
   *
   * 为什么是可选的：① 老会话没有 `startedAt`，算不出来；② 日志时间乱序（手改过、
   * 跨机器拷过）导致结果时刻早于发起时刻时也不写——宁可让界面不显示，也不编一个 0 秒。
   */
  durationMs?: number
  /**
   * 这次调用对文件的**实际改动**（write / edit 成功落盘后才有）：与轮尾「文件已更改」
   * 卡同一份数据（`tool/changes` 事件里那个 `change`，形状就是 {@link ChangedFileView}）。
   *
   * 为什么挂到工具卡上：卡上的文件名现在要能点开**这一刀改了什么**的补丁视图
   * （diff-viewer 那条路），而逐刀改动原本只以独立 `changes` 条目存在、与调用对不上号。
   * 这里按 callId 缝回去，工具卡读 `call.change` 即可，不必再去猜条目间的对应关系。
   * 执行失败、或还在跑没有结果时没有这一项。
   */
  change?: ChangedFileView
  /**
   * 这次调用带给界面的**卡片数据**（dsh 插件才有）。
   *
   * dsh 的工具用 presentCall / presentResult 声明怎么画自己的卡（六种：generic /
   * terminal / diff / search / read / web，字段见 `core/dsh-compat/presentation.ts`），
   * 兼容层把产物原样带进来。界面按 `card` 标签挑形态，**认不出来的回落通用工具卡**
   * （数据不丢，只是没画成专用形态）。Pneuma 自己的工具没有这一项。
   */
  presentation?: ToolPresentationView
}

/** 一张卡片视图的界面镜像（字段宽收：认得 `card` 就够挑形态了）。 */
export interface ToolPresentationView {
  /** 调用阶段的卡片。 */
  call?: { card: string } & Record<string, unknown>
  /** 完成阶段的卡片。 */
  result?: { card: string } & Record<string, unknown>
  /** 可重放的展示投影（与值无关的纯数据）。 */
  meta?: unknown
}

/**
 * 压缩落点标记：条目带上它，就说明「从这一刻起，模型看到的历史已经是压缩后的」。
 * 轨迹页据此把压缩历史渲染成独立区段（对照 dsh 的 Between turns），不必去猜正文。
 *
 * `count` = 本会话累计到这一条为止发生过的压缩次数（也就是「第几次压缩」），1 基。
 * 为什么用次数而不是「折进去多少条消息」：实时路径算得出条数，但会话日志里只记了
 * 保留了多少条（见 core/session.ts 的 `replaceWithSummary`，只写 `keep`），重放时
 * 反推不回来——同一个字段两条路径给不出同一个口径，索性不带。
 *
 * 压缩有两个落点，各自留在原本的 kind 上：
 * - 实时：compact 插件经 `dsc/notice(text, 'compaction')` 写下的 **system** 条目；
 * - 重放：摘要自己在内存里就是一条 `role: 'user'` 的消息（core/compact.ts 造的），
 *   正文固定以 `SUMMARY_BANNER` 开头，adapter 靠这个前缀把它认出来，仍是 **user** 条目。
 *   没有换成专属 kind，是因为「对话」页现在把摘要当用户气泡渲染——换 kind 会让摘要
 *   正文当场从对话页和终端界面消失。
 *
 * 老会话（日志里只有那条摘要消息）重放照样认得出，只是日志里只留最后一条摘要
 * （core/session.ts 的 `case 'summary'` 会把更早的记录换掉），所以重放路径的 `count`
 * 永远是 1。
 */
export interface CompactionMark {
  /** 本会话里这是第几次压缩，1 基。 */
  count: number
}

/**
 * 会话流里的一条可渲染条目。adapter 把 session/event 折叠成这个序列，
 * UI 只读消费；`id` 单调递增、仅在本会话生命周期内唯一。
 *
 * 每个条目都可以带 `ts`：毫秒 epoch，含义是「这条条目最后一次被写入的时刻」
 * （用户条目就是发消息那一刻，工具卡是最后一次更新那一刻）。界面按它显示
 * 「这条消息几点发的」「这一轮花了多久」。
 *
 * 为什么是可选的：2026-09 之前的会话日志里没有这个字段，重放老会话时拿不到时间。
 * 那时候界面降级为不显示时间与用时——绝不拿「现在」冒充历史时刻，也不显示 NaN。
 *
 * text / tool 条目还可以带 `usage`：从最近一条 user 条目算起，**这一轮**每一次模型
 * 请求的 prompt_tokens（含系统提示词与全部上下文）与 completion_tokens 全部累加之和。
 * 多步工具轮每次请求都重发整份上下文，所以这个和就是本轮的 API 真实计费量，
 * 而不是按正文字数估出来的。
 * 同一轮里靠前的条目挂的是「到那一刻为止」的累计，界面取轮内最后一条就是整轮真值。
 * 为什么是可选的：① 一次用量事件都没上报过（没有 usage 事件的老会话）时没有这个数；
 * ② 重放历史日志造不出这个数——会话日志只存消息，不存每次请求的用量。
 */
export type TranscriptEntry =
  /**
   * images 是图片引用（`/api/attachments/<sha>`，老会话是 data URL）；界面渲染成缩略图。
   * files 是视频 / 通用文件的落盘元数据；界面画文件卡，模型侧看到的是拼进正文的路径句柄。
   * `compaction` 只出现在重放出来的压缩摘要上（见 {@link CompactionMark}）。
   * `steering` = 这条消息是在助手回合**还没跑完**时插进来的（对照 dsh 的 steering 节点）。
   * `internal` = 这条消息不是人打的字，是运行时投递进来的（目前只有队友干完活的
   * `<teammate-report>` 汇报）。模型照常看得到全文，界面不拿它当用户气泡渲染——
   * 对话页把它画成一行「子任务状态更新」（对照 dsh 的 turn-trigger 节点：
   * TurnTriggerNodeView 默认收起，展开才看得到通知正文）。
   */
  | { kind: 'user'; id: number; text: string; images?: string[]; files?: UserFileAttachment[]; ts?: number; compaction?: CompactionMark; steering?: boolean; internal?: boolean }
  /**
   * durationMs 是这段思考从第一口 reasoning delta 到定稿的耗时（≥1s 界面才显示）。
   * 为什么可选：重放历史日志造不出它（日志只存定稿文本），老会话回看就降级不显示。
   */
  | { kind: 'thinking'; id: number; text: string; ts?: number; durationMs?: number }
  /**
   * 子代理内联卡（实时条目，不落盘）：队友在跑的时候长在转录里，收工折成一行头。
   * 由 subagent 插件把队友的事件流转成 SubagentCardView 推进来（dsc/subagent 事件），
   * 同名原位更新（React key 不换，卡片就地刷新）。
   */
  | { kind: 'subagent'; id: number; sub: SubagentCardView; ts?: number }
  /** usage 是整轮累计口径，见本类型头部的说明。 */
  | { kind: 'text'; id: number; text: string; ts?: number; usage?: { inputTokens: number; outputTokens: number } }
  /** usage 同上（一轮以工具结果收尾、没有最终正文时，数字落在这张卡上）。 */
  | { kind: 'tool'; id: number; call: ToolCallView; ts?: number; usage?: { inputTokens: number; outputTokens: number } }
  /** 计划卡：exit_plan_mode 交上来的计划，带用户批没批。 */
  | { kind: 'plan'; id: number; plan: PlanView; ts?: number }
  /**
   * `compaction` 只出现在压缩插件写下的那条通知上（见 {@link CompactionMark}）。
   *
   * `level: 'error'` 表示这条是**要人处理**的启动/运行问题（没有可用的模型端点、插件加载失败），
   * 界面把它从首屏的注脚里摘出来、改成一次弹窗；缺省（连同 `'info'`）只进日志与轨迹，不占首屏。
   */
  | {
      kind: 'system'
      id: number
      text: string
      ts?: number
      compaction?: CompactionMark
      level?: 'info' | 'error'
      /**
       * 来自输入框 `/` 命令的输出（`/help`、`/status`…）。
       *
       * 为什么要这个位：壳的「空会话欢迎态」会把首屏的 system 条目整批不画
       * （只留写前预览卡），于是新会话里打第一条命令什么也看不到（2026-10-27 查账）。
       * 命令输出属于用户主动要的东西，必须上屏；启动机位那种通知仍保持安静。
       */
      command?: boolean
    }
  /** 轮尾标记：这一轮为什么结束，见 {@link TurnEndReason}。 */
  | { kind: 'turn-end'; id: number; reason: TurnEndReason; ts?: number }
  /** 这一轮的输出撞上了长度上限（对照 dsh 的 `turn-max-tokens` 节点）。 */
  | { kind: 'turn-max-tokens'; id: number; ts?: number }
  /**
   * 模型这次请求失败、正在重试（对照 dsh 的 `model-retry` 节点）。
   *
   * 它是二级分组的**边界**（前后两段过程被它切开），但**不属于**整轮折叠要放过的那些
   * 独立节点——dsh 的规矩是「二级分组把模型重试视为分隔节点，但整轮折叠仍包含重试行」。
   */
  | { kind: 'model-retry'; id: number; attempt: number; text: string; ts?: number }
  /**
   * 一次成功的 write / edit 落盘后的实际改动（对照 dsh deliverables 的 produced 文件）。
   * 界面把同一轮里的这些条目聚合成轮尾一张「文件已更改」卡；`hunks` 是算好的
   * unified 差异段（结构见 {@link DiffHunkView}），审查面板直接渲染。
   */
  | { kind: 'changes'; id: number; file: ChangedFileView; ts?: number }
  /**
   * 回合收尾的聚合改动（codex `turn/diff/updated` 的同位条目）：本回合动过的每个文件
   * 一份「回合基线 vs 盘上终态」的差异，同文件多刀合一。纯内存条目——不落 jsonl，
   * 重启恢复后界面回退逐刀合并显示（`kind: 'changes'` 照常重放）。
   */
  | { kind: 'turnDiff'; id: number; files: ChangedFileView[]; ts?: number }

/**
 * 一轮对话为什么结束（口径就是宿主 `turn/end` 事件的 reason，见 core/events.ts）。
 *
 * 为什么要有它：dsh 的整轮折叠有一条规矩——**中断或失败的轮不折整轮**，开关行还要把
 * 「已停止 / 过程失败」显示出来（`contract/turn-process.ts` 的 `turnProcessAlwaysOpen`
 * 与 `chat/TurnProcessNodeView.tsx:26-28`）。dsc 的宿主一直知道这个原因，只是 adapter
 * 从事件折条目时把它丢了，于是界面上「跑挂了的一轮」和「好好答完的一轮」长得一模一样。
 */
export type TurnEndReason = 'completed' | 'aborted' | 'error'

/**
 * 子代理内联卡的数据（dsh SubagentMessage 同位物）：头行「状态点 + 任务 + 轮数/工具数/
 * 耗时/token + 状态词」，跑动时再加当前工具行与输出瀑布。数据是插件侧的实时快照，
 * 每次事件整体替换。
 */
export interface SubagentCardView {
  /** 队友名（同会话内唯一，卡片按它原位更新）。 */
  name: string
  /** 角色名（工牌冻结的那份）。 */
  role: string
  /** 派给它的任务原文（界面自己截断）。 */
  task: string
  /** 运行状态；`idle` = 正常收工，`stopped` = 被打断，`failed` = 过程失败。 */
  state: 'working' | 'idle' | 'failed' | 'stopped'
  /** 用的模型（`端点/模型`；跟随主会话模型时填当时的模型）。 */
  model?: string
  /** 已发起的模型请求轮数。 */
  rounds: number
  /** 已执行的工具调用次数。 */
  toolCalls: number
  /** 开工时刻（毫秒 epoch；名册种子卡才有，实时转发必有）。 */
  startedAt?: number
  /** 收工时刻；还在跑就没有。 */
  finishedAt?: number
  /** 当前（或最后一把）工具：跑动时画「当前工具行」。 */
  lastTool?: { name: string; args: string; status: 'running' | 'done' | 'failed' }
  /** 输出瀑布的行池（最新在后；界面只取最后几行，每行硬截单行宽）。 */
  outputLines?: string[]
  /** 累计 token（输入+输出，端点真值；一次都没回过用量时缺省）。 */
  tokens?: number
  /** 过程失败的原因（state=failed 时界面画一条错误行）。 */
  error?: string
  /** 队友会话的 jsonl 路径（点卡片开只读转录浮层）。 */
  file?: string
}

/** context 条按内容类型的分段（token 估算值，只描述占用段的颜色组成）。 */
export interface ContextSegmentsView {
  system: number
  prompt: number
  assistant: number
  thinking: number
  /** 工具**结果**（tool 消息正文）。 */
  tools: number
  /** 工具**定义**（每次请求携带的 schema 文本）。老宿主不推这一项，界面按 0 处理。 */
  schema?: number
}

/** 差异里的一行（与 core/diff-text.ts 的 DiffLine 同构，视图层零宿主依赖）。 */
export interface DiffLineView {
  kind: 'context' | 'remove' | 'add'
  text: string
  /** 这一行在旧文件里的行号；`add` 行为 null。 */
  oldLine: number | null
  /** 这一行在新文件里的行号；`remove` 行为 null。 */
  newLine: number | null
}

/** 一段 hunk：`@@ -oldStart,oldCount +newStart,newCount @@` 加上它包含的行（同构 DiffHunk）。 */
export interface DiffHunkView {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLineView[]
}

/** 一次成功的 write / edit 的实际改动（轮尾「文件已更改」卡与审查面板的数据）。 */
export interface ChangedFileView {
  /** 文件的绝对路径（打开预览用）。 */
  path: string
  /** 新增行数。 */
  added: number
  /** 删除行数。 */
  removed: number
  /** 算好的 unified 差异段；审查面板直接渲染，不再碰文件系统。 */
  hunks: DiffHunkView[]
  /** true = hunks 超过行数上限被砍过（面板据此提示「只显示前一部分」）。 */
  truncated?: boolean
  /** `added` = 新建文件（改前不存在）；`modified` = 改已有文件。 */
  status: 'added' | 'modified'
}

