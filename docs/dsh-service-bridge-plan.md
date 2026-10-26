# dsh 服务桥：把会话历史与用量接到 dsh 的插件上

> 状态：**通了**（2026-10-26）。读侧落在 `src/core/dsh-compat/session-bridge.ts`，
> 实时记账靠 `src/core/dsh-compat/llm-usage-event.ts` 派发 `llm/stream`；
> 真包验收（`dsh-cost-meter` 1.9.41）账本里能读到 `calls / input / output`。
> 细节与剩下的小口子见 §7。

## 1. 症状

`dsh-cost-meter` 1.9.41 能装、能挂、能进插件中心，账本也落在 `~/.dsc/storages/cost-meter/`，
但**成本条没有数字**。原因不是它坏了，而是它算账要的两类数据宿主没给：

- `sessionPersistence`：按会话 id 读历史事件（它从事件里取每次模型调用的 usage）；
- `sessions`：会话注册表（有哪些会话、每个的 header / 状态）。

插件里这两条是 `ctx.get('sessionPersistence')` 现取的，取到 `undefined` 就静默少一段功能
——所以「挂载成功」与「能用」是两件事。判定表（`src/core/dsh-compat/service-map.ts`）
把这两个名字标成 `adapted`：有对应物，但形状不同，必须写适配器。

## 2. 两边的形状差在哪（有据可查的部分）

dsh 的 `sessionPersistence`（`@deepseek-ai/dsh-session-persistence`）是**事件溯源**的一套：

- 会话是 `SessionHeader` + 一串带 `seq` 的事件，读侧是 `stat(sessionId)` → `SessionPersistenceSnapshot`
  （`header` / `revision` / `eventCount` / `sizeBytes` / `formatStatus`）、`open(id)` 拿读句柄、
  按 `throughSeq` / `beforeSeq` 分页读；
- 写侧是 `create(header)` 拿写句柄、append 事件——**写所有权**是它的核心语义
  （同一会话 id 只许一个写者）；
- 还有 `formatStatus: 'migration-required'` 这种跨版本状态。

Pneuma 这边是另一套：

- 会话是 `~/.dsc/sessions/<工作目录哈希>/<uuid>.jsonl`，一行一个 `{type: meta|user|assistant|tool}`，
  **没有 seq、没有事件类型体系、没有写所有权**；
- token 用量单独落 `~/.dsc/usage/usage.jsonl`（每行一次模型调用：`sid` / `i` / `o` / `t` / `n`），
  会话日志里没有。

也就是说：dsh 的读侧语义（事件流 + seq）Pneuma 没有，但**算账要的那点数据 Pneuma 有**，
只是散在两个地方。适配器的真正工作是把这两份拼成 dsh 期望的事件形状。

## 3. 为什么它不是「写个适配器」就完了

1. **API 面比看起来大**：不是两个方法，是 `stat / open / list / read(page) / create` 加句柄与
   revision 语义。只实现「刚好够某个插件调的那两个」等于给下一个插件埋新的坑。
2. **写侧无法诚实实现**：`create`/`append` 要求写所有权与 seq 单调，Pneuma 的会话写入由内核的
   agent 循环独占。给插件开写口 = 两套写者改同一份 jsonl，坏的是用户的会话记录。
   所以只能做**只读子集**，且必须对写方法响亮报错（不能静默 no-op）。
3. **没有验收对象**：`dsh-cost-meter` 是 200+ 文件的包，它读事件的字段口径没有文档，
   只能读源码对——它也不在仓库里（不装就没有）。没有它，「适配器对不对」无法证明，
   只能证明「我们的合成探针能跑」。
4. **收益 vs 成本**：这条链路服务的是「界面上的费用显示」这一类需求。Pneuma 自己已经有
   `usageStats()`（设置里的用量统计）与状态栏用量，成本条属于锦上添花。

## 4. 怎么做（三步都做了；第 3 步先负后正，见 §7）

**第一步：读侧最小面（1 批）——已做**

- 新 `src/core/dsh-compat/session-bridge.ts`：把 Pneuma 的会话列表映射成 dsh 的
  `list()` / `stat(id)`；`open(id)` 返回只读句柄，`read({throughSeq, beforeSeq, maxMessages})`
  按行分页（Pneuma 的 jsonl 行号即 seq）。
