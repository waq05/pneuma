# 缓存命中率排查：团队板动态内容污染系统提示

> 审计对象：numa 会话 `c2838565-45c2-4c9f-8a75-5cb629fb43ec`（底部状态栏「497K tok · 缓存命中 50%」、
> 转录里「系统提示 13.6K 字 · 12 段 · deepseek-v4.1-flash」连续出现多次）。
> 代码基准：`dev@721fb828`（审计开始时本 worktree 与 dev 同指、`git status` 干净）。
> 审计期间 `prompt-cache` 子代理已在本 worktree 改动：`M src/packages/subagent/index.ts`、
> `M src/packages/subagent/tests/{w11-branches,wiring}.spec.ts`、`?? src/packages/subagent/board-snapshot.ts`。
> 报告落笔前已复查：主链路（常量段 + `team-board` 投影）已接通，§9 按「接通后的剩余风险」写。
> **本报告里凡涉及 `src/packages/subagent/index.ts` 的结论一律以 dev 基线为准**（行号指 dev 基线，
> 第九节另注 worktree 当前行号）。
> 数据基准：`D:\waqData\dsc\sessions\D-dsc\c2838565-….jsonl`、`D:\waqData\dsc\usage\usage.jsonl`
> （lead 提供的路径；本报告的数字已独立复核，见 §3）。

---

## 1. 结论摘要

**缓存命中低的根因只有一个：系统提示里有随着每次请求变化的内容，导致每次请求的前缀从变化点往后全部作废。**
这个变化源是 `src/packages/subagent/index.ts:2166-2192` 的 `boardPromptText()`——它每轮现读任务板、队友状态、
最近活动并拼成 `team` 段，`index.ts:2249` 把它注册进系统提示。该段在段序上排在 `instructions`（AGENTS.md，
2942 字）与 `skills`（技能目录，6089 字）**之前**，所以一旦它变，后面的 ~10K 字系统提示和**整段对话历史**
都按全价重读。会话实测：7 个系统提示版本里，**唯一反复变化的就是 team 段**（209→452→507→693→693→900→923 字，
队友状态/任务进展每次变化它就涨）；v2 定稿为 12 段之后，其余 11 段全程逐字未变。

修法不是「调小缓存开关」，而是**稳定段与易变段分离**：系统提示里只留逐字常量（介绍+规矩），看板数据改走
`registerProjection` 追加到消息尾部（user 角色），并且只在看板变化后注入一次。这与 dsh 的 runtime-context、
ZCode 的 meta-user attachment 是同一形状。按该会话数据测算：把被拖累的请求拉回未变请求的水平（78–96% 命中），
整体命中率 **84.6%–90%**，取中位约 **87.8%**（算法见 §3.3）；换句话说「稳定后 85%+」成立。

---

## 2. 指标口径：「缓存命中」到底怎么算

### 2.1 状态栏那个百分数

| 项 | 口径 | 位置 |
| --- | --- | --- |
| 显示 | `12.3K tok · 缓存命中 87%`；`497K tok` 是**本会话累计**输入+输出 token | `src/packages/ui-statusbar/ui/ui.tsx:262-291` |
| 分子 | `cacheHitTokens`：本会话所有请求的 `prompt_cache_hit_tokens` 之和 | `ui/ui.tsx:277-280`、`:513-523` |
| 分母 | `cacheHitTokens + cacheMissTokens`（**只算端点上报过明细的请求**；不是输入总量） | `ui/ui.tsx:279-280`、`src/core/usage-log.ts:373-379` |
| 百分比 | `hit /(hit+miss)`，不足 100% 时加小数位区分「差几个 token」 | `ui/ui.tsx:663-692` |
| 数据源 | 优先读 `~/.dsc/usage/usage.jsonl` 按会话折叠；日志里没这条会话时退回内存快照累计 | `ui/ui.tsx:137-139`、`src/core/usage-log.ts:407-417`、`src/adapter/transcript.ts:908-920` |
| 累计还是按轮 | **累计**（整个会话、按 token 加权），不是最近一轮 | `src/contract/usage.ts:103-115` |

关键含义：**这是会话累计值，按 token 加权**。早期大上下文的请求权重高，所以一次「系统提示变了」的大请求
就能把整条会话的百分比拽下去；反过来，修好后旧会话的读数不会回溯变好，必须用新会话验证。

### 2.2 usage.jsonl 的字段与 i / ch / cm 的关系

`src/core/usage-log.ts:29-59` 定义了两种行：请求行与工具行（`k:'tool'`，无 token）。
请求行字段：

