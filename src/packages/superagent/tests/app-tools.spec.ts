/**
 * `app/tools/main.ts`、`app/tools/executor.ts`、`app/tools/tool.ts` 的补盲：主会话与执行者会话
 * 工具的名字、参数 schema、判定顺序、拒绝文案与结果形状。
 *
 * 宿主端口、engine、store 都是对象字面量假件（只实现被测工具真用到的成员），不建真运行期、
 * 不碰 `~/.dsc`；断言的是工具 `execute` 的真实返回值。
 *
 * @module dsc/packages/superagent/tests/app-tools
 */
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { UserError } from '../core/index.js'
import { SettingsSchema } from '../core/policy.js'
import { defaultPrompts } from '../app/prompts.js'
import { executorTools } from '../app/tools/executor.js'
import { mainTools } from '../app/tools/main.js'
import { AcknowledgementSchema, readTool, tool } from '../app/tools/tool.js'
import type { Ticket, Decision } from '../core/index.js'
import type { Tool } from '../app/tools/tool.js'

const AT = '2026-01-01T00:00:00.000Z'
const TICKET = 'ticket-a'
const AGENT = { id: 'master-session', role: 'orchestrator' }
const signal = new AbortController().signal
/** `words(n)`：造恰好 n 个词的文本，用来踩词数上限。 */
const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')

/** 能让 `ticketCard` 渲染的最小工单。 */
function fakeTicket(id = TICKET, over: Record<string, unknown> = {}): Ticket {
  return {
    id, title: 'Fix typo', decisionId: 'decision-1',
    mandate: { strength: 'explicit', scope: 'Fix typo', actor: { source: 'feishu', id: 'bob' } },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, ...over,
  } as unknown as Ticket
}

/** 由一次引擎判定结论造一张 Decision。 */
function decisionOf(triggerId: string, outcome: { kind: string; reason?: unknown; ticketId?: string }, over: Record<string, unknown> = {}): Decision {
  const reason = typeof outcome.reason === 'string' ? [{ code: 'said', values: { text: outcome.reason } }] : [outcome.reason ?? { code: 'explicitRouted' }]
  const base = { id: `decision-${triggerId}`, kind: outcome.kind, reason, triggerIds: [triggerId], strength: 'explicit',
    threadKey: 'feishu:om_1', at: AT, ...over }
  // accept 的判定默认带一张工单（与上游假件同形）；别的 kind 只在用例点名时带。
  const ticketId = outcome.ticketId ?? (outcome.kind === 'accept' ? TICKET : undefined)
  return { ...base, ...(ticketId ? { ticketId } : {}) } as unknown as Decision
}

