/**
 * 移植自 dsh-superagent/src/app/resources.ts（303 行，原生重写）。
 *
 * 模块边界、导出名、资源清单（`RESOURCES` / `resourceGrammar` / `ResourceHost` / `MainResourceHost` /
 * `readResource`）、每个 resource 的判定顺序与错误文案都照上游；只有三处「DSH 宿主调用」换成本仓原生能力：
 *
 * | 上游（DSH） | 本仓原生 | 依据 |
 * | --- | --- | --- |
 * | `type { SessionId } from '@deepseek-ai/dsh-session'` | 会话 id 就是 `string`（`Session.meta.id`，`src/core/session.ts:26`） | 与 `executor/dsh.ts` 文件头同一条口径 |
 * | `context.sessionController.inspect(workerSessionId(id) as SessionId).events` | 先取常驻 worker 会话的内存消息（`ctx.get('agent').sessionById`，对应 inspect 读活会话），没有时只读重放该工单的会话日志（`Session.load(file, true, { lease: false })`），再把协议消息投影成 dsh 会话语义下的 `user/message` / `assistant/message` / `tool/result` 三种事件（`transcript()`） | `surface.ts:164-194` 读工单转录用的是同一条只读口径；`app/context.ts:1-16` 说明 `BridgeEvent` 就是上游 `inspect().events` 在本仓的对应物 |
 * | `context.sessionController.modelCatalog()` | `ctx.get('llm')` 的 `LlmService.listModels()` + `provider` / `model`（`src/services/types.ts:122-180`） | 本仓模型清单的持有者是 llm 服务；`models` / `models/<provider>` 两个 resource 的字段按上游形状重排 |
 *
 * 会话日志路径用 `paths.ts` 的 `sessionsDir(ticketId)` + `workerSessionId(ticketId)`，与会话由谁创建无关；
 * 一张工单一个逻辑会话 id（`app/sessions.ts:404-417`），所以只读一个同名 jsonl，不扫目录。
 *
 * 浏览器/界面侧不 import 本文件；它只给 `orchestrator_read` 与执行者工具的读口。
 *
 * 给模型读的、分页的上下文资源：大段正文留在资源里，模型按需翻页。
 *
 * @module dsc/packages/superagent/app/resources
 */
