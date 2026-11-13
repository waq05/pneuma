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
 * 2. `runPrepare` 在工作树里跑设置里的准备命令（如 `pnpm install`），空串跳过；
 *    失败直接判 failed、不自动重试——重试只会把半成品当已准备好（上游 `PrepareFailed` 同一取舍）；
 * 3. `Session.create(cwd, 显式文件)`：**不走 `ctx.session.open`**，那会把用户正在看的
 *    会话切走（设计文档 §6.2.2）。worker 会话落在 `<DSC_HOME>/superagent/sessions/<工单 id>/`；
 * 4. `new MiniAgent(deps, session)`：`deps` 的六个必填项见 {@link WorkerExecutor.depsFor}；
 * 5. `followup(工单文本)` 开跑；回调 `assignmentStarted`。
 *
 * ## 为什么 `start` 只写一行副作用，不在这里动手
 *
 * 端口契约写明「each method only queues work」（`core/ports.ts:55-69`）：`start` 是在
 * `Tickets.create` / `wake` 的写事务里被调的（`core/tickets.ts:54`）。在工作树里跑 git、
 * 读会话文件都是慢动作，放在事务里会把整库的写锁一起攥住。所以这里只往 `effect` 表写一行
 * （与上游 `executor/dsh.ts:264-268` 同形），真正的派工由 `EffectQueue` 在事务提交后的
 * microtask 里做。
 *
 * 为什么是表而不是内存数组：进程崩在「行已写、还没派工」那一刻，内存里的活就没了；表里的行
 * 会在下一次启动的第一拍被 `dispatch` 取到（`runtime.recover()` 的注释写了这一点）。反向也
 * 成立：入队与工单写在同一个事务里，事务回滚时行一起没，不会凭空派一张不存在的工单。
 *
 * ## 派工 handler 里的工单从哪来：**重读**，不用快照
 *
 * 上游 `launchQueued` 开头的三句（`executor/dsh.ts:270-273`）是重读工单、取最新分配、确认
 * 它还 `pending`；这里照做。代价是多一个只读的 `readTicket` 构造选项（`runtime.ts` 传
 * `repos.tickets.get`），换来的是崩溃恢复的正确性：**payload 里的工单快照会过期**。进程重启
 * 后工单可能已经被停、被重试换了分配，快照看不出来；照快照派工会给一张已结束的工单起 worker，
 * 还会把 `recover()` 刚换上的新分配踩掉。重读之后这类行在 handler 开头就返回，随后被队列删掉
 * ——正是上游的行为。`Executor` 端口一行没改：读工单不是端口要的责任，是执行器自己的构造选项。
 * `readTicket` 缺省时 handler 直接抛错让队列退避并记日志：宁可反复报错，也不拿一个可能过期的
 * 快照去派工。
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
 * - **报告由 worker 主动说，执行器只补缺省**：worker 多了一个 `superagent_report` 工具
 *   （`tools.ts`），能报 progress / ready / blocked / failed / dropped。工具调用时就写引擎
 *   （blocked 不必等回合结束才让人看见）；回合正常收尾时，本回合报过终态就不再补 `ready`——
 *   否则「在等人拍板」的工单会被一句 ready 收尾。`error` 仍然一律记 `failed`。
 *   没报过终态的回合照旧按「completed → ready」判。
 * - **没有 `rewrite` / 上下文注入**：worker 的环境事实（仓库、目录、分支）直接写进系统提示，
 *   不走主会话的 env-facts 投影，因此也没有「上下文注入」卡。压缩照常接（`compact`）。
 * - **临时故障重试三次**：`error` 事件命中 {@link transient} 时不立刻判失败，退避
 *   15 / 30 / 60 秒后用**同一条会话**再投一句「继续」。与上游 `resumeAfter` 同一套规则；
 *   差别只在「等 idle」那一步——`MiniAgent` 没有可等待的 idle 事件，用 `retryPending`
 *   标记让故障回合的 `turn/end` 先不报，等重试那一回合自己收尾。
 *
 * @module dsc/packages/superagent/adapters/executor
 */
import { spawn } from 'node:child_process'
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
import { latestAssignment, runningAssignment, type Assignment, type Executor, type EngineForExecutor, type Ticket,
  type TicketInput, type WorkerReport } from '../core/index.js'
