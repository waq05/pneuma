# ui-skills（技能）

一句话：ui-skills 是技能中心这个独立整页的界面单元：已安装与市场两个 tab，启停、看正文、开出目录、导入技能与编辑市场源。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:31；ui/ui.tsx:108 只有一个页条目）。
- 启停一个技能会改模型下一轮看到的技能目录：`<available_skills>` 由 agent 插件拼，skills 只维护文本缓存（src/packages/skills/index.ts:6-7）；这里的 `setSkillEnabled` 写的就是那份启停表（ui/ui.tsx:12、243）。
- 技能正文不进上下文：目录里只有名字和一句话说明，模型要看正文才调 `skill` 工具（src/packages/skills/index.ts:6-7）。
- 供应链写入口不在界面通道：导入、安装市场技能、保存市场源走桌面原生桥（ui/ui.tsx:13-16、294）。
- 停用后模型侧不变，只是这一页画不出来（index.ts:7-9）。

## Known Limitations（已知限制）

- 导入、安装、保存市场源只桌面版能做；浏览器里只有一句「只桌面版能做」，不假装有按钮（ui/ui.tsx:13-16）。
- 远端 provider 贡献的技能只展示、不启停（src/packages/skills/index.ts:11-12）。
- 市场浏览失败的原因挂在面板里带重试，不弹全局错误（ui/ui.tsx:160-161）。
- 描述进目录前截到 500 字（src/packages/skills/index.ts:38）。

## 行与开关

- 行 id `ui-skills`，包名 `@pneuma/ui-skills`，order 361（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.8.1`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务（index.ts:31）。
- 槽条目 `shell.page`、order 20，页面 id `skills`（ui/ui.tsx:38、108）。
- 停用后整页不出现；宿主 skills 包仍照常发现与启停技能（index.ts:7-9）。
