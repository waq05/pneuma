# 折叠动效的几种做法（供挑选）

这一份是「整轮过程折叠」（消息流里那行 `用时 56秒 ∨` 点开/收起）的**动效选型记录**：
把三个参考实现里真实存在的做法逐条抄下来（含 file:line 与原始数值），加上本批已经落地的
那一版与另外四种可选做法，写清各自的观感、改法与代价。

**怎么用**：默认落地的是 **A（下面第 1 条）**。想换成别的，按每条末尾「怎么切过去」改
一到两处即可——高度动画的时长与缓动都走令牌（`--dsc-dur-slow` / `--dsc-ease`），
不需要动组件逻辑。

## 落点在哪儿

| 位置 | 作用 |
| --- | --- |
| `ui-shell/src/plugins/transcript/ui.tsx` | 过程区包一层 `.turn-process` > `.turn-process-body`，`data-fold` 表开合 |
| `ui-shell/src/legacy/views.css` | `.turn-process` / `.turn-process-body` / `.step-body` 的动画规则 |
| `ui-shell/src/plugins/transcript/fold-seats.tsx` | 收起时**延迟挂 `hidden`**（`foldHideDelayMs`，读数取 `--dsc-dur-slow`） |
| `ui-shell/src/legacy/tokens.css` | `--dsc-dur: 100ms` / `--dsc-dur-slow: 180ms` / `--dsc-ease: cubic-bezier(0.4, 0, 0.2, 1)` |

## 三个参考实现里真实存在的做法

### dsh：**不做高度动画**，只动那枚箭头

全仓没有 `transition: height` / `max-height` / `grid-template-rows`，也没有任何动画库。
展开/收起是内容的**瞬时显隐**，动画只在「这一行的抬头」上：

`packages/client/ui-chat/src/client/chat/TurnProcessNodeView.module.css:28-39`
```css
.chevron {
  flex: none;
  width: 14px;
  height: 14px;
  margin-left: 4px;
  color: inherit;
  transition: transform 100ms ease;
}

.root[data-open] .chevron {
  transform: rotate(180deg);
}
```
同一文件 `:17` 还有 `.root { transition: color 100ms ease; }`；降级写在 `:55-60`
（`@media (prefers-reduced-motion: reduce) { .root, .chevron { transition: none; } }`）。

过程内容本身：常驻挂载，只切 `hidden="until-found"`
（`ChatGroupSeat.tsx:162` 与 `chat/searchable-hidden.ts:21-22`），所以显隐是零过渡。
**阶段组头**那一级不是旋转箭头，而是「图标与箭头叠在一格里做 `opacity` 交叉淡入
（`transition: opacity 100ms ease`，`ChatGroupSeat.module.css:48-80`），图标上/下互换」。

### zcode：Radix 高度关键帧 300ms + 内容 fade + **收起后延迟 300ms 卸载**

折叠器件是 Radix Collapsible，动画在共享 wrapper 里
（`packages/ui/src/components/ui/collapsible.tsx:20-45`）：
内容层 `data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up`
配 `duration-300 ease-in-out`，内层再来一层 `animate-in fade-in-0` / `animate-out fade-out-0`
（关键帧体来自依赖 `tw-animate-css`，不在仓库源码里）。

它的收起是「内容还在、高度先收」——为此**延迟卸载**：
`ToolCallBlocks/ToolLayout.tsx:19` `const TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;`，
`:195-202` 的注释写明为什么（Radix 在 closed 动画里要读
`--radix-collapsible-content-height`，提前卸载子内容会读到外层高度、整块闪一下）；
思考块同款（`components/ai-elements/reasoning.tsx:62-63`）。
箭头是 `rotate-90` / `rotate-180` 两种（工具卡 `ToolSummaryRow.tsx:213-220` 是
`duration-200 ease-out` 的 `rotate-90`；`ai-elements/tool.tsx:96` 是 `rotate-180`）。

zcode 还有两条与本仓同族的写法，值得记：
- **`grid-template-rows: 0fr → 1fr` + opacity**：设置页高级配置
  `settings/model-provider-section/ModelEditorAdvanced.tsx:55-83` `duration-200` +
  `motion-reduce:transition-none`，收起时同时 `inert` + `aria-hidden`（保持挂载、退出交互）；
  工作区分组任务 `workspace-grouped-tasks/group-item.tsx:716-731` `duration-200 ease-out`。
- **WAAPI 的 FLIP**：`WorkspaceGroupedTasksSection.tsx:500-559`
  `element.animate([...], { duration: 150, easing: 'cubic-bezier(0.2, 0, 0, 1)' })`，
  并且第一行就是 `if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;`。
- 它的**会话状态胶囊 ↔ 面板**反而**不做尺寸过渡**（只过渡圆角/内边距/背景/阴影 300ms，
  宽高直接跳；两套内容用 `opacity 150ms` 交叉淡入，`ConversationStatusPanel.tsx:2002-2225`）。

### codex：Rust TUI，没有补间

`D:\codex\codex-rs\tui` 是 ratatui 终端界面：展开/收起是**换一套行重画**，没有动画引擎。
`chatwidget/activity_presentation.rs:16-40` 就是一个 `expanded: bool` 参数决定渲染
compact 行还是 expanded 行；折叠态用省略行提示「`… +N lines (ctrl+t to view transcript)`」
（`ui_consts.rs:12` + `tool_output.rs:113-127`）。它有 `MotionMode`（`motion.rs:16-63`，
读 Windows 的 `SPI_GETCLIENTAREAANIMATION`，`system_motion.rs:34-47`）用来把「活动中」的
小点降级成静态圆点；全仓唯一的手写逐帧动画是欢迎画面（`empty_state_animation.rs:35`，
50ms/帧）。**终端里没有「高度补间」这件事可抄**，可抄的是它的降级态度。

