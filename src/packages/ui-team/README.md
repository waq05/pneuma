# ui-team（子智能体界面半）

一句话：给状态面板「子智能体」区供名单（3 秒轮询写共享席位）、在正文区承载只读运行记录（在跑的队友也能打开、边跑边看，收工后跟读自己停；头部带停止 / 发话 / 移除与耗时读数；一次性子智能体没有「发话」这一项，头部那句只读说明换成「干完就不接后续消息」）、并报名右侧栏的子智能体页签。**标题旁不再有按钮与名册模态**——成员只在状态面板列一次；任务那些事归状态面板的「共享任务」区（数据面在宿主包 `subagent`）。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:31；ui/ui.tsx 只有槽条目、服务与 dock 页签三类注册）。
- 名册来自界面通道 `listTeammates`：常挂载的那条目录每 3 秒轮询一次写进共享席位，页面不可见时停下（ui/ui.tsx:1-8、200-240）。
- 用户能叫停、移除队友或带话过去，三个方法都在放行面上；带话会包成一条 `<message from="user">` 追加进队友信箱并叫醒它（`ReaderActions`；subagent/index.ts:936-946）。
- 看队友运行记录走 `peekTranscript`，只读，不碰队友的上下文。在跑的队友也能看：宿主侧是 `Session.load(..., { lease: false })`（`subagent/index.ts:862-872`），队友正写着也读得，半截行跳过、下一拍补上。
- 停用后模型侧不变，少的只是名册席位、只读层与页签；状态面板退回它自己的 5 秒轮询。

## Known Limitations（已知限制）

- 名册按 `sessionId` 过滤本会话；别的会话派出的**不列、不给入口**（2026-11-08 起跨会话折叠组已删）。
- 点队友一行不切会话：正文区是盖在 `[data-thread-area]` 上的只读层（`peekTranscript` + 消息流插件的同款行渲染），底下的会话原样开着。**不走 `openSession(队友日志)`**——那条路会用日志里的 `meta.id` 重算落盘路径（`core/session.ts:670`），把当前会话换成一个不存在的路径，输入框还能往里写；原因写在 `ui/ui.tsx` 的文件头。
- **在跑的队友也能打开**（2026-11-09 拆掉 2026-11-05 那道「等它收工」的门）：`teammateReader.open` 直接放行；跟读靠 `peekTranscript` 的 `lease: false` 只读重放，名册翻成已完成 / 已停止 / 失败之后 `working` 变假，轮询自己停，页面停在最后那份内容上。头部状态词与耗时按名册里的**当前这一位**刷新（按 `sameFile` 匹配），不是点下去那一刻的冻结快照。
- 发话 / 移除只在运行记录页头部：名册模态撤掉之后，列表处不重复挂动作（`ReaderActions`）。
- 名册靠 3 秒轮询，页面不可见时停发，回来可能看到过期名单。

## 行与开关

- 行 id `ui-team`，包名 `@pneuma/ui-team`，order 365（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.9.0`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务（index.ts:31）。
- 槽条目 `shell.header.lead`、order 20：**只挂轮询与只读层宿主，不画可见元素**（order 10 是模式钮，标题旁读作「新会话 · 标准模式」）；另报名一个 `subagent` dock 页签。
- 停用后正文区只读层与队友页签一起消失；状态面板「子智能体」区退回它自己的 5 秒轮询，点行退回右侧栏页签（`teammateReader` 服务缺席时）。
