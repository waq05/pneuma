/**
 * @pneuma/superagent 存储层的包级测试：测移植版 `app/store.ts`（`Store` 类 + `store-read.ts` + `versions.ts`），
 * 转写自上游 `tests/store.spec.ts`。钉的是：版本上限与回滚、Thread 索引、工作集只读活行、老库补生成列、
 * 首条 Trigger 命名、来源计数、链接、meta 补丁、事务提交回调、设置版本历史、SQLite 与内存实现
 * 顺序一致、`%`/`_` 按字面匹配。每条坏的后果都不是抛错，而是「两个编排器各写一遍」「旧库读不出
 * 活工单」「界面按错误顺序翻页」这类静默错误。
 *
 * 全程用 `tmpdir()` 下的临时目录，且每个用例一个：绝不碰用户真实的 `~/.dsc`。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const { Store, SCHEMA_VERSION } = await import('../../../../lib/packages/superagent/app/store.js')
const { MemoryRepositories } = await import('../../../../lib/packages/superagent/core/index.js')
const { threadFacts } = await import('../../../../lib/packages/superagent/app/views/records.js')
const { KV } = await import('../../../../lib/packages/superagent/kv.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')

let passed = 0
const roots = []

/** 每个用例一个临时目录：用例之间不共享库文件，失败也不会互相污染。 */
function tempRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `superagent-store-${label}-`))
  roots.push(dir)
  return dir
}

// ── 移植版 app/store.ts（上游 tests/store.spec.ts）────────────────────────────

/** 上游 spec 的 Ticket 夹具：只填被测查询会读的字段，其余用空值占位。 */
const ticket = (id, state, assignments, undelivered = []) => ({
  id, title: id, decisionId: '',
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
  channels: [], assignments: assignments.map((item, index) => ({ id: `${id}-${index}`, createdAt: '', ...item })), inputs: [],
  ...state === 'ended' ? { ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' } } : {},
  undelivered, createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] },
})
/** 上游 spec 的 Thread 夹具。 */
const thread = (id, source, fields = {}) =>
  ({ key: `${source}:${id}`, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {}, ...fields })
const ids = (items) => items.map((item) => item.id ?? item.key).sort()

test('新库版本更高时拒绝打开；atomic 里抛错整体回滚', () => {
  const path = join(tempRoot('app-rollback'), 'orchestrator.sqlite')
  const db = new Store(path)
  assert.throws(() => db.atomic(() => { db.set('a', 1); throw new Error('boom') }), /boom/)
  assert.equal(db.get('a'), undefined)
  db.set('schema', SCHEMA_VERSION + 1)
  db.close()
  assert.throws(() => new Store(path), /Unsupported orchestrator database version/)
  passed += 1
})

