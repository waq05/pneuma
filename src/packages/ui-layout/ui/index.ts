/**
 * `@dsc/ui-layout`：界面壳的**画图**那一半——App 骨架（侧栏 / 主区 / 诊断区）、审查栏、
 * 更新按钮；入口是 `ui.tsx`（插件 `ui-layout` 的 `./client`）。
 *
 * 2026-11-04 夜按「状态 / 画图」重新切了一刀：宿主通道、RuntimeContext 与读数 hook、页与
 * 视图信号、外观落地、今日用量都搬进 `@pneuma/ui-runtime`（库包、平台种子）。
 * 理由是那些是**状态**，全页只能有一份，且必须与插件读到的是同一份；而这里是**组件**，
 * 正是布局插件自己该带走的东西——所以本包的 `client.js` 从 1.3 KB 变成几十 KB 的真实现。
 *
 * 分层纪律（由 `scripts/ui-plugin-test.mjs` 的 [5b] 逐文件走查 import 钉住）：
 * 向下只用 `@dsc/ui-runtime`、`@dsc/ui-primitives`、`@dsc/ui-slots`、`@dsc/ui-dockkit`；
 * 不许 import `@dsc/ui-renderer`（会成环），也不许值引用 `@dsc/ui`。
 *
 * @module dsc-ui-shell/ui-layout
 */
export * from './app'
export * from './review-pane'
export * from './update-button'
