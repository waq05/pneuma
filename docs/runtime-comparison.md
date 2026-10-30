# 三家 runtime 的逐轮编排对照：dsh / codex / Pneuma

> 读的对象：DeepSeek Harness（下称 dsh，读的是 `D:\dsh\resources\app.asar` 里随包出货的
> `@deepseek-ai/dsh-*` 各包，代码在 `lib/index.js`）、OpenAI Codex 的 Rust 版
> （`D:\codex\codex`，HEAD `582a8812e0`）、本仓库 Pneuma（`src/`）。
> 所有结论都带 `文件:行号`；三家之外的话一律标成"我的判断"。
>
> 这篇回答三个问题：**一轮是怎么转的**、**模型每一轮到底收到什么**、**安全 / 成本 / 效率
> 各自靠什么保证**。最后一节列我认为 Pneuma 现在就该改的几条。

## 0 先给结论

1. **三家的主循环骨架几乎一样**：`while(true) { 组装请求 → 流式调模型 → 没有工具调用就停 → 执行工具 → 再来一圈 }`，
   结束条件都是"这一轮没有工具调用"，都**没有步数上限**（dsh 明说不内置轮次预算，
   `dsh-agent-loop/README.zh.md:221`；codex 的注释把"只回消息就算一轮完"写在
   `core/src/session/turn.rs:162-175`；Pneuma 的 `for(;;)` 里没有计数器，`src/core/loop.ts:338`）。
2. **差别全在"每一轮请求里装什么、怎么装"**。三家都意识到前缀缓存才是成本大头，但做法分三派：
   dsh 把易变内容全挪出 system 节点、codex 给提示词算确定性 UUID、Pneuma 把易变内容做成
   请求**末尾**的一条投影消息。方向一致，代价不同。
3. **安全上三家都靠"闸门有固定顺序 + 判不了就拒"**，但闸门放在哪一层不同：dsh 是
   沙箱 → 审批 → 工具流水线；codex 是审批策略 + 平台沙箱 + patch 路径判定；Pneuma 是一条
   带刻度的守卫链（地板 5 → 沙箱 8 → 模式 10 → 钩子 20/25 → 审批 30）。
4. **效率上最值得抄的是 codex 的"流式即派发"**：工具调用不用等整个响应结束，第 1 个调用
   在模型还在生成第 3 个时就已经在跑，回填顺序由 `FuturesOrdered` 保证
   （`core/src/session/turn.rs:3082-3084`、`:3503-3514`）。

## 1 一轮的骨架

### 1.1 三家对照

| 环节 | dsh | codex | Pneuma |
|---|---|---|---|
| 入口 | 从收件箱领活，`preStep` 组装 | `run_turn` 先做四件准备，再进循环 | `runTurn`：`beforeRequest` 后进 `for(;;)` |
| 循环体 | `preStep → step/start → 请求 → assistant 落盘 → 有工具就执行 → step/end`（`dsh-agent-loop/lib/index.js:936-1000`） | 收插入输入 → 抓上下文快照 → 拼历史 → 采样 → 收口判断（`turn.rs:475-595`） | `requestOnce` → 无 tool_calls 就 break → `executeToolCalls` → 步骤边界出账（`src/core/loop.ts:355-359`） |
| 结束条件 | 没有工具调用；`concludeTurn` 收口；`max-tokens` 截断**不**结束而是续写（`lib/index.js:1164`） | 没有工具调用；stop hook 要求继续则再跑（`turn.rs:761-778`） | 没有 tool_calls / 被 abort / 抛错 |
| 步数上限 | 无 | 无 | 无（子代理才有 `maxTurns`） |
| 计划阶段 | 不是阶段，是一段 plan mode 提示词 | 不是阶段，是提示词里的 `update_plan` 工具（`models-manager/prompt.md:52-60`） | 不是阶段，是模式条款（投影在请求末尾的 user 快照里，`src/plugins/mode.ts:86-90`） |
| 中途插话 | 下一步的输入里带（`dsh-agent-loop/README.zh.md:121`） | 循环顶部收进历史（`turn.rs:479-498`） | 进收件箱，步骤边界并进本轮（`loop.ts:309-323`） |

