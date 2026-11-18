# microcompact（旧工具结果清理）

一句话：microcompact 包在每次组装请求时把较旧的工具结果正文换成一句占位符，只改请求体、不动会话日志。

## Model Experience（模型体验）

- 不注册工具、不注册命令：它只往投影链上挂一个 `microcompact` 投影，order 650，夹在环境快照（600）之后、剥图（900）之前。
- 提示词贡献：把较旧的工具结果正文换成 `[旧工具结果已清理: 工具名]` 这类占位符，省下的量随会话增长，等于被替换正文的长度（`placeholderFor`）。
- 跳过规则：最近 5 条、失败或被拒的调用、带图、已落盘、已是占位符、单条省不到 256 token 的一律不碰（`microcompact()`）。
- 门槛：一次清理能省掉的字符占整段提示词不到 25% 时一条都不清，把这次冻结成空计划，等攒多了再动（`planWorthApplying`）。
- 清理时机三档（`refresh`，默认 `budget`）：`budget` 每次进入新一轮只累计可省字符，新增条目合计省够 8192 字符才把清理点推进一次，其余时间一直应用同一份已生效计划；`round` 是每轮重算一次（旧默认）；`request` 是每次请求都重算（旧行为，最省上下文、前缀最碎）（`DEFAULTS`、`advanceMicrocompactPlan`）。
  - 取舍是同一笔账：命中的 token 只按约 1/10 价收，断一次却把清理点之后整段按全价重读，所以 `budget` 宁可让旧结果多留几轮、攒着推。
- 对外提供 `microcompact` 服务：压缩插件在爆窗重试前先问它「清理之后装不装得下」，装得下就不去牺牲历史压摘要（`projectedTokens`）。
- 停用之后，模型侧少掉那些占位符：旧工具结果全文每轮照发，长会话输入 token 明显变多；会话日志本来就不受影响。

## Known Limitations（已知限制）

- 默认 `refresh: budget`：清理点只在攒够 8192 字符时往前挪一次，同一轮内逐字节冻结；代价是刚滑出窗口的结果可能多留几轮（`advanceMicrocompactPlan`）。
- 清掉的就是证据：被换成占位符的正文模型再也读不到，要原文只能重跑一次工具。
- 估算服务拿不到会话：失败/被拒结果按空集算（失败结果也按会清算），也看不到会话里冻结的 activePlan。两处都让 `projectedTokens` **可能比真正发出的投影更小**——方向是估小/乐观，不是偏保守；极端情况下「清理后装得下」的短路会误判成装得下，最后仍抛原来的爆窗错，而不是去压摘要。与旧 `round` 档同一口径。
- 三个可调值都有硬区间：keepRecent 1..50、minSaveTokens 0..4000、minFreePercent 0..80，超出的被夹回（`KEEP_RECENT_RANGE` / `MIN_SAVE_RANGE` / `MIN_FREE_RANGE`）。
- 冻结表（budget 的 activePlan 与 round 的冻结计划共用）最多记 64 个会话，超过就删最早的非当前会话（`SESSION_LIMIT`）。
- `refresh` 只认 `budget` / `round` / `request` 三档，手改 `plugins.json` 写歪了回落默认（`REFRESH_MODES`）。

## 行与开关

- 行 id `microcompact`，包名 `@pneuma/microcompact`，order 210。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认开：`cordis.patch.yml` 里没有 `disabled`，配置默认值 `enabled: true`（`DEFAULTS`）。
- inject 三个服务：`prompt`、`settings`、`session`（`microcompactPlugin.inject`）。
- 设置分区 id `microcompact`，order 36，五项：总开关、清理时机、保留条数、单条门槛、总门槛（`section.fields`）。