- `i` = `prompt_tokens` **总量，含缓存命中部分**（`src/core/llm.ts:698-708`；`src/core/pricing.ts:115-128` 同口径）。
- `o` = 输出 token。
- `ch` = `prompt_cache_hit_tokens`（DeepSeek 系）或 `prompt_tokens_details.cached_tokens`（OpenAI 系）；
  `cm` = `prompt_cache_miss_tokens`（DeepSeek 直接给）或 `i - ch`（OpenAI 系，`llm.ts:700-702`）。
- 因此 **DeepSeek 系上 `i == ch + cm`**；本会话实测 485,017 = 241,152 + 243,865，严格相等。
- `sid` = 发起请求的会话 id（队友的轮次也记在主会话名下时靠它区分）。
- `lm` / `ft` / `d` = 这一步的墙钟读数（毫秒），**与缓存命中无关**：
  - `lm` = 发出 → 定稿（`llmMs`），`src/packages/session-core/loop.ts:121-140`、`:547`；
  - `ft` = 发出 → 第一口输出（`ttftMs`，首字延迟）；
  - `d` = 第一口输出 → 定稿（`decodeMs`，输出速度的分母）；
  - 写入点：`src/packages/agent/index.ts:112-124`；读取/聚合：`src/core/usage-log.ts:43-52`、`:380-391`。

一行原始记录：

```json
{"t":1794922359148,"provider":"opencode","model":"deepseek-v4.1-flash","i":15206,"o":558,"ch":14464,"cm":742,"sid":"c2838565-…","lm":5289,"ft":2624,"d":2665}
```

---

## 3. 实证：7 个提示版本、16 次请求、49.72%

### 3.1 系统提示版本（会话日志 `state id=system-prompt`）

| 版本 | hash | 字数 | 段数 | 变化的段 |
| --- | --- | --- | --- | --- |
| v1 | `9e68ca5ef3026dff` | 11,891 | 10 | 初始（未开 web-* 插件，team 段 209 字） |
| v2 | `e8c4700f2b64534c` | 13,130 | 12 | subagent 段 1189、team 452、新增 web-fetch/web-search |
| v3 | `ce23b11da9753bd4` | 13,185 | 12 | **team 段 452→507**（队友状态） |
| v4 | `b6b56041501720e1` | 13,371 | 12 | **team 段 507→693**（板上出现任务 t1） |
| v5 | `4816092eed34866d` | 13,371 | 12 | **team 段仅一处 `working`→`stopped`** |
| v6 | `00b2e46064012bd5` | 13,578 | 12 | **team 段 693→900**（队友停工） |
| v7 | `77012dc47f1899f6` | 13,601 | 12 | **team 段 900→923**（任务状态变化） |

逐段 diff 的公共前缀只有 **3,287–3,417 字**（v3→v4 起）；也就是说系统提示后面 ~10K 字 + 全部历史都在
变化点之后。其余 11 段（identity / behavior / tool-rules / lsp / computer-use / subagent / web-fetch /
web-search / instructions / skills / model）在 v3–v7 期间**逐字未变**。

### 3.2 逐请求命中（16 条真实请求，`usage.jsonl` 按 sid 过滤；另有 29 条工具行）

| # | 输入 i | 命中 ch | 未命中 cm | 命中% | 归因 |
| --- | --- | --- | --- | --- | --- |
| 1 | 14,864 | 0 | 14,864 | 0% | 冷启动（首次请求，必 0） |
| 2 | 15,206 | 14,464 | 742 | 95% | 提示未变 |
| 3 | 16,428 | 14,848 | 1,580 | 90% | 提示未变 |
| 4 | 17,579 | 16,000 | 1,579 | 91% | 提示未变 |
| 5 | 21,887 | 20,224 | 1,663 | 92% | 提示未变 |
| 6 | 26,216 | 21,504 | 4,712 | 82% | 提示未变 |
| 7 | 29,698 | **0** | 29,698 | **0%** | 提示版本变化 |
| 8 | 30,516 | 29,312 | 1,204 | 96% | 提示未变 |
| 9 | 36,784 | 30,080 | 6,704 | 82% | 提示未变 |
| 10 | 41,710 | **0** | 41,710 | **0%** | 提示版本变化 |
| 11 | 44,675 | 41,344 | 3,331 | 93% | 提示未变 |
| 12 | 43,845 | 34,560 | 9,285 | 79% | 提示未变、历史变短（疑似压缩/裁剪，见 §10） |
| 13 | 34,465 | 17,152 | 17,313 | 50% | 头部未变、历史中段被改写（推测，见 §10） |
| 14 | 35,574 | 1,664 | 33,910 | 5% | 提示版本变化（只命中变化的提示前 ~1.7K token 公共前缀） |
| 15 | 37,387 | **0** | 37,387 | **0%** | 提示版本变化 |
| 16 | 38,183 | **0** | 38,183 | **0%** | 提示版本变化 |

