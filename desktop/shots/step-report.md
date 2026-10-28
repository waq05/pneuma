# 会话区折叠（三层 + 四档）—— 改动与自检报告

日期：2026-10-01 · 仓库：D:\dsc · 不改版本号、不 commit、不写真实 `~/.dsc`

本报告覆盖两批改动：**第一批**（阶段组折叠，三层结构的中间那层）是下面第一到六节；
**第二批**（四档档位、组头实时详情、组体限高与可收起内容的可访问性，0.6.7）在第七节。
第二批把第一批末尾「未验证 / 还没做」那份清单全部做完了，逐条对照见第七节的表。

对照的 dsh 参考源码（只读）：`D:\deepseek-harness\deepseek-harness\packages\client\ui-chat\src\client\`
（`conversation-nodes\process-groups.ts`、`conversation-nodes\process-activity.ts`、`conversation-nodes\step-process.ts`、
`conversation-nodes\README.zh.md`、`chat\ChatGroupSeat.tsx`、`chat\ChatGroupSeat.module.css`、`chat\TurnProcessNodeView.tsx`、
`chat\ReasoningRow.tsx`、`chat\searchable-hidden.ts`、`chat\use-process-scroll.ts`、`chat\use-disclosure.ts`、
`contract\process-groups.ts`、`contract\turn-process.ts`、`presentation-policy.ts`）

---

## 一、这一步解决了什么

改动前 dsc 的会话区只有两层折叠：**整轮总开关**（一行「用时 X」）+ **单条思考 / 工具卡**。
整轮开关永远画在轮首（`roundFold` 每轮只算一个 `[startIndex, endIndex]`），所以一轮里不管横跨
多少个阶段，能收起来的入口只有一个。这就是「只在最开始能折叠」。

这一步补上中间那一层：**阶段组**。一段阶段正文（模型写完一段话接着干活）把一轮切开，
两段正文之间夹着的思考与工具调用合成一组，每组一个组头，文案是这一组的工具类别聚合
（「已搜索代码并读取文件」这种）。

改完之后一轮的显隐是三层，从外向内：

```
用户消息
  ├ 整轮总开关「用时 X」            ← 收起时这一轮只剩它 + 最终回答 + 页脚
  ├ 阶段组头「已搜索代码并读取文件」   ← 整轮展开后才看得见，自己可单独开合
  │   ├ 思考过程（单条折叠）
  │   └ 工具卡 ×2（单条折叠）
  ├ 阶段正文（不进组，但整轮收起时一起消失）
  ├ 阶段组头「执行了命令」
  ├ 阶段正文
  ├ 阶段组头「修改了文件并已写入文件」
  └ 最终回答（不参与任何折叠）
