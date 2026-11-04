# microcompact（旧工具结果清理）

一句话：microcompact 包在每次组装请求时把较旧的工具结果正文换成一句占位符，只改请求体、不动会话日志。

## Model Experience（模型体验）

- 不注册工具、不注册命令：它只往投影链上挂一个 `microcompact` 投影，order 650，夹在环境快照（600）之后、剥图（900）之前（index.ts:42、112-155）。
- 提示词贡献：把较旧的工具结果正文换成 `[旧工具结果已清理: 工具名]` 这类占位符，省下的量随会话增长，等于被替换正文的长度（microcompact.ts:21-33）。
- 跳过规则：最近 5 条、失败或被拒的调用、带图、已落盘、已是占位符、单条省不到 256 token 的一律不碰（index.ts:64-70、microcompact.ts:51-58）。
- 门槛：一轮能清掉的字符占整段提示词不到 25% 时一条都不清，把这一轮冻结成空计划，等下一轮攒多了再动（index.ts:123-128、220-230）。
- 对外提供 `microcompact` 服务：压缩插件在爆窗重试前先问它「清理之后装不装得下」，装得下就不去牺牲历史压摘要（index.ts:15-16、166-179）。
- 停用之后，模型侧少掉那些占位符：旧工具结果全文每轮照发，长会话输入 token 明显变多；会话日志本来就不受影响（文件头 13）。

## Known Limitations（已知限制）

- 默认 `refresh: round`，一轮只清一次：同一轮里刚滑出窗口的结果这轮不清，换的是前缀稳定与服务端缓存命中（index.ts:57-61、135-146）。
- 清掉的就是证据：被换成占位符的正文模型再也读不到，要原文只能重跑一次工具（microcompact.ts:11-12）。
- 估算服务拿不到会话，失败集合按空集算，因此 `projectedTokens` 偏保守：更容易判「装不下」，不会误判成装得下（index.ts:158-165）。
- 三个可调值都有硬区间：keepRecent 1..50、minSaveTokens 0..4000、minFreePercent 0..80，超出的被夹回（index.ts:73-76）。
- 冻结表最多记 64 个会话，超过就删最早登记的那一条（index.ts:147-151）。

## 行与开关

- 行 id `microcompact`，包名 `@pneuma/microcompact`，order 210。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认开：`cordis.patch.yml` 里没有 `disabled`，配置默认值 `enabled: true`（index.ts:68）。
- inject 三个服务：`prompt`、`settings`、`session`（index.ts:96）。
- 设置分区 id `microcompact`，order 36，五项：总开关、清理时机、保留条数、单条门槛、总门槛（index.ts:183-270）。
