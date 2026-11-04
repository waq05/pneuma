/**
 * 界面骨架的界面半：布局插件在浏览器里的**挂载面**。
 *
 * 这一份是界面壳构建（`ui-shell/build-plugins.mjs`）的入口，产物落
 * `lib/ui/plugins/layout/client.js`；页面渲染器（`ui-renderer/ui/ui.tsx`）按启动图取它，
 * 拿 `App` 挂到 `#root`。
 *
 * 2026-11-04 夜起，**实现就在这个 bundle 里**（不再转手去 require 平台的种子）：
 * 共享状态（宿主通道、RuntimeContext、页 / 视图信号、外观落地）搬进了 `@pneuma/ui-runtime`，
 * 剩下的骨架、审查栏、更新按钮是纯粹的组件——这正是「停用布局插件就真的省掉这块代码」
 * 该有的样子。
 *
 * 于是导出面只剩 `App`：通道、`RuntimeProvider`、外观落地都由渲染器直接从
 * `@dsc/ui-runtime` 取（同一份种子实例），不再经布局转手。
 *
 * @module @pneuma/ui-layout/client
 */
// 值引用 `@dsc/ui`：本文件是**插件入口**，与 19 个界面单元的写法一致——构建时它是
// external，产物里留一条 `require("@dsc/ui")`，拿的是壳里那一份（不会把插件 API 内联进包）。
import { defineUiPlugin } from '@dsc/ui'

/**
 * 整张页面只有这一个骨架：侧栏 / 主区 / 诊断区。
 *
 * 组件本体在同包的 `app.tsx`，构建时整棵内联进本 bundle（`@dsc/ui-*` 是 external）。
 */
export { App } from './app'

/**
 * 布局插件本体。
 *
 * `apply` 里不登记任何东西：骨架的槽（`shell.page` / `shell.header` …）由
 * `@dsc/ui-slots` 声明、由 19 个界面单元往里放，App 由页面渲染器按启动图取来挂载。
 * 这一行的意义是**可停用**：停用后产物不进启动图，渲染器画诊断页而不是白屏
 * （见 `cordis.patch.yml` 与 `ui-renderer/ui/ui.tsx`）。
 */
export default defineUiPlugin({
  name: '界面骨架',
  apply() {
    // 没有要登记的东西：骨架不是「往槽里放一块」，它就是槽被放进的那张纸。
  },
})
