/**
 * @pneuma/superagent 第 6 步的包级测试：结果通知 + 停止 / 重试 / 清理三条命令的后端。
 *
 * 六条用例，每条只钉一件会「悄悄坏掉」的事：
 *   1. 工单结束真往 `outbox` 里放了一条 `notice`，那句能读的话与它指回的工单都在库里；
 *   2. `stop` 之后工单已结束，而且 worker 是在「工单已结束」之后才被停的（顺序不能反）；
 *   3. `retry` 之后工单回到待派工，新分配真的交给了执行器；
 *   4. `clean` 对未结束的工单抛错，对已结束的真的把工作树目录删掉（临时 git 仓库，真跑 git）；
 *   5. 通知那句话：完成说清改了什么，失败说清卡在哪一步；
 *   6. 命令层的 id 前缀匹配：唯一命中就动手，歧义就喊「贴长一点」，找不到就说没有。
 *
 * 「出站队列 → 最近动态」那一半（发出去、失败退避、窗口容量）在 `dispatch.test.mjs` 里，
 * 因为它现在的读者是发送泵，不是通知这个类。
 *
 * 全程 `tmpdir()` 下的临时目录，每个用例一份：绝不碰用户真实的 `~/.dsc`。
 * 迁移说明：原文件 import `lib/` 构建产物；现在直接 import 源码，不再要求先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, expect, test } from 'vitest'
import type { Executor } from '../core/ports.js'
import type { Ticket } from '../core/model.js'
import type { RuntimeOptions, SuperagentRuntime as RuntimeInstance, TicketView } from '../runtime.js'

const { openStore } = await import('../adapters/store.js')
const { StoreRepositories } = await import('../adapters/repositories.js')
const { noticeText } = await import('../adapters/notify.js')
const { ensureWorktree, slugOf } = await import('../adapters/worktree.js')
const { SuperagentRuntime } = await import('../runtime.js')
const { parseSaCommand, resolveTicket } = await import('../commands.js')

/** 固定时钟：镜像 `runtime.spec.ts`，让断言不依赖「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

const roots: string[] = []

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 一个用例一个临时根目录。 */
function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `superagent-notify-${label}-`))
  roots.push(dir)
  return dir
}

/** 库文件路径：`paths.ts` 的 `orchestratorDbPath()` = `<DSC_HOME>/superagent/orchestrator.sqlite`。 */
function dbPathOf(root: string): string {
  return join(root, 'superagent', 'orchestrator.sqlite')
}

/** 只读地查一次库，用完即关；断言都在调用方写。 */
function readDb<T>(root: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPathOf(root), { readOnly: true })
  try {
    return work(db)
  } finally {
    db.close()
  }
}

/** 一套运行期。 */
interface RuntimeFixture {
  runtime: RuntimeInstance
  store: ReturnType<typeof openStore>
  root: string
}

/**
 * 在临时目录里装一套运行期并跑完 `work`。
 *
 * `extra` 会并进 `RuntimeOptions`：第 3、4 条用例靠它换一个只记调用的假执行器
 * （真执行器要起会话与模型，这里要测的是「谁在什么时候被叫」）。
 * 收尾顺序与 `runtime.spec.ts` 一致：运行期 → 库 → 环境变量。
 */
function withRuntime<T>(
  label: string,
  work: (context: RuntimeFixture) => T,
  extra: Partial<RuntimeOptions> = {},
): T {
  const root = tempRoot(label)
  const previous = process.env['DSC_HOME']
  process.env['DSC_HOME'] = root
  const store = openStore()
  const runtime = new SuperagentRuntime(store, { now: () => AT, log: () => {}, ...extra })
  try {
    return work({ runtime, store, root })
  } finally {
    runtime.close()
    store.close()
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
  }
}

/** 假执行器的一次调用。 */
interface ExecutorCall {
  what: string
  ticket: string
  assignment: string
  reason?: string
  stage?: string
}

/** 跑测试用的 git：剥掉继承来的 `GIT_*`（理由同 `worktree.spec.ts`）。 */
const cleanEnv: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (key.toUpperCase().startsWith('GIT_') || value === undefined) continue
  cleanEnv[key] = value
}

