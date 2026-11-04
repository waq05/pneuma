/**
 * ui-statusbar：「状态栏」这个界面单元的宿主半，也是这一行在插件清单里的落点。
 *
 * 纯界面插件：真画东西的那半边在 `./ui/ui.tsx`，由界面壳的构建打成
 * `lib/ui/plugins/statusbar/client.js`，页面按启动图装载。这一份宿主半没有服务、
 * 没有工具、不监听任何事件——`apply` 是空的，它存在只为**让这一行进 Loader**，
 * 从而在插件中心里有一个能单独停用的开关：停用 `ui-statusbar` 后，宿主收集内置产物时
 * 按 `isPluginEnabled('ui-statusbar')` 把它滤掉，这个界面单元随之不进启动图
 * （见 `src/core/ui-bundles.ts` 的 `UiArtifactCache.table()`）。停用只影响本界面单元。
 *
 * order 规则：19 个界面单元统一占 350–368 专用段，按 id 字典序逐个编号
 * （actions 350、ask 351、browser 352、composer 353、files 354、palette 355、
 *  plugins 356、preview 357、prompt 358、sessions 359、settings 360、skills 361、
 *  status 362、statusbar 363、tasks 364、team 365、terminal 366、trace 367、transcript 368）；
 *  本包是 statusbar，order = 363。界面行不做任何事，order 只影响清单的可读性。
 * dsh.client.phase 原样保留 `early`（首屏批：装完壳才画第一帧）。
 *
 * @module pneuma/ui-statusbar
 */

/** 行身份：与 `cordis.patch.yml` 的 `id`、产物目录名（`ui-` 之外的 `statusbar`）分开写清楚。 */
export const name = 'ui-statusbar'

/**
 * 空实现：这一行的全部行为都在浏览器里。
 *
 * 为什么不是「干脆不写这个包」：没有宿主行就没有身份，插件中心列不出它，
 * 用户也就没有那个开关。
 */
export function apply(): void {}
