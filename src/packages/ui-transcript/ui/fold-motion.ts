/**
 * 整轮收起的**逐行动画**（S6 / 视口四阶段施工图的第④段）。
 *
 * ## `hidden` 归谁写（2026-11-11 第二次修，对齐 dsh 的 flow-motion）
 *
 * **谁被隐藏，谁自己写。** 本模块只负责「那一刻怎么走」：
 *
 *   - `fold-seats.tsx` 的 `useSearchableHidden` 在**每个元素自己的**布局效果里调
 *     `transition(element, hidden, commit)`；`commit` 就是那个元素「挂 / 摘 `hidden`」的闭包。
 *   - 本模块的 `transition` 只判断这个元素**是不是第一次来找我**：
 *     - 第一次（元素刚挂上来，例如切会话之后行按「会话 + 行身份」整批重挂）：**同步**
 *       `commit()`。新 DOM 一出现就该是收起的，这时也没有「旧高度」可过渡；
 *     - 见过的元素：交给逐行动画，末帧由本模块调它自己的 `commit()`。
 *   - 父级（`SeatBody`）不再遍历子节点写 `hidden`。旧实现由父级在 `collapsed` 变化时统一
 *     提交，而重挂不改变 `collapsed`，新 DOM 于是没人补 `hidden`，收起的一轮整段露出来
 *     （2026-11-11 报障，真机探针 `desktop/shots/_verify-collapse-remount.mjs`）。
 *
 * ## 末帧要再查一次焦点（2026-11-11 第三次修；2026-11-12 改成批次级判定）
 *
 * `useSearchableHidden` 在**开始**收起那一拍查一次焦点，命中就放行；但一轮收起要跑
 * 200 多毫秒，这中间键盘用户完全可能 Tab 进这一行。末帧 `display: none` 落到焦点元素上，
 * 焦点就掉回 body 了。所以收工时还要再查一次 `element.contains(activeElement)`：
 *
 *   - 命中：**不挂** `hidden`，调这一层自己的 `reveal()`（提交闭包上带着，见
 *     `fold-seats.tsx` 的 `HiddenCommit`）把这一轮 / 这一层放行成展开；
 *   - 同时把这个元素从这一批里干净退出（`clearElement`，不留内联高度）。
 *
 * 放行的顺序是「先开批次（行还写着 0 高，锚点才量得准）→ 再还内联值」，
 * 与点击展开那条路同一条时序。
 *
 * **判定是批次级的，不是逐元素的**（2026-11-12 修）。一轮里可能同时有多层可藏：多个
 * 阶段组，或者阶段组 + `model-retry` 这类**组外独立行**。各层的 `transitionend` 先后到达，
 * 若每层自己判「提交还是放行」，就会出现这样的组合：
 *
 *   1. 文档顺序靠前那层先收完 → 当场提交 `hidden` → `StepGroupSeat` 的 `turnHidden`
 *      把这一层里的组关掉、写进手动存档 false；
 *   2. 紧接着靠后那层查出焦点在自己里面 → 放行 → 整轮翻成展开。
 *
 * 结果是「整轮展开、组却收起着」，而且存档被写成 false，切走再切回也回不来。所以元素
 * 收完只**记账**（从这一批里摘掉、停监听、内联高度留着），真正的判定推迟到整批收工那次
 * `finish()`：
 *
 *   1. 扫一遍这一批（含已经收完记了账的）各元素，看焦点在不在里面；
 *   2. 有任何一层带焦点 → **整批一个 `hidden` 都不挂**，只调带焦点那层的 `reveal()`
 *      （它把整轮放行成展开；其余层跟着整轮的展开状态走，下一拍由展开方向摘 `hidden`），
 *      各元素的内联高度照旧还回去。别在这里对每层都调一次 `reveal()`——那会把整轮里
 *      所有组都展开；
 *   3. 一层都不带焦点 → 整批统一 `commit()`，每层该关的组照常关。
 *
 * 顺序依赖由此消失：判定只看收工那一刻的焦点，与「谁先收完」无关。收完到收工之间元素停在
 * 「内联高度 0 + `overflow: hidden`」，不会露出内容；`display: none` 晚几十毫秒挂，
 * 而那一层此刻已经是 0 高。
 *
 * ## 为什么还要一个批次
 *
 * 同一轮里所有行同时收，时长一样、必须同一个时钟；滚动补偿也**只能开一次批**
 * （`viewport.beginBatch`，后开的会把先开的顶掉）。所以每个元素先把自己的起始高度写上、
 * 在布局效果里登记；等整个提交的布局效果都跑完（微任务）再一次性开批、上过渡、跑帧时钟。
 * 这与参考实现 `flow-motion.ts:329-335` 的 `scheduleBatch()` 是同一个时序。
 *
 * ## 每行的动画与视口的顺序
 *
 * `viewport.ts` 的模块头定了每帧的顺序，本模块照它走：
 *
 *   1. 先写行的 box：`transition: none` → `overflow: hidden` → 写入**实测**的 `height` /
 *      `margin-top`；开批前强制回流一次（把上面这批写当成起始值）；再上过渡，
 *      三个值归零（高度、外边距、透明度）。行缝（容器 `row-gap`）同步收，否则逐行归零
 *      之后每道 3px 的缝还在，末帧会剩 N×3px 的齐跳。
 *   2. 再开批次：`viewport.beginBatch({ moving, durationMs })` 在**布局没变**的那一刻
 *      （高度写的是实测值）定下落点与锚点；批次里每帧先 `batch.frame()` 让视口测 / 写
 *      滚动与占位，本模块只管行的 box。
 *   3. 收工时先补末帧再关窗：`batch.end()` 会再补一次位置、把占位归零、
 *      `overflow-anchor` 还回去。
 *
 * 高度是**预量**的（`offsetHeight` + `getComputedStyle().marginTop`），不做 `auto` 插值、
 * 不读 `scrollHeight`。
 *
 * ## 时长从哪来
 *
 * 总时长是 `--dsc-dur-slow` 的**计算值**（见 `viewport.ts` 的 `readSlowMs`），
 * 本模块不钉字面量。内部按参考实现的比例切三段：淡出约 44%、高度延迟约 31%、高度跑约 69%。
 *
 * ## 两个方向不对称
 *
 * - **收起**：逐行量高 → 归零 → 整批收工时统一判定并提交 `hidden`（批次级，见上一节）；
 * - **展开**：行体**不动画**（没有「旧高度」可过渡，直接摘掉 `hidden`），但这一下是瞬时
 *   长高几百像素，所以批次必须在 DOM 变**之前**开（{@link FoldMotion.prepareExpand}，
 *   由点击那一刻调用），否则锚点量到的是「已经跳完」的位置，补不回来。
 *
 * `prefers-reduced-motion: reduce` 时不进动画：同步提交 `hidden`，只在同一批里补一次位置。
 *
 * @module dsc-ui-shell/plugins/transcript/fold-motion
 */