- 事件形状：`user`/`assistant`/`tool` 行直接映射成最小事件（`type` + 载荷 + `seq`）；
  **usage 事件由 `~/.dsc/usage/usage.jsonl` 合成**（按 `sid` 聚合，时间戳当 seq 排序键）。
- 写方法（`create` / `append`）一律抛一条中文错误：「dsh 的会话写句柄在 Pneuma 里不可用，
  会话由内核独占写入」。
- 注册进兼容层 ctx（`get` 能取到），仍走 `service-map.ts` 的口径。

**第二步：`sessions` 注册表（同一批）——已做**

- `get(id)` 返回 `SessionRecord`；`list()` 给当前工作区的会话（Pneuma 已有这一份数据）。
- 不要实现 fork / prompt / 迁移那些——它们属于写侧。

**第三步：用真包验收（已跑，结论是「历史通了、实时记账还没通」，见 §7）**

- 装 `dsh-cost-meter` 到隔离 profile，跑一轮带工具的真实对话（`scripts/_fake-llm.mjs` 可以
  点名工具），断言成本条出现非零数字。
- 拿不到真包时，退而求其次：写一个**模仿它调用序列**的探针插件（`ctx.get('sessionPersistence')`
  → `list` → `stat` → `open` → `read`），断言每一步都给得有道理。这只是必要条件，不是充分条件。

## 5. 现在能给的替代

- 想看在用多少 token：设置里的「用量统计」（`usageStats()`）与状态栏用量已经有数；
- 想看单个会话的花费：`~/.dsc/usage/usage.jsonl` 里有逐次调用的 `i`/`o`，可按 `sid` 汇总。

## 6. 已做的部分（2026-10-26）

`src/core/dsh-compat/session-bridge.ts`，两个只读桥：

| 名字 | 给了什么 | 没给什么 |
| --- | --- | --- |
| `sessionPersistence` | `list()`、`stat(id)`（header / revision / eventCount / sizeBytes / formatStatus）、`open(id, 'read')` 拿只读句柄，句柄上 `read({throughSeq, beforeSeq, maxMessages})` | `create` / `append` / `open(id,'write')`——一律抛一句中文错误，说明「会话由内核独占写入、只读能用什么」 |
| `sessions` | `list()`、`get(id)`、`has(id)`（会话 id、cwd、createdAt、title、live=false、persisted=true） | fork / prompt / 迁移这些写口 |

怎么进到插件手里：兼容层的 ctx 代理在 `get` 时先问 cordis，真没有就交给
`compatServiceOf(name)`（见 `src/core/plugin-loader.ts`）。**没有走 `ctx.provide`**——
桥是按插件现造的读口，provide 出去会变成所有插件共享一个可变对象。副作用是：写进
`inject` 仍会被拒（cordis 服务表里没有这两个名字，等不到），要改成 `ctx.get`；
dsh 的 cost-meter 本来就是这么写的。

事件怎么来（2026-10-26 晚改过一轮，见 §7.2）：会话 jsonl 的一行翻译成 **dsh 的事件类型**
（`user/message` / `assistant/message` / `tool/result`），正文包成 dsh 的消息形状
（`{ id, role, content: 内容块[], source }`），按时间排序后编 `seq` 与 `time`。
`~/.dsc/usage/usage.jsonl` 里的请求行按 `sid` 归到会话上，**并进它前面最近的那条
`assistant/message` 的 `usage` 字段**（dsh 的用量就长在助手消息上）；前面没有助手消息可挂
时才单列一条 `llm/usage`，并标 `ignorable`（不认识的插件可以跳过）。工具行不带 token，
不当事件；`meta` 行不是事件（会话头走 `header`）。

自检：`node scripts/dsh-session-bridge-check.mjs`（42 条，含「不声明 inject 的插件在 apply 里
ctx.get 现取」这条真挂载路径），进 `pnpm run check:dsh`。

## 7. 真包验收（2026-10-26）：先负后正

按第三步真装了一次：隔离 HOME、`numa plugin add dsh-cost-meter`（1.9.41，走 npm）、
假端点跑一轮带工具的对话。结果：

| 看什么 | 结果 |
| --- | --- |
| 包挂得上 | ✅ 插件中心里 `cost-meter` 在，enabled，没有 problem |
| 账本落盘 | ✅ `~/.dsc/storages/cost-meter/ledger.json`（325 KB，配置与价目表都在） |
| 成本条有数 | ❌ `ledger.days` 是空的——这一轮的花费一条没记 |