/** 主会话宿主假件：只实现 `MainToolsHost` 里被测工具会碰的成员，并记下每次端口调用。 */
function mainHost(options: Record<string, (() => unknown) | unknown> = {}) {
  const calls = { decide: [] as unknown[][], attach: [] as unknown[][], reply: [] as unknown[], requestStatus: [] as string[],
    note: [] as unknown[][], retryTicket: [] as string[], reevaluate: [] as string[], unsubscribe: [] as string[],
    pass: 0, sendReplies: 0, warn: [] as unknown[][], notify: [] as unknown[][], settingsSave: [] as unknown[][],
    pause: [] as unknown[][], synced: [] as string[], assessor: [] as unknown[] }
  const tickets = new Map<string, Ticket>([[TICKET, fakeTicket()]])
  const triggers = new Map<string, unknown>()
  const store = {
    tickets: { get: (id: string) => tickets.get(id) },
    triggers: { get: (id: string) => triggers.get(id),
      disposition: (id: string) => (options['disposition'] as ((id: string) => unknown) | undefined)?.(id) },
    threads: { get: () => undefined },
    atomic: <T>(work: () => T): T => work(),
    replyStatus: () => options['replyStatus'] ?? 'sent',
    settings: () => options['settings'] ?? SettingsSchema.parse({}),
  }
  const host = {
    context: { logger: { warn: (...args: unknown[]) => { calls.warn.push(args) } } },
    engine: {
      decide(triggerId: string, outcome: { kind: string; reason?: unknown }) {
        calls.decide.push([triggerId, outcome])
        const custom = options['decide'] as ((triggerId: string, outcome: unknown) => Decision) | undefined
        return custom ? custom(triggerId, outcome) : decisionOf(triggerId, outcome)
      },
      attach(ticketId: string, triggerId: string, note?: string) {
        calls.attach.push([ticketId, triggerId, note])
        const custom = options['attach'] as ((ticketId: string, triggerId: string) => Ticket) | undefined
        if (custom) return custom(ticketId, triggerId)
        return tickets.get(ticketId) ?? fakeTicket(ticketId)
      },
      reply(message: unknown) { calls.reply.push(message); return options['reply'] ?? { id: 'reply-1', status: 'sent', reused: false } },
      requestStatus(id: string) { calls.requestStatus.push(id); return options['requestStatus'] ?? true },
      note(id: string, text: string) { calls.note.push([id, text]) },
      retryTicket(id: string) { calls.retryTicket.push(id); return tickets.get(id) ?? fakeTicket(id) },
      reevaluate(id: string) { calls.reevaluate.push(id); return options['reevaluate'] ?? true },
      unsubscribe(thread: string) { calls.unsubscribe.push(thread); return options['unsubscribe'] ?? true },
    },
    store,
    prompts: { preview: (config: unknown) => ({ scope: 'Scope', orchestrator: `orchestrator:${JSON.stringify(config)}`,
      worker: 'worker prompt' }), save: (config: unknown, baseRevision: number) => ({ revision: baseRevision + 1, config }) },
    sessions: { status: () => 'idle', notify: (...args: unknown[]) => { calls.notify.push(args) },
      delivery: async () => 'injected', modelRetry: () => ({}) },
    settings: {
      view: () => ({}),
      block: () => ({}),
      save: async (block: string, value: unknown, revision: number, origin: string) => {
        calls.settingsSave.push([block, value, revision, origin])
        return { block, revision: revision + 1, context_delivery: 'injected' }
      },
      pause: async (paused: boolean, origin: string) => { calls.pause.push([paused, origin]); return { paused } },
      sync: async (source: string) => { calls.synced.push(source); return { allowed: options['synced'] ?? [] } },
    },
    assessor: {
      context: async (triggerId: string) => ({ trigger_id: triggerId }),
      read: async (agent: unknown, read: unknown) => { calls.assessor.push(['read', read]); return { text: 'read body' } },
      decide: async (triggerId: string, result: unknown) => {
        calls.assessor.push(['decide', triggerId, result])
        return options['assessorDecision'] ?? { state: 'accept', ticket_id: TICKET, reason: 'Explicit request from an allowed sender routed by the orchestrator' }
      },
    },
    resources: { pages: new Map<string, string>() },
    requestPass() { calls.pass += 1 },
    sendReplies: async () => { calls.sendReplies += 1 },
    quietly<T>(run: () => T): T { return run() },
  }
  return { host, calls, tickets, triggers }
}

/** 主会话工具表：按名字取工具，`run` 先用工具自己的 schema 解析参数再执行。 */
function mainToolsOf(options: Record<string, unknown> = {}) {
  const { host, calls, tickets, triggers } = mainHost(options as Record<string, () => unknown>)
  const tools = Object.fromEntries(mainTools(host as never, AGENT as never).map(item => [item.name, item]))
  const run = async (name: string, args: unknown) => {
    const item = tools[name] as Tool
    return item.execute(item.schema.parse(args), signal)
  }
  return { tools, calls, tickets, triggers, run, host }
}

