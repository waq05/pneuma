/**
 * @pneuma/superagent 第 5 步的包级测试：执行器（工作树 + 会话 + worker + 并发）。
 *
 * 十七条用例，每条只钉一件会「悄悄坏掉」的事：
 *   1. `start` 真建了工作树、真按显式路径建了会话，并把工单文本投给 worker；
 *   2. 并发上限生效：同时发 3 个，只起 2 个，第 3 个排队，有人让位才开工；
 *   3. `stop` 调的是「中断回合」而不是杀进程，且重复调不炸；
 *   4. 报告映射：`turn/end` 正常收尾 → `ready`，`error` → `failed`（纯函数直测，不起模型）；
 *   5. 两张全中文标题的工单不会撞同一棵工作树（slug 只留 ASCII，标题会折成 `ticket`）；
 *   6. 临时故障判据：状态码优先、文本兜底、配置错误不能误判；
 *   7. 临时故障退避后用同一会话继续，故障回合不算交付；
 *   8. 临时故障超过 3 次才判 failed；
 *   9. 非临时故障一次都不重试；
 *  10. 准备命令：成功返回输出，非零退出抛错；
 *  11. 准备命令在工作树里跑，失败判 failed 且不建会话；
 *  12. 准备阶段收到停止，准备结束后不再派工；
 *  13. 缺宿主时只记日志不假装成功；
 *  14. `deliver` 只入队，投递 handler 逐条重读工单、按顺序把输入交给 worker；
 *  15. 报告工具报 `blocked`：回合正常结束时不会被改写回 `ready`，问题带在报告上；
 *  16. 报告工具报 `progress`：只是中途进展，回合正常结束仍记 `ready`；
 *  17. 按会话反查不到 worker 时返回 false，工具据此抛错；
 *  18. 系统提示的内置兜底与 `prompts/worker.md` 逐字一致：产物缺 md 时文案不会漂移。
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const { WorkerExecutor, buildWorkerPrompt, worktreeNameOf, turnEndReport, errorReport, transient, runPrepare } =
  await import('../../../../lib/packages/superagent/adapters/executor.js')
const { createReportTool } = await import('../../../../lib/packages/superagent/tools.js')
const { ensureWorktree } = await import('../../../../lib/packages/superagent/adapters/worktree.js')
const { Session } = await import('../../../../lib/core/session.js')

/** 固定时钟：断言只看形状，不看「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

/** 临时目录清单：进程退出时兜底清一遍（每个用例自己也会清）。 */
const roots = []
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 等一个事件循环：`start` 只写一行副作用，真正的派工在 effect 队列的 microtask 里。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 内存版 EffectQueue：同接口、不落库、入队后排一个 microtask 派工。
 *
 * 为什么不直接用真的 `EffectQueue` + 临时库：这 13 条用例测的是执行器的装配与并发，
 * 不是队列本身（队列有 `effects.test.mjs` 专测）。内存版把「持久化」换成一行数组，
 * 语义（同一 key 合并、`limit` 名额、`running.size` 扣减、drain 留行）保持同形，
 * 现有用例的 `await tick()` 之后仍然派工。
 */
class MemoryEffects {
  constructor() {
    /** 等待执行的行；`value` 直接存对象（真队列存 JSON）。 */
    this.rows = []
    this.handlers = new Map()
    this.tasks = new Set()
    this.scheduled = false
    this.started = false
    this.stopped = false
    this.seq = 0
  }

  /** 与真队列的 `ON CONFLICT(kind,key)` 同义：覆盖载荷、generation+1、失败计数清零。 */
  enqueue(kind, key, payload) {
    const row = this.rows.find((item) => item.kind === kind && item.key === key)
    if (row !== undefined) {
      row.value = payload
      row.generation += 1
      row.attempts = 0
      row.due = Date.now()
    } else {
      this.rows.push({ kind, key, value: payload, seq: (this.seq += 1), generation: 0, attempts: 0, due: Date.now() })
    }
    this.kick()
  }

  handle(kind, run, options = {}) {
    if (this.handlers.has(kind)) throw new Error(`${kind} 这个副作用已经有处理器了`)
    const limit = options.limit ?? (() => 1)
    const ordered = options.ordered ?? false
    this.handlers.set(kind, { run, ordered, limit: ordered ? () => Math.min(1, limit()) : limit })
    this.kick()
  }

