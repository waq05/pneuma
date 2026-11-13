/**
 * superagent 的执行器：把一张工单变成「一个真在独立工作树里干活的 MiniAgent」。
 *
 * 这一步是本项目的分水岭（设计文档 §6.2 与第 5 步验收）：`Engine` 只负责「谁该干活、
 * 干到哪了」，本文件负责真正把会话、工作树与循环装配起来。
 *
 * ## 一张工单一个 worker
 *
 * 1. `ensureWorktree` 建（或复用）独立工作树，目录与分支都带工单 id 后缀——全中文标题
 *    经 `slugOf` 只会折成 `ticket`，不补唯一后缀时两张中文工单会撞同一棵树；
 * 2. `Session.create(cwd, 显式文件)`：**不走 `ctx.session.open`**，那会把用户正在看的
 *    会话切走（设计文档 §6.2.2）。worker 会话落在 `<DSC_HOME>/superagent/sessions/<工单 id>/`；
 * 3. `new MiniAgent(deps, session)`：`deps` 的六个必填项见 {@link WorkerExecutor.depsFor}；
 * 4. `followup(工单文本)` 开跑；回调 `assignmentStarted`。
 *
 * ## 为什么 `start` 只排队、不在这里动手
 *
 * 端口契约写明「each method only queues work」（`core/ports.ts:55-69`）：`start` 是在
 * `Tickets.create` / `wake` 的写事务里被调的（`core/tickets.ts:54`）。在工作树里跑 git、
 * 读会话文件都是慢动作，放在事务里会把整库的写锁一起攥住。所以这里只入队，真正的派工
 * 在下一个 microtask 里做——那时事务已经提交。
 *
 * ## 简版说明（做不到的部分，宁可功能少也不假装）
 *
 * - **权限档**：worker 会话钉死 `sandbox: workspace-write`（§7.3），不跟随用户当前会话。
 *   审批按 `unattended` 三档处理，但**没有**完整的 §7.2 语义：主审批服务没有「这次会不会
 *   弹卡」的非阻塞查询口，重复实现它的分类器只会漂移。本实现的取舍是：worker 会话的
 *   权限模式钉 `full-access`（否则一次 `npm test` 就会在无人值守时挂成一张永久的审批卡），
 *   真正的围栏交给 order 8 的沙箱；`deny`（默认）档在守卫入口拒绝「请求放宽沙箱」与
 *   「沙箱判定越界」这两类——它们才是必须有人拍板的事。`ask` 档改钉 `auto-edit` 并把
 *   一切交回全局守卫链，让人在旁边时照常弹卡。残留风险：受保护文件（AGENTS.md 这类）
 *   与安全钩子强制问人的调用仍可能弹卡。
 * - **报告只有 ready / failed 两种**：`turn/end` 正常收尾记 `ready`（正文最后一段当摘要），
 *   收到 `error` 记 `failed`。worker 在正文里提的问题不会被单独识别成 `blocked`/`waiting`，
 *   它落在摘要里；工单会按 `ready` 收尾。要补这张语义表，需要解析模型输出，P0 不做。
 * - **没有 `rewrite` / 上下文注入**：worker 的环境事实（仓库、目录、分支）直接写进系统提示，
 *   不走主会话的 env-facts 投影，因此也没有「上下文注入」卡。压缩照常接（`compact`）。
 *
 * @module dsc/packages/superagent/adapters/executor
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CoreEvent } from '@pneuma/runtime/core/events.js'
import type { LlmRoute, StreamHandlers, StreamRequest, StreamResult } from '@pneuma/runtime/core/llm.js'
import { Session } from '@pneuma/runtime/core/session.js'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { ToolGuardChain, ToolGuardInput } from '@pneuma/runtime/core/tool-guards.js'
import type { PromptSectionView } from '@pneuma/runtime/contract.js'
import type { CompactService, LlmService, SandboxService, ToolService } from '@pneuma/runtime/services/types.js'
import { MiniAgent, type AgentDeps } from '@pneuma/session-core/loop.js'
import { writePermissions } from '@pneuma/permission-core/permission-scope.js'
import type { Assignment, Executor, EngineForExecutor, Ticket, TicketInput, WorkerReport } from '../core/index.js'
import { LIMITS } from '../core/limits.js'
import { sessionsDir } from '../paths.js'
import { ensureWorktree, slugOf, type EnsureWorktreeInput, type WorktreeHandle } from './worktree.js'

/** 日志出口；默认丢弃，`runtime.ts` 传宿主的日志函数。 */
export type ExecutorLog = (line: string) => void

/**
 * 执行器从宿主上下文里要用到的那一角。
 *
 * 单列一个结构类型（而不是直接收整个 cordis `Context`）有两个理由：
 * 1. 包级测试可以注入假实现，不必伪造整个上下文；
 * 2. 依赖面写在纸面上——worker 只用模型、工具、守卫、沙箱、压缩这五样。
 *
 * 真实的 `Context` 结构上满足它（`services/types.ts:1571-1657` 的服务声明），
 * 所以生产装配可以直接 `new WorkerExecutor(ctx, …)`。
 */
