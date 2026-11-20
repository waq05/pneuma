/**
 * `app/migration.ts` 的包级覆盖测试：schema 10 → schema 11 迁移。
 *
 * 为什么这条链要逐段钉：升级发生在启动那一刻，坏了不会报「迁移失败」，而是旧库被读成半成品——
 * 工单丢掉 origin、消息收据丢失、设置版本倒退、Prompt 内容被读成上一版。最坏的是迁移跑一半
 * 留下半张新表，下一次启动再也起不来。所以每条都断言「迁完之后读到什么」，并且验证失败时
 * 数据库原样停在 schema 10。
 *
 * 夹具形状照上游 spec：先用当前 `Store` 建一次库，再把 outbox 降级成带 `sent` 列的 schema 10 形状、
 * 把版本号改回 10、补上遗留的 `inbox` 表，这样就得到一个真实的「旧库」。
 *
 * @module @pneuma/superagent/tests/app-migration
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'vitest'
import { SCHEMA_VERSION, Store } from '../app/store.js'
import { KV } from '../kv.js'
import { basisOf, reasonsOf, withoutCopies } from '../app/migration.js'
import { Prompts, composePrompt, defaultPrompts } from '../app/prompts.js'
import { masterPrompt } from '../app/context.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

/** 每个用例一个临时目录：用例之间不共享库文件，失败也不会互相污染。 */
function tempRoot(label: string): string {
  return createTempDir(`dsc-sa-mig-${label}-`)
}

/** 上游 `expect(...).toMatchObject(...)` 的等价物：对象逐键递归包含，数组要求等长且逐项包含，其余严格相等。 */
function matchObject(actual: any, expected: any): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `期望数组，实际是 ${typeof actual}`)
    assert.equal(actual.length, expected.length)
    expected.forEach((item, index) => { matchObject(actual[index], item) })
    return
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `期望对象，实际是 ${String(actual)}`)
    for (const [name, value] of Object.entries(expected)) matchObject(actual[name], value)
    return
  }
  assert.deepEqual(actual, expected)
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 造一个 schema 10 形状的库：带遗留 `outbox.sent` 列、`inbox` 表，版本号写 10。 */
function schema10(path: string, records: Record<string, unknown>, rows: { ticket?: any[]; decision?: any[]; thread?: any[]; trigger?: any[] } = {}): void {
  new Store(path).close()
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE outbox; CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)')
  const set = (name: string, value: unknown) => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  set('schema', 10)
  for (const [name, value] of Object.entries(records)) set(name, value)
  for (const row of rows.ticket ?? []) db.prepare('INSERT INTO ticket VALUES (?,?)').run(row.id, JSON.stringify(row))
  for (const row of rows.decision ?? []) db.prepare('INSERT INTO decision VALUES (?,?,?)').run(row.id, row.threadKey, JSON.stringify(row))
  for (const row of rows.thread ?? []) db.prepare('INSERT INTO thread VALUES (?,?)').run(row.key, JSON.stringify(row))
  for (const row of rows.trigger ?? []) db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(row.id, JSON.stringify(row), row.at)
  db.exec('CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.close()
}

const actor = { source: 'feishu', id: 'ou_alice' }
const mandate = (basis: unknown) => ({ strength: 'explicit', policyVersion: 'v1', basis, actor, scope: 'small' })

/** 在临时目录里造一个 schema 10 库并打开迁移后的 Store。 */
function opened(label: string, records: Record<string, unknown>): Store {
  const path = join(tempRoot(label), 'db.sqlite')
  schema10(path, records)
  return new Store(path)
}

test('低于 schema 10 的库拒绝打开，要求换新状态目录', () => {
  const path = join(tempRoot('too-old'), 'db.sqlite')
  new Store(path).close()
  const schema = (version: number) => { const db = new DatabaseSync(path); db.prepare("UPDATE kv SET value=? WHERE key='schema'").run(String(version)); db.close() }
  schema(9)
  assert.throws(() => new Store(path), /schema 9 predates schema 10, which this version cannot migrate; start with a new state directory/)
})

