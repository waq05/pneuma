# tools-default（内置工具）

一句话：注册 bash、作业、终端、读写与检索这些内置工具，并把预算与终端选择放进设置。

## Model Experience（模型体验）

- 注册 11 个工具：bash、job_output / job_list / job_kill、terminal、read、read_image、write、edit、glob、grep（index.ts:194-207）。
- 预算可调：命令缺省超时、超时上限、输出封顶、read 缺省行数；保存后按新预算重注册，下一次调用生效（index.ts:38-47、210-214）。
- 后台作业完成后经 800ms 合并再 followup 给模型，不炸出一串轮次（index.ts:82-105）。
- 终端环境选了 Git Bash 或 PowerShell 后，工具说明里的终端名跟着换，模型按新语法写命令（index.ts:285-347）。
- 状态面板的「终端」区读 `backgroundWorks` 片段，只列当前会话正在跑的活（index.ts:123-141）。

## Known Limitations（已知限制）

- 停用它，模型一件工具都没有，只剩纯对话（index.ts:1-3）。
- 作业与终端按会话归属：别的会话起的活不列、不收、不读（index.ts:145-190）。
- 输出封顶只是兜底；spill 开着时先由 spill 落盘（index.ts:237-243）。
- 终端检测是 10 秒缓存，启动后 50ms 预热；刚装的 shell 要点「重新检测」（index.ts:296-297、361-367）。
- 包描述只写 bash / read / write / edit / glob / grep 六件，没提 read_image、terminal 与作业工具（package.json:16）。

## 行与开关

- 行 id `tools-default`，包名 `@pneuma/tools-default`，order 80（package.json:10-18）。
- resolution 是 pinned（package.json:15）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject `tools`、`settings`、`agent`、`surfaces`、`session`；provide `backgroundWorks`（index.ts:75、192）。
- 两个设置分区：工具预算 order 36、终端环境 order 6（index.ts:255-259、290-294、358）。
