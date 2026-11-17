/**
 * 移植自上游 `dsh-superagent/src/app/runtime.ts`（252 行，原生重写）。
 *
 * 上游职责不变：应用组合根与生命周期管理器——先锁状态目录，再开编排库，然后把
 * `Store` / `Setup` / `Prompts` / `Engine` / `SourceRegistry` / `Effects` / `Outbox` / `Passes` /
 * `Sessions` / `Settings` / `DshExecutor` / `MasterAssessor` 接成一个能用的运行期，把
 * `SourceHost` 服务暴露给来源插件，并按「启动 → 就绪 → 停止」管生命周期。
 *
 * ## 与上游的差异（逐条；全是 DSH 能力换本仓原生能力，语义不变）
 *
 * 1. **不继承 cordis 的 `Service`**：上游 `super(ctx, 'orchestrator')` 让 cordis 自动登记
 *    `ctx.orchestrator`。本仓 20 多个服务都是「普通类 + `ctx.provide(name, value)`」
 *    （`service.ts:66-73` 的注释写着这条规矩），所以本类改成 `implements SourceHost`，构造时
 *    `this.ctx.provide('orchestrator', this)`；自动注销仍由插件 fiber 负责。`Context` 存成
 *    `readonly ctx`（上游 `Service` 的 protected `ctx`，这里公开给 W9 入口与镜像模块用）。
 * 2. **锁定状态目录**：上游 `proper-lockfile` 的 `lockSync(machine.stateDir, { stale: 30_000,
 *    onCompromised })`（本仓没有这个依赖）→ `@pneuma/runtime/core/lockfile.js` 的
 *    `acquireLock(machine.stateDir)`（先 OS 原生互斥，底座不可用退回 pid/birth 文件锁，同进程可重入）。
 *    OS 锁的持有者是内核对象，没有「锁被抢走」这回事，所以 `onCompromised` 那段（写体检项 + abort）
 *    没有对应物；拿不到锁时 `acquireLock` 返回 `null`，本类当场抛错（上游由 `lockSync` 自己抛）。
 * 3. **`machine.promptMaxChars.get()` → `machine.promptMaxChars`**：上游 `Machine` 的四个可调项是
 *    DSH `Volatile<number>`（带 `get()`）；本仓 `deployment.ts:44-49` 的 `Machine` 是普通数字。
 * 4. **DSH 宿主服务换本仓原生口**（这是本文件的主要工作量）：
 *    - `ctx.agents.get(id)` → `this.sessions.agent(id)`（`app/sessions.ts:343-344` 的等价口）；
 *      `agent.cancel(...)` / `agent.whenIdle()` → `SessionHandle` 的同名成员
 *      （`app/sessions.ts:109-111`）。
 *    - `ctx.sessionPersistence.flush()` → 删掉。本仓会话日志是同步追加（`role-models.ts:15`
 *      已记过这条），关会话时由 `Session.close()` 收尾（`app/sessions.ts:614-631` 的 `dispose()`），
 *      没有单独要 flush 的持久化服务。
 *    - `ctx.sessionController.modelCatalog()` 只被上游 HTTP 层用来列模型，随 HTTP 段一起不移植。
 *    - `@deepseek-ai/dsh-*` 的 type-only import（`dsh-agent` / `dsh-session` /
 *      `dsh-api-session-controller` / `dsh-session-persistence` / `dsh-workspace` /
 *      `dsh-permission-presets` / `dsh-system-prompt` / `dsh-tools` / `dsh-skill` /
 *      `dsh-subprocess`）全部删掉：那些包在本仓不存在，能力已由上面的原生口替代。
 *    - 「权限」不在本文件装配：上游那行 type-only import 只为 `permissionPresets.set(...)` 的类型，
 *      实际钉权限在 `Sessions.ensure` 里 `writePermissions(session, { sandbox: 'danger-full-access', ... })`
 *      （`app/sessions.ts:313-314`）。
 * 5. **不移植 HTTP 服务段**：上游 `initialize()` 第一句 `this.disposers.push(registerHttp(this.ctx,
 *    this.httpHost()))`（以及 `httpHost()` / `HttpHost` / `views/records.ts` 的 `LinkTarget` 在 HTTP
 *    层的用法）不搬。原因：本仓没有 `ctx.webServer` 那套管理面板路由；DSC 的面板走
 *    `INVOKABLE_METHODS` + 快照面（旧 `service.ts` / `surface.ts`），由 W9 的插件入口接。
 *    HTTP 段**只**做两件事：把运行期成员包成路由宿主、`models()` 调 `sessionController.modelCatalog()`；
 *    前者在 W9 直接读本类的公开成员即可，后者本仓换成 `ctx.llm.listModels()`（`services/types.ts:179`），
 *    不需要在运行期里再包一层。因此上游的 `disposers` 列表（里面只放 HTTP 路由注销函数）一并删掉。
 * 6. **来源启动不在本文件**：上游来源是独立 cordis 插件（`github-watch` / `feishu-watch`），
 *    `apply` 里拿 `ctx.orchestrator` 干活，`runtime.ts` 本身不起来源。本仓来源模块导出了
 *    `startGithub(host, signal)` / `startFeishu(host, signal)`（`sources/github.ts:134`、
 *    `sources/feishu.ts:154`），由 W9 的插件入口以本类为 `SourceHost`、以 `runtime.lifetime` 为
 *    停止信号启动——与上游「来源插件晚于运行期起来」的先后顺序一致。任务口径里「来源启动」那一步
 *    属于 W9 入口，不在 252 行里，这里如实说明。
 * 7. **`Engine` 多了必填的 `now`**：本仓 `core/part.ts:16-20` 的 `EngineOptions.now` 是必填（核心
 *    不读环境时钟），上游 `Engine` 缺省 `new Date()`。本类传同一个 `new Date().toISOString()`，
 *    与体检项的时间口径一致。
 *
 * 其余逐字保留：公开成员（`store` / `setup` / `prompts` / `effects` / `sources` / `commands` /
 * `sessions` / `settings` / `executor` / `assessor` / `outbox` / `engine` / `passes` / `ready` /
 * `masterId` / `health` / `lifetime` / `deployment` / `setupProblem` / `feishuProblem`）、装配顺序、
 * 判定顺序（`closing()` / `paused()` 的每个回调都现读）、错误与日志文案、`initialize()` 的启动顺序、
 * `shutdown()` 的收尾顺序、`stop()` 的幂等语义都没动；英文 doc 注释保留原文。
 *
 * @module dsc/packages/superagent/app/runtime
 */
