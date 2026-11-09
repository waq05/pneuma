# 批次 05：侧栏、设置与文件

> 审查口径见 `docs/code-review/2026-11-09/00-审查口径.md`。分支 `feat/pluginization`，按 2026-11-09 工作区现状只读审查。
> 未修改任何源码，未跑 install / build / typecheck / 测试。
>
> **本批涉及的在途改动文件（行号以工作区现文件为准）**：
> `src/packages/ui-files/ui/changes.tsx`（+92/−31）、`src/packages/ui-preview/ui/ui.tsx`（+52/−18）、
> `src/packages/ui-preview/locale/ui.{zh,en}.json`、`src/packages/ui-dockkit/ui/dock-state.ts`（新增 `setDockFileView`）、
> `src/packages/ui-layout/ui/app.tsx`（注释掉 `ReviewPane`）、`src/packages/ui-transcript/ui/rows/changes-card.tsx`（注释掉 `setDockReview`）。
> 其余本批文件（ui-sessions、ui-settings、ui-plugins、ui-skills、ui-files/ui.tsx、ui-browser、ui-terminal）**没有未提交改动**。
>
> 已被别的批次覆盖的条目（折叠回复默认值、主题默认值、工具卡三份、window 事件总线、`app.tsx` 上帝模块、样式层、`services` 丢弃）
> 本批只在出现新证据时补一行交叉引用，不重复计数。

## 范围

实际读过的文件（逐行或整段通读）：

- **ui-sessions**：`ui/ui.tsx`（2038 行，全文）、`ui/grouping.ts`（251 行，全文）、`index.ts`（29 行全文）
- **ui-settings**：`ui/ui.tsx`（1282 行：1–420 全读、420–720 逐行、845–905、900–1187 逐行、1189–1282 全文）、
  `ui/models.tsx`（1935 行：1–330 全读、330–450、其余按组件边界抽读 `validateDraft`/`blankModel`/`parseModels`/`mergeCaps`/`draftOf`）、
  `ui/model-infer.ts`（235 行全文）、`ui/archive.tsx`（195 行全文）、`ui/presets.tsx`（前 60 行 + 导出面）、
  `ui/usage.tsx`（255–315）
- **ui-plugins**：`ui/ui.tsx`（1307 行全文）
- **ui-skills**：`ui/ui.tsx`（1–120、240–420、市场段 680–837）
- **ui-files**：`ui/ui.tsx`（255 行全文）、`ui/changes.tsx`（627 行全文）
- **ui-preview**：`ui/ui.tsx`（354 行全文）
- **ui-browser**：`ui/ui.tsx`（1–120 + 调用面检索）；**ui-terminal**：`ui/ui.tsx`（326 行全文）
- **对照（只看调用关系，不审本体）**：`tui/app/SessionPicker.tsx`（1–80）、`tui/app/App.tsx:95–103`、
  `core/prefs.ts`（175–305、360–480、338–350）、`contract/session.ts`（全文）、`core/dock-ops.ts`（全文）、
  `core/config-store.ts`（120–239）、`core/model-caps.ts`（全文）、`core/plugin-registry.ts`（全文）、
  `core/plugin-loader.ts`（860–926）、`packages/runtime/index.ts`（150–270）、`packages/session/index.ts`（120–219）、
  `packages/settings/index.ts`（600–690）、`packages/plugin-manager/index.ts`（全文）、`packages/llm/index.ts`（240–290）、
  `packages/commands/index.ts`（610–660）、`ui-dockkit/ui/dock-state.ts`（120–180、250–380）、
  `ui-layout/ui/{app.tsx:590–670, review-pane.tsx:1–80}`、`ui-primitives/ui/{snapshot.ts, paths.ts, panels.ts:40–95}`、
  `ui-runtime/ui/{appearance.ts:80–137, usage-today.ts}`、`ui-transcript/ui/rows/changes-card.tsx:150–270`

没读：`ui-settings/ui/pair-modal.tsx`（278 行）、`ui-settings/ui/heatmap.ts`（108 行）、`ui-settings/ui/models.tsx` 的
`ProviderDetail`/`ModelFields`/`DiscoverDialog` 三个组件体（约 1367–1935）、`ui-skills` 的已安装列表渲染段（420–680）、
`ui-browser` 的地址栏交互段（120–378）、`scripts/ui-*.mjs` 探针。

## 结论摘要

- **P0 × 1 / P1 × 9 / P2 × 9**（共 19 条）
- 三条最重要的话：
  1. **P0：某个文件的「改动快照」只有一份内存表且没有失效点，而在途改动刚把一个新入口接到了它上面。**
     `patchSources`（`ui-dockkit/ui/dock-state.ts:276`）只增不删；新加的 `setDockFileView`（同文件 345–349）让**预览页签**也去读它。
     于是「改过 → 关页签 → 从文件树再点开」时，页签头上会挂着**上一刀**的 `+N/−N` 与「改动」开关（`ui-preview/ui/ui.tsx:112`、`163–181`）。
  2. **同一个判定在界面侧按卡片种类硬算，而宿主按行 id 算，两边结论相反。**
     宿主只对 `ui-layout`/`ui-renderer` 两行要求刷新（`packages/runtime/index.ts:191`），界面却给**所有内置行**标「停用（即时生效）」、
     给**所有第三方行**标「停用（刷新页面后生效）」（`ui-plugins/ui/ui.tsx:694–699`、`869`）——两类卡的提示都是错的。
  3. **设置包把「外观偏好归一化」做成了第四份，并且注释自承这是划算的。**
     `ui-settings/ui/ui.tsx:1219–1250` 的 `normalizePrefs` 与 `core/prefs.ts`、`ui-runtime/appearance.ts` 并存；
     其中字号旧档映射表 `{sm:0.92,md:1,lg:1.12}` 是第三份，主题默认 `'claude'` 是第四份（交叉引用批次 03 的 F6）。

---

## 按插件分节

### ui-sessions

#### [P1] `SessionList` 一个组件 1213 行、17 类职责；侧栏的每一个需求都要动它

- 位置：`src/packages/ui-sessions/ui/ui.tsx:187-1399`（`SessionList` 本体）、同文件 `1402-2038`（另外 18 个内部件与读数函数）
- 现象：`SessionList` 从 `useState` 一直画到页脚，中间夹着会话库调用、偏好写回、拖拽状态机、两份右键菜单。逐项对号（一行一号）：

  | # | 职责 | 行号 |
  |---|---|---|
  | 1 | 快照读数（sessions / sessionStates / 当前路径 / loading / cwd）+ 页面状态 | 188–215 |
  | 2 | 17 个本地状态：乐观高亮、搜索、视图菜单、行级菜单、每组条数、最近工作区、工作区改名、会话改名、两套拖拽、故障、分叉 | 203–247 |
  | 3 | 挂载取数：`refreshSessions` + `getUiPrefs` 五字段解析 + 原生桥 `recentCwds` | 249–278 |
  | 4 | 会话库操作的回执归一（ok/notice/error → Toast，成功后自动重扫） | 288–305 |
  | 5 | 偏好乐观写回 + 失败回滚（含 `patchOfUndo`） | 308–326、1538–1548 |
  | 6 | 打开 / 新建会话（乐观高亮、自动展开目标组） | 337–353 |
  | 7 | 「查看轨迹」跨页跳转 | 362–365 |
  | 8 | 在指定工作区新建（自补 `recentCwds` + 原生桥 `rememberCwd`） | 375–400 |
  | 9 | 会话改名 / 删除整个工作区（确认框 + 批量归档） | 403–445 |
  | 10 | 跨插件事件入口 `shell.session.new` | 455–462 |
  | 11 | 命令面板动作登记（`session.new`） | 467–482 |
  | 12 | 分叉：取用户消息 → 选择器 → 复制 → 打开新会话 | 490–524 |
  | 13 | 归档 / 恢复 / 复制 ID / 工作区别名 / 分组展开 | 527–577 |
  | 14 | 列表整形（`buildWorkGroups` / 单列表 / 父节点集 / 活动工作区） | 580–611 |
  | 15 | 两条 effect：乐观高亮 4 秒兜底、当前工作区自动展开并落盘 | 614–651 |
  | 16 | 展开真值判定 + 树折叠连带 | 655–662 |
  | 17 | 工作区拖拽排序（4 个处理函数 + 尾部落点） | 667–696、972–995、1115–1132 |
  | 18 | 会话行拖拽（落点半段判定、跨块校验、拖拽影子 DOM） | 699–785 |
  | 19 | JSX：新会话钮 + 技能/插件导航（含「插件页停用后不画钮」） | 789–825 |
  | 20 | JSX：列表头 + 搜索框 + 四档空态 | 827–913 |
  | 21 | JSX：单列表 / 工作区树 / 「展开剩余 N」/ 组头三颗钮 | 914–1134 |
  | 22 | JSX：视图选项菜单（分组/排序/筛选三组单选，共 9 项） | 1139–1187 |
  | 23 | JSX：行级菜单两份（会话 7 项 / 工作区 5 项） | 1190–1370 |
  | 24 | JSX：分叉位置选择器 | 1373–1394 |
  | 25 | 页脚（今日用量 + 设置入口） | 1396、1453–1482 |

