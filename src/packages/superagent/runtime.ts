/**
 * 运行期装配：把存储、仓储、领域核心、适配器接成一个能用的 `Engine`。
 *
 * 这一层是「插件入口（`index.ts`）」与「领域核心（`core/`）」之间唯一的中转：
 * 上面只看到 `publish` / `list` / `pump` / `close` 四个动作，下面全是核心的端口
 * 实现。把它单列一个文件，是为了让命令、泵、将来的界面快照共用同一个引擎实例，
 * 而不是各自 `new Engine(...)` 一 Assembly——两套引擎会各持一份队列与仓位。
 *
 * 库与锁不在这里建：`DscStore` 由调用方打开并负责关闭（`close()` 的注释里写明）。
 * 这样「谁开的谁关」只有一条规则，测试也能把整个 runtime 指到临时目录。
 *
 * @module dsc/packages/superagent/runtime
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@pneuma/runtime/core/session.js'
import type { SuperagentSettingsChangeView, SuperagentSurface } from '@pneuma/runtime/contract.js'
import { Engine, followupOwners, latestAssignment, latestReport, liveTicket, threadKey, ticketStage,
  type AssessmentOutcome, type ChannelRef, type Decision, type DomainEvent, type Executor, type OutboundMessage, type Outcome,
  type Reply, type ReplyRequest, type SourceScope, type Thread, type ThreadRef, type Ticket, type TicketInput, type TicketStage,
  type Trigger, type WorkerReport } from './core/index.js'
import { policyVersion, settingsPolicy, type RoleModel, type Settings } from './core/policy.js'
import { selectAssessor, type SuperagentAssessor } from './adapters/assessor-select.js'
import type { AssessorComplete, HeldCandidate } from './adapters/assessor-model.js'
import type { GithubApi } from './adapters/github/api.js'
import { claimPull } from './adapters/github/bind.js'
import { readPull } from './adapters/github/pull.js'
import { readThreadWindow, type ThreadWindow } from './adapters/github/read.js'
import { OutboxDispatcher, type MessageSender } from './adapters/dispatch.js'
import { EffectQueue } from './adapters/effects.js'
import type { FeishuThreads } from './adapters/feishu/loops.js'
import { POLL_HORIZON_MS } from './adapters/feishu/loops.js'
import { WorkerExecutor, loadPromptVolumes, worktreeNameOf, type UnattendedMode, type WorkerModel } from './adapters/executor.js'
import { answerTrigger, manualScope, manualTrigger, type ManualRequest } from './adapters/manual.js'
import { StoreNotifier, type RecentNotice } from './adapters/notify.js'
import { StoreOutbox } from './adapters/outbox.js'
import { StoreRepositories } from './adapters/repositories.js'
import { defaultSettings, GITHUB_SOURCE } from './adapters/settings.js'
import type { DscStore, CandidateRecord } from './adapters/store.js'
import { removeWorktree, worktreePathOf } from './adapters/worktree.js'
import { promptsDir, sessionsDir } from './paths.js'
import { buildSurface } from './surface.js'

/** 命令层要的一行工单：只给列表要用的四样，别把整个 Ticket 聚合摊出去。 */
export interface TicketView {
  id: string
  title: string
  /** 状态档位，由 `core/stage.ts` 的 `ticketStage` 判定。 */
  stage: TicketStage
  createdAt: string
  /**
   * 最近一份 worker 报告的摘要（它说干了什么）。
   *
   * 加在视图上而不是让界面去读库：界面面 `SuperagentSurface.tickets[].summary` 就是它；
   * 命令层（`commands.ts`）不读这一项，多一个可选字段不影响它。
   */
  summary?: string
  /**
   * 工单等人回答的那个问题原话（`Ticket.attention.question`）。
   *
   * 为什么要在视图里给：工单停在「等你回答」时，界面会给一个回话输入框；框上面不写
   * 在问什么，用户就是在盲回。摘要说的是「干到哪了」，不能代替问题本身。
   */
  question?: string
}

/** 日志出口；默认丢弃，测试与 `index.ts` 传宿主控制台。 */
export type RuntimeLog = (line: string) => void

/**
 * 一次启动恢复的结论：两类「上次没收尾」的工单各处理了几张。
 *
 * 只回 id 不回工单对象：调用方（`index.ts` 与测试）要的是「有没有动过、动了哪几张」，
 * 把整张工单摊出去只会让人以为恢复还负责别的。
 */
export interface RecoveryReport {
  /** 上次崩在 `running`、进程里又没有 worker，本次起新分配接续的工单。 */
  resumed: string[]
  /** 上次停在 `pending`、本次重新入队派工的工单。 */
  requeued: string[]
}

/** 一次保留策略扫描的结论。 */
export interface SweepReport {
  /** 会话目录被删掉的工单（已结束超过保留期）。 */
  removed: string[]
  /** 已结束超过保留期、但会话目录本来就不在的工单。 */
  missing: string[]
}

/**
 * 已结束工单的会话目录保留天数。
 *
 * 为什么只删会话、不删工作树：工作树里是没合并的提交，删了就找不回来；那是 `/sa clean`
 * 的活，且要由人确认。会话目录只是 worker 的对话记录，过了 30 天没人再读它。
 */
export const SESSION_RETENTION_DAYS = 30

/** 保留期的毫秒数。 */
const SESSION_RETENTION_MS = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000

/**
 * 恢复通知的落点。
 *
 * 与 `adapters/notify.ts` 的 `NOTICE_CHANNEL` 同形：`manual` 是「没有真实会话」的占位，
 * 这句话只进「最近动态」，下一拍由发送泵取出来给界面看（`dispatch.ts` 里 `manual` 一律不发送）。
 * 不 import 那个常量：它在适配层内部，导出它等于把「通知发到哪」变成跨层契约。
 */
const RECOVERY_CHANNEL: ChannelRef = { source: 'manual', thread: 'manual:notice', address: {} }

/** 执行器设置：仓库根走 getter（设置页改了下一张工单就用新值），其余是启动期的旋钮。 */
export interface WorkerRuntimeOptions {
  /** 仓库根；空 = 派工记失败并说明「没配仓库」。 */
  repo?: () => string
  /** 并发上限，缺省 2。 */
  maxWorkers?: number
  /**
   * 工作区准备命令的 getter；空串 = 不跑。
   *
   * 走 getter 而不是值：设置页改完，下一张工单就用新命令，不必重开宿主。
   */
  prepare?: () => string
  /** worker 的模型路由；缺省跟随当前选路。 */
  model?: WorkerModel | null
  /**
   * worker 额外禁用的命令名单；缺省没有额外禁令。
   *
   * 只进系统提示词的「可用命令」一句（`adapters/executor.ts` 的 `taskTextOf`），
   * 不是强制拦截——上游的 worker-bin shim 强制层在 DSC 没有对应物。
   */
  blockedCommands?: readonly string[]
  /** 无人值守审批档，缺省 `deny`。 */
  unattended?: UnattendedMode
  /** 工作树起点 ref；缺省 HEAD。 */
  base?: string
  /** 工作树根；缺省 `<DSC_HOME>/superagent/worktrees`。 */
  root?: string
}

/**
 * 设置分区的一个字段，投影给主会话工具看。
 *
 * 为什么值与声明要合成一条：工具得「先看现场再改」，`superagent_read` 的 settings 资源
 * 与 `superagent_settings_save` 的 key 校验读的是同一份；分两次问就多一条会漂移的口径。
 */
export interface SettingsFieldView {
  /** 设置分区里的键（与 `SettingsSectionSpec` 字段的 key 同名）。 */
  key: string
  /** 控件标题：模型据此看懂这一项管什么。 */
  label: string
  /** 值类型：text → 字符串，number → 数字，boolean → 布尔，list → 字符串数组。 */
  type: string
  /** 当前值（现读设置分区，不是构造时的快照）。 */
  value: unknown
  /** 控件下面那句说明（下拉字段会把可选值拼在末尾）。 */
  help?: string
}

/** 线程上的一条消息：工具侧只读得到这三样（候选现场与 worker 读上下文共用）。 */
export interface CandidateMessageView {
  /** 消息正文。 */
  text: string
  /** 说话人（来源自己的身份串，如 GitHub 登录名 / 飞书 open_id）。 */
  actor: string
  /** 发生时刻（ISO）。 */
  at: string
}

/**
 * 一条候选的现场：候选本身 + 触发它的那条消息 + 它线程上最近的消息。
 *
 * 为什么在运行期就装配好：候选记录只存了 trigger id 与线程键，消息正文与线程上下文只有
 * 运行期能按库查（`trigger` / `trigger_thread` 两张表的读法在仓储层）。工具拿到的是一份
 * 自足的现场，不必认识仓储，也就不用为它开一条读库的路。
 */
export interface CandidateContextView {
  /** 候选 id（就是 Eval 的 id）。 */
  id: string
  /** 触发它的那条消息 id。 */
  triggerId: string
  /** pending = 等人拍板；accepted / ignored = 已经有结论。 */
  state: 'pending' | 'accepted' | 'ignored'
  /** 判定出来的时间（ISO）。 */
  at: string
  /** 卡片标题（判定模型给的）。 */
  title: string
  /** 为什么判成可以接。 */
  reason: string
  /** 工单范围。 */
  scope: string
  /** 来源（`github` / `feishu` / `manual`）。 */
  source: string
  /** 触发它的那条消息。 */
  trigger: CandidateMessageView
  /** 它所在线程上的消息，按时间升序（旧 → 新），最多最近 {@link CANDIDATE_THREAD_LIMIT} 条。 */
  thread: CandidateMessageView[]
}

/**
 * worker 读上下文的 `ticket` 资源：这张工单本身 + 它的输入清单。
 *
 * 为什么正文取起始 Trigger、输入再单列一份：worker 的系统提示词里只有工单标题与正文
 * （`prompts/shared.md` 的 `<工单>` 段），它看不到「这张单后来还收到了什么」；而含糊的需求
 * 往往要靠后面那几条才看得懂。这里给的是**摘要**，完整原文走 `input:<id>`。
 */
export interface WorkerTicketContextView {
  /** 工单 id（与输入 id 一起构成「读自己这张单」的范围）。 */
  id: string
  /** 工单标题。 */
  title: string
  /** 建单时刻（ISO）。 */
  createdAt: string
  /** 人写的要求原文：起始 Trigger 的正文。 */
  body: string
  /** 输入清单（最近的 {@link WORKER_TICKET_INPUT_LIMIT} 条，旧的在前），每条带来源、时间、正文摘要。 */
  inputs: WorkerTicketInputView[]
  /** 输入总条数；比 {@link WorkerTicketContextView.inputs} 长时说明清单被截过。 */
  inputTotal: number
}

/** `ticket` 资源里的一条输入摘要。 */
export interface WorkerTicketInputView {
  /** 输入 id（`input:<id>` 资源用的就是它）。 */
  id: string
  /** 来源：`github` / `feishu` / `manual`，或 `main`（主会话写的）/ `system`（工单内部事件）/ `policy`。 */
  source: string
  /** 进工单的时刻（ISO）。 */
  at: string
  /** 正文摘要；超过上限就截断并注明总字数。 */
  text: string
}

/**
 * worker 读上下文的 `thread` 资源：这张工单所在线程的一页消息。
 *
 * 为什么一页一页给：一条长话题可能有上百条评论，一次全塞进上下文会把模型正在做的事挤没；
 * 分页让模型按需继续读，`next_offset` 与主会话的 `superagent_read` 同一语义。
 */
export interface WorkerThreadContextView {
  /** 线程键（`github:<number>` / `feishu:<chat>:<root>`）；工单没有可读线程时是空串。 */
  thread: string
  /** 这一页的起点（从 0 开始）。 */
  offset: number
  /** 这一页最多几条。 */
  limit: number
  /** 这条线程上的消息总数。 */
  total: number
  /** 这一页的消息，旧 → 新。 */
  messages: CandidateMessageView[]
  /** 还有下一页时给下一页的 `offset`；没有就不带这一项（带 null 会让模型以为有个 null 号）。 */
  next_offset?: number
}

/** worker 读上下文的 `input:<id>` 资源：一条输入的完整原文。 */
export interface WorkerInputContextView {
  /** 输入 id。 */
  id: string
  /** 来源（与 {@link WorkerTicketInputView.source} 同一口径）。 */
  source: string
  /** 进工单的时刻（ISO）。 */
  at: string
  /** 完整原文（不截断）。 */
  text: string
}

