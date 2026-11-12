/**
 * 会话区视口协调器（S5 / 第③阶段）：**测尺寸、写 `scrollTop`、写底部占位、开关
 * `overflow-anchor` 这四件事的唯一 owner**。
 *
 * ## 为什么只留这一个 owner
 *
 * 这四件事写的是同一份东西：`scrollTop` 能写到哪、眼下该在哪、可滚动范围有多长。
 * 两个人各写各的，谁的写生效取决于谁后跑——`follow.ts` 钉底、浏览器滚动锚定、
 * 折叠动画各改一帧，屏幕上就是每帧来回跳一次。所以分工定死：
 *
 * - `follow.ts` 只判**该不该贴底**（手势、落定、只认自己的写这些策略）；
 * - `render.tsx` / `fold-seats.tsx` 只画内容，一律不碰外层 `.chat` 的滚动；
 * - 本文件是**折叠批次这一套**（贴底判定、底部占位、锚定、逐行动画落地）里唯一读
 *   `getBoundingClientRect` / `offsetHeight`、唯一写 `scrollTop`、唯一写
 *   `[data-chat-turn-spacer]` 内联高度的地方。
 *
 * 「唯一」的边界要说清，否则读注释的人会以为整只滚动容器只有这里能动。2026-11-12 起
 * 外面只剩**一条**路径还在读这只容器的几何：
 *
 * - 工具卡 `tool-card/factory.tsx:409`：量 `.chat` 的位置来摆悬浮层，不写滚动；
 *
 * 刻度条 `jump-rail.tsx` 以前自己算「到底」（`scrollHeight − clientHeight − scrollTop`，
 * 没减占位），也自己调 `scrollTo` / `scrollIntoView` 跳轮；`follow.ts` 也曾自己写
 * `floor() − scrollTop <= 24` 这种门限。现在两处都只问 {@link ChatViewport.atFloor} /
 * {@link ChatViewport.floorSlack} / {@link ChatViewport.offsetOf} /
 * {@link ChatViewport.scrollToOffset}——于是**会话区这只 `.chat` 的「到底」只有 `floor()`
 * 一个定义**：短会话（`floor() === 0`）与长会话停在 floor 上给的是同一个答案，占位非 0
 * 时也不会再分叉成两套口径。
 *
 * 「全仓」的边界要说清（2026-11-12 复核：这一句以前写成「全仓」，兑现不了，这里老实交代）。
 * 除本文件之外还有四处写 `scrollHeight − clientHeight` 的「底」，但它们算的都是**别的**
 * 滚动容器，不是会话区，也都不减底部占位，因此不归本 owner 管、也不与 `floor()` 分叉：
 *
 * - `jump-rail.tsx:208` / `:237`：刻度条自己那条轨道 `.jump-rail-scroll` 的底；
 * - `fold-seats.tsx:235` / `:247` / `:283`：限高的过程组体 `.step-body` 自己的底；
 * - `ui-trace/ui/ui.tsx:214`：轨迹页自己那只滚动盒的底；
 * - `ui-status/ui/ui.tsx:2180`：状态面板自己那只滚动盒的底（它连 `FOLLOW_BOTTOM_PX`
 *   都是自己的一份常量）。
 *
 * 这四处要并进来，得先让它们各自持有一只视口实例——那是各自那一页的 owner 该做的事，
 * 本文件不替它们猜。
 *
 * 还要知道探针的盲区：探针拦的是 `scrollTop` 的**属性赋值**，`scrollTo` /
 * `scrollIntoView` 不走那个 setter，所以「写入栈只指向 ViewportOwner」这条判据抓不到
 * 走浏览器 API 的路径。这条盲区现在只剩备用价值：`.chat` 上已经不剩产品路径用它们
 * （刻度条自己那条轨道 `.jump-rail-scroll` 是**另一只**滚动容器，不归本 owner 管）。
 *
 * 组体（`.step-body` 自己的限高滚动，`fold-seats.tsx` 的 `useProcessScroll`）**不在**
 * 这个 owner 里：那是限高盒子自己的滚动，与外层贴底不是一件事。两套 owner 抢同一件事
 * 正是抖的来源，`ui-interaction-base-test.mjs` 那 7 条钉着组体那一套，别动它。
 *
 * ## 每帧的顺序（第④阶段的逐行动画照这个走）
 *
 *   1. **先让盒子动**：动画侧（`fold-motion.ts` 的逐行收起；展开方向行体不动画，只有
 *      阶段组的组体按 `max-height` 长出来）改高度 / 外边距 / 透明度；
 *   2. **再让行落地**：布局跑完。这一步有三个入口，谁先到谁补，补的是同一件事：
 *      `MutationObserver`（微任务，DOM 变完、布局之前，专治同一帧里又提交了一次的情况）、
 *      `ResizeObserver`（布局之后、绘制之前，量得最准）、以及一条 `requestAnimationFrame`
 *      （每帧的保险丝，过渡没有帧回调时靠它把差值追平）；
 *   3. **最后才轮到本文件**：测锚点此刻在哪 → 写 `scrollTop` → 写占位高度。
 *
 * 反过来的顺序一定抖：先写 `scrollTop` 再长盒子，等于拿上一帧的位置去补这一帧的高度。
 * 三次重复调用之间差不到 1px，后到的那个自动什么都不做（见 {@link MOVE_EPS}）。
 *
 * ## 两种落点，批次开始时定死
 *
 * - **跟随态**（`reader.following()` 为真）→ 落到 floor
 *   （`scrollHeight − 占位 − clientHeight`）：内容缩了跟着缩、长了跟着长；
 * - **读历史态** → 保住**第一条可见行**的屏幕位置：批次开始时量一次 `top`，
 *   之后每帧再量一次，把差值补进 `scrollTop`。
 *
 * 不用一种落点兼顾两处：贴底的人要的是「永远看到最后一行」，读历史的人要的是
 * 「我正看的那一行别动」，两者的目标位置在每一帧都不同。
 *
 * ## 有意不对齐参考实现的两处（是选择，不是遗漏）
 *
 * 参考实现是 dsh 的 `packages/client/ui-chat/src/client/chat/use-chat-viewport.ts`。
 * 下面两处我们**故意**不跟它：
 *
 * 1. **底部占位的用法**：它先加 room 再收（`scrollToBottom` 附近把占位撑起来，落定后
 *    再收回去），我们恒 0，靠折叠批次逐帧补 `scrollTop`。原因在探针：`_verify-fold-scroll`
 *    钉的就是「批次里 floor 会变、末帧占位回 0」这两条。改成「先加 room 再收」之后，
 *    批次期间 floor 会被占位垫平，「批次里 floor 真的变了」那条判据永远读不到变化——
 *    等于把观测面做没了。要改这里，先改那条探针的判据。
 * 2. **动画放行**：它只在 `running || motionTail || pendingInputs` 时允许动画
 *    （`ChatView.tsx:245-246` 把 `data-chat-motion` 挂上去），我们恒开。原因是壳里没有
 *    「空闲就把动画关掉」那套门：滚动与折叠动画由 CSS 过渡加批次帧时钟驱动，恒开让
 *    点击、跳轮、批次的观感是同一个节奏。代价是空闲时也可能有一帧过渡——探针只判位置
 *    （每帧读 `scrollTop` 与锚点 `top`），不判帧率，所以这个代价不在判据里。
 *
 * ## 谁开批次（第④阶段起）
 *
 * 只有 `fold-motion.ts` 一处：收起方向在「行的高度还写着实测值、布局没变」的那一刻开，
 * 展开方向在**点击回调里、DOM 变之前**开（行体是瞬时挂上去的，晚一步锚点就量错了）。
 * 本文件不再监听 `data-fold` 翻面自己开窗——那套过渡适配器是第③阶段的临时信号，
 * 留着就是两套开窗口径，同一帧会补两次位置。
 *
 * @module dsc-ui-shell/plugins/transcript/viewport
 */
