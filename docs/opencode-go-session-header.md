# opencode Go 端点：缺 `x-opencode-session` 导致 400

> **状态：已修（2026-10-14，未发版）**。下面第一节到「验证」是排查当时的分析原文，
> 保留作为判断依据的存档；「已实施」一节记这一刀最后怎么落的（与原文的「建议改法」有一处偏离，那里说明了为什么）。

## 现象

把模型切成 opencode 端点的（如 `opencode/claude-haiku-5-5`）之后，请求直接失败：

```
HTTP 400：{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing
x-opencode-session and cannot be routed efficiently. Please see
https://opencode.ai/docs/go/#where-can-i-use-it"}}
```

## 请求打到哪

| 位置 | 内容 |
| --- | --- |
| `~/.dsc/config.yaml:6` | `default.provider: opencode` |
| `~/.dsc/config.yaml:57-60` | `baseURL: https://opencode.ai/zen/go/v1`，`apiKeyEnv: OPENCODE_API_KEY` |
| `src/core/config.ts:88` | 读进来时剥掉尾部斜杠 |
| `src/core/llm.ts:434` | 拼成 `${baseUrl}/chat/completions` |

最终 URL：`https://opencode.ai/zen/go/v1/chat/completions`。

## 根因

opencode Go 网关按**会话**做路由和 prompt 缓存，官方文档（`https://opencode.ai/v2/docs/console/go/`
的 “Where can I use it?” 一节）要求客户端满足三条：

1. 流量要像 coding agent；
2. **用自己的 user agent 标识自己**（如 `my-coding-agent/1.0`），不能用通用 SDK / HTTP 库的名字；
3. **每条会话在 `x-opencode-session` 头里带一个稳定的 session ID**。

numa 第 2、3 条都不满足，网关因此拒绝路由，直接 400。

## numa 侧现状

发请求的地方：`src/core/llm.ts:434-441`（`streamOnce` 里的 `fetch`）。请求头只有两个：

```ts
headers: {
  'content-type': 'application/json',
  authorization: `Bearer ${request.apiKey}`,
},
```

没有会话标识头；也没有显式设 `user-agent`，实际值由 Node 的 fetch 实现（undici）决定，
不是能自标识的名字。

类型层也没有可携带这些信息的字段：

| 类型 | 位置 | 现有字段 |
| --- | --- | --- |
| `StreamRequest` | `src/core/llm.ts:73-86` | baseUrl / apiKey / model / messages / tools / maxTokens / temperature / thinking / reasoningEffort / signal |
| `LlmRoute` | `src/core/llm.ts:59-71` | api / baseUrl / apiKey / model / maxTokens / temperature / thinking / reasoningEffort |
| `FileProvider` | `src/core/migrate.ts:34-41` | displayName / baseURL / apiKeyEnv / api / models |
| `ProviderConfig` | `src/core/config.ts:36-44` | name / displayName / baseUrl / apiKey / api / models |

**结论：改 `config.yaml` 配不出来，必须动代码。**

## 现成可用的口子

架构上已经留了扩展点，不用另起一套：

- `src/core/llm.ts:321-326` — `LlmAdapter` 接口（`id` + `stream(request, handlers)`）。
- `src/core/llm.ts:328-329` — 内置协议 id 常量 `OPENAI_COMPLETIONS_API`。
- `src/plugins/llm.ts:65-68` — 适配器表，`openai-completions` 预注册。
- `src/plugins/llm.ts:128-136` — `registerAdapter()`，插件可注册新协议，重名会抛错。
- `src/plugins/llm.ts:137-147` — `stream()` 按 `api` 派发到适配器。
- 端点在 config.yaml 里用 `api: <id>` 选择协议（`src/core/migrate.ts:38`、`src/core/config.ts:41`）。

**会话 id 在插件层是拿得到的**：`src/plugins/llm.ts:23` 已经在用 `ctx.session.current().meta.id`。
问题是 `LlmAdapter.stream(request, handlers)` 的 request 里没有会话 id，所以**即便自建适配器也拿不到**，
必须先把字段从 core 的 `StreamRequest` 铺下来。

## 建议改法

1. `src/core/llm.ts:73-86` — 给 `StreamRequest` 加可选字段，比如 `sessionId?: string`。
2. `src/plugins/llm.ts:137-147` — `stream()` 派发前把当前会话 id 塞进 request。
   注意这里是一个汇聚点：循环轮次、压缩、子智能体都从这儿过，改一处全体受益。
3. `src/core/llm.ts:436-439` — 按条件补 headers：`user-agent` 自标识 + `x-opencode-session`。

条件从哪来，建议走配置而不是硬编码供应商名：给 `FileProvider`（`src/core/migrate.ts:34-41`）
和 `ProviderConfig`（`src/core/config.ts:36-44`）加一个可选字段（例如
`sessionHeader: true` 或更通用的 `headers: Record<string, string>`），解析时透传到 route。
硬编码判断 URL 里有没有 `opencode.ai` 更省事，但下次换别的网关就得再改一遍。

## 注意

- **不能无条件加这个头**。`src/core/llm.ts:44-46` 的注释已经写了同类教训：「多带一个未知字段，
  挑剔的网关会直接判 400」。请求体如此，请求头同理。必须按端点开关，否则会打坏现在能用的
  deepseek 等端点。
