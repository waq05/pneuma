/**
 * 时:分:秒（全仓库唯一一份）。
 *
 * 两处曾经各写一份：浏览器那条链的输出（`core/cdp/report.ts`）与沙箱的拒载日志
 * （`plugins/sandbox.ts`）。两份不只看写法不同，**时区也不一样**——前者走
 * `toISOString()`（UTC），后者取本地时分秒。于是同一个用户在同一个界面里会看到两套时间，
 * 北京时间的用户会以为浏览器的时钟坏了。
 *
 * 现在统一成**本地时间**：日志是给人看的，人按自己墙上的钟读它。要 UTC 的地方
 * （例如按天统计用量，`plugins/commands.ts` 取日期）本来就该走 `toISOString().slice(0, 10)`，
 * 那是另一件事，不在这里。
 *
 * @module dsc/core/clock
 */

/** 时间戳 → `HH:MM:SS`（本地时间，各段补零）。 */
export function clockText(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