/** 执行者宿主假件：只实现 `executorTools` 用的成员。 */
function executorHost(options: Record<string, unknown> = {}) {
  const calls = { report: [] as unknown[][], reply: [] as unknown[], handback: [] as unknown[][],
    followForContext: [] as unknown[][], markUnrelated: [] as unknown[][], relay: [] as unknown[][],
    notify: [] as unknown[][], sendReplies: 0 }
  const ticket = (options['ticket'] as Ticket | undefined) ?? fakeTicket()
  const host = {
    engine: {
      report(id: string, report: { question?: string }) {
        calls.report.push([id, report])
        const custom = options['report'] as ((id: string, report: unknown) => unknown) | undefined
        if (custom) return custom(id, report)
        return { ...ticket, ...report.question ? { attention: { id: 'attention-1', question: report.question } } : {} }
      },
      reply(message: unknown) { calls.reply.push(message); return options['reply'] ?? { id: 'reply-1', status: 'sent', reused: false } },
      markUnrelated(id: string, thread: string, reason: string) { calls.markUnrelated.push([id, thread, reason]) },
      handback(id: string, triggerId: string, reason: string) { calls.handback.push([id, triggerId, reason]); return options['handback'] ?? true },
      followForContext(id: string, ref: unknown) { calls.followForContext.push([id, ref]); return options['followed'] ?? true },
    },
    store: { tickets: { get: () => options['stored'] ?? ticket }, replyStatus: () => options['replyStatus'] ?? 'sent',
      atomic: <T>(work: () => T): T => work() },
    sessions: { relay: (id: string, text: string) => { calls.relay.push([id, text]) }, notify: (...args: unknown[]) => { calls.notify.push(args) } },
    resources: { pages: new Map<string, string>() },
    github: { deployment: { github: { login: 'agent-bot' } } },
    sendReplies: async () => { calls.sendReplies += 1 },
  }
  const tools = Object.fromEntries(executorTools(host as never, ticket).map(item => [item.name, item]))
  const run = async (name: string, args: unknown) => {
    const item = tools[name] as Tool
    return item.execute(item.schema.parse(args), signal)
  }
  return { host, tools, run, calls, ticket }
}

