# ui-actions（动作表（界面））

一句话：界面上的全局动作登记处——插件按 owner 交动作，按 id 去重，变化时通知订阅者；它自己一条动作都不提供。

## Model Experience（模型体验）

- 纯界面单元：宿主半是空 `apply`，不注册工具、不写提示词、不监听事件（index.ts:3-9、32）。
- 模型侧零变化；它只决定界面上有哪些全局动作可点（ui/ui.tsx:1-10）。
- 停用它，其他插件登记的动作不会出现在命令面板与设置里，但面板本身还在（ui-shell/src/plugin-api.ts:379-387）。

## 面板与数据

- 不是一块看得见的面板，而是命令面板、设置页、会话页共用的动作服务（ui/ui.tsx:1-10）。
- 数据来源：页面内各插件调 `ui.provide('actions')` 后登记的动作，没有宿主服务参与（ui/ui.tsx:38-53）。
- 顺序按 owner 首次出现、组内按登记顺序；id 重复只留第一条并告警（ui/ui.tsx:21-36）。
- `useActions` 在服务缺席时返回空表，调用方不必写防御分支（ui-shell/src/plugin-api.ts:375-387）。
- 停用后：命令面板只剩最近会话，动作与设置里的全局入口整块消失（ui/ui.tsx:1-10）。

## Known Limitations（已知限制）

- 同一个 owner 再登记就是整组替换，不能增量追加（ui/ui.tsx:15-19、38-42）。
- 注销只在「还是我这一份」时生效，旧句柄不会摘掉新登记的那组（ui/ui.tsx:43-49）。
- 动作表不持久化：刷新页面就清空，等插件重新登记（ui/ui.tsx:16-19）。
- 重复 id 只留第一条，后一条被忽略（ui/ui.tsx:26-31）。

## 行与开关

- 行 id `ui-actions`，包名 `@pneuma/ui-actions`，order 350（package.json:10-18）。
- resolution 是 overridable；默认开（cordis.patch.yml 里没有 `disabled`）。
- dsh.client：platform `pneuma`、api `^0.8.1`，没有 phase / inject（package.json:20-25）。
- 宿主半 inject 无、provide 无；界面半 provide `actions` 服务（index.ts:15-32；ui/ui.tsx:55-59）。
