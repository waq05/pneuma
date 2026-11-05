# ui-settings（设置）

一句话：ui-settings 是设置面板这个界面单元的宿主半：导航与字段表都来自宿主的 `getSettingsSections()`，壳照着画，不硬编分区清单。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:31；ui/ui.tsx:118 只有一个槽条目）。
- 模型能用哪家提供方、哪个默认模型，取决于这里存下的值：面板读 `getSectionValues`、写 `setSettingValue`（ui/ui.tsx:355、378）。
- 改一项立刻生效：`setSettingValue` 写回后回读一次宿主夹取过的值，非法值被宿主改写也照实显示（ui/ui.tsx:367-390）。
- 技能分区不在这里列，技能中心已是独立整页；宿主那份分区还在，TUI 与旧桌面版继续消费（ui/ui.tsx:21-25、89）。
- 停用后模型侧不变，少的只是设置入口（index.ts:7-9）。

## Known Limitations（已知限制）

- 未知的 custom 分区只给一句说明（`NotYetPanel`），不假装有界面（ui/ui.tsx:286-297）。
- 装技能、装插件是供应链写入口，壳里只说明去哪做（ui/ui.tsx:32-34）。
- 插件分区是壳造的合成分区，宿主没有（ui/ui.tsx:27-30）。
- 外观没有宿主分区，被追加在「通用」分区末尾（ui/ui.tsx:19、306-307）。
- 浏览器与远程页里能选默认模型（`setDefaultModel` 在放行面上），但不能增删端点或写 key（ui/models.tsx:13-16、355-357）。
- 控件与旧界面有两处差异：下拉用原生 `<select>`，成功与失败回执走分区底部的行内说明而不是全局 Toast（ui/ui.tsx:320-323）。

## 行与开关

- 行 id `ui-settings`，包名 `@pneuma/ui-settings`，order 360（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.9.0`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务（index.ts:31）。
- 槽条目 `shell.header`、order 31，入口是顶栏那颗齿轮钮（ui/ui.tsx:118）。
- 停用后设置面板打不开，模型与宿主设置本身不受影响（index.ts:7-9）。
