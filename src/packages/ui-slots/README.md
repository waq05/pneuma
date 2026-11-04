# ui-slots（槽位契约）

一句话：界面壳的槽位契约（`SLOT` / `SHELL_SLOTS` / 往 `SlotMap` 并表）与浏览器壳的 React 渲染出口（`SlotOutlet` / `ChainOutlet` / Factory 出口）。

## Model Experience（模型体验）

- 模型看不见这个包：它定的是"界面上哪儿有空位"，往空位里放东西是插件的事。
- 一个界面插件装上来之后模型多看见什么，取决于它往哪个槽里放；槽名表就是这张清单，`declare module` 并进 `SlotMap` 的九个壳槽即出口渲染时用的那张表。
- 契约与出口是同一份数据，所以合在一个包里：改槽名必须同时改出口，否则插件放进去的东西没人画。

## Known Limitations（已知限制）

- 它是壳的一部分：整棵树被编进壳的产物（`lib/ui/` 的 bundle），**没有独立的 `client.js`**，因此不能单独安装、单独停用——`pneuma.library: true` 就是这个意思。
- 改一行就要重建整个壳（`pnpm run build`），重建前页面上的还是旧的那一份；没有只换这一个包的热更路径。
- 运行时只依赖 `@dsc/ui-core` 与 react（由平台种子提供）；槽位类型走 `@dsc/ui` 的 `plugin-api.ts`——declare 合并认的是那个文件身份，不是包名。
- 本包不许 import `@dsc/ui-dockkit` / `@dsc/ui-layout` / `@dsc/ui-renderer`（都在它上面）。

## 谁在用它

- 界面插件的 `apply` 拿到 `ctx.slots`，落点就是这里的 `SlotMap`。
- `@dsc/ui-layout` 的 `app.tsx` 用 `SlotOutlet` 把插件塞进来的东西真的画出来。
