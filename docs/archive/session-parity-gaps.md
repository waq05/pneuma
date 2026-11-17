# 会话区与 dsh 的剩余差距

> 状态：已归档（2026-11-17）：S1–S11 已收口，留作会话区对齐的决策记录；文末两条未定论现象仍按线索保留。

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

**施工顺序（2026-11-10 的建议，已按此执行完）**：S10 → S4（先做 bash 那张）→ S2（比较器止血）→ S9 → S7 → S8 → S5 → S6。
排前面的两条理由是「改动小、用户一眼看得见」；S5 与 S6 共用同一套视口机制，所以合成四阶段施工图一起做。

**当前状态（2026-11-11）**：S1、S2、S3、S7、S9、S10、S11 已对齐；S5、S6 按四阶段施工图全部落地
（每个阶段都有真机读数）；S8 的数据面与两张卡已做完；S4 已换四张专用卡（命令类 + 读文件 / 检索 /
待办），剩下六张逐条写明了「为什么不值得现在做」（两张要改数据面，四张重复或已有等价形态）。
每条「没做到的」都写在对应小节里，**别只看标题就以为全齐了**——S2 的 ScriptDuration 目标没达成，
原因在文末「性能线索」。

### 视口与渲染管线的四阶段施工图（2026-11-10 设计，2026-11-11 四个阶段全部落地）

剩下的 S11 / S2 彻底版 / S5 / S6 都动同一片代码（`ui-transcript/ui/` 的 `render.tsx`、`ui.tsx`、`fold-seats.tsx`、`follow.ts`、`views.css`），所以**按下面顺序做，每阶段结束时门禁要能绿**。四段已全部完成（提交 `ef33fcd` / `f8b3180` / `2801529` / `cf13db9`），**表里「验收」那一列就是当时的判据，不是计划口径**：

| 阶段 | 改什么 | 验收 | 会失效的旧断言 |
| --- | --- | --- | --- |
| ① S11-a 占位壳 | `.chat` 末尾加一个恒 0 高的 `[data-chat-turn-spacer]`（**放在 `.chat-inner` 外面**）；`follow.ts` 的 `floor()` 改成 `scrollHeight − spacer − clientHeight` | `_verify-jitter` 余量不变、`ui-fold-combo` 全绿 | 若哪条探针数 `.chat` 子元素个数，会红 |
| ② S2 座位稳定 | 新增 `ui/seat-store.ts`（按 `Row.stable` 索引、只重建尾部变化行）；`SeatBody` 拆成可 memo 的 `SeatFrame` + 自己订阅的 `RowSlot`；`onFork` 提成稳定引用 | 新增 `_verify-row-isolation`（流式 3 秒内非尾行 DOM 变动为 0）；`_perf-stream` 的 ScriptDuration 应低于 447ms | `ui-transcript-render-test` 里钉 `middle.push`/`turn-process` 源码形态的几条；`rowBodyUnchanged` 退役 |
| ③ S5 视口协调器 | 新增 `ui/viewport.ts`，独占「测尺寸 / 写 scrollTop / 写占位 / 开关 overflow-anchor」；`follow.ts` 只留策略 | 新增 `_verify-fold-scroll`（16ms 采样：第一条可见行的屏幕 top 变化 ≤1px，末帧占位回 0） | `views.css` 里 overflow-anchor 那条的注释；`follow.ts` 的 floor/settle 说明 |
| ④ S6 逐行收起 | 新增 `ui/fold-motion.ts`；退役 `.turn-process` 的 grid 动画；分段器只留显隐集合；`hidden` 归被隐藏元素自己写（重挂当场同步提交，见过的走动画末帧） | `_verify-think-collapse`（位置回退 0 次）、`_verify-jitter` | `ui-transcript-render-test` 的 `[5]` 整段、`ui-fold-combo` 的一条、`_verify-think-collapse` 读 `data-fold` 的部分 |

**落地后的实际读数（不是预估）**：

- ①：占位恒 0 高，`floor()` 减掉它；② 之前贴底就已是「离 floor ≤2px」。
- ②：一帧里真正重跑的行体 3.51 → **2.31**，最坏单帧 115 → **6**（全量锚帧不再整屏重画）；`_verify-row-isolation` 0 违规。**ScriptDuration 没压到 447ms 以下**（469 → 450~457，单次采样 ±3%），原因已用 CPU profile 定位：会话区组件整段 19 秒合计只有 15–20ms，主线程 4 秒里 idle 3684ms，非 idle 的前三项全在轨迹页 bundle 下（见文末「性能线索」）。
- ③：展开 / 收起时第一条可见行屏幕 top 最大漂移 **0.46px / 0.50px**（限 1px），scrollTop 实际补位 334px，批次期间 `overflow-anchor` 内联与计算值都是 `none`、结束还原空串，末帧占位回 0；贴底态离 floor 最大 0.33px。
- ④：一次真实收起（段满高 228px）—— t=58ms 透明度已 0.01、高度还是 228px；t=69ms 才开始收高；t=185ms 高度 0；t=213ms 挂 `hidden`。收起过程中行自己在变矮，不再是整段被上缘切走。

四条设计定论（都是查过两边代码才定的，别再走回头路）：

1. **三者（S5/S6/S11）只能有一个 owner**：`viewport.ts` 独占三个 ref（滚动容器 / 内容列 / 占位）与三件事（测、写 scrollTop、写占位高度）。动画侧（`fold-motion.ts`）只写 box 的 `height/margin/opacity`，每帧顺序固定「先写 box → 再让 viewport 写滚动与占位」。分两套定时器必然一抖一抖。
2. **`overflow-anchor` 不能只关流式尾行**。它当初被关掉要解决的是「同一帧里我们在写 `scrollTop`、浏览器也在写」，只关尾行冲突一模一样；而批次末帧把行打成 `hidden` 时锚点候选会消失、浏览器重选锚点还会跳一下。dsh 是按**时间**开合的：批次活跃时整区设 `none`，批次结束还原。
3. **占位必须放在 `.chat-inner` 外面**。放里面会多吃一格 `--dsc-turn-gap`，而且 `follow.ts` 观察的是 `scroller.firstElementChild`（正是 `.chat-inner`），占位放里面会让「占位改高度」被当成内容增长、被自己的 `onResize` 抵消掉。
4. **贴底与读历史是两种落点**，在批次开始时就定：贴底 → 落到 floor；在读历史 → 保住第一条可见行的屏幕位置（前后各量一次 `top`，差值补进 `scrollTop`）。别用一种落点兼顾两处。

#### 阶段 ③④ 会撞到的既有断言（逐条查过，含行号）

查法：把 `scripts/ui-*.mjs` 与 `desktop/shots/_*.mjs` 全读一遍，只留真正读 `follow.ts` / `render.tsx` / `fold-seats.tsx` / `views.css` 的断言，再回源码确认那行还在、还叫这个名。行号是 2026-11-10 未提交状态。

**行号会漂的两个文件**：`render.tsx` 与 `ui.tsx` 在核对的这一小时里正被另一个子代理改（② S2 座位稳定，当时工作树里已经出现 `_probe-tmp.ts` 与 `_perf-rows.mjs`）。本节给的是 23:26 那一版的读数，并且都加了函数锚（`pushRow` / `flushSegment` / 放页补偿那个 `useLayoutEffect`）——② 落地后请按函数名重新定位，别照行号硬找。`follow.ts`、`fold-seats.tsx`、`views.css` 三个文件当时没有未提交改动，行号可直接用。

两个判词的口径先定死，免得后人把「可能」当「必然」：

- **必然失效**：按上面四条设计定论，这条断言钉的那串字符或那条 CSS 规则**必须**消失或改名；
- **可能失效**：取决于实现细节（留不留别名、wrapper 留不留、函数签名改不改）。

**【更正一条】** 施工图第 ③ 行「会失效的旧断言」写的是「`views.css` 里 overflow-anchor 那条的注释」——**没有任何探针钉它**。全仓 grep `overflow-anchor` 只命中两处：`views.css:1334` 的规则本身，和本文件里这张图。所以 ③ 改那段是自由的，代价是改完**没人守**。

##### 一、阶段 ③（S5 视口协调器）会撞到的

