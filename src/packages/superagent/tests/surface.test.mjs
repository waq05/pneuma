/**
 * 第 7 步前半的包级测试：界面面（快照）与服务转发。
 *
 * 九条用例各钉一件「界面点了没反应」的事：
 *   1. 面形状齐：ready / counts / tickets / recent 四样都在；
 *   2. 工单增减时 counts 跟着变（发布 → running；停止 → done）；
 *   3. peekSession 真读得到刚写进去的 jsonl（只读重放，不改文件）；
 *   4. 停 / 重试 / 清理 / 发布四个动作转发到运行期的对应方法；
 *   5. 运行期没起来时 `ready:false` 且带 `problem`（界面据此说清卡在哪）；
 *   6. 一张工单多个执行会话（重试过）时条目 id 顺延，不会撞 key；
 *   7-9. 来源清单（U5）在「没起来 / 正常 / 有错误」三种情形下的形状。
 *
 * 全程用 `tmpdir()` 下的临时 `DSC_HOME`，绝不碰用户真实的 `~/.dsc`。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { SuperagentRuntime } = await import('../../../../lib/packages/superagent/runtime.js')
const { SuperagentService } = await import('../../../../lib/packages/superagent/service.js')
const { sessionsDir } = await import('../../../../lib/packages/superagent/paths.js')
// 来源清单的纯函数在入口文件里：`apply` 的闭包拿不到真来源（要令牌 / 要 CLI），
// 「读到的状态 → 契约形状」这一段才是包级测试能验的部分（接线由 index.ts 那一行保证）。
const { buildSourceViews } = await import('../../../../lib/packages/superagent/index.js')

/** 固定时钟：断言不依赖「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

/** 一张合法工单 id（32 位十六进制；`paths.ts` 的目录名校验认这个形状）。 */
const TICKET_ID = 'abcdef0123456789abcdef0123456789'

const roots = []

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 一个用例一个临时根目录。 */
function tempRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `superagent-surface-${label}-`))
  roots.push(dir)
  return dir
}

/**
 * 在临时目录里装一套运行期 + 服务，跑完 `work` 后按「运行期 → 库 → 环境变量」收尾。
 * @param work - 拿到 runtime / service / root
 */
async function withRuntime(label, work) {
  const root = tempRoot(label)
  const previous = process.env.DSC_HOME
  process.env.DSC_HOME = root
  const store = openStore()
  const runtime = new SuperagentRuntime(store, { now: () => AT, log: () => {} })
  let changed = 0
  const service = new SuperagentService({
    current: () => runtime,
    ensure: () => runtime,
    problem: () => null,
    changed: () => { changed += 1 },
  })
  try {
    return await work({ runtime, service, root, changes: () => changed })
  } finally {
    runtime.close()
    store.close()
    if (previous === undefined) delete process.env.DSC_HOME
    else process.env.DSC_HOME = previous
  }
}

// G1：候选收件箱在快照面里那一格。
// 钉三件事：没开「先等我确认」时整格缺席（不是空数组）；开了之后写进去的候选能读出来；
// 定过结论的不再列出来。两种「空」在界面上是两件事，所以这里分两次断言。
test('快照面：候选收件箱那一格随开关出现，定过结论的不再列', async () => {
  const root = tempRoot('candidates')
  const previous = process.env.DSC_HOME
  process.env.DSC_HOME = root
  const store = openStore()
  const { buildSurface } = await import('../../../../lib/packages/superagent/surface.js')
  try {
    const off = new SuperagentRuntime(store, { now: () => AT, log: () => {} })
    assert.equal(buildSurface(off).candidates, undefined, '没开时整格缺席，不是空数组')
    off.close()

    store.saveCandidate('eval-1', 'trg-1', 'manual:trg-1', {
      outcome: { kind: 'accept', title: '改文案', scope: 'docs/', reason: '命中规则' },
      title: '改文案',
      reason: '命中规则',
      scope: 'docs/',
      source: 'manual',
    })
    const on = new SuperagentRuntime(store, { now: () => AT, log: () => {}, confirmInferred: true })
    const surface = buildSurface(on)
    assert.equal(surface.candidates.length, 1, '开着的 runtime 要带这一格')
    assert.equal(surface.candidates[0].id, 'eval-1')
    assert.equal(surface.candidates[0].title, '改文案')
    assert.equal(surface.candidates[0].source, 'manual')

    store.settleCandidate('eval-1', 'ignored')
    assert.deepEqual(buildSurface(on).candidates, [], '定过结论的不再列出来，但那一格还在')
    on.close()
  } finally {
    store.close()
    if (previous === undefined) delete process.env.DSC_HOME
    else process.env.DSC_HOME = previous
  }
})

