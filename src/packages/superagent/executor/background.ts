/**
 * 移植自 dsh-superagent/src/executor/background.ts（165 行，原生重写）。
 *
 * 上游的职责原样保留：worker 回合结束后，等它留下的后台活静默（shell 作业 + 子智能体），
 * 到点杀作业、报 waiting；工单结束时把作业杀掉、把子智能体收掉。函数名、判定顺序、错误文案
 * 全部照上游；只有「DSH 服务调用」换成本仓原生栈：
 *
 * | 上游（DSH） | 本仓原生 |
 * | --- | --- |
 * | `ctx.get('jobs')`：`list(caller)` / `wait(id, ms, caller, signal)` / `kill(id, caller, reason)` / `events.subscribe` | `ctx.jobs`（`services/types.ts:601-616`）：`list(owner?)` / `running(owner)` / `wait(id, ms, signal)` / `kill(id)`。**没有事件订阅**，所以 `jobsEnd` 给在跑的每一条都挂上 `wait`、取最先结束的那条再整表复查（等价于上游订阅 `settled`/`removed` 的「任一结束就复查」），实现见下 |
 * | `ctx.get('subagents')`：`waitForChildren` / `listChildren` / `drainChildren` | `ctx.team`（`services/types.ts:1026-1064`，subagent 插件提供）：`list()` 的 `TeammateView` 带 `sessionId` 与 `state`（`contract/plugin.ts:113-143`），`stopBySession(sessionId)` 收掉一个会话派出的全部队友。原生没有「等某个队友结束」的等待口，`childrenEnd` 用 250ms 轮询（与旧实现等作业的轮询同一取舍：等的人只有执行器一个，不值得给 subagent 加一套广播） |
 * | `type { Agent } from '@deepseek-ai/dsh-agent'` | worker 会话句柄由 `app/sessions.ts` 定义，这里用 `Awaited<ReturnType<Sessions['ensure']>>` 取，不重声明（同上游从 dsh-agent 取类型） |
 * | `type { SessionId } from '@deepseek-ai/dsh-session'` | 本仓会话 id 就是 `string`（`core/session.ts:26` 的 `SessionMeta.id`） |
 * | 作业的 `label`（首行做名字） | 本仓 `JobView` 只有 `command`（`services/types.ts:579-588`），`named` 取命令首行 |
 * | `kill(id, caller, reason)` | 本仓 `kill(id)` 不收 reason（`services/types.ts:615`）；`reason` 仍用于失败时的 `AggregateError` 文案 |
 *
 * 与上游的五条行为差异，头三条是「DSH 替我们做过、本仓没有」的那一步，后两条是本仓没有对应状态：
 *
 * 1. **`stopBackground` 多收一个 worker 句柄**（第五参）。上游用 `ctx.agents.get(sessionId)` 现查；
 *    本仓没有全局 agent 注册表（worker 的 `MiniAgent` 归 `app/sessions.ts` 管），由调用方
 *    （`dsh.ts`，手上有 `host.sessions`）把句柄传进来。传 `undefined` 等价于上游查不到会话。
 * 2. **`childrenEnd` 改为轮询**（理由见上表）。上游 `waitForChildren` 不可取消、所以用 `joins`
 *    去重；本仓的轮询可取消，没有并发叠加的问题，`joins` 随之删除。
 * 3. **`jobsEnd` 用 `wait` 代替事件订阅**（理由见上表）：对每条在跑的作业都挂 `wait`，哪条先结束就醒过来
 *    再复查全部，直到没有仍在跑的作业；`signal` 中止或作业表清空时返回 false。上游订阅 `settled`/`removed`，
 *    任一作业结束都复查；只等第一条会漏掉「别的作业先结束」，那一轮最坏要等到它自己的 10 分钟超时。
 * 4. **`running` 只认 `'running'`**：上游 `:31` 把 `'stopping'` 也算在跑。本仓 `JobView.status` 是
 *    `'running' | 'completed' | 'failed' | 'killed'`（`services/types.ts:583`），没有 `stopping`——`kill` 一步
 *    就把作业记成 `killed`（`tools-default/bash.ts:820-823`），没有「正在收但还没收完」的中间态可补。
 * 5. **`stopSubagents` 的「活队友」判据换成状态**：上游 `:145` 用 `subagents.listChildren(agent.id)` 拿到
 *    该会话的全部子智能体，再用 `ctx.agents.get(child.id)` 筛出「DSH 注册表里还有 agent」的那些——结束的
 *    子智能体（one-shot 收工/被移除）已从注册表摘掉，catalog 只剩一行。本仓 `TeamService.list()` 没有
 *    「本进程还持有 agent」这一项（`subagent/index.ts:963-990` 把内存里在队的与名册里收工的合并成
 *    `state`），所以判据取**非终态** `working | idle`（终态 `stopped | failed`，`subagent/index.ts:131`、
 *    `contract/plugin.ts:113-143`）。判据与动作的偏差写在这里：`stopBySession` 只遍历内存里的队友
 *    （`subagent/index.ts:1028-1040`），而名册里上一进程留下的 continuable 队友也报 `idle`，会被判成活队友
 *    却收不到——于是多取消一次 worker 回合。取舍取**宁可多取消一次**：漏掉真正 idle 的队友会留到工单
 *    结束后继续接传话，而多取消的 worker 回合在下一次 idle 会重新判（`dsh.ts` 的 `cancelled` 把这次 idle
 *    记作停工、不当作它自己的回合结束）。
 *
 * @module dsc/packages/superagent/executor/background
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JobsService, TeamService } from '@pneuma/runtime/services/types.js'
import type { Sessions } from '../app/sessions.js'

/** worker 会话句柄：真身由 `app/sessions.ts` 的 `Sessions.ensure` 决定（见上表）。 */
export type BackgroundAgent = Awaited<ReturnType<Sessions['ensure']>>
/** What the Executor uses of DSC's job registry: the jobs a Session owns, a wait for one and a kill. */
type Jobs = Pick<JobsService, 'list' | 'wait' | 'kill'>
/** What the Executor uses of DSC's subagents: a worker's live teammates and releasing them. */
type Subagents = Pick<TeamService, 'list' | 'stopBySession'>
/** How long a stop waits for a killed job to end, collecting its end so the worker is not woken to hear of it. */
const KILL_WAIT_MS = 10_000
/** How long a release of subagents may take; it can hold up a shutdown, so DSC's own callers bound it too. */
const DRAIN_LIMIT_MS = 10_000
/** How long one wait that collects a job's end runs; one that ends with the job running is followed by the next. */
const COLLECT_WAIT_MS = 10 * 60_000
/** How often the native look at a worker's subagents re-reads the teammate roster; it has no wait-for-children call. */
const CHILDREN_POLL_MS = 250

