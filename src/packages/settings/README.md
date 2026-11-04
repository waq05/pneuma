# settings（设置）

一句话：settings 包提供设置分区注册表与模型配置读写，界面只按插件交来的 JSON 声明画表单。

## Model Experience（模型体验）

- 不注册工具、不贡献提示词；模型能感觉到的只有它改的配置（端点、默认模型、温度、思考强度）（index.ts:1-12）。
- 温度写 `config.yaml`，写完刷新 llm 插件持有的同一份配置，下一条请求生效（index.ts:9-10、295-298）。
- 当前会话的权限模式与审阅者只改当前会话；思考强度同时记成新会话默认（index.ts:274-293）。
- 内置 8 个分区：通用、模型、模式、技能、归档、用量、终端界面、关于，插件分区走同一张表（index.ts:209-521）。
- 插件分区拿不到组件，只能交 JSON 与 save/action 回调，Electron 的 contextIsolation 因此不破（index.ts:4-8）。

## Known Limitations（已知限制）

- 内置分区 id 被占用：插件再注册同名分区会被忽略，并往会话流写一条 system（index.ts:526-530）。
- 返回值两套口径：save 返回字符串是失败原因、对象才是成功；action 则要抛错才算失败（index.ts:171-203、349-356）。
- 模型分区是 `custom: true`，结构化界面由桌面端自己画，不是通用表单（index.ts:312-318）。
- 写入落在 `config.yaml` 与 `credentials.yaml`；别处直接改文件不会自动刷进 llm 的内存对象（index.ts:9-10、137-141）。
- 换活动配置文件只改偏好，不动原文件；要回到出厂那份得点「恢复默认」（index.ts:240-250）。

## 行与开关

- 行 id `settings`，包名 `@pneuma/settings`，order 160（package.json:10-18）。
- resolution 是 pinned：用户 profile 覆盖不了它（package.json:15）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject `llm`、`approval`、`transcript`；provide `settings`（index.ts:106-109）。
- 服务面：registerSection / sections / values / save / action / discoverModels / testConnection（index.ts:524-584）。
