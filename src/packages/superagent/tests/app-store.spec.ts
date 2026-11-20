/**
 * `app/store.ts` 的包级覆盖测试：SQLite 持久化层。
 *
 * 为什么值得逐条钉：这一层坏了不会报错，而是「两个编排器各写一遍」「旧库读不出活工单」
 * 「收据被重复入队」「设置版本倒退」这类静默错。所以每条断言读的都是**落库后真实查出来的行**，
 * 用真 SQLite 文件（临时目录），不用内存假件替代被测的 SQL。
 *
 * 夹具与用例覆盖：版本上限与回滚、Thread 索引重建、工作集生成列、老库补列/换列、
 * 事务提交回调（含回调抛错上报）、旧实现写的库整份旁置、设置版本历史、列表顺序、
 * 出站收据的 add/settle/withdraw/behind/waiting，以及 `%`/`_` 按字面匹配。
 *
 * @module @pneuma/superagent/tests/app-store
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store, SCHEMA_VERSION } from '../app/store.js'
import { MemoryRepositories, threadKey } from '../core/index.js'
import type { Decision, Thread, Ticket, Trigger } from '../core/index.js'
import { SettingsSchema } from '../core/policy.js'
import { KV } from '../kv.js'
import { threadFacts } from '../app/views/records.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

/** 工单夹具：只填被测查询会读的字段，其余用空值占位。 */
function ticket(id: string, state: 'open' | 'ended', assignments: { state: 'pending' | 'running' | 'ended' }[], undelivered: string[] = []): Ticket {
  return {
    id, title: id, decisionId: '',
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
    channels: [], assignments: assignments.map((item, index) => ({ id: `${id}-${index}`, createdAt: '', ...item })), inputs: [],
    ...state === 'ended' ? { ended: { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const } } : {},
    undelivered, createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] },
  }
}
/** 线程夹具。 */
function thread(source: string, id: string, fields: Partial<Thread> = {}): Thread {
  return { key: `${source}:${id}`, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {}, ...fields }
}
/** 触发夹具。 */
function trigger(id: string, source: string, threads: { source: string; id: string }[], human: boolean, at: string, text: string): Trigger {
  return { id, source, threads, actor: { source, id: 'actor' }, human, at, text, meta: {} }
}
/** 判定夹具。 */
function decision(id: string, threadKeyValue: string): Decision {
  return { id, evalId: '', threadKey: threadKeyValue, triggerIds: [], policyVersion: '', at: id, kind: 'ignore', reason: [], strength: 'explicit' }
}
/** 出站消息夹具。 */
const message = (id: string, ticketId?: string) => ({
  id, channel: { source: 'feishu', thread: 'oc_1:om_1', address: { chat: 'oc_1' } }, text: `text ${id}`,
  kind: 'reply' as const, ...ticketId === undefined ? {} : { ticketId },
})
/** 工单/线程列表的比较口径：只比 id。 */
const ids = (items: { id?: string; key?: string }[]): string[] => items.map(item => item.id ?? item.key ?? '').sort()