import { useLayoutEffect, useMemo, useRef } from 'react'
import { readSlowMs, type ChatViewport, type FoldBatch } from './viewport'
import type { FoldScope, HiddenCommit, HiddenTransition } from './fold-seats'

/** 淡出占整段的比例（参考实现 70ms / 160ms）。 */
const FADE_RATIO = 70 / 160
/** 高度动画的延迟占整段的比例（参考实现 50ms / 160ms）：先透明、后收高。 */
const HEIGHT_DELAY_RATIO = 50 / 160
/** 收起跑完之后再多跑几帧才提交 `hidden`（ms）。过渡末值要到最后一帧才落到布局上。 */
const COMMIT_TAIL_MS = 60
/** 超时兜底比「总时长 + 余量」再多给的保险（ms）。 */
const GUARD_MS = 160

/** 一批逐行动画的把手：`render.tsx` 用它挂段、并在点击那一刻先开批次。 */
export interface FoldMotion extends FoldScope {
  /** 挂到每个 `.turn-process` 上；卸挂时 React 会回调 `null`。 */
  register(node: HTMLDivElement | null): void
  /**
   * 展开方向**在 DOM 变之前**开批次（见模块头「两个方向不对称」）。
   *
   * 必须在点击回调里、`setState` 之前调：那一刻量到的锚点才是读者此刻看到的位置。
   * 不是展开方向（已经展开着）时是空操作。
   */
  prepareExpand(): void
  /** 座位卸载时把还没收工的那一批收干净（内联样式与批次都不留给已经不在的节点）。 */
  clear(): void
}

