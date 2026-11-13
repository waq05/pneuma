/**
 * @pneuma/superagent 的 effect 队列包级测试：持久化、合并、退避、Later、limit、崩溃恢复、有序。
 *
 * 七条用例各钉一条「改错了不会当场报错、只会在崩溃或重试时丢活」的语义：
 *   1. 入队后 `pending` 为真，跑完删行；
 *   2. 同一 kind+key 重复入队：generation 递增、attempts 归零、跑的是最后一份载荷；
 *   3. 处理器抛错：行保留、attempts+1、due 往后推，到点再跑；
 *   4. `Later`：行保留但 attempts 不动（「现在没空位」不是这行的错）；
 *   5. `limit() === 0` 时不跑，放开后跑；
 *   6. 崩溃恢复：入队后不 dispatch 就关库，同一个库文件新开一个队列能把行取出来执行；
 *   7. 有序 kind：队首没跑完时后面的不跑。
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

const { EffectQueue, Later } = await import('../../../../lib/packages/superagent/adapters/effects.js')
const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  rmSync(sharedRoot, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})

/**
 * 一个用例一套：临时目录 + 真库 + 队列。
 *
 * @param label - 目录名后缀，失败时能看出是哪条用例
 * @param now - 可选假时钟；退避类用例靠它瞬移
 */