export interface WorkerHost {
  llm: Pick<LlmService, 'route' | 'routeTo' | 'stream'>
  tools: Pick<ToolService, 'list'>
  guards: ToolGuardChain
  /** 沙箱服务（插件关着时不存在）：无人值守档拿它判「这次越界了没有」。 */
  sandbox?: Pick<SandboxService, 'check'>
  /** 压缩服务（插件关着时不存在）：worker 也会跑长会话，爆窗前要能压。 */
  compact?: Pick<CompactService, 'check' | 'forceCompact'>
}

/** 无人值守审批档（设计文档 §7.2）：`deny` 保守、`allow` 自动化、`ask` 有人在旁边。 */
export type UnattendedMode = 'deny' | 'allow' | 'ask'

/** worker 的模型路由设置（对应设置里的 `executor.model`）；null = 跟随当前选路。 */
export interface WorkerModel {
  provider: string
  model: string
  reasoningEffort?: 'default' | 'off' | 'low' | 'high' | 'max'
}

/** 工作树操作的可注入面：测试用假实现顶掉真实 git。 */
export interface WorktreeOps {
  ensure(input: EnsureWorktreeInput): WorktreeHandle
}

/** 执行器选项；除 `host`/`repo` 外都有缺省值。 */
export interface WorkerExecutorOptions {
  /** 宿主端口；测试注入。构造参数给了 `ctx` 时缺省从它取。 */
  host?: WorkerHost
  /** 仓库根（设置里的 `repoPath`）；可传 getter，设置页改了下一次派工就用新值。 */
  repo?: string | (() => string)
  /** 同时干活的 worker 上限（设置项），默认 2，范围 1–16。 */
  maxWorkers?: number
  /** 工作树的起点 ref；缺省 HEAD。 */
  base?: string
  /** 工作树根；缺省 `<DSC_HOME>/superagent/worktrees`。 */
  root?: string
  /** worker 的模型路由；缺省跟随 `host.llm.route()`。 */
  model?: WorkerModel | null
  /** 无人值守审批档，默认 `deny`。 */
  unattended?: UnattendedMode
  /** 回给 worker 的「可用命令」提示；缺省说没有额外限制。 */
  blockedCommands?: readonly string[]
  /** 引擎回调；构造时 `Engine` 还没建好，用 getter 晚绑定。 */
  engine?: () => EngineForExecutor
  /** 日志出口。 */
  log?: ExecutorLog
  /** 按 trigger id 取原文（工单正文与后续消息都要它）；缺省给一句可读的占位。 */
  readTriggerText?: (triggerId: string) => string | undefined
  /** 工作树操作；测试注入假实现。 */
  worktree?: WorktreeOps
  /** 建会话；测试可换成假的（缺省 `Session.create`）。 */
  createSession?: (cwd: string, file: string) => Session
  /** 造 worker；测试换成假 agent（缺省 `new MiniAgent`）。 */
  createAgent?: (deps: AgentDeps, session: Session) => WorkerAgent
}

/** worker 的最小面：真身是 `MiniAgent`（`session-core/loop.ts:143`）。 */
export interface WorkerAgent {
  followup(text: string): void
  /** 中断当前回合；不杀进程（worker 是进程内的循环）。 */
  cancel(): void
  /** 还有回合在跑（`MiniAgent.isRunning`）；停止时据此决定何时还会话写租约。 */
  readonly isRunning?: boolean
}

/** 系统提示的三段模板（设计文档 §6.2.1）：正文与段清单同源。 */
export interface WorkerPromptInput {
  title: string
  body: string
  branch: string
  repo: string
  dir: string
  blockedCommands?: readonly string[]
}

/** 一次已入队、还没真正派出去的工单。 */
interface QueuedLaunch {
  ticket: Ticket
  assignment: Assignment
}

/** 一个正在干活的 worker。 */
interface Worker {
  ticketId: string
  assignmentId: string
  /** 工作树目录（也是 worker 的 cwd）。 */
  dir: string
  /** 分支名（`agent/<slug>`）。 */
  branch: string
  session: Session
  /** worker 本体；派工失败时可能还没建出来（见 `launch` 的 catch）。 */
  agent: WorkerAgent | null
  /** 已请求停止：此后的 turn/end / error 不再往引擎写报告（assignment 已经结束了）。 */
  stopping: boolean
  /** 会话已关闭（幂等）。 */
  closed: boolean
  /** 本轮最后一条非空助手正文，`turn/end` 的交付摘要取它。 */
  lastText: string
  /** 本轮收到的错误正文；`turn/end` 的 reason 是 `error` 时用它。 */
  lastError?: string
  /** 失败报告已发过：`error` 事件与随后的 `turn/end(error)` 只报一次。 */
  failedReported: boolean
}

/** 六件套：worker 只拿这些工具（设计文档 §6.2 的表格）。 */
const WORKER_TOOL_NAMES: readonly string[] = ['bash', 'read', 'write', 'edit', 'glob', 'grep']

/** 并发上限的缺省值：设计文档写 2；设置项可覆盖。 */
const DEFAULT_MAX_WORKERS = 2

/** 回合因 `completed` 收尾时的摘要下限；worker 一个字没留也得让工单上有句话。 */
const NO_SUMMARY = '（worker 这一回合没有留下文字总结，改动请看工作树）'

