# 缓存优化策略对照：numa（dev@28d651a1）vs dsh

> 目标：逐条对照 numa 与 dsh（`D:\deepseek-harness\deepseek-harness`）的前缀缓存策略，
> 给出可落地改进清单。只读调研，不改产品代码。
> numa 基准：`docs/cache-vs-dsh` 分支 `dev@28d651a1`（已含团队板动态内容移出系统提示的修复）。
> dsh 基准：本机 checkout；`pi-ai` 是 dsh 的依赖（`node_modules/.pnpm/@earendil-works+pi-ai@0.85.…`），
> 与缓存断点相关的实现在它里面，标注为 `pi-ai/…`。
> 历史实测：会话 `c2838565`（16 次请求，49.72%），详见 [cache-hit-teams.md](cache-hit-teams.md)。

---

## 0. 结论摘要

**dsh 最值得抄的三招**：① 变化后的系统提示不重写头部——官方 DeepSeek 路由 `systemPromptUpdate:'in-history'`，非空变更追加在已缓存历史后（`llm-deepseek/src/models.ts:8-23`、`serialize.ts:64,106-116`；`agent-loop/README.md:122,166`）；② 动态状态只走「历史末尾 user 快照 + 未变不发 + 压缩遮蔽重注」（`agent-loop/src/runtime-context.ts:124-181`、`README.md:172-180`），工作目录/沙箱/审批/子代理身份/源码路径/Web 地址都挡在系统提示外（`system-prompt/src/index.ts:178-186`）；③ 压缩/裁剪事件驱动、批量、复用主前缀（`compaction-basic/README.md:116,190-192,243-245`、`summarizer.ts:25-30,109-120`、`compaction-tool-result-pruner/src/index.ts:124-182`）。

**numa 现在最该补的三件事（P0/P1/P2）**

- **P0｜系统提示剩余易变段清零**：`schedule` 绝对时刻(41)、`self-improve` 待审计数(43)、`memory` 快照(60) 任一变化都会让该段之后的整段前缀+全部历史重读；改后单次省约 20–30K token。工作量中、风险低（复用已有尾部注入套路）。
- **P1｜microcompact 的 `refresh:'round'` 改事件/预算驱动**：每轮重算会推进清理点（numa 实测命中 60% 上下，`microcompact/microcompact.ts:99-107`），改成攒够 minFreePercent 才推进，预期命中 60%→75–85%。工作量中、风险中（旧结果多留几轮）。
- **P2｜prune/image-diet 批量化 + 缓存归因探针**：把「逐条越线/逐张卸图各断一次」并为一次（一个中等会话可少 5–15 次断）；探针记录首个差异消息，终结「为什么这次没命中」的黑盒。工作量小-中、风险低。

---

## 1. 对照总表（8 个主题）

判定：✅ 已一致　🟡 有差距（可改）　🔴 有差距（受协议/产品限制，暂不改）

| # | 主题 | dsh 做法（file:line） | numa 现状（file:line） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 显式缓存断点 | 3 处：首个 system + 最后一个工具定义 + 最后一条对话消息；仅 `compat.cacheControlFormat==='anthropic'` 且 retention≠none 时打；每轮重建、不残留旧断点（`pi-ai/dist/api/openai-completions.js:580-624,806-878`；`llm-pi-ai/src/catalog.ts:143,266`） | 2 处：首个 system + 最后一条消息；仅 `route.cacheControl===true` 时打（`src/core/llm.ts:759-806,570-586`；`src/core/config.ts:46-49,403`；`src/packages/llm/index.ts:132`；`loop.ts:498`） | ✅ 基本一致（少一个工具断点，收益小） |
| 2 | 系统提示分层 | 静态 section 注册表 + 独立 runtime-context；CONTEXT_ORDERS 只放动态事实；`HARNESS_SOURCE/WEB_SURFACE` 注释明写不进缓存提示（`core/system-prompt/src/index.ts:178-186,254-262,297-302`） | 内核 3 段固定 + 插件段按 order 排序 + `instructions(200)/skills(210)`；动态事实已有 envFacts 尾部通道（`prompt/index.ts:66-88,173-239`；`session-core/prompt.ts:1-18,420-459`） | 🟡 有差距：边界靠自觉，易变段仍可进头部 |
| 3 | 动态状态注入 | 历史末尾 user `<system-reminder>`；内容判等未变不发；压缩遮蔽后重注（`agent-loop/src/runtime-context.ts:124-181`；`README.md:172-180`）；时间用 durable user 消息、默认 10 分钟节流（`context/time-context/src/index.ts:55-56,199-241`） | env-facts 每轮尾部 user 快照（`prompt/index.ts:173-239,237`）；team-board 尾部投影 + 水位（`subagent/index.ts:2264-2312`、`board-snapshot.ts:151-233`）；todo/LSP/hooks/重复提醒均尾部注入（`todo/index.ts:292-336`；`lsp/index.ts:209-221`；`hooks/index.ts:545-555`；`agent/index.ts:230-258`） | ✅ 已一致（机制同形） |
| 4 | 工具定义/序列化确定性 | 工具按名字字典序（可用 `toolOrder` 显式指定）；工具变更走 `toolUpdate` 能力追加；wire 只带角色/内容块、时间戳常量 0（`core/system-prompt/src/index.ts:233-247,259-262`；`llm-pi-ai/src/models.ts:75-91`；`pi-ai/src/context.ts:46,198,236,407`） | 工具按注册序（Map 插入序）序列化，无排序（`src/packages/tools/index.ts:42,57-78`；`loop.ts:500-510`）；消息裁掉 `ts/files/origin`（`core/llm.ts:738-757`） | 🟡 有差距（排序）；toolUpdate 受协议限制 🔴 |
| 5 | microcompact/真压缩 | 阈值 0.8、保留 16%、headroom 65536、补压 1 次（`compaction-basic/src/config.ts:20,23,75-79,105-108`）；prune 压力触发、批量 durable；摘要请求复用主前缀；替换后从首个被替换 token 断（`compaction-basic/README.md:116,190-192,243-245`） | microcompact 投影每轮刷新（`microcompact/index.ts:76,112-163`）+ ROI 门槛 25%（`:74,130-140`）；tool-result-prune 逐条滑窗（`prompt/tool-result-prune.ts:34-41`；`prompt/index.ts:240-250`）；真压缩 `replaceWithSummary`（`session-core/compact.ts:373-375`）+ 摘要请求复用主前缀（`compact/index.ts:199-212`；`session-core/compact.ts:305-348`） | 🟡 有差距（刷新节奏/批量）；真压缩 warm-prefix ✅ |
| 6 | 注入去重/节流/落位 | 末尾追加保前缀；未变不发；时间 10 分钟下限；压缩丢快照后重注（`README.md:172-180,180`；`runtime-context.ts:164-180`） | 各注入方各有台账：env-facts 按会话记上次正文、todo/重复提醒/LSP/hooks 有 `InjectionNoteLedger`/`InjectionReportLedger`、team-board 三键水位（`prompt/index.ts:163-239`；`core/context-injection-report.ts:65,113`；`board-snapshot.ts:201-233`） | ✅ 已一致（numa 甚至更细） |
| 7 | 缓存指标/诊断 | token-meter 投影把 `cacheRead/cacheWrite` 与未缓存输入分开（`llm/token-meter/src/usage-projection.ts:14-26,77-79`）；命中率 `read/(input+read+write)`（`experimental/client-ui-stats/src/client/stats-usage.ts:26-69`）；每轮/每条消息 UI（`client/ui-chat/.../StatsPills.tsx:297-340`、`TurnUsagePanel.tsx:34-86`）；**无「为什么没命中」归因** | `usage.jsonl` 每请求 `i/o/ch/cm`（`core/usage-log.ts:29-59,332-399`）；状态栏只给会话累计（`ui-statusbar/ui/ui.tsx:262-291`）；transcript 每轮只有 input/output（`contract/transcript.ts:137-142,185`）；**无归因** | 🟡 有差距（粒度/展示）；两边都缺归因 |
| 8 | 其他 cache-friendly | 图片按 provider 拒绝才 durable 卸载（`compaction-image-offload/README.md:12,88`）；工具配对安全切点（`compaction/README.md:91`）；fs 观察策略纯事件、不写提示（`fs/fs-observation-policy/src/index.ts:1-8`）；reasoning 前缀绑定/降级（`llm-pi-ai/src/prefix-binding.ts:60-110`、`replay.ts:247-277`） | image-diet 每轮按龄卸载（`prompt/index.ts:251-268`；`core/image-diet.ts:36-52`）；孤儿清洗在 wire 前删历史（`core/llm.ts:221-242,566-570`）；env-facts 含 git 分支/脏文件（`session-core/prompt.ts:311-351`）；reasoning_content 回传（`llm.ts:737-757`） | 🟡 图片范式不同；其余各有取舍 |

