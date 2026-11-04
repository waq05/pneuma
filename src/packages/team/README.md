# team（共享任务板）

一句话：按会话一块的任务板，模型用 `team_task` 登记、认领、结项，队友和主会话看同一块。

## Model Experience（模型体验）

- 工具 `team_task`：create / list / get / claim / release / complete / reopen / set_dependencies / delete（index.ts:112-138）。
- 改状态必须带 `expected_revision`；不传直接拒绝，避免两个人同时认领时后到的覆盖先到的（index.ts:47-53）。
- 提示词 `team` 注入看板前 20 条与两条规矩：先上板写 write_scopes、认领前先 list（index.ts:142-156）。
- 队友转发调用会带自己的名字当认领人；主会话自己调用就是 lead（index.ts:29-35）。
- 只看本会话的板；切会话就是另一块（index.ts:6-7、42）。

## Known Limitations（已知限制）

- 默认关闭：cordis.patch.yml 里 `disabled: true`。
- 单板最多 256 条任务（core/team-board.ts:53-54）。
- 写作用域只是重叠提醒，不是锁：重叠照样允许开工，由人看 diff 裁决（core/team-board.ts:8-10）。
- 看板是明文 JSON，落在 `~/.dsc/team/boards/<会话 id>.json`，不是会话日志（core/team-board.ts:5-13）。
- 只有 lead 在写也能用，此时它就是一份共享 todo（index.ts:9-11）。
- 设置里的「清空本会话任务板」只清当前会话的条目（index.ts:160-174）。

## 行与开关

- 行 id `team`，包名 `@pneuma/team`，order 3610（package.json:10-18）。
- resolution 是 overridable，默认关闭（package.json:15；cordis.patch.yml）。
- inject `session`、`tools`、`prompt`、`settings`（index.ts:39）。
- 设置分区 id `team`，没写 order（按默认 100 排），含目录与清空按钮（index.ts:164-177）。
