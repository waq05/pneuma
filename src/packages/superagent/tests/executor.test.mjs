/**
 * @pneuma/superagent 第 5 步的包级测试：执行器（工作树 + 会话 + worker + 并发）。
 *
 * 五条用例，每条只钉一件会「悄悄坏掉」的事：
 *   1. `start` 真建了工作树、真按显式路径建了会话，并把工单文本投给 worker；
 *   2. 并发上限生效：同时发 3 个，只起 2 个，第 3 个排队，有人让位才开工；
 *   3. `stop` 调的是「中断回合」而不是杀进程，且重复调不炸；
 *   4. 报告映射：`turn/end` 正常收尾 → `ready`，`error` → `failed`（纯函数直测，不起模型）；
 *   5. 两张全中文标题的工单不会撞同一棵工作树（slug 只留 ASCII，标题会折成 `ticket`）。
 *
 * 全程不碰真模型：`createAgent` 换成假 agent，`worktree.ensure` 换成假工作树；
 * 只有第 5 条用真 git + 临时仓库，专门验名字的唯一后缀。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`；`DSC_HOME` 每个用例
 * 指到 `tmpdir()` 下的临时目录，绝不碰用户真实的 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/executor
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const { WorkerExecutor, worktreeNameOf, turnEndReport, errorReport, transient } =
  await import('../../../../lib/packages/superagent/adapters/executor.js')
const { ensureWorktree } = await import('../../../../lib/packages/superagent/adapters/worktree.js')
const { Session } = await import('../../../../lib/core/session.js')

/** 固定时钟：断言只看形状，不看「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

/** 临时目录清单：进程退出时兜底清一遍（每个用例自己也会清）。 */
const roots = []
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 等一个事件循环：`start` 只入队，真正的派工在 microtask 里。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 32 位十六进制，与 `core/ids.ts` 的 `key()` 同形，能被 `sessionsDir` 的校验接受。 */
function ticketId(seed) {
  return seed.repeat(32).slice(0, 32)
}

/** 一张最小工单：执行器只读 id / title / origin / inputs / undelivered。 */
function makeTicket(seed, title) {
  const id = ticketId(seed)
  const assignment = { id: `a-${id.slice(0, 4)}`, state: 'pending', createdAt: AT }
  const ticket = {
    id,
    title,
    decisionId: `d-${id.slice(0, 4)}`,
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      basis: { via: 'addressed', addressed: 'direct' },
      actor: { source: 'manual', id: 'operator' },
      scope: 'manual',
    },
    channels: [],
    assignments: [assignment],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: `t-${id.slice(0, 4)}`, triggerIds: [`t-${id.slice(0, 4)}`] },
  }
  return { ticket, assignment }
}

/** 假宿主：模型不会被调用，工具只要名字对得上，守卫一律 defer。 */
function fakeHost() {
  const names = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search']
  const tools = names.map((name) => ({ name, description: name, inputSchema: {}, risk: 'read', run: async () => '' }))
  return {
    llm: {
      route: () => ({ provider: 'fake', model: 'fake', api: 'fake' }),
      routeTo: () => ({ provider: 'fake', model: 'fake', api: 'fake' }),
      stream: async () => {
        throw new Error('包级测试不调用模型')
      },
    },
    tools: { list: () => tools },
    guards: { gate: async () => ({ action: 'defer' }), observe: (_name, text) => text },
  }
}

/**
 * 装一套执行器：假宿主 + 假工作树 + 真会话（只写文件，不发请求）+ 假 agent。
 *
 * 用真 `Session` 是为了让「会话文件有没有落盘」这条断言有真对象可查：执行器钉权限时
 * 写的那条 `permissions` 状态会顺带写出 meta 首行（`core/session.ts:1327-1352`）。
 */
