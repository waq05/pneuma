/**
 * `@dsc/ui-primitives`：壳的基元库——图标、载体基元（Text）、平台视图（代码 / markdown /
 * PDF / 表格 / 差异行）、文件图标、面板几何、toast / confirm、时间与 token 口径。
 *
 * 为什么单独成包（E2）：这一层本来就是壳里最下的一层——不依赖槽位、不依赖插件 API、
 * 不依赖 dock 与布局。E6 要把「基元库」作为平台种子下发给插件（dsh 的 `ui-primitives`
 * 是同一位），包边界得先立在这里，插件才能 require 到壳里这一份实现，而不是各自内联
 * 一份（同一枚图标内联在几个插件里，改一次就得改好几处）。
 *
 * 分层纪律（由 `scripts/ui-plugin-test.mjs` 的 [5b] 逐文件走查 import 钉住）：
 * **只许往下、不许往上**——本包不能 import `@dsc/ui-dockkit` / `@dsc/ui-layout`
 * 与 `@dsc/ui`（那三个都在它上面，反向依赖会被 alias 解析成第二份实现）。
 * 例外只有第三方依赖（react / shiki / react-markdown / pdfjs / vscode-icons…）
 * 与更底层的 `@dsc/ui-core`。
 *
 * 每个模块都 `export *` 出来（不是节选）：老路径的转发壳 re-export 整个索引，
 * 漏掉一个模块，该模块的名字就会在运行期变成 undefined——那种错编译期看不见。
 *
 * `package.json` 的 `"sideEffects": false` 是**必须留着**的一行（别当样板删掉）：本包的模块
 * 全是纯声明，而插件 bundle 现在经转发壳整索引进图——没有这个声明，rollup 会把
 * `file-icons` 依赖的 `vscode-icons-js`（CJS、摇不动树）内联进每个用到基元的插件 bundle
 * （实测 5 个插件各 +81KB）。E6 把本包作为平台种子下发、插件改成运行期 require 之后，
 * 这一行仍应保留（谁也不想为了一枚图标再各带一份 81KB 的表）。
 *
 * @module dsc-ui-shell/ui-primitives
 */
export * from './icons'
// 载体基元：终端壳的同名基元在 `src/ui/tui-plugin-api.ts`（那里 Text 是 ink 的 <Text>）。
export * from './plugin-text'
// 平台层（原 `src/platform/*`，全部与 React/DOM 打交道、不碰槽位与插件 API）。
export * from './code-view'
export * from './completion-sound'
export * from './confirm'
export * from './diff-rows'
export * from './file-icon-map.generated'
export * from './file-icons'
export * from './highlight'
export * from './hover-delay'
export * from './lang-table'
export * from './markdown'
export * from './panels'
export * from './paths'
export * from './pdf-view'
export * from './select'
export * from './table-view'
export * from './thread-resizer'
export * from './time'
export * from './toast'
export * from './tokens'
export * from './tool-summary'
