# 批次 10：TUI 与入口

> 审查口径见 `docs/code-review/2026-11-09/00-审查口径.md`。只读审查：未改任何源码，未跑 build / install / typecheck / 测试。
> 分支 `feat/pluginization`，按工作区现状审查。
> **本批涉及的在途改动文件**：`ui-shell/src/plugin-api.ts`（`TUI_SLOTS` 那一半）。
> `src/packages/tui/**`、`src/boot.ts`、`src/headless.ts`、`src/packages/cli/**`、`bin/dsc.js` **没有未提交改动**，行号即仓库现状。
> 行数一律用 `Get-Content | .Count`（含空行）计；`read` 报的 total 与之相同。
> 避免重复：03 已覆盖「模块白名单刻意分叉」「启动图丢 `services`」；04 已覆盖「工具卡三份」「Web 侧快捷键字面量」「审批卡权限档名与宿主不一致（Web 侧）」「主题默认值」。
> 本批只补 TUI 侧的新证据，并在引用处标注「见 03/04」。

## 范围

实际读过的文件：

- **tui 组件树**（`src/packages/tui/app/`，40 文件 8004 行）：
  `App.tsx`（1863 行，全读）、`ChatView.tsx`（660，全）、`StatusBar.tsx`（285，全）、
  `SessionPicker.tsx`（211，全）、`ApprovalCard.tsx`（183，全）、`AgentsOverlay.tsx`（116，全）、
  `scroll-model.ts`（517，全）、`Composer.tsx`（458，读 240–439）、`snapshot-subscribe.ts`（139，全）、
  `keymap.ts`（58，全）、`theme.ts`（207，读 1–60、117–166 + 常量表）、`TimelineRail.tsx`（按结构跳读）、
  其余 27 个文件按 import 关系与 grep 命中核对（`TranscriptViewport`、`TranscriptOverlay`、`PickerFrame`、
  `ModelPicker`、`PresetPicker`、`SkillsPicker`、`PlanReviewCard`、`AskCard`、`PreviewOverlay`、
  `SettingsOverlay`、`settings-model`、`ToolCard`、`Welcome`、`TaskStrips`、`ticker`、`history-store`、
  `click`、`mouse`、`pointer`、`cursor`、`display-width`、`attach`、`image-blocks`、`clipboard-image`、
  `markdown`、`MarkdownView`、`DiffBlock`）
- **tui 宿主半**：`src/packages/tui/index.ts`（107，全）、`package.json`、`cordis.patch.yml`（4 行）、
  `tests/tui-app-split.test.mjs`（72，全）、`README.md`
- **TUI 插件模型**：`src/packages/ui-core/tui-plugins.ts`（332，全）、`tui-plugin-api.ts`（25，全）、
  `slots-ink.tsx`（135，全）、`slots-react.ts`（109，全）、`scoped-slots.ts`（61，全）、`package.json`；
  `slots.ts` 只读导出面 + `SlotRegistry` 声明（930 行未逐行，见待核实）
- **对照**：`ui-shell/src/plugin-api.ts`（535，读 1–100 + 导出面）、`src/packages/ui-slots/ui/slots.ts`（96，全）、
  `src/packages/ui-slots/ui/slots-react.tsx`（394，全）、`src/packages/ui-boot/ui/boot.ts`（1048，读 660–739、1005–1048 + grep）、
  `src/packages/ui-transcript/ui/rounds.ts`（247，全）、`src/packages/ui-transcript/ui/render.tsx`（grep 定位）、
  `src/packages/ui-prompt/ui/ui.tsx`（1115，读 340–459 + grep）、`src/packages/ui-statusbar/ui/ui.tsx`（692，grep）、
  `src/packages/ui-primitives/ui/tokens.ts`（39，全）、`src/core/text-format.ts`（26，全）
- **入口**：`src/boot.ts`（34，全）、`src/headless.ts`（31，全）、`bin/dsc.js`（98，全）、
  `src/packages/cli/index.ts`（22，全）、`config-cli.ts`（102，全）、`plugin-cli.ts`（682，读 1–90 + grep 定位）、
  `src/host/startup.ts`（90，全）、`src/host/kernel.ts`（grep 导出面）、`src/core/config.ts`（读 170–219）、
  `src/core/migrate.ts`（读 155–209）、`src/packages/commands/index.ts`（797，读 600–669 + grep 命令表）、
  `src/packages/plugin-manager/index.ts`（159，全）、`src/services/types.ts`（读 600–670）
- **只读调用关系，不审本体**：`src/packages/runtime/index.ts`（读 74–84、370–419）、
  `src/contract/approval.ts`（读 40–89）、`src/contract/mode.ts`（grep）、
  `src/packages/approval/index.ts`（读 82–95）、`src/packages/commands-core/commands-completion.ts`（读 120–130）、
  `src/packages/ui-runtime/ui/host-channel.ts`（读 290–394）、`src/core/ui-methods.ts`（grep）

## 结论摘要

- **P0 0 条 / P1 9 条 / P2 10 条**
- 三条最重要的话：
  1. **「一轮」在两个载体里的定义相反。** Web 的 `rounds.ts` 明确写「插话（`steering`）不开新轮」，TUI 的
     `layoutViewport` 只排除 `internal`、把插话算成新轮——同一份会话 jsonl，终端刻度比桌面多几枚，`[`/`]`
     跳的也是不同的东西。这不是载体差异，是两个判据各写一遍。
  2. **`App.tsx` 1863 行背 17 类职责、61 份本地状态、一个 434 行的 `useInput`。** 命令、鼠标、审批、
     提问、计划、设置、五个浮层、滚动、附件、状态栏偏好全挂在同一个组件上，任何一条界面需求都要先读懂
     这 61 份状态的关系。
  3. **TUI 的插件装载器与浏览器壳的装载器是同一套算法的两份实现**（TUI 332 行 / web 一份 300+ 行）：
     `requireFor` 白名单、两轮重试、回滚账本、报告表逐段同形；而 `services` 只在 TUI 这一侧真正生效
     （web 侧被启动图丢掉，见 03 的 F1），于是「等提供者就绪」这条语义在两个载体里行为不同。

## 八个问题的直接回答

1. **共享了什么、各写了一遍什么。** 结论：**命令与数据契约共享，呈现与判据各写一套，其中三处纯逻辑
   本该上收却没上收（分轮、格式化、审批档位判定）。**

   | 能力 | 共享 | 各写一遍 | 定性 |
   | --- | --- | --- | --- |
   | 命令 | `ctx.commands.run` 注册表（`src/services/types.ts:660-670`，两条入口都落到同一张表） | 派发口两条：`runtime.runCommand`（`runtime/index.ts:383-387`）vs TUI 注入的 `dispatchCommand`（`tui/index.ts:73-74`）；`CommandContext` 两份（`runtime/index.ts:74-84` 三项 + `shell` 标记 / `App.tsx:1606-1631` 八项） | 载体差异（TUI 多三张浮层）＋纯逻辑重复（回执落点不同，见 F5） |
   | 快捷键 | 无 | TUI `keymap.ts`（58 行，`KEYS` 16 个键名 + 5 条 `HINT` 提示）＋`App.tsx:1162-1595`；Web 各包 window 监听（`ui-prompt:437-445`、`ui-layout:361-379`，见 04） | 必然不同（ink `useInput` vs DOM keydown）；**键名文案**是重复（F9） |
   | 状态栏 | 快照字段同一份（`StatusView`/`RuntimeSurfaces`） | `tui/app/StatusBar.tsx`（285）vs `ui-statusbar/ui/ui.tsx`（692） | 必然不同（一行文本 vs 可折叠卡片） |
   | 用量/费用格式化 | 无 | `core/text-format.ts:16-20`（TUI 用）vs `ui-primitives/ui/tokens.ts:21-38`（Web 用）vs 状态栏内联 `toFixed`（`StatusBar.tsx:212`） | **纯逻辑重复，应上收**（F8） |
   | 审批卡 | 契约 `ApprovalRequestView`（`contract/approval.ts:50-86`） | `tui/app/ApprovalCard.tsx`（183）vs `ui-prompt/ui/ui.tsx:250-620`；四档判定在 TUI 内部还有三份（F3） | 必然不同（一屏卡片 vs DOM 卡片）＋**判定重复**（F3）＋**档位名硬编码**（F11） |
   | 会话选择 | 契约 `SessionSummary`/`ArchivedSessionView` | `tui/app/SessionPicker.tsx`（纯展示）＋逻辑全在 `App.tsx:479-577/603-682/1353-1447`；Web 是 `ui-sessions/ui/ui.tsx`（2038） | 必然不同；但 TUI 侧「逻辑在 App、视图在组件」的切法让 App 多背 100 行（F1） |
   | 消息流 | `TranscriptEntry` 同一份 | `ChatView.tsx` + `TranscriptViewport` + `scroll-model` vs `ui-transcript`（780+426+368+…） | 必然不同（ink 按行裁切 vs DOM 虚拟列表） |
   | 分轮 | 无 | `scroll-model.ts:281-289` vs `rounds.ts:97-148` | **判据相反，必须上收**（F2） |

