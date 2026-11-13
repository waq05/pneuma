/**
 * @pneuma/superagent 第 8 步的包级测试：设置落盘、崩溃恢复、超时、保留策略。
 *
 * 六条用例各钉一件「能跑但长期用会出事」的事：
 *   1. 设置落盘往返：`save()` 真写 `plugins.json`，`values()` 与重开后的新分区读回同一份；
 *   2. 崩溃恢复：库里最新分配停在 `running`、进程里没有 worker → 起新分配接续、
 *      提示词写明上次中断、并发一条通知；已结束的工单一律不动；
 *   3. 崩溃恢复：`pending` 的工单重新入队派工（走执行器的 `start`，不自己建工作树）；
 *   4. 超时取消：建单超过上限的工单被停 worker、转 `failed`，已结束的不参与；
 *   5. 保留策略：只删已结束超过 30 天的会话目录，工作树不删；
 *   6. 保留策略：30 天内、正好 30 天、未结束的一律不删。
 *
 * 全程用 `tmpdir()` 下的临时目录，绝不碰用户真实的 `~/.dsc`。
 * `core/path-policy` 与 `core/plugin-registry` 的 DSC_HOME 是**模块加载那一刻**定死的，
 * 所以这里必须在 import 源码之前先把它指到临时目录。
 *
 * 迁移说明：原文件 import `lib/` 构建产物；现在直接 import 源码，不再要求先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/recovery
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { SettingsSectionSpec, SettingsValue, SettingsValues } from '@pneuma/runtime/services/types.js'
import type { Executor } from '../core/ports.js'
import type { DscStore } from '../adapters/store.js'
import type { SuperagentRuntime as RuntimeInstance } from '../runtime.js'

// 配置要读 `plugins.json`：测试必须有自己的 DSC_HOME，否则会读走开发者真实的 ~/.dsc。
// 必须在 import 源码之前设好：core/path-policy 的 DSC_HOME 是模块加载那一刻定死的。
const home = mkdtempSync(join(tmpdir(), 'superagent-recovery-home-'))
process.env['DSC_HOME'] = home

const { openStore } = await import('../adapters/store.js')
const { SuperagentRuntime } = await import('../runtime.js')
const { sessionsDir } = await import('../paths.js')
const { createSettingsSection } = await import('../index.js')
const { resolvePluginConfig } = await import('../../../core/plugin-registry.js')

/** 临时目录清单：进程退出时兜底清一遍。 */
const roots: string[] = [home]
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 一个用例一个临时根目录（= 这个用例的 DSC_HOME）。 */
function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `superagent-recovery-${label}-`))
  roots.push(dir)
  return dir
}

/** 一条工单 JSON 里本文件读到 / 改到的字段。 */
interface RawAssignment {
  id: string
  state: string
  endedAt?: string
  endedReason?: string
  report?: { state: string; summary: string; at?: string }
  deliveredAt?: string
}

/** 工单 JSON 的形状（`core/model.ts` 的 Ticket 序列化后）。 */
interface RawTicket {
  createdAt: string
  assignments: RawAssignment[]
  inputs: Array<{ id: string; kind?: string; text?: string; triggerId?: string; at?: string }>
  undelivered?: string[]
  ended?: { at: string; by: string; outcome: string }
}

/** 假执行器记下的调用。 */
interface ExecutorCalls {
  start: Array<{ ticketId: string; assignmentId: string }>
  stop: Array<{ ticketId: string; assignmentId: string; reason: string }>
  deliver: Array<{ ticketId: string; assignmentId: string }>
}

/**
 * 假执行器：只记调用，不起 worker、不建工作树。
 *
 * 恢复与超时的判据都落在「执行器被叫了什么」上，所以这一层用假的比起真 worker 更准。
 * 它**没有** `workingTicketIds()`：运行期把「查不到 worker 清单」按「一个 worker 都没有」
 * 处理，正好就是「上次宿主崩了、worker 全没了」的样子。
 */
