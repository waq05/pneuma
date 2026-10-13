/**
 * `@dsc/ui-layout`：界面壳的应用骨架与运行时——App 骨架（侧栏 / 主区 / 诊断区）、
 * 审查栏、正文区的两张脸（对话 / 轨迹）、主区整页切换、宿主通道的 React 面、外观落地。
 *
 * 三包里最上的一层：向下依赖 `@dsc/ui-dockkit`、`@dsc/ui-primitives` 与
 * `@dsc/ui-slots`，不许反向。
 *
 * E4 收掉的反向边：原来 `app.tsx` 直接取 `../boot`（白名单读数 + 装载账本）与 `../hmr`
 * （失败清单句柄）——那会让 `ui-layout → ui-renderer → ui-layout` 成环。现在装载会话与
 * 热更句柄的份额按结构定义在 `app.tsx`（`AppBootSession` / `AppSyncHandle`），由入口以
 * props 递进来；`scripts/ui-plugin-test.mjs` 的 [5b] 把 `@dsc/ui-renderer` 列为本包
 * 的禁止向上边，防回归。
 *
 * 还留着的一条向上边（E4 范围外，[5b] 仍放行，见其注释）：`@dsc/ui`（聚合面）——
 * `appearance.ts` 与 `review-pane.tsx` 要 `getHostNative` / `readCssColor`，`app.tsx`
 * 要 `setShellPage` / `useThreadView` 这些页 / 视图真源；它们现在住在 `plugin-api.ts` 里，
 * 把宿主桥与页状态下沉到下面某层之后才能改成向下取。
 *
 * @module dsc-ui-shell/ui-layout
 */
export * from './app'
export * from './appearance'
export * from './host-channel'
export * from './page-state'
export * from './review-pane'
export * from './runtime-context'
export * from './thread-view'
