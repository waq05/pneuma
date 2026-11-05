# ui-team（智能体团队）

一句话：标题旁的「智能体团队」入口 + 团队面板 + 正文区的只读运行记录（子智能体列表住在 `ui-status` 的「智能体」区）；共享任务板是宿主包 `team` 的事，不在这里。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:31；ui/ui.tsx:148、153 只有两个注册）。
- 名册来自界面通道 `listTeammates`：常挂载的下拉每 3 秒轮询一次写进共享席位，页面不可见时停下（ui/ui.tsx:5-8、177-189）。
- 用户能叫停、移除队友或带话过去，三个方法都在放行面上；带话会包成一条 `<message from="user">` 追加进队友信箱并叫醒它（ui/ui.tsx:6-7、463-529；subagent/index.ts:936-946）。
- 看队友运行记录走 `peekTranscript`，只读，不碰队友的上下文（ui/ui.tsx:8、590）。
- 停用后模型侧不变，少的只是名册与面板（index.ts:7-9）。

## Known Limitations（已知限制）

- title 与职责不符：清单写「共享任务板」，界面半画的是子智能体名册，没有登记、认领、结项（package.json:17-18 对照 ui/ui.tsx:1-17）。
- 老名册行没有 `sessionId`，不归任何会话，只进底部折叠组。
- 点队友一行不切会话：正文区是盖在 `[data-thread-area]` 上的只读层（`peekTranscript` + 消息流插件的同款行渲染），底下的会话原样开着。**不走 `openSession(队友日志)`**——那条路会用日志里的 `meta.id` 重算落盘路径（`core/session.ts:670`），把当前会话换成一个不存在的路径，输入框还能往里写；原因写在 `ui/ui.tsx` 的文件头。
- 还在跑的队友不给看：`teammateReader.open` 当场回绝并给一句人话（那份日志正被它写）。
- 名册靠 3 秒轮询，页面不可见时停发，回来可能看到过期名单。

## 行与开关

- 行 id `ui-team`，包名 `@pneuma/ui-team`，order 365（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.9.0`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务（index.ts:31）。
- 槽条目 `shell.header.lead`、order 20（「智能体团队」入口，有队友时带数量；order 10 是模式钮，标题旁读作「新会话 · 标准模式 · 智能体团队」）；另报名一个 `subagent` dock 页签。
- 停用后标题旁的入口、团队面板、正文区只读层与队友页签一起消失；状态面板「智能体」区退回它自己的 5 秒轮询，点行的动作退回右侧栏页签（`teammateReader` 服务缺席时）。