import { useCallback, useEffect, useState } from 'react'

/** 滚动容器：会话区唯一那个 `overflow-y: auto` 的盒子（`ui-layout` 的 app.tsx）。 */
const SCROLLER_SELECTOR = '.chat'
/** 底部占位：阶段 ① 放在 `.chat` 里、`.chat-inner` 之后（**不在**列里）。 */
const SPACER_SELECTOR = '[data-chat-turn-spacer]'
/** 一行：`ui-transcript` 的每个座位都是一个 `.entry-row`（见 ui.tsx 模块头第 2 条）。 */
const ROW_SELECTOR = '.entry-row'
/** 一轮的座位：`data-round-seat` 是这一轮的序号（`ui.tsx` 的 `<div className="turn-seat">`）。 */
const SEAT_ATTR = 'data-round-seat'
/** 一行属于哪一轮：`.entry-row` 上的 `data-round`（`render.tsx` / `fold-seats.tsx` 都写它）。 */
const ROUND_ATTR = 'data-round'
/**
 * 批次比过渡多留的尾巴（ms）。
 *
 * 为什么不能卡着过渡时长收工：网格过渡的末值是在最后一帧的「更新动画」那一步才落到
 * 布局上的，帧回调读到的可能还是上一帧的值；多跑三四帧把终态也补平，代价是几十毫秒。
 */
const BATCH_TAIL_MS = 80
/** 小于这个数（px）就当没动：亚像素抖动不用补，补了反而写出一条多余的 scroll 事件。 */
const MOVE_EPS = 0.5

/** 落点：跟随态落到 floor，读历史态保住第一条可见行。批次开始时定死，中途不改。 */
export type Landing = 'tail' | 'reading'

/** `scrollToOffset` 认的两种行为：瞬移 / 逐帧补过去。 */
export type ScrollBehaviorKind = 'instant' | 'smooth'

/**
 * 这次写入是谁要的。
 *
 * - `'follow'`（默认）：跟随策略要的（钉底、批次补位、放页补偿）。落点由策略定，写完就完事。
 * - `'jump'`：读者主动跳转（点刻度）。**落点就是读者的意图**——视口写完要把落点交给跟随
 *   策略重算意图（见 {@link ViewportReader.jumped}），而不是让策略把位置钉回底部。
 */
export type ScrollIntent = 'follow' | 'jump'

/**
 * 一条可以被「按住」的行：元素本身，加上它此刻相对滚动容器顶端的位置。
 *
 * 为什么记「相对容器顶端」而不是记 `scrollTop`：插入 / 收起的高度只能这么量——
 * 行被推下去多少，等于它上方长（缩）了多少。
 *
 * 为什么还要记**身份**（`seat` / `round` + `index`）：锚点是「读者正在看的那一行」，
 * 不是「那个 DOM 节点」。React 重挂（历史回填、设置到位、座位重新分组）会把节点换掉：
 * 旧元素脱开文档、同身份的新元素接在原位。只记元素引用的话，重挂之后 `land()` 每帧都
 * 读到 `isConnected === false`，整批一次都不补 `scrollTop`，屏幕上那一行就跟着收起的高度
 * 往上飞（2026-11-12 复现：段高 331px、漂移 166px）。所以元素之外再记一份身份，脱开之后
 * 按它把同一行找回来（见 {@link ChatViewport.captureAnchor} 与 `land()`）。
 */
