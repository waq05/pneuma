# ui-trace（执行轨迹）

一句话：ui-trace 是执行轨迹页的界面单元：上方一条时间轴、中间轮次记录表、右侧点开是行内检查器。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:30；ui/ui.tsx:71 只有一个槽条目）。
- 轨迹读的是会话条目本身（`readEntries` / `readLive` / `readSessionPath`），模型每一步工具调用、思考与用量都在这里留痕（ui/ui.tsx:76-79、5-13）。
- 时间口径是诚实的：工具发起时刻只认 `call.startedAt`，耗时只认 `call.durationMs`，缺哪个就写「未记录」，不拿条目 `ts` 冒充（ui/ui.tsx:18-19）。
- 停用后模型侧不变，轨迹页画不出来（index.ts:7-9）。

## Known Limitations（已知限制）

- 正文 text 不进轨迹，只留步骤与用量（ui/ui.tsx:10）。
- 搜索与时间轴缩放平移是壳补的增量，旧版没有（ui/ui.tsx:6-8、15-16）。
- 跟随贴底的阈值与其他页共用一把尺子（32px 贴底、120px 暂停），停在滞回区两边都不动（ui/ui.tsx:50-59）。
- `dsh.client.inject` 带 `transcript`，它要跟会话流一起排进启动图（package.json:24-26、index.ts:16）。

## 行与开关

- 行 id `ui-trace`，包名 `@pneuma/ui-trace`，order 367（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.8.1`，inject `['transcript']`（package.json:20-27）。
- 宿主半 inject 零个服务（index.ts:30）；界面半在启动图里依赖 `transcript`。
- 槽条目 `SLOT.thread`、order 1，线程视图切到 trace 时才渲染（ui/ui.tsx:70-71）。
- 停用后轨迹页不出现，会话流本身照常（index.ts:7-9）。
