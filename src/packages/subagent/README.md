# subagent（子智能体）

一句话：模型把能独立完成的活派给队友；队友是另一个 MiniAgent 实例 + 自己的会话文件 + 一份开工时冻结的工牌（工具白名单、审批意愿、轮次预算与模型）。

## Model Experience（模型体验）

- 默认关闭；打开且 `allowDelegation` 为真时，模型多出 `subagent` 工具（spawn / list / message / interrupt / stop）与一段角色目录提示词（index.ts:1058-1106）。
- 上下文两档：`fresh` 只知道任务，`fork` 额外带到父会话的上一个完整回合（index.ts:1071、1102）。
- 后台队友干完的汇报会自动接进 Lead 的下一轮；`quiet` 模式只写进会话，等用户下次说话（index.ts:61-62、1054）。
- 工牌开工即冻结：工具白名单、审批意愿、轮次预算、模型中途改角色文件只影响下一个队友（index.ts:12-14）。
- 审批取全局上限与角色意愿里更严的那个，弹卡时写明是谁在请求（index.ts:15-16）。
- 另有一条只读审查通道：`review` 派 read/glob/grep、approval 固定 forbid 的队友，findings 写回发起会话（index.ts:815-904）。

## Known Limitations（已知限制）

- 默认参数：同时 4 个队友、递归 1 层、审批 forbid、轮次不限（index.ts:76-84）。
- 队友看不到你与用户的对话；fork 也只到上一个完整回合（index.ts:1071、1102）。
- 并发满直接拒绝、不排队；递归层级最多 2（index.ts:1119-1120）。
- 收工队友在名册里最多留 12 个，超了挤掉最老的（index.ts:88-89）。
- 关掉 `allowDelegation` 只撤工具与提示词；已经在跑的队友会把当前这轮跑完（index.ts:1116-1117）。
- 名册在 `~/.dsc/team/roster.json`，队友会话存在 `sessions/.teammates/` 下，不是普通会话（index.ts:260；core/session.ts:1350-1351）。

## 行与开关

- 行 id `subagent`，包名 `@pneuma/subagent`，order 3600（package.json:10-18）。
- resolution 是 overridable，默认关闭（package.json:15；cordis.patch.yml 的 `disabled: true`）。
- inject 八个服务：`session`、`tools`、`llm`、`approval`、`transcript`、`prompt`、`settings`、`agent`（index.ts:233）。
- provide 两个：`team`（名册 / 停止 / 传话 / 移除）与 `review`（index.ts:813、904）。
- 设置分区 id `subagent`，order 40（index.ts:1155-1222）。