一句话概括三家的差异：
**dsh 的骨架是"事件日志 + 重放"**（turn/start、step/start、assistant/message、tool/result 全是落盘事件）；
**codex 的骨架是"一个回合一个快照"**（开轮抓一次 `StepContext`，上下文/工具/调用共用这一份视图，`turn.rs:279-301`）；
**Pneuma 的骨架是"循环 + 投影链"**（日志原文不动，发送前过一条纯函数链，`src/plugins/prompt.ts:128-209`）。

### 1.2 值得注意的两处细节

**dsh 的 preStep 顺序是"先组装提示词、再跑 pre-step 钩子"**（`lib/index.js:902-921`）。
代价写得很实在：插件改不了本次的 system 文本，只能往消息里加东西。好处是系统提示在整个
会话里只有一份，缓存前缀不会被插件随手打散。

**Pneuma 的收件箱出账时机**是它跟另两家最不一样的地方：后台作业完成、子代理回话这些
"插话"在**步骤边界**并进本轮（不多花一个回合），回合失败也在 `finally` 里补一次出账
（不丢输入）。dsh 与 codex 都是"插话进下一轮的输入"，多花一轮往返。这个设计在常驻多 agent
的场景里是省钱的（`src/core/loop.ts:309-323`）。

## 2 模型每一轮到底收到什么

### 2.1 请求对象的形状

| | dsh | codex | Pneuma |
|---|---|---|---|
| 有无 `system` 字段 | **没有**，提示词是 `messages[0]` 的 `system/message`（`dsh-system-prompt/README.zh.md:141`） | 没有，提示词是 `input[0]` 的 `developer` 项（`core/src/client.rs:1052-1083`） | **有**，`[{role:'system'}, ...history]`（`src/core/loop.ts:411`） |
| 历史 | `session.deriveMessages()` 全量 | `clone_history().for_prompt()` 全量 + `store:false`（`client.rs:1161`） | `session.messages` 全量 |
| 工具定义 | 每轮全量重发 | 每轮重发，另有"增量工具"通道（`turn.rs:1709-1722`） | 每轮全量重发，取当轮快照 `requestTools`（`loop.ts:448-458`） |
| 工具 schema 单独计量 | 有（`toolsTokens`） | 无（算在整体里） | **有**，单列一段（`core/token-estimate.ts:55-57`） |

三家都是"每轮全量重发"，这是无状态请求的必然结果。省钱的着力点只能在**前缀别变**和
**工具别多**上。

### 2.2 提示词怎么拼

**dsh**：一张集中分配的段号表（`dsh-system-prompt/lib/index.js:11-44`）。身份 -1000、
模式策略 500/600、每个工具一小段使用规范 1000~3100、SDK 5000、环境后缀 10000~10200。
工具段是**按作用域求值的函数**，工具不可见时返回空串（`dsh-tool-fs/lib/index.js:246-249`）——
预设裁掉 read 工具之后，提示词里不会留下"你应该用 read"这种指向不存在工具的废话。

**codex**：基础提示词不在代码里，来自模型目录的 metadata（`prompts/src/model_instructions.rs:8-19`），
正文是 275 行的 `models-manager/prompt.md`。最反常的一处：它**不走 `instructions` 字段**，
而是作为 `input` 第一项插进去，并给一个确定性 UUID v5
（`Uuid::new_v5(thread_id, 提示词正文)`，`client.rs:1052-1083`）——同一会话同一段提示词
永远同一个 id，服务端缓存前缀就能命中；提示词一改 id 自动变，缓存自然失效。
这是"用 id 表达缓存边界"，另外两家都没有。

**Pneuma**：`src/core/prompt.ts:369-397` 按刻度拼（身份 0、做事方式 10、工具规范 20、
agentsMd 200、技能 210、当前模型 890），排序原则写在 `prompt.ts:1-21`：稳定的在前、
易变的在后。

### 2.3 易变内容放哪：三家分别解了同一道题

下面是这道题的关键：`日期`、`工作目录`、`git 脏标`、`审批策略`、`AGENTS.md` 这些每轮都可能
变的东西，一旦写进 system，前缀缓存就整段作废。三家都不约而同地把它挪出了 system。