function fakeExecutor(): { calls: ExecutorCalls; executor: Executor } {
  const calls: ExecutorCalls = { start: [], stop: [], deliver: [] }
  const executor = {
    start(ticket: { id: string }, assignment: { id: string }) {
      calls.start.push({ ticketId: ticket.id, assignmentId: assignment.id })
    },
    deliver(ticket: { id: string }, assignment: { id: string }) {
      calls.deliver.push({ ticketId: ticket.id, assignmentId: assignment.id })
    },
    stop(ticket: { id: string }, assignment: { id: string }, reason: string) {
      calls.stop.push({ ticketId: ticket.id, assignmentId: assignment.id, reason })
    },
  }
  return { calls, executor: executor as unknown as Executor }
}

/** 运行期选项里本文件用到的两档。 */
interface RuntimeFixtureOptions {
  executor?: Executor
  timeoutSeconds?: () => number
}

/**
 * 在临时目录里装一套运行期并跑完 `work`，结束时按「运行期 → 库 → 环境变量」的顺序收尾。
 *
 * 收尾顺序不能反：运行期只释放自己的队列，库归测试所有；先删目录会让连接悬空。
 * `DSC_HOME` 必须还原，否则同一个测试进程里后面的用例会写进上一个用例的目录。
 */
function withRuntime(
  label: string,
  options: RuntimeFixtureOptions,
  work: (context: { runtime: RuntimeInstance; store: DscStore; root: string }) => void,
): void {
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
    work({ runtime, store, root })
  } finally {
    runtime.close()
    store.close()
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
  }
}

/** 直接改一行工单的 JSON：模拟「上次崩在中间」留下的状态，领域没有提供这种写入口。 */
function editTicket(store: DscStore, id: string, mutate: (ticket: RawTicket) => void): void {
  const row = store.handle.prepare('SELECT value FROM ticket WHERE id = ?').get(id) as { value?: string } | undefined
  if (row?.value === undefined) throw new Error(`库里应有工单 ${id}`)
  const value = JSON.parse(row.value) as RawTicket
  mutate(value)
  store.handle.prepare('UPDATE ticket SET value = ? WHERE id = ?').run(JSON.stringify(value), id)
}

/** 读一行工单的 JSON（断言用）。 */
function readTicket(store: DscStore, id: string): RawTicket {
  const row = store.handle.prepare('SELECT value FROM ticket WHERE id = ?').get(id) as { value?: string } | undefined
  if (row?.value === undefined) throw new Error(`库里应有工单 ${id}`)
  return JSON.parse(row.value) as RawTicket
}

/** 建一个会话目录，里面放一份像样的会话文件；返回目录路径。 */
function makeSessionDir(ticketId: string): string {
  const dir = sessionsDir(ticketId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), '{"type":"meta"}\n', 'utf8')
  return dir
}

/** 一天有多少毫秒；保留策略的判据都用它算。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 本文件的 `createSettingsSection()` 实现是同步的（`index.ts` 的 `values`、`save`
 * 都直接返回值），而契约声明的是 `MaybePromise`、`save` 还是可选的。这里按实现收窄一次。
 */
type SyncSection = Omit<SettingsSectionSpec, 'values' | 'save'> & {
  values(): SettingsValues
  save(key: string, value: SettingsValue): string | void
}

/** 读 `plugins.json` 里 superagent 那条配置。 */
function storedConfig(): { repoPath?: string; maxWorkers?: number; ticketTimeoutSeconds?: number } {
  const doc = JSON.parse(readFileSync(join(home, 'plugins.json'), 'utf8')) as {
    entries: Array<{ file: string; config: { repoPath?: string; maxWorkers?: number; ticketTimeoutSeconds?: number } }>
  }
  const entry = doc.entries.find((item) => item.file === 'superagent')
  if (entry === undefined) throw new Error('plugins.json 里应有 superagent 这一条')
  return entry.config
}

// ── 1. 设置落盘 ──────────────────────────────────────────────────────────────