test('按 Thread 找 Trigger：保存时重建索引，重存会换掉它所在的 Thread', () => {
  const db = new Store(join(tempRoot('app-thread-triggers'), 'orchestrator.sqlite'))
  db.triggers.save({ id: 'a', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_%_x' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '2', text: 'later', meta: {} })
  db.triggers.save({ id: 'b', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_%_x' }, { source: 'github', id: '3' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '1', text: 'earlier', meta: {} })
  db.triggers.save({ id: 'c', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_y_x' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '3', text: 'other', meta: {} })
  assert.deepEqual(db.read.threadTriggers('feishu:oc_1:om_%_x').map((trigger) => trigger.id), ['b', 'a'])
  assert.deepEqual(db.read.threadTriggers('github:3').map((trigger) => trigger.id), ['b'])
  db.triggers.save({ ...db.triggers.get('b'), threads: [{ source: 'github', id: '3' }] })
  assert.deepEqual(db.read.threadTriggers('feishu:oc_1:om_%_x').map((trigger) => trigger.id), ['a'])
  assert.deepEqual(db.read.threadTriggers('github:3').map((trigger) => trigger.id), ['b'])
  assert.deepEqual(db.read.subscribedThreads(), [])
  db.close()
  passed += 1
})

test('工作集只读活行：SQLite 与内存实现一致，且随每次保存更新', () => {
  const db = new Store(join(tempRoot('app-working-sets'), 'orchestrator.sqlite'))
  for (const repo of [db, new MemoryRepositories()]) {
    repo.tickets.save(ticket('running', 'open', [{ state: 'running' }]))
    // 重试或恢复会在已结束的 Assignment 后面再加一个 pending。
    repo.tickets.save(ticket('queued', 'open', [{ state: 'ended' }, { state: 'pending' }]))
    // 人发的消息抵达了已结束的 Ticket、但还没恢复它；旧版本留给下一拍。
    repo.tickets.save(ticket('waking', 'ended', [{ state: 'ended' }], ['input']))
    repo.tickets.save(ticket('done', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'github', { pending: ['a'] }))
    repo.threads.save(thread('2', 'github', { subscriptions: ['running'], evaluating: { id: 'e', threadKey: 'github:2', triggerIds: ['b'], strength: 'explicit',
      actor: { source: 'github', id: 'alice' }, basis: { via: 'followup' }, policyVersion: '', startedAt: '', deadline: '' } }))
    repo.threads.save(thread('oc:om', 'feishu', { subscriptions: ['done'] }))
    repo.threads.save(thread('3', 'github'))
    assert.deepEqual(ids(repo.tickets.open()), ['queued', 'running'])
    assert.deepEqual(ids(repo.tickets.active()), ['queued', 'running', 'waking'])
    assert.deepEqual(ids(repo.threads.active()), ['github:1', 'github:2'])
    repo.tickets.save(ticket('running', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'github'))
    assert.deepEqual(ids(repo.tickets.open()), ['queued'])
    assert.deepEqual(ids(repo.tickets.active()), ['queued', 'waking'])
    assert.deepEqual(ids(repo.threads.active()), ['github:2'])
  }
  assert.deepEqual(ids(db.read.subscribedThreads()), ['feishu:oc:om', 'github:2'])
  assert.deepEqual(ids(db.read.subscribedThreads('github')), ['github:2'])
  db.close()
  passed += 1
})

test('给还没有工作集列的老库按已有行补上生成列', () => {
  const path = join(tempRoot('app-add-columns'), 'orchestrator.sqlite')
  const raw = new DatabaseSync(path)
  raw.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  raw.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION))
  raw.prepare('INSERT INTO ticket VALUES (?,?)').run('t', JSON.stringify(ticket('t', 'open', [{ state: 'running' }])))
  raw.prepare('INSERT INTO thread VALUES (?,?)').run('github:1', JSON.stringify(thread('1', 'github', { pending: ['a'], subscriptions: ['t'] })))
  raw.close()
  const db = new Store(path)
  assert.deepEqual([ids(db.tickets.open()), ids(db.tickets.active())], [['t'], ['t']])
  assert.deepEqual([ids(db.threads.active()), ids(db.read.subscribedThreads('github'))], [['github:1'], ['github:1']])
  db.close()
  passed += 1
})

test('Thread 用第一条人类 Trigger 命名', () => {
  const db = new Store(join(tempRoot('app-first-trigger'), 'orchestrator.sqlite'))
  const base = { source: 'github', threads: [{ source: 'github', id: '5' }], actor: { source: 'github', id: 'x' }, meta: {} }
  db.triggers.save({ ...base, id: 'ci', human: false, at: '1', text: 'GitHub PR #5 CI: {}' })
  db.triggers.save({ ...base, id: 'person', human: true, at: '2', text: 'please look' })
  assert.equal(db.read.firstTrigger('github:5')?.id, 'ci')
  assert.equal(db.read.firstTrigger('github:5', true)?.id, 'person')
  db.close()
  passed += 1
})

test('按来源统计 Trigger，列表新在前，可按被过滤筛选', () => {
  const db = new Store(join(tempRoot('app-trigger-stats'), 'db.sqlite'))
  const trigger = (id, source, at) => ({ id, source, threads: [{ source, id: 'x' }], actor: { source, id: 'a' }, human: true, at, text: id, meta: {} })
  db.triggers.save(trigger('old', 'feishu', '2026-09-01T00:00:00Z'))
  db.triggers.save(trigger('kept', 'feishu', '2026-09-23T00:00:00Z'))
  db.triggers.save(trigger('dropped', 'feishu', '2026-09-23T01:00:00Z'))
  db.triggers.saveDisposition('dropped', { filtered: { code: 'chat_not_allowed' }, fanout: [], at: '' })
  db.triggers.save(trigger('gh', 'github', '2026-09-22T00:00:00Z'))
  assert.deepEqual(db.read.triggerStats('2026-09-22T12:00:00Z'), { feishu: { received: 2, filtered: 1, lastAt: '2026-09-23T01:00:00Z' }, github: { received: 0, filtered: 0, lastAt: '2026-09-22T00:00:00Z' } })
  const page = db.read.triggers({ source: 'feishu' }, 0, 2)
  assert.deepEqual(page.items.map((item) => item.id), ['dropped', 'kept'])
  assert.equal(page.more, true)
  assert.deepEqual(db.read.triggers({ filtered: true }).items.map((item) => item.id), ['dropped'])
  db.close()
  passed += 1
})

test('Thread 链接到来源点名的页面，否则链接到开头的消息', () => {
  const db = new Store(join(tempRoot('app-links'), 'links.sqlite'))
  const saveThread = (keyValue, source, id, meta = {}) => db.threads.save({ key: keyValue, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta })
  saveThread('github:7', 'github', '7', { url: 'https://github.com/acme/widgets/pull/7' })
  saveThread('feishu:oc_1:om_1', 'feishu', 'oc_1:om_1')
  db.triggers.save({ id: 'f1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true, at: '1', text: 'hi', url: 'https://applink.feishu.cn/client/message/link/open?token=t', meta: {} })
  assert.equal(threadFacts(db, db.threads.get('github:7')).url, 'https://github.com/acme/widgets/pull/7')
  assert.equal(threadFacts(db, db.threads.get('feishu:oc_1:om_1')).url, 'https://applink.feishu.cn/client/message/link/open?token=t')
  db.close()
  passed += 1
})

test('在 Thread 的 meta 里设置与删除来源键', () => {
  const db = new Store(join(tempRoot('app-patch-meta'), 'orchestrator.sqlite'))
  db.threads.save({ key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: { isPr: true, gone: true } })
  db.threads.patchMeta('github:5', { gone: undefined, title: 'Fix' })
  assert.deepEqual(db.threads.get('github:5').meta, { isPr: true, title: 'Fix' })
  db.threads.patchMeta('github:6', { title: 'none' })
  assert.equal(db.threads.get('github:6'), undefined)
  db.close()
  passed += 1
})

test('每个 KV 键只在 KV 里拼写，记录由它的表项命名', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..')
  const entries = Object.values(KV).flatMap((group) => Object.values(group))
  // 跳过会和无关字符串字面量撞车的单词键，只看带分隔符的键。
  const keys = entries.map((entry) => (typeof entry === 'string' ? entry : entry.prefix)).filter((name) => /[-:]/.test(name))
  // 只扫移植的镜像目录：KV 键的拼写只许出现在 kv.ts 与迁移里。
  const modules = ['app', 'core', 'executor', 'infra', 'sources']
    .flatMap((dir) => readdirSync(join(src, dir), { recursive: true, encoding: 'utf8' })
      .filter((path) => /\.tsx?$/.test(path)).map((path) => join(dir, path)))
  const spelled = modules.flatMap((path) => {
    if (path.endsWith('kv.ts') || path === join('app', 'migration.ts')) return []
    const text = readFileSync(join(src, path), 'utf8')
    return keys.filter((name) => text.includes(`'${name}`) || text.includes(`\`${name}`)).map((name) => `${path}: ${name}`)
  })
  assert.deepEqual(spelled, [])
  passed += 1
})

test('提交后回调只在最外层事务提交后跑，回滚掉的事务排的回调一条不跑', () => {
  const db = new Store(join(tempRoot('app-after-commit'), 'orchestrator.sqlite'))
  const ran = []
  db.atomic(() => {
    db.afterCommit(() => { ran.push('outer') })
    db.atomic(() => { db.afterCommit(() => { ran.push('inner') }) })
    assert.throws(() => db.atomic(() => { db.afterCommit(() => { ran.push('rolled back') }); throw new Error('boom') }), /boom/)
    // 最外层提交之前一条都不跑。
    assert.deepEqual(ran, [])
  })
  assert.deepEqual(ran, ['outer', 'inner'])
  assert.throws(() => db.atomic(() => { db.afterCommit(() => { ran.push('failed') }); throw new Error('boom') }), /boom/)
  db.afterCommit(() => { ran.push('outside') })
  assert.deepEqual(ran, ['outer', 'inner', 'outside'])
  db.close()
  passed += 1
})

test('提交后回调抛错要上报，其余照跑，已提交的写入保留', () => {
  const reported = []
  const db = new Store(join(tempRoot('app-report'), 'orchestrator.sqlite'), (error) => { reported.push(error) })
  const ran = []
  const value = db.atomic(() => {
    db.set(KV.runtime.masterId, 'm')
    db.afterCommit(() => { throw new Error('cancel failed') })
    db.afterCommit(() => { ran.push('next') })
    return 'done'
  })
  assert.equal(value, 'done')
  assert.deepEqual(ran, ['next'])
  assert.deepEqual(reported, [new Error('cancel failed')])
  assert.equal(db.get(KV.runtime.masterId), 'm')
  db.close()
  passed += 1
})

test('打不开成当前版本的库要关掉句柄，让同进程的后续尝试还能打开它', () => {
  const path = join(tempRoot('app-close'), 'orchestrator.sqlite')
  const db = new Store(path)
  db.set(KV.store.schema, SCHEMA_VERSION + 1)
  db.close()
  const original = DatabaseSync.prototype.close
  let closes = 0
  DatabaseSync.prototype.close = function patched(...args) { closes += 1; return original.apply(this, args) }
  try {
    assert.throws(() => new Store(path), /Unsupported orchestrator database version/)
    assert.equal(closes, 1)
  } finally { DatabaseSync.prototype.close = original }
  passed += 1
})

test('设置按版本保存：当前设置就是当前修订的快照，别处不存', () => {
  const db = new Store(join(tempRoot('app-settings'), 'orchestrator.sqlite'))
  assert.deepEqual(db.settings(), SettingsSchema.parse({}))
  db.saveSettings({ ...db.settings(), paused: true }, { source: 'panel', block: 'pause', policyVersion: 'v', policyChanged: false, notified: [] })
  db.saveSettings({ ...db.settings(), executor: { ...db.settings().executor, maxWorkers: 5 } })
  assert.equal(db.settings().paused, true)
  assert.equal(db.settings().executor.maxWorkers, 5)
  assert.deepEqual(db.settingsHistory().map((version) => [version.revision, version.source]), [[2, 'internal'], [1, 'panel']])
  assert.deepEqual([db.get(KV.settings.revision), db.blockRevision('pause'), db.keys('settings').filter((name) => name === 'settings')], [2, 1, []])
  db.close()
  passed += 1
})

test('替换早先版本定义不同的工作集列，并删掉本版没有的列', () => {
  const path = join(tempRoot('app-replace-columns'), 'orchestrator.sqlite')
  const raw = new DatabaseSync(path)
  raw.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    ALTER TABLE ticket ADD COLUMN open INTEGER AS (CASE WHEN value ->> '$.state' = 'open' THEN 1 END);
    ALTER TABLE ticket ADD COLUMN ref TEXT AS (nullif(value ->> '$.assignments[#-1].ref', ''));
    CREATE INDEX ticket_open ON ticket(open) WHERE open IS NOT NULL; CREATE INDEX ticket_ref ON ticket(ref) WHERE ref IS NOT NULL`)
  raw.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION))
  raw.prepare('INSERT INTO ticket (id, value) VALUES (?,?)').run('t', JSON.stringify(ticket('t', 'open', [{ state: 'running' }])))
  raw.close()
  const db = new Store(path)
  // 现在 open 集按 Ticket 有没有结束来读。
  assert.deepEqual(ids(db.tickets.open()), ['t'])
  assert.deepEqual(db.db.prepare("SELECT name FROM pragma_table_xinfo('ticket') WHERE name = 'ref'").all(), [])
  db.close()
  passed += 1
})

test('列表顺序在 SQLite 与内存里一致，嵌套事务失败只撤销自己', () => {
  const db = new Store(join(tempRoot('app-order'), 'orchestrator.sqlite'))
  const order = (items) => items.map((item) => item.id ?? item.key)
  const decision = (id) => ({ id, evalId: '', threadKey: 'github:1', triggerIds: [], policyVersion: '', at: id, kind: 'ignore', reason: [],
    strength: 'explicit' })
  const run = (repo) => {
    repo.tickets.save(ticket('first', 'open', [{ state: 'running' }]))
    repo.tickets.save(ticket('second', 'ended', [{ state: 'ended' }]))
    repo.tickets.save(ticket('third', 'open', [{ state: 'pending' }]))
    // 再存一次不改变位置。
    repo.tickets.save({ ...repo.tickets.get('first'), title: 'again' })
    repo.threads.save(thread('1', 'github', { pending: ['a'] })); repo.threads.save(thread('2', 'github')); repo.threads.save(thread('3', 'github', { pending: ['b'] }))
    repo.decisions.save(decision('d2'))
    repo.decisions.save(decision('d1'))
    // 失败的嵌套事务撤销自己的写入；外层继续并保留自己的。
    repo.atomic(() => {
      repo.tickets.save(ticket('outer', 'open', []))
      assert.throws(() => repo.atomic(() => { repo.tickets.save(ticket('inner', 'open', [])); throw new Error('boom') }), /boom/)
    })
    return { tickets: order(repo.tickets.list()), open: order(repo.tickets.open()), active: order(repo.tickets.active()), threads: order(repo.threads.list()),
      activeThreads: order(repo.threads.active()), decisions: order(repo.decisions.byThread('github:1')) }
  }
  const memory = run(new MemoryRepositories())
  assert.deepEqual(memory, { tickets: ['outer', 'third', 'second', 'first'], open: ['outer', 'third', 'first'], active: ['third', 'first'],
    threads: ['github:1', 'github:2', 'github:3'], activeThreads: ['github:1', 'github:3'], decisions: ['d2', 'd1'] })
  assert.deepEqual(run(db), memory)
  db.close()
  passed += 1
})

test('状态目录只给属主，库文件只给属主读', { skip: process.platform === 'win32' ? 'Windows 的 chmod 不映射 POSIX 权限位，无法验证 0700/0600' : false }, () => {
  const path = join(tempRoot('app-perms'), 'state', 'orchestrator.sqlite')
  new Store(path).close()
  assert.deepEqual([statSync(dirname(path)).mode & 0o777, statSync(path).mode & 0o777], [0o700, 0o600])
  passed += 1
})

test('键前缀和搜索词里的 `%`、`_` 按字面读，不当通配符', () => {
  const db = new Store(join(tempRoot('app-like'), 'orchestrator.sqlite'))
  for (const name of ['a%b', 'axb', 'a_c', 'abc']) db.set(name, 1)
  assert.deepEqual([db.keys('a%').sort(), db.keys('a_').sort()], [['a%b'], ['a_c']])
  const said = (id, text) => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'u' },
    human: true, at: '2026-10-01T00:00:00.000Z', text, meta: {} })
  for (const [id, text] of [['p', 'grew 50% today'], ['q', 'grew 500 today'], ['r', 'see a_b'], ['s', 'see axb']]) db.triggers.save(said(id, text))
  assert.deepEqual([db.read.search('50%').map((item) => item.id), db.read.search('a_b').map((item) => item.id)], [['p'], ['r']])
  db.close()
  passed += 1
})
after(() => {
  // 失败用例可能没走到 close，Windows 上删不掉被占用文件；清理是尽力而为，不因此让进程退出码变红。
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
  console.log(`通过 ${passed}`)
})
