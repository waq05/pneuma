# ui-status（状态面板）

一句话：ui-status 是状态面板这个界面单元的宿主半：一块可收成胶囊的浮层，分八区报 Git 改动、目标、计划、进程、终端、定点任务、子智能体与智能体团队。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:29；ui/ui.tsx 只有一个槽条目，另报名一个 dock 页签）。
- 它读的全是模型跑出来的副作用：`surfaces.goal` / `todos` / `planDirectory` / `backgroundWorks` / `scheduled`，以及界面通道的 `listTeammates` 与 `listTeamBoard`。
- 用户在这里能停掉模型起的后台作业、清空清单、暂停或恢复目标；后两项改的是目标与清单本身，模型下一轮的续跑与清单提醒因此变化（ui/ui.tsx:1004、1015；goal/index.ts:114-117）。
- 停用后模型侧不变，界面少了这块总览（index.ts:7-9）。

## Known Limitations（已知限制）

- 宽度 1280px 以下自动收成胶囊；860px 以下没有顶栏页签行，浮层回落正文区右上角（ui/ui.tsx:20-21、33-34、147-148）。
- 定点任务区绑的是 schedule 插件，它默认关着时整区不渲染（ui/ui.tsx:48-49）。
- 不是仓库、或干净到没有一行改动时，Git 区整块不画（ui/ui.tsx:41-42）。
- **「子智能体」区**：一行一个队友（状态点 + 名字 + 角色 + 状态词），点一行经 team 插件的 `teammateReader` 服务在正文区只读打开它的完整运行记录；还在跑的由那个服务当场回绝并给一句人话。一条队友都没有时**整区不画**（没有空态文案）；服务缺席（team 没装）时点行退回右侧栏的子智能体页签。
- **「智能体团队」区**：共享任务板只读列表（任务标题 / 负责人 / 状态，展开看描述、依赖与预计改动路径）。板子按会话各一块，切会话换一块；一条任务都没有时整区不画。面板不提供认领 / 结项按钮，改任务仍旧只走模型的 `team_task` 工具（与 dsh 同一条边界）。
- 两区是两件事，互不顶替：子智能体说「谁在跑」，智能体团队说「有哪些事、谁负责」。
- 进程区超过 6 条只留当前项前后连续 3 条，其余折成折叠桶（ui/ui.tsx:23-24）。
- 胶囊位置存 localStorage（`dsc.statusPanel.pos`），换浏览器回到默认位（ui/ui.tsx:35、165）。

## 行与开关

- 行 id `ui-status`，包名 `@pneuma/ui-status`，order 362（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.9.0`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务（index.ts:29）。
- 槽条目 `shell.main`、order 5；浮层 portal 到顶栏页签行（ui/ui.tsx:339、28-35）。
- 停用后内置产物被滤掉，这块总览连同「子智能体」「智能体团队」两区一起消失。