/** Serves paginated context resources to orchestrator_read so large bodies stay out of model prompts until requested. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelChoiceView } from '@pneuma/runtime/contract.js'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { Session } from '@pneuma/runtime/core/session.js'
import type { BridgeEvent } from '../../../core/dsh-compat/session-bridge.js'
import { UserError, key, latestReport, reached, runningAssignment, threadKey, type Ticket, type Trigger } from '../core/index.js'
import { batchOf, inputMessage, triggerMessage, workerSessionId } from '../executor/dsh.js'
import { readGithub } from '../sources/github-read.js'
import { feishuReferences, feishuRead } from '../sources/feishu-read.js'
import { feishuRef } from '../sources/feishu.js'
import { feishuTriggerId } from '../sources/feishu-trigger.js'
import { ASSIGNMENTS, INPUTS, assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, preview, textPage, threadCard, ticketCard,
  ticketDetails, triggerCard, type TicketThread } from './cards.js'
import { threadTitle } from './views/records.js'
import { transcriptEntry } from './context.js'
import { builtInParts, defaultPrompts } from './prompts.js'
import type { Commands } from '../infra/commands.js'
import type { PromptVersion, Prompts } from './prompts.js'
import type { Sessions } from './sessions.js'
import type { Settings } from './settings.js'
import { KV } from '../kv.js'
import { sessionsDir } from '../paths.js'
import type { Store } from './store.js'
import type { TextCache } from './cache.js'

/** Resource descriptors exposed via orchestrator_read, marking which resources worker sessions may also read for their own ticket. */
export const RESOURCES: readonly { name: string; holds: string; executor?: true }[] = [
  { name: 'tickets', holds: 'ticket cards, newest first; a card\'s state is person/review after a ready report, person/blocked or person/failed after those reports, person/answer with a question, person/delivery when an input could not reach the worker, working or working/queued while it works, idle once the worker ended its turn without a report, else how the ticket ended' },
  { name: 'triggers', holds: 'trigger cards with where each went, newest first' },
  { name: 'threads', holds: 'subscribed threads, newest activity first, with their labels, tickets, current assessment and polling errors' },
  { name: 'thread/<key>', holds: 'one thread: its label and link, its tickets and latest decisions, and its triggers, newest first', executor: true },
  { name: 'decisions', holds: 'decisions, newest first' },
  { name: 'decision/<id>', holds: 'one decision with its audit' },
  { name: 'ticket/<id>', holds: 'a ticket\'s card, the trigger, decision and threads it is tied to, its latest assignments with the start of each '
    + 'report, and its inputs, newest first', executor: true },
  { name: 'ticket/<id>/assignment', holds: 'its assignment text', executor: true },
  { name: 'ticket/<id>/assignments', holds: 'its assignments, newest first, with the start of each report', executor: true },
  { name: 'ticket/<id>/inputs', holds: 'its inputs, newest first', executor: true },
  { name: 'ticket/<id>/result', holds: 'its latest report', executor: true },
  { name: 'ticket/<id>/report/<id>', holds: 'the report of one of its assignments', executor: true },
  { name: 'ticket/<id>/transcript', holds: 'its Executor Session\'s messages, newest first', executor: true },
  { name: 'ticket/<id>/message/<n>', holds: 'one message of that transcript', executor: true },
  { name: 'ticket/<id>/input/<id>', holds: 'one input it was delivered', executor: true },
  { name: 'trigger/<id>', holds: 'a trigger\'s text, where it went, the message it replies to and the messages around it on its thread',
    executor: true },
  { name: 'settings', holds: 'settings by block, each with the revision a save names: the small blocks whole, the Policy and the Source '
    + 'instances summarized' },
  { name: 'settings/<block>', holds: 'one settings block whole, as orchestrator_settings_save takes it: policy, eval, executor, pause or '
    + 'source:<id>' },
  { name: 'prompts', holds: 'the prompt revision each Session reads, the skills, and the saved versions' },
  { name: 'prompts/<revision>', holds: 'one prompt version by number, or current, the one the Session works under', executor: true },
  { name: 'prompts/defaults', holds: 'the built-in prompt configuration, and the built-in parts by the key an override names' },
  { name: 'prompt-preview/<id>', holds: 'a composed prompt that orchestrator_prompts_save previewed' },
  { name: 'models', holds: 'model providers, the DSH default and each role\'s model' },
  { name: 'models/<provider>', holds: 'one provider\'s models' },
  { name: 'feishu/<trigger-id>/…', holds: 'a Feishu original, as the dsh-superagent-feishu skill describes', executor: true },
  { name: 'github/…', holds: 'a GitHub original, as the dsh-superagent-github skill describes', executor: true },
]
export const resourceGrammar = (executor: boolean): string => RESOURCES.filter(resource => !executor || resource.executor)
  .map(resource => `${resource.name}: ${resource.holds}`).join('; ')

export interface ResourceHost {
  readonly store: Pick<Store, 'get' | 'settings' | 'triggers' | 'tickets' | 'threads' | 'read' | 'decisions' | 'replyStatus'>
  readonly pages: TextCache
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'skills' | 'defaultChanged'>
  readonly commands: Commands
  readonly masterId: string
  /** 本仓 cordis 上下文：模型清单从它现取 `llm` 服务（上游从这里取 DSH 的 session controller）。 */
  readonly context: Context
  promptVersion(sessionId: string): PromptVersion
  /** Whether a Session may read `revision` (the revision it currently runs under or any revision it ran under previously). */
  mayRead(sessionId: string, revision: number): boolean
  feishuPageSize(): number
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
}
export interface MainResourceHost extends ResourceHost {
  readonly sessions: Pick<Sessions, 'status' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block'>
}
interface Read {
  host: ResourceHost; resource: string; rest: string; offset: number; limit?: number
  sessionId: string; ticketId?: string; signal?: AbortSignal
}
type Route = readonly [name: string, read: (read: Read) => unknown]