test('设置落盘往返：save 写 plugins.json，values 与重开后的新分区读回同一份', () => {
  const section = createSettingsSection() as SyncSection
  // 缺省：空仓库、并发 2、超时 1800 秒。
  expect(section.values().repoPath).toBe('')
  expect(section.values().maxWorkers).toBe(2)
  expect(section.values().ticketTimeoutSeconds).toBe(1800)

  section.save('repoPath', '  D:\\work\\demo-repo  ')
  section.save('maxWorkers', 8)
  section.save('ticketTimeoutSeconds', 0)
  expect(section.values().repoPath, '仓库路径应去掉首尾空白').toBe('D:\\work\\demo-repo')
  expect(section.values().maxWorkers).toBe(8)
  expect(section.values().ticketTimeoutSeconds, '0 表示不限，不能被夹成缺省').toBe(0)

  // 真落盘了：磁盘上那份 plugins.json 里能读到（不是只活在内存里）。
  const entry = storedConfig()
  expect(entry.repoPath).toBe('D:\\work\\demo-repo')
  expect(entry.maxWorkers).toBe(8)
  expect(entry.ticketTimeoutSeconds).toBe(0)

  // 模拟重启：新建一个分区（等价于宿主重新 apply），三个值都从磁盘读回来。
  const reopened = createSettingsSection() as SyncSection
  expect(reopened.values(), '重启后读回来的值应与保存前一致').toStrictEqual(section.values())
  const resolved = resolvePluginConfig('superagent') as { maxWorkers?: number; repoPath?: string }
  expect(resolved.maxWorkers, '注册表合并出来的也应是磁盘值').toBe(8)

  // 数值夹回区间：并发 1–16，超时 0–86400。
  section.save('maxWorkers', 99)
  expect(section.values().maxWorkers).toBe(16)
  section.save('maxWorkers', 0)
  expect(section.values().maxWorkers).toBe(1)
  section.save('ticketTimeoutSeconds', -5)
  expect(section.values().ticketTimeoutSeconds).toBe(0)

  // 仓库路径清空 = 删掉这个键（回到缺省的空路径），不是写一个空串。
  section.save('repoPath', '   ')
  expect(section.values().repoPath).toBe('')
  expect((resolvePluginConfig('superagent') as { repoPath?: string }).repoPath).toBeUndefined()
})

// ── 2. 崩溃恢复：running 没有 worker ────────────────────────────────────────