/** 一个正在收起的元素与它自己的末帧提交（提交闭包上还带着这一层自己的 `reveal`）。 */
interface Moving {
  readonly element: HTMLElement
  readonly commit: HiddenCommit
  readonly height: number
  readonly marginTop: number
}

/** 一批正在跑的收起。 */
interface Run {
  readonly batch: FoldBatch | null
  /** 还在动画里的元素。 */
  readonly items: Map<HTMLElement, Moving>
  /**
   * 已经收完、等整批收工统一判定的元素（只记了账，内联高度还留着）。
   *
   * 为什么不直接提交：同一批里只要有一层还带着键盘焦点，整批都不能挂 `hidden`
   * （见模块头「末帧要再查一次焦点」的批次级判定）。
   */
  readonly settled: Moving[]
  /** 段容器原来的内联 `row-gap`（收工时还回去）。 */
  readonly bodies: Map<HTMLElement, string>
  readonly listeners: Map<HTMLElement, (event: TransitionEvent) => void>
  readonly deadline: number
  raf: number
  timer: number
  done: boolean
}

/** 这一轮折叠动画需要读的那点外部状态（每次渲染刷新，闭包里读 ref）。 */
interface MotionOptions {
  collapsed: boolean
  viewport: ChatViewport
}

/** 读 `--dsc-ease`；读不到就用同一个曲线（`tokens.css` 的声明）。 */
function readEase(): string {
  const raw = globalThis.getComputedStyle(document.documentElement).getPropertyValue('--dsc-ease').trim()
  return raw === '' ? 'cubic-bezier(0.4, 0, 0.2, 1)' : raw
}