2. **`App.tsx` 的职责清单与拆分边界。** 17 类职责、48 个 `useState` + 13 个 `useRef` + 10 个 `useEffect` + 12 个 `useCallback` + 12 个 `useMemo`，
   一个 434 行的 `useInput`。逐条行号见 F1 的表格；拆分边界也见 F1。

3. **两个入口的调用顺序。** `boot.ts:15-29` 与 `headless.ts:12-26` **除 `surface` 一个字面量外逐行相同**
   （顺序：`migrateFromDsh` → `readConfig` → `readUiConfig` → 解析 `DSC_RESUME_SESSION` → `createKernel` →
   `loadExternalPlugins` → `emitStartupNotes`），两边顺序一致；但**迁移这件事有三处触发**，其中
   `readConfig()` 内部那一次（`core/config.ts:195`）把报告丢掉了，而 `numa config show` 也走这条路（F18）。

4. **cli / bin / commands 的子命令解析是两套还是三套。** 三处：`bin/dsc.js:28-66` 只做参数翻译与
   `config`/`plugin` 分发（零依赖，不能 import 包），`cli/config-cli.ts` 与 `cli/plugin-cli.ts` 各自解析
   `process.argv` 并自己 `process.exit`。`cli` **不起内核、不调宿主服务**，直接 import core 模块
   （`config-cli.ts:9-17`、`plugin-cli.ts:37-49`）——这是有意的（注释在 `cli/index.ts:4-6`：命令在内核起来之前跑）。
   问题在三处「入口表/帮助文本/退出码」互不知情（F19）。

5. **TUI 插件模型是不是第二套平行实现。** **不是平行的**：注册表（`slots.ts` 930 行）、订阅面
   （`slots-react.ts` 109 行）、登记账本（`scoped-slots.ts` 61 行）、席位（`store.ts`）两壳共用一份，
   `ui-core/index.ts:1-25` 也刻意**不**把 `slots-ink.tsx` / `tui-*` 转出去（浏览器安全边界守住了）。
   平行的是**外围三样**：渲染出口（`slots-ink.tsx` vs `ui-slots/ui/slots-react.tsx`，F15）、
   槽名常量（`TUI_SLOTS` 两份，F16）、装载器（F6）。`tui-plugin-api.ts` 只有 25 行、导出
   `defineUiPlugin` + `Text` + `TUI_SLOTS`，与 `ui-shell/src/plugin-api.ts` 的 535 行不是一个量级，
   重复面很小（只有一个 `TUI_SLOTS` 常量与 `Text` 的语义对齐）。

6. **快照节流/选择器/失效通知是否各一套。** 节流是**两套且在不同层**：Web 在宿主侧做
   （`host-stdio` leading-edge 与 `ui-events` 拖尾，见 03 的 F2），客户端 `host-channel` 只应用帧；
   TUI 在**客户端**做（`snapshot-subscribe.ts:88-101`，leading + trailing + 引用冻结），
   因为 `runtime.subscribe` 是同步「每个 delta 一次」。选择器：Web 有 `useHostSelector`（切片 + 相等判断），
   **TUI 没有选择器层**，整棵树读同一个快照（F14）。TUI **没有**再做 diff/合并——只做「窗口合并 + 冻结引用」，
   `App.tsx:169-170` 是唯一的订阅点。

7. **`StatusBar` 的用量/费用/上下文读法与 Web、`ui-primitives/tokens.ts` 的关系。**
   token 数 TUI 走 `core/text-format.ts` 的 `compactTokens`（`StatusBar.tsx:26`、`:203`、`ChatView.tsx:253`），
   Web 走 `ui-primitives/ui/tokens.ts` 的 `formatTokens`（后者头注释自称「状态栏、侧栏、轮尾、轨迹页共用一份」）；
   两者**输出不同**（`46.0k` vs `46K`、`1.2k` vs `1.2K`），见 F8。
   费用只有 TUI 显示（SUMMARY 已记：桌面壳不显示会话费用），但 TUI 自己内联了第三套金额格式
   （`StatusBar.tsx:212` 的 `≈¥${total.toFixed(2)}`），没有复用 `formatCostCny`（`tokens.ts:34-38`）。
   上下文百分比 TUI 现算（`StatusBar.tsx:170-175`），Web 的 `contextPressure` 在 `ui-statusbar` 内部另算。
   `ApprovalCard.tsx` 与 Web 审批卡**不共享任何判定**（F3）。

8. **旧/新：TUI 目录里有没有搬过来但已不用的东西。** 没有整份死文件（40 个模块全部被同级 import；
   `tests/tui-app-split.test.mjs:41-62` 还钉了「不许跨出 app 目录」）。**但有两处陈旧残留**：
   `scroll-model.ts:129-131` 留着一段被删函数的孤立注释（F13）；`keymap.ts` 声称键名只在这里出现，
   实际 11 个文件仍在写死键名（F9）。`ChatView.tsx` **已经不是**旧的一体式消息流——它只剩
   「`Entry` 渲染表 + 视口装配」（660 行里 397–541 是 `Entry` 的 switch），滚动/切片/刻度已经搬到
   `TranscriptViewport`（383）+ `scroll-model`（517）+ `TimelineRail`（213）。它和 `ui-transcript/rounds.ts`
   并存是**载体差异**，不是旧路径残留；真正并存出问题的是分轮判据（F2）。

---

## 按插件分节

### src/packages/tui（终端壳）

#### [P1] F1 `App.tsx` 1863 行、17 类职责、61 份本地状态，是全仓第四大的单体文件
- 位置：`src/packages/tui/app/App.tsx`（整份；统计：`useState` 48 处、`useRef` 13 处、`useEffect` 10 处、
  `useCallback` 12 处、`useMemo` 12 处、`useInput` 1 处 434 行）。按行数排在它前面的是
  `ui-status/ui/ui.tsx`（2309）、`ui-sessions/ui/ui.tsx`（2038）、`ui-settings/ui/models.tsx`（1935）
  ——那三个都是 Web 侧，终端壳这一份是纯 TUI 里最大的。（`90-global-evidence.md` 把这三个记作
  2310 / 2039 / 1936，差 1 是空行计数器不同，不是两套数字。）
- 现象：职责与行号区间：

  | # | 职责 | 行号 |
  | --- | --- | --- |
  | 1 | 快照合并 + 单点订阅 + 快照字段投影（approval/question/plan） | 167–173 |
  | 2 | 浮层/展开/卡片/设置 本地状态簇（48 份 `useState` 全集中在这一段） | 174–278 |
  | 3 | 模型清单、dock 文件清单 | 280–289 |
  | 4 | 点击命中注册表 + 拖动会话 | 290–299 |
  | 5 | 三个筛选投影（模型/模式/技能，各一份 memo） | 304–347 |
  | 6 | 副作用组：回合结束 BEL(349–362)、读 UI 偏好(366–372)、鼠标跟踪开关(374–390)、notice 8 秒过期(397–404)、图片字符画现算(406–435)、卡片换人复位(437–448) | 349–448 |
  | 7 | 提问卡派生与作答提交 | 301–302、450–477 |
  | 8 | 会话选择器：排序/工作区分桶/两级切片/窗口计算 | 479–577（99 行） |
  | 9 | 设置页行模型与窗口 | 579–593 |
  | 10 | 选择器动作收口（归档加载/切页/改名置顶归档分叉/打开会话/模型/模式/技能） | 595–682 |
  | 11 | 设置页动作（写值/执行/复制/行激活/编辑提交，含 win32 clip 分支） | 684–841（157 行） |
  | 12 | 撤回上一轮 + 剪贴板贴图 + 附件 + 图片预览 + 子代理查看/跟活轮询 | 843–981 |
  | 13 | 打开设置/选择器、代理名单、卡片动作（审批/计划/提问） | 983–1066 |
  | 14 | 鼠标分发（滚轮/移动/拖动/点击） | 1068–1160（93 行） |
  | 15 | 键位分发（十余段 `if` 判定，书写顺序即优先级） | 1162–1595（434 行） |
  | 16 | 提交与命令派发（含图片合流） | 1597–1653 |
  | 17 | `modal` 判定 + 浮层栈渲染 + 状态栏接线 | 1655–1860 |

- 证据：
  ```
  169:  const store = useCoalescedSnapshot(runtime, snapshotMs)
  170:  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  1162: useInput((input, key) => {
  1655: const modal =
  ```
- 影响：任何一条界面需求——加一个浮层、改一处键位、调一次命令回执——都要先在这个 61 份状态的
  组件里确认「我这份状态会不会被别人的 effect 复位」。已经能看到的耦合：设置页改值会顺手改
  `expandThinking` 与 `statusBarPrefs`（`701-705`）；换会话会清 `expandedTools`（`194-196`）；
  打开设置要先重置七个字段（`986-993`）。自检也验证不了：`tests/tui-app-split.test.mjs` 只检查
  目录结构与 import 前缀，不碰行为。
