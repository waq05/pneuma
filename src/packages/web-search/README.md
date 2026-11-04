# web-search（联网搜索）

一句话：web-search 给模型一个 `web_search` 工具，从 Tavily、博查或 Serper 拉真实网页结果，标题、链接、摘要一起回给它。

## Model Experience（模型体验）

- 注册工具 `web_search`：`query` 必填，`includeDomains` / `excludeDomains` 只在提供方是 tavily 时生效（index.ts:175-197）。
- 没配 key 就不挂工具、也不贡献提示词，免得模型每轮拿到一句「还没配 key」（index.ts:171-174、239-248）。
- 配了 key 才追加一段「联网搜索」提示词：要求查证后附来源、搜不到就换关键词、别编造搜索结果（index.ts:244-247）。
- 结果外面包一层不可信围栏，网页里出现的指令只能当资料读（index.ts:225-232，core/untrusted.ts 的 `wrapUntrusted`）。
- 风险等级 `read`，只读权限模式下也能用（index.ts:197）。
- 停用后模型侧少掉：这个工具、那段提示词，以及搜索结果注入上下文的那条路（index.ts:171-174、239-249）。

## Known Limitations（已知限制）

- 每次最多 20 条、默认 5 条；单条摘要封顶 800 字（index.ts:57、284、111-113）。
- 只有三家提供方；域名过滤只有 tavily 原生支持，其它家不硬凑（index.ts:20-22、126）。
- `apiKey` 明文存 `~/.dsc/plugins.json`，推荐改用 `apiKeyEnv`（index.ts:5-6、275-282）。
- 请求 20 秒超时，也会被回合取消打断（index.ts:69-74）。
- 设置里的测试按钮固定搜「Pneuma」，只回条数与第一条标题（index.ts:285、325-333）。

## 行与开关

- 行 id `web-search`，包名 `@pneuma/web-search`，order 3630（package.json:2、14）。
- resolution 是 overridable（package.json:15）；默认开：cordis.patch.yml 里没有 `disabled`，但没 key 时等于没挂工具（index.ts:171-174）。
- 宿主半 inject 三个服务：`tools`、`prompt`、`settings`（index.ts:167）。
- 设置分区 id `web-search`、order 46、五项字段与一颗测试按钮（index.ts:288-293、259-286）。
- `pneuma.settingsSection` 写的就是这个分区，插件中心按它跳到这一区（package.json:18）。