const registry = (ctx: Context): Jobs | undefined => ctx.get('jobs')
const subagentsOf = (ctx: Context): Subagents | undefined => ctx.get('team')
const running = (status: string): boolean => status === 'running'
/** The jobs the Session owns that run, but those in `except`, such as the ones left to a person. */
const owned = (jobs: Jobs, sessionId: string, except?: ReadonlySet<string>) =>
  jobs.list(sessionId).filter(job => running(job.status) && !except?.has(job.id))
/** `work`, or false once `signal` aborts or `ms` pass first. */
export function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted === true) return Promise.resolve(false)
  let stop!: () => void
  const stopped = new Promise<false>(resolve => { stop = () => { resolve(false) } })
  signal?.addEventListener('abort', stop, { once: true })
  const timer = ms === undefined ? undefined : setTimeout(stop, ms)
  timer?.unref?.()
  return Promise.race([work, stopped]).finally(() => { signal?.removeEventListener('abort', stop); clearTimeout(timer) })
}
/** The workers whose turn a stop of their subagents cancelled, whose next idle ends that turn rather than one of their own. */
export const cancelled = new WeakSet<BackgroundAgent>()
/** A job by its id and the first line of its command (upstream names it by the first line of its label). */
const named = (job: { id: string; command: string }): string => {
  const line = job.command.split('\n')[0]?.trim() ?? ''
  return line ? `${job.id} (${line})` : job.id
}
/** The shell jobs the Session owns that still run, but those in `except`, with their names. */
export const runningJobs = (ctx: Context, sessionId: string, except?: ReadonlySet<string>): { id: string; name: string }[] => {
  const jobs = registry(ctx)
  return jobs ? owned(jobs, sessionId, except).map(job => ({ id: job.id, name: named(job) })) : []
}
/** How many teammates of `sessionId` still work (the native look at a worker's subagents). */
const workingChildren = (subagents: Subagents, sessionId: string): number =>
  subagents.list().filter(child => child.sessionId === sessionId && child.state === 'working').length
