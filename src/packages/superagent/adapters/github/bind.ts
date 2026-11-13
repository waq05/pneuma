/**
 * 工单与 PR 之间那两条接线：把「智能体自己开的 PR」绑到工单上、以及每拍看一眼已关注 PR 的 CI。
 *
 * **为什么单独成文件**：这两件事原来写在 `index.ts` 的 `apply()` 闭包里。闭包里的依赖是
 * `ctx`、`store`、`runtime` 这些活对象，测试造不出来，于是它俩一行用例都没有——而它们的
 * 失败方式是静默的：PR 认领不上不会报错，症状只是「CI 一直没反应」「PR 合并了工单不结束」。
 * 抽出来之后依赖只剩五个小函数，测试可以只给假的。
 *
 * **为什么绑定规则不放在来源适配器里**：判断「这张 PR 属于哪张单」要工单清单与工单的
 * `execution`，那是工单层的事实；放进适配器等于让适配层反向依赖工单层，工单规则也会复制成
 * 两套（上游 `sources/github-pull.ts:35-50` 就是这么耦合的，移植时刻意没搬）。所以本文件
 * 只做「读事实 → 交判断给 `core` 的纯函数 → 调接线方给的动作」。
 *
 * @module dsc/packages/superagent/adapters/github/bind
 */
import type { ThreadRef, Ticket } from '../../core/model.js'
import { agentPull, pullOf, ticketBranch } from './pull.js'
import { SOURCE } from './trigger.js'

/** 一张开着的 PR 里，判归属用得到的三个字段（`agentPull` / `ticketBranch` 的入参）。 */
export interface OpenPull {
  number: number
  user: { login: string }
  head?: { ref?: string; repo?: { full_name: string } | null } | null
}

/** 把未知异常压成一行。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `bindAgentPulls` 要的五个动作。少一个就绑不了，所以全是必填。 */
export interface BindPullsDeps {
  /** 读这个仓库里开着的 PR。抛了算这一拍失败：不绑任何单，下一拍再来。 */
  pulls(): Promise<readonly OpenPull[]>
  /** 还活着、可能还缺一张 PR 的工单；`openTickets()` 的结果直接给进来。 */
  tickets(): readonly Pick<Ticket, 'id' | 'follows' | 'execution'>[]
  /** 机器人在这个仓库里的身份：登录名与 `owner/name`。 */
  account: { login: string; repository: string }
  /** 让工单关注一个线程；`own` 指「这是智能体自己开的」。 */
  bind(ticketId: string, thread: ThreadRef, own: boolean): unknown
  /** 记一行。绑失败不该让整拍失败，所以只记不抛。 */
  log?(line: string): void
}

/** 这一拍绑上的那一对；接线方可以拿它去记日志或显示。 */
export interface BoundPull {
  ticketId: string
  number: number
}

/**
 * 把智能体自己开的 PR 绑到对应工单上。
 *
 * 两个条件缺一不可，都由 `pull.ts` 的纯函数给：`agentPull`（登录名是机器人、head 仓库是
 * 本仓库——少了后一半，别人在自己 fork 里开一张同名分支的 PR 就能冒充）与 `ticketBranch`
 * （分支末段等于工单短名）。
 *
 * 已经关注过 PR 的单跳过：一张单只认一张 PR，重复绑只会多几条订阅。一张 PR 只绑给第一张
 * 名字对得上的单——`find` 的顺序就是工单清单的顺序，后面的单下拍再看它是否已被别人绑走。
 *
 * @returns 这一拍绑上的每一对；读 PR 失败时是空数组
 */
export async function bindAgentPulls(deps: BindPullsDeps): Promise<BoundPull[]> {
  let pulls: readonly OpenPull[]
  try {
    pulls = await deps.pulls()
  } catch (error) {
    deps.log?.(`读开着的 PR 失败：${errorText(error)}`)
    return []
  }
  if (pulls.length === 0) return []
  const bound: BoundPull[] = []
  for (const ticket of deps.tickets()) {
    if (pullOf(ticket) !== undefined) continue
    const mine = pulls.find((pr) => agentPull(pr, deps.account)
      && typeof pr.head?.ref === 'string' && ticketBranch(ticket, pr.head.ref))
    if (mine === undefined) continue
    try {
      // 线程 id 用 PR 号：适配器报 threadClosed 时也是这个（`pull.ts` 的
      // `{ source: SOURCE, id: String(pr.number) }`），两边对不上就永远等不到关闭事件。
      deps.bind(ticket.id, { source: SOURCE, id: String(mine.number) }, true)
      bound.push({ ticketId: ticket.id, number: mine.number })
      deps.log?.(`工单 ${ticket.id} 认领了 PR #${String(mine.number)}`)
    } catch (error) {
      deps.log?.(`工单 ${ticket.id} 绑 PR #${String(mine.number)} 失败：${errorText(error)}`)
    }
  }
  return bound
}

/** 一张该看 CI 的 PR：哪个工单、第几号。 */
export interface PullWatch {
  ticketId: string
  number: number
}

/** 这一拍该看 CI 的那些 PR。没有 PR 的工单不在里面。 */
export function pullWatches(tickets: readonly Pick<Ticket, 'id' | 'follows'>[]): PullWatch[] {
  return tickets.flatMap((ticket) => {
    const number = pullOf(ticket)
    return number === undefined ? [] : [{ ticketId: ticket.id, number }]
  })
}

/** `pollTicketChecks` 要的两个动作。 */
export interface PullCiDeps {
  /** 还活着、可能关注了 PR 的工单。 */
  tickets(): readonly Pick<Ticket, 'id' | 'follows'>[]
  /** 看一眼这张 PR 的 CI。抛了只记一行，不影响别的工单。 */
  check(number: number): Promise<void>
  log?(line: string): void
}

/**
 * 每张关注了 PR 的工单看一眼 CI。
 *
 * 为什么不在 `createGithubSource().tick()` 里做：来源不知道「哪些 PR 该看」——那是工单自己
 * 的 `follows` 才记着的事实。分开做也让「事件流失败」与「某张 PR 的 CI 失败」互不牵连。
 *
 * 每张 PR 的检查同时发（不是一个接一个等）：`check` 在第一次 `await` 之前就已经把请求发出去了，
 * 各 PR 之间没有先后依赖，串行只会让五张 PR 的轮询变成五次网络往返。
 *
 * @returns 全部检查结束时完成；单张失败不改变这件事，也不会抛
 */
export async function pollTicketChecks(deps: PullCiDeps): Promise<void> {
  await Promise.all(pullWatches(deps.tickets()).map(async (watch) => {
    try {
      await deps.check(watch.number)
    } catch (error) {
      deps.log?.(`工单 ${watch.ticketId} 的 PR CI 轮询失败：${errorText(error)}`)
    }
  }))
}
