# ui-layout（界面骨架）

一句话：界面壳的应用骨架与运行时——App 骨架（侧栏 / 主区 / 诊断区）、审查栏、正文区的两张脸（对话 / 轨迹）、主区整页切换、宿主通道的 React 面与外观落地。

## Model Experience（模型体验）

- 包本身不注册工具、不写提示词、不登记快照片段：模型看不见它，只看见它撑起来的界面。
- 模型的一轮回复在时间线上怎么排、切到轨迹视图看什么，由 `thread-view.ts` / `page-state.ts` 决定；对话与轨迹两张脸共用同一份真源，不各算一遍。
- 会话用量与成本的显示口径在 `usage-today.ts` 落地：同一条成本数，模型看到的和用户看到的必须是同一个。
- 宿主通道（`host-channel.ts`）是桌面端与页面之间的一条线，主题与窗口状态经它落到外观（`appearance.ts`）上。

## 插件形态（2.0 起）

- 它**是一个客户端插件**：`exports['./client']` 指到 `ui/ui.tsx`，界面壳的构建把它打成
  `lib/ui/plugins/layout/client.js` + `bundle.json`，装配行 `ui-layout`（order 349，排在
  19 个界面单元 350–368 之前）由 `cordis.patch.yml` 声明。停用这一行，产物不进启动图。
- 但 `client.js` 里**没有骨架的实现**：它 `require('@dsc/ui-layout')`，拿的是壳里那一份。
  原因在 `ui/ui.tsx` 抬头：`@dsc/ui` 把本包的读 hook 整包转出给插件，插件里的
  `useHostSnapshot()` 与骨架里的 App 必须共享同一份 RuntimeContext 与页 / 视图信号；
  bundle 里再内联一份，插件一渲染就抛「useHostChannel 必须在 RuntimeProvider 里用」。
  所以本包同时是平台种子（见 `ui-renderer/ui/platform-modules.json`）。
- 停用 / 加载失败**不会白屏**：入口（`ui-renderer/ui/main.tsx`）照不到骨架时画一块诊断页，
  写明「已停用 / 加载失败」以及去 `~/.dsc/plugins.json` 把 `ui-layout` 那条打开。

## Known Limitations（已知限制）

- 骨架代码仍在壳的 app bundle 里（经 `@dsc/ui` 的转出），所以停用这一行**不省下载量**，
  省掉的是「装这一行」本身；真要把实现挪进 bundle，得先把 `@dsc/ui` 对本包的转出拆掉。
- 改一行就要重建整个壳（`pnpm -C ui-shell build`），重建前页面上的还是旧的那一份；
  HMR 换装能给这条插件换模块，但挂在 `#root` 上的 App 引用是入口取的那一份，要刷新才换。
- 骨架是写死的一层（侧栏 + 主区 + 诊断区），不是可任意拖拽的分栏；要新的分区得改 `app.tsx`。
- 依赖方向单向：本包可以用 `@dsc/ui-dockkit` / `@dsc/ui-primitives` / `@dsc/ui-slots`，反过来不行；加一条向上边之前先想清楚会不会成环。

## 谁在用它

- `@pneuma/ui-renderer` 的入口（`ui-renderer/ui/main.tsx`）按**启动图**取来挂载它：
  首帧之前显式 await `loadPluginModule(entry)`，整张页面只有这一个 App。
- `@dsc/ui` 把本包整包转出，`src/packages/ui-*/ui/**` 那批界面插件按包名读到同一份骨架与页真源。