---

## 2. 逐条对照

### 2.1 显式缓存断点（打几处 / 何时启用 / 怎么移动）

**dsh**

- 打 **3 处**：`addCacheControlToSystemPrompt`（首个 system/developer 消息）+
  `addCacheControlToLastTool`（最后一个工具定义）+ `addCacheControlToLastConversationMessage`
  （最后一条 user/assistant/tool 消息里最后一个 text 块）——`pi-ai/dist/api/openai-completions.js:813-878`。
- **启用条件**：`getCompatCacheControl()` 只在 `compat.cacheControlFormat === 'anthropic'`
  且 `cacheRetention !== 'none'` 时返回断点；长保留可加 `ttl:'1h'`
  （`pi-ai/…/openai-completions.js:806-812`）。dsh 把 `cacheControlFormat` 作为
  「可按模型声明」的能力项（`llm-pi-ai/src/catalog.ts:143,266`；配置 schema `config.ts:306`）。
- **断点怎么移动**：dsh 的 durable 消息里**不存** `cache_control`（grep dsh packages 源码，
  只有 compat/config 与文档出现这个词）。每轮 `buildParams()` 用当前上下文重新转换消息、
  重新打点（`pi-ai/…/openai-completions.js:580-624`），所以「旧断点残留」这个问题不存在，
  也没有 ZCode 那种先清后打的步骤。
- 另一条路：官方 DeepSeek 适配器不用 pi-ai 的 anthropic 断点，而是靠「系统提示 in-history 追加 +
  服务端自动缓存」（见 2.2）；OpenAI 官方域名还会带 `prompt_cache_key`/24h retention
  （`pi-ai/…/openai-completions.js:587-591`）。

**numa**

- 打 **2 处**：第一条 system + 最后一条消息（`src/core/llm.ts:777-806`；注释说明「dsc 的系统提示
  是一整条，稳定/动态两个断点合并成头部这一个」`:762-766`）。
- **启用条件**：`route.cacheControl === true` 才打；缺省 false，请求体逐字节不变
  （`src/core/config.ts:46-49,403`；`src/packages/llm/index.ts:132`；`loop.ts:498`；
  `llm.ts:570-586`）。当前 DeepSeek 兼容网关（如 opencode zen）不声明，走服务端自动缓存。
- **断点移动**：同样每轮从 `serializeMessages` 的新数组上重新打（`llm.ts:738-757,777-806`），
  无旧断点残留。

**判定与建议**：✅ 基本一致。少的那个「最后工具定义」断点只在「system 变了但工具没变」时有点用，
端点 4 个断点额度也不稀缺；**不建议为它改代码**（风险是给多模态/字符串正文多包一层 text 块，
与端点兼容性有关）。这条列 P3/不做。

### 2.2 系统提示分层

**dsh**

- 结构：`PromptSection` 注册表（静态文本或按组装上下文求值）按 order+name 排序渲染
  （`core/system-prompt/src/index.ts:254-262,297-302`；文档 `docs/subsystems/system-prompt.md:46`）。
- 动态事实走另一个命名空间 `ctx.systemPrompt.context()`（runtime-context），
  CONTEXT_ORDERS 固定分配：WORKING_DIRECTORY 100、SANDBOX_POLICY 110、APPROVAL_POLICY 115、
  SUBAGENT_DELEGATION 120、HARNESS_SOURCE 200、WEB_SURFACE 210，且**注释写明**
  「Process-specific paths and endpoints stay out of the cached system prompt」
  （`core/system-prompt/src/index.ts:178-186`）。
