# ui-transcript（消息流）

一句话：ui-transcript 是「会话流」这个界面单元的宿主半，在对话主区把会话条目画成一排排座位与行。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词：宿主半只有空 `apply`，界面半报名 `shell.main` 槽（带 toolview 选举链）与只读子智能体流槽（index.ts:32，ui/ui.tsx:67-93）。
- 模型每一步都在这里留痕：正文、思考、工具卡、计划卡、子代理卡、system 行各走一条渲染（ui/ui.tsx:5-16、97）。
- 折叠只改「人怎么看」：定稿轮的过程收成一行「用时 X」，展开后仍是原条目，不碰模型上下文（ui/ui.tsx:11-15）。
- 停用后模型照常跑，对话主区空掉（`shell.main` 只有这一条）；折叠与快照服务仍在 `@pneuma/transcript`（index.ts:9-12）。

## 面板与数据

- 快照面：`readEntries` / `readLive` / `readTurnState` / `readCompactingSince` / `readSessionPath` / `readCwd` / `readSessions`（ui/ui.tsx:108-115、447）。
- 界面通道：`getUiPrefs` 读折叠与提醒偏好，`forkSession` / `openSession` / `refreshSessions` 分叉一轮，`rewindSession` / `submit` 编辑重发（ui/ui.tsx:136-155、323-330、368-375）。
- 服务：`composerDraft` 往输入框写首屏卡片，`actions` 登记四张提示词卡，`transcriptFlow` 把只读子智能体流交给团队右栏（ui/ui.tsx:83-93、423-443）。
- 分页只切画不画：尾部一页 ≥50 条且 ≥2 轮、最多 500 条，边界对齐轮起点（ui/paging.ts:2-3、24-31）。

## Known Limitations（已知限制）

- 旧界面的吸附快捷栏没搬；长会话的跨轮跳转由右侧 JumpRail 负责（ui/ui.tsx:18-20，ui/jump-rail.tsx:1-4）。
- JumpRail 用 portal 挂到 `.chat-wrap`，依赖壳的 DOM 里存在 `.chat`（ui/jump-rail.tsx:16-18）。
- 跟随贴底的阈值是 24px、落定 180ms，与 dsh 的 25px / 500ms 不完全同档（ui/follow.ts:10-14）。
- 单轮超过 500 条时整轮放进来，这一页会超上限；轮内靠阶段组限高顶着（ui/paging.ts:47-51）。
- 编辑重发要求会话已落盘：新会话第一条消息落盘前点编辑，只提示先发一条（ui/ui.tsx:361-363）。
- 回合完成的通知只在桌面原生桥可用；浏览器里只剩提示音（ui/ui.tsx:169-181）。

## 行与开关

- 行 id `ui-transcript`，包名 `@pneuma/ui-transcript`，order 368（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.8.1`，没有 phase 与 inject（package.json:20-25）。
- 宿主半 inject 零个服务：`apply` 是空的（index.ts:32）。
- 停用后对话主区不再画会话流，输入区仍在；团队右栏的 `transcriptFlow` 缺席，退回简版 PeekView（ui/ui.tsx:83-86，ui-team/ui/ui.tsx:745）。