### 本仓已有的两处先例

- `.think-body`（`legacy/views.css:8700-8710`）：`grid-template-rows: 1fr` + `@starting-style`
  给 0fr → **只 animate 展开那一向**（内容层挂在条件渲染上，收起是卸载）。
- `.sp-section-body`（`styles.css:1197-1207`）：`grid-template-rows: 1fr` /
  `[data-sp-open='0'] { 0fr }` 200ms，**两向都 animate**（始终挂载，内容不被 `display:none` 拿掉）。

## 可选做法一览

### 1. A：`grid-template-rows: 0fr ↔ 1fr` + 内容淡入淡出 + 收起延迟挂 `hidden`（**已落地**）

- **观感**：展开是「帘子从 0 长起来、内容同时淡进来」（0 → 内容高，180ms 缓动
  `cubic-bezier(0.4,0,0.2,1)`）；收起是「内容在原处被上缘一点点收掉」。
- **为什么选它**：纯 CSS、不预量高度（`max-height` 那条路的通病是要猜上限或量一次写回）；
  两向对称；时长/缓动走现成令牌；`.sp-section-body` 已经在用同一套写法。
- **代价/边界**：收起方向必须**延迟挂 `hidden`**（`foldHideDelayMs()` 现读
  `--dsc-dur-slow`），否则「高度按内容算」会让两边都成 0 高、动画等于没有；收起态要留一个
  0 高盒子（多占一格座位 gap，用负 `margin-top` 抵掉）。
- **实测**：展开方向逐帧采样过——0 → 24px，180ms，曲线与 `--dsc-ease` 一致。
  收起方向在隔离走查里没拍到（浏览器面板被遮挡，Chromium 对隐藏页面会推迟样式重算）。
  **请在真窗口里点一下确认**；若观感不对，换下面第 5 条（WAAPI）最稳。

### 2. B：dsh 原样——高度不动画，只有箭头 100ms

- **观感**：点一下，内容**立刻**整片出现/消失；只有 `用时 56秒 ∨` 那行里的箭头转 180°
  （100ms `ease`）与文字提一档色（100ms）。这一行的「分量最轻」正是这么读出来的。
- **怎么切过去**：删掉 `views.css` 里 `.turn-process` / `.turn-process-body` 的 grid、transition、
  `[data-fold='closed']` 三条（保留包一层，它顺带修了 flex gap 的空档问题），
  收起态改回 `display: none`；`fold-seats.tsx` 的 `delayMs` 可以一并去掉。
  箭头那 100ms 已经是现状（`.turn-fold-chevron` 的 `transition: transform var(--dsc-dur)`）。
- **适合**：想要与 dsh 逐像素一致的静气观感；长会话里滚动时更少动态。

### 3. C：zcode 完整版——300ms 高度 + fade + 收起时内容留 300ms

- **观感**：比 A 慢一档、更「软」；收起过程中内容仍可见（这是它延迟卸载换来的）。
- **怎么切过去**：两处数字——`--dsc-dur-slow` 只影响全站，若只想改这里，把 `.turn-process` 里的
  `var(--dsc-dur-slow)` 换成 `300ms`；`fold-seats.tsx` 的 `foldHideDelayMs()` 直接 `return 300`。
- **代价**：300ms 在长会话里连续开合会显得拖；与本站其它动效（100/180ms）不同档。

### 4. D：逐行错峰入场（stagger）

- **观感**：展开时不是一整块长出来，而是过程行**一条接一条**淡入（`opacity` +
  `translateY(4px)`，每条 delay 递增 ~20ms），像简报在铺开。dsh 的
  `AgentPresetSeat.module.css:64-101`（逐字符 `seat-char-in 0.4s ease-out forwards`，
  delay 由内联给）与 zcode 的 `wf-unfold` 系列（`styles.css:2080-2128`）都是这一类。
- **怎么切过去**：保留 A 的高度动画，再给 `.turn-process-body > *` 加一条
  `animation: turn-line-in var(--dsc-dur-slow) var(--dsc-ease) both;`，用
  `--i`（行序号，从 JSX 里 `style` 给）做 `animation-delay: calc(var(--i) * 20ms)`。
- **代价**：要往每行注入序号；行多时（几十行）总时长会被拖长，需要给 delay 设上限。

### 5. E：JS 量高度的 WAAPI（可中断、不依赖样式重算时机）

- **观感**：与 A 接近（高度补间），但曲线可以配任意贝塞尔，也能中途打断/反向。
- **怎么切过去**：在 `ui.tsx` 的 `.turn-process` 上挂一个 `useLayoutEffect`：开合变化时
  `el.animate([{ height: from }, { height: to }], { duration: 180, easing: 'cubic-bezier(0.4,0,0.2,1)' })`，
  高度用 `el.getBoundingClientRect().height` / `el.scrollHeight` 现量；
  CSS 那边去掉 grid 的两条、保留 `overflow: hidden` 与收起态的 `height: 0`。
- **代价**：要自己管 `overflow` 与动画结束后的高度复位（`fill: 'none'` 让 CSS 接管最好管）；
  逻辑从 CSS 挪进组件，探针要换成断言这套代码。
- **什么时候选它**：如果 A 的收起在你的窗口里看着不对（本批没能在真窗口里拍到收起方向），
  这条最稳——它的动画在**同一个任务里**启动，不依赖浏览器什么时候做样式重算。

## 一句话建议

留在 **A**。它把「不预量高度」这条好处拿到了，两向对称，数字走令牌，且与
`.sp-section-body` 同一套写法；想看 dsh 那种「静」的观感就换 **B**（改动最小，删几条 CSS）。
**D** 更像「演示型」动效，日常长会话里容易腻；**E** 是 A 出问题时的兜底。