/** 把未知异常压成一行可读文本。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * worker 的报告映射：`turn/end` 的三种收尾原因 → 引擎要的 {@link WorkerReport}。
 *
 * 单拎成纯函数是为了包级测试能直测映射，不必起模型（`tests/executor.test.mjs` 第 4 条）。
 * - `completed` → `ready`（摘要 = 最后一段正文）；
 * - `error` → `failed`（摘要 = 错误原文，没给就用正文）；
 * - `aborted` → 不报：主动停止时 assignment 已经结束，别往结束了的分配上补报告；
 *   非主动的 aborted（宿主收摊）由 `assignmentInterrupted` 那条路恢复。
 *
 * @param reason - `turn/end` 事件带的原因。
 * @param summary - 最后一条非空助手正文。
 * @param error - `error` 事件记下的错误正文。
 * @param stopping - 这个 worker 是否已经请求停止。
 */
export function turnEndReport(
  reason: 'completed' | 'aborted' | 'error',
  summary: string,
  error?: string,
  stopping = false,
): WorkerReport | null {
  if (stopping || reason === 'aborted') return null
  if (reason === 'error') return errorReport(error ?? summary)
  const text = summary.trim()
  return { state: 'ready', summary: text === '' ? NO_SUMMARY : text }
}

/** `error` 事件的报告：工单停在「等人处理」。 */
export function errorReport(message: string): WorkerReport {
  const text = message.trim()
  return { state: 'failed', summary: text === '' ? '回合失败（没有错误详情）' : text }
}

/**
 * 工单的工作树名：可读前缀 + 工单 id 前 8 位。
 *
 * 为什么必须带唯一后缀：`slugOf` 把全中文标题折成 `'ticket'`（`worktree.ts:79-91`），
 * 而本插件最常见的输入就是全中文。只留标题的话，第二张中文工单会复用第一张的分支与
 * 目录，两个 worker 就会在同一棵树里互相踩。
 *
 * 后缀取 `ticket.id` 的前 8 位：id 是 32 位十六进制（`core/ids.ts`），8 位在单机工单量级
 * 不会撞；前缀截到 40 字符，加上 `-` + 8 位仍在 `slugOf` 的 60 字符预算内。
 */
export function worktreeNameOf(ticket: Pick<Ticket, 'id' | 'title' | 'execution'>): string {
  const readable = slugOf(ticket.execution?.name ?? ticket.title).slice(0, 40).replace(/[-.]+$/, '')
  return `${readable === '' ? 'ticket' : readable}-${ticket.id.slice(0, 8)}`
}

/** 系统提示的三段模板（设计文档 §6.2.1 原文）；`sections` 给「系统提示」卡用。 */
export function buildWorkerPrompt(input: WorkerPromptInput): { text: string; sections: PromptSectionView[] } {
  const commands = input.blockedCommands?.length
    ? `除内置禁用之外，以下命令不允许使用：${input.blockedCommands.join('、')}`
    : '没有额外禁用的命令；禁止开 PR、禁止推远端。'
  const text = `你是超级智能体的执行者，负责一个工单。工单在独立的工作目录里，改动不要越出这个目录。

<工单>
标题：${input.title}
要求：${input.body}
分支：${input.branch}
</工单>

<环境>
仓库：${input.repo}
工作目录：${input.dir}
可用命令：${commands}
</环境>

<交付要求>
1. 改完跑一次相关测试，把结果写进最后一段。
2. 最后一段必须包含：改了哪些文件（一行一个，带 +/− 行数）、测试结果、没做的事。
3. 不要开 PR，不要推远端。改完必须在本分支上提交一次：git add -A && git commit -m "一句话说清改了什么"。
   不提交等于什么都没交付——工单的产出就是这条分支上的提交，改动悬在工作区里，人一收拾就没了。
4. 有需要人拍板的事，直接说清楚问题和你的建议，然后停下。
</交付要求>`
  return {
    text,
    // worker 的提示词不在内核的段注册表里（它是本包直接拼的），给「系统提示」卡一段合成的段：
    // 卡片至少能显示体量与来源，不至于空着一张段清单。
    sections: [{ id: 'superagent-worker', order: 0, chars: text.length, from: 'plugin:superagent' }],
  }
}

/** 参数里有没有「请求放宽沙箱」：两个字段任缺其一都会被主审批当半截请求拒掉，所以任一出现都算。 */
function requestsEscalation(args: Record<string, unknown>): boolean {
  return typeof args.sandbox_permissions === 'string' || typeof args.justification === 'string'
}

/**
 * 从 cordis 上下文取出执行器要的宿主端口。
 *
 * 三项硬依赖（`llm` / `tools` / `guards`）也走 `ctx.get`：`inject` 已经保证它们先于本插件
 * 就位，这里再查一次是为了把「声明了但实际没起来」这种情况变成一条**可读的缺项清单**，
 * 而不是等第一次取模型时才在深层抛一句看不懂的话。可选服务（沙箱 / 压缩）用 `ctx.get`
 * 读，cordis 对没有注入的服务做属性访问会抛错而不是给 undefined（同 `sandbox/index.ts:370`）。
 *
 * @returns `host` 为 null 时 `missing` 列出缺了哪些服务，调用方据此打降级日志。
 */
