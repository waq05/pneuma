/**
 * @pneuma/superagent 第 8 步的包级测试：设置落盘、崩溃恢复、超时、保留策略。
 *
 * 六条用例各钉一件「能跑但长期用会出事」的事：
 *   1. 设置落盘往返：`save()` 真写 `plugins.json`，`values()` 与重开后的新分区读回同一份；
 *   2. 崩溃恢复：库里最新分配停在 `running`、进程里没有 worker → 标 `failed` 并发通知；
 *      已结束的工单一律不动；
 *   3. 崩溃恢复：`pending` 的工单重新入队派工（走执行器的 `start`，不自己建工作树）；
 *   4. 超时取消：建单超过上限的工单被停 worker、转 `failed`，已结束的不参与；
 *   5. 保留策略：只删已结束超过 30 天的会话目录，工作树不删；
 *   6. 保留策略：30 天内、正好 30 天、未结束的一律不删。
 *
 * 全程用 `tmpdir()` 下的临时目录，绝不碰用户真实的 `~/.dsc`。
 * `core/path-policy` 与 `core/plugin-registry` 的 DSC_HOME 是**模块加载那一刻**定死的，
 * 所以这里必须在 import `lib/` 之前先把它指到临时目录（同 `packages/log/tests/log.test.mjs`）。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/recovery
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// 配置要读 `plugins.json`：测试必须有自己的 DSC_HOME，否则会读走开发者真实的 ~/.dsc。
// 必须在 import lib/ 之前设好：core/path-policy 的 DSC_HOME 是模块加载那一刻定死的。
const home = mkdtempSync(join(tmpdir(), 'superagent-recovery-home-'))
process.env['DSC_HOME'] = home

const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { SuperagentRuntime } = await import('../../../../lib/packages/superagent/runtime.js')
const { sessionsDir } = await import('../../../../lib/packages/superagent/paths.js')
const { createSettingsSection } = await import('../../../../lib/packages/superagent/index.js')
const { resolvePluginConfig } = await import('../../../../lib/core/plugin-registry.js')

/** 临时目录清单：进程退出时兜底清一遍。 */
const roots = [home]
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 一个用例一个临时根目录（= 这个用例的 DSC_HOME）。 */
function tempRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `superagent-recovery-${label}-`))
  roots.push(dir)
  return dir
}

/**
 * 假执行器：只记调用，不起 worker、不建工作树。
 *
 * 恢复与超时的判据都落在「执行器被叫了什么」上，所以这一层用假的比起真 worker 更准。
 * 它**没有** `workingTicketIds()`：运行期把「查不到 worker 清单」按「一个 worker 都没有」
 * 处理，正好就是「上次宿主崩了、worker 全没了」的样子。
 */
function fakeExecutor() {
  const calls = { start: [], stop: [], deliver: [] }
  return {
    calls,
    executor: {
      start(ticket, assignment) {
        calls.start.push({ ticketId: ticket.id, assignmentId: assignment.id })
      },
      deliver(ticket, assignment) {
        calls.deliver.push({ ticketId: ticket.id, assignmentId: assignment.id })
      },
      stop(ticket, assignment, reason) {
        calls.stop.push({ ticketId: ticket.id, assignmentId: assignment.id, reason })
      },
    },
  }
}

/**
 * 在临时目录里装一套运行期并跑完 `work`，结束时按「运行期 → 库 → 环境变量」的顺序收尾。
 *
 * 收尾顺序不能反：运行期只释放自己的队列，库归测试所有；先删目录会让连接悬空。
 * `DSC_HOME` 必须还原，否则同一个测试进程里后面的用例会写进上一个用例的目录。
 */
function withRuntime(label, options, work) {
  const root = tempRoot(label)
  const previous = process.env['DSC_HOME']
  process.env['DSC_HOME'] = root
  const store = openStore()
  const runtime = new SuperagentRuntime(store, {
    log: () => {},
    worker: { repo: () => join(root, 'repo') },
    ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    ...(options.executor === undefined ? {} : { executor: options.executor }),
  })
  try {
    return work({ runtime, store, root })
  } finally {
    runtime.close()
    store.close()
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
  }
}