- 明确挡在系统提示外的实例：
  - 工作目录 → runtime context（`packages/session/working-directory/src/index.ts:109-128,197-199`）；
  - 沙箱档位/可写根 → runtime context（`packages/sandbox/sandbox-policy/src/index.ts:183-185`）；
  - 审批档 → runtime context（`packages/interaction/user-approval/src/index.ts:190-192`）；
  - 子代理身份/委派说明 → runtime context，理由注释直白：
    「so the deployment's system prompt stays uniform across parents and children」
    （`packages/subagent/subagent/src/child-agent.ts:166-175,205-210`；
    `packages/subagent/tool-subagent/src/index.ts:379-381`）；
  - 源码路径/Web 地址 → runtime context（`packages/context/harness-dev-context/src/index.ts:140-157`）；
  - 时间 → 独立 durable user 消息（`packages/context/time-context/src/index.ts:199-241`）；
  - 团队板 → **根本不进提示**，只注册一段静态 `TEAM_POLICY`（`packages/team/tool-agent-team/src/index.ts:27-33,112-116`），
    数据由模型调 `team_task_*` 现查。
- 系统提示里剩下的就是在部署/会话生命周期内不变的东西（persona、工具哲学、
  AGENTS.md 指令、技能目录、模型信息）；「进程相关路径与端点」永远在 runtime context。

**numa**

- 结构同形：内核固定段 identity(0)/behavior(10)/tool-rules(20) + 插件段（order 15–60）+ `instructions`(200)
  + `skills`(210) + `model`(890)，按 order→id 排序（`session-core/prompt.ts:80-85,420-459`；
  `prompt/index.ts:296-324`）。
- 动态事实已有尾部通道：`registerEnvFacts` 的 mode/sandbox + env-facts 投影统一拼成请求末尾
  user 快照（`prompt/index.ts:117-239`；`mode/index.ts:91`；`sandbox/index.ts:463-470`）。
- **差距**：`prompt/index.ts:3-12` 自己写着「稳定内容往前放、易变内容往后放」，但**没有机制保证**。
  现实中仍有会变的段占着前面：
  - `schedule` order 41，正文含「下次触发时刻」（绝对时间）——`schedule/index.ts:459-478`；
  - `self-improve` order 43，正文含待审候选条数——`self-improve/index.ts:1295-1318`；
  - `memory` order 60，并入 agentsMd 块，写入即变——`memory/index.ts:370-374,387-390`；
  - `subagent` order 60（默认），含磁盘角色表 + 配置值——`subagent/index.ts:2330` 起。
  这些段一改，断点位置在前面（约 2.4–3.3K 字符处），后面的 instructions/skills 与全部历史重读。
  团队板段本次已改成常量并挪到 order 220（`subagent/index.ts:2376`），就是一个正例。

**建议**：两条路，按「数据是否能现查」选：
1. 数据可现查 → 移出系统提示，走尾部快照或工具（dsh 的 team 做法）。schedule 的「下次触发时刻」
   可以只留在 `/schedule list` 与工具返回里，系统提示只说「有 N 个启用的定时任务，用 schedule 工具查」。
2. 数据必须常驻 → 至少把 order 挪到 `skills(210)` 之后（如 220/230），让一次变化的命中前缀
   从 ~1.2K token 提升到 ~6K token。**代价**：一次变化仍会丢掉「历史」这一段（无法避免）。

### 2.3 动态状态注入（位置 / 判等 / 重注）

**dsh**

- 位置：历史末尾的 user 消息，内容包在 `<system-reminder>` 里（`runtime-context.ts:157-180`：
  `createUserMessage({ content: …, source: { kind:'runtime-context', form:'snapshot' } })`）；
  文档：首份快照固定开头、后续快照声明「It replaces earlier versions…」
  （`core/agent-loop/README.md:172`）。
- 判等：`RuntimeContextProjection.project()` 用 `deepEqualJson(previous, sections)`，
  相同则返回 `undefined`（不产消息）；不同才产一条（`runtime-context.ts:164-170`）。
  文档：「未变不注入、压缩把保留快照弄丢才重注」(`README.md:172-180`)。
- 「压缩丢快照」：投影用 surface 事件判断保留快照是否被 replacement 遮蔽，被遮蔽就把
  `retained` 置空，下一次组装自然重注（`runtime-context.ts:129-155`）。
- 时间：durable user 消息，默认 10 分钟一条；`refreshIntervalMs=0` 才每步发
  （`time-context/src/index.ts:55-56,135,209-214,232-241`）；append-only，旧快照留在历史里。

**numa**

- env-facts：请求末尾 user 消息，hash 去重只写状态（`prompt/index.ts:173-239`；落盘 `:396-403`）。
- team-board：请求末尾 user 消息，`BoardSnapshotWatermark` 三键判据（看板水位、轮号、用户轮键），
  同一用户轮内看板没变 → 返回原数组不注入；换用户轮 / 水位变 / 同轮二次派生 → 注入
  （`subagent/index.ts:2269-2312`；`board-snapshot.ts:166-233`）。
- 其他注入方：todo-reminder 每 8 轮节流（`todo/index.ts:292-336`；`core/todo-reminder-cadence.ts:72`）、
  重复调用提醒（`agent/index.ts:230-258`）、LSP 诊断（`lsp/index.ts:209-221`）、
  hooks 留言（`hooks/index.ts:545-555`）；统一用 `InjectionNoteLedger`/`InjectionReportLedger`
  防「同一次派生重复落 note/重复长卡」（`core/context-injection-report.ts:65,113`）。

**判定**：✅ 已一致，机制甚至更细（多注入通道各有台账）。差异只有两点：
1. numa 的注入**不落历史**（纯投影），dsh 的 runtime snapshot 是 durable 消息；
   结果是 numa 在「快照没变」的后续步骤里模型手里没有它（team-board 已用「换用户轮重注」补上，
   `board-snapshot.ts:151-175`），dsh 则一直留在历史里（代价是历史变长）。
2. env-facts 默认每轮发（`envRefreshMs=0`，`prompt/index.ts:66-88`）：尾部注入**不破前缀**，
   但每轮多烧几十~几百 token，且「上一条尾部快照」那段永远不可复用。

