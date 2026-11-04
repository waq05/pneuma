# ui-plugins（插件中心）

一句话：ui-plugins 是「插件中心」这个界面单元的宿主半，在主区画一张整页——插件清单、开关、详情与配置表单。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词：宿主半只有空 `apply`，界面半只报名一个 `shell.page` 槽（index.ts:29，ui/ui.tsx:108-113）。
- 插件开关就是模型能力的加减：这里翻一下调 `setPluginEnabled` 热挂载，模型的工具与提示词清单随之变（ui/ui.tsx:206、220）。
- 模型侧没有输入来自这里：停用后模型照常跑，少的只是「插件」这一页（index.ts:7-9）。

## 面板与数据

- 三组插件清单：自定义（external）、官方可开关（builtin + toggleable）、运行内核（builtin 不可停）；内核默认只露 3 行（ui/ui.tsx:55、264-273、410-412）。
- 数据全走界面通道：`listPlugins` / `setPluginEnabled` / `listUiTrust` / `getSettingsSections` / `getSectionValues` / `setSettingValue` / `runSettingAction`（ui/ui.tsx:140、160、206、220、707、802、825、842）。
- 桌面专属写口走原生桥：重启宿主 `restartHost`、装本地插件 `installPlugin`、写信任 `setUiTrust`；浏览器里前两个禁用并说明原因（ui/ui.tsx:172-181、232-261、301-303）。
- 详情页的配置表单与设置面板同源（同一张宿主声明表），控件是 `GenericFields` 的同构移植（ui/ui.tsx:12-14、783-789）。
- 第三方界面插件首见不加载，先摊开能力面让人答一次「我信任」（ui/ui.tsx:571-668）。

## Known Limitations（已知限制）

- 配置表单不共用实现（插件 bundle 之间不能互相 import），字段与 class 的漂移要两边一起改（ui/ui.tsx:783-789）。
- 重启宿主与添加插件只在桌面窗口的原生桥里有；浏览器页签里按钮禁用或给一句说明（ui/ui.tsx:232-250、301-303）。
- 第三方界面插件的信任写口同样只在桌面桥，浏览器里只能看不能答（ui/ui.tsx:172-181）。
- 运行内核组不可停、只读，默认只露 3 行，其余折叠（ui/ui.tsx:55、273、410-412）。
- `clientCapabilities` 只列不加载：界面半进不进启动图由宿主按 `dsh.client` / `plugin.json` 判（ui/ui.tsx:71-72，core/ui-bundles.ts:1440-1470）。
- 停用它就失去了给自己重新打开的开关：整页不再渲染，只能改 `plugins.json` 再重启（index.ts:7-9）。
- 只有清单里那两行字（标题、说明）按语言显示：内核读 `pneuma.title` / `pneuma.description` 时先查该包 `locale/<语言>.json`，没有译本回落清单原文（core/plugin-locale.ts）；本页自己的界面文案、分组名与按钮仍是中文。

## 行与开关

- 行 id `ui-plugins`，包名 `@pneuma/ui-plugins`，order 356（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.8.1`，没有 phase 与 inject（package.json:20-25）。
- 宿主半 inject 零个服务：`apply` 不碰 `ctx`（index.ts:29）。
- 停用后内置产物按启停记录被滤掉，界面单元不进启动图（index.ts:7-9，core/ui-bundles.ts:1468-1470）。