- 建议：按「状态簇」而不是按行数切，三步走（每步都能独立验收）：
  1. `overlay-stack.tsx`：搬 `modal`（1655–1666）与浮层渲染分派（1671–1749）+ 五个浮层的开关状态
     （210–212、232–241、254–264、266–276），对外只暴露 `open(kind, payload)` / `close()`；
  2. `session-picker-model.ts`：搬 479–577、603–682、1007–1025、1353–1447 与 242–252 的状态，
     导出纯函数 + 一个 `useSessionPicker()` hook，`SessionPicker.tsx` 只留渲染；
  3. `settings-controller.ts`：搬 579–593、684–841、983–1005、1505–1549（157 行的动作区是最大一块）；
  剩下 1162–1595 的键位分发留在最后动——它依赖上面三块导出的 `open/close` 语义，先拆会拆出循环。
- 置信度：高（整文件读过，行号逐段核对）

#### [P1] F2 「一轮」的定义与 `ui-transcript/rounds.ts` 相反：插话在 TUI 算新轮、在 Web 并入当前轮
- 位置：`src/packages/tui/app/scroll-model.ts:281-289`（TUI 判据）、`src/packages/ui-transcript/ui/rounds.ts:97-121`（Web 判据，自称「唯一真值」）
- 现象：Web 的 `splitRounds` 三条规则里，第 2 条明确「`steering === true` 且已有当前轮 → 归入当前轮，
  **不开新座位**」；TUI 的 `turns` 只排除 `internal`，**没看 `steering`**，于是每条插话都新开一轮。
  TUI 侧的注释还把这条写成了定义：「一轮（= 一条非内部用户消息）」（`scroll-model.ts:132`）。
- 证据：
  ```
  scroll-model.ts:285:    if (entry.kind === 'user' && entry.internal !== true) {
  rounds.ts:103:      if ((entry.steering === true || entry.internal === true) && current !== undefined) {
  rounds.ts:13:  2. `steering === true` 且已有当前轮 → 归入当前轮，**不开新座位**；
  ```
- 影响：同一份会话 jsonl，终端右侧刻度的枚数 = Web 的枚数 + 插话次数。`App.tsx:1780`
  的 `onPickTurn`、`TranscriptViewport` 的 `jumpTurn`、`TimelineRail` 的高亮全部按这个 `turns` 数组走，
  所以「跳到第 3 轮」在两个载体指的不是同一段对话。用户中途 Ctrl+Enter 插一句话是最常见的用法之一，
  这不是边角：`ChatView.tsx:411` 还专门为插话画了 `↩` 徽标。按 P0 口径「已经在制造 bug」判，
  这一条最接近，但它只是显示层错位、不写坏数据，故记 P1。
- 建议：把「条目 → 轮」的切分下沉到 `@pneuma/ui-core`（或在 `contract/` 里给一个纯函数，TUI 侧的
  `layoutViewport` 只需要 `在轮首的条目下标集合`）。**不要**让 TUI 去 import `ui-transcript`（那会把
  React/DOM 依赖带进终端壳）。迁移时用 `rounds.ts` 的三条规则做验收：同一份 jsonl，两边轮数必须相等。
- 置信度：高（两份判据都逐行读过，`steering` 字段在 `ChatView.tsx:411` 有消费方，确认 TUI 收得到这类条目）

#### [P1] F3 审批四档的「允许哪些档」判了四遍，且 TUI 与 Web 的键位不是同一套
- 位置：`src/packages/tui/app/ApprovalCard.tsx:56-62`、`:79-87`；`src/packages/tui/app/App.tsx:1034-1043`、`:1250-1259`；
  `src/packages/ui-prompt/ui/ui.tsx:423-432`
- 现象：同一件事（`scopes` 里有 `session` 才给「本会话允许」、有 `always` 才给「永久允许」、`hardline` 只留拒绝）
  在 TUI 里写成三份，Web 一份，**四份的键位还不一致**：
  - TUI 页脚按钮表：`[y] 允许一次 / [a] 本会话允许 / [p] 永久允许 / [n] 拒绝`；
  - TUI 键盘分支：`y/a/p/n`（`App.tsx:1251-1256`）；
  - TUI 鼠标动作：再判一遍 `scopes.includes('session')` / `('always')`（`App.tsx:1036-1041`）；
  - Web：`y` 一次 / **`s` 本会话** / **`a` 永久** / `n`（`ui-prompt:424-431`）。
- 证据：
  ```
  ApprovalCard.tsx:58:   'allow-session': { hint: '[a]', label: '本会话允许', color: STATUS_COLOR.done, dim: false },
  ApprovalCard.tsx:59:   'allow-always': { hint: '[p]', label: '永久允许', color: BORDER.active, dim: false },
  ui-prompt/ui/ui.tsx:426:        : key === 's' && scopes.includes('session')
  ui-prompt/ui/ui.tsx:428:          : key === 'a' && scopes.includes('always')
  ```
- 影响：同一个用户白天用桌面、晚上用终端，`a` 在一边是「本会话」、在另一边是「永久」——这是**安全语义**
  的差异，不是排版差异。四条判定分处两文件三处，将来加第四档（例如「允许本工作区」）要改四个地方，
  漏一处的表现是「卡上画了按钮但按了没反应」或反向「按键放行了卡上没画的档位」。
- 建议：把「档位 → 键位 + 标签 + 是否可用」收成一份纯数据（放 `@pneuma/ui-core` 或 `contract/approval.ts`
  旁边的零依赖模块）：`scopesOf(request): Array<{ action, key, label, enabled }>`，两边都渲染这张表、
  都按 `key` 派发。键位选哪一套由产品定，但**只能有一套**。
- 置信度：高（四处判定都读过原文；键位差异是逐字比对）

#### [P1] F4 模型/模式/技能三个「输入即筛选的列表浮层」是同一份状态机的三份拷贝
- 位置：`src/packages/tui/app/App.tsx:304-347`（三个筛选 memo）、`:1095-1114`（三份点击映射）、
  `:1448-1504`（三份键盘分支）、`:1726-1737`（三份渲染）；组件 `ModelPicker.tsx`（59 行）/ `PresetPicker.tsx`（72 行）/ `SkillsPicker.tsx`（65 行）
- 现象：三个浮层的键盘分支逐行同构，只有字段名与「Enter 之后做什么」不同：
  ```
  1448: if (modelPicker) {
  1449:   if (key.escape) setModelPicker(false)
  1450:   else if (key.return) {
  1451:     applyModel()
  1452:   } else if (key.upArrow) setModelIndex((current) => Math.max(0, current - 1))
  ```
  点击映射同样三份（`1095-1097` / `1102-1104` / `1109-1111`，连 `row - 1 - 3` 这个常量都各写一遍），
  筛选同样三份（`305-312` / `320-330` / `338-347`），渲染同样三份（三个组件各自的「选中行 + 提示行」）。
  加上会话选择器与设置页，TUI 里一共**五种列表导航**，各写一遍 `↑↓/Enter/Esc/筛选/窗口切片`。
- 证据：
  ```
  1096:      const row0 = row - 1 - 3
  1103:      const row0 = row - 1 - 3
  1110:      const row0 = row - 1 - 3
  1467:    // 模式浮层：与模型浮层同款（输入即筛选、Enter 切换、Esc 关）。
  ```
- 影响：加一条「←→ 翻页」「Home/End 跳首尾」要让用户在三个浮层里都享受到，得改三处；
  `row - 1 - 3` 这个「框内列表起始行」是硬编码的 3，和 `PICKER_CHROME = 5`（`:96`）不是同一个口径，
  将来浮层加一行标题就有一处会错位。
- 建议：抽一个 `useFilterList<T>({ items, keyOf, filterOf, onAccept })`，返回
  `{ index, query, visible, onKey(event): boolean }`；三个浮层变成一个 `<FilterPicker title rows hint />`
  加三份「取数据 + 回车动作」的配置。点击映射与窗口起点也应由同一份 hook 给出，别再各写 `- 3`。
- 置信度：高（三段键盘/点击/筛选/渲染全部读过并逐行比对）

#### [P1] F5 命令派发有两条路，回执落点不同：TUI 进 8 秒过期的 notice 盒，Web 进会话流
- 位置：`src/packages/tui/index.ts:73-74`（注入口）、`src/packages/tui/app/App.tsx:1630`（`notice: setNotice`）、
  `:400-404`（8 秒过期）、`src/packages/runtime/index.ts:80`（`notice` 写 transcript）、`:383-387`（`runCommand`）
- 现象：`DscRuntime` 已经有 `runCommand`（`contract/snapshot.ts:334`，实现 `runtime/index.ts:383-387`），
  它用的 `CommandContext.notice` 是**往会话流写一条 command 条目**；TUI 没用它，而是在
  `tui/index.ts:73-74` 里现查 `ctx.get('commands')` 再自己拼一份 `CommandContext`，`notice` 接的是
  `setNotice`——一个 8 秒后自动消失的提示盒（`App.tsx:397-404`）。
