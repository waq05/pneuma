# self-improve（经验沉淀）

一句话：self-improve 包把用户纠正过它的地方记成候选，用户确认后才写成技能或记忆，每次改动留台账可回滚。

## Model Experience（模型体验）

- 注册工具 `skill_write`：create / patch / write_file / archive，risk 标 write；强制 read-before-write、改前留 `.bak`、每次变更记台账（index.ts:579-684）。
- 注册工具 `learning`：propose 记候选、list 看清单、promote 转记忆或技能、drop 丢掉；候选正文默认不进模型上下文（index.ts:749-803）。
- 提示词贡献：一段 order 43 的系统提示，只报「有几条待审候选」「技能写入要不要审批」；候选为空且不要审批时返回空串（index.ts:932-955）。
- 守卫 `self-improve` order 29：对 `skill_write` 返回 pass，让链跳过 order 30 的通用审批卡，改用工具自己那张信息更全的卡（index.ts:686-700）。
- 三个命令：`/learn`、`/learnings`、`/skills-ledger`（index.ts:808-921）。
- 停用之后，模型侧少掉两个工具与那段提示：它写不了技能库，纠正只留在对话里，也没有可 promote 的候选（index.ts:955）。

## Known Limitations（已知限制）

- 默认关：`cordis.patch.yml` 第 5 行 `disabled: true`，理由是会写技能文件与提示词面（文件头 2）。
- 复盘轮、定时任务、子智能体发起的 `skill_write` 一律直接拒；判不出来时退回「走审批」那一侧（文件头 23-27）。
- 新建技能默认停用，要用户在 `/skills` 里启用后才进模型可见目录（index.ts:589）。
- 硬校验：description 不超过 60 字符、正文不能空、整份有字符上限；超了直接拒而不截断（文件头 17、index.ts:588）。
- 老化 active → stale（14 天未命中）→ archived（30 天）；pin 挡住自动改写与自动归档，归档只移进 `.archive/`、永不删（文件头 28-29）。
- 绝不改 `AGENTS.md`：只写 `~/.dsc/skills/` 与 `~/.dsc/learnings/`（文件头 30）。

## 行与开关

- 行 id `self-improve`，包名 `@pneuma/self-improve`，order 3760。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认关：`cordis.patch.yml` 第 5 行 `disabled: true`。
- inject 十一个服务：`tools`、`guards`、`commands`、`settings`、`transcript`、`skills`、`approval`、`session`、`agent`、`prompt`、`memory`（index.ts:268）。
- 设置分区 id `self-improve`，order 35；五项可调：总开关、复盘迭代下限、是否要审批、候选保留天数、候选条数上限（index.ts:114-133、1036）。
- 默认值：复盘在 12 次工具迭代后触发，保留天数与条数取 `DEFAULT_STORE_OPTIONS`（index.ts:114-120）。
