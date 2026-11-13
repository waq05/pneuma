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
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Engine, latestAssignment, latestReport, ticketStage, type ChannelRef, type DomainEvent, type Executor,
  type OutboundMessage, type SourceScope, type Thread, type ThreadRef, type Ticket, type TicketStage, type Trigger,
  type WorkerReport } from './core/index.js'
import { policyVersion, settingsPolicy, type RoleModel, type Settings } from './core/policy.js'
import { selectAssessor, type SuperagentAssessor } from './adapters/assessor-select.js'
import type { AssessorComplete } from './adapters/assessor-model.js'
import type { GithubApi } from './adapters/github/api.js'
import { readThreadWindow, type ThreadWindow } from './adapters/github/read.js'
import { OutboxDispatcher, type MessageSender } from './adapters/dispatch.js'
import { EffectQueue } from './adapters/effects.js'
import type { FeishuThreads } from './adapters/feishu/loops.js'
import { POLL_HORIZON_MS } from './adapters/feishu/loops.js'
import { WorkerExecutor, worktreeNameOf, type UnattendedMode, type WorkerModel } from './adapters/executor.js'
import { manualScope, manualTrigger, type ManualRequest } from './adapters/manual.js'
import { StoreNotifier, type RecentNotice } from './adapters/notify.js'
import { StoreOutbox } from './adapters/outbox.js'
import { StoreRepositories } from './adapters/repositories.js'
import { defaultSettings, GITHUB_SOURCE } from './adapters/settings.js'
import type { DscStore } from './adapters/store.js'
import { removeWorktree, slugOf } from './adapters/worktree.js'
import { sessionsDir, worktreesDir } from './paths.js'

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
  /** 无人值守审批档，缺省 `deny`。 */
  unattended?: UnattendedMode
  /** 工作树起点 ref；缺省 HEAD。 */
  base?: string
  /** 工作树根；缺省 `<DSC_HOME>/superagent/worktrees`。 */
  root?: string
}

/** 可注入项：时钟、日志、宿主上下文与执行器设置。 */
export interface RuntimeOptions {
  /** 当前时刻，`Date#toISOString` 形式；核心不读环境时钟。 */
  now?: () => string
  log?: RuntimeLog
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

/** 把未知异常压成一行可读文本，日志用。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  /** 执行器：`stop` 真停 worker、`retry` 重新派工要用；默认是 {@link WorkerExecutor}。 */
  private readonly executor: Executor
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
  /** 上一次算出来的策略，连同算它用的设置版本戳；版本没变就复用。 */
  private policyCache: { stamp: string; policy: ReturnType<typeof settingsPolicy> } | null = null
  /** 单工单超时（秒）的 getter；每拍现读，设置页改完下一拍就按新上限判。 */
  private readonly timeoutOf: () => number
  /**
   * 出站队列。恢复通知也从这里入队（`recover()`），与核心的回复共用同一个幂等口径：
   * 同一个 id 第二次 `send` 不会再写一行。
   */
  private readonly outbox: StoreOutbox
  private closed = false

  constructor(store: DscStore, options: RuntimeOptions = {}) {
    const now = options.now ?? (() => new Date().toISOString())
    this.store = store
    this.log = options.log ?? (() => {})
    this.clock = now
    // 复用 `DscStore` 的那条连接（`store.handle`）：再开一条会冒出第二个 WAL 写者，
    // 而且两条连接各自开的事务互不可见，`atomic` 的边界就不成立了。
    this.repos = new StoreRepositories(store.handle)
    // 策略与来源范围要先于判定器就位：判定器每次判定都现读设置（规则表改了立刻生效）。
    this.policyCache = null
    this.settingsOf = options.settings ?? (() => defaultSettings())
    this.scope = options.scope ?? manualScope
    this.githubApi = options.githubApi ?? (() => null)
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
    })
    this.notify = new StoreNotifier(store)
    this.timeoutOf = options.timeoutSeconds ?? (() => 0)
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

  /** 工单列表，新的在前；命令 `/sa list` 用。 */
  list(): TicketView[] {
    return this.repos.tickets.list().map(ticket => {
      const report = latestReport(ticket)
      return {
        id: ticket.id,
        title: ticket.title,
        stage: ticketStage(ticket),
        createdAt: ticket.createdAt,
        ...(report === undefined ? {} : { summary: report.summary }),
      }
    })
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
   * 目录名不许在这里另发明一套：执行器建树时用的是 `worktreeNameOf`（标题 slug 前 40 位 +
   * `-` + 工单 id 前 8 位，`adapters/executor.ts:232`），这里原样调同一个函数；`ensureWorktree`
   * 会把传进来的名字再 slug 一次并拼到工作树根下（`adapters/worktree.ts:192-195`），所以这里
   * 也套一次 `slugOf`，路径才与建出来的那棵对得上。
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
    const name = worktreeNameOf(ticket)
    const path = join(resolve(this.worktreeRoot ?? worktreesDir()), slugOf(name))
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
