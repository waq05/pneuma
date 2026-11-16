/**
 * 移植自 dsh-superagent/src/app/sessions.ts（352 行，原生重写）。
 *
 * 上游职责不变：建主会话与执行者会话、按角色选 preset、把会话事件路由给通知中继、
 * 按 request id 幂等投递、把模型预算重试的状态投影到 `models` 体检项、把每个会话跑过的
 * 提示词修订记进 `KV.sessions.prompts`。
 *
 * ## 与上游的差异（逐条，都是 DSH 能力换成本仓原生能力；语义不变）
 *
 * 1. **会话与 agent 由本模块自己造**：上游 `ctx.sessionController.resolveAgent/create` 建 DSH
 *    会话、`agent/created` 事件回来装饰。本仓用 `Session.load/create` 建会话、`new MiniAgent`
 *    建循环（与 `adapters/executor.ts` 的 worker、`subagent/index.ts` 的队友同一条路），
 *    所以 `ensure` 直接返回句柄、`decorate` 不再等 `agent/created`。
 * 2. **逻辑会话 id 落成 `Session.meta.id`**：本仓 `Session.create` 只会生成随机 uuid，因此新会话
 *    先按上游的逻辑 id（`worker-<ticketId>` / `KV.runtime.masterId`）写一行 meta 再 `Session.load`
 *    ——与 `subagent/index.ts:686-691` 的 seed 写法同源。这样 `ticketOfSession(agent.id)`、
 *    工具的 `ToolContext.sessionId`、`Sessions.prompt(sessionId)` 三处仍然是同一个 id。
 * 3. **preset**：本仓没有 DSH 的 agent preset 注册表（工具目录由全局注册表 + 投影决定）。角色在
 *    `ensure` 时定下，`WORKER_PRESET` / `ROUTER_PRESET` 作为可观测的落账写进会话日志的 note；
 *    `routed()` 读这条 note，读不到时按角色兜底（上游读投影，读不到按 `standard` 兜底，同一取舍）。
 * 4. **装饰落点**：上游在 agent 的 `systemPrompt.section` / `tools.register` / `restrict` /
 *    `guard` / skill scope 上登记。本仓这些能力都在 `MiniAgent` 的 `AgentDeps` 闭包里：
 *    系统提示 = `systemPrompt()`、工具目录 = `tools()`、守卫 = `guards()`、技能 = 插件级
 *    `ctx.skills.registerProvider`（按当前修订现读，不再按 agent 作用域绑定，故上游的
 *    `bindSkills` 取消）。因此 `decorate` 只做「记账 + 把会话登记进内核会话表」。
 * 5. **`install()`**：上游订阅 `agent/created`/`agent/disposed`/`session/event`/`agent/status`/
 *    `agent-preset/selected` 五路事件。本仓的会话都是本模块自己造的，事件经 `AgentDeps.emit`
 *    直接到手，没有「别人的 agent 被创建」这回事；`routed()` 也不依赖 preset 投影。剩下的
 *    只有退出兜底：宿主退出时收摊所有 agent。
 * 6. **`limitSubagent`**：上游给 worker 派出的子智能体加同样的工具限制。本仓子智能体由
 *    subagent 插件自己造、自己设限，本模块没有「子智能体被创建」的触发点，故取消这个方法。
 * 7. **模型重试账**：`RetryHealth` 是逐字移植的（它要 `{ type, seq, time, data }` 事件）。
 *    本仓 `CoreEvent` 没有序号，`observeRetry` 按会话自己数 turn/step 再合成同样形状的事件；
 *    `restore()` 无法做——本仓会话日志里没有事件序号快照，重启后重试状态从零开始（上游能回放）。
 * 8. **权限**：上游 `permissionPresets.set(..., 'danger-full-access')`；本仓用
 *    `writePermissions(session, { sandbox: 'danger-full-access', policy: 'full-access', reviewer: 'user' })`。
 * 9. **rename**：上游改 DSH 会话标题；本仓写会话 sidecar（`patchSessionMeta`），不碰 append-only 日志。
 * 10. **`host.tools`**：上游返回待注册的 `Tool` 定义（DSH 按 agent 注册）。本仓工具是全局注册表，
 *     模型看到的目录按会话挑，所以 host 直接给 `ToolEntry[]`（含 risk，守卫链要用）。
 *
 * @module dsc/packages/superagent/app/sessions
 */
