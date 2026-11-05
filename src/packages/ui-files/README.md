# ui-files（文件）

一句话：右侧栏的「文件」「Git」两个页签——工作区文件树与变更面板。

## Model Experience（模型体验）

- 纯界面单元：宿主半是空 `apply`，不注册工具、不写提示词（index.ts:3-9、29）。
- 模型侧零变化；它只让人浏览工作区、看 diff、暂存与提交（ui/ui.tsx:1-13）。
- Git 写操作走界面通道的审批，与工具调用同一套裁决（ui/changes.tsx:5-9）。
- 停用后模型不受影响，少掉的是人的文件树、变更面板与预览入口（ui/ui.tsx:69-75）。

## 面板与数据

- 文件页签：根行加懒加载目录树，展开才拉那一层；点文件开一张预览页签（ui/ui.tsx:17-26、125-177）。
- Git 页签：状态三分组、每文件增删行数、就地 diff、暂存 / 提交、提交历史（ui/changes.tsx:1-13）。
- 数据：快照里的 `cwd`（ui/ui.tsx:80-90），`dock` 通道的 `fs-list`；Git 走 `git-status` / `git-log` / `git-diff` / `git-stage` / `git-unstage` / `git-commit`（ui/ui.tsx:9-11、100；ui/changes.tsx:89-168）。
- 树状态按工作区根各存一份，切会话各回各的树（ui/ui.tsx:4-6、179-209）。
- 停用后：右侧栏没有文件与 Git 页签，点文件也不再开预览页签（ui/ui.tsx:69-75）。

## Known Limitations（已知限制）

- 工作区根 = 当前会话的 cwd，切会话即换根（ui/ui.tsx:25）。
- 目录懒加载：没展开的层不读盘，刷新只重拉已展开的层（ui/ui.tsx:191-195）。
- 条目过多时显示「已截断」，树不提供分页（ui/ui.tsx:109-116）。
- Git 提交把勾选的未暂存文件一起带上，一张审批卡覆盖两步（ui/changes.tsx:6-9）。
- 浏览器里也能用：读类 op 直接放行，写类 op 过审批（ui/ui.tsx:9-11）。

## 行与开关

- 行 id `ui-files`，包名 `@pneuma/ui-files`，order 354（package.json:10-18）。
- resolution 是 overridable；默认开（cordis.patch.yml 里没有 `disabled`）。
- dsh.client：platform `pneuma`、api `^0.9.0`，没有 phase / inject（package.json:20-25）。
- 宿主半 inject 无、provide 无（index.ts:15-29）。
