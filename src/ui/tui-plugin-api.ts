/**
 * TUI 载体的 `@dsc/ui` 值面：终端壳的 require 表把 `'@dsc/ui'` 解析到这一份，
 * 浏览器壳解析到 ui-shell 的 plugin-api——**同一份插件 bundle** 两个载体各拿各的实现
 * （阶段 6 的「同一份插件源码两种载体各跑一次」就落在这里）。
 *
 * 插件能拿到的值面刻意只有两样：
 *   - `defineUiPlugin`：标识函数（与浏览器版同一个实现）；
 *   - 载体基元 `Text`：浏览器版是 `<span>`，这里是 ink 的 `<Text>`——插件的渲染层
 *     只要站在基元上，就不必知道自己在哪种壳里。
 *
 * 槽位注册、宿主通道都**不**从这里给：`apply(ui)` 的 `ui.slots` / `ui.runtime`
 * 是壳在装载时传进来的（`src/ui/plugin.ts` 的契约），与载体无关。
 *
 * @module dsc/ui/tui-plugin-api
 */
import { Text } from 'ink'
import { defineUiPlugin } from './plugin.js'

/** 终端壳声明的槽名（对齐浏览器壳的 `ui-shell/src/ui-slots/slots.ts` 的常量做法）。 */
export const TUI_SLOTS = {
  /** 通知盒下方的插件扩展行（list）：插件在这里放一行状态说明。 */
  noticeExtensions: 'tui.notice.extensions',
} as const

export { defineUiPlugin, Text }