export interface ScrollAnchor {
  readonly element: HTMLElement
  /** 相对滚动容器顶端的位置（px）。 */
  readonly top: number
  /** 座位键（`data-round-seat`）：锚在「一轮」上时用它找回同一个座位。 */
  readonly seat?: string | null
  /** 这一行属于哪一轮（`data-round`）：锚在「一行」上时用它 + {@link ScrollAnchor.index} 找回。 */
  readonly round?: string | null
  /** 同一轮里的行序号（按 `.entry-row[data-round]` 的文档序，0 基）。 */
  readonly index?: number
}

/**
 * 跟随策略借给视口的两个问题。
 *
 * 视口不自己猜「现在该贴底还是该读历史」——那是 `follow.ts` 的策略；它只在批次开始
 * 那一刻问一句 `following()`，之后按那个落点跑到批次结束。
 */
export interface ViewportReader {
  /** 这一刻还在跟随底部吗。批次开始时用它把落点定死。 */
  following(): boolean
  /**
   * 视口自己写了 `scrollTop` 之后回报实际值。
   *
   * 为什么要有这一条：`follow.ts` 靠「这个位置是不是我自己写的」认出手势之外的滚动，
   * 视口在批次里每帧都写，不回报的话下一帧就会被当成「读者往上滚了」而松掉跟随。
   */
  wrote(top: number): void
  /**
   * 一次**主动跳转**（读者点刻度）落定了，`landed` 是写完之后的实际位置。
   *
   * 为什么不和 `wrote` 并成一条：`wrote` 每帧都来（补间逐帧写），语义是「这个位置是我
   * 写的」；这一条整次跳转只来一次，语义是「这次落点由读者指定」。跟随策略收到它之后按
   * 参考实现（`use-scroll-follow.ts` 的 `jump()`：`following = nearBottom(landed)`）重算
   * 意图——落点不在底就脱离跟随，在底就保持跟随——并且**不许钉底**：钉底会把读者刚跳上去
   * 的位置拽回 floor。
   */
  jumped?(landed: number): void
}

/** 一批会动的盒子（阶段 ④ 传逐行的动画盒子）。 */
export interface BatchOptions {
  /**
   * 这一批里正在动、位置不可信的元素。
   *
   * 选读历史态的锚点行时要避开它们里面的行：那几行此刻正被收起 / 展开，它们自己的
   * 位置本来就在变，拿它们当锚点等于拿一把会动的尺子。
   */
  readonly moving?: readonly Element[]
  /**
   * 这一批最多跑多久（ms）。不给就按样式表的慢档（`--dsc-dur-slow`）加一段尾巴。
   *
   * 逐行动画自己掌握总时长时传它（`fold-motion.ts` 传的是「总时长 + 提交余量」）。
   */
  readonly durationMs?: number
}

/**
 * 一个批次：开一批、跑若干帧、收一批。
 *
 * 阶段 ④ 的逐行动画会自己掌握帧时钟，每帧调 `frame()`；阶段 ③ 由 CSS 过渡驱动，
 * 内部那条 `requestAnimationFrame` 与 `ResizeObserver` 就是它的帧时钟。两条路走的是
 * 同一个 `land()`，不存在「两套补位置的算法」。
 */
export interface FoldBatch {
  /** 这一批定死的落点。 */
  readonly landing: Landing
  /** 每帧调一次：把落点补平（跟随态落 floor，读历史态补锚点位移）。 */
  frame(): void
  /** 收工：补末帧、把占位归零、把 `overflow-anchor` 还回去。重复调用无害。 */
  end(): void
  /** 还在跑吗。 */
  readonly active: boolean
}

