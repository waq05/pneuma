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
  createContext, useCallback, useContext, useLayoutEffect, useRef, useState,
  type JSX, type ReactNode, type RefObject,
} from 'react'
import { StepGroupRow } from './step-group-row'
import { clearFold } from './fold-state'
import { FoldResetContext, createFoldReset } from './fold-hook'
import type { StepGroup } from './process-groups'

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
 * 一个元素自己的「挂 / 摘 `hidden`」闭包，顺手带着这一层自己的放行动作。
 *
 * 为什么要带 `reveal`：末帧提交之前要**再查一次焦点**（见 `fold-motion.ts` 的
 * `holdsFocus` / `finish` 的批次级判定）。开始收起那一拍查过一次不算数——一轮收起要跑
 * 200 多毫秒，这中间键盘用户完全可能 Tab 进这一行。末帧 `display: none` 落到焦点元素上，
 * 焦点就掉回 body 了，正是「自动收起永远不许把键盘用户脚下的地板抽掉」要防的事。查到焦点在，
 * 要调的就是**这一层自己的**放行动作，所以它得跟着提交闭包一起交出去。
 *
 * 判定是**批次级**的：同一批里有任何一层带焦点，整批都不挂 `hidden`，只调带焦点那层的
 * `reveal()`（见 `fold-motion.ts` 的模块头）。所以「这一层的 `reveal` 有没有被调到」不等于
 * 「这一层是不是被放行」——整批一起被放行，`commit` 一个都没跑。
 */
export interface HiddenCommit {
  (): void
  /** 焦点在这一层里时的放行（把这一轮 / 这一层展开）。 */
  reveal: () => void
}

/**
 * 把「藏不藏」交给更外面一层执行的那次操作（对照 dsh 的 `chat/searchable-hidden.ts:9`）。
 *
 * @param element 稳定的子树根
 * @param hidden 想要的状态
 * @param commit 由**调用方**提供的「真的挂 / 摘 `hidden`」操作：过渡只决定什么时候调它，
 *   提交这件事始终归元素自己
 */
export type HiddenTransition = (element: HTMLElement, hidden: boolean, commit: HiddenCommit) => void

/**
 * 一层「被隐藏」的归属：执行隐藏的那次操作 + 「此刻是不是真的在藏」的只读查询。
 *
 * 为什么两样都要：`transition` 决定怎么藏（第一次挂上来的元素同步藏、见过的走动画）；
 * `hiddenOrCollapsing` 给里层（阶段组）判「这一拍真的开始藏了没有」——不是「应该收起」，
 * 是「已经挂上或真的在跑」（对照 dsh 的 `flow-motion.ts:104-106`）。
 *
 * 注意它**不包括**「刚登记、还等开批」那一段：那一刻还没有任何东西在动，而已开始的
 * 放行动作要等下一次提交才生效——按它关里层会误伤（见 `StepGroupSeat` 的守卫注释）。
 */
export interface FoldScope {
  readonly transition: HiddenTransition
  hiddenOrCollapsing(element: HTMLElement): boolean
}

/** 整轮折叠的作用域；`undefined` = 这里没有动画（同步挂 `hidden`，与参考实现同一口径）。 */
export const FoldScopeContext = createContext<FoldScope | undefined>(undefined)

/**
 * 用 `hidden="until-found"` 隐藏一棵子树，而不是把它卸载。
 *
 * 两个好处（对照 dsh 的 useSearchableHidden，chat/searchable-hidden.ts:11-45）：
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
 * @param transition 这一层归哪个折叠动画管（`FoldScopeContext` 里的那个）。
 *   **不传 = 同步提交**：没有动画的视图（团队页签的子代理流、前导行）走这条路，正好。
 *   传了之后「谁藏、什么时候藏」由它决定，而 `commit` 仍然是本函数的闭包——
 *   于是「元素重挂之后 hidden 由它自己在挂载时补上」这件事不再依赖任何父级。
 * @param onHidden `hidden` **真的挂上**那一拍的回调（放行时不会调）。整轮收起那一拍
 *   要按「已经藏了」来复位里层的展开态，而不是按「应该收起」——见 `RowSeat` /
 *   `StepGroupSeat` 的用法。
 * @returns 挂在被隐藏元素上的 ref
 */
export function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
  transition?: HiddenTransition,
  onHidden?: () => void,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    // 焦点在这棵子树里：这次不藏（调用方会把这一层展开），否则 Tab 到一半位置就没了。
    if (hidden && element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return
    }
    // 提交闭包把这一层自己的放行动作一起带上：末帧复检焦点时（fold-motion 的
    // `holdsFocus`）要调的就是它。`onHidden` 只在**真的挂上** `hidden` 时跑，
    // 被焦点保护放行的那次永远不会跑到这里。
    const commit = ((): void => {
      if (hidden) {
        element.setAttribute('hidden', 'until-found')
        onHidden?.()
      } else {
        element.removeAttribute('hidden')
      }
    }) as HiddenCommit
    commit.reveal = reveal
    if (transition === undefined) commit()
    else transition(element, hidden, commit)
  }, [hidden, reveal, transition, onHidden])
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