function hostFromContext(ctx: Context): { host: WorkerHost | null; missing: string[] } {
  const llm = ctx.get('llm') as WorkerHost['llm'] | undefined
  const tools = ctx.get('tools') as WorkerHost['tools'] | undefined
  const guards = ctx.get('guards') as WorkerHost['guards'] | undefined
  const missing: string[] = []
  if (llm === undefined) missing.push('llm')
  if (tools === undefined) missing.push('tools')
  if (guards === undefined) missing.push('guards')
  if (llm === undefined || tools === undefined || guards === undefined) return { host: null, missing }
  return {
    host: {
      llm,
      tools,
      guards,
      sandbox: ctx.get('sandbox') as WorkerHost['sandbox'],
      compact: ctx.get('compact') as WorkerHost['compact'],
    },
    missing,
  }
}

/**
 * 一个工单执行器：工作树 + 会话 + MiniAgent + 并发队列。
 *
 * 生命周期：`start` 入队 → microtask 派工 → 回合事件写报告 → `stop` 取消并让位。
 * 所有方法都可能在引擎的写事务里被调用，所以它们只做内存操作或排队；慢动作在
 * {@link WorkerExecutor.launch} 里，且已经在事务之外。
 */
export class WorkerExecutor implements Executor {
  private readonly host: WorkerHost | null
  /** 宿主没接上时缺的是什么（空数组 = 接上了）；降级日志要用它说清原因。 */
  private readonly hostProblem: string[]
  /** 仓库根的 getter：设置页改了路径，下一张工单不用重启就能用新值。 */
  private readonly repoOf: () => string
  private readonly maxWorkers: number
  private readonly base: string | undefined
  private readonly root: string | undefined
  private readonly model: WorkerModel | null
  private readonly unattended: UnattendedMode
  private readonly blockedCommands: readonly string[] | undefined
  private readonly engineOf: (() => EngineForExecutor) | undefined
  private readonly log: ExecutorLog
  private readonly readTriggerText: ((triggerId: string) => string | undefined) | undefined
  private readonly worktree: WorktreeOps
  private readonly createSession: (cwd: string, file: string) => Session
  private readonly createAgent: (deps: AgentDeps, session: Session) => WorkerAgent
  /** 正在干活的 worker（键 = 工单 id）。 */
  private readonly workers = new Map<string, Worker>()
  /** 等并发槽的工单，严格 FIFO。 */
  private readonly queue: QueuedLaunch[] = []
  /**
   * 已请求停止、但回合还在收尾的 worker。
   *
   * 它们已经让出「干活」名额（`workers` 里没了），但回合还没跑完，会话也还开着；
   * 并发上限要按「活着的 agent」算，所以这一段也要占坑，等 `onIdle` 关掉会话才放行
   * 下一个（见 `terminate` / `closeSession`）。
   */
  private readonly retiring = new Set<Worker>()
  /** 已经排过一次 microtask；同一拍内多次 `start` 只派工一次。 */
  private scheduled = false
  /** 「缺工具」只提醒一次：`tools()` 每轮请求都调，重复刷屏没有信息量。 */
  private missingToolsWarned = false
  private disposed = false

  /**
   * @param ctx - cordis 上下文；`options.host` 给了就优先用后者（测试）。允许 `null`：
   *   没有上下文时执行器停在「未接宿主」模式——`start` 只记一条说明缺项的日志，工单留在
   *   「待派工」，绝不假装派出去。
   */
  constructor(ctx: Context | null, options: WorkerExecutorOptions = {}) {
    this.log = options.log ?? (() => {})
    // 宿主端口：测试注入 > 真实上下文 > 没有。缺项不抛错，降级成「接不上」，由 start 报清楚。
    const resolved = options.host !== undefined
      ? { host: options.host, missing: [] as string[] }
      : ctx === null
        ? { host: null, missing: ['cordis Context'] }
        : hostFromContext(ctx)
    this.host = resolved.host
    this.hostProblem = resolved.missing
    const repo = options.repo ?? ''
    this.repoOf = typeof repo === 'function' ? repo : () => repo
    this.maxWorkers = Math.min(
      LIMITS.maxWorkers.max,
      Math.max(LIMITS.maxWorkers.min, Math.floor(options.maxWorkers ?? DEFAULT_MAX_WORKERS)),
    )
    this.base = options.base?.trim() || undefined
    this.root = options.root?.trim() || undefined
    this.model = options.model ?? null
    this.unattended = options.unattended ?? 'deny'
    this.blockedCommands = options.blockedCommands
    this.engineOf = options.engine
    this.readTriggerText = options.readTriggerText
    this.worktree = options.worktree ?? { ensure: ensureWorktree }
    this.createSession = options.createSession ?? ((cwd, file) => Session.create(cwd, file))
    this.createAgent = options.createAgent ?? ((deps, session) => new MiniAgent(deps, session))
    if (this.host === null) {
      this.log(
        `[superagent] 执行器未接宿主（缺 ${this.hostProblem.join('、') || '未知服务'}）：` +
          '工单会停在待派工，不会启动 worker；补齐这些服务并重启宿主后才会真正派工',
      )
    } else {
      // 可降级能力缺了不拦派工，但必须让人看见「这次少的是哪一道」。
      const degraded: string[] = []
      if (this.host.sandbox === undefined) degraded.push('sandbox（worker 没有文件围栏，写入只靠工作目录约束）')
      if (this.host.compact === undefined) degraded.push('compact（长会话不会自动压缩，爆窗会以 failed 收尾）')
      if (degraded.length > 0) this.log(`[superagent] 执行器可降级能力缺失：${degraded.join('；')}；worker 仍会启动`)
    }
  }

