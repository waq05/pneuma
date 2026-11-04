# ui-dockkit（右侧栏工具箱）

一句话：界面壳右侧栏（dock）的那一套——分栏模型、会话级状态与 React 画法；与 dsh 的 `ui-dockkit` 同位。

## Model Experience（模型体验）

- 模型看不见这个包，只看见右侧栏那几个页签。
- 分栏模型（`dock-model.ts`）是纯数据加纯函数、没有 React：宽度与折叠的规则可以单独读、单独测，不用起一个壳。
- 页签的开关状态住在模块级单例里（`dock-state.ts`）：一个进程只有一份 dock，谁都能订阅，谁也都能改。

## Known Limitations（已知限制）

- 它是壳的一部分：整棵树被编进壳的产物（`lib/ui/` 的 bundle），**没有独立的 `client.js`**，因此不能单独安装、单独停用——`pneuma.library: true` 就是这个意思。
- 改一行就要重建整个壳（`pnpm run build`），重建前页面上的还是旧的那一份；没有只换这一个包的热更路径。
- 只许往下：依赖 `@dsc/ui-primitives` 与 `@dsc/ui-core`；不许 import `@dsc/ui-layout`（布局在其上）与 `@dsc/ui`（聚合面，反向会成环）。
- 状态是模块级单例：同一进程里只有一份 dock，多开窗口也共用这一份，测试之间要自己清干净。

## 谁在用它

- `@dsc/ui-layout` 的 `app.tsx` 画右侧栏时用它。
- 界面插件经 `ctx.slots` 往右栏塞页签，页的登记面在 `dock-state.ts`。