test('schema 10 的库只按当前形状重写一次，读不到旧形状', () => {
  const path = join(tempRoot('rewrite'), 'db.sqlite')
  const base = {
    id: 't1', title: 'Fix', decisionId: 'd1', state: 'open', assignments: [], summary: '', createdAt: '1', updatedAt: '2',
    // schema 10 里，没有评论链接的 GitHub Channel 标记这个工单开的 PR。
    channels: [{ source: 'github', thread: 'github:8', address: { number: '8' } }, { source: 'github', thread: 'github:7', address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } }],
    mandate: mandate({ chatId: 'oc_team', direct: false, member: 'ou_alice', mention: true }),
    inputs: [{ id: 'i1', kind: 'reopen', decisionId: 'd2', at: '3' }, { id: 'i2', kind: 'reopen', decisionId: 'd0', at: '0' },
      { id: 'i3', kind: 'trigger', triggerId: 'trig-2', at: '4' }, { id: 'i4', kind: 'trigger', triggerId: 'ci-1', at: '5' }], undelivered: ['i1'],
    meta: { sourceTriggerId: 'trig-1', triggerIds: ['trig-1', 'trig-2'], workspace: '/w/fix-1', name: 'fix-1', sessionId: 'worker-t1', assignment: 'Read trigger/trig-1.',
      prNumber: 7, prUrl: 'https://github.com/acme/widgets/pull/7', branch: 'agent/fix-1', deliveryError: 'offline', recovery: 2, worktreeName: 'fix', scope: 'small' },
  }
  const imported = { ...base, id: 't2', state: 'ended', channels: [], inputs: [], undelivered: [], mandate: mandate({ legacyAuthority: 'thread_followup', followup: true }),
    meta: { sourceTriggerId: 'old', workspace: '/w/task-2', sessionId: 'worker-task-2', legacyPrompt: 'Read event/old' },
    ended: { at: '6', by: 'executor', reason: 'merged' } }
  // 已结束、但还留着一条人发的消息，且没有执行记录和来源 Trigger。
  const waiting = { ...base, id: 't3', state: 'ended', channels: [], ended: { at: '6', by: 'human', reason: 'Not needed' }, inputs: [{ id: 'i5', kind: 'trigger', triggerId: 'trig-2', at: '7' }],
    undelivered: ['i5'], mandate: mandate({ chatId: 'p2p', direct: true, member: 'ou_alice' }), meta: {} }
  const bare = { ...base, id: 't4', channels: [], inputs: [], undelivered: [], meta: undefined }
  const reopened = { id: 'd2', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-2'], kind: 'reopen', reason: 'follow-up', at: '3', ticketId: 't1', policyVersion: 'v1' }
  const unavailable = { id: 'd3', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-2'], kind: 'unavailable', reason: 'Assessment timed out', at: '5', policyVersion: 'v1' }
  const triggers = [{ id: 'trig-2', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor, human: true, at: '4', text: 'more', meta: {} },
    { id: 'ci-1', source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'ci' }, human: false, at: '5', text: 'CI', meta: {} }]
  const decision = { id: 'd1', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-1'], kind: 'accept', reason: '', at: '1', ticketId: 't1', policyVersion: 'v1',
    mandate: mandate({ legacyAuthority: 'proactive_rule', observation: true, rules: ['copy'] }) }
  const evaluating = { id: 'e1', threadKey: 'github:5', triggerIds: ['x'], strength: 'inferred', actor, policyVersion: 'v1', startedAt: '', deadline: '',
    basis: { source: 'github', scope: { number: 5 }, row: 'issues', admission: 'listedUnaddressed', observation: true, mode: 'auto' } }
  const thread = { key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating, meta: {} }
  schema10(path, {
    settings: { policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'x', visual: true }] }, executor: { reviewer: 'bob', prepare: 'echo $DSH_TAG_DIR' },
      sources: { 'github-issue': { enabled: true, config: {} }, github: { enabled: true, config: { mergeCli: 'gh' } } } },
    'settings-version:1': { revision: 1, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [],
      settings: { allowedChats: ['oc_team'], members: [], sources: undefined } },
    'settings-version:2': { revision: 2, savedAt: '', source: 'orchestrator-tool', policyVersion: '', policyChanged: false, notified: [],
      settings: { sources: { 'github-issue': { enabled: true, config: {} } } } },
    'prompt-revision': 1,
    'github-ended:8': { at: '2026-09-01T00:00:00Z', reason: 'merged' },
    'problem-dismissed:d3': true,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config: { shared: 's', orchestrator: 'o', worker: 'w', guides: { release: 'Use guide/github and dsh-tag-feishu.' } } },
    'prompt-settings-text': 1,
    'task/t1/input/i0': '{"text":"old input"}',
    'task/t1/input/i9': '{"text":"older copy"}', 'ticket/t1/input/i9': '{"text":"kept"}',
    'settings-version:3': { revision: 3, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [], settings: { executor: { maxWorkers: 'many' } } },
    'prompt-version:2': { revision: 2, previousRevision: 1, savedAt: '', source: 'web', config: { communication: 1 } },
    'answer-ready:t1:trig-3': true,
    'github-object-state:7': 'open', subscriptions: [], 'settings-before-9': { policy: {} }, 'thread-times-backfilled': true,
    'github-issue-pending': { 1: {} },
    // 读缓存，现在由内存保存。
    'feishu-read:orchestrator-1:feishu/e1/thread': '{}', 'github-read:worker-t1:github/pulls/7': '{}', 'feishu-source-link:oc_team:om_1': 'https://x',
    'orchestrator-1:prompt-preview/abc': 'prompt',
  }, { ticket: [base, imported, waiting, bare], decision: [decision, reopened, unavailable], thread: [thread], trigger: triggers })

  const store = new Store(path)
  assert.equal(store.get(KV.store.schema), SCHEMA_VERSION)
  const settings = store.settings()
  assert.deepEqual(Object.keys(settings.sources), ['github'])
  assert.equal(Object.hasOwn(settings.sources.github!.config, 'mergeCli'), false)
  assert.equal(Object.hasOwn(settings.policy.rules[0]!, 'visual'), false)
  assert.equal(Object.hasOwn(settings.executor, 'reviewer'), false)
  assert.equal(settings.executor.prepare, 'echo $DSH_SUPERAGENT_DIR')
  // 当前设置是最新修订的快照，迁移时存下，因为它与最新已存修订不同。
  const [current, , second, first] = store.settingsHistory()
  matchObject(current, { revision: 4, source: 'internal', settings })
  assert.equal(store.get('settings'), undefined)
  matchObject(first, { source: 'panel', settings: { sources: { feishu: { config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } } } } })
  matchObject(second, { source: 'tool', settings: { sources: { 'github-issue': { enabled: true } } } })
  matchObject(store.get('prompt-version:1'), { legacy: { config: { guides: { release: 'Use guide/github and dsh-tag-feishu.' } } },
    config: { skills: { release: 'Use the github section and dsh-superagent-feishu.' } } })
  // 无效的历史 Prompt 版本把原值留在 legacy 下，配置回退到上一版。
  matchObject(store.get('prompt-version:2'), { legacy: { config: { communication: 1 } }, config: store.get(KV.prompts.version(1))!.config })
  matchObject(store.get('settings-version:3'), { source: 'panel', settings: { executor: { maxWorkers: 'many' } } })
  const migrated = store.tickets.get('t1')!
  assert.equal(Object.hasOwn(migrated, 'meta'), false)
  assert.deepEqual(store.keys('github-ended:'), [])
  assert.equal(store.decisions.get('d3')!.kind, 'unavailable')
  assert.equal(store.decisions.get('d3')!.dismissed, true)
  assert.deepEqual(store.keys('problem-dismissed:'), [])
  matchObject(migrated, {
    origin: { triggerId: 'trig-1', triggerIds: ['trig-1', 'trig-2'] },
    execution: { name: 'fix-1', directory: '/w/fix-1', assignment: 'Read trigger/trig-1.' },
    delivery: { error: 'offline', at: '2' },
    follows: [{ thread: 'github:8', own: true, closed: { at: '2026-09-01T00:00:00Z', outcome: 'merged' } }, { thread: 'github:7', own: false }],
    channels: [{ source: 'github', thread: 'github:7', address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } }],
    answers: ['trig-3'],
    mandate: { basis: { via: 'listed', source: 'feishu', scope: { chatId: 'oc_team', direct: false }, sender: 'ou_alice', addressed: 'mention' } },
  })
  assert.equal(migrated.inputs[0]!.id, 'i1')
  assert.equal(migrated.inputs[0]!.kind, 'text')
  assert.ok((migrated.inputs[0] as { text: string }).text.includes('"resumed":true'))
  assert.equal((migrated.inputs[0] as { text: string }).text.includes('reopen'), false)
  assert.deepEqual(migrated.inputs[1], { id: 'i2', kind: 'reopen', decisionId: 'd0', at: '0' })
  assert.deepEqual(migrated.inputs.slice(2), [{ id: 'i3', kind: 'trigger', triggerId: 'trig-2', at: '4', human: true }, { id: 'i4', kind: 'trigger', triggerId: 'ci-1', at: '5' }])
  assert.equal(Object.hasOwn(migrated.execution!, 'recoveries'), false)
  const importedTicket = store.tickets.get('t2')!
  matchObject(importedTicket, { execution: { name: 'task-2', assignment: 'Read event/old' },
    mandate: { basis: { via: 'followup', authority: 'thread_followup' } } })
  assert.equal(Object.hasOwn(importedTicket, 'follows'), false)
  // 只重复 outcome 的结束理由不保留。
  assert.deepEqual(importedTicket.ended, { at: '6', by: 'executor', outcome: 'merged' })
  // 人停下的工单不留未投递消息；没存属性的工单照样得到 origin。
  matchObject(store.tickets.get('t4'), { origin: { triggerId: '', triggerIds: [] } })
  const waitingTicket = store.tickets.get('t3')!
  matchObject(waitingTicket, { ended: { outcome: 'stopped' }, undelivered: [], origin: { triggerId: '', triggerIds: [] },
    mandate: { basis: { via: 'listed', source: 'feishu', scope: { chatId: 'p2p', direct: true }, sender: 'ou_alice', addressed: 'direct' } } })
  assert.equal(Object.hasOwn(waitingTicket, 'execution'), false)
  // 理由是代码；assessor 写的原话按原样留下。
  assert.deepEqual(store.decisions.get('d2'), { ...reopened, reason: [{ code: 'said', values: { text: 'follow-up' } }] })
  assert.deepEqual(store.decisions.get('d3')!.reason, [{ code: 'timeout' }])
  assert.deepEqual(store.decisions.get('d1')!.mandate!.basis, { via: 'listed', rules: ['copy'], observation: {}, authority: 'proactive_rule' })
  assert.deepEqual(store.threads.get('github:5')!.evaluating!.basis, { via: 'admission', source: 'github', scope: { number: 5 }, row: 'issues',
    cell: 'listedUnaddressed', observation: { mode: 'auto' } })
  // kv：Input 读取时从工单渲染，所以不留正文；没人读的记录删掉，被移除的 Issue 来源产生的也删掉。
  assert.equal(store.get('ticket/t1/input/i0'), undefined)
  assert.equal(store.get('ticket/t1/input/i9'), undefined)
  assert.deepEqual(store.keys('task/'), [])
  for (const name of ['answer-ready:t1:trig-3', 'github-object-state:7', 'subscriptions', 'settings-before-9', 'thread-times-backfilled', 'prompt-settings-text',
    'feishu-read:orchestrator-1:feishu/e1/thread', 'github-read:worker-t1:github/pulls/7', 'feishu-source-link:oc_team:om_1', 'orchestrator-1:prompt-preview/abc']) {
    assert.equal(store.get(name), undefined, name)
  }
  assert.equal(store.get('github-issue-pending'), undefined)
  // schema 6 的表留着，带着 schema 7 导入时漏掉的行。
  assert.notEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'inbox'").get(), undefined)
  store.close()
  // 再迁一次结果不变。
  const raw = new DatabaseSync(path)
  raw.prepare("UPDATE kv SET value='10' WHERE key='schema'").run()
  raw.close()
  const again = new Store(path)
  assert.deepEqual(again.tickets.get('t1'), migrated)
  again.close()
})

