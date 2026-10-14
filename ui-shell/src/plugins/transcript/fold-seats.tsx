/**
 * 折叠用的两个「座位」组件与它们需要的三个 hook——从旧桌面渲染层原样搬来
 * （`desktop/src/renderer/fold-seats.tsx`）。
 *
 * 为什么要把它们从消息流里搬出来：会话区那棵树的渲染是「一条条目一个 .entry-row」，
 * 而三件事都要求「连续几条过程条目外围有真正的盒子」——
 * - 收起时不能卸载 DOM，要挂 `hidden="until-found"`（浏览器查找能命中）；
 * - 焦点落在将要收起的子树里时不能收（键盘用户会当场丢失位置）；
 * - 阶段组的组体要有自己的限高与滚动跟随。
 *
 * @module dsc-ui-shell/plugins/transcript/fold-seats
 */
import {
  useCallback, useLayoutEffect, useRef, useState,
  type JSX, type ReactNode, type RefObject,
} from 'react'
import { StepGroupRow } from './step-group-row'
import type { StepGroup } from './process-groups'

/**
 * 「贴到最底下」的判据（px）：旧渲染层从 `JumpStrip.tsx` 导出这个值，组体滚动跟随与
 * 外层 transcript 共用同一把尺子。壳还没搬右缘刻度条，判据先在本地——值与旧版一字不差。
 */
const AT_BOTTOM_EPS = 32

/**
 * 把一个每次都换引用的回调固定成稳定引用，内部始终调最新的那一个。
 *
 * 为什么要它：下面两个 hidden hook 都把回调放进了 effect 依赖里，而调用方（ChatView）
 * 在 map 里现造箭头函数，引用每次都变——effect 于是每次渲染都重跑一遍。虽然重跑本身幂等，
 * 但「隐藏时焦点在内部就展开」那条分支会在重跑时再触发一次展开，白绕一圈。
 *
 * @param callback 最新要调的回调
 * @returns 引用永远不变的包装
 */
function useStableCallback<T extends (...args: never[]) => void>(callback: T): T {
  const ref = useRef(callback)
  useLayoutEffect(() => {
    ref.current = callback
  }, [callback])
  return useCallback(((...args: never[]) => {
    ref.current(...args)
  }) as T, [])
}

/**
 * 收起时**延迟**挂 `hidden` 的那段时间：与 `tokens.css` 的 `--dsc-dur-slow`（0.18s）同源，
 * 从 CSS 变量现读——动画时长和延迟必须是同一个数，各写一份迟早会漂。
 *
 * 为什么要延迟（0.6.69 补，zcode 的「收起后延迟 300ms 才卸载内容」是同一件事）：
 * 整轮过程区的高度动画是 `grid-template-rows: 1fr → 0fr`，而轨道高度是**按内容算**的。
 * 收起的那一帧如果同时把这些行打成 `display: none`（`hidden` 的 UA/作者规则就是它），
 * 内容当场没了 → `1fr` 的用量也算成 0 → 高度从 0 到 0，动画等于没有（实测：收起方向
 * 第一帧就已经是 0，只有格子空转 180ms 才 display:none）。延迟到动画跑完再挂，
 * 收起方向才是「内容在原处被上缘一点点收掉」。
 */
function foldHideDelayMs(): number {
  const raw = globalThis.getComputedStyle(document.documentElement).getPropertyValue('--dsc-dur-slow').trim()
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0) return 180
  return raw.endsWith('ms') ? value : value * 1000
}

/**
 * 用 `hidden="until-found"` 隐藏一棵子树，而不是把它卸载。
 *
 * 两个好处（对照 dsh 的 useSearchableHidden，chat/searchable-hidden.ts:9-31）：
 * 1. **浏览器查找（Ctrl+F）仍能命中**收起来的内容——命中时浏览器在被命中的元素上发
 *    `beforematch` 事件，我们借此把这一层展开，用户直接就看到那一行；
 * 2. **键盘焦点不会被抽走**：隐藏之前先看焦点在不在里面，在就先展开（不隐藏），
 *    于是「自动收起」永远不会把用户脚下的地板抽掉。
 *
 * 为什么不用 React 的 `hidden` prop：这里要写的是字符串 `"until-found"` 而不是布尔值，
 * 直接操作 DOM 属性最稳（也顺带保证「属性增删」只在真需要时发生）。
 *
 * @param hidden 这一层现在要不要藏起来
 * @param reveal 焦点在里面、或被查找命中时的放行动作（通常是把它展开）
 * @param options.delayMs 挂 `hidden` 前等多少毫秒（给高度动画留出跑完的时间；展开方向不等）
 * @returns 挂在被隐藏元素上的 ref
 */
