/**
 * `@dsc/ui-runtime`：界面壳的共享运行时——宿主通道、React 上下文与读数 hook、
 * 页与视图信号、外观落地、今日用量。
 *
 * 为什么单独成包（2026-11-04 夜）：布局插件要把自己的骨架搬进**自己的 bundle**
 * （`lib/ui/plugins/layout/client.js`），可这些状态必须全页只有一份——
 * 插件里的 `useHostSnapshot()` 与骨架里的 `RuntimeProvider` 落在两份 context 上，
 * 首渲染就会抛「useHostChannel 必须在 RuntimeProvider 里用」。于是按「状态 / 画图」切：
 *
 *   - 状态（本包）：共享，进平台种子表，插件按包名 require 到壳里这一份；
 *   - 画图（`@pneuma/ui-layout`）：骨架、审查栏、更新按钮，随布局插件的 bundle 走。
 *
 * 分层纪律（`scripts/ui-plugin-test.mjs` 的 [5b] 逐文件走查 import 钉住）：
 * 本包只许往下——不能 import `@dsc/ui-layout` / `@dsc/ui-renderer` / `@dsc/ui`。
 *
 * 与 dsh 的对应：那边的 `ui-slots` / `ui-primitives` 是种子包、`ui-layout` 是插件；
 * 本包就是「种子」这一档里承载宿主连接与运行时上下文的那一格。
 *
 * @module @dsc/ui-runtime
 */
export * from './appearance'
export * from './host-channel'
export * from './page-state'
export * from './runtime-context'
export * from './thread-view'
export * from './usage-today'

// 原生桥的两枚常量：诊断区要拿它渲染「桥已就绪 / 版本对不上」那一行（`app.tsx`）。
// 它们住 `@dsc/ui-core`，而 `@dsc/ui-core` 是**故意不下发给插件**的（构建期保留成 external，
// 运行期撞「白名单外的模块」）。布局插件的 bundle 只能从平台种子里拿，所以在这里转出一次——
// 与 `@dsc/ui-primitives` 转出 `getHostNative` 是同一个理由。
export { NATIVE_BRIDGE_VERSION, NATIVE_OPS } from '@dsc/ui-core'