test('每条消息留作收据，记录它成了什么；被丢弃的用面板措辞的代码记原因', () => {
  const path = join(tempRoot('receipts'), 'db.sqlite')
  schema10(path, {})
  const raw = new DatabaseSync(path)
  const message = (id: string, sent: number, fields: Record<string, unknown> = {}) => raw.prepare('INSERT INTO outbox (id, value, sent) VALUES (?, ?, ?)')
    .run(id, JSON.stringify({ id, channel: { source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }, text: id, kind: 'reply', attempts: 2,
      error: 'offline', nextAttemptAt: 1, ...fields }), sent)
  message('gone', 1, { dropped: { at: '2026-09-01T00:00:00.000Z', reason: 'The conversation can no longer receive messages' } })
  message('ignored', 1, { dropped: { at: '2026-09-02T00:00:00.000Z', reason: 'The Source no longer listens to this conversation' } })
  message('sent', 1)
  message('waiting', 0)
  raw.close()
  const store = new Store(path)
  assert.deepEqual(store.read.droppedReplies().map(item => [item.id, item.dropped.reason]), [['ignored', 'channelIgnored'], ['gone', 'channelGone']])
  assert.deepEqual(['gone', 'sent', 'waiting'].map(id => store.replyStatus(id)), ['dropped', 'sent', 'pending'])
  // 收据不存尝试次数：等待中的消息有 `reply` effect，由它保留并继续计数。
  assert.deepEqual(store.receipts.get('waiting'), { id: 'waiting', channel: { source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }, text: 'waiting',
    kind: 'reply', status: 'pending' })
  assert.deepEqual(store.db.prepare('SELECT kind, key, attempts, error FROM effect').all().map(row => ({ ...row })), [{ kind: 'reply', key: 'waiting', attempts: 2, error: 'offline' }])
  assert.equal(store.db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().map(row => row.name).includes('sent'), false)
  store.close()
})