- 证据：
  ```
  187: function SessionList() {
  203:   const [pendingOpen, setPendingOpen] = useState<string | null>(null)
  227:   const [menu, setMenu] = useState<{ kind: 'session' | 'group'; id: string; x: number; y: number } | null>(null)
  240:   const [sessDrag, setSessDrag] = useState<{
  1193:           ? (() => {
  1292:           : (() => {
  1396:       <SidebarFooter />
  1399: }
  ```
  行级菜单两份是就地 IIFE（`1193` 会话、`1292` 工作区），各 100 行上下，与主组件的状态簇共用 `menu`/`groups`/`prefs`。
- 影响：侧栏是最常被提需求的一块（0.6.45 删工作区入口、0.7.1「选完目录没显示」、2026-11-03 乐观高亮、2026-11-06 插件钮死钮…全部落在这一个函数里）。
  任何一次改动（改拖拽手感、加一个菜单项、换空态文案）都要先读懂这 17 份状态；`limits`/`renaming`/`groupRenaming`/`menu`/`viewMenu` 五个正交的开合态共处一个闭包，
  改一个的时机不会报错、只会让另一个不生效。
- 建议：按下面五刀切，`index.ts` 与两个槽位注册不动，纯搬移即可验收：
  | 新文件 | 搬什么 | 对应行 |
  |---|---|---|
  | `ui/session-store.ts` | 快照读数、`run` 回执归一、`patchPrefs` + `patchOfUndo`、6 处 `refreshSessions` 收敛成一个 `mutate()` | 188–326、1831–1860 |
  | `ui/session-actions.ts` | 打开/新建/改名/归档/恢复/分叉/删除工作区/复制 ID | 337–577、1869–1897 |
  | `ui/group-model.ts` | 展开真值、树折叠、拖拽排序四函数（`reorder`/`dropAtEnd`/`commitSessDrag`/`dragFor`） | 655–785 |
  | `ui/session-row.tsx` | `SessionRow` + 行内改名草稿 + 标题溢出量测 | 1551–1821 |
  | `ui/session-menus.tsx` | 视图菜单、两分行级菜单、分叉选择器、`MenuRadio`/`MenuItem` | 1139–1394、1402–1442 |
  | `ui/sidebar-chrome.tsx` | 新会话钮、技能/插件导航、列表头、搜索框、空态、页脚、`AddWorkspaceButton`、`WorkspaceOpenGroup` | 789–913、1396、1453–1482、1869–2038 |
- 置信度：高（全文件逐行读过；行号逐段核对）

#### [P1] 偏好写回失败时把界面状态重置成**出厂默认**，而且写完不重读宿主

- 位置：`src/packages/ui-sessions/ui/ui.tsx:308-326`（`patchPrefs`）、`1538-1548`（`patchOfUndo`）
- 现象：`patchPrefs` 的失败分支调 `patchOfUndo(patch)`，而 `patchOfUndo` 填的是 `DEFAULT_PREFS.<字段>`，不是「打补丁之前的值」。
  展开态、别名表、工作区顺序、会话顺序、分组档、排序档，任何一次 `setUiPrefs` 抛错都会被整体抹成出厂值；
  同时成功后也**不**再调 `getUiPrefs` 对齐，所以界面会一直停在错的那一版，直到组件重挂。
- 证据：
  ```
  322:         setPrefs((current) => ({ ...current, ...patchOfUndo(patch) }))
  1537: /** patchPrefs 的撤销面：把刚打的补丁逐字段退回去。 */
  1540:   if (patch.group !== undefined) undo.group = DEFAULT_PREFS.group
  1544:   if (patch.expansion !== undefined) undo.expansion = DEFAULT_PREFS.expansion
  1546:   if (patch.sessionOrder !== undefined) undo.sessionOrder = DEFAULT_PREFS.sessionOrder
  ```
- 影响：注释说的是「退回去」，代码做的是「重置」。用户拖完一整个工作区顺序，若那一次写盘失败（`settings.json` 被别的窗口占用、磁盘只读、宿主刚退出），
  屏幕上所有分组会立刻塌回收起态、所有别名消失、手动排序全丢；磁盘上那份却还是好的——两边此后再也不会自动对齐（只有 remount 才重读）。
  这是「同一状态两份（界面 state vs settings.json）且失效逻辑只在一个方向上」的典型。
- 建议：`patchPrefs` 改成先快照 `const before = prefs`，失败时 `setPrefs(before)`；成功路径顺手把 `body` 里那些键回读一次对齐
  （或让宿主 `setUiPrefs` 返回归一后的 `UiPrefsView`，界面直接采信）。`patchOfUndo` 整个函数可以删掉。
- 置信度：高（两段原文都读过；「失败不重读」这一点已核对 `patchPrefs` 全文没有 `getUiPrefs`）

#### [P2] 侧栏偏好解析与宿主读档是两套口径：别名不裁长、顺序不去重

- 位置：`src/packages/ui-sessions/ui/ui.tsx:1493-1525`（`readStringRecord` / `readRecord` / `readStringList` / `readStringListRecord`）
  对照 `src/core/prefs.ts:433-442`、`478-496`
- 现象：同一份 `settings.json` 的 `ui` 段被两边各归一一次，规则不同：
  - 别名：宿主 `trim` + 压空白 + `slice(0, 40)`（`ALIAS_LIMIT`），界面原样收；
  - 工作区顺序：宿主 `[...new Set(...)]` 去重，界面留重复项；
  - 会话顺序：宿主逐条过滤，界面 `readStringListRecord` 递归调 `readStringList`（多一层过滤，等价）。
- 证据：
  ```
  ui.tsx:1494:   if (typeof value !== 'object' || value === null) return {}
  ui.tsx:1497:     if (typeof item === 'string') out[key] = item
  prefs.ts:439:           const name = alias.replace(/\s+/g, ' ').trim().slice(0, ALIAS_LIMIT)
  prefs.ts:434:         prefs.ui.workspaceOrder = [...new Set(ui.workspaceOrder.filter(...))]
  ```
- 影响：改名超过 40 字时，界面当场显示全名、写盘后被裁、下次启动显示裁过的——用户看到「自己改的名字变短了」。
  更麻烦的是界面这份是**唯一**被 `patchPrefs` 写回的数据源：界面把带重复项的 `order` 写回，宿主的去重规则又被绕过一次。
  改一次别名规则（比如放宽到 60 字）必须同时改两处，漏一处不报错。
- 建议：把 `readEnum` / `readStringRecord` / `readRecord` / `readStringList` / `readStringListRecord` 提到
  `src/contract/session.ts`（它已经是零依赖、浏览器安全的归一化文件，`normalizeStatusBarPrefs` 就在那儿），
  宿主 `readPrefs` 与侧栏共用；`ALIAS_LIMIT` 一起搬过去。
- 置信度：高（四处原文都读过）

#### [P2] 两个读数与基底库逐字等价，`snapshot.ts` 自称「唯一一份」被自己人打破

- 位置：`src/packages/ui-sessions/ui/ui.tsx:1837-1842`（`readCurrentPath`）、`550-555`（`copyId`）
  对照 `src/packages/ui-primitives/ui/snapshot.ts:39-44`（`readSessionPath`）、`85-92`（`readSessionId`）
- 现象：`readCurrentPath` 与 `readSessionPath` 都是「读 `status.sessionPath`，非字符串给 null」；`copyId` 与 `readSessionId` 都是
  「取路径末段、剥 `.jsonl`」。`snapshot.ts` 的模块注释写的正是「此前十个插件各写一遍…同一个字段的收窄写十遍」。
- 证据：
  ```
  ui.tsx:1840:   const path = (status as Record<string, unknown>)['sessionPath']
  ui.tsx:1841:   return typeof path === 'string' ? path : null
  snapshot.ts:42:   const value = (status as Record<string, unknown>)['sessionPath']
  snapshot.ts:43:   return typeof value === 'string' ? value : null

  ui.tsx:551:   const uuid = lastSegment(id).replace(/\.jsonl$/, '')
  snapshot.ts:91:   return base.endsWith('.jsonl') ? base.slice(0, -6) : base
  ```