### 2.4 工具定义与序列化确定性

**dsh**

- 工具顺序：默认按名字字典序（`compareToolNames`），部署可用 `toolOrder` 显式排序、
  未列出的插到 `<unlisted-tools>`（`core/system-prompt/src/index.ts:233-247,259-262`）。
  顺序在每次组装时确定，不依赖插件注册先后。
- 工具变更：路由能力 `toolUpdate:'addition-only'|'in-history'` 时，新增工具可以走
  developer 消息的 `tool_addition` 块追加，不重写前缀（`llm-pi-ai/src/models.ts:75-91`；
  `llm-deepseek/src/serialize.ts:91-105`；`core/agent-loop/README.md:122,166`）。
- 序列化：wire 消息由 durable 内容 + replay 元数据重建，消息对象上**没有**时间戳/来源 id
  进入 wire；pi-ai 侧统一 `timestamp: 0`（`llm-pi-ai/src/context.ts:46,198,236,407`）；
  DeepSeek 适配器只输出 role/content 块与 tool 引用（`llm-deepseek/src/serialize.ts:80-140`）。
- reasoning 回传：pi-ai 对 Anthropic 系用「请求前缀 digest」绑定签名块，前缀变了就丢弃过期
  thinking 再发；无法重建时把该条降级为 provider-neutral（`prefix-binding.ts:60-110`；
  `replay.ts:247-277`）。DeepSeek 适配器按 replay 元数据回传 thinking+signature
  （`llm-deepseek/src/serialize.ts:26-39`）。

**numa**

- 工具顺序 = 注册序（Map 插入序）+ 投影链（`tools/index.ts:42,57-78`）；请求组装直接
  `tools.map(...)` 序列化（`loop.ts:500-510`；`llm.ts:581-586`）——**无排序**。
- 序列化：`ts/files/origin` 在 wire 前删掉，assistant 只保留 `role/content/reasoning_content/tool_calls`
  （`llm.ts:738-757`）；请求前还会清孤儿工具消息（`llm.ts:221-242,563-570`）。
- 无 `toolUpdate` 机制（OpenAI chat-completions 形状不支持「对话中途加工具」）。

**判定与建议**：
- 排序：🟡 有差距但**收益有边界**——同一进程同配置下注册序稳定，排序只在
  「插件装载顺序变化 / 不同组合但工具集相同」时避免一次断。真正让前缀断的是**工具集变化**
  （MCP 连上/断开、设置里开关插件、PTY/浏览器动态工具），排序救不了。
- `toolUpdate`：🔴 受协议限制不改（numa 走 OpenAI 兼容 chat-completions；dsh 的 in-history
  工具更新用的是 DeepSeek Messages 的 `tool_addition` 块，网关不一定支持）。
- 可做的小改：在 `tools.visible()` 之后按名字排序再序列化（`src/packages/tools/index.ts:66-78`
  或 `loop.ts:500-510`），并加单测断言「两次组装、注册先后不同 → 序列化结果逐字节相同」。

### 2.5 microcompact 与真压缩

**dsh**

- 触发：`agent/pre-step` 压力检查、换模型时提前压、上下文爆窗后强制压
  （`compaction-basic/src/index.ts:157-175,183-203,213-257`）；阈值 = 窗口 × 0.8
  （`config.ts:20`），保留尾部约 16%（`:23,79`），headroom 65536（`:75`），补压 1 次、
  爆窗重试 1 次（`:105-106`）。
- 工具结果 prune：**压力触发后一次性批量**做：先 `pruneSession()` 落 durable 替换，
  再重测，仍超才摘要（`compaction-basic/src/index.ts:303,344-350`）。pruner 本身是确定性的
  head/middle/tail 切法（阈值 8192 字符 / 头 4096 / 尾 1024，`compaction-tool-result-pruner/src/config.ts:10-14`），
  每次替换同时写 `compaction/prune` 影子计价事件（`…/src/index.ts:124-182`）。
- 摘要请求**复用主对话前缀**：重放 surface 结点 0 的 system、header 的 tools、被折区间消息，
  末尾只加一条压缩指令——「genuine prefix of the last routed request，warm KV cache 复用」
  （`compaction-basic/src/summarizer.ts:25-30,73-84,109-120`；`region.ts:532-563`；
  `README.md:116,243-245`）。
- 压缩后：surface 用一条 user 摘要替换旧区间（`compaction/README.md:142`），
  **缓存从首个被替换的 token 起失效，之前的公共前缀仍可复用**（`README.md:190-192`）；
  没有「压缩后恢复命中」的特殊动作，靠后续请求重新累积。
- ROI：pruner 无显式收益门槛（只在压力下跑，压完再测）。

**numa**

- microcompact（旧工具结果换占位符）：投影，默认 `refresh:'round'`
  （`microcompact/index.ts:68-76`）：同一轮内冻结计划（`:112-163`），**每进入新一轮就重算**；
  有 ROI 门槛 `minFreePercent` 25%（`:74,130-140`）——「清 1 token 只按 1/10 价省，
  断一次前缀要按全价重读整段」；numa 注释里记录过实测「命中率被拖到 60% 上下（会话 bb13f0b5）」
  （`microcompact/microcompact.ts:99-107`）。`refresh:'request'` 更激进。
- tool-result-prune：投影，阈值/头尾与 dsh 同数字（8192/4096/1024），但**多一个「最近 4 条不动」**
  （`prompt/tool-result-prune.ts:34-41`；`prompt/index.ts:240-250`）。它是**无状态、逐请求重算**：
  每条超长结果在滑出最近 4 条那一刻切成占位符 → 每条各造成一次前缀断。
- 真压缩：`replaceWithSummary`（`session-core/compact.ts:373-375`）；阈值 80%、保留 16%、
  补压 1 次（`compact/index.ts:74-84`）；摘要请求复用主前缀（`compact/index.ts:199-212`；
  `session-core/compact.ts:305-348`）——**这一点已与 dsh 一致**。
- image-diet：每轮按「保留最近 2 个用户回合 + 用户图 4 张 + 工具图 2 张」卸载旧图
  （`core/image-diet.ts:36-52`；投影 `prompt/index.ts:251-268`）。图在历史前部，卸一张就从那张起断。

