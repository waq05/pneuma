/**
 * `@dsc/ui-renderer`：界面渲染器的浏览器半边——首帧入口 `start(api)` 与骨架诊断。
 *
 * 与 dsh 的 `dsh-client-ui-renderer` 同位：引导（`@dsc/ui-boot`）按启动图取它、调
 * `start(api)`；它再取骨架、建通道、装插件、渲染 App。停用本包后引导画诊断页。
 *
 * `ui/ui.tsx` 是**插件入口**（界面壳的构建把它打成 `client.js`），本索引只是作者面的
 * 出口：类型与 `start` 从这里转出，方便类型产物与探针按包名引。`ui/main.tsx` 的时代
 * 已经结束——页面入口搬到了引导包。
 *
 * @module dsc-ui-shell/ui-renderer
 */
export { default, start } from './ui'
