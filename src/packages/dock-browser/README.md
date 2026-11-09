# dock-browser（侧栏浏览器）

一句话：dock-browser 包让模型驱动桌面端侧栏那台浏览器（原生 WebContentsView、持久分区带登录态），做 DOM 级操作。

## Model Experience（模型体验）

- 注册工具 `browser_dock`（risk exec，每一步都要审批）：open / navigate / click / hover / type / press / scroll / evaluate / close，动作都用快照里的 ref 定位（index.ts:758-791）。
- 注册工具 `browser_dock_look`（risk **恒为 read**，人批在工具里）：views / snapshot / screenshot / console / network / wait_for（index.ts:616-660、1027-1057）。它**恒注册**（不注册模型就拿不到 ref）；默认每次调用在工具内请求一次审批卡（`forceAskReason`，跳过所有自动放行档），用户同意才读，设置里打开 `lookWithoutApproval` 才不弹卡直接读。
- 提示词贡献为零：没有 `ctx.prompt.register`；成本全在两个工具的说明与参数描述里，源码 76 行、约 3.3KB，随每次请求发送（index.ts:745-820）。
- 与 browser 包的分工写在文件头：这台是用户自己的侧栏浏览器（生命周期归桌面壳），那台是一次性 Chrome（index.ts:16-22）；两者共用 `core/cdp/` 那套快照与 ref 算法。
- 停用之后，模型侧少掉：这两个工具；侧栏浏览器仍然由用户自己点着用，与模型无关。

## Known Limitations（已知限制）

- 没有桌面壳就没有这条能力：`hostBrowser` 取不到时直接报「要在桌面端窗口里用」，TUI / 无头 / 远程壳一律拿不到（index.ts:106-108）。
- `browser_dock_look` 恒为 `read` 档、默认每次要人批：这台浏览器跑在用户自己的持久分区里（带登录态），看一眼现状也是看他的登录页面（index.ts:570-578、1053）。声明 `exec` 反而会让计划 / 探索 / 只读三种档整档拿不到「看」，所以人批放在工具里自己做（免打扰模式直接拒，不弹卡）。
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