describe('主会话工具：orchestrator_route', () => {
  test('一条缺字段或越界只拒这一条并点名字段；别的 kind 的字段不读', async () => {
    const { run, calls } = mainToolsOf()
    const result = await run('orchestrator_route', { decisions: [
      { kind: 'accept', trigger_id: 'a', title: 'Fix', acknowledgement: '收到。' },
      { kind: 'accept', trigger_id: 'b', title: 'Fix', worktree_name: 'one-two-three-four-five', acknowledgement: '收到。' },
      { kind: 'accept', trigger_id: 'c', title: 'Fix', worktree_name: 'fix-c', acknowledgement: '收到。', note: words(31) },
      { kind: 'accept', trigger_id: 'd', title: '', worktree_name: 'fix-d', acknowledgement: '收到。' },
      { kind: 'ignore', trigger_id: 'e', reason: 'chat', ticket_id: null, title: null, note: null },
    ] }) as { results: Record<string, unknown>[] }
    expect(result.results[0]).toStrictEqual({ trigger_id: 'a', kind: 'accept', refused: 'accept needs worktree_name' })
    expect(String(result.results[1]!.refused)).toMatch(/^worktree_name: Use 1–4 short English words/)
    expect(String(result.results[2]!.refused)).toMatch(/^note: Routing note must not exceed 30 words/)
    expect(result.results[3]).toStrictEqual({ trigger_id: 'd', kind: 'accept', refused: 'accept needs title' })
    // 第五条是 ignore：ticket_id / title / note 都为 null 也不读，照常判。
    expect(result.results[4]).toStrictEqual({ trigger_id: 'e', kind: 'ignore', decision: 'ignore', reason: 'chat' })
    expect(calls.decide).toHaveLength(1)
    expect(calls.pass).toBe(1)
  })

  test('一条被引擎拒（UserError）或意外失败，不影响同批其他条；意外失败留 warn 日志', async () => {
    const { run, calls } = mainToolsOf({
      attach: (ticketId: string, triggerId: string) => {
        if (triggerId === 'more') throw new Error('database is locked')
        if (ticketId === 'no-such-ticket') throw new UserError('unknownTicket')
        return fakeTicket(ticketId)
      },
    })
    const result = await run('orchestrator_route', { decisions: [
      { kind: 'ignore', trigger_id: 'thanks', reason: 'Thanks only.' },
      { kind: 'stop', trigger_id: 'request' },
      { kind: 'accept', trigger_id: 'request', title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' },
      { kind: 'attach', trigger_id: 'other', ticket_id: 'no-such-ticket' },
      { kind: 'attach', trigger_id: 'more', ticket_id: TICKET },
    ] }) as { results: Record<string, unknown>[] }
    expect(result.results[0]).toStrictEqual({ trigger_id: 'thanks', kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' })
    expect(result.results[1]).toStrictEqual({ trigger_id: 'request', kind: 'stop', refused: 'stop needs ticket_id' })
    expect(result.results[2]!.decision).toBe('accept')
    expect((result.results[2]!.ticket as { ticket_id: string }).ticket_id).toBe(TICKET)
    expect(result.results[3]).toStrictEqual({ trigger_id: 'other', kind: 'attach', refused: 'Unknown ticket' })
    expect(result.results[4]).toStrictEqual({ trigger_id: 'more', kind: 'attach', refused: 'Not recorded: database is locked; retry this item' })
    expect(calls.warn).toHaveLength(1)
    expect(calls.warn[0]![1]).toBe('more')
  })

  test('一条决定整批后：同批再 ignore 被拒，再 accept 回「已接受」；四个 kind 各自落到引擎调用', async () => {
    const { run, calls } = mainToolsOf({
      decide: (triggerId: string, outcome: { kind: string; reason?: unknown }) => triggerId === 'first'
        ? decisionOf(triggerId, { ...outcome, ticketId: TICKET }, { triggerIds: ['first', 'second'] })
        : decisionOf(triggerId, { ...outcome, ticketId: TICKET }, { id: 'decision-first' }),
      disposition: (triggerId: string) => triggerId === 'second' ? { decisionId: 'decision-first' } : undefined,
    })
    const batch = await run('orchestrator_route', { decisions: [
      { kind: 'accept', trigger_id: 'first', title: 'Retitle', worktree_name: 'retitle', acknowledgement: '收到。' },
      { kind: 'accept', trigger_id: 'second', title: 'Another', worktree_name: 'fix-other', acknowledgement: '收到。' },
      { kind: 'ignore', trigger_id: 'second', reason: 'chat' },
    ] }) as { results: Record<string, unknown>[] }
    expect(batch.results[0]!.decision).toBe('accept')
    expect(batch.results[1]!.decision).toBe('accept')
    expect(batch.results[1]!.reason).toBe(`Already accepted as ${TICKET}; title and acknowledgement unchanged`)
    expect(batch.results[2]).toStrictEqual({ trigger_id: 'second', kind: 'ignore',
      refused: 'Decided in this call with first, whose Decision took its batch' })

    calls.decide.length = 0
    const four = await run('orchestrator_route', { decisions: [
      { kind: 'accept', trigger_id: 'a', title: 'Fix', worktree_name: 'fix-typo', acknowledgement: '收到。', note: 'Copy fix.' },
      { kind: 'attach', trigger_id: 'b', ticket_id: TICKET, note: 'Same ticket.' },
      { kind: 'stop', trigger_id: 'c', ticket_id: TICKET, reason: 'Not needed after all' },
      { kind: 'ignore', trigger_id: 'd', reason: 'Thanks only.' },
    ] }) as { results: Record<string, unknown>[] }
    expect(four.results[0]).toMatchObject({ decision: 'accept', ticket: { ticket_id: TICKET, title: 'Fix typo', state: 'working/queued',
      strength: 'explicit', preview: '', read: `ticket/${TICKET}` } })
    expect(four.results[1]).toMatchObject({ reason: 'Attached: the ticket follows the trigger\'s thread and receives the trigger' })
    expect(calls.attach).toStrictEqual([[TICKET, 'b', 'Same ticket.']])
    expect(four.results[2]).toMatchObject({ decision: 'stop', reason: 'Not needed after all' })
    expect(four.results[3]).toMatchObject({ decision: 'ignore', reason: 'Thanks only.' })
    expect(calls.decide.map(([, outcome]) => (outcome as { kind: string }).kind)).toStrictEqual(['accept', 'stop', 'ignore'])
  })

  test('accept 没造出工单时按拒绝回话，理由用引擎给的原因', async () => {
    const { run } = mainToolsOf({
      decide: (triggerId: string, outcome: { kind: string }) => decisionOf(triggerId, { kind: 'ignore', reason: { code: 'noAdmissible' } }),
    })
    const result = await run('orchestrator_route', { decisions: [
      { kind: 'accept', trigger_id: 'a', title: 'Fix', worktree_name: 'fix-typo', acknowledgement: '收到。' },
    ] }) as { results: Record<string, unknown>[] }
    expect(result.results[0]).toStrictEqual({ trigger_id: 'a', kind: 'accept', refused: 'Ticket was not created: No admissible trigger' })
  })
})

describe('主会话工具：其余 12 个', () => {
  test('重试、要状态、留言、重排各自映射到引擎并排一拍', async () => {
    const { run, calls, triggers } = mainToolsOf({ requestStatus: false })
    const retried = await run('orchestrator_ticket_retry', { ticket_id: TICKET })
    expect(retried).toMatchObject({ reason: 'Started a new assignment', ticket: { ticket_id: TICKET } })
    expect(calls.retryTicket).toStrictEqual([TICKET])
    const status = await run('orchestrator_ticket_request_status', { ticket_id: TICKET })
    expect(status).toMatchObject({ reason: 'The worker is not waiting; nothing was sent' })
    await expect(run('orchestrator_ticket_note', { ticket_id: TICKET, text: words(101) })).rejects.toThrow(/At most 100 words/)
    expect(await run('orchestrator_ticket_note', { ticket_id: TICKET, text: 'From another ticket.' }))
      .toMatchObject({ reason: 'Noted for the worker' })
    expect(calls.note).toStrictEqual([[TICKET, 'From another ticket.']])
    // 归属某张工单的 follow-up：主会话不能重排，要报接手它的工单。
    const owned = mainToolsOf({ disposition: () => ({ fanout: [TICKET] }) })
    owned.triggers.set('owned', { id: 'owned', human: true, threads: [{ source: 'feishu', id: 'om_1' }] })
    await expect(owned.run('orchestrator_trigger_requeue', { trigger_id: 'owned' })).rejects.toMatchObject({ code: 'workerDecides' })
    expect(owned.calls.reevaluate).toStrictEqual([])
    expect(await run('orchestrator_trigger_requeue', { trigger_id: 'nowhere' })).toStrictEqual({ queued: true })
    expect(calls.reevaluate).toStrictEqual(['nowhere'])
    expect(triggers.size).toBe(0)
    // 重试 / 要状态 / 留言都经 routed 排一拍，重排自己排一拍。
    expect(calls.pass).toBe(4)
  })

  test('eval / eval_read / eval_decide 三个判定工具', async () => {
    const { run, calls } = mainToolsOf()
    expect(await run('orchestrator_eval', { trigger_id: 'trigger-1' })).toStrictEqual({ trigger_id: 'trigger-1' })
    expect(await run('orchestrator_eval_read', { trigger_id: 'trigger-1', resource: 'thread' })).toStrictEqual({ text: 'read body' })
    const direction = { implementation_requested: false, target_basis: 'undetermined', requires_design_decision: false, evidence: 'chatter' }
    const decided = await run('orchestrator_eval_decide', { trigger_id: 'trigger-1', decision: 'ignore', rule_assessments: [],
      direction, title: 't', scope: 's', reason: 'r' }) as { decision: string; reason: string }
    expect(decided.decision).toBe('accept')
    expect(decided.reason).toBe('Explicit request from an allowed sender routed by the orchestrator')
    expect(calls.assessor).toContainEqual(['decide', 'trigger-1', expect.objectContaining({ decision: 'ignore' })])
  })

  test('回复、退订：回状态取 replyStatus，回复后补发一次；退订经 quietly 走引擎', async () => {
    const { run, calls } = mainToolsOf({ replyStatus: 'dropped' })
    expect(await run('orchestrator_reply', { ticket_id: TICKET, purpose: 'result', text: 'Done.' })).toStrictEqual({ status: 'dropped' })
    expect(calls.reply).toStrictEqual([{ purpose: 'result', text: 'Done.', ticketId: TICKET }])
    expect(calls.sendReplies).toBe(1)
    expect(await run('orchestrator_thread_unsubscribe', { thread: 'github:123' })).toStrictEqual({ removed: true, thread: 'github:123' })
    expect(calls.unsubscribe).toStrictEqual(['github:123'])
  })

  test('settings_save：pause 走 pause；保存剥掉 context_delivery；source 必须点名实例', async () => {
    const { run, calls } = mainToolsOf()
    await expect(run('orchestrator_settings_save', { block: 'source', value: { enabled: false, config: {} }, revision: 0 }))
      .rejects.toThrow(/source names the Source instance, with block source only/)
    expect(await run('orchestrator_settings_save', { block: 'eval', value: { mode: 'auto' }, revision: 3 }))
      .toStrictEqual({ block: 'eval', revision: 4 })
    expect(calls.settingsSave).toStrictEqual([['eval', { mode: 'auto' }, 3, 'tool']])
    const bySource = await run('orchestrator_settings_save', { block: 'source', source: 'github', value: { enabled: false, config: {} }, revision: 1 }) as { block: string }
    expect(bySource.block).toBe('source:github')
    expect(await run('orchestrator_settings_save', { block: 'pause', value: { paused: true }, revision: 0 })).toStrictEqual({ paused: true })
    expect(calls.pause).toStrictEqual([[true, 'tool']])
  })

  test('policy_sync 只回报数量与增删的名字', async () => {
    const { run, calls } = mainToolsOf({ settings: SettingsSchema.parse({ policy: { sources: { github: { allowed: [{ id: 'ou_a', name: 'Alice' }] } } } }),
      synced: [{ id: 'ou_a', name: 'Alice' }, { id: 'ou_b', name: 'Bob' }] })
    expect(await run('orchestrator_policy_sync', { source: 'github' }))
      .toStrictEqual({ source: 'github', allowed: 2, added: ['Bob'], removed: [] })
    expect(calls.synced).toStrictEqual(['github'])
    const removing = mainToolsOf({ settings: SettingsSchema.parse({ policy: { sources: { github: { allowed: [{ id: 'ou_a', name: 'Alice' }] } } } }),
      synced: [] })
    expect((await removing.run('orchestrator_policy_sync', { source: 'github' }) as { removed: string[] }).removed).toStrictEqual(['Alice'])
  })

  test('prompts_save：preview 两个角色各出一个可读资源，缺 baseRevision 拒绝保存', async () => {
    const { run, host } = mainToolsOf()
    const preview = await run('orchestrator_prompts_save', { config: defaultPrompts(), preview: true }) as {
      previews: { role: string; chars: number; read: string }[] }
    expect(preview.previews.map(item => item.role)).toStrictEqual(['orchestrator', 'worker'])
    expect(host.resources.pages.size).toBe(2)
    expect([...host.resources.pages.keys()].every(key => key.startsWith(`${AGENT.id}:prompt-preview/`))).toBe(true)
    expect(preview.previews[0]!.chars).toBeGreaterThan(0)
    await expect(run('orchestrator_prompts_save', { config: defaultPrompts() })).rejects.toThrow(/Saving needs baseRevision/)
    const saved = await run('orchestrator_prompts_save', { config: defaultPrompts(), baseRevision: 2 }) as { revision: number }
    expect(saved.revision).toBe(3)
  })
})

describe('执行者工具', () => {
  test('ack：回执经引擎排队，返回回复状态；未出账时补发', async () => {
    const sent = executorHost()
    expect(await sent.run('orchestrator_ack', { trigger_id: 'trigger-1', text: '收到' }))
      .toStrictEqual({ trigger_id: 'trigger-1', acknowledgement: 'sent', reused: false })
    expect(sent.calls.reply).toStrictEqual([{ purpose: 'acknowledgement', ticketId: TICKET, triggerId: 'trigger-1', text: '收到' }])
    expect(sent.calls.sendReplies).toBe(0)
    const pending = executorHost({ reply: { id: 'reply-1', status: 'pending', reused: true }, replyStatus: 'pending' })
    expect(await pending.run('orchestrator_ack', { trigger_id: 'trigger-1', text: '收到' }))
      .toStrictEqual({ trigger_id: 'trigger-1', acknowledgement: 'pending', reused: true })
    expect(pending.calls.sendReplies).toBe(1)
    await expect(sent.run('orchestrator_ack', { trigger_id: 'trigger-1', text: words(101) }))
      .rejects.toThrow(/An acknowledgement has at most 100 words/)
  })

  test('report：工单已结束就拒绝；progress 只记内部；问题转成 attention 中继', async () => {
    const ended = executorHost({ stored: fakeTicket(TICKET, { ended: { at: AT, by: 'human', outcome: 'stopped' } }) })
    await expect(ended.run('orchestrator_report', { state: 'progress', summary: 'Still going.' }))
      .rejects.toThrow(/Ticket ended \(PR was closed or work finished\); do not resume it/)
    expect(ended.calls.report).toStrictEqual([])
    const progress = executorHost()
    expect(await progress.run('orchestrator_report', { state: 'progress', summary: 'Needs a decision.' }))
      .toStrictEqual({ reported: true, notification: 'internal_only' })
    expect(progress.calls.relay).toStrictEqual([])
    const attention = executorHost()
    const reported = await attention.run('orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: 'Desktop too?' }) as {
      notification: string; attention: { question: string } }
    expect(reported.notification).toBe('orchestrator')
    expect(reported.attention.question).toBe('Desktop too?')
    expect(attention.calls.relay).toHaveLength(1)
    expect(attention.calls.relay[0]![0]).toBe(`attention:${TICKET}:attention-1`)
  })

  test('线程工具：跟踪只收 <source>:<id> 并通知，弃跟与交回各自落账', async () => {
    const { run, calls, tools } = executorHost()
    await expect(run('orchestrator_thread_follow', { thread: 'github', reason: 'Related.' }))
      .rejects.toThrow(/A thread key is <source>:<id>, such as github:<number>/)
    expect(calls.followForContext).toStrictEqual([])
    expect(await run('orchestrator_thread_follow', { thread: 'github:9', reason: 'The Issue it fixes.' }))
      .toStrictEqual({ followed: true, thread: 'github:9' })
    expect(calls.followForContext).toStrictEqual([[TICKET, { source: 'github', id: '9' }]])
    expect(calls.notify).toHaveLength(1)
    const quiet = executorHost({ followed: false })
    expect(await quiet.run('orchestrator_thread_follow', { thread: 'github:9', reason: 'Related.' }))
      .toStrictEqual({ followed: false, thread: 'github:9' })
    expect(quiet.calls.notify).toStrictEqual([])
    expect(await run('orchestrator_thread_unrelated', { thread: 'feishu:oc_1:om_1', reason: 'Another topic.' }))
      .toStrictEqual({ removed: true, thread: 'feishu:oc_1:om_1' })
    expect(calls.markUnrelated).toStrictEqual([[TICKET, 'feishu:oc_1:om_1', 'Another topic.']])
    expect(await run('orchestrator_trigger_handback', { trigger_id: 'trigger-2', reason: 'Another change.' }))
      .toStrictEqual({ trigger_id: 'trigger-2', queued: true })
    expect(calls.handback).toStrictEqual([[TICKET, 'trigger-2', 'Another change.']])
    expect(tools.orchestrator_report!.schema).toBeDefined()
  })
})

describe('共享原语 tool.ts', () => {
  test('tool 原样返回定义；readTool 解析默认 offset 并透传参数', async () => {
    const definition = { name: 'probe', description: 'Probe.', schema: z.object({}), execute: async () => 'ok' }
    expect(tool(definition)).toBe(definition)
    const seen: unknown[][] = []
    const read = readTool('Read page.', false, async (...args) => { seen.push(args); return 'body' })
    expect(read.name).toBe('orchestrator_read')
    expect(await read.execute(read.schema.parse({ resource: 'tickets' }), signal)).toBe('body')
    expect(seen[0]![1]).toBe(0)
    expect(seen[0]![2]).toBeUndefined()
    expect(read.schema.safeParse({ resource: 'tickets', limit: 8001 }).success).toBe(false)
    expect(read.schema.safeParse({ resource: 'tickets', extra: true }).success).toBe(false)
    // executor 版本的资源说明只列 executor 能读的项。
    const executorRead = readTool('Read.', true, async () => 'x')
    expect(executorRead.description).not.toMatch(/prompts\/defaults:/)
  })

  test('AcknowledgementSchema 按词数卡，空白串拒绝', () => {
    expect(AcknowledgementSchema.safeParse(words(100)).success).toBe(true)
    expect(AcknowledgementSchema.safeParse(words(101)).success).toBe(false)
    expect(AcknowledgementSchema.safeParse('   ').success).toBe(false)
  })
})
