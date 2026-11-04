/**
 * `@pneuma/ui-renderer` 的宿主半：一个空 apply，只为让包加载器认得这个包、并在插件中心
 * 给它留一个**能单独停用的开关**。
 *
 * 渲染器的实体在界面半（`ui/`）：取骨架、建宿主通道、按批装插件、画首帧与骨架诊断。
 * 界面壳的构建（`ui-shell/build-plugins.mjs`）把它打成 `lib/ui/plugins/renderer/client.js`；
 * 引导（`@pneuma/ui-boot` 的 `ui/main.tsx`）按启动图取它、调它的 `start(api)`——
 * **不是**静态 import 进壳的 app bundle。
 *
 * 因此下面这个 apply 里**一行都不该加**：这一行没有任何下发给宿主的功能，它的存在只为
 * 「停用了就真的不装」。停用 `ui-renderer` 后，宿主收集内置产物时按
 * `isPluginEnabled('ui-renderer')` 把它滤掉（见 `src/core/ui-bundles.ts` 的
 * `UiArtifactCache.table()`），引导照不到渲染器就画一块诊断页（说清已停用与怎么打开），
 * 不会是白屏。
 *
 * order 规则：渲染器（348）→ 骨架（349）→ 19 个界面单元（350–368）。渲染器排在骨架前，
 * 因为首帧那一跳由它发起。
 *
 * @module @pneuma/ui-renderer
 */

/** 行身份：与 `cordis.patch.yml` 的 `id`、产物目录名（`ui-` 之外的 `renderer`）分开写清楚。 */
export const name = 'ui-renderer'

/**
 * 空实现：这一行的全部行为都在浏览器里（首帧由引导按启动图调 `start(api)`）。
 */
export function apply(): void {}