/** 视口对外的那张脸（`follow.ts` 与 `ui.tsx` 只认这些）。 */
export interface ChatViewport {
  /** 滚动容器（监听器挂在它上面，见 follow.ts）。 */
  readonly scroller: HTMLElement | null
  /** 内容列（`.chat-inner`；尺寸观察的对象）。 */
  readonly column: HTMLElement | null
  /** 底部占位；没有这一页（例如轨迹页）时是 null。 */
  readonly spacer: HTMLElement | null
  /** 挂上滚动容器：从内容里的任意一个节点往上找 `.chat`。重复挂同一个容器是空操作。 */
  attach(node: HTMLElement | null): void
  /** 摘掉监听与观察，并归还 `overflow-anchor`。 */
  detach(): void
  /** 现在滚到哪了。 */
  scrollTop(): number
  /** 内容总高（含占位）。 */
  scrollHeight(): number
  /** 可视区高。 */
  clientHeight(): number
  /** 可视区宽（不含滚动条）；命中测试取横向中点时用它，别用 `rect().width`。 */
  clientWidth(): number
  /** 占位现在的实际高度（元素真实高度，不是 style 字符串）。 */
  spacerHeight(): number
  /** 内容真正的底：`scrollHeight − 占位 − clientHeight`。占位是给滚动留的余量，不是内容。 */
  floor(): number
  /**
   * 此刻离「到底」还有多少像素：`floor() − scrollTop`。
   *
   * 正数 = 还在内容底上方，还要往下滚这么多；0 = 停在内容底；负数 = 已经越进占位里
   * （占位被撤、浏览器还没夹回来那一瞬才会出现）。
   */
  floorSlack(): number
  /**
   * 此刻算不算「在底」：离底 ≤ `slack` 像素。
   *
   * 判据就是 `floorSlack() <= slack`，短会话也一样：内容比可视区短时 `floor()` 是 0、
   * `floorSlack()` 也是 0，于是**短会话与长会话停在 floor 上给的是同一个答案**。
   *
   * 为什么必须一致（2026-11-12 改）：跟随策略拿它决定「读者松手后要不要重新跟上」
   * （`settle`）与「主动跳转的落点算不算底」（`jumped`）。短会话若判「不在底」，
   * 那颗「回到底部」的胶囊会在一个本来就滚不动的会话里亮着，而且落定之后再也不会
   * 恢复跟随。刻度条与跟随共用这一条，于是全仓对「到底」只有一个答案。
   *
   * @param slack 容差（px），默认 0：只认精确落在 floor 上
   */
  atFloor(slack?: number): boolean
  /** 元素相对滚动内容顶端的偏移（px）；没有容器、元素脱开或它此刻没有盒子时给 null。 */
  offsetOf(element: Element | null): number | null
  /** 滚动容器在视口里的矩形（命中测试要用屏幕坐标，调用方别再自己量）。 */
  rect(): DOMRect | null
  /**
   * 改变滚动位置**只经这里**：`top` 先夹到 `[0, floor()]`（占位不是内容，不许滚进去），
   * 再写下去。
   *
   * `'instant'` 直接写 `scrollTop`；`'smooth'` 由本文件逐帧写（不用浏览器的
   * `scrollTo({ behavior: 'smooth' })`，理由见实现）。返回写完之后的实际 `scrollTop`；
   * `'smooth'` 返回的是起点（动画还没跑），最终值在帧回调里落定。
   *
   * @param intent 这次写是谁要的（默认 `'follow'`）。`'jump'` 表示读者主动跳转：
   *   写完（`'smooth'` 是补间最后一帧）会把落点经 {@link ViewportReader.jumped} 交回
   *   跟随策略重算意图，落点不在底就脱离跟随。
   */
  scrollToOffset(top: number, behavior?: ScrollBehaviorKind, intent?: ScrollIntent): number
  /** 有没有一条逐帧补间正在跑（`'smooth'` 那一档）。 */
  motionActive(): boolean
  /**
   * 立刻停掉逐帧补间、停在当前位置。
   *
   * 读者手势（滚轮 / 拖动 / 触摸）到了就调它：补间每帧写一次 `scrollTop`，手滚出来的
   * 位置下一帧就被盖回去，手感是「滚不动」。
   */
  cancelMotion(): void
  /** 滚动区此刻是藏起来的（高度 0）：这一态下所有测量都不可信。 */
  hidden(): boolean
  /** 钉到底（写 floor），返回写完之后实际的 `scrollTop`。 */
  pin(): number
  /** 写占位高度；0 就清掉内联样式（口径与没有占位时一致）。 */
  setSpacer(height: number): void
  /**
   * 记一个锚点（放页前用）：第一个画出来的座位距容器顶端的位置。
   *
   * 除了元素引用，还记下这座的稳定身份（`data-round-seat`）：重挂之后按身份找回同一个
   * 座位，补位置这件事就不会因为换了节点而失效。
   */
  captureAnchor(): ScrollAnchor | null
  /**
   * 把锚点拉回它原来的位置；返回实际补了多少像素。
   *
   * 元素若在这期间被重挂（不再是同一个节点），先按身份找回同一个座位 / 同一行；
   * 找不回才是降级：原地不动，并把次数写进 `.chat` 的 `data-fold-anchor-fallback`。
   */
  restoreAnchor(anchor: ScrollAnchor): number
  /** 开一批；没有滚动容器时返回 null。 */
  beginBatch(options?: BatchOptions): FoldBatch | null
  /** 收掉当前这一批（没有批次时是空操作）。 */
  endBatch(): void
  /** 现在有没有一批在跑。 */
  batchActive(): boolean
  /** 绑上跟随策略；返回解绑函数。 */
  bindReader(reader: ViewportReader | null): () => void
}

/**
 * 读样式表里的慢档时长（`--dsc-dur-slow`）。
 *
 * 为什么要读而不写死：批次窗口与逐行动画的总时长必须是**同一个数**。各写一份，改令牌
 * 的人只会改一处，另一处就悄悄短了——短了的样子特别难查：末几帧没人补位置。
 * `fold-motion.ts` 也经这个函数取总时长，全仓只有这一处读它。
 */
export function readSlowMs(): number {
  const raw = globalThis.getComputedStyle(document.documentElement).getPropertyValue('--dsc-dur-slow').trim()
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0) return 180
  return raw.endsWith('ms') ? value : value * 1000
}

/**
 * 属性值放进选择器字面量前的兜底转义。
 *
 * 从 DOM 读回来的 `data-*` 是规范化字符串（这两个属性都是数字），这里只挡引号与反斜杠，
 * 不引 `CSS.escape`——它在某些宿主里没有，而这条路径只需要「不生成坏选择器」。
 */
