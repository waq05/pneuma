# ui-renderer（界面渲染器）

一句话：界面壳的渲染器——取骨架、建宿主通道、按批装插件、画首帧与骨架诊断。

## Model Experience（模型体验）

- 渲染器是首帧的发起者：引导把启动图交来之后，它先取骨架（布局插件）再建通道，界面从这一刻才有内容。
- 骨架缺席时它画诊断页（说清「已停用 / 加载失败」与怎么打开），不会白屏让模型以为壳坏了。
- 平台种子的白名单读数由引导传进来，渲染器不反向读装载器（两包之间只有一条类型边）。
- 热更对账的引擎在引导（`@pneuma/ui-boot/hmr.js`），渲染器只把它接到宿主通道上。

## Known Limitations（已知限制）

- 它现在是**能停用的插件**（有行、有开关）：停用 `ui-renderer` 后产物不进启动图，引导画诊断页；停用只影响下一次页面加载，当前页不会自己变回诊断页。
- 它是插件 bundle（纯 JS），带不了 CSS：界面样式仍住在本包的 `ui/styles/`，但由引导的 app bundle 按相对路径挂上。
- 它不能按值 import 引导（`@pneuma/ui-boot` 不在平台模块表里）：装载会话、热更、服务表 React 面都从 `start(api)` 的入参拿；唯一的跨包 import 是类型。
- 改一行就要重建整个壳（`pnpm -C ui-shell build`），重建前页面上的还是旧的那一份。
- 它是**第一批**（`phase: early`）：引导必须先物化它才能开始首帧，所以它不能像普通界面单元那样延后到空闲时刻。

## 谁在用它

- `ui-shell/index.html` 指向引导（`ui-boot/ui/main.tsx`）；引导按启动图找到 `renderer` 这一条并调 `start(api)`。
- 界面插件的 `client.js` 由渲染器经引导的装载会话分批装进 cordis。
- `ui-layout` 的 `client.js` 由渲染器在首帧前显式取回，拿它的 `App` / 通道 / `RuntimeProvider` 挂到 `#root`。