test('一步失败就什么都不改：数据库原样停在 schema 10', () => {
  const path = join(tempRoot('abort'), 'db.sqlite')
  const base = { id: 't1', title: 'Fix', decisionId: 'd1', channels: [], state: 'open', assignments: [], inputs: [], undelivered: [], summary: '', createdAt: '1',
    updatedAt: '2', mandate: mandate({ via: 'listed' }), meta: { sourceTriggerId: 'trig-1', workspace: '/w/fix-1' } }
  // 当前设置必须通过校验；非法值让迁移事务整体中止。
  schema10(path, { settings: { executor: { maxWorkers: 'many' } } }, { ticket: [base] })
  assert.throws(() => new Store(path), (error: Error) => /^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: the settings: /.test(error.message))
  const raw = new DatabaseSync(path)
  assert.deepEqual({ ...raw.prepare("SELECT value FROM kv WHERE key='schema'").get() }, { value: '10' })
  matchObject(JSON.parse(String(raw.prepare("SELECT value FROM ticket WHERE id='t1'").get()!.value)), { meta: { workspace: '/w/fix-1' } })
  raw.close()
})

test('把早先闸门记录的每种 basis 读成当前形状', () => {
  const scope = { chatId: 'oc_1', direct: false }
  assert.deepEqual(basisOf({ source: 'feishu', scope, row: 'oc_1', sender: 'Alice', addressed: 'mention' }), { via: 'addressed', source: 'feishu', scope, row: 'oc_1',
    sender: 'Alice', addressed: 'mention' })
  assert.deepEqual(basisOf({ source: 'feishu', scope, followup: true, rules: ['r'] }), { via: 'followup', source: 'feishu', scope, rules: ['r'] })
  assert.deepEqual(basisOf({ source: 'feishu', scope, addressed: 'direct', admission: 'unlistedAddressed' }), { via: 'admission', source: 'feishu', scope,
    cell: 'unlistedAddressed', addressed: 'direct' })
  // 在更早的闸门下观察、没记录 cell：发送者必须在名单里。
  assert.deepEqual(basisOf({ source: 'feishu', scope, sender: 'Alice', observation: true, mode: 'auto', rules: ['r'] }), { via: 'listed', source: 'feishu', scope,
    sender: 'Alice', rules: ['r'], observation: { mode: 'auto' } })
  assert.deepEqual(basisOf({ chatId: 'oc_1', direct: true, followup: true, member: 'ou_a' }), { via: 'followup', source: 'feishu', scope: { chatId: 'oc_1', direct: true },
    sender: 'ou_a' })
  assert.deepEqual(basisOf({ member: 'ou_a', mention: true }), { via: 'listed', sender: 'ou_a', addressed: 'mention' })
  assert.deepEqual(basisOf({ legacyAuthority: 'explicit_mention' }), { via: 'listed', authority: 'explicit_mention' })
  assert.deepEqual(basisOf({ via: 'followup' }), { via: 'followup' })
})

/** 造一个团队分区之前的 Prompt 版本：固定内容与内置指南都存进 config 里。 */
const legacyPrompts = (revision: number, guides: Record<string, string> = {}) => ({
  [`prompt-version:${revision}`]: { revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'web',
    config: { shared: 'Legacy shared rule.', orchestrator: 'Legacy orchestrator: only route.', worker: 'Legacy worker.',
      guides: { replies: 'Legacy replies.', dispatch: 'Accept any screenshot.', work: 'Legacy work. Enable auto-merge once it changes fewer than 350 lines (additions plus deletions); and so on.',
        feishu: 'Legacy Feishu skill.', identities: 'Alice is @alice.', ...guides } } },
  'prompt-revision': revision, 'prompt-settings-text': 1,
})

test('团队分区之前保存的 Prompt 版本写成当前形状，保留技能与自动合并阈值，并打上标记', () => {
  const store = opened('prompt-legacy', legacyPrompts(3, { notes: 'Call orchestrator_create_task with event_id, read event/<id>, follow guide/work and guide/release, load dsh-tag-github, cd "$DSH_TAG_DIR".' }))
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  const { config } = prompts.version(3)
  assert.equal(config.communication, defaultPrompts().communication)
  assert.ok(config.delivery.includes('it changes fewer than 350 lines (additions plus deletions);'))
  assert.equal(config.delivery.includes('fewer than 200 lines'), false)
  // 现在固定或内置的指南没了；团队自己的技能留着，用当前名字。
  assert.deepEqual(Object.keys(config.skills), ['identities', 'notes'])
  assert.equal(config.skills.notes, 'Call orchestrator_route (kind accept) with trigger_id, read trigger/<id>, follow the work section and skill dsh-superagent-release, load dsh-superagent-github, cd "$DSH_SUPERAGENT_DIR".')
  const prompt = composePrompt(config, 'orchestrator')
  assert.equal(prompt.includes('Legacy orchestrator'), false)
  assert.ok(prompt.includes(masterPrompt))
  assert.equal(prompts.current().revision, 3)
  // 按内置文本读时，旧版本说自己 old，而不是列差异。
  assert.deepEqual(prompts.history(0, 1).revisions.map(version => version.changed), [['legacy']])
  store.close()
})