function attrValue(raw: string): string {
  return raw.replace(/["\\]/g, '\\$&')
}

/**
 * 记下一条锚点的稳定身份。
 *
 * 座位（`[data-round-seat]`）用座位键；普通行用「轮号 + 同轮行序号」——这两样在 React
 * 重挂之后都不变，而元素引用会换人。找不到可靠身份时返回空对象：那时只能靠元素本身，
 * 脱开之后就是降级（见 `ViewportOwner.noteAnchorFallback`）。
 *
 * @param element 锚点元素
 * @param scroller 滚动容器（序号按它里面的文档序数）
 */
function identityOf(element: HTMLElement, scroller: HTMLElement): Pick<ScrollAnchor, 'seat' | 'round' | 'index'> {
  const seat = element.getAttribute(SEAT_ATTR)
  if (seat !== null) return { seat }
  const round = element.getAttribute(ROUND_ATTR)
  if (round === null) return {}
  let index = -1
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (row.getAttribute(ROUND_ATTR) !== round) continue
    index += 1
    if (row === element) return { round, index }
  }
  return { round }
}

/** 一批的帧时钟：rAF 每帧补一次，尺寸观察在布局之后补准的那一次。 */
class Batch implements FoldBatch {
  private live = true

  get active(): boolean {
    return this.live
  }

  private frameId = 0
  private resize: ResizeObserver | null = null
  private mutation: MutationObserver | null = null
  private readonly deadline: number

  constructor(
    private readonly host: ViewportOwner,
    readonly landing: Landing,
    readonly anchor: ScrollAnchor | null,
    duration: number,
  ) {
    this.deadline = performance.now() + duration
  }

  begin(): void {
    const scroller = this.host.scroller
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(() => {
        this.step()
      })
      const column = this.host.column
      if (column !== null) this.resize.observe(column)
      if (scroller !== null) this.resize.observe(scroller)
    }
    // 还有一类变化赶不上尺寸观察：同一帧里 React 再提交一次（整轮收起会顺手把内部的
    // 阶段组复位，那一下是**立刻**撤掉内容的，没有过渡），布局在尺寸观察投递之后才变，
    // 于是这一帧画出去就是「已经跳了、还没补」。DOM 变更的通知是微任务，跑在布局与绘制
    // 之前，在这里补一次就补在同一帧里（补的内容与帧内那次完全一样，重复调用无副作用）。
    if (scroller !== null && typeof MutationObserver === 'function') {
      this.mutation = new MutationObserver(() => {
        this.step()
      })
      this.mutation.observe(scroller, {
        attributes: true,
        attributeFilter: ['hidden', 'style', 'class'],
        childList: true,
        subtree: true,
      })
    }
    this.frameId = requestAnimationFrame(this.tick)
  }

  private readonly tick = (): void => {
    if (!this.live) return
    this.host.land(this)
    if (performance.now() >= this.deadline) {
      this.end()
      return
    }
    this.frameId = requestAnimationFrame(this.tick)
  }

  private step(): void {
    if (this.live) this.host.land(this)
  }

  frame(): void {
    this.step()
  }

  end(): void {
    if (!this.live) return
    this.live = false
    if (this.frameId !== 0) cancelAnimationFrame(this.frameId)
    this.frameId = 0
    this.resize?.disconnect()
    this.resize = null
    this.mutation?.disconnect()
    this.mutation = null
    // 末帧再补一次：此时过渡已经停住，补的是终态（上面那些帧可能还差一帧的值）。
    this.host.land(this)
    this.host.closeBatch(this)
  }
}

/** 视口的实现体，一个 `.chat` 对应一个。 */
class ViewportOwner implements ChatViewport {
  private container: HTMLElement | null = null
  private spacerElement: HTMLElement | null = null
  private reader: ViewportReader | null = null
  private batch: Batch | null = null
  /**
   * 「按身份也没找回锚点行」的次数（本视口实例内累计）。
   *
   * 只做观测：每发生一次就把它写到 `.chat` 的 `data-fold-anchor-fallback`，给
   * `desktop/shots/_verify-fold-anchor-remount.mjs` 断言「重挂之后不该掉进降级」。
   * 为什么挂成 DOM 属性：探针在页面外，读不到视口实例；这条属性不改布局，也不进批次的
   * 那几只观察器（它们的 `attributeFilter` 只有 `hidden` / `style` / `class`）。
   */
  private anchorFallbacks = 0
  /**
   * `'smooth'` 那一档的逐帧补间；null = 没有在跑。
   *
   * `jump` 记着这次补间是「读者主动跳转」还是普通跟随写入：补间收尾时只有跳转要把落点
   * 交回跟随策略（见 {@link ViewportReader.jumped}），跟随写入不用多这一道。
   */
  private tween: {
    readonly from: number
    readonly to: number
    readonly start: number
    readonly duration: number
    readonly jump: boolean
  } | null = null
  private tweenRaf = 0

  get scroller(): HTMLElement | null {
    return this.container
  }

  /** 内容列每次都现取：切会话时 `.chat` 不换，里面的列有可能换。 */
  get column(): HTMLElement | null {
    const scroller = this.container
    const first = scroller === null ? null : scroller.firstElementChild
    return first instanceof HTMLElement ? first : null
  }

  get spacer(): HTMLElement | null {
    return this.spacerElement
  }