/** 可注入项：时钟、日志、宿主上下文与执行器设置。 */
export interface RuntimeOptions {
  /** 当前时刻，`Date#toISOString` 形式；核心不读环境时钟。 */
  now?: () => string
  log?: RuntimeLog
  /**
   * 可见面变了：让快照失效（宿主那边通常发 `dsc/changed`）。
   *
   * 为什么由外面注入而不是运行期自己发：`ctx` 是可选的（测试里没有宿主），而且
   * 「快照失效」是宿主侧的词汇——运行期只该说「有东西变了」，怎么通知界面不归它管。
   * 主会话工具（`main-tools.ts`）改完工单后走的就是这一条。
   */
  changed?: () => void
  /**
   * cordis 上下文。给了才可能真正派工：执行器从它取模型 / 工具 / 守卫 / 沙箱 / 压缩。
   * 不给 = 「未接宿主」模式，`start` 只记日志、工单停在待派工（绝不假装起成功）。
   */
  ctx?: Context
  /** 执行器设置（仓库、并发、模型、审批档、工作树起点）。 */
  worker?: WorkerRuntimeOptions
  /**
   * 单工单超时秒数（getter，每拍现读设置）；`<= 0` 或没给 = 不限。
   *
   * 为什么是 getter 而不是数字：设置页改完要立刻按新上限判，不必重启宿主。
   */
  timeoutSeconds?: () => number
  /**
   * 换掉执行器（测试用）。
   *
   * 端口只有 `start` / `deliver` / `stop` 三个动作（`core/ports.ts:59`），所以假执行器
   * 记下调用就够了，不必起真 worker。不给就用 {@link WorkerExecutor}。
   */
  executor?: Executor
  /**
   * 把 worker 会话登记进内核会话表（`ctx.agent.attach` / `detach`）。
   *
   * 为什么运行期要透传而不是执行器直接取 `ctx.agent`：执行器拿的是 `Context | null`
   * （测试可以没有上下文），而 `attach` 只在装配处知道有没有 agent 服务。不接时
   * 一切照旧，只是 `subagent` 认不出 worker 是父会话（见 `WorkerExecutorOptions`）。
   */
  attachSession?: (session: Session) => void
  /** 摘掉 {@link attachSession} 的登记。 */
  detachSession?: (sessionId: string) => void
  /**
   * 设置来源（getter，每取一次策略现读）。
   *
   * 为什么要注入而不是在这里 `defaultSettings()`：准入名单是设置项（GitHub 那条尤其——
   * 「谁 @ 一下能派活」），构造时算死就变成「改了设置必须重启宿主」，而且这种失败没有
   * 任何提示，症状是「轮询在跑、就是没有工单」。不注入 = 只有手动来源的一份默认设置。
   */
  settings?: () => Settings
  /** 来源范围；不注入 = 只认手动来源（`adapters/manual.ts:77`）。 */
  scope?: SourceScope
  /**
   * 判定用的模型；不给或 `null` = 不调模型（`core/policy.ts:98` 的默认形态）。
   *
   * 给了它还得给 {@link RuntimeOptions.assessorComplete} 才会真的走模型版：模型名只是一份
   * 配置，能不能发请求取决于宿主有没有把模型服务接进来。
   */
  assessorModel?: RoleModel | null
  /** 一次问答；不给 = 就算配了模型也退回同步规则（见 `adapters/assessor-select.ts`）。 */
  assessorComplete?: AssessorComplete
  /**
   * 推断候选要不要先等人点头（backlog G1）。
   *
   * true = 判定器判成可以接的推断候选先落进候选收件箱，人在界面上点「接单」才建工单；
   * false（缺省）= 判定即接单，与上游一致。
   *
   * 只在 `eval.mode = 'auto'` 时看得出区别：`observe` 模式下引擎本来就不让推断候选
   * 接单（`core/policy.ts` 的 `admitsInferred` 要求 auto 且命中规则），那种候选连
   * 收件箱都进不去，判定器会按「模式不允许」记一条失败。
   */
  confirmInferred?: boolean
  /**
   * 出站消息的发送方，按 `channel.source` 查（`feishu` / `github`）。
   *
   * 是 getter 而不是一张现成的表：两个来源都在运行期建好之后才起来，构造时算死等于
   * 「来源起来之前排队的那条回复永远发不出去」。不给 = 一条都不发，只进最近动态
   * （P0 的行为，也是没配飞书 / 没令牌时的行为）。
   */
  senders?: () => Partial<Record<string, MessageSender>>
  /**
   * GitHub 来源的 API 客户端；不给 = 判定器拿不到线程上下文（不影响判定本身）。
   *
   * 为什么是 getter：GitHub 来源在运行期建好之后才起来（它要拿运行期的 `sourceBridge`），
   * 令牌与仓库还在设置里；构造时算死就永远是 `null`。为什么由外面给而不是运行期自己建：
   * 令牌从哪个环境变量读只有 `index.ts` 的设置分区知道，运行期再读一遍就是两套配置来源。
   */
  githubApi?: () => GithubApi | null
  /**
   * 机器人身份（GitHub 登录名 + `owner/name`）；不配 = 认领 PR 直接拒。
   *
   * 为什么要单独给：`GithubApi` 的窄接口只露了 `repository`（`adapters/github/api.ts:81-97`），
   * 登录名不在里面；而 `Settings` 里也没有它（`defaultSettings` 只把仓库 / 名单写进策略，
   * 机器人登录名只留在装配处的配置闭包里）。认领 PR 要靠 `agentPull` 判「这张 PR 是不是
   * 机器人自己开的」，少一半判不了，所以由装配处把同一个账户 getter 递进来。
   */
  githubAccount?: () => { login: string; repository: string } | undefined
  /**
   * 设置分区当前的字段与值（`superagent_read` 的 settings 资源、`superagent_settings_save` 用）。
   *
   * 为什么由装配层注入：设置分区对象只有 `index.ts` 拿得到（`createSettingsSection` 的
   * 返回值）。运行期若自己再建一份字段声明，就会与设置页出现两套字段 / 两套保存语义，
   * 迟早一边改了另一边没改。
   */
  settingsView?: () => SettingsFieldView[]
  /**
   * 调设置分区自己的 save（与设置面板同一个函数；返回字符串 = 被拒原因）。
   *
   * 为什么不在这里直接写 `plugins.json`：那会绕过这个分区的校验（枚举、上下限、路径格式）
   * 与设置变更历史，等于同一个设置有了两条写路径。
   */
  saveSetting?: (key: string, value: unknown) => string | void
}

/**
 * 来源适配器能用的三个动作。
 *
 * 故意只露这三个：`receive` 交一条 Trigger、`bindThread` 让工单关注一张 PR、`threadClosed`
 * 报线程关闭。评估、派工、改设置都不在里面——来源是「把外面的事变成 Trigger」的角色，
 * 看见得越多，越容易绕过准入闸自己建单。
 *
 * 类型在本文件定义而不是从某个来源适配器 import：这样一边加来源，运行期不用跟着改。
 */
export interface SourceBridge {
  receive(trigger: Trigger): unknown
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): unknown
  /** `outcome` 用来源自己的两个词（`merged` / `closed`），`at` 缺省由运行期补当前时刻。 */
  threadClosed(thread: ThreadRef, outcome?: 'merged' | 'closed', at?: string): unknown
}

/**
 * 主会话的十二个工具能对 Super Agent 做的二十件事（`main-tools.ts` 的依赖面）。
 *
 * 为什么只露这二十件：工具是模型直接调的入口，最容易越权。`engine`、执行器、库都在
 * 运行期里，露出去等于把「谁能不能改工单」的判定交给工具自己——那套判定在 `core/`，
 * 这里只把八个引擎方法原样转一手，再加十二个运行期才知道的东西：
 *   - `snapshot()`：读面。工具读的是「人能看见的那一面」，不另开一条读库的路。
 *   - `isWorkerSession()`：这条会话是不是某个 worker 的。主会话工具在 worker 里不该能用。
 *   - `changed()`：改完了，让快照失效。
 *   - `followupOwners()`：这条消息还归哪些工单的执行者决定。要拿仓储才能算
 *     （`core/model.ts:75`），所以由运行期代算，工具只收工单 id 清单。
 *   - `prompts()`：提示词两卷当前读到哪一版（覆盖 / 内置 / 兜底）。文件坐标在运行期
 *     （`paths.ts`），工具只该拿到内容与来源。
 *   - `savePrompt()`：把一卷提示词写成覆盖文件。校验（角色、字数）在工具层，这里只写盘。
 *   - `settings()` / `saveSetting()`（P7）：设置分区的字段、当前值与它自己的 save。
 *     分区对象只有装配层拿得到，运行期只做转交，不另建一份字段声明。
 *   - `candidates()` / `acceptCandidate()` / `ignoreCandidate()` / `confirmingInferred()`
 *     （P7）：候选现场与拍板。候选记录只存 trigger id 与线程键，消息正文与线程上下文
 *     要由运行期按库补（`trigger_thread`），所以现场在运行期装配，工具只负责挑那一条。
 *
 * 类型都取占位核心现成的（`core/index.js` / 契约），不在这里另造一套：多一套同形类型，
 * 核心改字段时这边不会报错，只会静静错位。
 */
export interface SuperagentCommandHost {
  /** 一条 Trigger 的判定；`accept` / `stop` / `ignore` 三种都走这里（准入与决策历史归核心）。 */
  decide(triggerId: string, outcome: Outcome): Decision
  /** 把一条 Trigger 挂到已有工单上，`note` 是给执行者的背景。 */
  attach(ticketId: string, triggerId: string, note?: string): Ticket
  /** 替工单排一条出站消息；入队后立刻催一拍泵。 */
  reply(request: ReplyRequest): Reply
  /** 请一张空闲工单的执行者报状态；`false` = 它没在等，什么都没发。 */
  requestStatus(ticketId: string): boolean
  /** 把一条事实记给工单的执行者。 */
  note(ticketId: string, text: string): Ticket
  /** 重试一张失败 / 卡住的工单：卡住的那份分配结束、起新的。 */
  retryTicket(ticketId: string): Ticket
  /** 这条 Trigger 还归哪些工单的执行者决定（工单 id 清单；空 = 不归任何工单）。 */
  followupOwners(triggerId: string): string[]
  /** 把一条 Trigger 重新排队判定；`false` = 已经有判定在跑。 */
  reevaluate(triggerId: string): boolean
  /** 掉掉一条线程上所有工单的订阅；`false` = 本来就没订。 */
  unsubscribe(thread: string): boolean
  /** 当前快照面（与界面拉到的是同一份装配）。 */
  snapshot(): SuperagentSurface
  /**
   * 提示词两卷的当前内容与来源（`superagent_read` 的 prompts 资源读它）。
   *
   * 为什么每次都现读盘：主会话存过覆盖文件之后，这里要立刻能读到新内容——缓存了就成了
   * 「保存成功、读回来还是旧的」。两卷都带上全文（模板原文，占位符没替换），模型照着改才有意义。
   */
  prompts(): { roles: { role: 'shared' | 'worker'; source: 'override' | 'default' | 'fallback'; text: string }[] }
  /**
   * 把一卷提示词存成覆盖文件（`<promptsDir>/<role>.md`，目录不存在就建）。
   *
   * 校验（role 认识、text 非空且不超上限）在工具层：这里拿到的已经是该写的内容。
   * 写盘失败直接往上抛，由工具翻成一句人话（比如「目录不可写」）。
   */
  savePrompt(role: 'shared' | 'worker', text: string): { role: 'shared' | 'worker'; path: string }
  /**
   * 设置分区的字段与当前值（`superagent_read` 的 settings 资源、save 工具的 key 校验读它）。
   *
   * 为什么值与声明一次给全：工具要「先看现场再改」；分两次问，字段清单与当前值就可能来自
   * 两个时刻，模型会照着一份过期的值改。
   */
  settings(): SettingsFieldView[]
  /**
   * 调设置分区自己的 `save`（与设置面板同一个函数）；返回字符串 = 被拒原因。
   *
   * 为什么不在这里直接落盘：写了会绕过这个分区的校验（枚举 / 上下限 / 路径格式）与设置
   * 变更历史，同一个设置就有了两条写路径。
   */
  saveSetting(key: string, value: unknown): string | void
  /**
   * 等人拍板的候选现场：候选 + 触发消息 + 线程最近消息（时间升序）。
   *
   * `candidate:<id>` 资源与 `superagent_eval` 读同一份装配；工具只负责按 id / trigger 挑。
   */
  candidates(): CandidateContextView[]
  /** 接一条候选，返回建出来的工单 id；`title` 覆盖判定时的标题（与面板接单同一个口子）。 */
  acceptCandidate(id: string, title?: string): string
  /** 忽略一条候选；`reason` 记进决策历史（不给人看原文也留个交代）。 */
  ignoreCandidate(id: string, reason?: string): void
  /** 候选收件箱开没开：关着时推断候选直接接单，没有可拍板的东西。 */
  confirmingInferred(): boolean
  /** 这条会话是不是某个 worker 的（主会话工具据此拒绝 worker 调用）。 */
  isWorkerSession(sessionId: string): boolean
  /** 通知快照失效（界面据此重画）。 */
  changed(): void
}

/**
 * worker 会话的端口：五个协作动作 + 第七批的 `report` / `claimPull` + 第八批的 `context`
 * 的唯一依赖（前五个从上游搬来，保护仓 `src/app/tools/executor.ts:13-21`）。
 *
 * 为什么每个动作都先收 `sessionId`：工具只拿得到 `ToolContext`，模型不知道工单 id
 * （那是执行器的内部账）；运行期在这里按会话反查出 `ticketId`，工具那一层不碰执行器。
 *
 * 为什么不是抛错而是 `false`：这条会话本来就可能不是 worker（用户在普通会话里调到了这些
 * 工具）。「找不到」是正常情况，翻译成一句人话该由工具层做，而不是让引擎深处抛一个模型
 * 看不懂的异常。几处 `false` 的含义各不相同，见各方法：
 *   - `followForContext` / `handback` 的 `false` 是语义（本来就在跟 / 没交回）；
 *   - 其余动作的 `false` = 会话不是 worker。
 * 工具在拿端口之前已经用 `host(sessionId)` 判过一次身份（`index.ts`），所以走正常路径时
 * 语义 `false` 不会被误当成身份问题；端口自己仍然对陌生会话返回 `false`，防越权调用。
 */