| | 做法 | 证据 |
|---|---|---|
| dsh | 投影成带 `source` 的 **user 消息**（工作目录、沙箱、审批、子代理身份…） | `dsh-system-prompt/lib/index.js:45-53`、`dsh-agent-loop/lib/index.js:910-920` |
| codex | 做成 `<environment_context>` 片段，且**只发差异**（跟上次快照逐字段比） | `core/src/context/world_state/environment.rs:115-202`、`:263-330` |
| Pneuma | 拼成一条 user 快照，**附在请求末尾**（每轮都发，缺省不跳过） | `src/core/prompt.ts:288-317`、`src/plugins/prompt.ts:158-185` |

三者代价不同，值得说清楚：

- dsh 的 user 消息在**历史中间**（跟在 AGENTS.md 后面），新的一轮如果内容变了，就是在
  中间插入/改写一段，缓存从那里断。它靠"变化才追加"缓解。
- codex 只发差异，是三省里最省 token 的；代价是每个上下文 section 都要实现
  `render_diff` 与"旧片段匹配器"，`core/src/context/world_state/` 目录 7 884 行
  （报告里的统计）。新增一类上下文接近新增一个子系统。
- Pneuma 每轮都在**末尾**追加一条完整的快照：前面逐字节不变，缓存一定命中；代价是
  每轮多几百 token，且快照不落库（日志里没有它，只有投影能复算）。

### 2.4 AGENTS.md 与时间

| | AGENTS.md | 时间 |
|---|---|---|
| dsh | 带 `source.kind='agent-instructions'` 的 user 消息，文件变了做增量协调（`dsh-agent-instructions/lib/index.js:143`、`:1270-1340`） | 单独一条 user 消息，10 分钟内不重复注入（`dsh-time-context/lib/index.js:149`、`:163`） |
| codex | `# AGENTS.md instructions` 的 user 片段，带元数据供后端统计（`core/src/context/user_instructions.rs:14-33`） | 在 `<environment_context>` 里，`current_date` 字段，同样走差异注入 |
| Pneuma | 进 system 的 `# agentsMd` 段（预算 20000 字符，超了保头 70% + 尾 20%，`prompt.ts:44-69`、`:222-230`） | 在环境快照里（`environmentText`） |

**这是 Pneuma 与另两家最实质的一处分歧**：Pneuma 把 AGENTS.md 放进 system。
好处是"说明书的地位高于对话"（模型更当回事），坏处是**用户改一次 AGENTS.md、或换个工作区，
整个会话的前缀缓存全部作废**。另两家都选择把它当"可变的上下文片段"，正是为了避免这个。

### 2.5 工具结果回填什么形状

| | 形状 | 截断 |
|---|---|---|
| dsh | `tool/result` 事件，content blocks（文本/图片） | 超 `maxInlineTokens: 12500` 先落 spill store，模型拿"头 + 省略说明 + 尾 + 去哪读全文"（`dsh-spill-policy/lib/index.js:186-225`） |
| codex | `function_call_output`，exec 类固定四段：`Exit code / Wall time / Total output lines / Output`（`core/src/tools/mod.rs:92-117`） | 按模型目录的 `truncation_policy` 统一截（`tools/mod.rs:103`）；会话型命令另有 10 000 token 上限 |
| Pneuma | `tool` 消息正文（字符串或带图片的块） | spill 4000 字符先落盘；bash 自己 8000 字符封顶，**保头 60% + 保尾 40%**（`core/tools/bash.ts:266-275`） |

Pneuma 的"头 60% + 尾 40%"值得单独说：它是对一条真实报障的修复——编译错误、测试断言
几乎都在输出末尾，只留头会让模型看不到失败原因。codex 的四段式则更结构化：它把
`Exit code` 与 `Wall time` 提到正文外面，模型不用再从输出里猜"这命令到底成功了没"。

### 2.6 一条第 N 轮的请求长什么样

**dsh**（`dsh-agent-loop/lib/index.js:1282-1292`）：

```
{ provider, model, reasoningEffort?, maxTokens?,
  messages: [ system(拼好的提示词),
              user(Instructions from: D:\dsc\AGENTS.md …),
              user(工作目录 / 沙箱策略 / 审批策略 快照),
              user(Time sampled while preparing turn 3, step 1: …),
              user(用户这一轮说的话),
              assistant(文本 + tool-call),
              tool(结果),
              … ],
  tools: [完整 schema], sessionId, signal }
```

**codex**（`core/src/client.rs:1154-1170`）：

