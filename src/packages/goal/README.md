# goal（会话目标）

一句话：goal 包保存一个跨轮次的会话目标，本轮干净结束后自动接着往下跑，跑满轮次上限就停下等用户处理。

## Model Experience（模型体验）

- 注册工具 `goal`：`action=create` 建目标、`complete` 报完成、`blocked` 报阻塞；暂停、恢复、放宽上限只能由用户用 `/goal` 做（index.ts:134-180）。
- 自动续跑的载荷：`dsc/turn-end` 且 reason 为 completed 时，若目标还 armed，就补一条 user 消息继续（index.ts:225-235）；文本写明第几轮，并要求「用证据验证过才调 complete」（index.ts:124-128）。
- 轮次上限：新建目标默认 24 轮（goal.ts:27），硬顶 256 轮（goal.ts:30），配置只能在范围内放宽。
- 有卡挂着就不推：`ctx.waiting.any` 为真时 `takeGoalRound()` 直接返回 null（index.ts:114-117）。
- 提示词贡献：压缩时原样带过去一句目标（index.ts:184-188），另有 `goal` 快照投影给界面（index.ts:132）。
- 停用之后，模型侧少掉：`goal` 工具、每轮结束后的续跑消息、以及压缩时那句目标原文。

## Known Limitations（已知限制）

- 不隔会话点火：切会话或恢复历史会话后 armed 为 false，要用户亲自点继续才续跑（文件头 7、goal.ts:61-62）。
- 续跑只认当前查看会话的回合结束：后台 agent 的 turn-end 被挡掉（index.ts:227-228）。
- 轮次上限不能取消，只能放宽到 256（index.ts:47-48）。
- 清空目标也要往日志写一条 `goal = null`，否则重启重放会把旧目标读回来（index.ts:70-76）。
- 与 dsh 同族能力的差异：待确认，本包代码里没有与 dsh 的对照说明。

## 行与开关

- 行 id `goal`，包名 `@pneuma/goal`，order 270。
- resolution 是 overridable：profile 里同名的新版本可以覆盖它（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 九个服务：`session`、`tools`、`commands`、`agent`、`transcript`、`surfaces`、`waiting`、`compact`、`settings`（index.ts:55）。
- 设置分区 id `goal`，order 36，两项：新目标缺省轮次 1..256、点一次「加轮次」加 1..64 轮（index.ts:243-285）。
