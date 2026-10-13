/**
 * `@dsc/ui-renderer`：界面壳的渲染器/装载器包——启动图取回、分批装载、平台种子表、
 * 插件热更对账与页面入口。
 *
 * 与 dsh 的 `modules`（浏览器半边：load/materialize）＋`ui-renderer`（渲染出口）同一个位置。
 * dsc 的壳小，装载内核与入口合在一位上，不再切第二刀（切了要动 A2/A3 的取数路径，收益为零）。
 * 包内分工：`boot.ts` 是装载会话与平台种子表（`MODULES`），`hmr.ts` 是它的热更半边，
 * `main.tsx` 是入口（声明槽 → 装插件 → 渲染 App）。
 *
 * 分层纪律（[5b] 钉）：本包在最上层，向下依赖 `@dsc/ui-layout`（App 与运行时）、
 * `@dsc/ui-slots`、`@dsc/ui`（种子里的插件契约面）与 `@dsc/ui-core`；
 * `../platform-modules.json` 是数据文件（平台模块表的单一事实源）。
 *
 * `main.tsx` **刻意不从本索引转出**：它带顶层副作用（`void bootstrap()` 真的挂载应用），
 * 谁 import 到它谁就会起一个壳；入口只由 `index.html` 指向。
 *
 * @module dsc-ui-shell/ui-renderer
 */
export * from './boot'
export * from './hmr'