/** 一台只记调用的假运行期：转发用例只要「调到了哪个方法、给了什么」。 */
function fakeRuntime() {  const calls = []
  const runtime = {
    publish(input) {
      calls.push(['publish', input])
      return TICKET_ID
    },
    list() {
      return [{ id: TICKET_ID, title: '假工单', stage: { stage: 'working', action: 'queued' }, createdAt: AT }]
    },
    stop(id) {
      calls.push(['stop', id])
    },
    retry(id) {
      calls.push(['retry', id])
    },
    clean(id) {
      calls.push(['clean', id])
    },
    pump() {},
    recent() {
      return []
    },
  }
  return { runtime, calls }
}

/**
 * 手写一个执行会话 jsonl：meta 首行 + 一条用户消息（与 `Session` 落盘的形状一致）。
 *
 * 为什么不直接用 `Session.create`：它用写流异步落盘，`close()` 只是 `stream.end()`，
 * 紧跟着读会偶发 ENOENT。peek 只认日志的形状，手写更确定。
 */
function writeSession(file, cwd, text) {
  mkdirSync(dirname(file), { recursive: true })
  const meta = { type: 'meta', id: randomUUID(), cwd, createdAt: Date.now() }
  const user = { type: 'user', text, ts: Date.now() }
  writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify(user)}\n`)
}

test('面形状：ready / counts / tickets / recent 四样都在', async () => {
  await withRuntime('shape', ({ runtime, service }) => {
    const id = runtime.publish({ title: '改登录页文案', body: '把错误提示改成中文' })
    const surface = service.surface()
    assert.equal(surface.ready, true)
    assert.equal(surface.problem, undefined)
    assert.equal(typeof surface.counts.needsYou, 'number')
    assert.equal(typeof surface.counts.running, 'number')
    assert.equal(typeof surface.counts.done, 'number')
    assert.equal(surface.tickets.length, 1)
    assert.equal(surface.tickets[0].id, id)
    assert.equal(surface.tickets[0].title, '改登录页文案')
    assert.equal(surface.tickets[0].at, AT, '建单时刻要带出来（命令层叫 createdAt，契约叫 at）')
    assert.deepEqual(surface.tickets[0].stage, { stage: 'working', action: 'queued' })
    assert.ok(Array.isArray(surface.recent), 'recent 必须是数组（没有动态就是空数组）')
    // 三组计数之和必须等于工单总数：界面分组头不许「加起来对不上」。
    assert.equal(surface.counts.needsYou + surface.counts.running + surface.counts.done, surface.tickets.length)
  })
})

test('来源：两个来源都没起来时也列出来，enabled 照设置开关，不带状态字段', () => {
  const sources = buildSourceViews({
    github: { enabled: false, status: null },
    feishu: { enabled: true, status: null },
  })
  // 顺序固定：界面按这个顺序画，不在前端自己排。
  assert.deepEqual(sources.map((source) => source.id), ['github', 'feishu'])
  // 关着的来源也要在清单里：否则用户分不清「没配这个来源」与「配了但坏了」。
  assert.deepEqual(sources[0], { id: 'github', enabled: false })
  // 开了但还没起来（缺令牌 / 缺 CLI / 缺群）同样是 enabled: true，状态为空。
  assert.deepEqual(sources[1], { id: 'feishu', enabled: true })
  for (const source of sources) {
    assert.ok(!('lastPollAt' in source), '来源没起来（status 为 null）时不该有 lastPollAt')
    assert.ok(!('lastError' in source), '没失败过就不该有 lastError')
  }
})

test('来源：起来了且上一拍成功时带 lastPollAt，不带 lastError', () => {
  const sources = buildSourceViews({
    github: { enabled: true, status: { lastPollAt: AT, lastError: null } },
    feishu: { enabled: true, status: { lastPollAt: AT, lastError: null } },
  })
  for (const source of sources) {
    assert.equal(source.enabled, true)
    assert.equal(source.lastPollAt, AT, '上次轮询时刻要原样带出来（界面据此算「几分钟前」）')
    assert.ok(!('lastError' in source), '成功之后错误要清掉，不能留一个 null 或空串')
  }
})

test('来源：有错误时原样带 lastError，已有的 lastPollAt 一并保留', () => {
  const sources = buildSourceViews({
    github: { enabled: true, status: { lastPollAt: AT, lastError: '401 Unauthorized: Bad credentials' } },
    // 只有错误、没有轮询时刻：契约用「没有这一项」表达 null（界面画「从未成功 · 错误」）。
    feishu: { enabled: true, status: { lastPollAt: null, lastError: 'lark-cli exited with code 1' } },
  })
  assert.deepEqual(sources[0], {
    id: 'github',
    enabled: true,
    lastPollAt: AT,
    lastError: '401 Unauthorized: Bad credentials',
  })
  assert.deepEqual(sources[1], { id: 'feishu', enabled: true, lastError: 'lark-cli exited with code 1' })
})

test('工单数变化时 counts 跟着变：发布算进行中，停止后算已完成', async () => {
  await withRuntime('counts', async ({ runtime, service }) => {
    const id = runtime.publish({ title: '要停的工单', body: '正文' })
    assert.deepEqual(service.surface().counts, { needsYou: 0, running: 1, done: 0 })

    await service.stop(id)
    const after = service.surface()
    assert.deepEqual(after.counts, { needsYou: 0, running: 0, done: 1 })
    assert.deepEqual(after.tickets[0].stage, { stage: 'ended' })
  })
})

test('peekSession 读得到刚写进去的执行会话 jsonl（只读）', async () => {
  const root = tempRoot('peek')
  const previous = process.env.DSC_HOME
  process.env.DSC_HOME = root
  try {
    const file = join(sessionsDir(TICKET_ID), '11111111-1111-4111-8111-111111111111.jsonl')
    writeSession(file, root, '把登录页的错误提示改成中文')
    const before = readFileSync(file, 'utf8')

    // peekSession 不需要运行期：文件在就能看（库还没开也一样）。
    const service = new SuperagentService({
      current: () => null,
      ensure: () => null,
      problem: () => null,
      changed: () => {},
    })
    const entries = await service.peekSession(TICKET_ID)
    const user = entries.find((entry) => entry.kind === 'user')
    assert.ok(user !== undefined, `转录里应有那条用户消息，实际：${entries.map((e) => e.kind).join(',')}`)
    assert.match(user.text, /错误提示改成中文/)
    assert.equal(readFileSync(file, 'utf8'), before, '读转录不能改动 jsonl')
  } finally {
    if (previous === undefined) delete process.env.DSC_HOME
    else process.env.DSC_HOME = previous
  }
})

test('停 / 重试 / 清理 / 发布转发到运行期的对应方法', async () => {
  const { runtime, calls } = fakeRuntime()
  let changed = 0
  const service = new SuperagentService({
    current: () => runtime,
    ensure: () => runtime,
    problem: () => null,
    changed: () => { changed += 1 },
  })

  const id = await service.publish({ title: '转发', body: '正文' })
  assert.equal(id, TICKET_ID)
  await service.stop(TICKET_ID)
  await service.retry(TICKET_ID)
  await service.clean(TICKET_ID)

  assert.deepEqual(calls, [
    ['publish', { title: '转发', body: '正文' }],
    ['stop', TICKET_ID],
    ['retry', TICKET_ID],
    ['clean', TICKET_ID],
  ])
  assert.equal(changed, 4, '四个写动作各通知一次快照失效（发布 / 停 / 重试 / 清理）')
})

test('运行期没起来时 ready:false 且带 problem', () => {
  const service = new SuperagentService({
    current: () => null,
    ensure: () => null,
    problem: () => ({ code: 'store_unavailable', detail: '编排库没打开：拿不到单实例锁' }),
    changed: () => {},
  })
  const surface = service.surface()
  assert.equal(surface.ready, false)
  assert.equal(surface.problem?.code, 'store_unavailable')
  assert.match(surface.problem?.detail ?? '', /单实例锁/)
  assert.deepEqual(surface.counts, { needsYou: 0, running: 0, done: 0 })
  assert.deepEqual(surface.tickets, [])
  assert.deepEqual(surface.recent, [])
})

test('多个执行会话（重试过）时条目 id 顺延，不撞 key', async () => {
  const root = tempRoot('multi')
  const previous = process.env.DSC_HOME
  process.env.DSC_HOME = root
  try {
    const dir = sessionsDir(TICKET_ID)
    const files = ['11111111-1111-4111-8111-111111111111.jsonl', '22222222-2222-4222-8222-222222222222.jsonl']
    for (const name of files) writeSession(join(dir, name), root, `第 ${name.slice(0, 1)} 次的执行`)
    const service = new SuperagentService({
      current: () => null,
      ensure: () => null,
      problem: () => null,
      changed: () => {},
    })
    const entries = await service.peekSession(TICKET_ID)
    const ids = entries.map((entry) => entry.id)
    assert.equal(new Set(ids).size, ids.length, `条目 id 不能重复：${ids.join(',')}`)
    assert.ok(entries.some((entry) => entry.kind === 'user' && /第 1 次/.test(entry.text)))
    assert.ok(entries.some((entry) => entry.kind === 'user' && /第 2 次/.test(entry.text)))
  } finally {
    if (previous === undefined) delete process.env.DSC_HOME
    else process.env.DSC_HOME = previous
  }
})