import { LIMITS } from '../core/limits.js'
import { sessionsDir } from '../paths.js'
import type { EffectPayloads, EffectQueuePort } from './effects.js'
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
  /**
   * 工作区准备命令；可传 getter。空串 = 不跑。
   *
   * 建好工作树之后、建会话之前跑，失败即判 failed（不自动重试）。
   */
  prepare?: string | (() => string)
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
  /**
   * 持久化副作用队列（`adapters/effects.ts`）；不给 = 不派工（`start` 只记一条说明）。
   *
   * 为什么由构造参数传而不是执行器自己 new：队列要在运行期与 `pump`、`close` 共用一个实例
   * （`runtime.ts` 的生活周期比执行器长），两处各 new 一个会各自扫表、各自派工。
   */
  effects?: EffectQueuePort
  /**
   * 按 id 重读工单；派工与投递的 handler 靠它确认「这行还该不该跑」。
   *
   * 只读，不参与写：不给时 handler 直接抛错（见文件头「派工 handler 里的工单从哪来」）。
   */
  readTicket?: (ticketId: string) => Ticket | undefined
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
  /**
   * 临时故障的首次退避（毫秒），默认 {@link TRANSIENT_BACKOFF_MS}（15 秒）。
   *
   * 只给测试用：真实重试要等 15 / 30 / 60 秒，用例不能真等一分钟。
   */
  retryDelayMs?: number
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
  /**
   * 本回合 worker 用 `superagent_report` 报过的终态。
   *
   * 有它，`turn/end(completed)` 就不能再按缺省的 `ready` 报——worker 已经说了
   * 「我卡住了 / 我交付了」，执行器不该把前者改写成后者（backlog G7 要修的正是这个）。
   * `progress` 不记进来：它是中途进展，不是这一回合的结论。
   * 回合开始（`turn/start`）清掉，见 {@link WorkerExecutor.emitOf}。
   */
  reported?: WorkerReport
  /** 失败报告已发过：`error` 事件与随后的 `turn/end(error)` 只报一次。 */
  failedReported: boolean
  /**
   * 已用掉的临时故障重试次数（跨回合累计）。
   *
   * 上游把它存在执行器的一张 `Map` 里（`transient.get(assignment.id)`），这里挂在 worker 上：
   * 当前一个工单同一时刻只有一个 worker，挂在这里少一张要维护的映射。
   * 清零时机与上游一致：回合正常收尾、或 worker 被停。
   */
  transientTries: number
  /** 正在等退避重试：`turn/end(error)` 不报 failed，等重试那一回合重新收尾。 */
  retryPending: boolean
}

/**
 * 七件套：worker 只拿这些工具（设计文档 §6.2 的表格 + G7 的报告工具）。
 *
 * 报告工具必须在这里出现，否则 worker 拿到了工具名却调不到：`tools()` 是 worker 的
 * 全部目录，它按这张固定名单做减法，不看主会话的模式投影。
 */
const WORKER_TOOL_NAMES: readonly string[] = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'superagent_report']

/** 并发上限的缺省值：设计文档写 2；设置项可覆盖。 */
const DEFAULT_MAX_WORKERS = 2

/** 回合因 `completed` 收尾时的摘要下限；worker 一个字没留也得让工单上有句话。 */
const NO_SUMMARY = '（worker 这一回合没有留下文字总结，改动请看工作树）'

/** 把未知异常压成一行可读文本。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 临时故障的关键字：连接被拒 / 重置 / 超时 / 解析失败，以及模型端点的过载与限流。
 *
 * 与上游 `executor/dsh.ts:44-55` **逐项相同**——这份判据判错的后果是两头的：
 * 把配置错误当网络抖动重试三次（白等一分钟），或把抖动当配置错误直接判死。
 */
const TRANSIENT_PATTERN = new RegExp(
  [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR',
    'socket hang up', 'fetch failed', 'network error', 'overloaded', 'rate limit',
    '\\b(?:408|429|50[0-4])\\b',
  ].join('|'),
  'i',
)

