/**
 * GitHub 来源的对外入口：一个 `tick()` 跑一拍，一个 `status()` 报上一拍的结果。
 *
 * 一拍做三件事，顺序与上游 `pollRound`（`sources/github.ts:280-296`）一致：
 * 通知 → 全仓库事件流 → 默认分支 CI。每件事各自失败、各自记录，最后一起报：一次网络抖动不该
 * 让同一拍里已经读到的通知也丢掉。
 *
 * **不做定时**：没有 `setInterval`、也没有 `pause()`。上游的 `watch()`（`github.ts:127-146`）与
 * `pause()`（`sources/poll.ts:33-40`）留在接线方，因为「多久一拍、失败几次才报错」是设置问题，
 * 不是来源的语义；本适配器只保证「叫一次 tick 就完整跑一拍」。
 *
 * 同一原因，GitHub 在 `x-poll-interval` 头里给出的「最小间隔」与这一拍的通知条数
 * （`github.ts:310-311/294`）没有出口：`status()` 只有 `lastPollAt` / `lastError`，`tick()` 也
 * 没法告诉调度层该等多久。接线方按自己的 `pollSeconds` 起定时器；要遵守 GitHub 的要求，得把
 * 那个头交给调度层——那属于接线方的接口，不在本文件。
 *
 * **没搬的三段**（都要「当前有哪些工单 / 哪些订阅线程」，而本适配器只拿到三个方法）：
 *
 * - `pollTicketPulls`（`github.ts:404-413`）：轮询未结束工单的 PR。要 `ctx.tickets.open()` 给出
 *   编号清单。缺了它，PR 的 CI 不会随拍子上报——接线方对每张 PR 调一次本文件导出的
 *   `pollPullChecks` 即可补上（基线、指纹、`revision` 都在那里）。
 * - `pollThreads`（`github.ts:430-439`）：轮询订阅话题。要 `ctx.threads.subscribed()` 与
 *   `ctx.threads.patch`。缺了它，只在通知里出现过、后来没人再提的 Issue 上的新评论读不到。
 *   这是本适配器最大的一个缺口：核心没给「订阅了哪些话题」这个出口，硬猜就会变成全仓库扫。
 * - `nameThread`（`github.ts:425-428`）：给话题写标题与事实。要 `ctx.threads.patch/describe`；
 *   缺了它只影响界面展示（话题没有标题、没有 CI 事实），不影响事件与准入。
 *
 * 同理，`pollNotifications` 里给话题写 `pollError` 的那两处（`github.ts:164/373`）也没有出口：
 * 读失败只记进本拍的失败清单与 `status().lastError`。
 *
 * @module dsc/packages/superagent/adapters/github/source
 */
import { z } from 'zod'
import { key } from '../../core/ids.js'
import type { ThreadRef, Trigger } from '../../core/model.js'
import { GithubError, validItems } from './api.js'
import type { GithubApi, GithubPage } from './api.js'
import { ciCounts, ciFailures, ciSummary, pullChecks, type CiSnapshot } from './read.js'
import { observePull, readPull, type Pull } from './pull.js'
import { cursorAt, etagFor, horizonAt, sinceAt } from './poll.js'
import { GITHUB_KEYS, GithubState } from './state.js'
import type { GithubBranchCiState, GithubCiState, GithubKvHandle, GithubRetry, GithubStreamState } from './state.js'
import {
  branchCiTrigger, ciTrigger, commentTrigger, githubAddress, IssueSchema, issueTrigger, pullTrigger,
  CommentSchema, sameName,
} from './trigger.js'

/**
 * 同步调用就能喂给核心的三个动作。
 *
 * 只列来源自己会调用的：`receive` 交事件、`bindThread` 让工单关注一张 PR、`threadClosed` 报
 * 线程关闭。其余（评估、派工、设置）都是接线方的事，来源不该看见。
 */
export interface GithubEngine {
  receive(trigger: Trigger): unknown
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): unknown
  /** `reason` 是 `'merged'` / `'closed'`；`at` 是关闭时刻，不传就由核心按自己的时钟记。 */
  threadClosed(thread: ThreadRef, reason?: string, at?: string): unknown
}

