/**
 * ui-transcript：「会话流」这个界面单元的宿主半，也是这一行在插件清单里的落点。
 *
 * 纯界面插件：真画东西的那半边在 `./ui/ui.tsx`，由界面壳的构建打成
 * `lib/ui/plugins/transcript/client.js`，页面按启动图装载。这一份宿主半没有服务、
 * 没有工具、不监听任何事件——`apply` 是空的，它存在只为**让这一行进 Loader**
 * （dsh 的 `packages/client/ui-goal` 就是这个形状）。
 *
 * 进了 Loader 才有开关：插件中心里停用 `ui-transcript`，宿主收集内置产物时按
 * `isPluginEnabled('ui-transcript')` 把它滤掉，这个界面单元随之不进启动图
 * （见 `src/core/ui-bundles.ts` 的 `UiArtifactCache.table()`）。停用只影响本界面单元，
 * 折叠事件、快照服务那一半仍在 `@pneuma/transcript` 里照常跑。
 *
 * @module pneuma/ui-transcript
 */

/** 行身份：与 `cordis.patch.yml` 的 `id`、产物目录名（`ui-` 之外的 `transcript`）分开写清楚。 */
export const name = 'ui-transcript'

/**
 * 空实现：这一行的全部行为都在浏览器里。
 *
 * 为什么不是「干脆不写这个包」：没有宿主行就没有身份，插件中心列不出它，
 * 用户也就没有那个开关。
 */
export function apply(): void {}
