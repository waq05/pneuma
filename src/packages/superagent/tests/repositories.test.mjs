/**
 * @pneuma/superagent 仓储适配层的包级测试：钉 9 条不变量。
 *
 * 为什么是这几条：事务提交与回滚、嵌套并入外层、坏行报错、四类聚合的读写与三个「活跃集」查询——
 * 这些坏了都不是「报个错」那么简单：回滚失效会留下半张工单，嵌套失效会让内层提前提交，
 * 活跃集判据放宽会让 Eval 把已经处理过的 Trigger 再跑一遍。所以每条都得有断言。
 *
 * 全程用 `tmpdir()` 下的临时目录，且每个用例一个：绝不碰用户真实的 `~/.dsc`。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const storeModule = await import('../../../../lib/packages/superagent/adapters/store.js')
const repositoryModule = await import('../../../../lib/packages/superagent/adapters/repositories.js')

const AT = '2026-01-01T00:00:00.000Z'
const roots = []
let passed = 0

/**
 * 一套用例一个库。
 *
 * 仓储拿的是 `DscStore.handle` 同一条连接：这正是被测的接线方式，事务、PRAGMA 与建表都在
 * 这一条连接上，换一条就测不到「事务是否真的落在同一个 DatabaseSync 上」。
 */
function openCase(label) {
  const dir = mkdtempSync(join(tmpdir(), `superagent-repositories-${label}-`))
  roots.push(dir)
  const store = storeModule.openStore(join(dir, 'orchestrator.sqlite'))
  return { store, repos: new repositoryModule.StoreRepositories(store.handle), close: () => store.close() }
}

/** 领域对象只当 JSON 用：这里造最小合法形状，不引 core 的实现，免得测试跟着领域逻辑一起变。 */
function trigger(id, overrides = {}) {
  return {
    id,
    source: 'test',
    threads: [{ source: 'test', id: 'thread-1' }],
    actor: { source: 'test', id: 'actor-1' },
    human: true,
    at: AT,
    text: `trigger ${id}`,
    meta: {},
    ...overrides,
  }
}

function thread(key, overrides = {}) {
  return {
    key,
    ref: { source: 'test', id: key.replace(/^test:/, '') },
    createdAt: AT,
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {},
    ...overrides,
  }
}

function ticket(id, overrides = {}) {
  return {
    id,
    title: `ticket ${id}`,
    decisionId: 'd-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'p1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'test', id: 'actor-1' },
      scope: 'test',
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: 'trg-1', triggerIds: ['trg-1'] },
    ...overrides,
  }
}

function decision(id, threadKeyValue, overrides = {}) {
  return {
    id,
    evalId: 'eval-1',
    threadKey: threadKeyValue,
    triggerIds: ['trg-1'],
    policyVersion: 'p1',
    at: AT,
    kind: 'accept',
    reason: [],
    strength: 'explicit',
    ...overrides,
  }
}

test('atomic：成功时提交，失败时整体回滚，且异常原样抛出', () => {
  const testCase = openCase('atomic')
  try {
    const first = ticket('t-1')
    testCase.repos.tickets.save(first)
    const before = testCase.repos.tickets.list().length

    const boom = new Error('写到一半失败')
    let caught
    try {
      testCase.repos.atomic(() => {
        testCase.repos.tickets.save(ticket('t-2'))
        throw boom
      })
    } catch (error) {
      caught = error
    }
    // 原样抛出：同一个对象，不是包一层的新错误，调用方才能按自己的错误类型分支
    assert.equal(caught, boom)
    assert.equal(testCase.repos.tickets.list().length, before)
    assert.equal(testCase.repos.tickets.get('t-2'), undefined)
    assert.deepEqual(testCase.repos.tickets.get('t-1'), first)
    // 回滚不留事务：否则后面每次 atomic 都会撞上「已有活动事务」
    assert.equal(testCase.store.handle.isTransaction, false)

    testCase.repos.atomic(() => {
      testCase.repos.tickets.save(ticket('t-3'))
    })
    assert.ok(testCase.repos.tickets.get('t-3'))
  } finally {
    testCase.close()
  }
  passed += 1
})