/**
 * 把核心的 `EngineForSources`（`core/engine.ts:261`）收成本模块要的三个动作。
 *
 * 只差在核心的 `threadClosed` 是三个必填参数（`core/engine.ts:62`：`thread`, `outcome`, `at`）：
 * 直接把它当 `GithubEngine` 传进来，`tsc` 会因为「要求 3 个参数、这里只允许 1～3 个」报错。
 * 包一层既省得每个接线点各写一遍，也顺手把 `at` 补上——漏传它会让工单的结束时刻变成「核心
 * 处理这件事的时刻」，而不是 PR 真正关闭的时刻（`github-pull.ts:82`）。
 */
export function githubEngine(
  engine: {
    receive(trigger: Trigger): unknown
    bindThread(ticketId: string, thread: ThreadRef, own: boolean): unknown
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): unknown
  },
  now: () => string,
): GithubEngine {
  return {
    receive: (trigger) => engine.receive(trigger),
    bindThread: (ticketId, thread, own) => engine.bindThread(ticketId, thread, own),
    threadClosed: (thread, reason, at) => engine.threadClosed(thread, reason === 'merged' ? 'merged' : 'closed', at ?? now()),
  }
}

/** 观测哪些事件。默认全开：DSC 的接收范围是「整仓库都算收到」（`adapters/scope.ts:37-38`），由策略决定收不收。 */
export interface GithubObserve {
  issues?: boolean
  pulls?: boolean
  comments?: boolean
  ci?: boolean
}

/** `createGithubSource` 的入参。 */
export interface GithubSourceOptions {
  /** 已经绑定仓库与令牌的客户端。 */
  api: GithubApi
  /** `owner/name`；只用来拼 `github.com` 链接与比对通知里的仓库名。 */
  repository: string
  /** 机器人自己的登录名：它自己发的消息一律跳过（`github.ts:227/355/397`）。 */
  login: string
  engine: GithubEngine
  /** 持久层，只取 `kv` 表要用的 `handle`（`DscStore.handle`）。 */
  store: { handle: GithubKvHandle }
  /** 本拍开始时刻，`Date#toISOString` 形式。 */
  now: () => string
  log: (line: string) => void
  observe?: GithubObserve | undefined
}

/** 一拍里的临时状态：同一张 PR 只读一次，失败与「已删除」分开记（`github.ts:147-153`）。 */
interface Round {
  started: string
  pulls: Map<number, Promise<Pull>>
  failures: string[]
  dropped: number[]
  abandoned: number[]
}

/** 24 小时后放弃一条读不通的通知，免得一条永久坏掉的通知把来源健康永远钉在 error 上（`github.ts:334-335`）。 */
const RETRY_WINDOW_MS = 24 * 3600_000

/** 通知里的一条（`github.ts:21-23`）：`subject.url` 是它指向的 Issue 或 PR 的 API 地址。 */
const NotificationSchema = z.looseObject({
  repository: z.looseObject({ full_name: z.string() }),
  subject: z.looseObject({ url: z.string().nullish() }),
})

/** 全仓库事件流的条目：评论多两个指回 Issue / PR 的字段（`github.ts:171`）。 */
const ListedSchema = CommentSchema.extend({
  issue_url: z.string().nullish(), pull_request_url: z.string().nullish(),
})

/**
 * 全仓库的三条事件流（`github.ts:173-177`）。
 *
 * `/issues` 里也包含 PR（GitHub 的设计），`/issues/comments` 只是 Issue 与 PR 的会话评论，
 * 行内 review 评论要单独走 `/pulls/comments`——三条流凑齐才不会漏掉任何一类评论。
 */
const STREAMS = [
  { id: 'issues', path: 'issues?state=all' },
  { id: 'comments', path: 'issues/comments?' },
  { id: 'review-comments', path: 'pulls/comments?' },
] as const

/** 列表响应必须是数组：形状变了就报错，静默当空列表会永久漏事件（上游 `z.array(...).parse` 同效）。 */
function listOf(body: unknown): unknown[] {
  if (!Array.isArray(body)) throw new Error('GitHub returned a non-list response')
  return body
}

