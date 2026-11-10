# 会话区与 dsh 的剩余差距

这份清单只记**会话区（对话流的渲染、折叠、滚动）**与参考实现 dsh 的差距。

- 参考实现：`D:\deepseek-harness\deepseek-harness`（下文路径都相对这个根）。
- 本仓现状：`src/packages/ui-transcript/`（行与折叠）、`src/packages/ui-renderer/ui/styles/`（样式）、
  `src/packages/ui-tool` 不存在——工具卡在 `src/packages/ui-transcript/ui/tool-card/`。
- 行号截至 **2026-11-10**，改动后请顺手更新；每做完一条，把状态改成「已对齐（日期）」，别删条目。

怎么用：挑一条 → 读「两边现在怎么写」→ 按「代价」估工期 → 做完补一行验证记录。

**核实记录（2026-11-10，一次只读核对）**：改掉了六处站不住的说法——S9 其实**已经有**选中浮层
（在 `ui-ask` 里，不在 `ui-transcript`，所以当时 grep 漏了）、S2 的「给行加 `memo` 一行止血」不成立
（`Row` 对象每帧重建）、S7 的「可能不适用」是错的（重答的轮序号不变，展开态确实会沿用）、
S4 漏了 `read-row.tsx` 且本仓已有可点文件路径、S8 缺的是**数据源**不是卡片、S6 的行号漂了。
另外从 S5 里拆出 S11（底部占位与折叠期空间补偿）。行号以这次核实为准。

**施工顺序（核实的建议）**：S10 → S4（先做 bash 那张）→ S2（比较器止血）→ S9 → S7 → S8 → S5 → S6。
排前面的两条理由是「改动小、用户一眼看得见」；S5 与 S6 共用同一套视口机制，必须一起评估，放最后。

---

## 已对齐（2026-11-10，不再重复做）

| 项 | dsh 的做法 | 本仓现在的做法 |
| --- | --- | --- |
| 三层折叠结构 | 整轮 `turn-process` / 阶段组 `ChatGroupSeat` / 单行 `DisclosureRow` | 同三层（`round-fold.tsx` / `step-group-row.tsx` / `think-row.tsx`、`tool-card`） |
| 四档展示档位 | `presentation-policy.ts:25-54` | `round-fold.tsx` 的 `PROCESS_FOLD_POLICIES` |
| 组头文案聚合 | `step-process.ts:11-28` | `process-groups.ts` 的 `stepGroupTitle` |
| 组头实时标题 150ms 最短保留 | `ChatGroupSeat.tsx:58-81` | `step-group-row.tsx:89-120` + 纯函数 `liveTitleDecision` |
| 组体限高 / 渐隐 / 组内独立滚动 | `ChatGroupSeat.module.css:102-133` | `views.css` 的 `.step-body`（`min(400px,50vh)` + mask 24px） |
| 收起改挂 `hidden="until-found"`（Ctrl+F 可命中、不抽走焦点） | `searchable-hidden.ts:31-43` | `fold-seats.tsx` 的 `useSearchableHidden` |
| 行身份跨「直播 → 定稿」 | 块索引（`AssistantMarkdown.tsx:99-109`） | `Row.stable`（`shared.ts` 的 `buildSeats`），组取首行身份 |
| 直播思考收起起步 | `use-disclosure.ts:11-21` | `think-row.tsx`：`useFoldState(storeKey, !live && prefs.reasoningOpen)` |
| 整轮收起才复位内部行与组 | `ChatNodeSeat.tsx:122-131` 的 `disclosureReset` | `ui.tsx` 的 `collapsedRounds` + `foldMemory.clearPrefixes` |
| 运行中尾组一条也成组 | `process-groups.ts:147-165` | `process-groups.ts` 尾组 `flush(false)` |
| 展开不做高度过渡（条件渲染） | `DisclosureRow.tsx:121-122` | `views.css` 的 `.think-body` 已撤 `grid-template-rows` |
| 思考行 / 工具卡默认展开开关 | 无（dsh 恒收起） | 本仓自己的增量，保留（直播期不生效） |

---

## P1：影响以后每个功能

### S1 会话区没有「节点级槽位」（已对齐 2026-11-10）