```
{ model, store: false, stream: true, tool_choice: "auto", parallel_tool_calls: true,
  input: [ developer(基础提示词, 确定性 UUID id),
           developer(AGENTS.md instructions …),
           user(<environment_context>…</environment_context>),   // 仅变化时
           user(用户输入),
           function_call / function_call_output …,
           reasoning(encrypted_content) ],
  tools: [...], reasoning: {effort, summary}, prompt_cache_key, text: {verbosity, format} }
```

**Pneuma**（`src/core/loop.ts:411`，投影后）：

```
[0] system     身份 + 做事方式 + 工具规范 + # agentsMd + 技能目录 + 当前模型
[1] user       用户第一句话
[2] assistant  正文 + tool_calls
[3] tool       结果（可能被 spill / 截断）
[4] assistant  …
[5] user       环境事实快照（日期、平台、cwd、git 脏文件、模式条款）
```

## 3 安全怎么保证

### 3.1 闸门的顺序

| | 顺序 | 关键性质 |
|---|---|---|
| dsh | 沙箱（文件）→ 审批（ask/never）→ 工具流水线（pre-execute → 单调守卫 → execute → post-execute） | 守卫只能收紧：后注册的监听器没法把拒绝翻回允许（`dsh-tools/README.zh.md:110`） |
| codex | 审批四档（untrusted / on-request / granular / never）+ 平台沙箱 + `safety.rs` 的 patch 判定 | "每个路径都在可写根内 + 沙箱可用"才自动批准，否则问人或拒（`core/src/safety.rs:106-124`） |
| Pneuma | 守卫链：地板 5 → 沙箱 8 → 模式 10 → 钩子 20/25 → 审批 30 | 链上抛错按拒；地板只 deny/defer，**从不 pass**（`src/core/tool-guards.ts:103-117`、`approval-floor.ts:15-23`） |

三家的取舍差异在于"谁排前面"：

- dsh 把**沙箱排最前**，因为它约束的是"文件能不能被写"，这是比"用户同不同意"更硬的边界。
- Pneuma 把**灾难地板排最前**，理由写在文件头：模式闸门在若干情形直接 `pass`
  （`core/modes.ts:104`、`:135`），一 pass 后面的钩子和审批就全失语了
  （`approval-floor.ts:4-8`）。所以"灾难命令连满权限也不许跑"只能由排在最前面的那一位自己完成。
- codex 没有独立的"地板"层，它靠审批档位 + 沙箱 + `safety.rs` 的路径判定，且允许
  "同意并写入 execpolicy 规则"沉淀成规则（`protocol/src/protocol.rs:4371-4391`）。

### 3.2 三家的失败关闭点

这是安全设计里最该对齐的一条：**判不了的时候，是拒还是放**。

| 场景 | dsh | codex | Pneuma |
|---|---|---|---|
| 沙箱后端不可用 | 拒绝执行（`SANDBOX_UNAVAILABLE`），绝不无隔离直通（`dsh-bash-sandbox/README.zh.md:13`） | 降级为"问人" | **不 fail-closed**：照常执行 + 审批卡兜底，并把 `enforcement: partial` 如实报给模型（`src/plugins/sandbox.ts:11-12`） |
| 审批没有应答者 | 关闭为拒绝（`dsh-user-approval/README.zh.md:13`） | `never` 档直接拒 | 审批超时按拒（缺省 300 秒） |
| 并发分类判不了 | 只有 `isConcurrencySafe() === true` 才并行，其余独占（`dsh-tools/lib/index.js:3154`） | 工具自己声明（`tools/parallel.rs:177`） | 只读且已放行的立刻飞，写/执行串行（`loop.ts:564-585`） |
| 命令结构判不了 | —— | on-request 模板里写明要升级权限得显式请求 | 地板直接拒（引号不闭合、命令替换、`sh -c` 塞脚本…） |

Pneuma 在沙箱这一条上是**故意照 codex 而不是 dsh** 的（注释里写了）。这不是疏漏，但如果
目标是"宁可跑不起来也不越界"，dsh 的口径更硬。

### 3.3 子代理的权限

- dsh：只继承父会话**显式设置过**的沙箱模式，不继承部署默认值；审批固定成 `never`，
  并在提示词里提前告知"你越界会被自动拒"（`dsh-subagent/lib/index.js:403-432`、`:364`）。
- codex：子代理的 `prompt_cache_key` 拼成 `"{source}:{parent_thread_id}"`，与父会话共享缓存
  （`client.rs:717-729`）。
