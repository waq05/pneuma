# waiting（等人登记表）

一句话：waiting 包 provide 一个 `waiting` 服务：每张等人决定的卡片自己登记「我在等」，想往下推的人只问一句「有没有人在等」。

## Model Experience（模型体验）

- 不注册工具、不写提示词：模型看不到这张登记表（index.ts:14-42 只有 provide 与一个 Map）。
- 它挡的是自动续跑：goal 插件推下一轮之前问 `ctx.waiting.any`，有人等就返回 null（goal/index.ts:114-117）。
- 定时任务投递前也问同一句（schedule/index.ts:11、203）。
- 因此它间接改变模型体验：界面上挂着审批、计划、提问卡时，模型不会被自动叫醒继续跑（index.ts:4-5、goal/index.ts:114-117）。

## Known Limitations（已知限制）

- 只有查询没有事件：`register` 返回注销函数，但没有「有人开始或停止等」的通知（index.ts:20-25；core/lifecycle-hooks.ts:152）。
- 登记表在内存里，进程重启即空，卡片恢复后要重新登记（index.ts:18、plan/index.ts:150）。
- 某个 pending 回调抛错按「没在等」处理，以免把续跑永久钉死（index.ts:30-37）。
- 同一 id 重复登记会覆盖前一条，先前那次登记的注销函数随即失效（index.ts:21-24）。

## 行与开关

- 行 id `waiting`，包名 `@pneuma/waiting`，order 50（package.json:2、14）。
- resolution 是 pinned：profile 里的同名版本不能覆盖它（package.json:15）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- 宿主半 inject 零个服务，provide 一个 `waiting`（index.ts:14-17、42）。
- 三个登记方：approval、plan、ask（approval/index.ts:1041、plan/index.ts:150、ask/index.ts:239）。
