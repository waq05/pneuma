/**
 * P4 的包级测试：建单时定下的执行参数（`prepareTicket` 钩子）与 PR 认领（`pr_number`）。
 *
 * 六组用例，钉的都是「不报错、只是悄悄不生效」的那两条链路：
 *   1. `worktreePathOf` 与 `ensureWorktree` 算出同一个目录 / 分支（真 git、临时仓库）；
 *   2. `prepare()` 把 `execution.name` / `directory` 写上；没给短名时退回标题；
 *   3. `prepare()` 是纯的：调两次不建目录、不抛、不改入参；
 *   4. 接上 `prepareTicket` 之后 `ticketBranch` 对得上真建出来的分支（真 bug 的回归）；
 *   5. `claimPull` 四种拒绝：工单已结束、PR 不属于这张单、PR 已属于别的活工单、PR 读失败；
 *   6. `claimPull` 成功：绑一次、`own` 对；已经是这张单的 follow 时不重复绑。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`；第 4 组把 `DSC_HOME`
 * 指到临时目录，绝不碰用户真实的 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/pull-claim
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

const { WorkerExecutor, worktreeNameOf } = await import('../../../../lib/packages/superagent/adapters/executor.js')
const { ensureWorktree, worktreePathOf } = await import('../../../../lib/packages/superagent/adapters/worktree.js')
const { ticketBranch } = await import('../../../../lib/packages/superagent/adapters/github/pull.js')
const { claimPull } = await import('../../../../lib/packages/superagent/adapters/github/bind.js')
const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { StoreRepositories } = await import('../../../../lib/packages/superagent/adapters/repositories.js')
const { SuperagentRuntime } = await import('../../../../lib/packages/superagent/runtime.js')

/** 固定时钟：断言只看形状，不看「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

/** 临时目录清单：进程退出时兜底清一遍（每个用例自己也会清）。 */
const roots = []

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})

/** 记一条通过的断言；失败照常抛给 node:test。 */
function ok(value, message) {
  assert.ok(value, message)
  passed += 1
}

/** 严格相等。 */
function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  passed += 1
}

/** 深比较（对象 / 数组）。 */
function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

/**
 * 跑测试用的 git：剥掉继承来的 `GIT_*`。
 *
 * 不剥的话，开发者 shell 里设过 `GIT_DIR` 会让这些命令全落到别的仓库——测试就会在别人的
 * 工作区上跑（理由同 `worktree.test.mjs`）。
 */
const cleanEnv = {}
for (const [key, value] of Object.entries(process.env)) {
  if (key.toUpperCase().startsWith('GIT_') || value === undefined) continue
  cleanEnv[key] = value
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 造一个能提交的临时仓库：`worktree add` 至少要有一次提交，否则没有 HEAD 可当起点。 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-claim-repo-'))
  roots.push(dir)
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'superagent-test@example.com'])
  git(dir, ['config', 'user.name', 'Superagent Test'])
  writeFileSync(join(dir, 'README.md'), '# pull claim probe\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

/** 单独一个工作树根目录：放在仓库外面，模拟 `<DSC_HOME>/superagent/worktrees/`。 */
function makeRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `superagent-claim-${label}-`))
  roots.push(dir)
  return dir
}

/** 32 位十六进制，与 `core/ids.ts` 的 `key()` 同形。 */
function ticketId(seed) {
  return seed.repeat(32).slice(0, 32)
}

/** 一张最小工单：`prepare` 只读 id / title。 */
function bareTicket(seed, title) {
  return { id: ticketId(seed), title, decisionId: `d-${seed}`, mandate: { strength: 'explicit' }, channels: [] }
}

test('1. worktreePathOf 与 ensureWorktree 算出同一个目录与分支', () => {
  const repo = makeRepo()
  const root = makeRoot('path')
  const placed = worktreePathOf({ name: 'fix login copy', root })
  equal(placed.slug, 'fix-login-copy', 'slug 与 ensureWorktree 用的那份规则一致')
  equal(placed.branch, 'agent/fix-login-copy')

  const handle = ensureWorktree({ repo, name: 'fix login copy', root })
  equal(handle.path, placed.dir, '工作树目录必须与纯函数算出来的一致')
  equal(handle.branch, placed.branch, '分支名也必须一致')
  ok(existsSync(placed.dir), 'ensureWorktree 应真的建出目录')
})

