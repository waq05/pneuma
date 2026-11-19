# 批次 04：对话呈现（transcript / composer / prompt / statusbar / trace / ask / status / team / tasks）

> 状态：已归档（2026-11-17）：2026-11-09 一次性审查报告；14 条 P0 已全部修复（见同目录 FIXES.md）。

> 审查快照：分支 `feat/pluginization`，工作区有未提交改动，按现状审查。
> **本批涉及的在途改动文件（行号以工作区现文件为准）**：
> `src/packages/ui-transcript/ui/ui.tsx`、`src/packages/ui-transcript/ui/welcome.tsx`、
> `src/packages/ui-transcript/ui/rows/changes-card.tsx`、`src/packages/ui-transcript/locale/*`、
> `src/packages/ui-team/ui/ui.tsx`、`src/packages/ui-team/README.md`、`src/packages/ui-team/locale/*`、
> `src/packages/ui-status/ui/ui.tsx`、`src/packages/ui-status/README.md`、`src/packages/ui-status/locale/*`；
> 另有未跟踪新文件 `src/packages/ui-transcript/ui/greeting.ts`。

## 范围

实际读过的文件（全份或整段）：

- `src/packages/ui-status/ui/ui.tsx`（1–2309 全读）、`ui/status-model.ts`（全）、`README.md`（改动标记）
- `src/packages/ui-transcript/ui/ui.tsx`（全 780）、`welcome.tsx`（全 250）、`greeting.ts`（全 100）、
  `timing.ts`（全 40）、`turn-notify.ts`（全 133）、`render.tsx`（全 426）、`shared.ts`（全 178）、
  `rounds.ts`（全 247）、`round-fold.tsx`（全 368）、`fold-seats.tsx`（1–200）、`subagent-flow.tsx`（全 90）、
  `rows/foot.tsx`、`rows/user-row.tsx`、`rows/tool-row.tsx`、`rows/changes-card.tsx`、
  `tool-card/factory.tsx`（1–200）
- `src/packages/ui-composer/ui/ui.tsx`（全 1204）、`model-controls.tsx`（全 857）、`model-picker.ts`（全 321）、
  `surfaces.ts`（全 235）
- `src/packages/ui-prompt/ui/ui.tsx`（1–420 精读，其余按结构跳读）
- `src/packages/ui-statusbar/ui/ui.tsx`（全 692）
- `src/packages/ui-trace/ui/ui.tsx`（1–420、560–850）、`trace-format.ts`（全 314）
- `src/packages/ui-team/ui/ui.tsx`（全 737）
- `src/packages/ui-tasks/ui/ui.tsx`（全 99）
- `src/packages/ui-ask/ui/ui.tsx`（1–200）
- 对照读（只作证据，不审）：`src/packages/ui-primitives/ui/{time,tokens,snapshot,paths}.ts`、
  `src/packages/ui-runtime/ui/appearance.ts`、`src/contract/runtime.ts:20–82`、`src/core/prefs.ts:159–295`

## 结论摘要

- **P0 1 条 / P1 12 条 / P2 8 条**
- 三条最重要的话：
  1. **「收起后显示哪些回复」这条设置现在有三份归一化，其中两份的兜底值与契约默认相反**（默认是 `final`，
     两份代码写成「认不出就 `all`」），设置页显示的那一档与实际生效的那一档可以不一样。
  2. **工具卡在这个批次里有三份实现**（transcript 的 `ToolRow`、transcript 的 Factory `ToolCard`、trace 的
     `TraceToolRow`），前两份 logic 几乎逐行相同，只是 `ToolCard` 是最新的、`ToolRow` 退化成保险丝。
  3. **`ui-status/ui/ui.tsx` 2309 行至少背了 15 件事**（拖动 + 落点 + 自动档 + 八个分区 + 三条本地轮询 +
     两档时钟 + 一份右栏页签），拆成 8 个文件是必须做的，不是因为「文件大」，而是因为改任一区都要碰同一个
     状态簇。

## 按插件分节

### ui-status

#### [P1] 2309 行单文件承担 15 件互不相干的职责，是全仓最大的上帝模块
- 位置：`src/packages/ui-status/ui/ui.tsx`（整份；派生规则已抽到 `ui/status-model.ts`，但状态与副作用全留在这里）
- 现象：职责清单（逐条对应行号）：
  1. 展示档位三态 + 本机存档（:196–213 读写、:622 状态、:1217–1243 菜单）
  2. 胶囊拖动（:269–282 位移区间、:699–774 指针三段、:777–794 窗口缩放夹取）
  3. 胶囊位置本机存档（:219–251）
  4. portal 落点解析（:665–672 先 `.topbar .tabs` 再正文区）
  5. 自动档宽度裁决（:676–688 ResizeObserver、:959 阈值）
  6. 八个分区的渲染与显隐/分隔线（:1117–1144、:1246–1345）
  7. 八个分区组件本体（:1487–2308：Goal / Todo / Agent / TeamBoard / Git / Plan / Work / Workflow）
  8. Git 本地轮询：三档节奏 + 慢仓库退让 + 两种催拍（:879–949、:489–501）
  9. 队友名册双源：team 席位 or 本地 5s 轮询（:607–620、:798–826）
  10. 共享任务板独立 5s 轮询（:835–862）
  11. 折叠桶预览卡的开关计时器与 Escape（:1010–1058、:1716–1748）
  12. 七组快照选择器 + 各自手写相等判断（:381–574）
  13. 快/慢两档时钟（:961–976）
  14. 四个写动作与 toast（:1060–1101）
  15. 右栏「后台活输出」页签整条实现：轮询 + 跟随滚动 + 冻结（:2126–2225、:2228–2243）
- 证据：
  ```
  296:const DEFAULT_SECTION_OPEN: Readonly<Record<SectionId, boolean>> = {
  1117:  const hasData =
  1129:  const showGit = git !== null
  ```
- 影响：任何一条需求（改拖动手感、加一个分区、改 git 节奏）都要先读懂这 15 件事共用的
  `host/area/pos/mode/preview/now/git/mates/board` 状态簇；`:777–794` 的缩放夹取与 `:699–774`
  的拖动共用一个 `dragBounds`，任何人改一处都会影响另一处。自检也验证不了（`scripts/ui-status-panel-test.mjs`
  只钉 `status-model.ts` 的纯函数）。
