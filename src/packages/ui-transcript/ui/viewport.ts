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
 * - 本文件是唯一读 `getBoundingClientRect` / `offsetHeight`、唯一写 `scrollTop`、
 *   唯一写 `[data-chat-turn-spacer]` 内联高度的地方。
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

/**
 * 一条可以被「按住」的行：元素本身，加上它此刻相对滚动容器顶端的位置。
 *
 * 为什么记「相对容器顶端」而不是记 `scrollTop`：插入 / 收起的高度只能这么量——
 * 行被推下去多少，等于它上方长（缩）了多少。
 */
export interface ScrollAnchor {
  readonly element: HTMLElement
  /** 相对滚动容器顶端的位置（px）。 */
  readonly top: number
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
  /** 占位现在的实际高度（元素真实高度，不是 style 字符串）。 */
  spacerHeight(): number
  /** 内容真正的底：`scrollHeight − 占位 − clientHeight`。占位是给滚动留的余量，不是内容。 */
  floor(): number
  /** 滚动区此刻是藏起来的（高度 0）：这一态下所有测量都不可信。 */
  hidden(): boolean
  /** 钉到底（写 floor），返回写完之后实际的 `scrollTop`。 */
  pin(): number
  /** 写占位高度；0 就清掉内联样式（口径与没有占位时一致）。 */
  setSpacer(height: number): void
  /** 记一个锚点（放页前用）：第一个画出来的座位距容器顶端的位置。 */
  captureAnchor(): ScrollAnchor | null
  /** 把锚点拉回它原来的位置；返回实际补了多少像素。 */
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
  }

  detach(): void {
    this.endBatch()
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
    return { element, top: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top }
  }

  restoreAnchor(anchor: ScrollAnchor): number {
    const scroller = this.container
    if (scroller === null || !anchor.element.isConnected) return 0
    const before = scroller.scrollTop
    const top = anchor.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    if (Math.abs(top - anchor.top) <= MOVE_EPS) return 0
    this.write(before + (top - anchor.top))
    return scroller.scrollTop - before
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
    if (anchor === null || !anchor.element.isConnected) return
    const rect = anchor.element.getBoundingClientRect()
    // 锚点行这一帧被藏起来了（收起末尾挂了 hidden）：剩下几帧已经没有可信的尺子，
    // 停手比拿一个 0 高度的矩形去补要好——乱补一下就是一次真的跳动。
    if (rect.height === 0) return
    const top = rect.top - scroller.getBoundingClientRect().top
    const drift = top - anchor.top
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
      const anchor: ScrollAnchor = { element: row, top: rect.top - view.top }
      if (!moving.some((scope) => scope.contains(row))) return anchor
      fallback ??= anchor
    }
    return fallback
  }

  /** 唯一的 `scrollTop` 写入口：写完把实际值回报给跟随策略。 */
  private write(target: number): number {
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