  /** 正在干活的 worker 数（并发上限的分子）；测试与诊断用。 */
  get activeCount(): number {
    return this.workers.size
  }

  /** 还在排队的工单数；测试与诊断用。 */
  get queuedCount(): number {
    return this.queue.length
  }

  /**
   * 此刻进程里还有 worker 的工单 id（在跑的 + 已请求停止、回合还在收尾的）。
   *
   * 只读查询，给崩溃恢复与体检用：库里说某张工单的分配还在 `running`，这里查不到它，
   * 就说明那个 worker 随上次宿主一起没了。不改任何状态，也不触发派工。
   */
  workingTicketIds(): string[] {
    return [...this.workers.keys(), ...[...this.retiring].map(worker => worker.ticketId)]
  }

  /**
   * 引擎要求派工：只入队，下一个 microtask 再动手（理由见文件头）。
   *
   * 同一个 (工单, 分配) 重复调用是空操作：`Tickets.addInput` 会在待派工阶段反复调
   * `start`（`core/tickets.ts:244`），重复建树会白跑 git，还会把 worker 建两份。
   */
  start(ticket: Ticket, assignment: Assignment): void {
    if (this.disposed) return
    if (this.host === null) {
      this.log(
        `[superagent] 工单 ${ticket.id} 停在待派工：执行器缺 ${this.hostProblem.join('、') || '宿主服务'}，没有启动 worker`,
      )
      return
    }
    const existing = this.workers.get(ticket.id)
    if (existing !== undefined) {
      if (existing.assignmentId === assignment.id) return
      // 同一张工单换了新分配（重试 / 恢复）：旧 worker 先让位，再排新的。
      this.terminate(existing, '新分配接管')
    }
    if (this.queue.some(item => item.ticket.id === ticket.id && item.assignment.id === assignment.id)) return
    this.queue.push({ ticket, assignment })
    this.schedule()
  }

  /**
   * 把未送达的 Input 递进 worker 的当前回合。
   *
   * 文本按 `TicketInput` 的种类取；`trigger` 的原文只有仓储知道，由 `options.readTriggerText`
   * 提供（`runtime.ts` 用同一个仓储读）；取不到时给一句「原文见工单」——宁可少，不编。
   */
  deliver(ticket: Ticket, assignment: Assignment): void {
    if (this.disposed) return
    const worker = this.workers.get(ticket.id)
    if (worker === undefined || worker.assignmentId !== assignment.id || worker.stopping) return
    const agent = worker.agent
    if (agent === null) return
    const ids = ticket.undelivered
    if (ids.length === 0) return
    const text = this.inputsText(ticket, ids)
    try {
      agent.followup(text)
      this.engineOf?.()?.inputsDelivered(ticket.id, assignment.id, ids)
    } catch (error) {
      this.log(`[superagent] 工单 ${ticket.id} 的输入投递失败：${describe(error)}`)
      try {
        this.engineOf?.()?.deliveryFailed(ticket.id, assignment.id, describe(error).slice(0, 300))
      } catch (inner) {
        this.log(`[superagent] 投递失败也未能记进工单 ${ticket.id}：${describe(inner)}`)
      }
    }
  }

  /**
   * 停止一个 worker：中断它的回合，不杀进程。
   *
   * 幂等：重复调用（以及分配已经结束后的迟到调用）都是空操作。会话写租约不在这里立刻
   * 还——`turn/end` 之后循环还要落收尾出账与 git 聚合（`session-core/loop.ts:398-418`），
   * 提前 `close` 会把它们写进一条没有租约的会话。真正的关闭挂在 `onIdle` 上。
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    const worker = this.workers.get(ticket.id)
    if (worker === undefined || worker.assignmentId !== assignment.id) return
    this.terminate(worker, reason)
  }

  /** 退出插件时的收摊：取消所有 worker、关闭会话、清空队列。重复调用是空操作。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queue.length = 0
    for (const worker of [...this.workers.values()]) this.terminate(worker, '执行器关闭')
    // 收尾中的 worker 已经不在 `workers` 里（见 `terminate`），但会话还开着；
    // 插件都要卸了，不再等它的 `onIdle`。
    for (const worker of [...this.retiring]) this.closeSession(worker)
  }

  /**
   * worker 的模型路由。
   *
   * 设置里给了 provider/model 就用 `routeTo`（子智能体同款，`subagent/index.ts:732-738`）；
   * 否则跟随 `route()`——P0 没有单独的 worker 模型设置项，跟随当前选路是唯一可用的答案。
   */
  route(): LlmRoute {
    if (this.host === null) throw new Error('执行器未接宿主，取不到模型路由')
    if (this.model !== null) {
      return this.host.llm.routeTo(this.model.provider, this.model.model, this.model.reasoningEffort ?? 'default')
    }
    return this.host.llm.route()
  }

  /**
   * 模型面前的那份工具目录：只挑六件套（设计文档 §6.2 的表格）。
   *
   * 用 `list()` 而不是 `visible()`：worker 没有「当前查看的会话」，模式白名单那套投影
   * 按会话算，拿不到它的档位；这里按固定名单做减法，结果与用户当前模式无关。
   */
  tools(): ToolEntry[] {
    if (this.host === null) return []
    const all = this.host.tools.list()
    const picked: ToolEntry[] = []
    for (const name of WORKER_TOOL_NAMES) {
      const entry = all.find(item => item.name === name)
      if (entry !== undefined) picked.push(entry)
    }
    if (picked.length < WORKER_TOOL_NAMES.length) {
      if (!this.missingToolsWarned) {
        this.missingToolsWarned = true
        const missing = WORKER_TOOL_NAMES.filter(name => !picked.some(item => item.name === name))
        this.log(`[superagent] worker 缺工具：${missing.join('、')}（这些能力对 worker 不可用）`)
      }
    }
    return picked
  }