test('running 却没有 worker：起新分配接续，提示词写明上次中断；已结束的不动', () => {
  const { executor, calls } = fakeExecutor()
  withRuntime('orphan', { executor }, ({ runtime, store, root }) => {
    const id = runtime.publish({ title: '崩在中间的单', body: '正文' })
    const endedId = runtime.publish({ title: '已经结束的单', body: '正文' })
    // 模拟「上次跑到一半宿主没了」：库里最新分配停在 running，进程里没有 worker。
    editTicket(store, id, (ticket) => {
      ticket.assignments.at(-1)!.state = 'running'
    })
    // 已结束的工单即使分配停在 running，也不该被恢复逻辑碰。
    editTicket(store, endedId, (ticket) => {
      ticket.assignments.at(-1)!.state = 'running'
      ticket.ended = { at: ticket.createdAt, by: 'human', outcome: 'completed' }
    })
    const oldAssignmentId = readTicket(store, id).assignments.at(-1)!.id
    calls.start.length = 0

    const report = runtime.recover()
    expect(report.resumed, '只有那张没结束的 running 工单该被接续').toStrictEqual([id])
    expect(report.requeued).toStrictEqual([])

    const recovered = readTicket(store, id)
    const oldAssignment = recovered.assignments.at(-2)!
    const next = recovered.assignments.at(-1)!
    // 旧分配结束了（原因是宿主重启），新分配接着干。
    expect(oldAssignment.id).toBe(oldAssignmentId)
    expect(oldAssignment.state).toBe('ended')
    expect(typeof oldAssignment.endedAt, '旧分配要留下结束时刻').toBe('string')
    expect(next.state, '新分配等执行器派工').toBe('pending')
    expect(next.id).not.toBe(oldAssignmentId)

    // 第一条输入是恢复提示词：新 worker 的会话是空的，必须被告知「上次中断了、先看现场」。
    const note = recovered.inputs.find((input) => input.text?.includes('The host restarted during this ticket'))
    expect(note, '新分配要收到一条「上次中断了」的提示词').toBeDefined()
    expect(recovered.undelivered, '提示词还没投递，等执行器派工时一起发').toStrictEqual([note?.id])

    // 派工走执行器的 start：按 (工单, 新分配) 交给它，恢复自己不去建树。
    expect(calls.start).toStrictEqual([{ ticketId: id, assignmentId: next.id }])
    expect(existsSync(join(root, 'superagent', 'worktrees')), '恢复逻辑不该绕过执行器去建树').toBe(false)

    // 一张通知进了出站队列；下一拍泵会把它取进「最近动态」。
    const rows = store.handle.prepare('SELECT value FROM outbox ORDER BY rowid').all() as Array<{ value: string }>
    expect(rows.length, '应入队一条接续通知').toBe(1)
    expect(
      (JSON.parse(rows[0].value) as { payload: { message: { text: string } } }).payload.message.text,
    ).toMatch(/已自动接续/)

    // 已结束的工单原样：没有多一份报告、也没多一份分配。
    const ended = readTicket(store, endedId)
    expect(ended.assignments.length).toBe(1)
    expect(ended.assignments.at(-1)?.report).toBeUndefined()

    // 幂等：再恢复一次时最新分配已是新那份 pending，只会再交给执行器一次，不会再生一份分配。
    const again = runtime.recover()
    expect(again.resumed, '接续过的单不该被反复接续').toStrictEqual([])
    expect(again.requeued).toStrictEqual([id])
    expect(readTicket(store, id).assignments.length, '第二次恢复不该再起第三份分配').toBe(2)
    expect((store.handle.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(1)
  })
})

// ── 2b. 崩溃恢复：接续之后又崩一次 ──────────────────────────────────────────

test('接续之后又崩一次：再起第三份分配，两份旧分配都记为宿主重启', () => {
  const { executor, calls } = fakeExecutor()
  withRuntime('orphan-twice', { executor }, ({ runtime, store }) => {
    const id = runtime.publish({ title: '连崩两次的单', body: '正文' })
    // 第一次崩：最新分配停在 running。
    editTicket(store, id, (ticket) => {
      ticket.assignments.at(-1)!.state = 'running'
    })
    expect(runtime.recover().resumed).toStrictEqual([id])

    // 第二次崩：接续出来的那份分配也停在 running（它跑起来之后宿主又死了）。
    editTicket(store, id, (ticket) => {
      ticket.assignments.at(-1)!.state = 'running'
    })
    calls.start.length = 0
    expect(runtime.recover().resumed, '第二份分配也该被接续').toStrictEqual([id])

    const ticket = readTicket(store, id)
    expect(ticket.assignments.length, '两次崩溃两份新分配').toBe(3)
    expect(
      ticket.assignments.slice(0, 2).map((item) => item.endedReason),
      '两份被换掉的分配都写清是宿主重启',
    ).toStrictEqual(['hostRestarted', 'hostRestarted'])
    expect(ticket.assignments.at(-1)!.state).toBe('pending')
    expect((store.handle.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n, '每次崩溃各一条通知').toBe(2)
  })
})

// ── 2c. 崩溃恢复：报过 failed，但之后人又接了一句 ──────────────────────────

test('报过 failed 但之后人又接了一句：仍然接续，不留成没人推进的 working', () => {
  const { executor } = fakeExecutor()
  withRuntime('orphan-after-failed', { executor }, ({ runtime, store }) => {
    const id = runtime.publish({ title: '失败后又说了句', body: '正文' })
    // 现场：worker 报了一轮 failed，人回了一句话、那条消息已经投给 worker（deliveredAt 在
    // 报告之后），worker 正跑着——宿主就在这时崩了。
    // 这种单既不满足「等人」（人已经接过话），也不满足「可重试」（`canRetry` 只认等人），
    // 只有接续一条路；适配层若按「报过 failed 就跳过」处理，它会永远停在 working。
    editTicket(store, id, (ticket) => {
      const latest = ticket.assignments.at(-1)!
      latest.state = 'running'
      latest.report = { state: 'failed', summary: '第一轮失败', at: ticket.createdAt }
      const deliveredAt = new Date(Date.parse(ticket.createdAt) + 1_000).toISOString()
      latest.deliveredAt = deliveredAt
      ticket.inputs.push({ id: 'human-after-failed', kind: 'trigger', triggerId: 'trg-x', at: deliveredAt })
    })

    const report = runtime.recover()
    expect(report.resumed, '人已经接过话的单必须接续').toStrictEqual([id])
    const ticket = readTicket(store, id)
    expect(ticket.assignments.length).toBe(2)
    expect(ticket.assignments.at(-1)!.state).toBe('pending')
  })
})

// ── 3. 崩溃恢复：pending 重新入队 ───────────────────────────────────────────

test('pending 的工单：恢复时重新入队派工，不自己建工作树', () => {
  const { executor, calls } = fakeExecutor()
  withRuntime('requeue', { executor }, ({ runtime, store, root }) => {
    const id = runtime.publish({ title: '排队时崩了', body: '正文' })
    const assignmentId = readTicket(store, id).assignments.at(-1)!.id
    calls.start.length = 0

    const report = runtime.recover()
    expect(report.requeued).toStrictEqual([id])
    expect(report.resumed).toStrictEqual([])
    expect(calls.start, '应把同一对（工单 + 分配）重新交给执行器').toStrictEqual([{ ticketId: id, assignmentId }])

    // 恢复走的是执行器的 start，不是自己 `ensureWorktree`：假执行器不建树，这里就没有树。
    expect(existsSync(join(root, 'superagent', 'worktrees'))).toBe(false)

    // 幂等：再恢复一次仍然只是「再交给执行器一次」，执行器按 (工单, 分配) 去重（真执行器那侧）。
    const again = runtime.recover()
    expect(again.requeued).toStrictEqual([id])
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
      ticket.assignments.at(-1)!.state = 'running'
    })
    // 排队中的工单：建得再久也不该被超时改判——它一次都没跑过，排队的那次派工稍后仍会启动。
    editTicket(store, queuedId, (ticket) => {
      ticket.createdAt = old
    })
    editTicket(store, endedId, (ticket) => {
      ticket.createdAt = old
      ticket.assignments.at(-1)!.state = 'running'
      ticket.ended = { at: old, by: 'human', outcome: 'completed' }
    })
    calls.stop.length = 0

    runtime.pump()

    expect(calls.stop.length, '只该停那一张正在跑的').toBe(1)
    expect(calls.stop[0].ticketId).toBe(id)
    expect(calls.stop[0].reason).toMatch(/超过 60 秒未完成，已取消/)

    const stored = readTicket(store, id)
    expect(stored.assignments.at(-1)!.report?.state).toBe('failed')
    expect(stored.assignments.at(-1)!.report?.summary).toBe('超过 60 秒未完成，已取消')
    expect(runtime.list().find((item) => item.id === id)?.stage).toStrictEqual({ stage: 'person', action: 'failed' })

    // 排队中与已结束的：报告一个字段都没多。
    expect(readTicket(store, queuedId).assignments.at(-1)?.report).toBeUndefined()
    expect(readTicket(store, endedId).assignments.at(-1)?.report).toBeUndefined()

    // 超时是幂等的：下一拍不再重复停、也不再重写报告。
    const summary = stored.assignments.at(-1)!.report?.summary
    calls.stop.length = 0
    runtime.pump()
    expect(calls.stop.length).toBe(0)
    expect(readTicket(store, id).assignments.at(-1)!.report?.summary).toBe(summary)
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
    expect(report.removed).toStrictEqual([id])
    expect(existsSync(dir), '31 天前结束的工单，会话目录应被删掉').toBe(false)
    expect(existsSync(worktree), '工作树不归保留策略删（那是 /sa clean 的事）').toBe(true)

    // 幂等：再扫一次只是「本来就不在」。
    expect(runtime.sweep().removed).toStrictEqual([])
    expect(runtime.sweep().missing).toStrictEqual([id])
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
    expect(report.removed, '30 天内的任何东西都不该被删').toStrictEqual([])
    expect(existsSync(dirRecent), '29 天前结束的会话目录应留着').toBe(true)
    expect(existsSync(dirEdge), '正好 30 天的会话目录应留着（判据是「超过」30 天）').toBe(true)
    expect(existsSync(dirOpen), '未结束的工单不在保留策略范围内').toBe(true)
  })
})