- 建议：按下面边界拆（新文件都在 `ui-status/ui/` 下，`index.ts` 与槽位注册不动）：
  | 新文件 | 搬什么 | 对应行 |
  | --- | --- | --- |
  | `panel-shell.tsx` | 档位、拖动、位置存档、portal 落点、自动档宽度、胶囊壳 DOM | 171–282、622–794、1145–1244 |
  | `sections/git.tsx` / `goal.tsx` / `plan.tsx` / `todo.tsx` | 四个只读区 + 各自的空态判定 | 1487–1668、1990–2039、1934–1984 |
  | `sections/runtime.tsx` | 终端区 + 输出页签 | 2049–2116、2126–2243 |
  | `sections/agent.tsx` / `team-board.tsx` | 名册区 + 任务板区 | 1760–1925 |
  | `sections/workflow.tsx` | 定点任务区 + `taskState` | 2246–2308 |
  | `use-git-reading.ts` | 轮询 + 三档节奏 + 两种催拍 | 879–949 |
  | `use-roster.ts` | 席位/轮询双源 + 相等判断 | 426–458、607–620、798–826 |
  | `use-board.ts` | 任务板轮询 | 443–458、835–862 |
  | `selectors.ts` | 七组 read*/same* | 381–574 |
- 置信度：高（全文读完，行号逐段核对）

#### [P1] 分区可见性与分隔线是手写的 8 对布尔，加第九个分区要改 9 处
- 位置：`src/packages/ui-status/ui/ui.tsx:1117–1144`
- 现象：`showGit…showTeam` 八个布尔，紧接 `sepGoal…sepTeam` 八个「上面有没有东西」的布尔算式，
  每个算式都要手动把前七个 `show*` 穷举一遍；`hasData` 又把八个数据面各判一次。
  新增一个分区（或让某区在两种数据下出现）必须同时改：`SectionId`(:295)、`DEFAULT_SECTION_OPEN`(:296)、
  `hasData`(:1117)、`show*`(:1129)、`sep*`(:1138)、渲染分支(:1246–1345)。
- 证据：
  ```
  1138:  const sepGoal = showGit
  1143:  const sepAgent = sepWorkflow || showWorkflow
  ```
- 影响：`sepTodo`(:1140) 把 `showPlan` 也算进去，而 `showPlan` 来自计划目录；只要有人调整分区顺序而漏改一行，
  分隔线就会画在错误的位置（没有报错、没有自检覆盖）。这是典型「改 A 忘 B」。
- 建议：改成一张表驱动：`const SECTIONS: ReadonlyArray<{id: SectionId; show: boolean; render: ReactNode}>`，
  `hasData = SECTIONS.some(s => s.show)`，分隔线渲染时按「已显示分区的前缀和」现算，删掉 16 个布尔。
- 置信度：高

#### [P1] 队友名册存在两条数据源与两套相等判断，且状态面板自己也留了一份轮询
- 位置：`src/packages/ui-status/ui/ui.tsx:607–620`（席位）、`:798–826`（本地 5s 轮询）、`:426–440`（sameMateList）；
  `src/packages/ui-team/ui/ui.tsx:202–229`（team 侧 3s 轮询）
- 现象：team 插件开着时读共享席位；没开时它自己起一条 5s 轮询。两条路写同一个 `mates` 状态，
  但相等判断只有本地那条用（席位那条靠 `useSeat`）。同一份「谁在跑」因此有两个刷新节奏（3s / 5s）、
  两套错误语义（team 侧 `.catch` 静默保留旧值，status 侧 `.catch` 清空列表）。
- 证据：
  ```
  609:  //   没席位（team 没装/被停用）→ 保留本地轮询（下面那段 effect）。
  812:          if (alive) setLocalMates((current) => (current.length === 0 ? current : []))
  ```
- 影响：team 插件一停一启，名册从 5s 轮询切到 3s 席位；两条路的失败处理不一致，一侧保留旧名册、一侧清空，
  同一时刻状态面板与右栏子智能体页签可能一个有名册一个空。改轮询参数要改两个包。
- 建议：把「名册轮询」整体收到 provider（team）里，status 只读服务；team 缺席时状态面板直接不画智能体区
  （现在已有「没数据就隐藏」的口径），删掉 :798–826 这段回落轮询。
- 置信度：高

#### [P2] 文件头说「分区七个」，代码是八个
- 位置：`src/packages/ui-status/ui/ui.tsx:22`（注释）对 `:295`（`SectionId` 八个值）、`:284–294`（另一段注释说「八个分区」）
- 现象：文件头 `- **分区七个**（…Git 工具 / 目标 / 计划 / 进程 / 终端 / 工作流 / 智能体）`，
  缺了后来加的「共享任务」；同一文件另一处注释已是八个。
- 证据：
  ```
  22: * - **分区七个**（顺序照 ZCode 的 Git 工具 / 目标 / 计划 / 进程 / 终端 / 工作流 / 智能体），
  295:type SectionId = 'git' | 'goal' | 'plan' | 'todo' | 'terminal' | 'workflow' | 'agent' | 'team'
  ```
- 影响：读文件头的人会以为没有任务板区，改动时容易把 `team` 区漏掉（它确实没出现在「数据」那一节的清单里）。
- 建议：把文件头的「数据（逐区）」一节补齐第八区，或改成「分区清单见 `SectionId`」不再复述个数。
- 置信度：高

#### [P1] 同一份 git 读数在这个批次里有两条取数路径（本地轮询 vs 快照面）
- 位置：`src/packages/ui-status/ui/ui.tsx:879–949`（本地 `dock git-status` 轮询，12s/30s/60s）；
  `src/packages/ui-composer/ui/surfaces.ts:223–235`（读 `surfaces.git` 轻读数）
- 现象：状态面板自己拍 `git-status {stats:true}` 拿 added/removed/dirtyFileCount，输入区分支行读宿主推的
  `surfaces.git`。两处都有 `dirtyFileCount`，但刷新节奏不同（面板 12–60s、快照面跟宿主推帧）。
