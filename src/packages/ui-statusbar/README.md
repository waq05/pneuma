# ui-statusbar（状态栏）

一句话：ui-statusbar 是底部状态栏的界面单元：轮次与速度、token、上下文三段读数，每段带一张悬浮卡。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:30；ui/ui.tsx:55 只有一个槽条目）。
- 读数来自宿主 `status.progress` / `status.contextSegments`，它不重算模型数据（ui/ui.tsx:24）。
- 输出速度、首 token 平均与两项耗时走桌面原生桥读 `~/.dsc/usage/usage.jsonl`（ui/ui.tsx:25-27、623）；浏览器里没有这条桥，那几行省略。
- 停用后模型侧不变，底部三段消失（index.ts:7-9）。

## Known Limitations（已知限制）

- 缺数据就整段省略，不补 0：步数为 0 不画第一段，累计 token 为 0 不画第二段，`contextWindow` 为 0 不画第三段（ui/ui.tsx:13-20）。
- 用时只在回合进行中出现（ui/ui.tsx:12）。
- 三段口径对齐 dsh 的 ActivityPill / UsagePill / contextPressure，样式仍是旧 `views.css` 加一组覆盖（ui/ui.tsx:2-8）。
- 首屏批装载（`phase: "early"`），装完壳才画第一帧（package.json:24、index.ts:16）。

## 行与开关

- 行 id `ui-statusbar`，包名 `@pneuma/ui-statusbar`，order 363（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.9.0`，phase `early`（package.json:20-25）。
- 宿主半 inject 零个服务（index.ts:30）。
- 槽条目 `shell.statusbar`、order 1（ui/ui.tsx:55）。
- 停用后底部状态栏整条消失，模型侧不受影响（index.ts:7-9）。