> **已对齐（2026-11-10）**。做了三件：① `shared.ts` 加了三条 chain 子槽
> （`transcript.node` / `transcript.toolview` / `transcript.reasoning.body`）；② `render.tsx` 的
> switch 搬进 `builtinRowBody`，`RowBody` 先问节点槽、落空画内置行体；③ 给壳加了
> `renderSlot(name, owner, fallback)` 的第三个参数——chain 的兜底只能走它，写 `?? 内置`
> 判不出来（返回值是出口元素、永远不是 `null`）。
> 验收：`scripts/ui-node-slot-test.mjs` 30 条全绿、`desktop/shots/_verify-think-markdown.mjs` 真机通过
> （顺带验了「兜底不套 `.slot-entry`、没画丢」）。
> **仍欠一条**：第三方插件真的接管一类节点的运行时实证——现在钉到的是「源码形状 + 注册表行为
> + 兜底没坏」，不是「装个插件换掉思考行」的端到端。

- **现象**：想让「思考正文长什么样」「这条消息的图怎么排」跟别人不一样时，只能改内核；
  插件只能接管工具卡。
- **dsh**：每种节点都是槽——`conversation.chat.node`（`ChatView.tsx:252-262`）、
  `conversation.chat.reasoning.body`（`AssistantMarkdown.tsx:80`）、
  `conversation.chat.message.images`（`AssistantMarkdown.tsx:127-131`）、
  `conversation.chat.text-interaction`（`ChatView.tsx:259-262`），`ChatNodeSeat.tsx:166-176`
  按 `kind` 分发。
- **本仓**：只有工具卡一条链（`TOOLVIEW_SLOT`，`ui-transcript/ui/shared.ts:78`）；
  思考行、正文、系统行、用户行写死在 `render.tsx` 的 `RowBody` switch 里（`render.tsx:288-400`）。
- **代价**：中。把 `RowBody` 的 switch 拆成「按 kind 声明的槽 + 内置兜底」，工具卡那条链改成
  其中一项，行为不变。
- **验收**：现有 `ui-transcript-render-test` 全绿；新增一条「注册一个 reasoning body 槽能改掉
  思考正文」的测试用插件。

### S2 整树重渲染，没有逐节点订阅（已止血 2026-11-10，彻底方案未做）

> **已止血（2026-11-10）**：给 `RowBody` 包了一层**带比较器**的 `memo`
> （`render.tsx` 的 `RowBodyBody` + `rowBodyUnchanged`），只比 `row.entry` 引用、`row.live`、
> `renderSlot` 三样。直播行照旧每帧重画（`liveEntries()` 每次 `map` 出新对象），定稿行不再重画。
> 实测（`desktop/shots/_perf-stream.mjs`，60 轮 / 126 行 / 约 19 秒流式，同一台机器单次采样）：
>
> | 指标（渲染进程累积） | memo 关 | memo 开 | 差 |
> | --- | --- | --- | --- |
> | TaskDuration | 1796 ms | 1674 ms | −6.8% |
> | **ScriptDuration** | 604 ms | **447 ms** | **−26%** |
> | RecalcStyleDuration | 229 ms | 231 ms | ≈0（DOM 输出没变，符合预期） |
> | LayoutDuration | 79 ms | 85 ms | ≈0 |
>
> 一句话读法：**少干了四分之一的脚本活，但主线程本来就没被压垮**（帧间隔 p50/p95 在两版里都是
> 6.1/6.2ms，20 秒里只有 1 次长任务）。所以这一条在 126 行这个规模是「省电、不是提速」；
> 要变成体感差异，得等整棵树真的压不住的时候——单次采样，没有取中位数，别当成精确值。
> **彻底方案仍然没做**：座位层（`SeatBody`）还是每帧重建，`seat` / `roundFolds` / `stepGrouping`
> 全是新引用，浅比较必失败；要它稳就得给座位算稳定身份，那就滑进 keyed store 了。

- **现象**：长会话流式时 CPU 偏高、滚动更容易抖；这是「上下抽搐」类报障反复出现的土壤。
- **dsh**：每行自己订阅一个节点（`ChatNodeSeat.tsx:55-62` 的 `useChatNode(nodeKey)`，
  `ChatFlow.tsx:52-63` 按稳定 key 复用实例），只有内容变的那一行重渲染。
- **本仓**：`ui.tsx` 用 `useMemo(() => buildSeats(entries, live), [entries, live])` 算座位，
  而 `live` 每来一口 delta 都是新引用 → `buildSeats` 每帧重跑 → **每一行都是新 `Row` 对象**
  （`shared.ts` 的 `rowOf` 返回对象字面量），再往下整棵行树重渲染。
