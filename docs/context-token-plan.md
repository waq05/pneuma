# 上下文与 token 优化技术书（0.6.68 批）

2026-10-15。对标 codex / dsh(deepseek-harness) / ZCode 三家 agent loop 的请求组装，补 dsc
（Pneuma）在 **省 token** 与 **能力** 两块上的缺口。本文是施工契约：六条并行线各自的
目标、落点、接口、验收探针与风险都写在下面，子智能体按线施工，主控审查验收后合流。

## 0. 背景：三家的共同形状（为什么这么改）

三家都把「一轮请求」拆成两层：

- **稳定前缀**（system / instructions / 工具目录）——字节不变，靠服务端前缀缓存兜住成本；
- **易变快照**（环境、时间、运行时策略）——进 user/developer 消息，且**变化才注入**或**落在尾部**。

逐项证据：

| 机制 | codex | dsh | ZCode | dsc 现状 |
| --- | --- | --- | --- | --- |
| system 投递 | `instructions` 字段 / developer 片段 | section 注册表，node 0 | **三条 system + 显式 ephemeral cache 标记** | 全并进头部一条 system |
| 环境 | `<environment_context>`(user)，diff | user 快照，10 分钟刷新 | system 里 `env_info`，会话级快照 | 尾部 user 快照，**每轮都发** |
| AGENTS.md | user，diff ~32KiB | user + reconcile，64KB | meta_user `# agentsMd`，100KB | `# agentsMd` 块，**每轮整段重发** |
| 工具目录 | 全量，插入序 | **变更才发 developer 通告** | 全量，每轮 | 全量，每轮 |
| 旧工具结果 | 无（靠 compaction） | 可选 pruner 包 | **microcompact：每轮清旧结果** | 只在压缩时 prune |
| 历史校验 | `for_prompt()` 规范化 | **运行时 invariant 强校验** | provider 投影规范化 | `sanitizeToolOrphans`（已接 notice） |
| 缓存断点 | `prompt_cache_key`+WS 增量 | `systemPromptUpdate:'in-history'` | **stable/dynamic 各一个 ephemeral + 尾部一个** | 无显式（靠网关自动） |
| 压缩后 | 纯模型摘要 | 纯模型摘要 | **回插 read-state 提醒** | 机械锚点+原话（领先），无 read-state |
| 子代理 | 独立 developer 片段 | child-agent 独立装配 | **独立 context builder（含 env/model）** | role.prompt 一段，**无 env/model** |

dsc 已经拿到最难的三块（前缀友好的尾部 env 快照、压缩的机械锚点、spill 输出侧落盘）。
本批补的六条线，全部是上表里「dsc 缺席」那一列。

## 1. 现状锚点（施工前必读的具体位置）

- 主循环请求组装：`src/core/loop.ts:374-469` `requestOnce`。组装式：
  `assembled = [{role:'system', content: deps.systemPrompt()}, ...deps.session.messages]`，
  再过 `deps.rewrite(assembled, session)`；再 `emit({type:'context', segments})` 后 `deps.stream(...)`。
- 投影链：`src/plugins/prompt.ts:52-192`。`registerProjection(id, fn, {order})`；内置三条
  `fold-system`(500) / `env-facts`(600) / `drop-images`(900)。保留名
  `RESERVED_PROJECTIONS = {fold-system, drop-images}`（`plugins/prompt.ts:39`）。
- 系统提示词装配：`src/core/prompt.ts:302-330` `buildSystemPrompt`；段顺序
  identity(0)/behavior(10)/tool-rules(20)/插件贡献/# agentsMd(200)/skills(210)/model(890)。
- 环境事实：`src/core/prompt.ts:258-276` `environmentText`（**30 秒 TTL 缓存**）；
  投影 `plugins/prompt.ts:95-104`；落盘去重 `noteEnvFacts`（`plugins/prompt.ts:200-204`）。
- 指令文件预算：`src/core/prompt.ts:49` `DEFAULT_INSTRUCTION_BUDGET = 20_000`（**字符**口径）。
- 协议发送：`src/core/llm.ts:405-470` `streamOnce`（`serializeMessages` 在 :588，
  headers 在 :445）；孤儿清洗与报告 `llm.ts:206`，已接线 `plugins/llm.ts:34` `noticeSanitize`。