/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker Sessions. */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Session, type AsyncInboxItem } from '@pneuma/runtime/core/session.js'
import type { LlmRoute, StreamHandlers, StreamRequest, StreamResult } from '@pneuma/runtime/core/llm.js'
import type { CoreEvent } from '@pneuma/runtime/core/events.js'
import type { ContextInjectionView, EffortLevel, PromptSectionView } from '@pneuma/runtime/contract.js'
import type { SkillDefinition, SkillSummary } from '@pneuma/runtime/core/skills.js'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { ToolGuardChain, ToolGuardInput } from '@pneuma/runtime/core/tool-guards.js'
import { patchSessionMeta } from '@pneuma/runtime/core/session-meta.js'
import type { AgentService, CompactService, LlmService, PromptService, SkillProvider, ToolService } from '@pneuma/runtime/services/types.js'
import { MiniAgent, type AgentDeps } from '@pneuma/session-core/loop.js'
import { writePermissions } from '@pneuma/permission-core/permission-scope.js'
import { key, liveTicket, type Ticket } from '../core/index.js'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.js'
import type { HealthEntry } from '../infra/health.js'
import { superagentRoot, sessionsDir } from '../paths.js'
import { AgentDelivery, messageId, requestIdOf, type PromptedId } from './delivery.js'
import type { Effects } from './effects.js'
import type { Variable } from './execution-environment.js'
import { RetryHealth, type RetryHealthEvent } from './retry-health.js'
import { initializeRoleModel } from './role-models.js'
import { bundledSkills } from './skill-files.js'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.js'
import type { Store } from './store.js'
import { KV } from '../kv.js'

/** 会话日志里记「这条会话跑哪个 preset」的 note id（见文件头第 3 条）。 */
const PRESET_NOTE = 'superagent-preset'
/** 本插件注册的技能来源名与重名裁决 rank（外部插件建议 500+，见 SkillProvider 的注释）。 */
const SKILL_PROVIDER = 'dsh-superagent'
const SKILL_RANK = 500

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 本模块管理的会话开始 / 完全空闲（对应上游 DSH 的 `agent/status`）。 */
    'superagent/agent-status'(payload: { agent: SessionHandle; status: 'idle' | 'running' }): void
    /** 排进收件箱、后来被出账消费的一条投递（对应上游 `agent/inbox/claimed`）。 */
    'superagent/inbox-claimed'(payload: { agent: SessionHandle; sessionId: string; origin: 'user' | 'notice' }): void
    /** 某条按 request id 投的消息真正进了会话历史（对应上游 `session/event` 的 user/message）。 */
    'superagent/message-read'(payload: { sessionId: string; requestId: string }): void
    /** 会话的回合报错（对应上游 `agent/error`，执行器据此判临时故障与失败）。 */
    'superagent/agent-error'(payload: { agent: SessionHandle; sessionId: string; error: string }): void
  }
}

/**
 * 一条由本模块管理的会话：本仓 `Session` + 跑它的 `MiniAgent`，外加执行器要的几样能力。
 * 结构上满足 `app/delivery.ts` 的 `DeliveryTarget`。
 */