- 证据：
  ```
  ui-status/ui.tsx:905: .invoke<Record<string, unknown>>('dock', ['git-status', { stats: true }])
  ui-composer/ui/surfaces.ts:233: dirtyFileCount: typeof record['dirtyFileCount'] === 'number' ? record['dirtyFileCount'] : 0,
  ```
- 影响：同一仓库很可能在同一屏上显示两个文件数（面板 12s 前的读数、分支行最新的读数）；改「多久刷一次」
  要知道有两个地方在拍。面板注释（:140–143）解释了为什么不走快照面，但代价就是这个矛盾没被收口。
- 建议：让宿主在 `surfaces.git` 里一并给出 added/removed（它已在算 numstat 给 Git 页签），面板改成订阅快照面，
  删掉 :879–949 的本地轮询与两套「催拍」；退一步至少把 `GitSummary` 的相等判断（:497–501）上收到
  `ui-primitives`，与 composer 的 `sameGit` 共用。
- 置信度：高

### ui-transcript

#### [P0] 「收起后显示的回复」三份归一化，两份兜底值与契约默认相反
- 位置：`src/core/prefs.ts:182`（真源默认 `final`）、`:291–295`（收窄回落 `FOLDED_REPLIES_DEFAULT`）；
  `src/packages/ui-transcript/ui/ui.tsx:176`、`src/packages/ui-runtime/ui/appearance.ts:119–121`、
  `src/packages/ui-settings/ui/ui.tsx:1238`
- 现象：同一项设置被独立收窄四遍。宿主那份回落 `final`（默认值），而界面侧三份都写成
  「等于 `'final'` 才是 `final`，其余一律 `all`」——字段缺失 / 老档 / 坏值时界面算出来是 `all`。
  `ui-runtime` 的 `DEFAULT_APPEARANCE` 又写 `foldedReplies: 'final'`，与同文件 119 行的回落函数自相矛盾。
- 证据：
  ```
  core/prefs.ts:182: const FOLDED_REPLIES_DEFAULT: UiFoldedReplies = 'final'
  ui-transcript/ui/ui.tsx:176: foldedReplies: value['foldedReplies'] === 'final' ? 'final' : 'all',
  ui-runtime/ui/appearance.ts:119: function normalizeFoldedReplies(value: unknown): FoldedReplies {
  ui-runtime/ui/appearance.ts:120:   return value === 'final' ? 'final' : 'all'
  ui-settings/ui/ui.tsx:1238: foldedReplies: prefs?.foldedReplies === 'final' ? 'final' : 'all',
  ```
- 影响：老 `settings.json` 里没有这一项时（这是绝大多数存量用户），宿主生效的是 `final`（收起后只留最终回答），
  而设置页单选读 `appearance.foldedReplies` 显示「全部回复」——用户看到 A、实际是 B，改设置还得先点一次 B
  再点回 A 才可能写对。这条已经是可见的不一致，不是将来风险。
- 建议：contract 里给 `UiFoldedReplies` 配一个 `normalizeFoldedReplies`（或直接把 `contract/session.ts:148`
  的 `UiPrefsView` 拆出 `DEFAULT_UI_PREFS`），四处改为 import 同一个函数；`ui.tsx:176` 与 `ui-settings:1238`
  删本地三元式。
- 置信度：高（四处原文都核对过；未跑起来验界面，故不改判 P0 的措辞为「推测」）

#### [P1] 工具卡有三份实现，最新那份与保险丝那份 logic 几乎逐行相同
- 位置：`src/packages/ui-transcript/ui/rows/tool-row.tsx:70`（`ToolRow`）、
  `src/packages/ui-transcript/ui/tool-card/factory.tsx:170`（`ToolCard`，D2 装配定义）、
  `src/packages/ui-trace/ui/ui.tsx:773`（`TraceToolRow`）
- 现象：`ToolRow` 与 `ToolCard` 的判断序列完全同构：`expandable = status !== 'preparing'`、
  `bodyOpen`、`running`、`summary = toolSummary(...)`、`targetPath = fileTargetOf(...)`、
  `intended = useIntendedDiff(...)`、`barVisible` 量高。连量法本身也是两份：`BAR_MIN_CONTENT_H = 400` 与
  `expandedContentHeight()` 在 `rows/fold-body.ts:9,18` 与 `tool-card/factory.tsx:97,105` 逐字重复
  （`ToolRow` 从前者 import，`ToolCard` 自己又写了一遍）。`ToolRow` 现在的唯一用途是 factory 未注册时的 fallback。
- 证据：
  ```
  factory.tsx:179: const expandable = call.status !== 'preparing'
  tool-row.tsx:79:  const expandable = call.status !== 'preparing'
  tool-row.tsx:53:  fallback: <ToolRow entry={props.entry} matched={props.matched} storeKey={props.storeKey} />,
  render.tsx:335:  return renderSlot?.(TOOLVIEW_SLOT, { entry, storeKey }) ?? <ToolRow entry={entry} storeKey={storeKey} />
  ```
- 影响：改工具卡的头行/状态列（例如「定稿不印完成」这条口径）要改三处；`ToolRow` 与 `ToolCard` 的用时文案已经不
  一致（`t('transcript.tool.timeSuffix')` vs Factory 的 `ChatStatus`），保险丝一被触发，卡片外观会跳变。
  行数：303 + 723 行里有一半是双写。
- 建议：删掉 `ToolRow` 的完整实现，把 fallback 改成「不带局部槽的 `ToolCard`」（`variant='trace'` 或加
  `degraded`）；`TraceToolRow` 同样只保留在 factory 缺席时；`expandedContentHeight` / `BAR_MIN_CONTENT_H`
  只留 `rows/fold-body.ts` 那一份，`factory.tsx:97–114` 的副本删掉改成 import。
- 置信度：高（三份头部 20 行逐行比对过）

#### [P1] 空会话首屏与正文各写一份 system 条目渲染
- 位置：`src/packages/ui-transcript/ui/welcome.tsx:231–247`（首屏）对 `src/packages/ui-transcript/ui/render.tsx:337–348`（正文）
- 现象：两处都在做同一组判定：`parseReviewNotice` → `ReviewNoticeCard`；`command === true` →
  `.entry-system-command`。首屏那支还自己判了 `row.entry.kind !== 'system'` 提前返回。
