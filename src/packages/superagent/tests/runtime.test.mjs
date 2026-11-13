/**
 * @pneuma/superagent 第 4 步的包级测试：手动来源 + 调度器 + 命令解析。
 *
 * 五条用例对应验收清单，每条只钉一件会「悄悄坏掉」的事：
 *   1. `/sa new` 之后真有一张工单，状态是「待派工」；
 *   2. 同一句话发两次得两张（P0 不去重，靠 Trigger id 里掺随机量）；
 *   3. 2 秒泵幂等（连着两拍不报错、不重复建单）；
 *   4. 领域事件真的落进了 `event` 表（不是只打了日志）；
 *   5. 参数错误给出可操作的文案，且「缺正文用标题」这条规则成立。
 *
 * 全程用 `tmpdir()` 下的临时目录，每个用例一个：绝不碰用户真实的 `~/.dsc`。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { StoreOutbox } = await import('../../../../lib/packages/superagent/adapters/outbox.js')
const { SuperagentRuntime } = await import('../../../../lib/packages/superagent/runtime.js')
const { parseSaCommand } = await import('../../../../lib/packages/superagent/commands.js')

/** 固定时钟：id 里已有随机量，时间固定只是为了让断言不依赖「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

const roots = []

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 一个用例一个临时根目录；返回库文件的绝对路径。 */
function tempRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `superagent-runtime-${label}-`))
  roots.push(dir)
  return dir
}

/** 库文件路径：`paths.ts` 的 `orchestratorDbPath()` = `<DSC_HOME>/superagent/orchestrator.sqlite`。 */
function dbPathOf(root) {
  return join(root, 'superagent', 'orchestrator.sqlite')
}

/** 只读地查一次库，用完即关；断言都在调用方写。 */
function readDb(root, work) {
  const db = new DatabaseSync(dbPathOf(root), { readOnly: true })
  try {
    return work(db)
  } finally {
    db.close()
  }
}

/**
 * 在临时目录里装一套运行期并跑完 `work`，结束时按「运行期 → 库 → 环境变量」的顺序收尾。
 *
 * 收尾顺序不能反：运行期只释放自己的队列，库归测试所有；先删目录会让连接悬空。
 * `DSC_HOME` 必须还原，否则同一个测试进程里后面的用例会写进上一个用例的目录。
 */
function withRuntime(label, work) {
  const root = tempRoot(label)
  const previous = process.env.DSC_HOME
  process.env.DSC_HOME = root
  const store = openStore()
  const runtime = new SuperagentRuntime(store, { now: () => AT, log: () => {} })
  try {
    return work({ runtime, store, root })
  } finally {
    runtime.close()
    store.close()
    if (previous === undefined) delete process.env.DSC_HOME
    else process.env.DSC_HOME = previous
  }
}

test('publish 建出工单，list 能看到，状态是待派工', () => {
  withRuntime('create', ({ runtime, root }) => {
    const id = runtime.publish({ title: '改登录页文案', body: '把错误提示改成中文' })
    assert.match(id, /^[0-9a-f]{32}$/, `publish 应返回工单 id，实际 ${id}`)

    const tickets = runtime.list()
    assert.equal(tickets.length, 1)
    assert.equal(tickets[0].id, id)
    assert.equal(tickets[0].title, '改登录页文案')
    // 占位执行器不启动会话，所以最新 Assignment 停在 pending——「待派工」那一档。
    assert.deepEqual(tickets[0].stage, { stage: 'working', action: 'queued' })

    const count = readDb(root, (db) => db.prepare('SELECT COUNT(*) AS n FROM ticket').get().n)
    assert.equal(count, 1, '库里 ticket 表应多一行')
  })
})

test('同一句话发两次得到两张工单（P0 不做去重）', () => {
  withRuntime('twice', ({ runtime }) => {
    const first = runtime.publish({ title: '同一句话', body: '同一句话' })
    const second = runtime.publish({ title: '同一句话', body: '同一句话' })
    assert.notEqual(first, second, '两次发布的工单 id 不能相同')
    assert.equal(runtime.list().length, 2)
  })
})

test('pump 幂等：连着调两次不报错、工单数不变', () => {
  withRuntime('pump', ({ runtime }) => {
    runtime.publish({ title: '只发一次', body: '正文' })
    const before = runtime.list().length
    assert.equal(before, 1)

    assert.doesNotThrow(() => {
      runtime.pump()
      runtime.pump()
    })
    assert.equal(runtime.list().length, before)
  })
})

test('emit 把领域事件写进 event 表', () => {
  withRuntime('events', ({ runtime, root }) => {
    const id = runtime.publish({ title: '要看事件', body: '正文' })
    const rows = readDb(root, (db) => db.prepare('SELECT kind FROM event WHERE ticket = ? ORDER BY seq').all(id))
    const kinds = rows.map((row) => row.kind)
    // ticket.created 是第一个带 ticketId 的领域事件（`core/tickets.ts:55`）。
    assert.ok(kinds.includes('ticket.created'), `event 表里应有 ticket.created，实际：${kinds.join(', ') || '空'}`)
    // kind 用的是领域事件类型字符串，不是 DecisionKind 之类的另一套枚举。
    assert.ok(kinds.every((kind) => typeof kind === 'string' && kind.includes('.')))
  })
})

test('命令解析：缺参数时报错文案可读，缺正文时正文取标题', () => {
  const usage = parseSaCommand([])
  assert.equal(usage.kind, 'error')
  assert.match(usage.message, /\/sa new/, '报错文案要直接告诉用户怎么写')

  const bare = parseSaCommand(['new'])
  assert.equal(bare.kind, 'error')
  assert.match(bare.message, /\/sa new/)

  // 分隔符两侧的空格可有可无；多个词的标题不该被拆散。
  assert.deepEqual(parseSaCommand(['new', '改 登录 页', '|', '把错误提示改成中文']), {
    kind: 'new',
    title: '改 登录 页',
    body: '把错误提示改成中文',
  })
  // 只给标题时，正文同标题。
  assert.deepEqual(parseSaCommand(['new', '只', '有', '标', '题']), {
    kind: 'new',
    title: '只 有 标 题',
    body: '只 有 标 题',
  })
  assert.deepEqual(parseSaCommand(['list']), { kind: 'list' })
})

test('outbox 入队幂等，撤回后状态是 dropped', () => {
  withRuntime('outbox', ({ store, root }) => {
    const outbox = new StoreOutbox(store)
    const message = { id: 'msg-1', channel: { source: 'manual', thread: 'manual:1', address: {} }, text: '好', kind: 'notice' }

    outbox.send(message)
    outbox.send(message)
    assert.equal(outbox.status('msg-1'), 'pending')
    assert.equal(readDb(root, (db) => db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n), 1, '同 id 第二次不该再入队')

    outbox.withdraw('msg-1')
    assert.equal(outbox.status('msg-1'), 'dropped')
    assert.equal(readDb(root, (db) => db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n), 0, '撤回应删掉未发送的行')
  })
})