test('已存的团队分区与技能按当前名字写：早先项目名、变成读取的工具与路由工具', () => {
  const config = { ...defaultPrompts(), delivery: 'Merge with --repo $DSH_FREELANCER_GITHUB_REPOSITORY.',
    skills: { notes: 'Load dsh-freelancer-github; cd "$DSH_FREELANCER_DIR". List with orchestrator_tickets, then orchestrator_ticket_inspect.',
      routing: 'Accept with orchestrator_ticket_accept; stop with orchestrator_ticket_stop, never orchestrator_trigger_ignore.' } }
  const store = opened('prompt-names', { 'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config }, 'prompt-revision': 1, 'prompt-settings-text': 1 })
  const { config: current } = new Prompts(store, () => 100000, () => undefined, () => true).current()
  assert.equal(current.delivery, 'Merge with --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY.')
  assert.equal(current.skills.notes, 'Load dsh-superagent-github; cd "$DSH_SUPERAGENT_DIR". List with orchestrator_read tickets, then orchestrator_read ticket/<id>.')
  // 四个路由工具并成一个。
  assert.equal(current.skills.routing, 'Accept with orchestrator_route (kind accept); stop with orchestrator_route (kind stop), never orchestrator_route (kind ignore).')
  store.close()
})

test('把移除的自动合并阈值与成员身份写成新的 Prompt 版本，除非更早的版本已经写过', () => {
  const before = { policy: { autoMergeLineLimit: 350, members: [{ name: 'Alice', feishuId: 'ou_alice', github: 'alice' }, { name: 'Bob', feishuId: 'ou_bob', github: '' }] } }
  const store = opened('prompt-settings', { 'settings-before-9': before })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  const migrated = prompts.current()
  assert.equal(migrated.revision, 1)
  assert.equal(migrated.previousRevision, 0)
  assert.equal(migrated.source, 'settings-migration')
  assert.ok(migrated.config.delivery.includes('it changes fewer than 350 lines (additions plus deletions);'))
  assert.ok(migrated.config.skills.identities!.includes('- Alice (Feishu ou_alice) is @alice on GitHub'))
  assert.equal(migrated.config.skills.identities!.includes('Bob'), false)
  assert.equal(store.get('settings-before-9'), undefined)
  store.close()
  // 默认阈值、没有任何人有两个身份：什么都不改；其他交付文本把阈值作为独立一句补上。
  const unchanged = opened('prompt-settings-noop', { 'settings-before-9': { policy: { members: [{ name: 'Bob', feishuId: 'ou_bob', github: '' }] } } })
  assert.equal(new Prompts(unchanged, () => 100000, () => undefined, () => true).current().revision, 0)
  unchanged.close()
  const own = opened('prompt-settings-own', { 'settings-before-9': { policy: { autoMergeLineLimit: 80 } }, 'prompt-revision': 1,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config: { ...defaultPrompts(), delivery: 'Deliver PRs.' } } })
  assert.equal(new Prompts(own, () => 100000, () => undefined, () => true).current().config.delivery,
    'Deliver PRs.\nEnable auto-merge only on a PR that changes fewer than 80 lines (additions plus deletions).')
  own.close()
  const done = opened('prompt-settings-done', { 'settings-before-9': before, 'prompt-settings-text': 1 })
  assert.equal(new Prompts(done, () => 100000, () => undefined, () => true).current().revision, 0)
  done.close()
})

test('当前 Prompt 版本读起来与上一版不同时，保留它说的内容', () => {
  const config = { ...defaultPrompts(), delivery: 'Deliver PRs.' }
  const store = opened('prompt-current', { 'prompt-revision': 2, 'prompt-settings-text': 1,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config },
    'prompt-version:2': { revision: 2, previousRevision: 1, savedAt: '', source: 'web', config: { delivery: ['not text'] } } })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  const current = prompts.current()
  assert.equal(current.revision, 2)
  assert.deepEqual(current.config, config)
  assert.deepEqual(current.legacy, { config: { delivery: ['not text'] } })
  assert.deepEqual(prompts.history(0, 2).revisions.map(version => version.changed), [['legacy'], []])
  store.close()
})

