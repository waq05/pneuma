/**
 * 把 GitHub 的 issue / PR / 评论 / review / CI 变化变成领域 `Trigger`。
 *
 * 纯函数，不发请求、不读时钟（时钟由最后一个可选参数注入），因为这里的每一个字段都是**契约**：
 *
 * - `id` 是内容哈希。公式改一个字符，同一条评论就会被当成新事件再派一次工单；
 * - `meta` 的键名决定准入与观察。上游 `sources/github.ts:32-37` 的 `scopeOf` 只认
 *   `meta.ci` / `meta.branch` / `meta.kind`；`sources/github-read.ts:163/168` 只认
 *   `meta.branch` / `meta.number` / `meta.kind` / `meta.commentId`。改名的后果不是报错，
 *   是「整类事件不再被观察」，而且没有任何一条日志会说。
 *
 * 所以本文件逐字照搬上游 `sources/github-trigger.ts` 的取值与拼装顺序，只把依赖换掉：
 * `infra/text.ts` 的 `sameName` / `escapeRegExp` 就地实现（DSC 没搬那个模块），
 * `SOURCE` 取自 `adapters/settings.ts` 的 `GITHUB_SOURCE`，保证来源名只有一处拼写。
 *
 * @module dsc/packages/superagent/adapters/github/trigger
 */
import { z } from 'zod'
import { key } from '../../core/ids.js'
import type { ChannelRef, Trigger } from '../../core/model.js'
import { GITHUB_SOURCE } from '../settings.js'

/** 来源名。同时是 `Trigger.source`、线程 id 前缀与策略里的来源键（上游 `sources/kind.ts:7`）。 */
export const SOURCE = GITHUB_SOURCE

/** 大小写不敏感地比两个身份（GitHub 的登录名与仓库名都不区分大小写，`infra/text.ts`）。 */
export const sameName = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

/** 转义成字面量正则片段，供 `@login` 匹配用（`infra/text.ts`）。 */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 默认时钟：上游在多处直接 `new Date().toISOString()`，这里收成一个可注入的参数，行为不变。 */
type Clock = () => string
const defaultClock: Clock = () => new Date().toISOString()

/** 回复地址：issue / PR 的会话，或 `url` 指向讨论评论时的 review 线程（`github-trigger.ts:8-9`）。 */
export const githubChannel = (number: number, url?: string): ChannelRef => ({
  source: SOURCE,
  thread: `${SOURCE}:${String(number)}`,
  address: { number: String(number), ...(url === undefined ? {} : { url }) },
})