export interface SessionHandle {
  /** 逻辑会话 id，等于 `Session.meta.id`（worker 为 `worker-<ticketId>`）。 */
  readonly id: string
  readonly role: 'orchestrator' | 'worker'
  /** `running` = 有回合在跑；`idle` = 完全闲下来（没有在跑的回合、也没有排队的下一轮）。 */
  readonly status: 'idle' | 'running'
  readonly session: Session
  readonly agent: MiniAgent
  /** 撤回还没出账的投递（参数是 `promptedId` 的返回值）；已出账返回 false。 */
  readonly inbox: { remove(messageId: PromptedId): boolean }
  /** 等这条会话完全闲下来（已经在闲就立即 resolve）。 */
  whenIdle(): Promise<void>
  /** 停回合；`keepInbox` 为真时把排队输入留到下一次回合，为假时丢弃（对齐上游两种停止语义）。 */
  cancel(options?: { kind: 'user'; keepInbox?: boolean }): void
  /** 投一条消息（下一轮出账）。 */
  followup(text: string): void
  /** 最后一条非空 assistant 正文（替代上游 `session.snapshotEvents()` 里的 assistant/message）。 */
  lastAssistantText(): string
}

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** 本仓 Cordis 上下文：取宿主服务、发本模块的事件。 */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'delete' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** 这条会话模型可见的工具目录（本仓全局注册表里挑好的 `ToolEntry`，见文件头第 10 条）。 */
  tools(agent: SessionHandle, ticket?: Ticket): ToolEntry[]
}

/** 本模块为一条会话登记的账：解绑时按 LIFO 释放。 */
interface SessionBinding { disposers: (() => void)[] }

/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** 主会话（router preset）保留的 profile 工具：上游 `tools.restrict` 的 allow 名单。 */
const ROUTER_TOOLS = ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill']
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/** 把配置里的思考强度字符串收成契约里的档位；认不出的按缺省（不编造一个档位）。 */
function effortOf(value: string | undefined): EffortLevel {
  switch (value) {
    case 'off': case 'low': case 'high': case 'max': case 'default': return value
    default: return 'default'
  }
}

/** 取一条 assistant 消息的正文（本仓 content 可能是字符串或多模态数组）。 */
function textOf(message: { content: string | null | readonly { type: string; text?: string }[] }): string {
  if (typeof message.content === 'string') return message.content
  if (message.content === null) return ''
  return message.content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('')
}

/**
 * 一条会话的句柄实现：状态机、`whenIdle` 等待者、停机保留的收件箱都在这里。
 * 只有本文件的 `Sessions` 会造它，对外按 {@link SessionHandle} 用。
 */
class BoundSession implements SessionHandle {
  readonly inbox: { remove: (messageId: PromptedId) => boolean }
  /** 由 `Sessions` 在造出 `MiniAgent` 之后填：构造 agent 的 deps 闭包要拿到这个句柄。 */
  agent!: MiniAgent
  private statusValue: 'idle' | 'running' = 'idle'
  private readonly waiters: (() => void)[] = []
  /** `cancel({ keepInbox: true })` 留下的排队输入：回合完全收尾后才放回去（见 cancel 的注释）。 */
  private readonly kept: AsyncInboxItem[] = []

  constructor(readonly id: string, readonly session: Session, readonly role: 'orchestrator' | 'worker',
    private readonly owner: Sessions) {
    this.inbox = {
      remove: (messageId: PromptedId): boolean => {
        const requestId = requestIdOf(messageId)
        return requestId === undefined ? false : owner.forget(this.id, requestId)
      },
    }
  }

  get status(): 'idle' | 'running' { return this.statusValue }

  whenIdle(): Promise<void> {
    if (this.statusValue === 'idle') return Promise.resolve()
    return new Promise(resolve => { this.waiters.push(resolve) })
  }

  cancel(options: { kind: 'user'; keepInbox?: boolean } = { kind: 'user' }): void {
    // 收件箱先摘下来再取消：留在箱里的话，MiniAgent 的回合收尾会把它们出账、再排一轮，
    // 与「停机」正好相反（agent 插件 stop() 的取舍相同）。
    const queued = this.session.takeAsyncInbox()
    if (options.keepInbox === true) this.kept.push(...queued)
    // 不保留的排队输入连投递账一起丢掉：账还在的话，重启后 `inbox.remove` 会找到一条
    // 会话里已经不存在的消息（见 delivery.ts 的文件头第 2 条）。
    else this.owner.discardDeliveries(this.session)
    this.agent.cancel()
  }

  followup(text: string): void { this.agent.followup(text) }

  lastAssistantText(): string {
    for (let index = this.session.messages.length - 1; index >= 0; index -= 1) {
      const message = this.session.messages[index]
      if (message === undefined || message.role !== 'assistant') continue
      const text = textOf(message)
      if (text.trim() !== '') return text
    }
    return ''
  }

