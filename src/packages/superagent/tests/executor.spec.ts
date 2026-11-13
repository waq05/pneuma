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
 * 迁移说明：原文件 import `lib/` 构建产物；现在直接 import 源码，不再要求先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/executor
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Assignment, Ticket } from '../core/model.js'
import type { WorkerAgent, WorkerHost } from '../adapters/executor.js'
import type { EngineForExecutor } from '../core/index.js'

const { WorkerExecutor, worktreeNameOf, turnEndReport, errorReport } =
  await import('../adapters/executor.js')
const { ensureWorktree } = await import('../adapters/worktree.js')
const { Session } = await import('../../../core/session.js')

/** 固定时钟：断言只看形状，不看「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

/** 临时目录清单：进程退出时兜底清一遍（每个用例自己也会清）。 */
const roots: string[] = []
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 等一个事件循环：`start` 只入队，真正的派工在 microtask 里。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 32 位十六进制，与 `core/ids.ts` 的 `key()` 同形，能被 `sessionsDir` 的校验接受。 */
function ticketId(seed: string): string {
  return seed.repeat(32).slice(0, 32)
}

/** 一张最小工单：执行器只读 id / title / origin / inputs / undelivered。 */
function makeTicket(seed: string, title: string): { ticket: Ticket; assignment: Assignment } {
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
  return { ticket: ticket as unknown as Ticket, assignment: assignment as unknown as Assignment }
}

/** 假宿主：模型不会被调用，工具只要名字对得上，守卫一律 defer。 */
function fakeHost(): WorkerHost {
  const names = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search']
  const tools = names.map((name) => ({ name, description: name, inputSchema: {}, risk: 'read', run: async () => '' }))
  const host = {
    llm: {
      route: () => ({ provider: 'fake', model: 'fake', api: 'fake' }),
      routeTo: () => ({ provider: 'fake', model: 'fake', api: 'fake' }),
      stream: async () => {
        throw new Error('包级测试不调用模型')
      },
    },
    tools: { list: () => tools },
    guards: { gate: async () => ({ action: 'defer' }), observe: (_name: string, text: string) => text },
  }
  // 假宿主只实现执行器会碰到的面；真实 WorkerHost 的端口更多。
  return host as unknown as WorkerHost
}

/** 假 agent 的形状（执行器只调 followup / cancel / isRunning）。 */
interface FakeAgent {
  deps: unknown
  session: ReturnType<typeof Session.create>
  followups: string[]
  cancels: number
  isRunning: boolean
  followup(text: string): void
  cancel(): void
}

/** 执行器回调记录。 */
interface ExecutorEvents {
  ensured: Array<{ repo: string; name: string }>
  started: Array<{ ticketId: string; assignmentId: string }>
  reports: Array<{ ticketId: string; report: unknown }>
  delivered: Array<{ ticketId: string; assignmentId: string; ids: string[] }>
  turnEnded: Array<{ ticketId: string; assignmentId: string }>
  failed: Array<{ ticketId: string; assignmentId: string; error: unknown }>
}

/** 一套执行器夹具。 */
interface ExecutorFixture {
  root: string
  executor: InstanceType<typeof WorkerExecutor>
  events: ExecutorEvents
  agents: FakeAgent[]
  cleanup: () => void
}

/**
 * 装一套执行器：假宿主 + 假工作树 + 真会话（只写文件，不发请求）+ 假 agent。
 *
 * 用真 `Session` 是为了让「会话文件有没有落盘」这条断言有真对象可查：执行器钉权限时
 * 写的那条 `permissions` 状态会顺带写出 meta 首行（`core/session.ts:1327-1352`）。
 */