test('atomic 嵌套：内层不开新事务，内层抛错由外层整体回滚', () => {
  const testCase = openCase('nested')
  try {
    // 内层若自己提交，外层再抛错也抹不掉它；能一起抹掉才说明内层确实并入了外层事务
    assert.throws(
      () =>
        testCase.repos.atomic(() => {
          testCase.repos.tickets.save(ticket('outer'))
          testCase.repos.atomic(() => {
            testCase.repos.tickets.save(ticket('inner'))
          })
          throw new Error('外层失败')
        }),
      /外层失败/,
    )
    assert.deepEqual(testCase.repos.tickets.list(), [])
    assert.equal(testCase.store.handle.isTransaction, false)

    // 嵌套成功只提交一次，两层写入都落库
    testCase.repos.atomic(() => {
      testCase.repos.tickets.save(ticket('outer'))
      testCase.repos.atomic(() => {
        testCase.repos.tickets.save(ticket('inner'))
      })
    })
    assert.deepEqual(testCase.repos.tickets.list().map((row) => row.id), ['inner', 'outer'])
  } finally {
    testCase.close()
  }
  passed += 1
})

test('triggers：save 是 upsert，get 读回最新值，disposition 独立存取', () => {
  const testCase = openCase('triggers')
  try {
    const first = trigger('trg-1')
    testCase.repos.triggers.save(first)
    assert.deepEqual(testCase.repos.triggers.get('trg-1'), first)
    assert.equal(testCase.repos.triggers.get('missing'), undefined)

    const updated = trigger('trg-1', {
      text: '改过的正文',
      threads: [{ source: 'test', id: 'a' }, { source: 'test', id: 'b' }],
    })
    testCase.repos.triggers.save(updated)
    assert.deepEqual(testCase.repos.triggers.get('trg-1'), updated)

    // trigger_thread 跟着重建：旧线程的行要消失，否则时间线会读出一条已经不存在的归属
    const rows = testCase.store.handle
      .prepare('SELECT thread FROM trigger_thread WHERE id = ? ORDER BY thread')
      .all('trg-1')
    assert.deepEqual(rows.map((row) => row.thread), ['test:a', 'test:b'])

    assert.equal(testCase.repos.triggers.disposition('trg-1'), undefined)
    const disposition = { fanout: ['t-1'], at: AT }
    testCase.repos.triggers.saveDisposition('trg-1', disposition)
    assert.deepEqual(testCase.repos.triggers.disposition('trg-1'), disposition)
    testCase.repos.triggers.saveDisposition('trg-1', { ...disposition, requeued: true })
    assert.deepEqual(testCase.repos.triggers.disposition('trg-1'), { ...disposition, requeued: true })
  } finally {
    testCase.close()
  }
  passed += 1
})

test('threads：save/get/list 按插入序读回', () => {
  const testCase = openCase('threads')
  try {
    assert.equal(testCase.repos.threads.get('test:a'), undefined)
    const a = thread('test:a')
    const b = thread('test:b', { lastAt: AT })
    // 故意倒着写：list 的顺序必须是插入序（rowid），不是 key 的字母序
    testCase.repos.threads.save(b)
    testCase.repos.threads.save(a)
    assert.deepEqual(testCase.repos.threads.get('test:a'), a)
    assert.deepEqual(testCase.repos.threads.list(), [b, a])

    const changed = { ...a, pending: ['trg-1'] }
    testCase.repos.threads.save(changed)
    assert.deepEqual(testCase.repos.threads.get('test:a'), changed)
    assert.equal(testCase.repos.threads.list().length, 2)
  } finally {
    testCase.close()
  }
  passed += 1
})

test('threads.active：只挑出 pending 非空或 evaluating 的线程', () => {
  const testCase = openCase('threads-active')
  try {
    testCase.repos.threads.save(thread('test:queued', { pending: ['trg-2', 'trg-1'] }))
    testCase.repos.threads.save(
      thread('test:evaluating', {
        evaluating: {
          id: 'eval-1',
          threadKey: 'test:evaluating',
          triggerIds: ['trg-1'],
          strength: 'explicit',
          actor: { source: 'test', id: 'actor-1' },
          basis: { via: 'addressed', addressed: 'mention' },
          policyVersion: 'p1',
          startedAt: AT,
          deadline: AT,
        },
      }),
    )
    // 有工单订阅它，但没排队、没评估：不算活跃——判据不是「有没有工单」
    testCase.repos.threads.save(thread('test:watched', { subscriptions: ['t-1'], lastAt: AT }))
    assert.deepEqual(testCase.repos.threads.active().map((row) => row.key), ['test:queued', 'test:evaluating'])
  } finally {
    testCase.close()
  }
  passed += 1
})

