/**
 * `@dsc/ui-layout`：界面壳的应用骨架与运行时——App 骨架（侧栏 / 主区 / 诊断区）、
 * 审查栏、正文区的两张脸（对话 / 轨迹）、主区整页切换、宿主通道的 React 面、外观落地。
 *
 * 三包里最上的一层：向下依赖 `@dsc/ui-dockkit` 与 `@dsc/ui-primitives`，不许反向。
 * 包里还留着两条**过渡期的向上边**（E4/E6 收尾时该消掉，`scripts/ui-plugin-test.mjs`
 * 的 [5b] 把它们逐条列成白名单，别的向上边一律红）：
 *   - `@dsc/ui`（聚合面）：`appearance.ts` 与 `review-pane.tsx` 要 `getHostNative` /
 *     `readCssColor`，这两个值现在住在 `plugin-api.ts` 里——E4 把宿主桥那一段下沉到
 *     下面某层之后，这两处应改成向下取（那时 [5b] 的白名单一并删掉）。
 *   - `../slots` / `../slots-react` / `../boot`：槽位包与渲染器包（E4）还没拆出来，
 *     先按相对路径用；E4 落地后应改成 `@dsc/ui-slots` / `@dsc/ui-renderer`。
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