/**
 * How many teammates of `sessionId` are not in a terminal state: `working` runs, `idle` waits for a follow-up, while
 * `stopped`/`failed` ended (`subagent/index.ts:131`). The stop of a worker's subagents needs this, not just `working`
 * (see the file header's item 5).
 */
const liveChildren = (subagents: Subagents, sessionId: string): number =>
  subagents.list().filter(child => child.sessionId === sessionId && (child.state === 'working' || child.state === 'idle')).length

/**
 * Wait until no shell job the Session owns runs; false at once when none ran, or when `signal` aborts first. The wait is
 * no waiter on any job, so each job's end still reaches the worker.
 */
async function jobsEnd(ctx: Context, sessionId: string, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  const jobs = registry(ctx)
  if (!jobs) return false
  // The first look decides whether any job ran at all; a look that ends after none ran is the one that ends the turn.
  let ran = false
  for (;;) {
    const live = owned(jobs, sessionId, except)
    if (!live.length) return ran
    if (signal.aborted) return false
    ran = true
    // 本仓作业表没有事件订阅：下一次复查的时机是「任一作业结束」。这一轮给每条在跑的作业都挂 `wait`，
    // 谁先结束就拿谁回来，再整表复查；本轮没用上的等待随 `round` 一起中止，不会把旧等待堆到下一轮。
    const round = new AbortController()
    try {
      await until(Promise.race(live.map(job => jobs.wait(job.id, COLLECT_WAIT_MS, AbortSignal.any([signal, round.signal])))), signal)
    } finally { round.abort() }
  }
}
/**
 * Wait until none of the worker's subagents works; false at once when none did, or when `signal` aborts first.
 * The DSH service this replaces has a `waitForChildren` the native teammate service lacks, so the look polls its roster.
 */
async function childrenEnd(ctx: Context, sessionId: string, signal: AbortSignal): Promise<boolean> {
  const subagents = subagentsOf(ctx)
  if (!subagents) return false
  if (!workingChildren(subagents, sessionId)) return false
  while (!signal.aborted) {
    await until(new Promise<void>(resolve => {
      const timer = setTimeout(resolve, CHILDREN_POLL_MS)
      timer.unref?.()
    }), signal)
    if (signal.aborted) return false
    if (!workingChildren(subagents, sessionId)) return true
  }
  return false
}

/**
 * Wait until nothing runs for a worker that went idle: its shell jobs, but those in `except`, and its subagents.
 * A job's or a subagent's end wakes the worker with its result, which ends this look; a worker this bundle cannot wake
 * (its Session is not a resident agent) is woken by `dsh.ts` after this look reports the quiet, which ends that turn too.
 * @returns true once all of it ended with the worker idle; false when the worker runs again, or when `signal` aborts first,
 * as when the host stops or the look's time is up.
 */