- 证据：
  ```
  tui/index.ts:73:        dispatchCommand: (input, target, ui) =>
  tui/index.ts:74:          (ctx.get('commands') as CommandService | undefined)?.run(input, target, ui) ?? false,
  runtime/index.ts:70:     * notice 写 transcript 条目（TUI 与壳都直接读它，所以命令输出在哪一端都看得见）；
  runtime/index.ts:80:        notice: (text) => ctx.transcript.system(text, undefined, true),
  App.tsx:1630:        notice: setNotice,
  App.tsx:402:    const timer = setTimeout(() => setNotice(null), 8_000)
  ```
  （`runtime/index.ts:70` 那句注释本身现在已经不成立——它假设 TUI 也走 `commandUi()`，
  而 TUI 从 `tui/index.ts:73` 注入了自己那份。）
- 影响：`commands/index.ts` 里有 **53 处 `ui.notice(...)`**（`/help` 一次列 24 条内置命令、`/plugins` 列整张插件表、
  `/usage` 多段读数）。这些回执在 TUI 里落进固定高度帧（`App.tsx:1672` 的 `height={frameRows}` + `overflow="hidden"`）
  底部的一个 `borderStyle="single"` 盒（`1814-1820`），8 秒后消失；长回执会把下面的 `Composer`
  挤出可视区（静态推断，见待核实）。同时「同一条命令在桌面留下记录、在终端只闪一下」这件事，
  会让用户以为命令没生效。
- 建议：两条并一条。短期：TUI 的 `notice` 改成「长回执进 transcript、短提示进 notice 盒」（按行数分流，
  阈值一处定义）；长期：删掉 `dispatchCommand` 注入，让 TUI 也走 `runtime.runCommand`，
  只把 TUI 独有的回调（`openPresets/openSkills/openSettings/openAgents/toggleThinking`）通过
  `runtime.setCommandUi(...)` 之类的一次性注册补进去。注意 `runtime.runCommand` 不过
  `shellCommandRejection`（`commands-core/commands-completion.ts:120-130`）的闸。终端放行全量命令本身合理
  （用户就在键盘前），但「这是有意的」没有注释明说——
  合并时别顺手把闸接上，也别在无注释的情况下把这条差异当 bug 修掉。
- 置信度：高（两条链的代码都读过）；「长回执撑坏固定帧」是静态推断，没有实跑，见待核实

#### [P1] F6 TUI 插件装载器与浏览器壳装载器是同一套算法的两份实现，且 `services` 只在一侧生效
- 位置：`src/packages/ui-core/tui-plugins.ts:91-280`；对照 `src/packages/ui-boot/ui/boot.ts:672-738`
  （`ui` 对象与两轮重试）、`src/core/ui-manifest.ts:295-302`（web 侧丢 `services`，见 03 的 F1）
- 现象：两份装载器的骨架逐段同形——
  ① `requireFor` 白名单 + 「在图上但还没装好」的报错分流（`tui-plugins.ts:122-136`）；
  ② 失败回滚账本 + 两轮重试（`tui-plugins.ts:167-258` vs `boot.ts:711-738`，连「最常见的失败不是插件写错了，
  而是顺序」这句注释都各写一遍）；
  ③ 插件的 `ui` 对象（`slots` / `host` / `runtime` / `provide` / `consume`）字段与顺序一致
  （`tui-plugins.ts:205-219` vs `boot.ts:672-684`）；
  ④ 报告表 + `disposeAll` 逆序卸载。
  差异只有注释里声明的三处载体差异（不走 `<script>`、白名单表、报告去处），加上一处**没声明的差异**：
  `services` 依赖只有 TUI 读到了。
- 证据：
  ```
  tui-plugins.ts:248:      ...((entry as { services?: readonly string[] }).services === undefined
  ui-manifest.ts:295:    const entries: UiPluginEntry[] = ordered.map((artifact) => ({
  ```
  （`UiPluginManifestEntry = UiPluginRow & { file: string }`，`UiPluginRow` 本来就带 `services`（`ui-bundles.ts:107`、`:440`），
  所以 `tui-plugins.ts:248-250` 那个 `as` 断言是多余的——多半是作者也不确定字段在不在。）
- 影响：写 `"services": ["actions"]` 的插件，在终端里会等 provider 装上（`unmetDependencies` 生效），
  在浏览器里不会（启动图里根本没有这个字段）。同一份 bundle 两个载体行为不同，而两份装载器的注释都写着
  「语义对齐浏览器壳」——照注释读会读错。两轮重试/回滚这类容易写漏的逻辑（复制订阅者、逆序回滚、尝试次数）
  也要维护两遍。
- 建议：把「读产物 → 过白名单 → 建 ui 对象 → 两轮重试 → 回滚 → 报告」抽成
  `createUiLoader({ readBytes, requireTable(entry), report })`（落 `ui-core`，纯逻辑、两位载体传差异），
  TUI 只留 `bytesOf`/`factoryOf` 的 node 版与 `tuiRuntime`。同时删掉 `tui-plugins.ts:248-250` 的 `as` 断言。
  这条与 03 的 F1 是同一根因的两半：**先修 `services` 的搬运，再合并装载器**，否则合并时会把
  「web 丢 services」一起带进共用实现。
- 置信度：高（两份装载器都逐段读过；`services` 字段的写入/丢弃/读取三跳都核过）

#### [P1] F7 `boot.ts` 与 `headless.ts` 除一个 `surface` 字面量外逐行相同
- 位置：`src/boot.ts:15-29` 与 `src/headless.ts:12-26`
- 现象：两份 `main()` 完全同构：`migrateFromDsh()` → `readConfig()` → `readUiConfig()` → 解析
  `DSC_RESUME_SESSION`（含 `'1'` → `'auto'` 的特例）→ `createKernel({ config, resumeSessionPath, surface })`
  → `loadExternalPlugins(root, ui.plugins)` → `emitStartupNotes(root, migration, config)`；
  连注释「首次运行：把 dsh 的模型配置迁移到 dsc 自己的文件（幂等，只读 dsh）」都一字不差。
- 证据：
  ```
  boot.ts:17:  const migration = migrateFromDsh()
  boot.ts:26:  const root = await createKernel({ config, resumeSessionPath, surface: 'tui' })
  headless.ts:23:  const root = await createKernel({ config, resumeSessionPath, surface: 'headless' })
  ```
- 影响：启动顺序是这类项目最容易「改 A 忘 B」的地方。现在加一步（例如「先读 profile 再建内核」、
  「启动失败要写一条 boot 日志」）必须改两个文件；漏一个的表现是「桌面端正常、终端缺提示」，
  而且两边的错误前缀还不一样（`[numa] 启动失败` vs `[numa] headless 启动失败`），排查时先被误导一次。
- 建议：抽 `src/host/boot-shell.ts` 的 `runShell({ surface }): Promise<void>`，两个入口各自只剩
  `runShell({ surface: 'tui' })` / `runShell({ surface: 'headless' })` 一行 + 各自的 catch。
  顺带把 `DSC_RESUME_SESSION` 的解析（`'1'` → `'auto'`）收进这个函数——它现在也是两份。
- 置信度：高（两文件全读）

#### [P1] F8 token 数有两个格式化口径，TUI 与 Web 显示同一个数会不一样
- 位置：`src/core/text-format.ts:16-20`（TUI 用）、`src/packages/ui-primitives/ui/tokens.ts:21-38`（Web 用）、
  `src/packages/tui/app/StatusBar.tsx:203`、`:212`（费用内联）
- 现象：两个函数都叫「token 缩写」，输出不同：
  - `compactTokens(46000)` → `46.0k`（小写 k，恒一位小数，不 trim）；`compactTokens(1200)` → `1.2k`；
  - `formatTokens(46000)` → `46K`（大写 K，`trimZero` 去掉 `.0`）；`formatTokens(1200)` → `1.2K`；
  - 金额：`formatCostCny` 有 `<¥0.01` 的兜底（`tokens.ts:36`），TUI 的 `≈¥${total.toFixed(2)}`
    会把 0.004 元显示成 `≈¥0.00`（读起来是「没花钱」）。
- 证据：
  ```
  text-format.ts:18:  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  tokens.ts:24:  if (value < 1_000_000) return `${trimZero(value / 1_000)}K`
  StatusBar.tsx:212:      text: `≈¥${status.cost.total.toFixed(2)} ${status.cost.peakNow ? '峰' : '谷'}`,
  ```
- 影响：`tokens.ts:1-2` 的注释写着「token 数的显示口径（状态栏、侧栏、轮尾、轨迹页共用一份）」，
  事实是终端这一份没进来。同一个会话在桌面看到 `46K tok`、在终端看到 `tok 46.0k↑`，用户会当成两个数
  （这正是 `text-format.ts:5-6` 自己警告过的场景）。ARCHITECTURE 第 3 期已把「token 格式」列为待收项。
- 建议：定一份权威（建议 `ui-primitives/ui/tokens.ts`，它已经处理了 `trimZero`、非有限数、负数、`<¥0.01`），
  把 `compactTokens`/`shortCwd` 降级成别名或直接删；TUI 的 `shortCwd` 是真在用的（`StatusBar.tsx:222`、
  `Welcome.tsx:86`），路径那一条保留在 `core`，token 与金额那两条统一到 `tokens.ts` 并让 `core` 反向转出。