页脚（复制 · 赞 · 踩 · 分叉 · 用量 · 时刻）
```

---

## 二、逐文件改动（行段）

### 1. 新建：分组器纯函数层

| 文件 | 行段 | 内容 |
| --- | --- | --- |
| `desktop/src/renderer/process-groups.ts`（新建 320 行） | 1–37 | 模块注释：切分规则逐条对照 dsh 的 `process-groups.ts:146-164`，并说明 dsc 的 transcript 天然是那个形状（`adapter/transcript.ts:284-298` 的 `message` 分支把思考与正文拆成两条独立条目） |
| 同上 | 38–52 | `ProcessActivity`：十四个行为类（read / search / commands / edit …），照 `process-activity.ts:7-21` 另加 dsc 的 `browser`、`search`、`session_search` |
| 同上 | 55–87 | `StepGroup`：轮号 + 轮内组序号 + 起止下标 + 类别计数 + 收口状态 + 实时类别 |
| 同上 | 89–103 | `StepGrouping`：组列表 + 两张查找表（`headAt` 组头画在哪、`at` 这条归哪组） |
| 同上 | 105–135 | `activityOf(name)`：工具名 → 类别，首个命中 |
| 同上 | 137–186 | 两套文案表（`已读取文件` / `正在读取文件` …）+ 拼接常量（「并」「，」「等」，共享前缀「已」） |
| 同上 | 189–215 | `stepGroupTitle(counts, closed, running)`：已结束报类别聚合（前三类），未结束只报此刻在跑的那一类 |
| 同上 | 219–232 | `runningActivity`：组里最后一个运行中工具属于哪一类（照 `process-activity.ts:97-114` 的「最大 time」口径） |
| 同上 | 234–253 | `countActivities`：次数降序、同数按首次出现的稳定排序 |
| 同上 | 260–320 | `groupSteps`：切分主循环（正文封组、计划卡成界、system 不成界、尾组按轮次收口） |

### 2. 新建：组头组件

| 文件 | 行段 | 内容 |
| --- | --- | --- |
| `desktop/src/renderer/StepGroupRow.tsx`（新建 85 行） | 1–23 | 模块注释：为什么用聚合文案、为什么整行可点 |
| 同上 | 25–45 | `ACTIVITY_ICON`：类别 → 图标（照 `ChatGroupSeat.tsx:37-52` 的 `PROCESS_ICONS`） |
| 同上 | 47–85 | 组头本体：真 `<button>`，带 `data-open` / `data-step-group` / `data-step-activity` / `data-step-closed` / `data-step-counts` 五个钩子，`aria-expanded` 跟着开合 |

### 3. 改动：ChatView 接入三层

| 文件 | 行段 | 改了什么 |
| --- | --- | --- |
| `desktop/src/renderer/ChatView.tsx`（950 → 1050 行） | 33–42 | 模块注释新增「阶段组折叠」一段（切分、组头位置、两态默认值、三层显隐、轮收尾复位） |
| 同上 | 62–63 | import 加 `StepGroupRow`、`groupSteps` / `StepGroup` / `StepGrouping`、`stepGroupFoldKey` |
| 同上 | 106–114 | 新增 `EMPTY_STEP_GROUPING` 常量（详细档用的空结果，做成常量让那一档的引用不变） |
| 同上 | 221–229 | `turnOpen` 改名 `foldOpen`：两级折叠共用一份 state（键形状天然不冲突，而它们总被同一件事同时改——轮收尾复位） |
| 同上 | 494–501 | 新增 `stepGrouping` memo；详细档（`foldTurns` 为假）直接给空分组 |
| 同上 | 536–545 | `runningFoldKeys`（键集合）换成 `runningRounds`（轮序号集合） |
| 同上 | 547–581 | 轮收尾复位 effect 扩到两级：整轮键 + 这一轮里每个组键一起写回默认收起 |
| 同上 | 607–621 | 新增 `stepGroupExpanded`（跑动中的组默认展开、定稿组默认收起）与 `toggleStepGroup` |
| 同上 | 790–798 | map 回调里新增 `step` / `stepHead` / `stepExpanded` 三个判定 |
| 同上 | 955 | 组收起时组内条目**整个不渲染**（不是用 CSS 藏），组头那条与页脚那条例外 |
| 同上 | 990–991 | 组头渲染（只在整轮展开时，跑动中照画）+ 组体显隐交给 `turnExpanded && stepExpanded` |

### 4. 改动：存档键 / 图标 / 样式

| 文件 | 行段 | 改了什么 |
| --- | --- | --- |
| `desktop/src/renderer/fold-state.ts`（44 → 59 行） | 45–58 | 新增 `stepGroupFoldKey(sessionId, roundIndex, groupSeq)` → 键格式 `会话id:step:轮序号:组序号`；注释说明为什么用「组序号」而不是「组内第一条的下标」（直播中尾组会一直长，下标会变） |
| `desktop/src/renderer/icons.tsx`（496 → 512 行） | 238–251 | 新增 `IconGlobe`：搜网页 / 访问网页 / 开浏览器三类共用（与本地代码搜索区分开） |
| `desktop/src/renderer/styles.css`（7232 → 7329 行） | 6525–6616 | 新增「阶段组头」样式段：`.step-fold`（与 `.turn-fold` 同规格的行内按钮）、`.step-fold-icon`、`.step-fold-label`（`text-secondary`，比思考行亮一档，两级折叠靠颜色分层而不是缩进）、`.step-fold-chevron` + `[data-open]` 180° 旋转；段头注明与 dsh 的 `ChatGroupSeat.module.css` 的对照关系 |
| 同上 | 6618–6626 | `prefers-reduced-motion` 那一段补进 `.step-fold` 与 `.step-fold-chevron` |

### 5. 自检资产

| 文件 | 内容 |
| --- | --- |
| `desktop/shots/step-groups-check.mjs`（新建） | 分组器的**行为单测**，94 条断言。直接跑 `src/renderer/process-groups.ts` 源码（该模块只有 type-only import，Node 的 type stripping 能把它们整条抹掉），验的是真源码而不是打包产物 |
| `desktop/shots/step-seed.mjs`（新建） | 隔离种子：三轮静态样张（三段阶段 / 只有思考 / 无最终正文）+ 实时样张 |
| `desktop/shots/step-seed-check.mjs`（新建） | **端到端检查**，18 条断言。走「`Session.load` → `Transcript.replayHistory` → `groupSteps`」整条链，验真实重放出来的条目形状能被正确切开；自己先重建夹具，所以不依赖执行顺序 |
| `desktop/shots/step-shots.ps1`（新建） | 隔离截图自检，三个用例：`step-static`（三层显隐 + 组头文案 + 独立开合）、`step-live`（跑动中组默认展开 → 定稿后两级一起收起 → 展开整轮的聚合组头）、`step-detail`（详细档无组头、过程摊开） |
| `desktop/shots/fold-check.mjs`（65 → 110 条） | 同步两条被本次改动打破的整轮断言（`turnExpanded` / `previousRunningRounds` 改名），并新增第 5 组「阶段组」43 条（样式挂点、渲染钩子、文案体系、详细档不分、收口清空实时类别） |

---

## 三、自检结果

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 桌面端类型检查 | `pnpm --dir desktop typecheck` | exit 0 |
| 桌面端打包 | `pnpm --dir desktop build` | exit 0（`out/renderer/assets/index-B52ORD7F.js`、`index-CcEB_yWP.css`） |
| 分组器行为单测 | `node desktop/shots/step-groups-check.mjs` | **94 条断言全过** |
| 端到端（jsonl → 分组） | `node desktop/shots/step-seed-check.mjs` | **18 条断言全过** |
| 整轮折叠回归网 | `node desktop/shots/fold-check.mjs` | **110 条断言全过**（原 65 条无回归） |
| 隔离截图自检 | `pwsh -NoProfile -File step-shots.ps1` | 三个用例 38 项判据**全部为真** |

### 三个截图用例量到了什么

**`step-static`（标准档 · 定稿轮）**——隔离 settings `processFold=standard`

- `collapsed.steps = 0`：整轮收起时组头**根本不画**，不是用 CSS 藏起来；
- `turnOpen.steps = 3`：展开整轮后浮出三个组头，`aria-expanded` 全是 `false`（默认收起）；
- `turnOpen.round0 = { thinkBlocks: 0, toolCards: 0 }`：组收起时组员从 DOM 里退场；
- `stepOpen.round0 = { thinkBlocks: 1, toolCards: 2 }`：点开第一组后只有它自己的成员回来，
  另外两组的 `aria-expanded` 仍是 `false`（独立开合）；
- 三个组头文案逐字比对通过：`已搜索代码并读取文件` / `执行了命令` / `修改了文件并已写入文件`；
- 箭头展开后 `transform` 从 `none` 变成 `matrix(-1, 0, 0, -1, 0, 0)`（180°）；
- 层级靠颜色分层量到了：`.step-fold-label` = `var(--dsc-text-secondary)`，
  `.think-label` = `var(--dsc-text-tertiary)`；行高 26px 对 27px（同一档）。

**`step-live`（标准档 · 实时一轮）**

- 跑动中：`stepCount=1`，标题 `正在分析请求`，`aria-expanded="true"`，组员在 DOM 里
  `thinkBlocks=1` —— 组头出现且默认展开；
- 定稿后：`stepCount=0`（组头随整轮一起隐去）、`round.thinkBlocks=0`、整轮开关 `aria-expanded="false"`
  —— 两级折叠一起复位；
- 再展开整轮：`stepCount=2`，文案 `已完成分析` / `已读取文件`，两个都收起；
- 页脚显示 `用量 330 tok`（宿主上报真值，不带 `~`）。

**`step-detail`（详细档）**

- `toggles=0 && steps=0`：既没有整轮总开关，也没有阶段组头；
- `membersVisible=true`（`round0` 里 3 条思考 + 5 张工具卡直接摊开）。

截图：`step-static.png`（三个组头，第一组展开、另两组只剩聚合标题）、
`step-live.png`（`已完成分析` + `已读取文件` 两个组头，中间夹阶段正文，页脚 330 tok）、
`step-detail.png`（详细档：过程逐条摊开，无组头）。

---

## 四、隔离安全（真实 `~/.dsc` 指纹）

跑前 / 跑后各做一次「文件数 + 全量 SHA256 聚合」比对：

- 文件数 **138 → 138**（锁定 0）
- 清单聚合 SHA256 `445d8ff19df6ad5ac59cfc71524cfa2d2a1ad32d826f5013e167c37268b42119`（两次一致）
- 内容聚合 SHA256 `5014e8ba154234e9550ffe6e91a95b11c4192abfff73ffe961854e4b01afd427`（两次一致）
- 差异行 **0 条** · 路径增删 **新增 0 / 减少 0**

进程纪律：`DSC_DESKTOP_USER_DATA` + `USERPROFILE` + `HOME` 全部指到 `desktop/shots/step-home`；
Electron 用 `Start-Process` 起，最后只 `taskkill /PID <自己起的那棵> /T /F`；临时目录变量一律
自命名（`$stepHome` 等），绝不用 `$home` / `$HOME`。

---

## 五、实现中修正的一处语义漏洞

第一版把「组头渲染」的条件写成 `stepHead !== undefined && turnExpanded`，看着没问题——
但 `turnExpanded` 在**不在整轮过程区里**时恒为真，而详细档（`foldTurns=false`）下
每一轮都不在过程区里。结果是详细档虽然关掉了整轮折叠，阶段组头却照样冒出来，
把「过程条目逐条摊开」那一档又收了一遍。

修法：`stepGrouping` 这一层就区分档位——`foldTurns` 为假时直接给空分组
（`ChatView.tsx:494-501`）。外层既然撤了，内层不能自己冒出来。
`step-detail` 用例（`toggles=0 && steps=0 && membersVisible=true`）就是钉这条的。

---

## 六、取舍与下一步

### 这一步有意没做的（第 3 步的清单）

1. **组体限高与方向渐隐**。dsh 的组体是 `min(400px, 50vh)` 限高 + 上下 24px 渐隐 + 组内独立滚动跟随
   （`use-process-scroll.ts`）。dsc 的组内条目本身已经是一条条折叠行，第一版先不上限高；
   要做就得把「组」包进一个容器，而现在的渲染是「一个 `entries.map` 逐条产出 `.entry-row`」，
   需要改成按组产出。
2. **跑动中组体默认收起**。现在跑动中组是展开的（组头 + 成员都在）。dsh 的 standard 档跑动中
   只显示组头一行、组体收起，组头带实时详情（`正在运行命令 · pnpm build`）。
   这一条与下面第 3 条是一对：不先做实时详情就收起组体，屏幕上会少掉「在调哪个工具」这条线索。
3. **思考块直播态默认展开**（`ThinkingBlock.tsx:114` 的 `readFold(storeKey, live)`）与 dsh 相反
   （`conversation-nodes/README.zh.md:172`：「单个推理初始收起，包括流式输出期间」）。
4. **档位对齐到四档**。dsh 是 `compact / standard / detailed / verbose`，其中 **`detailed` 仍然整轮折叠**，
   只有 `verbose` 才关掉；区别在 `stepGrouping`（compact/standard 全部组可折、detailed 只历史轮分组、
   verbose 不分）。dsc 的 `detailed` = dsh 的 `verbose`，缺了 dsh 那个「整轮照折、只折历史轮」的档。
   扩档要动五处链路（`contract.ts` → `core/prefs.ts` 白名单 → `plugins/runtime.ts` 回执 →
   `appearance.ts` 归一 → `SettingsModal.tsx` 那一行）。
5. **收起时保护键盘焦点**（dsh：“自动收起若会隐藏键盘焦点，则保持过程展开”，README.zh.md:104）；
   dsc 是无条件不渲染，焦点在里面时会被抽走。
6. **浏览器查找命中折叠内容**（dsh 的 `searchable-hidden.ts`：挂 `hidden` 属性、被查找时自动展开）；
   dsc 收起时根本不渲染，所以 Ctrl+F 搜不到过程内容。
7. **组头的 hover 换箭头**（dsh 的图标位叠箭头，悬停时换成 chevron）；dsc 现在图标与箭头并存。
8. **中途插话则不折整轮**。dsh 有 `hasInterleavedInput`；dsc 的 transcript 里没有 steering 这个 kind
   （`contract.ts:187-198`），这一条既没数据也没行为。

### 需要留意的两处观感

1. **中文聚合文案有时会别扭**。「修改了文件并已写入文件」这种读起来不顺，根因是 dsh 的拼法规则
   （两项都以「已」开头才省略第二个的「已」，而 `edit` 的完成文案是「修改了文件」，不以「已」开头）。
   要改就得动文案表（例如把 `edit` 改成「已修改文件」），那会偏离 dsh 的原文案表，所以这次照 dsh 保留。
2. **组比较碎**。模型「思考 + 说一句 + 调工具 + 说一句」这种形态会形成「只含思考的组」+「只含工具的组」
   两组（因为正文一封组，后面的工具就另起一组）。这不是实现问题：dsh 的 `ChatGroupSeat` 与截图里的
   `已完成分析` 也是这么切出来的。

### 未验证

- 浅色主题下这三个用例没另拍（结构与深色同一套令牌）。
- `prefers-reduced-motion` 只写了样式降级，没做截图用例。
- `plan`（计划卡）成界这条只在行为单测里验过（种子造不出 plan 条目，要真跑一次审批），
  没有做成截图用例。

---

## 七、第二批（0.6.7）：把上面那份「未验证 / 还没做」做完了

上一节列的三条、加上第六节最后那份「离 dsh 还差什么」清单里除第 8 条（中途插话，dsc 没有
steering 条目类型，有意不做）以外的全部，都在这一批做完。逐条对照：

| 第一批末尾列出的欠缺 | 第二批怎么做的 | 证据 |
| --- | --- | --- |
| 档位对齐到四档（`detailed` 语义要改） | `UiProcessFold` 扩成 `compact / standard / detailed / verbose`，能力表抽进零依赖的 `desktop/src/renderer/fold-policy.ts`（`foldTurns` / `stepGrouping` / `liveDetail` / `reasoningPreview` 逐格对照 dsh 的 `POLICIES`）；五处链路（契约 / 白名单 / 回执 / 归一 / 设置页）全改 | `step-groups-check` 第 19 组 12 条 + `fold-check` 第 3、8 组；截图 `step-detailed.png`（跑动中不分组、历史轮才有组头）、`step-verbose.png` |
| 思考块直播态默认展开与 dsh 相反 | **保留 dsc 的选择**：跑动中的那一段永远展开（它是「现在在干什么」的唯一线索）。新增的「定稿的思考行默认展开」开关只管定稿条目 | `fold-check` 里 `readFold(storeKey, live \|\| defaultOpen)` 的接线断言 |
| 收起时保护键盘焦点 | 两处收起都不再 `return null`，改挂 `hidden="until-found"`；隐藏前先看焦点在不在子树里，在就先展开不隐藏（`desktop/src/renderer/fold-seats.tsx` 的 `useSearchableHidden`）。组头点击时另把焦点落到组头自己身上 | `step-static` 的 `focusGuardWorks`（焦点在组里时点收起 → 开关仍是展开态、焦点没丢）与 `collapseAfterBlurWorks`（焦点挪开后收得掉，证明前一条是保护而不是开关坏了） |
| 浏览器查找命中折叠内容 | 同一条 `hidden="until-found"` 路线，外加 `beforematch` 监听 | `step-static` 的 `beforematchReveals`（把事件派发到收起那一轮里的工具卡上 → 整轮展开、`hidden` 归零） |
| 组头的 hover 换箭头 | `.step-fold-leading` 用 `inline-grid` 把图标与箭头叠在同一格，悬停 / 聚焦 / 展开时换过来 | `step-static` 的 `expandedSwapsIconForChevron`（`iconOpacity=0` 且 `chevronOpacity=1`）；`fold-check` 的 C2 组 |
| 浅色主题没另拍 | 加了 `step-light` 用例 | `step-light.png`；判据是「组头与背景的对比度 9.43 对思考行的 5.53」 |
| reduced-motion 没做用例 | 改成从样式表读 `@media (prefers-reduced-motion: reduce)` 块核对三处挂点 | `fold-check` 的 E2 两条 |
| plan 成界没做成截图 | 种子里往 jsonl 追一条老格式 `plan` 记录，`step-plan` 用例重新打开一次会话（走真 `dsc/session-open`）再取证 | `step-plan.png`；`step-seed-check` 另验了 `Session.load` 读得回 `state('plan')` |

第二批新增/扩过的四张网（全部实测，非估算）：

| 网 | 条数 | 覆盖的增量 |
| --- | --- | --- |
| `step-groups-check.mjs` | 163 PASS / 0 FAIL（原 94 + 新增 69） | 实时详情的取值优先级（command / file_path / description / pattern / queries / questions / 取不到退回工具名 / 坏 JSON）、160 字素簇截断与 ZWJ 表情不切散、详情挂在未结束组上而收口清空、没有 running 工具时取最后一段直播尾思考、150ms 最短保留的六种判定、四档能力表逐格、只给历史轮分组、文案表边界（恰好三类不加「等」/ 十类仍列前三 / 八个同次数按首次出现） |
| `step-seed-check.mjs` | 25 PASS / 0 FAIL（原 18 + 新增 7） | 种子第 4 轮「33 条调用挤一组」的形状、`Session.load` 把老格式 `plan` 读回 `state('plan')`、重放路径的会话流里本来没有计划卡 |
| `fold-check.mjs` | 166 PASS / 0 FAIL（原 110 + 新增 56） | 四档设置链路（含 `verbose` 不被归一秒成 `standard`）、两个默认态开关的接线、直播详情与防抖的实现挂点、组体限高与 mask、图标与箭头叠放、`hidden="until-found"` 与焦点检查、`@media (prefers-reduced-motion)` 块 |
| `step-shots.ps1` | 6 用例 / 49 条布尔旗标全真 | `step-static` 21 条、`step-live` 13 条、`step-detailed` 6 条、`step-verbose` 4 条、`step-light` 2 条、`step-plan` 3 条 |

`step-static` 里量到的关键数字：组体 `clientHeight=400`（限高生效）、`scrollHeight=1414`（33 条成员）、
渐隐 `mask-image` 在场、组内滚到顶不动外层 `scrollTop`（254 → 254）、收起时那一轮只有 2 条过程行留在
DOM 里带 `hidden`（它们负责 Ctrl+F 能命中）；`step-live` 里 27 次采样（每 60ms 一次，比 150ms 的最短
保留还密）**零次有效跳变**。

### 第二批的四处诚实边界

1. **`detailed` 档的语义变了**（原本等于 dsh 的 `verbose`）。老 `settings.json` 里存着 `detailed` 的人
   升级后会看到过程折起来——去设置里改「完全展开」即可。没做存档迁移：这个档位 0.6.3 才加，
   迁移要额外引入一个存档版本位，代价大于收益。
2. **冷启动看不到计划卡**：启动恢复历史会话这条路不发 `dsc/session-open`
   （`src/host/kernel.ts:363-366` 只重放历史），而计划卡靠那个事件回到会话流。要让两条路一致得改内核，
   已登记在 `docs/harness-benchmark-roadmap.md` §3.2。
3. **`prefers-reduced-motion` 验的是规则在场**，不是渲染结果：让媒体查询真的命中要改主进程加
   `--force-prefers-reduced-motion` 启动开关。真要验得动产品代码，本批没动。
4. **Chromium 把 `hidden="until-found"` 实现成 `content-visibility: hidden`**：被跳过的内容在
   `getClientRects()` 里仍报矩形（实测 8 条收起的组成员全报 1）。所以自检里的可见性判据是
   「祖先带 `hidden` 属性 + 有矩形」两条一起用——单看矩形会把收起来的又算成可见（这一脚在
   `step-shots.ps1` 的注释里留了记录）。

---

## 八、第三批（0.6.8）：轮结束原因、轮中途插话与四道折叠闸门

这一批是把「与 dsh 的差异清单」里**原料已经齐、只差消费**的那几条补齐，逐项对照与踩坑见
[development-log.md 阶段 24](../../docs/development-log.md)。四张网的变化：

| 网 | 条数 | 新增覆盖 |
| --- | --- | --- |
| `step-groups-check.mjs` | 180 PASS / 0 FAIL（+17） | 插话不另起一轮且是二级分组的边界、计时不被插话归零、轮尾标记与长度上限都是独立节点、独立节点表五类 |
| `step-seed-check.mjs` | 25 PASS / 0 FAIL | 不变 |
| `fold-check.mjs` | 190 PASS / 0 FAIL（+24） | 契约三样新东西（`TurnEndReason` / `steering` / 两种新条目）、事件链原料真的从循环里出来、adapter 三处消费、渲染层四道闸门与「已停止 / 过程失败」三态、`disabled` 与空条目不占位、组体的 `wasOpen` |
| `step-shots.ps1` | **7 用例 / 56 条布尔旗标全真** | 新用例 `step-control` 七条：插话同轮 + 锁整轮折叠 + 过程保持展开、组收口时组内 `scrollTop` 不动（且那一刻这一轮仍在跑）、中断的轮报「已停止」且不可点 |

`step-control` 量到的关键数字：插话那两条用户消息的 `data-round` 都是 `1`（同一轮）、那一轮的
整轮开关 `data-turn-blocked="1"` + `disabled`、组体 `clientHeight=400` 对 `scrollHeight=1110`、
滚动位置 `60 → 60`（收口前后一致）。真实 `~/.dsc` 七轮跑完指纹逐文件零改动。

**踩到的两个坑（都不是产品 bug，但都伪装成产品 bug）**：

1. **假端点把「第几跳」判错了**。它原来在整个请求体里找 `"role":"tool"`——多轮对话里历史本来
   就带着前几轮的工具消息，于是第二轮的第一跳被误判成第二跳、压根不吐工具调用。界面上表现为
   「那一轮只切出一个组」，一度以为是分组器坏了。改成看**最后一条消息的角色**，并把跳数做成
   可配（`FOLD_FAKE_HOPS`）。
2. **「组收口」被「轮收尾」盖住了**。自检一开始等的是「这一轮结束」，而轮收尾会触发「复位组内
   开合」——组被整个收起，`scrollTop` 自然归 0，测出来的不是要验的那件事。让假端点支持
   「中间跳带一段正文 + 一个工具」，把两个时刻错开，并加一条 `turnStillRunning` 断言证明
   收口那一刻轮确实还在跑。

---

## 九、第四批（0.6.9）：准备中态与模型重试行（动到流式层）

前两批改的是「宿主已经报出来的东西没人消费」，这一批反过来：**原料本身不在**，要一路从 SSE
解析透到界面。逐项对照与踩坑见 [development-log.md 阶段 25](../../docs/development-log.md)。

| 网 | 条数 | 新增覆盖 |
| --- | --- | --- |
| `step-groups-check.mjs` | 210 PASS / 0 FAIL（+30） | 十四个类别的准备文案、准备中的类别计数与详情规则（只有通用类别补工具名）、升级后回到「正在…」、只有 `preparing` 变也算换标题、模型重试是二级分组边界但不在独立节点表里 |
| `step-seed-check.mjs` | 25 PASS / 0 FAIL | 不变 |
| `fold-check.mjs` | 213 PASS / 0 FAIL（+23） | 契约的 `preparing` / `model-retry`、流式层两个回调与触发点、事件链两条转发、adapter 的队列与由 `liveEntries` 合成、轮末清队列、十四类准备文案、工具卡不可展开、运行指示分开「正在准备 / 正在调用」、TUI 与轨迹页都认得 |
| `step-shots.ps1` | **8 用例 / 62 条布尔旗标全真** | 新用例 `step-prepare` 六条：准备中那一行「准备中」+ 无箭头无展开区、组头文案「准备读取文件」、假端点故意 500 之后出现「正在重试（第 2 次）」、重试后正常跑完、轮末不留准备中的条目 |

**这一批最值得记的不是功能，是那个被自检逼出来的 bug**：`tool/prepare` 起初往已定稿列表里
push 条目，而 `entries` 永远把已定稿列表排在直播尾之前——工具卡因此**插到了正在流式的思考
前面**，DOM 顺序成了「用户 → 工具卡 → 思考 → 正文 → 重试行」，这一轮也只剩一个组、组头
永远显示不出「准备读取文件」。表象一直像 150ms 防抖没落定，把 DOM 顺序与组号逐个打出来才
看见真相。

第一版修法（push 前先把直播尾定稿）顺序对了但**引入重复内容**——`message` 事件随后再 push
一遍思考与正文，中间隔着刚插进来的工具条目，「合并进相邻同类型条目」就落空了，`step-live`
当场从 2 个组变成 3 个。最终改法是把准备中的条目**移出列表**、由 `liveEntries()` 合成在直播尾
之后，`tool/call` 到达时才正式落进列表——顺序天然对、无重复，清理也简化成一句「清空队列」。

---

## 十、第五批（0.6.10）：组头跑动中的扫光

这一批比预想的小：**dsc 早在思考摘要上做了同一件事**。`styles.css` 那段
`.think-summary-text[data-shimmer]::after` 已经是 dsh `TextShimmer` 的等价写法（`::after` 用
`content: attr(data-shimmer)` 复制同一串文字、高光渐变裁进字形、底层真文字保持可选中与可读）。
所以只做了三件事：把那条规则的**选择器并列加上组头的 label**、给 label 一个定位父级、
在 `prefers-reduced-motion` 里把组头那条也关掉。收口的组不给扫光（对照 dsh 的
`active={!data.closed}`）——已经不动了还扫，看着像还在干活。

**类别图标不改**：dsh 的图标来自它自己的设计系统包，dsc 拿不到那些 SVG；而且 dsh 把 `commands`
画成抽象的 API 方块图标，语义上不如 dsc 的终端图标贴切。真正值得对齐的是「哪一类用哪一类
图标」的映射，那条已经对齐。这条与「运行指示保留 dsc 两行」「子调用计数不做」一起登记在
`docs/harness-benchmark-roadmap.md` §3.3 的「明确不做」里。

| 网 | 条数 | 新增覆盖 |
| --- | --- | --- |
| `step-groups-check.mjs` | 210 PASS / 0 FAIL | 不变（这一批不碰纯函数层） |
| `step-seed-check.mjs` | 25 PASS / 0 FAIL | 不变 |
| `fold-check.mjs` | 218 PASS / 0 FAIL（+5） | 两条选择器并列共用、label 是定位父级、渲染层只给跑动中的组挂 `data-shimmer`、reduced-motion 降级也在、扫光节奏照 dsh 的 `1.5s steps(48, end) 0.3s infinite` |
| `step-shots.ps1` | **8 用例 / 63 条布尔旗标全真** | `step-live` 多一条 `liveHeadShimmers`：跑动中的组头确实带扫光挂点 |

诚实边界：静态截图只能证明「挂点与样式在场」，证明不了「动画真在跑」——扫光是 1.5 秒一轮的
连续动画，单帧看不出来。真要验得录一段或读 `getAnimations()` 的播放状态，本批按「规则在场 +
挂点在场」记，与 `prefers-reduced-motion` 那条同一口径。

---

## 十一、第六批（0.6.11）：加载更早（渲染层渐进渲染）

这一批原本要照 dsh 做**数据源分页**，动手前先量了真实开销（`desktop/shots/load-bench.mjs`，
只读 `~/.dsc`）：最大的单会话 1 MB / 25 条消息，`Session.load` **4.9ms**、堆增量 **3.3 MB**；
**全部 78 个会话**加载一遍 **26ms** / **2.5 MB**。关键在于 dsc 的 `messages` 同时是「模型请求
上下文」与「界面展示来源」同一份——只给展示分页，请求上下文仍要全量加载，**内存一点不减**。
dsh 能省下来是因为它结构上把两者分开了（`session-query` 索引 + node store + `next-turn` 领取
批次），那是架构级改造，在当前数据量下收益为零。

所以这一步做**渲染层渐进渲染**，用户可见行为与 dsh 一致：

- 一页 8 轮，初始只画最近一页，顶上给一颗「加载更早的 N 轮（上面还有 N 轮）」；
- 记的是「用户放出的最早**轮号**」而不是页数——会话一直在长，按页数记会让最上面那轮被新消息
  悄悄收走；
- 锚定按 dsh 的原文「按正文顺序锚定按钮下第一个可见内容项」，DOM 更新后由 `useLayoutEffect`
  把它拉回原来的视口位置；锚点若落在限高组体内，**那个组先在自己的滚动范围内吸收位移**，
  吸不下的才交给外层 transcript；
- 开合状态按轮号存（`会话id:turn:N`），与渲染窗口无关，所以跨分页天然保留。

| 网 | 条数 | 新增覆盖 |
| --- | --- | --- |
| `step-groups-check.mjs` | 210 PASS / 0 FAIL | 不变 |
| `step-seed-check.mjs` | 28 PASS / 0 FAIL（+3） | 分页样张 12 轮、每轮一组、每轮过程从思考开始（只有回答的轮没过程可折，整轮开关是 disabled 的，那批断言就没东西可验——第一版种子就是这么踩的） |
| `fold-check.mjs` | 218 PASS / 0 FAIL | 不变 |
| `step-shots.ps1` | **9 用例 / 68 条布尔旗标全真** | 新用例 `step-paging` 五条：初始 8 轮 + 按钮文案、点完 12 轮、锚点 `moved: 0`（外层 `scrollTop` 569→527 正是补偿）、手动展开的整轮跨分页仍展开 |

诚实边界：① **数据源分页押后**，不是不做——等会话真长到几千轮、内存变成可观测问题时，再连
「模型上下文与展示历史分离」一起做。② 「分页请求期间若读者滚动则优先服从滚动」这条 dsh 规矩
只在异步取数据时才有意义（这一步是同步的、一次渲染完事），没有实现也没有可测场景。