- 影响：`readSessionPath` 与 `readSessionId` 的存在意义就是「口径只有一处」；本包明明已经从基底库 import 了 `readCwd`/`readSessions`
  （`ui.tsx:81`），却在这两项上另起一份。哪天 `status.sessionPath` 改叫 `sessionFile`，改基底库的人以为改完了，侧栏这两处会静默退回 null
  （表现为「点了会话不高亮」「复制的 ID 是空」）。
- 建议：`readCurrentPath` 换成 `useHostSelector(readSessionPath)`，`copyId` 改为 `useHostSelector(readSessionId)` 后写剪贴板；
  删掉本文件那两个函数与 `lastSegment` 的这处用法。
- 置信度：高（四段原文逐字比对过）

#### [P2] 一次归档触发两次全量扫盘；`refreshSessions` 在本包有 6 个调用点

- 位置：`src/packages/ui-sessions/ui/ui.tsx:250`、`299`、`351`、`395`、`439`、`518`；对照 `src/packages/session/index.ts:187`
- 现象：`run()` 在每次 mutation 回执成功后自己再调一次 `refreshSessions`（`299`），而宿主 `archive()` 在挪完文件后**也会**自己
  `await service.refresh()`（`session/index.ts:187`）。归档一条会话因此扫两遍盘；`refresh()` 本身是「活动区 + 归档区各扫一遍」
  （`session/index.ts:134-137`，批次 01 已把「每扫一次都是几百次 stat」记为 P1）。
- 证据：
  ```
  ui.tsx:299:         await channel.invoke('refreshSessions', [])
  ui.tsx:439:         await run('refreshSessions', [])
  session/index.ts:187:         if (done.length > 0) await service.refresh()
  ```
- 影响：`refreshSessions` 全仓被 4 个界面包 14 处调用（`ui-sessions` ×6、`ui-transcript` ×3、`ui-composer` ×1、`ui-palette` ×1、TUI ×3），
  没有去抖也没有「最小间隔」。会话上百条时，一次「归档 + 回执刷新」是两次整目录扫描，用户看到的是侧栏闪两下。
- 建议：`run()` 不再无条件刷新，改成「宿主的 mutation 回执里带一个 `changed: 'list' | 'row' | 'none'`」由界面决定刷不刷；
  或在宿主侧给 `refresh()` 加 2 秒合并窗口（批次 01 的建议同向）。至少把 `ui-sessions` 里那 5 处显式调用收进 `run()`。
- 置信度：高（两处调用链都读过；实际耗时未测）

### ui-settings

#### [P1] 外观偏好归一化做了第四份，注释自承「重复这一小段比多一个 applier 划算」

- 位置：`src/packages/ui-settings/ui/ui.tsx:1219-1250`（`normalizePrefs`）；对照 `src/core/prefs.ts:180-295`、`src/packages/ui-runtime/ui/appearance.ts:84-137`
- 现象：同一组偏好被独立归一四遍。设置页这份把五条规则内联进一个函数：字号旧档映射表、字号夹取、主题四档回落、密度/过程折叠/折叠时机/折叠回复收窄、
  提示音三项回落。其中字号映射表 `{sm:0.92,md:1,lg:1.12}` 是第三份（`prefs.ts:188`、`appearance.ts:36`），
  主题默认 `'claude'` 是第四份（`prefs.ts:382`、`appearance.ts:102`、`desktop/electron/main/index.ts:105`）。
- 证据：
  ```
  1215:  * 为什么在这里再归一一次、而不 import 壳的 appearance.ts：那个模块被插件 bundle 内联
  1217:  * 归一规则很短（三档枚举 + 字号夹取），重复这一小段比多一个 applier 划算。
  1222:   const legacy: Record<string, number> = { sm: 0.92, md: 1, lg: 1.12 }
  1226:     themeMode:
  1229:         : 'claude',
  1230:   fontSize: Math.min(1.35, Math.max(0.85, Math.round(second * 100) / 100)),
  1238:   foldedReplies: prefs?.foldedReplies === 'final' ? 'final' : 'all',
  ```
- 影响：注释里的理由只成立一半——重复的**代价**确实是「一段 30 行的代码」，但它不是自由变量：`foldedReplies` 的兜底已经和契约默认相反
  （批次 04 的 P0，本批只补一行新证据：`src/contract/session.ts:173-177` 的注释写「默认 'all' 与参考实现一致」，
  而 `prefs.ts:182` 是 `'final'`、`prefs.ts:285` 的注释又写「认不出的值一律回落 all」——三句话三个说法）。
  真正该抽的不是「applier」，是**纯归一化函数**：它没有模块级状态，内联不会多出任何东西，注释里担心的「多一组模块级状态」在纯函数上不存在。
- 建议：把 `normalizeFontScale` / `normalizeTheme` / `normalizeDensity` / `normalizeProcessFold` / `normalizeCollapseTiming` /
  `normalizeFoldedReplies` / `readSoundVariant` 七个纯函数收进 `src/contract/session.ts`（零依赖，宿主与两个壳都能 import），
  `prefs.ts`、`appearance.ts`、本文件三处改为 import；`appearance.ts` 只保留 `appearanceFromPrefs` 的组装与模块级 apply 状态。
- 置信度：高（三处原文都读过；`contract/session.ts` 已是无依赖归一化文件的先例）

#### [P1] 模型草稿有两套校验，各自缺对方的一半规则

- 位置：`src/packages/ui-settings/ui/models.tsx:220-241`（界面 `validateDraft`）对照 `src/core/config-store.ts:168`、`187-214`（宿主 `validateDraft`）
- 现象：同一份 `ProviderDraft` 两边各校验一遍，规则集**不重叠**：

  | 规则 | 界面 `models.tsx` | 宿主 `config-store.ts` |
  |---|---|---|
  | 端点名字符集 | `/^[a-z0-9_-]+$/`（允许 `-`/`_` 开头） | `/^[a-z0-9][a-z0-9_-]{0,40}$/`（必须字母数字开头、限长 41） |
  | 端点名重复 | 查（`226-228`） | 不查 |
  | Base URL 形态 | 查（`225`） | 查（`191`） |
  | 模型 id 非空 | 查 | 查 |
  | 模型 id 重复 | 查（`234`） | 不查 |
  | 上下文窗口为正整数 | 查（`235`） | 查（`197`） |
  | 最大输出 ≥0 且整数 | 查（`238`） | **不查**（只 `Math.round`，`223`） |
  | `thinkingParam`/档位/模态枚举 | **不查** | 查（`201-212`） |
  | 「没勾档位但不是 none」 | **不查** | 查（`207-209`） |

- 证据：
  ```
  models.tsx:223:   if (!/^[a-z0-9_-]+$/.test(name)) return t('settings.models.validate.nameChars')
  models.tsx:234:     if (seen.has(id)) return t('settings.models.validate.duplicateId', { id })
  config-store.ts:168: const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/
  config-store.ts:207:     if (caps.thinkingParam !== 'none' && caps.thinkingLevels.length === 0) {
  ```
- 影响：输入 `-foo` 这种端点名，界面校验通过、点保存后被宿主拒（错误文案不同、指代不同）；反过来，手改 config.yaml 或旧数据里
  带重复模型 id 的端点，宿主照收、界面一打开就报 `duplicateId`，用户看到「这个端点是怎么存进去的」。
  「没勾任何思考档位」这种状态界面根本不拦，用户点保存吃宿主回执——两个校验器各自只挡住自己认得的那一半，谁都不是权威。
- 建议：宿主把校验抽成 `validateDraft(draft): string[]`（返回全部问题而不是抛第一个），经接界面通道的方法（如 `getSettingsSections` 那类只读面）
  下发或直接由 `saveProvider` 回执带 `problems: string[]`；界面只做「保存前预演」调用同一个函数，删掉本地那份规则表。
- 置信度：高（两处原文逐条比对；表里每一行都有对应行号）

#### [P1] `model-infer.ts` 的四个常量是 `core` 的手抄镜像，其中 `128000/8192` 在核心里已有三份

- 位置：`src/packages/ui-settings/ui/model-infer.ts:36`、`38`、`39-41`；对照 `src/core/model-caps.ts:19`、`28`、`31`、
  `src/core/config.ts:180-181`、`src/core/config-store.ts:138-139`、`src/core/migrate.ts:130-131`
- 现象：`DEFAULT_LEVELS`（四档清单）、`DEFAULT_PARAM`（`'thinking'`）、`FALLBACK_CONTEXT`（`128_000`）、`FALLBACK_OUTPUT`（`8_192`）
  四个值都是手抄。注释自己承认「那几条常量与 `src/core/model-caps.ts` 是同值镜像，探针里对着宿主那份断言，别各写各的」——
  也就是说，唯一的一致性保证来自一个探针，编译期没有任何约束。`128_000` / `8_192` 在核心里本来就是三份（读配置、读写配置、迁移各一份）。
