/**
 * @pneuma/superagent 存储适配层的包级测试：钉住九条不变量。
 *
 * 为什么是这几条：建库幂等、版本上限、版本下限迁移、单实例锁、事务回滚、表与索引齐全、
 * outbox 状态列与老库升级、认领 / 收尾 / 放回、崩溃后 sending 行自动回队列——任一条坏了，
 * 症状都不是「报个错」，而是「两个编排器同时写库」「旧代码把新库降级写坏」「迁移跑一半留下
 * 半张表」「崩一次就丢一批没发出去的消息」这类要人工修数据的事故，所以每条都得有断言。
 *
 * 全程用 `tmpdir()` 下的临时目录，且每个用例一个：绝不碰用户真实的 `~/.dsc`。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const store = await import('../../../../lib/packages/superagent/adapters/store.js')

let passed = 0
const roots = []

/** 每个用例一个临时目录：用例之间不共享库文件，失败也不会互相污染。 */
function tempRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `superagent-store-${label}-`))
  roots.push(dir)
  return dir
}

function withDb(dbPath, work) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return work(db)
  } finally {
    db.close()
  }
}

function tableNames(dbPath) {
  return withDb(dbPath, (db) =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name),
  )
}

function indexNames(dbPath) {
  return withDb(dbPath, (db) =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name),
  )
}

function userVersion(dbPath) {
  return withDb(dbPath, (db) => db.prepare('PRAGMA user_version').get().user_version)
}

function ticketCount(dbPath) {
  return withDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS n FROM ticket').get().n)
}

/** outbox 的列，按名字索引；`dflt_value` 是 SQL 字面量原文（字符串默认值带引号）。 */
function outboxColumns(dbPath) {
  return withDb(dbPath, (db) =>
    Object.fromEntries(db.prepare('PRAGMA table_info(outbox)').all().map((column) => [column.name, column])),
  )
}

/** outbox 的行，按入队顺序；只取 id 与状态，断言时一眼能看清顺序与归属（转成普通对象，便于 deepEqual）。 */
function outboxRows(dbPath) {
  return withDb(dbPath, (db) =>
    db.prepare('SELECT id, state FROM outbox ORDER BY rowid').all().map((row) => ({ id: row.id, state: row.state })),
  )
}

/** 期望的表：原文 9 张 + 本适配层补的 3 张 + 候选收件箱（G1）。名单写死，不跟着 DDL 自动变——否则改了 DDL 测试也跟着绿。 */
const EXPECTED_TABLES = [
  'kv',
  'trigger',
  'disposition',
  'thread',
  'ticket',
  'decision',
  'outbox',
  'trigger_thread',
  'effect',
  'meta',
  'event',
  'assignment',
  'candidate',
]

/** 期望的索引：原文 4 个 + 新增 3 个 + 候选收件箱 1 个。 */
const EXPECTED_INDEXES = [
  'trigger_at',
  'trigger_thread_at',
  'decision_thread',
  'effect_due',
  'event_ticket_seq',
  'assignment_ticket',
  'assignment_agent_state',
  'candidate_state_at',
]

function assertTables(dbPath) {
  const actual = tableNames(dbPath)
  for (const name of EXPECTED_TABLES) {
    assert.ok(actual.includes(name), `缺表 ${name}；现有：${actual.join(', ')}`)
  }
  assert.equal(actual.length, EXPECTED_TABLES.length, `表数量不对，多出来的：${actual.filter((n) => !EXPECTED_TABLES.includes(n)).join(', ')}`)
}

function assertIndexes(dbPath) {
  const actual = indexNames(dbPath)
  for (const name of EXPECTED_INDEXES) {
    assert.ok(actual.includes(name), `缺索引 ${name}；现有：${actual.join(', ')}`)
  }
}

test('建库幂等：同一目录连开两次，表都在、无报错', () => {
  const dbPath = join(tempRoot('idempotent'), 'orchestrator.sqlite')
  store.openStore(dbPath).close()
  store.openStore(dbPath).close()
  store.openStore(dbPath).close()
  assertTables(dbPath)
  assertIndexes(dbPath)
  assert.equal(userVersion(dbPath), store.SCHEMA_VERSION)
  passed += 1
})

test('版本过高：user_version=99 时拒绝打开（store_version_too_new）', () => {
  const dbPath = join(tempRoot('too-new'), 'orchestrator.sqlite')
  store.openStore(dbPath).close()

  const raw = new DatabaseSync(dbPath)
  raw.exec('PRAGMA user_version = 99')
  raw.close()

  assert.throws(
    () => store.openStore(dbPath),
    (error) => error instanceof Error && error.code === 'store_version_too_new',
  )
  // 拒绝之后库必须原样：不静默降级，也不留下半套改动
  assert.equal(userVersion(dbPath), 99)
  assertTables(dbPath)
  passed += 1
})