export function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
  options?: { delayMs?: number },
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  const delay = options?.delayMs ?? 0
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    // 放行永远不等：展开要立刻看得见（高度动画由 CSS 那边跑）。
    if (!hidden) {
      element.removeAttribute('hidden')
      return
    }
    // 焦点在这棵子树里：这次不藏（调用方会把这一层展开），否则 Tab 到一半位置就没了
    if (element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return
    }
    if (delay <= 0) {
      element.setAttribute('hidden', 'until-found')
      return
    }
    const timer = globalThis.setTimeout(() => {
      element.setAttribute('hidden', 'until-found')
    }, delay)
    return () => {
      globalThis.clearTimeout(timer)
    }
  }, [hidden, reveal, delay])
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    // beforematch 会在元素自身触发并冒泡：外层与里层都挂上，命中哪一层就展开哪一层
    element.addEventListener('beforematch', reveal)
    return () => {
      element.removeEventListener('beforematch', reveal)
    }
  }, [reveal])
  return ref
}

/** 组体上下两条渐隐边现在该不该出现。 */
export interface ScrollEdges {
  up: boolean
  down: boolean
}

/** 静止时的两条边：都不画。 */
const NO_EDGES: ScrollEdges = { up: false, down: false }

/**
 * 阶段组组体自己的滚动：限高之内滚动、两条方向渐隐、以及「跟随最新内容」。
 *
 * 放开的时候定位到哪一头，看这一组闭没闭（对照 dsh 的 use-process-scroll.ts:29-47 与
 * conversation-nodes/README.zh.md:168-170）：
 * - **没闭**：贴到底并继续跟随——那一组还在长，用户要看的是最新那一条；
 * - **闭了**：从顶部开始——一组收了几十条调用时，从头读才是「这一阶段干了什么」。
 *
 * 跟随与暂停的判据跟外层 transcript 用同一把尺子（贴底档 AT_BOTTOM_EPS）：用户往上滚出这一档
 * 就暂停跟随，滚回来就恢复。两者各滚各的，组内滚动不会把外层视角一起带走。
 *
 * @param bodyRef 限高滚动的那个盒子
 * @param contentRef 里面不限高的内容（靠观察它的尺寸变化发现「又长高了」）
 * @param open 这一组展开了没有（收起时不做任何测量与定位）
 * @param live 这一组还在跑吗（决定放开时贴底还是回到顶部）
 */
