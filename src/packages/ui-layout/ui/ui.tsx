/**
 * 界面骨架的界面半：布局插件在浏览器里的**注册面**。
 *
 * 这一份是界面壳构建（`ui-shell/build-plugins.mjs`）的入口，产物落
 * `lib/ui/plugins/layout/client.js`；页面入口（`ui-renderer/ui/main.tsx`）按启动图取它，
 * 拿 `App` 挂到 `#root`。
 *
 * 为什么不是把实现搬进这个 bundle：`@dsc/ui`（`ui-shell/src/plugin-api.ts:298-323`）把
 * 本包的读 hook 整包转出给插件——插件里写的 `useHostSnapshot()` / `useShellPage()` /
 * `useThreadView()` 用的就是**壳里那一份**本包实例。骨架里的 App 与这些 hook 必须共享
 * 同一份模块级状态（RuntimeContext、页与视图的信号、外观落地），bundle 里再内联一份就会
 * 出现第二个 RuntimeContext：插件一渲染就抛「useHostChannel 必须在 RuntimeProvider 里用」。
 * 所以 `@dsc/ui-layout` 与 ui-slots / ui-primitives / ui-dockkit 一样是平台种子——装载器的
 * require 表给的是壳里这一份，这条 `./client` 只负责「登记这一行」与「转出挂载面」。
 *
 * 转出的这几项就是 main.tsx 首帧要用的全部：App、通道工厂、React 上下文与外观落地。
 *
 * @module @pneuma/ui-layout/client
 */
// 值引用 `@dsc/ui`：这个文件是**插件入口**（界面半），与 19 个界面单元的写法一致，
// 产物里因此保持一条 `require("@dsc/ui")`（构建时它是 external，拿的是壳那一份）。
// 注意 `scripts/ui-plugin-test.mjs` 的 [5b] 目前把本目录当成纯层库、禁止值引用 `@dsc/ui`
// ——这一条对本文件需要豁免（它不在壳的图里，也不会把插件 API 内联进包）。
import { defineUiPlugin } from '@dsc/ui'

export {
  /** 整张页面只有这一个骨架：侧栏 / 主区 / 诊断区。 */
  App,
  /** 宿主通道（SSE 收帧 + POST 调方法）；首帧前先建它，装插件时一并交出去。 */
  createHostChannel,
  /** 把通道挂进 React 树（`useHostSnapshot` 那一族 hook 的上下文）。 */
  RuntimeProvider,
  /** 外观落地的唯一一份实现（主题 / 字号 / 密度写到 document 根元素上）。 */
  applyAppearance,
  appearanceFromPrefs,
  DEFAULT_APPEARANCE,
  loadCachedAppearance,
  saveCachedAppearance,
} from '@dsc/ui-layout'

/**
 * 布局插件本体。
 *
 * `apply` 里不登记任何东西：骨架的槽（`shell.page` / `shell.header` …）由
 * `@dsc/ui-slots` 声明、由 19 个界面单元往里放，App 由页面入口按启动图取来挂载。
 * 这一行的意义是**可停用**：停用后产物不进启动图，入口画诊断页而不是白屏
 * （见 `cordis.patch.yml` 与 `ui-renderer/ui/main.tsx`）。
 */
export default defineUiPlugin({
  name: '界面骨架',
  apply() {
    // 没有要登记的东西：骨架不是「往槽里放一块」，它就是槽被放进的那张纸。
  },
})
