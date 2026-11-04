# ui-runtime（界面运行时）

一句话：界面壳的共享运行时——宿主通道、React 上下文与读数 hook、页与视图信号、外观落地、今日用量；作为平台种子下发给界面插件。

## Model Experience（模型体验）

- 模型看不到这一层，但界面里的每一个读数都经过它：会话快照、连接状态、页切换、正文的两张脸、今日用量，全从这里的 context 与信号读出来。
- 模型写出的东西要等这里把宿主帧推上来才会出现在屏幕上；通道断线时界面显示「重连中」，而不是把所有内容当成空。
- 它不注册工具、不写提示词、不画任何 DOM：画图在 `@pneuma/ui-layout` 与 19 个界面单元里。

## Known Limitations（已知限制）

- 它是库包（`pneuma.library: true`），**没有独立的 `client.js`**、没有装配行，因此不能单独安装或停用——这是刻意的：它装的是状态，全页只能有一份。
- 改一行就要重建整个壳（`pnpm run build`），重建前页面上的还是旧的那一份。
- 只许往下：不能 import `@dsc/ui-layout` / `@dsc/ui-renderer` / `@dsc/ui`（反向依赖会被 alias 解析成第二份实现，症状是首渲染抛「必须在 RuntimeProvider 里用」）。
- 外观落地带着模块级记录（最近一次报出去的控件条颜色、跟随系统的监听），所以它不能进可停用的插件。

## 谁在用它

- `@pneuma/ui-layout` 的 App 骨架、`@pneuma/ui-renderer` 的首帧，以及 19 个界面单元（经 `@dsc/ui` 的整包转出）。
- `ui-shell/src/plugin-api.ts` 的那批读 hook 就是本包的转出；插件写法不受影响。