| 断言（探针:行 → 源码:行） | 现在钉的是什么 | ③ 之后 | 建议处置 |
| --- | --- | --- | --- |
| `scripts/ui-turn-spacer-test.mjs:135` → `follow.ts:27` | 占位选择器 `[data-chat-turn-spacer]` 写在 `follow.ts` 里 | 必然失效（测量归 `viewport.ts`） | 改：把这条挪去钉 `viewport.ts` 的同一句，强度不变 |
| `scripts/ui-turn-spacer-test.mjs:136` → `follow.ts:28` | 读的是 `.offsetHeight`（元素真实高度，不是 style） | 必然失效 | 改：同上 |
| `scripts/ui-turn-spacer-test.mjs:137` → `follow.ts:28` | 取不到占位时 `?? 0` | 必然失效 | 改：同上 |
| `scripts/ui-turn-spacer-test.mjs:138-141` → `follow.ts:97-98` | `floor()` 的算式 `scrollHeight − spacerHeight(scroller) − clientHeight` | 必然失效（floor 变成 viewport 的测量 API） | 改：钉 viewport 里同一条减法，别只钉 `floor()` 这个名字 |
| `scripts/ui-turn-spacer-test.mjs:142` → `follow.ts:130` | `pin()` 写的是 `floor()`，不是 `scrollHeight` | 必然失效（写 scrollTop 归 viewport） | 改：钉 viewport 的 `pin()` 写 floor |
| `scripts/ui-turn-spacer-test.mjs:143` | 否定断言：`pin()` 不再直接写 `scrollHeight` | 不撞 | 留：否定式，只要没人写 `= scroller.scrollHeight` 就永远绿 |
| `scripts/ui-turn-spacer-test.mjs:144` → `follow.ts:11` | 贴底判定 24px | 不撞 | 留：这是策略，按定论 ① 只留在 `follow.ts` |
| `scripts/ui-turn-spacer-test.mjs:145-148` → `follow.ts:152`、`:191` | 判据比的是「离 floor 多远」，不是离 `scrollHeight` | 可能失效（`floor()` 改叫 `viewport.floor()` 就当场不匹配） | 改：正则放宽成 `(?:viewport\.)?floor\(\)`，强度不降 |
| `scripts/ui-turn-spacer-test.mjs:96-119` → `ui-layout/ui/app.tsx` | 占位是 `.chat` 的**最后一个子元素**，且 `chat-inner` 收尾到它、它到 `.chat` 收尾之间没有别的节点 | 不撞（③ 只写内联高度，不搬 DOM） | 留，**但这是硬约束**：③ 别往 `.chat` 里再加兄弟节点（测量探针、遮罩层都算），加了必然红 |
| `scripts/ui-turn-spacer-test.mjs:125-129` → `ui.tsx` | 反向钉：占位不许出现在 `ui.tsx` 里 | 不撞 | 留 |
| `scripts/ui-turn-spacer-test.mjs:154-162` → `views.css:12770-12773` | `.turn-spacer` 的 `flex: 0 0 auto` + `height: 0`；`:161` 还要求规则前 600 字符里有「高度由」三个字 | 可能失效（③ 要把注释从「现阶段恒 0」改成「协调器按需写」） | 改：改写注释时抠住「高度由…写内联样式」这句；或把断言改成「注释里点了 viewport.ts」 |
| `scripts/ui-interaction-base-test.mjs:470` → `follow.ts:11` | 贴底判定 24px | 不撞 | 留 |
| `scripts/ui-interaction-base-test.mjs:471` | 否定断言：旧的 `clientHeight < 160` 已撤 | 不撞 | 留 |
| `scripts/ui-interaction-base-test.mjs:472` → `follow.ts:14` | `FOLLOW_SETTLE_MS = 180` | 可能失效（落定等待就是为了补最后几像素，可能整体搬进 viewport） | 改：两种归属都认，或跟常量一起挪 |
| `scripts/ui-interaction-base-test.mjs:475` → `follow.ts:272` | `wheel` 监听挂在滚动容器上 | 不撞（手势识别是策略） | 留 |
| `scripts/ui-interaction-base-test.mjs:476` → `follow.ts:231` | 只认往上滚（`deltaY >= 0` 就返回） | 不撞 | 留 |
| `scripts/ui-interaction-base-test.mjs:477` → `follow.ts:17` | `UP_KEYS` 含 `PageUp` | 不撞 | 留 |
| `scripts/ui-interaction-base-test.mjs:482-491` → `follow.ts:249-251` | `onPointerDown` 函数体：只记时刻、不当场松手 | 可能失效：`bodyOf(followSrc, 'const onPointerDown = (): void => {')` 按字面函数头取体，③ 一旦给它加参数就取不到体 | 改：函数头改成按 `const onPointerDown` 起头、按花括号配平取体 |
| `scripts/ui-interaction-base-test.mjs:494-500` → `follow.ts:221-227` | `onGesture` 函数体：清跟随之前不许有任何延后动作 | 可能失效（同上，字面函数头） | 改：同上 |
| `scripts/ui-interaction-base-test.mjs:503` → `follow.ts:271` | `scrollend` 直接挂 `settle` | 可能失效（settle 若整体搬进 viewport） | 改：两种归属都认 |
| `scripts/ui-interaction-base-test.mjs:504` → `follow.ts:160` | 180ms 计时器兜底调 settle | 可能失效（同上） | 改：同上 |
| `scripts/ui-interaction-base-test.mjs:507` → `follow.ts:131`、`:168`、`:175`、`:182`、`:199` | `written.current = scroller.scrollTop`（只认自己的写） | 可能失效：若 viewport 的 pin 直接返回写入值，这行变成 `written.current = viewport.pin()` | 改：写成「两种写法都认」的正则（`viewport.pin()` 与 `scroller.scrollTop` 各一支），强度不降 |
| `scripts/ui-interaction-base-test.mjs:508` → `follow.ts:181` | 差 1px 以内当自己滚的 | 不撞 | 留 |
| `scripts/ui-interaction-base-test.mjs:511` → `follow.ts:275` | `new ResizeObserver(onResize)` | 可能失效（观察器算「测尺寸」，可能搬 viewport） | 改：两种归属都认 |
| `scripts/ui-interaction-base-test.mjs:515-521` → `follow.ts:253-261` | `onResize` 里「读者在读就提前返回、绝不走到 pin」 | 可能失效（同上，字面函数头） | 改：同 482 那两条 |
| `scripts/ui-interaction-base-test.mjs:525-529` → `follow.ts:38`、`:206` | 手势有效期 1500ms 及那道判定 | 不撞 | 留 |
| `scripts/ui-interaction-base-test.mjs:532-538` → `fold-seats.tsx:128`、`:253-268` | 组体那 7 条：4px 贴底、wheel、只认往上、scrollend、`written`、跟随才追、不再用 `AT_BOTTOM_EPS` | 不撞 | 留，**列为禁改**：③ 的 viewport 只管外层 `.chat`（滚动容器 / 内容列 / 占位三个 ref），别顺手把 `.step-body` 也纳进去——纳进去这 7 条一起红；组体是限高盒子自己的滚动，与外层贴底不是一套 |
| `scripts/ui-paging-test.mjs:200` → `ui.tsx:369`（放页补偿那个 `useLayoutEffect` 里的 `scroller.scrollTop += top - anchor.top`） | 放页后把锚点拉回原视口位置 | 可能失效：定论 ④ 要求「贴底/读历史两种落点由协调器定」，③ 若把放页补偿一起收进 viewport，这行会变成 viewport 的调用 | 改：钉「量了锚点位移再补」，别钉那一行字面量 |
| `scripts/ui-paging-test.mjs:201` → `ui.tsx:331-332`（`pageAnchor.current = …`） | 锚点取第一个画出来的座位 `[data-round-seat]` | 可能失效（同 200 号） | 改：同上 |
| `views.css:1329-1334` | `.chat` 的 `overflow-anchor: none` 与它上面那段「两边都在写 scrollTop」的注释 | **没有任何探针钉它**（见上面那条更正） | 改：③ 自由改写，但要自补一条断言（批次活跃时 `none`、批次结束还原），否则改完没人守 |
| `views.css:12766` | 注释里的「`follow.ts` / 第③阶段」 | 不是断言，但与上面 154-162 那条共用同一段注释 | 改：动这段时别把「高度由」三个字弄丢 |
| `desktop/shots/_verify-jitter.mjs:153`、`:188` | 每 60ms 读 `.chat` 的 scrollTop / scrollHeight / clientHeight 算余量 | 不撞 | 留：占位恒 0 时 `sh − ch` 不变，③ 的验收正是「余量不变」 |
| `desktop/shots/_verify-follow-debug.mjs:164-180` | 拦截 `scrollTop` 写入、把调用栈记下来给人看 | 不会红，但栈里的函数名会从 `follow.ts` 变 `viewport.ts`，读栈的人会误判「还有人在绕过 viewport 写」 | 改：文件头补一句「③ 起写入栈应指向 viewport.ts」 |
| `desktop/shots/_verify-follow-pill.mjs:160` | 逐个读 `.chat-inner > *` | 不撞（占位在 `.chat-inner` 外面，它也不数个数） | 留 |

##### 二、阶段 ④（S6 逐行收起）会撞到的