export interface SuperagentWorkerCommandHost {
  /** 先回执再动大手术：把一条回执排到人的原始消息所在的渠道。会话不是 worker 的 → false。 */
  ack(sessionId: string, triggerId: string, text: string): boolean
  /** 掉掉一条与工单无关的线程订阅；工单自己的线程引擎会拒（`UserError`）。会话不是 worker 的 → false。 */
  markUnrelated(sessionId: string, thread: string, reason: string): boolean
  /** 跟一条相关线程只为上下文；`false` = 这条线程本来就在跟。 */
  followForContext(sessionId: string, thread: string): boolean
  /** 把一条不属于本工单的消息交回去重新判定；`false` = 另一张工单还在决定它，或本来就不归它。 */
  handback(sessionId: string, triggerId: string, reason: string): boolean
  /** 交一份状态报告；`false` = 会话不是 worker（与执行器的 `reportBySession` 同口径）。 */
  report(sessionId: string, report: WorkerReport): boolean
  /**
   * 认领一张 PR：报告带 `pr_number` 时先绑线程，再写报告（上游 `orchestrator_report` 的顺序）。
   *
   * @returns 拒绝原因（一句人话，说清为什么不行、该传什么）；成功 / 本来就绑着 → undefined
   */
  claimPull(sessionId: string, number: number): Promise<string | undefined>
  /**
   * 读这张工单的上下文（工具已确认会话属于 worker）；返回 null = 工单不存在或不归这个会话。
   *
   * 三种 resource 各回一种形状（{@link WorkerTicketContextView} / {@link WorkerThreadContextView} /
   * {@link WorkerInputContextView}）；返回 `unknown` 而不是联合类型，是因为这一层只负责装配与
   * 分页，文本化归工具（`tools.ts` 的 `contextTool`）。
   *
   * `input:<id>` 不属于这张工单时同样返回 null：工具据此说「这条输入不属于这张工单」。
   * 这里不回「你越权了 / 它属于别家」这种话——那等于确认了别的工单存在。
   *
   * @param resource - `ticket` / `thread` / `input:<id>`（工具已校验形状）
   * @param offset - `thread` 的起点；其余 resource 忽略
   * @param limit - `thread` 一页最多几条；其余 resource 忽略
   */
  context(sessionId: string, resource: string, offset: number, limit: number): unknown
  /** 通知快照失效（线程订阅 / 报告变了，界面据此重画）。 */
  changed(): void
}

/**
 * 执行器可选的只读反查：这条会话是不是它自己的 worker 的。
 *
 * 为什么不写进 `Executor` 端口（`core/ports.ts`）：那是核心契约，塞一个 DSC 专用方法进去
 * 就要动 `core/`。这里按结构探一次方法，执行器实现了就用，没实现（测试里的假执行器、
 * 将来换的实现）就当「不是 worker」——主会话工具宁可多放一次调用过去，也不该把主会话
 * 误判成 worker 而封掉。
 */
interface SessionOwner {
  ownsSession(sessionId: string): boolean
}

/**
 * 执行器可选的只读反查：这条会话属于哪张工单的哪个分配。
 *
 * worker 工具要往引擎写东西，光知道「是不是 worker」不够，还要 ticketId；这张表是执行器的
 * 私有账（`this.workers` / `this.retiring`），运行期按结构探一次，不把手伸进执行器。
 * 判据与 {@link SessionOwner} 是同一张表：执行器的 `workerOf` 就是 `ownsSession` 的唯一实现。
 */
interface SessionWorker {
  workerOf(sessionId: string): { ticketId: string; assignmentId: string } | null
}

/** 把未知异常压成一行可读文本，日志用。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 历史值 → 显示形态：数组拼逗号分隔（与设置面 `values()` 同一口径），其余 `String()`。 */
function shownValue(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value)
}

/**
 * 一段正文的摘要：超过上限就截断，并注明原来共有多少字。
 *
 * 为什么注明总字数：模型据此知道「这里被截过」，要读完整原文就去取 `input:<id>`；
 * 只留一个省略号的话，它会以为那条消息本来就这么短。
 */
function clipText(text: string, limit: number): string {
  const chars = [...text]
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')}…（共 ${String(chars.length)} 字）`
}

/** GitHub 线程键的前缀。与 `github/trigger.ts:39` 的 `${SOURCE}:${number}` 同一处拼法。 */
const GITHUB_THREAD_PREFIX = `${GITHUB_SOURCE}:`

/**
 * 线程键 `github:<number>` 里的那个编号；不是本来源、或者解析不出正整数（`github:ci:main`）
 * 时给 `undefined`。
 *
 * 为什么在运行期就丢掉解析不出的键：默认分支的 CI 线程没有 Issue / PR 可读
 * （上游 `github.ts:441-442` 在来源里跳过它），而本接口只交编号，`github:ci:main` 交过去
 * 只能变成 `issues/NaN/comments` 这种请求。丢在知道「这是 CI 线程」的这一侧，比让来源猜单号干净。
 */
function githubNumber(thread: string): number | undefined {
  if (!thread.startsWith(GITHUB_THREAD_PREFIX)) return undefined
  const number = Number(thread.slice(GITHUB_THREAD_PREFIX.length))
  return Number.isInteger(number) && number > 0 ? number : undefined
}

/**
 * 一次判定的线程窗口最多读几页评论。上游缺省是 10 页（`deployment.ts:19`），这里照抄。
 *
 * 每页 100 条，10 页 = 1000 条；再长的线程里触发消息本来就找不到了，多读的只是配额。
 */
const THREAD_CONTEXT_MAX_PAGES = 10

/** 窗口里普通消息保留的字符数（上游 `WINDOW_CHARS`，`app/assessment.ts:37`）。 */
const THREAD_WINDOW_CHARS = 400

/** 触发消息近邻保留的字符数（上游 `NEAR_CHARS`）：前后两条往往就是「在回谁」的答案。 */
const THREAD_NEAR_CHARS = 1200

/**
 * 读上下文的硬上限：15 秒（上游 `admissionContextTimeoutMs` 的默认值）。
 *
 * 为什么必须有：判定器是**同步等**这份上下文的，而 GitHub 的 api 自带 30 秒请求超时、
 * 最多读 10 页——最坏情况 300 秒，早把 Eval 的截止时间压穿了。上游也是 15 秒上限。
 * 超时不取消在途请求（那要改 api 签名），只是不再等它：判定按「没有上下文」继续。
 */
const THREAD_CONTEXT_TIMEOUT_MS = 15_000

/**
 * 候选现场里线程消息最多给几条（新的那几条）。
 *
 * 为什么给上限：主会话读候选是为了拍板，不是通读整条线程；上游 `orchestrator_eval` 也只
 * 给一段窗口。10 条足够看清「在回谁、上下文是什么」，又不会把一张卡片撑成全屏。
 */
const CANDIDATE_THREAD_LIMIT = 10

/**
 * worker 读 `ticket` 时输入清单最多给几条（最近的那几条，按旧 → 新排）。
 *
 * 为什么是 10：worker 真正要补的是「最近这轮说了什么」，条目再多它也不读；而每条还带摘要，
 * 数量不压住就会把工单原文挤出上下文。完整原文由 `input:<id>` 按需取。
 */
const WORKER_TICKET_INPUT_LIMIT = 10

/** 输入摘要保留的字符数：与线程窗口同一档（400 字），够看清在说什么，又不至于一条占满一页。 */
const WORKER_INPUT_SUMMARY_CHARS = 400

/**
 * worker 读 `thread` 时一页最多几条。
 *
 * 工具层也校验同一个上限（`tools.ts` 的 `CONTEXT_MAX_LIMIT`）：工具管「模型能不能这么问」，
 * 这里兜「别的调用方会不会塞一个更大的数进来」。两处同值时以工具那层的说法为准。
 */
const WORKER_THREAD_MAX = 50

/**
 * 把窗口渲染成提示词里的一段可读文本。
 *
 * 为什么要限长：一条评论最长 65k 字，11 条拼起来会把 800 token 的判定回复挤没。上游同样
 * 按 400 / 1200 字截断（`app/assessment.ts:198-202`），这里照抄那两档。
 *
 * 为什么触发消息本身不重复正文：提示词上面「正文」一节已经给了一次；重复只会让模型以为
 * 有两份不同的需求，还白花 token。上游也是用 `trigger: true` 标记而不重复（`assessment.ts:200`）。
 *
 * 触发消息不在窗口里时（行内 review 评论不在这份会话列表里），标题直说「没找到」：
 * 让模型知道上下文可能缺了它所在的那一段，而不是把「最早的 5 条」当成完整前后文。
 */
export function renderThreadContext(window: ThreadWindow, sourceId: string): string {
  const trigger = window.messages.findIndex((message) => message.id === sourceId)
  const omittedBefore = window.messages.reduce((sum, message) => sum + message.omittedBefore, 0)
  const header = window.sourceFound
    ? `对话上下文（本线程共 ${String(window.loaded)} 条，省略前 ${String(omittedBefore)} 条、后 ${String(window.omittedAfter)} 条）：`
    : `对话上下文（本线程共 ${String(window.loaded)} 条，没找到这条消息，以下只列最早的几条）：`
  const center = trigger >= 0 ? window.messages[trigger]!.position : -1
  const lines = window.messages.map((message, index) => {
    const who = `${message.at === '' ? '时刻未知' : message.at} ${message.author}${message.bot ? '（机器人）' : ''}`
    if (index === trigger) return `- ${who}：（这条就是上面的请求正文）`
    const limit = Math.abs(message.position - center) <= 2 ? THREAD_NEAR_CHARS : THREAD_WINDOW_CHARS
    const text = message.text.length > limit
      ? `${message.text.slice(0, limit)}…（共 ${String(message.text.length)} 字）`
      : message.text
    return `- ${who}：${text}`
  })
  return [header, ...lines].join('\n')
}

/**
 * 一条领域事件指向的工单 id。
 *
 * 只有一部分事件带 `ticketId`（`DomainEvent` 的联合类型，见 `core/ports.ts:86-103`）；
 * `trigger.received`、`eval.started`、`decision.recorded` 这些发生在工单存在之前，
 * 没有可指向的工单。`event` 表的主键要求先有工单行（`DscStore.appendEvent` 会先
 * `readTicket`），所以这类事件只能记日志，硬写只会让接单事务回滚。
 */