- 证据：
  ```
  welcome.tsx:235:  if (row.entry.command === true) {
  welcome.tsx:244:  const notice = parseReviewNotice(row.entry.text)
  render.tsx:341:  const notice = parseReviewNotice(entry.text)
  render.tsx:344:  return entry.command === true ? (
  ```
- 影响：新增一种 system 卡片（比如「上下文已压缩」的专用卡）时，首屏与正文会走出两种排版；
  `welcome.tsx:234` 的注释已经记录过「首屏漏了命令输出」这一次报障，说明这条双写真的踩过。
- 建议：把这两个分支抽成 `SystemRow`（`rows/system-row.tsx`），`welcome` 直接复用；首屏只保留「挑哪几条画」的决定。
- 置信度：高

#### [P2] 只读用户气泡是主气泡的整段复制
- 位置：`src/packages/ui-transcript/ui/rows/user-row.tsx:83–204`（`UserRow`）与 `:209–251`（`ReadonlyUserRow`）
- 现象：贴图条（`entry.images.map` + 灯箱）、`UserFileCards`、气泡 class 三段在两份里逐字重复，
  只差「编辑钮 / 编辑框」这一块。
- 证据：
  ```
  209: export function ReadonlyUserRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): ReactNode {
  226:        {entry.images === undefined || entry.images.length === 0 ? null : (
  ```
- 影响：贴图灯箱、附件卡的改动要改两遍；`ReadonlyUserRow` 里漏改一处，右栏看到的队友记录与主会话就不一样。
- 建议：`UserRow` 加 `readOnly?: boolean`，编辑块按它不渲染；删掉 `ReadonlyUserRow`，`subagent-flow.tsx:80` 改传参。
- 置信度：高

#### [P1] 分轮有两套实现，轨迹页那套不认「插话」与「机器投递」
- 位置：`src/packages/ui-transcript/ui/rounds.ts:97–148`（唯一真值）对
  `src/packages/ui-trace/ui/trace-format.ts:195–263`（`buildTraceModel` 自建轮次）
- 现象：transcript 的规则 2/3（`steering === true`、`internal === true` 都不开新轮，见 rounds.ts:103–111）
  在 trace 侧完全没有对应判断——trace 只要 `kind === 'user'` 就 `openRound`。
- 证据：
  ```
  rounds.ts:103: if ((entry.steering === true || entry.internal === true) && current !== undefined) {
  trace-format.ts:221: if (entry.kind === 'user') {
  trace-format.ts:222:   const round = openRound(entry)
  ```
- 影响：同一会话在对话页有 N 轮、在轨迹页有 N+1 或 N+2 轮；`stats.rounds`(ui-trace:354) 与右缘刻度条的
  轮数是两个数。改动分轮口径（rounds.ts 的注释记录了 0.6.67 那次座位错位）时，轨迹页不会跟着改。
- 建议：把 `splitRounds` 的核心（含 steering/internal 规则）上收到 `@dsc/ui-primitives`，
  trace 的 `buildTraceModel` 只在其结果上补 steps/marks，不再自己判 `kind === 'user'`。
- 置信度：高（两份实现都读全）

#### [P2] 回合「进行中」有两条渲染路：直播行与压缩行各起一份时钟
- 位置：`src/packages/ui-transcript/ui/ui.tsx:676–697`（压缩行 + 直播行）、
  `src/packages/ui-transcript/ui/rows/foot.tsx:158–167`（`TurnStatusLine` 内部 1s interval）、
  `src/packages/ui-transcript/ui/timing.ts:30–36`（起点推导）
- 现象：`TurnStatusLine` 自己每秒 `setState`，而 `TranscriptFlow` 又用 `turnState !== 'idle'` 判
  「是不是最新一轮在跑」(:664)；压缩态那条同时受 `compactingSince` 与 `activity` 两处条件控制(:679、:691)。
- 证据：
  ```
  foot.tsx:162: const timer = setInterval(() => setNow(Date.now()), LIVE_CLOCK_INTERVAL_MS)
  ui.tsx:691: {activity !== null && compactingSince === null ? (
  ```
- 影响：三处「现在在跑吗」的判据（`activity`、`turnState`、`roundFolds.get().running`）在边界上会给出不同答案
  （例如刚提交、还没回第一口时 `activity` 为 null 但 `turnState` 已是 `thinking`）；改其中一处就会看到
  「转圈没了但组头还在转」这类不一致。
- 建议：把「这一轮在跑吗」收成 `round-fold.tsx` 的 `RoundFold.running` 一处判断，直播行与压缩行都读它。
- 置信度：中（未逐帧验证三种判据的所有组合）

### ui-composer

#### [P1] 思考档位的中文名有三份，其中设置页与输入区用词不同
- 位置：`src/packages/ui-composer/ui/model-picker.ts:45–54`（`EFFORT_LABELS`，注释自承是
  `src/core/model-caps.ts:37–42` 的同值镜像）、`src/packages/ui-composer/locale/ui.zh.json:46–50`、
  `src/packages/settings/locale/ui.zh.json:33–36`
- 现象：同一批档位在三处各有一张表，且值已经不同：输入区 `off` 是「关」、`max` 是「最大」；
  设置页 `off` 是「关闭思考」、`max` 是「最高」。
- 证据：
  ```
  model-picker.ts:48: export const EFFORT_LABELS: Readonly<Record<EffortLevel, string>> = {
  composer/locale/ui.zh.json:50:  "effort.max": "最大",
  settings/locale/ui.zh.json:36:  "option.effort.max": "最高",
  model-caps.ts:41:  max: '最大',
  ```
- 影响：用户在输入区选「最大」、到设置页看到「最高」，会以为是两档；改一处文案不会带动另两处。
  宿主错误回执（`packages/llm/index.ts:225–226` 用 `THINKING_LEVEL_LABELS`）又是第三套说法。
- 建议：档位显示名只留 `@dsc/ui-primitives`（或 contract）一份，三个包 import；locale 里删掉 `effort.*` /
  `option.effort.*` 两套键，改由宿主下发 label（`ModelChoiceView.thinkingLevels` 已有结构可扩）。
