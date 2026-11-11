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
 *
 * `failed` 与 `aborted` 是两件事：前者是工具真的跑挂了（异常、超时、参数坏掉），要排查；
 * 后者是用户按了停止、或者这一轮被放弃——调用根本没跑完，但不是工具的错，用户不必去查日志。
 */
export type ToolStatus = 'preparing' | 'running' | 'done' | 'failed' | 'aborted' | 'rejected'

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
  /**
   * 这张卡**内部**发生的调用（PTC 的 run_code：一段脚本里调了几次 sdk.xxx()）。
   *
   * 口径对着 dsh 的 run_code 卡：脚本里的调用不各自成为顶层工具行，而是这张卡里的嵌套行；
   * 组头的类别计数也把它们按自己的类别算进去（一段脚本 read+grep+bash 就是读、搜、命令各一次）。
   *
   * 为什么存完整的 ToolCallView 而不是只存名字：每行要画自己的参数摘要与成败状态，
   * 而子调用的这些字段随结果回来会更新（见 adapter 的 tool/result 分支）。
   */
  subCalls?: ToolCallView[]
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
 * - 重放：摘要自己在内存里就是一条 `role: 'user'` 的消息（packages/session-core/compact.ts 造的），
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
  /**
   * usage 是整轮累计口径，见本类型头部的说明。
   *
   * `process` 标的是：「这句正文是同一步里**调工具之前**的那前言」，不是阶段收尾
   * （「安装完成，启动做最后实测：」这种）。判据在 adapter 的 `tool/call` 分支——只有
   * 工具调用真的发出来了，回头看列表尾、把刚定稿的那条正文补上这个标记；模型只写话没
   * 动手的那一步不会有它，那种正文仍然是正文。
   *
   * 为什么要这个标记（2026-11-07 报障）：dsh 的模型把这类话写在 reasoning 通道，屏幕上
   * 是一行「思考 · …」；numa 的模型写在正文通道，不区分就会变成「调一次工具接一段大字
   * 正文」。界面据此把它按过程行画（小字灰行）、留在阶段组里、不封组。
   */
  | {
      kind: 'text'
      id: number
      text: string
      ts?: number
      usage?: { inputTokens: number; outputTokens: number }
      process?: true
    }
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
  | {
      kind: 'model-retry'
      id: number
      /** 第几次重试（1 起；界面上「（3/5）」的分子）。 */
      attempt: number
      /** 这条请求最多重试几次（界面上「3/5」的分母）。 */
      maxRetries: number
      /** 这次重试前等了多久（毫秒，界面上换算成秒）。 */
      delayMs: number
      /** 失败原因原文（HTTP 状态与上游报文）。 */
      text: string
      ts?: number
    }
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
   * 这一轮请求用的系统提示（对照 dsh 的 SystemPromptRow）。
   *
   * 同 hash 的连续几轮**不各占一条**：adapter 遇到同 hash 就原地刷新上一条的 `ts`
   * （见 adapter/transcript.ts 的 `prompt/used` 分支）。所以一个会话里这条卡片的数量
   * 等于「提示词换过几次」，不是「发过几次请求」。
   */
  | { kind: 'system-prompt'; id: number; prompt: SystemPromptView; ts?: number }
  /**
   * 这一轮请求额外注进上下文的东西（对照 dsh 的 ContextInjectionRow）：环境快照、
   * 模式条款、沙箱档位、待办提醒。它们**不是**对话历史（投影注入，不落消息流），
   * 但确实是模型当时看到的内容，单独记一条卡片。
   *
   * 同一轮里的多步工具调用每一步都要重发整份上下文，注入清单因此会重复出现：adapter 在
   * **这一轮**范围内按 `parts` 比对，相同就把那一条的次数 +1，不再叠新卡（跨轮不合并，
   * 下一轮模型看到的是一段新的上下文）。
   *
   * `count` = 这一种注入组合在这一轮里被重发了几次（缺省 1）。它是「同一份清单重复出现」
   * 的现算结果，不是内容的一部分（内容由 `parts` 决定）。但**两处判等对它的口径相反**，
   * 弄反任意一处都会坏掉一个功能：
   *
   * - **重放判等**（`packages/transcript` 的 `sameEntries` / `shape()`）必须剔掉它：实时
   *   按事件累加、重放按日志重新数，同一份清单在日志里只写一条，两边数出来的值可以不同
   *   （实时 6、重开 3）。留着比，每次重开同一条会话都会判「内容变了」，整表重建、条目
   *   id 从头重发，折叠态与直播尾一起被抹掉。
   * - **界面重画判等**（`ui-transcript` 的 `sameRow`，走 `sameContent` 深度比）必须比它：
   *   adapter 在次数 +1 时特意换一个新对象，就是为了让这一行判「变了」重画。剔掉它，
   *   注入卡上的「共 N 步」会冻在第一次的数上不再刷新。
   */
  | { kind: 'context-injection'; id: number; parts: ContextInjectionView[]; count?: number; ts?: number }

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
  /**
   * 干完之后还能不能接着问：`one-shot` 的干完就结束、不接后续消息，卡头标「一次性」。
   * 老快照没有这一项（那时只有一种队友），按可续接处理。
   */
  mode?: 'continuable' | 'one-shot'
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

