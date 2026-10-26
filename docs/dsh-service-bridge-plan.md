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

事件怎么来：会话 jsonl 的一行算一个事件（按时间排序后编 `seq`），`~/.dsc/usage/usage.jsonl`
里的请求行按 `sid` 归到会话上、类型标成 `llm/usage`（带 inputTokens / outputTokens /
cacheReadTokens / cacheWriteTokens）；工具行不带 token，不当事件。

自检：`node scripts/dsh-session-bridge-check.mjs`（32 条，含「不声明 inject 的插件在 apply 里
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

- 我们只发 `llm/stream`，没发 `session/event`。费用条有数了；如果哪天插件依赖
  `session/event` 做别的事（它是会话内事件流），再补。
- 我们发的是「一次调用一个 usage chunk」，dsh 是流式过程中逐步吐。插件只认最后一个有效
  usage，等价；但若将来有插件按增量累加，这里要改成按帧发。

> 「桥的形状对」不等于「功能对」——只做读侧时成本条仍然是空的，这一条是这轮最大的提醒。

## 8. 参考

- 判定表：`src/core/dsh-compat/service-map.ts`（`sessions` / `sessionPersistence` 两条）
- 真包验收记录：[development-log.md](development-log.md) 里「真装一个 dsh 组合包」那一节
- 安装路径：[development.md](development.md) 的「dsh 组合包怎么装」