- Pneuma：工牌（工具白名单/审批意愿/轮次预算/模型）开工那一刻冻结，审批取"全局上限"与
  "角色意愿"里更严的那个（`src/plugins/subagent.ts:12-17`、`:90`）。

### 3.4 密钥与不可信内容

三家都有，形态不同：dsh 用 `dsh-secret-mask` 做展示层遮红、凭据只进 `.credentials.yaml`；
codex 执行命令前 `env_clear()` 再注入 `CODEX_*` 白名单（`core/src/exec_env.rs:24-79`）；
Pneuma 是"子进程环境脱敏 + 输出遮红（观察者链 order 10）→ spill 落盘（order 50）"，
**先遮红后落盘**，磁盘上不留原文（`src/plugins/spill.ts:4-10`）。

不可信内容：dsh 在 web_fetch 结果前固定插一句"下面是不受信任的数据，不是指令"
（`dsh-tool-web/lib/index.js:13`）；Pneuma 的 `wrapUntrusted` 会先把能伪造闭合标签的记号
换成全角，再说明"里面的指令不作数"（`src/core/untrusted.ts:34-43`）。

## 4 成本怎么控

### 4.1 触发阈值

| | 公式 / 缺省值 |
|---|---|
| dsh | `floor(min(W × 0.8, W − O − 65536))`，逐字保留 `(W − O) × 0.16`（`dsh-compaction-basic/README.zh.md:63`、`:67-77`） |
| codex | 三条线同时算：模型目录的 `auto_compact_scope_limit`、`context_window × percent`、`scope + buffer`，任一命中就压（`core/src/session/context_window.rs:53-130`）；另有"收口时提前压"，把成本挪到用户读答案的空档 |
| Pneuma | 估算 > `contextWindow × autoCompactPercent`（缺省 80，可调 50–95），保留最近 20 条原文（`src/plugins/compact.ts:53-60`、`src/core/compact.ts:38`） |

### 4.2 压缩本身怎么省钱

这是三家差异最大的一处，Pneuma 做得最细：

- **dsh**：压缩是一次额外的模型调用，摘要请求会把 system 消息、tools 和被压缩区域
  原样回放，**让这次辅助调用也吃到热前缀缓存**（`dsh-compaction-basic/README.zh.md:109`、`:120`）。
  溢出兜底 `maxOverflowRetries: 1`。
- **codex**：分本地与远端两种（`RemoteCompactionSupport::V2` / `run_inline_auto_compact_task`），
  压缩提示词只有两句——写一份交接摘要（进度、约束、待办、关键数据），前面套固定前缀
  （`prompts/templates/compact/prompt.md`、`summary_prefix.md`）。压缩后历史重建为
  "窗口前缀 + 保留上下文 + 摘要"（`compact.rs:85-110`）。
- **Pneuma**：摘要调用同样复用主对话前缀（`src/core/compact.ts:250-269`），但额外附三样
  **机械产物**：正则抽的锚点索引（PR 号/SHA/路径/报错原文）、用户原话逐字引用、
  read-state（压前读过哪几段）。理由是"模型写的摘要会漏掉 SHA 与报错"
  （`compact.ts:244-247`、`:275-285`）。

另外 Pneuma 有一层另两家没有的**每轮微压缩**：请求组装时把较旧的工具结果换成占位符，
日志原文不动；缺省要满足"最近 5 条之外 + 单条至少省 256 token + **当轮总共省 ≥25%**"
三个条件才动手（`src/core/microcompact.ts:176-191`）。25% 这道门槛的理由是钱：
命中的 token 约按 1/10 价收，没命中的按全价重读，清得少反而亏。

### 4.3 prompt 缓存

| | 做法 | 我的评价 |
|---|---|---|
| dsh | 适配器里搜不到 `cache_control`，全靠"保证前缀逐字节稳定"，并在每包 README 里写清"这改动会让缓存从第几个 token 起失效"（`dsh-llm-deepseek/lib/index.js`） | 文档纪律代替代码机制，脆，但省事 |
| codex | `prompt_cache_key` 三种策略（会话派生 / 自定义 / 省略），子代理拼父会话 id | 有显式信号，可观测 |
| Pneuma | 不做客户端缓存；靠网关自动前缀缓存 + 端点声明支持时打 Anthropic 风格断点（缺省 false，`src/core/llm.ts:86-88`、`:678-701`） | 折中方案 |

