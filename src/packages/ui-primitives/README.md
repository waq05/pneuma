# ui-primitives（界面基元）

一句话：界面壳的基元库——图标、载体基元（代码 / markdown / PDF / 表格 / 差异行）、文件图标、面板几何、toast 与 confirm、时间与 token 口径；E6 起作为平台种子下发给界面插件。

## Model Experience（模型体验）

- 模型写出的代码块、diff、表格、图片、PDF 最终都落到这里的载体基元上：哪种扩展名配哪枚图标、diff 的哪一行标红标绿，口径在这一层。
- 模型一次工具调用在界面上显示成什么，也由这里决定：`tool-args.ts` 折参数、`tool-summary.ts` 收一句摘要——摘得太长挤掉正文，太短又看不出改了什么。
- 包本身不注册工具、不写提示词：模型看不见它，只看见它画出来的那些块。
- 每个模块都 `export *` 出来，不是节选：`@dsc/ui` 整包转出本包，漏掉一个模块，那个名字就在插件的 require 面上变成 `undefined`，编译期看不见。

## Known Limitations（已知限制）

- 它是壳的一部分：整棵树被编进壳的产物（`lib/ui/` 的 bundle），**没有独立的 `client.js`**，因此不能单独安装、单独停用——`pneuma.library: true` 就是这个意思。
- 改一行就要重建整个壳（`pnpm run build`），重建前页面上的还是旧的那一份；没有只换这一个包的热更路径。
- 本包只许往下：不能 import `@dsc/ui-dockkit` / `@dsc/ui-layout` / `@dsc/ui`，反向依赖会被 alias 解析成第二份实现。
- `ui/package.json` 的 `"sideEffects": false` 必须留着：缺了它，整包进图时摇不掉的 `vscode-icons-js`（CJS）会被无谓地拖进来。

## 谁在用它

- `@dsc/ui-dockkit`、`@dsc/ui-layout` 与 `@dsc/ui` 都在用；界面插件经 `@dsc/ui` 的整包转出拿到同一份实现。
- E6 起它进 `ui-shell/src/platform-modules.json` 的平台种子表，插件按裸包名 require 到壳里这一份。
