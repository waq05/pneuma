/**
 * PR 的读取与生命周期观察：读一张 PR、判断它是不是智能体在工单分支上开的、以及它合并 / 关闭后
 * 通知核心「这个线程关了」。
 *
 * **没搬的是绑定规则**：上游 `claimPull`（`sources/github-pull.ts:35-50`）与 `observePull` 里的
 * 自动绑定（`:57-69`）要读 `ctx.tickets.open()`、`ctx.triggers.get()`，还要判「一个 PR 只能属于
 * 一张活着的工作单」「分支最后一段等于工单短名」。这些判断在 DSC 属于工单层（`core/tickets.ts`
 * 的 `bind` / `threadClosed`），适配层再写一份就会冒出两套规则，改一处忘另一处。缺了自动绑定的
 * 后果是：工单不会因为「智能体自己开了个 PR」而自动关注它——接线方拿到工单后调
 * `engine.bindThread(ticketId, { source, id }, own)` 补上，本文件把判断所需的两条纯函数
 * （`agentPull` / `ticketBranch`）留着，省得它再写一遍。
 *
 * 同理，`claimPull` 的「这张 PR 是不是本工单的」没有搬：`observePull` 只做「结束就报
 * `threadClosed`」，谁该关注这张 PR 由工单层决定。
 *
 * @module dsc/packages/superagent/adapters/github/pull
 */
import { z } from 'zod'
import { key } from '../../core/ids.js'
import type { Follow, ThreadRef, Ticket } from '../../core/model.js'
import type { OutboundMessage } from '../../core/ports.js'
import type { GithubApi } from './api.js'
import { githubPage, sameName, SOURCE, UserSchema } from './trigger.js'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }

/** 读一张 PR；`number` 补进结果，因为 API 的响应体里没有它（`github-pull.ts:16-17`）。 */
export async function readPull(api: GithubApi, number: number): Promise<Pull> {
  return { ...PullSchema.parse(await api.get(`pulls/${String(number)}`)), number }
}

/** `github:12` → 12；不是 GitHub 线程给 `undefined`（`github-pull.ts:18`）。 */
const pullNumber = (thread: string): number | undefined =>
  thread.startsWith(`${SOURCE}:`) ? Number(thread.slice(SOURCE.length + 1)) : undefined

/** 工单关注的 PR 编号；`open` 为真时只算还没关闭的（`github-pull.ts:19-21`）。 */
export function pullsOf(ticket: Pick<Ticket, 'follows'>, open = false): number[] {
  return (ticket.follows ?? []).filter((item) => !open || !item.closed).flatMap((item) => pullNumber(item.thread) ?? [])
}
/** 工单最近关注的那张 PR：优先还开着的，其次最后关闭的。 */
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined =>
  pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)

/**
 * 这张 PR 是不是智能体在本仓库里开的（不是从 fork 来的，`github-pull.ts:23-25`）。
 *
 * 两个条件缺一不可：登录名是它自己，head 仓库是本仓库。少了后一半，别人在自己的 fork 里
 * 开一张同名分支的 PR，就能冒充「工作单的 PR」。
 */
export function agentPull(
  pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: { login: string; repository: string },
): boolean {
  return sameName(pr.user.login, deployment.login) && sameName(pr.head?.repo?.full_name ?? '', deployment.repository)
}

/** 分支属于这张工单：最后一段路径等于工单短名，例如 `agent/<name>`（`github-pull.ts:27-28`）。 */
export function ticketBranch(ticket: Pick<Ticket, 'execution'>, ref: string): boolean {
  return !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
}

/** 本模块对核心的唯一要求：一个线程关闭了。只声明用得到的，别把整个 Engine 递进来。 */
export interface PullCloser {
  /**
   * `reason` 取 `'merged'` / `'closed'`，与上游 `threadClosed` 的 outcome 同义
   * （`sources/github-pull.ts:83`）；`at` 是关闭发生的时刻，不知道就不传。
   */
  threadClosed(thread: ThreadRef, reason?: string, at?: string): unknown
}

/**
 * 观察一张 PR 的开 / 合并 / 关闭状态（`github-pull.ts:57-69` 的可搬部分）。
 *
 * 结束就报 `threadClosed`：核心只对「有关注这张 PR 的工单」动手（`core/tickets.ts:77-90`），
 * 没有工单关注时是一次空操作，所以重复调用不会重复结束谁。
 *
 * `at` 用 PR 自己的 `merged_at` / `closed_at`（`github-pull.ts:82`）：用轮询时刻会让工单的
 * 结束时间晚几分钟，而「关闭之后又有新工作」的判定正是拿这个时刻比的。
 *
 * @returns 这张 PR 是否已经结束
 */
export async function observePull(closer: PullCloser, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) {
    closer.threadClosed({ source: SOURCE, id: String(pr.number) }, pr.merged ? 'merged' : 'closed', pr.merged_at ?? pr.closed_at ?? undefined)
  }
  return ended
}

/**
 * 工单因 PR 结束时要发出的通知（`github-pull.ts:90-105`）。
 *
 * 只发给**非 GitHub 渠道**：GitHub 自己的时间线和关联 Issue 已经显示了合并 / 关闭，再往 PR 里
 * 回一句「已合并」是噪声。通知语言跟随触发这张工单的那句话：有汉字且没有假名就说中文。
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter((item) => item.closed && pullNumber(item.thread) !== undefined)
  const latest = (items: Follow[]): Follow | undefined => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter((item) => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = pullNumber(follow.thread)!
  const url = githubPage(repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${String(number)}](${url}) 已合并。` : `[PR #${String(number)}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${String(number)}](${url}) has merged.` : `[PR #${String(number)}](${url}) was closed without merging.`
  return ticket.channels.filter((channel) => channel.source !== SOURCE).map((channel) => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome),
    channel,
    text,
    kind: 'notice',
    ticketId: ticket.id,
  }))
}