- 证据：
  ```
  model-infer.ts:23:  *   那几条常量与 `src/core/model-caps.ts` 是同值镜像，探针里对着宿主那份断言，别各写各的。
  model-infer.ts:36: const DEFAULT_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'high', 'max']
  model-infer.ts:40: export const FALLBACK_CONTEXT = 128_000
  model-infer.ts:41: export const FALLBACK_OUTPUT = 8_192
  model-caps.ts:19: export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'high', 'max']
  config.ts:180:       contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 128_000,
  migrate.ts:130:         contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 128_000,
  ```
- 影响：「拉取清单」推断出来的能力值（一个没查到家族表的新模型）会按界面这份缺省填，而宿主读档时按核心那份兜底。
  今天四个值恰好相等所以看不出来；哪天把核心缺省上下文从 128k 提到 200k（这是个很可能发生的需求），
  已存的模型会被核心读成 200k，而新拉的模型仍按 128k 填进 config.yaml——同一次升级，两个模型两个缺省。
  `DEFAULT_PARAM` 抄错更贵：界面按 `'thinking'` 填、宿主认的是别的，等于发一个端点不认的字段。
- 建议：`model-caps.ts` 的四个常量（`THINKING_LEVELS`、`DEFAULT_THINKING_PARAM`、以及新增 `MODEL_CONTEXT_DEFAULT`/`MODEL_OUTPUT_DEFAULT`）
  由 `src/contract/plugin.ts` 转出，`model-infer.ts` 直接 import（它已经 `import type` 过 `@dsc/ui`，值导入同样可行，因为这几个都是纯字面量）；
  核心里那三处 `128_000`/`8_192` 同时改成引用同一个常量。
- 置信度：高（六处原文都读过，值逐字相同）

#### [P2] `models.tsx` 1935 行装 7 个组件，`ui.tsx` 1282 行装 5 类职责

- 位置：`src/packages/ui-settings/ui/models.tsx`（`ModelsGroup` 330–940、`ProviderRailItem` 942–984、`ProviderDetail` 985–1366、
  `BaseUrlInput` 1367–1400、`PaneForm` 1401–1572、`ModelFields` 1573–1788、`DiscoverDialog` 1789–1935）；
  `src/packages/ui-settings/ui/ui.tsx`（`SettingsPanel` 180–390、`GenericFields` 400–851、`EmbeddedSection` 852–875、
  `AppearanceRows` 903–1187、`normalizePrefs` 1219–1250、`NotYetPanel` 1266–1277）
- 现象：两个文件都远超 800 行。`models.tsx` 的 7 个组件属同一个功能域（模型设置），但 `ModelsGroup` 自己就背了
  17 个状态（`config`/`selected`/`draft`/`modelDraft`/`bulk`/`keyEdit`/`keyValue`/`discovered`/`discovering`/`testing`/`probed`…，`336-371`）。
  `ui.tsx` 则是**五件不同的事**：面板骨架与分区导航、声明式字段渲染器、并进父页的分区壳、外观设置整页、偏好归一化。
- 证据：
  ```
  models.tsx:330: export function ModelsGroup(): ReactNode {
  models.tsx:357:   const [discovering, setDiscovering] = useState<ReadonlySet<string>>(() => new Set())
  ui.tsx:180: function SettingsPanel(): ReactNode {
  ui.tsx:400: function GenericFields({
  ui.tsx:903: function AppearanceRows(): ReactNode {
  ```
- 影响：`ui.tsx` 里「外观」这一整页（903–1187，285 行）被追加在「通用」分区末尾（`375`：`section.id === 'general' ? <AppearanceRows /> : null`），
  与分区导航、字段渲染器处在同一文件但不共享任何状态，改外观只该动其中一块却要重新理解整个面板。
- 建议：`ui.tsx` 拆 `ui/panel.tsx`（180–390）、`ui/fields.tsx`（400–851）、`ui/appearance.tsx`（881–1250）；
  `models.tsx` 拆 `ui/models/detail.tsx`（985–1366）、`ui/models/forms.tsx`（1367–1788）、`ui/models/discover.tsx`（1789–1935），
  纯工具函数（`parseTokenCount`/`contextLabel`/`mergeCaps`/`draftOf`）单独落 `ui/models/pure.ts` 便于探针直读。
- 置信度：高（组件边界与行号逐一核对）

#### [P2] 归档页自建一套分组 + 一套「多久以前」，与侧栏是两套

- 位置：`src/packages/ui-settings/ui/archive.tsx:36-46`（`groupByWorkspace`）、`48-50`（`lastSegment`）、`52-61`（`ago`）、`71`（数据源）
  对照 `src/packages/ui-sessions/ui/grouping.ts:61-66`、`158-207`（`displayName` / `buildWorkGroups`）、`ui-sessions/ui/ui.tsx:114-123`（`relativeTime`）
- 现象：「按工作区分组、组内按时间倒序、组间按最新一条倒序」这条规则写了两遍；「相对时间」写了两遍（文案还不同：侧栏「N 天前」不带 30 天界限，
  归档页超过 30 天直接给绝对日期）。两处的数据源也不同：侧栏读宿主快照里的 `sessions`（含归档行，`session/index.ts:136` 把活动区与归档区拼成一份），
  归档页另调 `listArchivedSessions`（`session/index.ts:196-214`）拿 `ArchivedPage`（多 `trashDir`/`trashCount`、行形状是 `path` 而非 `id`）。
- 证据：
  ```
  archive.tsx:45:     .sort((a, b) => (b.items[0]?.archivedAt ?? 0) - (a.items[0]?.archivedAt ?? 0))
  archive.tsx:71:       .invoke<ArchivedPage>('listArchivedSessions')
  grouping.ts:181:     .sort((a, b) => {
  ui.tsx:114: function relativeTime(at: number): string {
  ```
- 影响：`listArchivedSessions()`（`core/session.ts:1251`）在一个工作区里被读两遍（`session/index.ts:136` 与 `199`）——两处各自 `readdirSync` 归档区、
  各自解析 meta。归档一条会话后，侧栏与设置页要各自重扫一遍才能一致；两边的时间文案不一致，用户会以为「归档时间」有两个值。
- 建议：归档页的分组直接复用 `buildWorkGroups`（喂 `ArchivedFilter: 'only'` 的输入即可），相对时间并进批次 04 建议的 `formatAgo(ts, now, granularity)`；
  宿主侧让快照的 `sessions` 与 `ArchivedPage.items` 出自同一次扫描。
- 置信度：高（四处原文都读过）

### ui-plugins

#### [P1] 「停用/启用后是否要刷新」在界面侧按卡片种类硬判，与宿主按行 id 的判定相反

- 位置：`src/packages/ui-plugins/ui/ui.tsx:693-699`（`PluginCard` 的开关提示）、`869`（`TrustCard` 的开关提示）；
  对照 `src/packages/runtime/index.ts:191`、`194-210`、`219`，`src/packages/ui-plugins/locale/ui.zh.json:42-46`
- 现象：宿主那边唯一的「要刷新吗」判据是 `const rootEntry = file === 'ui-layout' || file === 'ui-renderer'`（`runtime/index.ts:191`），
  `rootEntry` 为真时不发 `dsc/ui-plugins-changed`（页面因此不会热换），提示语也换成「刷新页面（或重启宿主）后生效」。
  界面侧没有读这个判定，而是按**卡片种类**写死：
  - 所有 `PluginCard`（含 `ui-layout` / `ui-renderer` 这两行）标「停用（即时生效）」；
  - 所有 `TrustCard`（第三方界面插件，键恒为 `<目录名>/ui/client.js`，不可能等于 `ui-layout`）标「停用（刷新页面后生效）」。
- 证据：
  ```
  ui.zh.json:42:   "plugins.card.disableNow": "停用（即时生效）",
  ui.zh.json:45:   "plugins.card.disableReload": "停用（刷新页面后生效）",
  ui.tsx:696:             ? row.enabled
  ui.tsx:697:               ? t('plugins.card.disableNow')
  ui.tsx:869:             data-tip={row.enabled ? t('plugins.card.disableReload') : t('plugins.card.enableReload')}
  runtime/index.ts:191:         const rootEntry = file === 'ui-layout' || file === 'ui-renderer'
  runtime/index.ts:198:           `已${enabled ? '启用' : '停用'}第三方界面插件「${name}」，${rootEntry ? '刷新页面（或重启宿主）后生效' : '即时生效'}`,
  ```
- 影响：两类提示都错。停用 `ui-layout` 后宿主明确要刷新，界面却说「已即时生效」——用户盯着一个没变的页面；
  停用第三方界面插件后宿主是即时生效，界面说「刷新页面后生效」——用户白按一次 F5（而这一次刷新会丢掉他正在看的对话滚动位与输入草稿）。
  这是「同一个判定两处各算一遍」的教科书样本：改宿主的 `rootEntry`（比如以后加 `ui-dockkit`）界面不会跟着改，且没有任何编译期信号。