/** Enforces that main-Session-only resources cannot be read by worker Sessions. */
const main = ({ host, ticketId }: Read): MainResourceHost => {
  if (ticketId || !('settings' in host)) throw new Error('This resource belongs to the main Session')
  return host as MainResourceHost
}
const text = ({ resource, offset, limit }: Read, body: string) => textPage(resource, body, offset, limit ?? 4000)
function list<T>({ offset, limit }: Read, fetch: (offset: number, count: number) => T[]) {
  const size = Math.min(limit ?? 20, 50)
  const items = fetch(offset, size + 1)
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null }
}
/** Check whether a worker session's ticket is authorized to read a trigger (via delivery, ticket origin, or followed thread). */
const readable = (host: ResourceHost, ticket: Ticket, trigger: Trigger): boolean => reached(ticket, trigger, key => host.store.threads.get(key))
  || ticket.origin.triggerIds.includes(trigger.id) || trigger.threads.some(ref => ticket.follows?.some(follow => follow.thread === threadKey(ref)))
const trigger = (host: ResourceHost, id: string, ticketId?: string): Trigger => {
  const found = host.store.triggers.get(id)
  if (!found) throw new UserError('unknownTrigger')
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError('notReached')
  return found
}
/** Fetch and cache a source resource on offset 0, serving subsequent offsets from the session cache. */
async function sourcePage(read: Read, source: string, fetch: () => Promise<unknown>) {
  const { host, resource, offset, sessionId } = read
  const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`)
  if (body === undefined) throw new Error(`Read this ${source === 'feishu' ? 'Feishu' : 'GitHub'} resource from offset 0 first`)
  if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body)
  return text(read, body)
}
const THREAD_DECISIONS = 5
const triggerLine = (trigger: Trigger) => ({ trigger_id: trigger.id, actor: trigger.actor.id, human: trigger.human, at: trigger.at,
  preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}` })
/** The worker Session's log file: one logical session id per ticket (`app/sessions.ts:404-417`), so one jsonl. */
const transcriptFile = (ticketId: string): string => join(sessionsDir(ticketId), `${workerSessionId(ticketId)}.jsonl`)
/** A message's content in dsh's block shape: text and image parts keep their kind. */
function blocksOf(content: ChatMessage['content']): { type: string; text?: string }[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (content === null) return []
  return content.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: part.type })
}
/**
 * One logged protocol message as the dsh session event `transcriptEntry` reads. The three event types are the only ones
 * `transcriptEntry` keeps, mirroring what a DSH Executor Session produced; reasoning blocks are kept here and dropped there.
 */
function eventOf(message: ChatMessage, index: number): BridgeEvent | undefined {
  const base = { seq: index + 1, time: message.ts ?? 0 }
  if (message.role === 'user') return { ...base, type: 'user/message', data: { role: 'user', content: blocksOf(message.content) } }
  if (message.role === 'assistant') {
    const content = [
      ...(message.reasoning_content ? [{ type: 'reasoning', text: message.reasoning_content }] : []),
      ...blocksOf(message.content),
      ...(message.tool_calls ?? []).map(call => ({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments })),
    ]
    return { ...base, type: 'assistant/message', data: { message: { role: 'assistant', content } } }
  }
  if (message.role === 'tool') return { ...base, type: 'tool/result', data: { message: { role: 'tool', content: blocksOf(message.content) } } }
  return undefined
}
/**
 * The worker Session's messages: the live one when the worker is loaded (upstream `inspect` reads the live session), else
 * its log, read-only. `Session.load(..., { lease: false })` never takes the write lease a live worker holds (the same rule
 * `surface.ts:164-194` follows), and an absent log is an empty transcript, not an error.
 */
function messagesOf(host: ResourceHost, ticketId: string): readonly ChatMessage[] {
  const sessionId = workerSessionId(ticketId)
  const live = host.context.get('agent')?.sessionById(sessionId)
  if (live !== undefined) return live.messages
  const file = transcriptFile(ticketId)
  if (!existsSync(file)) return []
  const session = Session.load(file, true, { lease: false })
  try {
    return [...session.messages]
  } finally {
    session.close()
  }
}
/** The worker Session's messages as dsh session events, the three types `transcriptEntry` reads. */
async function transcript(host: ResourceHost, ticketId: string): Promise<BridgeEvent[]> {
  return messagesOf(host, ticketId).flatMap((message, index) => {
    const event = eventOf(message, index)
    return event === undefined ? [] : [event]
  })
}
/** The host's model choices grouped by provider, in the order the host lists them. */
function providersOf(choices: readonly ModelChoiceView[]) {
  const groups = new Map<string, ModelChoiceView[]>()
  for (const choice of choices) groups.set(choice.provider, [...groups.get(choice.provider) ?? [], choice])
  return [...groups].map(([id, models]) => ({ id, name: models[0]!.providerDisplayName, models }))
}
/** One model line on a provider page: the identity a model is chosen by, and what the chooser shows about it. */
const modelLine = (choice: ModelChoiceView) => ({ id: choice.model, value: choice.value, description: choice.description, context_window: choice.contextWindow })

