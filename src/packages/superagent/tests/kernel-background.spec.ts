/**
 * `executor/background.ts` 的包级测试：worker 回合结束后的后台静默等待（shell 作业 + 子智能体）、
 * 到点收集作业、停工单时收作业与收队友。
 *
 * 转写自同目录 `background.test.mjs`（node:test 探针，读的是 `lib/` 构建产物）。这里直接
 * import 源码，跑在 unit project 里，所以同一批判据也计进覆盖率。上游对应关系见该探针文件头；
 * 被测逻辑只认五个动作——`jobs.list` / `jobs.wait` / `jobs.kill`、`team.list` / `team.stopBySession`，
 * 作业表与队友名册都用对象字面量替身，不真起子进程、不派真队友。
 *
 * @module dsc/packages/superagent/tests/kernel-background
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  cancelled,
  collectJob,
  killJobs,
  runningJobs,
  stopBackground,
  stopSubagents,
  until,
  untilQuiet,
  type BackgroundAgent,
} from '../executor/background.js'

/** 假作业表：`list` / `wait` / `kill`，外加测试专用的 `run` / `end` / `remove`。 */
function makeJobs({ waitMode = 'deferred' }: { waitMode?: 'deferred' | 'immediate' } = {}) {
  const views = new Map<string, { id: string; owner: string; status: string; command: string }>()
  const waiters = new Map<string, Set<(value: boolean) => void>>()
  const listCalls: (string | undefined)[] = []
  const killed: string[] = []
  let counter = 0

  const settle = (id: string) => {
    const pending = waiters.get(id)
    if (pending === undefined) return
    waiters.delete(id)
    for (const resolve of pending) resolve(true)
  }

  const service = {
    listCalls,
    killed,
    list(owner?: string) {
      listCalls.push(owner)
      return [...views.values()].filter((job) => owner === undefined || job.owner === owner)
    },
    wait(id: string, _timeoutMs: number, signal?: AbortSignal) {
      const job = views.get(id)
      if (job === undefined || job.status !== 'running') return Promise.resolve(true)
      if (waitMode === 'immediate') return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        let pending = waiters.get(id)
        if (pending === undefined) {
          pending = new Set()
          waiters.set(id, pending)
        }
        pending.add(resolve)
        signal?.addEventListener('abort', () => resolve(false), { once: true })
      })
    },
    kill(id: string) {
      const job = views.get(id)
      if (job === undefined || job.status !== 'running') return false
      job.status = 'killed'
      killed.push(id)
      settle(id)
      return true
    },
    run(owner: string, command = 'pnpm test') {
      counter += 1
      const id = `job-${String(counter)}`
      views.set(id, { id, owner, status: 'running', command })
      return id
    },
    end(id: string, status = 'completed') {
      const job = views.get(id)
      if (job === undefined) throw new Error(`没有作业 ${id}`)
      job.status = status
      settle(id)
    },
    remove(id: string) {
      views.delete(id)
      settle(id)
    },
    get: (id: string) => views.get(id),
  }
  return service
}

/** 假队友名册：`list` 返回 `TeammateView` 的最小子集（`sessionId` + `state`）。 */
function makeTeam(children: { sessionId: string; state: string }[] = []) {
  return {
    children,
    listCalls: 0,
    stopped: [] as string[],
    list() {
      this.listCalls += 1
      return this.children
    },
    stopBySession(sessionId: string) {
      this.stopped.push(sessionId)
      return Promise.resolve([])
    },
  }
}

/** 假 worker 句柄：只实现被测函数用到的 `id` / `status` / `whenIdle` / `cancel`。 */
function makeAgent(id = 'worker-t1', status = 'idle') {
  const agent = {
    id,
    status,
    cancels: [] as { kind: string; keepInbox?: boolean }[],
    whenIdle: async () => {},
    cancel(options: { kind: string; keepInbox?: boolean } = { kind: 'user' }) {
      agent.cancels.push(options)
      agent.status = 'idle'
    },
  }
  return agent as typeof agent & BackgroundAgent
}

/** 假 Cordis 上下文：没给的插件返回 undefined（模拟插件没开）。 */
function makeCtx(services: Record<string, unknown> = {}) {
  return { get: (name: string) => services[name] } as never
}