- user agent 必须是自标识的名字，不能留 undici / node 这类通用值（文档第 2 条）。
- 文档写明「Traffic is monitored for abuse that degrades the experience for other users」，
  **补齐头不等于一定放行**，改完要实测确认。
- 文档的「Known problematic clients」名单里第一条就是 **DeepSeek Harness**，理由是
  「session information arrives on some model paths, but is missing on others」。numa 首次运行
  从 dsh 的 `settings.yaml` 迁移而来（`src/core/config.ts:2-3`），排查时值得顺带看一眼
  辅助请求（标题生成、压缩、子智能体）是不是各自走了不同路径——这类「部分路径带、部分不带」
  的毛病往往不是单点。

## 验证

改完在 numa 里切到 opencode 的模型发一条消息，看 400 是否消失即可。

## 已实施（2026-10-14）

### 为什么同类客户端不踩这个坑（读源码核过）

| | 机制 |
| --- | --- |
| ZCode（`apps/zcode-cli/packages/adapters/src/model/runner-attribution.ts`、`opencode-session.ts`） | 所有模型请求过**一个**归因头构造器：`x-opencode-session` 只在 `isOpenCodeGoBaseUrl(baseURL)` 为真时发——host 是 `opencode.ai` 或其子域、path 规范化后正好 `/zen/go/v1`（大小写与尾斜杠都宽容，`/zen/v1` 的普通 Zen 不算）；值取会话 id 并剥掉内部前缀（`sess_` / `subagent_agent_`），没有会话 id 就省略这个头。同一构造器还发 `x-session-id`、`x-zcode-session-type`、`x-request-id` 等观测头（设计稿 `docs/superpowers/specs/2026-06-09-agent-model-request-session-header-design.md`） |
| dsh（`packages/llm/llm-pi-ai/src/adapter.ts`、`packages/llm/llm/src/attribution.ts`） | 把 `options.sessionId` 传给底层 SDK，由 SDK 按 provider 目录里的 `sessionAffinityFormat`（`packages/llm/llm-pi-ai/src/catalog.ts`）决定发什么；另有 `attributionHeaders()` 给**每个**请求带自标识 `user-agent` |

共同点两条：**会话 id 一定铺到请求层**（这是 numa 缺的那半）、**发不发这个头由端点形状决定**
（不认 provider id——那是用户随手起的名字，会变）。

### numa 落地

| 面 | 改动 |
| --- | --- |
| `src/core/request-attribution.ts`（新，纯模块） | 门控 `isOpenCodeGoBaseUrl`（host ∈ {`opencode.ai`, `*.opencode.ai`} 且 path 规范化 = `/zen/go/v1`）；会话 id 合法性只放行 `[A-Za-z0-9._:-]{1,128}`，非法/超长/空一律**省略这个头**（绝不让观测字段把请求弄坏）；`sessionAttributionHeaders` 出「自标识 UA + 命中才加会话头」 |
| `src/core/llm.ts` | `StreamRequest` 加可选 `sessionId`；`streamOnce` 的 fetch 头展开 `...sessionAttributionHeaders(request.baseUrl, request.sessionId)`——不命中就是空表，别家端点发出去的头与修前逐字节一样 |
| `src/plugins/llm.ts` | 派发口兜底 `sessionId: request.sessionId ?? currentSessionId(ctx)`：所有 LLM 流量都从这条缝过，改一处全体受益 |
| `src/core/loop.ts` / `compact.ts` / `plugins/session-title.ts` / `plugins/approval.ts` | 各自带上**自己那条会话**的 id（回合用 `this.session.meta.id`——后台会话也在跑，不能填「当前查看的会话」；摘要算被压的会话；标题算被起名的会话；审批算发起调用的会话） |

**与上面「建议改法」的偏离**：原文提议给 `FileProvider`/`ProviderConfig` 加可选字段让用户在
`config.yaml` 里开。最后没走配置，改走 URL 门控——两份参考实现都这么判，而且「配置写不出来」
本来就是这个报障的前提（用户再配一遍没有意义）；门控条件挑的是端点的**事实**（host+path），
不认 provider id。要接别家网关时在同一个模块里补一条门控即可。

**自标识 user-agent 只在命中门控时带**：文档第 2 条只对 opencode Go 提要求，所以别家端点
（deepseek / glm / command）的请求头保持原样——与原文那条「不能无条件加」的提醒一致。

### 验证

- 新探针 `scripts/llm-session-header-test.mjs`（**51 条**）：门控纯逻辑、真 wire（桩掉
  `globalThis.fetch` 跑真 `streamChat`，逐条看发出去的头）、重试稳定（5xx 重试两次物理请求
  会话 id 不变）、内核端到端（真 kernel + Go baseUrl 跑真回合：会话头 = 该会话 `meta.id`，
  两轮不变，标题支线也带同一个）、铺线钉（四个调用方 + 派发口兜底 + 协议层只有一处补头）。
- **没有真打一次 opencode Go**（要花用户的 key，且文档明写「补齐头不等于一定放行」）。
- `/models` 拉取清单那条路（`src/core/model-discovery.ts`）没带这个头：它没有会话可归因
  （纯端点探测）。若那边也被要求，在同一模块里补即可。

## 参考

- opencode 文档：https://opencode.ai/v2/docs/console/go/ （“Where can I use it?” 一节）
