/**
 * @pneuma/superagent `executor/background.js` 的包级测试：worker 回合结束后的后台静默等待
 * （shell 作业 + 子智能体）、到点收集作业、停工单收作业与收队友。
 *
 * 转写自上游 `tests/background.spec.ts`（5 条）。本仓是原生重写，上游依赖的 DSH 服务换成了
 * 本仓原生栈，所以每条都在注释里标了对应关系与差异：
 *
 * | 上游 | 本仓原生 | 本测试怎么落 |
 * | --- | --- | --- |
 * | `ctx.get('jobs')` 的 `list` / `wait` / `kill` / `events.subscribe` | `ctx.get('jobs')` 的 `list` / `wait` / `kill`（没有事件订阅） | 作业表用假件，`list` 调用次数就是「复查了几次」 |
 * | `ctx.get('subagents')` 的 `waitForChildren` / `listChildren` / `drainChildren` | `ctx.get('team')` 的 `list` / `stopBySession`（没有等子智能体结束的等待口） | 名册用假件，`list` 调用次数就是「轮询了几拍」 |
 * | `agent.status` / `agent.cancel({kind}, {keepInbox})` | 本仓 `SessionHandle.status` / `cancel({kind, keepInbox})` | worker 句柄用对象字面量，记录 `cancel` 的入参 |
 *
 * 上游第 4 条（`waitForChildren` 只 join 一次）在本仓没有等价断言：本仓删掉了 `joins` 去重，
 * 轮询可取消、两次 look 各轮询各的。这里改成钉「本仓原生等价」——两次 look 各看一眼名册、
 * 各自被取消，反向锁住「没有共享 join」这件事。
 *
 * 上游第 5 条用 `vi.useFakeTimers` 把 10 秒快进；这里用 `node:test` 的 `t.mock.timers` 照做。
 *
 * 全程不碰真作业表 / 真队友 / 真模型；这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/background
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { cancelled, collectJob, killJobs, runningJobs, stopBackground, stopSubagents, until, untilQuiet } =
  await import('../../../../lib/packages/superagent/executor/background.js')
const { drain, makeAgent, makeCtx, makeJobs, makeTeam, tick } = await import('./fixtures-background.mjs')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 1. 静默判定 ─────────────────────────────────────────────────────────────

test('作业结束把 worker 吵醒时不算静默：本轮取到的 payload 让下一拍再看', async () => {
  // 上游第 1 条：waitForChildren 里 jobs.end(id) 让 worker 变 running，look 必须返回 false。
  // 本仓没有事件订阅，等价物是 jobsEnd 的 wait 返回后复查；同样在复查时看到 status 不是 idle。
  const agent = makeAgent()
  const jobs = makeJobs()
  const id = jobs.run(agent.id, 'pnpm test')
  jobs.wait = async (jobId) => {
    jobs.end(jobId)
    agent.status = 'running'
    return true
  }
  assert.equal(await untilQuiet(makeCtx({ jobs }), agent, new AbortController().signal), false)
  assert.equal(jobs.get(id).status, 'completed', '作业确实在这一轮结束了')
  passed += 1
})

test('宿主停机时不再等永远不会结束的子智能体', async () => {
  // 上游第 2 条：waitForChildren 永不返回，宿主 abort 后 untilQuiet 必须给出 false。
  // 本仓 childrenEnd 是 250ms 轮询，abort 后下一次轮询直接认出「信号已中止」。
  const agent = makeAgent()
  let sawRoster
  const polled = new Promise((resolve) => { sawRoster = resolve })
  const team = {
    list() {
      sawRoster()
      return [{ sessionId: agent.id, state: 'working' }]
    },
    stopBySession: async () => [],
  }
  const stop = new AbortController()
  const quiet = untilQuiet(makeCtx({ team }), agent, stop.signal)
  await polled
  stop.abort()
  assert.equal(await quiet, false)
  passed += 1
})

test('作业只在结束时被复查一次，不随输出重复看表', async () => {
  // 上游第 3 条：100 行输出不触发 list，作业结束才复查。
  // 本仓 jobs 没有输出事件（上游订阅 settled/removed），所以「输出」在这里根本不经过被测模块：
  // 等价断言是「wait 挂着的时候 list 不增长，end 之后才增长」。
  const agent = makeAgent()
  const jobs = makeJobs()
  const id = jobs.run(agent.id, 'pnpm test')
  const quiet = untilQuiet(makeCtx({ jobs }), agent, new AbortController().signal)
  await tick()
  const looked = jobs.listCalls.length
  assert.equal(looked, 1, '看一眼确认有在跑的作业')
  await tick()
  assert.equal(jobs.listCalls.length, looked, '没有作业结束就不再复查')
  jobs.end(id)
  assert.equal(await quiet, true)
  assert.ok(jobs.listCalls.length > looked, '作业结束后才复查')
  passed += 1
})

test('两次 look 各自轮询子智能体、各自被取消（本仓原生等价：没有上游的 joins 去重）', async () => {
  // 上游第 4 条断言 waitForChildren 只调一次（DSH 不能取消 join，所以用 joins 去重）。
  // 本仓把等待改成可取消的轮询，joins 随之删除；这里反向钉住「两次 look 互不共享」。
  const agent = makeAgent()
  const team = makeTeam([{ sessionId: agent.id, state: 'working' }])
  const ctx = makeCtx({ team })
  const first = new AbortController()
  const second = new AbortController()
  const a = untilQuiet(ctx, agent, first.signal)
  const b = untilQuiet(ctx, agent, second.signal)
  await tick()
  assert.ok(team.listCalls >= 2, '两次 look 各看一眼名册，没有共享的 join')
  first.abort()
  second.abort()
  assert.deepEqual([await a, await b], [false, false])
  passed += 1
})

// ── 2. 停工 ────────────────────────────────────────────────────────────────

test('子智能体 10 秒收不掉就放弃等待，并取消被唤醒的回合', async (t) => {
  // 上游第 5 条：drainChildren 不结束，9.999s 时还没停，10s 到点后停止并取消回合。
  // 本仓 stopSubagents 同样用 DRAIN_LIMIT_MS=10_000 兜底，cancelled 记下「这次 idle 属于停工」。
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = makeAgent('worker-t1', 'running')
  const team = makeTeam([{ sessionId: agent.id, state: 'working' }])
  team.stopBySession = (sessionId) => {
    team.stopped.push(sessionId)
    return new Promise(() => {})
  }
  let stopped = false
  const stopping = stopSubagents(makeCtx({ team }), agent).then(() => { stopped = true })
  try {
    await drain()
    t.mock.timers.tick(9_999)
    await drain()
    assert.equal(stopped, false, '差 1 毫秒还在等')
    t.mock.timers.tick(1)
    await stopping
  } finally {
    t.mock.timers.reset()
  }
  assert.deepEqual(team.stopped, ['worker-t1'], '收的是这个 worker 的队友')
  assert.deepEqual(agent.cancels, [{ kind: 'user', keepInbox: false }], '收完要取消被队友结束叫醒的回合')
  assert.equal(cancelled.has(agent), true, '记下这次 idle 属于这次停工（本仓原生等价）')
  passed += 1
})

test('until：工作先到给结果，信号中止或超时给 false（本仓原生补充）', async () => {
  // 上游没有单独测这个辅助函数；untilQuiet / stopSubagents 全靠它，这里单独钉住三种出口。
  assert.equal(await until(Promise.resolve(7)), 7)
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(await until(new Promise(() => {}), aborted.signal), false)
  assert.equal(await until(new Promise(() => {}), undefined, 5), false)
  passed += 1
})

test('killJobs：只杀本会话在跑的作业（除了 except），并等每个收尾', async () => {
  const jobs = makeJobs({ waitMode: 'immediate' })
  const first = jobs.run('worker-t1', 'pnpm test')
  const kept = jobs.run('worker-t1', 'pnpm lint')
  const other = jobs.run('worker-t2', 'pnpm build')
  await killJobs(makeCtx({ jobs }), 'worker-t1', '工单结束', new Set([kept]))
  assert.deepEqual(jobs.killed, [first], '只杀不属于 except 的那个')
  assert.equal(jobs.get(kept).status, 'running', 'except 的作业（留给人的）不动')
  assert.equal(jobs.get(other).status, 'running', '别的会话的作业不动')
  passed += 1
})

test('killJobs：一个作业杀不掉不影响别的，最后抛 AggregateError 带原因', async () => {
  const jobs = makeJobs({ waitMode: 'immediate' })
  const first = jobs.run('worker-t1', 'pnpm test')
  const second = jobs.run('worker-t1', 'pnpm lint')
  const kill = jobs.kill
  jobs.kill = (id) => {
    if (id === second) throw new Error('kill 失败')
    return kill(id)
  }
  await assert.rejects(killJobs(makeCtx({ jobs }), 'worker-t1', '工单结束'), (error) =>
    error instanceof AggregateError &&
    error.message === 'Killing the shell jobs of worker-t1 failed' &&
    error.errors[0].message === 'kill 失败')
  assert.deepEqual(jobs.killed, [first], '前一个作业照杀')
  passed += 1
})

test('collectJob：作业结束后带回名字与状态；中止或作业表清空时给 undefined', async () => {
  const jobs = makeJobs()
  const id = jobs.run('worker-t1', 'sleep 10\n第二行')
  const job = { id, name: `${id} (sleep 10)` }
  const ended = collectJob(makeCtx({ jobs }), 'worker-t1', job, new AbortController().signal)
  await tick()
  jobs.end(id, 'completed')
  assert.deepEqual(await ended, { name: job.name, status: 'completed' })

  const pendingId = jobs.run('worker-t1', 'sleep 20')
  const abort = new AbortController()
  const aborted = collectJob(makeCtx({ jobs }), 'worker-t1', { id: pendingId, name: pendingId }, abort.signal)
  await tick()
  abort.abort()
  assert.equal(await aborted, undefined, '信号中止先结束')

  const goneId = jobs.run('worker-t1', 'sleep 30')
  const gone = collectJob(makeCtx({ jobs }), 'worker-t1', { id: goneId, name: goneId }, new AbortController().signal)
  await tick()
  jobs.remove(goneId)
  assert.equal(await gone, undefined, '作业表清空后收不到它的结束')
  passed += 1
})

test('stopBackground：收作业 + 收队友；没有 worker 句柄时只收作业', async () => {
  const jobs = makeJobs({ waitMode: 'immediate' })
  const id = jobs.run('worker-t1', 'pnpm test')
  const agent = makeAgent('worker-t1')
  const team = makeTeam([{ sessionId: 'worker-t1', state: 'working' }])
  await stopBackground(makeCtx({ jobs, team }), 'worker-t1', '工单结束', false, agent)
  assert.deepEqual(jobs.killed, [id])
  assert.deepEqual(team.stopped, ['worker-t1'])
  assert.equal(agent.cancels.length, 1)

  // 上游用 ctx.agents.get(sessionId) 现查；本仓没有全局 agent 注册表，查不到就是 undefined（第 5 参不传）。
  const otherJobs = makeJobs({ waitMode: 'immediate' })
  otherJobs.run('worker-t2', 'pnpm test')
  const otherTeam = makeTeam([{ sessionId: 'worker-t2', state: 'working' }])
  await stopBackground(makeCtx({ jobs: otherJobs, team: otherTeam }), 'worker-t2', '工单结束')
  assert.deepEqual(otherTeam.stopped, [], '没有 worker 句柄就不碰队友')
  passed += 1
})

test('runningJobs：只列本会话在跑的作业，名字取命令首行，except 放行用户接管的', async () => {
  const jobs = makeJobs()
  const first = jobs.run('worker-t1', 'pnpm test\n第二行不进名字')
  const done = jobs.run('worker-t1', 'pnpm lint')
  jobs.end(done)
  jobs.run('worker-t2', 'pnpm build')
  assert.deepEqual(runningJobs(makeCtx({ jobs }), 'worker-t1'), [{ id: first, name: `${first} (pnpm test)` }])
  assert.deepEqual(runningJobs(makeCtx({ jobs }), 'worker-t2'), [{ id: 'job-3', name: 'job-3 (pnpm build)' }])
  assert.deepEqual(runningJobs(makeCtx({ jobs }), 'worker-t1', new Set([first])), [])
  assert.deepEqual(runningJobs(makeCtx({}), 'worker-t1'), [], '作业插件没开时给空清单')
  passed += 1
})
