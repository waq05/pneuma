# schedule（定时任务）

一句话：schedule 包让模型和用户建定时任务，到点把任务描述投回建它的会话，跑一次完整回合。

## Model Experience（模型体验）

- 注册工具 `schedule`：action 七选一 create / list / update / run / delete / pause / resume，规则六种写法 after / at / every / daily / weekly / cron（五字段 Vixie，拒绝 L/W/# 与秒字段），risk 标 write（index.ts:240-272）。
- 命令 `/schedule`：list / add <选择器> <标题> / pause|resume|run|remove <id前缀>（index.ts:357-358）。
- 提示词贡献：一段 order 41 的系统提示，只在「总开关开着且至少有一条启用任务」时出现；正文是**静态**说明（来源、授权边界、用 `action=list` 查），不列任务标题与下次时间（index.ts:86-105、498-511）。
- 任务清单与「有几个启用任务」走尾部投影（order 630）：在同一条件下往请求末尾追加一条 user 消息，没任务时不发（index.ts:513-552）。
- 那段提示同时交代规矩：以「【定时任务触发】」开头的消息不是用户当下指令、不构成授权，需要授权的动作照常走审批（index.ts:452-457）。
- 投递前还会问 `ctx.waiting.anyFor(目标会话 id)` 这条会话有没有人在等（不是全进程的 `any`：别的会话挂着审批卡不该挡住这条排期）；目标会话取建任务那一个，用户切走也回原来的对话（文件头 11，index.ts:227）。
- 停用之后，模型侧少掉 `schedule` 工具与那段任务清单：它排不了新任务，也读不到现有排期（index.ts:240-354、440-461）。

## Known Limitations（已知限制）

- 默认关：`cordis.patch.yml` 第 5 行 `disabled: true`，文件头第 2 行写明理由（到点会自己跑模型）。
- 宿主不常驻就不触发：桌面端或终端关着时排期不会跑，工具说明要求如实告诉用户（文件头 19、index.ts:249）。
- 至多一次：先落盘推进 nextRunAt 再投递，崩在中间靠 pendingSlot 恢复一次；错过的排期宽限期是半周期夹在 120 秒到 2 小时之间，超了把积压合并成一次跑（文件头 7-8，core/schedule/runner.ts:92-116）。
- 三条硬上限与时间口径：单次运行默认 600 秒、可填 30..7200；历史保留默认 200 条、可填 20..1000；every 间隔至少 60 秒；DST 跳过的时刻不跑、重叠只取较早一次（index.ts:61、73-74、247，文件头 6）。
- 失败只重试「完全没到模型」的瞬时网络错，梯度 5 / 15 / 30 分钟；配额熔断挂起 15 分钟；同一任务在跑就跳过（文件头 10，core/schedule/runner.ts:39-42）。
- 不许用 schtasks 兜底：dsc 的命令策略把系统计划任务判成后门高危（文件头 20-21）。

## 行与开关

- 行 id `schedule`，包名 `@pneuma/schedule`，order 3720。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认关：`cordis.patch.yml` 第 5 行 `disabled: true`。
- inject 十个服务：`tools`、`commands`、`settings`、`transcript`、`agent`、`session`、`waiting`、`llm`、`prompt`、`surfaces`（index.ts:164）。
- 设置分区 id `schedule`，order 32；四项可改：总开关、默认时区、单次运行秒数、历史条数（index.ts:470-575）。