| 断言（探针:行 → 源码:行） | 现在钉的是什么 | ④ 之后 | 建议处置 |
| --- | --- | --- | --- |
| `scripts/ui-transcript-render-test.mjs:268` → `views.css:10813-10824` | `.turn-process` 的 `grid-template-rows: 1fr` 与 `[data-fold='closed']` 的 `0fr` | 必然失效 | 改：换成逐行 motion 的形态钉（`fold-motion.ts` 存在、每帧写 height/margin/opacity、按时间开合批次） |
| `scripts/ui-transcript-render-test.mjs:273` → `views.css:10816-10818` | 时长取 `--dsc-dur-slow`（写在 grid 的 transition 上） | 必然失效（那条 transition 整条退役） | 改：把「时长取令牌、不写死毫秒」这条改钉到 motion 的时长来源上，别顺手丢掉 |
| `scripts/ui-transcript-render-test.mjs:272` → `views.css:10834-10839` | `.turn-process-body` 的 opacity 过渡与收起态 `opacity: 0` | 必然失效（跟着 grid 一起退役） | 改：逐行 motion 自己写 opacity，断言改钉那里 |
| `scripts/ui-transcript-render-test.mjs:271` → `views.css:10821-10824` | 收起态用负 margin 抵掉「0 高盒子多算的那一格 gap」 | 可能失效：wrapper 保留（只退动画、不退元素）时这条还要留着；wrapper 一起退场才失效 | 改：跟 wrapper 的取舍一起定 |
| `scripts/ui-transcript-render-test.mjs:270` | 否定断言：收起态不许写 `display: none` | 不撞 | 留：④ 收尾靠的是 `.entry-row[hidden]` 的 `display:none`，不在这条选择器里，负向钉不会自己打脸 |
| `scripts/ui-transcript-render-test.mjs:269` → `views.css:10826-10831` | `.turn-process-body` 的 `min-height: 0` + `overflow: hidden` | 可能失效（同 271，看 wrapper 留不留） | 改：同上 |
| `scripts/ui-transcript-render-test.mjs:277` → `fold-seats.tsx:99-104`（配 `:51-56`） | 用 `setTimeout` 猜 180ms 再挂 `hidden` | 必然失效（`hidden` 改由 motion 末帧提交，这个定时器必须走） | 改：钉「末帧提交」——批次结束时那次调用里才 `setAttribute('hidden','until-found')`，提交前不许挂 |
| `scripts/ui-transcript-render-test.mjs:279` → `fold-seats.tsx:52` + `tokens.css:376` | `getPropertyValue('--dsc-dur-slow')` 与令牌 `--dsc-dur-slow: 180ms` 同源 | 必然失效（前半截消失，后半截要留） | 改：拆两条——令牌本身还在（留），「motion 的时长读这个令牌」（从 fold-seats 搬到 fold-motion） |
| `scripts/ui-transcript-render-test.mjs:280` → `fold-seats.tsx:291`、`:332` | `delayMs: foldHideDelayMs()` 出现**恰好两次** | 必然失效（两处参数都没了） | 删：它钉的「延迟只给 display:none 那一层」这个口径仍有效，但载体不存在了；口径改由「末帧提交只作用于 RowSeat 与 StepGroupSeat 外层、组体 max-height 那层不提交」承接 |
| `scripts/ui-transcript-render-test.mjs:281` → `fold-seats.tsx:337` | 组体那层不传 `delayMs`（内容留在文档里，本来就平滑） | 不撞 | 留，**列为禁改**：④ 明确不接组体，接了这条就红 |
| `scripts/ui-transcript-render-test.mjs:282` → `fold-seats.tsx:91`、`:110` | 焦点在子树里就 reveal；`beforematch` 放行 | 不撞 | 留，**并建议升格**：这是 ④ 之后唯一还在的「收起不抽走焦点 / Ctrl+F 能命中」的源码证据，真机那条（`_verify-think-collapse`）该加一条按 Ctrl+F 命中收起内容的断言 |
| `scripts/ui-transcript-render-test.mjs:253-256` → `render.tsx:248-249`（`flushSegment` 里那两层 div） | `.turn-process` + `.turn-process-body` 两层、带 `data-fold` | 可能失效（「分段器只留显隐集合」若把 wrapper 退掉，这两层就不存在） | 改：跟 wrapper 取舍一起定 |
| `scripts/ui-transcript-render-test.mjs:262` → `render.tsx:197`（`pushRow` 的 else 分支） | 不折的行走 `middle.push({ …, fold: false })` 原地摆 | 可能失效（middle 的形状若从 `{node, fold}` 改成 `{node, hidden}`，这行不匹配） | 改：钉「不折的行原地摆」这条行为，别钉字面量 |
| `scripts/ui-transcript-render-test.mjs:263` → `render.tsx:255-262`（`for (const block of middle)` 那段） | `segment.push` 攒段 + `flushSegment()` 之后接 `foldBlocks.push` | 可能失效（这正是 ④ 要重写的分段器） | 改：同 262 |
| `scripts/ui-transcript-render-test.mjs:287` → `views.css:10871` | `.step-body` 的 `transition: max-height` | 不撞 | 留：④ 不动组体这一级；④ 之后它是全仓唯一还剩的高度过渡，别顺手删 |
| `scripts/ui-transcript-render-test.mjs:291` | `views.css` 里还要出现 `dsh` 与 `zcode` | 不撞 | 留：`zcode` 另有 4 处（`:2953`、`:5627`、`:6142`、`:6686`），删掉 `.turn-process` 那段注释也不会红 |
| `scripts/ui-fold-combo-test.mjs:173` → `render.tsx:197`（`pushRow` 的 else 分支） | 同 262 号那行字面量 | 可能失效（同上） | 改：与 262 号同批改——两个探针钉同一行，改早了会双红 |
| `scripts/ui-fold-combo-test.mjs:174` → `render.tsx:255-262` | 同 263 号那两段 | 可能失效（同上） | 改：与 263 号同批改 |
| `scripts/ui-tool-row-flat-test.mjs:147` → `views.css:10826-10829` | `.turn-process-body` 的 gap 是 3px | 可能失效（同 271 / 269，看 wrapper） | 改：同上 |
| `scripts/ui-tool-row-flat-test.mjs:64` → `views.css` 的 `.tool-card` 规则 | `.tool-card` 里不许有 `overflow: hidden`（会把里面 sticky 的行头截断） | 可能失效：motion 给盒子做高度动画时通常要 `overflow: hidden`，写进 `.tool-card` 就必然红 | 改：动画盒子一律用座位那层（`RowSeat` 的 `.entry-row` 或专用类），别写进 `.tool-card` |
| `scripts/ui-process-grid-test.mjs:134` → `views.css` | 裸选择器 `.step-body {` 在 views.css 里只能出现一次 | 可能失效：④ 若给组体加一条裸 `.step-body {` 就红 | 改：新规则用 `.step-body[data-motion]` 这种带属性的选择器，绕开计数 |
| `desktop/shots/_verify-think-collapse.mjs:210`、`:240` → `render.tsx:248`（`data-fold`） | 轮询读 `.turn-process` 的 `data-fold`，用来找「第一次收起」那一帧 | 可能失效：wrapper 退场后 `querySelector('.turn-process')` 是 null，`fold` 一栏全 null、`firstClosed` 是 −1、`around` 是空数组——报告最关键那段直接没了 | 改：改读 `hidden` 属性（末帧）或 motion 批次的控制属性 |
| `desktop/shots/_verify-think-collapse.mjs:242-279` | **这个探针现在一条断言都没有**：只 `console.log` 报告然后 `process.exit(0)`，位置回退多少次都算通过 | ④ 的验收「位置回退 0 次」现在是空转 | 改：**开工第一件事**是加断言（回退次数为 0、末帧 `hidden` 已挂、末帧占位回 0），否则新探针写不写一个样 |
| `desktop/shots/_verify-level3.mjs:179-180` | 读 `.turn-process` 的 `data-fold` | 可能失效（读数变 null；不在门禁里，不会红） | 改：与 210 号同批改 |
| `desktop/shots/_probe-gap.mjs:164` | 读 `.turn-process-body` 找「段里装着什么」 | 可能失效（`segs` 变空数组，那段诊断没数据） | 改：wrapper 退场就改读段边界 |
| `desktop/shots/_verify-think-sticky.mjs:321`、`:328` | `.step-fold` 的 `data-open` | 不撞（阶段组组头自己的属性） | 留 |
| `desktop/shots/_verify-think-markdown.mjs:323`、`:330`；`_verify-bash-card.mjs:304`；`_verify-tool-row-flat.mjs:137` | 同上，都读 `.step-fold[data-open]` | 不撞 | 留 |
| `desktop/shots/_verify-selection-actions.mjs` | 全文只有 `:231` 的 `scrollIntoView({ block: 'center' })`，**不读** `data-fold`、`data-open`、`data-scroll-up/down`、`scrollTop` | 不撞 | 留：它根本不在撞车名单里（施工图的提示可以划掉） |
| `views.css:9013-9015` | `.entry-row[hidden] { display: none }` | 不撞，但 ④ 之后它是「末帧才挂 hidden」的落点，规则必须留着（删了 `until-found` 就不生效，UA 的 `display:none` 压不过 `.entry-row { display: flex }`） | 改：现在没有任何探针钉它，④ 顺手补一条 |
| `views.css:10937-10940` | `.step-body[hidden] { max-height: 0; overflow: hidden }`（组体那一层不走 motion） | 不撞 | 留，也补一条断言 |

**已查、但与 ③④ 无命中**（省得下一批再摸一遍）：`ui-row-memo`、`ui-node-slot`、`ui-compaction-row`、`ui-prompt-cards`、`ui-command-menu`、`ui-step-group-live`、`ui-collapse-prefs`、`ui-fold-prefs`、`ui-round-fold-tail`、`ui-thread-resizer`——它们读了 `views.css` / `render.tsx`，但钉的是别的区块（模型卡、命令提示、入口卡片、缩进栅格），③④ 不碰。

##### 待拍板：`foldHideDelayMs()` 还有没有别的调用方

**答：没有。** 全仓 grep（`src` / `scripts` / `desktop` 源码与探针），这个名字只出现在三处：