test('2. prepare 写上 execution.name / directory；没给短名时退回标题', () => {
  const root = makeRoot('prepare')
  const executor = new WorkerExecutor(null, { root, log: () => {} })

  const named = executor.prepare(bareTicket('a1', '改登录页文案'), { name: 'fix login copy' })
  equal(named.execution.name, 'fix-login-copy-a1a1a1a1', '短名要 slug 化并补工单 id 后缀')
  equal(named.execution.assignment, '', 'assignment 此刻还没有，留空串')
  equal(named.execution.directory, join(root, 'fix-login-copy-a1a1a1a1'), '目录落在工作树根下')
  equal(
    worktreePathOf({ name: named.execution.name, root }).dir,
    named.execution.directory,
    '目录必须与 ensureWorktree 的算法同源',
  )

  // 模型没给短名（或只给了空白）：退回标题算；全中文标题的 slug 是 `ticket`，仍有 id 后缀区分。
  const titled = executor.prepare(bareTicket('b2', '改登录页文案'), {})
  equal(titled.execution.name, 'ticket-b2b2b2b2', '没给短名时用标题算，中文折成 ticket 也带 id 后缀')
  const blank = executor.prepare(bareTicket('c3', 'tidy copy'), { name: '   ' })
  equal(blank.execution.name, 'tidy-copy-c3c3c3c3', '空白短名等于没给，退回标题')
})

test('3. prepare 是纯的：调两次不建目录、不抛、结果相同', () => {
  const root = makeRoot('pure')
  const executor = new WorkerExecutor(null, { root, log: () => {} })
  const ticket = bareTicket('d4', '纯函数')
  const first = executor.prepare(ticket, { name: 'pure check' })
  const second = executor.prepare(ticket, { name: 'pure check' })
  deepEqual(second, first, '同样的输入必须给出同样的工单')
  equal(existsSync(first.execution.directory), false, 'prepare 不能建目录：它跑在数据库事务里')
  equal(ticket.execution, undefined, '不能改入参（事务里的原件是别处还拿着的）')
})

test('4. 接上 prepareTicket 之后 ticketBranch 对得上真建出来的分支（bug 回归）', () => {
  const home = makeRoot('wiring')
  const previous = process.env.DSC_HOME
  process.env.DSC_HOME = home
  const repo = makeRepo()
  const store = openStore()
  // 用真 WorkerExecutor 的 prepare（纯函数），其余动作换成空的：这里要证的是「运行期把钩子
  // 接上了、写进去的 execution 能让 ticketBranch 认得出分支」，不是派工本身。
  const real = new WorkerExecutor(null, { log: () => {} })
  const runtime = new SuperagentRuntime(store, {
    now: () => AT,
    log: () => {},
    executor: {
      start() {},
      deliver() {},
      stop() {},
      prepare: (ticket, outcome) => real.prepare(ticket, outcome),
    },
  })
  try {
    const id = runtime.publish({ title: 'fix login copy', body: '把登录页文案改成中文' })
    const ticket = new StoreRepositories(store.handle).tickets.get(id)
    ok(ticket.execution !== undefined, 'prepareTicket 没接上时 execution 会是 undefined——这正是要修的 bug')
    equal(ticket.execution.name, worktreeNameOf(ticket), 'execution.name 就是工单的工作树名（分支末段）')

    // 派工时执行器按同一个名字建树：目录与工单上记的必须是同一棵。
    const handle = ensureWorktree({ repo, name: worktreeNameOf(ticket) })
    equal(handle.path, ticket.execution.directory, '工单记的目录就是派工要建的那棵树')
    ok(ticketBranch(ticket, handle.branch), 'ticketBranch 必须认得出这张单的分支（PR 自动绑定的前提）')
    ok(!ticketBranch(ticket, 'agent/other-work'), '别的分支不能算这张单的')
  } finally {
    runtime.close()
    store.close()
    if (previous === undefined) delete process.env.DSC_HOME
    else process.env.DSC_HOME = previous
  }
})

/** 一张 PR；只填判归属用得到的字段。 */
const pr = (number, overrides = {}) => ({
  number,
  state: 'open',
  user: { login: 'dsc-bot' },
  head: { ref: 'agent/fix-login-copy', repo: { full_name: 'owner/repo' } },
  ...overrides,
})

/** 本仓库的机器人身份（`agentPull` 的第二个参数）。 */
const ACCOUNT = { login: 'dsc-bot', repository: 'owner/repo' }

/** 一张最小工单；`channels` 是「它在哪条线程上被接单的」。 */
function ticketOf(overrides = {}) {
  return { id: 't1', title: 'fix login copy', channels: [], follows: [], ...overrides }
}

/** 一台记调用的假依赖面；`bind` 调用按顺序记下来供断言。 */
function depsOf(overrides = {}) {
  const binds = []
  const deps = {
    pull: async (number) => pr(number),
    account: ACCOUNT,
    ticket: () => ticketOf(),
    openTickets: () => [],
    bind: (ticketId, thread, own) => { binds.push({ ticketId, thread, own }) },
    ...overrides,
  }
  return { deps, binds }
}