function setup(label: string, options: { maxWorkers?: number; log?: (line: string) => void } = {}): ExecutorFixture {
  const root = mkdtempSync(join(tmpdir(), `superagent-executor-${label}-`))
  roots.push(root)
  const previous = process.env['DSC_HOME']
  process.env['DSC_HOME'] = root

  const events: ExecutorEvents = { ensured: [], started: [], reports: [], delivered: [], turnEnded: [], failed: [] }
  const agents: FakeAgent[] = []
  const engine = {
    assignmentStarted: (id: string, assignmentId: string) => {
      events.started.push({ ticketId: id, assignmentId })
    },
    report: (id: string, report: unknown) => {
      events.reports.push({ ticketId: id, report })
    },
    turnEnded: (id: string, assignmentId: string) => {
      events.turnEnded.push({ ticketId: id, assignmentId })
    },
    inputsDelivered: (id: string, assignmentId: string, ids: string[]) => {
      events.delivered.push({ ticketId: id, assignmentId, ids })
    },
    deliveryFailed: (id: string, assignmentId: string, error: unknown) => {
      events.failed.push({ ticketId: id, assignmentId, error })
    },
  }

  const executor = new WorkerExecutor(null, {
    host: fakeHost(),
    repo: join(root, 'repo'),
    maxWorkers: options.maxWorkers ?? 2,
    worktree: {
      ensure(input: { repo: string; name: string }) {
        events.ensured.push({ repo: input.repo, name: input.name })
        const path = join(root, 'worktrees', input.name)
        mkdirSync(path, { recursive: true })
        return { path, branch: `agent/${input.name}`, created: true }
      },
    },
    createSession: (cwd: string, file: string) => Session.create(cwd, file),
    createAgent: (_deps, session) => {
      const agent: FakeAgent = {
        deps: _deps,
        session,
        followups: [],
        cancels: 0,
        isRunning: false,
        followup(text: string) {
          this.followups.push(text)
          // 真 MiniAgent 的 followup 会 appendUser，会话文件就是在那一刻落盘的
          //（`core/session.ts:1327-1352`）。假 agent 照做，文件断言才测的是真链路。
          this.session.appendUser(text)
        },
        cancel() {
          this.cancels += 1
        },
      }
      agents.push(agent)
      return agent as unknown as WorkerAgent
    },
    engine: () => engine as unknown as EngineForExecutor,
    log: options.log ?? (() => {}),
    readTriggerText: () => '把错误提示改成中文',
  })

  const cleanup = (): void => {
    executor.dispose()
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
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

    expect(s.events.ensured.length, '应恰好建一次工作树').toBe(1)
    expect(s.events.ensured[0].repo).toBe(join(s.root, 'repo'))
    expect(
      s.events.ensured[0].name.endsWith(`-${ticket.id.slice(0, 8)}`),
      `工作树名要带工单 id 后缀，实际：${s.events.ensured[0].name}`,
    ).toBe(true)

    expect(s.agents.length, '应恰好起一个 worker').toBe(1)
    const agent = s.agents[0]
    expect(s.events.started.length, '应回调一次 assignmentStarted').toBe(1)
    expect(s.events.started[0]).toStrictEqual({ ticketId: ticket.id, assignmentId: assignment.id })

    const file = agent.session.filePath
    expect(
      file.startsWith(join(s.root, 'superagent', 'sessions', ticket.id)),
      `会话要落在 sessionsDir(ticket.id) 下，实际：${file}`,
    ).toBe(true)
    expect(file.endsWith('.jsonl'), `会话文件应是 jsonl，实际：${file}`).toBe(true)
    expect(existsSync(file), '会话文件应在 start 之后落盘（钉权限那条状态会写 meta 首行）').toBe(true)

    expect(agent.followups.length, '工单文本应投递一次').toBe(1)
    expect(agent.followups[0], '投递内容应带标题').toMatch(/改登录页文案/)
    expect(agent.followups[0], '投递内容应带正文').toMatch(/把错误提示改成中文/)
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

    expect(s.executor.activeCount, '并发上限 2：只能起两个').toBe(2)
    expect(s.executor.queuedCount, '第三个应排队').toBe(1)
    expect(s.agents.length, '只应建两个 agent').toBe(2)

    // 让出一个名额：第三个应立刻补上。
    s.executor.stop(items[0].ticket, items[0].assignment, '腾位')
    await tick()
    expect(s.executor.activeCount, '让位后第三个应开工').toBe(2)
    expect(s.executor.queuedCount).toBe(0)
    expect(s.agents.length, '第三个 agent 应已建出来').toBe(3)
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
    expect(agent.cancels, '刚开工时不该自己中断').toBe(0)

    s.executor.stop(ticket, assignment, '用户停止')
    expect(agent.cancels, 'stop 应调用一次 cancel（中断回合，不杀进程）').toBe(1)

    expect(() => s.executor.stop(ticket, assignment, '再说一次'), '重复 stop 不应抛错').not.toThrow()
    expect(agent.cancels, '重复 stop 不应再次中断').toBe(1)
    expect(s.executor.activeCount, '停止后不再占并发名额').toBe(0)
  } finally {
    s.cleanup()
  }
})