describe('app/store', () => {
  const roots: string[] = []
  const opened: Store[] = []
  /** 每个用例一个临时目录与一个库句柄；用例之间不共享文件。 */
  function open(label: string, report?: (error: unknown) => void): Store {
    const dir = createTempDir(`dsc-sa-store-${label}-`)
    roots.push(dir)
    const db = report === undefined ? new Store(join(dir, 'orchestrator.sqlite')) : new Store(join(dir, 'orchestrator.sqlite'), report)
    opened.push(db)
    return db
  }
  afterEach(() => {
    for (const db of opened.splice(0)) {
      try { db.close() } catch { /* 用例自己关过的忽略。 */ }
    }
  })

  it('atomic 失败整体回滚，嵌套事务只撤销自己', () => {
    const db = open('rollback')
    db.set('a', 1)
    expect(() => db.atomic(() => { db.set('a', 2); throw new Error('boom') })).toThrow(/boom/)
    expect(db.get('a')).toBe(1)
    db.atomic(() => {
      db.set('outer', true)
      expect(() => db.atomic(() => { db.set('inner', true); throw new Error('nested') })).toThrow(/nested/)
    })
    expect(db.get('outer')).toBe(true)
    expect(db.get('inner')).toBeUndefined()
    // 正常路径的返回值原样传出，嵌套层也能传值。
    expect(db.atomic(() => 'value')).toBe('value')
    expect(db.atomic(() => db.atomic(() => 42))).toBe(42)
  })

  it('版本高于本版时拒绝打开；低于 OLDEST 时给出可操作的错话', () => {
    const db = open('version')
    const path = join(roots[roots.length - 1]!, 'orchestrator.sqlite')
    db.set(KV.store.schema, SCHEMA_VERSION + 1)
    db.close()
    expect(() => new Store(path)).toThrow(/Unsupported orchestrator database version/)
    // 改回到低于 OLDEST_SCHEMA：错误里要点名「换新状态目录」。
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE kv SET value=? WHERE key=?').run('9', KV.store.schema)
    raw.close()
    expect(() => new Store(path)).toThrow(/schema 9 predates schema 10/)
  })

  it('Thread 索引在保存时重建：重存会换掉它所在的线程', () => {
    const db = open('index')
    db.triggers.save(trigger('a', 'feishu', [{ source: 'feishu', id: 'oc_1:om_%_x' }], true, '2', 'later'))
    db.triggers.save(trigger('b', 'feishu', [{ source: 'feishu', id: 'oc_1:om_%_x' }, { source: 'github', id: '3' }], true, '1', 'earlier'))
    expect(db.read.threadTriggers('feishu:oc_1:om_%_x').map(item => item.id)).toEqual(['b', 'a'])
    expect(db.read.threadTriggers('github:3').map(item => item.id)).toEqual(['b'])
    db.triggers.save({ ...db.triggers.get('b')!, threads: [{ source: 'github', id: '3' }] })
    expect(db.read.threadTriggers('feishu:oc_1:om_%_x').map(item => item.id)).toEqual(['a'])
    expect(db.read.threadTriggers('github:3').map(item => item.id)).toEqual(['b'])
    // 触发删除后索引行不再残留。
    db.db.prepare('DELETE FROM trigger WHERE id=?').run('a')
    expect(db.read.threadTriggers('feishu:oc_1:om_%_x')).toEqual([])
  })

  it('工作集只读活行，SQLite 与内存实现同序同集，且随保存更新', () => {
    const db = open('working-sets')
    for (const repo of [db, new MemoryRepositories()]) {
      repo.tickets.save(ticket('running', 'open', [{ state: 'running' }]))
      // 重试或恢复会在已结束的 Assignment 后面再加一个 pending。
      repo.tickets.save(ticket('queued', 'open', [{ state: 'ended' }, { state: 'pending' }]))
      // 人发的消息抵达了已结束的 Ticket、但还没恢复它。
      repo.tickets.save(ticket('waking', 'ended', [{ state: 'ended' }], ['input']))
      repo.tickets.save(ticket('done', 'ended', [{ state: 'ended' }]))
      repo.threads.save(thread('github', '1', { pending: ['a'] }))
      repo.threads.save(thread('github', '2', { evaluating: { id: 'e', threadKey: 'github:2', triggerIds: ['b'], strength: 'explicit',
        actor: { source: 'github', id: 'alice' }, basis: { via: 'followup' }, policyVersion: '', startedAt: '', deadline: '' } }))
      repo.threads.save(thread('feishu', 'oc:om', { subscriptions: ['done'] }))
      repo.threads.save(thread('github', '3'))
      expect(ids(repo.tickets.open())).toEqual(['queued', 'running'])
      expect(ids(repo.tickets.active())).toEqual(['queued', 'running', 'waking'])
      expect(ids(repo.threads.active())).toEqual(['github:1', 'github:2'])
      repo.tickets.save(ticket('running', 'ended', [{ state: 'ended' }]))
      repo.threads.save(thread('github', '1'))
      expect(ids(repo.tickets.open())).toEqual(['queued'])
      expect(ids(repo.tickets.active())).toEqual(['queued', 'waking'])
      expect(ids(repo.threads.active())).toEqual(['github:2'])
    }
    // `github:2` 有 evaluating 但没有订阅，所以不在订阅列表里：这条只认 subscriptions。
    expect(ids(db.read.subscribedThreads())).toEqual(['feishu:oc:om'])
    expect(ids(db.read.subscribedThreads('github'))).toEqual([])
  })

  it('给还没有工作集列的旧库按已有行补上生成列', () => {
    const dir = createTempDir('dsc-sa-store-add-columns-')
    const path = join(dir, 'orchestrator.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    raw.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION))
    raw.prepare('INSERT INTO ticket VALUES (?,?)').run('t', JSON.stringify(ticket('t', 'open', [{ state: 'running' }])))
    raw.prepare('INSERT INTO thread VALUES (?,?)').run('github:1', JSON.stringify(thread('github', '1', { pending: ['a'], subscriptions: ['t'] })))
    raw.close()
    const db = new Store(path)
    try {
      expect([ids(db.tickets.open()), ids(db.tickets.active())]).toEqual([['t'], ['t']])
      expect([ids(db.threads.active()), ids(db.read.subscribedThreads('github'))]).toEqual([['github:1'], ['github:1']])
      // effect 表没有 generation 列的老库也要补齐（addColumns 的最后一条分支）。
      expect(db.db.prepare("SELECT name FROM pragma_table_xinfo('effect') WHERE name = 'generation'").all().length).toBe(1)
    } finally { db.close() }
  })

  it('替换早先版本定义不同的生成列，并删掉本版没有的列', () => {
    const dir = createTempDir('dsc-sa-store-replace-columns-')
    const path = join(dir, 'orchestrator.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      ALTER TABLE ticket ADD COLUMN open INTEGER AS (CASE WHEN value ->> '$.state' = 'open' THEN 1 END);
      ALTER TABLE ticket ADD COLUMN ref TEXT AS (nullif(value ->> '$.assignments[#-1].ref', ''));
      CREATE INDEX ticket_open ON ticket(open) WHERE open IS NOT NULL; CREATE INDEX ticket_ref ON ticket(ref) WHERE ref IS NOT NULL`)
    raw.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION))
    raw.prepare('INSERT INTO ticket (id, value) VALUES (?,?)').run('t', JSON.stringify(ticket('t', 'open', [{ state: 'running' }])))
    raw.close()
    const db = new Store(path)
    try {
      // 现在 open 集按 Ticket 有没有结束来读（旧定义按 value.state，形状已不同）。
      expect(ids(db.tickets.open())).toEqual(['t'])
      expect(db.db.prepare("SELECT name FROM pragma_table_xinfo('ticket') WHERE name = 'ref'").all()).toEqual([])
    } finally { db.close() }
  })

  it('Thread 用第一条人类 Trigger 命名', () => {
    const db = open('first-trigger')
    const threads = [{ source: 'github', id: '5' }]
    db.triggers.save(trigger('ci', 'github', threads, false, '1', 'GitHub PR #5 CI: {}'))
    db.triggers.save(trigger('person', 'github', threads, true, '2', 'please look'))
    expect(db.read.firstTrigger('github:5')?.id).toBe('ci')
    expect(db.read.firstTrigger('github:5', true)?.id).toBe('person')
    expect(db.read.firstTrigger('github:6')).toBeUndefined()
  })

  it('线程链接优先用 meta.url，没有就链到它第一条消息', () => {
    const db = open('links')
    db.threads.save(thread('github', '7', { meta: { url: 'https://github.com/acme/widgets/pull/7' } }))
    db.threads.save(thread('feishu', 'oc_1:om_1'))
    db.triggers.save(trigger('f1', 'feishu', [{ source: 'feishu', id: 'oc_1:om_1' }], true, '1', 'hi'))
    expect(threadFacts(db, db.threads.get('github:7')!).url).toBe('https://github.com/acme/widgets/pull/7')
    // 没有 url 的线程不带这个键（不是空串）。
    expect(threadFacts(db, db.threads.get('feishu:oc_1:om_1')!).url).toBeUndefined()
  })

  it('patchMeta 增删来源键，describe 改标题/链接/事实且不存在时不动', () => {
    const db = open('meta')
    db.threads.save(thread('github', '5', { meta: { isPr: true, gone: true } }))
    db.threads.patchMeta('github:5', { gone: undefined, title: 'Fix' })
    expect(db.threads.get('github:5')!.meta).toEqual({ isPr: true, title: 'Fix' })
    // 没有变化就不重写（这里靠读出来仍然相等间接证明）。
    db.threads.patchMeta('github:5', { title: 'Fix' })
    expect(db.threads.get('github:5')!.meta).toEqual({ isPr: true, title: 'Fix' })
    db.threads.patchMeta('github:6', { title: 'none' })
    expect(db.threads.get('github:6')).toBeUndefined()
    db.threads.describe('github:5', { label: 'PR 5', url: 'https://example.test/5', facts: { ci: { value: 'green' }, gone: null } })
    const described = db.threads.get('github:5')!
    expect(described.meta.label).toBe('PR 5')
    expect(described.meta.url).toBe('https://example.test/5')
    expect(described.meta.facts).toEqual({ ci: { value: 'green' } })
    db.threads.describe('github:5', { facts: { ci: null } })
    expect(db.threads.get('github:5')!.meta.facts).toEqual({})
    db.threads.describe('github:404', { label: 'x' })
    expect(db.threads.get('github:404')).toBeUndefined()
  })

  it('提交后回调只在最外层事务提交后跑，回滚掉的事务排的一条不跑', () => {
    const db = open('after-commit')
    const ran: string[] = []
    db.atomic(() => {
      db.afterCommit(() => { ran.push('outer') })
      db.atomic(() => { db.afterCommit(() => { ran.push('inner') }) })
      expect(() => db.atomic(() => { db.afterCommit(() => { ran.push('rolled back') }); throw new Error('boom') })).toThrow(/boom/)
      // 最外层提交之前一条都不跑。
      expect(ran).toEqual([])
    })
    expect(ran).toEqual(['outer', 'inner'])
    expect(() => db.atomic(() => { db.afterCommit(() => { ran.push('failed') }); throw new Error('boom') })).toThrow(/boom/)
    db.afterCommit(() => { ran.push('outside') })
    expect(ran).toEqual(['outer', 'inner', 'outside'])
  })

  it('提交后回调抛错要上报，其余照跑，已提交的写入保留', () => {
    const reported: unknown[] = []
    const db = open('report', error => { reported.push(error) })
    const ran: string[] = []
    const value = db.atomic(() => {
      db.set(KV.runtime.masterId, 'm')
      db.afterCommit(() => { throw new Error('cancel failed') })
      db.afterCommit(() => { ran.push('next') })
      return 'done'
    })
    expect(value).toBe('done')
    expect(ran).toEqual(['next'])
    expect(reported).toHaveLength(1)
    expect(String((reported[0] as Error).message)).toBe('cancel failed')
    expect(db.get(KV.runtime.masterId)).toBe('m')
  })

  it('拍不开成当前版本的库要关掉句柄，让同进程的后续尝试还能打开它', () => {
    const dir = createTempDir('dsc-sa-store-close-')
    const path = join(dir, 'orchestrator.sqlite')
    const db = new Store(path)
    db.set(KV.store.schema, SCHEMA_VERSION + 1)
    db.close()
    const original = DatabaseSync.prototype.close
    let closes = 0
    DatabaseSync.prototype.close = function patched(this: DatabaseSync, ...args: []): void {
      closes += 1
      return original.apply(this, args)
    } as typeof DatabaseSync.prototype.close
    try {
      expect(() => new Store(path)).toThrow(/Unsupported orchestrator database version/)
      expect(closes).toBe(1)
    } finally { DatabaseSync.prototype.close = original }
  })

  it('移植前旧实现的库整份旁置：按新库启动、旧行读不到、旁置文件内容还在，并报一句', () => {
    const root = createTempDir('dsc-sa-store-legacy-')
    const path = join(root, 'orchestrator.sqlite')
    // 移植前的库：版本记在 PRAGMA user_version，没有 kv 的 schema 键，旧表 meta 与旧形状的 ticket 行都在。
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA user_version = 4;
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    raw.prepare('INSERT INTO kv VALUES (?,?)').run('workspace-root', JSON.stringify('/srv/work'))
    raw.prepare('INSERT INTO meta VALUES (?,?)').run('schema-version', '4')
    raw.prepare('INSERT INTO ticket VALUES (?,?)').run('old-1', JSON.stringify({ id: 'old-1', state: 'open', meta: {} }))
    raw.prepare('INSERT INTO ticket VALUES (?,?)').run('old-2', JSON.stringify({ id: 'old-2', state: 'ended', meta: {} }))
    raw.close()
    const reported: string[] = []
    const db = new Store(path, error => { reported.push(String(error)) })
    try {
      // 新库：schema 键写成本版，旧 ticket 行读不到。
      expect(db.get(KV.store.schema)).toBe(SCHEMA_VERSION)
      expect(db.tickets.list()).toEqual([])
    } finally { db.close() }
    // 旧文件整份旁置（连同 SQLite 旁文件），新库留在原路径。
    const moved = readdirSync(root).filter(name => name.includes('.legacy-') && !name.endsWith('-wal') && !name.endsWith('-shm'))
    expect(moved).toHaveLength(1)
    expect(existsSync(path)).toBe(true)
    const legacy = new DatabaseSync(join(root, moved[0]!), { readOnly: true })
    try {
      expect(Number(legacy.prepare('PRAGMA user_version').get()?.user_version)).toBe(4)
      expect(Number(legacy.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n)).toBe(2)
      expect(String(legacy.prepare("SELECT value FROM meta WHERE key = 'schema-version'").get()?.value)).toBe('4')
    } finally { legacy.close() }
    // report 收到一条话，原路径与旁置路径都在里面。
    expect(reported).toHaveLength(1)
    expect(reported[0]!.includes(path)).toBe(true)
    expect(reported[0]!.includes(join(root, moved[0]!))).toBe(true)
    // 全新空库没有 user_version 也没有旧表，不能被误判旁置。
    const freshDir = createTempDir('dsc-sa-store-legacy-fresh-')
    const fresh = join(freshDir, 'orchestrator.sqlite')
    new Store(fresh).close()
    expect(readdirSync(dirname(fresh))).toEqual(['orchestrator.sqlite'])
  })

  it('设置按版本保存：当前设置就是最新修订的快照，块修订独立计数', () => {
    const db = open('settings')
    expect(db.settings()).toEqual(SettingsSchema.parse({}))
    db.saveSettings({ ...db.settings(), paused: true }, { source: 'panel', block: 'pause', policyVersion: 'v', policyChanged: false, notified: [] })
    db.saveSettings({ ...db.settings(), executor: { ...db.settings().executor, maxWorkers: 5 } })
    expect(db.settings().paused).toBe(true)
    expect(db.settings().executor.maxWorkers).toBe(5)
    expect(db.settingsHistory().map(version => [version.revision, version.source])).toEqual([[2, 'internal'], [1, 'panel']])
    expect([db.get(KV.settings.revision), db.blockRevision('pause'), db.keys('settings').filter(name => name === 'settings')]).toEqual([2, 1, []])
    expect(db.settingsHistory(1)).toHaveLength(1)
    // 非法设置被 schema 拒绝，不落库。
    expect(() => db.saveSettings({ paused: 'yes' })).toThrow()
    expect(db.settingsHistory()).toHaveLength(2)
  })

  it('列表读口：工单新在前，判定按线程旧在前', () => {
    const db = open('list')
    db.tickets.save(ticket('first', 'open', [{ state: 'running' }]))
    db.tickets.save(ticket('second', 'ended', [{ state: 'ended' }]))
    db.tickets.save(ticket('third', 'open', [{ state: 'pending' }]))
    expect(db.tickets.list().map(item => item.id)).toEqual(['third', 'second', 'first'])
    expect(db.tickets.open().map(item => item.id)).toEqual(['third', 'first'])
    const decisions = [decision('d2', 'github:1'), decision('d1', 'github:1'), decision('d9', 'github:2')]
    for (const item of decisions) db.decisions.save(item)
    expect(db.decisions.byThread('github:1').map(item => item.id)).toEqual(['d2', 'd1'])
    expect(db.decisions.get('d2')?.id).toBe('d2')
    expect(db.decisions.get('missing')).toBeUndefined()
    // 再存一次不改变位置。
    db.tickets.save({ ...db.tickets.get('first')!, title: 'again' })
    expect(db.tickets.list().map(item => item.id)).toEqual(['third', 'second', 'first'])
  })

  it('出站收据：add 幂等、settle 两种结局、withdraw 只撤 pending', () => {
    const db = open('receipts')
    expect(db.receipts.add(message('m1', 'ticket-1'))).toBe(true)
    // 同 id 再入队保持原收据，返回 false。
    expect(db.receipts.add(message('m1', 'ticket-1'))).toBe(false)
    expect(db.replyStatus('m1')).toBe('pending')
    expect(db.receipts.get('m1')?.text).toBe('text m1')
    expect(db.receipts.waiting().map(item => item.id)).toEqual(['m1'])
    db.receipts.settle(message('m1', 'ticket-1'), 'sent')
    expect(db.replyStatus('m1')).toBe('sent')
    expect(db.receipts.waiting()).toEqual([])
    expect(db.receipts.get('m1')?.dropped).toBeUndefined()
    // 落成 dropped 时记下原因与时间。
    db.receipts.add(message('m2', 'ticket-1'))
    db.receipts.settle(message('m2', 'ticket-1'), 'channelGone')
    expect(db.replyStatus('m2')).toBe('dropped')
    expect(db.receipts.get('m2')?.dropped?.reason).toBe('channelGone')
    expect(Number.isNaN(Date.parse(db.receipts.get('m2')!.dropped!.at))).toBe(false)
    // 已出账的不再被 withdraw 撤回。
    expect(db.receipts.withdraw('m1')).toBe(false)
    expect(db.replyStatus('m1')).toBe('sent')
    // 排队中撤回成功，之后 settle 会重建一条收据，让这个 id 不能再次入队。
    db.receipts.add(message('m3'))
    expect(db.receipts.withdraw('m3')).toBe(true)
    expect(db.receipts.get('m3')).toBeUndefined()
    db.receipts.settle(message('m3'), 'sent')
    expect(db.replyStatus('m3')).toBe('sent')
    expect(db.receipts.add(message('m3'))).toBe(false)
    expect(db.replyStatus('missing')).toBeUndefined()
  })

  it('behind 只认同一工单同一会话里更早的排队消息，且失败次数到线就放行', () => {
    const db = open('behind')
    db.receipts.add(message('m1', 'ticket-1'))
    db.receipts.add(message('m2', 'ticket-1'))
    // m1 没有失败记录：attempts=0 < 1，m2 要排在它后面。
    expect(db.receipts.behind('m2', 1)).toBe(true)
    // 失败到线：不再挡住后面的消息。
    db.db.prepare('INSERT INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES (?,?,?,?,?,?,?,?)')
      .run('reply', 'm1', '{}', 0, 3, 'timeout', '9999', '')
    expect(db.receipts.behind('m2', 4)).toBe(true)
    expect(db.receipts.behind('m2', 3)).toBe(false)
    // 不同工单的排队消息不算在它前面，非排队状态也不算。
    db.receipts.add(message('other', 'ticket-2'))
    expect(db.receipts.behind('other', 1)).toBe(false)
    expect(db.receipts.behind('m1', 1)).toBe(false)
  })

  it('triggers 与 threads 的读写口与 KV set/get/delete', () => {
    const db = open('basic')
    const saved = trigger('t1', 'feishu', [{ source: 'feishu', id: 'oc:om' }], true, '2026-09-23T00:00:00.000Z', 'hi')
    db.triggers.save(saved)
    expect(db.triggers.get('t1')).toEqual(saved)
    expect(db.triggers.get('missing')).toBeUndefined()
    expect(db.triggers.disposition('t1')).toBeUndefined()
    db.triggers.saveDisposition('t1', { fanout: ['ticket-1'], at: 'now' })
    expect(db.triggers.disposition('t1')).toEqual({ fanout: ['ticket-1'], at: 'now' })
    db.threads.save(thread('github', '1'))
    expect(db.threads.get('github:1')?.key).toBe('github:1')
    expect(db.threads.get('github:2')).toBeUndefined()
    db.set(KV.runtime.masterId, 'master')
    expect(db.get(KV.runtime.masterId)).toBe('master')
    db.delete(KV.runtime.masterId)
    expect(db.get(KV.runtime.masterId)).toBeUndefined()
    expect(threadKey({ source: 'github', id: '1' })).toBe('github:1')
  })

  it('键前缀和搜索词里的 `%`、`_` 按字面读，不当通配符', () => {
    const db = open('like')
    for (const name of ['a%b', 'axb', 'a_c', 'abc']) db.set(name, 1)
    expect([db.keys('a%').sort(), db.keys('a_').sort()]).toEqual([['a%b'], ['a_c']])
    expect(db.keys('a%b').sort()).toEqual(['a%b'])
    expect(db.keys(KV.sessions.prompts).every(name => name.startsWith(KV.sessions.prompts.prefix))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('状态目录只给属主，库文件只给属主读', () => {
    const dir = createTempDir('dsc-sa-store-perms-')
    const path = join(dir, 'state', 'orchestrator.sqlite')
    new Store(path).close()
    expect([statSync(dirname(path)).mode & 0o777, statSync(path).mode & 0o777]).toEqual([0o700, 0o600])
  })
})