- 建议：`PluginInfoView` / `UiTrustView` 各加一个 `reloadRequired?: boolean`（由 `runtime.setPluginEnabled` 与 `listPluginInfos` 同一处算好），
  界面只读字段选文案；在那之前，至少把 `PluginCard` 对 `file.startsWith('ui-layout') || file.startsWith('ui-renderer')` 补一条分支。
- 置信度：高（宿主判定与两处文案都逐行读过；`UiTrustView.key` 的形状见 `ui.tsx:116-117` 与 `keyOf` 的注释）

#### [P1] 两条启停路径保证不同：界面那条有内核闸与事件，AI 工具那条两样都没有

- 位置：`src/packages/runtime/index.ts:178-223`（`setPluginEnabled`）对照 `src/packages/plugin-manager/index.ts:72-79`（工具 `enable`/`disable`）、
  `src/core/plugin-loader.ts:908-926`（`setPluginEnabledHot`）、`src/core/plugin-registry.ts:423-435`（`writePluginEnabled` 的返回值语义）
- 现象：界面路径 `runtime.setPluginEnabled` 做三件事——(1) 先 `writePluginEnabled(file, enabled)`，返回 false（内核行）就写一条 system 说明并 return；
  (2) 按 `rootEntry` 决定发不发 `dsc/ui-plugins-changed`；(3) 写 system 条目回执。
  `plugin_manager` 工具直接 `await setPluginEnabledHot(file, …)`，而 `setPluginEnabledHot` 内部**丢弃**了 `writePluginEnabled` 的返回值：
  内核行（`source='builtin'` 且无 `toggleable`）会先 `await unmountExternalPlugin(file)`（对没登记在热挂载表里的行是静默 no-op），
  然后写盘失败被忽略，最后返回 `{ok:true}`。
- 证据：
  ```
  plugin-manager/index.ts:76:             const outcome = await setPluginEnabledHot(file, action === 'enable')
  plugin-manager/index.ts:78:             return `已${action === 'enable' ? '启用' : '停用'}插件 ${file}（热生效，已写盘持久化）`
  plugin-loader.ts:920:     writePluginEnabled(file, true)
  plugin-loader.ts:924:   writePluginEnabled(file, false)
  registry.ts:429:   const canToggle = meta === undefined || meta.source === 'external' || meta.toggleable === true
  registry.ts:430:   if (!canToggle) return false
  ```
- 影响：模型对内核行说「停用 goal」，工具回「已停用插件 goal（热生效，已写盘持久化）」——写盘没发生、挂载也大概率没变，
  这是一句假回执；而 `plugins.json` 与内存里那份到底谁对，要靠「重启一次还记得吗」才能发现。
  对第三方界面插件（键 `<目录名>/ui/client.js`）情况反过来：写盘成功、页面不换（没发 `dsc/ui-plugins-changed`），表现成「停用了但界面还在」。
- 建议：`setPluginEnabledHot` 改为返回 `{ ok, problem?, changed?: boolean }` 并把 `writePluginEnabled` 的 false 折成 `ok:false`；
  `plugin_manager` 工具改成调 `runtime.setPluginEnabled`（同一入口、同一事件、同一回执），不直接摸 loader。
- 置信度：中（三条路径的控制流已逐行核对；`unmountExternalPlugin` 对未登记行是否真的 no-op 只读了函数头「未挂载时静默」，没验证内置行是否在表里 → 见待核实）

#### [P1] 声明式设置表单有两份 275 行的同构实现，新的字段类型要改两处

- 位置：`src/packages/ui-settings/ui/ui.tsx:400-851`（`GenericFields`）对照 `src/packages/ui-plugins/ui/ui.tsx:1022-1296`（`ConfigFields`）
- 现象：六种控件（info/button/select/switch/text/number）的渲染、提交时机（下拉与开关即写、文本失焦或回车才写）、
  「选项外的值也要看得见」、`derivedLabelKey` 置灰只读、失败回执走表单底部行内说明——两边的判断序列与 class 名逐条同构。
  注释自己说明这是刻意的（插件 bundle 之间不能互相 import）。
- 证据：
  ```
  ui-settings/ui/ui.tsx:400: function GenericFields({
  ui-plugins/ui/ui.tsx:1014:  * 声明式配置表单：设置面板 `GenericFields` 的同构移植（同一套 class 与提交时机：
  ui-plugins/ui/ui.tsx:1022: function ConfigFields({ section, onAction }: { section: SettingsSectionView; onAction: () => void }): ReactNode {
  ui-plugins/ui/ui.tsx:1192:         : [...field.options, { value: current, label: t('plugins.config.unrecognized', { value: current }) }]
  ui-settings/ui/ui.tsx:702:       const options = listed ? field.options : [...field.options, { value: current, label: t('settings.ui.unknownOption', { value: current }) }]
  ```
- 影响：设置页比插件页多三样（`field.actions` 的行内动作、配对弹窗、更新横幅），插件页没有；插件页比设置页少一整段。
  加第七种控件（比如 `textarea`、`password`）或改一次提交时机，必须改两处 275 行，漏一处的表现是「设置页能存、插件详情页存不了」。
  两边的 i18n key 也各一套（`settings.ui.unknownOption` vs `plugins.config.unrecognized`），同一句「认不出的值」译了两次。
- 建议：把渲染器下沉到 `@dsc/ui-primitives`（它已经是所有插件共用的平台种子，`plugin-api.ts:421` 整包转出），
  签名收敛成 `<DeclaredFields section values draft note onCommit onAct onAction />`，两边只保留各自的 `useState` 与副作用；
  设置页独有的 `field.actions` 用可选 prop 打开。
- 置信度：高（两份实现都完整读过，逐段比对）

#### [P2] 插件清单的三种呈现各算一遍「已停用 / 内核 / 有问题」标记

- 位置：`src/packages/ui-plugins/ui/ui.tsx:626-708`（卡片）、`src/packages/plugin-manager/index.ts:26-37`（`renderList`）、
  `src/packages/commands/index.ts:628-634`（`/plugins` 命令）
- 现象：三处消费同一份 `PluginInfoView[]`（`core/plugin-registry.ts:477-498`），各自把 `source`/`enabled`/`problem`/`toggleable` 折成一行字。
  `/plugins` 那处还硬编了「启停与配置在桌面端「插件」页」这句话，而插件页本身在壳里是主区整页、不在设置里（`ui-settings/ui/ui.tsx:242` 的注释专门纠正过这一点）。
- 证据：
  ```
  plugin-manager/index.ts:31:       const state = info.enabled ? '启用' : '停用'
  commands/index.ts:629:           const flags = [plugin.source === 'builtin' ? '内核' : '外部', plugin.enabled ? undefined : '已停用']
  ui.tsx:659:         <div className={`plugin-desc${row.problem !== undefined ? ' problem' : ''}`}>
  ```
- 影响：加一个来源档（例如将来的「共享插件」）或改一次「工程内核」的措辞，要同步三处；`/plugins` 的定位话术已经在指错地方。
- 建议：在 `contract/plugin.ts` 给 `PluginInfoView` 加一个派生的 `badges: string[]`（上游算好），三处都只渲染数组；`/plugins` 的指路文案改成「插件页 / 插件详情」。
- 置信度：高（三处原文都读过）

#### [P2] 三个 600ms 的 `setTimeout` 当同步屏障用

- 位置：`src/packages/ui-plugins/ui/ui.tsx:251`、`268`、`315`
- 现象：启停与安装之后都用 `setTimeout(refresh|loadTrusts, 600)` 等宿主「写完再读」。这是把一次异步完成事件换成了一个固定的猜测值：
  宿主要先写盘、再挂载/卸载 cordis fiber、再写 system 条目，耗时没有上界（插件 import 慢、磁盘排队都会超）。
- 证据：
  ```
  251:         setTimeout(loadTrusts, 600)
  268:         setTimeout(refresh, 600)
  315:         setTimeout(refresh, 600)
  ```
- 影响：500ms 未完成时读到旧值——界面把刚打开的开关又画回关闭（随后 `refresh` 已经跑完，用户看到闪一下）；
  3 秒才完成时列表在两秒里显示的是过期状态。三处魔数还各自独立，调一处不影响另两处。
- 建议：`setPluginEnabled` / `installPlugin` / `setUiTrust` 的回执里带最终 `enabled` 或 `rows` 快照，界面直接采信；
  或者让宿主在完成后 emit 一个 `dsc/plugins-changed`，界面订阅它重取（与 `dsc/ui-plugins-changed` 同一通道）。
