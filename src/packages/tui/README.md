# tui（终端界面）

一句话：终端界面插件，把 runtime 服务挂到 ink，并把 `platform: 'tui'` 的界面插件装进通知盒下方的槽。

## Model Experience（模型体验）

- 不注册工具、不写提示词；模型侧行为不变，变的是人看的界面（index.ts:1-16）。
- 提供 `interactive`：审批插件据此知道「有人在看」，才会弹人工审批卡；没有它按无人应答立刻拒（index.ts:43-44）。
- 界面插件装载失败的原因写成一条 system 条目进会话流，不只在 stderr（index.ts:35-37、54-57）。
- 只装 `platform: 'tui'` 的界面插件，块渲染在通知盒下方（index.ts:46-63）。

## Known Limitations（已知限制）

- 只在 TTY 下进备用屏；非 TTY 不写 1049 序列（index.ts:41-42）。
- 卸载只做一次：`dsc/exit` 与 disposer 可能都跑，靠 tornDown 去重（index.ts:81-92）。
- 崩溃兜底只还原屏幕，不打印「会话已保存」（index.ts:12-14、73-78）。
- 终端没有诊断区，插件装载失败只能进会话流（index.ts:53）。
- Ctrl+C 交给 App（一次打断、双击退出），不走 ink 默认退出（index.ts:65-68）。

## 行与开关

- 行 id `tui`，包名 `@pneuma/tui`，order 9000（package.json:10-17）。
- resolution 是 overridable（package.json:15）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject `ui`、`transcript`；provide `interactive`（index.ts:37、44）。
- 不注册设置分区；package.json 的 title 只有 `tui`，也没有 description（package.json:16-17）。
