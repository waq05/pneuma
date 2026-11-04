# ui-browser（受控浏览器（界面））

一句话：标题写「受控浏览器」，实际是右侧栏里给人用的浏览器页签（Electron 的原生网页视图）；模型那台受控 Chrome 在 `@pneuma/browser`。

## Model Experience（模型体验）

- 纯界面单元：宿主半是空 `apply`，不注册工具（index.ts:3-9、31）。
- 本包不提供模型工具；它画的是用户自己开的浏览器页签（ui/ui.tsx:2-13）。
- 模型侧的受控浏览器工具与审批在 `@pneuma/browser`，两件事共用一个词，但代码不共用（package.json:17-18）。
- 停用它，模型仍能开它那台隔离 Chrome，只是人在右侧栏看不到页签（ui/ui.tsx:50-94）。

## 面板与数据

- 页签体：地址栏、后退 / 前进 / 刷新、用系统浏览器打开；内容由桌面主进程的 WebContentsView 覆盖层画（ui/ui.tsx:5-13、289-356）。
- 数据来源：原生桥 `dockBrowser`（摆位 / 显隐）、`browserNav`、`browserClose`、`browser-state`、`browser-open-requested`（ui/ui.tsx:7-12、118-158）。
- 全局事件 `browser-tab-open-request` / `browser-tab-close-request` 在插件注册处订阅，避免每张页签各收一次（ui/ui.tsx:61-92）。
- 隐藏的页签只摘视图不销毁，第一次露出来才 load（ui/ui.tsx:19-20、160-168）。
- 停用后：右侧栏没有浏览器页签，模型那边的 `browser-tab-open-request` 也没有壳接（ui/ui.tsx:71-87）。

## Known Limitations（已知限制）

- 浏览器（没有原生桥）里只给一句「请打开桌面版」，功能不可用（ui/ui.tsx:246-252）。
- 摆位要等几何稳定，最多重试 120 帧；超了照报，可能摆到窗口外（ui/ui.tsx:170-231）。
- 地址栏草稿与页面地址分开，编辑中不被页面跳转覆盖（ui/ui.tsx:16-18、109-110、134）。
- 新页签不自动加载页面，地址栏回车才进（ui/ui.tsx:22）。
- 用系统浏览器打开走 `openExternal`，实参要过桥的白名单（ui/ui.tsx:281-287）。

## 行与开关

- 行 id `ui-browser`，包名 `@pneuma/ui-browser`，order 352（package.json:10-18）。
- resolution 是 overridable；默认开（cordis.patch.yml 里没有 `disabled`）。
- dsh.client：platform `pneuma`、api `^0.8.1`，没有 phase / inject（package.json:20-25）。
- 宿主半 inject 无、provide 无（index.ts:15-31）。
- title / description 抄的是宿主包 `browser` 的，与界面职责不符（package.json:17-18）。