/** 直接改一行工单的 JSON：模拟「上次崩在中间」留下的状态，领域没有提供这种写入口。 */
function editTicket(store, id, mutate) {
  const row = store.handle.prepare('SELECT value FROM ticket WHERE id = ?').get(id)
  assert.ok(row !== undefined, `库里应有工单 ${id}`)
  const value = JSON.parse(row.value)
  mutate(value)
  store.handle.prepare('UPDATE ticket SET value = ? WHERE id = ?').run(JSON.stringify(value), id)
}

/** 读一行工单的 JSON（断言用）。 */
function readTicket(store, id) {
  return JSON.parse(store.handle.prepare('SELECT value FROM ticket WHERE id = ?').get(id).value)
}

/** 建一个会话目录，里面放一份像样的会话文件；返回目录路径。 */
function makeSessionDir(ticketId) {
  const dir = sessionsDir(ticketId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), '{"type":"meta"}\n', 'utf8')
  return dir
}

/** 一天有多少毫秒；保留策略的判据都用它算。 */
const DAY_MS = 24 * 60 * 60 * 1000

// ── 1. 设置落盘 ──────────────────────────────────────────────────────────────

test('设置落盘往返：save 写 plugins.json，values 与重开后的新分区读回同一份', () => {
  const section = createSettingsSection()
  // 缺省：空仓库、并发 2、超时 1800 秒。
  assert.equal(section.values().repoPath, '')
  assert.equal(section.values().maxWorkers, 2)
  assert.equal(section.values().ticketTimeoutSeconds, 1800)

  section.save('repoPath', '  D:\\work\\demo-repo  ')
  section.save('maxWorkers', 8)
  section.save('ticketTimeoutSeconds', 0)
  assert.equal(section.values().repoPath, 'D:\\work\\demo-repo', '仓库路径应去掉首尾空白')
  assert.equal(section.values().maxWorkers, 8)
  assert.equal(section.values().ticketTimeoutSeconds, 0, '0 表示不限，不能被夹成缺省')

  // 真落盘了：磁盘上那份 plugins.json 里能读到（不是只活在内存里）。
  const doc = JSON.parse(readFileSync(join(home, 'plugins.json'), 'utf8'))
  const entry = doc.entries.find((item) => item.file === 'superagent')
  assert.ok(entry !== undefined, 'plugins.json 里应有 superagent 这一条')
  assert.equal(entry.config.repoPath, 'D:\\work\\demo-repo')
  assert.equal(entry.config.maxWorkers, 8)
  assert.equal(entry.config.ticketTimeoutSeconds, 0)

  // 模拟重启：新建一个分区（等价于宿主重新 apply），三个值都从磁盘读回来。
  const reopened = createSettingsSection()
  assert.deepEqual(reopened.values(), section.values(), '重启后读回来的值应与保存前一致')
  assert.equal(resolvePluginConfig('superagent').maxWorkers, 8, '注册表合并出来的也应是磁盘值')

  // 数值夹回区间：并发 1–16，超时 0–86400。
  section.save('maxWorkers', 99)
  assert.equal(section.values().maxWorkers, 16)
  section.save('maxWorkers', 0)
  assert.equal(section.values().maxWorkers, 1)
  section.save('ticketTimeoutSeconds', -5)
  assert.equal(section.values().ticketTimeoutSeconds, 0)

  // 仓库路径清空 = 删掉这个键（回到缺省的空路径），不是写一个空串。
  section.save('repoPath', '   ')
  assert.equal(section.values().repoPath, '')
  assert.equal(resolvePluginConfig('superagent').repoPath, undefined)
})

// ── 2. 崩溃恢复：running 没有 worker ────────────────────────────────────────

