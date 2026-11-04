# ui-tasks（任务与目标）

一句话：ui-tasks 是输入框上方那条会话目标条的界面单元——任务清单条已经撤掉，清单现在只在状态面板的「进程」区里。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:29；ui/ui.tsx:24 只有一个槽条目）。
- 目标条读 `surfaces.goal`，就是 goal 插件登记的那块（ui/ui.tsx:4-5、38）。
- 四颗按钮 pause / resume / clear / extend 走 `goalAction`（ui/ui.tsx:51-55、74-88）；暂停后自动续跑停下，模型下一轮不再被自动叫醒（goal/index.ts:114-117）。
- 停用后模型侧不变，少的只是这条目标条（index.ts:7-9）。

## Known Limitations（已知限制）

- 没设目标整条不渲染（ui/ui.tsx:5-6、40）。
- 只有目标，没有任务清单：TaskDock 已撤销，清单归状态面板的进程区（ui/ui.tsx:10-12）。
- 目标正文过长时只显示一行，全文挂在 `title` 上（ui/ui.tsx:61）。
- 目标被阻塞时把 `blockedReason` 当 `title`，界面上只显示状态与轮数（ui/ui.tsx:61-66）。
- 「放宽轮次」只在阻塞原因是「轮次已达上限」时出现，一次加 `extendRoundsBy` 轮（默认 8，可配 1..64；ui/ui.tsx:81-85、goal/index.ts:38、49、105）。

## 行与开关

- 行 id `ui-tasks`，包名 `@pneuma/ui-tasks`，order 364（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.8.1`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务（index.ts:29）。
- 槽条目 `shell.composer`、order 22，排在审批、计划、提问卡（10）之后、输入框（50）之前（ui/ui.tsx:23-24）。
- 停用后目标条不出现，目标本身仍在 goal 插件里照常续跑（index.ts:7-9）。