function setup(label, options = {}) {
  const root = mkdtempSync(join(tmpdir(), `superagent-executor-${label}-`))
  roots.push(root)
  const previous = process.env.DSC_HOME
  process.env.DSC_HOME = root

  const events = { ensured: [], started: [], reports: [], delivered: [], turnEnded: [], failed: [] }
  const agents = []
  const engine = {
    assignmentStarted: (id, assignmentId) => { events.started.push({ ticketId: id, assignmentId }) },
    report: (id, report) => { events.reports.push({ ticketId: id, report }) },
    turnEnded: (id, assignmentId) => { events.turnEnded.push({ ticketId: id, assignmentId }) },
    inputsDelivered: (id, assignmentId, ids) => { events.delivered.push({ ticketId: id, assignmentId, ids }) },
    deliveryFailed: (id, assignmentId, error) => { events.failed.push({ ticketId: id, assignmentId, error }) },
  }

  const executor = new WorkerExecutor(null, {
    host: fakeHost(),
    repo: join(root, 'repo'),
    maxWorkers: options.maxWorkers ?? 2,
    worktree: {
      ensure(input) {
        events.ensured.push(input)
        const path = join(root, 'worktrees', input.name)
        mkdirSync(path, { recursive: true })
        return { path, branch: `agent/${input.name}`, created: true }
      },
    },
    createSession: (cwd, file) => Session.create(cwd, file),
    createAgent: (deps, session) => {
      const agent = {
        deps,
        session,
        followups: [],
        cancels: 0,
        isRunning: false,
        followup(text) {
          this.followups.push(text)
          // 真 MiniAgent 的 followup 会 appendUser，会话文件就是在那一刻落盘的
          //（`core/session.ts:1327-1352`）。假 agent 照做，文件断言才测的是真链路。
          this.session.appendUser(text)
        },
        cancel() { this.cancels += 1 },
      }
      agents.push(agent)
      return agent
    },
    engine: () => engine,
    log: options.log ?? (() => {}),
    readTriggerText: () => '把错误提示改成中文',
  })

  const cleanup = () => {
    executor.dispose()
    if (previous === undefined) delete process.env.DSC_HOME
    else process.env.DSC_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
  return { root, executor, events, agents, cleanup }
}

test('start 建工作树、创建会话文件，并把工单文本投给 worker', async () => {
  const s = setup('start')
  try {
    const { ticket, assignment } = makeTicket('8f9a1c69', '改登录页文案')
    s.executor.start(ticket, assignment)
    await tick()

    assert.equal(s.events.ensured.length, 1, '应恰好建一次工作树')
    assert.equal(s.events.ensured[0].repo, join(s.root, 'repo'))
    assert.ok(
      s.events.ensured[0].name.endsWith(`-${ticket.id.slice(0, 8)}`),
      `工作树名要带工单 id 后缀，实际：${s.events.ensured[0].name}`,
    )

    assert.equal(s.agents.length, 1, '应恰好起一个 worker')
    const agent = s.agents[0]
    assert.equal(s.events.started.length, 1, '应回调一次 assignmentStarted')
    assert.deepEqual(s.events.started[0], { ticketId: ticket.id, assignmentId: assignment.id })

    const file = agent.session.filePath
    assert.ok(
      file.startsWith(join(s.root, 'superagent', 'sessions', ticket.id)),
      `会话要落在 sessionsDir(ticket.id) 下，实际：${file}`,
    )
    assert.ok(file.endsWith('.jsonl'), `会话文件应是 jsonl，实际：${file}`)
    assert.ok(existsSync(file), '会话文件应在 start 之后落盘（钉权限那条状态会写 meta 首行）')

    assert.equal(agent.followups.length, 1, '工单文本应投递一次')
    assert.match(agent.followups[0], /改登录页文案/, '投递内容应带标题')
    assert.match(agent.followups[0], /把错误提示改成中文/, '投递内容应带正文')
  } finally {
    s.cleanup()
  }
})

test('并发上限：同时发 3 个，只起 2 个，第 3 个排队', async () => {
  const s = setup('queue', { maxWorkers: 2 })
  try {
    const items = [0, 1, 2].map((index) => makeTicket(String.fromCharCode(97 + index), `任务 ${index + 1}`))
    for (const { ticket, assignment } of items) s.executor.start(ticket, assignment)
    await tick()

    assert.equal(s.executor.activeCount, 2, '并发上限 2：只能起两个')
    assert.equal(s.executor.queuedCount, 1, '第三个应排队')
    assert.equal(s.agents.length, 2, '只应建两个 agent')

    // 让出一个名额：第三个应立刻补上。
    s.executor.stop(items[0].ticket, items[0].assignment, '腾位')
    await tick()
    assert.equal(s.executor.activeCount, 2, '让位后第三个应开工')
    assert.equal(s.executor.queuedCount, 0)
    assert.equal(s.agents.length, 3, '第三个 agent 应已建出来')
  } finally {
    s.cleanup()
  }
})

test('stop 调用中断方法，重复调不炸', async () => {
  const s = setup('stop')
  try {
    const { ticket, assignment } = makeTicket('c1d2e3f4', '要停的工单')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    assert.equal(agent.cancels, 0, '刚开工时不该自己中断')

    s.executor.stop(ticket, assignment, '用户停止')
    assert.equal(agent.cancels, 1, 'stop 应调用一次 cancel（中断回合，不杀进程）')

    assert.doesNotThrow(() => s.executor.stop(ticket, assignment, '再说一次'), '重复 stop 不应抛错')
    assert.equal(agent.cancels, 1, '重复 stop 不应再次中断')
    assert.equal(s.executor.activeCount, 0, '停止后不再占并发名额')
  } finally {
    s.cleanup()
  }
})

test('报告映射：turn/end 正常收尾 → ready，error → failed', () => {
  assert.deepEqual(turnEndReport('completed', '改了 a.ts（+1/−0）\n测试：通过'), {
    state: 'ready',
    summary: '改了 a.ts（+1/−0）\n测试：通过',
  })

  assert.deepEqual(errorReport('模型请求超时'), { state: 'failed', summary: '模型请求超时' })
  assert.deepEqual(turnEndReport('error', '半截正文', '模型请求超时'), {
    state: 'failed',
    summary: '模型请求超时',
  })

  // 主动停止 / 被打断不往已结束的分配上补报告。
  assert.equal(turnEndReport('aborted', '半截正文'), null)
  assert.equal(turnEndReport('completed', '收尾', undefined, true), null)
})

test('临时故障判据：状态码优先，文本兜底', () => {
  // 带 status 的错误：408 / 429 / 5xx 是临时故障，4xx 其余不是。
  assert.equal(transient({ status: 408 }), true, '408 请求超时要重试')
  assert.equal(transient({ status: 429 }), true, '429 限流要重试')
  assert.equal(transient({ status: 500 }), true, '500 要重试')
  assert.equal(transient({ status: 503 }), true, '503 要重试')
  assert.equal(transient({ status: 404 }), false, '404 重试一万次也一样')
  assert.equal(transient({ status: 401 }), false, '401 是令牌问题，不是抖动')

  // 没有 status：退到错误文本。
  assert.equal(transient(new Error('read ECONNRESET')), true, '连接重置要重试')
  assert.equal(transient(new Error('fetch failed')), true, 'fetch 失败要重试')
  assert.equal(transient(new Error('socket hang up')), true)
  assert.equal(transient(new Error('model overloaded')), true)
  assert.equal(transient(new Error('upstream returned 502')), true, '文本里的 5xx 也算')

  // 非临时故障不能被误判，否则配置错误会白等三次退避。
  assert.equal(transient(new Error('没有配置仓库路径（设置 → Super Agent → repoPath）')), false)
  assert.equal(transient(new Error('标题不能为空：先写一句要它做什么')), false)
  assert.equal(transient('plain string without keywords'), false, '非 Error 值按文本判')

  // `code` 字段也参与判据（Node 的网络错误常把它挂在 Error 的 code 上）。
  assert.equal(transient(Object.assign(new Error('connection failed'), { code: 'ETIMEDOUT' })), true)
  // 非 Error 的裸对象不带 code：与上游一致，只 String() 一下，不特判。
  assert.equal(transient({ code: 'ETIMEDOUT' }), false, '非 Error 值只按文本判')
})

test('没有宿主上下文时 start 只记缺项日志，不假装成功', () => {
  const lines = []
  const executor = new WorkerExecutor(null, { log: (line) => lines.push(line) })
  const { ticket, assignment } = makeTicket('deadbeef', '没有宿主')
  executor.start(ticket, assignment)

  assert.equal(executor.activeCount, 0, '缺宿主时不该起 worker')
  assert.equal(executor.queuedCount, 0, '缺宿主时也不该排进队列假装会派出去')
  assert.equal(lines.length, 2, `应只有构造与 start 各一条日志，实际：${lines.join(' | ')}`)
  assert.match(lines[0], /执行器未接宿主（缺 cordis Context）/, '构造时就该说清楚缺什么')
  assert.match(lines[1], /停在待派工.*cordis Context.*没有启动 worker/, 'start 的日志要说清「缺什么、所以没起」')
  executor.dispose()
})

test('两个全中文标题的工单得到两个不同的工作树', () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-executor-worktree-'))
  roots.push(root)
  try {
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
      assert.equal(result.status, 0, `git ${args.join(' ')} 失败：${result.stderr || result.error?.message || ''}`)
    }
    git(['init', '-q'])
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-qm', 'init'])

    // 同一个中文标题，只靠工单 id 区分——正是 slug 折成 `ticket` 时最容易踩的坑。
    const first = { id: ticketId('a'), title: '改登录页文案' }
    const second = { id: ticketId('b'), title: '改登录页文案' }
    const firstName = worktreeNameOf(first)
    const secondName = worktreeNameOf(second)
    assert.notEqual(firstName, secondName, '两张工单的工作树名必须不同')

    const worktreeRoot = join(root, 'worktrees')
    const a = ensureWorktree({ repo, name: firstName, root: worktreeRoot })
    const b = ensureWorktree({ repo, name: secondName, root: worktreeRoot })
    assert.equal(a.created, true, '第一棵应是新建的')
    assert.equal(b.created, true, '第二棵应是新建的，不是复用第一棵')
    assert.notEqual(a.path, b.path, '两棵树不能是同一目录')
    assert.notEqual(a.branch, b.branch, '两个分支不能同名')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
