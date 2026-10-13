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
 * 还留着的那一条向上边**已清零**（E4 收尾）：原来 `appearance.ts` / `review-pane.tsx` 要
 * `getHostNative` / `readCssColor`、`app.tsx` 要 `setShellPage` / `useThreadView` 这些
 * 页 / 视图真源，它们当时住在 `plugin-api.ts` 里，于是本包只能反向引聚合面 `@dsc/ui`。
 * 现在：宿主桥与读色下沉到 `@dsc/ui-primitives`（`native.ts` / `css.ts`），页 / 视图真源
 * 连同它们的读 hook（`useShellPage` / `useThreadView` / `useTraceFocus`）就在本包
 * （`page-state.ts` / `thread-view.ts`，`@dsc/ui` 只转出）——本包对 `@dsc/ui` 的边为零，
 * `scripts/ui-plugin-test.mjs` 的 [5b] 已把 `@dsc/ui` 列为本包的禁止向上边，防回归。
 * 剩下一条**纯类型**相对边 `../plugin-api`（只有 `import type { UiSlots }`：那个别名由
 * `SlotMap` / `SlotFactoryMap` 拼成，declare 合并只认那个文件身份）——与 ui-slots 同款，
 * 擦除后零字节，在 [5b] 的相对边白名单里列着。
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
