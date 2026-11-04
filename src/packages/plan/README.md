# plan（计划交付）

一句话：plan 包提供 `exit_plan_mode` 工具与它的评审卡，把模型写的方案落成文件、挂起等用户批准。

## Model Experience（模型体验）

- 注册工具 `exit_plan_mode`：参数 `plan` 是计划全文（markdown，第一行是 # 标题），工具把它写进 `.dsc/plans/` 下的 .md 再弹评审卡，risk 标 read（index.ts:170-207）。
- 批准后自动 `setMode('build')`，并在返回文案里要模型先用 `todo_write` 把分步任务立成清单；拒绝时把用户在卡里填的反馈原话原样捎回（index.ts:106、195-204）。
- 不注册提示词段：计划该怎么写、怎么交，写在 mode 包那段环境快照里；本包只管交付、评审与切档（core/modes.ts:153-170）。
- 界面两个快照：`pendingPlan` 出当前查看会话那张卡（活卡优先，没有再看会话状态里留的僵尸卡），`planDirectory` 出本会话终态计划的账（index.ts:149、161-168）。
- 停用之后，模型侧少掉 `exit_plan_mode`：计划档里它只能把方案写在对话里，没有可交的入口，批完也不会自动切回执行档（index.ts:170-207）。

## Known Limitations（已知限制）

- 一次回答最多交一份计划，改方案要交完整的新版本；这条只写在工具说明里，代码不拦第二份（index.ts:173-175）。
- 计划文件落在工作区的 `.dsc/plans/`，文件名带时间戳与标题片段（core/modes.ts:61-80）。
- 多卡并存时每个会话最多一张、互不顶掉，界面只画当前查看会话的那张；切走不会再把它按拒收收尾（文件头 12-14、index.ts:66-73）。
- 会话账最多留 50 条，面板只显示最近 12 条，更早的要去文件树翻 `.dsc/plans/`（index.ts:34-37）。
- 进程退出时挂起的卡按「拒绝」静默收尾，不喊界面（index.ts:219-222）。
- 引入这份账之前的老会话没有 `plans` 条目，面板那区就空着，不回溯（index.ts:159-160）。

## 行与开关

- 行 id `plan`，包名 `@pneuma/plan`，order 240。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认开：`cordis.patch.yml` 里没有 `disabled`。
- inject 五个服务：`session`、`tools`、`mode`、`surfaces`、`waiting`，并 provide `plan`（index.ts:52-53）。
- 没有设置分区，也没有命令：入口只有 `exit_plan_mode` 与评审卡（index.ts:149-150、207）。