- 定义：`fold-seats.tsx:51`；
- 调用：`fold-seats.tsx:291`（`RowSeat`）、`fold-seats.tsx:332`（`StepGroupSeat` 外层），只有这两处；
- 探针：`ui-transcript-render-test.mjs:280` 用正则数它出现两次——**不 import、不执行**，只数字符串。

`useSearchableHidden` 的 `delayMs` 参数同样只有上面两处调用传了值；第三处 `fold-seats.tsx:337`（组体那层）根本不传。

三条路：

| 选项 | 做法 | 代价 |
| --- | --- | --- |
| **A 直接删（推荐）** | 函数与 `delayMs` 选项一起删，`useSearchableHidden` 收回成两参 | `ui-transcript-render-test.mjs` 的 `:277`、`:279`、`:280` 三条要改（它们本来就必然失效）；`--dsc-dur-slow` 不受影响，`views.css:10871` 的 `.step-body` 过渡还在用 |
| B 保留兜底 | 留着函数，没人调时挂在 `options.delayMs` 上 | ① 留下一段永远拿不到调用方的死代码，下一个人会以为「还有地方要猜时长」；② `:280` 那条「恰好两次」得改成「零次或两次」，一条有力度的形态钉变成含糊断言；③ 真正的坑：将来谁手滑又传 `delayMs`，`hidden` 会在动画中途提交——正是 ④ 要根除的症状 |
| C 改名留壳 | 保留同名函数、语义换成「返回一个在末帧执行的提交器」 | 名字带 Delay 却是提交器，名实不符；motion 侧本来就有自己的批次对象，多转一手没收益 |

推荐 A。它存在的唯一目的是「等一个猜出来的时长」，④ 之后这个时长由 motion 自己知道，不需要猜；一段玩具级兜底比没有更危险。

##### 决议清单

**③ 开工前必须先做掉的三件事（按优先级）**

1. 先给「批次活跃时 `.chat` 的 `overflow-anchor` 是 `none`、批次结束还原」写一条断言——现在全仓零覆盖，③ 改完没人守。
2. 按「测量归 viewport」重写 `ui-turn-spacer-test.mjs` 的 `[3]` 整段（`:135-148`）；顺序上等 `viewport.ts` 真的存在再改，别先删后补。
3. 把 `ui-interaction-base-test.mjs` 里按字面函数头取体的两处（`:482`、`:494`）和 `:507` 的写法改成签名变化也能命中的正则，否则 ③ 一动就假红。

**④ 开工前必须先做掉的三件事（按优先级）**

1. 先把 `_verify-think-collapse.mjs` 从「只打印」改成真断言——它现在恒 `exit 0`，验收等于空转。
2. 改掉 `ui-transcript-render-test.mjs` 的 `:268`、`:272`、`:273` 三条（grid 动画那三条必然失效的），换成逐行 motion 的形态钉，否则它们会挡住 ④ 的第一次提交。
3. 先拍定 `.turn-process` wrapper 留不留，再一次性处理 `:253-256`、`:269`、`:271`、`ui-fold-combo-test.mjs:174`、`ui-tool-row-flat-test.mjs:147` 这 5 条（留就全留、退就全改），别改一半。

##### 主控已拍板（2026-11-10，施工时照这个来）

1. **`foldHideDelayMs()` 按 A 路直接删**：连同 `useSearchableHidden` 的 `delayMs` 选项一起收掉，
   函数收回两参。理由不是「代码难看」，而是**它猜的那个时长在 ④ 之后由 motion 自己知道**；
   留一段玩具级兜底的真实代价是「将来谁手滑又传 `delayMs`，`hidden` 才会在动画中途提交」——
   正是 ④ 要根除的那个症状。`ui-transcript-render-test.mjs:277`/`:279`/`:280` 三条随批改。
2. **`.turn-process` 那个元素留着，只退役它的 grid 动画**：④ 把它从
   `grid-template-rows: 1fr → 0fr` 的裁剪盒子改成普通容器（`display: block`、不裁剪），
   但**元素本身与 `data-fold` 读数继续写**。这样 `_verify-level3.mjs:179-180` 与
   `_probe-gap.mjs:164` 这两处真机读数不作废（它们查的是「整轮收起来了没有」，与用哪种动画无关），
   而「整段一起缩」这个观感问题的根源是 grid 裁剪，不是这个 div 存不存在。
   连带的 5 条断言（`ui-transcript-render-test.mjs:253-256`/`:269`/`:271`、
   `ui-fold-combo-test.mjs:174`、`ui-tool-row-flat-test.mjs:147`）按「元素留、动画退」的形态同批改。
3. **③ 的 viewport 只管外层 `.chat`，不许把 `.step-body` 纳进去**：组体自己有一套限高滚动
   （`fold-seats.tsx` 的 `useProcessScroll`），两套 owner 抢同一件事就是抖的来源。
   `ui-interaction-base-test.mjs:532-538` 那 7 条钉着组体那一套，破了就是真破。
4. **④ 不许接组体那一层**：`fold-seats.tsx:337` 不传 `delayMs` 是对的（组体收起走 `max-height: 0`，
   内容留在文档里，不需要延迟），`ui-transcript-render-test.mjs:281` 钉着它。逐行动画只做
   外层 `.entry-row` 与整轮那一层。
5. **动画盒子用 `.entry-row`，不许给 `.tool-card` 写 `overflow: hidden`**：`ui-tool-row-flat-test.mjs:64`
   钉着「工具卡不许有 overflow hidden」，因为会截断卡里 sticky 的行头。这条不是琐碎规则，
   它决定 ④ 的 motion 该挂在哪个元素上。

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
| 整轮收起才复位内部行与组 | `ChatNodeSeat.tsx:122-131` 的 `disclosureReset` | 阶段组座位在整轮真藏它那一拍关组并抹组内行的存档（`fold-seats.tsx` 的 `StepGroupSeat`），不在组里的行由 `RowSeat` 抹自己的 |
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

### S2 整树重渲染，没有逐节点订阅（已对齐 2026-11-11：座位注册表 + 逐行订阅）

> **已对齐（2026-11-11，四阶段施工图的第②段，提交 `f8b3180`）**。做了三件事：
>
> 1. 新增 `ui/seat-store.ts`：按 `keyOf(row, sessionKey)` 索引（与 React `key` 同一个字符串），
>    **内容等价就复用上一帧那个 `Row` 对象**（`entry` 引用相同、或手写递归深度相等），
>    提交时**只对「格子换过对象」的键喊一声**。
> 2. 座位拆成两半：`SeatFrame`（memo，props 全是稳定标量：座位键 / 藏不藏 / 轮序号 / 稳定回调 /
>    注册表 / 槽渲染函数）+ `RowSlot`（自己用 `useSyncExternalStore` 订阅自己那一格）。
>    行体 `RowBody` 于是回到普通函数——**`rowBodyUnchanged` 那个止血比较器退役**。
> 3. `reveal` 提成 `useCallback`、`onFork` 改成吃**轮号**再按轮号 `useMemo`：这两个回调原来每帧
>    现造，会让整屏的壳 memo 全部失效——登记表做得再对，回调一换引用就白做。
>
> 实测（`_perf-stream.mjs`，60 轮 / 128 行 / 19 秒，同机）：
>
> | 指标 | 改前 | 改后 |
> | --- | --- | --- |
> | 一帧里真正重跑的行体 | 平均 3.51 / 最坏单帧 **115** | 平均 **2.31** / 最坏 **6** |
> | 总执行次数 | 596 | 380（−36%） |
> | 全量锚帧触发重画 | 115 行 | **0 行** |
> | ScriptDuration | 469 ms | 450~457 ms（−4%，单次采样 ±3%） |
>
> 那个 115 是「宿主每 50 帧发一次全量锚帧」造成的：内容一字不差但对象全新建，止血比较器
> 当场集体失效。现在深度相等就复用旧对象，整屏重画那一拍没了。
>
> **没做到的那条**：`ScriptDuration < 447ms` 不成立，原因不在会话区（见文末「性能线索」：
> 4 秒 profile 里主线 idle 3684ms，会话区组件整段 19 秒只有 15–20ms）。
>
> **两条探针的分工，别读错**：`_verify-row-isolation` 守的是**用户可见的不变量**（行被碰 /
> 被重挂 / 内容被换都会红），它**证明不了**「少重渲染了」——把判等改成恒 `false` 它照样绿，
> 因为 React 对内容没变的输出根本不写 DOM。真正守住「少重渲染」的是单测
> `ui-row-isolation-test`（75 条，直接 import 注册表演算复用与通知）。

> **止血阶段（2026-11-10，历史记录）**：给 `RowBody` 包了一层**带比较器**的 `memo`
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

### S4 工具卡只有一张通用卡（部分对齐：命令类 + 读文件 / 检索 / 待办 / 网页 / 图片共六张已换专用卡）