- 工具结果裁剪（现有，只在压缩时跑）：`src/core/compact.ts:69-117` `pruneRegion`
  （`toolResultChars` 默认 2000、`imageBudget` 默认 4）。
- 图片卸载现有实现：`src/plugins/computer-use.ts:116-136` `dropStaleScreenshots`
  （投影名 `prune-stale-screenshots`，`computer-use.ts:491`）——**只镜像电脑控制自己的截图**。
- 压缩：`src/core/compact.ts:206-272` `compactSession`，结束于 `session.replaceWithSummary`；
  机械产物 `src/core/compact-anchors.ts`（`buildAnchorIndex`/`collectVerbatimUserMessages`/
  `buildRecoveryFooter`/`SUMMARY_BANNER`）。
- 子代理：`src/plugins/subagent.ts:400-410` `systemPrompt: () => input.role.prompt + "# 你在团队里的位置..."`；
  MiniAgent 的 deps **没有 `rewrite`**（所以 env-facts 对子代理不生效）。`startTeammate` 在 :340。
- 插件装配清单：`src/host/kernel.ts`。`BUILTIN_PLUGINS`(:246+)、`OFFICIAL_OBJECTS`(:220)、
  `createKernel`(:326+) 里的 `root.plugin(...)` 调用序列。API 版本常量 `KERNEL_API_VERSION = 6`
  （`src/core/plugin-registry.ts`）。

## 2. 施工纪律（六条线共同遵守）