export async function untilQuiet(ctx: Context, agent: BackgroundAgent, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  for (;;) {
    const children = await until(childrenEnd(ctx, agent.id, signal), signal)
    const jobs = await jobsEnd(ctx, agent.id, signal, except)
    if (signal.aborted || agent.status !== 'idle') return false
    if (!children && !jobs) return true
  }
}

/**
 * Kill the shell jobs the Session owns, but those in `except`, collecting each end so the worker is not woken to hear of it.
 * One failure stops none other. The native `kill(id)` takes no reason; `reason` only names the failure aggregate.
 */
export async function killJobs(ctx: Context, sessionId: string, reason: string, except?: ReadonlySet<string>): Promise<void> {
  const jobs = registry(ctx)
  const live = jobs ? owned(jobs, sessionId, except) : []
  const failures: unknown[] = []
  // The waits start before the kills, so each end counts as collected.
  const collected = live.map(job => jobs!.wait(job.id, KILL_WAIT_MS).catch(() => undefined))
  for (const job of live) try { jobs!.kill(job.id) } catch (error) { failures.push(error) }
  await Promise.all(collected)
  if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`)
}

/**
 * Collect the end of a shell job the Session owns, so it wakes no one, until `signal` aborts.
 * @returns the job's name and status once it ended; undefined when `signal` aborted first.
 */
export async function collectJob(ctx: Context, sessionId: string, job: { id: string; name: string }, signal: AbortSignal):
  Promise<{ name: string; status: string } | undefined> {
  const jobs = registry(ctx)
  while (jobs && !signal.aborted) {
    // The native wait polls the job table; false means the job still ran at its timeout (or the signal aborted).
    const ended = await jobs.wait(job.id, COLLECT_WAIT_MS, signal)
    if (signal.aborted) return undefined
    const view = jobs.list(sessionId).find(item => item.id === job.id)
    // The job left the table (the table was cleared): its end cannot be collected any more.
    if (view === undefined) return undefined
    if (!running(view.status)) return { name: job.name, status: view.status }
    if (ended) return undefined
  }
  return undefined
}

/**
 * Release the worker's live subagents, for a bounded time. The worker is woken with each one's end before the release
 * returns, which wakes it, so the worker's turn is cancelled after, keeping its inbox when `keepInbox`, and the stop ends
 * with that turn. Its Session still admits subagents.
 */
export async function stopSubagents(ctx: Context, agent: BackgroundAgent, keepInbox = false): Promise<void> {
  const subagents = subagentsOf(ctx)
  if (!subagents) return
  // 上游 `:145` 筛的是「DSH 注册表里还有 agent」的子智能体（结束的已摘掉），不是只看 `working`；本仓的等价判据是
  // `TeamService.list()` 里的非终态 `working | idle`（判据与动作的偏差见文件头第 5 条）。
  if (!liveChildren(subagents, agent.id)) return
  try { await until(subagents.stopBySession(agent.id), undefined, DRAIN_LIMIT_MS) }
  finally {
    if (agent.status !== 'idle') cancelled.add(agent)
    agent.cancel({ kind: 'user', keepInbox })
    await until(agent.whenIdle(), undefined, DRAIN_LIMIT_MS)
  }
}

/**
 * Stop what a worker runs in the background once its Assignment ends: kill its shell jobs and release its subagents (see
 * `stopSubagents`). A Session not loaded has no subagent at work. One failure stops nothing else.
 *
 * The worker handle is the fifth parameter because the native stack has no global agent registry to look it up in (see the
 * file header); pass `undefined` when the Session has no worker, which is what an absent DSH agent meant upstream.
 */
export async function stopBackground(ctx: Context, sessionId: string, reason: string, keepInbox = false,
  agent?: BackgroundAgent): Promise<void> {
  const failures: unknown[] = []
  await killJobs(ctx, sessionId, reason).catch((error: unknown) => { failures.push(error) })
  if (agent) await stopSubagents(ctx, agent, keepInbox).catch((error: unknown) => { failures.push(error) })
  if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`)
}