/**
 * 这一轮请求用的系统提示摘视图。**正文不在这里**，只记「哪一版、多大、由哪些段拼成」。
 *
 * 为什么不记全文（这是本卡片的第一条设计约束）：一份系统提示每代 15–25KB——内核三段、
 * 指令文件（AGENTS.md 有 20k 字符预算）、技能目录都在里面。40 轮就是 800KB，而会话日志
 * 是每开一次会话就要整份重读的。正文本来就按 hash 去重落在 `state('system-prompt')`
 * 条目里（每会话只留最后一版全文，写入处在 packages/session-core/loop.ts 的请求组装段），
 * 卡片要展开全文时去那里取，日志里不再抄一遍。
 */
export interface SystemPromptView {
  /** 正文摘要（sha256 前 16 位），与 state('system-prompt') 的 hash 同一个算法（session-core/prompt.ts 的 promptHash）。 */
  hash: string
  /** 正文字符数（UTF-16 code unit，与指令预算同口径）。 */
  chars: number
  /** 分段清单，按拼装顺序；**正文不在这里**。 */
  sections: PromptSectionView[]
  /** 这一段用的模型名。 */
  model?: string
  /** 正文取不回来（老会话没有 state 记录）→ 卡片不画「展开全文」。 */
  bodyMissing?: boolean
}

/** 系统提示里的一段（只记身份与体量，不记正文）。 */
export interface PromptSectionView {
  /** 段 id：identity / behavior / tool-rules / instructions / skills / preset:persona / mode … */
  id: string
  /** 注册时声明的顺序刻度。 */
  order: number
  chars: number
  /**
   * 来源：内核三段 / 指令文件 / 某个插件登记的段。
   *
   * `plugin:` 后面跟的是**注册 id**（`PromptService.register` 的第一个参数，约定就是
   * 插件名，例如 `plugin:preset:persona`）——注册表里只存得住这个 id，没有单独的
   * 「谁登记的」字段，所以来源就从它来。
   */
  from: 'core' | 'file' | `plugin:${string}`
}

/**
 * 一条上下文注入（投影往请求里塞的内容）：环境快照、模式条款、沙箱档位、待办提醒。
 *
 * 正文同样不整段记：这类内容每轮都重算、常常每轮都变，全文记下来就是每轮一条几千字的
 * 日志。卡片要的是「这轮注入了什么、注入到哪儿、多长」，收起时给 200 字预览够认出来。
 */
export interface ContextInjectionView {
  /** env-facts / mode / sandbox / todo-reminder / repeat-reminder / skill-body / lsp-diagnostics / lifecycle-hooks */
  kind: string
  /** 提供方（投影名 / 环境片段名 / 工具名），用于对账。 */
  source: string
  where: 'system' | 'user-tail'
  chars: number
  /** 前 200 字，够收起时认出来；空串 = 没有正文可给。 */
  preview?: string
}

/**
 * 已知的上下文注入类别（`ContextInjectionView.kind`）。
 *
 * 为什么给一张常量表：卡片按 kind 挑标题与配色，界面层不许写裸字符串。以后加新的注入
 * 类别（技能正文、LSP 诊断……）只要在这里补一行。表外的 kind 仍然允许（字段类型是
 * string）：认不出来的按通用「上下文注入」画，不丢数据。
 *
 * 本批登记这五类——就是本仓现在**真的会注**的那些。技能正文与 LSP 诊断故意
 * 不做：它们命中才发一次，而且已经作为**工具结果**落进了会话日志（工具卡里看得到全文），
 * 再记一张注入卡等于同一份内容记两遍，卡片还会把「模型读了哪些技能」和「模型调了什么
 * 工具」搅成两套账。生命周期钩子的话术同理，走的是 `note` 记录。
 */
export const CONTEXT_INJECTION_KINDS = {
  /** 每轮附在请求末尾的环境快照（日期 / 平台 / 工作目录 / git 状态）。 */
  envFacts: 'env-facts',
  /** 协作模式条款（`registerEnvFacts('mode')`）。 */
  mode: 'mode',
  /** 沙箱档位与可写根（`registerEnvFacts('sandbox')`）。 */
  sandbox: 'sandbox',
  /**
   * 待办节流提醒（每 8 轮一次：同一会话两次提醒至少隔 `everyRounds` 轮，
   * 且清单里还有未完成项、距上次写清单也过了这么多轮才发）。
   */
  todoReminder: 'todo-reminder',
  /** 重复调用提醒（同一工具 + 同一份参数连续第 3/5/8 次才发一条，不否决调用）。 */
  repeatReminder: 'repeat-reminder',
} as const

/** 表里的取值联合；表外的新类别仍然可以直接写字符串。 */
export type ContextInjectionKind = (typeof CONTEXT_INJECTION_KINDS)[keyof typeof CONTEXT_INJECTION_KINDS]

/** 注入预览的字符上限：够在收起态认出「这是哪一段」，又不至于把日志撑大。 */
export const CONTEXT_INJECTION_PREVIEW_CHARS = 200

/** 取一段注入正文的预览（前 200 字）；空白正文给空串，界面据此不画引号。 */
export function contextInjectionPreview(text: string): string {
  return text.trim() === '' ? '' : text.slice(0, CONTEXT_INJECTION_PREVIEW_CHARS)
}

/**
 * 两份注入清单是不是同一份。
 *
 * 判据是逐项浅比较：条目就五个平铺字段（kind / source / where / chars / preview），
 * 没有嵌套结构，序列化后的字符串比较与手写逐字段比较等价，且键序由同一段代码产出、
 * 天然固定。adapter 的去重与 Session 的落盘去重共用这一份判据，两条路径不会漂。
 */
export function sameContextInjections(
  a: readonly ContextInjectionView[],
  b: readonly ContextInjectionView[],
): boolean {
  if (a.length !== b.length) return false
  if (a.length === 0) return true
  return JSON.stringify(a) === JSON.stringify(b)
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

