# subagent（子智能体与任务板）

一句话：模型把能独立完成的活派给队友；队友是另一个 MiniAgent 实例 + 自己的会话文件 + 一份开工时冻结的工牌（工具白名单、审批意愿、轮次预算与模型）。包里另带一块按会话分开的共享任务板（`team_task`），2026-11-06 由原「共享任务板」插件并入。

## Model Experience（模型体验）

- 默认关闭；打开且 `allowDelegation` 为真时，模型多出 `subagent` 工具（spawn / list / message / interrupt / stop）与一段角色目录提示词（index.ts:1086-1107、1255-1264）。
- `board` 打开时多出 `team_task` 工具与「共享任务板」提示段；两个开关各管一半（index.ts:1236-1275）。
- 子智能体的提示段会提一句 `team_task`：两个包分开时子智能体提示不提板子，模型就不会去用（index.ts:1248-1264）。
- 上下文两档：`fresh` 只知道任务，`fork` 额外带到父会话的上一个完整回合（index.ts:1043-1050）。
- 后台队友干完的汇报会自动接进 Lead 的下一轮；`quiet` 模式只写进会话，等用户下次说话（index.ts:69、275、731）。
- 工牌开工即冻结：工具白名单、审批意愿、轮次预算、模型中途改角色文件只影响下一个队友（index.ts:12-14）。
- 审批取全局上限与角色意愿里更严的那个，弹卡时写明是谁在请求（index.ts:15-16）。
- 另有一条只读审查通道：`review` 派 read/glob/grep、approval 固定 forbid 的队友，findings 写回发起会话（index.ts:850-932）。

## Known Limitations（已知限制）

- 默认参数：同时 4 个队友、递归 1 层、审批 forbid、轮次不限、任务板开（index.ts:102-111）。
- 队友看不到你与用户的对话；fork 也只到上一个完整回合（index.ts:1043-1050）。
- 并发满直接拒绝、不排队；递归层级最多 2（index.ts:273）。
- 收工队友在名册里最多留 12 个，超了挤掉最老的（index.ts:116）。
- 关掉 `allowDelegation` 只撤 `subagent` 工具与名册提示，已经在跑的队友会把当前这轮跑完，任务板照常；关掉 `board` 只撤 `team_task` 与板子提示，派活、汇报与名册照常（index.ts:1236-1275）。
- 名册在 `~/.dsc/team/roster.json`，队友会话存在 `sessions/.teammates/` 下，不是普通会话（index.ts:288；core/session.ts:1363-1364）。
- 任务板每个会话各一块（`~/.dsc/team/boards/<会话 id>.json`），切会话就是另一块板；清空只清当前会话（core/team-board.ts:22-24、85-88）。

## 行与开关

- 行 id `subagent`，包名 `@pneuma/subagent`，order 3600（package.json:24-34）。
- resolution 是 overridable，默认关闭（package.json:25-29；cordis.patch.yml 的 `disabled: true`）。
- inject 八个服务：`session`、`tools`、`llm`、`approval`、`transcript`、`prompt`、`settings`、`agent`（index.ts:260）。
- provide 两个：`team`（名册 / 停止 / 传话 / 移除）与 `review`（index.ts:841、932）。
- 设置分区 id `subagent`，order 40；「任务板」是一组（`group: 'board'`），里面是 `board` 开关、板子目录与「清空本会话任务板」（index.ts:1329-1406）。
