/**
 * ui-superagent：「Super Agent」这个界面单元的宿主半，也是这一行在插件清单里的落点。
 *
 * 纯界面插件：真画东西的那半边在 `./ui/ui.tsx`，由界面壳的构建打成
 * `lib/ui/plugins/superagent/client.js`，页面按启动图装载。这一份宿主半没有服务、
 * 没有工具、不监听任何事件——`apply` 是空的，它存在只为**让这一行进 Loader**，
 * 从而在插件中心里有一个能单独停用的开关：停用 `ui-superagent` 后，宿主收集内置产物时
 * 按 `isPluginEnabled('ui-superagent')` 把它滤掉，这个界面单元随之不进启动图
 * （见 `src/core/ui-bundles.ts` 的 `UiArtifactCache.table()`）。停用只影响本界面单元。
 *
 * 工单数据归宿主包 `@pneuma/superagent`（它注册设置分区、往快照里挂 `surfaces.superagent`）；
 * 本包只读它、不写它，两半各自独立启停。
 *
 * order 规则：界面单元专用段 348–368 已被 21 个单元占满（renderer 348、layout 349、
 *  actions 350、ask 351、browser 352、composer 353、files 354、palette 355、
 *  plugins 356、preview 357、prompt 358、sessions 359、settings 360、skills 361、
 *  status 362、statusbar 363、tasks 364、team 365、terminal 366、trace 367、
 *  transcript 368）；段内没有空号，本包接在段尾之后取 369，避免为了一个号去动别人的包。
 *  界面行不做任何事，order 只影响清单的可读性。
 *
 * @module pneuma/ui-superagent
 */

/** 行身份：与 `cordis.patch.yml` 的 `id`、产物目录名（`ui-` 之外的 `superagent`）分开写清楚。 */
export const name = 'ui-superagent'

/**
 * 空实现：这一行的全部行为都在浏览器里。
 *
 * 为什么不是「干脆不写这个包」：没有宿主行就没有身份，插件中心列不出它，
 * 用户也就没有那个开关。
 */
export function apply(): void {}