- 置信度：高（两个函数全文比对；调用点 grep 过，TUI 侧 3 处、Web 侧多处在用）

#### [P2] F9 `keymap.ts` 声称「键名只在本文件出现」，实际 11 个文件仍在写死键名
- 位置：`src/packages/tui/app/keymap.ts:16-58`（`KEYS`/`HINT`）；写死处：`AgentsOverlay.tsx:112`、
  `AskCard.tsx:121`、`Composer.tsx:424`、`ModelPicker.tsx:55`、`PlanReviewCard.tsx:102`、`PresetPicker.tsx:68`、
  `PreviewOverlay.tsx:72`、`SessionPicker.tsx:193-204`、`SettingsOverlay.tsx:248-251`、`SkillsPicker.tsx:61`、
  `App.tsx:901`/`:1247`/`:1626`/`:1833`
- 现象：`keymap.ts:1-6` 的动机写得很清楚——「同一批键名散在六个文件里各写一遍，改一处忘一处」，
  但它只覆盖了 5 条提示（`HINT.transcript`/`peek`/`backToBottom`/`thinkingExpand`/`empty`）与
  `KEYS` 的 16 个键名；其余 11 个文件（含 `App.tsx` 自己那 4 处提示）仍直接写 `'↑↓ 选择 · Enter 打开 · Esc 关闭'` 这类字面量。
  `KEYS` 里的 `pick`/`enter`/`tab`/`space` 四个常量**没有任何消费者**（grep `KEYS.` 全目录：只命中 12 个键名）。
- 证据：
  ```
  SessionPicker.tsx:198:              ↑↓ 选择 · Enter 打开 · 鼠标点击选中、再点打开 · 滚轮移动
  ModelPicker.tsx:55:        ↑↓ 选择 · Enter 切换 · Esc 关闭
  keymap.ts:41:  pick: '↑↓',
  ```
- 影响：改一次键位（例如把浮层关闭从 `q/Esc` 改成 `Esc`）要改的仍是十余处。这个文件现在的价值是
  「看起来统一了」，反而降低了后来者的警惕。
- 建议：要么把这十余处提示全部改成拼 `KEYS`，要么在 `keymap.ts` 头注里写明「只覆盖 X/Y/Z 三处提示，
  其余待迁」并把这 10 处列成待办。前者是半天的活，建议一次做完——顺手能删掉 4 个无消费者的常量。
- 置信度：高（grep 全目录，命中逐条看过）

#### [P2] F10 会话运行状态点与短 id 在 TUI 内部各有三到四份，其中一份已经导出却没人复用
- 位置：`StatusBar.tsx:45-49`（`BACKGROUND_DOT`）、`:52-53`（`shortId`，**已 export**）；
  `AgentsOverlay.tsx:26-30`、`:33-34`；`SessionPicker.tsx:28-32`、`:153-155`
- 现象：三份一模一样的 `{ working: ◐ / awaiting-approval: ⚠ / just-finished: ✓ }` 表，三份一模一样的
  「取文件名去后缀前 8 位」。`StatusBar.tsx:52` 的 `shortId` 是导出的，`App.tsx:78` 也确实
  `import { shortId }`——但另外两个浮层宁可就地再写一遍，`AgentsOverlay.tsx:25` 还留了一句理由
  「不互相 import 保持浮层自洽」。
- 证据：
  ```
  AgentsOverlay.tsx:25: /** 后台会话状态点的形状与颜色（与 StatusBar 同源；不互相 import 保持浮层自洽）。 */
  SessionPicker.tsx:153:            const shortId = (session.id.split(/[\\/]/).pop() ?? session.id)
  ```
- 影响：新增一种会话状态（例如 `queued`）要改三处，漏一处就是「选择器里没点、状态栏里有」。
  这些全是同一个目录内的几行纯函数，没有任何「自洽」收益。（90-global-evidence 第 3 节已把 TUI 的 4 份
  `shortId` 记进全局重复表，本条补的是 `BACKGROUND_DOT` 那三份与「已导出却不用」的证据。）
- 建议：`BACKGROUND_DOT` 与 `shortId` 一起搬进 `theme.ts`（它已经是「状态色 + 标记位」的家，
  且没有 React 依赖），三个组件 import 同一份；删掉 `AgentsOverlay` 的理由注释。
- 置信度：高（三处全读）

#### [P2] F11 审批卡的权限档名与协作模式是硬编码，与状态栏用宿主 label 的做法不一致
- 位置：`src/packages/tui/app/ApprovalCard.tsx:143-144`；对照 `StatusBar.tsx:157-162`、宿主档位表 `src/packages/approval/index.ts:84-88`
- 现象：同一屏上，状态栏的「权限」段从宿主投影取 label（`surfaces.policy.options.find(...)?.label`），
  审批卡却自己写了一个三元表达式；两处的 `auto-edit` 文案不同——宿主是「自动编辑」（`approval/index.ts:86`），
  审批卡写「工作区自动」。协作模式更直接：审批卡把内部 id 原样打出来。
- 证据：
  ```
  ApprovalCard.tsx:143:        权限 {request.policy === 'readonly' ? '仅查看' : request.policy === 'auto-edit' ? '工作区自动' : '完全访问'} · 审阅{' '}
  ApprovalCard.tsx:144:        {request.reviewer === 'user' ? '本人' : 'AI 复核'} · 模式 {request.mode}
  approval/index.ts:86:  { id: 'auto-edit', label: '自动编辑', hint: '工作区内写操作自动放行，其余需审批' },
  ```
- 影响：`CollaborationMode` 是 `'build' | 'plan' | 'explore' | 'quiet'`（`contract/mode.ts:79`），所以卡上会出现
  「模式 build」这样给用户看内部 id 的一行；而状态栏同一段显示中文标签（宿主的中文标签在
  `session-core/modes.ts:187` 一带）。`ApprovalRequestView` 里**没有** label 字段
  （`contract/approval.ts:76-79` 只有 id），但 label 其实**已经到界面了**——`RuntimeSurfaces.policy` /
  `.mode` 的 `options` 就是宿主投影（`contract/runtime.ts:104-109`），状态栏用的正是它。
- 建议：短期只改 TUI：`ApprovalCard` 从 `snapshot.surfaces.policy.options` / `.mode.options` 查 label
  （把 `surfaces` 当 prop 传进去，`App.tsx:1853` 已经在传），删掉那段三元与 `{request.mode}`；
  若要让审批卡脱离 `surfaces` 也能独立渲染，再给 `ApprovalRequestView` 补 `policyLabel`/`reviewerLabel`/`modeLabel`
  三个字段，宿主填、三个载体都直接用。
- 置信度：高（三处文案都核对过，`CollaborationMode` 的取值集合与 label 表的位置查过）

#### [P2] F12 `modal` 在 1655 行声明、1235 行使用：键位分发的正确性依赖「回调一定在渲染后执行」
- 位置：`src/packages/tui/app/App.tsx:1235`、`:1552`（使用）、`:1655-1666`（声明）
- 现象：`useInput` 的回调注册在 1162 行，回调体里引用了 493 行之后才 `const` 初始化的 `modal`。
  它现在能工作，是因为 ink 只在事件到达时（组件函数返回之后）才调用回调——即运行期顺序与代码顺序相反。
  同一段里还有一处死分支：`dispatchMouseClick` 在 1080 行已经对 `pickerBuffer !== null` 提前 return，
  1082 行又拿它算 `listTop`。
- 证据：
  ```
  1235:    if (key.ctrl && input === 'v' && !modal) {
  1080:      if (pickerBuffer !== null) return null // 改名输入态不响应鼠标
  1082:      const listTop = 3 + (pickerBuffer !== null ? 1 : 0)
  1655:  const modal =
  ```
- 影响：任何把 `modal` 改成 `useMemo`、或把这段 `useInput` 提取成独立 hook 并提前调用的重构，
  都会得到 `ReferenceError: Cannot access 'modal' before initialization`；报错点在键盘回调里，
  表现为「一按键整个界面崩」，而不是编译错误。1082 行的死分支则会误导后来者以为存在「改名态多一行」
  的布局差异（实际不可达）。
- 建议：把 `modal` 的计算（1655-1666）提到 `useInput` 之前（它只依赖上方已声明的状态，纯搬不换逻辑），
  1082 行改成 `const listTop = 3` 并删掉三元的另一半。
- 置信度：高（行号与依赖关系核对过；「运行期顺序相反」按 React + ink 的调用时机判断）

#### [P2] F13 `scroll-model.ts` 留着被删函数的孤立注释，常量与其他文件手抄一份
- 位置：`src/packages/tui/app/scroll-model.ts:129-131`、`:111-114`；对照 `ChatView.tsx:71`、`theme.ts:131`
- 现象：129 行是一段 JSDoc，函数体已被删掉，注释孤零零挂着；`WATERFALL_ROWS = 3` 与
  `INDENT_DETAIL = 2` 又各抄一份，理由写着「本模块不引 UI 层，故复写常量」——但 `theme.ts` 全文没有任何
  import（纯常量表），`ChatView.tsx` 也在同一个目录，这个理由不成立。