合计：输入 485,017，命中 241,152，**49.72%**；未命中 243,865，其中第 7/10/14/15/16 次（提示变化）
合计 182,552，占全部未命中的 **74.9%**。未变的请求命中 **78–96%**，变了的请求 **0%（一次 5%）**。

### 3.3 修好后的预期命中率（给 prompt-cache 验收用的目标数）

把「被系统提示变化拖累的请求」按未变请求的命中水平重算（首请求冷启动 14,864 保持 0%）：

| 假设未变请求命中水平 | 重算后总命中 | 总命中率 |
| --- | --- | --- |
| 78% | 410,425 | 84.6% |
| **85%（中位）** | **425,616** | **87.8%** |
| 88% | 432,127 | 89.1% |
| 90% | 436,467 | 90.0% |

即：**修好后该会话量级的整体命中率应在 85%–89%，单轮（除首请求）应在 80% 以上**。这是验收线，不是拍脑袋。

---

## 4. P0 / P1 原因排序表

| 级别 | 原因 | 证据（file:line） | 影响（哪些 token 不命中） |
| --- | --- | --- | --- |
| **P0** | `team` 段每轮现拼任务板/队友状态/最近活动，注册进系统提示 | `src/packages/subagent/index.ts:2166-2192`（`boardPromptText`）、`:2249`（`ctx.prompt.register('team', boardPromptText)`）；会话 v3–v7 只有 team 段变 | 变化点（系统提示前 ~3.3K 字）之后：其余 8 段系统提示 + instructions 2942 字 + skills 6089 字 + **整段对话历史**，全部按未命中重读 |
| **P0（同源）** | 队友系统提示里同样每轮现拼「队伍 + 板子摘要 + 最近活动」 | dev 基线 `src/packages/subagent/index.ts:1024-1053`（`teamCollabText`）、`:1148-1171`（`systemPrompt: () => …${teamCollabText(teammate)}`） | 每个队友会话的每次请求，系统提示都变 → 队友侧缓存同样近乎全灭；且队友 `MiniAgent` 没有投影链（`deps.rewrite` 未传，见 `session-core/loop.ts:75-89` 的注释与 subagent `:1145-1148`），不能靠尾部注入自救 |
| P1 | 工具定义（schema）随插件装卸/连接变化而变；变更点在请求最前，等于整段前缀作废 | `src/packages/tools/index.ts:42,57-78`（注册序即序列化序）、`src/packages/session-core/loop.ts:500-510`、`src/core/llm.ts:581-586`；动态注册点：`mcp/index.ts:259-265`、`subagent/index.ts:2221-2271`、`browser`/`computer-use` 的 `syncTools` | 工具目录一变，从工具声明位置起（多数模板在消息之前）全部未命中；会话中期才启用插件/连 MCP 时最明显 |
| P1 | 工具结果微压缩（microcompact）默认 `refresh:'round'`，每跨一轮清理点前移一条 → 前缀从最早被清的那条起失效 | `src/packages/microcompact/index.ts:49`（order 650）、`:76`（默认 `round`）、`:112-163`；`microcompact.ts:99-107` 注释实测「命中率被拖到 60% 上下（会话 bb13f0b5）」 | 被清工具结果之前的 token 命中，之后全 miss；长会话里每轮都断一次 |
| P1 | 历史重写类改动：真压缩、tool-result-prune、image-diet | `src/packages/session-core/compact.ts:373-375`（`replaceWithSummary`）；`src/packages/prompt/index.ts:240-250`（prune）、`:251-268`（image-diet）；`src/packages/session-core/compact.ts:305-310,327-348`（压缩请求想复用主前缀） | 压缩一次断一次（不可避免）；prune 在「第一次越线」断一次；image-diet 每卸一张旧图就在图的位置断一次（图在历史前部 → 后面全 miss）。§3.2 第 13 次 50% 疑似此类 |
| P1 | `schedule` 段包含「下次触发时刻」绝对时间，任务触发/编辑后变化 | `src/packages/schedule/index.ts:458-480`、`src/core/schedule/rule.ts:743-748`（`describeNext` 输出绝对时刻） | 每次定时任务触发后一次全量失效；没配定时任务则无影响 |
| P1 | `memory` 段并入 `# agentsMd` 块，记忆写入后变化 | `src/packages/memory/index.ts:387-390`；`src/packages/session-core/prompt.ts:229-251`、`:434-441` | 每次 `memory` 工具成功写入 → 系统提示变 → 全量失效（同一会话多次写就多次断） |
| P1 | `self-improve` 段含「待审候选条数」，propose/promote 后变化 | `src/packages/self-improve/index.ts:1295-1318` | 每次登记候选后断一次；频率取决于用户 |
| P2 | `mcp-instructions` 段随 MCP 连上/断开变化；`preset:persona` 随模式切换；`model` 段随 /model 切换；`skills` 随技能增删；`instructions` 随 AGENTS.md 被改 | `src/packages/mcp/index.ts:267-283`；`src/packages/presets/index.ts:195-211`；`src/packages/prompt/index.ts:316-320`；`src/packages/session-core/prompt.ts:420-446`、`:253-272`（mtime 缓存） | 都是一次性失效（改一次断一次），属正常代价 |
| 非问题（安全） | 环境事实 / 模式 / 沙箱已走「请求末尾 user 快照」 | `src/packages/prompt/index.ts:143-239`（env-facts order 600，`:237` 追加 user 消息）、`src/packages/mode/index.ts:91`、`src/packages/sandbox/index.ts:463-470`（注释记录过历史上放系统提示导致「59K 未命中、只命中 4K」的事故） | 落在前缀之外，只增加尾部未命中（几十~几百 token/轮） |