/** 组体贴底判定（px）：dsh 的组体用 1px；壳里留 4px，容得下缩放带来的小数误差。 */
const PROCESS_BOTTOM_EPS = 4

/** 组体手势落定的等待（ms）：比外层短，组内一次手势的行程本来就小。 */
const PROCESS_SETTLE_MS = 140

/** 往上翻的键：只有「想回头读」才需要抢在内容增长前松手。 */
const PROCESS_UP_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'PageUp', 'Home'])

/**
 * 阶段组组体自己的滚动：限高之内滚动、两条方向渐隐、以及「跟随最新内容」。
 *
 * 放开的时候定位到哪一头，看这一组闭没闭（对照 dsh 的 use-process-scroll.ts:29-47 与
 * conversation-nodes/README.zh.md:168-170）：
 * - **没闭**：贴到底并继续跟随——那一组还在长，用户要看的是最新那一条；
 * - **闭了**：从顶部开始——一组收了几十条调用时，从头读才是「这一阶段干了什么」。
 *
 * 跟随怎么判，跟外层 transcript 用同一套（dsh 的 `useScrollFollow(false, 1)`）：
 * 读者往回读（往上滚 / 往上翻页）就先松手，落定后再看离底多远；
 * 内容变长只在跟随开着时才追，**读者往上读的时候一个字都不动**。
 * 旧实现只在 scroll 事件里判「离底 32px 以内」，而流式内容在同一个事件循环里就可能先长高，
 * 于是刚滚上去一点又被拽回底部——这是「组体粘滞」的来源。
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
  /** 还在不在跟随最新内容。滚离底部暂停，滚回底部恢复。 */
  const follow = useRef(live)
  /** 上一次由我们自己写到的位置（用来认出「这条 scroll 是我们自己引起的」）。 */
  const written = useRef(0)
  const settleTimer = useRef<number | null>(null)
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
      written.current = body.scrollTop
    }
    wasOpen.current = open
  }, [bodyRef, open, live])

  useLayoutEffect(() => {
    const body = bodyRef.current
    const content = contentRef.current
    if (body === null || !open) return
    /** 贴到底并把两条渐隐边同步进 state（值没变就不惊动 React）。 */
    const pin = (): void => {
      body.scrollTop = body.scrollHeight
      written.current = body.scrollTop
    }
    const readEdges = (): void => {
      const limit = body.scrollHeight - body.clientHeight
      const top = body.scrollTop
      const next: ScrollEdges = { up: top > 1, down: limit > 0 && top < limit - 1 }
      setEdges((previous) => (previous.up === next.up && previous.down === next.down ? previous : next))
    }
    const clearSettle = (): void => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
    /** 手势落定：这一刻的远近才算数。够近就恢复跟随并补齐最后几像素。 */
    const settle = (): void => {
      clearSettle()
      const limit = body.scrollHeight - body.clientHeight
      follow.current = limit - body.scrollTop <= PROCESS_BOTTOM_EPS
      if (follow.current && limit > 0) pin()
      readEdges()
    }
    const schedule = (): void => {
      clearSettle()
      settleTimer.current = window.setTimeout(settle, PROCESS_SETTLE_MS)
    }
    /** 读者自己滚：动手就松手（不等越过哪条线），落定后再判。 */
    const onScroll = (): void => {
      const top = body.scrollTop
      if (Math.abs(top - written.current) <= 1) {
        written.current = top
        readEdges()
        return
      }
      follow.current = false
      schedule()
      readEdges()
    }
    const onGesture = (): void => {
      follow.current = false
      schedule()
    }
    const onWheel = (event: WheelEvent): void => {
      // 只认往上滚：组体在底部时往下滚什么都不该发生，这时松手会让后来居上的内容没人追。
      if (event.ctrlKey || event.deltaY >= 0) return
      onGesture()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (PROCESS_UP_KEYS.has(event.key)) onGesture()
    }
    /** 内容变长：跟随开着才追，读者在读就一动不动。 */
    const observe = (): void => {
      if (follow.current) {
        const limit = body.scrollHeight - body.clientHeight
        if (limit > 0 && limit - body.scrollTop > 2) pin()
      }
      readEdges()
    }
    onScroll()
    body.addEventListener('scroll', onScroll, { passive: true })
    body.addEventListener('scrollend', settle)
    body.addEventListener('wheel', onWheel, { passive: true })
    body.addEventListener('keydown', onKey)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(observe) : undefined
    observer?.observe(body)
    if (content !== null) observer?.observe(content)
    return () => {
      clearSettle()
      body.removeEventListener('scroll', onScroll)
      body.removeEventListener('scrollend', settle)
      body.removeEventListener('wheel', onWheel)
      body.removeEventListener('keydown', onKey)
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
 * @param props.foldStoreKey 这一行自己的折叠存档键（只有带展开体的行才有，见 render.tsx
 *   的 `rowFoldKey`）。整轮**真的**把它藏起来那一拍要把这条存档抹掉：否则整轮收起之后
 *   切走再切回，行按「会话 + 行身份」整批重挂，会把收起之前手动点开的思考 / 工具卡
 *   原样带回来。组里的成员行由 `StepGroupSeat` 那一条统一抹（它们的 `.entry-row`
 *   自己不会被挂 `hidden`）。
 *   同一拍还要推进这一行的复位代次（{@link FoldResetContext}）：抹存档只管重挂之后，
 *   已挂载的那一行要当场回默认态，见 `fold-hook.ts` 模块头「复位代次」。
 */
export function RowSeat(props: {
  hidden: boolean
  onReveal(): void
  roundIndex: number | undefined
  foldStoreKey?: string | undefined
  children: ReactNode
}): JSX.Element {
  const scope = useContext(FoldScopeContext)
  /**
   * 这一行的复位代次（见 `fold-hook.ts` 模块头「复位代次」）。
   *
   * 从 context 取「外层座位已经有的那一份」：阶段组里的成员行自己不会被挂 `hidden`
   * （藏的是组座位），它们的复位只能由组座位推进——那一份由 `StepGroupSeat` 给出来。
   * 组外的行没有外层代次，就自己造一份。谁真的会被藏，谁持有代次。
   *
   * 为什么不用一个全局代次：一轮收起会推进它，整屏所有行都跟着重渲染——本线前面那批
   * 「流式每帧只重画一行」的成果就白做了。代次只经 `useSyncExternalStore` 订阅，
   * 推进时只惊动真正订阅它的那几行。
   */
  const enclosingReset = useContext(FoldResetContext)
  const [ownReset] = useState(createFoldReset)
  const reset = enclosingReset ?? ownReset
  const reveal = useStableCallback(props.onReveal)
  // 真的挂上 `hidden` 那一拍才做（放行时不会跑到这里，见 useSearchableHidden 的 onHidden）：
  // 先抹掉这一行的手动存档，再推进代次——已挂载的这一行因此当场回默认态，不用等重挂。
  // 顺序不能反：行读到的是「抹过存档之后」的默认态（`fold-hook.ts` 的复位分支）。
  const forgetFold = useStableCallback((): void => {
    clearFold(props.foldStoreKey)
    reset.bump()
  })
  // 收起时**不在这里**判断隐藏时机：这一条在过程区里，交给这一轮的折叠动画——
  // 见过的元素走逐行收、末帧提交；刚挂上来的元素（切会话按新键重挂）当场就是收起的。
  const ref = useSearchableHidden(props.hidden, reveal, scope?.transition, forgetFold)
  return (
    <FoldResetContext.Provider value={reset}>
      <div
        ref={ref}
        className="entry-row"
        data-round={props.roundIndex === undefined ? undefined : props.roundIndex}
      >
        {props.children}
      </div>
    </FoldResetContext.Provider>
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
 * @param props.onTurnHidden 整轮**真的**把这一层藏起来了（`hidden` 已挂上）：组里那些行
 *   自己的展开存档由调用方在这一拍抹掉（行是纯函数现算的，只有渲染层手上有清单）。
 *   被焦点保护放行的那一拍**不会**调它。
 * @param props.onTurnClosed 同一拍把这一组自己的展开态复位（清存档，**不写**「手动收起」）。
 *   为什么不复用 `onToggle`：那是用户点击那条路，会把手动选择写进存档——自动收起不是
 *   用户的选择，写成手动之后兜底（以及以后任何默认态）就再也翻不动这一组了。
 */
export function StepGroupSeat(props: {
  group: StepGroup
  turnCollapsed: boolean
  open: boolean
  showDetail: boolean
  onToggle(): void
  /** 整轮被收起时，浏览器查找命中要把它放出来的动作。 */
  onRevealTurn(): void
  onTurnHidden(): void
  onTurnClosed(): void
  children: ReactNode
}): JSX.Element {
  const scope = useContext(FoldScopeContext)
  const revealTurn = useStableCallback(props.onRevealTurn)
  /**
   * 这一组自己的复位代次（见 `fold-hook.ts` 模块头「复位代次」）。
   *
   * 组内成员行的 `.entry-row` 自己不会被挂 `hidden`（藏的是这个组座位），所以它们的复位
   * 只能由这一层推进代次：真挂上 `hidden` 那一拍 `bump()`，订阅了它的成员行当场回默认态。
   * 组外的行各自持有自己那一份（`RowSeat`）。
   */
  const [resetSource] = useState(createFoldReset)
  /**
   * 这一组现在展开着没有，每次渲染刷新。
   *
   * 为什么要一个 ref 而不是直接用 `props.open`：「关这一组」有两个入口（同步提交那一拍、
   * 动画末帧的 commit），它们可能先后走进来；关的动作必须是**幂等**的，否则 `onToggle`
   * 第二下会把刚关掉的组翻回来——收起动画底下看不见，但存档里留下「展开」，下次切回来
   * 就带着它。ref 在第一次关掉时立刻置假，第二个入口看见就退。
   */
  const openRef = useRef(props.open)
  openRef.current = props.open
  /** 在这一拍把这一组关掉（幂等；不碰展开方向）。 */
  const closeGroup = (): void => {
    if (!openRef.current) return
    openRef.current = false
    props.onTurnClosed()
  }
  /**
   * 整轮**真的**挂上 `hidden` 的那一拍：关掉这一组，并让调用方抹掉组里行的展开存档
   * （对照 dsh 的 `ChatGroupSeat.tsx:168-170`）。
   *
   * 为什么挂在提交闭包里，而不是在下面那个布局效果里判「这一拍开始藏了没有」：
   * 收起动画把元素先登记进 `waiting`、批次还要等一个微任务才开。那段窗口里
   * `hiddenOrCollapsing` 已经为真，而**另一层**的放行（焦点在那一行里）要等下一次提交
   * 才生效——在窗口里关组，就会出现「整轮最后是展开的、组却被关掉还写进了存档」
   * （2026-11-11 报障）。提交闭包只在**这一层真的挂上 `hidden`** 时跑，放行时不跑，
   * 时机与判据合一。
   */
  const turnHidden = useStableCallback((): void => {
    closeGroup()
    props.onTurnHidden()
    // 抹完组内行的手动存档再推进代次（顺序不能反：成员行读到的是「抹过之后」的默认态，
    // 见 `fold-hook.ts` 的复位分支）。组已经关着也照推——用户手点开过的那几条行
    // 同样得在这一拍复位。
    resetSource.bump()
  })
  // 外层（组头 + 组体一起藏）也归整轮逐行动画：它是 `display: none`，早挂一帧就把这一行的
  // 高度抽走、动画等于没跑。刚挂上来的元素（切会话重挂）则在挂载时当场就是收起的。
  // 里层（组体自己）**不走动画**——组体收起走的是 `max-height: 0`，内容留在文档里，
  // 动画本来就是平滑的（见 views.css 的 .step-body），所以那一层不传 transition。
  const seatRef = useSearchableHidden(props.turnCollapsed, revealTurn, scope?.transition, turnHidden)
  // 组体被查找命中（或焦点正在组里）时，把这一组展开
  const revealGroup = useStableCallback(() => {
    if (!props.open) props.onToggle()
  })
  const bodyRef = useSearchableHidden(!props.open, revealGroup)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // 组体自己的滚动与渐隐：跑动中的组贴底跟随，已结束的组从顶部开始（见 useProcessScroll）
  const edges = useProcessScroll(bodyRef, contentRef, props.open, !props.group.closed)
  /**
   * 「从展开变收起」那一拍的兜底：没有动画作用域的视图（前导行、团队页签）是同步提交的，
   * 这一拍 `hidden` 已经挂上，关一次就够。
   *
   * 有作用域时不在这里关：这一刻元素大多只是进了 `waiting`、批次还没开
   * （`hiddenOrCollapsing` 的说明见 `FoldScope`），真正关的时机在 `turnHidden` 里。
   * 两个入口都走幂等的 {@link closeGroup}，先后到也只关一次。
   */
  const wasTurnCollapsed = useRef(props.turnCollapsed)
  const toggleRef = useRef<() => void>(closeGroup)
  toggleRef.current = closeGroup
  useLayoutEffect(() => {
    const entering = !wasTurnCollapsed.current && props.turnCollapsed
    wasTurnCollapsed.current = props.turnCollapsed
    if (!entering || !props.open) return
    const element = seatRef.current
    if (element === null) return
    const hiding = scope === undefined ? element.hasAttribute('hidden') : scope.hiddenOrCollapsing(element)
    if (!hiding) return
    if (!openRef.current) return
    toggleRef.current()
  }, [props.turnCollapsed, props.open, scope, seatRef])
  return (
    <FoldResetContext.Provider value={resetSource}>
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
    </FoldResetContext.Provider>
  )
}