- 置信度：高（三份原文都比对过；设置页只读了 locale 与那一行代码，未深审其渲染）

#### [P2] 浮层定位的量法散在三个地方，平台里已有 `anchored.ts` 没被用
- 位置：`src/packages/ui-composer/ui/model-controls.tsx:316–338`（`openFlyout` 量一次）、
  `:347–365`（`useLayoutEffect` 再量一次修高）、`:394–405`（`clampShift` 推回正文列）
- 现象：同一张面板要量三次（行位置、卡片自然高、裁剪容器左右），每次都自己找
  `overflowX !== 'visible'` 的祖先（`:297–307`），而 `@dsc/ui-primitives/ui/anchored.ts` 就是干这件事的。
- 证据：
  ```
  300:      if (getComputedStyle(node).overflowX !== 'visible') {
  401:    const raw = { left: box.left - shiftRef.current, right: box.right - shiftRef.current }
  ```
- 影响：`changes-card.tsx:26` 与 `ui-status` 的拖拽（`ui.tsx:269–282`）也各有一份「找容器 + 量 rect」，
  样式一改（比如 `.thread-main` 不再是裁剪容器）就要同时改三处。
- 建议：把 `clipBoxOf` 抽到 `ui-primitives/anchored.ts`，三处共用；`openFlyout` 与修正 effect 合并成
  一个 `useFlyoutPlacement(rowRef, cardRef)`。
- 置信度：中（`anchored.ts` 只读了文件名与导出面，未逐行核对其能力是否覆盖）

### ui-prompt

#### [P2] 路径展示函数是 `ui-primitives` 那份的复制（少了 home 分支）
- 位置：`src/packages/ui-prompt/ui/ui.tsx:215–226` 对 `src/packages/ui-primitives/ui/paths.ts:10–28`
- 现象：`displayPathOf` 的 cwd 相对化逻辑逐字相同，只是插件的这份没有 `home` 参数与 `~/…` 分支；
  注释（:211–214）说「不能 import」的理由是「插件 bundle 只能 require 白名单模块」，
  但 `@dsc/ui-primitives` 已经是平台种子（同文件 :44 就在 import `Select` / `humanErrorText`）。
- 证据：
  ```
  ui-prompt/ui/ui.tsx:215: function displayPathOf(path: string, cwd: string): string {
  ui-primitives/ui/paths.ts:10: export function displayPathOf(path: string, cwd: string, home = ''): string {
  ```
- 影响：审批卡上的路径不会缩成 `~/…`（工作目录外的家目录文件显示全路径），而对话页的改动卡会；
  注释里那条「不能 import」的理由已经过期，会误导后来的人继续复制。
- 建议：删本地实现，`import { displayPathOf } from '@dsc/ui-primitives'`；顺手改掉过期注释。
- 置信度：高

#### [P2] 权限档位的兜底文案表与宿主表、设置页文案三处措辞不同
- 位置：`src/packages/ui-prompt/ui/ui.tsx:263–273`（`POLICY_TEXT` / `MODE_TEXT`）、
  `src/packages/approval/index.ts:84–88`（`POLICY_OPTIONS` 的 label）、
  `src/packages/settings/locale/ui.zh.json:25–27`（`option.policy.*`）
- 现象：同一个 `readonly` 档，审批卡兜底写「仅查看」，宿主档位表写「仅查看」，设置页写「只读（都要批准）」；
  `auto-edit` 三处分别是「工作区自动」/「自动编辑」/「自动编辑（命令要批准）」。
- 证据：
  ```
  ui-prompt/ui/ui.tsx:264:  readonly: t('policy.readonly'),
  approval/index.ts:85:  { id: 'readonly', label: '仅查看', hint: '只读模式：读类操作放行，写/执行类一律拒绝' },
  settings/locale/ui.zh.json:25:  "option.policy.readonly": "只读（都要批准）",
  ```
- 影响：审批卡优先用宿主 label（`optionLabel`，:317–319），所以正常情况下看到的和设置页不同；
  只有宿主档位表缺席时才露出兜底那套。三份表任一改动都要人肉同步。
- 建议：兜底表从 contract 的 tier 常量派生（或删掉兜底，宿主缺席时显示 id），设置页文案统一到宿主 label。
- 置信度：高

### ui-statusbar

#### [P1] 回合状态与用量读法是第 3、4 份实现，与 primitives / ui-trace 并存
- 位置：`src/packages/ui-statusbar/ui/ui.tsx:479–484`（自建 `readTurnState`，四值白名单，认不出给 null）、
  `:503–511`（`readUsageInput/Output`）、`:132–139`（累计 token 双源：日志 or 快照）；
  `src/packages/ui-trace/ui/ui.tsx:840–850`（`readUsage` 返回总数）；`src/packages/ui-primitives/ui/snapshot.ts:47–52`
- 现象：`status.turnState` 有四种读法：primitives 给 `string`+缺省 `'idle'`；statusbar 白名单+缺省 `null`
  （整段不画）；`ui-status/ui/ui.tsx:482–487` 又抄了一遍 primitives 那版；transcript/composer 用 primitives。
  `status.usage` 也有两份：trace 拼成总数，statusbar 拆成两列再求和。
- 证据：
  ```
  statusbar/ui/ui.tsx:481:  return typeof raw === 'string' && (TURN_STATES as readonly string[]).includes(raw)
  ui-primitives/ui/snapshot.ts:51:  return typeof value === 'string' ? value : 'idle'
  ui-trace/ui/ui.tsx:848:  const total = input + output
  ```
- 影响：宿主加一个新回合状态（例如 `compacting`）时，四个包的降级行为各不相同：有的当 idle（直播行消失）、
  有的整段不画（状态栏只剩 token 段）、有的照字符串透传。改这一处口径要改四个包。
- 建议：contract 的 `StatusView.turnState` 已经在 `src/contract/runtime.ts:34` 定死四值，把「认不出怎么办」
  也放进 primitives（`readTurnState` 返回 `TurnState | null`，语义二选一并写进文档），其余三处删本地实现。
- 置信度：高

