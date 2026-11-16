/**
 * @pneuma/superagent 的 effect 队列包级测试：测移植版 `app/effects.ts`（`Effects` 类，逐字移植自上游
 * `src/app/effects.ts`），转写自上游 `tests/effects.spec.ts` 的 13 条用例：事务提交后才派发（回滚的不跑）、
 * 同 kind+key 合并成最新载荷、按 kind 限流并保持 seq 先后、指数退避封顶与体检项报错、drain 后重启续跑、
 * `Later` 只推后首次退避、有序 kind 被失败的队首压住、quiet 不写错误、运行中 cancel 再入队不丢新行、
 * 队列自身失败上报、重复 handler 拒绝。每条都钉「改错了不会当场报错、只会在崩溃或重试时丢活」。
 *
 * 全程用临时目录与显式库路径，绝不碰 `~/.dsc`；时钟可注入，退避在用例里瞬移，
 * 不靠 `setTimeout` 真等 2 秒。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/effects
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

/** 整个文件共用一个临时根：`~/.dsc` 一次都不碰。 */
const sharedRoot = mkdtempSync(join(tmpdir(), 'superagent-effects-'))
// 有些模块在 import 时会读环境；先指到临时目录，再加载被测代码。
process.env.DSC_HOME = sharedRoot

const { Effects, Later } = await import('../../../../lib/packages/superagent/app/effects.js')
const { Store } = await import('../../../../lib/packages/superagent/app/store.js')
const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  rmSync(sharedRoot, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})

// ══════════════════════════════════════════════════════════════════════════════
// 新段（W9 移植）：`app/effects.js`，对应上游 `tests/effects.spec.ts`（13 条用例）
//
// W9-3 删旧树时：删掉下面的旧段分隔注释及其之后的内容，只留本段。
// ══════════════════════════════════════════════════════════════════════════════

/** 上游 `fixtures/async.ts` 的 `deferred()`：外部可解的 Promise。 */
function deferred() {
  const { promise, resolve, reject } = Promise.withResolvers()
  return { promise, resolve, reject }
}

/** 记录调用参数的假处理器：`calls` 是每次调用收到的参数数组，行为由 `impl` 决定。 */
function recorder(impl = () => {}) {
  const calls = []
  const fn = (...args) => {
    calls.push(args)
    return impl(...args)
  }
  fn.calls = calls
  return fn
}

/** 轮询等条件成立；超过 3 秒算超时。用真定时器，不搬 vitest 的 `waitFor`。 */
async function waitFor(check, what) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 一条 relay 载荷。 */
const relay = (text) => ({ text })

/**
 * 一套：临时库 + 真健康板 + 可注入时钟；`start()` 按上游 `beforeEach` 调一次。
 *
 * @param label - 目录名后缀，失败时能看出是哪条用例
 * @param start - 初始假时钟（毫秒）
 */