/** 网页地址，用于「去 GitHub 看这条」。 */
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${String(number)}`

/**
 * 解析 Issue、PR 或 review 评论的网页 / API 地址（`github-trigger.ts:13-18`）。
 *
 * 返回 `undefined` 表示「不是这个仓库的 Issue/PR」——通知里混着别的仓库、commit、文件页时，
 * 调用方据此跳过，而不是猜一个编号出来。
 */
export function githubAddress(
  url: string,
  repository: string,
): { number: number; pr: boolean; discussion?: number } | undefined {
  const address = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
}

/** GitHub 把已注销的账号返回成 `null`，网页上显示为 `ghost`（`github-trigger.ts:20-21`）。 */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform((user) => user ?? { login: 'ghost', type: 'User' })

/**
 * 一条评论或一个 review。
 *
 * review 带 `state` 与 `commit_id`；行内评论带文件、行号、diff 片段，`in_reply_to_id` 是它
 * 所在 review 线程的根评论 id（`github-trigger.ts:26-32`）。
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>

/** 一个 Issue；编号是 PR 时 GitHub 会带上 `pull_request`（`github-trigger.ts:35-39`）。 */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>

/** 新建时能拿到的字段：Issue 与 PR 共用一份（`github-trigger.ts:40`）。 */
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>

/** 评论挂在哪个 Issue / PR 上；`url` 是它的网页地址，`prAuthor` 只在 PR 上有。 */
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string }

/**
 * GitHub 报告的是「普通用户」而不是机器人或 App（`github-trigger.ts:46-47`）。
 *
 * 为什么不用「有 `[bot]` 后缀」一条判据：GitHub App 的账号一定是 `[bot]`，但跑在普通账号
 * 下的评审机器人不是。上游的选择是「普通账号一律算人」，由提示词去说明哪些账号是自动化的；
 * 这里照抄，因为把普通账号判成机器人的后果是「它对智能体说的需求永远不成立」。
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')

/** 行内评论的文件:行号与 diff 末尾几行；GitHub 的 diff 片段就截止在被评论的那一行（`github-trigger.ts:49-53`）。 */
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${String(line)}` : ''}`, hunk].filter(Boolean).join('\n')
}

/** 评论正文；review 的结论（APPROVED / CHANGES_REQUESTED）即使没有正文也要进 `text`（`github-trigger.ts:54-59`）。 */
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}

/**
 * 正文里是否 @ 了智能体（`github-trigger.ts:60-61`）。
 *
 * 两侧的边界字符是必须的：`mail@agent-bot.example` 不是 @ 它，`@agent-bot2` 也不是。
 */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)

/** 作者与「是不是人」：智能体自己的消息算机器人（`github-trigger.ts:62-63`）。 */
const author = (user: { login: string; type?: string }, agent: string):
  { actor: { source: string; id: string }; human: boolean } =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })

/**
 * 一条评论或 review 的 Trigger（`github-trigger.ts:65-77`）。
 *
 * `id` 四段固定：`github-comment` + 评论网页地址（没有就用 `github:<编号>`）+ 评论 id + 版本
 * （`updated_at ?? submitted_at ?? ''`）。版本进 id 是编辑后能重新派单的原因：同一条评论被
 * 改了，`updated_at` 变、id 变，核心才认得这是一条新事件。
 *
 * @param now - 缺时间字段时的兜底时刻；测试注入定值
 */
export function commentTrigger(
  comment: GithubComment,
  ref: PullRef,
  kind: 'conversation' | 'inline' | 'review',
  agent: string,
  now: Clock = defaultClock,
): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? now()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key('github-comment', comment.html_url ?? `${SOURCE}:${String(ref.number)}`, String(comment.id), version)
  return {
    id,
    source: SOURCE,
    threads: [{ source: SOURCE, id: String(ref.number) }],
    ...author(comment.user, agent),
    at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: {
      number: ref.number,
      isPr: ref.isPr,
      ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}),
      commentId: comment.id,
      kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {},
    },
  }
}

/**
 * 新开的 Issue：标题 + 正文（`github-trigger.ts:82-89`）。
 *
 * `id` 只有 `github-issue` + 编号：Issue 的正文没有可编辑的「版本」概念，同一张单永远同一个
 * 事件 id，于是重复读到不会重复派单。
 */
export function issueTrigger(issue: Opened, agent: string): Trigger {
  const body = issue.body ?? ''
  return {
    id: key('github-issue', String(issue.number)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.number) }],
    ...author(issue.user, agent),
    at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(issue.number, issue.html_url),
    url: issue.html_url,
    meta: { number: issue.number, isPr: false, kind: 'issue' },
  }
}

/**
 * 新开的 PR：标题 + 描述（`github-trigger.ts:94-96`）。
 *
 * PR 与 Issue 的编号在 GitHub 上是同一个序列，永不冲突，所以这里复用 `github-issue` 的 id
 * 公式；`meta.kind` 与 `isPr` 才是区分「这是 PR」的地方。
 */
export function pullTrigger(pull: Opened, agent: string): Trigger {
  return { ...issueTrigger(pull, agent), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}

/**
 * 默认分支 CI 的一次状态变化（`github-trigger.ts:98-102`）。
 *
 * `actor.id` 是空串、`human: false`：CI 没有发话的人。也**没有 `channel`**——这个事件没有可以
 * 回话的地方，硬填一个 `channel` 会让回复队列往一个不存在的会话投递。
 */
export function branchCiTrigger(
  branch: string,
  sha: string,
  revision: number,
  summary: string,
  url: string,
  now: Clock = defaultClock,
): Trigger {
  return {
    id: key('github-ci', `branch:${branch}`, String(revision)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }],
    actor: { source: SOURCE, id: '' },
    human: false,
    at: now(),
    text: summary,
    url,
    meta: { ci: true, branch, sha, revision },
  }
}

/**
 * 某个 PR 的 CI 状态变化（`github-trigger.ts:103-107`）。
 *
 * `revision` 只数「上报过的变化次数」，所以同一份快照重复读到不会造出新 id；它挂在 PR 的线程上，
 * 因此可以回到 PR 里回话。
 */
export function ciTrigger(
  pr: { number: number; html_url: string; user: { login: string } },
  revision: number,
  summary: string,
  now: Clock = defaultClock,
): Trigger {
  return {
    id: key('github-ci', String(pr.number), String(revision)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: String(pr.number) }],
    actor: { source: SOURCE, id: '' },
    human: false,
    at: now(),
    text: summary,
    channel: githubChannel(pr.number),
    url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision },
  }
}
