/**
 * `@dsc/ui-slots`：界面壳的槽位包——槽名契约（`SLOT` / `SHELL_SLOTS` / 往 `SlotMap` 并表）
 * 与浏览器壳的 React 渲染出口（`SlotOutlet` / `ChainOutlet` / Factory 出口）。
 *
 * 与 dsh 的 `ui-slots` 同位。为什么契约与出口合成一个包而不照 dsh 再拆「纯契约 / 渲染器」：
 * dsh 拆是因为它的 `ui-slots` 是 React-free 的 npm 包、渲染出口另有 `ui-renderer` 消费；
 * dsc 的槽名表与出口是**同一份数据**（`declare module` 并进 SlotMap 的 9 个壳槽就是出口在
 * 渲染时用的那张表），拆开只会多一处漂移面。
 *
 * 分层纪律（由 `scripts/ui-plugin-test.mjs` 的 [5b] 逐文件走查 import 钉住）：
 * 运行时只依赖 `@dsc/ui-core` 与 react（由种子提供）；对 `../plugin-api` 的引用是**类型面**
 * （`SlotMap` 契约表、`UiComponent` 等，擦除后零字节）——`declare module` 的合并落在
 * **文件身份**上（re-export 不参与合并），必须按相对路径写，是刻意保留的一条边。
 * 不许 import `@dsc/ui-dockkit` / `@dsc/ui-layout` / `@dsc/ui-renderer` / `@dsc/ui`（都在上面）。
 *
 * @module dsc-ui-shell/ui-slots
 */
export * from './slots'
export * from './slots-react'
