/**
 * 整轮收起的**逐行动画**（S6 / 视口四阶段施工图的第④段）。
 *
 * ## 为什么不再用 `.turn-process` 的 grid 动画
 *
 * 旧做法把整段过程区当成一个裁剪盒子（`grid-template-rows: 1fr → 0fr` + `overflow: hidden`）：
 * 高度从整段的上缘缩起，于是**一整块被切掉**，正文被切在字中间，几十行一起塌。
 * 现在改成每一行各缩各的：行自己先量出高度再归零，同一个批次时钟推进，观感是
 * 「一片行同时往下收」——不是「一块帘子被上缘拉走」。
 *
 * ## 每行的动画与视口的顺序
 *
 * `viewport.ts` 的模块头定了每帧的顺序，本模块照它走，一句不差：
 *
 *   1. **先写行的 box**：`transition: none` → `overflow: hidden` → 写入**实测**的
 *      `height` / `margin-top` → 强制回流一次（把上面这批写当成起始值）→
 *      再上过渡 → 三个值归零（高度、外边距、透明度）。行缝（容器 `row-gap`）同步收，
 *      否则逐行归零之后每道 3px 的缝还在，末帧会剩 N×3px 的齐跳。
 *   2. **再开批次**：`viewport.beginBatch({ moving, durationMs })` 在**布局没变**的那一刻
 *      （高度写的是实测值）定下落点与锚点；批次里每帧先 `batch.frame()` 让视口测 / 写
 *      滚动与占位，本模块只管行的 box。反过来（先写滚动再改盒子）一定抖。
 *   3. **收工时先补末帧再关窗**：`batch.end()` 会再补一次位置、把占位归零、把
 *      `overflow-anchor` 还回去。
 *
 * 高度是**预量**的（`offsetHeight` + `getComputedStyle().marginTop`），不做 `auto` 插值、
 * 不读 `scrollHeight`：`scrollHeight` 量的是「内容有多高」，而行此刻可能被外层限高盒裁过。
 *
 * ## `hidden` 的三个提交入口
 *
 * `hidden="until-found"` 只在**末帧**提交（挂早了内容当场没了，动画等于没跑；这也是旧实现
 * 要「猜一个时长再 setTimeout」的唯一原因）。三个入口走同一个 `finish()`，谁先到谁提交：
 *
 *   1. `transitionend` 且 `propertyName === 'height'`（正常路径，最早）；
 *   2. 批次末帧：本模块的 `requestAnimationFrame` 时钟跑到「总时长 + 余量」；
 *   3. 超时兜底：`总时长 + 余量 + 保险`（过渡被合成器丢掉、标签页在后台这类情况下仍要收工）。
 *
 * 提交顺序是**先挂 `hidden`（`display: none`）再清内联样式**：反过来的话，清掉 `height`
 * 的那一瞬行会弹回原高度，就是又一次跳。
 *
 * ## 时长从哪来
 *
 * 总时长是 `--dsc-dur-slow` 的**计算值**（`tokens.css` 声明 180ms，`styles.css` 的 `:root`
 * 后载覆盖成 200ms，实际运行时是 200ms；本模块不钉字面量，也不自己算第二份）。
 * 内部按参考实现的比例切三段：淡出约 44%、高度延迟约 31%、高度跑约 69%。三段里
 * 「高度延迟 + 高度跑」正好等于总时长。
 *
 * ## 两个方向不对称
 *
 * - **收起**：逐行量高 → 归零 → 末帧提交 `hidden`；
 * - **展开**：行体**不动画**（没有「旧高度」可过渡，直接挂上去），只有阶段组的组体会借
 *   `max-height` 长出来。但这一下是瞬时长高几百像素，所以批次必须在 DOM 变**之前**开
 *   （{@link FoldMotion.prepareExpand}，由点击那一刻调用），否则锚点量到的是「已经跳完」
 *   的位置，补不回来。
 *
 * `prefers-reduced-motion: reduce` 时不进动画：焦点检查照做，然后同步提交 `hidden`，
 * 只在同一帧里借批次补一次位置（少了过渡，但那一下仍然不许跳）。
 *
 * @module dsc-ui-shell/plugins/transcript/fold-motion
 */
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { readSlowMs, type ChatViewport } from './viewport'