**判定**：🟡 有差距在「刷新节奏」与「批量 vs 逐条」，真压缩的 warm-prefix 已一致。

**建议**：
- microcompact：把「按轮重算」改成「预算/事件驱动」——例如累计「可清 token ≥ 上下文某比例」
  才推进清理点（现有 `minFreePercent` 已是雏形，把它从「每轮判断」改成「每轮只累计、
  够阈值才一次性推进」）；或直接参照 dsh 「压力触发 + 一次批量」。预期收益：工具密集会话
  命中率 60% → 75–85%（引用 bb13f0b5 的实测基数），每次少断 1 次前缀 = 少重读「清理点之后」
  的 10–20K token。风险：旧结果多留几轮，上下文占用略升；已有 ROI 门槛可调。
- tool-result-prune：同理改批量——「攒够 N 条待修剪/省够 X token 才一次性落投影」。
  它与 microcompact 有重叠（都在清旧工具结果），**可以先合并决策再分别落地**，避免两套策略
  互相把清理点推来推去。
- image-diet：保留每轮按龄卸载（这是 numa 的产品选择，避免老图烧 token），但可加
  「只在用户轮边界卸载 + 攒批」：一轮内多次工具步骤不动图，减少断次数。列 P2。

### 2.6 注入去重/节流与落位

- dsh：runtime-context 末尾 append、未变不发、压缩遮蔽重注（见 2.3）；time-context durable、
  10 分钟下限；两者都「**append-only，保住已发送前缀**」——`core/agent-loop/README.md:180`
  原话「Runtime reminders … append after existing messages and preserve that prefix」。
- numa：四个注入方各有台账（env-facts 文本台账、todo/重复提醒/LSP/hooks 的
  `InjectionNoteLedger`+`InjectionReportLedger`、team-board 三键水位），落位统一在
  `rewrite()` 的投影链末尾追加 user 消息（`prompt/index.ts:363-378`；order 600/650/700/800/850/900）。
- **判定**：✅ 已一致。numa 唯一缺的是「注入内容的结构化来源标记」——dsh 的
  `MessageSource.form`（`instructions/catalog/snapshot/notice/relay/recall`）
  让「这条是快照、后一条同类快照取代它」有类型可依（`packages/llm/llm/src/message.ts:39-75`），
  numa 只有自由文本 + 台账 key。对缓存的直接影响很小（台账已够），对可诊断性有影响（见 2.7）。

### 2.7 缓存指标与诊断

**口径（重要，两边语义不同）**

- dsh：`inputTokens` = **未缓存输入**，缓存命中/写入单独计（`token-meter/src/usage-projection.ts:14-26`）；
  提示词总量 = `inputTokens + cacheReadTokens + cacheWriteTokens`（`:77-79`）；
  命中率 = `cacheRead / (input + read + write)`（`client-ui-stats/src/client/stats-usage.ts:26-69`）。
- numa：`inputTokens` = `prompt_tokens` **总量（含命中）**；`cacheMissTokens = i - ch`
  （`core/llm.ts:698-708`；`core/pricing.ts:115-128`）；命中率 = `ch/(ch+cm)`。
- 换算：`ch(numa) = cacheRead(dsh)`；`i(numa) = input(dsh)+read+write`；
  `cm(numa) = input(dsh)+write(dsh)`（写入缓存按未命中计价）。引用两边数字时先对齐口径。

**展示粒度**

- dsh：每轮 cacheHit 在 StatsPills（`client/ui-chat/src/client/chat/StatsPills.tsx:297-340`），
  每条消息的 TurnUsagePanel 也有明细（`TurnUsagePanel.tsx:34-86`）；聚合在
  `stats-fold.ts:679`、`stats-totals.ts:25`、`stats-contract.ts:121`。
- numa：状态栏只有**本会话累计**（`ui-statusbar/ui/ui.tsx:262-291`）；transcript 每轮 usage
  只有 input/output，没有缓存两栏（`contract/transcript.ts:137-142,185`）；
  但 `usage.jsonl` 是**每请求一行**带 `ch/cm`（`core/usage-log.ts:29-59,332-399`），
  脚本可算逐请求命中——上次排查就是靠它对的账。

**诊断（两边都没做好）**

- dsh：grep `cache` 在 `packages/runtime-diagnostics`、`packages/telemetry` 均为 0 命中；
  没有「这次为什么没命中 / 从哪条消息开始断」的可观测手段，只有数字。
- numa：同样没有。上次会话里第 13 次 50%、第 14 次 5% 至今只能推测是「历史中段被改写」。
- **建议（P2）**：在 `loop.ts` 组装请求处加一个**只在调试/探针下开启**的前缀归因：
  对 `serializeMessages` 后的消息数组做逐条 hash 链，与上一条请求的 hash 链比较，
  记录「首个不同的消息下标 + 该消息来源（system/投影名/工具结果）」；每次请求一行写进
  `usage.jsonl` 的扩展字段（如 `pb: {i:3,src:'team-board'}`）。成本：每请求 O(消息数) 的 hash，
  可忽略；收益：以后命中率掉下来能直接指到「哪条消息变了」。

### 2.8 其他 cache-friendly 手法

