# self-improve（经验沉淀）

一句话：self-improve 包把用户纠正过它的地方记成候选，用户确认后才写成技能或记忆，每次改动留台账可回滚。

## Model Experience（模型体验）

- 注册工具 `skill_write`：create / patch / write_file / archive，risk 标 write；强制 read-before-write、改前留 `.bak`、每次变更记台账（index.ts:786-889）。
- 注册工具 `learning`：propose 记候选、list 看清单、promote 转记忆或技能、drop 丢掉；候选正文默认不进模型上下文（index.ts:1005-1058）。
- 提示词贡献：一段 order 43 的系统提示，**只留静态说明**（learning 工具怎么 propose、开了审批时技能写入要走审批）；待审条数不再是系统提示的一部分（`promptText`，index.ts:1323）。
- 待审条数走尾部投影（order 620）：N>0 时往请求末尾追加一条 user 消息「候选清单里有 N 条待审经验」，N=0 不发；候选正文仍然不进任何提示词（`offImproveTail`，index.ts:1343）。
- 守卫 `self-improve` order 29：对 `skill_write` 返回 pass，让链跳过 order 30 的通用审批卡，改用工具自己那张信息更全的卡（index.ts:899-906）。
- 三个命令：`/learn`、`/learnings`、`/skills-ledger`（index.ts:1065-1178）。
- 停用之后，模型侧少掉两个工具与那段提示：它写不了技能库，纠正只留在对话里，也没有可 promote 的候选（index.ts:1190）。
- 自修订（2026-11-11 加）：这一轮读过技能、又以 `error` 结束时，插件自己起一轮修订，只取读过的第一个技能；模型只准回一行 patch JSON 或 NONE（index.ts:184、232-272、745-754）。修订**不直接写技能**，只落一条 `skill-draft` 候选，文本里带 `revisionOf=<技能名>`，promote 时才走 `patchSkill`（index.ts:657-702、917-950）。
- 「读过」认两条路：`skill` 工具的 `tool_calls`，以及 `/技能名` 注入正文留下的 `<skill_content name="X">` 标签；同一轮里「先 `/技能名` 再 `skill_write`」不会再被 read-before-write 误挡（skill-write.ts:606-638、657-663、index.ts:494-516）。

## Known Limitations（已知限制）

- 默认关：`cordis.patch.yml` 第 5 行 `disabled: true`，理由是会写技能文件与提示词面（文件头 2）。
- 复盘轮、定时任务、子智能体发起的 `skill_write` 一律直接拒；判不出来时退回「走审批」那一侧（文件头 23-27）。
- 自修订只由「读过技能 + 这一轮 turn-end 为 error」触发，不做定时主动复盘；一轮读了多个技能时只取第一个（index.ts:745-754）。
- 自修订的「失败现场」只取最后一条助手正文与最后一条工具报错（各截 800 字符）；请求级失败没有工具报错时这一项为空（index.ts:232-247）。
- 新建技能默认停用，要用户在 `/skills` 里启用后才进模型可见目录（index.ts:594）。
- 硬校验：description 不超过 60 字符、正文不能空、整份有字符上限；超了直接拒而不截断（文件头 17、index.ts:580）。
- 老化 active → stale（14 天未命中）→ archived（30 天）；pin 挡住自动改写与自动归档，归档只移进 `.archive/`、永不删（文件头 28-29）。
- 绝不改 `AGENTS.md`：只写 `~/.dsc/skills/` 与 `~/.dsc/learnings/`（文件头 30）。

## 行与开关

- 行 id `self-improve`，包名 `@pneuma/self-improve`，order 3760。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认关：`cordis.patch.yml` 第 5 行 `disabled: true`。
- inject 十一个服务：`tools`、`guards`、`commands`、`settings`、`transcript`、`skills`、`approval`、`session`、`agent`、`prompt`、`memory`（index.ts:372）。
- 设置分区 id `self-improve`，order 35；五项可调：总开关、复盘迭代下限、是否要审批、候选保留天数、候选条数上限（index.ts:114-133、1290）。
- 默认值：复盘在 12 次工具迭代后触发，保留天数与条数取 `DEFAULT_STORE_OPTIONS`（index.ts:114-120）。


