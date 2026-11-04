# memory（长期记忆）

一句话：memory 包把跨会话还要用的事实存成三格（全局事实、用户偏好、本工作区），再把这三种内容拼进每一轮请求里给模型看。

## Model Experience（模型体验）

- 注册工具 `memory`：动作 add / replace / remove，格位 memory（全局）/ user（偏好）/ workspace（本工作区），一次可以传多条 operations（index.ts:273-365）。
- 提示词块：`ctx.prompt.register('memory', …, { order: 60, block: 'agents-md' })`（index.ts:371），跟 AGENTS.md 同一块；内容是栏位说明加三格清单。
- 写入后立刻重算快照，本会话下一次请求就用新的（index.ts:152-169、352-356）；同时挂一条一次性的「你加载的副本已过期」提醒（index.ts:184-185）。
- 额度：global 2200、user 1375、workspace 2200 字（core/memory.ts:89-93）；写满整次拒绝，并把当前条目回吐给模型，让它自己合并（index.ts:340-350）。
- 自动复盘：默认每 10 个有实质内容的用户回合起一轮，只准 add（index.ts:867-876，计数口径见 872-874）。
- 整包停用之后，模型侧少掉：系统提示里那一栏记忆、`memory` 工具、以及每 10 回合一次的自动复盘。**注意区分**：设置里把「长期记忆」关掉（`enabled: false`）时工具仍在目录里——它不撤注册，只在调用时回「现在是关着的」（index.ts:314、367）；只有停用整个包才会真的少掉工具。

## Known Limitations（已知限制）

- 额度写满不截断：整次拒绝，不替用户丢条目（文件头 8 行，回吐见 index.ts:340-350）。
- 写记忆默认不弹审批卡：`writeApproval` 默认 false（core/memory.ts:154），打开后才走 `ctx.approval.decide`（index.ts:327-338）。
- 整理（prune）只移不删：陈旧且从没被引用过的条目搬进同目录的 `.archive.md`（文件头 12 行）。
- 注入有上限：最多 200 行、25000 字（core/memory.ts:159-160），被预算挤掉的条目不进提示词。
- 与 dsh 同族能力的差异：待确认，本包只说自己前三条设计与 Hermes 的 memory_tool.py 对过（文件头 7 行），没提 dsh。

## 行与开关

- 行 id `memory`，包名 `@pneuma/memory`，order 280。
- resolution 是 overridable：profile 里同名的新版本可以覆盖它（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 八个服务：`session`、`tools`、`prompt`、`approval`、`agent`、`commands`、`transcript`、`settings`（index.ts:114）。
- 数据落在 `~/.dsc/memory/`（文件头 4 行），设置分区 id `memory`，命令 `/memory` 看额度与条目（index.ts:393-444）。