  /** 回合开始：置 running 并广播（上游 `agent/status` 的 running 半边）。 */
  markRunning(): void {
    if (this.statusValue === 'running') return
    this.statusValue = 'running'
    this.owner.emitStatus(this)
  }

  /** 完全闲下来：放回保留的收件箱、置 idle、广播并唤醒 `whenIdle()` 的等待者。 */
  markIdle(): void {
    const kept = this.kept.splice(0)
    for (const item of kept) this.session.enqueueAsync(item.text, item.images, item.origin, item.files)
    if (this.statusValue === 'idle') return
    this.statusValue = 'idle'
    this.owner.emitStatus(this)
    for (const resolve of this.waiters.splice(0)) resolve()
  }
}

/**
 * Creates and decorates orchestrator and worker Session agents with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** 装饰过的会话 → 解绑时要释放的账；`dispose()` 时按会话释放。 */
  private readonly bindings = new Map<SessionHandle, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** 本模块管理的会话：逻辑 id → 句柄（替代上游 `ctx.agents` 里属于本插件的那部分）。 */
  private readonly handles = new Map<string, SessionHandle>()
  /** 合成 `RetryHealthEvent` 用的游标（见文件头第 7 条）。 */
  private readonly retryCursors = new Map<string, { seq: number; turn: number; step: number }>()
  /** 每轮投影链报上来的上下文注入清单（`takeContextInjections` 取走即清）。 */
  private readonly injections = new WeakMap<SessionHandle, ContextInjectionView[]>()
  private skillsDisposer: (() => void) | undefined

  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.store)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
    // 运行时技能：本仓的技能目录是插件级来源，注册一次、按当前提示词修订现读（见文件头第 4 条）。
    this.ensureSkillsProvider()
  }

  /**
   * Subscribes to host events. Upstream decorated every agent DSH created and re-selected its preset; this module
   * creates its own agents and reads their events through `AgentDeps.emit`, so the only host event left is the exit
   * hook that releases them. Call once at startup.
   */
  install(): void {
    this.ctx.effect(() => this.ctx.on('dsc/exit', () => { this.dispose() }), 'superagent: sessions.install')
  }

  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/tools, sets `danger-full-access` permissions, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<SessionHandle> {
    const existing = this.handles.get(id)
    if (existing !== undefined) return existing
    if (this.llm() === undefined) throw new Error('宿主没有 llm 服务，dsh-superagent 起不了会话')
    this.ensureSkillsProvider()
    const session = this.openSession(id, cwd)
    const handle = new BoundSession(id, session, role, this)
    // deps 的闭包要拿到句柄，句柄的 agent 又要 deps：先造句柄、再填 agent（与上游 create → decorate 同一顺序）。
    handle.agent = new MiniAgent(this.depsFor(handle), session)
    this.handles.set(id, handle)
    const settings = this.host.store.settings()
    await initializeRoleModel(session, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    this.decorate(handle)
    // 权限在第一次请求前钉死：本插件的会话跑在自己的信任边界内（上游 permissionPresets 的同一取舍）。
    writePermissions(session, { sandbox: 'danger-full-access', policy: 'full-access', reviewer: 'user' })
    if (title.trim() !== '') {
      try { patchSessionMeta(id, { title }) } catch (error) {
        this.warn('dsh-superagent could not rename session %s: %s', id, String(error))
      }
    }
    return handle
  }

  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const handle = this.handles.get(sessionId)
    return handle === undefined ? false : await this.agentDelivery.holds(handle, requestId)
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (handle === undefined) throw new Error(`会话 ${sessionId} 不归 dsh-superagent 管，投递没有落点`)
    const outcome = await this.agentDelivery.send(handle, requestId, text, mode, this.host.lifetime, authorize, accepted)
    if (outcome === 'landed') this.ctx.emit('superagent/message-read', { sessionId, requestId })
  }
  /** The id of the message `prompt` delivers under `requestId`, which the executor's inbox removal names it by. */
  promptedId(requestId: string): PromptedId { return messageId(requestId) }
  /** 撤回一条还没出账的投递（上游 `agent.inbox.remove` 的等价口）；已出账或不存在返回 false。 */
  forget(sessionId: string, requestId: string): boolean {
    const handle = this.handles.get(sessionId)
    return handle === undefined ? false : this.agentDelivery.forget(handle.session, requestId)
  }
  /** 本模块管理的会话句柄（替代上游 `ctx.agents.get`）；不归本模块管返回 undefined。 */
  agent(sessionId: string): SessionHandle | undefined { return this.handles.get(sessionId) }
  /** 丢掉一条会话所有还没出账的投递登记（`SessionHandle.cancel` 不保留收件箱时调）。 */
  discardDeliveries(session: Session): void { this.agentDelivery.discard(session) }
  /** 等一条会话完全闲下来；会话不存在时立即返回。 */
  async whenIdle(sessionId: string): Promise<void> { await this.handles.get(sessionId)?.whenIdle() }
  /** 停一条会话的回合；`keepInbox` 语义见 {@link SessionHandle.cancel}。 */
  cancel(sessionId: string, options: { kind: 'user'; keepInbox?: boolean } = { kind: 'user' }): void {
    this.handles.get(sessionId)?.cancel(options)
  }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const handle = this.handles.get(this.host.masterId)
    if (handle === undefined) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    const requestId = `notice:${name}:${key(text)}`
    const outcome = await this.agentDelivery.send(handle, requestId, text, { inject: summary }, this.host.lifetime)
    if (outcome === 'landed') this.ctx.emit('superagent/message-read', { sessionId: handle.id, requestId })
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.handles.has(sessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  /** 广播一条状态变化（本模块的事件，见文件头的 `install` 差异）。 */
  emitStatus(handle: SessionHandle): void {
    this.ctx.emit('superagent/agent-status', { agent: handle, status: handle.status })
  }
  private ticketOf(handle: SessionHandle): Ticket | undefined {
    const ticketId = ticketOfSession(handle.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** 会话文件位置：worker 在工单目录里，主会话在 `sessions/main/` 下（都不进用户会话列表）。 */
  private sessionFileOf(id: string): string {
    const ticketId = ticketOfSession(id)
    if (ticketId !== undefined) return join(sessionsDir(ticketId), `${id}.jsonl`)
    return join(superagentRoot(), 'sessions', 'main', `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)
  }
  /** 打开（必要时新建）会话：逻辑 id 先写成 meta 行再 `load`，这样 `Session.meta.id` 就是上游的会话 id。 */
  private openSession(id: string, cwd: string): Session {
    const file = this.sessionFileOf(id)
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file) && statSync(file).size > 0) return Session.load(file, true)
    writeFileSync(file, `${JSON.stringify({ type: 'meta', id, cwd, createdAt: Date.now() })}\n`, 'utf8')
    return Session.load(file, true)
  }
  /** 一次请求要的 `AgentDeps`：模型路由、系统提示、工具目录、守卫链、流式请求与事件出口。 */
  private depsFor(handle: BoundSession): AgentDeps {
    return {
      route: () => this.routeOf(handle),
      systemPrompt: () => this.systemPromptFor(handle),
      tools: () => this.toolDirectory(handle),
      guards: this.guardFor(handle),
      stream: (api: string, request: StreamRequest, handlers: StreamHandlers): Promise<StreamResult> => {
        const llm = this.llm()
        if (llm === undefined) return Promise.reject(new Error('宿主没有 llm 服务，发不出模型请求'))
        return llm.stream(api, request, handlers)
      },
      emit: event => this.observe(handle, event),
      notice: text => this.warn('会话 %s：%s', handle.id, text),
      beforeRequest: async signal => { await this.compact()?.check(signal, handle.session) },
      onContextOverflow: async signal => (await this.compact()?.forceCompact(signal, handle.session)) ?? false,
      // 请求投影链照主会话同一套跑：worker 也吃宿主的环境快照 / 去图这类投影（上游所有会话共用同一套）。
      rewrite: (messages, session) => {
        const prompt = this.promptService()
        if (prompt === undefined) return messages
        const collected: ContextInjectionView[] = []
        const out = prompt.rewrite(messages, session, view => { collected.push(view) })
        this.injections.set(handle, collected)
        return out
      },
      takeContextInjections: () => this.injections.get(handle) ?? [],
      onIdle: () => { this.idle(handle) },
    }
  }
  /** 模型路由：主会话跟随会话自己的选路；worker 用设置里的执行者模型，没配就跟随当前选路。 */
  private routeOf(handle: SessionHandle): LlmRoute {
    const llm = this.llm()
    if (llm === undefined) throw new Error('宿主没有 llm 服务，取不到模型路由')
    if (handle.role === 'orchestrator') return llm.routeForSession(handle.session)
    const model = this.host.store.settings().executor.model
    return model === null ? llm.route() : llm.routeTo(model.provider, model.model, effortOf(model.reasoningEffort))
  }
  /** 系统提示：主会话只有本插件这一份（上游的 `complete: true`）；worker 是宿主基础提示 + 本插件这一段。 */
  private systemPromptFor(handle: SessionHandle): { text: string; sections: PromptSectionView[] } {
    const version = this.promptFor(handle, true)
    const ticket = this.ticketOf(handle)
    const current = ticket === undefined ? undefined : this.host.store.tickets.get(ticket.id)
    const composed = this.host.prompts.compose(version.config, handle.role === 'orchestrator' ? 'orchestrator' : 'worker',
      current === undefined ? undefined : this.host.environment(current))
    const section = `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current === undefined ? '' : mandateInstructions(current.mandate)}`
    const policy: PromptSectionView = { id: 'dsh-superagent-policy', order: 9999, chars: section.length, from: 'plugin:superagent' }
    if (handle.role === 'orchestrator') return { text: section, sections: [policy] }
    const base = this.promptService()?.systemPromptParts(handle.session.meta.cwd, { sessionId: handle.id, cwd: handle.session.meta.cwd })
    return base === undefined ? { text: section, sections: [policy] }
      : { text: `${base.text}\n\n${section}`, sections: [...base.sections, policy] }
  }
  /** 模型可见的工具目录：角色白名单 ∩ 全局注册表 + host 给这条会话补的工具（后者不掩，见文件头第 10 条）。 */
  private toolDirectory(handle: SessionHandle): ToolEntry[] {
    const all = this.tools()?.list() ?? []
    const extra = this.host.tools(handle, this.ticketOf(handle))
    const picked: ToolEntry[] = []
    for (const name of handle.role === 'worker' ? WORK_TOOLS : ROUTER_TOOLS) {
      const entry = all.find(item => item.name === name)
      if (entry !== undefined) picked.push(entry)
    }
    for (const entry of extra) if (!picked.some(item => item.name === entry.name)) picked.push(entry)
    return picked
  }
  /** 守卫链：主会话多一道 noWait 闸，worker 多一道「工单结束了就停手」闸，其余交给宿主链。 */
  private guardFor(handle: SessionHandle): ToolGuardChain {
    const ticket = this.ticketOf(handle)
    return {
      gate: async (input: ToolGuardInput) => {
        // 每次现取：插件装配顺序不保证构造期就能拿到守卫服务（取不到时失败关闭）。
        const base = this.guards()
        if (base === undefined) return { action: 'deny' as const, reason: '宿主没有守卫链，dsh-superagent 不允许动手' }
        if (handle.role === 'orchestrator') {
          const reason = noWait({ name: input.toolName, arguments: input.args }, () => this.routed(handle))
          if (reason !== undefined) return { action: 'deny' as const, reason }
        } else if (ticket !== undefined) {
          const current = this.host.store.tickets.get(ticket.id)
          if (current === undefined || !liveTicket(current)) return { action: 'deny' as const, reason: 'Ticket ended; new work needs a new authorized ticket' }
        }
        return base.gate(input)
      },
      observe: (toolName, text) => this.guards()?.observe(toolName, text) ?? text,
    }
  }
  /**
   * Whether a Session runs the router preset: as this module recorded it in the Session log when it created the Session,
   * else as it was created (`standard`, the safer caps, when unreadable).
   */
  private routed(handle: SessionHandle): boolean {
    try {
      const preset = handle.session.notes().flatMap(note => note.id === PRESET_NOTE ? [note.text] : []).at(-1)
      return (preset ?? (handle.role === 'orchestrator' ? ROUTER_PRESET : WORKER_PRESET)) === ROUTER_PRESET
    } catch { return false }
  }
  /** 回合事件路由：状态、错误、投递出账、模型重试账（上游 `session/event` + `agent/status` + `agent/error`）。 */
  private observe(handle: BoundSession, event: CoreEvent): void {
    this.observeRetry(handle, event)
    switch (event.type) {
      case 'turn/start':
        handle.markRunning()
        return
      case 'turn/end':
        this.retryHealth.clear(handle.id)
        this.updateModelHealth()
        return
      case 'error':
        this.ctx.emit('superagent/agent-error', { agent: handle, sessionId: handle.id, error: event.message })
        return
      case 'user': {
        // 排队中的投递在出账这一刻认回来：本仓没有 DSH 的 inbox/claimed 事件，靠正文对账（见 delivery.ts）。
        const requestId = this.agentDelivery.claim(handle.session, event.text)
        if (requestId === undefined) return
        this.ctx.emit('superagent/inbox-claimed', { agent: handle, sessionId: handle.id, origin: event.origin ?? 'notice' })
        this.ctx.emit('superagent/message-read', { sessionId: handle.id, requestId })
        return
      }
      default:
        return
    }
  }
  /** 完全闲下来：清重试账、刷新体检、置 idle 并唤醒等待者（上游 `agent/status` 的 idle 半边）。 */
  private idle(handle: BoundSession): void {
    this.retryHealth.clear(handle.id)
    this.updateModelHealth()
    handle.markIdle()
  }
  /**
   * 把本仓 `CoreEvent` 合成 `RetryHealth` 要的事件形状（它逐字移植自上游，见文件头第 7 条）。
   * 序号、turn、step 都由本模块自己数：本仓事件流没有这三样，但判定顺序与上游一致
   * （turn 边界、同一 step 内的重试与成功消息）。
   */
  private observeRetry(handle: SessionHandle, event: CoreEvent): void {
    let cursor = this.retryCursors.get(handle.id)
    if (cursor === undefined) {
      cursor = { seq: -1, turn: -1, step: -1 }
      this.retryCursors.set(handle.id, cursor)
    }
    const record = (type: string, data: unknown): void => {
      const entry: RetryHealthEvent = { type, seq: ++cursor.seq, time: Date.now(), data }
      this.retryHealth.observe(handle.id, entry)
    }
    if (event.type === 'turn/start') {
      cursor.turn += 1
      cursor.step = -1
      record('turn/start', { turn: cursor.turn })
      return
    }
    if (event.type === 'turn/end') { record('turn/end', { turn: cursor.turn }); return }
    if (event.type === 'message') {
      cursor.step += 1
      record('assistant/message', { turn: cursor.turn, step: cursor.step, interrupted: event.finishReason === 'interrupted',
        message: { source: { kind: 'model', provider: this.providerOf(handle) } } })
      return
    }
    if (event.type === 'model/retry') {
      record('llm/retry', { turn: cursor.turn, step: cursor.step + 1, retryId: `${handle.id}:${event.attempt}`,
        provider: this.providerOf(handle), retry: event.attempt, failure: { message: event.reason } })
    }
  }
  /** 这条会话现在生效的端点名（重试账按它归属）；读不出来记 unknown，不编造。 */
  private providerOf(handle: SessionHandle): string {
    const llm = this.llm()
    if (llm === undefined) return 'unknown'
    try { return llm.providerOf(handle.session) } catch { return 'unknown' }
  }
  private decorate(handle: SessionHandle): void {
    if (this.bindings.has(handle)) return
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(handle, binding)
    // 角色对应的 preset 记进会话日志（本仓没有 DSH 的 preset 投影，见文件头第 3 条）。
    handle.session.appendNote(PRESET_NOTE, handle.role === 'worker' ? WORKER_PRESET : ROUTER_PRESET)
    if (handle.status === 'idle') this.retryHealth.clear(handle.id)
    this.updateModelHealth()
    // 会话登记进内核会话表：subagent 认父会话、后台作业通知认归属都靠它（旧执行器同一手）。
    const agents = this.agentService()
    if (agents !== undefined) {
      agents.attach(handle.session)
      binding.disposers.push(() => { agents.detach(handle.id) })
    }
  }
  /** 释放一条会话的登记（LIFO）；会话本身由 `dispose()` 关。 */
  private release(handle: SessionHandle): void {
    const binding = this.bindings.get(handle)
    if (binding === undefined) return
    this.bindings.delete(handle)
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
    this.retryCursors.delete(handle.id)
    this.retryHealth.clear(handle.id)
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void {
    this.skillsDisposer?.()
    this.skillsDisposer = undefined
    for (const handle of [...this.handles.values()]) {
      this.release(handle)
      this.handles.delete(handle.id)
      const close = (): void => {
        try { handle.agent.dispose() } catch (error) { this.warn('dsh-superagent could not close session %s: %s', handle.id, String(error)) }
      }
      // 回合还在跑：先停，等它收尾（出账与 git 聚合都要写会话）再关。直接关会把记录写进一条
      // 已经还了写租约的会话（`Session.close` 之后 streamFor 会重开文件、但没有租约）。
      if (handle.status === 'running') {
        handle.cancel({ kind: 'user' })
        void handle.whenIdle().then(close, close)
      } else close()
    }
    this.updateModelHealth()
  }
  /** 注册插件级技能来源；技能服务晚于本模块就位时，下一次 `ensure` 再试一次（见文件头第 4 条）。 */
  private ensureSkillsProvider(): void {
    if (this.skillsDisposer !== undefined) return
    const skills = this.ctx.get('skills')
    if (skills === undefined) return
    this.skillsDisposer = skills.registerProvider(this.skillProvider())
  }
  /** 插件级技能来源：名字带 `SKILL_PREFIX`，正文按当前提示词修订现读（见文件头第 4 条）。 */
  private skillProvider(): SkillProvider {
    const entries = (): { summary: SkillSummary; content: string }[] => {
      const version = this.host.prompts.current()
      return this.host.prompts.skills(version.config).map(([name, content]) => {
        const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
        const body = version.config.skills[name] ?? ''
        const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
        const summary: SkillSummary = { name: `${SKILL_PREFIX}${name}`, description, source: 'plugin:superagent', rank: SKILL_RANK,
          modelInvocable: true, userInvocable: false, local: false, ...(bundled === undefined ? {} : { path: bundled.path }) }
        return { summary, content }
      })
    }
    return {
      name: SKILL_PROVIDER,
      rank: SKILL_RANK,
      list: (): SkillSummary[] => entries().map(entry => entry.summary),
      get: (name: string): SkillDefinition | undefined => {
        const found = entries().find(entry => entry.summary.name === name)
        return found === undefined ? undefined : { ...found.summary, content: found.content }
      },
    }
  }
  /** 记一条提示词修订：请求绑定那一刻把当前修订追加进 `KV.sessions.prompts`（旧修订保留，`mayRead` 据此放行）。 */
  private promptFor(handle: SessionHandle, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(handle.id)) ?? []
    if (revisions.at(-1) !== version.revision) {
      store.set(KV.sessions.prompts(handle.id), [...revisions.filter(revision => revision !== version.revision), version.revision])
    }
    return version
  }
  private llm(): LlmService | undefined { return this.ctx.get('llm') }
  private tools(): ToolService | undefined { return this.ctx.get('tools') }
  private guards(): ToolGuardChain | undefined { return this.ctx.get('guards') }
  private promptService(): PromptService | undefined { return this.ctx.get('prompt') }
  private compact(): CompactService | undefined { return this.ctx.get('compact') }
  private agentService(): AgentService | undefined { return this.ctx.get('agent') }
  private warn(format: string, ...values: unknown[]): void { this.ctx.logger.warn(format, ...values) }
}