> **第一批（2026-11-10）**：`bash` / `shell` / `pwsh` 三种名字（且参数里真有 `command` 字段）
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
>
> **第二批（2026-11-11，`3339fb3`）**：`read` / `glob`+`grep` / `todo_write` 三张卡落地——
> read 头行给行区间（结果里真实行号优先，参数兜底；单行写「第 N 行」，只有起点写「第 N 行起」），
> 展开是行号 + 原文两列；检索头行给「N 处 · M 个文件」、展开按文件分组列命中（路径可点），
> **没有命中单独画**而不是空卡；待办头行给「d/n 完成」+ 进行中那条，展开是四态勾选清单
> （只读，数据面没改）。判据与实现在 `tool-card/read-model.ts` + `read-view.tsx`、
> `search-model.ts` + `search-view.tsx`、`todo-model.ts` + `todo-view.tsx`，装配在
> `factory.tsx:282-299`（三张卡都要求「名字 + 参数字段 + `variant === 'chat'`」三条），
> 可点路径的外壳抽到 `path-button.tsx`。
> 验收：`scripts/ui-tool-views-test.mjs` 187 项、`desktop/shots/_verify-tool-views.mjs` 49 项真机
> （三条调用一次跑完；路径可点、行号 3–7、检索 2 文件 3 处、待办 1/3；组收起时三张卡不可见、
> 重新展开可见；**切到轨迹页后三张卡一个都不出现**、原始参数 JSON 与结果原文都在；悬停头行时
> 「在轨迹中查看」药丸亮、三枚读数淡出）。截图 `_tool-views.png` / `_tool-views-todo.png`。
>
> **第三批（2026-11-12）**：`web`（`web_search` / `webfetch`）与 `read_image` 两张卡落地。
>
> - **web 卡**：头行一枚读数（`3 条结果` / `HTTP 200`），展开体是来源清单——可点标题 + 两行摘要 +
>   截断说明；`http(s)` 之外（空串、`javascript:`）**不画成链接**（口径同 `markdown.tsx:561-570`）。
>   **数据面这一次动了**（也就是上一版说的「要改数据面」）：`packages/web-search/index.ts` 现在
>   返回 `{ text, presentation }`，卡片数据按 dsh 的 `web` 卡词汇放进 `presentation.result`
>   （`card: 'web'` + `sources[]` + `truncated`）。为什么不是界面去反解那段文本：摘要自己会换行、
>   也可能以 `2. ` 开头，文本分不清哪一行是新结果。落盘与重放走的是**早就存在的一条链**
>   （`core/session.ts:990-1000` 写进 tool 记录 → `session.presentations` → `adapter` 的
>   `tool/presentation` 分支），由 `scripts/ui-dsh-card-replay-test.mjs` 钉着；老会话没有卡片数据时
>   才回头严格解析宿主那段文本（`web-model.ts` 的 `webTextResultOf`，认不出就摊原文，不留空壳）。
>   判据与实现在 `tool-card/web-model.ts` + `web-view.tsx`，装配在 `factory.tsx`（判据是
>   「名字 + 参数字段」**或**「卡片数据按 `card: 'web'`」+ `variant === 'chat'`）。
>   **文本兜底要处理「界面侧文本被截断」**（评审揪出来的）：`adapter/transcript.ts:49` 的
>   `RESULT_TEXT_LIMIT = 1500` 会把结果截到 1500 字再补一个省略号，切点可能落在编号块的任何
>   位置。现在的判法是「长度正好 1501 且以省略号收尾」才算被截，命中时**丢掉末尾那个不完整的
>   块、留在前面已收好的来源，并把 `truncated` 置真**——半截 `https://a.exa…` 绝不画成可点
>   链接。卡片数据里的每个外部字段都过了一遍 `core/secrets.ts` 的 `redact`：这个槽不经过工具
>   结果那条观察者链，却同样落进会话日志。
> - **read_image 卡**：头行 `PNG · 6.2 KB` + 与 read 同一枚可点路径（`fileTargetOf` 的白名单加了
>   这个名字，预览页签本来就画得了图），展开体是**这张图本身** + `64×48`。
>   **上一版说「要改数据面（ToolCallView 缺附件列表）」——查完发现不必改**：`read_image` 的参数里
>   永远有路径，而 `dock` 的 `fs-read`（`packages/desktop-dock/index.ts:467-489`，图片 ≤5MB）
>   本来就把图片按 base64 交给界面（markdown 的贴图、预览页签、pdf 视图走的都是它）。卡片展开时
>   现读一次，比把 8MB 的 base64 塞进每次会话快照划算得多（`image-tool.ts:30-31` 那条 6MB 红线
>   正是按 base64 膨胀定的）。代价写在卡片文件头：盘上那张图后来被删/改了，卡里看到的就是「读不到」。
>   判据与实现在 `tool-card/read-image-model.ts` + `read-image-view.tsx`。
> - 验收：`scripts/ui-tool-web-test.mjs` 127 项（模型与 `wrapUntrusted` 都是真代码，含三种截断
>   落法与「摘要自己以省略号结尾」的反面对照）、
>   `scripts/ui-tool-read-image-test.mjs` 48 项（回执 → 四种状态的判法也跑真代码）、
>   `desktop/shots/_verify-web-image-cards.mjs` 38 项真机
>   （web 卡走**重放**——真搜索要 API key 与外网；图片卡走**真跑**，假模型喊 `read_image`，宿主真读盘，
>   断言 `<img>` 的 `naturalWidth=64`、屏幕上有高度、点图开预览页签、两张卡标记不串、
>   轨迹页两张都不出现且原文都在）。截图 `_web-image-cards.png` / `_web-image-cards-image.png`。
>
> **仍欠的四张，逐条给理由**（不是「没来得及」，是「现在做会做出一张假卡」）：
> - `file-mutation`：本仓已有等价形态（write/edit 的「将做的改动 / 这次改动」diff 块 + 可点路径），
>   再画一张是重复；
> - `details`：参考实现那张是「一次调用的明细折叠面板」，本仓展开体已是输入字段表 + 输出首行 +
>   「展开更多」，等价；
> - `ask-question`：本仓问答有独立卡片（在 `ui-ask`），不走工具卡；
> - `read-family`：它本身只是「read 与 read_image 共用的一段组装函数」，不是新视图。
>
> （`web` 与 `read-image` 已由第三批做掉：前者动了数据面，后者查完**不必**动数据面——
> 上一版那条「`ToolCallView` 缺附件列表所以只能画空框」的判断是错的，见上。）

- **现象**：`bash` 在 dsh 是一块终端（黑底、退出码徽章），本仓是「执行了命令 · 摘要」。
- **不成立的那半句**：`read` 在 dsh 里是「可点文件路径 + 行号」，本仓**当时已经是**可点路径了
  （`tool-card/factory.tsx` 一直在画可点的文件路径）——只差行号与折叠形态，2026-11-11 补齐（见上）。
- **dsh**：11 个视图——`read-family-row`、`read-row`、`search-row`、`web-row`、
  `file-mutation-row`、`bash-sample`、`todo-row`、`details-row`、`ask-question-row`、
  `read-image-row`、`GenericToolCard`（`packages/client/ui-tool/src/client/tool/toolviews/`，
  原文漏了 `read-row.tsx`，这里补上）。
- **本仓**：通用卡是 `ToolCardView`（`tool-card/factory.tsx`）+ 工具名匹配表 + 参数表
  `toolArgFields` + diff + 结果尾巴；上面六张专用卡在它前面拦一道。
- **代价**：第一批 bash 是「中」，第二批三张也是「中」，第三批两张还是「中」（web 多一处数据面
  改动：一个插件多返回一个字段；read-image 一处没改）。剩下四张是重复或已有等价形态——
  所以不是排期问题，是值不值得再养一套画法的问题。
- **验收**：每张卡一条隔离截图 + 一条断言；与 dsh 对应截图并排放 `docs/` 里。

### S5 滚动是「CSS + 钉底」，dsh 是「视口协调器」（已对齐 2026-11-11：一个 owner）

> **已对齐（2026-11-11，四阶段施工图的第③段，提交 `2801529`）**：新增 `ui/viewport.ts`，把
> 「测尺寸 / 写 `scrollTop` / 写底部占位 / 开关 `overflow-anchor`」收成**唯一 owner**；
> `follow.ts` 只剩策略（该不该贴底、手势、只认自己的写），全文件 **0 处** `scrollTop` 赋值、
> **0 处** `getBoundingClientRect`。两种落点在批次开始时定死：跟随态落到 floor、读历史态保住
> 第一条可见行的屏幕位置。每帧顺序写进 owner 的模块头：先让盒子动 → 再让行落地
> （MutationObserver 微任务 / ResizeObserver 布局后 / rAF 保险丝）→ 最后测锚点、写滚动、写占位。
>
> 真机读数（`_verify-fold-scroll`，22 条）：展开 / 收起时第一条可见行屏幕 top 最大漂移
> **0.46px / 0.50px**（限 1px），`scrollTop` 实际补位 334px（折叠段 0→331.2px），批次期间
> `overflow-anchor` 的内联值与计算值都是 `none`、结束清成空串落回样式表，末帧占位回 0；
> 贴底态离 floor 最大 0.33px。
>
> **一个刻意的选择**：样式表的常态口径就是 `overflow-anchor: none`，所以批次结束后**计算值**
> 仍是 `none`。让浏览器也来锚定就是第二个 owner，正好回到要消灭的病——不改。
>
> 这一条以前 `overflow-anchor` **全仓零覆盖**，这一批补了断言（`ui-turn-spacer-test` 的 `[5]`）。

