/**
 * `@dsc/ui-dockkit`：右侧栏（dock）那一套——分栏模型、会话级状态与画法。
 *
 * 与 dsh 的 `ui-dockkit` 同位，包内也照它的两层切：`dock-model`（纯数据 + 纯函数，
 * 无 React）在底，`dock-state`（模块级订阅状态 + 插件登记面）在中，`dock`（React 画法）在上。
 *
 * 分层纪律（由 `scripts/ui-plugin-test.mjs` 的 [5b] 钉住）：本包只许往下——
 * 依赖 `@dsc/ui-primitives`（图标 / 文件图标）与 `@dsc/ui-core`；不许 import
 * `@dsc/ui-layout`（布局在其上），也不许 import `@dsc/ui`（聚合面，反向会成环）。
 *
 * @module dsc-ui-shell/ui-dockkit
 */
export * from './dock-model'
export * from './dock-state'
export * from './dock'