- 证据：
  ```
  scroll-model.ts:129: /** 一行里的最长文本（估算用；不认识的就是空串）。 */
  scroll-model.ts:112: const WATERFALL_ROWS = 3
  scroll-model.ts:113: /** 缩进列数（与 theme 的 `INDENT.detail` 同口径；本模块不引 UI 层，故复写常量）。 */
  scroll-model.ts:114: const INDENT_DETAIL = 2
  ChatView.tsx:71: const WATERFALL_ROWS = 3
  ```
- 影响：`estimateLines` 的职责就是「照着渲染器数行」，它和 `ChatView` 的瀑布行数必须永远相等——
  两份 `3` 分处两文件，改一处忘一处的后果是滚动坐标整体偏一行（这套代码的注释里已经记录过两次
  同类事故：`ChatView.tsx:298-301`、`scroll-model.ts:50-61`）。
- 建议：删掉 129-131 的孤立注释；`scroll-model.ts` 改成 `import { INDENT } from './theme.js'` 与
  `import { WATERFALL_ROWS } from './ChatView.js'`（或把 `WATERFALL_ROWS` 提到 `theme.ts`，
  让两侧都从那里取，避免反向依赖）。
- 置信度：高（三处常量与注释都读过；`theme.ts` 无 import 已核实）

#### [P2] F14 TUI 没有选择器层：整棵树读同一份快照，合并窗口是唯一的性能闸
- 位置：`src/packages/tui/app/App.tsx:169-170`、`:1851-1859`、`ChatView.tsx:543`（未 memo）
- 现象：`App` 一个 `useSyncExternalStore` 拿到整份 `RuntimeSnapshot`，然后按字段分发给
  `ChatView`/`StatusBar`/`TaskStrips`；`ChatView` 本身不是 `memo` 的（只有叶子 `Entry` 在
  `ChatView.tsx:374` memo 了）。Web 侧有 `useHostSelector`（切片 + 相等判断），
  `ui-statusbar` 每个字段各一个选择器（`ui-statusbar/ui/ui.tsx:115-119`）。
- 证据：
  ```
  App.tsx:170:  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  ChatView.tsx:543: export function ChatView({
  ```
- 影响：现在靠 `snapshot-subscribe.ts` 的 80ms 合并窗口把提交次数压到 ~12/秒，而每次提交都会
  重建 `ChatView` 的整棵视口（含 `TimelineRail` 的几何计算）。这不是当前的 bug（有节流兜着），
  但一旦出现「某个浮层里也要实时数据」，加一个订阅就会绕开合并窗口的收益——因为整个设计里
  **只有一处订阅**，没有「只订这一片」的手段。
- 建议：不急着做。若要做，最小改动是给 `StatusBar` 与 `TaskStrips` 各包一层 `memo` + 自取字段
  （它们现在收的是 `snapshot.status`/`surfaces` 整体引用，每帧都换），而不是引入一套 Web 那样的选择器机制。
  这条列在这里是为了回答「选择器是不是各一套」：Web 有、TUI 没有，且不是有意省略的。
- 置信度：中（结构已核对；「整棵树重建」是按 React 语义推断，未实测渲染次数）

### src/packages/ui-core（TUI 插件模型：tui-plugins / tui-plugin-api / slots-ink）

#### [P2] F15 槽位的渲染出口是两套实现，子槽校验文案与错误边界类逐字相同
- 位置：`src/packages/ui-core/slots-ink.tsx:55-135`；对照 `src/packages/ui-slots/ui/slots-react.tsx:89-197`
- 现象：两壳共用注册表与 `useSlot`/`useSeatProps`（这是对的），但**渲染出口**各写一份：`SlotEntryHost`
  里的「子槽没声明就抛 `SlotAssemblyError`」逐字相同（连拼接文案的分隔符都一样）、
  `api` 的 `useMemo` 形状相同、`SlotErrorBoundary` 类除 `render()` 外逐字相同。
  TUI 版还缺两样：`ChainOutlet`（chain 槽选举）与 `FactoryOutlet`（D2），并且它的 `renderSlot`
  不做 `slots.spec(name) === 'chain'` 的分派——把 chain 子槽当 list 渲染，不报错。
- 证据：
  ```
  slots-ink.tsx:68:        throw new SlotAssemblyError(
  slots-ink.tsx:69:          `条目 ${entry.slot}/${entry.id} 没有声明子槽「${name}」` +
  slots-react.tsx:104:        throw new SlotAssemblyError(
  slots-react.tsx:105:          `条目 ${entry.slot}/${entry.id} 没有声明子槽「${name}」` +
  slots-ink.tsx:82:      renderFactorySlot: (): ReactNode => {
  slots-ink.tsx:83:        throw new SlotAssemblyError('TUI 壳还没有 Factory 渲染出口（无消费者）；registerFactory 的登记两壳一致，渲染出口后补')
  ```
- 影响：`slots-ink.tsx:13-15` 把「TUI 没有 Factory 出口」写成了明确的设计选择（调用即报错），这部分是干净的。
  问题在于**校验逻辑**也复制了一份：将来给子槽加一条规则（例如「必须先 `declare` 才能进 `children`」）
  要改两处；chain 语义只在 Web 侧实现，TUI 侧静默降级——插件作者在 TUI 里注册 chain 子槽不会得到
  任何提示，只会看到「全都渲染了」。
- 建议：把「子槽名校验 + 抛错文案 + `SlotRenderApi` 组装 + 错误边界」抽成
  `slots-shared.tsx` 里一个 `createSlotEntryHost({ Wrapper, CrashView })`，两壳只传载体包装
  （`<div class="slot-entry">` / ink `<Box>`）与崩溃视图；`renderSlot` 里补上
  `chain` 分派（TUI 没消费者就抛「本载体不支持 chain 子槽」，别静默当 list）。
- 置信度：高（两个文件全读，逐段比对）

#### [P1] F16 `TUI_SLOTS` 常量两份定义，且 TUI 槽名不在 `SlotMap` 里——插件按类型写不出 TUI 槽的注册
- 位置：`src/packages/ui-core/tui-plugin-api.ts:20-23`、`ui-shell/src/plugin-api.ts:45-48`（**该文件有未提交改动**）、
  `src/packages/ui-slots/ui/slots.ts:26-38`（只并了 9 个浏览器槽）、`ui-shell/src/slot-contract.typecheck.tsx:23-24`（钉住「不在 `SlotMap` 的槽名必须报错」）
- 现象：同一个常量、同一个字符串在两处各定义一份，`ui-shell/src/plugin-api.ts:42-43` 的注释说这是刻意的
  （「槽名两边导出同名常量」）。真正的缺口在类型面：`SlotMap` 只并了 9 个浏览器槽，
  **`'tui.notice.extensions'` 从来没有进过 `SlotMap`**，`tui-plugin-api.ts` 也没有 `declare module '@dsc/ui'` 这一手。
  而类型探针明确要求「槽名不在 `SlotMap` → 编译必须报错」，于是第三方插件写
  `ui.slots.register(TUI_SLOTS.noticeExtensions, …)` 恰好命中这条负例；运行期那套
  （`scripts/ui-tui-plugin-test.mjs` 的 `injectSlot`，纯 JS）却跑得通。
- 证据：
  ```
  tui-plugin-api.ts:20: export const TUI_SLOTS = {
  plugin-api.ts:45: export const TUI_SLOTS = {
  slot-contract.typecheck.tsx:23: // @ts-expect-error 槽名不在 SlotMap
  slot-contract.typecheck.tsx:24: ui.slots.register('shell.nope', { id: 'x' }, () => null)
  ```
- 影响：类型面与运行面对同一个 TUI 槽的说法相反。第一个真要发终端界面的第三方插件会在
  `pnpm -C ui-shell typecheck` 卡住，只能 `as never` 或 `@ts-expect-error` 绕过——而那条负例正是
  「槽名必须来自表」的守卫，绕过一次就废了。等价于「TUI 插件模型目前只对内置探针开放」。
  两份常量将来加第二个槽时还得同步改两处。
- 建议：把 `'tui.notice.extensions': { kind: 'list' }` 并进 `SlotMap`（放 `ui-shell/src/plugin-api.ts:59`
  那个空 `interface SlotMap {}` 旁边，或由 `ui-core` 出一份 `declare module '@dsc/ui'` 的 d.ts）；
  `tui-plugin-api.ts` 只从 `@dsc/ui-core` 转出常量，删掉 `plugin-api.ts:45-48` 那一份；
  再在 `slot-contract.typecheck.tsx` 补一条正例 `ui.slots.register(TUI_SLOTS.noticeExtensions, …)` 把两侧钉在一起。
- 置信度：中（`SlotMap` 并表、typecheck 负例、TUI 常量三处都读过；「插件 tsc 会报错」是按
  `slot-contract.typecheck.tsx:23-24` 的同一机制推断，没有实跑 `tsc`，见待核实）