const ROUTES: readonly Route[] = [
  ['tickets', read => {
    const host = main(read), tickets = host.store.tickets.list()
    const card = (ticket: Ticket) => ({ ...ticketCard(ticket), ...host.sessions.modelRetry(runningAssignment(ticket) && workerSessionId(ticket.id)) })
    return list(read, (offset, count) => tickets.slice(offset, offset + count).map(card))
  }],
  ['triggers', read => {
    const { store } = main(read)
    return list(read, (offset, count) => store.read.recentTriggers(offset, count).map(item => triggerCard(item, store.triggers.disposition(item.id))))
  }],
  ['threads', read => {
    const { store } = main(read)
    const threads = store.read.subscribedThreads().sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
    return list(read, (offset, count) => threads.slice(offset, offset + count).map(thread => threadCard(thread, threadTitle(store, thread))))
  }],
  ['thread/', read => {
    const { host, rest, ticketId } = read
    const thread = host.store.threads.get(rest)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    // Worker Sessions may only read threads their own ticket subscribes to or follows.
    if (!thread || (ticketId && !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some(follow => follow.thread === rest)))) {
      throw new Error('Unknown or inaccessible thread')
    }
    const { store } = host
    const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread))
    const page = list(read, (offset, count) => store.read.threadPage(thread.key, offset, count).map(triggerLine))
    // Worker sessions cannot inspect other tickets or decisions on a shared thread.
    if (ticketId) return { ...card, ...page }
    const tickets = ids.flatMap(id => { const found = store.tickets.get(id); return found ? [ticketCard(found)] : [] })
    const decisions = store.decisions.byThread(thread.key).slice(-THREAD_DECISIONS).reverse().map(decisionCard)
    return { ...card, tickets, decisions, ...page }
  }],
  ['decisions', read => list(read, (offset, count) => main(read).store.read.recentDecisions(offset, count).map(decisionCard))],
  ['decision/', read => {
    const decision = main(read).store.decisions.get(read.rest)
    if (!decision) throw new Error('Unknown decision')
    return decisionDetails(decision)
  }],
  ['settings', read => main(read).settings.view()],
  ['settings/', read => text(read, JSON.stringify(main(read).settings.block(read.rest)))],
  ['prompts', read => {
    const host = main(read), current = host.prompts.current(), status = host.sessions.status()
    const history = host.prompts.history(read.offset, Math.min(read.limit ?? 20, 50)), skills = host.prompts.skills(current.config).map(([name]) => name)
    // The built-in parts whose text changed since the team overrode them, and those this version no longer has, which the
    // panel shows and the next save drops.
    const changes = host.prompts.defaultChanged(current.config)
    const changed = changes.filter(item => !item.removed).map(item => item.part)
    const removed = changes.filter(item => item.removed).map(item => item.part)
    return { revision: status.revision, read: `prompts/${current.revision}`, notification_pending: status.notificationPending,
      ...changed.length ? { default_changed: changed } : {}, ...removed.length ? { removed_parts: removed } : {},
      sessions: status.sessions.map(session => ({ session_id: session.sessionId, revision: session.revision })),
      skills: { built_in: skills.filter(name => !(name in current.config.skills)).map(name => `dsh-superagent-${name}`),
        team: Object.keys(current.config.skills).map(name => `dsh-superagent-${name}`) },
      items: history.revisions.map(({ previousRevision, savedAt, ...version }) =>
        ({ ...version, previous_revision: previousRevision, saved_at: savedAt })),
      next_offset: history.next_offset }
  }],
  // A worker Session may read only its current prompt revision and revisions it previously ran under.
  ['prompts/', read => {
    const { host, resource, rest, sessionId, ticketId } = read
    const prompts = host.prompts
    const bound = host.promptVersion(sessionId)
    const parts = () => Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text]))
    const version = rest === 'current' ? bound : rest === 'defaults' && !ticketId ? { revision: 0, config: defaultPrompts(), parts: parts() }
      : /^\d+$/.test(rest) ? (Number(rest) === 0 && prompts.current().revision === 0 ? prompts.current() : prompts.version(Number(rest))) : undefined
    if (!version || (ticketId && !host.mayRead(sessionId, version.revision))) throw new Error('Unknown or inaccessible prompt version')
    return text({ ...read, resource: rest === 'current' ? `prompts/${version.revision}` : resource }, JSON.stringify(version))
  }],
  ['prompt-preview/', read => {
    const body = main(read).pages.get(`${read.sessionId}:${read.resource}`)
    if (body === undefined) throw new Error('Unknown preview for this Session')
    return text(read, body)
  }],
  // 上游 `sessionController.modelCatalog()` 的 `{ default, groups, failures }`；本仓 llm 服务给扁平的模型清单，
  // 这里按 provider 分组补齐 groups 的形状。`failures` 没有对应物（端点配置坏时 listModels 自己抛错），如实给空表。
  ['models', async read => {
    const host = main(read), llm = host.context.get('llm')
    if (llm === undefined) throw new Error('Model catalog unavailable: the host has no llm service')
    const settings = host.store.settings()
    const roles = { orchestrator: settings.eval.model, worker: settings.executor.model }
    const providers = providersOf(llm.listModels())
    return { default: { provider: llm.provider, model: llm.model }, roles, failures: [],
      providers: providers.map(group => ({ id: group.id, name: group.name, count: group.models.length, read: `models/${group.id}` })) }
  }],
  ['models/', async read => {
    const llm = main(read).context.get('llm')
    if (llm === undefined) throw new Error('Model catalog unavailable: the host has no llm service')
    const group = providersOf(llm.listModels()).find(item => item.id === read.rest)
    if (!group) throw new Error('Unknown model provider')
    return list(read, (offset, count) => group.models.slice(offset, offset + count).map(modelLine))
  }],
  ['feishu/', async read => {
    const source = trigger(read.host, read.rest.split('/')[0]!, read.ticketId)
    const ref = feishuRef(source)
    if (!ref) throw new Error('A Feishu source trigger is required')
    const commands = read.host.commands.withSignal(read.signal)
    return sourcePage(read, 'feishu', () => feishuRead(commands, ref, read.resource, read.host.feishuPageSize()))
  }],
  ['github/', read => sourcePage(read, 'github', () => readGithub(read.host.commands.withSignal(read.signal), read.resource))],
  ['trigger/', async read => {
    const { host, rest, ticketId, offset, signal } = read
    if (!rest || rest.includes('/')) throw new Error('Unknown context resource')
    const found = trigger(host, rest, ticketId)
    const ref = feishuRef(found)
    // Redact decision IDs, other tickets, and unreachable neighbour triggers when a worker session reads a trigger.
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    const shown = (item: Trigger | undefined) => item && (!ticket || readable(host, ticket, item)) ? item : undefined
    const disposition = host.store.triggers.disposition(found.id)
    const visible = disposition && ticket ? { ...disposition, decisionId: undefined, fanout: disposition.fanout.filter(id => id === ticket.id) }
      : disposition
    // Omit card preview and self-reference because this resource returns the full text.
    const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible)
    const parent = found.source === 'feishu' && typeof found.meta.parentId === 'string' ? found.meta.parentId : undefined
    const repliedTo = shown(parent ? host.store.triggers.get(feishuTriggerId(parent)) : undefined)
    const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id)
    const around = { before: shown(neighbours.before), after: shown(neighbours.after) }
    return { ...card, ...await host.sourceLink(found, signal), acknowledgement: host.store.replyStatus(key('ack', found.id)) ?? 'not_requested',
      ...(ref ? { context: feishuReferences(ref) } : {}),
      ...(offset === 0 ? {
        ...repliedTo ? { replied_to: triggerLine(repliedTo) } : {},
        around: { ...around.before ? { before: triggerLine(around.before) } : {}, ...around.after ? { after: triggerLine(around.after) } : {} },
      } : {}),
      ...text(read, found.text) }
  }],
  ['ticket/', async read => {
    const { host, resource, rest, ticketId, signal } = read
    const [id, section, part, ...more] = rest.split('/')
    if (!id || more.length) throw new Error('Unknown context resource')
    if (ticketId && ticketId !== id) throw new Error('Ticket does not belong to this worker')
    const ticket = host.store.tickets.get(id)
    if (!ticket) throw new UserError('unknownTicket')
    if (section === undefined) {
      const running = runningAssignment(ticket) && workerSessionId(ticket.id)
      const retry = 'sessions' in host ? (host as MainResourceHost).sessions.modelRetry(running) : {}
      // Merge subscribed threads (including context-only subscriptions) and source-bound threads without duplicates.
      const bound = new Set((ticket.follows ?? []).map(follow => follow.thread))
      const subscribed = host.store.read.subscribedThreads().filter(thread => thread.subscriptions.includes(id))
      const marked = (key: string, context: boolean): TicketThread =>
        ({ thread: key, ...context ? { context: true } : {}, ...bound.has(key) ? { bound: true } : {} })
      const threads = [...subscribed.map(thread => marked(thread.key, !!thread.context?.includes(id))),
        ...[...bound].filter(key => !subscribed.some(thread => thread.key === key)).map(key => marked(key, false))]
      return { ...ticketDetails(ticket, threads, batchOf(host, ticket), !!ticketId), ...retry }
    }
    if (section === 'assignments' || section === 'inputs') {
      if (part !== undefined) throw new Error('Unknown context resource')
      const size = Math.min(read.limit ?? (section === 'assignments' ? ASSIGNMENTS : INPUTS), 50)
      const { items, next_offset } = section === 'assignments'
        ? newestPage(ticket.assignments, read.offset, size, item => assignmentLine(ticket, item), resource)
        : newestPage(ticket.inputs, read.offset, size, input => inputLine(ticket, input, !!ticketId), resource)
      return { items, next_offset: next_offset ?? null }
    }
    let body: string
    if (section === 'input' && part) {
      // Render the input on demand with its resolved source link, matching either its short key or full input ID.
      const input = ticket.inputs.find(item => key(item.id) === part || item.id === part)
      const inputTrigger = input?.kind === 'trigger' ? host.store.triggers.get(input.triggerId) : undefined
      const card = inputTrigger && input?.kind === 'trigger' ? triggerMessage(inputTrigger, await host.sourceLink(inputTrigger, signal), input.note) : undefined
      const message = input && inputMessage(input, card)
      if (message === undefined) throw new Error('Unknown ticket input')
      body = message
    } else if (section === 'message' && part && /^\d+$/.test(part)) {
      const event = (await transcript(host, id))[Number(part)]
      const entry = event && transcriptEntry(event)
      if (!entry) throw new Error('Unknown transcript entry')
      body = JSON.stringify(entry)
    } else if (section === 'report' && part) {
      const report = ticket.assignments.find(item => item.id === part)?.report
      if (!report) throw new Error('Unknown assignment report')
      body = report.summary
    } else if (part !== undefined) throw new Error('Unknown context resource')
    else if (section === 'assignment') body = ticket.execution?.assignment ?? ''
    else if (section === 'result') body = latestReport(ticket)?.summary ?? ''
    else if (section === 'transcript') {
      body = (await transcript(host, id)).flatMap((event, index) => {
        const entry = transcriptEntry(event)
        const said = entry?.message.content.map(block => 'text' in block ? block.text : `[${block.type}]`).join(' ') ?? ''
        return entry ? [{ type: entry.type, preview: preview(said).slice(0, 80), chars: JSON.stringify(entry).length,
          read: `ticket/${id}/message/${index}` }] : []
      }).reverse().map(event => JSON.stringify(event)).join('\n')
    } else throw new Error('Unknown context resource')
    return text(read, body)
  }],
]

/**
 * Read a paginated resource for the main Session or a ticket's worker Session.
 * Legacy prefixes (`event/`, `task/`, `observation/`) remain accepted so references in older Session history stay readable.
 */
export async function readResource(host: ResourceHost, resource: string, offset: number, limit: number | undefined, ticketId?: string,
  signal?: AbortSignal) {
  const name = resource.replace(/^event\//, 'trigger/').replace(/^task\//, 'ticket/').replace(/^observation\//, 'decision/')
  const route = ROUTES.find(([route]) => route.endsWith('/') ? name.startsWith(route) : name === route)
  if (!route) throw new Error('Unknown context resource')
  const sessionId = ticketId ? workerSessionId(ticketId) : host.masterId
  const rest = route[0].endsWith('/') ? name.slice(route[0].length) : ''
  return route[1]({ host, resource: name, rest, offset, sessionId, ...limit ? { limit } : {}, ...ticketId ? { ticketId } : {},
    ...signal ? { signal } : {} })
}