  /** 这个 kind（或这一行）还有几行在等；用例用它替掉原来的 `queuedCount`。 */
  count(kind) {
    return this.rows.filter((row) => row.kind === kind).length
  }

  pending(kind, key) {
    return this.rows.some((row) => row.kind === kind && (key === undefined || row.key === key))
  }

  cancel(kind, key) {
    this.rows = this.rows.filter((row) => !(row.kind === kind && row.key === key))
  }

  start() {
    this.started = true
    this.kick()
  }

  kick() {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.dispatch()
    })
  }

  dispatch() {
    if (!this.started || this.stopped) return
    for (const [kind, handler] of this.handlers) {
      const running = new Set([...this.tasks].filter((task) => task.kind === kind).map((task) => task.key))
      const rows = this.rows.filter((row) => row.kind === kind).sort((a, b) => a.seq - b.seq)
      const ready = handler.ordered && running.size > 0
        ? []
        : rows.filter((row) => row.due <= Date.now() && !running.has(row.key))
      let room = ready.length > 0 ? handler.limit() - running.size : 0
      for (const row of ready) {
        if (room-- <= 0) break
        this.run(kind, handler, row)
      }
    }
  }

  run(kind, handler, row) {
    const task = { kind, key: row.key, done: Promise.resolve() }
    task.done = (async () => {
      // 失败的行留在原地：用例里派工 handler 自己接住异常，不会走到这一支；
      // 真队列的退避重试由 `effects.test.mjs` 覆盖。
      await handler.run(row.value, row.key)
      this.rows = this.rows.filter((item) => item !== row)
    })().finally(() => {
      this.tasks.delete(task)
      this.kick()
    })
    this.tasks.add(task)
  }

  async idle(kind) {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks].filter((task) => kind === undefined || task.kind === kind).map((task) => task.done)
      if (running.length === 0) return
      await Promise.allSettled(running)
    }
  }

  async drain() {
    this.stopped = true
    await Promise.allSettled([...this.tasks].map((task) => task.done))
  }
}

/**
 * 等一个条件成立，最多等 `timeout` 毫秒。
 *
 * 为什么不用固定 `sleep`：准备命令要真起一个子进程，机器忙的时候几十毫秒不够，
 * 空闲的时候又白等。条件式等待两边都不吃亏。
 */
async function waitFor(condition, timeout = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return condition()
}

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
function fakeHost(jobs, team) {
  const names = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'job_output', 'job_list', 'job_kill', 'subagent', 'superagent_report', 'web_search']
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
    ...(jobs === undefined ? {} : { jobs }),
    ...(team === undefined ? {} : { team }),
  }
}

/**
 * 假作业表：只实现执行器用到的四个动作（list / running / wait / kill），外加两个
 * 测试专用方法（add 造一个在跑的作业，finish 让它结束）。
 *
 * 为什么不用真 `JobTable`：真表要起子进程，用例得等真的 `sleep`；这里要验的是执行器
 * 的等待与终止逻辑，作业是真是假不影响判据。
 */
