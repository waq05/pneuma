# skills（技能）

一句话：发现 SKILL.md、维护模型可见的技能目录、管启停与市场安装，并给模型一个按名取正文的 `skill` 工具。

## Model Experience（模型体验）

- 系统提示里的 `<available_skills>` 只列名字与一句话说明，正文不进上下文；这段文本由 prompt 插件取 `catalogText()` 拼进去（index.ts:106-127；prompt/index.ts:283）。
- 工具 `skill` 按名字取正文，返回 `<skill_content>`；名字必须来自目录（index.ts:350-373）。
- 每个 user-invocable 的技能自动注册 `/技能名` 命令，正文随用户消息一起提交（index.ts:129-154、197-211）。
- 停用的技能既不进目录，也不能通过工具加载（index.ts:107、369）。
- 插件注册的远端技能只展示、不能在本机启停（index.ts:8-9、265）。

## Known Limitations（已知限制）

- 目录是缓存：切会话只在 cwd 变了时重扫，同工作区内换会话不重扫（index.ts:77-84、396-404）。
- 每条描述截到 500 字、命令说明截到 36 字；目录为空时整段不出现（index.ts:42-43、106-108、147）。
- 内置命令名不能被技能占用（new/resume/compact/model/help/exit/effort/plugins/skills）（index.ts:45-46）。
- 本地技能每次 `read` 都重扫目录，远端技能每次都重新拉取（index.ts:238-260）。
- 市场安装只写 `DSC_SKILLS_DIR` 并广播 `dsc/skills-changed`，不会替用户启用装好的技能（index.ts:312-330）。

## 行与开关

- 行 id `skills`，包名 `@pneuma/skills`，order 110（package.json:10-18）。
- resolution 是 pinned（package.json:15）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- provide `skills`；inject `session`、`tools`、`commands`、`transcript`（index.ts:62-65）。
- 本包不注册设置分区：技能开关与市场源在设置插件的「技能」分区里（settings/index.ts:336-343）。
