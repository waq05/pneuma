# ui-sessions（会话列表）

一句话：ui-sessions 是左侧栏会话列表这个界面单元的宿主半：分组、搜索、重命名、拖拽排序与今日用量都画在这一栏里。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词（index.ts:29；ui/ui.tsx:95-97 只有两个槽条目）。
- 它画的是宿主快照里的 `sessions` / `sessionStates` / `status.sessionPath`，归档会话也在内（ui/ui.tsx:9-10、157-159）。
- 切会话是这里唯一会换掉模型上下文的动作：点一行走 `openSession`，模型下一条消息就属于那个会话（ui/ui.tsx:291-312）。
- 置顶、归档、重命名、拖拽排序只改界面偏好与会话元数据，不进模型上下文（ui/ui.tsx:282、366、400）。
- 停用后模型侧不变，左侧栏整块消失（index.ts:7-9）。

## Known Limitations（已知限制）

- 分组、排序、筛选、展开态存在 `UiPrefs` 里，换一台机器不跟随（ui/ui.tsx:14、132）。
- 手动排序只在 manual 档生效，且只在同一置顶块内互拖（ui/ui.tsx:17-18、710）。
- 没拖过顺序时，manual 档的组间位置按「工作区第一次出现的时间」冻结（组内最早一条会话的
  `createdAt`，越新加入的越靠上）：新建、打开、归档会话都不会让某个工作区上浮；`order` 里没有
  的组（例如搜索态下拖过一次之后剩下的组）一律排在表内之后，组间也按同一个键定序。
- 每组默认露 5 条，搜索时才全量放开（ui/ui.tsx:14、190）。
- 「在资源管理器里打开」与「记住工作目录」走原生桥，浏览器与远程页里没有（ui/ui.tsx:356、391、1271）。
- 归档会话的显隐靠三档筛选，不是「归档即消失」（ui/ui.tsx:10-11、222）。

## 行与开关

- 行 id `ui-sessions`，包名 `@pneuma/ui-sessions`，order 359（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.9.0`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务（index.ts:29）。
- 两个槽条目：`shell.header` 的「添加工作区」（order 10）与 `shell.sidebar` 的会话列表（order 1）（ui/ui.tsx:95-97）。
- 停用后内置产物被滤掉，左侧栏不再有会话列表（index.ts:7-9）。
