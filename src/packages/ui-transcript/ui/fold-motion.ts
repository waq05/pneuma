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
 * - **收起**：逐行量高 → 归零 → 末帧各元素自己提交 `hidden`；
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
import type { FoldScope, HiddenTransition } from './fold-seats'

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

/** 一个正在收起的元素与它自己的末帧提交。 */
interface Moving {
  readonly element: HTMLElement
  readonly commit: () => void
  readonly height: number
  readonly marginTop: number
}

/** 一批正在跑的收起。 */
interface Run {
  readonly batch: FoldBatch | null
  readonly items: Map<HTMLElement, Moving>
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

  /** 元素此刻是不是已经藏好、或正在这一轮里收起（不是「将要收」）。 */
  function hiddenOrCollapsing(element: HTMLElement): boolean {
    if (element.hasAttribute('hidden')) return true
    if (waiting.has(element)) return true
    return run !== null && run.items.has(element)
  }

  /** 一个元素收完了：挂 `hidden` → 清内联；它是最后一个就让整批收工。 */
  function settle(target: Run, item: Moving): void {
    if (!target.items.delete(item.element)) return
    const element = item.element
    const listener = target.listeners.get(element)
    if (listener !== undefined) {
      element.removeEventListener('transitionend', listener)
      target.listeners.delete(element)
    }
    // 顺序照旧：先让元素挂上 `hidden`（display:none），再清内联样式，反过来会弹回原高度。
    if (element.isConnected) item.commit()
    clearElement(element)
    if (target.items.size === 0) finish(target)
  }

  /** 收工时把一批的末帧、样式、批次一起收干净。重复调用无害。 */
  function finish(target: Run): void {
    if (target.done) return
    target.done = true
    if (target.raf !== 0) cancelAnimationFrame(target.raf)
    target.raf = 0
    if (target.timer !== 0) window.clearTimeout(target.timer)
    target.timer = 0
    // 剩下的元素是「过渡被丢掉 / 走到超时兜底」的那些：照同样的顺序补提交。
    for (const [element, listener] of target.listeners) element.removeEventListener('transitionend', listener)
    for (const item of [...target.items.values()]) {
      if (item.element.isConnected) item.commit()
      clearElement(item.element)
    }
    target.items.clear()
    target.listeners.clear()
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
    const item = target.items.get(element)
    if (item === undefined) return
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
  function collapse(element: HTMLElement, commit: () => void): void {
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
      if (hiddenOrCollapsing(element)) return
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
