/**
 * GitHub 的只读面：CI 快照，以及「把 Issue / PR / 评论读成人能看懂的几条消息」。
 *
 * 搬的是上游 `sources/github-read.ts:1-154` 的整个只读面（CI 快照 + 对话读法）；**没搬的是
 * `githubThreadContext`（`github-read.ts:159-177`）**，原因是它依赖上游 `sources/kind.ts` 的
 * `ThreadContext` / `ContextPart`——那套接口的语义是「按 part（root / parent / thread）增量读上下文，
 * 回一个 `{ messages, body, status, next }` 给评估器」，DSC 没有这个概念（`core/` 里上下文由
 * 执行器自己组织）。缺了它的后果不是丢事件：行内 review 评论的 Trigger 照样进来，只是**评估侧
 * 要自己补读一次 review 线程**才能看到前后文——用本文件的 `readGithub(api, 'github/pulls/9/thread/5')`
 * 就行，读法与上游一致。同样没搬的是 `readRepositoryPath`（`github-read.ts:47-57`）：DSC 的执行器
 * 在本地工作树里读文件，不需要走 API 读仓库内容。
 *
 * @module dsc/packages/superagent/adapters/github/read
 */
import { z } from 'zod'
import type { ThreadFact } from '../../core/model.js'
import { validItems, type GithubApi, type Tally } from './api.js'
import { CommentSchema, isHumanLogin, IssueSchema, reviewPlace, type GithubComment } from './trigger.js'

const CheckSchema = z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })
const StatusSchema = z.looseObject({ context: z.string(), state: z.string() })
type Check = Pick<z.infer<typeof CheckSchema>, 'name' | 'status' | 'conclusion'>
type Status = Pick<z.infer<typeof StatusSchema>, 'context' | 'state'>

/** 一个提交的 CI 快照：检查任务 + 提交状态（两套 GitHub 机制，要合起来看才准）。 */
export interface CiSnapshot { head: string; checks: Check[]; statuses: Status[] }

/** 算作失败的结论 / 状态；`success`、`neutral`、`skipped`、`stale` 不算（`github-read.ts:15`）。 */
const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])

/** 失败与进行中的条数，供线程事实与「还在跑就别报恢复」的判定用（`github-read.ts:16-22`）。 */
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  const statuses = snapshot.statuses ?? []
  return {
    failed: snapshot.checks.filter((check) => FAILING.has(check.conclusion ?? '')).length
      + statuses.filter((status) => FAILING.has(status.state)).length,
    running: snapshot.checks.filter((check) => check.status !== 'completed').length
      + statuses.filter((status) => status.state === 'pending').length,
  }
}