function setup(label, now) {
  const dir = mkdtempSync(join(sharedRoot, `${label}-`))
  const dbPath = join(dir, 'orchestrator.sqlite')
  const store = openStore(dbPath)
  const queue = now === undefined ? new EffectQueue(store) : new EffectQueue(store, undefined, now)
  return {
    dir,
    store,
    queue,
    /** 读这一行现在长什么样；断言直接看库，不看队列的内存状态。 */
    row(kind, key) {
      return store.handle
        .prepare('SELECT key, value, seq, generation, attempts, error, due FROM effect WHERE kind = ? AND key = ?')
        .get(kind, key)
    },
    cleanup() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('enqueue 后 pending 为真；dispatch 跑掉后为假', async () => {
  const s = setup('run')
  try {
    const seen = []
    s.queue.handle('launch', async (payload) => { seen.push(payload) })
    s.queue.start()

    assert.equal(s.queue.pending('launch'), false, '空队列里不该有等待行')
    s.queue.enqueue('launch', 'a1', { ticketId: 't1', assignmentId: 'a1' })
    assert.equal(s.queue.pending('launch'), true, '入队后应有一行在等')
    assert.equal(s.queue.pending('launch', 'a1'), true, '按 key 查也应命中')

    await s.queue.idle('launch')
    assert.deepEqual(seen, [{ ticketId: 't1', assignmentId: 'a1' }], '载荷应原样交给处理器')
    assert.equal(s.queue.pending('launch', 'a1'), false, '成功之后行必须删掉')
    passed += 1
  } finally {
    s.cleanup()
  }
})

test('同一 kind+key 重复入队：generation 递增、attempts 归零、跑最后一份载荷', async () => {
  const s = setup('merge')
  try {
    const calls = []
    // 第一次故意失败，把 attempts 顶到 1；第二次成功，验证「重入队把失败计数清掉」。
    s.queue.handle('launch', async (payload) => {
      calls.push(payload)
      if (calls.length === 1) throw new Error('第一份故意失败')
    })
    s.queue.start()
    s.queue.enqueue('launch', 'a1', { ticketId: 't1', assignmentId: 'a1' })
    await s.queue.idle('launch')

    const failed = s.row('launch', 'a1')
    assert.equal(failed?.attempts, 1, '第一次失败应留下 attempts = 1')
    assert.equal(failed?.generation, 0, '第一次入队 generation 是 0')

    // 同一 key 再说一遍：载荷换新、generation+1、attempts 清零、due 拉回现在。
    s.queue.enqueue('launch', 'a1', { ticketId: 't2', assignmentId: 'a1' })
    const merged = s.row('launch', 'a1')
    assert.equal(merged?.generation, 1, '重复入队应把 generation 加一')
    assert.equal(merged?.attempts, 0, '重复入队应把 attempts 清零')
    assert.match(String(merged?.value), /t2/, 'value 应换成最后一份载荷')

    await s.queue.idle('launch')
    assert.equal(calls.length, 2, '应有两次执行')
    assert.deepEqual(calls[1], { ticketId: 't2', assignmentId: 'a1' }, '跑的是最后一份载荷')
    assert.equal(s.queue.pending('launch', 'a1'), false, '第二次成功后应删行')
    passed += 1
  } finally {
    s.cleanup()
  }
})

test('处理器抛错：行保留、attempts+1、due 往后推，到点后重跑', async () => {
  let clock = 1_000_000
  const s = setup('retry', () => clock)
  try {
    let runs = 0
    s.queue.handle('launch', async () => {
      runs += 1
      throw new Error('这次失败')
    }, { retry: [100, 1000] })
    s.queue.start()
    s.queue.enqueue('launch', 'a1', { ticketId: 't1', assignmentId: 'a1' })
    await s.queue.idle('launch')

    const first = s.row('launch', 'a1')
    assert.equal(runs, 1)
    assert.equal(first?.attempts, 1, '失败一次 attempts 应为 1')
    assert.match(String(first?.error ?? ''), /这次失败/, '错误原文应写进行里')
    assert.equal(first?.due, clock + 100, '首次退避 = retry[0]（此时 attempts 还是 0）')

    // 没到点：dispatch 取不到它，再跑一次也不会执行。
    s.queue.dispatch()
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(runs, 1, '未到期的行不该被取走')

    // 到点：再跑一次，attempts 累加、退避翻倍（100 × 2^1 = 200）。
    clock += 100
    await s.queue.idle('launch')
    const second = s.row('launch', 'a1')
    assert.equal(runs, 2, '到点后应重跑')
    assert.equal(second?.attempts, 2, 'attempts 应累加')
    assert.equal(second?.due, clock + 200, '第二次退避 = 首次 × 2^attempts')
    passed += 1
  } finally {
    s.cleanup()
  }
})

test('Later：行保留但 attempts 不变，只把 due 推后 retry[0]', async () => {
  let clock = 2_000_000
  const s = setup('later', () => clock)
  try {
    s.queue.handle('launch', async () => {
      throw new Later('现在没有空位')
    }, { retry: [500, 5000] })
    s.queue.start()
    s.queue.enqueue('launch', 'a1', { ticketId: 't1', assignmentId: 'a1' })
    await s.queue.idle('launch')

    const row = s.row('launch', 'a1')
    assert.ok(row !== undefined, 'Later 之后行必须还在')
    assert.equal(row?.attempts, 0, 'Later 不算失败，attempts 不该加')
    assert.equal(row?.due, clock + 500, 'due 只推后 retry[0]')
    passed += 1
  } finally {
    s.cleanup()
  }
})

test('limit 为 0 时不跑；放开后跑', async () => {
  const s = setup('limit')
  try {
    let room = 0
    let runs = 0
    s.queue.handle('launch', async () => { runs += 1 }, { limit: () => room })
    s.queue.start()
    s.queue.enqueue('launch', 'a1', { ticketId: 't1', assignmentId: 'a1' })
    await s.queue.idle('launch')

    assert.equal(runs, 0, 'limit 0 时一个都不该跑')
    assert.equal(s.queue.pending('launch', 'a1'), true, '行应原样等着')

    room = 1
    await s.queue.idle('launch')
    assert.equal(runs, 1, '放开名额后应跑掉')
    assert.equal(s.queue.pending('launch', 'a1'), false)
    passed += 1
  } finally {
    s.cleanup()
  }
})

test('崩溃恢复：入队后不 dispatch，换一个队列实例接同一个库仍能取到并执行', async () => {
  const dir = mkdtempSync(join(sharedRoot, 'crash-'))
  const dbPath = join(dir, 'orchestrator.sqlite')
  try {
    // 第一段：只入队、不 start（进程在这里「崩掉」）。
    const first = openStore(dbPath)
    const crashed = new EffectQueue(first)
    crashed.handle('launch', async () => { throw new Error('崩溃前不该跑到这一步') })
    crashed.enqueue('launch', 'a1', { ticketId: 't1', assignmentId: 'a1' })
    assert.equal(crashed.pending('launch', 'a1'), true, '行应已落库')
    first.close()

    // 第二段：同一个库文件、新队列实例、新构造的 seq。
    const second = openStore(dbPath)
    try {
      const recovered = new EffectQueue(second)
      const seen = []
      recovered.handle('launch', async (payload) => { seen.push(payload) })
      // seq 应从库里的最大值接着数：新行排在旧行之后，不会插到它前面。
      recovered.enqueue('launch', 'a2', { ticketId: 't2', assignmentId: 'a2' })
      const rows = second.handle
        .prepare('SELECT key, seq FROM effect WHERE kind = ? ORDER BY seq')
        .all('launch')
      assert.deepEqual(rows.map((row) => row.key), ['a1', 'a2'], 'a1 应排在 a2 前面')
      assert.equal(Number(rows[1]?.seq), 2, '新实例的 seq 应从 MAX(seq) 接着数')

      recovered.start()
      await recovered.idle('launch')
      assert.deepEqual(seen.map((item) => item.ticketId), ['t1', 't2'], '崩溃前入队的行应被取到并执行')
      assert.equal(recovered.pending('launch'), false, '两行都应删掉')
    } finally {
      second.close()
    }
    passed += 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('有序 kind：队首没跑完时后面的不跑', async () => {
  const s = setup('ordered')
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const started = []
    s.queue.handle('launch', async (_payload, key) => {
      started.push(key)
      if (key === 'first') await gate
    }, { ordered: true, limit: () => 4 })
    s.queue.start()
    s.queue.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'first' })
    s.queue.enqueue('launch', 'second', { ticketId: 't2', assignmentId: 'second' })

    // 等几轮事件循环，确认队列真的派过工、且只派了队首。
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(started, ['first'], '队首没跑完，第二行不该开始')

    release()
    await s.queue.idle('launch')
    assert.deepEqual(started, ['first', 'second'], '队首跑完后第二行才该开始')
    passed += 1
  } finally {
    s.cleanup()
  }
})
