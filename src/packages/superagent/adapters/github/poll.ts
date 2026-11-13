/**
 * 轮询的时间口径：游标回退、14 天视野、以及「还该不该继续轮询某个话题」。
 *
 * 这三条是纯算术，单独放一个文件是为了能被逐一钉住：它们错了不会报错，只会「某些事件永远读不到」
 * 或者「同一批通知每拍重读一次」，两种症状都不像 bug，像是 GitHub 抖了一下。
 *
 * 上游 `sources/poll.ts` 里的 `pollThreads` 与 `pause` 没有搬：前者要遍历 `ctx.threads.subscribed()`
 * 并按工单是否还活着决定停不停（DSC 的窄端口不给这个清单），后者是定时器（定时器由接线方起，
 * 本适配器只提供 `tick()`）。缺了它们不影响事件语义，只影响「谁来按时调用 tick」。
 *
 * @module dsc/packages/superagent/adapters/github/poll
 */

/**
 * 订阅过的话题在最后一次事件 / 工单结束之后还继续轮询多久（`sources/poll.ts:6`）。
 *
 * 14 天的理由在上游是「人可能隔一个周末再来回一句」；短于它，隔几天回来的评论就再也读不到。
 */
export const POLL_HORIZON_MS = 14 * 24 * 3600_000

/**
 * 把一拍的开始时刻往前挪 5 秒，当作下一拍的起点（`sources/poll.ts:16`）。
 *
 * 为什么必须重叠：GitHub 的 `since` 是「服务端记录的最后修改时间」，客户端时钟、GitHub 的
 * 索引延迟、以及 `updated_at` 只精确到秒，三者叠起来足以让一条刚落下的评论落在两个窗口的缝里。
 * 重叠带来的重复读不产生重复事件——`Trigger.id` 是内容哈希，`Intake.receive` 对已存在的 id
 * 返回 `duplicate`（`core/intake.ts:23`）。
 */
export const cursorAt = (started: string): string => new Date(Date.parse(started) - 5000).toISOString()

/**
 * 这一拍允许往前读的最早时刻，向下取整到整点（`sources/github.ts:209`）。
 *
 * 取整到整点是为了让「游标一直没动」这件事稳定成立：同一个小时里的每一拍算出的视野相同，
 * 条件请求（`If-None-Match`）才不会因为几秒钟的抖动反复失效。视野本身是上限，防止一个
 * 从没成功过的游标把第一次轮询变成「把 14 天里的全部历史灌进来」。
 */
export function horizonAt(started: string): string {
  const horizon = Math.floor((Date.parse(started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  return new Date(horizon).toISOString()
}

/**
 * 这一拍实际请求的 `since`：存下来的游标与 14 天视野取大者（`sources/github.ts:210`）。
 *
 * 没存过游标时从这一拍开始，而不是从视野开始——「第一次开这个来源」不该把仓库历史读一遍。
 */
export function sinceAt(storedSince: string | undefined, started: string): string {
  const start = Date.parse(started)
  const stored = storedSince === undefined ? Number.NaN : Date.parse(storedSince)
  const from = Number.isFinite(stored) ? stored : start
  return new Date(Math.max(from, Date.parse(horizonAt(started)))).toISOString()
}

/**
 * 这一拍要不要发 `If-None-Match`。
 *
 * 只在 `since` 与上一拍完全相同时才复用 ETag（`sources/github.ts:211/248`）：游标一动，
 * 上次那个 ETag 描述的就是另一段列表了，带上去要么白跑一次 304、要么让服务端拿旧条件
 * 回一个「没变化」，于是新事件被静默吞掉。
 */
export function etagFor(stored: { since: string; etag?: string } | undefined, since: string): string | undefined {
  return stored?.etag !== undefined && stored.since === since ? stored.etag : undefined
}

/**
 * 一个话题还值不值得轮询：它最近一次活动（或结束）在 14 天以内（`sources/poll.ts:8-14`）。
 *
 * 上游自己读工单与话题，这里只收时间戳：本适配器拿不到工单清单，判断留给调用方。
 */
export function polled(times: readonly string[], now: number = Date.now()): boolean {
  const stamps = times.map((time) => Date.parse(time)).filter(Number.isFinite)
  return stamps.length > 0 && now - Math.max(...stamps) < POLL_HORIZON_MS
}