- **注意（2026-11-10 核实后的修正）**：所以「给 `ThinkRow` / `ToolCardView` 加 `memo`」这条
  **一行下去没用**——props 每帧都是新引用，`memo` 的浅比较必然失败。
  可行的止血是给 `RowBody`（或座位层）写**带比较器的** `memo`，比较 `row.entry` 引用 +
  `row.live` + `renderSlot`；彻底做法仍是 keyed store 逐行订阅。
  另外 `MarkdownView` 自己已经 `memo` 了（`ui-primitives/ui/markdown.tsx:612`），
  「每帧重新解析 markdown」这个担心不成立，别把它算进成本。
- **代价**：中（比原来写的「中高」低一档：止血那条改的是 `RowBody` 一个组件 + 一个比较器）。
- **验收**：录制一条 200 条目的会话，流式 1000 个 delta，量 React commit 次数与耗时；
  改前 / 改后各一次，数字差距写在这里。

---

## P2：用户能直接看见

### S3 思考正文是纯文本，不是 Markdown（已对齐 2026-11-10）

> **已对齐（2026-11-10）**。正文搬到 `ui-transcript/ui/rows/think-text.tsx`（单拆一个文件：
> 它正是 `transcript.reasoning.body` 那条槽的落点），改走 `MarkdownView`——`streaming` 递
> `live`、`baseDir` 取会话工作目录（与正文同口径）。样式复用 `.file-md` 那一套，只补 12 条
> 带 `.think-text` 前缀的覆盖（段距收紧、标题降级、代码块与表格不许撑宽），
> `.think-text` 撤掉了 `white-space: pre-wrap`。
> 验收：`scripts/ui-think-markdown-test.mjs` 32 条全绿、`desktop/shots/_verify-think-markdown.mjs`
> 真机通过（截图 `desktop/shots/_think-markdown.png`：代码块有底色与行号、列表有缩进、加粗生效）。
> 顺带记一条小刺（未做）：收起态摘要里的行内代码会带出反引号（`think-row.tsx` 只
> `replaceAll('**', '')`，没去反引号），一行可修。