- 置信度：高（三处原文 + 宿主侧 `setPluginEnabled` 的分支都读过）

### ui-files / ui-preview

#### [P0] 某个文件的「改动快照」只有一份内存表、没有失效点，而新入口（预览页签）刚接到它上面

- 位置：`src/packages/ui-dockkit/ui/dock-state.ts:276`（`patchSources`）、`259-267`（`setDockPreview` 带 patch → 补丁页签）、
  `345-349`（**在途新增** `setDockFileView` → 预览页签）；消费方 `src/packages/ui-preview/ui/ui.tsx:112`、`163-181`、`194-198`（在途改动）；
  另一个入口 `src/packages/ui-files/ui/ui.tsx:186`（文件树点一行）
- 现象：`patchSources` 是 `Map<文件绝对路径, ChangedFileView>`，只在 `set` 里出现（`dock-state.ts:261`、`346`），**全仓没有任何 `delete`/`clear`**。
  它原本是补丁页签的私有数据：那张页签自带路径、重启后读不到就显示「已过期」（`ui-preview:215` 的注释与 `274` 的 `patch.gone`）。
  在途改动把新入口 `setDockFileView` 接到同一张表上，但预览页签**不区分**「这份 patch 是哪次挂上来的」：
  `PreviewBody` 无条件 `useDockPatchSource(path)`，非 null 就画增删计数与「改动 / 预览」开关。
- 证据：
  ```
  dock-state.ts:276: const patchSources = new Map<string, ChangedFileView>()
  dock-state.ts:346:   patchSources.set(target.path, target.patch)
  ui-preview/ui/ui.tsx:112:   const patchSource = useDockPatchSource(path)
  ui-preview/ui/ui.tsx:163:         {patchSource === null ? null : (
  ui-files/ui/ui.tsx:186:             onClick={() => setDockPreview({ path: entryPath })}
  ```
- 影响：可复现的步骤——(1) 让 agent 改一次 `foo.ts`；(2) 从轮尾「文件已更改」卡点开 `foo.ts`（此刻挂上 patch）；(3) 关掉这张页签；
  (4) 在右侧栏文件树里点 `foo.ts`（走 `setDockPreview({path})`，不带 patch）。页签头上会显示**上一刀**的 `+N/−N` 和一个「改动」开关，
  点开看到的也是旧 hunks。用户没有任何线索分辨这是历史还是当前。
  换会话、换轮次都不清（只按路径键，而路径是全局的）；同一张表还只增不减——`dock-state.ts:269-275` 自己说明「hunks 可能很大」所以不落盘，但没有淘汰策略。
- 建议：给这份状态补失效点，三选一（推荐前两个一起做）：(1) `setDockPreview` 无 patch 时 `patchSources.delete(path)`（「打开当前内容」应该清掉历史改动）；
  (2) `ChangedFileView` 带 `capturedAt` + 那一轮的 `sessionPath`/`turnKey`，预览页签只在同一个 turn 内认它；
  (3) 页签关闭（`dockActions.closeTab`）时按 tab.path 清。并对这张表加上限（例如按最近使用保留 20 条）。
- 置信度：高（静态可判定：`patchSources` 的全部出现点已穷举为 2 处 `set` + 1 处 `get`，无清除；预览页签无条件读它。未实机复现 → 见待核实）

#### [P1] 「看某个文件的改动」有三个入口、三种载体，其中一条整块已经停用但代码还在

- 位置：
  - 补丁页签：`ui-dockkit/ui/dock-state.ts:259-267` → `ui-preview/ui/ui.tsx:81-86`、`212-286`（`PatchTab`/`PatchBody`），调用方 `ui-transcript/ui/tool-card/factory.tsx:610`
  - 预览页签带「改动」开关：`dock-state.ts:345-349`（在途）→ `ui-preview/ui/ui.tsx:111-113`、`194-198`，调用方 `ui-files/ui/changes.tsx:198`（在途）、`ui-transcript/ui/rows/changes-card.tsx:199`（在途）
  - 并排审查面板：`ui-layout/ui/review-pane.tsx:55`（215 行），入口 `changes-card.tsx:198` 已注释
- 现象：文档口径是「审查与 Git 改动预览统一走预览页签」，代码里同时存在三条：
  工具卡点文件名仍走**补丁页签**（`kind: 'patch'`，默认就画 diff）；轮尾卡与 Git 面板走**预览页签**（默认渲染文件内容、可切 diff）；
  并排审查面板的 `ReviewPane` 已被注释掉（`ui-layout/ui/app.tsx:82` 的 import、`636-641` 的渲染），但整份组件与它的偏好键都还在。
- 证据：
  ```
  factory.tsx:610:         setDockPreview(opensPatch ? { path: absPath, cwd, patch } : { path: absPath, cwd })
  app.tsx:639:                 {/* 并排审查面板已停用（2026-11-08）：审查与 Git 改动预览统一到右侧栏的文件预览页签
  app.tsx:641:                 {/* <ReviewPane /> */}
  changes-card.tsx:198:     // setDockReview({ files, index, cwd })
  ui-primitives/ui/panels.ts:48:   diffPaneWidth: 'dsc.diffPaneWidth',
  core/prefs.ts:348:   for (const key of ['sidebar', 'thread', 'dock', 'diff'] as const) {
  ```
- 影响：同一个手势（点一个文件的改动）在不同位置打开不同种类的页签，用户学不会；两套 diff 渲染（`PatchBody` 与 `PreviewBody` 的 patchView）
  都要维护 `DiffRows` 的入参与「截断说明」。
  更实质的是死代码的成本：`ReviewPane`（215 行）已无导入方，`setDockReview` 只剩 `review-pane.tsx:189` 自己调来关闭；
  `app.tsx:599`/`636` 还留着一个**永远**为 null 的 `review` 判断；`settings.json` 仍在读写一个没人用的 `diff` 面板宽度
  （`prefs.ts:348`、`panels.ts:48/55/79/91`）。这一串只要有人「顺手清理 `review === null`」，就会以为审查面板还会出现。
- 建议：一次收干净——(1) `factory.tsx:610` 改调 `setDockFileView`，删掉 `kind: 'patch'` 的报名与 `PatchTab`/`PatchBody`；
  (2) 删 `review-pane.tsx`、`dockReview`/`setDockReview`/`useDockReview`、`app.tsx` 的三处 `review` 判断；
  (3) 删 `PANEL_KEYS.diffPaneWidth` 与 `prefs.ts:348` 的 `'diff'`（保留读档对未知键的容忍）。三步可分开验收。
- 置信度：高（三条链的每一跳都读过；`ReviewPane` 的导入方用全仓 grep 穷举为 0）

#### [P2] `changes.tsx` 换到预览页签后，旧的就地展开路径残留成不可达代码

- 位置：`src/packages/ui-files/ui/changes.tsx:145-162`（`toggleDiff`）、`76-80`（`Expanded.file`）、`347-354`（只画 `file === null` 的那支）、
  `566-573`（`GitDiffView` 的 `inline`）、`587`（`git-diff-inline`）
- 现象：在途改动把三个分组的 `onShowDiff` 换成了 `onOpenFile`（预览页签），但 `toggleDiff(group, file)` 与随之而来的状态没删：
  `toggleDiff` 现在**只被** `276` 行的「全部改动」按钮以 `('all', null)` 调用，所以 `expanded.file` 永远是 null，
  `GitDiffView` 的 `inline` 永远不传，`152` 行那个 `staged` 分支与 `146` 行的「再点一次收起」判定都不可达。
- 证据：
  ```
  145:   const toggleDiff = (group: string, file: string | null): void => {
  152:     const payload = file === null ? {} : group === 'staged' ? { file, staged: true } : { file }
  276:             toggleDiff('all', null)
  347:       {expanded !== null && expanded.file === null ? (
  573:   inline?: boolean
  ```
- 影响：读者会以为「点文件行就地展开」还活着（`Expanded` 的注释 `76` 与 `GitDiffView` 的注释 `566` 都这么写），
  下一次给 Git 面板加功能时会照这条不存在的路改；`git-diff-inline` 这套 CSS 也失去唯一消费方（样式层已归批次 03 管，这里只登记代码侧）。
- 建议：`Expanded` 收成 `{ group: string } | null`（或直接用一个 `boolean`），`toggleDiff` 去掉 `file` 参数，
  删 `staged` 分支与 `inline`/`git-diff-inline`；「全部改动」保留为单个布尔。
- 置信度：高（`toggleDiff`/`GitDiffView` 的全部引用点已 grep 穷举）

#### [P2] dock op 名有宿主那份规范表，界面 6 个包各写字符串字面量；方法名还分成 `dock` 与 `terminal` 两个

