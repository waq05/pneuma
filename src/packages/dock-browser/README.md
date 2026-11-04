# dock-browser（侧栏浏览器）

一句话：dock-browser 包让模型驱动桌面端侧栏那台浏览器（原生 WebContentsView、持久分区带登录态），做 DOM 级操作。

## Model Experience（模型体验）

- 注册工具 `browser_dock`（risk exec，每一步都要审批）：open / navigate / click / hover / type / press / scroll / evaluate / close，动作都用快照里的 ref 定位（index.ts:758-791）。
- 打开「看侧栏浏览器免审批」才另注册 `browser_dock_look`（risk read）：views / snapshot / screenshot / console / network / wait_for（index.ts:793-819、824-833）。
- 提示词贡献为零：没有 `ctx.prompt.register`；成本全在两个工具的说明与参数描述里，源码 76 行、约 3.3KB，随每次请求发送（index.ts:745-820）。
- 与 browser 包的分工写在文件头：这台是用户自己的侧栏浏览器（生命周期归桌面壳），那台是一次性 Chrome（index.ts:16-22）；两者共用 `core/cdp/` 那套快照与 ref 算法。
- 停用之后，模型侧少掉：这两个工具；侧栏浏览器仍然由用户自己点着用，与模型无关。

## Known Limitations（已知限制）

- 没有桌面壳就没有这条能力：`hostBrowser` 取不到时直接报「要在桌面端窗口里用」，TUI / 无头 / 远程壳一律拿不到（index.ts:106-108）。
- `browser_dock_look` 默认不注册：这台浏览器跑在用户自己的持久分区里（带登录态），看一眼现状不该无条件免审批（index.ts:25-27、829-831）。
- `evaluate` 过与 browser 包同一道敏感原语黑名单，表达式里出现的地址还要再过一遍 URL 策略（index.ts:727-733）。
- 快照默认最多 15000 字符（按行截断，绝不切碎元素），控制台留 200 条、网络留 50 条，等元素默认 5 秒（index.ts:89-95）。
- 页面文本一律过 `wrapUntrusted`（来源标成 browser），模型拿到的是数据不是指令（index.ts:38、735）。
- 默认关：cordis.patch.yml 里写着 `disabled: true`。

## 行与开关

- 行 id `dock-browser`，包名 `@pneuma/dock-browser`，order 3750。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认关：cordis.patch.yml 里写着 `disabled: true`。
- inject 两个服务：`tools`、`settings`（index.ts:180）。
- 设置分区 id `dock-browser`、order 35（index.ts:837-841）；五个可调值：免审批开关、快照字符上限、控制台条数、网络条数、等元素上限（index.ts:89-95）。