test('版本过低：user_version=0 且表被删，重开后表回来、版本回到当前版本', () => {
  const dbPath = join(tempRoot('migrate'), 'orchestrator.sqlite')
  store.openStore(dbPath).close()

  const raw = new DatabaseSync(dbPath)
  raw.exec('PRAGMA user_version = 0')
  for (const table of EXPECTED_TABLES) raw.exec(`DROP TABLE IF EXISTS ${table}`)
  raw.close()
  // 先确认真的删干净了，否则这条用例什么都没证明
  assert.deepEqual(tableNames(dbPath), [])

  store.openStore(dbPath).close()
  assertTables(dbPath)
  assertIndexes(dbPath)
  assert.equal(userVersion(dbPath), store.SCHEMA_VERSION)
  passed += 1
})

test('锁冲突：第一次拿到之后，第二次抛 instance_lock_busy', () => {
  const lockPath = join(tempRoot('lock'), 'orchestrator.lock')
  const held = store.acquireInstanceLock(lockPath)
  try {
    assert.throws(
      () => store.acquireInstanceLock(lockPath),
      (error) => error instanceof Error && error.code === 'instance_lock_busy',
    )
  } finally {
    held.release()
  }
  // 释放之后能再拿：否则崩一次就永远起不来
  const again = store.acquireInstanceLock(lockPath)
  try {
    assert.equal(again.path, lockPath)
  } finally {
    again.release()
  }
  passed += 1
})

test('事务回滚：atomic 里抛错后行数不变', () => {
  const dbPath = join(tempRoot('rollback'), 'orchestrator.sqlite')
  const db = store.openStore(dbPath)
  try {
    db.createTicket({ title: '留在库里的一张', task: '这张是回滚前就提交的' })
    const before = ticketCount(dbPath)
    assert.equal(before, 1)

    assert.throws(
      () =>
        db.atomic(() => {
          db.createTicket({ title: '不该留下的', task: '这段写事务会抛错' })
          throw new Error('模拟写到一半失败')
        }),
      /模拟写到一半失败/,
    )
    assert.equal(ticketCount(dbPath), before)
  } finally {
    db.close()
  }
  passed += 1
})