/** 让已排队的微任务跑完。 */
async function drain(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('background：静默判定', () => {
  test('作业结束把 worker 吵醒时不算静默：本轮取到 payload 后下一拍再看', async () => {
    const agent = makeAgent()
    const jobs = makeJobs()
    const id = jobs.run(agent.id, 'pnpm test')
    jobs.wait = async (jobId: string) => {
      jobs.end(jobId)
      agent.status = 'running'
      return true
    }
    expect(await untilQuiet(makeCtx({ jobs }), agent, new AbortController().signal)).toBe(false)
    expect(jobs.get(id)!.status).toBe('completed')
  })

  test('宿主停机时不再等永远不会结束的子智能体', async () => {
    const agent = makeAgent()
    let sawRoster: () => void = () => {}
    const polled = new Promise<void>((resolve) => { sawRoster = resolve })
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
    expect(await quiet).toBe(false)
  })

  test('作业挂着时不重复看表，结束之后才复查', async () => {
    const agent = makeAgent()
    const jobs = makeJobs()
    const id = jobs.run(agent.id, 'pnpm test')
    const quiet = untilQuiet(makeCtx({ jobs }), agent, new AbortController().signal)
    await tick()
    const looked = jobs.listCalls.length
    expect(looked).toBe(1)
    await tick()
    expect(jobs.listCalls.length).toBe(looked)
    jobs.end(id)
    expect(await quiet).toBe(true)
    expect(jobs.listCalls.length).toBeGreaterThan(looked)
  })

  test('两次 look 各自轮询子智能体、各自被取消（没有共享 join）', async () => {
    const agent = makeAgent()
    const team = makeTeam([{ sessionId: agent.id, state: 'working' }])
    const ctx = makeCtx({ team })
    const first = new AbortController()
    const second = new AbortController()
    const a = untilQuiet(ctx, agent, first.signal)
    const b = untilQuiet(ctx, agent, second.signal)
    await tick()
    expect(team.listCalls).toBeGreaterThanOrEqual(2)
    first.abort()
    second.abort()
    expect([await a, await b]).toEqual([false, false])
  })

  test('until：工作先到给结果，信号中止或超时给 false', async () => {
    expect(await until(Promise.resolve(7))).toBe(7)
    const aborted = new AbortController()
    aborted.abort()
    expect(await until(new Promise(() => {}), aborted.signal)).toBe(false)
    expect(await until(new Promise(() => {}), undefined, 5)).toBe(false)
  })
})

describe('background：停工', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('子智能体 10 秒收不掉就放弃等待，并取消被唤醒的回合', async () => {
    const agent = makeAgent('worker-t1', 'running')
    const team = makeTeam([{ sessionId: agent.id, state: 'working' }])
    team.stopBySession = (sessionId: string) => {
      team.stopped.push(sessionId)
      return new Promise(() => {})
    }
    let stopped = false
    const stopping = stopSubagents(makeCtx({ team }), agent).then(() => { stopped = true })
    await drain()
    vi.advanceTimersByTime(9_999)
    await drain()
    expect(stopped).toBe(false)
    vi.advanceTimersByTime(1)
    await stopping
    expect(team.stopped).toEqual(['worker-t1'])
    expect(agent.cancels).toEqual([{ kind: 'user', keepInbox: false }])
    expect(cancelled.has(agent)).toBe(true)
  })

  test('killJobs：只杀本会话在跑的作业（except 里的留给人的那些不动），并等每个收尾', async () => {
    const jobs = makeJobs({ waitMode: 'immediate' })
    const first = jobs.run('worker-t1', 'pnpm test')
    const kept = jobs.run('worker-t1', 'pnpm lint')
    const other = jobs.run('worker-t2', 'pnpm build')
    await killJobs(makeCtx({ jobs }), 'worker-t1', '工单结束', new Set([kept]))
    expect(jobs.killed).toEqual([first])
    expect(jobs.get(kept)!.status).toBe('running')
    expect(jobs.get(other)!.status).toBe('running')
  })

  test('killJobs：一个作业杀不掉不影响别的，最后抛 AggregateError 带原因', async () => {
    const jobs = makeJobs({ waitMode: 'immediate' })
    const first = jobs.run('worker-t1', 'pnpm test')
    const second = jobs.run('worker-t1', 'pnpm lint')
    const kill = jobs.kill
    jobs.kill = (id: string) => {
      if (id === second) throw new Error('kill 失败')
      return kill(id)
    }
    await expect(killJobs(makeCtx({ jobs }), 'worker-t1', '工单结束')).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Killing the shell jobs of worker-t1 failed',
    })
    expect(jobs.killed).toEqual([first])
  })

  test('stopBackground：收作业 + 收队友；没有 worker 句柄时只收作业', async () => {
    const jobs = makeJobs({ waitMode: 'immediate' })
    const id = jobs.run('worker-t1', 'pnpm test')
    const agent = makeAgent('worker-t1')
    const team = makeTeam([{ sessionId: 'worker-t1', state: 'working' }])
    await stopBackground(makeCtx({ jobs, team }), 'worker-t1', '工单结束', false, agent)
    expect(jobs.killed).toEqual([id])
    expect(team.stopped).toEqual(['worker-t1'])
    expect(agent.cancels).toHaveLength(1)

    const otherJobs = makeJobs({ waitMode: 'immediate' })
    otherJobs.run('worker-t2', 'pnpm test')
    const otherTeam = makeTeam([{ sessionId: 'worker-t2', state: 'working' }])
    await stopBackground(makeCtx({ jobs: otherJobs, team: otherTeam }), 'worker-t2', '工单结束')
    expect(otherTeam.stopped).toEqual([])
  })

  test('stopBackground：作业与队友都失败时抛 AggregateError，两个错误都在', async () => {
    const jobs = makeJobs({ waitMode: 'immediate' })
    jobs.run('worker-t1', 'pnpm test')
    jobs.kill = () => { throw new Error('kill 失败') }
    const agent = makeAgent('worker-t1', 'running')
    const team = makeTeam([{ sessionId: 'worker-t1', state: 'working' }])
    team.stopBySession = () => Promise.reject(new Error('team 失败'))
    await expect(stopBackground(makeCtx({ jobs, team }), 'worker-t1', '工单结束', true, agent)).rejects.toMatchObject({
      message: 'Stopping the background work of worker-t1 failed',
    })
  })
})

