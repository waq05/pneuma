/**
 * B4 流式渲染：1,000 个变更灌进 TUI 的帧合并器，量通知次数与耗时。
 *
 * ## 被测对象
 *
 * `lib/packages/tui/app/snapshot-subscribe.js` 的 `createCoalescedStore`
 * （源码 `src/packages/tui/app/snapshot-subscribe.ts:51`）。这是 TUI 把
 * 「上游每个 delta 一次通知」折成「一个窗口一次取值」的真实实现，桌面/远程的 80ms
 * 合并与之同值。基准直接灌它的上游监听器，不经过 React/ink——测的是合并策略本身，
 * 而不是某个组件树有多大。
 *
 * ## 口径
 *
 * - 起点 = 同步循环灌第 1 个变更前一刻；终点 = 第 2 次（trailing）通知落下；
 * - 1,000 个变更在同一个同步任务里灌入：第 1 个走 leading 立即放值，其余 999 个攒到
 *   窗口末尾走 trailing 一次；
 * - `value` 是「爆发开始 → 静默」的耗时，主要由合并窗口 `TUI_SNAPSHOT_MS`（80ms）决定，
 *   因此很稳；`detail.notifications` 应恒为 2，`detail.upstreamReads` 也应为 2
 *   （窗口内不重复读上游，这是冻结取值的前提）。
 *
 * 设计 §4.2 给 B4 的退化线是 1.3×，本层按任务约定统一用 1.5×；额外把
 * 「通知次数」当作结构性判据——合并失效时它会先于耗时暴露（1,000 次而不是 2 次）。
 *
 * ## 输出
 *
 * 一行 `BENCH_RESULT {id,label,metric,value,detail}`。value 单位毫秒。
 *
 * @module tests/bench/b4-stream-render
 */
import { createTempHome, emitResult, fail, libUrl } from './helpers.mjs'

const ID = 'b4-stream-render'
const LABEL = 'B4 流式渲染'
const CHANGES = 1000
/** 等第 2 次通知的兜底上限；远大于合并窗口，红了说明定时器/合并逻辑坏了。 */
const WAIT_TIMEOUT_MS = 5000

createTempHome('dsc-bench-b4-')

const { createCoalescedStore, TUI_SNAPSHOT_MS } = await import(
  libUrl('packages/tui/app/snapshot-subscribe.js')
)

let upstreamReads = 0
let upstreamListener = null
const store = createCoalescedStore(
  () => ({ revision: (upstreamReads += 1) }),
  (listener) => {
    upstreamListener = listener
    return () => {
      upstreamListener = null
    }
  },
  { ms: TUI_SNAPSHOT_MS },
)

const notificationAt = []
let resolveTrailing = null
let rejectTrailing = null
const trailing = new Promise((resolvePromise, rejectPromise) => {
  resolveTrailing = resolvePromise
  rejectTrailing = rejectPromise
})
// 这个定时器是 ref 的：合并器内部的 trailing 定时器 unref 过，光等 Promise 进程会提前退出。
const guard = setTimeout(() => rejectTrailing(new Error(`${WAIT_TIMEOUT_MS}ms 内没等到 trailing 通知`)), WAIT_TIMEOUT_MS)

const unsubscribe = store.subscribe(() => {
  notificationAt.push(performance.now())
  if (notificationAt.length === 2) resolveTrailing()
})

try {
  const startedAt = performance.now()
  for (let index = 0; index < CHANGES; index += 1) {
    if (upstreamListener === null) throw new Error('上游订阅在灌入过程中被断开')
    upstreamListener()
  }
  const pendingAfterBurst = store.pending()
  await trailing
  clearTimeout(guard)

  const elapsedMs = notificationAt[1] - startedAt
  const snapshotA = store.getSnapshot()
  const snapshotB = store.getSnapshot()
  const stillPending = store.pending()

  if (notificationAt.length !== 2) throw new Error(`通知次数 ${notificationAt.length}，期望 2（leading + trailing）`)
  if (pendingAfterBurst !== true) throw new Error('爆发结束时合并器没有攒下待放变更（trailing 丢了）')
  if (upstreamReads !== 2) throw new Error(`上游读取 ${upstreamReads} 次，期望 2（窗口内不应重复读）`)
  if (stillPending !== false) throw new Error('trailing 通知之后合并器仍标记 pending')
  if (snapshotA !== snapshotB) throw new Error('两次 getSnapshot() 返回了不同引用（窗口内没有冻结）')

  emitResult({
    id: ID,
    label: LABEL,
    metric: 'ms',
    value: Math.round(elapsedMs * 1000) / 1000,
    detail: { changes: CHANGES, notifications: notificationAt.length, upstreamReads, windowMs: TUI_SNAPSHOT_MS },
  })
} catch (error) {
  fail(`${LABEL}：${error instanceof Error ? error.message : String(error)}`)
} finally {
  clearTimeout(guard)
  unsubscribe()
}