---

## 5. 系统提示 12 个段的来源与稳定性（会话 v7 实测）

段排序：先 order，再 id（`src/packages/session-core/prompt.ts:80-85`、`:448`）。

| 段 id | order | 字数(v7) | 谁贡献 | 稳定性 |
| --- | --- | --- | --- | --- |
| identity | 0 | 127 | 内核 `session-core/prompt.ts:104-106` | **永不变** |
| behavior | 10 | 508 | `session-core/prompt.ts:108-118` | **永不变** |
| tool-rules | 20 | 298 | `session-core/prompt.ts:120-126` | **永不变** |
| lsp | 42 | 323 | `packages/lsp/index.ts:225-233`（启用时静态文本） | 仅启停时变 |
| computer-use | 60 | 735 | `packages/computer-use/index.ts:496` + `:455-488`（含缩放系数、限定应用、每截屏动作数） | 仅设置/缩放变化时变 |
| subagent | 60 | 1189 | `packages/subagent/index.ts:2210-2244`：角色表（`agent-roles.ts:431-441` 磁盘读、按名排序）、`maxTeammates`、`teamMode`、`board`、`modelRuleText()`（`:638-647`） | 稳定（仅设置/角色文件/模型变时） |
| **team** | 60 | **923** | **`subagent/index.ts:2166-2192` + `:2249`** | **P0 每轮变** |
| web-fetch | 60 | 293 | `packages/web-fetch/index.ts:129-139` | 静态 |
| web-search | 60 | 109 | `packages/web-search/index.ts:475-483` | 静态 |
| instructions | 200 | 2942 | `session-core/prompt.ts:197-227`（读 AGENTS.md/CLAUDE.md，mtime 缓存 `:253-272`），`:439-441` 组装 | 文件被改时变一次 |
| skills | 210 | 6089 | `packages/prompt/index.ts:316`（`ctx.skills.catalogText()`） | 技能增删时变一次 |
| model | 890 | 43 | `packages/prompt/index.ts:320`（`ctx.llm.model`） | /model 切换时变一次 |

本会话里没出现、但同样受 `ctx.prompt.register` 管的其他易变段：`preset:persona`(15)、`schedule`(41)、
`self-improve`(43)、`mcp-instructions`(55)、`ops`(60)、`memory`（并入 agentsMd 块）。
审计过的 **safe 路径**：env-facts（600）、mode/sandbox 的 `registerEnvFacts`——它们在请求尾部追加 user 快照，
不在系统提示里，不会破前缀。

---

## 6. 消息级前缀稳定性审计