/** 淡出占整段的比例（参考实现 70ms / 160ms）。 */
const FADE_RATIO = 70 / 160
/** 高度动画的延迟占整段的比例（参考实现 50ms / 160ms）：先透明、后收高。 */
const HEIGHT_DELAY_RATIO = 50 / 160
/**
 * 收起跑完之后再多跑几帧才提交 `hidden`（ms）。
 *
 * 为什么不能卡着总时长收工：过渡的末值要到最后一帧的「更新动画」那一步才落到布局上，
 * `transitionend` 与帧回调都可能早一帧。多跑三四帧，代价是几十毫秒。
 */
const COMMIT_TAIL_MS = 60
/** 超时兜底比「总时长 + 余量」再多给的保险（ms）。 */
const GUARD_MS = 160

/** 一批逐行动画的把手：`render.tsx` 用它挂段、并在点击那一刻先开批次。 */
export interface FoldMotion {
  /** 挂到每个 `.turn-process` 上；卸挂时 React 会回调 `null`。 */
  register(node: HTMLDivElement | null): void
  /**
   * 展开方向**在 DOM 变之前**开批次（见模块头「两个方向不对称」）。
   *
   * 必须在点击回调里、`setState` 之前调：那一刻量到的锚点才是读者此刻看到的位置。
   * 不是展开方向（已经展开着）时是空操作。
   */
  prepareExpand(): void
}

/** 一批的把手（给下一次翻面用）：反向打断时回退，不提交 `hidden`。 */
interface Runner {
  abort(): void
}