/** 造一个与最后一个 schema 10 发行版完全相同的原始库（含遗留 schema 6 的 `inbox` / `task` 表）。 */
function lastSchema10(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL, PRIMARY KEY (thread, id));
    CREATE INDEX trigger_at ON trigger(at);
    CREATE INDEX trigger_thread_at ON trigger_thread(thread, at);
    CREATE INDEX decision_thread ON decision(thread);
    CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE task (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const kv = (name: string, value: unknown) => db.prepare('INSERT INTO kv VALUES (?,?)').run(name, JSON.stringify(value))
  kv('schema', 10); kv('master-id', 'orchestrator-1'); kv('settings', { executor: { maxWorkers: 2 } })
  kv('relay-queue', [{ id: 'report:old', text: '{"kind":"worker_report"}' }])
  const trigger = { id: 'trig-1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor, human: true, at: '2026-10-01T00:00:00Z', text: 'fix it', meta: {} }
  db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(trigger.id, JSON.stringify(trigger), trigger.at)
  db.prepare('INSERT INTO trigger_thread VALUES (?,?,?,1)').run('feishu:oc_team:om_1', trigger.id, trigger.at)
  const thread = { key: 'feishu:oc_team:om_1', ref: trigger.threads[0], createdAt: trigger.at, subscriptions: ['t1'], correlated: [], pending: [], meta: {} }
  db.prepare('INSERT INTO thread VALUES (?,?)').run(thread.key, JSON.stringify(thread))
  const base = { id: 't1', title: 'Fix', decisionId: 'd1', channels: [], state: 'open', summary: '', createdAt: trigger.at, updatedAt: trigger.at,
    mandate: mandate({ source: 'feishu', scope: { chatId: 'oc_team' }, sender: 'Alice', addressed: 'mention' }), inputs: [], undelivered: [],
    assignments: [{ id: 'a1', state: 'running', createdAt: trigger.at }],
    meta: { sourceTriggerId: trigger.id, triggerIds: [trigger.id], workspace: '/w/fix-1', name: 'fix-1', sessionId: 'worker-t1', assignment: 'Read trigger/trig-1.' } }
  db.prepare('INSERT INTO ticket VALUES (?,?)').run(base.id, JSON.stringify(base))
  const reply = { id: 'reply-1', channel: { source: 'feishu', thread: thread.key, address: { chatId: 'oc_team', messageId: 'om_1' } }, text: '收到', kind: 'reply', attempts: 0, error: '' }
  db.prepare('INSERT INTO outbox VALUES (?,?,0)').run(reply.id, JSON.stringify(reply))
  db.prepare('INSERT INTO inbox VALUES (?,?,0)').run('left-out', '{"id":"left-out"}')
  db.close()
}

test('打开最后一个 schema 10 版本留下的库，补上本版并存的东西并迁移', () => {
  const path = join(tempRoot('last-schema10'), 'db.sqlite')
  lastSchema10(path)
  const store = new Store(path)
  assert.equal(store.get(KV.store.schema), SCHEMA_VERSION)
  assert.deepEqual(store.tickets.active().map(ticket => ticket.id), ['t1'])
  assert.deepEqual(store.read.subscribedThreads('feishu').map(thread => thread.key), ['feishu:oc_team:om_1'])
  const migrated = store.tickets.get('t1')!
  matchObject(migrated, { origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
    execution: { name: 'fix-1', directory: '/w/fix-1', assignment: 'Read trigger/trig-1.' },
    mandate: { basis: { via: 'addressed', addressed: 'mention' } } })
  assert.deepEqual(store.receipts.waiting().map(item => item.id), ['reply-1'])
  assert.deepEqual(store.db.prepare('SELECT kind, key, generation FROM effect ORDER BY seq').all().map(row => ({ ...row })), [{ kind: 'relay', key: 'report:old', generation: 0 },
    { kind: 'reply', key: 'reply-1', generation: 0 }])
  assert.deepEqual(store.db.prepare('SELECT id FROM inbox').all().map(row => ({ ...row })), [{ id: 'left-out' }])
  store.close()
  const again = new Store(path)
  assert.deepEqual(again.tickets.get('t1'), migrated)
  assert.deepEqual({ ...again.db.prepare('SELECT COUNT(*) AS n FROM effect').get() }, { n: 2 })
  again.close()
})

test('来源的记录按当前形状写一次，读的时候不再转换旧形状', () => {
  const path = join(tempRoot('sources'), 'db.sqlite')
  const recent = new Date(Date.now() - 3600_000).toISOString()
  const dm = { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } }
  const evaluating = { id: 'e1', threadKey: 'github:5', triggerIds: ['issue'], strength: 'inferred', actor, policyVersion: 'v1', startedAt: '',
    deadline: '', basis: { via: 'listed' } }
  schema10(path, {
    'feishu-chats': { oc_dm: true, oc_team: false }, 'feishu-history:oc_team': '2026-09-01T00:00:00.000Z',
    // 早先版本把群话题存成列表。
    'feishu-history-threads:oc_team': ['omt_old'],
    'github-thread:7': '2026-09-02T00:00:00.000Z', 'thread-since:github:7': '2026-09-03T00:00:00.000Z',
    'github-thread:8': '2026-09-04T00:00:00.000Z',
    'github-issue-pending': { a: { number: 12, at: recent }, b: { number: 13, at: '2026-01-01T00:00:00.000Z' } }, 'github-issues-since': 'x',
  }, {
    trigger: [{ id: 'dm', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_dm:om_1' }], actor, human: true, at: '2026-09-01T00:00:00Z',
      text: 'fix', channel: dm, meta: {} },
    { id: 'issue', source: 'github-issue', threads: [{ source: 'github', id: '12' }], actor: { source: 'github', id: 'alice' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'Login fails', meta: { number: 12 } }],
    thread: [{ key: 'feishu:oc_team:om_9', ref: { source: 'feishu', id: 'oc_team:om_9' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: {} },
    { key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating,
      meta: {} }],
  })
  const raw = new DatabaseSync(path)
  raw.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('r1', JSON.stringify({ id: 'r1', channel: dm, text: 'Done', kind: 'reply', attempts: 0, error: '' }))
  // effect 命名 Trigger 之前排队的 Assessment：一个 Eval 在跑，一个 Eval 已结束。
  for (const [seq, evalId] of [[1, 'e1'], [2, 'e2']] as [number, string][]) {
    raw.prepare('INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)').run('assessment', evalId, '{}', seq, 0, '')
  }
  raw.close()
  const store = new Store(path)
  assert.deepEqual(store.get(KV.feishu.topics('oc_team')), { omt_old: '2026-09-01T00:00:00.000Z' })
  assert.deepEqual(store.triggers.get('dm')!.channel!.address, { chatId: 'oc_dm', messageId: 'om_1', direct: 'true' })
  assert.deepEqual(store.receipts.waiting()[0]!.channel.address, { chatId: 'oc_dm', messageId: 'om_1', direct: 'true' })
  assert.equal(store.threads.get('feishu:oc_team:om_9')!.meta.url, 'https://applink.feishu.cn/client/chat/open?openChatId=oc_team')
  assert.equal(store.triggers.get('issue')!.source, 'github')
  // 轮询窗口内还在等的那条重新读；更早的那条不是新请求。
  assert.deepEqual(store.get(KV.github.retries), { 12: { since: recent, pr: false } })
  assert.equal(store.get(KV.github.cursor(7)), '2026-09-03T00:00:00.000Z')
  assert.equal(store.get(KV.github.cursor(8)), '2026-09-04T00:00:00.000Z')
  for (const name of ['github-issue-pending', 'github-issues-since', 'github-thread:7', 'thread-since:github:7', 'github-thread:8']) {
    assert.equal(store.get(name), undefined, name)
  }
  const effects = store.db.prepare("SELECT key, value FROM effect WHERE kind = 'assessment'").all().map(row => [row.key, JSON.parse(String(row.value))])
  assert.deepEqual(effects, [['e1', { triggerId: 'issue' }]])
  store.close()
})

test('工单的每个事实只留一份：结束、最新报告，以及能从它推出的 worker Session 不留', () => {
  const base = { id: 't', title: 'Fix', decisionId: 'd', channels: [], inputs: [], undelivered: [], createdAt: '1', updatedAt: '2',
    mandate: mandate({ via: 'listed' }), origin: { triggerId: 'x', triggerIds: ['x'] }, execution: { name: 'fix', directory: '/w', session: 'worker-t', assignment: 'Do it.' } }
  const open = withoutCopies({ ...base, state: 'open', summary: 'Working on it',
    assignments: [{ id: 'a1', ticketId: 't', ref: 'worker-t', state: 'running', createdAt: '1' }] })
  assert.deepEqual(open, { ...base, execution: { name: 'fix', directory: '/w', assignment: 'Do it.' },
    assignments: [{ id: 'a1', state: 'running', createdAt: '1', report: { state: 'progress', summary: 'Working on it', at: '2' } }] })
  // 已有报告的工单保留最新那份；没有结束记录的已结束工单按 closed 结束。
  const reported = { id: 'a1', ticketId: 't', ref: '', state: 'ended', createdAt: '1', report: { state: 'ready', summary: 'Done', at: '2' } }
  const ended = withoutCopies({ ...base, state: 'ended', summary: 'Done', assignments: [reported] })
  matchObject(ended, { ended: { at: '2', by: 'executor', outcome: 'closed' }, assignments: [{ id: 'a1', state: 'ended', report: { summary: 'Done' } }] })
})

test('把早先版本用文字存的原因读成代码，其他文字原样保留', () => {
  assert.deepEqual(reasonsOf('Assessment timed out'), [{ code: 'timeout' }])
  assert.deepEqual(reasonsOf('a1: not_a_member; b2: no_mention'), [{ code: 'not_a_member', triggerId: 'a1' }, { code: 'no_mention', triggerId: 'b2' }])
  assert.deepEqual(reasonsOf('Routed to ticket t9'), [{ code: 'routed', values: { ticket: 't9' } }])
  assert.deepEqual(reasonsOf('Observe mode: would accept (a copy fix)'), [{ code: 'observed', values: { text: 'a copy fix' } }])
  // assessor 的话里可能有冒号或分号；它们仍算一条原因。
  assert.deepEqual(reasonsOf('Not a request: chatter; nothing to do'), [{ code: 'said', values: { text: 'Not a request: chatter; nothing to do' } }])
  assert.deepEqual(reasonsOf([{ code: 'timeout' }]), [{ code: 'timeout' }])
})

const ticket10 = (id: string, fields: Record<string, unknown> = {}) => ({ id, title: 'Fix', decisionId: 'd1', channels: [], state: 'open', assignments: [],
  inputs: [], undelivered: [], summary: '', createdAt: '1', updatedAt: '2', mandate: mandate({ via: 'listed' }), meta: { sourceTriggerId: 'trig-1' }, ...fields })

/** 像 schema 10 保存时那样填 `trigger_thread` 行。 */
function indexed(path: string, triggers: { id: string; at: string; threads: { source: string; id: string }[] }[]): void {
  const raw = new DatabaseSync(path)
  for (const { id, at, threads } of triggers) {
    for (const thread of threads) raw.prepare('INSERT INTO trigger_thread VALUES (?, ?, ?, 1)').run(`${thread.source}:${thread.id}`, id, at)
  }
  raw.close()
}

test('每个 Thread 用它的 Trigger 定时间，Trigger 的时间统一成存储时刻的格式', () => {
  const path = join(tempRoot('thread-times'), 'db.sqlite')
  const comment = (id: string, at: string) => ({ id, source: 'github', threads: [{ source: 'github', id: '7' }], actor, human: true, at, text: id, meta: {} })
  // GitHub 用整秒写时间；schema 10 在还不知道活动时间前保存的 Thread 没有时间。
  const triggers = [comment('first', '2026-10-01T00:00:00Z'), comment('last', '2026-10-09T00:00:00.000Z')]
  schema10(path, {}, { trigger: triggers,
    thread: [{ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-10-05T00:00:00.000Z', subscriptions: [], correlated: [], pending: [], meta: {} }] })
  indexed(path, triggers)
  const store = new Store(path)
  assert.equal(store.threads.get('github:7')!.createdAt, '2026-10-01T00:00:00.000Z')
  assert.equal(store.threads.get('github:7')!.lastAt, '2026-10-09T00:00:00.000Z')
  assert.equal(store.triggers.get('first')!.at, '2026-10-01T00:00:00.000Z')
  assert.deepEqual(store.db.prepare("SELECT at FROM trigger WHERE id = 'first' UNION ALL SELECT at FROM trigger_thread WHERE id = 'first'").all().map(row => ({ ...row })),
    [{ at: '2026-10-01T00:00:00.000Z' }, { at: '2026-10-01T00:00:00.000Z' }])
  store.close()
})

test('工单读不出来时点名停在哪个工单，数据库原样停在 schema 10', () => {
  const path = join(tempRoot('broken-ticket'), 'db.sqlite')
  const broken = ticket10('t9')
  delete (broken as { inputs?: unknown }).inputs
  schema10(path, {}, { ticket: [broken] })
  assert.throws(() => new Store(path), (error: Error) => /^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: ticket t9: /.test(error.message))
  const raw = new DatabaseSync(path)
  assert.deepEqual({ ...raw.prepare("SELECT value FROM kv WHERE key='schema'").get() }, { value: '10' })
  assert.deepEqual(JSON.parse(String(raw.prepare("SELECT value FROM ticket WHERE id='t9'").get()!.value)), broken)
  raw.close()
})

test('最新已存修订持有设置时让它成为当前设置，并把落后的指针移到它', () => {
  const path = join(tempRoot('lagging-pointer'), 'db.sqlite')
  const version = (revision: number, settings: unknown) => ({ revision, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [], settings })
  schema10(path, { settings: { executor: { maxWorkers: 4 } }, 'settings-revision': 1, 'settings-version:1': version(1, {}),
    'settings-version:2': version(2, { executor: { maxWorkers: 4 } }) })
  const store = new Store(path)
  assert.deepEqual(store.settingsHistory().map(item => item.revision), [2, 1])
  assert.deepEqual([store.get(KV.settings.revision), store.settings().executor.maxWorkers, store.get('settings')], [2, 4, undefined])
  store.close()
})

test('Trigger 过滤与 Assignment 结束的文字原因读成代码，结束原因只留一份', () => {
  const path = join(tempRoot('reason-codes'), 'db.sqlite')
  const assignment = (id: string, endedReason: string) => ({ id, ticketId: 't1', ref: '', state: 'ended', createdAt: '1', endedAt: '2', endedReason })
  schema10(path, {}, { ticket: [ticket10('t1', { assignments: [assignment('a1', 'Retried by a person'), assignment('a2', 'host restarted'),
    { id: 'a3', ticketId: 't1', ref: '', state: 'running', createdAt: '2' }] })] })
  const raw = new DatabaseSync(path)
  raw.prepare('INSERT INTO disposition VALUES (?, ?)').run('trig-1', JSON.stringify({ filtered: 'Sender is not an authorized human member', fanout: [], at: '' }))
  raw.close()
  const store = new Store(path)
  assert.deepEqual(store.tickets.get('t1')!.assignments.map(item => item.endedReason), ['retried', 'hostRestarted', undefined])
  assert.deepEqual(store.triggers.disposition('trig-1')!.filtered, { code: 'senderNotMember' })
  store.close()
  // 结束停掉的 Assignment 不再重复结束原因，原因留在结束记录上。
  const ended = withoutCopies({ ...ticket10('t2'), state: 'ended', ended: { at: '5', by: 'human', reason: 'Not needed', outcome: 'stopped' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: '1', endedAt: '5', endedReason: 'Not needed' }] })
  assert.deepEqual([ended.ended, ended.assignments[0]], [{ at: '5', by: 'human', reason: 'Not needed', outcome: 'stopped' }, { id: 'a1', state: 'ended', createdAt: '1', endedAt: '5' }])
})

test('直聊的工单 Channel 标成 direct；存的是 Lark 链接时按 Lark 品牌拼 Thread 链接', () => {
  const path = join(tempRoot('direct-lark'), 'db.sqlite')
  const dm = { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } }
  const lark = { id: 'lark', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_2' }], actor, human: true, at: '2026-10-01T00:00:00.000Z',
    text: 'hi', url: 'https://applink.larksuite.com/client/message/link/open?token=x', meta: {} }
  schema10(path, { 'feishu-chats': { oc_dm: true } }, { ticket: [ticket10('t1', { channels: [dm] })], trigger: [lark],
    thread: [{ key: 'feishu:oc_other:om_9', ref: { source: 'feishu', id: 'oc_other:om_9' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }] })
  const store = new Store(path)
  assert.deepEqual(store.tickets.get('t1')!.channels, [{ ...dm, address: { ...dm.address, direct: 'true' } }])
  assert.equal(store.threads.get('feishu:oc_other:om_9')!.meta.url, 'https://applink.larksuite.com/client/chat/open?openChatId=oc_other')
  store.close()
})

test('升级时重新投递进行中的 Eval 候选，让它开始计时并能过期', () => {
  const path = join(tempRoot('evaluating'), 'db.sqlite')
  const evaluating = { id: 'e9', threadKey: 'github:9', triggerIds: ['issue-9'], strength: 'explicit', actor, policyVersion: 'v1', startedAt: '1',
    deadline: '2', basis: { via: 'listed' } }
  schema10(path, {}, {
    trigger: [{ id: 'issue-9', source: 'github', threads: [{ source: 'github', id: '9' }], actor, human: true, at: '2026-09-01T00:00:00Z', text: 'Fix it', meta: {} }],
    thread: [{ key: 'github:9', ref: { source: 'github', id: '9' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating, meta: {} }],
  })
  const store = new Store(path)
  const effects = store.db.prepare("SELECT key, value FROM effect WHERE kind = 'assessment'").all().map(row => [row.key, JSON.parse(String(row.value))])
  assert.deepEqual(effects, [['e9', { triggerId: 'issue-9' }]])
  store.close()
})