| 机制 | 结论 | 证据（file:line） |
| --- | --- | --- |
| 请求组装 | 每次请求都是 `[system(系统提示全文), ...session.messages]`，再跑投影链 | `src/packages/session-core/loop.ts:439-446` |
| `applyExplicitCache` | 只在端点声明 `cacheControl:true` 时打点（缺省 false）；打两处：第一条 system + 最后一条消息。**头部断点救不了会变的系统提示**——内容一变，两处缓存键都作废 | `src/core/llm.ts:759-806`（`:777-806`）、`:570-586`（wire 使用）、`src/core/config.ts:403`、`src/packages/llm/index.ts:132`、`loop.ts:498` |
| 本会话端点 | `opencode` 网关（`D:\waqData\dsc\config.yaml` 的 `opencode.baseURL=https://opencode.ai/zen/go/v1`，未声明 cacheControl）→ **没有显式断点**，靠网关自动前缀缓存；所以字节前缀稳定是唯一杠杆 | 配置文件；`src/core/llm.ts:768-770` 的注释 |
| `fold-system` 投影 | 把历史里所有 system 并进头部一条。**任何插件往历史补 system 都会重写第 0 条** → 前缀从第一个 token 起失效。当前 plugins 都改用了 user 角色 | `src/packages/prompt/index.ts:139-142`、`src/core/llm.ts:152-181` |
| `serializeMessages` 字段裁剪 | 删 `ts`/`files`/`origin`；assistant 只保留 `role/content/reasoning_content/tool_calls` → 历史字节稳定（前提是模型每次回同样内容） | `src/core/llm.ts:737-757` |
| 工具定义顺序 | 序列化顺序 = 工具注册序（Map 插入序）+ 投影链；`intercept` 一变就破前缀；dsh 侧对工具序做了字典序确定性排序，dsc 没有 | `src/packages/tools/index.ts:42,57-78`、`loop.ts:500-510`、`llm.ts:581-586` |
| 工具孤儿清洗 | `sanitizeToolOrphans` 会删历史条目（一次性的），删一次断一次 | `src/core/llm.ts:563-570`、`:221-223` |
| microcompact | 默认每轮重算清理计划（`refresh:'round'`），清理点前移 = 前缀断；注释实测命中掉到 60% | `src/packages/microcompact/index.ts:49,76,112-163`、`microcompact.ts:99-107` |
| 真压缩 | `replaceWithSummary` 改写历史中段 → 从改写点起全部 miss；压缩请求本身想复用主前缀（system+tools 一字不差），但**系统提示每轮变时这条暖前缀路径也跟着断** | `src/packages/session-core/compact.ts:305-310,327-348,373-375`、`packages/compact/index.ts:199-212` |
| tool-result-prune / image-diet | 确定性裁剪，只在「第一次越线/第一次卸图」断一次；图在历史前部时后面全 miss | `src/packages/prompt/index.ts:240-250,251-268` |
| env-facts 尾部快照 | 每轮追加到最后（默认 `envRefreshMs=0`），**不破前缀**，只让「上一条尾部快照」那段不可复用；hash 去重后只落一条状态 | `src/packages/prompt/index.ts:66-88,143-239`、`:396-401` |
| 系统提示落盘去重 | 按 hash 去重（`appendSystemPrompt`）——**工作正常**；转录里连出多张卡不是因为去重坏了，而是每轮 hash 真的不同 | `src/core/session.ts:1241-1255` |
| 系统提示卡合并 | 只合并「同 kind、最近一条、hash 相同」的卡；hash 不同就新长一张卡，而卡片可见摘要（字数取整 + 段数）可能完全相同 → 看起来像「同一份提示注入 3 次」 | `src/adapter/transcript.ts:950-962` |

---

## 7. dsh / ZCode 对照（它山之石）

### 7.1 dsh（`D:\deepseek-harness\deepseek-harness`）

1. **系统提示分层是「段注册表」，动态事实根本不进去。** 系统提示 = 若干 `PromptSection`（静态或按组装上下文求值）
   按 order+name 排序渲染（`packages/core/system-prompt/src/index.ts:297-302`、`:254-262`）。
   目录/沙箱/审批/子代理身份/源码路径/Web 地址这类动态事实，走独立的 `ctx.systemPrompt.context()`
   （runtime-context），order 表见 `packages/core/system-prompt/src/index.ts:178-186`，注释写明
   **「Process-specific paths and endpoints stay out of the cached system prompt」**。
2. **动态状态注入位置 = 历史末尾的 `<system-reminder>` user 消息，且「没变就不发」。** 快照渲染见
   `packages/core/system-prompt/src/index.ts:309-325`；投影只在 contributions 与上次不同时才产出一条
   user 消息（`deepEqualJson` 判等），否则 `return`（`packages/core/agent-loop/src/runtime-context.ts:124-181`）。
   文档把规则写死：未变不注入、压缩把我留的快照弄丢才重注（`packages/core/agent-loop/README.md:172-180`）。