- **已经补掉的**（2026-11-10 之前陆续落地）：藏起来的行不写缓存、手势 1500ms TTL、
  `pointerdown` 即停跟随、用 `useLayoutEffect` 而不是 `useEffect` 上钉底。
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

### S11 没有「底部占位」，折叠时靠外边距兜（已对齐：占位元素在、owner 在，高度仍恒 0）

> **已对齐（第①段 `ef33fcd` 备元素，第③段 `2801529` 立 owner）**：`.chat` 里、`.chat-inner`
> **之后**放了一个 `[data-chat-turn-spacer]`，默认 `height: 0`、`flex: 0 0 auto`，内联高度只由
> `viewport.ts` 写；`floor()` = `scrollHeight − 占位 − clientHeight`。
> 现在它**恒 0**：逐行动画（第④段）跑完之后位置由批次逐帧补偿，不需要「先加 room」那一步。
> 留着它是因为贴底口径从此不必再改——占位真长出来时，贴底比的是内容底而不是占位那片空白。
> 放在 `.chat-inner` 外面是刻意的：放里面会多吃一格 `--dsc-turn-gap`，而且 `follow` 观察的
> `scroller.firstElementChild` 正是 `.chat-inner`，占位在里面会让「占位改高度」被当成内容增长、
> 被自己的 `onResize` 抵消掉。

- **现象**：过程区收起 / 展开那一拍，末尾内容会跳一下；贴底时尤其明显。
- **dsh**：底部有一个 `data-chat-turn-spacer` 占位元素承担高度变化（`use-chat-viewport.ts`），
  配合逐帧 `scrollTop` 同步，所以视觉上「收起来的那段高度被占位吃掉了」。
- **本仓**：用 `views.css:1346-1366` 的贴底外边距近似，没有真正的占位元素。
- **代价**：小到中（一个占位元素 + 跟随它的高度计算），但它与 S5 的逐帧同步是同一套机制，
  所以两条要一起做，别单拆。
- **验收**：与 S5 同一条探针。

---

## P3：实现方式不同，暂不影响使用

### S6 整轮收起动画是「整段一起缩」（已对齐 2026-11-11：逐行落下 + 末帧提交 hidden）

> **已对齐（2026-11-11，四阶段施工图的第④段，提交 `cf13db9`）**：新增 `ui/fold-motion.ts`，
> 每行预量 `offsetHeight` + `marginTop` 后归零（同一个批次时钟，**没有 stagger**——参考实现也是
> 全批共用进度，要复刻的是「每行自己的盒子」这个形状，不是错开）。
> `.turn-process` 的 `grid-template-rows` / `overflow: hidden` / `min-height: 0` 全部撤掉，
> 元素与 `data-fold` 读数保留（`_verify-level3` 与 `_probe-gap` 还在读它）。
> `hidden="until-found"` 的提交权归**被隐藏的那个元素自己**：它把自己的 `commit` 交给这一轮的
> 动画，动画在末帧调它；三个入口（`transitionend` 且属性是 `height` / 批次末帧 / 「总时长 +
> 余量 + 保险」的超时兜底）落到同一个 `finish()`。第一次见到的元素——也就是刚重挂上来的——
> 不进动画，当场同步提交：切会话时行按「会话 + 行身份」整批重挂，靠的就是这一条，否则收起轮
> 的过程行会在新 DOM 上一条 `hidden` 都没有，整段露在屏幕上而开关行还写着已收起。
> `fold-seats.tsx` 里那个「猜一个时长再 `setTimeout`」的 `foldHideDelayMs()` 也因此删掉
> （`delayMs` 选项一起收）。
> 时长从 `--dsc-dur-slow` 的**计算值**读（运行时 200ms，不是 `tokens.css` 写的 180ms），
> 按 70/160、50/160 切段：淡出 44%、高度延迟 31%、高度 69%。
>
> 真机读数（一次真实收起，段满高 228px）：t=58ms 透明度 0.01 而高度仍是 228px → t=69ms 开始
> 收高 → t=185ms 高度 0 → t=213ms 挂 `hidden`。**先淡出、收高时屏幕上已经没有字**，
> 所以不存在「文字被切在中间」。
>
> 验收：`_verify-think-collapse` **18 条真断言**（这条探针以前一条断言都没有、恒 `exit 0`，
> 这一批先把它改真、在旧 grid 代码上跑绿，再在新代码上跑绿）；`_verify-jitter` 8 条（同样从
> 空转修活）；`_verify-collapse-remount` **29 条**（P1 切会话后每轮 `hidden` 数与基线一致、
> 开关行仍收起；P2 整轮真收起后组关着；P3 焦点在组里时整轮被放行、组不关；P4 收起动画
> 跑到一半焦点才进来时末帧不藏、焦点不掉；P5 行级存档在整轮真藏那一拍被抹掉，切走再切回
> 后回到默认收起态；P6 同批多层时焦点落在靠后那层，靠前的组不许被关——2026-11-12 补。
> 2026-11-12 又加了 P7 / P8 各三条，现在是 **35 条**，见本节末尾「放行与复位的两处修正」）。
>
> **P6 与批次级判定（2026-11-12）**：「提交还是放行」的判定原来是**逐元素**的，同批兄弟层
> 于是有顺序依赖——一轮里同时有多层可藏（两个阶段组 + `model-retry` 这类组外独立行）时，
> 文档顺序靠前那层的 `transitionend` 先到就当场提交 `hidden`、`StepGroupSeat` 的
> `turnHidden` 把这一层的组关掉并写进手动存档 false；紧接着靠后那层被焦点放行，整轮翻成
> 展开。结果「整轮展开、组却收起着」，切走再切回也回不来。现在元素收完只记账（`Run.settled`），
> 整批收工时统一判一次：任何一层带焦点 → 整批一个 `hidden` 都不挂，只调那一层的 `reveal()`；
> 一层都不带 → 整批统一 `commit()`。超时兜底走同一个 `finish()`，同一份判定。
> `scripts/ui-transcript-render-test.mjs`（169 条）里原来钉「settle 里逐元素提交」「item.commit()
> 恰好三处」的两条断言，随之改成钉「收完只记账」与「批次判定骨架」（提交动作现在是两处：
> `finish` 的无焦点分支 + 降级分支）；`hiddenOrCollapsing` 那条额外钉住「记账到收工之间也算
> 在藏」。三条钉子都用内存变异验过会红。
> 红/绿读数：修之前 `_verify-collapse-remount` 27 / 2，两条红是「P6：靠前那一层的组没有被
> 关掉」（实测 `fold=open, turnOpen=1, firstGroupOpen=null, bodyHidden=true, bodyHeight=0`）
> 与「切走再切回之后靠前那一组仍然展开」（实测仍 `firstGroupOpen=null`、`bodyHidden=true`）；
> 修之后 29 / 0。
>
> 负对照三个，都是真跑出来的红：把「第一次见到就同步提交」那一支拆掉，`_verify-collapse-remount`
> 报 10 / 4（第 1 轮 `hidden 2/3`、第 2 轮 `0/3`）；把逐行动画改回「立刻挂 `hidden`」，
> `_verify-think-collapse` 报「收起中行自己在变矮 0 帧」；把「末帧焦点复检」与「行存档复位」
> 两处拆掉，同一条探针报 20 / 4——P4 三条（那一层挂上 `hidden`、`activeElement` 掉回 `BODY`、
> 整轮停成收起）与「行级复位」一条（切回来 `aria-expanded` 仍是 `true`）。
>
> 整轮**真的**挂上 `hidden` 那一拍，里层才复位：阶段组把自己关掉，组内行与不在组里的行
> 各自把展开存档抹掉（`StepGroupSeat` / `RowSeat` 的 `onHidden`）。判据是「已经挂上
> `hidden`」，不是「应该收起」，也不是「排上了收起队列」：焦点在某一层里、那一层被放行时
> 根本没有 `hidden`；另一层被放行、整轮最后其实展开时，这一层也还没到提交那一刻——两种
> 情况下组都不会被关掉。
>
> **放行与复位的两处修正（2026-11-12，P7 / P8）**
>
> ① **复位代次：不重挂也复位**。整轮被真藏那一拍，行座位抹的是**存档**（`fold-state`），
> 同一次挂载里的行自己还开着——收起整轮再展开，那条思考行照样摊在屏幕上，只有切走再切回
> （重挂）才回默认态。参考实现的展开态带一个「复位代次」（`use-disclosure.ts:11-21` 的
> `expanded = expandedVersion === version`），座位被真藏那一拍推进代次，**已挂载的**那一条
> 当场收起。现在每个座位实例持有一份代次（`fold-hook.ts` 的 `createFoldReset`）：
> `RowSeat` 自己一份（组外的行），`StepGroupSeat` 一份给组内成员行（它们的 `.entry-row`
> 自己不会被挂 `hidden`，藏的是组座位）；行用 `useSyncExternalStore` 订阅
> （`FoldResetContext`），所以代次推进只惊动订阅了它的那几行，不是整屏——context 里放一个
> 每次变化的新对象会把 memo 过的行全部重渲染。复位读 `foldStateOf`（抹过存档之后的默认态，
> 等价于「重挂之后会读到什么」），这条路上**不写**任何手动存档。
>
> ② **放行不写手动存档**。焦点保护放行原来走 `reveal()` → `foldMemory.set(turnKey, true)`，
> 等于把这一轮钉成「手动展开」：键盘用户 Tab 一次，`collapseTiming` 的兜底就失效，
> 切走再切回也还是开着。现在放行只记在 `SeatBody` 的一份内存态里（键是「哪一条会话的哪一轮」，
> 不落盘），用户点击开关才写存档（`toggleTurn` 会先清掉这份放行）；整轮开关行上留了两个
> 读数：`data-turn-manual`（存档里明写着展开）、`data-turn-rescue`（这一轮此刻靠放行摊着）。
> 阶段组被整轮真藏那一拍也改成**清存档**（`onTurnClosed` → `foldMemory.clear`），不再写
> 「手动收起」——自动收起不是用户的选择。
>
> 真机读数：`_verify-collapse-remount` **35 条**（原来 29 条，加 P7 三条、P8 三条）。
> 修之前：P7 两条红（不切会话再展开后 `aria-expanded` 仍是 `true`、点开组后展开区仍在，
> `bodyPresent: true`），P8 那条旧断言也红（切走再切回仍是 `turnOpen: "1"`）；换成最终断言
> 之后单独跑过一次负对照——只把 `reveal` 改回 `foldMemory.set(turnKey, true)`，P8 两条当场红
> （`manual: "1"`、`rescue: null`），其余 33 条绿。修之后 35 / 0。
> `scripts/ui-transcript-render-test.mjs`（169 条）里钉 `fold-motion` 形状的两处（`item.commit()`
> 恰好两处、`settle` 不提交）与反例照旧全绿：这次没动 `fold-motion.ts`。
>
> ~~**已知的结构性限制**：定稿轮一律分组，而一轮只有一个阶段组，所以真机上「段里多行同时各缩」
> 的形态造不出来……~~（2026-11-12 撤销这条判断）：一段里本来就可能有多层——阶段组 + 夹在
> 中间的 `model-retry` 独立行 + 后一个阶段组。`_verify-collapse-remount` 的种子（每轮两次
> 工具调用、中间夹一条重试提示）就是这种形态，量到的是 3 个 `.turn-process-body` 直接子元素
> 同时各缩。P6 用的正是它。

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