### 4.4 固定成本

三家每轮都重发"系统提示 + 全部工具 schema"。dsh 明确写了这份成本
（`dsh-system-prompt/README.zh.md:151`、`:163`）；Pneuma 把它单列成上下文分段
（`core/token-estimate.ts:55`），界面上能直接看到"工具定义占了多少"。

省这份钱只有两条路：**裁工具**（schema 真的不发了）或**渐进披露**。Pneuma 的
`tool-search` 插件走的是后者：把 MCP 的 schema 先收起来，需要时再暴露
（`src/plugins/tool-search.ts:1-14`）。

## 5 效率怎么来

### 5.1 并行

| | 调度方式 | 保序 |
|---|---|---|
| dsh | 每步实时分类，可并行的进有界滚动池（默认 10），独占的单独跑并构成屏障；池子填到一半遇到独占先排空再切换 | 策略判定、结果落盘、上下文**始终按模型给的顺序**（`dsh-agent-loop/lib/index.js:489-495`、`:543-560`） |
| codex | `parallel_tool_calls: true`；流里每来一个调用就塞进 `FuturesOrdered`，结束后按序 drain | `FuturesOrdered` 天然保证回填顺序 = 调用顺序（`turn.rs:3082-3084`、`:3503-3514`） |
| Pneuma | 守卫链与审批卡串行问（一次只能弹一张卡），但"只读且已放行"的调用立刻起飞；撞上第一个写/执行调用或回合收尾时一起收割 | 结果永远按模型给的顺序落库（`loop.ts:564-585`、`:634-643`） |

差异在**起点**：codex 是"流式即派发"，模型还在生成后续调用时前面的已经在跑；dsh 是
"整条响应结束后再调度"；Pneuma 是"边判边跑"。codex 的首字延迟最优，Pneuma 的审批体验最好
（不用等全部到齐才弹卡）。

### 5.2 取消

- dsh：协作式取消，未派发的调用补一条 `ABORTED_BEFORE_DISPATCH` 错误结果，**让历史里每个
  tool/call 都有配对结果**（`dsh-agent-loop/README.zh.md:129`）。
- codex：`CancellationToken` 逐层向下传，收敛成 `TurnAborted`；对"中途插话"另有一层 `preempt`
  ——取消当前流但保留已完成项与响应 ID 以便续传（`turn.rs:2883-2896`），比直接掐断省钱。
- Pneuma：一个 `AbortController` 贯穿 fetch 与工具执行；已打断时在飞的收尾，剩下没开始的
  逐条补"用户取消，调用未执行"的合成结果（`loop.ts:588-595`）。

三家在这件事上的约束是同一个：**协议要求每个 tool_call 都有对应的 tool 消息**，
少一条下一轮就 400。区别只是"补什么形状的合成结果"。

### 5.3 大输出

三家都落盘，阈值不同：dsh 12500 token、Pneuma spill 4000 字符 + bash 8000 字符封顶、
codex 按模型目录的 `truncation_policy`。共同点是**"先落盘再决定给模型看多少"**，
而不是先截断再记录——原始输出永远可追。

## 6 三家的共同点与分歧

### 共同点（说明这些是"绕不开的"）

1. 结束条件 = 这一轮没有工具调用，**没有步数上限**。
2. 易变上下文（日期、cwd、权限策略）必须离开 system，否则缓存全废。
3. 工具结果必须落盘/可追，给模型看的只是一份视图。
4. 取消时必须给每个 tool_call 补一条合成结果，否则协议崩。
5. 判不了的时候默认拒（或至少默认慢路径）。

### 分歧（说明这些是"可选的"）

| 争点 | 选项 A | 选项 B |
|---|---|---|
| 提示词放哪 | 独立 `system` 字段/节点（Pneuma） | 塞进 `input[0]` 并给确定性 id（codex） |
| AGENTS.md 放哪 | system 里（Pneuma） | 可变上下文片段（dsh / codex） |
| 易变内容怎么发 | 每轮末尾整段重发（Pneuma） | 只发差异（codex） |
| 压缩摘要要不要机械产物 | 要（Pneuma：锚点/SHA/原话/read-state） | 不要，纯模型摘要（dsh / codex） |
| 沙箱不可用时 | 拒绝执行（dsh） | 降级 + 审批兜底（Pneuma / codex） |
| 工具派发时机 | 流式即派发（codex） | 响应结束后调度（dsh） |