export function useProcessScroll(
  bodyRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  open: boolean,
  live: boolean,
): ScrollEdges {
  /** 还在不在跟随最新内容。滚离底部暂停，滚回底部恢复（与 ChatView 的外层跟随同一套口径）。 */
  const follow = useRef(live)
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES)
  /** 上一次渲染时这一组展开没有：用来分辨「这次是刚展开」与「展开着、只是状态变了」。 */
  const wasOpen = useRef(false)

  // 只在**刚展开**的那一刻定位：没闭的组贴到底并继续跟随（那一组还在长），
  // 闭了的组从顶部开始且不跟随。之后组的状态再变（比如一句正文把它封了口，live 由真变假）
  // **不重置阅读位置**——dsh 明确写了这条规矩（conversation-nodes/README.zh.md:170：
  // 「数据中的组变为已关闭，或通过模式切换恢复限高时，不重置已展开组的阅读位置」）。
  // 用户正读到一半，组一收口就把他拽回顶部，是最容易把人惹毛的一类跳动。
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null || !open) {
      wasOpen.current = open
      return
    }
    if (!wasOpen.current) {
      follow.current = live
      body.scrollTop = live ? body.scrollHeight : 0
    }
    wasOpen.current = open
  }, [bodyRef, open, live])

  useLayoutEffect(() => {
    const body = bodyRef.current
    const content = contentRef.current
    if (body === null || !open) return
    /** 量一次：跟随中就贴底，然后把两条边的显隐同步进 state（值没变就不惊动 React）。 */
    const measure = (): void => {
      const limit = body.scrollHeight - body.clientHeight
      if (follow.current && limit > 0) body.scrollTop = body.scrollHeight
      const top = body.scrollTop
      const next: ScrollEdges = { up: top > 1, down: limit > 0 && top < limit - 1 }
      setEdges((previous) => (previous.up === next.up && previous.down === next.down ? previous : next))
    }
    /** 用户自己滚：滚回贴底那一档以内恢复跟随，滚出去就暂停——两个门槛都在 AT_BOTTOM_EPS 上。 */
    const onScroll = (): void => {
      const limit = body.scrollHeight - body.clientHeight
      follow.current = limit <= 0 || limit - body.scrollTop <= AT_BOTTOM_EPS
      measure()
    }
    measure()
    body.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
    observer?.observe(body)
    if (content !== null) observer?.observe(content)
    return () => {
      body.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [bodyRef, contentRef, open])

  return edges
}

/**
 * 一条普通条目的座位：一个真正产生盒子的 `.entry-row`（见 styles.css 里对它的说明）。
 *
 * 为什么需要盒子：`hidden` 属性要靠 `display: none` 生效，而 `display: contents` 的元素上
 * 它不起作用（0.6.3 的 `.entry-row` 正是 contents）。所以收起来的那一条必须是真盒子。
 *
 * @param props.hidden 整轮收起来了、且这一条在过程区里 → 藏起来（但留着 DOM 供 Ctrl+F 命中）
 * @param props.onReveal 被查找命中时把整轮展开
 * @param props.roundIndex 这一条属于哪一轮（刻度条按它做命中测试）
 */
export function RowSeat(props: {
  hidden: boolean
  onReveal(): void
  roundIndex: number | undefined
  children: ReactNode
}): JSX.Element {
  const reveal = useStableCallback(props.onReveal)
  // 收起时延迟挂 hidden：这一条在过程区里，整轮收起的高度动画要靠它的内容撑着（见 foldHideDelayMs）
  const ref = useSearchableHidden(props.hidden, reveal, { delayMs: foldHideDelayMs() })
  return (
    <div
      ref={ref}
      className="entry-row"
      data-round={props.roundIndex === undefined ? undefined : props.roundIndex}
    >
      {props.children}
    </div>
  )
}

/**
 * 一个阶段组的座位：组头 + 限高的组体。
 *
 * 两层 hidden 各管一件事：
 * - **整轮收起** → 组头与组体一起藏（三层显隐从外向内，对照 dsh 的
 *   conversation-nodes/README.zh.md:56）；
 * - **这一组收起** → 只藏组体（组头永远是这一阶段唯一看得见的东西）。
 * 两层都走 `hidden="until-found"`：先被命中的那一层会自己展开（浏览器查找的落点通常是正文里的
 * 具体一行，也就是里层）。
 *
 * @param props.group 这一组（组头文案与「闭没闭」都从它来）
 * @param props.turnCollapsed 整轮收起来了没有
 * @param props.open 这一组自己展开了没有
 * @param props.showDetail 组头要不要显示实时详情（档位开关）
 */
export function StepGroupSeat(props: {
  group: StepGroup
  turnCollapsed: boolean
  open: boolean
  showDetail: boolean
  onToggle(): void
  /** 整轮被收起时，浏览器查找命中要把它放出来的动作。 */
  onRevealTurn(): void
  children: ReactNode
}): JSX.Element {
  const revealTurn = useStableCallback(props.onRevealTurn)
  // 外层（组头 + 组体一起藏）同样要延迟：它是 `display: none`，早挂一帧就把
  // 整轮高度动画的内容抽走了。里层（组体自己）**不延迟**——组体收起走的是
  // `max-height: 0`，内容留在文档里，动画本来就是平滑的（见 views.css 的 .step-body）。
  const seatRef = useSearchableHidden(props.turnCollapsed, revealTurn, { delayMs: foldHideDelayMs() })
  // 组体被查找命中（或焦点正在组里）时，把这一组展开
  const revealGroup = useStableCallback(() => {
    if (!props.open) props.onToggle()
  })
  const bodyRef = useSearchableHidden(!props.open, revealGroup)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // 组体自己的滚动与渐隐：跑动中的组贴底跟随，已结束的组从顶部开始（见 useProcessScroll）
  const edges = useProcessScroll(bodyRef, contentRef, props.open, !props.group.closed)
  return (
    <div ref={seatRef} className="step-seat">
      <StepGroupRow
        group={props.group}
        open={props.open}
        showDetail={props.showDetail}
        onToggle={props.onToggle}
      />
      <div
        ref={bodyRef}
        className="step-body"
        data-step-body
        data-scroll-up={edges.up ? '1' : undefined}
        data-scroll-down={edges.down ? '1' : undefined}
      >
        <div ref={contentRef} className="step-content">
          {props.children}
        </div>
      </div>
    </div>
  )
}