- 位置：`src/core/dock-ops.ts:23-24`（自称「三处共用」）、`30`、`33-39`、`42`；
  内联字面量：`ui-files/ui/ui.tsx:114`（`fs-list`）、`ui-files/ui/changes.tsx:111`、`154`、`180`、`211`、`239`、
  `ui-preview/ui/ui.tsx:124`、`137`（`fs-read`）、`ui-status/ui/ui.tsx:905`（`git-status`）、
  `ui-transcript/ui/intended-diff.ts:209`（`fs-read`）、`ui-composer/ui/mention.ts:38`（`fs-list`）、
  `ui-terminal/ui/ui.tsx:181`、`219`、`234`、`239`（`term-*`，方法名是 `terminal` 而非 `dock`）
- 现象：`dock-ops.ts` 的注释写「这一份零依赖、浏览器安全，所以三处共用：宿主插件、界面通道、桌面主进程与壳」，
  但那三处指的是**宿主侧**；真正发请求的界面包一个都没 import 它（`@dsc/ui` 的导出面里也没有它），
  13 处调用各自手写 op 名与 payload 形状。终端那一族还换了方法名：`native.invoke('terminal', ['term-spawn', …])` 走原生桥，
  其余走 `channel.invoke('dock', [op, …])` 走界面通道。
- 证据：
  ```
  dock-ops.ts:23:  * 这一份零依赖、浏览器安全，所以三处共用：宿主插件（分档与审批）、界面通道（放行面）、
  ui-files/ui/ui.tsx:114:     .invoke<Listing>('dock', ['fs-list', { dir: path }])
  ui-preview/ui/ui.tsx:124:       .invoke<ReadResult>('dock', ['fs-read', { file: path }])
  ui-terminal/ui/ui.tsx:239:       .invoke<{ id: string }>('terminal', ['term-spawn', { cwd, shell }])
  ```
- 影响：改一个 op 名（例如 `git-status` → `git:status`）要靠全仓 grep，漏一处是运行时「未知 op」；
  payload 形状（`{file, staged}`、`{stats:true}`、`{dir}`）也没有类型约束，两处传错字段不会编译报错。
- 建议：把 `DOCK_READ_OPS`/`DOCK_WRITE_OPS` 与 payload 的 TypeScript 形状放进 `contract/plugin.ts`（浏览器安全），
  `@dsc/ui` 转出；界面侧改成 `dockInvoke('fs-read', { file })` 这类带重载的包装，`terminal` 那一族也挂进同一张表（区分传输即可）。
- 置信度：高（13 处调用点已 grep 穷举，宿主侧 `ui-methods.ts:85` 与 `native-bridge.ts:57` 的引用也核对过）

### ui-skills

#### [P2] 技能页与插件页不共享市场逻辑（一个有一个没有），但「整页 + 分组 + 展开更多 + 空态卡」外壳各写一份

- 位置：`src/packages/ui-skills/ui/ui.tsx:117-121`、`265-283`（分组）、`680-837`（市场段）、`360-394`（安装）；
  `src/packages/ui-plugins/ui/ui.tsx:86`（`GROUP_PREVIEW = 10`）、`340-356`（分组与展开）、`602-619`（`GroupMore`）、`428-438`（空态卡）；
  对照 `ui-sessions/ui/ui.tsx:93`（`PREVIEW_COUNT = 5`）
- 现象：先回答问题本身——**市场浏览/安装只有技能页有**：`browseMarket`（`ui-methods.ts:143` 放行）与原生桥 `installMarketSkill`/`setMarketSources`
  只在 `ui-skills` 出现；插件页没有任何市场浏览，它的安装是「系统文件选择器选一个 .js」（`ui-plugins/ui/ui.tsx:305-320` 的 `installPlugin`），
  与 `plugin_manager` 工具的 `browse_remote`/`install_remote`（`packages/plugin-manager/index.ts:101-143`，走 `config-core/market.js`）不是同一套。
  所以「两个市场各写一份」这个问题**不成立**（插件市场目前只有 AI 工具能用，没有界面）。
  真正的重复在页面外壳：「标题 + 一条 lead + 分组标题 + 每组前 N 条 + `GroupMore` 展开其余 + 空态卡」在技能页与插件页各写一遍，
  阈值还是两个不同的数（`GROUP_PREVIEW = 10` vs 侧栏 `PREVIEW_COUNT = 5`）。
- 证据：
  ```
  ui-plugins/ui/ui.tsx:86: const GROUP_PREVIEW = 10
  ui-plugins/ui/ui.tsx:347:   function shownOf<T>(key: PluginGroupKey, list: readonly T[]): readonly T[] {
  ui-skills/ui/ui.tsx:265:   const groups = useMemo(() => {
  ui-skills/ui/ui.tsx:829:           {(market?.items.length ?? 0) === 0 && market?.error === undefined && !marketLoading && market !== null && (
  ```
- 影响：加一个「按来源折叠」的交互或改一次「展开其余 N 个」的文案，两个页面各改一遍；三处阈值（5/10/市场分页）没有统一口径，
  用户在不同列表里遇到的「默认露几条」不一样。若将来给插件页补市场，会天然复制技能页那 150 行。
- 建议：把「分组 + 前 N 条 + 展开其余 + 空态卡」抽成 `@dsc/ui-primitives` 的 `<GroupedList items groups previewCount renderRow empty />`，
  两个页面各传数据；市场那一套等插件页真要加时再抽（现在抽会抽空）。
- 置信度：高（两页的相关段都读过；市场逻辑的唯一性用 grep 穷举过 `browseMarket`/`installMarketSkill`/`setMarketSources`）

