/**
 * `executor/background.js` 的测试夹具：DSH 作业表与子智能体服务的对象字面量替身。
 *
 * 为什么不用真作业表 / 真队友：真作业表要起子进程，用例得等真 `sleep` 跑完；真队友要派真
 * 子智能体（还要真模型）。被测逻辑只认五个动作——`jobs.list` / `jobs.wait` / `jobs.kill`、
 * `team.list` / `team.stopBySession`，作业与队友是真是假不影响判据。字段形状照本仓
 * `src/services/types.ts` 的 `JobView` 与 `src/contract/plugin.ts` 的 `TeammateView`，
 * 只留被测函数读到的成员（这是上游 `tests/fixtures/host.ts` 的 `jobRegistry` 的原生等价物）。
 *
 * @module @pneuma/superagent/tests/fixtures-background
 */

/**
 * 假作业表：`list` / `wait` / `kill`，外加测试专用的 `run` / `end` / `remove` / `get`。
 *
 * `waitMode` 决定 `wait` 怎么回来：
 * - `'deferred'`（默认）：挂着等 `end` / `kill` / `remove` 决议，模拟「这个作业结束时 wait 返回 true」，
 *   用来测 `untilQuiet` 与 `collectJob` 的复查循环；
 * - `'immediate'`：立刻返回 true，只给 `killJobs` / `stopBackground` 这类「杀了就完事」的用例用。
 *
 * 本仓 `jobs` 没有输出事件（上游靠 `events.subscribe` 的 `settled` / `removed`），所以这里也没有
 * `output`——「作业只在结束时被复查」由 `listCalls` 的计数来钉。
 */
export function makeJobs({ waitMode = 'deferred' } = {}) {
  const views = new Map()
  const waiters = new Map()
  const listCalls = []
  const killed = []
  let counter = 0

  /** 让挂在 `id` 上的 waits 都以 true 返回。 */
  function settle(id) {
    const pending = waiters.get(id)
    if (pending === undefined) return
    waiters.delete(id)
    for (const resolve of pending) resolve(true)
  }

  const service = {
    listCalls,
    killed,
    list(owner) {
      listCalls.push(owner)
      return [...views.values()].filter((job) => owner === undefined || job.owner === owner)
    },
    running(owner) {
      return service.list(owner).filter((job) => job.status === 'running')
    },
    wait(id, _timeoutMs, signal) {
      const job = views.get(id)
      if (job === undefined || job.status !== 'running') return Promise.resolve(true)
      if (waitMode === 'immediate') return Promise.resolve(true)
      return new Promise((resolve) => {
        let pending = waiters.get(id)
        if (pending === undefined) {
          pending = new Set()
          waiters.set(id, pending)
        }
        pending.add(resolve)
        signal?.addEventListener('abort', () => resolve(false), { once: true })
      })
    },
    kill(id) {
      const job = views.get(id)
      if (job === undefined || job.status !== 'running') return false
      job.status = 'killed'
      killed.push(id)
      settle(id)
      return true
    },
    /** 造一个在跑的作业，返回它的 id。 */
    run(owner, command = 'pnpm test') {
      counter += 1
      const id = `job-${String(counter)}`
      views.set(id, { id, owner, status: 'running', command })
      return id
    },
    /** 让作业结束（默认 completed），并唤醒等它的 waits。 */
    end(id, status = 'completed') {
      const job = views.get(id)
      if (job === undefined) throw new Error(`没有作业 ${id}`)
      job.status = status
      settle(id)
    },
    /** 把作业从表里摘掉（模拟作业表被清空）。 */
    remove(id) {
      views.delete(id)
      settle(id)
    },
    get(id) {
      return views.get(id)
    },
  }
  return service
}

/** 假队友名册：`list` 返回 `TeammateView` 的最小子集（`sessionId` + `state`），`stopBySession` 记下收过谁。 */
export function makeTeam(children = []) {
  return {
    children,
    listCalls: 0,
    stopped: [],
    list() {
      this.listCalls += 1
      return this.children
    },
    stopBySession(sessionId) {
      this.stopped.push(sessionId)
      return Promise.resolve([])
    },
  }
}

/** 假 worker 句柄（`BackgroundAgent`）：只实现被测函数用到的 `id` / `status` / `whenIdle` / `cancel`。 */
export function makeAgent(id = 'worker-t1', status = 'idle') {
  return {
    id,
    status,
    cancels: [],
    followups: [],
    whenIdle: async () => {},
    followup(text) {
      this.followups.push(text)
    },
    cancel(options = { kind: 'user' }) {
      this.cancels.push(options)
      this.status = 'idle'
    },
  }
}

/** 假 Cordis 上下文：`ctx.get(name)` 只认 `jobs` 与 `team`；没给的那一项返回 undefined（模拟插件没开）。 */
export function makeCtx(services = {}) {
  return { get: (name) => services[name] }
}

/** 让已排队的微任务跑完：等待/轮询里没有真 I/O 依赖，一个事件循环足够。 */
export async function drain() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** 等一个宏任务：用来让 `wait` 真正挂上。 */
export const tick = () => new Promise((resolve) => setImmediate(resolve))
