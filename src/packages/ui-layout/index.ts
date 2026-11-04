/**
 * `@pneuma/ui-layout` 的宿主半：一个空 apply，只为让包加载器认得这个包、并在插件中心
 * 给它留一个**能单独停用的开关**。
 *
 * 骨架的实体在界面半（`ui/`）：App、页与视图的真源、宿主通道的 React 面、外观落地。界面壳的
 * 构建（`ui-shell/build-plugins.mjs`）把它打成 `lib/ui/plugins/layout/client.js`，页面入口
 * （`src/packages/ui-renderer/ui/main.tsx`）按启动图取它、拿 `App` 挂到 `#root`——
 * **不是**静态 import 进壳的 app bundle。
 *
 * 因此下面这个 apply 里**一行都不该加**：这一行没有任何下发给宿主的功能，它的存在只为
 * 「停用了就真的不装」。停用 `ui-layout` 后，宿主收集内置产物时按
 * `isPluginEnabled('ui-layout')` 把它滤掉（见 `src/core/ui-bundles.ts` 的
 * `UiArtifactCache.table()`），入口照不到骨架就画一块诊断页（说清已停用与怎么打开），
 * 不会是白屏。
 *
 * 与三个种子包（ui-slots / ui-primitives / ui-dockkit）的差别：那三个没有 `./client`、
 * 没有行（插件按包名 require 到的是壳里同一份实例）；本包既有 `./client`（页面按启动图
 * 装载的挂载面），也在平台种子里（`@dsc/ui` 把本包的读 hook 整包转出给插件，骨架与插件
 * 必须读同一份模块状态——见 `ui/ui.tsx` 抬头）。
 *
 * order 规则：19 个界面单元占 350–368（按 id 字典序），本包是那 19 个画图用的纸，取 349。
 *
 * @module @pneuma/ui-layout
 */

/** 行身份：与 `cordis.patch.yml` 的 `id`、产物目录名（`ui-` 之外的 `layout`）分开写清楚。 */
export const name = 'ui-layout'

/**
 * 空实现：这一行的全部行为都在浏览器里（骨架由页面入口挂载）。
 */
export function apply(): void {}