test('running 却没有 worker：标 failed（原因写明宿主重启）并发一条通知；已结束的不动', () => {
  const { executor, calls } = fakeExecutor()
  withRuntime('orphan', { executor }, ({ runtime, store, root }) => {
    const id = runtime.publish({ title: '崩在中间的单', body: '正文' })
    const endedId = runtime.publish({ title: '已经结束的单', body: '正文' })
    // 模拟「上次跑到一半宿主没了」：库里最新分配停在 running，进程里没有 worker。
    editTicket(store, id, (ticket) => {
      ticket.assignments.at(-1).state = 'running'
    })
    // 已结束的工单即使分配停在 running，也不该被恢复逻辑碰。
    editTicket(store, endedId, (ticket) => {
      ticket.assignments.at(-1).state = 'running'
      ticket.ended = { at: ticket.createdAt, by: 'human', outcome: 'completed' }
    })
    calls.start.length = 0

    const report = runtime.recover()
    assert.deepEqual(report.failed, [id], '只有那张没结束的 running 工单该被标失败')
    assert.deepEqual(report.requeued, [])
    assert.equal(calls.start.length, 0, 'running 的工单不该被重新派工')

    // 工单进了「等人」的失败档，原因里必须同时有「宿主重启，worker 丢了」与重派办法。
    assert.deepEqual(runtime.list().find((item) => item.id === id).stage, { stage: 'person', action: 'failed' })
    const summary = readTicket(store, id).assignments.at(-1).report.summary
    assert.match(summary, /宿主重启，worker 丢了/)
    assert.match(summary, /\/sa retry/)

    // 一条通知进了出站队列；下一拍泵会把它取进「最近动态」。
    const rows = store.handle.prepare('SELECT value FROM outbox ORDER BY rowid').all()
    assert.equal(rows.length, 1, '应入队一条恢复通知')
    assert.match(JSON.parse(rows[0].value).payload.message.text, /宿主重启，worker 丢了/)

    // 已结束的工单原样：没有被改判、也没有多一份报告。
    assert.equal(readTicket(store, endedId).assignments.at(-1).report, undefined)

    // 幂等：再恢复一次不会重写报告，也不会再发一条通知。
    const again = runtime.recover()
    assert.deepEqual(again.failed, [], '已经标过 failed 的不该被反复改判')
    assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1)

    // 恢复不自己建工作树：建树只发生在执行器 launch 里（这里用的是假执行器，所以没有目录）。
    assert.equal(existsSync(join(root, 'superagent', 'worktrees')), false, '恢复逻辑不该绕过执行器去建树')
  })
})

// ── 3. 崩溃恢复：pending 重新入队 ───────────────────────────────────────────

test('pending 的工单：恢复时重新入队派工，不自己建工作树', () => {
  const { executor, calls } = fakeExecutor()
  withRuntime('requeue', { executor }, ({ runtime, store, root }) => {
    const id = runtime.publish({ title: '排队时崩了', body: '正文' })
    const assignmentId = readTicket(store, id).assignments.at(-1).id
    calls.start.length = 0

    const report = runtime.recover()
    assert.deepEqual(report.requeued, [id])
    assert.deepEqual(report.failed, [])
    assert.deepEqual(calls.start, [{ ticketId: id, assignmentId }], '应把同一对（工单 + 分配）重新交给执行器')

    // 恢复走的是执行器的 start，不是自己 `ensureWorktree`：假执行器不建树，这里就没有树。
    assert.equal(existsSync(join(root, 'superagent', 'worktrees')), false)

    // 幂等：再恢复一次仍然只是「再交给执行器一次」，执行器按 (工单, 分配) 去重（真执行器那侧）。
    const again = runtime.recover()
    assert.deepEqual(again.requeued, [id])
  })
})

// ── 4. 超时取消 ─────────────────────────────────────────────────────────────