### S8 缺几类特殊节点卡片（已对齐 2026-11-11：数据面 + 两张卡）

> **已对齐（2026-11-11，两次提交）**。这一条当初的判断是「真正缺的是数据源」，于是先补数据面
> 再补界面：
>
> 1. **数据面**（`14ac148`）：契约加 `system-prompt` / `context-injection` 两类条目（只带读数与
>    摘要，**不带正文**——一份系统提示 15–25KB，条目不携带）；核心加 `prompt/used` 与
>    `context/injected` 两个事件；会话 state 加两条记录，**每条都带位置锚 `after`**
>    （写在几条消息之后）。没有这个锚，实时条目落在轮中、重放落在轮首，全字段比对必不相等,
>    后果是每次打开会话都整表重建、展开态与直播尾全丢。
> 2. **界面**（`178a468`）：两张可展开的卡。⚙ 系统提示收起一行「字数 · 段数 · 模型」，展开是
>    段清单（段 id / 来源 / 字数，按声明刻度排序）+ hash 前 8 位；⊕ 上下文注入收起是「按类合计
>    的字数，超三类收进 +N」，展开逐条给来源 / 注入位置 / 字数 / 前 200 字预览。
>
> 顺带修掉三处会静默坏掉的落位：`rounds.ts` 原来只放过 `system`，开场第一条注入卡会被当成
> 「这一轮已经答完」（answered 置真、endIndex 推到它，整轮折叠与轮尾用时全判错）；
> `round-fold.tsx` 的 `TURN_INDEPENDENT` 不补两类的话，落在过程区里的卡会跟着整轮被藏掉；
> `ui.tsx` 的空会话欢迎态原来只认 `system`，新会话第一件事就是发请求，一落卡就把欢迎态顶掉。
>
> 验收：`transcript-metadata-test`（含「实时与重放全字段一致」）、`ui-prompt-cards-test` 156 条、
> `_verify-prompt-cards` 真机通过（9 段按刻度排序、hash 前 8 位、+1 分支）。
> **仍欠**：压缩落点（`CompactionItem`）已经是卡片（`ae2d3c3`）；命令类节点仍统一画成
> `.entry-system-command`，没有按 dsh 分出 `ApprovalCommand` / `GenericCommandCard`——差别在
> 信息密度，不在功能。

- **dsh**：`SystemPromptRow`、`ContextInjectionRow`、`CompactionItem`、`CommandNodeView`、
  `ApprovalCommand`、`GenericCommandCard` 各一张卡。
- **本仓**：system / 压缩标记 / 命令输出统一画成 `.entry-system` 或 `.entry-system-command`。
- **真正缺的是数据源（2026-11-10 核实）**：条目类型表 `src/contract/transcript.ts:139-242`
  里**根本没有** context 注入、系统提示、压缩这几类节点——照 dsh 补卡也没有内容可画。
  所以这条要拆成两件事：先决定「这几类信息本仓要不要进会话流」（数据侧），再谈卡片。
- **代价**：小到中（卡片本身小），难点在数据侧要不要加节点类型；差别在信息密度，不在功能。

### S9 选中文字后的浮层：动作已改走槽（已对齐 2026-11-10，多颗定位也做完了）

> **已对齐（2026-11-10）**：浮层动作从写死一颗改成一条 `list` 槽 `ask.selection.action`
> （`owner: { text, close }`），内置那颗「问 AI」也登记到链上（`id: ask.selection.builtin`，
> priority 100 兜底位），于是动作次序一律由槽的 `order` 决定，插件能排到它前面或后面。
> 定位从按钮挪到容器 `.ask-sel-actions` 上（多颗时排一行）；`mousedown` 守卫也跟着改到容器，
> 否则插件那颗按钮在 click 之前就被摘掉了。
> 验收：`scripts/ui-ask-selection-slot-test.mjs` 32 条、`ui-side-ask-test` 66 条、
> `desktop/shots/_verify-selection-actions.mjs` 真机通过（真实选区 → 浮层从槽里渲染出 1 颗
> 「问 AI」）。截图 `desktop/shots/_selection-actions.png`。
> **多颗动作的右边界夹取也做完了（2026-11-10 补记，`6751ea8`）**：上面那句「仍欠」是写在这
> 一条修完之前的，已过时。`select.ts:76-92` 的 `anchorOf` 现在收第三参 `measured`，按**实量**
> 宽度夹 `[8, innerWidth − width − 8]`，`BUBBLE_W=92` 只剩「浮层还没上屏」那一帧的兜底；
> `ui.tsx:313-315` 用 `useLayoutEffect` 在绘制前量一次（用户看不到中间帧），`:318-328` 再挂
> `ResizeObserver` 管「插件异步往槽里加动作、整排变宽」的情况。`ui-ask-selection-slot-test.mjs`
> 的 `[6]` 段（`:193-227`）有 8 条钉着这件事，其中一条是「`anchorOf` 函数体里已不出现 `BUBBLE_W`」。

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

### 性能线索：会话区已经不是瓶颈了（2026-11-11，S2 收工时的 CPU profile）

60 轮 / 128 行 / 19.8 秒流式，`_perf-stream.mjs` 读数 `taskMs 1830 / scriptMs 457 / 帧 p50 6.1`。
中段取 4 秒 CPU profile：**主线程 idle 3684/4000ms**，非 idle 里最大的三项是
`measure` 31.9ms、`getClientRects` 23ms、`hidden` 16.2ms，**全挂在轨迹页那个 bundle 的 URL 下**
（不是 `transcript/client.js`）；会话区自己的组件（SeatBody / 组头 / 组行 / 构建座位 / 折叠钩子
/ 刻度条）整段 19 秒合计约 15–20ms。

结论有两条，都还没做：

1. **产能已经拿到顶**：座位注册表落地后一帧只重画 2 个左右的真变了行，最坏帧从 115 行降到 6 行，
   ScriptDuration 卡在 450–460ms 不再动。会话区再 memo 一层的收益是零头，别再加了。
2. **那 70ms 到底是谁，还没定论**——而且我先前那条「藏起来的页签在量布局」的猜测**已被查证否定**：
   `ui-layout/ui/app.tsx:613` 是条件渲染（`threadView === 'trace' ? <SlotOutlet …/> : <div className="chat">…`），
   切走就**卸载**，不是 `display:none` 藏着；流式期间轨迹页根本不在 DOM 里。profile 按 bundle 归因
   会把共享 chunk 算进某个包里，我是被那个误导了。
   现有候选（未证实）是对话页自己的两处「量内容高度」：`ui-transcript/ui/rows/think-row.tsx:146` 与
   `ui-transcript/ui/tool-card/factory.tsx:384`，两处都是 `ResizeObserver` + `expandedContentHeight(body)`，
   而流式时思考正文与工具卡展开体每帧都在长，回调就会每帧触发。
   **要定论得重跑 `_perf-stream` 并按源码映射看调用栈**（不是看 bundle 名），再决定是加「高度变化
   小于 1px 就不 set」还是把这两处合成一个 observer。
   顺带还值得查的一条：**快照广播是否让二十多个插件每帧都重渲染**。这两条都不属于会话区对齐范围，
   但都直接反映在用户感知的流畅度上，记在这里免得丢。