- **现象**：模型在思考里写的 `1.` 列表、`**加粗**`、` ``` ` 代码块，到界面上是原始字符。
- **dsh**：`renderSlot('conversation.chat.reasoning.body', …)` 默认 `MarkdownText`
  （`AssistantMarkdown.tsx:80`），代码块/列表/表格都排出来。
- **本仓**：`.think-text` 直接 `{entry.text}`（`think-row.tsx:217`），
  `white-space: pre-wrap`（`views.css` 的 `.think-text`）。
- **代价**：小（复用 `MarkdownView`）+ 一个性能注意点：长思考每帧解析会慢，需要 `streaming`
  降级（本仓的 `MarkdownView` 已有 `streaming` 参数）。
- **验收**：摄影一张带代码块的思考展开图；`ui-transcript-render-test` 加一条「思考正文走
  markdown」的形态钉。

### S4 工具卡只有一张通用卡（部分对齐 2026-11-10：命令类已换专用卡）

> **部分对齐（2026-11-10）**：`bash` / `shell` / `pwsh` 三种名字（且参数里真有 `command` 字段）
> 换成一张终端块——`$ 命令` / 输出（限高 `min(240px,30vh)` 内滚）/ 退出码徽章 / 耗时。
> 判据与实现在 `tool-card/factory.tsx` 的 `isTerminalCall` 与 `tool-card/bash-view.tsx`；
> **只在对话页生效**，轨迹页（`variant === 'trace'`）继续摊原始参数与结果原文——那一页的
> 职责是取证，格式化会把原文吃掉。
> 退出码是**从结果文本里解析**的（`/退出码 (\d+)/`，只看前两行）：宿主没有结构化退出码，
> `tools-default/bash.ts:206` 只在非 0 时写那一行；命中就把整行从正文摘掉，解析不到且
> `status=done` 视为 0，跑动中只写「运行中」。
> 验收：`scripts/ui-tool-bash-test.mjs` 43 项、`desktop/shots/_verify-bash-card.mjs` 真机通过
> （真跑 `echo 自检输出; exit 3`，断言命令 / 输出 / 徽章 3 / 正文里没有重复的退出码行 /
> **阶段组展开后终端块在屏幕上真有高度**）。截图 `desktop/shots/_bash-card.png`。
> **仍欠**：`read` 那一张（只差行号与折叠形态，本仓已有可点文件路径），以及 dsh 另外 9 个
> 视图（`search-row` / `web-row` / `file-mutation-row` / `todo-row` / `details-row` /
> `ask-question-row` / `read-image-row` / `GenericToolCard` / `read-family-row`）。

- **现象**：`bash` 在 dsh 是一块终端（黑底、退出码徽章），本仓是「执行了命令 · 摘要」。
- **不成立的那半句**：`read` 在 dsh 里是「可点文件路径 + 行号」，本仓**已经是**可点路径了
  （`tool-card/factory.tsx:630` 与 `:654` 都在画可点的文件路径）——这条只差行号与折叠形态。
- **dsh**：11 个视图——`read-family-row`、`read-row`、`search-row`、`web-row`、
  `file-mutation-row`、`bash-sample`、`todo-row`、`details-row`、`ask-question-row`、
  `read-image-row`、`GenericToolCard`（`packages/client/ui-tool/src/client/tool/toolviews/`，
  原文漏了 `read-row.tsx`，这里补上）。
- **本仓**：一张 `ToolCardView`（`tool-card/factory.tsx:230`）+ 工具名匹配表
  + 参数表 `toolArgFields` + diff + 结果尾巴。
- **代价**：中。分批做，第一张先做 `bash`（终端块：命令 + 输出 + 退出码徽章），它的收益最大；
  `read` 那张只剩「行号 + 折叠」这点增量。
- **验收**：每张卡一条隔离截图 + 一条断言；与 dsh 对应截图并排放 `docs/` 里。

### S5 滚动是「CSS + 钉底」，dsh 是「视口协调器」（部分成立）

- **已经补掉的**（未提交的 `follow.ts` 改动）：藏起来的行不写缓存、手势 1500ms TTL、
  `pointerdown` 即停跟随、用 `useLayoutEffect` 而不是 `useEffect` 上钉底——这几样已经和文档
  初稿写的时候不一样了，**接手前先 `git diff` 看一眼它改到哪了**。
- **剩下的**：折叠那一拍的**逐帧**位置补偿（现在是「下一帧再钉一次」，所以仍有一两帧位移），
  以及底部占位（见 S11）。
- **dsh**：`use-chat-viewport.ts` + `use-chat-reading.ts`——折叠期间逐帧同步 `scrollTop`、
  25px 贴底阈值、500ms 采样 + `scrollend`、`reading.pending` 抑制跟随、折叠期间关原生锚定
  （`use-chat-viewport.ts:96-102`）。
- **本仓**：`ui-transcript/ui/follow.ts` 钉底 + `overflow-anchor: none`
  （`views.css:1329-1334`）+ 贴底外边距（`views.css:1346-1366`）。
- **代价**：中（比初稿的「中高」低：一半已经落地，剩下的核心是「折叠动画期间每帧同步
  `scrollTop`」这一件，要一个贯穿折叠组件与滚动容器的协调器）。
- **验收**：`desktop/shots/_verify-think-collapse.mjs` 那种「50ms 采样 + 位置回退计数」的探针。

### S11 没有「底部占位」，折叠时靠外边距兜（2026-11-10 从 S5 拆出）

- **现象**：过程区收起 / 展开那一拍，末尾内容会跳一下；贴底时尤其明显。
- **dsh**：底部有一个 `data-chat-turn-spacer` 占位元素承担高度变化（`use-chat-viewport.ts`），
  配合逐帧 `scrollTop` 同步，所以视觉上「收起来的那段高度被占位吃掉了」。
- **本仓**：用 `views.css:1346-1366` 的贴底外边距近似，没有真正的占位元素。
- **代价**：小到中（一个占位元素 + 跟随它的高度计算），但它与 S5 的逐帧同步是同一套机制，
  所以两条要一起做，别单拆。
- **验收**：与 S5 同一条探针。

---

## P3：实现方式不同，暂不影响使用

### S6 整轮收起动画是「整段一起缩」

- **dsh**：逐行 JS 动画（`flow-motion.ts:383-430`：淡出 70ms → 延迟 50ms → 高度 110ms，
  逐行隐藏、各自可被 Ctrl+F 命中，同时补偿滚动）。
- **本仓**：一个 `.turn-process` 容器 + `grid-template-rows: 0fr ↔ 1fr`
  （`views.css:10699-10725`；原文写的 10621-10632 已漂）。
- **差别**：观感接近、逐像素不同；容器式包裹还会让夹在中间的独立条目把过程切成几段
  （`render.tsx` 的 `flushSegment`）。
- **代价**：大（要移植整套 flow-motion 与视口协调）。
- **建议**：等 S5 做完再评估——两者共用同一套视口机制。

### S7 整轮展开态没有「回答代次」（已对齐 2026-11-10，用「重答即清存档」近似）

> **已对齐（2026-11-10，近似实现）**：没有加代次字段，而是在 `editAndResend` 里
> **rewind 成功之后、submit 之前**把这一轮的折叠存档清掉（`ui.tsx:503-511`）：
> 整轮那一格用 `foldMemory.clear([turnFoldKey(sid, keep)])` **精确清**（`turn:1` 当前缀会把
> `turn:10` 一起清掉），行与阶段组按前缀清（`…:r3:` / `…:step:r3:`）——它们也带轮号，
> 不清的话新回答里同位置的行会继承上一版同位置行的展开态。
> 为什么 `keep` 能当轮号：`rounds.ts` 规则 3 不让 `internal` 条目开新轮，所以「这条之前
> 人打的用户消息条数」正好是这条消息所在轮的序号。
> 验收：`scripts/ui-edit-generation-test.mjs` 32 条（含第 5 节真的 import `fold-state.ts`
> 演算「精确清不误伤 `turn:10`」「前缀 `s:r1:` 不误伤 `s:r10:`」）；
> `desktop/shots/_verify-edit-generation.mjs` 真机通过——走界面「编辑并重发」，
> 重答收工后 `.turn-fold` 的 `aria-expanded` 回到 `"false"`（没清的话会是 `"true"`）。
> 与 dsh 的差别只在实现：它是「代次不匹配所以不命中」，本仓是「重答这一拍清掉」。

- **dsh**：`turnProcesses` 记 `{turn, answerStep}`，`turnProcessOpen` 要求代次匹配
  （`stores.ts:36-44`）——同一轮重答一次，用户上次的展开选择失效。
- **本仓**：键是 `会话:turn:轮`（`fold-state.ts` 的 `turnFoldKey`），重答后展开态沿用。
- **不是「不适用」（2026-11-10 核实后修正）**：`editAndResend`（`ui.tsx:479-510`）是
  `rewindSession(路径, 保留几条人打的用户消息, 新正文)` 再 `submit`——它把这条消息之后的内容
  全截掉重发，**新回答拿到的轮序号与原来相同**，`turnFoldKey` 一模一样，存档必然命中。
  所以「重答后用户上次的展开选择还留着」这条**确实存在**。
- **代价**：小。给存档键加上「这一轮第几次回答」（宿主侧要能给出这个代次；没有就退回
  「每次 rewind 时清掉这一轮的 turn 存档」这种近似做法）。

### S8 缺几类特殊节点卡片（部分成立）

- **dsh**：`SystemPromptRow`、`ContextInjectionRow`、`CompactionItem`、`CommandNodeView`、
  `ApprovalCommand`、`GenericCommandCard` 各一张卡。
- **本仓**：system / 压缩标记 / 命令输出统一画成 `.entry-system` 或 `.entry-system-command`。
- **真正缺的是数据源（2026-11-10 核实）**：条目类型表 `src/contract/transcript.ts:139-242`
  里**根本没有** context 注入、系统提示、压缩这几类节点——照 dsh 补卡也没有内容可画。
  所以这条要拆成两件事：先决定「这几类信息本仓要不要进会话流」（数据侧），再谈卡片。
- **代价**：小到中（卡片本身小），难点在数据侧要不要加节点类型；差别在信息密度，不在功能。

### S9 选中文字后的浮层：动作已改走槽（已对齐 2026-11-10，多颗定位仍欠）

> **已对齐（2026-11-10）**：浮层动作从写死一颗改成一条 `list` 槽 `ask.selection.action`
> （`owner: { text, close }`），内置那颗「问 AI」也登记到链上（`id: ask.selection.builtin`，
> priority 100 兜底位），于是动作次序一律由槽的 `order` 决定，插件能排到它前面或后面。
> 定位从按钮挪到容器 `.ask-sel-actions` 上（多颗时排一行）；`mousedown` 守卫也跟着改到容器，
> 否则插件那颗按钮在 click 之前就被摘掉了。
> 验收：`scripts/ui-ask-selection-slot-test.mjs` 32 条、`ui-side-ask-test` 66 条、
> `desktop/shots/_verify-selection-actions.mjs` 真机通过（真实选区 → 浮层从槽里渲染出 1 颗
> 「问 AI」）。截图 `desktop/shots/_selection-actions.png`。
> **仍欠**：多颗动作时的右边界夹取——`select.ts` 的 `anchorOf` 仍按单颗宽度（`BUBBLE_W=92`）
> 夹，插件挂 2–3 颗时整排可能伸出视口被裁。改法是容器右对齐到选区右缘（用 `right` 而不是
> `left`），或渲染后 measure 再夹。

- **原文写「grep 无命中」是错的**：本仓**已经有**这个浮层，在
  `ui-ask/ui/ui.tsx:188-262` 的 `SelectionBubble`——`.chat` 里选中 ≥4 个字就贴选区右下角浮
  「问 AI」，`:93-100` 还有对应的快捷键（带引用）。当时只 grep 了 `ui-transcript`，所以漏了。
- **dsh**：`text-interaction.ts` + `conversation.chat.text-interaction` 槽
  （`ChatView.tsx:212-263`）——动作是**槽里挂的**，插件可以加「解释这段」「翻译这段」。
- **本仓**：动作写死成「问 AI」一件。
- **代价**：小到中（把那一颗按钮换成一条 chain 子槽，选区几何/滚动跟随/移动端都已经有了）。

### S10 思考行展开时没有 sticky 头部（已对齐 2026-11-10）

> **已对齐（2026-11-10）**：`.think-block.open .think-head` 改成 `position: sticky; top: 0`。
> 吸附参照系是**阶段组的组体 `.step-body`**（`max-height: min(400px,50vh)` + `overflow-y: auto`），
> 不是 `.chat`——再往上的 `.turn-process-body` 是 `overflow: hidden`，吸附链到那里就断了。
> `.think-bar` 的 `top` 从 0 挪到 `var(--dsc-process-row-h)`，两块上下叠着谁也不盖谁。
> 验收：`desktop/shots/_verify-think-sticky.mjs` 真机通过（滚 160px 后行头与组体顶差 0px、
> 块顶已上移 160px 证明是「头吸住」而不是「整块没动」、快捷栏紧贴行头底边、**真鼠标点吸住的行头
> 还能收起**）。截图 `desktop/shots/_think-sticky.png`。
> 两个改这一条必踩的坑：① `--dsc-fill-quinary` 是 **3% 的透明填充**，直接当行头底色会让滚过去的
> 内容从行头里透出来（看着像两行字叠一起），要用「linear-gradient 铺色 + `--dsc-bg-raised` 垫底」
> 才真不透明；② 组体顶部那条 24px 渐隐遮罩会作用到吸住的行头上、把字淡掉一半，得把顶边那条撤掉——
> **但一条 `mask-image: none` 不够**：滚到中段时 `[data-scroll-up]` 与 `[data-scroll-down]` 同时挂着，
> `none` 会把底边那条渐隐一起撤掉，所以要两条规则（一条撤顶边，一条在「上下都能滚」时只留底边）。

- **dsh**：`.root[data-expanded] [data-disclosure-header] { position: sticky; top: 0 }`
  （`ReasoningRow.module.css:17-22`）。
- **本仓**：用 `.think-bar` 吸附快捷栏代替，但有 **400px 内容阈值**（`fold-body.ts:9`），
  短于 400px 的思考展开后没有吸附条。
- **差别**：短思考展开时，滚动到正文中间就找不到「收起」按钮（要靠行头，行头已滚走）。
- **代价**：小（去掉阈值或把行头也做成 sticky）。

---

## 不在会话区、但同源的两处（记在这里免得丢）

- **工具视图的槽契约**：dsh 的 `tool.call.toolview` 按 wire 工具名 keyed 分发
  （`ui-tool/src/client/contract/slots.ts:23-27`）；本仓是选举链（priority + 认领），
  行为等价、契约形状不同。插件移植时要对着查。
- **批量折叠的动画作用域**：dsh 只在 `running || motionTail || pendingInputs` 时挂
  `data-chat-motion`（`ChatView.tsx:228-232`），本仓没有这层「什么时候允许动」的开关，
  动画恒开——`prefers-reduced-motion` 之外没有别的降级路径。
