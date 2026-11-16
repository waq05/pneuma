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
import { liveTicket } from '../../core/model.js'
import type { ThreadRef, Ticket } from '../../core/model.js'
import { agentPull, pullOf, pullsOf, ticketBranch, type Pull } from './pull.js'
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

/** `claimPull` 要的五个动作。少一个就判不了，所以全是必填；测试给假的就能跑。 */
export interface ClaimPullDeps {
  /** 读一张 PR；抛了算认领失败。 */
  pull(number: number): Promise<Pull>
  /** 本仓库的机器人身份（`agentPull` 的第二个参数）。 */
  account: { login: string; repository: string }
  /** 按 id 读工单（工单层的事实只在工单层读）。 */
  ticket(id: string): Ticket | undefined
  /** 所有开着的工单（查「这张 PR 已经属于别人」）。 */
  openTickets(): readonly Ticket[]
  /** 让工单关注一个线程；`own` 指「这是智能体自己开的」。 */
  bind(ticketId: string, thread: { source: string; id: string }, own: boolean): void
}

/**
 * 这张工单是不是由那张 PR 的消息开的（上游 `claimPull` 的 `started`）。
 *
 * 上游读来源 Trigger 的 `meta.isPr` / `meta.number`（`sources/github-pull.ts:39`），这里只读
 * 得到工单的渠道：`Ticket.channels` 记着它被接单时那些消息的线程，PR 的线程键就是
 * `github:<number>`（`github/trigger.ts:37-41`）。GitHub 的 Issue 与 PR 共用一套编号，同一个
 * 号码不可能既是 Issue 又是 PR，所以这条与上游的 `meta.number` 等价，也不会把 Issue 单
 * 错认成 PR。
 */
function startedFrom(ticket: Ticket, number: number): boolean {
  return ticket.channels.some(channel => channel.source === SOURCE && channel.thread === `${SOURCE}:${String(number)}`)
}

/**
 * 认领一张 PR：报告带 `pr_number` 时先走这里，通过了才写报告（上游 `claimPull`，
 * `sources/github-pull.ts:35-50`；工具侧接线见 `app/tools/executor.ts:88-92`）。
 *
 * 判定顺序照上游，一条都不能换：
 * 1. **工单还开着**：结束的工单不再认领，否则报告写不进去，认领却会留下一条订阅；
 * 2. **读得到 PR**：读失败（404 / 网络 / 令牌）算认领失败，不猜；
 * 3. **这张 PR 是这张单的**：来源 PR（`started`）或机器人自己开的、分支末段等于工单短名
 *    （`opened`），二者满足一个。`agentPull` 还要 head 在自己仓库，挡掉 fork 里的冒充；
 * 4. **没被别的活工单绑着**：一张 PR 只属于一张还开着的单，否则两张单会抢同一份 CI；
 * 5. **开着的 PR 才绑**：关掉 / 合并了的 PR 绑上去也等不到后续，还会让「PR 合并 → 工单结束」
 *    误判成已发生。`own` 只给 `opened`——来源 PR 是这张单开在的线程，不是它自己开的。
 *
 * 已经是这张单的 follow（且开着、`own` 对得上）时不重复绑：重复绑只会多几条同键订阅。
 *
 * @param deps - 读 PR、读工单、绑线程的五个动作
 * @param ticketId - 要认领的工单
 * @param number - PR 号
 * @returns 拒绝原因（中文，说清为什么不行、该传什么）；认领成功或本来就绑着 → undefined
 */
export async function claimPull(deps: ClaimPullDeps, ticketId: string, number: number): Promise<string | undefined> {
  const ticket = deps.ticket(ticketId)
  if (ticket === undefined) return `没有这张工单（${ticketId}）：先确认这张单还在，再报 pr_number`
  if (!liveTicket(ticket)) {
    return '这张工单已经结束了：结束的工单不再认领 PR。要接着干就先在工单线程里回一条消息让它重新打开'
  }
  let pull: Pull
  try {
    pull = await deps.pull(number)
  } catch (error) {
    return `读 PR #${String(number)} 失败（${errorText(error)}）：确认这个号是这张单的 PR；拿不准就先把 pr_number 去掉`
  }
  const started = startedFrom(ticket, number)
  const opened = agentPull(pull, deps.account) && ticketBranch(ticket, pull.head.ref)
  if (!started && !opened) {
    return `PR #${String(number)} 不属于这张工单：要么传这张单来源的那条 PR，要么传机器人（${deps.account.login}）` +
      `自己开的、分支末段是这张单短名（${ticket.execution?.name ?? '还没有定名'}）的 PR；没有 PR 就别传 pr_number`
  }
  const owner = deps.openTickets().find(item => pullsOf(item, true).includes(number))
  if (owner !== undefined && owner.id !== ticketId) {
    return `PR #${String(number)} 已经属于另一张还开着的工单（${owner.id.slice(0, 8)}）：` +
      '一张 PR 只能绑一张工单，把 pr_number 留空，或者在属于它的那张工单里报'
  }
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${String(number)}`)
  // 与上游同一条判据（`sources/github-pull.ts:48`）：已绑着且没关就什么都不做；绑过又关掉的
  // （PR 重新打开）要补回来；`own` 由来源 PR 变成机器人自开时也要把 `own` 纠正过来。
  if (pull.state === 'open' && (follow === undefined || follow.closed !== undefined || (opened && !follow.own))) {
    // 线程 id 用 PR 号，与 `bindAgentPulls` 和适配器报 `threadClosed` 时一致。
    deps.bind(ticketId, { source: SOURCE, id: String(number) }, opened)
  }
  return undefined
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