**为什么**：读它的源码才看清，它记**实时花费**走的是 dsh 的事件流
（`ctx.on('llm/stream')` 与 `ctx.on('session/event')`），不是读历史。
`sessionPersistence` 那条只服务它的「历史 / 补账 / 会话列表」功能。我们没有发这两类事件，
所以它一条也收不到。

**顺带按真消费方把桥的形状改对了**（这轮最有价值的产出）：它的
`recordsFromPersistence()` 要求——

- `stat()` / `list()` 的 `header.id`（我们原来写 `sessionId`，会被当成「没这个会话」跳过）；
- `handle.header` 与 `handle.inheritedEventCount`（原来没有）；
- `handle.read(offset)` 里 **offset 是一个 seq 数字**（原来只吃对象）。

这三处都按真实调用点改了，自检也从 32 条加到 36 条（新增句柄 header / 继承计数 /
数字偏移三条）。

### 7.1 补上事件流之后：通了（同一天补的）

做完读侧之后补了**旁路事件**：回合里每记一条用量，就按 dsh 的 waterfall 约定派发一次
`llm/stream`——把这一次调用的真实 token 数包成**唯一一个** `{ type:'usage', usage }` chunk，
交给监听者链（插件会包住它、读到 usage、记账、再往下吐），然后把这个被包过的迭代器消费完。
落在 `src/core/dsh-compat/llm-usage-event.ts`，调用点在 `src/plugins/agent.ts` 的用量分支。

再跑真包验收：

```
PASS 组合包里的 cost-meter 挂上了
PASS 挂载没有报问题
PASS 账本落在 ~/.dsc/storages/cost-meter
PASS 账本里有这一轮的花费
```

账本里读到的是真的数：`calls: 2、input: 80、output: 35`，按 `fake:fake-chat` 分渠道、
按会话分账（花费是 0，因为假端点没有价目表——数字对、钱数对不上是正常的）。

**没有骗人的地方**：chunk 里的数字就是这次请求真实的 token 数，不是编的；我们只是把
「回调式流」翻译成「迭代器式流」让插件读得到。插件抛错一律吞掉，记账失败不影响回合。

剩下的小口子（不挡用）：

- ~~只发 `llm/stream`，没发 `session/event`~~ —— 当晚补上了，见 §7.2。
- 我们发的是「一次调用一个 usage chunk」，dsh 是流式过程中逐步吐。真 dsh 的
  `StreamChunk` 里 `usage` 本来就是**一条**（在 `finish` 之前结算，见
  `packages/llm/llm/src/types.ts` 的 `StreamChunk` 注释「Adapters emit usage before the
  terminal finish and nothing afterward」），所以这不是缩水；差别只在「我们整段文本不回放
  逐 delta 的节奏」。

> 「桥的形状对」不等于「功能对」——只做读侧时成本条仍然是空的，这一条是这轮最大的提醒。

## 7.2 第二轮（当晚）：`session/event` 广播 + 历史改成 dsh 形状 + 用量口径对齐

§7.1 之后还剩三处「安静地不做声」，这一轮全补上。每处都先说清原来错在哪，再说现在怎么给。

### 7.2.1 `session/event`：正在跑的这一轮，插件终于看得见

原来只发 `llm/stream`（一次调用的用量），会话**过程**没人播：`turn/start`、`step/start`、
`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end` 一条都没有。
`dsh-cost-meter` 的统计预热等 `turn/end`、按事件对账的那部分等 `assistant/message` 里的
`usage`——它们不报错，只是永远不触发。

新文件 `src/core/dsh-compat/session-events.ts`：一个会话一座桥，把内核 `CoreEvent` 翻译成
dsh 的 `session/event`（第二个参数是会话载体，第三个是事件）。调用点在
`src/plugins/agent.ts` 的 `emit` 第一行，`publish` 内部整体吞错——广播始终是旁路。

翻译规则里有几处是**按 dsh 的顺序**硬对齐的，值得记住：

- 内核先发 `user` 再发 `turn/start`；dsh 是 `turn/start` 在前。所以回合没开时的用户消息先
  收着，等 `turn/start` 到了再补发（轮中途插话则立刻发，它属于当前回合）。