#### [P2] 上下文占用百分比与上下文窗口缩写各有一套，与输入区的写法不同
- 位置：`src/packages/ui-statusbar/ui/ui.tsx:335`（`Math.min(100, Math.round(used/window*100))`）、
  `:357`（`~{formatTokens(used)} / {formatTokens(window)}`）；
  `src/packages/ui-composer/ui/model-picker.ts:183–186`（`contextLabel` → `128k`）
- 现象：同一个 `contextWindow` 在状态栏显示 `128K`、在模型菜单显示 `128k`；百分比只在状态栏算，
  输入区的模型卡不显示占用。
- 证据：
  ```
  statusbar/ui/ui.tsx:335: const percent = Math.min(100, Math.round((props.used / props.windowTokens) * 100))
  model-picker.ts:185: return `${Math.round(contextWindow / 1000)}k`
  ```
- 影响：两处读数看起来不像同一个数（大写 K / 小写 k、是否四舍五入到 k）；将来模型卡要加占用率时
  会再抄一遍那个 `min(100, round(...))`（`ui-settings` 的模型页大概率也有一份，见待核实）。
- 建议：`contextLabel` 改用 `formatTokens`；把 `contextOccupancy(used, window)` 上收到 primitives，
  状态栏与模型卡共用。
- 置信度：中（设置页那份没查）

### ui-trace

#### [P1] 轨迹页保留第三份工具卡与自己的用量合计
- 位置：`src/packages/ui-trace/ui/ui.tsx:773–836`（`TraceToolRow`）、`:142–151`（`roundUsage` 自己滚一遍轮内 usage）、
  `:840–850`（`readUsage`）
- 现象：`TraceToolRow` 与 factory 的 `ToolCard` 是同一张卡的两种画法（`:648` 有 factory 优先、这份 fallback），
  `roundUsage` 又在 `ui-trace` 内重算「这一轮最后一条带 usage 的条目」，与 `render.tsx:121–125` 的
  `findLast(usage)`、`rows/foot.tsx:58–62` 的合计是三处同义推导。
- 证据：
  ```
  ui-trace/ui/ui.tsx:147:  if (own !== null) map.set(round.index, { entryId: step.id, total: own.inputTokens + own.outputTokens })
  ui-transcript/ui/render.tsx:121:  const usage = findLast(
  ui-transcript/ui/rows/foot.tsx:60:  measured !== null && measured.inputTokens + measured.outputTokens > 0
  ```
- 影响：轮尾显示「12.3K tok」的口径（最后一条带 usage 的条目）现在有两份实现；`ui-trace` 那份把
  `entryUsage`（trace-format.ts:169–174）当判据，transcript 那份直接判 `(text|tool) && usage !== undefined`，
  两条在「同一轮里 tool 之后又来一条 text」的边界上可能取到不同条目。
- 建议：把「本轮用量真值」抽成 `@dsc/ui-primitives` 的 `roundUsage(entries)`（输入：一轮的条目），
  transcript 的 `render.tsx:121` 与 trace 的 `:142` 都调它；`TraceToolRow` 见上一条工具卡建议。
- 置信度：高

### ui-team

#### [P1] 队友状态词表第三份，且耗时组件与 status-model 的时长函数各算一遍
- 位置：`src/packages/ui-team/ui/ui.tsx:73–78`（`STATE_LABEL`）、`:517–538`（`UsedTime` 自己 `setInterval(1000)` + `formatDuration`）；
  `src/packages/ui-status/ui/ui.tsx:316–321`（`MATE_STATE_LABEL`）、
  `src/packages/ui-transcript/ui/rows/tool-row.tsx:274–279`（`SUB_STATE_TEXT`）；
  `src/packages/ui-status/ui/status-model.ts:225–238`
- 现象：`TeammateView['state']` 四种值在三个包各有一张「值 → 译文」表（`team.state.*` / `status.agent.state*` /
  `transcript.sub.*`，三套 locale 键）。耗时也有两份：team 的 `UsedTime` 现算，status-model 的
  `mateElapsedMs/longestElapsedMs` 只有 `scripts/ui-status-panel-test.mjs` 在用。
- 证据：
  ```
  ui-team/ui/ui.tsx:74:  working: t('team.state.working'),
  ui-status/ui/ui.tsx:317:  working: t('status.agent.stateWorking'),
  tool-row.tsx:275:  working: t('transcript.sub.working'),
  status-model.ts:225: export function mateElapsedMs(
  ```
- 影响：同一名队友在状态面板写「运行中」、在正文只读层写「进行中」、在工具卡里又一种词；
  `mateElapsedMs` 这份已无生产调用方，却仍被自检钉住（删它要先改探针，容易被后来的改动绕开）。
- 建议：选手册（`contract/task.ts` 的 `TeammateView`）旁边加一张状态词表由宿主下发，三个包只渲染；
  `UsedTime` 改用 `mateElapsedMs`，把 status-model 这份变成唯一实现（或反过来把 `mateElapsedMs` 挪到
  `ui-primitives` 并让自检继续钉）。
- 置信度：高

#### [P2] 目标条在 `ui-tasks` 与 `ui-status` 各画一份，动作集还不一样
- 位置：`src/packages/ui-tasks/ui/ui.tsx:44–99`（`GoalBarSlot`）对 `src/packages/ui-status/ui/ui.tsx:1488–1554`（`GoalSection`）
- 现象：两处都读 `surfaces.goal`，都画「目标正文 + 相位 + done/total」，但动作不同：输入框上方那条有
  `extend` / `clear`（tasks:88–95），状态面板那条只有 `pause` / `resume`（status:1525–1547）。
  两份相位文案表（`tasks.phase.*` vs `status.goal.phase*`）也是两份译文。
- 证据：
  ```
  tasks/ui/ui.tsx:58: const action = (name: 'pause' | 'resume' | 'clear' | 'extend', tip: string): void => {
  status/ui/ui.tsx:1096: const goalAction = (name: 'pause' | 'resume', tip: string): void => {
  ```
- 影响：用户清目标只能在输入框上方那条点；在状态面板看到目标却清不掉。`goal.phase === 'blocked'` 时
  输入框上方多出「延长」那颗，状态面板没有——同一状态两种可做的下一步。
