# ui-palette（命令面板）

一句话：Ctrl+K 命令面板，一处搜动作、最近会话、页面与设置。

## Model Experience（模型体验）

- 纯界面单元：宿主半是空 `apply`，不注册工具、不写提示词（index.ts:3-9、29）。
- 模型侧零变化；面板只是人的跳转入口（ui/ui.tsx:1-18）。
- 停用后动作还在动作表里，只是没有搜索入口（ui/ui.tsx:68-122）。

## 面板与数据

- 条目两源：动作表（`useActions`）与宿主快照里的最近 8 条会话（ui/ui.tsx:3-10、128-161）。
- 动作由各插件登记（会话插件登记「新会话」、设置登记分区、转录登记首屏提示词），面板不硬编码（ui/ui.tsx:3-8）。
- 会话条目调 `openSession` / `refreshSessions`（ui/ui.tsx:153-156）。
- 键盘：↑↓、PgUp / PgDn、Home / End、Enter、Esc；Ctrl+Shift+K 让给旁问（ui/ui.tsx:242-265、82-84）。
- 停用后：没有 Ctrl+K 面板与 `?` 键位表，侧栏帮助行也打不开它（ui/ui.tsx:32-35、68-122）。

## Known Limitations（已知限制）

- 最近会话只取 8 条，且过滤掉已归档（ui/ui.tsx:140-145）。
- 键位表是硬编码的一张清单，没有运行期注册表；加新快捷键要手改这份（ui/ui.tsx:321-339）。
- 面板自己收起，动作的 `run` 不负责关门（ui/ui.tsx:206-211）。
- 滚轮只在指针不在列表上时折算给列表，指针在列表里交给浏览器原生滚动（ui/ui.tsx:391-404）。
- Tab 键被吃掉，焦点不会跑出面板（ui/ui.tsx:261-264）。

## 行与开关

- 行 id `ui-palette`，包名 `@pneuma/ui-palette`，order 355（package.json:10-18）。
- resolution 是 overridable；默认开（cordis.patch.yml 里没有 `disabled`）。
- dsh.client：platform `pneuma`、api `^0.9.0`，没有 phase / inject（package.json:20-25）。
- 宿主半 inject 无、provide 无（index.ts:15-29）。