/** 一行（或一个阶段组座位）的预量结果。 */
interface Box {
  readonly element: HTMLElement
  readonly height: number
  readonly marginTop: number
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

/** 一段过程区里装行的那一层（`.turn-process-body`）。 */
function bodyOf(root: HTMLElement): HTMLElement | null {
  const body = root.firstElementChild
  return body instanceof HTMLElement && body.classList.contains('turn-process-body') ? body : null
}

/** 这一段里所有会动的行：body 的直接子元素（`.entry-row` 或 `.step-seat`）。 */
function rowsOf(root: HTMLElement): HTMLElement[] {
  const body = bodyOf(root)
  if (body === null) return []
  return [...body.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
}

/**
 * 焦点还在一批里就放行（不藏），否则把这一批的每一行挂上 `hidden="until-found"`。
 *
 * 与 `useSearchableHidden` 用同一条口径：藏之前先看焦点在不在里面，在就先展开——
 * 自动收起永远不许把键盘用户脚下的地板抽掉。
 *
 * @returns 有没有因为焦点而放行（放行时调用方要负责把整轮展开）
 */
function commitHidden(boxes: readonly Box[], reveal: () => void): boolean {
  for (const box of boxes) {
    const element = box.element
    if (!element.isConnected) continue
    if (element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return true
    }
  }
  for (const box of boxes) {
    if (box.element.isConnected) box.element.setAttribute('hidden', 'until-found')
  }
  return false
}

/** 把动画期写下的内联值全部还回去（行 + 它所在的那一层）。 */
function clearStyles(boxes: readonly Box[], bodies: readonly HTMLElement[]): void {
  for (const box of boxes) {
    const style = box.element.style
    style.transition = ''
    style.height = ''
    style.marginTop = ''
    style.opacity = ''
    style.overflow = ''
  }
  for (const body of bodies) {
    body.style.transition = ''
    body.style.rowGap = ''
  }
}

/**
 * 收起一批：预量 → 写起始值 → 回流 → 开批次 → 上过渡归零 → 三个入口收工。
 *
 * @returns 这一批的把手；已经不用跑（焦点在里面、或这段里一行都没有）时返回 null
 */
function startCollapse(
  viewport: ChatViewport,
  roots: readonly HTMLElement[],
  reveal: () => void,
): Runner | null {
  const bodies: HTMLElement[] = []
  const boxes: Box[] = []
  for (const root of roots) {
    const body = bodyOf(root)
    if (body === null) continue
    bodies.push(body)
    for (const element of rowsOf(root)) {
      boxes.push({
        element,
        height: element.offsetHeight,
        marginTop: Number.parseFloat(globalThis.getComputedStyle(element).marginTop) || 0,
      })
    }
  }
  if (boxes.length === 0) return null

  // 焦点在这一批里：这一批不跑，直接把整轮展开（键盘用户的位置不许被抽走）。
  for (const box of boxes) {
    const element = box.element
    if (element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return null
    }
  }

  const total = readSlowMs()
  const fade = Math.round(total * FADE_RATIO)
  const delay = Math.round(total * HEIGHT_DELAY_RATIO)
  const run = total - delay
  const ease = readEase()

  if (prefersReducedMotion()) {
    // 系统说「少动」：不进动画、同步提交 `hidden`。批次仍然开一小段，把这一帧的位置补平——
    // 少了过渡，这一下还是一次真的跳。
    const batch = viewport.beginBatch({ moving: roots, durationMs: COMMIT_TAIL_MS })
    commitHidden(boxes, reveal)
    batch?.frame()
    batch?.end()
    return null
  }

  // 1) 先写行的 box：去掉过渡，把「此刻实测的高度 / 外边距」写死。
  //    不写这一步，浏览器看到的是 `auto → 0`，那是一次跳变而不是过渡。
  for (const box of boxes) {
    const style = box.element.style
    style.transition = 'none'
    style.overflow = 'hidden'
    style.height = `${String(box.height)}px`
    style.marginTop = `${String(box.marginTop)}px`
  }
  // 2) 强制回流一次：把上面这批写算成「起始值」，下一步的过渡才有起点。
  //    读滚动容器（视口那边的盒子），不在本模块另起一个测量口径。
  void (viewport.scroller?.scrollHeight ?? 0)
  // 3) 布局还没变，此刻开批次：落点与锚点都是「收起前」的。
  const batch = viewport.beginBatch({ moving: roots, durationMs: total + COMMIT_TAIL_MS })
  // 4) 再上过渡、三个值归零。行缝同步收（见模块头）。
  const rowTransition = [
    `height ${String(run)}ms ${ease} ${String(delay)}ms`,
    `margin-top ${String(run)}ms ${ease} ${String(delay)}ms`,
    `opacity ${String(fade)}ms ${ease} 0ms`,
  ].join(', ')
  for (const box of boxes) {
    const style = box.element.style
    style.transition = rowTransition
    style.height = '0px'
    style.marginTop = '0px'
    style.opacity = '0'
  }
  const bodyTransition = `row-gap ${String(run)}ms ${ease} ${String(delay)}ms`
  for (const body of bodies) {
    body.style.transition = bodyTransition
    body.style.rowGap = '0px'
  }

  let done = false
  let raf = 0
  let timer = 0
  let frame: Runner | null = null

  const stop = (): void => {
    done = true
    if (raf !== 0) cancelAnimationFrame(raf)
    raf = 0
    if (timer !== 0) window.clearTimeout(timer)
    timer = 0
    for (const box of boxes) box.element.removeEventListener('transitionend', onEnd)
  }

  /** 末帧提交：先 `hidden`（display:none）再清内联，反过来会弹回原高度。 */
  const finish = (): void => {
    if (done) return
    stop()
    commitHidden(boxes, reveal)
    clearStyles(boxes, bodies)
    batch?.end()
  }

  /** 跑到一半被反向打断（又点开）：不提交 `hidden`，把行放回原样。 */
  const abort = (): void => {
    if (done) return
    stop()
    clearStyles(boxes, bodies)
    batch?.end()
  }

  const onEnd = (event: TransitionEvent): void => {
    // 只认高度那一条：`margin-top` / `opacity` 的结束时刻不一样，认错会早提交。
    if (event.propertyName === 'height') finish()
  }

  const tick = (): void => {
    if (done) return
    // 顺序照 `viewport.ts` 模块头：行的 box 已由上面的过渡推进（这一帧不再重写），
    // 先让视口测 / 写，再判断这一批跑完没有。重复调 `frame()` 落到同一个 `land()`，
    // 差值小于半像素时它自己什么都不做。
    batch?.frame()
    if (performance.now() >= deadline) {
      finish()
      return
    }
    raf = requestAnimationFrame(tick)
  }

  const deadline = performance.now() + total + COMMIT_TAIL_MS
  for (const box of boxes) box.element.addEventListener('transitionend', onEnd)
  raf = requestAnimationFrame(tick)
  // 入口三：过渡被合成器丢掉 / 标签页在后台时，transitionend 可能永远不来。
  timer = window.setTimeout(finish, total + COMMIT_TAIL_MS + GUARD_MS)

  frame = { abort }
  return frame
}

/**
 * 给一个座位装上「整轮收起」的逐行动画。
 *
 * @param options.collapsed 这一轮收起来了没有（整轮开关与 collapseTiming 算出来的值）
 * @param options.viewport 外层滚动容器唯一的 owner（批次由它开、由它关）
 * @param options.reveal 把整轮展开（焦点在里面、或末帧发现焦点在里面时用）
 * @returns 挂段用的 `register` 与展开前开批次的 `prepareExpand`
 */
export function useTurnFoldMotion(options: {
  collapsed: boolean
  viewport: ChatViewport
  reveal(): void
}): FoldMotion {
  const segments = useRef(new Set<HTMLDivElement>())
  const runner = useRef<Runner | null>(null)
  const mounted = useRef(false)
  const prepared = useRef(false)
  /** 每次渲染刷新：effect 只跟 `collapsed` 跑，回调不必进依赖。 */
  const latest = useRef(options)
  latest.current = options

  const register = useCallback((node: HTMLDivElement | null): void => {
    if (node !== null) segments.current.add(node)
  }, [])

  const prepareExpand = useCallback((): void => {
    const { viewport, collapsed } = latest.current
    if (!collapsed) return
    const roots = [...segments.current]
    if (roots.length === 0) return
    prepared.current = true
    viewport.beginBatch({ moving: roots })
  }, [])

  useLayoutEffect(() => {
    const { viewport, reveal, collapsed } = latest.current
    // 上一次还在跑（快速点两下）：先回退干净，再按新状态来。
    runner.current?.abort()
    runner.current = null
    const roots = [...segments.current]
    const first = !mounted.current
    mounted.current = true
    if (roots.length === 0) {
      prepared.current = false
      return
    }
    if (!collapsed) {
      // 展开：行体不动画（直接挂上去），只有组体的 max-height 会长出来。批次通常已经在
      // `prepareExpand()` 里、DOM 变之前开好了；没有才在这里补开一个（锚点会晚一帧）。
      if (!prepared.current) viewport.beginBatch({ moving: roots })
      prepared.current = false
      return
    }
    prepared.current = false
    if (first) {
      // 首帧就处于收起态（切会话、放页、历史轮重挂）：同步提交，不放动画。
      // 这时组件刚挂上，行也没被画出来过，动画只会变成一次「凭空冒出再消失」。
      const boxes: Box[] = []
      for (const root of roots) {
        for (const element of rowsOf(root)) boxes.push({ element, height: 0, marginTop: 0 })
      }
      commitHidden(boxes, reveal)
      return
    }
    runner.current = startCollapse(viewport, roots, reveal)
  }, [options.collapsed])

  return useMemo(() => ({ register, prepareExpand }), [register, prepareExpand])
}