  attach(node: HTMLElement | null): void {
    // 节点没了（这一屏换成了欢迎态 / 换会话重挂）就当场摘干净：留着旧容器只会
    // 让观察器继续盯着一棵已经不归这一屏管的树。
    if (node === null) {
      this.detach()
      return
    }
    const scroller = node.closest<HTMLElement>(SCROLLER_SELECTOR)
    if (scroller === null) {
      this.detach()
      return
    }
    if (scroller === this.container) return
    this.detach()
    this.container = scroller
    this.spacerElement = scroller.querySelector<HTMLElement>(SPACER_SELECTOR)
    // 降级计数跟着容器走：换容器（换会话 / 整屏重挂）就从 0 开始，别把上一屏的次数带过来。
    this.anchorFallbacks = 0
    delete scroller.dataset.foldAnchorFallback
  }

  detach(): void {
    this.endBatch()
    this.stopTween()
    const scroller = this.container
    if (scroller !== null) scroller.style.overflowAnchor = ''
    this.container = null
    this.spacerElement = null
  }

  scrollTop(): number {
    return this.container?.scrollTop ?? 0
  }

  scrollHeight(): number {
    return this.container?.scrollHeight ?? 0
  }

  clientHeight(): number {
    return this.container?.clientHeight ?? 0
  }

  clientWidth(): number {
    return this.container?.clientWidth ?? 0
  }

  /**
   * 占位高度。
   *
   * 为什么每次读元素的实际高度而不缓存：高度由本文件按需写内联样式，缓存一份就得另外
   * 维护失效时机；贴底时读一次 `offsetHeight`，代价远小于一次错位。
   * 取不到占位（例如轨迹页、或占位还没挂上）按 0 算，口径与没有占位时一致。
   */
  spacerHeight(): number {
    return this.spacerElement?.offsetHeight ?? 0
  }

  floor(): number {
    return Math.max(0, this.scrollHeight() - this.spacerHeight() - this.clientHeight())
  }

  floorSlack(): number {
    return this.floor() - this.scrollTop()
  }

  atFloor(slack = 0): boolean {
    if (this.hidden()) return false
    // 短会话（`floor() === 0`）与长会话停在 floor 上是同一个结论：`floorSlack()` 都是 0。
    // 以前这里多一道 `floor() > 0` 的守卫，于是同一个「到底」在短会话里给 false、在
    // 长会话里给 true，跟随与刻度条各读各的（见接口注释）。
    return this.floorSlack() <= slack
  }

  offsetOf(element: Element | null): number | null {
    const scroller = this.container
    if (scroller === null || element === null || !element.isConnected) return null
    // 没有盒子（`display:none` / 整轮收起挂 hidden）就没有可信的位置：给 null 让调用方跳过，
    // 别把一个 0 矩形当成「在最上面」。
    if (element.getClientRects().length === 0) return null
    // 内容原点 = 容器上缘在屏幕上的位置 − 已滚过的距离；之后每行只量自己的矩形。
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop
    return element.getBoundingClientRect().top - origin
  }

  rect(): DOMRect | null {
    return this.container?.getBoundingClientRect() ?? null
  }

  scrollToOffset(top: number, behavior: ScrollBehaviorKind = 'instant', intent: ScrollIntent = 'follow'): number {
    const scroller = this.container
    if (scroller === null) return 0
    // 藏起来的时候写 scrollTop 会被夹成 0（同 pin）：原样返回，不制造一条假的滚动。
    if (this.hidden()) return scroller.scrollTop
    const target = Math.max(0, Math.min(this.floor(), top))
    // 新手势/新指令到了：先把上一条补间停掉，否则两个 rAF 会互相覆盖。
    this.stopTween()
    const jump = intent === 'jump'
    if (behavior === 'instant') {
      const landed = this.write(target)
      // 主动跳转的落点当场交回策略：位置就是读者的意图（参考实现的 `jump()` 同义）。
      if (jump) this.reader?.jumped?.(landed)
      return landed
    }
    const from = scroller.scrollTop
    if (Math.abs(target - from) <= MOVE_EPS) {
      // 已经在落点上（点的就是当前这一轮）：没有补间要跑，但这仍是一次主动跳转的落定，
      // 跟随意图照样要按落点重算，否则状态会停在跳转之前的那份意图上。
      if (jump) this.reader?.jumped?.(from)
      return from
    }
    // 为什么不用 `scroller.scrollTo({ behavior: 'smooth' })`：中间那几十帧是浏览器在写
    // `scrollTop`，本文件与 `follow.ts` 都收不到「这是我们自己写的」的回报，follow 的
    // 「只认自己的写」会把它们当成读者动手，下一帧就钉回底部（跳轮当场被撤销）。
    // 逐帧写就还是同一条写入通道，每帧都经 `write()` 回报，语义与瞬移完全一致。
    this.tween = { from, to: target, start: performance.now(), duration: readSlowMs(), jump }
    this.tweenRaf = requestAnimationFrame(this.stepTween)
    return from
  }

  private readonly stepTween = (): void => {
    const tween = this.tween
    if (tween === null) return
    this.tweenRaf = 0
    const progress = Math.min(1, (performance.now() - tween.start) / tween.duration)
    // ease-out：起手快、收尾稳，与折叠那套 CSS 过渡的观感一致。
    const eased = 1 - Math.pow(1 - progress, 3)
    // 标成 `'tween'`：这一帧就是补间自己写的，不许它把自己停掉（见 `write`）。
    const landed = this.write(tween.from + (tween.to - tween.from) * eased, 'tween')
    if (progress >= 1) {
      this.tween = null
      // 补间收尾 = 落点到了：主动跳转要把落点交回策略，由它按位置重算跟随意图。
      if (tween.jump) this.reader?.jumped?.(landed)
      return
    }
    this.tweenRaf = requestAnimationFrame(this.stepTween)
  }