| 手法 | dsh | numa | 评价 |
| --- | --- | --- | --- |
| 图片 | **按 provider 拒绝才卸载**，durable `image/offload` 事件，一次失败换一次永久卸载；缓存从第一张被改的图起失效（`compaction-image-offload/README.md:12,88,94-96`；`src/image-offload.ts:16-44`） | 每轮按龄/预算主动卸载（`core/image-diet.ts:36-52`），占位符不变 role 序列（`prompt/index.ts:251-268`） | 范式不同：dsh 少断、但可能白付一次失败请求；numa 主动省 token、但每次卸图断一次。numa 更适合「截图/贴图多」的场景，保持即可（P2 批量化） |
| 孤儿工具消息 | 配对校验 + 压缩切点对齐（`compaction/src/tool-pairing.ts`；`compaction/README.md:91`）；DeepSeek 序列化遇到无对应调用的结果直接报错（`llm-deepseek/src/serialize.ts:131-140`） | 请求前 `sanitizeToolOrphans` 删/补（`core/llm.ts:221-242,563-570`） | dsh 更「fail closed」，numa 更「自动修复」。孤儿只在损坏会话出现一次，断一次可接受——**不改**（改动风险大于收益） |
| 文件状态提醒 | 不注入文件内容/状态；`fs-observation-policy` 纯事件闸门，不产生提示文本（`fs/fs-observation-policy/src/index.ts:1-8`） | env-facts 每轮带 git 分支 + 最多 5 个脏文件（`session-core/prompt.ts:311-351`），30 秒 TTL；agent 一改文件文本就变，但只在**尾部** | ✅ 尾部安全；代价是每轮几十~几百 token 不可缓存（见 P2） |
| reasoning 回传 | Anthropic 系按前缀 digest 校验签名，过期即丢；降级不炸请求（`prefix-binding.ts:60-110`；`replay.ts:247-277`） | 所有 assistant 的 `reasoning_content` 原样回传（`llm.ts:737-757`）；DeepSeek 无语义签名，日志字节稳定 | ✅ 各自协议下的正确做法 |
| 上下文来源分类 | `MessageSource.form`（snapshot/catalog/notice/…，`llm/src/message.ts:39-75`）让「快照被后续快照取代」「注入不落历史」有类型可依 | 只有 note/state 记账 + 台账 key | 🟡 对缓存影响小，对诊断影响大（P2 可借） |
| 图片/工具变更的一次性代价 | 文档把代价写死（`README.md:190-192`、`compaction-image-offload/README.md:88`） | 注释里有（`microcompact.ts:99-107`、`sandbox/index.ts:463-466`） | ✅ 都有记录，numa 缺「用户可查」的报表 |

---

## 3. numa 已知剩余断点逐条裁决

| 断点 | 现状（file:line） | dsh 对应解法（file:line） | 裁决 | 优先级 | 单次代价（估） |
| --- | --- | --- | --- | --- | --- |
| `microcompact` `refresh:'round'` | 投影每轮重算计划（`microcompact/index.ts:76,112-163`）；ROI 门槛 25%（`:74,130-140`）；实测 60%（`microcompact.ts:99-107`） | 压力触发 + 批量 durable prune（`compaction-basic/src/index.ts:303,344-350`；`compaction-tool-result-pruner/src/index.ts:124-182`） | **改**：预算/事件驱动，攒够再推进 | P1 | 清理点之后整段，约 10–20K token/次；工具密集会话每轮一次 |
| 真压缩 `replaceWithSummary` | 改写历史中段（`session-core/compact.ts:373-375`）；摘要请求复用主前缀（`compact/index.ts:199-212`） | 同样 replace 语义，缓存从首个被替换 token 断（`compaction-basic/README.md:190-192`）；摘要请求复用主前缀（`summarizer.ts:25-30,109-120`） | **不改**（本质要改历史，一次断不可避免；warm-prefix 已对齐） | — | 每次压缩一次，属正常代价 |
| `tool-result-prune` 逐条滑窗 | 无状态投影 + 最近 4 条不动（`tool-result-prune.ts:34-41`；`prompt/index.ts:240-250`） | 压力触发批量 durable prune（同上） | **改**：批量化，与 microcompact 合并决策 | P1 | 每条越线一次，约 5–15K token/次 |
| `image-diet` 每轮 | 按龄卸载（`prompt/index.ts:251-268`；`core/image-diet.ts:36-52`） | 仅在 provider 拒绝时 durable 卸载（`compaction-image-offload/README.md:12,88`） | **部分改**：保留主动策略，改为用户轮边界批量 | P2 | 每卸一张一次，图在历史前部时可达十几 K |
| `schedule` 段绝对时刻 | order 41，含 `describeNext()` 绝对时间（`schedule/index.ts:459-478`；`core/schedule/rule.ts:743-748`） | dsh 只注册静态授权说明段（`schedule/tool-schedule/src/index.ts:359-366`），任务清单与下次时刻由 `schedule_list/view` 工具返回；系统提示不含动态时间 | **改**：正文去时刻，改为「有 N 个任务，用工具查」 | P0 | 断点 ~2.5K 字符处 → 每次触发丢几乎整段前缀，约 20–30K token |
| `memory` 段 | order 60、并入 agentsMd（`memory/index.ts:370-374,387-390`） | dsh 无对应插件（查不到 memory 包）；适用「易变数据走尾部」原则 | **改**：记忆索引走尾部快照或工具，正文只留说明 | P0 | 断点 ~6K 字符处（agentsMd 内），约 20–30K token/次写入 |
| `self-improve` 段 | order 43，含待审候选条数（`self-improve/index.ts:1295-1318`） | dsh 无对应插件（查不到）；同上原则 | **改**：只留静态说明，条数用工具查 | P0 | 断点 ~2.4K 字符处，约 20–30K token/次 propose |
| 工具定义按注册序、无排序 | `tools/index.ts:42,57-78`；`loop.ts:500-510` | 字典序排序 + `toolOrder`（`system-prompt/src/index.ts:233-247`） | **小改**：序列化前按名字排序 | P2 | 工具集变化才断；排序只解决「顺序不确定」 |
| `fold-system` 重写头部 | 投影把历史 system 并进头部（`prompt/index.ts:142`；`core/llm.ts:164-181`） | dsh 无此投影（系统提示是 surfaced 的第 0 条，插件用 runtime-context） | **不改**（现有插件都用 user 角色；可加门禁测试） | P2 | 仅外部插件往历史塞 system 时触发一次 |
| `sanitizeToolOrphans` 删历史 | wire 前清洗（`core/llm.ts:221-242,566-570`） | dsh 用配对校验 + 压缩安全切点（`compaction/src/tool-pairing.ts`；`compaction/README.md:91`） | **不改**（协议硬伤，损坏会话才触发一次） | — | 仅损坏/中断会话一次 |
| env-facts 每轮尾部注入 | `envRefreshMs=0` 缺省（`prompt/index.ts:66-88,173-239`）；含 git 状态（`session-core/prompt.ts:311-351`） | 时间 10 分钟节流、未变不发（`time-context/src/index.ts:55-56,209-214`；`runtime-context.ts:164-170`） | **小改**：稳定部分（平台/shell/目录）上移或缓存，日期/git 保持尾部；或 `envRefreshMs` 设 30–60s | P2 | 尾部不破前缀；每轮约 200–500 token 不可缓存 |
| 显式断点少一个「最后工具定义」 | 2 处（`llm.ts:777-806`） | 3 处（`pi-ai/.../openai-completions.js:813-878`） | **不改**（收益小、多包一层 text 块有兼容风险） | — | 极小 |
| 每轮 usage 无缓存字段 / 无归因 | `contract/transcript.ts:137-142,185`；`core/usage-log.ts:29-59` 有每请求 ch/cm | dsh 每轮 UI 有 cacheHit，但同样无归因（`stats-usage.ts:26-69`；runtime-diagnostics/telemetry 无 cache） | **加**：transcript 带 ch/cm + 前缀归因探针 | P2 | 诊断类，不直接省 token |

