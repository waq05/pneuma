/**
 * @pneuma/superagent 存储适配层的包级测试：钉 6 条不变量。
 *
 * 为什么是这 6 条：建库幂等、版本上限、版本下限迁移、单实例锁、事务回滚、表与索引齐全——
 * 这六样任一坏了，症状都不是「报个错」，而是「两个编排器同时写库」「旧代码把新库降级写坏」
 * 「迁移跑一半留下半张表」这类要人工修数据的事故，所以每条都得有断言。
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

/** 期望的表：原文 9 张 + 本适配层补的 3 张。名单写死，不跟着 DDL 自动变——否则改了 DDL 测试也跟着绿。 */
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
]

/** 期望的索引：原文 4 个 + 新增 3 个。 */
const EXPECTED_INDEXES = [
  'trigger_at',
  'trigger_thread_at',
  'decision_thread',
  'effect_due',
  'event_ticket_seq',
  'assignment_ticket',
  'assignment_agent_state',
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
  assert.equal(userVersion(dbPath), 1)
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

test('版本过低：user_version=0 且表被删，重开后表回来、版本回到 1', () => {
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
  assert.equal(userVersion(dbPath), 1)
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
  passed += 1
})

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})