- 建议：定一条：目标条只画在状态面板（与「任务条已撤」同一条理由，tasks 文件头 :10–12 已写），
  把 `extend` / `clear` 搬进 `GoalSection`，`ui-tasks` 只留目标条的空壳或整个退场。
- 置信度：高

### ui-ask

#### [P2] `readSessionId` 第 4 份，且与 primitives 同名不同义
- 位置：`src/packages/ui-ask/ui/ui.tsx:85–90`、`src/packages/ui-transcript/ui/ui.tsx:723–728`、
  `src/packages/ui-composer/ui/surfaces.ts:78–83` 对 `src/packages/ui-primitives/ui/snapshot.ts:85–92`
- 现象：三处本地实现都读 `status.sessionId`（uuid，契约 `src/contract/runtime.ts:21`）；
  而 primitives 那个同名函数返回的是 `sessionPath` 的文件名去 `.jsonl`（短名），并在注释里
  明确说「不用 status.sessionId，两个口径对不上」。`ui-status/ui.tsx:111,953` 用的正是短名那个，
  拿去和 `mate.sessionId` 比。
- 证据：
  ```
  ui-primitives/ui/snapshot.ts:82: * 为什么不用 `status.sessionId`：那份 id 与名册（`listTeammates` 的 sessionId）不是一个口径，
  ui-transcript/ui/ui.tsx:726:  const value = (status as Record<string, unknown>)['sessionId']
  ui-status/ui/ui.tsx:953: (sessionId === null ? [] : mates.filter((mate) => mate.sessionId === sessionId)),
  ```
- 影响：同名函数返回两种值，是全仓最容易「拿错一把钥匙」的地方：折叠态存档键（`fold-state.ts:83` 用 uuid）
  与名册筛选（用文件名）= 两条键空间。把其中一个换成另一个不会报错，只会静默丢折叠状态或让名册整块为空。
- 建议：primitives 里改名区分（`readSessionUuid` / `readSessionShortId`），三个包删本地实现；
  在 `snapshot.ts` 的模块头把两种 id 的用途各写一行。
- 置信度：高（四处实现都读过）

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
| --- | --- | --- | --- | --- |
| 工具卡 | `ui-transcript/ui/rows/tool-row.tsx:70` `ToolRow` | `ui-transcript/ui/tool-card/factory.tsx:170` `ToolCard`（D2 定义） | `render.tsx:335`、`tool-row.tsx:53`、`subagent-flow.tsx:69` 的 fallback | 把 fallback 换成「无局部槽的 ToolCard」，删 `ToolRow` 主体 |
| 轨迹页工具卡 | `ui-trace/ui/ui.tsx:773` `TraceToolRow` | 同上 Factory（`variant='trace'`） | `ui-trace/ui/ui.tsx:648` fallback | 同上；两处 fallback 合并成一个 `DegradedToolCard` |
| 队友运行记录 | `ui-team/ui/ui.tsx:596–644` `PeekView`（简版直排） | `transcriptFlow` 服务（`ui-team:651–663` → `ui-transcript/subagent-flow.tsx`） | `ui-team:718` 服务缺席时 | 保留兜底，但 `PeekView` 的四类行排版要与 `RowBody` 对齐（现在正文/工具/思考各一套） |
| 空会话首屏的 system 行 | `ui-transcript/ui/welcome.tsx:231–247` | `ui-transcript/ui/render.tsx:337–348` `RowBody` | 首屏仍走旧的一支 | 抽 `SystemRow`，首屏复用 |
| 用户气泡（只读） | `user-row.tsx:83–204` `UserRow` | `user-row.tsx:209–251` `ReadonlyUserRow` | `subagent-flow.tsx:80` | 合成一个带 `readOnly` 的组件 |
| 分轮 | `ui-transcript/ui/rounds.ts:97` `splitRounds` | `ui-trace/ui/trace-format.ts:195` `buildTraceModel` | 轨迹页 | 分轮上收 primitives，trace 只补 steps |
| 目标条 | `ui-tasks/ui/ui.tsx:44` `GoalBarSlot` | `ui-status/ui/ui.tsx:1488` `GoalSection` | 两处同时活跃 | 二选一（建议留状态面板） |
| git 读数 | `ui-status/ui/ui.tsx:879–949` 本地轮询 | `ui-composer/ui/surfaces.ts:223` 快照面 | 两处同时活跃 | 面板改订阅快照面 |
| 回合状态读法 | `ui-primitives/ui/snapshot.ts:47` | `ui-statusbar:479`、`ui-status:482`、`ui-transcript:141`(用 primitives) | 三处自建 | 统一到 primitives 并定「认不出」语义 |
| 折叠偏好归一化 | `core/prefs.ts:291` | `ui-transcript:176`、`ui-runtime:119`、`ui-settings:1238` | 三份并存且默认值分叉 | 只留 contract/primitives 一份 |

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
| --- | --- | --- | --- | --- |
| 时长格式化（秒/分/时） | `ui-primitives/ui/time.ts:51–61` | `ui-status/ui/status-model.ts:190–200` | 数学完全一致，只有 i18n 键前缀不同（`primitives.duration.*` / `status.duration.*`） | 只留 primitives 一份，status 的字典挂到 primitives 命名空间下 |
| 「多久以前」 | `ui-transcript/ui/welcome.tsx:152–159` `elapsedLabel` | `ui-status/ui/status-model.ts:215–222` `formatAgo` | welcome 按分钟/小时/天取整（「3小时前」），status 精确到分（「3小时12分前」） | 合成一个 `formatAgo(ts, now, granularity)` |
| token 数量 | `ui-primitives/ui/tokens.ts:21–26` `formatTokens` | `ui-statusbar/ui/ui.tsx:627–629` `formatExactTokens` | 前者 K/M 缩写（卡面），后者千分位（只进 title） | 把 `formatExactTokens` 也放进 `tokens.ts`，同文件两个函数 |
| 上下文窗口缩写 | `ui-statusbar:357` `formatTokens` | `ui-composer/ui/model-picker.ts:183–186` `contextLabel` | `128K` vs `128k` | composer 改用 `formatTokens` |
| 队友状态词 | `ui-status/ui/ui.tsx:316–321` | `ui-team/ui/ui.tsx:73–78`；`ui-transcript/rows/tool-row.tsx:274–279` | 三套 locale 键、三种译法 | 宿主下发或 primitives 一份表 |
| 队友已运行时长 | `ui-team/ui/ui.tsx:517–538` `UsedTime` | `ui-status/ui/status-model.ts:225–238` `mateElapsedMs` | 前者现算+自起定时器，后者纯函数（只被自检引用） | 纯函数留下、组件改用纯函数 |
| 思考档位名 | `core/model-caps.ts:37–42` | `ui-composer/ui/model-picker.ts:48–54`；`settings/locale:33–36` | 「最大」vs「最高」，「关」vs「关闭思考」 | 只留宿主一份 label |
| 权限档位名 | `approval/index.ts:84–88` | `ui-prompt/ui/ui.tsx:263–273`；`settings/locale:25–27` | 三处措辞不同 | 删插件兜底表，设置页统一到宿主 label |
| 路径展示 | `ui-primitives/ui/paths.ts:10–28` | `ui-prompt/ui/ui.tsx:215–226` | 后者少 `home` 分支，注释里的「不能 import」理由已过期 | 删本地实现 |
| 轮内用量真值 | `ui-transcript/ui/render.tsx:121–125` | `ui-trace/ui/ui.tsx:142–151` | 一个是 `findLast`，一个是逐条目覆盖写 | 上收 `roundUsage(rows)` |
| `status.usage` 合计 | `ui-statusbar/ui/ui.tsx:503–511,132` | `ui-trace/ui/ui.tsx:840–850` | 一个拆两列，一个直接给总数 | 上收 primitives 的 usage 读法 |
| `status.turnState` | `ui-primitives/ui/snapshot.ts:47–52` | `ui-statusbar:479–484`；`ui-status/ui/ui.tsx:482–487` | 回落值 `'idle'` vs `null` | 统一进 primitives |
| `surfaces.goal` 读法 | `ui-status/ui/ui.tsx:404–409` | `ui-tasks/ui/ui.tsx:36–41` | **逐字相同** | 上收 primitives |
| `sessionId` 读法 | `ui-primitives/ui/snapshot.ts:85–92`（短名） | `ui-transcript:723`、`ui-composer/surfaces.ts:78`、`ui-ask:85`（uuid） | 同名不同义 | 改名区分 |
| 首次空会话卡片的入口 | `ui-transcript/ui/welcome.tsx:108–148` `WELCOME_CARDS` | `ui-transcript/ui/ui.tsx:574–593`（动作表优先，回落内置清单） | 两套来源，`WELCOME_ICON_BY_ID` 做桥 | 可接受（有注释说明），但 icons 映射与卡片表要同步维护 |
| 展开区高度量法 | `ui-transcript/ui/rows/fold-body.ts:9,18` | `ui-transcript/ui/tool-card/factory.tsx:97,105` | 常量与函数逐字相同（`BAR_MIN_CONTENT_H = 400`、逐子块 scrollHeight 相加） | 删 factory 那份，改 import fold-body |
| 快捷键字面量 | `ui-ask/ui/ui.tsx:124` 与 `:149`（同一个 `Ctrl+Shift+K` 写两遍） | `ui-layout/ui/app.tsx:361–379`、`ui-palette/ui/ui.tsx:91` | Web 壳没有表；TUI 已有 `tui/app/keymap.ts:16–44` | 在 ui-primitives 建一张 `KEYS`，Web 侧复用 TUI 那套做法 |
| 折叠桶语义 | `ui-status/ui/status-model.ts:88–96` | （无重复，但 `FOLD_LABEL` 在 `ui.tsx:324–329` 另一处） | 语义在 model、文案在组件，两处都要跟着 `FoldBucketKind` 扩张 | 可接受，保留 |