/**
 * 这个错误算不算「过一会儿可能就好」。
 *
 * 先看 `status`：错误对象上带 HTTP 状态码时，`408` / `429` / `5xx` 就是临时故障，
 * 这是最准的一路判据。没有 `status` 才退到错误文本里找连接类关键字——上游也是这个顺序。
 *
 * @param error - 任何被抛出来的东西；不假设它是 `Error`
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}`
    : String(error)
  return TRANSIENT_PATTERN.test(text)
}

/** 临时故障最多重试几次（含第一次）。与上游 `TRANSIENT_TRIES` 一致。 */
export const TRANSIENT_TRIES = 3

/**
 * 在 `cwd` 里跑一条准备命令。
 *
 * 与上游 `prepareDirectory`（`executor/dsh.ts:247-262`）的差别只有两处：
 * 1. 上游跑在工单目录的**父目录**（目录由 prepare 建）；当前目录已经由 `git worktree` 建好，
 *    所以跑在树里——worker 的 cwd 就是那里，装依赖要装到它看得见的地方。
 * 2. 上游失败后 `rmdir` 空目录；当前不删树（那是 git 管的，删了要 `worktree remove`），
 *    靠「失败即判 failed、不自动重试」达到同一个效果：半成品不会被当成已准备好。
 *
 * 用 `shell: true` 而不是 `sh -c`：Windows 上没有 `sh`，上游那条路径在 DSC 的主要平台上跑不了。
 * 命令来自设置页（用户自己写的），本来就是给它执行用的，不存在工单标题那种注入面。
 *
 * @param command - 要跑的命令
 * @param cwd - 在哪跑
 * @param timeoutMs - 超时就杀掉
 * @returns 命令的输出（只留尾部）
 * @throws 起不来、超时、非零退出
 */
export function runPrepare(command: string, cwd: string, timeoutMs: number = PREPARE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-PREPARE_OUTPUT_LIMIT)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(new Error(`准备命令起不来：${error.message}`))
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`准备命令超过 ${String(Math.round(timeoutMs / 60_000))} 分钟，已杀掉`))
      else if (code !== 0) reject(new Error(`准备命令退出码 ${String(code)}：${output.trim().slice(-800)}`))
      else resolve(output)
    })
  })
}

/**
 * 首次退避 15 秒，之后每次翻倍：15 / 30 / 60 秒。
 *
 * 与上游 `TRANSIENT_BACKOFF_MS` 一致。三次合计一分四十五秒：抖一两分钟能自己好的，
 * 这一段时间够它好；抖一小时的（令牌过期、服务停用）本来就不是「临时故障」。
 */
const TRANSIENT_BACKOFF_MS = 15_000

/**
 * 工作区准备命令的超时：10 分钟。
 *
 * 与上游 `PREPARE_TIMEOUT_MS` 一致。超时的典型场景是命令卡在凭证提示上：不设上限，
 * 它会一直攥着一个并发名额，工单既不动也不报错。
 */
const PREPARE_TIMEOUT_MS = 10 * 60_000

/** 准备命令只留尾部这么多字符：装依赖会刷几千行，全留着没有信息量。 */
const PREPARE_OUTPUT_LIMIT = 4000

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
</交付要求>

<报告状态>
你有一个 superagent_report 工具，把状态说给工单，而不是只写在正文里：

- 需要人拍板才能继续（缺信息、要选方案、要动工单范围外的东西）：调 superagent_report，
  state 填 blocked，question 写清要人回答什么，然后停下等回复。只在正文里提问不算数——
  那句话会被并进摘要，工单照样按「干完了」收尾。
- 这一回合干完、可以交付：调 superagent_report，state 填 ready，summary 写清交付了什么。
- 确定做不下去：state 填 failed，summary 说明卡在哪。
- 中途有值得让人知道的进展（跑了很久、换了方案）：可以报一次 state=progress。
  它不是必须的，别每轮都报，也别拿它代替 ready。