---

## 4. 改进清单（P0/P1/P2）

### P0｜把系统提示里的剩余易变段清零（schedule / memory / self-improve）

- **做什么**：
  - `schedule`：段正文只留「本会话有 N 个启用的定时任务；用 `schedule` 工具的 `action=list` 查详情与下次时刻」，
    删掉 `describeNext()` 的绝对时刻（`schedule/index.ts:464-476`）。
  - `memory`：`block:'agents-md'` 的快照挪到尾部投影（复用 `registerProjection`，order 700 附近），
    系统提示只留「长期记忆索引由程序附在消息末尾，写入后下一次请求生效」。
  - `self-improve`：正文只留静态说明，待审条数用工具或尾部快照给。
- **预期收益**：每次「写记忆 / 登记候选 / 定时任务触发」不再整段重读。按上次实测的单请求量级
  （输入 30–45K token），单次变化省约 **20–30K token**；一次会话写 3 次记忆即省 60–90K。
- **工作量**：中（3 个插件的提示段改造 + 各自的尾部注入/台账 + 测试）。
- **风险**：低——尾部注入套路已在 team-board 验证；注意别把「记忆正文」放进系统提示导致 prompt
  injection 面扩大（self-improve 现有注释已强调不拼候选正文，`self-improve/index.ts:1290-1294`）。
- **怎么量**：新会话触发一次记忆写入，`usage.jsonl` 该请求 `ch/(ch+cm)` 应仍 ≥80%（修复前该请求 ≈0%）；
  单测断言：模拟写记忆前后 `systemPromptParts().text` 逐字节相同。

### P1｜microcompact 刷新节奏改事件/预算驱动

- **做什么**：`refresh:'round'` 语义从「每轮重算」改为「每轮只累计可省量，累计 ≥ 阈值
  （或会话压力 ≥ 阈值）才推进一次清理点」；保留 25% ROI 门槛。可先做成一个配置档
  （`refresh:'budget'`），默认用新档，老档保留给想更省 token 的人。
- **预期收益**：工具密集会话每轮少一次前缀断。引用 numa 自己的实测（`microcompact.ts:99-107`：
  清理点前移把命中拖到 60% 上下），改为批量后预期 **75–85%**；每少断一次 =
  少重读清理点之后的 10–20K token。
- **工作量**：中（投影状态 + 台账 + 配置项 + 测试）。
- **风险**：中——旧工具结果多留几轮，峰值上下文上升；用 ROI 门槛和「清理点只前进不后退」约束。
- **怎么量**：同一会话对比改动前后逐请求 `cm`（= `i-ch`）；断言「连续两轮如果没有新的长工具结果，
  投影后的消息 JSON 逐字节相同」。集成测试可用假端点跑 5 步工具轮，断言只发生 1 次清理。

### P2｜prune/image-diet 批量化 + 缓存归因探针 + 观测性

- **做什么**：
  1. tool-result-prune 与 microcompact 合并决策、批量落一次（与 P1 同一批 PR 也行）；
  2. image-diet 在用户轮边界批量卸图，不在工具步骤中间卸；
  3. `loop.ts` 组装处加「前缀 hash 链 + 首个差异消息」调试探针，写入 usage.jsonl 扩展字段；
  4. transcript 的每轮 usage 增加 `cacheHitTokens/cacheMissTokens`（`contract/transcript.ts:137-142`），
     状态栏外的卡片/悬浮层可按轮展示。
- **预期收益**：prune 从「每条一次断」降到「每次批量一次断」（一个 20 次工具调用的会话可少 5–15 次断）；
  image-heavy 会话卸图次数减半；归因探针让后续命中率问题能在 1 分钟内定位（上次 50%/5% 两个异常
  花了整轮排查）。
- **工作量**：小-中（探针最小；prune 批量化与 P1 联动）。
- **风险**：低（探针默认关/只在 debug 日志）。
- **怎么量**：探针输出里每次请求有 `prefixBreakAt` 与来源；回归时看它是否指向预期组件。
  批量化的度量同上：对比改动前后同一会话的 `cm` 与「断点次数」。

### 明确不做（附理由）

1. **in-history 系统提示追加**：dsh 靠 DeepSeek Messages 的 `systemPromptUpdate:'in-history'`
   （`llm-deepseek/src/models.ts:8-23`），numa 走 OpenAI 兼容 chat-completions 且内核
   `fold-system` 会把任何追加的 system 并回头部（`prompt/index.ts:142`；`core/llm.ts:164-181`）——
   做了反而更糟。等价替代是尾部 user 快照（已在用）。
2. **工具 in-history 更新**：同上，协议不支持；只做排序与冻结测试。
3. **压缩后「恢复命中」**：压缩必须改写历史，从首个被替换 token 断一次是物理事实
   （dsh 也是这么记录的，`compaction-basic/README.md:190-192`），没有免费方案。
4. **把 env-facts 关掉**：平台事实（Windows→PowerShell）只有尾部快照一个载体
   （`prompt/index.ts:73-80` 的论证），关掉会让模型写 bash-ism；只调刷新频率。
5. **给所有插件段重排 order 的大重构**：只调「已确认会变」的几段，改动面越小越好。

---

## 5. 怎么量（统一口径 + 断言形状）

### 5.1 真实会话