function setupApp(label, start = Date.parse('2026-09-09T00:00:00Z')) {
  const dir = mkdtempSync(join(sharedRoot, `app-${label}-`))
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  const board = new HealthBoard()
  let clock = start
  const effects = new Effects(store, board, () => clock)
  effects.start()
  return {
    store,
    board,
    effects,
    /** 当前假时钟。 */
    get clock() { return clock },
    /** 拨动假时钟（毫秒）。 */
    advance(ms) { clock += ms },
    /** 关库并删目录。 */
    cleanup() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('事务里入队的副作用在提交后跑一次；回滚的事务一条也不跑', async () => {
  const h = setupApp('commit')
  try {
    const run = recorder(async () => {})
    h.effects.handle('relay', run)
    h.store.atomic(() => { h.effects.enqueue('relay', 'kept', relay('a')) })
    assert.throws(() => h.store.atomic(() => {
      h.effects.enqueue('relay', 'dropped', relay('b'))
      throw new Error('rolled back')
    }), /rolled back/)
    await h.effects.idle()
    assert.deepEqual(run.calls, [[{ text: 'a' }, 'kept']], '只跑提交了的那条，载荷与 key 原样交给处理器')
    assert.equal(h.effects.pending('relay'), false)
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('同一 kind+key 只留一份：跑最新载荷；运行中又来新载荷时跑完再跑一次', async () => {
  const h = setupApp('coalesce')
  try {
    const hold = deferred()
    const run = recorder(async (payload) => { if (payload.text === 'first') await hold.promise })
    h.effects.handle('relay', run)
    h.effects.enqueue('relay', 'k', relay('first'))
    await waitFor(() => run.calls.length === 1, '第一次开始跑')
    h.effects.enqueue('relay', 'k', relay('second'))
    h.effects.enqueue('relay', 'k', relay('third'))
    hold.resolve()
    await h.effects.idle()
    assert.deepEqual(run.calls.map(([payload]) => payload.text), ['first', 'third'], '第二份被第三份合并掉')
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('同一 kind 按 seq 先来先跑；limit 条并发；limit 为 0 时一条也不起', async () => {
  const h = setupApp('limit')
  try {
    const holds = new Map()
    let limit = 2
    const run = recorder(async (_payload, key) => {
      const hold = deferred()
      holds.set(key, hold)
      await hold.promise
    })
    h.effects.handle('launch', run, { limit: () => limit })
    for (const key of ['a', 'b', 'c']) h.effects.enqueue('launch', key, { ticketId: key, assignmentId: key })
    await waitFor(() => run.calls.length === 2, '前两条先跑')
    assert.deepEqual(run.calls.map(([, key]) => key), ['a', 'b'])
    limit = 0
    holds.get('a').resolve()
    await waitFor(() => !h.effects.pending('launch', 'a'), 'a 跑完')
    h.effects.kick()
    await Promise.resolve()
    assert.equal(run.calls.length, 2, 'limit 为 0 时跑完一条也不再补位')
    limit = 2
    holds.get('b').resolve()
    await waitFor(() => run.calls.length === 3, 'b 跑完后 c 补位')
    assert.deepEqual(run.calls.map(([, key]) => key), ['a', 'b', 'c'])
    holds.get('c').resolve()
    await h.effects.idle()
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('同一 key 带新载荷重入队时保留队列位置', async () => {
  const h = setupApp('reseq')
  try {
    const run = recorder(async () => {})
    let room = 0
    h.effects.handle('launch', run, { limit: () => room })
    h.store.atomic(() => {
      h.effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
      h.effects.enqueue('launch', 'second', { ticketId: 't2', assignmentId: 'a2' })
      h.effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
    })
    await h.effects.idle()
    room = 1
    await h.effects.idle()
    assert.deepEqual(run.calls.map(([, key]) => key), ['first', 'second'], '重入队不改 seq，first 仍在 second 前')
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('失败按指数退避重试、上限封顶；连续失败三次报错，成功一次后恢复', async () => {
  const h = setupApp('backoff')
  try {
    let fail = true
    const run = recorder(async () => { if (fail) throw new Error('session busy') })
    h.effects.handle('notice', run, { retry: [1000, 3000] })
    h.effects.enqueue('notice', 'prompts', { value: { prompt_config_saved: 2 }, summary: 'Prompt configuration saved' })
    await h.effects.idle()
    assert.deepEqual([h.board.all.notice?.state, h.board.all.notice?.detail],
      ['ready', '1 waiting since 2026-09-09T00:00:00.000Z'], '一次失败还没到三次，体检项就绪')
    for (const wait of [1000, 2000, 3000, 3000]) {
      h.advance(wait - 1)
      await h.effects.idle()
      const calls = run.calls.length
      h.advance(1)
      await h.effects.idle()
      assert.equal(run.calls.length, calls + 1, `等满 ${String(wait)}ms 才重跑`)
      if (wait === 2000) {
        assert.deepEqual([h.board.all.notice?.state, h.board.all.notice?.detail],
          ['error', '1 waiting since 2026-09-09T00:00:00.000Z; the last failure: Error: session busy'],
          '第三次失败起体检项报错')
      }
    }
    fail = false
    h.advance(3000)
    await h.effects.idle()
    assert.deepEqual([h.board.all.notice?.state, h.board.all.notice?.detail], ['ready', 'Nothing waiting'])
    assert.equal(h.effects.pending('notice'), false)
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('drain 后不再起新活：等着的与被打断的都留到下次 start 再跑', async () => {
  const h = setupApp('drain')
  try {
    const hold = deferred()
    h.effects.handle('relay', async () => { await hold.promise; throw new Error('aborted') })
    h.effects.enqueue('relay', 'cut', relay('a'))
    await waitFor(() => h.effects.pending('relay', 'cut'), 'cut 已被取走')
    await Promise.resolve()
    const drained = h.effects.drain()
    h.effects.enqueue('relay', 'later', relay('b'))
    hold.resolve()
    await drained
    const next = new Effects(h.store, new HealthBoard(), () => h.clock)
    next.start()
    const run = recorder(async () => {})
    next.handle('relay', run)
    await next.idle()
    assert.deepEqual(run.calls.map(([, key]) => key), ['cut', 'later'], '被打断的先跑，然后才是 drain 之后入队的')
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('Later 不算失败：只推后首次退避，不累加 attempts', async () => {
  const h = setupApp('later')
  try {
    let later = true
    const run = recorder(async () => { if (later) throw new Later('paused') })
    h.effects.handle('launch', run, { retry: [5000, 60000] })
    h.effects.enqueue('launch', 'a', { ticketId: 't', assignmentId: 'a' })
    await h.effects.idle()
    assert.deepEqual([h.board.all.launch?.state, h.board.all.launch?.detail],
      ['ready', '1 waiting since 2026-09-09T00:00:00.000Z'], 'Later 不算失败，体检仍是就绪')
    later = false
    h.advance(4999)
    await h.effects.idle()
    assert.equal(run.calls.length, 1, '首个退避没到，不重跑')
    h.advance(1)
    await h.effects.idle()
    assert.equal(run.calls.length, 2)
    assert.equal(h.effects.pending('launch'), false)
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('有序 kind 一次只跑队首；队首失败时后面的行不跑', async () => {
  const h = setupApp('ordered')
  try {
    const failing = new Set(['first'])
    const run = recorder(async (_payload, key) => { if (failing.has(key)) throw new Error('offline') })
    h.effects.handle('relay', run, { ordered: true, limit: () => 4, retry: [1000, 1000] })
    h.effects.enqueue('relay', 'first', relay('a'))
    h.effects.enqueue('relay', 'second', relay('b'))
    await h.effects.idle()
    h.advance(1000)
    await h.effects.idle()
    assert.deepEqual(run.calls.map(([, key]) => key), ['first', 'first'], '队首失败重试，第二条仍被压住')
    failing.clear()
    h.advance(1000)
    await h.effects.idle()
    assert.deepEqual(run.calls.map(([, key]) => key), ['first', 'first', 'first', 'second'], '队首成功后第二条才跑')
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('quiet kind 的失败不写进体检；没有到期行时不问 limit', async () => {
  const h = setupApp('quiet')
  try {
    const limit = recorder(() => 4)
    h.effects.handle('delivery', async () => { throw new Error('Session gone') }, { quiet: true, limit, retry: [1000, 1000] })
    h.effects.kick()
    await h.effects.idle()
    assert.equal(limit.calls.length, 0, '一条到期行都没有时不该问 limit')
    h.effects.enqueue('delivery', 't', { ticketId: 't' })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await h.effects.idle()
      h.advance(1000)
    }
    assert.deepEqual([h.board.all.delivery?.state, h.board.all.delivery?.detail],
      ['ready', '1 waiting since 2026-09-09T00:00:00.000Z'], 'quiet 时连错四次也报就绪')
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('运行中被 cancel 并重新入队：第一次跑完不会删掉新行，新行随后再跑一次', async () => {
  const h = setupApp('cancel')
  try {
    const hold = deferred()
    const run = recorder(async (_payload, _key) => { if (run.calls.length === 1) await hold.promise })
    h.effects.handle('relay', run)
    h.effects.enqueue('relay', 'k', relay('first'))
    await waitFor(() => run.calls.length === 1, '第一次开始跑')
    h.effects.cancel('relay', 'k')
    h.effects.enqueue('relay', 'k', relay('second'))
    hold.resolve()
    await h.effects.idle()
    assert.deepEqual(run.calls.map(([payload]) => payload.text), ['first', 'second'])
    assert.equal(h.effects.pending('relay'), false)
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('重启后新入队的行排在等待行之后（seq 跨实例续号）', async () => {
  const h = setupApp('restart-order')
  try {
    const hold = deferred()
    h.effects.handle('relay', async () => { await hold.promise; throw new Error('aborted') }, { ordered: true })
    h.effects.enqueue('relay', 'first', relay('a'))
    h.effects.enqueue('relay', 'second', relay('b'))
    await waitFor(() => h.effects.pending('relay', 'first'), 'first 已被取走')
    await Promise.resolve()
    const drained = h.effects.drain()
    hold.resolve()
    await drained
    const next = new Effects(h.store, new HealthBoard(), () => h.clock)
    next.enqueue('relay', 'third', relay('c'))
    next.start()
    const run = recorder(async () => {})
    next.handle('relay', run, { ordered: true })
    await next.idle()
    assert.deepEqual(run.calls.map(([, key]) => key), ['first', 'second', 'third'], '新行接在等待行后面')
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('队列自身失败（limit 抛错）记到该 kind 的体检项，下一次成功派发后清除', async () => {
  const h = setupApp('broken')
  try {
    let broken = true
    const run = recorder(async () => {})
    h.effects.handle('relay', run, {
      limit: () => {
        if (broken) throw new Error('database is locked')
        return 1
      },
    })
    h.effects.enqueue('relay', 'k', relay('a'))
    await h.effects.idle()
    assert.deepEqual([h.board.all.relay?.state, h.board.all.relay?.detail],
      ['error', 'The effect queue failed: Error: database is locked'])
    broken = false
    h.effects.kick()
    await h.effects.idle()
    assert.deepEqual([h.board.all.relay?.state, h.board.all.relay?.detail], ['ready', 'Nothing waiting'])
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('同一个 kind 第二次 handle 直接抛错', () => {
  const h = setupApp('duplicate')
  try {
    h.effects.handle('relay', async () => {})
    assert.throws(() => h.effects.handle('relay', async () => {}), /The relay effects already have a handler/)
    passed += 1
  } finally {
    h.cleanup()
  }
})