/** 跑一次 git，返回 stdout。 */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 造一个能提交的临时仓库：`worktree add` 至少要有一次提交，否则没有 HEAD 可当起点。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-notify-repo-'))
  roots.push(dir)
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'superagent-test@example.com'])
  git(dir, ['config', 'user.name', 'Superagent Test'])
  writeFileSync(join(dir, 'README.md'), '# notify probe\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

test('1. 工单结束入队一条 notice，内容在库里自解释', () => {
  withRuntime('notice', ({ runtime, root }) => {
    const id = runtime.publish({ title: '改登录页文案', body: '把提示改成中文' })
    runtime.stop(id)

    const rows = readDb(root, (db) => db.prepare('SELECT id, value FROM outbox').all()) as Array<{ value: string }>
    expect(rows.length, '结束时应入队，且只入队一条').toBe(1)
    const stored = JSON.parse(rows[0].value) as {
      kind: string
      payload: { at: string; message: { ticketId: string; text: string } }
    }
    expect(stored.kind).toBe('notice')
    expect(stored.payload.message.ticketId, '通知要指回工单').toBe(id)
    expect(stored.payload.message.text, '那句话要带上标题，人能认出是哪张').toMatch(/工单「改登录页文案」/)
    expect(stored.payload.at, '入队时刻要一起写进 payload：行一旦入队就与内存无关了').toBe(AT)
  })
})

test('2. stop：工单已结束，且 worker 在「工单已结束」之后才被停', () => {
  const calls: ExecutorCall[] = []
  let runtime: RuntimeInstance | null = null
  /** 假执行器：只记调用，不建树、不起 worker。 */
  const fake = {
    start: (ticket: { id: string }, assignment: { id: string }) =>
      calls.push({ what: 'start', ticket: ticket.id, assignment: assignment.id }),
    deliver: () => {},
    stop: (ticket: { id: string }, assignment: { id: string }, reason: string) => {
      const stage = runtime?.list().find((item) => item.id === ticket.id)?.stage.stage
      calls.push({ what: 'stop', ticket: ticket.id, assignment: assignment.id, reason, stage })
    },
  }
  withRuntime('stop', ({ runtime: active, store }) => {
    runtime = active
    const id = active.publish({ title: 'stop me', body: '正文' })
    const assignmentId = new StoreRepositories(store.handle).tickets.get(id)!.assignments[0].id
    expect(active.list()[0].stage).toStrictEqual({ stage: 'working', action: 'queued' })

    active.stop(id)

    expect(active.list()[0].stage, '领域要先收尾').toStrictEqual({ stage: 'ended' })
    const stops = calls.filter((call) => call.what === 'stop')
    expect(stops.length >= 1, 'worker 要被停').toBe(true)
    expect(stops.every((call) => call.ticket === id && call.assignment === assignmentId)).toBe(true)
    // 顺序判据：停 worker 的那一刻，工单已经是「已结束」。
    expect(stops.every((call) => call.stage === 'ended'), '停 worker 必须发生在工单结束之后').toBe(true)
  }, { executor: fake as unknown as Executor })
})

test('3. retry：失败报告后重试，工单回到待派工并重新交给执行器', () => {
  const starts: Array<{ ticket: string; assignment: string; state: string }> = []
  const stops: Array<{ ticket: string; assignment: string }> = []
  const fake = {
    start: (ticket: { id: string }, assignment: { id: string; state: string }) =>
      starts.push({ ticket: ticket.id, assignment: assignment.id, state: assignment.state }),
    deliver: () => {},
    stop: (ticket: { id: string }, assignment: { id: string }) =>
      stops.push({ ticket: ticket.id, assignment: assignment.id }),
  }
  withRuntime('retry', ({ runtime, store }) => {
    const id = runtime.publish({ title: 'retry me', body: '正文' })
    const repos = new StoreRepositories(store.handle)
    const ticket = repos.tickets.get(id)!
    const first = ticket.assignments[0].id
    // 领域里这份报告由 worker 的回合事件写进来；这里直接落库，只为把工单摆成「失败了」。
    ticket.assignments[0].report = { state: 'failed', summary: '沙箱拒绝了写操作', at: AT }
    ticket.assignments[0].state = 'ended'
    repos.tickets.save(ticket)
    expect(runtime.list()[0].stage).toStrictEqual({ stage: 'person', action: 'failed' })

    runtime.retry(id)

    const after = runtime.list()[0]
    expect(after.stage, '重试后应回到待派工').toStrictEqual({ stage: 'working', action: 'queued' })
    const again = repos.tickets.get(id)!
    expect(again.assignments.length, '重试要开一份新分配').toBe(2)
    expect(again.assignments[1].state).toBe('pending')
    expect(again.assignments[1].id).not.toBe(first)
    expect(stops.some((call) => call.assignment === first), '旧分配要先结束').toBe(true)
    expect(
      starts.some((call) => call.assignment === again.assignments[1].id && call.state === 'pending'),
      '新分配要交给执行器重新派工',
    ).toBe(true)
  }, { executor: fake as unknown as Executor })
})

test('4. clean：未结束抛错，已结束真的删掉工作树目录', () => {
  let repoPath = ''
  withRuntime('clean', ({ runtime, root }) => {
    const repo = makeRepo()
    repoPath = repo
    const id = runtime.publish({ title: 'clean me', body: '正文' })
    const title = runtime.list()[0].title
    // 与执行器建树时同一套命名：标题 slug 前 40 位 + '-' + 工单 id 前 8 位（`adapters/executor.ts:232`）。
    const name = `${slugOf(title).slice(0, 40).replace(/[-.]+$/, '')}-${id.slice(0, 8)}`
    const handle = ensureWorktree({ repo, name })
    expect(handle.path, '目录要落在 <DSC_HOME>/superagent/worktrees 下').toBe(
      join(root, 'superagent', 'worktrees', slugOf(name)),
    )

    expect(() => runtime.clean(id), '未结束的工单不许清理，文案要说「先 stop」').toThrow(/先停止/)
    expect(existsSync(handle.path), '抛错之后目录必须还在').toBe(true)

    runtime.stop(id)
    runtime.clean(id)
    expect(existsSync(handle.path), '已结束的工单清理后目录应当消失').toBe(false)
  }, { worker: { repo: () => repoPath } })
})

test('5. 通知文案：完成说清改了什么，失败说清卡在哪一步', () => {
  const done = noticeText({
    id: 'a'.repeat(32),
    title: '改登录页文案',
    ended: { at: AT, by: 'executor', outcome: 'completed' },
    assignments: [{
      id: 'assignment-0',
      state: 'ended',
      createdAt: AT,
      startedAt: AT,
      report: { state: 'ready', summary: '改了 src/login.ts +3 -1，测试通过', at: AT },
    }],
  } as unknown as Ticket)
  expect(done, '完成的通知要说清改了哪个文件').toMatch(/src\/login\.ts/)

  const failed = noticeText({
    id: 'b'.repeat(32),
    title: '改登录页文案',
    ended: { at: AT, by: 'human', outcome: 'stopped' },
    assignments: [{ id: 'assignment-0', state: 'ended', createdAt: AT, report: { state: 'failed', summary: 'git worktree add 失败：分支已被占用', at: AT } }],
  } as unknown as Ticket)
  expect(failed, '没开始过 = 倒在派工那一步').toMatch(/失败在派工/)
  expect(failed, '失败细节要带出来').toMatch(/分支已被占用/)
})

test('6. 命令层：id 前缀唯一命中就干，歧义喊「贴长一点」，找不到说没有', () => {
  const view = (id: string, title: string): TicketView =>
    ({ id, title, stage: { stage: 'ended' }, createdAt: AT }) as unknown as TicketView
  const tickets = [
    view(`${'abcdef01'}${'0'.repeat(24)}`, '甲'),
    view(`${'abcdef02'}${'0'.repeat(24)}`, '乙'),
    view(`${'12345678'}${'0'.repeat(24)}`, '丙'),
  ]

  const unique = resolveTicket(tickets, '1234')
  expect('ticket' in unique, '前缀只命中一张时应直接给出工单').toBe(true)
  if (!('ticket' in unique)) throw new Error(`期望唯一命中，实际是 ${JSON.stringify(unique)}`)
  expect(unique.ticket.title).toBe('丙')

  const exact = resolveTicket(tickets, tickets[0].id)
  expect('ticket' in exact, '完整 id 也要认').toBe(true)
  if (!('ticket' in exact)) throw new Error(`期望完整 id 命中，实际是 ${JSON.stringify(exact)}`)
  expect(exact.ticket.title).toBe('甲')

  const ambiguous = resolveTicket(tickets, 'abcdef')
  expect('message' in ambiguous).toBe(true)
  if (!('message' in ambiguous)) throw new Error('期望歧义结果')
  expect(ambiguous.message).toMatch(/有歧义/)
  expect(ambiguous.message).toMatch(/贴长一点/)

  const missing = resolveTicket(tickets, 'deadbeef')
  expect('message' in missing).toBe(true)
  if (!('message' in missing)) throw new Error('期望找不到结果')
  expect(missing.message).toMatch(/没有这张工单/)

  // 解析侧：三条子命令各接一个 id；缺 id 时给能照着敲的提示。
  expect(parseSaCommand(['stop', '1234'])).toStrictEqual({ kind: 'stop', id: '1234' })
  expect(parseSaCommand(['retry', 'abcdef01'])).toStrictEqual({ kind: 'retry', id: 'abcdef01' })
  expect(parseSaCommand(['clean', 'abcdef02'])).toStrictEqual({ kind: 'clean', id: 'abcdef02' })
  const noId = parseSaCommand(['stop'])
  expect(noId.kind).toBe('error')
  if (noId.kind !== 'error') throw new Error('缺 id 应当返回 error')
  expect(noId.message).toMatch(/\/sa stop/)
})
