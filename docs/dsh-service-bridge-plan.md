# dsh 服务桥：为什么它还没做，以及做的时候怎么做

> 状态：**未开工**（2026-10-26 记录）。这是 dsh 插件适配剩下的最后一项，也是唯一一项
> 「装得上但用不起来」的根因。本文只写清楚边界与做法，不写「已完成」。

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

## 3. 为什么不在一批里做完

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

## 4. 要做的时候怎么做（三步，可按需切）

**第一步：读侧最小面（1 批）**

- 新 `src/core/dsh-compat/session-bridge.ts`：把 Pneuma 的会话列表映射成 dsh 的
  `list()` / `stat(id)`；`open(id)` 返回只读句柄，`read({throughSeq, beforeSeq, maxMessages})`
  按行分页（Pneuma 的 jsonl 行号即 seq）。
- 事件形状：`user`/`assistant`/`tool` 行直接映射成最小事件（`type` + 载荷 + `seq`）；
  **usage 事件由 `~/.dsc/usage/usage.jsonl` 合成**（按 `sid` 聚合，时间戳当 seq 排序键）。
- 写方法（`create` / `append`）一律抛一条中文错误：「dsh 的会话写句柄在 Pneuma 里不可用，
  会话由内核独占写入」。
- 注册进兼容层 ctx（`get` 能取到），仍走 `service-map.ts` 的口径。

**第二步：`sessions` 注册表（同一批）**

- `get(id)` 返回 `SessionRecord`；`list()` 给当前工作区的会话（Pneuma 已有这一份数据）。
- 不要实现 fork / prompt / 迁移那些——它们属于写侧。

**第三步：用真包验收（必须做，否则不算完成）**

- 装 `dsh-cost-meter` 到隔离 profile，跑一轮带工具的真实对话（`scripts/_fake-llm.mjs` 可以
  点名工具），断言成本条出现非零数字。
- 拿不到真包时，退而求其次：写一个**模仿它调用序列**的探针插件（`ctx.get('sessionPersistence')`
  → `list` → `stat` → `open` → `read`），断言每一步都给得有道理。这只是必要条件，不是充分条件。

## 5. 现在能给的替代

- 想看在用多少 token：设置里的「用量统计」（`usageStats()`）与状态栏用量已经有数；
- 想看单个会话的花费：`~/.dsc/usage/usage.jsonl` 里有逐次调用的 `i`/`o`，可按 `sid` 汇总。

## 6. 参考

- 判定表：`src/core/dsh-compat/service-map.ts`（`sessions` / `sessionPersistence` 两条）
- 真包验收记录：[development-log.md](development-log.md) 里「真装一个 dsh 组合包」那一节
- 安装路径：[development.md](development.md) 的「dsh 组合包怎么装」
