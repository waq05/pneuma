# computer-use（操作电脑桌面）

一句话：computer-use 包让模型看这台 Windows 桌面并动手点、打、拖，动手每次都要过审批卡，只读观察可以免审批。

## Model Experience（模型体验）

- 注册工具 `computer`（risk exec，每次都要用户在审批卡上点头）：点击、拖拽、输入、粘贴、按键、滚动、元素定向动作与急停 stop（index.ts:430-441）。
- 勾了「看屏幕免审批」才另注册 `computer_look`（risk read）：截屏、无障碍观察、列窗口 / 应用 / 显示器、查鼠标，看了一眼不必确认（index.ts:444-456、487-489）。
- 提示词贡献：一段 `computer-use` 块（缺省 order 60，prompt/index.ts:225），约 9 条闭环规矩——先想清目标窗口、优先用无障碍元素、动完再观察、点到了不等于生效、别念屏幕上的隐私内容、急停随时可用——约 500 字（index.ts:458-481）。
- 工具面随配置变：关了免审批时只读动作塞进 `computer` 里，开了才拆出 `computer_look`，描述文字也跟着改写（index.ts:424-429、461-463）。
- 停用之后，模型侧少掉：这两个工具与那段闭环规矩，屏幕上的东西模型再也看不见。

## Known Limitations（已知限制）

- 与 dsh 的差异：dsh 把桌面操作外包给外部 Rust 驱动，这些护栏由那个驱动负责；dsc 在自己进程里兜，所以下面几条都只是 dsc 进程内的判断（index.ts:10-21）。
- 坐标先按上次截图的缩放系数换算回物理像素，落在屏幕外直接报错，不靠系统静默夹紧（index.ts:11）。
- 元素索引只对「该窗口最近一次观察」有效，元素消失时 fail-closed 报错，不退回坐标乱点（index.ts:12）。
- 自上次截屏起最多连做 12 个动作（可调 0~200，0 = 不限），超了要求先重新截屏（index.ts:61-62、80、479）。
- Win 键永远拒绝（它会切走整个桌面）；`computer_look` 只能做只读动作，传 click 会被运行时闸门拒掉（index.ts:17、303-313）。
- 默认关：官方插件，要在设置里打开才会挂载（index.ts:2、cordis.patch.yml 的 `disabled: true`）。

## 行与开关

- 行 id `computer-use`，包名 `@pneuma/computer-use`，order 3620。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认关：cordis.patch.yml 里写着 `disabled: true`。
- inject 四个服务：`tools`、`prompt`、`settings`、`guards`（index.ts:221）。
- 守卫 order 4 让 stop 越过所有闸门：它是「停下来」，不是「做事」（index.ts:493-503）；设置分区 id `computer-use`、order 45（index.ts:534-538）。
- 每次动作可写一行 `~/.dsc/audit/computer-use.jsonl`，记录时刻、动作、目标、结果与是否审批过（index.ts:69-70、256-267）。