test('报告映射：turn/end 正常收尾 → ready，error → failed', () => {
  expect(turnEndReport('completed', '改了 a.ts（+1/−0）\n测试：通过')).toStrictEqual({
    state: 'ready',
    summary: '改了 a.ts（+1/−0）\n测试：通过',
  })

  expect(errorReport('模型请求超时')).toStrictEqual({ state: 'failed', summary: '模型请求超时' })
  expect(turnEndReport('error', '半截正文', '模型请求超时')).toStrictEqual({
    state: 'failed',
    summary: '模型请求超时',
  })

  // 主动停止 / 被打断不往已结束的分配上补报告。
  expect(turnEndReport('aborted', '半截正文')).toBeNull()
  expect(turnEndReport('completed', '收尾', undefined, true)).toBeNull()
})

test('没有宿主上下文时 start 只记缺项日志，不假装成功', () => {
  const lines: string[] = []
  const executor = new WorkerExecutor(null, { log: (line: string) => lines.push(line) })
  const { ticket, assignment } = makeTicket('deadbeef', '没有宿主')
  executor.start(ticket, assignment)

  expect(executor.activeCount, '缺宿主时不该起 worker').toBe(0)
  expect(executor.queuedCount, '缺宿主时也不该排进队列假装会派出去').toBe(0)
  expect(lines.length, `应只有构造与 start 各一条日志，实际：${lines.join(' | ')}`).toBe(2)
  expect(lines[0], '构造时就该说清楚缺什么').toMatch(/执行器未接宿主（缺 cordis Context）/)
  expect(lines[1], 'start 的日志要说清「缺什么、所以没起」').toMatch(/停在待派工.*cordis Context.*没有启动 worker/)
  executor.dispose()
})

test('两个全中文标题的工单得到两个不同的工作树', () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-executor-worktree-'))
  roots.push(root)
  try {
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    const git = (args: string[]): void => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
      expect(result.status, `git ${args.join(' ')} 失败：${result.stderr || result.error?.message || ''}`).toBe(0)
    }
    git(['init', '-q'])
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-qm', 'init'])

    // 同一个中文标题，只靠工单 id 区分——正是 slug 折成 `ticket` 时最容易踩的坑。
    const first = { id: ticketId('a'), title: '改登录页文案' }
    const second = { id: ticketId('b'), title: '改登录页文案' }
    const firstName = worktreeNameOf(first)
    const secondName = worktreeNameOf(second)
    expect(firstName, '两张工单的工作树名必须不同').not.toBe(secondName)

    const worktreeRoot = join(root, 'worktrees')
    const a = ensureWorktree({ repo, name: firstName, root: worktreeRoot })
    const b = ensureWorktree({ repo, name: secondName, root: worktreeRoot })
    expect(a.created, '第一棵应是新建的').toBe(true)
    expect(b.created, '第二棵应是新建的，不是复用第一棵').toBe(true)
    expect(a.path, '两棵树不能是同一目录').not.toBe(b.path)
    expect(a.branch, '两个分支不能同名').not.toBe(b.branch)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
