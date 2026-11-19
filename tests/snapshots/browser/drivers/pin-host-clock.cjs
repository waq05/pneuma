/**
 * 宿主进程的「钉死时钟」预加载（经 `node --require` 注入，见 `dom.snapshot.ts` 的
 * `pinnedHostNow`）。
 *
 * ## 为什么需要它
 *
 * 05 场景把**页面**时钟钉在 `SNAP_NOW`（`dom.snapshot.ts` 的 `PIN_CLOCK_BOOT`），但侧栏
 * 「当前未落盘会话」那一行的时间戳来自**宿主进程**：`src/packages/session/index.ts:144-151`
 * 给这条会话补 `createdAt: session.meta.createdAt`，而 `session.meta.createdAt` 是
 * `Session.create()` 里的 `Date.now()`（`src/core/session.ts:664`）。页面拿钉死的
 * `Date.now()` 减宿主的真实时刻（`src/packages/ui-sessions/ui/ui.tsx:112-121` 的
 * `relativeTime`）：
 *
 * - 真实时刻早于 `SNAP_NOW`（2026-11-17 12:00 本地）→ 差值非负 → 显示「刚刚」→ DOM 里有
 *   一行 `<time>`；
 * - 一旦真实时刻晚于 `SNAP_NOW` → 差值为负 → `relativeTime` 返回空串 → 这一行整行消失，
 *   golden 从 128 行变 127 行。
 *
 * 也就是说「只钉页面、不钉宿主」的修法从 2026-11-17 12:00 起任何机器都必红。这里把宿主
 * 时钟也钉到同一个 `SNAP_NOW`，两侧的 `Date.now()` 完全相等，`relativeTime` 恒为「刚刚」。
 *
 * ## 口径与页面侧一致
 *
 * 只替换 `new Date()`（无参构造）与 `Date.now()`；`new Date(ts)` / `Date.parse` / `Date.UTC`
 * 不动（与 `PIN_CLOCK_BOOT` 同款）。Node 自己的计时走单调时钟，不受影响；`src/**` 里没有
 * 靠 `Date.now()` 推进的轮询循环，所以常量时钟不会卡住宿主启动。
 *
 * 未设 `DSC_DOM_HOST_NOW`（或值不是有限数字）时本文件什么都不做——其它场景照旧用真实时钟。
 */
'use strict'

const raw = process.env['DSC_DOM_HOST_NOW']
const fixed = raw === undefined || raw === '' ? Number.NaN : Number(raw)

if (Number.isFinite(fixed)) {
  class PinnedDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(fixed)
      else super(...args)
    }

    static now() {
      return fixed
    }
  }
  globalThis.Date = PinnedDate
}