/** GitHub 回 410 表示会话已被永久删除；404 反而不算（可能是私有仓库临时失去权限，`github.ts:157-158`）。 */
const deleted = (error: unknown): boolean => error instanceof GithubError && error.code === 410

/** 只读一张 PR 的 CI 需要的东西：没有工单、没有话题，只有客户端、时钟与持久层。 */
export interface GithubChecksOptions {
  api: GithubApi
  engine: Pick<GithubEngine, 'receive' | 'threadClosed'>
  store: { handle: GithubKvHandle }
  now: () => string
}

/**
 * 轮询一张 PR 的 CI（`github.ts:414-424` 的可搬部分）。
 *
 * 第一次观察只建立指纹基线，不上报；指纹变了（同一份快照重复读到不算）才上报，`revision`
 * 每报一次加一，保证每次变化的 Trigger id 都不同。读 PR 的同时也观察它的开合状态，和上游
 * `pollTicketPulls` 走同一个 `pull()` 的效果一致。
 *
 * 线程上的 CI 事实（上游 `ctx.threads.describe`）没有写：本适配器没有那个出口（见文件头）。
 * 独立成导出函数，是因为「哪些 PR 该看」只有接线方知道（工单清单）。
 */
export async function pollPullChecks(options: GithubChecksOptions, number: number): Promise<void> {
  const state = new GithubState(options.store.handle)
  const pr = await readPull(options.api, number)
  await observePull(options.engine, pr)
  const snapshot = await pullChecks(options.api, pr.head.sha)
  // 指纹用核心的内容哈希，不直接存 JSON：它与上游 `github.ts:417` 的值逐位相同，迁移旧库时对得上。
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = state.get<GithubCiState>(GITHUB_KEYS.ci(number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) {
    await options.engine.receive(ciTrigger(pr, revision, ciSummary(snapshot, `PR #${String(number)}`, `github/pulls/${String(number)}/checks`), options.now))
  }
  state.set(GITHUB_KEYS.ci(number), { fingerprint, revision })
}

/**
 * 造一个 GitHub 来源。
 *
 * @param options - 客户端、仓库、机器人登录名、核心的三个动作、持久层与时钟
 * @returns `tick()` 跑一拍（失败会抛，`status()` 里留原因），`status()` 读上一拍
 */
export function createGithubSource(options: GithubSourceOptions): {
  tick(): Promise<void>
  status(): { lastPollAt: string | null; lastError: string | null }
} {
  const { api, repository, login, engine, now, log } = options
  const state = new GithubState(options.store.handle)
  const observe = { issues: true, pulls: true, comments: true, ci: true, ...options.observe }
  let lastPollAt: string | null = null
  let lastError: string | null = null

  /** 读失败的记账：410 进「已删除」，24 小时放弃的进「已放弃」，其余才是真失败（`github.ts:160-165`）。 */
  function failed(round: Round, number: number, error: unknown, abandoned = false): void {
    if (deleted(error)) round.dropped.push(number)
    else if (abandoned) round.abandoned.push(number)
    else round.failures.push(`#${String(number)}: ${String(error)}`)
  }

  /** 一张 PR 每拍只读一次，读完就观察它的生命周期（`github.ts:376-383`）。 */
  function pull(round: Round, number: number): Promise<Pull> {
    let read = round.pulls.get(number)
    if (!read) {
      read = readPull(api, number).then(async (pr) => {
        await observePull(engine, pr)
        return pr
      })
      round.pulls.set(number, read)
    }
    return read
  }

  /**
   * 读一个 Issue / PR 的评论与 review（`github.ts:384-403`）。
   *
   * 除了 `since` 还要再按时间戳筛一遍：`/reviews` 不接受 `since` 参数，返回的是全部 review，
   * 只能自己按 `submitted_at` 截断。
   */
  async function intakeComments(
    round: Round,
    ref: { number: number; isPr: boolean; url?: string; prAuthor?: string },
    since: string,
  ): Promise<void> {
    const kinds = ref.isPr ? ['conversation', 'inline', 'review'] as const : ['conversation'] as const
    for (const kind of kinds) {
      const suffix = `&since=${encodeURIComponent(since)}`
      const path = kind === 'conversation' ? `issues/${String(ref.number)}/comments?per_page=100${suffix}`
        : kind === 'inline' ? `pulls/${String(ref.number)}/comments?per_page=100${suffix}`
          : `pulls/${String(ref.number)}/reviews?per_page=100`
      const comments = validItems(CommentSchema, await api.slurp<unknown>(path))
      for (const comment of comments) {
        const timestamp = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
        if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
        if (sameName(comment.user.login, login)) continue
        // 没有正文的 review 结论（APPROVED）也要进：可能有 worker 正等着这个批准（`github.ts:398`）。
        const trigger = commentTrigger(comment, ref, kind, login, now)
        if (trigger.text) await engine.receive(trigger)
      }
    }
  }

  /**
   * 读一个 Issue / PR 的通知：它在游标之后新建时补一条正文 Trigger，然后读评论。
   *
   * 两条都要：只读正文，一张老单今天有人回一句就读不到；只读评论，正文里的 @ 到不了准入闸
   * （`github.ts:344-374`）。
   */
  async function readNotified(round: Round, number: number, item: GithubRetry): Promise<void> {
    const { since } = item
    let isPr = item.pr
    if (!isPr) {
      const issue = IssueSchema.parse(await api.get(`issues/${String(number)}`))
      // `issues/<n>` 对 PR 也会返回，并且带 `pull_request`；那种情况走下面的 PR 分支。
      isPr = !!issue.pull_request
      if (!isPr) {
        // 游标之后别人新建的 Issue：正文要进 Trigger，正文里的 @ 才到得了准入闸。
        // 后来编辑加进去的 @ 不算：正文的 actor 只能是作者（`github.ts:352-353`）。
        const opened = Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.user.login, login)
        if (opened) await engine.receive(issueTrigger(issue, login))
        await intakeComments(round, { number, isPr: false, url: issue.html_url }, since)
      }
    }
    if (isPr) {
      const pr = await pull(round, number)
      // PR 描述也发一条，id 与事件流产生的那条相同，核心据此去重（`github.ts:363-368`）。
      if (pr.created_at && Date.parse(pr.created_at) >= Date.parse(since) && !sameName(pr.user.login, login)) {
        const opened = {
          number, title: pr.title ?? '', body: pr.body, user: pr.user, created_at: pr.created_at, html_url: pr.html_url,
        }
        await engine.receive(pullTrigger(opened, login))
      }
      await intakeComments(round, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since)
    }
    state.set(GITHUB_KEYS.cursor(number), cursorAt(round.started))
  }

  /**
   * 读一条全仓库事件流（`github.ts:203-249`）。
   *
   * 三条规则都在这一个函数里，任何一条改错都会静默漏事件：
   * - 游标只前进不后退（`next > since` 才写），否则同一段会被反复读；
   * - 每条新条目都用到「本流开始收的时刻」与 14 天视野取大者筛一遍，开关打开之前的旧条目、
   *   视野之外的旧条目都不该变成新事件；
   * - 游标没动时复用 ETag，服务端回 304 就静默返回（`github.ts:211/216/248`）。
   */
  async function readStream(round: Round, id: string, path: string): Promise<void> {
    const name = GITHUB_KEYS.stream(id)
    const stored = state.get<GithubStreamState>(name)
    const kinds = id === 'issues'
      ? [...observe.issues ? ['issues'] : [], ...observe.pulls ? ['pulls'] : []]
      : ['comments']
    const before = stored?.started ?? {}
    const started: Record<string, string> = Object.fromEntries(kinds.map((kind) => [kind, before[kind] ?? round.started]))
    const horizon = Date.parse(horizonAt(round.started))
    const since = sinceAt(stored?.since, round.started)
    const etag = etagFor(stored, since)
    const listed = `${path}&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
    let page: GithubPage<unknown>
    try {
      page = await api.getPage<unknown>(listed, { etag })
    } catch (error) {
      if (error instanceof GithubError && error.code === 304) return
      throw error
    }
    const items = validItems(ListedSchema, listOf(page.body))
    const fresh = (at: string | null | undefined, kind: string): boolean =>
      kind in started && Date.parse(at ?? '') >= Math.max(Date.parse(started[kind]!), horizon)
    for (const item of items) {
      if (sameName(item.user.login, login)) continue
      if (id === 'issues') {
        const issue = IssueSchema.safeParse(item)
        const pr = issue.success && !!issue.data.pull_request
        if (!issue.success || !fresh(issue.data.created_at, pr ? 'pulls' : 'issues')) continue
        await engine.receive(pr ? pullTrigger(issue.data, login) : issueTrigger(issue.data, login))
        continue
      }
      const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec((id === 'comments' ? item.issue_url : item.pull_request_url) ?? '')?.[1])
      if (!number || !fresh(item.updated_at ?? item.created_at, 'comments')) continue
      const isPr = id === 'review-comments' || /\/pull\//.test(item.html_url ?? '')
      const ref = { number, isPr, ...item.html_url ? { url: item.html_url } : {} }
      const trigger = commentTrigger(item, ref, id === 'comments' ? 'conversation' : 'inline', login, now)
      if (trigger.text) await engine.receive(trigger)
    }
    const newest = Math.max(...items.map((item) => Date.parse(item.updated_at ?? '')).filter(Number.isFinite))
    const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
    const next = Date.parse(moved) > Date.parse(since) ? moved : since
    const received = page.headers['etag']?.trim()
    // ETag 属于这次请求；下一拍只有在游标没动时才会重发同一个条件（`github.ts:247-248`）。
    state.set(name, { since: next, started, ...received && next === since ? { etag: received } : {} })
  }

  /** 三条流各自失败、各自重置：关掉的那条把游标清掉，重新打开时才从打开那一刻算起（`github.ts:179-196`）。 */
  async function pollRepository(round: Round): Promise<void> {
    for (const stream of STREAMS) {
      const observed = stream.id === 'issues' ? observe.issues || observe.pulls : observe.comments
      if (!observed) {
        state.set(GITHUB_KEYS.stream(stream.id), undefined)
        continue
      }
      try {
        await readStream(round, stream.id, stream.path)
      } catch (error) {
        round.failures.push(`${stream.id}: ${String(error)}`)
      }
    }
  }

  /**
   * 默认分支 CI：只在失败集合变化时上报（`github.ts:251-272`）。
   *
   * 三个容易改错的地方：
   * - 第一次观察只建立基线，不上报——否则每次重启都会把「当前失败」当成新事件；
   * - 还有检查在跑时保留上一次的失败集合，免得「从失败到通过」被中间的「进行中」拆成两次上报；
   * - 关掉 CI 观察时保留 `revision`、丢掉失败集合：将来重新打开，`revision` 继续往上数，
   *   才会产出新的 Trigger id（`github.ts:188-193`）。
   */
  async function pollBranchCi(round: Round): Promise<void> {
    if (!observe.ci) {
      const seen = state.get<GithubBranchCiState>(GITHUB_KEYS.branchCi)
      state.set(GITHUB_KEYS.branchCi, seen ? { revision: seen.revision } : undefined)
      return
    }
    try {
      const root = z.looseObject({ default_branch: z.string() }).parse(await api.get(''))
      const head = z.looseObject({ sha: z.string() }).parse(await api.get(`commits/${encodeURIComponent(root.default_branch)}`))
      const snapshot: CiSnapshot = await pullChecks(api, head.sha)
      const previous = state.get<GithubBranchCiState>(GITHUB_KEYS.branchCi)
      // 换过默认分支就从零建立基线：旧分支的失败集合与这个分支无关（`github.ts:257-258`）。
      const known = previous?.branch === root.default_branch ? previous.failures : undefined
      const failing = ciFailures(snapshot)
      const counts = ciCounts(snapshot)
      const current = failing.length || !counts.running ? failing : known ?? []
      let revision = previous?.revision ?? 0
      if (known && JSON.stringify(current) !== JSON.stringify(known)) {
        revision += 1
        const summary = ciSummary(snapshot, root.default_branch, `github/commits/${head.sha}/checks`)
        const url = `https://github.com/${repository}/commit/${head.sha}`
        await engine.receive(branchCiTrigger(root.default_branch, head.sha, revision, summary, url, now))
      }
      state.set(GITHUB_KEYS.branchCi, { branch: root.default_branch, failures: current, revision })
    } catch (error) {
      round.failures.push(`default branch CI: ${String(error)}`)
    }
  }

  /**
   * 读通知并逐个读取它们指向的 Issue / PR（`github.ts:298-343`）。
   *
   * 游标与重试表在同一个事务里落盘：只前进游标而没记下重试，那几条读失败的通知就永久消失。
   * 410 与「24 小时都没读通」的重试被丢掉，但它们**不算**本拍的失败——删掉的话题不该让来源
   * 一直报错（`github.ts:331-341`）。
   */
  async function pollNotifications(round: Round): Promise<void> {
    const stored = state.get<string>(GITHUB_KEYS.since)
    const since = stored ?? round.started
    if (stored === undefined) state.set(GITHUB_KEYS.since, since)
    const path = `notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`
    const page = await api.getPage<unknown>(path)
    const link = page.headers['link']
    const raw = link !== undefined && /rel="next"/.test(link)
      ? await api.slurp<unknown>(path)
      : listOf(page.body)
    const notifications = validItems(NotificationSchema, raw)
    const retries: Record<string, GithubRetry> = { ...state.get<Record<string, GithubRetry>>(GITHUB_KEYS.retries) }
    // 上一拍失败的通知先跑，再按时间正序跑新通知；每条只读一次（`github.ts:316-324`）。
    const items = new Map<number, GithubRetry>(Object.entries(retries).map(([number, retry]) => [Number(number), retry]))
    for (const notification of [...notifications].reverse()) {
      if (!sameName(notification.repository.full_name, repository)) continue
      const address = githubAddress(notification.subject.url ?? '', repository)
      if (!address || address.discussion || items.has(address.number)) continue
      const { number, pr } = address
      items.set(number, { since: [state.get<string>(GITHUB_KEYS.cursor(number)) ?? since, since].sort().at(-1)!, pr })
    }
    for (const [number, item] of items) {
      try {
        await readNotified(round, number, item)
        delete retries[String(number)]
      } catch (error) {
        const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
        const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
        failed(round, number, error, abandoned)
        if (!deleted(error) && !abandoned) {
          retries[String(number)] = retry
          continue
        }
        delete retries[String(number)]
      }
    }
    state.atomic(() => {
      state.set(GITHUB_KEYS.since, cursorAt(round.started))
      state.set(GITHUB_KEYS.retries, retries)
    })
  }

  return {
    async tick(): Promise<void> {
      const started = now()
      lastPollAt = started
      const round: Round = { started, pulls: new Map(), failures: [], dropped: [], abandoned: [] }
      // 通知失败不打断后面的流：同一拍里已经读到的别丢，最后一起报（`github.ts:280-296`）。
      const notified = await pollNotifications(round).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await pollRepository(round)
      await pollBranchCi(round)
      if (!notified.ok) {
        lastError = String(notified.error)
        throw notified.error
      }
      if (round.failures.length) {
        const error = new Error(`${String(round.failures.length)} GitHub reads failed: ${round.failures.slice(0, 3).join('; ')}`)
        lastError = error.message
        throw error
      }
      lastError = null
      const named = (numbers: number[]): string =>
        [...new Set(numbers)].sort((a, b) => a - b).map((number) => `#${String(number)}`).join(', ')
      const dropped = (round.dropped.length ? `; deleted on GitHub: ${named(round.dropped)}` : '')
        + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
      log(`github: poll done at ${started}${dropped}`)
    },
    status(): { lastPollAt: string | null; lastError: string | null } {
      return { lastPollAt, lastError }
    },
  }
}