  private stopTween(): void {
    if (this.tweenRaf !== 0) cancelAnimationFrame(this.tweenRaf)
    this.tweenRaf = 0
    this.tween = null
  }

  motionActive(): boolean {
    return this.tween !== null
  }

  cancelMotion(): void {
    this.stopTween()
  }

  hidden(): boolean {
    return this.container === null || this.clientHeight() === 0
  }

  pin(): number {
    const scroller = this.container
    if (scroller === null) return 0
    // 藏起来的容器上写 scrollTop 没有意义（而且会被浏览器夹成 0）：原样返回。
    if (this.hidden()) return scroller.scrollTop
    return this.write(this.floor())
  }

  setSpacer(height: number): void {
    const spacer = this.spacerElement
    if (spacer === null) return
    const next = height > MOVE_EPS ? `${String(Math.ceil(height))}px` : ''
    if (spacer.style.height !== next) spacer.style.height = next
  }

  captureAnchor(): ScrollAnchor | null {
    const scroller = this.container
    if (scroller === null) return null
    const element = scroller.querySelector<HTMLElement>('[data-round-seat]')
    if (element === null) return null
    return {
      element,
      top: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      ...identityOf(element, scroller),
    }
  }

  restoreAnchor(pending: ScrollAnchor): number {
    const scroller = this.container
    if (scroller === null) return 0
    // 元素若在这一拍里被重挂，先按身份换回同一行的新节点；换不回来才是降级（原地不动）。
    const anchor = this.resolveAnchor(pending)
    if (anchor === null || !anchor.element.isConnected) {
      this.noteAnchorFallback()
      return 0
    }
    const before = scroller.scrollTop
    const top = anchor.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    if (Math.abs(top - anchor.top) <= MOVE_EPS) return 0
    this.write(before + (top - anchor.top))
    return scroller.scrollTop - before
  }