test('5. claimPull 四种拒绝：工单已结束 / PR 不属于 / 已被别的单绑着 / PR 读失败', async () => {
  // 1）工单已结束：认领先看这一条，不该去读 PR。
  const ended = depsOf({
    ticket: () => ticketOf({ ended: { at: AT, by: 'human', outcome: 'stopped' } }),
    pull: async () => { throw new Error('不该走到读 PR') },
  })
  const endedReason = await claimPull(ended.deps, 't1', 12)
  ok(typeof endedReason === 'string' && endedReason.includes('已经结束'), `工单已结束要拒，实际：${endedReason}`)
  equal(ended.binds.length, 0)

  // 2）PR 既不是来源 PR，也不是机器人开的对应分支。
  const stranger = depsOf({
    ticket: () => ticketOf({ execution: { name: 'fix-login-copy', directory: '', assignment: '' } }),
    pull: async (number) => pr(number, { user: { login: 'someone-else' }, head: { ref: 'agent/other-work', repo: { full_name: 'owner/repo' } } }),
  })
  const strangerReason = await claimPull(stranger.deps, 't1', 12)
  ok(typeof strangerReason === 'string' && strangerReason.includes('不属于这张工单'), `不属于要拒，实际：${strangerReason}`)
  ok(strangerReason.includes('pr_number'), '拒绝文案要告诉模型「拿不准就别传 pr_number」')
  equal(stranger.binds.length, 0)

  // 3）PR 已经被另一张还开着的工单绑着：一张 PR 只能属于一张单。
  const taken = depsOf({
    ticket: () => ticketOf({ channels: [{ source: 'github', thread: 'github:12' }] }),
    openTickets: () => [ticketOf({ id: 'other', follows: [{ thread: 'github:12', own: true }] })],
  })
  const takenReason = await claimPull(taken.deps, 't1', 12)
  ok(typeof takenReason === 'string' && takenReason.includes('另一张'), `已被绑着要拒，实际：${takenReason}`)
  equal(taken.binds.length, 0)

  // 4）读 PR 失败：网络 / 404 / 令牌都算认领失败，不猜。
  const unreadable = depsOf({ pull: async () => { throw new Error('502 bad gateway') } })
  const readReason = await claimPull(unreadable.deps, 't1', 12)
  ok(typeof readReason === 'string' && readReason.includes('读 PR #12 失败'), `读失败要拒，实际：${readReason}`)
  ok(readReason.includes('502 bad gateway'), '原因要带上底层错误，人才知道是网络还是号码写错')
  equal(unreadable.binds.length, 0)
})

test('6. claimPull 成功：绑一次、own 对；已经是这张单的 follow 时不重复绑', async () => {
  // 机器人自己开的、分支末段等于工单短名 → own 为真。
  const opened = depsOf({
    ticket: () => ticketOf({ execution: { name: 'fix-login-copy', directory: '', assignment: '' } }),
  })
  const openedReason = await claimPull(opened.deps, 't1', 12)
  equal(openedReason, undefined, '成功时不给拒绝原因')
  deepEqual(opened.binds, [{ ticketId: 't1', thread: { source: 'github', id: '12' }, own: true }], 'own 传 opened')

  // 来源 PR（这张单就是那条 PR 的消息开的）：own 为假，分支名对不上也照样认。
  const started = depsOf({
    ticket: () => ticketOf({ channels: [{ source: 'github', thread: 'github:12' }] }),
    pull: async (number) => pr(number, { user: { login: 'someone-else' }, head: { ref: 'feature/x', repo: { full_name: 'owner/repo' } } }),
  })
  equal(await claimPull(started.deps, 't1', 12), undefined)
  deepEqual(started.binds, [{ ticketId: 't1', thread: { source: 'github', id: '12' }, own: false }], '来源 PR 不是机器人开的')

  // 已经跟着这张 PR（开着、own 也对）：再认领一次不该多绑一条订阅。
  const followed = depsOf({
    ticket: () => ticketOf({
      channels: [{ source: 'github', thread: 'github:12' }],
      follows: [{ thread: 'github:12', own: false }],
    }),
  })
  equal(await claimPull(followed.deps, 't1', 12), undefined)
  equal(followed.binds.length, 0, '本来就绑着：不重复绑')

  // 关掉 / 合并了的 PR 不绑：绑上也等不到后续，还会让「PR 合并 → 工单结束」误判成已发生。
  const closed = depsOf({
    ticket: () => ticketOf({ channels: [{ source: 'github', thread: 'github:12' }] }),
    pull: async (number) => pr(number, { state: 'closed' }),
  })
  equal(await claimPull(closed.deps, 't1', 12), undefined, '关着的 PR 不算认领失败')
  equal(closed.binds.length, 0, '关着的 PR 不绑')
})