3. **系统提示变化时优先「追加在已缓存历史之后」而不是重写第 0 条。** 路由声明 `systemPromptUpdate:'in-history'`
   时，继续中的请求序列把变更后的提示追加到历史后（`packages/core/agent-loop/README.md:166`、
   `packages/core/agent-loop/src/agent.ts:448-460,716-727`；能力判定 `packages/llm/llm-pi-ai/src/models.ts:75-91`）。
   不具备该能力的路由才回落到头部替换（并从那里断缓存）。**注意：这条 dsh 的招术在 dsc 用不了**——
   dsc 的 `fold-system` 会把历史里任何 system 并进头部，反而更糟；dsc 只能走 user 尾部快照。
4. **缓存断点打三处：system + 最后一个工具定义 + 最后一条消息。** 实现在依赖 `pi-ai`
   （`node_modules/.pnpm/@earendil-works+pi-ai@0.85.…/dist/api/openai-completions.js:622-623,807-874`），
   仅当 model compat 声明 `cacheControlFormat:'anthropic'` 时启用（`packages/llm/llm-pi-ai/src/catalog.ts:143,266`）。
5. **团队板：系统提示里只有静态政策，数据全靠工具现查。** `packages/team/tool-agent-team/src/index.ts:27-33`
   的 `TEAM_POLICY` 是纯常量，`:112-116` 注册为 `team:policy` 段；任务板动态数据不在提示里，
   模型用 `team_task_list/get/update` 拉（同文件 `:117-235` 的工具定义）。
   子代理身份说明也特意做成 runtime-context 而不是系统提示段，理由注释写得直白：
   「so the deployment's system prompt stays uniform across parents and children」
   （`packages/subagent/subagent/src/child-agent.ts:166-175,205-210`）。

**对 dsc 的直接启示**：dsh 的「每轮注入如何去重节流」= **内容判等、未变不发**；「动态状态注入在哪」= **历史末尾
user 快照**；「缓存断点」= system + last tool + last message（且断点无法挽救已经变化的头部）。

### 7.2 ZCode（`D:\zcode-code\ZCode`）

1. **稳定/易变两档明码标注。** 每个上下文段带 `cacheHint: 'stable' | 'dynamic'`
   （`apps/zcode-cli/packages/core/src/context/types.ts:54,66`），builder 按档组装：
   CLI prefix（无 cache marker）+ stable body（ephemeral 断点）+ dynamic body（ephemeral 断点）
   （`apps/zcode-cli/packages/core/src/context/builder.ts:240-281`；`:323-337` 的注入排序也是 stable 在前）。
2. **易变事实不进系统提示，走 meta-user attachment。** env/日期/模型/memory/skills/context_prefix 这些段
   `cacheHint` 全是 `dynamic`（`.../context/sections/env-info.ts:194,218,309`、`current-date.ts:19`、
   `memory.ts:21`、`skills.ts:31`、`request-user-context.ts:38`），由
   `buildMetaUserAttachments`（`builder.ts:295-321`）作为用户侧附件/历史消息发送；
   规范文件写明「tool schemas, project instructions, skills, current date 都在默认 system blocks 之外；
   静态/全局缓存体和动态体分离」（`apps/zcode-cli/docs/design/v2/loop/system-prompt-contract.md:21-23,82-110`）。
3. **对话尾部断点每次移动到最新一条非 system 消息（并先清掉旧断点），保证「历史前缀 + 本轮新增」这个形状。**
   `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts:139-142,549-570`。
4. **系统提示按会话快照，不在每次请求按当前代码重建。** 注释写明原因：「system 原来每次按当前代码重建，
   升级或冷恢复后已发送的前缀字节改变，prompt cache 失效」（`.../runtime/methods/context-refresh.ts:80`，
   另见 `:310,452`）；规范里说明会话只在压缩或换模型时接受提示契约更新
   （`system-prompt-contract.md:7-10,138-147`）。

---

## 8. 验证方法（可执行）

### 8.1 单测断言：系统提示逐字不变

```ts
// 在 subagent 包测试里用 fake ctx（已有 wiring.spec.ts 的 harness）：
const before = ctx.prompt.systemPromptParts(cwd, scope).text
// 造一次看板变化：create → claim → note（或用 team_task 工具跑一遍 runTeamTask）
const after = ctx.prompt.systemPromptParts(cwd, scope).text
expect(after).toBe(before)                    // 系统提示逐字相同
expect(promptHash(after)).toBe(promptHash(before))
// 反例守卫：常量里不能出现看板数据
expect(before).not.toContain('在队队友与绑定任务')
expect(before).not.toContain('最近活动（新的在前）')
```

### 8.2 单测断言：看板快照「变了才注入、同一次请求派生两遍答案一致」

