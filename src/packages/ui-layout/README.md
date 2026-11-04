# ui-layout（界面骨架）

一句话：界面壳的应用骨架与运行时——App 骨架（侧栏 / 主区 / 诊断区）、审查栏、正文区的两张脸（对话 / 轨迹）、主区整页切换、宿主通道的 React 面与外观落地。

## Model Experience（模型体验）

- 包本身不注册工具、不写提示词、不登记快照片段：模型看不见它，只看见它撑起来的界面。
- 模型的一轮回复在时间线上怎么排、切到轨迹视图看什么，由 `thread-view.ts` / `page-state.ts` 决定；对话与轨迹两张脸共用同一份真源，不各算一遍。
- 会话用量与成本的显示口径在 `usage-today.ts` 落地：同一条成本数，模型看到的和用户看到的必须是同一个。
- 宿主通道（`host-channel.ts`）是桌面端与页面之间的一条线，主题与窗口状态经它落到外观（`appearance.ts`）上。

## Known Limitations（已知限制）

- 它是壳的一部分：整棵树被编进壳的产物（`lib/ui/` 的 bundle），**没有独立的 `client.js`**，因此不能单独安装、单独停用——`pneuma.library: true` 就是这个意思。
- 改一行就要重建整个壳（`pnpm run build`），重建前页面上的还是旧的那一份；没有只换这一个包的热更路径。
- 骨架是写死的一层（侧栏 + 主区 + 诊断区），不是可任意拖拽的分栏；要新的分区得改 `app.tsx`。
- 依赖方向单向：本包可以用 `@dsc/ui-dockkit` / `@dsc/ui-primitives` / `@dsc/ui-slots`，反过来不行；加一条向上边之前先想清楚会不会成环。

## 谁在用它

- `@pneuma/ui-renderer` 的入口（`ui-renderer/ui/main.tsx`）挂载它：整张页面只有这一个 App。
- `@dsc/ui` 把本包整包转出，`src/packages/ui-*/ui/**` 那批界面插件按包名读到同一份骨架与页真源。