test('表与索引：逐个 sqlite_master 查', () => {
  const dbPath = join(tempRoot('schema'), 'orchestrator.sqlite')
  store.openStore(dbPath).close()
  assert.ok(existsSync(dbPath))
  for (const name of EXPECTED_TABLES) {
    const hit = withDb(dbPath, (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
    )
    assert.ok(hit !== undefined, `sqlite_master 里没有表 ${name}`)
  }
  for (const name of EXPECTED_INDEXES) {
    const hit = withDb(dbPath, (db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name),
    )
    assert.ok(hit !== undefined, `sqlite_master 里没有索引 ${name}`)
  }
  // 新库走「建 v1 形状 → v2 迁移加列」这条路，列与默认值都得真的在。
  const columns = outboxColumns(dbPath)
  assert.ok('state' in columns, `outbox 缺 state 列；现有：${Object.keys(columns).join(', ')}`)
  assert.equal(columns.state.dflt_value, "'pending'", 'state 默认值必须是 pending，老行升级后才直接可用')
  assert.equal(columns.state.notnull, 1, 'state 是 NOT NULL')
  passed += 1
})

test('老库升级：v1 结构 + 已有行 → 打开后补上 state 列、老行变 pending', () => {
  const dbPath = join(tempRoot('upgrade'), 'orchestrator.sqlite')
  // 手搓一个 v1 库：只有 outbox 的旧形状、版本号 1、里面已经有一行待发消息。
  const raw = new DatabaseSync(dbPath)
  raw.exec('CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  raw.exec(`INSERT INTO outbox (id, value) VALUES ('old', '{"id":"old","kind":"reply"}')`)
  raw.exec('PRAGMA user_version = 1')
  raw.close()

  const db = store.openStore(dbPath)
  db.close()

  assert.equal(userVersion(dbPath), store.SCHEMA_VERSION, '升级后版本号要跟上代码')
  assert.ok('state' in outboxColumns(dbPath), '老库要补上 state 列')
  const row = withDb(dbPath, (probe) => {
    const got = probe.prepare('SELECT id, value, state FROM outbox').get()
    return { id: got.id, value: got.value, state: got.state }
  })
  assert.deepEqual(row, { id: 'old', value: '{"id":"old","kind":"reply"}', state: 'pending' }, '老行补默认值，载荷不动')
  passed += 1
})

test('claimOutbox：取走的行是 sending，不是被删', () => {
  const dbPath = join(tempRoot('claim'), 'orchestrator.sqlite')
  const db = store.openStore(dbPath)
  try {
    db.enqueueOutbox({ id: 'm1', kind: 'reply', payload: { text: '第一句' } })
    db.enqueueOutbox({ id: 'm2', kind: 'reply', payload: { text: '第二句' } })

    const claimed = db.claimOutbox(1)
    assert.deepEqual(claimed.map((item) => item.id), ['m1'], '按入队顺序取，且一次只取 limit 条')
    assert.deepEqual(claimed[0].payload, { text: '第一句' }, '载荷原样交出来')
    assert.deepEqual(
      outboxRows(dbPath),
      [{ id: 'm1', state: 'sending' }, { id: 'm2', state: 'pending' }],
      '认领只改状态，不删行',
    )

    // 已经被认领的那一行不能再被取第二次，否则两个发送方会各发一遍。
    assert.deepEqual(db.claimOutbox(50).map((item) => item.id), ['m2'])
  } finally {
    db.close()
  }
  passed += 1
})

test('finishOutbox 删行；requeueOutbox 放回 pending 且能被再次认领', () => {
  const dbPath = join(tempRoot('finish-requeue'), 'orchestrator.sqlite')
  const db = store.openStore(dbPath)
  try {
    db.enqueueOutbox({ id: 'm1', kind: 'reply', payload: { text: '发得出去' } })
    assert.deepEqual(db.claimOutbox().map((item) => item.id), ['m1'])
    db.finishOutbox('m1')
    assert.deepEqual(outboxRows(dbPath), [], '收尾之后行要没了')

    db.enqueueOutbox({ id: 'm2', kind: 'reply', payload: { text: '这拍发不出去' } })
    assert.deepEqual(db.claimOutbox().map((item) => item.id), ['m2'])
    db.requeueOutbox('m2')
    assert.deepEqual(outboxRows(dbPath), [{ id: 'm2', state: 'pending' }], '放回队列只改状态、不重写载荷')
    assert.deepEqual(db.claimOutbox().map((item) => item.id), ['m2'], '放回之后下一拍要能再次取到')
  } finally {
    db.close()
  }
  passed += 1
})

test('崩溃恢复：库里的 sending 行在重开 store 后变回 pending', () => {
  const dbPath = join(tempRoot('crash-recovery'), 'orchestrator.sqlite')
  // 模拟「认领之后、收尾之前」进程没了：行停在 sending，没人会再去发它。
  const first = store.openStore(dbPath)
  first.enqueueOutbox({ id: 'stuck', kind: 'reply', payload: { text: '崩在中间的那条' } })
  assert.deepEqual(first.claimOutbox().map((item) => item.id), ['stuck'])
  first.close()
  assert.deepEqual(outboxRows(dbPath), [{ id: 'stuck', state: 'sending' }], '关库不会自动收尾，先确认行确实卡在 sending')

  const second = store.openStore(dbPath)
  try {
    assert.deepEqual(outboxRows(dbPath), [{ id: 'stuck', state: 'pending' }], '重开库要把 sending 放回 pending')
    assert.deepEqual(second.claimOutbox().map((item) => item.id), ['stuck'], '恢复之后要能被重新认领')
  } finally {
    second.close()
  }
  passed += 1
})

// 候选收件箱（G1）：推断候选不直接建工单，先落在这里等人点头。
// 钉四件事：写进去读得出来、重复写同一 id 不出两行、只列 pending、定过结论的不再改。
test('候选收件箱：写入 / 重写 / 只列 pending / 结论幂等', () => {
  const dbPath = join(tempRoot('candidate'), 'orchestrator.sqlite')
  const db = store.openStore(dbPath)
  try {
    const value = { outcome: { kind: 'accept', title: '改文案' }, title: '改文案', reason: '命中规则', scope: 'docs/', source: 'github' }
    db.saveCandidate('eval-1', 'trigger-1', 'github:1', value)
    db.saveCandidate('eval-2', 'trigger-2', 'github:2', { ...value, title: '第二张' })
    assert.deepEqual(db.listCandidates().map((item) => item.id).sort(), ['eval-1', 'eval-2'], '两条都要在')
    assert.equal(db.getCandidate('eval-1').value.title, '改文案', 'value 要原样读回来')

    // 同一个 id 重写：不出第二行，状态回到 pending（Eval 超时重排会再判一次）。
    db.saveCandidate('eval-1', 'trigger-1', 'github:1', { ...value, title: '改文案（重判）' })
    assert.equal(db.listCandidates().length, 2, '同一个 id 重写不该多出一行')
    assert.equal(db.getCandidate('eval-1').value.title, '改文案（重判）', '重写要覆盖 value')

    // 定结论：接单之后它不再出现在待确认里，再定一次返回 false。
    assert.equal(db.settleCandidate('eval-1', 'accepted'), true)
    assert.deepEqual(db.listCandidates().map((item) => item.id), ['eval-2'], '定过结论的不该再列出来')
    assert.equal(db.settleCandidate('eval-1', 'ignored'), false, '已经定过结论的不该被改第二次')
    assert.equal(db.getCandidate('eval-1').state, 'accepted', '状态保持第一次的结论')
  } finally {
    db.close()
  }
  passed += 1
})

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})
