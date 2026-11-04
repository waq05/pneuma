# commands（斜杠命令）

一句话：commands 包提供 `commands` 服务，把 25 条内置斜杠命令与外部插件注册的命令放进同一张表，负责补全、派发与 `/help` 文本。

## Model Experience（模型体验）

- 不注册工具：它提供的是命令注册表与派发器（index.ts:82-126），命令本身不进模型请求。
- 对模型唯一的直接输入是 `/review`：不带参数时先弹卡选范围，然后把一份审查任务书通过 `runtime.submit` 当成普通用户回合提交（index.ts:317-372）。
- 那份任务书固定 25 行上下、约 500 字：写明 diff 落盘路径与读法、按 P0–P3 分级、每条四个字段的格式、最后一句整体结论，另附改动清单与未跟踪文件（core/git-info.ts:239-283）。
- 提示词贡献为零：没有 `ctx.prompt` 调用；用户敲的斜杠命令在到达模型之前就被拦下派发（index.ts:99-125）。
- 停用之后，模型侧少掉：`/review` 提交的那份任务书；所有斜杠命令一并失效（含 /help）。

## Known Limitations（已知限制）

- 回合跑着的时候，标了 `duringTask: 'deny'` 的命令一律挡下：/new、/resume、/compact、/fork、/update（index.ts:114-122）。
- 同名注册是 Map 覆盖语义：插件注册一个与内置同名的命令会把它顶掉，没有冲突报错（file-review 曾经劫走 /review，见 file-review/index.ts:429-432）。
- 两处能跑的范围不同：桌面壳只列 `shell: true` 那批，终端列全量，`/help` 文本跟着走（index.ts:63-67）。
- 命令说明只有一处真源：`/help` 与菜单的说明都取那张表的 description，改文案只有一处可改（core/commands-completion.ts:36-37）。
- 要指挥界面的命令在壳不支持时只回一句人话，不报错（例如 `/thinking` 遇上没有 `toggleThinking` 的壳，index.ts:604-606）。

## 行与开关

- 行 id `commands`，包名 `@pneuma/commands`，order 100。
- resolution 是 pinned：profile 里的同名副本不生效（core/plugin-loader.ts:1503-1514）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 两个服务：`session`、`llm`（index.ts:57）；provide 一个 `commands`（index.ts:58）。
- 内置清单 25 条在 `core/commands-completion.ts:32-78`；外部插件用 `ctx.commands.register` 加进来的命令自动进 /help、补全与派发（index.ts:83-95）。
