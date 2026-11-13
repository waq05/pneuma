# Super Agent 界面（@pneuma/ui-superagent）

一句话：Super Agent 的界面半——侧栏一行入口（带待处理徽标）+ 主区一个整页，页里三页签（发布 / 工单 / 设置），工单详情从工单页进。

## 这个包是什么

一个**纯界面插件**，由两半组成：

- `index.ts`（宿主半）：`name` + 空 `apply`。它唯一的作用是让这一行进 Loader，从而在插件中心里有一个能单独停用的开关。
- `ui/`（界面半）：`ui.tsx` 注册侧栏一行与整页，`publish.tsx` / `tickets.tsx` / `detail.tsx` / `settings.tsx` 是四张页面，`state.ts` 读快照面并放页内导航信号。壳的构建把它打成 `lib/ui/plugins/superagent/client.js`，页面按启动图装载。

工单数据、五个写方法与快照面都归宿主包 `@pneuma/superagent`（默认关着）；本包只读、不写它，两半各自独立启停。

## 这个包做了什么

- **侧栏一行**：点一下进「工单」页并清掉详情选择；已经停在工单列表时再点一次回对话页。右侧徽标读 `counts.needsYou`，为 0 不画。
- **整页**：`useShellPage()` 比对 `superagent`，不是自己就返回 `null`；外壳与插件中心同款（`.plugins` / `.plugins-inner` / `.plugins-head`）。
- **页签**：发布 / 工单 / 设置。页签与选中工单放 `state.ts` 的模块级 `createSignal`——整页退出时页条目会被卸载，`useState` 会丢。
- **发布**：标题（必填）+ 正文（多行）+ 起点分支（可选），提交调 `superagentPublish({ title, body, base? })`；成功切到工单页并高亮新工单，下面列 `recent` 最近 5 条。
- **工单**：需要你处理（`person`）/ 进行中（`working` + `idle`）/ 已完成（`ended`）三组；一条都没有时给「发一条试试」+ 去发布按钮。
- **详情**：标题、id、状态、时间、交付摘要；时间线用 `superagentPeekSession` 读执行会话转录，只读；停止 / 重试 / 清理三颗按钮，清理只在 `ended` 时可点且过 `confirmAction` 二次确认。
- **设置**：`getSettingsSections` 里找 `id === 'superagent'` 那一段就地渲染，写走 `setSettingValue`（不另造存储）。
- **两种异常都摊开**：快照面缺席画「未启动」+ 怎么打开；`ready:false` 时画 `problem.code` / `problem.detail`，不吞、不假数字 0。
- 文案走 `createT({ zh, en })`：`locale/ui.zh.json` 是语义真源（中文原文），`locale/ui.en.json` 是译本；界面里不写死中文。

## Model Experience

- 这一页对模型上下文**零贡献**：宿主半的 `apply` 是空的，不注册工具、不注册命令、不 provide 服务、不监听事件；界面半只在浏览器里跑。
- 模型看不到侧栏那一行，也不会因为这一页被打开而多出任何提示词或工具说明。
- 本包不写任何文件；只在用户点按钮时发那五个界面通道方法，不改模型下一轮读到的会话状态。

## Known Limitations

- 停用本插件时没有人把 `page` 复位（只有 `plugins` 有特判，见 `ui-sessions/ui/ui.tsx:210-213`）：正停在 Super Agent 页上停用它，主区会剩一片空白，点一条会话才能回来。
- 手机档侧栏默认收起，要拉出抽屉才看得见这一行；56px 窄栏里不会出现它（`docs/superagent-design.md` §8.6）。
- 整页会顶掉对话区，不能边看工单边聊（这是选「整页」范式的已知代价）。
- 执行会话时间线要手动点刷新才看得到新条目（工单阶段变了才会自动重读整页，转录不随泵推）。
- `branch` / `changedFiles` 已留字段，P0 宿主不填，所以这两行现在不会出现。
