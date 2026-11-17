# web-search（联网搜索）

一句话：web-search 给模型一个 `web_search` 工具，默认用 DeepSeek 的原生联网搜索，也可以换成 Tavily、博查或 Serper，标题、链接、摘要一起回给它。

## Model Experience（模型体验）

- 注册工具 `web_search`：`query` 必填，`includeDomains` / `excludeDomains` 只在提供方是 tavily 时生效（index.ts:382-400）。
- 工具**总是**注册；没取到 key 时调用回一句能照做的错（去插件中心填 key、别用 curl），不是悄悄消失（index.ts:133-146、473）。
- 配到 key 才真有结果；追加一段「联网搜索」提示词：查证后附来源、搜不到就换关键词、别编造搜索结果（index.ts:475-484）。
- 结果外面包一层不可信围栏，网页里出现的指令只能当资料读（index.ts:426-435，core/untrusted.ts 的 `wrapUntrusted`）。
- 风险等级 `read`，只读权限模式下也能用（index.ts:403）。
- 结果里出现的「摘要」逐条封顶 800 字；`maxResults` 到顶时界面标「只列了前 N 条」（index.ts:124-136、440-455）。
- 停用后模型侧少掉：这个工具、那段提示词，以及搜索结果注入上下文的那条路。

## 提供方

| 提供方 | 怎么认 | key 从哪来 | 特点 |
| --- | --- | --- | --- |
| `deepseek`（默认） | Anthropic 兼容的 Messages 接口 + 原生 `web_search` 工具 | `DEEPSEEK_API_KEY`（环境变量或 `~/.dsc/credentials.yaml` 的 refs 段） | 不用另申请服务；每次搜索多烧一轮模型 token，实测 6~9 秒（index.ts:223-265） |
| `tavily` | `api.tavily.com/search` | 自己在设置里填 | 支持 `includeDomains` / `excludeDomains` 直通 |
| `bocha` | `api.bochaai.com/v1/web-search` | 自己在设置里填 | 国内可直连 |
| `serper` | `google.serper.dev/search` | 自己在设置里填 | Google 结果的代理 |

DeepSeek 那条路把 `x-api-key` 与 `Authorization: Bearer` 两个头都发（官方端点认前者、Anthropic 兼容代理常认后者）；结果从回复里 `web_search_tool_result` 块收，同一条 URL 只留第一次，没有结果块就明确报「这次没触发搜索」（index.ts:267-306）。

## Known Limitations（已知限制）

- 每次最多 20 条、默认 5 条；单条摘要封顶 800 字（index.ts:105-113、124-136）。
- DeepSeek 原生搜索按「让模型搜一轮」计费：多一轮 `deepseekMaxUses` 就多一次模型调用（默认 1 轮）（index.ts:57-64）。
- DeepSeek 那条路接口换代理要改 `deepseekBaseUrl`；模型名不对会直接回 HTTP 400（index.ts:41-52）。
- 域名过滤只有 tavily 原生支持，其它家不硬凑（index.ts:321-330）。
- `apiKey` 明文存 `~/.dsc/plugins.json`，推荐改用 `apiKeyEnv` 或凭据库（index.ts:144-146）。
- 第三方服务请求 20 秒超时、DeepSeek 45 秒，都会随回合取消一起打断（index.ts:147-165、262）。
- 设置里的测试按钮固定搜「Pneuma」，只回条数与第一条标题（index.ts:599-614）。

## 行与开关

- 行 id `web-search`，包名 `@pneuma/web-search`，order 3630（package.json:2、28）。
- resolution 是 overridable（package.json:29）；默认开：cordis.patch.yml 里没有 `disabled`。
- 宿主半 inject 三个服务：`tools`、`prompt`、`settings`（index.ts:377）。
- 设置分区 id `web-search`、order 46、七个字段与一颗测试按钮（index.ts:494-547）。
- `pneuma.settingsSection` 写的就是这个分区，插件中心按它跳到这一区（package.json:32）。