1. **工作树隔离**：每条线在自己的 worktree 里改，路径 `D:\dsc\.worktrees\<线名>\`。
   分支名见各线。**不要动主工作树 `D:\dsc`**（有并发会话在提交）。不要碰别人的 worktree
   （`.worktrees/m4`、`w-notice`、`w-page` 是既有线）。
2. **CRLF**：本仓工作区是 CRLF。用 Edit 做小范围替换，**别整文件重写**（`Write` 覆盖会把
   整篇变 LF，diff 假涨几百行）。收尾自查 `git diff -w --stat`，应只显示真实改动。
3. **构建与探针**：先 `pnpm run build`（tsc → `lib/`），再 `node scripts/<你的探针>.mjs`。
   探针全跑在临时 HOME 上，真实 `~/.dsc` 一个字节都不动（照 `scripts/commands-battery.mjs` 的头）。
4. **探针必须有负向验证**：每条断言至少抽一条，把被测行为改坏后探针应变红（证明不空转）。
   把你抽的那条写在交付说明里。
5. **别改冻结的旧渲染层**（`desktop/src/renderer`、旧 `src/app/*` 的渲染）——本批全是宿主/内核侧。
6. **注释与文案**：中文，风格照周边（说明「为什么」不讲「做了什么」）。用户可见文案照
   `docs/` 既有口径（2–4 字动词、无标点）。

## 3. 六条线

---

### WS1 每轮旧工具结果微压缩（`feat/ctx-diet-tool-results`）

**为什么**：ZCode 每轮开头把旧的、可压缩的工具结果换成占位符（`compact/microcompact.ts`：
保留最近 5 条、单次最小省 256 token）。dsc 只有全量摘要一层，平时旧工具结果原样挂在历史里
每轮重发——长会话最大的一块浪费。

**目标**：新增一条内置投影，在每次请求组装时把**较旧的**工具结果正文换成占位符，
只影响请求体、不改会话日志（日志原文不动；模型可见 ⟺ 已记录靠投影可复算保证）。

**落点**：
- 新文件 `src/plugins/microcompact.ts`：一个内置插件，`provide` 无（纯投影贡献者），
  `inject: ['prompt', 'settings', 'session']`，`apply` 里 `ctx.prompt.registerProjection('microcompact', fn, { order: 650 })`
  （order 取 650：在 `env-facts`(600) 之后、`drop-images`(900) 之前）。
- `src/host/kernel.ts`：在 `createKernel` 里 `await root.plugin(microcompactPlugin, getPluginConfig('microcompact'))`，
  并在 `BUILTIN_PLUGINS` 加一条元数据（`file: 'microcompact'`，带 `settingsSection: 'microcompact'`）。
- 纯函数本体建议放 `src/core/` 下（例：`src/core/microcompact.ts`），零依赖、可被探针用
  Node 类型擦除直读（照 `ui-transcript-render-test.mjs` 的读法）。

**契约**：
- 输入 `ChatMessage[]`（已 fold-system 之后的形状），输出新数组（**不得就地改输入**）。
- 只处理 `role === 'tool'` 且 `content` 是 **string** 的条目；跳过：
  - 最近 `keepRecent` 条工具结果以内（默认 5，可配）；
  - `error !== undefined` 的（失败结果往往就是证据，别丢）；
  - content 里含 `image_url` 的（图走 WS2）；
  - 已经被 spill 落过盘的（含 `[完整输出已落盘：` 或已是占位符）——避免二次处理；
  - 估算省下的 token < `minSaveTokens`（默认 256，可配）的。
- 占位文案：`` `[旧工具结果已清理：${toolName}]` ``（用 `tool_call_id` 反查 assistant 里那次调用的 `name`；
  查不到就只写「旧工具结果已清理」）。**保留被清理条数到最后**做一条统计？——不必，占位符里带工具名即可。
- 配置（走 `ctx.settings.registerSection('microcompact', ...)`，照 compact 插件的 fields 形状）：
  `keepRecent`(默认 5，范围 1..50)、`minSaveTokens`(默认 256，范围 0..4000)、`enabled`(默认 **true**)。
- 这条投影**必须幂等**：跑两遍结果一样（第二遍时旧结果已是占位符，长度小于 minSaveTokens → 跳过）。

**验收探针** `scripts/microcompact-test.mjs`（≥ 15 条）：
- 保留最近 N 条：构造 20 条工具结果，断言最后 5 条原文在、前 15 条变占位；
- 最小节省门槛：一条很短的旧结果**不**被清（省不到 256 token）；
- 跳过错误结果 / 含图结果 / 已 spill 结果；
- 幂等：连跑两次输出逐字节相等；
- 不改输入数组（原数组内容与长度不变）；
- 工具名回填正确（占位符里带上真实工具名）；
- 接线：投影链里 `microcompact` 在 `env-facts` 之后、`drop-images` 之前（可读 `projectionChain` 顺序或用一条真请求的组装结果断言）；
- 端到端：起真内核 + 假 SSE，跑一段带多次工具调用的回合，断言第二轮的请求体里旧结果已清理
  （参照 `scripts/teammate-notice-test.mjs` 的假 SSE 手法）。
- 负向验证：把 `keepRecent` 写死成 0（或去掉最小门槛）→ 至少一条断言变红。

**风险**：不要把工具结果清得太狠（模型回头要用证据）。默认 5 条 + 256 token 门槛是保守值；
配置可调。**注意**：`serializeMessages` 之前会先跑 `sanitizeToolOrphans`（`llm.ts:408`），
微压缩在投影链（更早）跑——顺序是「投影 → sanitize → serialize」，符合预期。

---

### WS2 每轮图片按龄卸载（`feat/ctx-diet-images`）

**为什么**：dsc 现在只有两处图片处理——全局 `drop-images`（模型不收图时全剥）和
`prune-stale-screenshots`（只镜像电脑控制自己的截图，且只保留最新一张）。
用户贴的图、工具结果里的图、以及电脑控制的历史截图，在长会话里**每轮重发**。

**目标**：一条通用的「图片按龄/按预算卸载」投影，覆盖所有来源；与 `drop-images`（能力门，最后跑）
职责分开——本投影管「留着但太久/太多」，`drop-images` 管「模型根本不收图」。

**落点**：
- 纯函数建议放 `src/core/`（例：`src/core/image-diet.ts`），或扩展 `src/core/compact.ts` 的
  `pruneRegion` 里的图片段（**复用现有语义**：用户图按预算保留、其余卸载为占位文本
  `（图片已卸载，原文里这里是一张图）`）。
- 注册成内置投影：与 WS3 共用 `src/plugins/prompt.ts`。**只做最小插入**（在 `drop-images` 之前加一条
  `image-diet`，order 取 700），别重排文件——这条线跟 WS3 共用该文件，合流由主控做。
- 电脑控制的 `prune-stale-screenshots` 保留（它更懂「截图被新截图取代」），但本投影兜住通用情形。
  若两者语义重叠，**以本投影的通用规则为准**，把 `computer-use.ts` 的那条降级为不注册（同文件小改）。

**契约（纯函数 `pruneImages(messages, opts)`）**：
- 遍历所有 `content` 是数组的消息；对 `image_url` 部件：
  - 最近的用户消息里的图：按 `userImageBudget`（默认 4）保留，超出的卸载；
  - 工具结果里的图：按 `toolImageBudget`（默认 2，只保最近的）保留，超出的卸载；
  - 更早的历史图：超过 `keepRounds`（默认 2 个用户回合）的，全部卸载。
- 卸载 = 换成 `{ type: 'text', text: '（图片已卸载，原文里这里是一张图）' }`；**不删消息**（保证
  role 序列不变、不产生孤儿）。
- 幂等；不改输入。
- 配置：`ctx.settings.registerSection('image-diet', ...)`——`userImageBudget`(0..20)、
  `toolImageBudget`(0..20)、`keepRounds`(0..50)、`enabled`(默认 true)。
  **模型不收图时这条不必要**（drop-images 全剥），但留着无害。

**验收探针** `scripts/image-diet-test.mjs`（≥ 12 条）：
- 用户图超预算被卸载、未超预算保留；
- 工具结果图按最近 N 张保留；
- 更早回合的图全卸载；
- **消息条数与 role 序列不变**（无孤儿）；
- 幂等；不改输入；
- 文本部件顺序保持（卸载只替换 image_url 部件那片，不重排）；
- 与 `drop-images` 并存：模型不收图时最终无图（端到端一条）。
- 负向验证：把 `userImageBudget` 设成 999 → 「卸载」类断言变红。

**风险**：别把「当前正在看的那张截图」卸载掉（`keepRounds`/`toolImageBudget` 要能保住最新那张）。
电脑控制正在跑时，最新截图必须留——探针要有一条钉住这个。

---

### WS3 上下文新鲜度与缓存（`feat/ctx-cache-and-budget`）

**为什么**：三处小缺口——
(a) env 快照**每轮都发**（30 秒 TTL），dsh 是「10 分钟刷新下限、没变不重注」；
(b) dsc **没有任何显式 cache 断点**，对 DeepSeek 自动缓存够用，换 Anthropic 系就退化
（ZCode 给 stable/dynamic 各打一个 ephemeral + 对话末尾一个）；
(c) 指令预算是**字符**口径（`DEFAULT_INSTRUCTION_BUDGET = 20_000`），三家都是字节，用户对不上。

**目标**：(a) env 快照「变了才发」；(b) 按 provider 能力注入显式 cache 标记；(c) 预算口径成字节
（或至少在文档与注释里显式标注「字符」并给出与三家的换算）。

**落点**：
- (a) `src/plugins/prompt.ts:95-104`：env-facts 投影改为——维护「上次发过的快照文本」，
  与本次 `environmentSnapshot(cwd)` 相同则**不追加**这条 user 消息（或改追加一条极短的
  `（环境无变化）`？不——**不追加**，与 dsh 一致）。注意：**不能破坏**「每轮请求里模型手里
  有当前环境」——首次与变化时必须发。刷新下限照 dsh：引入 `refreshIntervalMs`（默认 600000），
  没到间隔且文本没变就不发。
- 该文件与 WS2 共用，**只改 env-facts 这一段**，别碰别处。
- (b) `src/core/llm.ts`：`streamOnce`（:405-470）与 `serializeMessages`（:588）附近。
  按 provider/路由能力决定是否打 `cache_control`。**当前只有 DeepSeek 系一个路由**，
  所以这条默认**不改变 DeepSeek 请求体一个字节**（避免破坏现有自动缓存）。
  做法：新增一个能力探测（照 `src/core/model-caps.ts` 的形状）——只有端点声明支持显式
  cache 标记时才注入。给 `LlmRoute`/适配器加可选能力位，默认 false。
  **关键纪律：DeepSeek 请求体必须逐字节不变**（用探针钉死）。
- (c) `src/core/prompt.ts:49`：把 `DEFAULT_INSTRUCTION_BUDGET` 的注释与文档口径讲清（字符 vs 字节），
  或直接改成字节（`20_000` 字符 ≈ 中文 60KB 字节，改成字节口径要**同步调默认值**别把预算砍一半）。
  **建议**：保留字符口径（代码零风险），只在注释/`docs/` 里写明与其他三家的换算，并在设置分区
  help 文案里写「以字符计」。若改字节，必须重算默认值 + 探针覆盖。

**验收探针** `scripts/env-cache-test.mjs`（≥ 12 条）：
- 环境无变化时第二轮请求**不含**第二条 env 快照（历史里只有一条）；
- 环境变化（改 cwd/分支/DSC 假时钟）时追加新快照；
- 刷新下限未到且文本未变 → 不发；
- 首次必发；落盘状态条目（`noteEnvFacts`）行为不变；
- **DeepSeek 请求体零漂移**：一条请求体的 `JSON.stringify` 与改造前逐字节相等
  （在探针里钉住 `serializeMessages` 的输出，含/不含新能力位两种情形）；
- 预算口径：断言默认值与该口径自洽。
- 负向验证：把「变了才发」改回「每轮都发」→ 第一条断言变红。

**风险**：(b) 最容易把 DeepSeek 打坏——**默认路径必须零改动**，能力位默认 false。
(a) 别让模型在长回合里拿着过期环境发呆——刷新下限 + 变化即发两手都要有。

---

### WS4 运行时请求 invariant（`feat/request-invariant`）

**为什么**：dsh 在 `llm/stream` waterfall 断言「请求 messages == `session.deriveMessages()` 逐字节相等」，
不符即 fail——能在**调用点**抓住「模型看到的 ≠ 日志可重建」的一整类 bug。
dsc 目前只有 `sanitizeToolOrphans`（孤儿那半边，且已接 notice）。**系统提示词 + 投影链**这半边没有校验。

**目标**：新增一个**纯、便宜、不抛**的校验：每次组装完请求体后，重新派生一遍，
逐条比对，不等则经 `dsc/notice` 报出「第几条开始不一致 + 差异摘要」，并 `console.warn` 一次。

**落点**：
- 新文件 `src/core/request-invariant.ts`：纯函数
  `checkReconstructable(sent: ChatMessage[], derived: ChatMessage[]): InvariantReport`，
  返回 `{ ok, firstDiffIndex?, reason?, digest? }`；`derived` 由调用方按同一路径重新算出。
- `src/core/loop.ts:383-391`：组装出 `messages` 后、`deps.stream` 前，调一次校验；
  不一致 → `deps.emit({ type: 'error' | 'notice', ... })`（**不阻断请求**——照 dsh 是 fail，
  但 dsc 选择「报出但不杀会话」，因为报出后人类还能救；把这个取舍写进注释）。
- 派生路径要**复用同一个纯函数**：把「`[system, ...session.messages]` → 投影链」抽成一个
  可复算的函数（`plugins/prompt.ts` 的 `rewrite` 已经是纯的，但它吃 session 做 env 归属）。
  校验用「再跑一次 `rewrite`（同一 session、同一 system）」比对。
  **注意 env-facts 的副作用**（`noteEnvFacts` 会 appendState）——校验时用只读模式或让它幂等
  （hash 相同不重写，已经幂等）。TTL 缓存让两次调用拿到同一份 env 文本，不会 flake。

**契约**：
- 绝不抛异常、绝不 mutate 输入、绝不发模型请求。
- 报告要有可行动的定位（firstDiffIndex + 该条的 role + 长度差）。
- 同一会话同一形状只报一次（照 `plugins/llm.ts` 的 `sanitizeNotices` 去重 map 手法）。

**验收探针** `scripts/request-invariant-test.mjs`（≥ 12 条）：
- 健康日志 → `ok:true`，无 notice；
- 在组装与发送之间往 `session.messages` 插一条 → `firstDiffIndex` 指向它、报 notice；
- 一个**非纯投影**（返回带随机数/时间戳的数组）→ 被抓住（这是「日志可重建」的核心价值）；
- 一个**就地 mutate 输入**的坏投影 → 被抓住；
- 去重：同一形状连跑两轮只报一次；
- 不阻断：校验失败时请求仍照发（断言 stream 被调用）；
- 端到端：真内核 + 假 SSE 跑一回合不产生误报（0 false positive）。
- 负向验证：把校验函数改成恒返回 `ok:true` → 至少两条断言变红。

**风险**：误报会刷屏且吓人。**先保证零误报**（真常路径探针必须干净）。若某投影天然易变
（env/timestamp），在设计里显式标注「易变段」并对它们放宽比对（比对结构而非字节）。

---

### WS5 压缩后 read-state 回插（`feat/compact-readstate`）

**为什么**：ZCode 压缩后回插「你刚读过这些文件（最多 5 个、每文件约 5K、总约 50K token）」，
让接手模型不必重读（`compact-post-reminders.ts:8-51`）。dsc 的 anchors 抽的是**路径索引**
（机械正则），不是「这些文件你刚读到哪」的可读状态。

**目标**：压缩时额外从被折区间里机械抽出「最近被 read 过的文件路径 + 最后一次读取的行范围」，
作为一条紧凑的 read-state 段并进摘要（落在 `kept[0]` 的摘要正文里，或紧随其后的一条 user 条目）。

**落点**：
- `src/core/compact-anchors.ts`：加 `buildReadState(messages, budgetChars): string`——
  扫被折区间里的 tool 调用（`read` 的 args 含 path/offset/limit），按最后出现去重，
  保留最多 `readStateFiles`(默认 5) 个、每文件最多一行、总预算 `readStateChars`(默认 1500)。
- `src/core/compact.ts:264-268`：把 `buildReadState(raw, ...)` 的产物拼进 `summary`
  （与 anchors / quotes 并列）。注意顺序：摘要正文 → carry → quotes → anchors → readState → recovery。
- `src/plugins/compact.ts`：把 `readStateFiles`/`readStateChars` 加成可调值（照 anchorBudgetChars 的形状）。

**验收探针** `scripts/compact-readstate-test.mjs`（≥ 12 条）：
- 被折区间里有 `read` 调用 → 产出含文件路径与行范围；
- 同一文件多次读 → 只留最后一条；
- 超过 `readStateFiles` → 只留最近 N 个；
- 超预算 → 截断并带省略标记；
- 没读过任何文件 → 空串（不产生空段）；
- 摘要拼接顺序正确（readState 在 recovery 之前）；
- 端到端：真内核压缩一段带 read 的历史，断言压缩后 `kept[0]` 含 read-state，且**不含**被折原文；
- 幂等（同输入同输出）。
- 负向验证：把 `readStateFiles` 写死 0 → 那条断言变红。

**风险**：read-state 是**提示**不是真相（文件可能已被改）。文案要带「（可能已过时，需要时重读）」。

---

### WS6 子代理上下文 + todo 节流提醒（`feat/subagent-context-and-reminders`）

**为什么**（两件）：
(a) 子代理的 system prompt 只有 `role.prompt + 团队位置`（`subagent.ts:400-410`），
**没有 cwd/平台/日期/模型**——子代理会瞎猜路径。ZCode 有独立 context builder 带 env/model。
(b) dsc 把「做事方式」静态写进 system prompt；ZCode 选**节流注入**（todo 每 10 turn 一条），
长会话里模型更不容易忘。这条 dsc 缺失，但**默认关**（能力 vs token 的取舍，用户可自己开）。

**目标**：
(a) 子代理的 system prompt 补一段环境/模型事实（cwd、平台、日期、模型名）。
(b) 新增一条**节流提醒投影**：每 N 个用户回合注入一条 todo 提醒（默认 **enabled:false**）。

**落点**：
- (a) `src/plugins/subagent.ts:400-410`：`systemPrompt` 文案里追加一段
  （照 `src/core/prompt.ts:258` `environmentText` 的形状，但**给子代理用要按它自己的 cwd**——
  `input.parentSession.meta.cwd`；模型名取 `teammate.badge.model ?? ctx.llm.model`）。
  也可以做成一个共享的纯函数 `subagentEnvironmentText(cwd, model)` 便于探针。
- (b) `src/plugins/todo.ts`：注册一条投影 `ctx.prompt.registerProjection('todo-reminder', fn, { order: 800 })`。
  逻辑纯函数：数历史里距最近一次 `todo_write` 调用过了几个用户回合；超过 `everyTurns`(默认 10) 且
  当前有未完成 todo，则追加一条 user 提醒（`（提醒：任务清单有未完成项，做完一步就把状态改掉）`）。
  配置走 todo 现有设置分区或新开 `todo-reminder` 分区：`enabled`(默认 **false**)、`everyTurns`(默认 10)。
- **注意**：todo 插件 `inject` 目前是 `['session','tools','commands','surfaces','compact']`，
  要加 `'prompt'`。

**验收探针** `scripts/subagent-context-test.mjs` + `scripts/todo-reminder-test.mjs`（合计 ≥ 18 条）：
- (a) 子代理 system prompt 含 cwd/平台/日期/模型；用 parent 的 cwd（不是进程 cwd）；模型名回填正确；
  负向：把 env 段去掉 → 断言变红。
- (b) 默认**不注入**（enabled:false）；开启后每 N 回合注入一条；未到 N 不注入；
  有未完成 todo 才注入；无 todo 不注入；幂等（同一历史连跑同结果）；注入的是 user 角色且不改日志。
  负向：把 `everyTurns` 设成 1 → 「未到 N 不注入」那条变红。
- 端到端各一条（真内核 + 假 SSE）。

**风险**：(b) 默认关是硬要求——不能给所有人加 token。(a) 别把主会话的 env 快照混进子代理
（子代理有自己的 cwd 与模型，`requestSession` 归属别搞错）。

---

## 4. 合流与总验收（主控做）

1. 每条线自测：`pnpm run build` 绿 + 自己的探针全绿 + 负向验证记录。
2. 主控逐线审：`git diff -w` 读改动、抽查一条断言做**第三方负向验证**（自己动手改坏再跑）。
3. 合流：按依赖顺序 rebase 到 main，端口式解冲突（重点 `plugins/prompt.ts`：WS2+WS3）。
4. 合流后跑**全量无头电池**（所有 `scripts/*-test.mjs`）+ `desktop` 侧 typecheck。
5. 主控补一条**跨线整合探针**：一次真请求里，微压缩 + 图片卸载 + env 变化才发 + invariant
   四者同时生效且互不打架（顺序、幂等、无孤儿）。
6. 提交：每线一个 commit（约定式），或整合成一个 feat 提交——按最终改动量定。

## 5. 验收清单（Definition of Done）

- [ ] WS1 微压缩：投影接线、配置可调、探针 ≥15 绿、幂等、负向验证
- [ ] WS2 图片按龄卸载：通用覆盖、role 序列不变、探针 ≥12 绿、负向验证
- [ ] WS3 env 变化才发 + cache 能力位（**DeepSeek 零漂移**）+ 预算口径，探针 ≥12 绿
- [ ] WS4 invariant：零误报、抓住非纯/篡改、探针 ≥12 绿、不阻断
- [ ] WS5 压缩 read-state：探针 ≥12 绿、幂等
- [ ] WS6 子代理 env/model + todo 节流提醒（默认关），探针 ≥18 绿
- [ ] 全量电池绿；`pnpm typecheck` 绿
- [ ] 每条线的负向验证记录（主控抽查一条）

---

## 6. 交付记录（2026-10-15 实做）

六条线各一个 worktree + 子智能体并行施工，主控逐线审查、独立做第三方负向验证，再合流。

| 线 | 分支 | 新增/改动 | 探针 | 结果 |
| --- | --- | --- | --- | --- |
| WS1 | `feat/ctx-diet-tool-results` | `core/microcompact.ts`、`plugins/microcompact.ts`、kernel 挂载 | `microcompact-test.mjs` | 32 条绿 |
| WS2 | `feat/ctx-diet-images` | `core/image-diet.ts`、`plugins/image-diet.ts`、prompt 投影、computer-use 降级 | `image-diet-test.mjs` | 42 条绿 |
| WS3 | `feat/ctx-cache-and-budget` | `core/llm.ts`（`applyExplicitCache`）、`plugins/prompt.ts`（env 闸门）、`core/config.ts`/`migrate.ts`/`plugins/llm.ts`（端点能力位）、`core/prompt.ts`（口径注释） | `env-cache-test.mjs` | 31 条绿（含 DeepSeek 零漂移） |
| WS4 | `feat/request-invariant` | `core/request-invariant.ts`、`core/loop.ts`、`plugins/agent.ts` | `request-invariant-test.mjs` | 37 条绿 |
| WS5 | `feat/compact-readstate` | `core/compact-anchors.ts`（`buildReadState`）、`core/compact.ts`、`plugins/compact.ts` | `compact-readstate-test.mjs` | 31 条绿 |
| WS6 | `feat/subagent-context-and-reminders` | `core/prompt.ts`（`subagentEnvironmentText`）、`plugins/subagent.ts`、`core/todo-reminder.ts`、`plugins/todo.ts` | `subagent-context-test.mjs` + `todo-reminder-test.mjs` | 46 条绿 |
| 整合 | — | — | `context-pipeline-test.mjs` | 17 条绿（四层同链） |

主控对每条线都做了**独立**负向验证（不看子智能体自述，自己改坏产物/源码跑一遍）：WS1 改 `minSaveTokens` 门槛 → 1 红；WS2 改缺省 `userImageBudget` → 8 红；WS3 把 env 闸门改恒真 → 3 红；WS4 让 `isRuntimeInjection` 恒真 → 8 红；WS5 改标题文案 → 1 红；WS6 剥掉子代理环境段 → 6 红。改回后全部归零。

### 合流时改的三处

1. **image-diet 投影 order 700 → 550**（挪到 env-facts 600 之前）。原因：env-facts 会往请求末尾追加一条 user 环境快照，image-diet 按「最近几个用户回合」决定留哪些图——若跑在它之后，那条合成快照会白占一格，`keepRounds` 的口径凭空保守一格。改后 `context-pipeline-test` 的「第三轮的图仍在」成为判别断言（改回 700 恰好 1 条变红）。
2. **`prompt.envRefreshMs` 缺省从 600000 改成 0（每轮都发）**。原因比「省几十 token」硬：dsc 的 env 快照是「平台：Windows（bash 跑的是 PowerShell）」这条事实的**唯一载体**（`core/prompt.ts` 的三个内置段里都没有，dsh 也没有平台注入）；跳过一轮 = 那一轮模型可能写 bash-ism。开关保留，>0 时退回「变了才发 + 到点重注」。
3. **`plugins/microcompact.ts` 的注释改准**：原稿写「取错会话顶多漏保护一条，不会误清」，实际是「会误清」（漏保护就等于那条失败结果可能被当普通旧结果清掉）。如实标注为已知限制。

### 关键发现（留给以后）

- **「变了才发」在 dsh 与 dsc 不是同一件事**。dsh 的快照是 **durable 的 user 消息**（落历史），跳过重发时旧快照还在历史里、模型照样看得见；dsc 的快照是**投影注入、不落历史**，跳过 = 那一轮请求里根本没有环境。要做 dsh 那种语义，得把快照落成 durable 消息——那会改会话日志形状（transcript 渲染、压缩、`resident-agents-test` 里「线上最后一条 user 是 env 快照」的假设），且 UI 上会多出一个用户气泡，所以本次不做。
- **投影链里有状态投影**（`user-prompt-submit`、`lsp-write-diagnostics`）：它们第一次跑会消费 `pending` 并 `appendNote`。WS4 的 invariant 要二次派生，因此必须按标记摘掉「运行时注入段」再逐字节比。实测这两个投影第二次跑都提前返回（`pending` 已空），不会重复落 note——所以二次派生是安全的。
- **`worktree` 里 `legacy-frozen-check` 会假红**（3 条 CSS 哈希）。原因是 `git worktree add` 检出的行尾归一化与主树不同，不是任何改动引入的——用一个**完全无改动的临时工作树**复现即可确认。这个检查只在主树里当门用。

### 已知限制 / 后续

- **投影函数拿不到所属会话**：`registerProjection(id, fn)` 的 `fn` 只收 `messages`，会话要靠模块级 `requestSession`（env-facts 用）或 `ctx.session.current()`（microcompact / hooks / lsp 用）。常驻多 agent 下后台会话在跑、用户看着另一个会话时会取错。根治要把签名扩成 `fn(messages, session)`——属内核 API 变更，本批没做（microcompact 受影响的只是「失败结果那条证据可能被清」）。
- **cacheControl 断点没对过真端点**：手头只有 DeepSeek 路由（它靠网关自动缓存，不能打点）。断点形状按 Anthropic/ZCode 惯例实现并用探针钉住，接 Anthropic 系端点时要实测。
- **`cacheControl` 是端点级 config.yaml 字段**：设置页编辑端点时 `upsertProvider` 按 `ProviderDraft` 重建条目会丢掉它（既有行为，非本批引入）。
- **未跑实机走查**：本批全是宿主/内核侧、纯请求组装，无 UI 变化；实机走查（真端点、真长会话）未做。