1. `usage.jsonl` 按 `sid` 过滤，逐请求算 `hit% = ch/(ch+cm)`、`miss = cm`（numa 口径；
   等价 `i-ch`）。判据：首请求除外，单轮 ≥80%；整体（含首轮）≥85%。
2. 与会话 jsonl 的 `state.id=system-prompt` 记录对齐：修复后「同一会话内系统提示版本数」应
   等于「确实改了设置/模型/文件」的次数，而不是每轮一条。
3. 用探针（若实现）看每次低命中的 `prefixBreakAt` 指向哪个组件，验证归因。

### 5.2 单测/集成断言（形状）

```ts
// ① 系统提示逐字稳定（schedule/memory/self-improve 改造后）
const a = ctx.prompt.systemPromptParts(cwd, scope).text
triggerScheduleNextRunChange(); writeMemoryCell(); proposeLearning()
const b = ctx.prompt.systemPromptParts(cwd, scope).text
expect(b).toBe(a)
expect(promptHash(b)).toBe(promptHash(a))                // session-core/prompt.ts:100

// ② microcompact 预算驱动：无新长结果时清理点不推进（两次投影逐字节相同）
const base = [...messages, assistantToolCallResult]      // 中间只有普通新结果
expect(JSON.stringify(rewrite(base))).toBe(JSON.stringify(rewrite(base)))
// 或直接断言 planMicrocompact 的落点集合在 N 轮内不变

// ③ 工具定义确定性
const names = ctx.tools.visible(scope).map(t => t.name)
expect(names).toEqual([...names].sort())                 // 若采纳排序

// ④ prune 批量化：一次压力事件只落一次替换
expect(session.snapshotEvents().filter(e => e.type === 'compaction/prune')).toHaveLength(1)

// ⑤ env-facts 节流：窗口内第二次请求不再追加快照
expect(countEnvSnapshots(request2)).toBe(0)
```

### 5.3 预期数字（引用上次实测）

- 团队板修复前：49.72%（会话 c2838565，16 请求，命中 241,152 / 输入 485,017）。
- 修复后按「未变请求 78–96%」重算：**84.6%–90%（中位 ≈87.8%）**——这是本轮改动的验收基线。
- P0/P1/P2 全部落地后的目标：**工具密集会话全程 ≥85%**，单次变化请求的命中前缀从
  ~1.2K token 提升到「无变化」（P0）或至少 ~6K token（仅挪 order 时的保守值）。

---

## 6. 「dsh 有我们没有」与「两边都没做好」

### dsh 有、numa 没有（且值得借思路）

1. **in-history 系统提示/工具追加**（协议能力 + 内核配合）：numa 受 OpenAI 兼容协议与
   `fold-system` 限制，无法照搬；等价替代是「易变内容全部尾部注入」——这条 numa 已在做，
   只是还没做全（见 P0）。
2. **runtime-context 的结构化来源**（`MessageSource.form`）：让「快照/目录/通知」有类型，
   重注与去重判定更可靠，也利于 UI 归因。numa 可用「投影 id + note id」近似（已有台账），
   完整结构需动契约，列 P3。
3. **每轮缓存命中率 UI**：dsh 每轮/每条消息都能看（`StatsPills.tsx:297-340`），numa 只有会话累计。
   可先补数据（transcript usage 带 ch/cm），UI 回头再说。
4. **`prompt_cache_key` / 24h retention**（OpenAI 官方域名，`pi-ai/.../openai-completions.js:587-591`）：
   numa 若支持 OpenAI 官方路由可顺手加，DeepSeek 网关用不上。

### 两边都没做好

1. **「这次为什么没命中」的归因**：dsh 无（runtime-diagnostics/telemetry 里 grep 不到 cache），
   numa 无；上次会话的 50%/5% 异常只能推测。建议两边都加「前缀 hash 链 + 首个差异消息」。
2. **全局缓存不变量门禁**：numa 现在只有 subagent 的 `prompt-stability.spec.ts`（本次修复新增），
   其他插件仍可能悄悄往系统提示塞动态文本；dsh 有大量 replay/round-trip 测试，
   但没有「任意常见事件下 system prompt + 工具目录 + 历史前缀不变」的统一断言。
3. **缓存命中率告警/预算**：两边都没有「本会话命中率低于 X 就在 UI/日志提示」的机制；
   命中率掉到 50% 要用户自己发现（本次就是用户先发现的）。
4. **图片/裁剪的 ROI 统一决策**：numa 的 microcompact 有 ROI 门槛，但 prune/image-diet 没有；
   dsh 的 pruner 只在压力下跑（隐含 ROI），image 仅在失败时卸载（隐含 ROI）——两边都没有
   显式「断一次前缀 vs 省 N token」的统一账本。

---

## 7. 查不到 / 不确定

1. **dsh 的 `cacheControlFormat:'anthropic'` 对具体模型是否生效**：它是由模型 catalog 的
   compat 声明（`llm-pi-ai/src/catalog.ts:266` 默认可声明，`config.ts:306` 可覆盖），
   具体 provider-data 里哪些模型开了没逐个查；只能确认「机制存在、条件明确」。
2. **DeepSeek 官方路由是否真的接受 mid-conversation system 消息**：dsh 声明
   `systemPromptUpdate:'in-history'`（`llm-deepseek/src/models.ts:14`）；numa 的网关（opencode zen，
   OpenAI 兼容）是否支持未验证，且 numa 的 `fold-system` 会先并回头部，所以不构成可选方案。
3. **numa 端点的缓存是否按最长公共前缀折算**：上次观察到「系统提示变化后有的请求 0%、有的 5%」，
   网关实现不可见（服务端），只能实测；这也是 P2 探针的理由之一。
4. **dsh 是否有 memory / self-improve 对应插件**：dsh 包清单里没有 memory 插件
   （有 `skill`、`todo`、`context/file-reference` 等），所以这两条只能按通用原则对照，
   找不到直接对应实现。
5. **dsh 的 per-request cache 记录在哪里持久化**：usage 在 `assistant/message` 的 stream 里
   （`token-meter/src/usage-projection.ts:81-86`），是否另有像 numa `usage.jsonl` 那样的独立账本没查到；
   对「按会话算命中率」不影响（session 事件本身可聚合）。