test('tickets：save/get/list 新的在前，open 排除已结束', () => {
  const testCase = openCase('tickets')
  try {
    const a = ticket('t-a')
    const b = ticket('t-b')
    const ended = ticket('t-c', { ended: { at: AT, by: 'human', outcome: 'stopped' } })
    testCase.repos.tickets.save(a)
    testCase.repos.tickets.save(b)
    testCase.repos.tickets.save(ended)
    assert.deepEqual(testCase.repos.tickets.get('t-a'), a)
    assert.deepEqual(testCase.repos.tickets.list().map((row) => row.id), ['t-c', 't-b', 't-a'])
    assert.deepEqual(testCase.repos.tickets.open().map((row) => row.id), ['t-b', 't-a'])

    testCase.repos.tickets.save({ ...a, title: '改过标题' })
    assert.equal(testCase.repos.tickets.get('t-a').title, '改过标题')
    assert.equal(testCase.repos.tickets.list().length, 3)
  } finally {
    testCase.close()
  }
  passed += 1
})

test('tickets.active：挑出有未送达 Input 或最新 Assignment 为 pending/running 的工单', () => {
  const testCase = openCase('tickets-active')
  try {
    const running = { id: 'as-1', state: 'running', createdAt: AT }
    const pending = { id: 'as-2', state: 'pending', createdAt: AT }
    const endedAssignment = { id: 'as-3', state: 'ended', createdAt: AT, endedAt: AT, endedReason: '完成' }
    testCase.repos.tickets.save(
      ticket('t-input', {
        inputs: [{ id: 'in-1', kind: 'text', text: '在这', at: AT }],
        undelivered: ['in-1'],
        assignments: [endedAssignment],
      }),
    )
    testCase.repos.tickets.save(ticket('t-running', { assignments: [endedAssignment, running] }))
    testCase.repos.tickets.save(ticket('t-pending', { assignments: [pending] }))
    // 历史 Assignment 停在 running、最新已结束：不算活跃（判据只看最新那条）
    testCase.repos.tickets.save(ticket('t-stale', { assignments: [running, endedAssignment] }))
    testCase.repos.tickets.save(ticket('t-idle', { assignments: [endedAssignment] }))
    assert.deepEqual(testCase.repos.tickets.active().map((row) => row.id), ['t-pending', 't-running', 't-input'])
  } finally {
    testCase.close()
  }
  passed += 1
})

test('decisions.byThread：按 thread 列取同一线程的历史，按发生序', () => {
  const testCase = openCase('decisions')
  try {
    testCase.repos.decisions.save(decision('d-1', 'test:a'))
    testCase.repos.decisions.save(decision('d-2', 'test:b'))
    testCase.repos.decisions.save(decision('d-3', 'test:a', { kind: 'ignore' }))
    assert.equal(testCase.repos.decisions.get('d-3').kind, 'ignore')
    assert.deepEqual(testCase.repos.decisions.byThread('test:a').map((row) => row.id), ['d-1', 'd-3'])
    assert.deepEqual(testCase.repos.decisions.byThread('test:none'), [])

    // 换线程要连 `thread` 列一起改，否则按线程查还是旧归属。
    // 顺序看 rowid 而不是 at：upsert 不换行，d-1 虽然改了归属仍排在 d-2 前面。
    testCase.repos.decisions.save(decision('d-1', 'test:b'))
    assert.deepEqual(testCase.repos.decisions.byThread('test:a').map((row) => row.id), ['d-3'])
    assert.deepEqual(testCase.repos.decisions.byThread('test:b').map((row) => row.id), ['d-1', 'd-2'])
  } finally {
    testCase.close()
  }
  passed += 1
})

test('坏行：value 不是 JSON 时抛 StoreRowError，不当成「没有这条」', () => {
  const testCase = openCase('corrupt')
  try {
    testCase.store.handle
      .prepare('INSERT INTO ticket (id, value) VALUES (?, ?)')
      .run('t-broken', '{不是 JSON')
    assert.throws(
      () => testCase.repos.tickets.get('t-broken'),
      (error) =>
        error instanceof repositoryModule.StoreRowError &&
        error.code === 'store_row_corrupt' &&
        error.table === 'ticket' &&
        error.row === 't-broken',
    )
    // 列表也不该默默跳过这一行：跳过等于「这条工单不存在」，比报错更危险
    assert.throws(
      () => testCase.repos.tickets.list(),
      (error) => error.code === 'store_row_corrupt',
    )
  } finally {
    testCase.close()
  }
  passed += 1
})

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})
