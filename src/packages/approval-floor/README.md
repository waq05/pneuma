# approval-floor（危险命令硬拦截）

一句话：approval-floor 包在守卫链 order 5 上拦下灾难性命令、用户黑名单里的字符串与无人值守时的越界写，比权限模式和审批卡都早一步。

## Model Experience（模型体验）

- 不注册工具：它只往守卫链注册一位守卫（index.ts:64-65），位置在模式 10、安全钩子 20、审批 30 之前（index.ts:81）。
- 提示词贡献为零：没有 `ctx.prompt` 调用，也不写环境事实。
- 模型能看见的只有拒绝理由：deny 的 reason 原样回给模型，例如「命令命中用户 deny 黑名单（*.env）」「配置读不通，按最严处理一律拒」（core/approval-floor.ts:762、924）。
- 白名单不是放行：命中白名单只返回 defer，再由审批层免卡通过；它从不返回 pass，免得把中间的安全钩子一起跳掉（index.ts:7、core/approval-floor.ts:19-20）。
- 停用之后，模型侧少掉：灾难命令与黑名单命令的当场拒绝，这些命令改由权限模式与审批卡裁决。

## Known Limitations（已知限制）

- 只判「拒」或「不拒」：白名单之外的放不放行由审批环节决定，地板看不到最后怎么裁（index.ts:167）。
- 看不懂脚本内部做什么：它只按命令文本与写目标判，命令超过长度上限（默认 4000 字、可调 100~100000）直接按「看不清要跑什么」拒（core/approval-floor.ts:118、724）。
- 白名单还要过结构关：命令里有管道、分号、子 shell、变量、重定向或引号时一律不走白名单，白名单里的 `*` 只能放末尾（index.ts:134）。
- 熔断只统计地板自己的拒，审批层拒的不计入，所以连撞审批不会触发它（index.ts:167）。
- 配置读不通时一律拒，并往界面发一条提示，不静默放过（index.ts:253-256）。

## 行与开关

- 行 id `approval-floor`，包名 `@pneuma/approval-floor`，order 3640。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 三个服务：`guards`、`commands`、`settings`（index.ts:54）。
- provide 一个服务 `approvalFloor`，只交出白名单判定与条数（index.ts:68-71）；命令 `/floor` 看规则与熔断状态（index.ts:100-105）；设置分区 id `approval-floor`、order 33（index.ts:110-114）。
- 配置在 `~/.dsc/plugins.json` 的 `approval-floor` 条目；默认 16 条白名单前缀、16 条 deny 通配（core/approval-floor.ts:45-86），熔断默认连续 5 次拒、冷却 60 秒（core/approval-floor.ts:119-121）。