#### [P2] F17 TUI 的 `UiRuntimeApi.getSnapshot` 每次读都自增 `seq`，还两次遍历全量条目
- 位置：`src/packages/ui-core/tui-plugins.ts:300-313`
- 现象：`seq` 注释说是「快照版本号」，但它在 `getSnapshot()` 体内自增——同一个内容读两次得到两个版本号；
  顺手还把 `base.entries` 过滤成两份新数组（`entries` 与 `liveEntries`）。
- 证据：
  ```
  303:    getSnapshot: () => {
  304:      const base = runtime.getSnapshot()
  305:      seq += 1
  310:        entries: base.entries.filter((entry) => entry.id > 0),
  311:        liveEntries: base.entries.filter((entry) => entry.id < 0),
  ```
- 影响：插件若拿 `seq` 判「快照变没变」（这正是版本号的用途），会得到「每次都变」，于是丢掉缓存；
  每次调用分配 3 个数组（展开一份 + 两次 filter），而 `App` 那条 80ms 合并窗口走的**不是**这个函数
  （它走 `runtime.getSnapshot` 原样），所以这个开销只落在 TUI 插件身上，且与 Web 通道「seq 由宿主帧生成、
  同帧多次读同值」（`host-channel` 的帧语义，见 03）不一致。
- 建议：`seq` 改成由 `subscribe` 回调触发时自增一次（即「帧」的边界），`getSnapshot` 只读；
  `entries`/`liveEntries` 用 `useMemo` 式的惰性缓存（按 `base` 引用记忆一次）。
- 置信度：高（函数全文读过）；「插件是否真用 seq 判变化」未查，见待核实

### 入口（src/boot.ts / src/headless.ts / src/packages/cli / bin/dsc.js）

#### [P2] F18 `migrateFromDsh` 有三处触发，其中 `readConfig()` 内部那一次丢掉报告，`config show` 也会写盘
- 位置：`src/core/config.ts:192-196`（内部触发）、`src/boot.ts:17`、`src/headless.ts:14`、`src/packages/cli/config-cli.ts:22-48`
- 现象：`readConfig()` 里有一句「缺配置时先尝试从 dsh 迁移」，返回值直接丢弃；两个入口在调用
  `readConfig()` 之前又各自显式调了一次 `migrateFromDsh()` 并把报告交给 `emitStartupNotes`。
  于是「迁移」这件事有三条触发路径，只有两条会把结果告诉用户。
- 证据：
  ```
  config.ts:194:  // 从 dsh 迁移只往**出厂那份**里写：换过配置文件的人自己选了一份，不该被迁移结果盖掉。
  config.ts:195:  if (file === DSC_CONFIG_YAML && !existsSync(DSC_CONFIG_YAML)) migrateFromDsh()
  config-cli.ts:48:  const config = readConfig()
  ```
- 影响：①`numa config show` 是只读命令，但它调 `readConfig()`，可能在用户没预期的时候写
  `~/.dsc/config.yaml` 与 `~/.dsc/credentials.yaml`；②两个入口的 `boot.ts:17` 是**无条件**迁移，
  而 `config.ts:195` 那个条件判断的注释说「换过配置文件的人不该被盖掉」——两个口径不同，
  用自定义配置文件的人仍会看到一句「已从 dsh 迁移模型配置到 ~/.dsc/config.yaml」，而应用实际读的是
  另一份。迁移本身幂等（`migrate.ts:161-162`：目标存在就返回 null），所以不会坏数据。
- 建议：迁移只在**一处**发生，且返回报告：给 `readConfig()` 加一个可选出参或返回
  `{ config, migration }`，两个入口都改成 `const { config, migration } = readConfig()`，
  删掉 `boot.ts:17` / `headless.ts:14` 的显式调用；`config-cli` 的 `show` 传 `migrate: false`。
- 置信度：高（`config.ts:192-196`、`migrate.ts:160-166`、`config-cli.ts:47-49` 三处都读过）；
  「用自定义配置时会看到误导提示」是静态推断，见待核实

#### [P2] F19 `bin/dsc.js` 与 `cli/index.ts` 各存一份「子命令 → 文件」表，而 `--help` 漏了 4 个子命令
- 位置：`bin/dsc.js:59-66`、`:37-55`；`src/packages/cli/index.ts:15-22`；`src/packages/cli/plugin-cli.ts:4-10`
- 现象：`cli/index.ts` 导出一张 `CLI_ENTRIES` 表，注释说「`bin/dsc.js` 按它拼 `lib/packages/cli/<file>`」，
  但 `bin/dsc.js` 是零依赖启动器（`dsc.js:5-7` 明说不 import 包），实际写的是三元表达式硬编码文件名——
  那张表没有任何消费者。同时 `--help` 只列 `plugin add/remove/list`，而 `plugin-cli.ts` 还实现了
  `builds` / `version-exemptions` / `allow-version` / `revoke-version` 四条（`plugin-cli.ts:7-10` 有文档，
  `:672` 的用法行也列全了）。
- 证据：
  ```
  cli/index.ts:15: /** 子命令 → 产物文件名（`bin/dsc.js` 按它拼 `lib/packages/cli/<file>`）。 */
  bin/dsc.js:60:   const tool = first === 'config' ? 'config-cli.js' : 'plugin-cli.js'
  plugin-cli.ts:672: console.error('用法：numa plugin <add|remove|list|builds|version-exemptions|allow-version|revoke-version> ...')
  ```
- 影响：`numa --help` 是用户唯一的发现入口，四条已实现的插件命令（含**版本豁免**这条安全相关入口，
  `plugin-cli.ts:26-28` 说明了它的重要性）在帮助里根本不存在，只能靠读源码或 `numa plugin` 打错才知道。
  改名/新增一个脚本要动两处（表 + 三元），漏一处是「命令静默跑到旧脚本」。
- 建议：三处收一处——`--help` 的文本从 `plugin-cli.ts` / `config-cli.ts` 各自的 usage 常量拼
  （或让 `bin` 在缺参数时 `--help` 转发给子脚本，`config-cli.ts:100` 与 `plugin-cli.ts:672` 已有现成的用法行）；
  `CLI_ENTRIES` 要么删（承认 bin 是零依赖启动器，文件名只能硬编码），要么改成一张 `bin` 能读的 JSON
  产物。**不要**留着「表在这儿、用在那儿」的假单一来源。
- 置信度：高（三处原文都读过；`bin/dsc.js` 无 import 包已核实 `dsc.js:14-17` 的 import 清单）

