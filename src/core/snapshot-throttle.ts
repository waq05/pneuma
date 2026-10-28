/**
 * 界面快照推送的节流间隔（全仓库唯一一份口径）。
 *
 * 「快照推送」指宿主把当前界面状态推给端起界面（桌面壳走 host-stdio、手机/浏览器走 remote）。
 * 两边原先各抄了一份 `readThrottle`，连缺省值 80 与区间 16～1000 都是两处硬编码——
 * 改一处另一处就跟不上，于是同一次操作在两个界面上的刷新手感不一样。口径挪到这里，
 * 两个插件只负责把自己那份配置读数传进来。
 *
 * 区间为什么是这两个数：下限 16 毫秒约等于一帧，再小就是追着渲染器跑（白烧 CPU）；
 * 上限 1 秒，再大就是点完按钮半天没反应。
 *
 * @module dsc/core/snapshot-throttle
 */
import { clampInt } from './clamp.js'

/** 缺省间隔（毫秒）：约每秒 12 帧，推得勤又不至于压住主线程。 */
export const DEFAULT_SNAPSHOT_THROTTLE_MS = 80

/** 下限（毫秒）：一帧的量级。 */
export const MIN_SNAPSHOT_THROTTLE_MS = 16

/** 上限（毫秒）：再大就点完按钮没反应了。 */
export const MAX_SNAPSHOT_THROTTLE_MS = 1_000

/** 配置里的 `snapshotThrottleMs` → 真正用的毫秒数（不是有限数就取缺省，再夹进 16～1000）。 */
export function snapshotThrottleMs(value: unknown): number {
  return clampInt(value, MIN_SNAPSHOT_THROTTLE_MS, MAX_SNAPSHOT_THROTTLE_MS, DEFAULT_SNAPSHOT_THROTTLE_MS)
}