function fakeJobs() {
  const jobs = new Map()
  let counter = 0
  const service = {
    killed: [],
    list(owner) {
      return [...jobs.values()].filter((job) => owner === undefined || job.owner === owner)
    },
    running(owner) {
      return service.list(owner).filter((job) => job.status === 'running')
    },
    async wait() {
      return true
    },
    kill(id) {
      const job = jobs.get(id)
      if (job === undefined || job.status !== 'running') return false
      job.status = 'killed'
      job.finishedAt = Date.now()
      service.killed.push(id)
      return true
    },
    add(owner) {
      counter += 1
      const id = `job-${String(counter)}`
      jobs.set(id, { id, owner, status: 'running', command: 'pnpm test', startedAt: Date.now(), exitCode: null })
      return id
    },
    finish(id, status = 'completed') {
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`没有作业 ${id}`)
      job.status = status
      job.exitCode = status === 'completed' ? 0 : 1
      job.finishedAt = Date.now()
    },
  }
  return service
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
  // 派工 / 投递的 handler 会重读工单（真执行器走 `readTicket`）：用例把 start 传进来的工单
  // 记一份，读到的就是同一张——与真仓储在 `Tickets.create` 里刚存下的那一版等价。
  // 投递用例还要靠它看「已投递」的进度：`inputsDelivered` 会就地删 `undelivered`，
  // 与真引擎（`core/assignments.ts:48-58`）同一效果。
  const tickets = new Map()
  const engine = {
    assignmentStarted: (id, assignmentId) => {
      events.started.push({ ticketId: id, assignmentId })
      const ticket = tickets.get(id)
      const assignment = ticket?.assignments.find((item) => item.id === assignmentId)
      // 真引擎在这里把分配标成 running（`core/assignments.ts:38`）；投递 handler 只认 running。
      if (assignment !== undefined) assignment.state = 'running'
    },
    report: (id, report) => { events.reports.push({ ticketId: id, report }) },
    turnEnded: (id, assignmentId) => { events.turnEnded.push({ ticketId: id, assignmentId }) },
    inputsDelivered: (id, assignmentId, ids) => {
      events.delivered.push({ ticketId: id, assignmentId, ids })
      const ticket = tickets.get(id)
      if (ticket !== undefined) ticket.undelivered = ticket.undelivered.filter((inputId) => !ids.includes(inputId))
    },
    deliveryFailed: (id, assignmentId, error) => { events.failed.push({ ticketId: id, assignmentId, error }) },
  }

  const queue = new MemoryEffects()

  const executor = new WorkerExecutor(null, {
    host: fakeHost(options.jobs, options.team),
    repo: join(root, 'repo'),
    maxWorkers: options.maxWorkers ?? 2,
    effects: queue,
    readTicket: (id) => tickets.get(id),
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
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.backgroundLimitMs === undefined ? {} : { backgroundLimitMs: options.backgroundLimitMs }),
    ...(options.backgroundPollMs === undefined ? {} : { backgroundPollMs: options.backgroundPollMs }),
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
  })
  // 记工单要在 start 之前：`start` 里只写入队，handler 读工单发生在其后的 microtask。
  const start = executor.start.bind(executor)
  executor.start = (ticket, assignment) => {
    tickets.set(ticket.id, ticket)
    start(ticket, assignment)
  }
  queue.start()

  const cleanup = () => {
    executor.dispose()
    if (previous === undefined) delete process.env.DSC_HOME
    else process.env.DSC_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
  return { root, executor, queue, events, agents, cleanup }
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
    // 会话日志走 `createWriteStream`（`core/session.ts:1356-1368`），建文件是异步的；
    // 固定等一个 tick 偶尔会抢在 open 完成之前（机器忙时尤其明显）。条件式等它落盘，
    // 断言的意思没变：start 之后会话文件必须出现。
    assert.ok(await waitFor(() => existsSync(file)), '会话文件应在 start 之后落盘（钉权限那条状态会写 meta 首行）')

    assert.equal(agent.followups.length, 1, '工单文本应投递一次')
    assert.match(agent.followups[0], /改登录页文案/, '投递内容应带标题')
    assert.match(agent.followups[0], /把错误提示改成中文/, '投递内容应带正文')
  } finally {
    s.cleanup()
  }
})