---

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
| --- | --- | --- | --- | --- |
| `/` 命令派发 | TUI 注入 `dispatchCommand` → `ctx.get('commands')`（`tui/index.ts:73-74`、`App.tsx:1606-1631`） | `runtime.runCommand` → `ctx.commands.run`（`runtime/index.ts:383-387`） | 只有 TUI（`App.tsx:1605`） | 删注入口，TUI 也走 `runtime.runCommand`；TUI 独有的 5 个界面回调改一次性注册（F5） |
| 命令回执 | `notice` = 8 秒过期的提示盒（`App.tsx:1630`、`:400-404`） | `notice` = 会话流的 command 条目（`runtime/index.ts:80`） | TUI 全部命令（`commands/index.ts` 里 53 处 `ui.notice`） | 按行数分流：长回执进 transcript，短提示进盒（F5） |
| 分轮（turn 切分） | TUI `scroll-model.ts:281-289` 自己数（插话算新轮） | `ui-transcript/ui/rounds.ts:97-148`（自称唯一真值，插话不开新轮） | TUI 的刻度/跳转/`jumpTurn` 全部 | 抽纯函数到 `ui-core` 或 `contract/`，两壳共用（F2） |
| token / 金额格式化 | `core/text-format.ts:16-20` `compactTokens`（TUI） | `ui-primitives/ui/tokens.ts:21-38` `formatTokens` / `formatCostCny`（Web） | TUI `StatusBar.tsx:203`、`ChatView.tsx:253`；金额另有内联第三份（`StatusBar.tsx:212`） | 统一到 `tokens.ts`，删 `compactTokens`（保留 `shortCwd`）（F8） |
| 审批四档判定 | TUI 三份（`ApprovalCard.tsx:79-87`、`App.tsx:1034-1043`、`:1250-1259`） | Web 一份（`ui-prompt/ui/ui.tsx:423-432`） | TUI 键盘 + 鼠标 + 页脚三处 | `scopesOf(request)` 一张表，两壳渲染同一份（F3） |
| 权限/模式文案 | TUI 审批卡硬编码（`ApprovalCard.tsx:143-144`），模式打内部 id | 宿主档位表（`approval/index.ts:84-88`）；TUI 状态栏已经走宿主 label（`StatusBar.tsx:157-162`） | TUI 审批卡 | 先改成查 `surfaces.policy`/`.mode` 的 options；要独立渲染再补契约字段（F11） |
| 界面插件装载 | 浏览器壳 `ui-boot/ui/boot.ts`（300+ 行，含 cordis 分支） | TUI `ui-core/tui-plugins.ts:91-280`（332 行） | 两壳各用各的 | 抽 `createUiLoader`，差异只留「读字节 + require 表 + 报告去处」（F6） |
| 槽位渲染出口 | ink 版 `ui-core/slots-ink.tsx` | DOM 版 `ui-slots/ui/slots-react.tsx` | TUI / Web 各自 | 校验与错误边界上收，只留包装器与崩溃视图（F15）；TUI 补 chain 分派或明确报错 |
| 槽名契约 | `TUI_SLOTS`（`ui-core/tui-plugin-api.ts:20-23`） | `SLOT` + `SlotMap`（`ui-slots/ui/slots.ts:26-52`） | TUI 插件用前者，但类型面只有后者 | TUI 的槽并进 `SlotMap`，常量单源（F16） |
| 入口装配 | `src/boot.ts:15-29` | `src/headless.ts:12-26` | 两个入口并存（TUI / 桌面 stdio） | 抽 `runShell({surface})`（F7） |
| 从 dsh 迁移 | 入口显式 `migrateFromDsh()`（`boot.ts:17`、`headless.ts:14`） | `readConfig()` 内部的隐式迁移（`config.ts:195`） | 两条都在跑，`config-cli.ts:48` 走的是隐式那条 | 只留一条并返回报告（F18） |
| 子命令入口表 | `bin/dsc.js:60` 硬编码文件名 | `cli/index.ts:16-19` 的 `CLI_ENTRIES`（无消费者） | bin 只有自己那份 | 删表或让 bin 读 JSON（F19） |

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
| --- | --- | --- | --- | --- |
| 分轮判据 | `tui/app/scroll-model.ts:281-289` | `ui-transcript/ui/rounds.ts:97-121` | B 排除 `steering`，A 只排除 `internal`；**行为相反** | 抽 `splitTurns(entries): number[]` 到 `ui-core` |
| 审批档位判定 | `tui/app/ApprovalCard.tsx:79-87`、`App.tsx:1034-1043`、`:1250-1259` | `ui-prompt/ui/ui.tsx:374`、`:423-432` | 键位 `a/p` vs `s/a`；Web 有 `scopes` 空数组回落 `['once']`（`:374`），TUI 靠「`allow-once` 恒在」等效 | 一张 `scopesOf()` + 一份键位表 |
| token 缩写 | `core/text-format.ts:16-20` | `ui-primitives/ui/tokens.ts:21-38` | `1.2k`/`46.0k` vs `1.2K`/`46K`；后者还处理 0/负数/非有限 | 统一到 `tokens.ts` |
| 金额格式 | `ui-primitives/ui/tokens.ts:34-38` | `tui/app/StatusBar.tsx:212` | 后者无 `<¥0.01` 兜底 | 复用 `formatCostCny` |
| 后台会话状态点 | `tui/app/StatusBar.tsx:45-49` | `tui/app/AgentsOverlay.tsx:26-30`、`tui/app/SessionPicker.tsx:28-32` | 三份逐字相同（后者注释自称「不互相 import 保持自洽」） | 搬进 `theme.ts` |
| 短 id | `tui/app/StatusBar.tsx:52-53`（已 export） | `tui/app/ApprovalCard.tsx:41-42`、`AgentsOverlay.tsx:33-34`、`SessionPicker.tsx:153-155` | 四份逐字相同，其中一份已导出且被 `App.tsx:78` import | 统一 import `StatusBar` 那份（或搬 `theme.ts`） |
| 筛选列表浮层 | `tui/app/App.tsx:1448-1466`（模型） | `:1468-1485`（模式）、`:1487-1504`（技能） | 只有字段名与回车动作不同；点击映射另三份（`:1095-1114`，`row - 1 - 3` 各写一遍） | 一个 `useFilterList` + 一个 `<FilterPicker>` |
| 时钟/节拍 | `tui/app/ticker.ts`（共享节拍） | `ui-statusbar` 快/慢两档时钟（见 04）、`ui-transcript/timing.ts` | TUI 已收敛成一份（好）；Web 侧仍两档各一套 | Web 侧对齐 ticker 的做法（不在本批） |
| 子槽校验文案 | `ui-core/slots-ink.tsx:67-72` | `ui-slots/ui/slots-react.tsx:103-108` | 逐字相同 | 抽共享校验 |
| 错误边界类 | `ui-core/slots-ink.tsx:106-135` | `ui-slots/ui/slots-react.tsx:166-197` | 除 `render()` 外逐字相同 | 抽 `createSlotErrorBoundary(View)` |
| 装载器骨架 | `ui-core/tui-plugins.ts:91-280` | `ui-boot/ui/boot.ts:672-738`（+ 白名单/重试/回滚段） | `requireFor` 报错文案、两轮重试注释、`ui` 对象、报告表同形；TUI 多读到了 `services` | 抽 `createUiLoader` |
| 启动装配 | `src/boot.ts:15-29` | `src/headless.ts:12-26` | 只有 `surface` 一个字面量不同 | 抽 `runShell({surface})` |
| 子命令表/帮助 | `bin/dsc.js:59-66`、`:37-55` | `cli/index.ts:16-19`、`config-cli.ts:100`、`plugin-cli.ts:672` | 三份帮助文本，入口表没人读，`--help` 漏 4 条子命令 | 帮助文本从子脚本 usage 拼 |
| 键名文案 | `tui/app/keymap.ts:16-58` | 11 个文件里的字面量（见 F9） | keymap 只覆盖 5 条提示，且有 4 个常量无消费者 | 全量迁到 `KEYS` 或缩范围并注明 |
| 权限档位名 | `approval/index.ts:84-88`（宿主表） | `tui/app/ApprovalCard.tsx:143`、`ui-prompt/ui/ui.tsx:263-273`（Web 侧，见 04） | 三处措辞不同（「自动编辑」/「工作区自动」/「只读（都要批准）」） | 契约补 label 字段，界面不再自造 |

## 待核实

1. **`App.tsx` 与 Web 的 `useSyncExternalStore` 提交次数没有实测。** F14 里「整棵树重建」是按 React
   语义推断的；`scripts/tui-snapshot-coalesce-test.mjs`（286 行）测的是合并窗口本身，
   没测「一次提交重建多少组件」。要证实得加渲染计数器或 React Profiler。
2. **长命令回执在固定帧里是否真的把 Composer 挤出可视区。** `App.tsx:1672` 的根盒是
   `height={frameRows}` + `overflow="hidden"`，`1814-1820` 的 notice 盒在 `Composer`（`1830`）之前。
   静态看会裁掉后面的兄弟节点，但没有实跑 `/help`（24 行）确认。`scripts/tui-*.mjs` 里没有钉这件事的用例。
3. **F16 的两个类型层结论都没实跑 `tsc`。** ①插件写 `ui.slots.register(TUI_SLOTS.noticeExtensions, …)`
   是否真的报错（依据是 `slot-contract.typecheck.tsx:23-24` 的同一条负例语义）；②运行期注册表是否落在
   默认 `SlotMapLike`（依据是 `tui-plugins.ts:49` 的 `new SlotRegistry<InkComponent>()` 只传一个类型参数、
   `slots.ts:375` 的默认 `M = SlotMapLike`）。`scripts/ui-tui-plugin-test.mjs` 只跑运行期，没有类型断言。
4. **`UiRuntimeApi.getSnapshot` 的 `seq` 有没有插件真的在读。** 没找到消费方
   （`scripts/ui-tui-plugin-test.mjs` 的样本插件只读 `ui.host.platform`）。若无人使用，
   F17 里的 `seq` 与 `sessionId` 补字段可以整段删掉，只留两份数组过滤。
5. **`services` 在 TUI 侧是否真的端到端生效。** 代码路径是通的（`tui-plugins.ts:246-251` 读到了），
   但 `scripts/ui-tui-plugin-test.mjs` 的样本清单里没有声明 `services` 的用例，
   所以「TUI 会等 provider」只是读代码得出的结论，没有探针。
6. **`slots.ts`（930 行）未逐行读。** 本批只核了导出面与 `SlotRegistry` 的类型参数默认值；
   `elect`/`chain`/`keyed` 三种形态的匹配规则是否与 Web 完全一致，属批次 03 的范围（它也没逐行读）。
7. **`App.tsx:1082` 的 `listTop` 与 `PICKER_CHROME`（`:96`）是否有实际的几何偏差。**
   两处口径不同（3 vs 5），但 3 是「列表起始行」、5 是「框的固定行数」，不一定矛盾；
   要看 `PickerFrame.tsx` 的实际边框行数才能判断点击命中是否会差一行。本批没有实跑点击。
8. **`ui-statusbar` 每隔字段一个选择器（`:115-119`）与本批 F14 的对比只是抽样。** 该文件 692 行，
   本批只 grep 了 cost/context/usage 相关段，没有逐行确认它是否也有「整份 snapshot 传给子组件」的地方。
9. **`bin/dsc.js` 与编译产物的对应关系没验证。** 报告里的 `lib/packages/cli/<file>` 路径取自
   `dsc.js:61` 与 `cli/index.ts:15` 的注释；没有 build 产物的实际目录结构可对照（本批禁止 build）。