## 7 对 Pneuma 的具体建议

按"投入产出比"排序，前三条是我认为现在就该做的。

### 7.1 给主循环加一个可配的步数上限（中）

三家都没有，但 Pneuma 的风险最高：它的工具调用可以自我延续（`PTC` 脚本里能循环调工具），
而且主会话缺省不限轮次。建议做法不是硬编码数字，而是"缺省给一个宽松值（例如 200 步）、
在接近上限时由 inject 告诉模型'再调 X 次这一轮就被截断'"，把硬截断变成软提示。
子代理已经有 `maxTurns` 的先例（`src/plugins/subagent.ts:524-531`），接口是现成的。

### 7.2 把 AGENTS.md 从 system 挪到可变上下文（中）

这是三家唯一"方向不同"的地方，而且 Pneuma 的选法有明确代价：改一次 AGENTS.md、
或切一个工作区，整段前缀缓存作废。挪法可以照 codex：作为一条带 source 的 user 消息，
内容按 mtime 缓存、变了才重发。代价是模型对它的"重视程度"可能下降——可以用措辞补偿
（"下面是这个项目必须遵守的规则，与用户指令同等效力"）。

### 7.3 工具结果用 codex 那种四段式（低）

现在 Pneuma 的 bash 结果就是"退出码 1\n<输出>"。codex 的四段式
（`Exit code / Wall time / Total output lines / Output`）把"这命令成没成、跑了多久、
输出被截了没"提到正文外，模型不用再猜。改动只在 `spawnShell` 的 `finish` 里，
成本几乎为零。

### 7.4 压缩摘要复用前缀这件事已经做了，可以再补一件（低）

Pneuma 已经让摘要调用复用主对话前缀（`compact.ts:250-269`），这一步是对的。
还可以补的是 dsh 的**"变化才落 request envelope"**：把每次请求的
provider/model/tools/窗口记录进会话日志，只在变化时追加（`dsh-agent-loop/lib/index.js:1227-1268`）。
好处是出问题能完整回放"那一轮到底发了什么"，而现在的日志只有消息、没有 envelope。

### 7.5 不要学的两条

- **codex 的 world-state 差异注入**：省 token 是真省，但 `core/src/context/world_state/`
  接近 8000 行，且每加一类上下文都要维护"当前渲染 + 快照结构 + 旧片段匹配 + 压缩后重建"。
  Pneuma 的上下文种类远少于十种，用"末尾整段重发"更划算。
- **dsh 的"文档纪律代替缓存机制"**：靠 README 里逐条写"这改动会让缓存从第几个 token 失效"，
  在插件可以随便加权重的架构里迟早失守。要么加显式 cache 断点，要么在组装阶段就断言
  "前缀段只能由固定集合贡献"。

## 附：证据来源

- dsh：`dsh-agent-loop`、`dsh-system-prompt`、`dsh-tools`、`dsh-compaction-basic`、
  `dsh-token-meter`、`dsh-user-approval`、`dsh-bash-sandbox`、`dsh-spill-policy`、
  `dsh-agent-instructions`、`dsh-subagent`、`dsh-llm-retry`、`dsh-time-context`、
  `dsh-base/cordis.patch.yml`（均在 `D:\dsh\resources\app.asar` 内）。
- codex：`codex-rs/core/src/{session/turn.rs, session/context_window.rs, client.rs,
  client_common.rs, safety.rs, exec_env.rs, tools/mod.rs, tools/parallel.rs,
  context/world_state/*, compact.rs, prompts/templates/compact/*}`、
  `codex-rs/protocol/src/protocol.rs`。
- Pneuma：`src/core/{loop.ts, prompt.ts, llm.ts, ptc.ts, compact.ts, microcompact.ts,
  token-estimate.ts, tool-guards.ts, approval-floor.ts, secrets.ts, untrusted.ts}`、
  `src/plugins/{prompt.ts, compact.ts, microcompact.ts, mode.ts, approval.ts, sandbox.ts,
  subagent.ts, spill.ts, tool-search.ts}`、`src/core/tools/{bash.ts, search-tools.ts}`。