test('超时：建单超过上限的 running 工单被停 worker、转 failed；排队中与已结束的不参与', () => {
  const { executor, calls } = fakeExecutor()
  withRuntime('timeout', { executor, timeoutSeconds: () => 60 }, ({ runtime, store }) => {
    const id = runtime.publish({ title: '跑太久的单', body: '正文' })
    const queuedId = runtime.publish({ title: '还在排队的单', body: '正文' })
    const endedId = runtime.publish({ title: '已经结束的单', body: '正文' })
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    editTicket(store, id, (ticket) => {
      ticket.createdAt = old
      ticket.assignments.at(-1).state = 'running'
    })
    // 排队中的工单：建得再久也不该被超时改判——它一次都没跑过，排队的那次派工稍后仍会启动。
    editTicket(store, queuedId, (ticket) => {
      ticket.createdAt = old
    })
    editTicket(store, endedId, (ticket) => {
      ticket.createdAt = old
      ticket.assignments.at(-1).state = 'running'
      ticket.ended = { at: old, by: 'human', outcome: 'completed' }
    })
    calls.stop.length = 0

    runtime.pump()

    assert.equal(calls.stop.length, 1, '只该停那一张正在跑的')
    assert.equal(calls.stop[0].ticketId, id)
    assert.match(calls.stop[0].reason, /超过 60 秒未完成，已取消/)

    const stored = readTicket(store, id)
    assert.equal(stored.assignments.at(-1).report.state, 'failed')
    assert.equal(stored.assignments.at(-1).report.summary, '超过 60 秒未完成，已取消')
    assert.deepEqual(runtime.list().find((item) => item.id === id).stage, { stage: 'person', action: 'failed' })

    // 排队中与已结束的：报告一个字段都没多。
    assert.equal(readTicket(store, queuedId).assignments.at(-1).report, undefined)
    assert.equal(readTicket(store, endedId).assignments.at(-1).report, undefined)

    // 超时是幂等的：下一拍不再重复停、也不再重写报告。
    const summary = stored.assignments.at(-1).report.summary
    calls.stop.length = 0
    runtime.pump()
    assert.equal(calls.stop.length, 0)
    assert.equal(readTicket(store, id).assignments.at(-1).report.summary, summary)
  })
})

// ── 5. 保留策略：删 30 天前的 ───────────────────────────────────────────────

test('sweep：只删已结束超过 30 天的会话目录，工作树不动', () => {
  withRuntime('sweep-old', {}, ({ runtime, store, root }) => {
    const id = runtime.publish({ title: '一个月前的单', body: '正文' })
    const dir = makeSessionDir(id)
    // 工作树根里放一个目录：它不是会话，保留策略不许碰。
    const worktree = join(root, 'superagent', 'worktrees', 'kept-tree')
    mkdirSync(worktree, { recursive: true })

    const endedAt = new Date(Date.now() - 31 * DAY_MS).toISOString()
    editTicket(store, id, (ticket) => {
      ticket.ended = { at: endedAt, by: 'human', outcome: 'completed' }
    })

    const report = runtime.sweep()
    assert.deepEqual(report.removed, [id])
    assert.equal(existsSync(dir), false, '31 天前结束的工单，会话目录应被删掉')
    assert.equal(existsSync(worktree), true, '工作树不归保留策略删（那是 /sa clean 的事）')

    // 幂等：再扫一次只是「本来就不在」。
    assert.deepEqual(runtime.sweep().removed, [])
    assert.deepEqual(runtime.sweep().missing, [id])
  })
})

// ── 6. 保留策略：30 天内的一律不动 ──────────────────────────────────────────

test('sweep：30 天内、正好 30 天、未结束的一律不删', () => {
  withRuntime('sweep-keep', {}, ({ runtime, store }) => {
    const recent = runtime.publish({ title: '29 天前结束', body: '正文' })
    const edge = runtime.publish({ title: '正好 30 天前结束', body: '正文' })
    const open = runtime.publish({ title: '还没结束', body: '正文' })
    const dirRecent = makeSessionDir(recent)
    const dirEdge = makeSessionDir(edge)
    const dirOpen = makeSessionDir(open)

    // 同一个基准时刻算两边的边界，避免「算完到扫描之间过了几毫秒」把正好 30 天的判成过期。
    const base = Date.now()
    editTicket(store, recent, (ticket) => {
      ticket.ended = { at: new Date(base - 29 * DAY_MS).toISOString(), by: 'human', outcome: 'completed' }
    })
    editTicket(store, edge, (ticket) => {
      ticket.ended = { at: new Date(base - 30 * DAY_MS).toISOString(), by: 'human', outcome: 'completed' }
    })

    const report = runtime.sweep(base)
    assert.deepEqual(report.removed, [], '30 天内的任何东西都不该被删')
    assert.equal(existsSync(dirRecent), true, '29 天前结束的会话目录应留着')
    assert.equal(existsSync(dirEdge), true, '正好 30 天的会话目录应留着（判据是「超过」30 天）')
    assert.equal(existsSync(dirOpen), true, '未结束的工单不在保留策略范围内')
  })
})