test('deliver 只入队：投递 handler 逐条重读工单，按顺序把输入交给 worker', async () => {
  const s = setup('deliver')
  try {
    const { ticket, assignment } = makeTicket('0b1c2d3e', '边跑边收消息')
    ticket.inputs.push({ id: 'in-1', kind: 'text', text: '补充一句', at: AT })
    ticket.inputs.push({ id: 'in-2', kind: 'text', text: '再补充一句', at: AT })
    ticket.undelivered.push('in-1', 'in-2')

    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    assert.equal(agent.followups.length, 1, '先投一次工单文本')

    // `deliver` 只写一行 delivery 副作用；真正的 followup 在队列下一拍。
    s.executor.deliver(ticket, assignment)
    assert.equal(s.queue.count('delivery'), 1, 'deliver 应只入队')
    assert.equal(agent.followups.length, 1, '入队那一刻不该已经投出去')

    await s.queue.idle('delivery')
    assert.equal(agent.followups.length, 3, '两条未送达的输入应各投一条消息')
    assert.match(agent.followups[1], /补充一句/)
    assert.match(agent.followups[2], /再补充一句/)
    assert.deepEqual(s.events.delivered.map((item) => item.ids), [['in-1'], ['in-2']], '逐条投递、按顺序记账')
    assert.deepEqual(ticket.undelivered, [], '投完不应再留未送达的输入')
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
    assert.equal(s.queue.count('launch'), 1, '第三个应留在队列里')
    assert.equal(s.agents.length, 2, '只应建两个 agent')

    // 让出一个名额：第三个应立刻补上。
    s.executor.stop(items[0].ticket, items[0].assignment, '腾位')
    await tick()
    assert.equal(s.executor.activeCount, 2, '让位后第三个应开工')
    assert.equal(s.queue.count('launch'), 0)
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

test('系统提示：内置兜底与 prompts/worker.md 逐字一致，产物缺 md 时照样拼得出来', () => {
  const input = {
    title: '改登录页文案',
    body: '把「登录」按钮改成「进入」',
    branch: 'agent/fix-login-8f9a1c69',
    repo: join(tmpdir(), 'repo'),
    dir: join(tmpdir(), 'worktrees', 'fix-login-8f9a1c69'),
    blockedCommands: ['pnpm publish', 'git push'],
  }
  const values = {
    title: input.title,
    body: input.body,
    branch: input.branch,
    repo: input.repo,
    dir: input.dir,
    commands: `除内置禁用之外，以下命令不允许使用：${input.blockedCommands.join('、')}`,
  }
  // 文案真源是**源码树**里的 md（tests/../prompts/worker.md），不是产物里那一份：
  // 拿产物当参照就成了自己跟自己比，构建漏拷也照样绿。
  const template = readFileSync(new URL('../prompts/worker.md', import.meta.url), 'utf8')
  const fromMd = template
    .replace(/^\uFEFF?\s*<!--[\s\S]*?-->/, '')
    .trim()
    .replace(/\{\{(\w+)\}\}/g, (whole, name) => values[name] ?? whole)

  assert.match(fromMd, /^你是超级智能体的执行者，负责一个工单。/, 'md 正文应从定稿第一句开始（文件头注释要剥掉）')
  assert.match(
    fromMd,
    /<工单>[\s\S]*<环境>[\s\S]*<交付要求>[\s\S]*<报告状态>/,
    '三段（工单 / 环境 / 交付要求）与报告状态都应在',
  )

  // 正常路径：读产物里的 prompts/worker.md（构建还没拷 prompts 时会自动落到兜底）。
  assert.equal(buildWorkerPrompt(input).text, fromMd, '运行时拼出的提示词必须与 md 逐字一致')

  // 兜底路径：指向一个不存在的文件，确定性地模拟「产物缺 prompts/worker.md」。
  const missing = join(tmpdir(), `superagent-no-prompt-${process.pid}`, 'worker.md')
  assert.equal(existsSync(missing), false, '这个路径必须不存在，否则测的不是兜底')
  assert.equal(
    buildWorkerPrompt(input, { templatePath: missing }).text,
    fromMd,
    '兜底文案必须与 md 一字不差，否则改一句 md 就悄悄漂移',
  )

  // 认不出的占位符原样保留：拼错名字时模型会看到 {{typo}}，而不是被悄悄替换成空串。
  const dir = mkdtempSync(join(tmpdir(), 'superagent-worker-prompt-'))
  roots.push(dir)
  try {
    const custom = join(dir, 'worker.md')
    writeFileSync(custom, '<!-- 说明 -->\n标题：{{title}}，未知：{{unknown}}\n', 'utf8')
    assert.equal(buildWorkerPrompt(input, { templatePath: custom }).text, '标题：改登录页文案，未知：{{unknown}}')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 段清单保持原样：一段合成段，字数是拼好的正文长度。
  const prompt = buildWorkerPrompt(input)
  assert.deepEqual(prompt.sections, [
    { id: 'superagent-worker', order: 0, chars: prompt.text.length, from: 'plugin:superagent' },
  ])
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

test('临时故障：不立刻判失败，退避后用同一会话继续', async () => {
  const logs = []
  const s = setup('transient-retry', { retryDelayMs: 5, log: (line) => logs.push(line) })
  try {
    const { ticket, assignment } = makeTicket('aa11bb22', '端点抖一下')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    assert.equal(agent.followups.length, 1, '先投一次工单文本')

    // 一回合跑到一半，模型端点报 503。
    agent.deps.emit({ type: 'turn/start' })
    agent.deps.emit({ type: 'error', message: 'upstream returned 503' })
    // 故障回合的收尾：不该把工单判死。
    agent.deps.emit({ type: 'turn/end', reason: 'error' })

    assert.equal(s.events.reports.length, 0, '临时故障不该立刻报 failed')
    assert.match(logs.join('\n'), /临时故障.*5ms 后第 1 次重试/)

    // 退避到点：同一会话再投一句「继续」。
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(agent.followups.length, 2, '应投一次「继续」')
    assert.match(agent.followups[1], /临时故障.*从中断处继续/)
    assert.equal(s.agents.length, 1, '不该新建会话')

    // 重试那一回合干净跑完 → ready。
    agent.deps.emit({ type: 'turn/start' })
    agent.deps.emit({ type: 'message', text: '改完了，测试通过' })
    agent.deps.emit({ type: 'turn/end', reason: 'completed' })
    assert.equal(s.events.reports.length, 1, '重试成功后应只有一条报告')
    assert.equal(s.events.reports[0].report.state, 'ready')
  } finally {
    s.cleanup()
  }
})

test('临时故障超过 3 次：判 failed；非临时故障一次都不重试', async () => {
  const s = setup('transient-exhaust', { retryDelayMs: 1 })
  try {
    const { ticket, assignment } = makeTicket('cc33dd44', '一直抖')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]

    // 前三次：都安排重试，一条 failed 都不报。
    for (let round = 1; round <= 3; round += 1) {
      agent.deps.emit({ type: 'turn/start' })
      agent.deps.emit({ type: 'error', message: 'read ECONNRESET' })
      agent.deps.emit({ type: 'turn/end', reason: 'error' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(s.events.reports.length, 0, `第 ${round} 次临时故障不该报 failed`)
    }

    // 第四次：超过上限，判 failed。
    agent.deps.emit({ type: 'turn/start' })
    agent.deps.emit({ type: 'error', message: 'read ECONNRESET' })
    agent.deps.emit({ type: 'turn/end', reason: 'error' })
    assert.equal(s.events.reports.length, 1, '超过上限应报一条 failed')
    assert.equal(s.events.reports[0].report.state, 'failed')
  } finally {
    s.cleanup()
  }
})

test('非临时故障立刻判 failed，不进重试', async () => {
  const s = setup('transient-not')
  try {
    const { ticket, assignment } = makeTicket('ee55ff66', '配置错了')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    agent.deps.emit({ type: 'turn/start' })
    agent.deps.emit({ type: 'error', message: '没有配置仓库路径（设置 → Super Agent → repoPath）' })
    assert.equal(s.events.reports.length, 1, '配置错误要立刻报，不能白等退避')
    assert.equal(s.events.reports[0].report.state, 'failed')
  } finally {
    s.cleanup()
  }
})

test('准备命令：成功返回输出，非零退出抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-prepare-'))
  roots.push(dir)
  try {
    const out = await runPrepare('echo prepared-ok', dir, 5000)
    assert.match(out, /prepared-ok/, '应返回命令输出')

    await assert.rejects(() => runPrepare('exit 3', dir, 5000), /准备命令退出码 3/, '非零退出要抛错')
    await assert.rejects(
      () => runPrepare('definitely-not-a-command-xyz', dir, 5000),
      /准备命令退出码/,
      '命令不存在也要抛错，不能当成成功',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('准备命令在工作树里跑；失败判 failed 且不建会话', async () => {
  const ok = setup('prepare-ok', { prepare: 'echo marker > prepared.txt' })
  try {
    const { ticket, assignment } = makeTicket('1234abcd', '先装依赖')
    ok.executor.start(ticket, assignment)
    // launch 现在要等准备命令跑完，条件式等它起 worker。
    await waitFor(() => ok.agents.length === 1)

    const dir = join(ok.root, 'worktrees', worktreeNameOf(ticket))
    assert.ok(existsSync(join(dir, 'prepared.txt')), '准备命令应在工作树目录里执行')
    assert.equal(ok.agents.length, 1, '准备成功后应起 worker')
    assert.equal(ok.events.reports.length, 0, '准备成功不该报 failed')
  } finally {
    ok.cleanup()
  }

  const bad = setup('prepare-bad', { prepare: 'exit 7' })
  try {
    const { ticket, assignment } = makeTicket('5678cdef', '装不上依赖')
    bad.executor.start(ticket, assignment)
    await waitFor(() => bad.events.reports.length === 1)

    assert.equal(bad.agents.length, 0, '准备失败不该起 worker')
    assert.equal(bad.events.reports.length, 1, '准备失败要报一条 failed')
    assert.equal(bad.events.reports[0].report.state, 'failed')
    assert.match(bad.events.reports[0].report.summary, /准备命令退出码 7/, '摘要要说清是准备命令挂了')
  } finally {
    bad.cleanup()
  }
})

test('准备阶段收到停止：准备结束后不再派工', async () => {
  // 一条跑 300ms 的命令，给我们时间在 await 中间调 stop。
  const s = setup('prepare-stop', { prepare: 'node -e "setTimeout(() => {}, 300)"' })
  try {
    const { ticket, assignment } = makeTicket('9abcdef0', '准备到一半被停')
    s.executor.start(ticket, assignment)
    await tick()
    s.executor.stop(ticket, assignment, '用户停止')

    // 等准备命令跑完（300ms）+ 一点余量，确认没有 worker 起来。
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(s.agents.length, 0, '停止之后准备结束也不该起 worker')
    assert.equal(s.events.reports.length, 0, '停止是正常收口，不该报 failed')
  } finally {
    s.cleanup()
  }
})

test('没有宿主上下文时 start 只记缺项日志，不假装成功', () => {
  const lines = []
  const queue = new MemoryEffects()
  const executor = new WorkerExecutor(null, { log: (line) => lines.push(line), effects: queue })
  const { ticket, assignment } = makeTicket('deadbeef', '没有宿主')
  executor.start(ticket, assignment)

  assert.equal(executor.activeCount, 0, '缺宿主时不该起 worker')
  assert.equal(queue.count('launch'), 0, '缺宿主时也不该入队假装会派出去')
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

/**
 * 报告工具的一次调用上下文。
 *
 * 用真 `Session` 的 `meta.id` 当 `sessionId`：生产里 `ToolContext.sessionId` 就是它
 * （`session-core/loop.ts:711-713`），用别的值测不出「按会话反查 worker」这条链路。
 */
function reportContextOf(agent) {
  return {
    cwd: agent.session.meta.cwd,
    sessionId: agent.session.meta.id,
    sessionPath: agent.session.filePath,
    signal: new AbortController().signal,
  }
}

test('worker 工具目录：有三件作业工具，不含主会话才有的 web_search', async () => {
  const s = setup('worker-tools')
  try {
    const { ticket, assignment } = makeTicket('7a1b2c3e', '工具目录')
    s.executor.start(ticket, assignment)
    await tick()
    const names = s.executor.tools().map((entry) => entry.name)
    // 三件作业工具必须有：bash 的 run_in_background 对 worker 同样开着，
    // 起了作业却读不到输出等于把长活锁死（backlog G3）。
    for (const name of ['job_output', 'job_list', 'job_kill']) {
      assert.ok(names.includes(name), `worker 的工具目录里要有 ${name}`)
    }
    // 主会话能力不能漏进来：固定名单做减法，注册表里有什么都不影响结果。
    assert.ok(!names.includes('web_search'), 'worker 不该拿到 web_search')
  } finally {
    s.cleanup()
  }
})

test('报告工具报 blocked：回合正常结束时不再改写回 ready，问题带在报告上', async () => {
  const s = setup('report-blocked')
  try {
    const { ticket, assignment } = makeTicket('7a1b2c3d', '要人拍板')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    assert.ok(
      s.executor.tools().some((entry) => entry.name === 'superagent_report'),
      'worker 的工具目录里要有报告工具',
    )
    const tool = createReportTool({ report: (sessionId, report) => s.executor.reportBySession(sessionId, report) })
    const context = reportContextOf(agent)

    agent.deps.emit({ type: 'turn/start' })
    const result = await tool.run({ state: 'blocked', summary: '两个方案都行，要人挑一个', question: '用方案 A 还是 B？' }, context)
    assert.match(result, /已报 blocked/, '工具要给模型一句可读的回执')

    // 工具调用当场就写引擎：人不必等回合结束才知道 worker 卡住了。
    assert.equal(s.events.reports.length, 1, '调用报告工具应立刻写一条报告')
    assert.equal(s.events.reports[0].report.state, 'blocked')
    assert.equal(s.events.reports[0].report.question, '用方案 A 还是 B？', 'question 要原样带进报告')

    // 回合照常收尾：不能再补一条 ready。
    agent.deps.emit({ type: 'message', text: '（正文里也提了一句，但它不算数）' })
    agent.deps.emit({ type: 'turn/end', reason: 'completed' })
    const states = s.events.reports.map((item) => item.report.state)
    assert.deepEqual(states, ['blocked'], `blocked 之后不该再出现 ready，实际：${states.join(' → ')}`)
  } finally {
    s.cleanup()
  }
})

test('报告工具报 progress：只是中途进展，回合正常结束仍记 ready', async () => {
  const s = setup('report-progress')
  try {
    const { ticket, assignment } = makeTicket('8b2c3d4e', '报个进度')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    const tool = createReportTool({ report: (sessionId, report) => s.executor.reportBySession(sessionId, report) })
    const context = reportContextOf(agent)

    agent.deps.emit({ type: 'turn/start' })
    await tool.run({ state: 'progress', summary: '改到一半，测试还没跑' }, context)
    assert.equal(s.events.reports.length, 1)
    assert.equal(s.events.reports[0].report.state, 'progress')

    // progress 不进终态：回合正常收尾时必须再报一次 ready，否则工单永远停在中途。
    agent.deps.emit({ type: 'message', text: '改完了，测试通过' })
    agent.deps.emit({ type: 'turn/end', reason: 'completed' })
    const states = s.events.reports.map((item) => item.report.state)
    assert.deepEqual(states, ['progress', 'ready'], `progress 之后应补一条 ready，实际：${states.join(' → ')}`)
    assert.equal(s.events.reports[1].report.summary, '改完了，测试通过', 'ready 的摘要取最后一段正文')
  } finally {
    s.cleanup()
  }
})

test('按会话找不到 worker 时返回 false，报告工具据此抛错', async () => {
  const s = setup('report-unknown')
  try {
    const { ticket, assignment } = makeTicket('9c3d4e5f', '不在 worker 会话里')
    s.executor.start(ticket, assignment)
    await tick()

    // 有 worker 在跑，但这条会话 id 不是它的：执行器必须说「不是我的会话」。
    assert.equal(
      s.executor.reportBySession('not-a-worker-session', { state: 'progress', summary: 'x' }),
      false,
      '找不到会话应返回 false',
    )

    const tool = createReportTool({ report: (sessionId, report) => s.executor.reportBySession(sessionId, report) })
    const outsider = {
      cwd: s.root,
      sessionId: 'not-a-worker-session',
      sessionPath: join(s.root, 'nowhere.jsonl'),
      signal: new AbortController().signal,
    }
    await assert.rejects(
      () => tool.run({ state: 'blocked', summary: 'x', question: 'y' }, outsider),
      /只在 Super Agent 的 worker 会话里可用/,
      '工具要把 false 翻译成一句模型看得懂的话',
    )
    assert.equal(s.events.reports.length, 0, '找不到 worker 时一条报告都不该写')
  } finally {
    s.cleanup()
  }
})

// ── G3：回合结束后的后台作业 ─────────────────────────────────────────────────
//
// 对齐上游 `executor/dsh.ts:629-656`：回合结束后还有作业在跑就先不报交付，等作业静默；
// 静默后唤醒 worker 去读输出；到 30 分钟还在跑就杀掉并报 waiting；停工单时一并杀。

test('回合结束还有后台作业：先不报交付，作业结束再唤醒 worker', async () => {
  const jobs = fakeJobs()
  const s = setup('bg-wait', { jobs, backgroundPollMs: 20 })
  try {
    const { ticket, assignment } = makeTicket('7a1b2c41', '等后台作业')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    const jobId = jobs.add(agent.session.meta.id)

    agent.deps.emit({ type: 'turn/start' })
    agent.deps.emit({ type: 'message', text: '构建已经转到后台' })
    agent.deps.emit({ type: 'turn/end', reason: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(s.events.reports.length, 0, '作业还在跑，不该报 ready')

    // 作业结束：唤醒 worker 去读输出，而不是由这里报交付。
    jobs.finish(jobId)
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(s.events.reports.length, 0, '唤醒 worker 之后也不该由这里报交付')
    assert.equal(agent.followups.length, 2, '派工的工单文本 + 作业结束通知')
    assert.match(agent.followups[1], /job-1/, '通知要写明是哪个作业')
    assert.match(agent.followups[1], /job_output/, '通知要告诉它怎么读输出')
  } finally {
    s.cleanup()
  }
})

test('等作业期间 worker 起了新回合：旧等待中止，不再唤醒', async () => {
  const jobs = fakeJobs()
  const s = setup('bg-interrupt', { jobs, backgroundPollMs: 20 })
  try {
    const { ticket, assignment } = makeTicket('7a1b2c42', '等待被打断')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    const jobId = jobs.add(agent.session.meta.id)

    agent.deps.emit({ type: 'turn/start' })
    agent.deps.emit({ type: 'turn/end', reason: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(s.events.reports.length, 0, '作业还在跑，不该报 ready')

    // 新回合起来：旧的等待到此为止，它不该再去唤醒 worker。
    agent.deps.emit({ type: 'turn/start' })
    jobs.finish(jobId)
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(agent.followups.length, 1, '中止的等待不该再唤醒 worker')
    assert.equal(s.events.reports.length, 0, '新回合还没结束，不该有报告')
  } finally {
    s.cleanup()
  }
})

test('后台作业跑过上限：杀掉并报 waiting，摘要写明是哪几个', async () => {
  const jobs = fakeJobs()
  const s = setup('bg-limit', { jobs, backgroundLimitMs: 60, backgroundPollMs: 10 })
  try {
    const { ticket, assignment } = makeTicket('7a1b2c43', '作业跑过头')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    const jobId = jobs.add(agent.session.meta.id)

    agent.deps.emit({ type: 'turn/start' })
    agent.deps.emit({ type: 'message', text: '还没跑完' })
    agent.deps.emit({ type: 'turn/end', reason: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.equal(s.events.reports.length, 1, '到点要报一条')
    assert.equal(s.events.reports[0].report.state, 'waiting', '报的是 waiting 而不是 ready')
    assert.match(s.events.reports[0].report.summary, /job-1/, '摘要要写明杀的是哪个作业')
    assert.deepEqual(jobs.killed, [jobId], '到点的作业要真的被终止')
  } finally {
    s.cleanup()
  }
})

test('停工单：它的后台作业一并终止', async () => {
  const jobs = fakeJobs()
  const s = setup('bg-stop', { jobs, backgroundPollMs: 20 })
  try {
    const { ticket, assignment } = makeTicket('7a1b2c44', '停工单收作业')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]
    const jobId = jobs.add(agent.session.meta.id)

    s.executor.stop(ticket, assignment, '用户停止')
    assert.deepEqual(jobs.killed, [jobId], '工单停了，作业不该继续跑')
  } finally {
    s.cleanup()
  }
})

// G6：worker 派出去的队友在工单停下之后没人认领（父会话已停），所以要一并收掉。
// 上游同一步是 `stopSubagents`（`executor/background.ts:141-153`）。
test('停工单：它派出去的队友一并收掉', async () => {
  const stopped = []
  const team = {
    stopBySession: async (sessionId) => {
      stopped.push(sessionId)
      return ['explorer-1']
    },
  }
  const s = setup('team-stop', { team })
  try {
    const { ticket, assignment } = makeTicket('7a1b2c45', '停工单收队友')
    s.executor.start(ticket, assignment)
    await tick()
    const agent = s.agents[0]

    s.executor.stop(ticket, assignment, '用户停止')
    await tick()
    assert.deepEqual(stopped, [agent.session.meta.id], '要按 worker 会话 id 收队友')
  } finally {
    s.cleanup()
  }
})