describe('background：作业收集与清单', () => {
  test('collectJob：作业结束后带回名字与状态；中止或作业表清空时给 undefined', async () => {
    const jobs = makeJobs()
    const id = jobs.run('worker-t1', 'sleep 10\n第二行')
    const job = { id, name: `${id} (sleep 10)` }
    const ended = collectJob(makeCtx({ jobs }), 'worker-t1', job, new AbortController().signal)
    await tick()
    jobs.end(id, 'completed')
    expect(await ended).toEqual({ name: job.name, status: 'completed' })

    const pendingId = jobs.run('worker-t1', 'sleep 20')
    const abort = new AbortController()
    const aborted = collectJob(makeCtx({ jobs }), 'worker-t1', { id: pendingId, name: pendingId }, abort.signal)
    await tick()
    abort.abort()
    expect(await aborted).toBeUndefined()

    const goneId = jobs.run('worker-t1', 'sleep 30')
    const gone = collectJob(makeCtx({ jobs }), 'worker-t1', { id: goneId, name: goneId }, new AbortController().signal)
    await tick()
    jobs.remove(goneId)
    expect(await gone).toBeUndefined()
  })

  test('collectJob：没有作业插件时直接返回 undefined', async () => {
    const pending = collectJob(makeCtx({}), 'worker-t1', { id: 'job-1', name: 'x' }, new AbortController().signal)
    expect(await pending).toBeUndefined()
  })

  test('runningJobs：只列本会话在跑的作业，名字取命令首行，except 放行用户接管的', () => {
    const jobs = makeJobs()
    const first = jobs.run('worker-t1', 'pnpm test\n第二行不进名字')
    const done = jobs.run('worker-t1', 'pnpm lint')
    jobs.end(done)
    jobs.run('worker-t2', 'pnpm build')
    expect(runningJobs(makeCtx({ jobs }), 'worker-t1')).toEqual([{ id: first, name: `${first} (pnpm test)` }])
    expect(runningJobs(makeCtx({ jobs }), 'worker-t2')).toEqual([{ id: 'job-3', name: 'job-3 (pnpm build)' }])
    expect(runningJobs(makeCtx({ jobs }), 'worker-t1', new Set([first]))).toEqual([])
    expect(runningJobs(makeCtx({}), 'worker-t1')).toEqual([])
  })

  test('runningJobs：命令为空时名字只留 id', () => {
    const jobs = makeJobs()
    const id = jobs.run('worker-t1', '')
    expect(runningJobs(makeCtx({ jobs }), 'worker-t1')).toEqual([{ id, name: id }])
  })
})