```ts
// 直接测 board-snapshot.ts 的纯函数 + 台账
const wm = new BoardSnapshotWatermark()
expect(wm.due('s1', '1:0:0', 0)).toBe(true)          // 首次注入
wm.mark('s1', '1:0:0', 0)
expect(wm.due('s1', '1:0:0', 0)).toBe(true)          // 同一轮 invariant 二次派生：必须一致
expect(wm.due('s1', '1:0:0', 1)).toBe(false)         // 下一轮、板子没变：不注入
expect(wm.due('s1', '2:0:0', 1)).toBe(true)          // 板子变了：注入
// 投影层：两次 rewrite 的「最后一条消息」必须逐字相同，且 role 是 user（不是 system）
```

### 8.3 只读探针：从真实会话账本对齐「提示版本 × 命中率」

本报告的数据就是这样核出来的，可直接复用（PowerShell，只读）：

```powershell
$sid='<会话 id>'
# 1) 系统提示版本（会话 jsonl）
Get-Content "<session>.jsonl" | Where-Object { $_ -match '"id":"system-prompt"' } |
  ForEach-Object { ($_ | ConvertFrom-Json).payload.hash }
# 2) 逐请求命中（usage.jsonl）
Get-Content "$env:USERPROFILE\.dsc\usage\usage.jsonl" | ForEach-Object { try { $_|ConvertFrom-Json } catch {} } |
  Where-Object { $_.sid -eq $sid -and $null -ne $_.i } |
  ForEach-Object { "{0} i={1} ch={2} cm={3} hit={4}%" -f $_.t,$_.i,$_.ch,$_.cm,[math]::Round(100*$_.ch/[math]::Max($_.i,1)) }
```

判据：**提示版本数应为 1（会话内无设置/模型/插件/AGENTS.md 变化时）；单轮命中（除首轮）≥ 80%。**

### 8.4 真实会话核对（改完必跑）

1. 新开一个会话，开任务板与子代理，跑 6–8 轮，中途让队友认领/完成/写进展。
2. `usage.jsonl` 按 sid 算：请求 2 起单轮命中 ≥ 80%，整体（含首轮）≥ 85%。
3. 会话 jsonl 里 `system-prompt` 状态记录应只剩 **1 条**（或只在真正改了设置/模型时多 1 条）；
   转录里不应再出现「同一份系统提示连出多张卡」。
4. 反例检查：看板变化后模型仍应拿到最新数据——检查该轮请求尾部有一条以 `# 共享任务板快照` 开头的
   user 消息，且下一轮同一板子不再重复注入。

### 8.5 防止回归的 grep 断言

```bash
# 系统提示段注册点不得再出现「每次现读看板」的函数
git grep -n "ctx.prompt.register('team'" -- src/packages/subagent/index.ts
# 期望：取文本的是常量或只依赖 config，不得出现 readBoard / teammates
git grep -n "readBoard" -- src/packages/subagent/index.ts
# 期望：readBoard 只出现在工具实现与投影里，不出现在 prompt.register 的闭包里
```

---

## 9. 给 prompt-cache 子代理的具体修改建议（含在途方案审查）

在途方案方向正确，且**复查时主链路已经接通**：`board-snapshot.ts` 拆出纯函数 + 水位台账；
`index.ts:2299` 已把 `team` 段切成逐字常量 `TEAM_BOARD_GUIDE`；`:2301-2306` 已注册
`registerProjection('team-board', …, { order: 700 })`；投影本体 `:2185-2240` 是「追加 user 消息 +
水位判据 + 空板短路 + 注入卡/留底两个台账」。`teamCollabText` 也已静态化。
以下按「还剩哪些点要盯」排列：

1. **队友状态的通道要在常量里点名。** `subagent` 段已加规则「在队队友与绑定任务不在系统提示里……
   要看谁在干什么，用 `subagent list`」（`index.ts:2273`），但 `TEAM_BOARD_GUIDE`（`:529-539`）
   只指向 `team_task`。建议在 `TEAM_BOARD_GUIDE` 里补一句「队友名单与状态用 `subagent list` 查」，
   否则模型只看到 `team_task` 时不会想到还有这条通道。另请确认 `subagent list` 返回
   `state/role/taskId`（契约 `TeammateView` 是有的）。
2. **加一个「每用户轮至少重注一次」的下限（可选但建议）。** 现在 `BoardSnapshotWatermark.due()`
   的语义是：同一轮的二次派生必须注入（`board-snapshot.ts:169-178`）、下一轮板子没变就不注入。
   但注入不落会话历史（`:2224-2228` 自己补 note），所以板子长时间不动的会话里，模型后续轮次手里
   **没有**那份快照，只能靠自觉调工具。建议参照 `core/todo-reminder-cadence.ts` 加「每 N 轮/每用户轮
   至少重注一次」的下限；代价是每轮几十~几百 token 的尾部未命中，远小于系统提示全断。
   若决定不加，请在 `team-collab-plan.md` 里写明这个取舍（模型只被提醒一次，后续靠工具）。