只在真有必要时调；状态没变就别重复报。
</报告状态>`
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
 * 一个工单执行器：工作树 + 会话 + MiniAgent + 持久化并发队列。
 *
 * 生命周期：`start` 写一行 `launch` 副作用 → 队列的 handler 派工 → 回合事件写报告 →
 * `stop` 取消并让位。所有方法都可能在引擎的写事务里被调用，所以它们只做一次同步的入队；
 * 慢动作在 {@link WorkerExecutor.launch} 里，且已经在事务之外。
 */
export class WorkerExecutor implements Executor {
  private readonly host: WorkerHost | null
  /** 宿主没接上时缺的是什么（空数组 = 接上了）；降级日志要用它说清原因。 */
  private readonly hostProblem: string[]
  /** 仓库根的 getter：设置页改了路径，下一张工单不用重启就能用新值。 */
  private readonly repoOf: () => string
  /** 工作区准备命令的 getter；空串 = 不跑。 */
  private readonly prepareOf: () => string
  /** 持久化副作用队列；`start` / `deliver` 只往它里面写一行。 */
  private readonly effects: EffectQueuePort | undefined
  /** 按 id 重读工单（派工 / 投递的 handler 用）；见文件头的「重读，不用快照」。 */
  private readonly readTicket: ((ticketId: string) => Ticket | undefined) | undefined
  /** 「没接 effect 队列」只提醒一次：`start` 会被反复调，重复刷屏没有信息量。 */
  private warnedNoEffects = false
  /**
   * 准备阶段就被停掉的分配 id。
   *
   * 为什么需要它：`stop` 只能停「已经有 worker」的工单；而准备命令是异步的，这期间
   * `workers` 里还没有这个 worker，停不下来。记下 id，准备结束后据此放弃派工——
   * 否则用户点了停止，worker 过一分钟还是起来了。
   */
  private readonly cancelled = new Set<string>()
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
  /**
   * 已请求停止、但回合还在收尾的 worker。
   *
   * 它们已经让出「干活」名额（`workers` 里没了），但回合还没跑完，会话也还开着；
   * 并发上限要按「活着的 agent」算，所以这一段也要占坑，等 `onIdle` 关掉会话才放行
   * 下一个（见 `terminate` / `closeSession`）。
   */
  private readonly retiring = new Set<Worker>()
  /** 「缺工具」只提醒一次：`tools()` 每轮请求都调，重复刷屏没有信息量。 */
  private missingToolsWarned = false
  private disposed = false
  /** 临时故障重试的退避定时器；`dispose` 时全部清掉，不留一个在宿主卸载后还回调。 */
  private readonly retryTimers = new Set<NodeJS.Timeout>()
  /** 临时故障的首次退避（毫秒）；测试注入 0，免等。 */
  private readonly retryDelayMs: number

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
    const prepare = options.prepare ?? ''
    this.prepareOf = typeof prepare === 'function' ? prepare : () => prepare
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
    this.effects = options.effects
    this.readTicket = options.readTicket
    this.readTriggerText = options.readTriggerText
    this.worktree = options.worktree ?? { ensure: ensureWorktree }
    this.createSession = options.createSession ?? ((cwd, file) => Session.create(cwd, file))
    this.createAgent = options.createAgent ?? ((deps, session) => new MiniAgent(deps, session))
    this.retryDelayMs = options.retryDelayMs ?? TRANSIENT_BACKOFF_MS
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
    // 两个 handler 在这里登记（与上游 `executor/dsh.ts:232-235` 同一位置）：
    // 名额要读 `workers` / `retiring`，只有执行器自己算得出来；运行期只负责建队列与驱动它。
    if (this.effects !== undefined) {
      this.effects.handle('launch', payload => this.launchQueued(payload), {
        limit: () => this.launchCapacity(),
        // 上游 `executor/dsh.ts:233`：派工失败先 5 秒后重试，最长 5 分钟。
        retry: [5000, 300_000],
      })
      // 投递失败已经落在工单的 `ticket.delivery` 上（`core/assignments.ts:72-77`），
      // 不再让健康项跟着报 error（`quiet`），否则一次投递失败会在两处各报一遍。
      this.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => 4, quiet: true })
    }
  }

  /** 正在干活的 worker 数（并发上限的分子）；测试与诊断用。 */
  get activeCount(): number {
    return this.workers.size
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
   * 按会话反查 worker 并记一条报告——`superagent_report` 工具的落点。
   *
   * 为什么按会话 id 而不是工单 id：工具只拿得到 `ToolContext`，模型根本不知道工单 id
   * （那是执行器的内部账）。`ctx.sessionId` 的来源就是 `Session.meta.id`
   * （`session-core/loop.ts:711-713`），两边对得上。
   *
   * 找到了就**立刻**写引擎，不等回合结束：`blocked` 要马上让工单停下来等人，
   * `progress` 要马上更新摘要。`progress` 不记进 `worker.reported`——它是中途进展，
   * 不是这一回合的结论，回合正常收尾仍该按 `ready` 报一次（见 {@link emitOf}）。
   *
   * @param sessionId - 发起调用的会话（`ToolContext.sessionId`）
   * @param report - 状态、摘要与（仅 blocked 时的）问题
   * @returns true = 这条会话确实属于一个在跑的 worker（找到即真；引擎写失败只记日志）
   */
  reportBySession(sessionId: string, report: WorkerReport): boolean {
    for (const worker of this.workers.values()) {
      if (worker.session.meta.id !== sessionId) continue
      if (this.report(worker, report) && report.state !== 'progress') worker.reported = report
      return true
    }
    return false
  }

  /**
   * 引擎要求派工：只往 `effect` 表写一行，真正的派工在队列的 handler 里（理由见文件头）。
   *
   * 同一个 (工单, 分配) 重复调用由表主键合并成一行（`ON CONFLICT(kind,key)`）：
   * `Tickets.addInput` 在待派工阶段会反复调 `start`（`core/tickets.ts:244`），合并保住
   * 「重复建树白跑 git、worker 建两份」这条老约束，同时把最新入队时刻（due）刷新回来。
   */
  start(ticket: Ticket, assignment: Assignment): void {
    if (this.disposed) return
    if (this.host === null) {
      this.log(
        `[superagent] 工单 ${ticket.id} 停在待派工：执行器缺 ${this.hostProblem.join('、') || '宿主服务'}，没有启动 worker`,
      )
      return
    }
    if (this.effects === undefined) {
      if (!this.warnedNoEffects) {
        this.warnedNoEffects = true
        this.log('[superagent] 执行器没有接 effect 队列：工单会停在待派工，不会启动 worker')
      }
      return
    }
    const existing = this.workers.get(ticket.id)
    if (existing !== undefined) {
      if (existing.assignmentId === assignment.id) return
      // 同一张工单换了新分配（重试 / 恢复）：旧 worker 先让位，再排新的。
      this.terminate(existing, '新分配接管')
    }
    this.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /**
   * 把未送达的 Input 递给 worker：只入队，投递动作在 `deliverQueued` 里逐条重读工单再做。
   *
   * 为什么不在事务里直接 `followup`：`deliver` 也是在 Engine 的写事务里被调的
   * （`core/assignments.ts:41`），而 `followup` 会碰会话文件。入队之后，投递失败还能按
   * `delivery` 的退避重试，而不是一次异常丢掉一条消息。
   */
  deliver(ticket: Ticket, _assignment: Assignment): void {
    if (this.disposed) return
    if (this.effects === undefined) return
    this.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
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
    if (worker === undefined) {
      // 还在准备阶段（建树 / 跑准备命令）：没有 worker 可停，记下来让准备结束后放弃派工。
      // 不记的话用户点了停止，一分钟准备命令跑完，worker 照样起来。
      this.cancelled.add(assignment.id)
      this.log(`[superagent] 工单 ${ticket.id} 在准备阶段收到停止，准备结束后不再派工`)
      return
    }
    if (worker.assignmentId !== assignment.id) return
    this.terminate(worker, reason)
  }

  /**
   * 退出插件时的收摊：取消所有 worker、关闭会话、停掉队列。重复调用是空操作。
   *
   * 不删 `effect` 表里的行：那些是「还没做、或没做完」的活，删了就丢；`drain` 只让队列不再
   * 起新活、等正在跑的收尾，剩下的行留给下一次启动（`runtime.close()` 的注释同理）。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // 准备阶段被停的记录一并清掉：插件都要卸了，没有「准备结束」这一刻了。
    this.cancelled.clear()
    // 退避中的重试全部作废：插件都要卸了，回调里那一句「继续」没有接收方。
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    for (const worker of [...this.workers.values()]) this.terminate(worker, '执行器关闭')
    // 收尾中的 worker 已经不在 `workers` 里（见 `terminate`），但会话还开着；
    // 插件都要卸了，不再等它的 `onIdle`。
    for (const worker of [...this.retiring]) this.closeSession(worker)
    // 停新活：正在跑的 handler 会自己收尾（失败的那一行因 `stopped` 原样留在库里）。
    void this.effects?.drain()
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
   * 模型面前的那份工具目录：只挑七件套（设计文档 §6.2 的表格 + 报告工具）。
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

  /**
   * 现在还能起几个 worker（`launch` 的 `limit`）。
   *
   * **不再减「正在准备的派工数」**：`EffectQueue.dispatch` 已经用「本 kind 正在跑的 handler 数」
   * 扣过一次名额（`effects.ts` 里 `room = limit() - running.size`），执行器的 handler 就是那些
   * 在跑的 handler；这里再减一遍会重复计数。具体后果：上限 2、A 正在准备（占 1 个）时 B 入队，
   * 两处各减一次会把 B 卡到 A 派工完成之后——并发上限被压成串行。上游的
   * `WorkerSlots.launches()`（`executor/dsh.ts:182-185`）同样只减正在跑的 worker，不减 launch
   * 预约，正是这个原因。
   *
   * `retiring` 要算：收尾中的 worker 会话还开着，它是一个活着的 agent。
   */
  private launchCapacity(): number {
    return Math.max(0, this.maxWorkers - (this.workers.size + this.retiring.size))
  }

  /**
   * `launch` 的 effect handler：确认这一行还该跑，然后真正派工。
   *
   * 开头三句与上游 `executor/dsh.ts:270-273` 逐条对齐：
   * 1. 重读工单——payload 里只有 id，没有会过期的快照（理由见文件头）；
   * 2. 取最新分配，必须还是这行说的那一份（重试 / 恢复可能已经换了分配）；
   * 3. 分配必须还是 `pending`（已经跑起来的、已经结束的都不该再派一次）。
   * 三条任一不成立就返回，行随即被队列删掉——这就是「崩溃后表里的旧行不会乱派工」。
   *
   * @throws 没有 `readTicket` 时抛错：宁可让队列退避并报错，也不拿可能过期的快照派工
   */
  private async launchQueued({ ticketId, assignmentId }: EffectPayloads['launch']): Promise<void> {
    if (this.disposed) return
    if (this.readTicket === undefined) {
      throw new Error('执行器没有工单读取口（readTicket），无法确认这次派工还该不该做')
    }
    const ticket = this.readTicket(ticketId)
    const assignment = ticket === undefined ? undefined : latestAssignment(ticket)
    if (
      ticket === undefined ||
      ticket.ended !== undefined ||
      assignment?.id !== assignmentId ||
      assignment.state !== 'pending'
    ) {
      return
    }
    // `launch` 自己接住所有异常并落成 failed 报告，不往外抛：派工失败重试没有意义
    // （准备命令失败会把半成品当已准备好，与上游 `PrepareFailed` 同一取舍）。
    await this.launch(ticket, assignment)
  }

  /**
   * `delivery` 的 effect handler：逐条重读工单，把未送达的输入递给正在跑的 worker。
   *
   * 为什么逐条重读而不是一次把整批发出去（上游 `executor/dsh.ts:290-328` 同一结构）：
   * 发一条就会调一次 `inputsDelivered` 改库；两条之间工单可能被停、分配可能被换。
   * 一次读一份快照发整批，就会出现「前两条发出去了、后两条发给了一个已经结束的分配」。
   *
   * 失败照上游的顺序处理：先确认工单还由这份分配跑着，再记 `deliveryFailed`，然后把错误
   * 抛给队列退避重试（`quiet`：失败信息已经在工单上了）。
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    if (this.disposed || this.readTicket === undefined) return
    const engine = this.engineOf?.()
    if (engine === undefined) {
      this.log(`[superagent] 工单 ${ticketId} 的输入投递没有引擎可用：跳过这一行`)
      return
    }
    for (;;) {
      const ticket = this.readTicket(ticketId)
      if (ticket === undefined || ticket.ended !== undefined) return
      const assignment = runningAssignment(ticket)
      const inputId = ticket.undelivered[0]
      if (assignment === undefined || inputId === undefined) return
      const worker = this.workers.get(ticketId)
      // 没有 worker 就没有会话可投；这份行到此为止（下一次 `assignmentStarted` 会重新入队）。
      if (worker === undefined || worker.assignmentId !== assignment.id || worker.stopping || worker.agent === null) return
      const input = ticket.inputs.find(item => item.id === inputId)
      // 库里记着这个 id、inputs 里却没有：再投也投不出内容，留着只会死循环。删行并记一句。
      if (input === undefined) {
        this.log(`[superagent] 工单 ${ticketId} 的输入 ${inputId} 在 inputs 里找不到，跳过`)
        return
      }
      try {
        worker.agent.followup(this.inputsText(ticket, [inputId]))
        engine.inputsDelivered(ticketId, assignment.id, [inputId])
      } catch (error) {
        this.log(`[superagent] 工单 ${ticketId} 的输入投递失败：${describe(error)}`)
        try {
          engine.deliveryFailed(ticketId, assignment.id, describe(error).slice(0, 300))
        } catch (inner) {
          this.log(`[superagent] 投递失败也未能记进工单 ${ticketId}：${describe(inner)}`)
        }
        // 抛给 EffectQueue：它会按 delivery 的退避（默认 2s 起）再试，行不会丢。
        throw error
      }
    }
  }

  /**
   * 真正派工：建工作树 → 建会话 → 钉权限 → 造 agent → 投工单文本 → 告诉引擎。
   *
   * 这里跑在事务之外（见文件头）。任何一步失败都落成一张 `failed` 报告，且把已经建出来的
   * 会话关掉；错误不往外抛——外抛会让 `launch` 的 effect 行带着退避一直重试，而准备命令失败
   * 重试只会把半成品当已准备好。
   */
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    let session: Session | null = null
    let worker: Worker | null = null
    try {
      const repo = this.repoOf().trim()
      if (repo === '') throw new Error('没有配置仓库路径（设置 → Super Agent → repoPath），无法建工作树')
      if (this.engineOf === undefined) throw new Error('执行器没有引擎回调，报告没有出口')
      const name = worktreeNameOf(ticket)
      const handle = this.worktree.ensure({ repo, name, base: this.base, root: this.root })
      // 准备命令：建树之后、建会话之前。失败直接抛，由下面的 catch 判 failed——
      // 不自动重试（与上游 `PrepareFailed` 同一条取舍：重试只会把半成品当已准备好）。
      const prepare = this.prepareOf().trim()
      if (prepare !== '') {
        this.log(`[superagent] 工单 ${ticket.id} 跑准备命令：${prepare}`)
        const startedAt = Date.now()
        await runPrepare(prepare, handle.path)
        this.log(`[superagent] 工单 ${ticket.id} 准备命令完成（${String(Date.now() - startedAt)}ms）`)
      }
      // 准备期间被停掉 / 插件被卸：不再往下走（见 `cancelled`）。
      if (this.cancelled.delete(assignment.id)) {
        this.log(`[superagent] 工单 ${ticket.id} 在准备阶段被停，放弃派工`)
        return
      }
      if (this.disposed) return
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
        transientTries: 0,
        retryPending: false,
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
      this.cancelled.delete(assignment.id)
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
   * | `tools` | 七件套（`tools()`） |
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
      // 上一回合的终态不许漏到这一回合：新回合没再报，就按这一回合自己的收尾判。
      delete worker.reported
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
      // 临时故障先安排重试：这一步**不**报 failed，等重试那一回合的收尾再判。
      // 与上游 `executor/dsh.ts:509` 的 `if (this.retries(...)) { this.resumeAfter(...); return }` 同一顺序。
      if (this.retryTransient(worker, event.message)) return
      worker.failedReported = true
      this.report(worker, errorReport(event.message))
      return
    }
    if (event.type === 'turn/end') {
      this.turnEnded(worker)
      if (worker.stopping) return
      // 正在等退避重试：这一回合的收尾不算数。重试那一回合会重新走一遍 turn/end，
      // 那时 `retryPending` 已清，按正常收尾判。
      if (worker.retryPending) {
        worker.retryPending = false
        return
      }
      // 回合正常收尾 → 临时故障计数清零。上游在 `workerIdle` 里做同一件事
      // （`executor/dsh.ts:606`：`this.transient.delete(idle.id)`），理由是一回合干净跑完
      // 就说明「上次那个故障过去了」，下一次该重新给三次机会。
      if (event.reason === 'completed') worker.transientTries = 0
      // 本回合 worker 已经用 `superagent_report` 报过终态：那个状态就是结果，不能再按
      // `completed` 补一条 `ready`——否则「等人拍板」的工单会被一句 ready 收尾，
      // 正是 G7 要修的症状。也不重复写同一条：工具调用时已经写进引擎了，
      // ready / dropped 已经结束工单，再写只会撞 `ticketEnded` 白记一行日志。
      // error 不走这里：出错一律按 failed 报，见下面。
      if (event.reason === 'completed' && worker.reported !== undefined) return
      const report = event.reason === 'error' && worker.failedReported
        ? null
        : turnEndReport(event.reason, worker.lastText, worker.lastError)
      if (report !== null) this.report(worker, report)
    }
  }

  /** 报告写回引擎；失败只记日志。返回值表示这次报告有没有真的写进去（工具据此决定记不记终态）。 */
  private report(worker: Pick<Worker, 'ticketId'>, report: WorkerReport): boolean {
    const engine = this.engineOf?.()
    if (engine === undefined) {
      this.log(`[superagent] 工单 ${worker.ticketId} 的报告没有引擎可写：${report.state}`)
      return false
    }
    try {
      engine.report(worker.ticketId, report)
      return true
    } catch (error) {
      this.log(`[superagent] 工单 ${worker.ticketId} 的 ${report.state} 报告未记入：${describe(error)}`)
      return false
    }
  }

  /**
   * 临时故障：安排一次「继续」重试。
   *
   * 与上游 `resumeAfter`（`executor/dsh.ts:554-576`）同一套规则：
   * 1. 只对 `transient()` 认的错误重试；配置类错误一次都不重试（否则白等三次退避）。
   * 2. 最多 {@link TRANSIENT_TRIES} 次，退避 `15s × 2^(n−1)`：15 / 30 / 60 秒。
   * 3. 重试用**同一条会话**再投一句「继续」，不新建会话——工作树、分支、上下文都还在；
   *    新建会话等于让 worker 从零开始，前面干了一半的活它看不见。
   *
   * 与上游的一处差异：上游把「继续」投进会话后还等 `whenIdle` 再判收尾；这里的
   * `MiniAgent` 没有可等待的 idle 事件，所以靠 `retryPending` 标记让 `turn/end(error)`
   * 先不报 failed，等重试那一回合自己收尾。语义一样：故障回合不算交付。
   *
   * @param worker - 出错的 worker
   * @param message - `error` 事件带的原文
   * @returns true = 已安排重试，调用方不要再报 failed
   */
  private retryTransient(worker: Worker, message: string): boolean {
    if (!transient(message)) return false
    if (worker.transientTries >= TRANSIENT_TRIES) {
      this.log(`[superagent] 工单 ${worker.ticketId} 临时故障已达 ${String(TRANSIENT_TRIES)} 次上限，不再重试`)
      return false
    }
    worker.transientTries += 1
    worker.retryPending = true
    const delay = this.retryDelayMs * 2 ** (worker.transientTries - 1)
    this.log(
      `[superagent] 工单 ${worker.ticketId} 临时故障，${String(delay)}ms 后第 ${String(worker.transientTries)} 次重试：` +
        message.slice(0, 120),
    )
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      // 等退避的这一段时间里，工单可能已被停、宿主可能已卸、worker 可能已换：都不该再投消息。
      if (this.disposed || worker.stopping) return
      if (this.workers.get(worker.ticketId) !== worker) return
      worker.agent?.followup(
        `你的上一回合因为临时故障失败（${message.slice(0, 200)}）。请从中断处继续这个工单，不要从头再来。`,
      )
    }, delay)
    timer.unref?.()
    this.retryTimers.add(timer)
    return true
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
    // 停掉的 worker 不再重试；计数一并清掉，与上游 `stop()` 里的 `transient.delete(assignment.id)` 同义。
    worker.transientTries = 0
    worker.retryPending = false
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
    // 一个名额刚让出来：催一拍队列，等着的派工不必等下一次泵。
    this.effects?.kick()
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
    // 收尾中的 worker 到这里才真正让位（见 `terminate` 与 `launchCapacity`）。
    this.effects?.kick()
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