/** Application composition root and lifecycle manager for dsh-superagent. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { acquireLock, type FileLock } from '@pneuma/runtime/core/lockfile.js'
import { Engine, key, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.js'
import { settingsPolicy } from '../core/policy.js'
import { SourceRegistry } from '../sources/registry.js'
import { Commands } from '../infra/commands.js'
import type { Deployment, Machine } from '../deployment.js'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.js'
import type { SetupProblem } from '../setup.js'
import { DshExecutor, sourceTrigger, workerSessionId } from '../executor/dsh.js'
import { MasterAssessor } from './assessment.js'
import { KV } from '../kv.js'
import { Store } from './store.js'
import { evalsHealth } from './views/overview.js'
import type { LinkTarget } from './views/records.js'
import { TextCache } from './cache.js'
import { Effects } from './effects.js'
import { Prompts } from './prompts.js'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.js'
import { eventNotice, followupNotice } from './notices.js'
import { pullEndNotices } from '../sources/github-pull.js'
import { HealthBoard } from '../infra/health.js'
import { Outbox } from './outbox.js'
import { Passes } from './passes.js'
import { Setup } from './setup.js'
import { feishuSettings } from '../sources/feishu.js'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.js'
import { Sessions } from './sessions.js'
import { Settings } from './settings.js'
import { sourceContextOf, type SourceContextDeps } from './source-context.js'
import type { ResourceHost } from './resources.js'
import { mainTools, type MainToolsHost } from './tools/main.js'
import { executorTools, type ExecutorToolsHost } from './tools/executor.js'

// 来源插件只经 `ctx.orchestrator`（即本类）与 dsh-superagent 交互——与上游同一份服务面。
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private releaseLock?: FileLock
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  /**
   * @param ctx - Cordis context of the plugin; the composed services read their host services from it and
   *   `orchestrator` is provided on it for Source plugins.
   * @param machine - Machine limits read from the plugin configuration.
   * @param restart - Restarts the plugin so setup runs again after account CLI changes.
   */
  constructor(readonly ctx: Context, readonly machine: Machine, restart: () => void) {
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const release = acquireLock(machine.stateDir)
    // 上游 lockSync 拿不到锁自己抛；原生 acquireLock 用 null 表示「别的活进程拿着」，这里换成同一时机的一行错。
    if (release === null) throw new Error(`Another process holds the state directory lock: ${machine.stateDir}`)
    this.releaseLock = release
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars, deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), now: () => new Date().toISOString(), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      // 契约层要求 `SourceHost` 服务可用；W9 入口与来源插件都从 `ctx.get('orchestrator')` / 同名字段拿它。
      ctx.provide('orchestrator', this)
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release.release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops, cancelling running reads and subprocesses (native OS locks cannot be lost, so there is no compromised-lock abort). */
  get lifetime(): AbortSignal { return this.stopped.signal }
  /** Returns one Source kind's scoped context; its `report` can only write the health entries that kind declares. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // HTTP 段不移植（见文件头第 5 条）：上游在这里先注册管理面板路由，DSC 的面板走 INVOKABLE_METHODS + 快照面，由 W9 接。
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      // 上游 `ctx.agents.get(id)` 换成本仓会话管理器现查；不属于本模块的 id 直接没有句柄。
      const agents = ids.flatMap(id => this.sessions.agent(id) ?? [])
      // 上游 DSH 的 `agent.cancel({ kind: 'user' }, { keepInbox: true })` 是两个参数；本仓 `SessionHandle.cancel`
      // 把「停谁 / 留不留收件箱」合成一个选项对象（`app/sessions.ts:110-111`、`:219-228`）。
      for (const agent of agents) agent.cancel({ kind: 'user', keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      // 上游 `await this.ctx.sessionPersistence.flush()` 没有对应物：`sessions.dispose()` 里的 `Session.close()`
      // 已经把同步追加的日志收尾（见文件头第 4 条）。
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; releasing an OS lock twice is harmless.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        try { this.releaseLock?.release() } catch (error) { unreleased(error) }
      }
    }
  }
}