/**
 * 一段给人看 / 给模型看的 CI 摘要（`github-read.ts:23-36`）。
 *
 * 结构固定为「失败优先，其次进行中，最后通过」，并附一条「去哪读全部检查」的指路：
 * 摘要只是入口，不能让读者以为失败就这几个。
 */
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  const checks = snapshot.checks.map((check) => ({
    name: check.name, failed: FAILING.has(check.conclusion ?? ''), running: check.status !== 'completed',
  }))
  const statuses = (snapshot.statuses ?? []).map((status) => ({
    name: status.context, failed: FAILING.has(status.state), running: status.state === 'pending',
  }))
  const results = [...checks, ...statuses]
  const failed = results.filter((result) => result.failed).map((result) => result.name)
  const running = results.filter((result) => result.running).map((result) => result.name)
  const names = (list: string[]): string =>
    list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${String(list.length - 5)} more` : '')
  const at = `on ${where} at ${snapshot.head.slice(0, 7)}`
  const still = running.length ? `; ${String(running.length)} still running` : ''
  const line = failed.length ? `CI failed ${String(failed.length)}/${String(results.length)} ${at}: ${names(failed)}${still}`
    : running.length ? `CI running ${String(running.length)}/${String(results.length)} ${at}: ${names(running)}`
      : `CI passed ${String(results.length)}/${String(results.length)} ${at}`
  return `${line}\nRead ${read} for every check.`
}

/**
 * 失败集合，排序后的名字列表（`github-read.ts:37-40`）。
 *
 * 为什么是「名字集合」而不是指纹：默认分支的 CI 只在失败集合变化时上报，
 * 一个还在跑的检查换了个名字不该触发一轮工作。
 */
export function ciFailures(snapshot: CiSnapshot): string[] {
  return [
    ...snapshot.checks.filter((check) => FAILING.has(check.conclusion ?? '')).map((check) => check.name),
    ...(snapshot.statuses ?? []).filter((status) => FAILING.has(status.state)).map((status) => status.context),
  ].sort()
}

/** 线程上的一条 CI 事实：失败优先，其次进行中，否则通过（`github-read.ts:41-45`）。 */
export function ciFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}

/**
 * 读一个提交的检查与状态（`github-read.ts:60-70`）。
 *
 * 两份数据都要读：`check-runs` 是 Actions 等新机制，`statuses` 是老的外部状态（Vercel、Jenkins
 * 的预览）。只看一份，另一份的失败就变成「CI 通过」——那是最坏的一种错。
 *
 * 状态按 context 取**最新一条**：GitHub 把同一个 context 的历次状态按时间倒序返回，
 * 所以「先出现的那条」就是最新的。
 */
export async function pullChecks(api: GithubApi, head: string, tally?: Tally): Promise<CiSnapshot> {
  const page = z.looseObject({ check_runs: z.array(z.unknown()) })
  const pages = (await api.slurp<unknown>(`commits/${head}/check-runs?per_page=100`))
    .flatMap((value) => { const parsed = page.safeParse(value); return parsed.success ? [parsed.data] : [] })
  const runs = validItems(CheckSchema, pages.flatMap((item) => item.check_runs), tally)
  const statuses = validItems(StatusSchema, await api.slurp<unknown>(`commits/${head}/statuses?per_page=100`), tally)
  const latest = new Map<string, string>()
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state)
  const checks = runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }))
  return {
    head,
    checks: checks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    statuses: [...latest].map(([context, state]) => ({ context, state })).sort((a, b) => a.context.localeCompare(b.context)),
  }
}

/** 一条给模型看的 GitHub 消息（上游 `sources/kind.ts:58-61` 的 `ContextMessage`，DSC 没有这个模块）。 */
export interface GithubMessage {
  id: string
  from: string
  at: string
  text: string
  bot?: true
  reply_to?: string
  url?: string
  path?: string
  line?: number
}

/** 把评论 / review / Issue 格式化成一条消息；机器人要标出来，因为机器的消息永远不构成授权（`github-read.ts:73-78`）。 */
function githubMessage(item: GithubComment, text: string, id: string): GithubMessage {
  const line = item.line ?? item.original_line
  return {
    id,
    from: item.user.login,
    at: item.created_at ?? item.submitted_at ?? '',
    text,
    ...!isHumanLogin(item.user) ? { bot: true as const } : {},
    ...item.html_url ? { url: item.html_url } : {},
    ...item.path ? { path: item.path, ...line != null ? { line } : {} } : {},
  }
}

/** review 的正文：结论（APPROVED / CHANGES_REQUESTED）单独一行在前（`github-read.ts:79-80`）。 */
const reviewText = (review: GithubComment): string =>
  [review.state && review.state !== 'COMMENTED' ? review.state : '', review.body ?? ''].filter(Boolean).join('\n\n')

const DescriptionSchema = IssueSchema.extend({
  labels: z.array(z.looseObject({ name: z.string() })).nullish(), draft: z.boolean().nullish(), merged: z.boolean().nullish(),
  head: z.looseObject({ ref: z.string() }).nullish(), base: z.looseObject({ ref: z.string() }).nullish(),
})

/**
 * 一条行内评论所在的整个 review 线程，按时间正序（`github-read.ts:85-90`）。
 *
 * 根评论的判定要认「给我的这条本身就是回复」：`in_reply_to_id` 指向根，于是从任意一条回复
 * 出发都能捞回同一个线程——评估器手里拿到的往往正是回复，而不是根。
 */
async function reviewThread(api: GithubApi, number: number, comment: number, tally?: Tally): Promise<GithubComment[]> {
  const comments = validItems(CommentSchema, await api.slurp<unknown>(`pulls/${number}/comments?per_page=100`), tally)
  const root = comments.find((item) => item.id === comment)?.in_reply_to_id ?? comment
  return comments.filter((item) => item.id === root || item.in_reply_to_id === root)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
}

/** 线程消息：第一条带上文件:行号与 diff 片段，后面的标出在回谁（`github-read.ts:91-96`）。 */
function threadMessages(thread: GithubComment[], id: (comment: GithubComment) => string): GithubMessage[] {
  const [first] = thread
  return thread.map((item) => item === first
    ? githubMessage(item, [reviewPlace(item), item.body ?? ''].filter(Boolean).join('\n\n'), id(item))
    : { ...githubMessage(item, item.body ?? '', id(item)), ...first ? { reply_to: id(first) } : {} })
}

/**
 * 按资源名读 GitHub 的对话内容（`github-read.ts:102-141`）。
 *
 * 资源名是给评估器与执行器用的稳定标识，不暴露原始 API 形状：换接口时改这里，调用方的提示词
 * 不用动。支持的形状与上游一致：
 * `github/issues/<n>`、`github/pulls/<n>`、`/comments/<page>`、`/reviews/<page>`、`/thread/<comment-id>`、
 * `/checks`，以及 `github/commits/<sha>/checks`。
 */
export async function readGithub(api: GithubApi, resource: string): Promise<unknown> {
  // 一个提交的 CI，比如默认分支的；没有 PR 会指向它（`github-read.ts:104-105`）。
  const commit = /^github\/commits\/([0-9a-f]{7,40})\/checks$/.exec(resource)
  if (commit) return pullChecks(api, commit[1]!)
  const match = /^github\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) {
    throw new Error('Use github/issues/<number>, github/pulls/<number>, or append /comments/<page>, /reviews/<page>, /thread/<comment-id> or /checks; or github/commits/<sha>/checks')
  }
  const [, kind, number, section, page = '1'] = match
  if (kind === 'issues' && (section === 'reviews' || section === 'checks' || section === 'thread')) {
    throw new Error('Reviews, review threads and checks require a pull request')
  }
  const path = `${kind!}/${number!}`
  if (section === 'checks') {
    if (match[4]) throw new Error('Checks do not take a page number')
    const head = z.looseObject({ head: z.looseObject({ sha: z.string() }) }).parse(await api.get(path))
    return pullChecks(api, head.head.sha)
  }
  if (section === 'thread') {
    if (!match[4]) throw new Error('Name the review thread by one of its comments: github/pulls/<number>/thread/<comment-id>')
    const thread = await reviewThread(api, Number(number), Number(match[4]))
    if (!thread.length) throw new Error('No review comment of this PR has that id')
    return { messages: threadMessages(thread, (item) => String(item.id)) }
  }
  if (!section) {
    const item = DescriptionSchema.parse(await api.get(path))
    const branches = item.head && item.base ? { head: item.head.ref, base: item.base.ref } : {}
    const labels = item.labels?.length ? { labels: item.labels.map((label) => label.name) } : {}
    return {
      number: item.number, title: item.title, state: item.state, ...item.merged ? { merged: true } : {},
      ...item.draft ? { draft: true } : {}, ...branches, ...labels, ...githubMessage(item, item.body ?? '', String(item.number)),
    }
  }
  const listed = await api.get<unknown>(`${path}/${section}?per_page=20&page=${page}`)
  // 列表端点回了非数组说明响应形状变了；静默当空列表会让这一页的消息永久消失。
  if (!Array.isArray(listed)) throw new Error('GitHub returned a non-list response')
  const tally: Tally = { skipped: 0 }
  const items = validItems(CommentSchema, listed, tally)
  const messages = items.map((item) => section === 'reviews'
    ? githubMessage({ ...item, created_at: item.submitted_at ?? item.created_at }, reviewText(item), String(item.id))
    : { ...githubMessage(item, item.body ?? '', String(item.id)), ...item.in_reply_to_id ? { reply_to: String(item.in_reply_to_id) } : {} })
  return {
    messages,
    ...tally.skipped ? { skipped: tally.skipped } : {},
    // 满一页才可能有下一页：上游按「这一页正好 20 条」判断（`github-read.ts:140`），这里照抄。
    ...listed.length === 20 ? { next_resource: `github/${kind}/${number}/${section}/${String(Number(page) + 1)}` } : {},
  }
}