### 重复调用提醒（2026-11-11 已落地，`b3c995f`）

上面第 1 条查清之后定的方向：**不学「步数上限」，学 dsh 的守卫**。理由是那个上限会斩断正常的长活
（这一轮改渲染管线自己就跑了三十多步），而 dsh 的哲学是「不斩断，只在模型明显原地打转时提醒它」。

dsh 的参照实现：`packages/guard/repeat-tool-reminder`（`src/index.ts`）——按
「连续重复的同一工具 + **完全相同的规范化参数**」判断（不是按工具名），默认阈值 `[3, 5, 8]`，
到第一档注入温和提醒、到后两档注入详细提醒（工具名 + 连续次数 + 参数前 500 字，`argumentsPreviewChars`
可配）。**建议性，不否决、不改写调用**，只是把话塞进模型的上下文。同目录还有 `timeout-policy`
管超时，也不管步数。本仓目前这两层都没有（grep 全仓无「重复调用检测」）。

要做的三件事：
1. 一个纯函数检测器（连续同一工具 + 相同参数 → 计数；换一次调用就清零），阈值可配，可单测真值表；
2. 到阈值时往请求里追加一条 `user-tail` 注入，并落一条 `context/injected`（复用 S8 那套数据面），
   轨迹页与卡片能看见「刚才提醒过它」；
3. 探针：假端点固定回同一个 `tool_call`（正好是我们的复现现场），断言第 3/5/8 次出现提醒、
   换参数后计数清零、以及**调用没有被否决**。这条探针同时也把下一节第 1 条的现象钉住。

**做完了（`b3c995f`）**，落点与结果：

- 纯函数在 `src/core/repeat-reminder.ts`（`normalizeToolArguments` 递归按键名排序、数组保序；
  判定永远用完整串，500 字预览只影响文案）；投影注册在 `src/packages/agent/index.ts:197-233`
  （`order: 850`，夹在 todo-reminder 800 与 drop-images 900 之间）。**`loop.ts` 一行没改。**
  - 一个不显然但关键的细节：数次数用的是**会话日志那份 messages**，不是组装后那份——
    env-facts 与 todo-reminder 已经往尾巴补过 user 消息，拿组装那份数会每步清零、永远到不了阈值。
- 提醒落在**第 3/5/8 次调用之后组装的那次请求**（即第 4/6/9 次请求），因为投影只能看见已经
  落进历史的调用。要「第 3 次请求本身就带」得在工具执行前判断，那就要改循环——不做。
- 验收：单测 72 条真值表；真机 61 条（假端点固定回同一个 `tool_call` 跑 16 跳，第 4/6/9/16 次各 1 条、
  其余 12 次 0 条；14 次调用 14 条结果且一条没被拒；日志 4 条带 `repeat-reminder` 的
  `context-injected`；换参数清零、再连续 3 次又提醒）。负向实测：档位恒 0 → 单测 47/72、真机 39/60；
  恒 1 → 45/72、34/60。
- 已知没做：阈值与预览上限只在纯函数入参上可配（做成插件中心可调要再加功能包与设置分区）；
  界面收起行只列前三类，所以这一类在收起行里折成 `+1`。
- **顺带记一个观感问题**（看图才发现的，分两步修完）。一次 16 步的回合会落下 8 张几乎一样的
  「上下文注入」卡（每跳请求一份）：  1. `c0d5a7e` 先改**记账口径**：落盘去重原来只跟上一条比，而实际序列是 A、A+提醒、A、A+提醒，
     A 被 B 隔开于是去重全部失效。改成「跟**这一轮里**同 parts 的卡比」，8 张降到 6 张。
  2. `897c285` 再改**上报口径**（这一步才真正对齐参考实现）：投影只在**内容变化时**上报。
     参考实现的 `RuntimeContextProjection`（`packages/core/agent-loop/src/runtime-context.ts:118`）
     里就一句 `if (this.retained?.text === snapshot) return`——没变连事件都不产生；我们只在记账层照抄，
     **注入行为没动**（本仓注入不落历史，跳过注入就等于那一跳模型没看到环境）。
     结果：16 跳两轮只落 5 张卡、日志 5 条记录，**重开后逐字一致**。
- **为什么「重开等于实时」以前是躲着的**：日志的落位记录跨轮去重（16 跳只落 8 条），按它重放时
  第一轮的次数是 4（实时 7）、第二轮那张卡根本不存在——重放 5 张 vs 实时 6 张。
  上报改成「只记变化」之后，日志里每条记录 = 一次真实的内容变化，重放按记录重建，
  天然与实时一致（真机 72 条断言里有一条专门逐字段比两边，负向实测去掉闸就红）。
- **两个闸必须是两张表**：`envSent` 记「这一跳还要不要注入」，`InjectionReportLedger` 记
  「这一跳还要不要长卡」。`envRefreshMs > 0` 时注入会被跳过，台账绝不能跟着推进——
  否则下一跳会把一份从没上报过的正文当成「报过了」，卡上永远缺一段。
- **还剩一处措辞问题**（已在 `aaa4334` 补）：一张只有「重复调用提醒」的卡，字面上像「这一跳只注入了
  提醒」，其实环境照常注入了、只是没变没记。现在注入卡头行带一句悬停说明「只列这一跳新增的注入；
  内容没变的项不会重复出现」。**没有编造「另有 N 项未变」**——我们没有记录完整清单，那个数字是
  造出来的；标题文字也没改。
- **同一批还修掉一个真 bug：待办提醒从第 N 轮起每一跳都补一次**（`aaa4334`）。
  `countRoundsSinceLastTodoWrite` 越过 `everyRounds` 之后一直 ≥ 阈值，而那条幂等判据查的是
  「历史里有没有提醒」——提醒是投影注入、刻意不落历史，于是永远查不到。12 轮实测：改前 4 条
  （第 10–13 次请求），改后 1 条；18 轮改后 2 条、轮号 9 与 17、间隔正好 8。
  台账按**会话**分表（否则后台会话刚提醒过会把眼前这条会话的提醒吞掉），轮号取「已有多少条
  assistant 消息」而不是「距上次写清单的轮数」（后者每次 `todo_write` 清零，会让提醒越拖越稀）。
  还有一个不显然的约束：**同一轮重复投影必须给同一个答案**，否则 loop 的 invariant 会二次派生
  投影链、那一遍少一句话，当场报「对不上」。

### 两个待查的产品现象（2026-11-11，修探针时撞见，不是探针的锅）

1. **回合环没有步数上限**（2026-11-11 查清，原先记的「同一个请求被重发 8 次」是误诊）。
   现象是：假端点每次回同一个 `tool_call`，会话日志里就连续出现约 8 条一模一样的 `assistant`
   记录，最后一条带 `model-retry: 连接失败：fetch failed`。查下来这不是重试——重试有上限
   （`src/core/llm.ts:437` 的 `MAX_ATTEMPTS = 6`，首次 + 5 次重试，只对连接/超时/408/429/5xx 生效），
   而 **`src/packages/session-core/loop.ts:362` 那个 `for (;;)` 回合环没有步数上限**：它只在
   「这一步没有工具调用」或「用户取消」时退出。假端点每次都回同一个 `tool_call`，于是环一直跑，
   `session.ts:970` 又按 `callId` 去重、把重复的 tool 结果吞掉，历史尾部永远同一个形状，
   直到连接断掉才收工——**那个「8」是断线前恰好跑的步数，不是任何上限**。
   这是真问题：模型若一直要求调工具，这一轮会无限跑下去，只能靠用户点停止。
   要定论还差一件事（当时没留证据）：那次探针的 `session.jsonl` 被探针自己 `rmSync` 掉了，
   现存日志里搜不到 `fetch failed`。**复现方法**：让假端点固定回同一个 `tool_call`，跑一轮，
   看 8 条 assistant 的 `toolCalls[].id` 是不是同一个——是就确认。
   修法方向：**不加上限，改做「重复调用提醒」守卫**——已在 `b3c995f` 落地（方案与验收见上一节）。
   注意它只是「提醒模型」，**不保证收工**：模型无视提醒时这一轮仍会继续跑，那是有意的取舍
   （硬上限会斩断正常的长活）。真要在极端情况下兜底，得另加一个很高的步数上限，目前没做。
2. **工具调用真的成功时，贴底跟随只有 69%、底部胶囊亮了 52 帧**；换成 read 报错那一态则是
   99%、0 帧。同一份代码、同一个探针，两种结果。目前分不清是产品缺陷（工具卡落定那一下把
   跟随松掉了）还是上面那条环的合成现象，所以**没有写进任何判据**——写成绿的是骗人，
   写成红的是冤枉。查法：先等重复调用提醒落地、让那一轮能正常收工，再看这个 69% 还在不在。

三条新写的真机探针（`_verify-think-collapse` / `_verify-jitter` / `_verify-fold-scroll`）是各自
`spawn` Electron 的，**没带** `_probe-kit` 里那三条禁后台节流的开关。窗口被挡时 Chromium 会把
定时器压到 1Hz、停掉 rAF，采样只剩几十帧——`_verify-follow-debug` 那次 69%/99% 的跳变就是被
这个坑到的。要补的话是三条各加几行 `extraEnv`，不影响前台结果。