  /**
   * 把锚点解析成「此刻 DOM 里的那一个元素」：这是「按行、不按节点」的落点规矩。
   *
   * 顺序：
   *   1. 元素还挂在文档里 → 原样返回（99% 的帧走这条，一次 `isConnected` 而已）；
   *   2. 脱开了但记着座位键 → 按 `data-round-seat` 找回同一个座位；
   *   3. 脱开了、是普通行 → 按「`data-round` + 同轮行序号」找回同一行；
   *   4. 都没有 → null，调用方按降级处理（记计数 + 几何兜底）。
   *
   * 为什么这一条成立：React 重挂换的是 DOM 节点，`data-round-seat` / `data-round` 与
   * 「同一轮里的第几行」都是**内容**的身份，重挂之后原样还在（见 `fold-seats.tsx` 的
   * `data-round` 与 `render.tsx` 的 `data-round={seat.round}`）。
   *
   * @returns 换过元素的新锚点（`top` 仍是批次开始时的那个）；找不回给 null
   */
  private resolveAnchor(anchor: ScrollAnchor): ScrollAnchor | null {
    if (anchor.element.isConnected) return anchor
    const scroller = this.container
    if (scroller === null) return null
    const seat = anchor.seat
    if (seat !== undefined && seat !== null) {
      const element = scroller.querySelector<HTMLElement>(`[${SEAT_ATTR}="${attrValue(seat)}"]`)
      return element === null ? null : { ...anchor, element }
    }
    const round = anchor.round
    const index = anchor.index
    if (round === undefined || round === null || index === undefined) return null
    let seen = -1
    for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      if (row.getAttribute(ROUND_ATTR) !== round) continue
      seen += 1
      if (seen === index) return { ...anchor, element: row }
    }
    return null
  }

  /** 记一次「按身份也没找回锚点」的降级；挂到 `.chat` 上供探针读。 */
  private noteAnchorFallback(): void {
    this.anchorFallbacks += 1
    const scroller = this.container
    if (scroller !== null) scroller.dataset.foldAnchorFallback = String(this.anchorFallbacks)
  }

  bindReader(reader: ViewportReader | null): () => void {
    this.reader = reader
    return () => {
      if (this.reader === reader) this.reader = null
    }
  }

  batchActive(): boolean {
    return this.batch !== null
  }

  beginBatch(options?: BatchOptions): FoldBatch | null {
    const scroller = this.container
    if (scroller === null) return null
    // 上一批还没收（折叠还没跑完又点了一下）：先把它补平再开新的，落点按新这一刻重新定。
    this.endBatch()
    const landing: Landing = this.reader?.following() === false ? 'reading' : 'tail'
    const anchor = landing === 'reading' ? this.readingAnchor(options?.moving ?? []) : null
    // 按时间开：整区关掉浏览器的滚动锚定。只关尾行不够——同一帧里我们在写 scrollTop、
    // 浏览器也在写，冲突与关不关尾行无关（定论第 2 条）。
    scroller.style.overflowAnchor = 'none'
    this.setSpacer(0)
    const batch = new Batch(this, landing, anchor, options?.durationMs ?? readSlowMs() + BATCH_TAIL_MS)
    this.batch = batch
    batch.begin()
    return batch
  }

  endBatch(): void {
    this.batch?.end()
  }

  /** 批次收工（只由 `Batch.end()` 调）：还回 `overflow-anchor`、把占位清零。 */
  closeBatch(batch: Batch): void {
    if (this.batch !== batch) return
    this.batch = null
    const scroller = this.container
    // 还回空串 = 让样式表里那条口径重新生效（见 views.css 的 .chat）。
    if (scroller !== null) scroller.style.overflowAnchor = ''
    this.setSpacer(0)
    this.reader?.wrote(this.scrollTop())
  }

  /** 这一批的一帧：按批次开始时定死的落点补平。 */
  land(batch: Batch): void {
    const scroller = this.container
    if (scroller === null) return
    if (batch.landing === 'tail') {
      const floor = this.floor()
      if (Math.abs(scroller.scrollTop - floor) > MOVE_EPS) this.write(floor)
      return
    }
    const anchor = batch.anchor
    if (anchor === null) return
    // 锚点每帧**按身份重新解析**，而不是只用批次开始时那个元素引用：React 重挂（历史回填、
    // 设置到位、座位重新分组）会把节点换掉，只认引用的话这一帧起就再也补不动了
    // （2026-11-12 复现：段高 331px 收掉、锚点行漂了 166px）。
    const row = this.resolveAnchor(anchor)
    if (row === null) {
      // 按身份也找不回这一行（那一轮被删了、或座位整体重排到别的轮号）：这一帧没有可信的
      // 尺子。记一次降级给探针，并且只做几何兜底——内容缩到当前位置之下时把 `scrollTop`
      // 夹回 floor，至少不让人停在空白上（浏览器本来也会在收缩后自己夹，这里只是写明白）。
      this.noteAnchorFallback()
      const floor = this.floor()
      if (scroller.scrollTop > floor + MOVE_EPS) this.write(floor)
      return
    }
    const rect = row.element.getBoundingClientRect()
    // 锚点行这一帧被藏起来了（收起末尾挂了 hidden）：剩下几帧已经没有可信的尺子，
    // 停手比拿一个 0 高度的矩形去补要好——乱补一下就是一次真的跳动。
    if (rect.height === 0) return
    const top = rect.top - scroller.getBoundingClientRect().top
    // `row.top` 与 `anchor.top` 是同一个值（`resolveAnchor` 只换元素，不换位置基准）。
    const drift = top - row.top
    if (Math.abs(drift) <= MOVE_EPS) return
    this.write(scroller.scrollTop + drift)
  }

  /**
   * 读历史态的锚点：视口里**第一条可见行**，避开这一批正在动的那些盒子。
   *
   * 为什么要避开：正在收起 / 展开的那些行，自己的位置每一帧都在变，拿它们当尺子等于
   * 拿一把会动的尺子。避开之后取到的是「这一批之外、屏幕上真正没在动的第一行」——
   * 读者眼睛就在它上面。
   *
   * 整屏都在动（整段过程区占满可视区）时退回第一条可见行：至少有一个参照，比没有强。
   */
  private readingAnchor(moving: readonly Element[]): ScrollAnchor | null {
    const scroller = this.container
    if (scroller === null) return null
    const view = scroller.getBoundingClientRect()
    if (view.height === 0) return null
    let fallback: ScrollAnchor | null = null
    for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      // `hidden="until-found"` 也是 `[hidden]`：收起来的行不算可见。
      if (row.closest('[hidden]') !== null) continue
      const rect = row.getBoundingClientRect()
      if (rect.height === 0 || rect.bottom <= view.top) continue
      if (rect.top >= view.bottom) break
      const anchor: ScrollAnchor = {
        element: row,
        top: rect.top - view.top,
        ...identityOf(row, scroller),
      }
      if (!moving.some((scope) => scope.contains(row))) return anchor
      fallback ??= anchor
    }
    return fallback
  }

  /**
   * 唯一的 `scrollTop` 写入口：写完把实际值回报给跟随策略。
   *
   * `source` 只区分一件事：这一下是不是补间自己写的。**不是补间写的就当场把补间停掉**——
   * `pin()`、批次的 `land()`、`restoreAnchor()`、瞬移跳转都走这里，它们的位置意图比正在
   * 跑的补间新，留着补间就会让下一帧把这一下覆盖回去（审查 P2）。
   */
  private write(target: number, source: 'write' | 'tween' = 'write'): number {
    if (source !== 'tween') this.stopTween()
    const scroller = this.container
    if (scroller === null) return 0
    scroller.scrollTop = target
    const actual = scroller.scrollTop
    this.reader?.wrote(actual)
    return actual
  }
}

/** `useChatViewport` 交出去的两样：视口本体，和一个稳定的挂载函数。 */
export interface ChatViewportHandle {
  readonly viewport: ChatViewport
  readonly attach: (node: HTMLElement | null) => void
}

/**
 * 造一个视口，并把它的生命周期挂到调用它的组件上。
 *
 * 为什么用 `useState(() => ...)` 建一次：视口里存着观察器与批次，每帧重建等于每帧
 * 重新挂观察器——那本身就是一层抖。
 *
 * @returns 视口本体与一个稳定的 `attach`（可以和其他 ref 回调拼在同一个节点上）。
 */
export function useChatViewport(): ChatViewportHandle {
  const [viewport] = useState(() => new ViewportOwner())
  const attach = useCallback((node: HTMLElement | null): void => {
    viewport.attach(node)
  }, [viewport])
  useEffect(() => () => {
    viewport.detach()
  }, [viewport])
  return { viewport, attach }
}
