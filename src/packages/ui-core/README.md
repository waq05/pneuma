# ui-core（界面共用核心库）

一句话：宿主与界面壳共用的界面契约实现——槽位注册表、服务表、席位（store）、帧归并、到达协议、
插件契约，外加终端壳（ink）那一半的装载器。除终端壳外都不依赖具体载体，浏览器安全。

## Model Experience（模型体验）

- 这个库本身对模型不可见：模型既不 import 它，也不在提示词里看到它。它决定的是模型输出**怎么被画出来**。
- 模型流式输出的每一帧由 `frames.ts` 归并进快照（严格版：认不出的帧直接报错，不做兜底），工具卡与正文因此能逐帧更新。
- 工具卡、状态条、设置页这些位置由 `slots.ts` 的注册表装配；插件在 `apply` 里登记，卸载时按 `scoped-slots.ts` 的账本逆序回滚。
- 正文 token 粗估、吞吐读数、diff 解析等口径经桶文件（`index.ts`）从 `src/core` 转出，界面显示与宿主计算同源，模型看到的「~N tok」「速度」不会与宿主口径分叉。
- 终端壳走的也是这一份契约：`tui-plugins.ts` 按同一套槽位/服务语义装载 `platform: 'tui'` 的插件，所以同一份插件源码能在两种壳里各跑一次。

## Known Limitations（已知限制）

- 浏览器安全是硬约束：除 `tui-*.ts` 外不 import 任何 node 内置模块；加一个 node 依赖就会让界面壳构建失败。
- `@dsc/ui-core` 故意不在平台种子表里（`ui-shell/build-plugins.mjs` 的 `EXTERNAL`）：插件当值引用会得到「白名单外的模块」。插件只能用 `@dsc/ui` 与 `@dsc/ui-primitives` 转出的那一份。
- 启动图（`ui-manifest.ts`）已归内核（`src/core/ui-manifest.ts`）；本包只是把它再转出一次以保持壳的导入面不变，修改排序或类型要去 core 改。
- 终端壳的 React 订阅面（`slots-ink.tsx`）与浏览器壳共用 `slots-react.ts`，但渲染出口各自实现；TUI 没有 Factory 渲染出口（没有消费者）。
- 本包的 SDK 类型树按仓库相对结构摆放（`packages/ui-core/**` + `core/**` + `contract.d.ts`），源码里的 `../../core/*.js` 在类型产物里才原样成立；改目录深度要同步改 `ui-shell/build-types.mjs`。

## 谁在用它

- `ui-shell/src/plugin-api.ts`：`@dsc/ui` 聚合面从这里取值与类型。
- `src/packages/ui-{layout,primitives,slots,renderer,dockkit}/ui/**`：槽位、席位、服务、帧、信号与原生桥规格。
- `src/core/ui-bundles.ts` / `ui-boot-source.ts` / `ui-hmr.ts` / `ui-server.ts`：启动图的类型与排序走 `src/core/ui-manifest.ts`（本包再转出）。
- `src/packages/tui/index.ts`：按裸说明符取终端壳那一半（`@pneuma/ui-core/slots.js`、`slots-ink.js`、`tui-plugins.js`、`tui-plugin-api.js`）。
