# subagent（子智能体与任务板）

一句话：模型把能独立完成的活派给队友；队友是另一个 MiniAgent 实例 + 自己的会话文件 + 一份开工时冻结的工牌（工具白名单、审批意愿、轮次预算与模型）。包里另带一块按会话分开的共享任务板（`team_task`），2026-11-06 由原「共享任务板」插件并入。

## Model Experience（模型体验）

- 默认关闭；打开且 `allowDelegation` 为真时，模型多出 `subagent` 工具（spawn / list / message / interrupt / stop）与一段角色目录提示词（index.ts:1086-1107、1255-1264）。
- `board` 打开时多出 `team_task` 工具与「共享任务板」提示段；两个开关各管一半（index.ts:1236-1275）。
- **协作工具不受角色白名单限制**：`team_task` 在 `COLLAB_TOOL_NAMES` 里，`toolsFor` 筛队友工具表时对它放行——白名单表达的是「能改哪些文件、能跑什么命令」，任务板是一次协作登记（risk 为 read），不该因为角色写了 `tools: read, glob, grep` 就一起关掉（2026-11-08 修：explorer 队友曾回「只有 read、glob、grep」而领不到任务）。
- 子智能体的提示段会提一句 `team_task`：两个包分开时子智能体提示不提板子，模型就不会去用（index.ts:1248-1264）。
- 上下文两档：`fresh` 只知道任务，`fork` 额外带到父会话的上一个完整回合（index.ts:1043-1050）。
- **一次性（`keep: false`）**：干完就从在队表里摘掉、不再接传话，名册留一条记录供查看。语义照抄 dsh 的 `one-shot`，但触发方式不同——dsh 由子代理后端决定（外部 CLI 后端那类），dsc 只有本地后端，所以做成派活时的显式选择。`list` 会给在队的一次性加标注。
- 后台队友干完的汇报会自动接进 Lead 的下一轮；`quiet` 模式只写进会话，等用户下次说话（index.ts:69、275、731）。
- 工牌开工即冻结：工具白名单、审批意愿、轮次预算、模型中途改角色文件只影响下一个队友（index.ts:12-14）。
- **轮次预算三档**：角色文件显式 `max-turns`（写 0 也算显式，表示不限）> 设置页「默认最大轮次」里该角色的值 > 全局轮次上限（大于 0 时取更严）。名册提示与队友开工冻结的工牌都走同一个 `resolveMaxTurns`，所以提示里写的轮次就是实际给的（index.ts:154-173 解析、770-774 冻结工牌）。
- **模型与思考强度可选（需用户授权）**：设置页「队友模型」打开开关并勾选授权清单后，spawn 可以带 `model`（只能用 `parseModelRef` 归一成 `端点/模型`，且必须落在清单里）与 `effort`（default / off / low / high / max）；开关关闭时带 `model` 直接拒绝并指路去设置页。优先级：spawn 显式 > 角色文件 `model` > 旧配置 `defaultModel`（兼容兜底）> 跟随当前会话；`effort` 为 spawn > 角色文件 > 跟随模型默认。工牌开工冻结，名册提示只列授权清单内的模型，队友系统提示不列清单（index.ts:224-345 解析、944-947 冻结、564-573 与 1017 两处提示）。
- 审批取全局上限与角色意愿里更严的那个，弹卡时写明是谁在请求（index.ts:15-16）。
- 另有一条只读审查通道：`review` 派 read/glob/grep、approval 固定 forbid 的队友，findings 写回发起会话（index.ts:850-932）。

## Known Limitations（已知限制）

- 默认参数：同时 4 个队友、递归 1 层、审批 forbid、默认轮次 critic 16 / reviewer 64 / writer 128 / explorer 不限、模型选择关闭、任务板开（index.ts:110-137）。
- **旧配置兼容**：设置页不再展示 `defaultModel`（换成「允许 Agent 为子队友选择模型」+ 授权清单），但存量 `defaultModel` 仍作为 spawn 显式与角色文件之后的兜底读取，升级不丢模型设置。授权清单里的模型若被从端点里删掉，配置仍保留（不自动清空）；端点恢复后这一项自动回到清单里（index.ts:224-237）。
- 队友看不到你与用户的对话；fork 也只到上一个完整回合（index.ts:1043-1050）。
- 并发满直接拒绝、不排队；递归层级最多 2（index.ts:273）。
- 收工队友在名册里最多留 12 个，超了挤掉最老的（index.ts:116）。
- 一次性子智能体同样占名册那 200 条上限，被挤掉后记录文件还在盘上、界面里却找不到了；这条老问题没动。
- 关掉 `allowDelegation` 只撤 `subagent` 工具与名册提示，已经在跑的队友会把当前这轮跑完，任务板照常；关掉 `board` 只撤 `team_task` 与板子提示，派活、汇报与名册照常（index.ts:1236-1275）。
- 名册在 `~/.dsc/team/roster.json`，队友会话存在 `sessions/.teammates/` 下，不是普通会话（index.ts:288；core/session.ts:1363-1364）。
- 任务板每个会话各一块（`~/.dsc/team/boards/<会话 id>.json`），切会话就是另一块板；清空只清当前会话（core/team-board.ts:22-24、85-88）。
- **板子归属按发起调用的会话算，不看「当前查看的会话」**：队友转发 `team_task` 时由 `toolsFor` 塞 `caller.sessionId`（= 派它的那个会话），主会话自己的调用回落工具上下文的 `sessionId`。后台队友跑着、用户切走之后，认领仍落在自己那块板上（2026-11-08 修）。
- 嵌套派活同理：队友自己派出的子队友，父会话是这个队友自己的会话（`runSubagent` 的 `parent` 参数由调用方给），名册过滤与汇报都按它算。

## 行与开关

- 行 id `subagent`，包名 `@pneuma/subagent`，order 3600（package.json:24-34）。
- resolution 是 overridable，默认关闭（package.json:25-29；cordis.patch.yml 的 `disabled: true`）。
- inject 八个服务：`session`、`tools`、`llm`、`approval`、`transcript`、`prompt`、`settings`、`agent`（index.ts:260）。
- provide 两个：`team`（名册 / 停止 / 传话 / 移除）与 `review`（index.ts:841、932）。
- 设置分区 id `subagent`，order 40；三组：`turns`「默认最大轮次」（四个内置角色各一个 `roleTurns.<角色>` 数字项，0–200，0 = 不限）、`models`「队友模型」（`allowModelSelection` 开关 + `allowedModels` 分组多选，清单来自 `ctx.llm.listModels()` 按端点显示名分组）与 `board`「任务板」（`board` 开关、板子目录与「清空本会话任务板」）（index.ts:1853-2045）。
- **模型授权保存校验**：开关开着却一个模型都没勾（两个方向：开开关、清空清单）都会被拒并给失败文案，落盘是 `plugins.json` 的 `subagent.config.allowedModels` 扁平字符串数组（index.ts:2009-2020；locale 的 `save.needAllowedModel`）。
- **旧安装迁移**：插件启动时把内置角色文件里仍等于旧出厂默认的 `max-turns` 删掉（critic 4 / reviewer 16 / writer 20），让设置页的按角色默认值生效；用户改过的值保留。迁移幂等、只碰这三个内置文件名、任何异常都不影响启动（agent-roles.ts:187-244）。