## 待核实

1. **`status.sessionId` 与短名在真实会话里是否总相等**。`ui-transcript` 用它拼折叠存档键，
   `ui-status` 用短名筛名册；`ui-team/ui/ui.tsx:19–25` 明确记录过「队友日志的 `meta.id` 与文件名是两个 uuid」。
   真会话里若两者不同，折叠状态会在切会话/看队友时串味。需要跑一次会话验证（本轮只做静态阅读）。
2. **`appearance.foldedReplies` 的真实消费方**。我确认 `ui-settings/ui/ui.tsx:1072` 读它显示当前档，
   但没查 `ui-renderer` 是否还把它传给别的消费者；若没有，那条 P0 的影响面只到「设置页显示错一档」。
3. **`ui-settings` 的模型页是否另有一份思考档位/上下文窗口表**（本轮按口径不深审，只读了 locale 与 1238 行）。
4. **`mateElapsedMs` / `longestElapsedMs` 是否真的只有探针在用**：我 grep 了 `src` 与 `scripts`，
   生产代码零引用；但 `docs/development-log.md:4324` 把它们列为「时长口径」的一部分，删之前要确认没有外部消费方。
5. **`scripts/ui-*.mjs` 探针与这些重复的绑定关系**：`ui-status-panel-test.mjs:169–181` 直接钉
   `mateElapsedMs` / `formatAgo` / `formatCountdown`；`ui-welcome-greeting-test.mjs`（未跟踪的新文件）钉
   `greeting.ts`。合并重复实现前要先改探针，否则门禁会红。
6. **`round-fold.tsx` 的 `ProcessFold` / `CollapseTiming` / `FoldedReplies` 三个类型是「本地复述契约」**：
   契约在 `src/contract/session.ts:167–197`，`ui-runtime/ui/appearance.ts:40–42` 用索引类型取的同一份。
   `round-fold.tsx:27–44` 是手写 union，契约加一档时这里不会编译报错。本轮未查是否有探针断言这三者的对齐关系。
7. **`turn-notify.ts:37–38` 说「与 `src/packages/remote/index.ts:692-703` 的 `waitingCardOf` 同口径」**：
   远程推送侧是否也维护了第四份「等人的卡」优先级判断，本轮未读 `remote` 包。
8. **`ui-transcript/ui/greeting.ts` 是未跟踪新文件**，`welcome.tsx` 的 45 条文案表与它靠
   `scripts/ui-welcome-greeting-test.mjs` 对齐；该探针也未被 git 跟踪，两者是否都要进这一批提交需主控确认。