function ticketIdOf(event: DomainEvent): string | undefined {
  const data = event.data as Record<string, unknown>
  const value = data.ticketId
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 一条线程「最近有动静」的时刻，用来挑人回话该回到哪条线程。
 *
 * 还没收到过消息的线程没有 `lastAt`（模型里它是可选的），退回创建时刻——否则一张工单
 * 订阅着两条线程时，「哪条最新」会因为一条 `undefined` 而随机摇摆。
 */
function threadRecency(thread: Thread): string {
  return thread.lastAt ?? thread.createdAt
}

/**
 * 一个已经装好的 Super Agent 运行期。
 *
 * 构造不会启动任何后台任务：泵由 `index.ts` 起，命令由 `commands.ts` 注册。
 * 这样「建库失败」只影响构造这一个点，不会顺带拖起半套定时器。
 */
export class SuperagentRuntime {
  private readonly store: DscStore
  private readonly log: RuntimeLog
  /** 时钟；`publish` 造 Trigger 时要用，核心那边也拿同一个。 */
  private readonly clock: () => string
  private readonly repos: StoreRepositories
  private readonly assessor: SuperagentAssessor
  private readonly engine: Engine
  /**
   * 持久化副作用队列：派工与输入投递都先落 `effect` 表，再由它的 handler 执行。
   *
   * 由运行期持有（不是执行器）：`pump` 每拍催它一次、`close` 要 drain 它，两者的生命周期
   * 比执行器长；执行器只拿到同一个实例去登记 handler。
   */
  private readonly effects: EffectQueue
  /**
   * 执行器：`stop` 真停 worker、`retry` 重新派工要用；默认是 {@link WorkerExecutor}。
   *
   * 类型上多挂一个可选的 `prepare`：建单的 `prepareTicket` 钩子要它（见构造器里那段注释）。
   * 注入的假执行器没有这个能力时钩子原样退回工单，接单照常。
   */
  private readonly executor: Executor & Partial<Pick<WorkerExecutor, 'prepare'>>
  /** 结果通知：工单结束时入队一句话，并留一份内存里的最近动态。 */
  private readonly notify: StoreNotifier
  /** 发送泵：把出站队列里的消息真正送到飞书 / GitHub。 */
  private readonly dispatch: OutboxDispatcher
  /** 仓库根的 getter，与执行器同一个来源；`clean` 要拿它算工作树在哪个仓库下。 */
  private readonly repoOf: () => string
  /** 工作树根（设置里给过就用它），`clean` 要按它重算目录。 */
  private readonly worktreeRoot: string | undefined
  /** 设置与 Policy 在 P0 是只读的：进程内没有改设置的入口，缓一份就够。 */
  private readonly settingsOf: () => Settings
  /** 来源范围：准入闸拿它判「这条消息这个来源收不收」（`core/policy.ts:186-187`）。 */
  private readonly scope: SourceScope
  /** GitHub 来源的 API 客户端 getter；来源没起来时是 `null`（见 `RuntimeOptions.githubApi`）。 */
  private readonly githubApi: () => GithubApi | null
  /** 机器人身份 getter；认领 PR 判「机器人自己开的」要用（见 `RuntimeOptions.githubAccount`）。 */
  private readonly githubAccount: () => { login: string; repository: string } | undefined
  /** 上一次算出来的策略，连同算它用的设置版本戳；版本没变就复用。 */
  private policyCache: { stamp: string; policy: ReturnType<typeof settingsPolicy> } | null = null
  /** 单工单超时（秒）的 getter；每拍现读，设置页改完下一拍就按新上限判。 */
  private readonly timeoutOf: () => number
  /**
   * 推断候选要不要先等人点头（backlog G1）。
   *
   * 装配时读一次：它是「判定器要不要挂起」的开关，判定器在构造时就定了形状。
   * 改它要重开宿主——与判定模型同一条取舍。
   */
  private readonly confirmInferred: boolean
  /**
   * 出站队列。恢复通知也从这里入队（`recover()`），与核心的回复共用同一个幂等口径：
   * 同一个 id 第二次 `send` 不会再写一行。
   */
  private readonly outbox: StoreOutbox
  /** 可见面变了时的出口；没注入 = 没人关心（测试与未接宿主的模式）。 */
  private readonly onChanged: () => void
  /** 设置分区的字段与当前值（装配层注入）；没接 = 空表，settings 资源会如实说没有字段。 */
  private readonly settingsViewOf: () => SettingsFieldView[]
  /** 设置分区的保存（与面板同一个口子）；没接 = 一律拒绝保存，不静默成功。 */
  private readonly saveSettingOf: (key: string, value: unknown) => string | void
  private closed = false

  constructor(store: DscStore, options: RuntimeOptions = {}) {
    const now = options.now ?? (() => new Date().toISOString())
    this.store = store
    this.log = options.log ?? (() => {})
    this.onChanged = options.changed ?? (() => {})
    // 设置分区只有装配层拿得到：没注入时给空表 / 明确拒绝，比建一份假分区诚实。
    this.settingsViewOf = options.settingsView ?? (() => [])
    this.saveSettingOf = options.saveSetting ?? (() => '设置分区没接上，不能保存')
    this.clock = now
    // 复用 `DscStore` 的那条连接（`store.handle`）：再开一条会冒出第二个 WAL 写者，
    // 而且两条连接各自开的事务互不可见，`atomic` 的边界就不成立了。
    this.repos = new StoreRepositories(store.handle)
    // 策略与来源范围要先于判定器就位：判定器每次判定都现读设置（规则表改了立刻生效）。
    this.policyCache = null
    this.settingsOf = options.settings ?? (() => defaultSettings())
    this.scope = options.scope ?? manualScope
    this.githubApi = options.githubApi ?? (() => null)
    this.githubAccount = options.githubAccount ?? (() => undefined)
    // 配了模型且宿主给了模型出口才用模型版；否则是 P0 那套同步规则（`assessor-select.ts`）。
    // `context` 走运行期自己的 `threadContext`：判定器只拿到「一条 Trigger → 一段文本」的函数，
    // 它不需要知道 GitHub 的编号、令牌与分页都在运行期这一侧。
    this.assessor = selectAssessor({
      model: options.assessorModel ?? null,
      settings: this.settingsOf,
      context: (trigger) => this.threadContext(trigger),
      ...(options.assessorComplete === undefined ? {} : { complete: options.assessorComplete }),
      onError: (error, evalId) => this.log(`[superagent] 判定 ${evalId} 失败：${describe(error)}`),
      log: (line) => this.log(line),
      // 推断候选的落点（backlog G1）：开了「先确认」就落进候选收件箱等人点头，
      // 否则判定即接单（与上游一致）。明确请求永远不走这条路。
      ...(options.confirmInferred === true
        ? {
            holdCandidate: (hold: HeldCandidate) => {
              this.store.saveCandidate(hold.evalId, hold.triggerId, hold.threadKey, {
                outcome: hold.outcome,
                title: hold.title,
                reason: hold.reason,
                scope: hold.scope,
                source: hold.source,
              })
              this.log(`[superagent] 候选 ${hold.evalId}（${hold.source}）等人确认：${hold.title}`)
            },
          }
        : {}),
    })
    this.notify = new StoreNotifier(store)
    this.timeoutOf = options.timeoutSeconds ?? (() => 0)
    this.confirmInferred = options.confirmInferred === true
    this.outbox = new StoreOutbox(store)
    // 发送泵：一拍取一批、逐条发、失败的原样写回队列（规则见 `adapters/dispatch.ts`）。
    // `senders` 是 getter：两个来源都在运行期之后才建好，构造时算死会漏掉「起来之前排队的回复」。
    this.dispatch = new OutboxDispatcher({
      store,
      senders: options.senders ?? (() => ({})),
      remember: (fresh) => { this.notify.remember(fresh) },
      now,
      log: (line) => { this.log(line) },
    })
    // 执行器的入口：宿主上下文（模型 / 工具 / 守卫 / 沙箱 / 压缩）+ 设置。
    // 没给 `ctx` 时执行器停在「未接宿主」模式（`start` 只记一条缺项日志、工单留待派工）。
    // `engine` 用 getter 晚绑定：引擎的构造需要执行器，执行器的报告又要引擎。
    const worker = options.worker
    this.repoOf = worker?.repo ?? (() => '')
    this.worktreeRoot = worker?.root?.trim() || undefined
    // 队列先于执行器建：执行器的构造函数要往它上面登记 launch / delivery 两个 handler。
    // 这里不给 health：doctor 是拉取式接口（`HealthCheck.run`），与队列期望的
    // `claim(kind).set(entry)` 推拉方向相反；适配该在装配处做，而 `index.ts` 这一轮不在可改范围。
    this.effects = new EffectQueue(store)
    this.executor = options.executor ?? new WorkerExecutor(options.ctx ?? null, {
      repo: this.repoOf,
      maxWorkers: worker?.maxWorkers,
      prepare: worker?.prepare,
      model: worker?.model ?? null,
      blockedCommands: worker?.blockedCommands,
      unattended: worker?.unattended,
      base: worker?.base,
      root: this.worktreeRoot,
      log: (line) => { this.log(line) },
      engine: () => this.engine,
      effects: this.effects,
      // 派工 handler 要重读工单（文件头「重读，不用快照」）：仓储与运行期共用同一条连接，
      // 读到的就是引擎刚提交的那一版，不是 `start` 那一刻的快照。
      readTicket: (ticketId) => this.repos.tickets.get(ticketId),
      readTriggerText: (triggerId) => this.repos.triggers.get(triggerId)?.text,
      ...(options.attachSession === undefined ? {} : { attachSession: options.attachSession }),
      ...(options.detachSession === undefined ? {} : { detachSession: options.detachSession }),
    })
    this.engine = new Engine({
      repo: this.repos,
      policy: () => this.currentPolicy(),
      scope: this.scope,
      assessor: this.assessor,
      executor: this.executor,
      outbox: this.outbox,
      now,
      emit: (event) => { this.record(event) },
      // 建单那一刻把 `execution`（工作树名 / 目录）写上：不接这个钩子，`Ticket.execution`
      // 永远是 undefined，`route` 的 `worktree_name` 等于白写，`ticketBranch` 也永远对不上
      // 分支名（「机器人开的 PR」自动绑定因此一条都绑不上）。
      // 用箭头函数读 `this.executor`，不在对象字面量里提前解构：执行器确实先建好了，
      // 但这个字段将来若被替换（测试 / 热换），箭头读到的仍是当前那一个。
      prepareTicket: (ticket, outcome) => this.executor.prepare?.(ticket, outcome) ?? ticket,
    })
    // 装配完成后才允许派工：`start()` 之前的行只躺在库里（与上游 `runtime.ts:216` 同一位置）。
    this.effects.start()
  }

  /**
   * 当前策略。
   *
   * 为什么每次现读：准入名单、接单模式、暂停开关都是设置项，构造时算死等于「改了要重启」。
   * 为什么不每次都重算：`settingsPolicy` 每次都会造一套闭包，而它每拍、每条 Trigger 都要被
   * 问一次；用版本戳缓存，设置没动就复用同一份。
   *
   * 版本戳用核心的 `policyVersion`（规则 + 接单模式 + 来源名单，`core/policy.ts:128`），
   * 另外补上 `paused` 与研判超时——这两样同样进 `Policy`，却不在那份版本里。
   *
   * **已知边界**：这里换了策略不会给在途工单补一条 `policyChanged`（核心的授权重算入口），
   * 所以「把某人从名单里删掉」只影响之后进来的消息，不会让已开的那张单当场失效。
   */
  private currentPolicy(): ReturnType<typeof settingsPolicy> {
    const settings = this.settingsOf()
    const stamp = `${policyVersion(settings)}|${String(settings.paused)}|${String(settings.eval.timeoutSeconds)}`
    if (this.policyCache !== null && this.policyCache.stamp === stamp) return this.policyCache.policy
    const policy = settingsPolicy(settings, this.scope)
    this.policyCache = { stamp, policy }
    return policy
  }

  /**
   * 开着的工单原文。
   *
   * 给来源适配器用：GitHub 的 PR CI 轮询要知道「哪些 PR 该看」，而这件事只有工单自己知道
   * （`Ticket.follows` 记着它关注的 PR）。只读、只露开着的——已结束的工单没人再关心 CI。
   */
  openTickets(): Ticket[] {
    this.assertOpen()
    return this.repos.tickets.open()
  }

  /**
   * 还开着的工单订阅的 GitHub 线程，只用编号与「是不是 PR」两样（上游 `github.ts:430-459`
   * 的 `pollThreads` 需要的那张清单）。
   *
   * 为什么由运行期算而不是来源自己扫：来源只拿到一个仓库的客户端，「哪张工单还跟着哪个
   * PR / Issue」只有工单的 `follows` 记着（`core/model.ts:314`）；来源要是自己去读话题表，
   * 就变成「订阅了哪些话题」这件事有两个主。
   *
   * 只认 `github:<number>` 形状的线程键：本来源的线程键就是「来源名 + 编号」
   * （`github/trigger.ts:39`、`github/bind.ts:82`），编号解析不出来的（`github:ci:main` 这类
   * 默认分支 CI 线程）在这一步丢掉，理由见 {@link githubNumber}。
   *
   * **`isPr` 的取法**：`Follow` 里没有这个字段（`core/model.ts:314` 只有 `thread` / `own` /
   * `closed`，它记的是「跟没跟、关没关」，不是「这是什么」），所以只能看话题。话题上的
   * `meta` 是模型给来源放原生属性的那一格（`core/model.ts:177-181`），先读 `meta.isPr`。
   * 但 DSC 里只有飞书来源会写它（`feishuThreads().patch`），GitHub 来源没有 `threads.patch`
   * 出口（`github/source.ts:22-26` 的「没搬的三段」），所以真查起来 `meta.isPr` 常常是
   * `undefined`。退路取同一条话题上**最新一条 Trigger 的 `meta.isPr`**：那个字段由 GitHub
   * 来源自己写（`github/trigger.ts:164/192/203`），准入与观察也按它判，是线程身份的事实来源。
   * 两条都没有时按 Issue 处理——Issue 的会话评论接口对 PR 返回的也是同一批会话评论，漏的只是
   * 行内 review 与 review 结论；反过来把 Issue 当 PR 去读 `pulls/<n>/comments` 会拿不到，
   * 还可能整个请求 404、让这一拍白失败。
   *
   * 同一张 PR 被多张工单跟着只回一条：一张 PR 每拍读一次评论就够，重复读只会白发请求。
   */
  subscribedThreads(): { number: number; isPr: boolean }[] {
    this.assertOpen()
    // Map 同时做去重与「任一工单认定是 PR 就算 PR」的合并。
    const threads = new Map<number, boolean>()
    for (const ticket of this.repos.tickets.open()) {
      for (const follow of ticket.follows ?? []) {
        const number = githubNumber(follow.thread)
        if (number === undefined) continue
        threads.set(number, threads.get(number) === true || this.threadIsPull(follow.thread))
      }
    }
    return [...threads].map(([number, isPr]) => ({ number, isPr }))
  }

  /** 一条 GitHub 话题是不是 PR：先看话题属性，再看话题上最新一条 Trigger 的 `meta.isPr`（理由见 `subscribedThreads`）。 */
  private threadIsPull(thread: string): boolean {
    const meta = this.repos.threads.get(thread)?.meta
    if (typeof meta?.['isPr'] === 'boolean') return meta['isPr']
    return this.repos.triggers.latestOn(thread)?.meta['isPr'] === true
  }

  /**
   * 一条 Trigger 的线程上下文，渲染成提示词里的一节（backlog S1，对齐上游 `admissionContext`
   * 与 `githubThreadContext`）。
   *
   * 只对 GitHub 生效：飞书来源有自己的读法，判定器目前也只给 GitHub 的候选补上下文；别的来源
   * 一律 `undefined`，提示词里就不会多出「上下文」那一节。
   *
   * 取编号只认 `trigger.meta.number`（`github/trigger.ts:163/192/203/255` 都写它）：默认分支 CI
   * 的 Trigger 没有编号（`github:ci:main`），没有对话可读，直接 `undefined`。
   *
   * **失败只记日志、返回 `undefined`**：读上下文是判定的**加分项**。GitHub 抖一下、令牌过期、
   * 行内 review 读不到根评论——这些都不该让一条本来能判的请求变成「判定器不可用」，否则一次
   * 网络抽风就会把请求推给超时重排。
   *
   * 行内 review 评论不在会话窗口里（见 `readThreadWindow` 的注释）：那时 `sourceFound` 为
   * false，渲染出的标题会说明「没找到这条消息」，模型据此知道上下文不完整。
   */
  async threadContext(trigger: Trigger): Promise<string | undefined> {
    if (trigger.source !== GITHUB_SOURCE) return undefined
    const number = Number(trigger.meta.number)
    if (!Number.isInteger(number) || number <= 0) return undefined
    const api = this.githubApi()
    if (api === null) return undefined
    const commentId = trigger.meta.commentId
    // 触发消息的 id 与会话消息的 id 同形（网页地址）；没有网页地址时退回评论数字 id。
    const messageId = trigger.url ?? (typeof commentId === 'number' ? String(commentId) : '')
    try {
      // 超时用 race 而不是 AbortSignal：`readThreadWindow` 不收 signal，加一个要改它的签名与
      // 整个 api 层。判定器只需要「别无限等」，不需要真的把请求掐掉。
      const window = await Promise.race([
        readThreadWindow(api, number, messageId, THREAD_CONTEXT_MAX_PAGES),
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), THREAD_CONTEXT_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      if (window === null) {
        this.log(
          `[superagent] 触发器 ${trigger.id} 的对话上下文读超时（${String(THREAD_CONTEXT_TIMEOUT_MS / 1000)} 秒，按没有上下文判定）`,
        )
        return undefined
      }
      if (window.messages.length === 0) return undefined
      return renderThreadContext(window, messageId)
    } catch (error) {
      this.log(`[superagent] 触发器 ${trigger.id} 的对话上下文没读到（按没有上下文判定）：${describe(error)}`)
      return undefined
    }
  }

  /**
   * 给来源适配器用的三个动作。
   *
   * 每次返回新对象：来源只该拿到这三个函数。把运行期本身交出去，来源就能绕过准入闸自己
   * `publish`，那套「谁的需求能被接单」的判定等于没有。
   */
  sourceBridge(): SourceBridge {
    return {
      receive: (trigger) => this.engine.receive(trigger),
      bindThread: (ticketId, thread, own) => this.engine.bindThread(ticketId, thread, own),
      threadClosed: (thread, outcome, at) => this.engine.threadClosed(thread, outcome ?? 'closed', at ?? this.clock()),
    }
  }

  /**
   * 主会话工具用的窄端口（`main-tools.ts` 的唯一依赖）。
   *
   * 为什么返回新对象而不把 `engine` 交出去：工具只需要八个动作 + 十二个运行期自己的查询；
   * 拿到引擎就等于拿到「随便读哪条 Trigger、随便改哪张工单」的全部权限。与
   * `sourceBridge()` 同一个理由：谁拿到什么，是一条安全边界，不是风格问题。
   *
   * 每次调用都新建一个对象：成本可以忽略（一天几十次），换来「这个对象随时能用」。
   *
   * @throws 运行期已关闭时抛错（关闭后的写没有意义，早报比在核心深处报好查）
   */
  commands(): SuperagentCommandHost {
    this.assertOpen()
    return {
      decide: (triggerId, outcome) => this.engine.decide(triggerId, outcome),
      attach: (ticketId, triggerId, note) => this.engine.attach(ticketId, triggerId, note),
      reply: (request) => {
        const reply = this.engine.reply(request)
        // 回复只是入队，真正发出去要泵：这里立刻催一拍，免得白等 2 秒的定时器。
        // 催失败不影响「已经排上队」这个事实（下一拍照旧会取它），只记一行日志。
        try {
          this.pump()
        } catch (error) {
          this.log(`[superagent] 回复 ${reply.id} 已入队，但催泵失败：${describe(error)}`)
        }
        // 状态在发出去之前只可能是 `pending`：发送是一次网络往返，等不到就如实报。
        return { ...reply, status: this.outbox.status(reply.id) ?? reply.status }
      },
      requestStatus: (ticketId) => this.engine.requestStatus(ticketId),
      note: (ticketId, text) => this.engine.note(ticketId, text),
      // 工具这一侧与上游一致，只调引擎：`retryTicket` 的事务里已经把新分配交给执行器了
      // （`core/tickets.ts:178`）。运行期 `retry()` 那次再叫 `executor.start` 是命令层的
      // 幂等补刀（见它的注释），不是「起新分配」的另一半，这里不重复。
      retryTicket: (ticketId) => this.engine.retryTicket(ticketId),
      // 归属不是引擎方法：拿运行期手里的仓储算一次核心的 `followupOwners`。工具只该知道
      // 「还归哪几张工单」，不该拿到仓储（拿到就能绕过准入闸读遍全库）。
      followupOwners: (triggerId) => {
        const trigger = this.repos.triggers.get(triggerId)
        return trigger === undefined ? [] : followupOwners(trigger, this.repos)
      },
      reevaluate: (triggerId) => this.engine.reevaluate(triggerId),
      unsubscribe: (thread) => this.engine.unsubscribe(thread),
      // 提示词两卷：读工具要看到「现在生效的是哪一版、来源是什么」。走 `loadPromptVolumes`
      // 而不是自己拼路径，读法与 `buildWorkerPrompt` 才是同一个优先级（覆盖 → 内置 → 兜底）。
      prompts: () => {
        const volumes = loadPromptVolumes()
        return {
          roles: [volumes.shared, volumes.worker].map((volume) => ({
            role: volume.role,
            source: volume.source,
            text: volume.text,
          })),
        }
      },
      // 写覆盖文件。目录不存在就建（第一次保存时 `<DSC_HOME>/superagent/prompts` 通常还没有）；
      // 文件名就是卷名，与 `loadPromptVolumes` 找覆盖文件的约定一致。
      savePrompt: (role, text) => {
        const path = join(promptsDir(), `${role}.md`)
        mkdirSync(promptsDir(), { recursive: true })
        writeFileSync(path, text, 'utf8')
        return { role, path }
      },
      // 设置三件（P7）：字段 / 值由装配层注入，这里只转交。保存走分区自己的 save，
      // 与设置面板同一条路（校验、写盘、变更历史都不缺）。
      settings: () => this.settingsViewOf(),
      saveSetting: (key, value) => this.saveSettingOf(key, value),
      // 候选四件（P7）：现场（候选 + 触发 + 线程）由运行期装配；接单 / 忽略薄转调现有的
      // 运行期方法，与面板按钮同一个口子——判定结果的原文从库里取，不由工具转手。
      candidates: () => this.candidateContexts(),
      acceptCandidate: (id, title) => this.acceptCandidate(id, title),
      ignoreCandidate: (id, reason) => this.ignoreCandidate(id, reason),
      confirmingInferred: () => this.confirmingInferred(),
      snapshot: () => buildSurface(this),
      isWorkerSession: (sessionId) => this.workerOwns(sessionId),
      changed: () => { this.onChanged() },
    }
  }

  /**
   * 一条会话是不是某个 worker 的。
   *
   * 判据在执行器里（`adapters/executor.ts` 的 `ownsSession`）：worker 表是它的私有账，
   * 运行期不伸手进去读。执行器没有这个方法时（测试里的假执行器、将来换的实现）按
   * 「不是 worker 会话」处理——主会话工具宁可多让一次调用过去，也不该把主会话误判成
   * worker 而封掉。
   *
   * 为什么不拿 `reportBySession(sessionId, …)` 当探针：那会真往工单里写一条报告，
   * 探一下就把状态改了。
   */
  private workerOwns(sessionId: string): boolean {
    const owns = (this.executor as Partial<SessionOwner>).ownsSession
    return typeof owns === 'function' && owns.call(this.executor, sessionId)
  }

  /**
   * 按会话反查「它属于哪张工单的哪个 worker」（第三批的 worker 工具用）。
   *
   * 与 {@link workerOwns} 同一条判据——执行器里 `ownsSession` 就是 `workerOf(...) !== null`
   * （见 `adapters/executor.ts`），这里只是把 ticketId 一起带回来。注入的假执行器没有这个
   * 能力时按「不是 worker」处理，工具据此报「不在 worker 会话里」。
   */
  private workerOf(sessionId: string): { ticketId: string; assignmentId: string } | null {
    const locate = (this.executor as Partial<SessionWorker>).workerOf
    return typeof locate === 'function' ? locate.call(this.executor, sessionId) : null
  }

  /**
   * worker 的五个工具用的窄端口（`tools.ts` 的 `WorkerToolDeps` 接到这里）。
   *
   * 为什么再开一个端口而不扩 `commands()`：主会话工具与 worker 工具是两条权限路。工人能
   * 回执、能处置自己工单的线程、能报状态，但绝不能决策 / 挂单 / 停单；把这些塞进主会话
   * 端口，再靠「调用方自觉别用」是挡不住的——端口本身就是边界。
   *
   * 每个动作都先按会话反查 worker：查不到返回 `false`，不抛（与 `reportBySession` 同口径，
   * 工具负责翻成一句人话）。查到之后才碰引擎；引擎的 `UserError`（比如掉工单自己的源线程）
   * 原样往上抛，也由工具翻译。
   *
   * @throws 运行期已关闭时抛错（关闭后的写没有意义，早报比在核心深处报好查）
   */
  workerCommands(): SuperagentWorkerCommandHost {
    this.assertOpen()
    return {
      ack: (sessionId, triggerId, text) => {
        const worker = this.workerOf(sessionId)
        if (worker === null) return false
        const reply = this.engine.reply({ purpose: 'acknowledgement', ticketId: worker.ticketId, triggerId, text })
        // 与主会话端口的 `reply` 同一处理：回复只是入队，立刻催一拍泵，免得白等 2 秒的定时器。
        // 催失败不影响「已经排上队」这个事实（下一拍照旧会取它），只记一行日志。
        try {
          this.pump()
        } catch (error) {
          this.log(`[superagent] 回执 ${reply.id} 已入队，但催泵失败：${describe(error)}`)
        }
        return true
      },
      markUnrelated: (sessionId, thread, reason) => {
        const worker = this.workerOf(sessionId)
        if (worker === null) return false
        this.engine.markUnrelated(worker.ticketId, thread, reason)
        return true
      },
      followForContext: (sessionId, thread) => {
        const worker = this.workerOf(sessionId)
        if (worker === null) return false
        // 线程键在**这里**切成端口要的 `{ source, id }`：工具不碰核心类型，形状不对就返回
        // false（工具那层已经先查过形状，走不到这里；留这一手是防将来别的调用方）。
        const at = thread.indexOf(':')
        if (at < 1 || at === thread.length - 1) return false
        return this.engine.followForContext(worker.ticketId, { source: thread.slice(0, at), id: thread.slice(at + 1) })
      },
      handback: (sessionId, triggerId, reason) => {
        const worker = this.workerOf(sessionId)
        return worker === null ? false : this.engine.handback(worker.ticketId, triggerId, reason)
      },
      report: (sessionId, report) => this.reportBySession(sessionId, report),
      // 认领 PR 的入口（工具侧 `superagent_report` 的 `pr_number`）。三步身份 / 配置检查都在
      // 这里做完，然后交给 `bind.ts` 的纯函数判：判定顺序与上游 `claimPull` 一致，
      // 运行期只负责把「按会话反查工单」「读 PR」「绑线程」三个真实动作接上。
      claimPull: async (sessionId, number) => {
        const worker = this.workerOf(sessionId)
        if (worker === null) return '不在 worker 会话里：认领 PR 只能由工单的 worker 发起'
        const api = this.githubApi()
        const account = this.githubAccount()
        if (api === null || account === undefined) {
          return 'GitHub 没配（要先填仓库与令牌），不能认领 PR'
        }
        return claimPull({
          // `readPull` 会把 PR 号补进结果（API 响应体里没有它），与 `bindAgentPulls`
          // 读的是同一个函数，判「机器人自己开的」时才有一致的字段。
          pull: (value) => readPull(api, value),
          account: { login: account.login, repository: account.repository },
          ticket: (id) => this.repos.tickets.get(id),
          openTickets: () => this.repos.tickets.open(),
          bind: (ticketId, thread, own) => { this.engine.bindThread(ticketId, thread, own) },
        }, worker.ticketId, number)
      },
      // 读自己工单的上下文：身份、工单、分页全由 `contextOf` 按会话现算；这里只是端口的一手转交。
      // 它不需要 `changed`：读不改变任何可见面，工具也不会推快照。
      context: (sessionId, resource, offset, limit) => this.contextOf(sessionId, resource, offset, limit),
      changed: () => { this.onChanged() },
    }
  }

  /**
   * 装配 `superagent_context` 要的那一份现场。
   *
   * 为什么放在运行期：仓储、起始 Trigger、线程消息表都只有这里拿得到；工具那一层只做
   * 参数校验与文本化。分页与「输入最多 10 条」的裁剪也在这里，两种越权都在这里拦成 null：
   * 会话反查不到工单（不是 worker / 工单已删）、输入的 id 不在 `ticket.inputs` 里（别人的输入）。
   *
   * @returns 三种 resource 各一种形状；null = 这张工单读不到了，工具负责翻成一句人话
   */
  private contextOf(sessionId: string, resource: string, offset: number, limit: number): unknown {
    const worker = this.workerOf(sessionId)
    if (worker === null) return null
    const ticket = this.repos.tickets.get(worker.ticketId)
    if (ticket === undefined) return null
    if (resource === 'ticket') return this.ticketContextOf(ticket)
    if (resource === 'thread') return this.threadContextOf(ticket, offset, limit)
    const id = resource.startsWith('input:') ? resource.slice('input:'.length).trim() : ''
    // 只认这张工单自己的输入：别人的 id 一律当不存在——回「那是别的工单的」等于确认它存在。
    const input = id === '' ? undefined : ticket.inputs.find((item) => item.id === id)
    return input === undefined ? null : this.inputContextOf(input)
  }

  /** `ticket` 资源：工单本身 + 最近 10 条输入的摘要（完整原文走 `input:<id>`）。 */
  private ticketContextOf(ticket: Ticket): WorkerTicketContextView {
    const body = this.repos.triggers.get(ticket.origin.triggerId)?.text ?? ''
    return {
      id: ticket.id,
      title: ticket.title,
      createdAt: ticket.createdAt,
      // 起始消息被删 / 库是手改的：如实说取不到，不拿标题冒充正文。
      body: body.trim() === '' ? `（取不到这张工单的要求原文：起始消息 ${ticket.origin.triggerId} 没读到）` : body,
      inputs: ticket.inputs.slice(-WORKER_TICKET_INPUT_LIMIT).map((input) => this.ticketInputViewOf(input)),
      inputTotal: ticket.inputs.length,
    }
  }

  /** 一条输入 → `ticket` 资源里的摘要行。 */
  private ticketInputViewOf(input: TicketInput): WorkerTicketInputView {
    const { source, text } = this.inputFactsOf(input)
    return { id: input.id, source, at: input.at, text: clipText(text, WORKER_INPUT_SUMMARY_CHARS) }
  }

  /** `input:<id>` 资源：这条输入的完整原文（不截断）。 */
  private inputContextOf(input: TicketInput): WorkerInputContextView {
    const { source, text } = this.inputFactsOf(input)
    return { id: input.id, source, at: input.at, text }
  }

  /**
   * 一条输入是谁给的、原文是什么。
   *
   * `source` 的取法：Trigger 用来源自己的名字（`github` / `feishu` / `manual`）；主会话写的
   * `text` / `note` 记 `main`；工单内部事件（恢复 / 重开 / 策略变更）记 `system` / `policy`。
   * 为什么不让工具自己认 kind：工具拿到的是一份摘要清单，kind 是核心模型的事。
   */
  private inputFactsOf(input: TicketInput): { source: string; text: string } {
    switch (input.kind) {
      case 'trigger': {
        const trigger = this.repos.triggers.get(input.triggerId)
        const text = trigger?.text ?? ''
        const body = text.trim() === '' ? `（取不到这条消息的原文：trigger ${input.triggerId}）` : text
        // `note` 是挂这条消息时主会话给的背景，和原文一起给：只给原文，模型看不出「为什么给我这条」。
        return {
          source: trigger?.source ?? 'unknown',
          text: input.note === undefined ? body : `（背景：${input.note}）\n${body}`,
        }
      }
      case 'text':
      case 'note':
        return { source: 'main', text: input.text }
      case 'resumed':
        return { source: 'system', text: `（工单恢复：按原来的目标继续，trigger ${input.triggerId}）` }
      case 'reopen':
        return { source: 'system', text: `（工单被重新打开：按原目标继续，decision ${input.decisionId}）` }
      case 'policy-changed':
        return { source: 'policy', text: `（策略变更：${input.from} → ${input.to}）` }
    }
  }

  /** `thread` 资源：这张工单所在线程的一页消息（旧 → 新）。 */
  private threadContextOf(ticket: Ticket, offset: number, limit: number): WorkerThreadContextView {
    const thread = this.contextThreadOf(ticket)
    // 工具已经校验过 offset >= 0、limit 1~50；这里再夹一次是给「别的调用方」——端口是导出的。
    const start = Math.max(0, Math.trunc(offset))
    const size = Math.min(WORKER_THREAD_MAX, Math.max(1, Math.trunc(limit)))
    if (thread === '') return { thread, offset: start, limit: size, total: 0, messages: [] }
    const total = this.threadMessageCount(thread)
    const rows = this.store.handle
      .prepare('SELECT id FROM trigger_thread WHERE thread = ? ORDER BY at ASC, rowid ASC LIMIT ? OFFSET ?')
      .all(thread, size, start) as unknown as { id?: unknown }[]
    const messages: CandidateMessageView[] = []
    for (const row of rows) {
      const trigger = this.repos.triggers.get(String(row.id))
      // 行还在、Trigger 读不到：索引比主表旧了一步，跳过这一条比整页报错好。
      if (trigger === undefined) continue
      messages.push({ text: trigger.text, actor: trigger.actor.id, at: trigger.at })
    }
    const next = start + size < total ? start + size : undefined
    return {
      thread,
      offset: start,
      limit: size,
      total,
      messages,
      // 没有下一页就不带这一项：带一个 null 会让模型以为「下一页是 null 号」。
      ...(next === undefined ? {} : { next_offset: next }),
    }
  }

  /** 这条线程上一共有几条消息（分页要算 `next_offset`）。 */
  private threadMessageCount(thread: string): number {
    const row = this.store.handle
      .prepare('SELECT COUNT(*) AS count FROM trigger_thread WHERE thread = ?')
      .get(thread) as { count?: unknown } | undefined
    const count = Number(row?.count)
    return Number.isFinite(count) ? count : 0
  }

  /**
   * 这张工单「所在线程」的键：起始 Trigger 的第一个线程。
   *
   * 为什么不取最近有动静的那条：worker 要看的是「这张单是从哪段对话里来的」，而
   * `answerThreadOf` 取的是「人回话回到哪」——工单跟了 PR 之后后者会变，前者才是它的出身。
   * 起始消息读不到时退回订阅它的线程（按最近动静挑），别凭空说「没有线程」。
   */
  private contextThreadOf(ticket: Ticket): string {
    const origin = this.repos.triggers.get(ticket.origin.triggerId)
    const first = origin?.threads[0]
    if (first !== undefined) return threadKey(first)
    return this.answerThreadOf(ticket.id)?.key ?? ''
  }

  /**
   * 飞书话题轮询要的三个动作（`FeishuThreads`，见 `adapters/feishu/loops.ts:141`）。
   *
   * 三件都只有运行期知道：
   * - **哪些话题还值得轮询**：要有活工单订阅着，或者最近 14 天内有过消息。端口契约要求
   *   接线层先筛（`loops.ts:138-139`），因为「哪张工单还活着」不在来源手里。
   * - **话题上最新的那条 Trigger**：补收的锚。飞书来源拿它的 `meta` 里的 chatId / messageId
   *   去读话题消息（`loops.ts:348-355`），没有锚就补不了。
   * - **写话题属性**：落在 `Thread.meta`——模型里就是给来源放原生属性的那一格
   *   （`core/model.ts:177-181`），话题 id 与最近一次读失败记在那儿。
   *
   * 为什么 `patch` 要整行回写：`threads.save` 只认整条话题（`repositories.ts:151`）。读与写之间
   * 没有 `await`，同一个 tick 里不会被别的写入插进来。
   */
  feishuThreads(): FeishuThreads {
    return {
      subscribed: (source) => this.repos.threads.list()
        .filter((thread) => thread.ref.source === source && this.worthPolling(thread)),
      latest: (key) => this.repos.triggers.latestOn(key),
      patch: (key, meta) => { this.patchThread(key, meta) },
    }
  }

  /**
   * 一个话题还值不值得轮询（`loops.ts:138-139` 的契约）：有活工单订阅着，或者最近 14 天里有消息。
   *
   * 「活工单」是「行在、且没结束」：结束的工单还会留在 `subscriptions` 里（历史），拿它当活
   * 就会让一批早该停的话题永远被轮询；也不把「查不到的 id」当活——那种 id 只会凭空造出
   * 一个永久轮询的话题（现状没有删工单的路径，但库里可能被手工改过）。
   */
  private worthPolling(thread: Thread): boolean {
    if (thread.subscriptions.some((id) => {
      const ticket = this.repos.tickets.get(id)
      return ticket !== undefined && ticket.ended === undefined
    })) return true
    const at = Date.parse(thread.lastAt ?? thread.createdAt)
    const now = Date.parse(this.clock())
    return Number.isFinite(at) && Number.isFinite(now) && now - at < POLL_HORIZON_MS
  }

  /** 把来源属性写回话题；`undefined` 表示删掉那个键（`pollError: undefined` 就是「这轮没出错」）。 */
  private patchThread(key: string, meta: Record<string, unknown>): void {
    const thread = this.repos.threads.get(key)
    if (thread === undefined) return
    const next = { ...thread.meta }
    for (const [name, value] of Object.entries(meta)) {
      if (value === undefined) delete next[name]
      else next[name] = value
    }
    this.repos.threads.save({ ...thread, meta: next })
  }

  /**
   * 发布一条需求，返回它建出的工单 id。
   *
   * 调用链（一行一步）：
   *   1. `manualTrigger(input, now)`：把标题/正文包成 `Trigger`（`addressed: 'direct'`）。
   *   2. `Engine.receive(trigger)`：入库、扇出到线程订阅、排队 Eval；返回
   *      `'stored' | 'duplicate' | 'filtered'`。
   *   3. `Engine.evaluateDue()`：给排队的线程起 Eval；Eval 在事务里把候选交给
   *      `ManualAssessor.request`，那里只入队。
   *   4. `ManualAssessor.drain(engine)`：事务外逐条读候选、`Engine.decide`，
   *      接单的决策带回工单 id。
   *   5. 取最后建出的工单 id 返回。
   *
   * 为什么不能「从 `receive` 的结果里取工单 id」：`receive` 的返回类型是
   * `ReceiveResult`（`core/intake.ts:8`），只有三个字符串，根本没有工单 id；
   * 工单 id 是 `decide` 的 `Decision.ticketId`（`core/evals.ts:311` 生成）。
   * 所以这里从 `drain` 的返回值取。
   *
   * @returns 工单 id；这条消息没接单（被 ignore / unavailable / 未入库）时，
   *          返回 Trigger 的 id，调用方可据此判断「没建成」
   */
  publish(input: ManualRequest): string {
    this.assertOpen()
    const trigger = manualTrigger(input, this.clock())
    const received = this.engine.receive(trigger)
    if (received !== 'stored') {
      // `filtered` 说明来源没被监听，`duplicate` 说明 id 撞了；两者都不会有工单。
      this.log(`[superagent] 触发器 ${trigger.id} 未入库（${received}），没有工单可建`)
      return trigger.id
    }
    this.engine.evaluateDue()
    const created = this.assessor.drain(this.engine)
    const ticketId = created.at(-1)
    if (ticketId !== undefined) return ticketId
    this.log(`[superagent] 触发器 ${trigger.id} 没有建出工单：判定结果不是接单`)
    return trigger.id
  }

  /**
   * 面板上的一句话：造一条人的 Trigger，挂到这张工单的线程上，交给 `Engine.receive`。
   *
   * 为什么走 `Engine.receive` 而不是直接在工单上加一条 Input：来源消息进领域只有这一道门
   * （入库、线程相关、订阅扇出、`addInput`、`wake`、按需排队 Eval，全在 `core/intake.ts:19-62`）。
   * 从旁边插一条 Input 看着更短，但「谁说的、经由哪条线程、要不要唤醒」立刻变成第二套规则，
   * 一处改了另一处忘掉，症状是「回答进库了但 worker 没醒」。
   *
   * 为什么线程要在这里找出来：工单模型里没有「它属于哪条线程」这个字段，只有线程的
   * `subscriptions` 记着「哪些工单订阅了我」。一张工单可能同时订阅多条线程（自己的话题 +
   * 关注的 PR），人回话要回到**最近有动静**的那条——先筛订阅它的全部线程，按
   * {@link threadRecency} 取最新；同一时刻时按线程 key 定序，保证同一个局面每次选同一条。
   *
   * @param ticketId - 要回答的工单
   * @param text - 回答正文（服务层已经判过非空与长度）
   * @throws 工单不存在 / 已结束 / 找不到它的线程 / 这条回答被判重复或被准入闸拦下
   */
  answer(ticketId: string, text: string): void {
    this.assertOpen()
    const ticket = this.repos.tickets.get(ticketId)
    if (ticket === undefined) throw new Error(`没有这张工单：${ticketId}`)
    if (!liveTicket(ticket)) throw new Error(`这张工单已经结束（${ticket.title}），没有可回答的问题`)
    const thread = this.answerThreadOf(ticketId)
    if (thread === undefined) {
      throw new Error('这张工单没有可回话的线程（消息可能来自不支持回话的来源）')
    }
    const trigger = answerTrigger({ thread: thread.ref, text, ticketId }, this.clock())
    const received = this.engine.receive(trigger)
    // 三种结果都要说清，不能静默：`stored` 才是「真的挂到工单上了」。
    if (received === 'duplicate') throw new Error('这条回答重复了：同一条消息已经收过一次，这次没有进工单')
    if (received === 'filtered') throw new Error('准入闸没放行：这条回答的来源不在允许名单里')
    // 入库那一步已经 `wake` 了工单（`core/intake.ts:59`）；再拍一次泵，让投递副作用在这一拍起跑。
    this.pump()
    this.onChanged()
  }

  /**
   * 一张工单人回话该回到的那条线程：订阅它的线程里最近有动静的那条。
   *
   * @param ticketId - 工单 id
   * @returns 线程；一条都没订阅这张工单时返回 `undefined`（调用方给一句能读的报错）
   */
  private answerThreadOf(ticketId: string): Thread | undefined {
    const subscribed = this.repos.threads.list().filter((thread) => thread.subscriptions.includes(ticketId))
    if (subscribed.length === 0) return undefined
    return subscribed.reduce((best, thread) => {
      const [a, b] = [threadRecency(thread), threadRecency(best)]
      if (a !== b) return a > b ? thread : best
      return thread.key > best.key ? thread : best
    })
  }

  /** 工单列表，新的在前；命令 `/sa list` 用。 */
  list(): TicketView[] {
    return this.repos.tickets.list().map(ticket => {
      const report = latestReport(ticket)
      // 问题原话只取一次：`attention` 由 worker 报 blocked 时挂上，回答后由执行器清掉。
      const question = ticket.attention?.question.trim() ?? ''
      return {
        id: ticket.id,
        title: ticket.title,
        stage: ticketStage(ticket),
        createdAt: ticket.createdAt,
        ...(report === undefined ? {} : { summary: report.summary }),
        ...(question === '' ? {} : { question }),
      }
    })
  }

  /**
   * 等人拍板的推断候选（backlog G1），新的在前。
   *
   * 返回存储层的原始记录：界面要的字段在 `value` 里，怎么渲染是 `surface.ts` 的事。
   * 「先等我确认」关着时库里本来就是空的（判定完就接单了），不必特判。
   */
  candidates(): CandidateRecord[] {
    return this.store.listCandidates()
  }

  /**
   * 等人拍板的候选现场（`superagent_read` 的 `candidate:<id>` 资源与 eval 工具读它）。
   *
   * 与 {@link candidates} 的分工：那里给界面卡片（判定的原始 JSON 还在 `value` 里，界面不
   * 需要正文）；这里给模型看，把触发消息正文与线程上下文一次补齐，工具拿到的是一份自足的
   * 现场，不必认识仓储。
   */
  candidateContexts(): CandidateContextView[] {
    return this.store.listCandidates().map((record) => this.candidateContextOf(record))
  }

  /** 一条候选记录 → 工具侧的现场（缺消息 / 线程时用空串与空表，不让工具拿到 undefined）。 */
  private candidateContextOf(record: CandidateRecord): CandidateContextView {
    const trigger = this.repos.triggers.get(record.triggerId)
    return {
      id: record.id,
      triggerId: record.triggerId,
      state: record.state,
      at: record.at,
      title: record.value.title,
      reason: record.value.reason,
      scope: record.value.scope,
      source: record.value.source,
      trigger: {
        text: trigger?.text ?? '',
        actor: trigger?.actor.id ?? '',
        at: trigger?.at ?? '',
      },
      thread: this.threadMessages(record.threadKey),
    }
  }

  /**
   * 一条线程上最近的消息，按时间升序（旧 → 新）。
   *
   * 为什么直接查 `trigger_thread`：仓储端口只露了 `latestOn`（一条），没有「按线程取一批」
   * 的读口；这一批又要按 `at` 排而不是按写入序。表与索引都是现成的（`store.ts` 的
   * `trigger_thread_at`），这里只读 id 列，正文仍走 `repos.triggers.get`，不碰写路径。
   */
  private threadMessages(key: string): CandidateMessageView[] {
    if (key === '') return []
    const rows = this.store.handle
      .prepare('SELECT id FROM trigger_thread WHERE thread = ? ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(key, CANDIDATE_THREAD_LIMIT) as unknown as { id?: unknown }[]
    const messages: CandidateMessageView[] = []
    for (const row of rows) {
      const trigger = this.repos.triggers.get(String(row.id))
      // 行还在、Trigger 读不到：索引比主表旧了一步，跳过这一条比整份候选报错好。
      if (trigger === undefined) continue
      messages.push({ text: trigger.text, actor: trigger.actor.id, at: trigger.at })
    }
    // 查询按时间倒序取「最新 N 条」，这里翻回旧→新：读上下文时顺序就是时间顺序。
    return messages.reverse()
  }

  /** 推断候选要不要先等人点头（backlog G1）；界面据此决定画不画「待确认」那一块。 */
  confirmingInferred(): boolean {
    return this.confirmInferred
  }

  /**
   * 设置变更历史（上游 `app/settings-history.ts` 的等价物），新的在前。
   *
   * 存储层给的是 JSON 反序列化的前后值；这里统一成界面要的显示形态——数组拼成
   * 逗号分隔（与设置面 `values()` 的展示口径一致），其余 `String()`，没有就是缺省。
   */
  settingsHistory(limit = 30): SuperagentSettingsChangeView[] {
    return this.store.settingsHistory(limit).map((record) => ({
      version: record.version,
      at: record.at,
      key: record.key,
      ...(record.from === undefined ? {} : { from: shownValue(record.from) }),
      ...(record.to === undefined ? {} : { to: shownValue(record.to) }),
    }))
  }

  /**
   * 接一条候选：把库里那份判定结果原样交给引擎，建出工单。
   *
   * 为什么判定结果从库里取、不由界面传：界面转手那份 JSON 是最容易改坏的形状——
   * 少一个 `rules` 就会被引擎按「推断候选没有命中规则」拒掉（`core/evals.ts:152`）。
   *
   * 为什么走 `engine.decide` 而不直接建工单：准入、规则、强度、决策历史都归核心，
   * 从这里绕过去等于把领域逻辑抄第二份。
   *
   * @param id - 候选 id
   * @param title - 覆盖判定时那个标题；不给就用原来的
   * @returns 建出来的工单 id
   * @throws 没有这条候选、已经处理过、或引擎拒绝
   */
  acceptCandidate(id: string, title?: string): string {
    const record = this.store.getCandidate(id)
    if (record === undefined) throw new Error(`没有这条候选：${id}`)
    if (record.state !== 'pending') throw new Error(`这条候选已经处理过了（${record.state}）`)
    const outcome = record.value.outcome as AssessmentOutcome
    if (outcome.kind !== 'accept') throw new Error(`这条候选不是「接单」结论（${outcome.kind}），不该从这里接`)
    const wanted = title?.trim() ?? ''
    const decision = this.engine.decide(record.triggerId, {
      ...outcome,
      ...(wanted === '' ? {} : { title: wanted }),
    })
    if (decision.ticketId === undefined) throw new Error(`引擎没有建出工单（${decision.kind}）`)
    this.store.settleCandidate(id, 'accepted')
    return decision.ticketId
  }

  /**
   * 忽略一条候选：它就此结束，不再进工单。
   *
   * 决策历史里补一条 `ignore`：判定时记的那条 `awaiting-person` 是「在等人」，
   * 这条是「人说了不要」——两件事，分开记才看得出发生了什么。
   */
  ignoreCandidate(id: string, reason?: string): void {
    const record = this.store.getCandidate(id)
    if (record === undefined) throw new Error(`没有这条候选：${id}`)
    if (record.state !== 'pending') throw new Error(`这条候选已经处理过了（${record.state}）`)
    this.store.settleCandidate(id, 'ignored')
    this.engine.decide(record.triggerId, { kind: 'ignore', reason: reason?.trim() || '人在界面上忽略了这个候选' })
  }

  /**
   * 面板「最近动态」：通知适配层内存窗口里的那几条（最旧在前）。
   *
   * 读的是内存窗口，不碰库——快照每次装配都会问它，不能顺带做一次出站队列的 drain。
   * 窗口靠发送泵补货：`flushOutbox()` 每取出一批消息，就把「说了什么」记进窗口。
   */
  recent(): RecentNotice[] {
    return this.notify.recent()
  }

  /**
   * 启动恢复：扫一遍工单，把「上次宿主崩在中间」留下的三种状态各自收口。
   *
   * 判据只有一条：**库里说最新分配还在跑，进程里却没有对应 worker**。
   *   - `pending`：还没派出去就崩了 → 重新入队（`executor.start`，它会按「工单 + 分配」去重）；
   *   - `running` 且没有 worker：上次真的跑过 → 交给领域的 `assignmentInterrupted`，
   *     由它结束旧分配、起一份新分配，并把「上次中断了，先看工作树和 git 状态」的提示词
   *     作为第一条输入投给新 worker（`core/assignments.ts:83-92`）；
   *   - `ended`：领域已经收尾，一律不碰。
   *
   * **不判失败**：DSC 的 worker 是进程内的 MiniAgent，宿主一死会话就没了，重开一份新分配
   * 是唯一能继续的路；判失败只会把一张还能干的单推给人。至于「worker 已经报了结论、之后
   * 没人接话」的单（失败原因、要人拍板的问题），领域自己会保留原分配，这里不算接续、也不发
   * 「已自动接续」的通知——那份结论留在界面上等人处理。
   *
   * **不在这里建工作树**：新分配的派工走执行器自己的 `start → launch → ensureWorktree`，
   * 与正常派工同一条路；`ensureWorktree` 本身幂等（同名树在就复用，`adapters/worktree.ts:192`），
   * 分支名由工单 id 与标题算出来（`worktreeNameOf`），所以恢复既不丢上一轮的改动，
   * 也不建第二棵树、更不换分支。
   *
   * 幂等：`pending` 第二次调用时执行器队列里已有同一对（工单 + 分配），`start` 直接返回；
   * 接续过的单第二次进来时最新分配已是新那份 `pending`，走上面那一条。可以安全地重复调用。
   *
   * **没派出去的行不需要在这里补**：`start` 现在只往 `effect` 表写一行，进程崩在
   * 「行已写、还没派工」时那一行还在表里；本次启动的 `effects.start()` 之后，第一拍
   * `dispatch`（`pump`）就会把它取出来。这一条覆盖「正常退出」与「崩溃」两种结局。
   * 表里的旧行会不会乱派工，由 `launchQueued` 开头的重读把住：工单已结束、分配已换、
   * 分配不再 `pending` 的行会被直接丢弃（见 `adapters/executor.ts` 文件头）。
   *
   * @returns 本次接续的与重新入队的工单 id
   */
  recover(): RecoveryReport {
    this.assertOpen()
    const resumed: string[] = []
    const requeued: string[] = []
    const live = this.workerTicketIds()
    for (const ticket of this.repos.tickets.open()) {
      const assignment = latestAssignment(ticket)
      if (assignment === undefined || assignment.state === 'ended') continue
      if (assignment.state === 'pending') {
        try {
          // 执行器按 (工单, 分配) 去重：重复恢复不会派两遍，更不会建两棵工作树。
          this.executor.start(ticket, assignment)
          requeued.push(ticket.id)
        } catch (error) {
          this.log(`[superagent] 工单 ${ticket.id} 恢复派工失败：${describe(error)}`)
        }
        continue
      }
      // 下面是 running：进程里还有 worker 的说明这次不是崩溃残留（例如刚恢复完又重进这里）。
      if (live.has(ticket.id)) continue
      try {
        // 该不该换分配，交给领域判（`core/assignments.ts:83-92`）：它只在「最新报告是
        // waiting / ready / blocked / failed，且之后没有新输入投给 worker」时才保留原分配。
        // 在适配层另写一份更粗的判据（比如「报过 failed 就不接续」）会漏掉「报了失败、
        // 人又说了一句、worker 正跑着」这个窗口，留下既不能接续、也不能重试的卡单。
        this.engine.assignmentInterrupted(ticket.id, assignment.id)
        // 领域判定「这一单本来就在等人」时不换分配；只把真换了分配的算作接续。
        if (latestAssignment(this.repos.tickets.get(ticket.id) ?? ticket)?.id === assignment.id) continue
        resumed.push(ticket.id)
        this.notifyRecovered(ticket, assignment.id)
      } catch (error) {
        this.log(`[superagent] 工单 ${ticket.id} 的崩溃恢复未记入：${describe(error)}`)
      }
    }
    if (resumed.length > 0 || requeued.length > 0) {
      this.log(
        `[superagent] 启动恢复：${String(resumed.length)} 张接续（起新分配、工作树沿用）、` +
          `${String(requeued.length)} 张重新入队`,
      )
    }
    return { resumed, requeued }
  }

  /**
   * 保留策略：删掉**已结束超过 30 天**的工单的会话目录。
   *
   * 判据是工单的 `ended.at`，不是文件时间：文件时间会被备份 / 复制改掉，而「这张工单
   * 哪天结束」是库里记着的事实。`ended.at` 读不出来的（手改坏的库）一律不动。
   *
   * **保证不删 30 天内的东西**：只有 `now - endedAt > 30 天` 才动手，正好 30 天的保留；
   * 未结束的工单、以及工作树根（`worktrees/`）都不在这里删——后者是 `/sa clean` 的活，
   * 里面可能有还没合并的提交。
   *
   * 幂等：目录已经不在就记进 `missing`，不报错。
   *
   * @param now - 当前时刻（毫秒）；测试注入用
   */
  sweep(now: number = Date.now()): SweepReport {
    this.assertOpen()
    const cutoff = now - SESSION_RETENTION_MS
    const removed: string[] = []
    const missing: string[] = []
    for (const ticket of this.repos.tickets.list()) {
      const endedAt = ticket.ended === undefined ? Number.NaN : Date.parse(ticket.ended.at)
      // 没结束、时间读不出来、或者还在保留期内：一律不动。
      if (!Number.isFinite(endedAt) || endedAt >= cutoff) continue
      let dir: string
      try {
        dir = sessionsDir(ticket.id)
      } catch (error) {
        this.log(`[superagent] 工单 ${ticket.id} 的会话目录算不出来，跳过：${describe(error)}`)
        continue
      }
      if (!existsSync(dir)) {
        missing.push(ticket.id)
        continue
      }
      try {
        rmSync(dir, { recursive: true, force: true })
        removed.push(ticket.id)
      } catch (error) {
        this.log(`[superagent] 工单 ${ticket.id} 的会话目录没删掉（${dir}）：${describe(error)}`)
      }
    }
    if (removed.length > 0 || missing.length > 0) {
      this.log(`[superagent] 会话清理：删了 ${String(removed.length)} 个，已不在 ${String(missing.length)} 个`)
    }
    return { removed, missing }
  }

  /**
   * 体检用读数：未结束、最新分配还在 `running` 的工单有几张，其中几张进程里没有 worker。
   *
   * 「没有 worker」不一定是坏事：`recover()` 跑过之后，卡住的单会换成一份新的 `running`
   * （或 `pending`）分配；还留在 running 又没 worker 的，就是「没人推进、也没人报错」的卡单，
   * 体检要把它点出来。
   */
  runningStats(): { total: number; orphaned: number } {
    this.assertOpen()
    const live = this.workerTicketIds()
    let total = 0
    let orphaned = 0
    for (const ticket of this.repos.tickets.open()) {
      if (latestAssignment(ticket)?.state !== 'running') continue
      total += 1
      if (!live.has(ticket.id)) orphaned += 1
    }
    return { total, orphaned }
  }

  /**
   * 2 秒泵的一拍：先按超时收掉跑太久的工单，再把到期的 Eval 处理掉、判定排队中的候选，
   * 然后催一次副作用队列（派工 / 投递），最后把出站消息发出去。
   *
   * 队列那一拍不能省：退避重试的行（due 往后推过）没有别的东西会再唤醒它——`kick()` 只在
   * 入队 / 有任务结束时排 microtask，而失败收尾时 due 还没到；每拍现扫一次，到点的行就会被
   * 取走。上游等价物是 `passes.pumpOnce()` 里的 `effects.kick()`（`app/passes.ts:64`）。
   *
   * 发送不 `await`：一次网络往返可能几秒，等它会把整拍拖住（超时判定、Eval 都会跟着晚）。
   * 发送泵自己有一道 `busy` 闸（`dispatch.ts`），所以提前放出去不会把同一行发两遍。
   *
   * 抛错由调用方（`index.ts` 的定时器）捕获后记日志，不中断下一拍。
   */
  pump(): void {
    this.assertOpen()
    this.expireOverdue()
    this.engine.evaluateDue()
    this.assessor.drain(this.engine)
    // 派工 / 投递的 handler 在这里起跑；它们自己会报告、自己会在失败时退避。
    this.effects.dispatch()
    void this.flushOutbox()
  }

  /**
   * 发一轮出站消息。
   *
   * 公开是为了让测试能 `await` 它——泵里是发出去就走，等不到结果。正常路径上不会抛：
   * 一条消息发不出去只影响那一条，不该让泵的日志里冒出一个跟工单无关的堆栈。
   *
   * @returns 这一轮结束时完成；有没有发出、发了几条不回报（要看效果去读「最近动态」）
   */
  async flushOutbox(): Promise<void> {
    if (this.closed) return
    try {
      await this.dispatch.flush()
    } catch (error) {
      // 取队列本身失败（某行 JSON 坏了会抛）只记一行，下一拍照旧跑。
      this.log(`[superagent] 出站消息未发出：${describe(error)}`)
    }
  }

  /**
   * 超时取消：工单从建单到现在超过 `ticketTimeoutSeconds`（> 0 时）→ 停 worker、转 `failed`。
   *
   * 只处理**最新分配正在 `running`** 的工单，三个例外都是「不该由超时改判」的状态：
   *   - 已结束的工单不参与（它已经收口了）；
   *   - `pending`（还在排队等并发空位）不参与：它一次都没跑过，没有 worker 可停；若在这里
   *     改判失败，执行器队列里那一项稍后仍会照常派工，等于失败又被推翻；
   *   - 已经报过 `failed` / `blocked` 的跳过：那是「等人」的状态，超时再写一遍只会把 worker
   *     提出的问题或失败原因盖掉。`failed` 还兼作幂等：同一张单每拍都超时，不会每 2 秒
   *     重写一次报告。
   *
   * 顺序是「先停 worker、再写报告」：先写报告的话，worker 取消时回来的 `turn/end` 会撞上
   * 一个已经 `failed` 的分配；先停（`stopping = true`）则它收尾时不再往引擎写报告。
   */
  private expireOverdue(): void {
    const seconds = Math.floor(this.timeoutOf())
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const limitMs = seconds * 1000
    const now = Date.now()
    for (const ticket of this.repos.tickets.open()) {
      const createdAt = Date.parse(ticket.createdAt)
      if (!Number.isFinite(createdAt) || now - createdAt <= limitMs) continue
      const assignment = latestAssignment(ticket)
      if (assignment?.state !== 'running') continue
      const reported = assignment.report?.state
      if (reported === 'failed' || reported === 'blocked') continue
      const reason = `超过 ${String(seconds)} 秒未完成，已取消`
      try {
        this.executor.stop(ticket, assignment, reason)
        this.engine.report(ticket.id, { state: 'failed', summary: reason })
        this.log(`[superagent] 工单 ${ticket.id} ${reason}`)
      } catch (error) {
        this.log(`[superagent] 工单 ${ticket.id} 超时取消失败：${describe(error)}`)
      }
    }
  }

  /**
   * worker 报告入口：`superagent_report` 工具按会话找到正在跑的 worker，把报告交给引擎。
   *
   * 为什么放在运行期而不是让工具直接拿执行器：执行器由运行期私有持有（它要晚绑定引擎），
   * 工具只拿得到 `sessionId`。这里转一手，执行器就仍然只有运行期认识。
   * 注入的假执行器没有这个能力时返回 false，工具据此报「不在 worker 会话里」。
   */
  reportBySession(sessionId: string, report: WorkerReport): boolean {
    const probe = this.executor as Partial<Pick<WorkerExecutor, 'reportBySession'>>
    if (typeof probe.reportBySession !== 'function') return false
    try {
      return probe.reportBySession(sessionId, report)
    } catch (error) {
      this.log(`[superagent] 会话 ${sessionId} 的 ${report.state} 报告没写进去：${describe(error)}`)
      return false
    }
  }

  /**
   * 进程里此刻有 worker 的工单 id。
   *
   * 走可选查询而不是把执行器类型钉死成 `WorkerExecutor`：`options.executor` 允许注入假执行器
   * （测试），没有这个查询的按「一个 worker 都没有」处理——对恢复与体检都是保守的一侧。
   */
  private workerTicketIds(): Set<string> {
    const probe = this.executor as Partial<Pick<WorkerExecutor, 'workingTicketIds'>>
    if (typeof probe.workingTicketIds !== 'function') return new Set()
    try {
      return new Set(probe.workingTicketIds())
    } catch (error) {
      this.log(`[superagent] 取 worker 清单失败（按没有 worker 处理）：${describe(error)}`)
      return new Set()
    }
  }

  /**
   * 崩溃接续后的一条通知：入 `outbox`，下一拍泵会把它取进「最近动态」。
   *
   * 必须发：接续会在界面上凭空多出一份新分配、进度条从头走，人需要一句话解释「这是自己
   * 接着干，不用管」，否则会以为有人在偷偷重派。
   */
  private notifyRecovered(ticket: Ticket, assignmentId: string): void {
    const message: OutboundMessage = {
      // 幂等键带上分配 id：同一张工单的另一次崩溃是新的一条通知，同一次崩溃只发一次。
      id: `recover:${ticket.id}:${assignmentId}`,
      channel: RECOVERY_CHANNEL,
      text: `工单「${ticket.title}」上次没跑完（宿主重启，worker 丢了）。已自动接续：起了一份新分配，` +
        `工作树与分支沿用，不用手动重试。`,
      kind: 'notice',
      ticketId: ticket.id,
    }
    try {
      this.outbox.send(message)
    } catch (error) {
      // 通知失败不影响「已经接续」这个事实：账已经落库，界面下一拍也会看到阶段变化。
      this.log(`[superagent] 工单 ${ticket.id} 的恢复通知未入队：${describe(error)}`)
    }
  }

  /**
   * 停止一张工单：先让领域收尾，再真停 worker。
   *
   * **顺序不能反**。`engine.stopTicket` 把工单标成结束、结束在跑的分配；先停 worker 的话，
   * 它收尾时回来的回合事件（`turn/end`）会撞上「工单已结束」，那份报告只能丢掉。
   * 领域在事务里也会对同一批分配调一次 `executor.stop`（`core/tickets.ts:362`），而
   * 执行器的 `stop` 是幂等的（`adapters/executor.ts:465`），所以这里再叫一次没有副作用。
   *
   * @throws UserError（`unknownTicket`）当这张工单不存在
   */
  stop(ticketId: string): void {
    this.assertOpen()
    // 停之前先记下要停哪些分配：领域收尾之后它们全变成 `ended`，就认不出是哪个了。
    const before = this.repos.tickets.get(ticketId)
    const stopping = before?.assignments.filter(assignment => assignment.state !== 'ended') ?? []
    this.engine.stopTicket(ticketId)
    if (before === undefined) return
    for (const assignment of stopping) this.executor.stop(before, assignment, '人要求停止')
  }

  /**
   * 重试一张失败 / 卡住的工单，然后让泵重新派工。
   *
   * 领域在 `retryTicket` 的事务里已经把新分配交给执行器了（`core/tickets.ts:178`，那是
   * 本轮真正的派工入口）；这里再叫一次 `start` 是幂等补刀——执行器按「工单 + 分配」去重
   * （`adapters/executor.ts:411`），重复的一叫是空操作，却保证「重试之后一定重新派工」，
   * 不必依赖调用方记得再拍一次泵。
   *
   * @throws UserError（`notRetryable`）当这张工单不是「失败 / 卡住」状态
   */
  retry(ticketId: string): void {
    this.assertOpen()
    const ticket = this.engine.retryTicket(ticketId)
    const pending = latestAssignment(ticket)
    if (pending !== undefined) this.executor.start(ticket, pending)
  }

  /**
   * 清掉一张**已结束**工单的工作树。
   *
   * 目录名不许在这里另发明一套：执行器建树时用的是 `worktreeNameOf`（`adapters/executor.ts`），
   * 落点用 `worktreePathOf`（`adapters/worktree.ts`）——建单时的 `prepare` 与 `ensureWorktree`
   * 都走同一个纯函数，所以这里原样调它，路径才与建出来的那棵对得上。
   *
   * 为什么只许清理已结束的：worker 还在写的时候删目录，它的改动与提交会落进一个悬空的树里，
   * 人也拿不回来。要清理就先 `stop`（`/sa stop`），这是唯一不会丢东西的顺序。
   */
  clean(ticketId: string): void {
    this.assertOpen()
    const ticket = this.repos.tickets.get(ticketId)
    if (ticket === undefined) throw new Error(`没有这张工单：${ticketId}`)
    if (ticket.ended === undefined) {
      throw new Error(`工单「${ticket.title}」还没结束，先停止（/sa stop ${ticket.id.slice(0, 8)}）再清理工作树`)
    }
    const repo = this.repoOf().trim()
    if (repo === '') {
      throw new Error('没有配置仓库路径（设置 → Super Agent → repoPath），不知道工作树挂在哪个仓库下，无法清理')
    }
    const path = worktreePathOf({ name: worktreeNameOf(ticket), root: this.worktreeRoot }).dir
    removeWorktree({ repo, path })
    this.log(`[superagent] 工单 ${ticket.id} 的工作树已清理：${path}`)
  }

  /**
   * 释放运行期。
   *
   * 先 drain 副作用队列：不再起新的派工 / 投递，等正在跑的那几个收尾；**没跑完的行留在
   * `effect` 表里**，下一次启动的第一拍会被 `dispatch` 取到——这正是「崩溃不丢活」的同一条
   * 恢复路径（见 {@link recover} 的注释）。`drain` 是异步的，而 `close()` 是同步契约：
   * 这里只发出去不等它。等它会让宿主卸载卡在一个可能跑十分钟的准备命令上；而队列的行本来
   * 就是为「没等到」准备的。
   *
   * **不关 store**：库是调用方（`index.ts`）打开的，生命周期归它；这里关掉会让
   * 调用方手里的句柄变成悬空的。重复调用是空操作。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    void this.effects.drain()
    this.assessor.clear()
  }

  /** 一条领域事件落进 `event` 表；没有工单可指向的（见 `ticketIdOf`）只记日志。 */
  private record(event: DomainEvent): void {
    const ticketId = ticketIdOf(event)
    if (ticketId === undefined) {
      this.log(`[superagent] 事件 ${event.type}（发生在工单之前，不入 event 表）`)
      return
    }
    try {
      // kind 直接用领域事件类型字符串（'ticket.created' 这类），不另造一套枚举：
      // 时间线要与 `DomainEvents` 一一对应，多一层映射就会漂移。
      this.store.appendEvent(ticketId, event.type, { at: event.at, data: event.data })
    } catch (error) {
      // 写账失败不该回滚接单：它发生在核心的写事务里，抛出去会把刚建的工单一起回滚。
      this.log(`[superagent] 事件 ${event.type} 未落库：${describe(error)}`)
    }
    // 通知挂在「工单结束」这一个事件上：工单的结局只有一个，重复触发也只会入队一次（见 `ended`）。
    if (event.type === 'ticket.ended') this.announce(ticketId)
  }

  /**
   * 工单结束 → 入队一条通知。
   *
   * 读工单而不是拿事件里的字段：通知要说「改了什么」，那是 worker 最后一份报告的内容，
   * 只在工单里（`assignments[].report`）。读失败只记日志——账已经落库，不该把结束回滚。
   */
  private announce(ticketId: string): void {
    try {
      const ticket = this.repos.tickets.get(ticketId)
      if (ticket !== undefined) this.notify.ended(ticket)
    } catch (error) {
      this.log(`[superagent] 工单 ${ticketId} 的通知未入队：${describe(error)}`)
    }
  }

  /** 关闭后再用是程序错误，早报比在核心深处报「unknownTicket」好查。 */
  private assertOpen(): void {
    if (this.closed) throw new Error('SuperagentRuntime 已关闭')
  }
}
