# llm（模型路由）

一句话：llm 包决定每一条模型请求发往哪里、用哪个模型、带哪档思考强度，这类状态只在它这里存一份。

## Model Experience（模型体验）

- 不注册工具：本包的 apply 只做 `ctx.provide('llm', service)`（index.ts:291），没有任何 `tools.register`，模型不能自己换模型或端点。
- 路由：`route()` 组出 api / baseUrl / apiKey / model / maxTokens / temperature / thinking / reasoningEffort 八项（index.ts:113-134），请求循环拿它发请求。
- 上下文窗口：`contextWindow` 读 config.yaml 里该模型声明的窗口，查不到按 128000 算（index.ts:151）；压缩阈值与「超出窗口」判定都读这个数。
- 输入模态：`inputModalities` 返回该模型收不收图（index.ts:166-169），压缩与贴图时据此把图片卸下来。
- 历史清洗：发请求前丢掉孤儿或重复的工具结果、剔掉没有回应的工具调用、把插队消息移回工具结果之后，并给用户一条说明（index.ts:35-49）。只改发给模型的这一份，会话日志不动（index.ts:47）。
- 停用之后，模型侧少掉全部请求路由：`ctx.llm` 不存在，agent 循环、压缩摘要、起标题、审批复核、子智能体都发不出请求（这些包都声明 `inject: ['llm']`，见 compact/index.ts:148、agent/index.ts:53）。

## Known Limitations（已知限制）

- 只认 config.yaml 的 providers 段：端点没配就直接抛错，不会自动回落到别的端点（index.ts:113-119）。
- 思考档位受模型声明限制：模型没声明 thinkingLevels 时只有「默认」可选，选别的当场抛错（index.ts:221-228）。
- 缓存断点不默认加：只有端点声明了 `cacheControl: true` 才带（index.ts:131-132），普通端点的请求体不带显式缓存标记。
- 模型选择按会话存（`session.appendState('model', …)`，index.ts:248），不是进程全局值；换一条会话看到的是那条会话自己的模型。
- 与 dsh 同族能力的差异：待确认，本包代码里没有与 dsh 的对照说明。

## 行与开关

- 行 id `llm`，包名 `@pneuma/llm`，order 10（见 cordis.patch.yml 与 package.json）。
- resolution 是 pinned：应用安装目录里的这一份优先，profile 里的同名副本让路（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 只有 `session`（index.ts:53），因为「上次选的那组模型」要记进会话状态；执行配置由宿主直接给（host/kernel.ts:45 把整个 DscCoreConfig 传给 llm）。
- 不注册设置分区（package.json 里没有 `settingsSection`），模型与档位在界面选择器里改。