3. **确定性序列化保持住。** 任务/活动按 id/时刻排序（现在按板上顺序，删除重建会换序）；不要放相对时间
   （`activityDigestLine` 用 `hh:mm` 绝对时刻，OK）；`BoardSnapshotWatermark` 的
   `revision:activity.length:最新活动 at` 三个分量缺一不可（纯活动追加不动 revision，条数封顶后靠 at 兜住）。
   以后若把队友状态放进快照正文，记得把状态摘要也算进水位（状态变化不动 revision）。
4. **字数上限收紧一点。** 当前 `BOARD_SNAPSHOT_LIMITS.chars=2000`（约 800–1000 token），比原系统提示段
   （923 字）更大；既然是尾部每变化注一次，建议 ≤1500 字，并保留「先丢活动、再丢任务、最后硬截断」的
   确定性顺序（现有实现已如此）。
5. **队友侧只能「工具现查」是硬约束，要写进文档。** 队友 `MiniAgent` 拿不到投影链
   （`session-core/loop.ts:75-89` 的 `rewrite` 是可选的，subagent 构造时没传），所以队友系统提示必须保持
   逐字常量、数据一律现查。请确认 `team_task list` 与 `team_message inbox` 的返回字段覆盖你写的引导，
   并在 `docs/team-collab-plan.md`（写白名单内）与 README 里把这个约束记下来。
6. **别漏掉 `subagent` 段的其他输入。** `index.ts:2258-2293` 每轮读磁盘角色表（`listRoles`，按名排序）、
   读 config、拼 `modelRuleText()`：只在设置/角色文件/模型变化时变，属可接受的一次性失效。
   但验收必须断言**同配置、不同看板状态下整个 systemPrompt 逐字不变**（不只 team 段）。
7. **团队板文档同步。** `docs/team-collab-plan.md` §3.3 与 §7「已落地」的描述（「队友系统提示每轮现读
   队伍 + 板上任务 + 最近活动」）已经与修复后的行为相反，需要改成「稳定段只放规矩，易变数据走尾部快照/
   工具现查」。
8. **验收口径**：除单测外必须跑 §8.3/§8.4。单测只能证明「hash 不变」，不能证明端点真的给到 85%——
   这个端点是 opencode 网关，缓存行为与官方 DeepSeek 不一定相同，只认实测账本。

---

## 10. 没查到 / 不确定的部分（如实列出）

1. **opencode 网关的缓存实现查不到**：本会话模型是 `opencode/deepseek-v4.1-flash`（`config.yaml`：
   `baseURL: https://opencode.ai/zen/go/v1`），不是官方 DeepSeek API；网关的自动缓存在服务端，
   本机没有源码。因此「为什么同样改了系统提示，第 14 次请求还命中 5%（≈1.8K token 公共前缀）、
   其余几次却是 0%」**无法从 dsc 源码确认**，只能作为实测现象记录。修复动作不受影响（前缀稳定）。
2. **第 13 次请求 50% 的归因是推测**：头部系统提示未变、却只命中一半，最像历史中段被改写
   （microcompact 每轮推进清理点 / 压缩后历史变短）。会话 jsonl 的 `state.system-prompt` 只带
   `after`（写入时消息条数）锚点，无法与请求边界一一对应，所以我没有把这条写成确定结论。
3. **请求条数口径差 1**：lead 说「17 次真实请求」，我按 `sid + i` 过滤得到 **16 条请求行**
   （另有 29 条工具行，`k:'tool'` 无 token）。差异原因没查到（可能有一次无缓存明细或计入别的 sid），
   不改变结论。
4. **dsh 在 DeepSeek 路由上到底打不打显式断点**：`cacheControlFormat` 默认是 `'offer'`
   （`packages/llm/llm-pi-ai/src/catalog.ts:266`，即由具体模型 compat 声明），
   `pi-ai` 的 `deepseek.models.js` 里没搜到该字段，未逐模型全查；只能确认「dsh 的机制是
   system + last tool + last message 三处，且是否启用由模型 compat 决定」。
5. **ZCode 的 `src/core/llm.ts:764` 注释出处**：dsc `core/llm.ts:762-766` 注释引述的 ZCode 文件布局
   在当前 ZCode 仓库已不存在（实现迁到 `apps/zcode-cli/packages/*`）。ZCode 侧结论按新布局取证，
   没有去找旧版本文件。