/** 系统是不是要求「少动」。 */
function prefersReducedMotion(): boolean {
  return typeof globalThis.matchMedia === 'function'
    && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 把动画期写下的内联值全部还回去。 */
function clearElement(element: HTMLElement): void {
  const style = element.style
  style.transition = ''
  style.height = ''
  style.marginTop = ''
  style.opacity = ''
  style.overflow = ''
}

/**
 * 造一轮的折叠动画（一个座位一个，生命周期与座位实例相同）。
 *
 * @param latest 座位每次渲染刷新的选项（收起没有、外层视口）
 */
function createFoldMotion(latest: { current: MotionOptions }): FoldMotion {
  /** 这一轮画出来的 `.turn-process` 段（`prepareExpand` 要用它们当「在动的范围」）。 */
  const segments = new Set<HTMLDivElement>()
  /** 已经来问过「我该不该藏」的元素：不在里面 = 这个元素是刚挂上来的。 */
  const seen = new WeakSet<HTMLElement>()
  /** 已经写好起始高度、等微任务开批的元素。 */
  const waiting = new Map<HTMLElement, Moving>()
  /** 正在跑的那一批。 */
  let run: Run | null = null
  let scheduled = false

  /**
   * 元素此刻是不是**真的**在藏：已经挂上 `hidden`，或者这一批已经真的开跑了
   * （动画里 / 已经缩到 0 高、等整批收工的那些都算）。
   *
   * **排队等开批的那一段不算**：那时元素只是登记进了 `waiting`，还没有任何东西在动；
   * 而「另一层被焦点保护放行、整轮其实不藏」要等下一次提交才生效。按「排上队」判，
   * 里层（阶段组）的守卫会在这个窗口里误把组关掉（2026-11-11 报障，见
   * `StepGroupSeat` 的 `turnHidden`）。
   *
   * 「已收完、等收工」那一段（`run.settled`）**要算**：此刻它的内联高度已经是 0，
   * 只差 `hidden` 没挂。不算的话，这一窗口里的一次重渲染会把它当成「没在藏」重新
   * 交给 `collapse`，量到 0 高就当场 `commit()`——顺序依赖又回来了。
   */
  function hiddenOrCollapsing(element: HTMLElement): boolean {
    if (element.hasAttribute('hidden')) return true
    if (run === null) return false
    if (run.items.has(element)) return true
    return run.settled.some((item) => item.element === element)
  }

  /**
   * 这一层里此刻有没有键盘焦点。批次收工时用它做**一次性**判定（见 {@link finish}）。
   *
   * 为什么末帧还要查一次（2026-11-11 第三次修）：`useSearchableHidden` 只在**开始**
   * 收起那一拍查一次焦点，而一轮收起要跑 200 多毫秒；这中间键盘用户完全可能 Tab 进
   * 这一行。末帧 `display:none` 落到焦点元素上，焦点掉回 body——正是模块头承诺
   * 「自动收起永远不许把键盘用户脚下的地板抽掉」要防的事。
   *
   * @returns 焦点在不在这一层里
   */
  function holdsFocus(item: Moving): boolean {
    const element = item.element
    return element.contains(element.ownerDocument.activeElement)
  }

  /**
   * 一个元素收完了：**只记账**，不提交。
   *
   * 为什么推迟（2026-11-12）：同一批里只要还有一层带着键盘焦点，整批都不能挂 `hidden`
   * （见 {@link finish} 的批次判定）。逐个提交就等于「谁先收完谁先关」，同批兄弟层于是
   * 会出现「整轮最后展开、先收完那层的组却被关掉并写进存档」。
   */
  function settle(target: Run, item: Moving): void {
    if (!target.items.delete(item.element)) return
    const element = item.element
    const listener = target.listeners.get(element)
    if (listener !== undefined) {
      element.removeEventListener('transitionend', listener)
      target.listeners.delete(element)
    }
    // 内联高度先留着（已经是 0 高 + `overflow: hidden`，不露内容），等收工时统一提交或
    // 统一还回去。它是最后一个就收工——判定在收工那一刻做，与谁先到无关。
    target.settled.push(item)
    if (target.items.size === 0) finish(target)
  }

  /**
   * 收工时做这一批的**批次级**判定，然后把末帧、样式、批次一起收干净。重复调用无害。
   *
   * 判定见模块头「末帧要再查一次焦点」：扫这一批（已收完记账的 + 还没收完、被超时兜底
   * 带进来的）里有没有键盘焦点——
   *   - 有：整批一个 `hidden` 都不挂，只放行带焦点的那一层（`reveal` 把整轮翻成展开），
   *     其余层跟着整轮的展开状态走；各元素的内联高度照旧还回去；
   *   - 没有：整批统一 `commit()`，每层该关的组照常关。
   *
   * 顺序照旧：先让元素挂上 `hidden`（display:none），再清内联样式，反过来会弹回原高度。
   */
  function finish(target: Run): void {
    if (target.done) return
    target.done = true
    if (target.raf !== 0) cancelAnimationFrame(target.raf)
    target.raf = 0
    if (target.timer !== 0) window.clearTimeout(target.timer)
    target.timer = 0
    // 这一批的全部元素：已经收完记了账的，加上过渡被丢掉 / 走到超时兜底还没收完的。
    const items = [...target.settled, ...target.items.values()]
    target.settled.length = 0
    target.items.clear()
    // 还没收完的那些（超时兜底进来的）把监听停掉；已经收完的在 settle 里停过了。
    for (const [element, listener] of target.listeners) element.removeEventListener('transitionend', listener)
    target.listeners.clear()
    // 批次级判定：任何一层带焦点，整批都不提交（否则就是「先收完的那层把组关掉、
    // 整轮却因为靠后那层被放行而展开」）。只放行带焦点的那一层：它把整轮翻成展开，
    // 其余层跟着整轮的展开状态走——**别**对每层都调一次 `reveal()`，那会展开整轮的组。
    const focused = items.find(holdsFocus)
    if (focused !== undefined) {
      focused.commit.reveal()
    } else {
      for (const item of items) {
        if (item.element.isConnected) item.commit()
      }
    }
    for (const item of items) clearElement(item.element)
    for (const [body, gap] of target.bodies) {
      body.style.transition = ''
      body.style.rowGap = gap
    }
    if (run === target) run = null
    target.batch?.end()
  }

  /** 反向打断 / 放行：停掉这个元素自己的动画，把样式还回去（不提交 `hidden`）。 */
  function cancelMotion(element: HTMLElement): void {
    const queued = waiting.get(element)
    if (queued !== undefined) {
      waiting.delete(element)
      clearElement(element)
    }
    const target = run
    if (target === null) return
    // 已经收完、只是还没到收工的元素也要退出去：这一批正在被展开方向打断，
    // 收工时不该再替它提交 `hidden`（那会把刚放行的行重新藏起来）。
    const at = target.settled.findIndex((item) => item.element === element)
    if (at !== -1) target.settled.splice(at, 1)
    const item = target.items.get(element)
    if (item === undefined) {
      clearElement(element)
      if (target.items.size === 0) finish(target)
      return
    }
    target.items.delete(element)
    const listener = target.listeners.get(element)
    if (listener !== undefined) {
      element.removeEventListener('transitionend', listener)
      target.listeners.delete(element)
    }
    clearElement(element)
    // 最后一行也被放行了：这一批没有东西可动，立刻收工（批次位置由视口自己补）。
    if (target.items.size === 0) finish(target)
  }

  /**
   * 开批：把等着的元素一次性交给视口，同一个时钟跑完。
   *
   * 时序见模块头「为什么还要一个批次」——这个函数只会在微任务里被调到。
   */
  function flush(): void {
    if (waiting.size === 0) return
    const items = [...waiting.values()]
    waiting.clear()
    const viewport = latest.current.viewport
    const moving = items.map((item) => item.element)
    if (prefersReducedMotion()) {
      // 系统说「少动」：不进动画、同步提交 `hidden`。批次仍然开一小段，把这一帧的位置补平。
      // 这条路上不用再做批次级判定：收起/放行的判定发生在布局效果里，到这一刻还没来得及
      // 让用户搬焦点（同一个任务里没有输入事件窗口）。
      const batch = viewport.beginBatch({ moving, durationMs: COMMIT_TAIL_MS })
      for (const item of items) {
        if (item.element.isConnected) item.commit()
        clearElement(item.element)
      }
      batch?.frame()
      batch?.end()
      return
    }
    // 起始高度已经写在元素上（等于此刻实测值），布局没变：强制回流一次，让下一步的过渡有起点。
    void (viewport.scroller?.scrollHeight ?? 0)
    const total = readSlowMs()
    const fade = Math.round(total * FADE_RATIO)
    const delay = Math.round(total * HEIGHT_DELAY_RATIO)
    const runtime = total - delay
    const ease = readEase()
    const batch = viewport.beginBatch({ moving, durationMs: total + COMMIT_TAIL_MS })
    const next: Run = {
      batch,
      items: new Map(items.map((item) => [item.element, item])),
      settled: [],
      bodies: new Map(),
      listeners: new Map(),
      deadline: performance.now() + total + COMMIT_TAIL_MS,
      raf: 0,
      timer: 0,
      done: false,
    }
    run = next
    for (const item of items) {
      const element = item.element
      const listener = (event: TransitionEvent): void => {
        // 只认高度那一条：`margin-top` / `opacity` 结束时刻不一样，认错会早提交。
        if (event.target !== element || event.propertyName !== 'height') return
        if (next.items.get(element) !== item) return
        settle(next, item)
      }
      next.listeners.set(element, listener)
      element.addEventListener('transitionend', listener)
      const style = element.style
      style.transition = [
        `height ${String(runtime)}ms ${ease} ${String(delay)}ms`,
        `margin-top ${String(runtime)}ms ${ease} ${String(delay)}ms`,
        `opacity ${String(fade)}ms ${ease} 0ms`,
      ].join(', ')
      style.height = '0px'
      style.marginTop = '0px'
      style.opacity = '0'
      // 行缝（段容器的 row-gap）同步收：每行归零之后每道 3px 的缝还在，末帧会剩 N×3px 的齐跳。
      const body = element.parentElement
      if (body !== null && body.classList.contains('turn-process-body') && !next.bodies.has(body)) {
        next.bodies.set(body, body.style.rowGap)
        body.style.transition = `row-gap ${String(runtime)}ms ${ease} ${String(delay)}ms`
        body.style.rowGap = '0px'
      }
    }
    const tick = (): void => {
      next.raf = 0
      if (next.done) return
      // 顺序照 `viewport.ts` 模块头：行 box 由上面的过渡推进，先让视口测 / 写，再判断跑完没有。
      next.batch?.frame()
      if (performance.now() >= next.deadline) {
        finish(next)
        return
      }
      next.raf = requestAnimationFrame(tick)
    }
    next.raf = requestAnimationFrame(tick)
    // 过渡被合成器丢掉 / 标签页在后台时，transitionend 可能永远不来。
    next.timer = window.setTimeout(() => {
      finish(next)
    }, total + COMMIT_TAIL_MS + GUARD_MS)
  }

  /** 排一次开批：等整个提交的布局效果都跑完（微任务），期间只登记、不动批次。 */
  function schedule(): void {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      flush()
    })
  }

  /**
   * 把一个元素交给逐行动画：先写死它此刻的实测高度，再等微任务开批。
   *
   * @param element 要收起的行（或阶段组座位）
   * @param commit 这个元素自己的「挂 `hidden`」闭包（末帧由本模块调它）
   */
  function collapse(element: HTMLElement, commit: HiddenCommit): void {
    const height = element.offsetHeight
    const marginTop = Number.parseFloat(globalThis.getComputedStyle(element).marginTop) || 0
    // 已经没高度了（例如组体自己先收了）：没有可过渡的东西，当场提交。
    if (height === 0 && marginTop === 0) {
      commit()
      return
    }
    // 1) 先写行的 box：去掉过渡，把「此刻实测的高度 / 外边距」写死。不写这一步，
    //    浏览器看到的是 `auto → 0`，那是一次跳变而不是过渡。
    const style = element.style
    style.transition = 'none'
    style.overflow = 'hidden'
    style.height = `${String(height)}px`
    style.marginTop = `${String(marginTop)}px`
    waiting.set(element, { element, commit, height, marginTop })
    schedule()
  }

  /**
   * 这个元素来问「我该藏吗」。
   *
   * 第一次见它 → 同步提交（重挂之后立刻就是收起的）；见过 → 交给逐行动画。
   * 摘 `hidden`（展开）永远立刻生效。
   */
  const transition: HiddenTransition = (element, hidden, commit) => {
    const mounted = seen.has(element)
    seen.add(element)
    if (hidden) {
      // 已经在藏 / 已经排上队的不用再来一次（`hiddenOrCollapsing` 现在只认「真在跑」，
      // 排队那一段要单独判，否则同一个元素会被登记两次）。
      if (hiddenOrCollapsing(element) || waiting.has(element)) return
      if (mounted) collapse(element, commit)
      else commit()
      return
    }
    cancelMotion(element)
    commit()
  }

  /** 拿掉已经离场的段（卸载回调只给 `null`，认不出是哪一段，只能顺手扫一遍）。 */
  function prune(): void {
    for (const segment of segments) {
      if (!segment.isConnected) segments.delete(segment)
    }
  }

  /** 这一轮此刻在文档里的那些段。 */
  function liveSegments(): HTMLDivElement[] {
    const list: HTMLDivElement[] = []
    for (const segment of segments) {
      if (segment.isConnected) list.push(segment)
      else segments.delete(segment)
    }
    return list
  }

  function register(node: HTMLDivElement | null): void {
    prune()
    if (node !== null) segments.add(node)
  }

  function prepareExpand(): void {
    const { viewport, collapsed } = latest.current
    if (!collapsed) return
    const roots = liveSegments()
    if (roots.length === 0) return
    viewport.beginBatch({ moving: roots })
  }

  /** 座位卸载：把还没收工的那一批收干净。 */
  function clear(): void {
    for (const item of waiting.values()) clearElement(item.element)
    waiting.clear()
    if (run !== null) finish(run)
  }

  return { register, prepareExpand, transition, hiddenOrCollapsing, clear }
}

/**
 * 给一个座位装上「整轮收起」的逐行动画。
 *
 * @param options.collapsed 这一轮收起来了没有（整轮开关与 collapseTiming 算出来的值）
 * @param options.viewport 外层滚动容器唯一的 owner（批次由它开、由它关）
 * @returns 挂段用的 `register`、展开前开批次的 `prepareExpand`，以及交给每一行自己用的
 *   `transition` / `hiddenOrCollapsing`（见模块头「hidden 归谁写」）
 */
export function useTurnFoldMotion(options: MotionOptions): FoldMotion {
  const latest = useRef(options)
  latest.current = options
  const motion = useMemo(() => createFoldMotion(latest), [latest])
  // 座位卸载：把还没收工的东西收干净，别把内联样式与批次留给一个已经不在的节点。
  useLayoutEffect(() => () => {
    motion.clear()
  }, [motion])
  return motion
}