  /** 系统提示：三段模板 + 段清单（见 {@link buildWorkerPrompt}）。 */
  systemPrompt(input: WorkerPromptInput): { text: string; sections: PromptSectionView[] } {
    return buildWorkerPrompt(input)
  }

  /** 下一个 microtask 派工；同一拍内多次 `start` 只排一次。 */
  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.pump()
    })
  }

  /** 有空位就从队首派工；`launch` 自己接住所有异常，不会把队列卡死。 */
  private pump(): void {
    if (this.disposed) return
    // 名额按「活着的 agent」算：收尾中的 worker 还开着会话，不能算已经让位。
    while (this.workers.size + this.retiring.size < this.maxWorkers && this.queue.length > 0) {
      const item = this.queue.shift()
      if (item === undefined) break
      this.launch(item)
    }
  }

  /**
   * 真正派工：建工作树 → 建会话 → 钉权限 → 造 agent → 投工单文本 → 告诉引擎。
   *
   * 这里跑在事务之外（见文件头）。任何一步失败都落成一张 `failed` 报告，且把已经建出来的
   * 会话关掉；错误不往外抛——`start` 的调用方在事务里，外抛会回滚工单本身。
   */
  private launch(item: QueuedLaunch): void {
    const { ticket, assignment } = item
    let session: Session | null = null
    let worker: Worker | null = null
    try {
      const repo = this.repoOf().trim()
      if (repo === '') throw new Error('没有配置仓库路径（设置 → Super Agent → repoPath），无法建工作树')
      if (this.engineOf === undefined) throw new Error('执行器没有引擎回调，报告没有出口')
      const name = worktreeNameOf(ticket)
      const handle = this.worktree.ensure({ repo, name, base: this.base, root: this.root })
      const file = join(sessionsDir(ticket.id), `${randomUUID()}.jsonl`)
      session = this.createSession(handle.path, file)
      // 权限在 worker 开工前钉死（§7.3）：沙箱永远 workspace-write，不跟随用户当前会话；
      // 审批模式见文件头的「简版说明」。这一条 appendState 同时把会话文件落了盘——
      // 守卫按 sessionPath 反查会话时（`core/guard-session.ts:57-75`）文件必须已经存在。
      writePermissions(session, {
        sandbox: 'workspace-write',
        policy: this.unattended === 'ask' ? 'auto-edit' : 'full-access',
        reviewer: 'user',
      })
      worker = {
        ticketId: ticket.id,
        assignmentId: assignment.id,
        dir: handle.path,
        branch: handle.branch,
        session,
        // 先占位：`emit` 闭包要拿到 worker，而 agent 的构造又要拿到闭包。
        agent: null,
        stopping: false,
        closed: false,
        lastText: '',
        failedReported: false,
      }
      const active = worker
      const agent = this.createAgent(this.depsFor(active, ticket), session)
      active.agent = agent
      this.workers.set(ticket.id, active)
      // 先投工单文本、再告诉引擎「开跑了」：`Assignments.started` 会立刻把等待中的输入
      // 交给 `deliver`（`core/assignments.ts:41`），顺序反了的话新消息会排在工单要求之前。
      agent.followup(this.taskTextOf(ticket, handle))
      this.engineOf?.()?.assignmentStarted(ticket.id, assignment.id)
      this.log(`[superagent] 工单 ${ticket.id} 已在 ${handle.path} 开工（分支 ${handle.branch}，${handle.created ? '新建' : '复用'}）`)
    } catch (error) {
      this.log(`[superagent] 工单 ${ticket.id} 派工失败：${describe(error)}`)
      if (worker !== null) {
        // 走同一条退场路径：可能已经开了一轮，先取消，回合收尾后才关会话。
        this.terminate(worker, '派工失败')
      } else if (session !== null) {
        // 会话建了、worker 还没建：直接还租约。
        try {
          session.close()
        } catch {
          // 关闭失败没有第二件可做的事：这条会话没有 worker 会再用它。
        }
      }
      this.report({ ticketId: ticket.id }, { state: 'failed', summary: `派工失败：${describe(error)}` })
    }
  }

  /**
   * 一次请求要的 `AgentDeps`（设计文档 §6.2 的六个必填项）。
   *
   * | 字段 | 这里的实现 |
   * | --- | --- |
   * | `route` | 设置里的 provider/model，缺省跟随当前选路 |
   * | `systemPrompt` | {@link buildWorkerPrompt} 的三段模板，环境事实直接写进去 |
   * | `tools` | 六件套（`tools()`） |
   * | `guards` | 全局链 + 无人值守入口（{@link WorkerExecutor.guardsFor}） |
   * | `stream` | `ctx.llm.stream` |
   * | `emit` | 回合事件 → 引擎报告（{@link WorkerExecutor.emitOf}） |
   *
   * 另外接了 `compact`（每轮前的压缩检查与爆窗重试）和 `notice`（运行时提醒落日志）；
   * `rewrite` / `takeContextInjections` 不接：worker 没有投影链，环境事实已在系统提示里。
   */
  private depsFor(worker: Worker, ticket: Ticket): AgentDeps {
    const body = this.bodyOf(ticket)
    const system = this.systemPrompt({
      title: ticket.title,
      body,
      branch: worker.branch,
      repo: this.repoOf().trim(),
      dir: worker.dir,
      blockedCommands: this.blockedCommands,
    })
    return {
      route: () => this.route(),
      systemPrompt: () => system,
      tools: () => this.tools(),
      guards: this.guardsFor(worker),
      stream: (api: string, request: StreamRequest, handlers: StreamHandlers): Promise<StreamResult> => {
        if (this.host === null) return Promise.reject(new Error('执行器未接宿主，发不出模型请求'))
        return this.host.llm.stream(api, request, handlers)
      },
      emit: event => this.emitOf(worker, event),
      notice: text => this.log(`[superagent] worker ${worker.ticketId}：${text}`),
      beforeRequest: async signal => {
        await this.host?.compact?.check(signal, worker.session)
      },
      onContextOverflow: async signal => {
        return (await this.host?.compact?.forceCompact(signal, worker.session)) ?? false
      },
      onIdle: () => {
        // 停止请求是在回合中途发的：循环跑完收尾（出账 + git 聚合）才真正闲下来，
        // 这时才还写租约（见 `stop` 的注释）。
        if (worker.stopping) this.closeSession(worker)
      },
    }
  }

  /**
   * worker 的守卫链：先过本执行器的无人值守闸，再交给全局链。
   *
   * 为什么不直接 `guards: ctx.guards`：worker 在后台跑，没有人能点审批卡。全局链的
   * order 30 是人工审批，`full-access` 已经避免了绝大多数卡；但「请求放宽沙箱」与
   * 「沙箱判定越界」这两类必须先在这里拦掉，否则会挂成一张永远没人点的卡。
   *
   * 为什么不做成全局注册（order 29）：注册在 `ctx.guards` 上会活到插件卸载，而执行器
   * 的生命周期由 `runtime.close()` 管；包一层每 worker 的链不用登记、也不用退订。
   * order 8 的沙箱仍然排在前面（这里是在它**之后**被调用：`gate` 里再委托全局链，
   * 沙箱照常先判），所以「先沙箱、后无人值守」的顺序没有变。
   */
  private guardsFor(worker: Worker): ToolGuardChain {
    const host = this.host
    if (host === null) {
      return {
        gate: async () => ({ action: 'deny', reason: '执行器未接宿主，worker 不能动手' }),
        observe: (_toolName, text) => text,
      }
    }
    return {
      gate: async (input: ToolGuardInput) => {
        if (worker.stopping) return { action: 'deny', reason: '工单已停止，worker 不再接受新的工具调用' }
        if (requestsEscalation(input.args)) {
          if (this.unattended === 'deny') {
            return {
              action: 'deny',
              reason: '无人值守执行器（档位 deny）拒绝放宽沙箱：写入范围就是这个工单的工作树；确实需要越界时请让人改档位或手工处理。',
            }
          }
          // allow / ask 交给全局链：allow 会按 worker 会话的 full-access 放行，ask 会弹卡。
          return host.guards.gate(input)
        }
        if (this.unattended === 'deny' && input.risk !== 'read') {
          const fence = this.fenceOf(worker, input)
          if (fence !== undefined && !fence.allowed) {
            return {
              action: 'deny',
              reason: `无人值守执行器拒绝越界操作（沙箱规则：${fence.rule ?? fence.reason ?? '未知'}）：${
                fence.requestable
                  ? '这类越界需要人点一次审批，worker 在后台没有人能点。'
                  : '沙箱判定这次的越界不该被批准。'
              }`,
            }
          }
        }
        return host.guards.gate(input)
      },
      observe: (toolName, text) => host.guards.observe(toolName, text),
    }
  }

  /** 沙箱查一次这次调用会不会越界；服务不在场或自己抛错时返回 undefined（交给全局链判）。 */
  private fenceOf(worker: Worker, input: ToolGuardInput) {
    const sandbox = this.host?.sandbox
    if (sandbox === undefined) return undefined
    try {
      return sandbox.check(input.target, input.command, worker.dir, worker.session.filePath)
    } catch (error) {
      this.log(`[superagent] 工单 ${worker.ticketId} 的沙箱预判失败（交给全局守卫链）：${describe(error)}`)
      return undefined
    }
  }

  /**
   * 回合事件 → 引擎报告。
   *
   * - `turn/start`：清掉上一回合的正文、错误与「已报失败」标记；
   * - `message`：记最后一条非空助手正文（交付摘要的来源）；
   * - `error`：立刻记 `failed`（随后 `turn/end(error)` 不再重复）；
   * - `turn/end`：先记 `turnEnded`（闲置时间），再按 {@link turnEndReport} 记报告。
   *
   * 所有引擎调用都包了 try/catch：`report` 在工单已结束或分配已结束时抛 `UserError`
   * （`core/assignments.ts:99-113`），报告失败不该把 worker 的回合也带崩。
   */
  private emitOf(worker: Worker, event: CoreEvent): void {
    if (event.type === 'turn/start') {
      worker.lastText = ''
      delete worker.lastError
      worker.failedReported = false
      return
    }
    if (event.type === 'message') {
      if (event.text.trim() !== '') worker.lastText = event.text
      return
    }
    if (event.type === 'error') {
      worker.lastError = event.message
      if (worker.stopping) return
      worker.failedReported = true
      this.report(worker, errorReport(event.message))
      return
    }
    if (event.type === 'turn/end') {
      this.turnEnded(worker)
      if (worker.stopping) return
      const report = event.reason === 'error' && worker.failedReported
        ? null
        : turnEndReport(event.reason, worker.lastText, worker.lastError)
      if (report !== null) this.report(worker, report)
    }
  }

  /** 报告写回引擎；失败只记日志。 */
  private report(worker: Pick<Worker, 'ticketId'>, report: WorkerReport): void {
    const engine = this.engineOf?.()
    if (engine === undefined) {
      this.log(`[superagent] 工单 ${worker.ticketId} 的报告没有引擎可写：${report.state}`)
      return
    }
    try {
      engine.report(worker.ticketId, report)
    } catch (error) {
      this.log(`[superagent] 工单 ${worker.ticketId} 的 ${report.state} 报告未记入：${describe(error)}`)
    }
  }

  /** 「这一回合结束了」：只更新分配的闲置时间，不改工单状态。 */
  private turnEnded(worker: Worker): void {
    const engine = this.engineOf?.()
    if (engine === undefined) return
    try {
      engine.turnEnded(worker.ticketId, worker.assignmentId)
    } catch (error) {
      this.log(`[superagent] 工单 ${worker.ticketId} 的回合结束未记入：${describe(error)}`)
    }
  }

  /**
   * 让一个 worker 退场：取消回合、移出并发表、推队列。
   *
   * 会话按 `isRunning` 决定何时关：还在跑就等 `onIdle`（见 `stop` 的注释）；已经不跑了
   * 就立刻还租约。`terminate` 自身幂等，重复调用只会在 `stopping` 那一步返回。
   */
  private terminate(worker: Worker, reason: string): void {
    if (worker.stopping) return
    worker.stopping = true
    const agent = worker.agent
    this.workers.delete(worker.ticketId)
    try {
      agent?.cancel()
    } catch (error) {
      this.log(`[superagent] 工单 ${worker.ticketId} 中断失败：${describe(error)}`)
    }
    this.log(`[superagent] 工单 ${worker.ticketId} 的 worker 已停止（${reason}）`)
    if (agent?.isRunning !== true) {
      this.closeSession(worker)
    } else {
      // 回合还在收尾：会话先不关，让循环把收尾出账与 git 聚合写完（`stop` 的注释）。
      this.retiring.add(worker)
    }
    this.schedule()
  }

  /** 关闭会话（幂等）；释放写租约，并让出一个并发名额。 */
  private closeSession(worker: Worker): void {
    if (worker.closed) return
    worker.closed = true
    this.retiring.delete(worker)
    try {
      worker.session.close()
    } catch (error) {
      this.log(`[superagent] 工单 ${worker.ticketId} 的会话关闭失败：${describe(error)}`)
    }
    // 收尾中的 worker 到这里才真正让位（见 `terminate` 与 `pump`）。
    this.schedule()
  }

  /** 工单正文：来自它的起始 Trigger；取不到就给一句可读的占位，不编内容。 */
  private bodyOf(ticket: Ticket): string {
    const text = this.readTriggerText?.(ticket.origin.triggerId)?.trim()
    return text === undefined || text === '' ? `（执行器取不到工单原文，按标题「${ticket.title}」执行）` : text
  }

  /** 头一次投给 worker 的工单文本。 */
  private taskTextOf(ticket: Ticket, handle: WorktreeHandle): string {
    return `工单：${ticket.title}
要求：${this.bodyOf(ticket)}
分支：${handle.branch}
工作目录：${handle.path}

请在这个工作目录里完成上面的要求；干完在最后一段写清楚：改了哪些文件（一行一个，带 +/− 行数）、测试结果、没做的事。`
  }

  /** 把一批未送达的 Input 拼成一条消息；每种 Input 的取文方式见 {@link inputTextOf}。 */
  private inputsText(ticket: Ticket, ids: readonly string[]): string {
    const parts = ids.map(id => {
      const input = ticket.inputs.find(item => item.id === id)
      return input === undefined ? `（工单里找不到输入 ${id}）` : this.inputTextOf(input)
    })
    return `工单收到新消息：\n\n${parts.join('\n\n')}`
  }

  /** 一条 Input 的可读文本；`trigger` 的原文由宿主注入的 `readTriggerText` 提供。 */
  private inputTextOf(input: TicketInput): string {
    if (input.kind === 'trigger') {
      const text = this.readTriggerText?.(input.triggerId)?.trim()
      return text === undefined || text === ''
        ? `（一条新消息，执行器取不到原文：trigger ${input.triggerId}。请按工单现状继续，拿不准就在最后一段说明。）`
        : text
    }
    if (input.kind === 'text' || input.kind === 'note') return input.text
    if (input.kind === 'resumed') return `（工单恢复：按原来的目标继续，trigger ${input.triggerId}）`
    if (input.kind === 'reopen') return `（工单被重新打开：按原目标继续，decision ${input.decisionId}）`
    return `（策略变更：${input.from} → ${input.to}）`
  }
}