---

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
|---|---|---|---|---|
| 看某个文件的改动 | 补丁页签：`dock-state.ts:259-267` → `ui-preview:212-286`（`PatchTab`） | 预览页签带「改动 / 预览」开关：`dock-state.ts:345-349` → `ui-preview:111-198` | 工具卡 `factory.tsx:610`（仍走旧的）；轮尾卡与 Git 面板已走新的 | 工具卡改 `setDockFileView`，删 `kind:'patch'` 与 `PatchTab` |
| 并排审查 | `ui-layout/ui/review-pane.tsx`（215 行） | 同上（预览页签） | 已无（`app.tsx:82`/`641` 注释、`changes-card.tsx:198` 注释） | 整块删，连同 `dockReview`/`setDockReview`/`useDockReview` 与 `diffPaneWidth` 偏好键 |
| Git 面板就地展开 diff | `changes.tsx:145-162` `toggleDiff(group, file)` + `GitDiffView(inline)` | 同「看某个文件的改动」 | 只剩「全部改动」按钮用 `('all', null)` 一支 | 收成布尔，删 file 分支与 `inline` |
| 归档列表 | 侧栏快照 `sessions`（`session/index.ts:136` 把归档区拼进列表） | `listArchivedSessions` → `ArchivedPage`（`session/index.ts:196-214`） | 两条都活：侧栏按 `archivedFilter` 筛，设置页整页读 | 让两者出自同一次扫描；界面至少复用同一份分组与相对时间 |
| 插件启停 | `runtime.setPluginEnabled`（内核闸 + 发 `dsc/ui-plugins-changed` + system 回执） | `plugin_manager` 工具直调 `setPluginEnabledHot`（无闸、无事件） | AI 工具 | 工具改走 `runtime.setPluginEnabled` |
| 外观偏好的归一化 | `core/prefs.ts` `readPrefs` + 七个 `read*` 归一函数 | `ui-runtime/ui/appearance.ts:84-137`；`ui-settings/ui/ui.tsx:1219-1250` | 三条都活（宿主、壳、设置页各一份） | 纯归一函数收进 `contract/session.ts`，三处 import |
| 模型草稿校验 | `core/config-store.ts:187-214`（抛第一个错） | `ui-settings/ui/models.tsx:220-241`（返回一句文案） | 两条都活 | 宿主返回 `problems: string[]`，界面调同一个函数 |
| 模型能力缺省 | `core/model-caps.ts:19/28/31`、`core/config.ts:180-181` | `ui-settings/ui/model-infer.ts:36-41` | 两条都活 | 常量从 contract 转出，界面 import |
| 侧栏偏好解析 | `core/prefs.ts:422-496`（裁长、去重） | `ui-sessions/ui/ui.tsx:1488-1525`（不裁、不去重） | 两条都活 | 解析函数收进合同层一份 |
| 「今日用量」 | `ui-runtime/ui/usage-today.ts`（`useTodayUsage`，末位即今天） | `ui-settings/ui/usage.tsx:269-278`（自己读 `usageStats` 再取 `days`） | 两条都活 | 设置页复用 `useTodayUsage` 或抽出 `todayOf(stats)` |

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
|---|---|---|---|---|
| 「多久以前」 | `ui-sessions/ui/ui.tsx:114-123` `relativeTime`（分/时/天） | `ui-settings/ui/archive.tsx:52-61` `ago`（多 30 天界限、超了给绝对日期）；另有 `ui-transcript/welcome.tsx:152-159`、`ui-status/ui/status-model.ts:215-222`（批次 04 已记） | 四份，取整与界限都不同 | 合成 `formatAgo(ts, now, { granularity, maxDays })` 进 primitives |
| 路径末段 | `ui-primitives/ui/paths.ts:31-34` `baseNameOf` | `ui-sessions/grouping.ts:69-73`、`ui-settings/archive.tsx:48-50`、`ui-settings/models.tsx:169-172`、`ui-primitives/file-type-classify.ts:363`、`ui-primitives/highlight.ts:22`、`tui/app/App.tsx:99-103`、`tui/app/ChatView.tsx:121` | 八份；`grouping.ts` 那份多处理尾部反斜杠，其余直接 `pop()` | 只留 `baseNameOf`，其余改 import |
| 会话短 id（路径末段 + 剥 `.jsonl`） | `ui-primitives/ui/snapshot.ts:85-92` `readSessionId` | `ui-sessions/ui/ui.tsx:550-555` `copyId`；`tui` 三处（`AgentsOverlay:34`、`ApprovalCard:42`、`StatusBar:53`） | TUI 那三处还多切 8 位 | 上收 `shortSessionId(path, max?)` |
| 枚举字段收窄（`value === 'x' ? 'x' : 默认`） | `ui-sessions/ui/ui.tsx:1488-1490` `readEnum` | `core/prefs.ts:261/276/291` 三个；`ui-runtime/appearance.ts:91/99/110/119` 四个；`ui-settings/ui/ui.tsx:1226-1238` 五个内联；`ui-transcript/ui/ui.tsx:718` 一个 | 十四个，其中 `foldedReplies` 的兜底值已分叉（批次 04 P0） | `contract/session.ts` 出一份 `readEnum(value, values, fallback)`，各处只留枚举表 |
| 外观偏好的整份归一化 | `core/prefs.ts:360-500` | `ui-runtime/appearance.ts:128-137`；`ui-settings/ui/ui.tsx:1219-1250` | 三份；字号映射表在三处逐字相同，主题默认 `'claude'` 四处 | 见 P1 第二条 |
| 模型能力缺省常量 | `core/model-caps.ts:19/28/31`（四档 / `thinking` / `DEFAULT_CAPS`） | `ui-settings/ui/model-infer.ts:36-41`（`DEFAULT_LEVELS`/`DEFAULT_PARAM`/`FALLBACK_CONTEXT`/`FALLBACK_OUTPUT`） | 注释写「同值镜像，探针里对着宿主断言」 | 常量进 contract，删镜像 |
| `128_000` / `8_192` 缺省 | `core/config.ts:180-181` | `core/config-store.ts:138-139`、`core/migrate.ts:130-131`、`ui-settings/model-infer.ts:40-41` | 五处字面量 | 一个 `MODEL_DEFAULTS` 常量 |
| 声明式设置表单 | `ui-settings/ui/ui.tsx:400-851`（452 行） | `ui-plugins/ui/ui.tsx:1022-1296`（275 行） | 设置页多 `field.actions`/配对弹窗/更新横幅；i18n key 各一套 | 下沉 primitives，见 P1 |
| 归档分组与排序 | `ui-sessions/ui/grouping.ts:158-207` `buildWorkGroups` | `ui-settings/ui/archive.tsx:36-46` `groupByWorkspace` | 前者支持三档分组与手动顺序，后者只有「按 cwd 分组 + 时间倒序」 | 归档页复用 `buildWorkGroups`（喂 `archived: 'only'`） |
| 插件清单的一行文案 | `ui-plugins/ui/ui.tsx:626-708` | `packages/plugin-manager/index.ts:26-37`；`packages/commands/index.ts:628-634` | 三套「已停用 / 内核 / 有问题」措辞 | 上游给 `badges: string[]` |
| 「今日用量」的取法 | `ui-runtime/ui/usage-today.ts:38-67` | `ui-settings/ui/usage.tsx:269-278` | 都取 `days` 末位；一份带 60s 轮询，一份只读一次 | 抽 `todayOf(stats)` |
| 原生桥缺席的说明 | `ui-skills/ui/ui.tsx:329/344/363/415` | `ui-plugins/ui/ui.tsx:215/281/306/1123`、`ui-sessions/ui/ui.tsx:1310/1872/1944`、`ui-settings/ui/ui.tsx:480/533/613/814`、`ui-terminal/ui/ui.tsx:100`、`ui-browser/ui/ui.tsx:257`、`ui-statusbar/ui/ui.tsx:598` | 17 处 `if (!native.available)`，各自挑一句 toast/空态 | primitives 出 `requireNative(fallback)` |
| 上下文窗口缩写 | `ui-settings/ui/models.tsx:144-151` `contextLabel`（`128K`） | `ui-composer/ui/model-picker.ts:183-186`（`128k`，批次 04 已记）；**新证据** `packages/llm/index.ts:275`（`${Math.round(x/1000)}k 上下文`，进模型的 description 文本） | 三份，两处大写一处小写，宿主那份还嵌进一句话里 | 宿主与两个界面都用 `formatTokens` 同族函数 |
| 页面外壳（标题 + 分组 + 展开其余 + 空态卡） | `ui-plugins/ui/ui.tsx:369-594`、`602-619` | `ui-skills/ui/ui.tsx:265-283`（分组）、`680-837`（市场段的分组与空态）；侧栏的「展开剩余」在 `ui-sessions/ui/ui.tsx:1091-1110` | 三处阈值不同（10 / 市场分页 / 5） | 抽 `<GroupedList>` |

## 待核实

1. **P0 的实机复现**：`patchSources` 陈旧这条是纯静态推断（全仓 `patchSources` 只有 2 处 `set`、1 处 `get`，无 `delete`/`clear`；`PreviewBody` 无条件读它）。
   我没跑界面验证「从文件树再点开同一个文件会看到旧徽标」，也没验证 `dockActions.openPreview` 是否在别处间接触发清理（只读了 `dock-state.ts:120-180` 的接线）。
2. **`plugin_manager` 对第三方界面插件键（`<目录名>/ui/client.js`）的写入是否真被启动图读到**：`ui-bundles.ts:1040`/`1619`/`1633` 都是
   `isPluginEnabled(fileKey)`，键形状与 `keyOf` 一致；但 `writePluginEnabled` 走的是 `catalog.get(file)`（对这类键恒 undefined，所以 `canToggle` 为真、写盘成功）。
   这条链我只读了三个函数，没跑「AI 停用第三方界面插件」的完整路径。
3. **`unmountExternalPlugin` 对内置/内核行是否真是 no-op**：`plugin-loader.ts:884-889` 的注释写「未挂载时静默」，但内置插件是否登记在
   `mountedOf(current)` 那张表里我没查到（`mountExternalPlugin` 的写入点未读）。这决定 P1 第三条的实际后果是「假回执」还是「真的卸了内核插件」。
4. **`ui-settings/ui/heatmap.ts`（108 行）与 `core/usage-log.ts` 的日桶定义**是否同口径：只读了 `usage.tsx` 的消费段，`heatmap.ts` 与宿主聚合都没读。
5. **`PREVIEW_COUNT = 5` / `GROUP_PREVIEW = 10` 是否被探针钉住**：`scripts/ui-interaction-base-test.mjs`、`scripts/ui-status-panel-test.mjs`
   等探针未读（本批禁跑测试），删改阈值前要先 grep 探针。
6. **`ui-skills` 的市场源解析与宿主是否两套**：界面 `saveSources`（`ui-skills:400-421`）按「名字, 地址」逐行切分后交给原生桥
   `setMarketSources`；宿主侧解析（`core/prefs.ts` 的 `marketSources` 或 `config-core/market.ts`）未读，无法判断校验规则是否重复。
7. **主题默认值的新证据**：本批新增 `ui-settings/ui/ui.tsx:881-886` 的 `THEME_TILES`（主题四档的**第五份**字面量，前四份见批次 03 的 F6）
   与 `1226-1229` 的 `'claude'` 回落。批次 03 的结论不变，只是默认值来源多数了一处。
8. **`ui-browser` 的原生事件名有两套拼法**：`browser-open-requested`（`native-bridge.ts:205`、`desktop/electron/main/dock.ts:116`）与
   `browser-tab-open-request`（`core/dock-browser.ts:225` 的 `DOCK_TAB_OPEN_EVENT`、`ui-browser/ui/ui.tsx:79`）。两者是不同事件（per-tab vs 全局，
   `ui-browser:74-77` 的注释专门区分过），但命名不成体系；我未判断是否该统一，留给出命名规范的人。