- 内核先发 `message` 再发 `usage`；dsh 把用量放在 `assistant/message` **同一条**里。所以
  助手消息先压在手里，等紧随其后的 `usage` 到了再一起发；没有用量（端点没报）就在下一条
  事件之前定稿，不吞消息。
- `context`（请求组装完成、流还没开）就是「一步开始」；重试会再来一条 `context`，那时这一步
  的助手消息还没定稿，所以**不另开一步**。

不发什么也写清楚了：dsh 那些我们给不出的（`request/header`、`compaction/summary`、
`assistant/chunk` 逐帧、`system/message`）一律不发，不编。

自检 `node scripts/dsh-session-events-check.mjs`（36 条）：顺序、`seq` 连续、`surfaceOp`
只加在 `user/message` / `assistant/message` / `tool/result` 三类上、重试不另开步、
中止与失败各有 reason、监听器抛错不带崩回合，外加一条**真挂载**（dsh 风格插件
`ctx.on('session/event')` 真的接住，会话 id 经 `session.header.id` 到手）。

### 7.2.2 历史桥原来给的是「我们的行」，不是「dsh 的事件」

`sessionPersistence.open().read()` 原来把 jsonl 原样交出：`user` / `assistant` / `tool`。
看起来「一样有数据」，但 dsh 的插件按**类型**认：`dsh-cost-meter` 的 backfill、
context-costs、trajectory 只认 `assistant/message`（还要 `data.usage` 与
`data.message.source`）。所以它的「历史补账 / 上下文成本」那一半是空转的——和 §7 里成本条
为空是同一类错：**形状差不多**不等于**消费方认**。

现在逐行翻译：`user` → `user/message`（`{id, role, content:[{type:'text'}], source}`），
`assistant` → `assistant/message`（正文 + 推理 + `tool-call` 内容块），
`tool` → `tool/result`（`toolCallId` 与 `source.callId` 成对），`meta` 不再是事件，
`state` 这类自有记录原样透传并标 `ignorable`。用量按时间并进前面最近的
`assistant/message`；并进去了就不再单列。

副作用（是修正，不是退化）：`stat().eventCount` 少了——那是**事件**数，`meta` 本来就不是事件。

### 7.2.3 用量口径：原来的数会把缓存命中算两遍钱

我们这边 `inputTokens` 是 `prompt_tokens` **总量**（缓存命中含在内）；dsh 的分项是**互斥**的：
`inputTokens` 只算未命中，`cacheReadTokens` 单列，计费时三项相加
（`packages/llm/llm/src/types.ts` 的 `TokenUsage` 注释写得很直白）。原来把我们的总量直接
塞进 `inputTokens`，同时又把命中数塞进 `cacheReadTokens`——插件按互斥口径一算，命中那部分
被按未命中价再收了一遍。

现在换算收在 `toDshUsage()`（`llm-usage-event.ts`）一处，两个出口共用：
`inputTokens = 未命中`、`cacheReadTokens = 命中`、`cacheWriteTokens = 0`（我们没有「缓存写入」
这个概念，不编）、`totalTokens = 四项之和`。历史桥也用它，所以「实时」与「补账」两处
对同一个回合报同一个数。

### 7.2.4 一条链路合起来走得通（离线验收）

三条面各自有自检还不够：真插件是**三条一起用**的，接缝上的顺序错照样能全绿。所以加了
`scripts/dsh-compat-live-check.mjs`（19 条）：真内核 + 本地假端点跑一个两步骤的真回合，
一个探针插件同时听 `llm/stream`、`session/event`，并在 `turn/end` 时用
`sessionPersistence` 读回这一轮。断言三件事对得上：事件里的用量 === 流里的用量 ===
历史里的用量，且历史里读得到 `user/message` 与 `assistant/message`。

真包验收（`DSC_REAL_PKG_EXPECT_COSTS=1 node scripts/dsh-real-package-e2e.mjs`）在同一批改动
之后仍然 6/6 全绿——说明新发的 `session/event` 没有把 cost-meter 的监听器带崩。

## 8. 参考

- 判定表：`src/core/dsh-compat/service-map.ts`（`sessions` / `sessionPersistence` 两条）
- 真包验收记录：[development-log.md](development-log.md) 里「真装一个 dsh 组合包」那一节
- 安装路径：[development.md](development.md) 的「dsh 组合包怎么装」
