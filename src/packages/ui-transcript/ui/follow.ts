/**
 * 跟着底部的自动滚动：松手 / 只认自己的写 / 贴底门槛 / 跳轮交接五条规矩（详见函数头）。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * 2026-11-10（S5 第③阶段）起这里**只留策略**：该不该贴底、读者动没动手、落定什么时候到，
 * 全在这里判；量尺寸、写 `scrollTop`、写底部占位、开关 `overflow-anchor` 都归
 * `viewport.ts`（那个文件是这四件事的唯一 owner，每帧顺序也写在它的模块头）。
 * 所以本文件里不会再有写滚动位置的赋值，只有 `viewport.pin()`。
 *
 * @module dsc-ui-shell/plugins/transcript/follow
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatViewport } from './viewport'

/** 贴底判定（px）：与 dsh 的 `use-scroll-follow` 同一档（25px），差别只在取整。 */
const FOLLOW_BOTTOM_PX = 24

/** 位置落定的等待（ms）：dsh 是 500ms；壳里的手势距离都短，等太久反而像卡住。 */
const FOLLOW_SETTLE_MS = 180

/** 往上翻的键：只有「想回头读」才需要抢在内容增长前松手（往下滚到底不需要）。 */
const UP_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'PageUp', 'Home'])

/**
 * 所有会滚动的键：按下任何一个都先把补间停掉（往下翻只停补间，不松跟随）。
 *
 * 为什么和 {@link UP_KEYS} 分开：往下翻不是「读者要读历史」，不该松手；但补间每帧都在写
 * `scrollTop`，不停的话这只手刚翻出去的位置下一帧就被盖回去（与滚轮 `deltaY >= 0` 同一口径）。
 */
const SCROLL_KEYS: ReadonlySet<string> = new Set([...UP_KEYS, 'ArrowDown', 'PageDown', 'End'])

/**
 * 手势的有效期（ms）：这一下之后多久内的滚动还算「读者在读历史」。
 *
 * 取 1.5 秒而不是「一次手势管一次滚动」：拖滚动条是一次 pointerdown 带一长串 scroll，
 * 触屏滑动也是一次手势滚很远；反过来，排版慢一拍引起的滚动会落在手势之后很久，那时
 * 早就过了有效期，不会被误判成读者。
 */
const GESTURE_TTL_MS = 1500

/**
 * 跟着底部的自动滚动（对齐 dsh 的 `use-scroll-follow.ts` 与 `use-chat-reading.ts`）。
 *
 * 五条规矩，缺一条就会「粘滞」——明明往上滚了一段，下一口流式内容一到又被拽回底部：
 *
 * 1. **读者往回读就先松手**：往上滚的滚轮、`↑` / `PgUp` / `Home` 一到，跟随当场取消，
 *    不等滚动位置越过哪条线；等位置落定（`scrollend`，或 180ms 内没有新滚动）再按距离重判。
 *    只认「往上」：在底部往下滚时浏览器什么也不做，这时松手只会让下一口内容没人追。
 * 2. **只认自己的写**：钉底要写 `scrollTop`，它引发的 scroll 事件不能当成「读者动了」。
 *    记下每次写到哪儿，差在 1px 以内就当自己滚的（dsh 的 `movedByReader` 同一口径）。
 * 3. **贴底的门槛要近**：dsh 用 25px；壳原来写 160px，往上滚一小段仍算「在底部」，
 *    于是内容一长就把人拽回去，手感就是粘。
 * 4. **松手必须有手势作证**（2026-11-10 加）：位置变了不等于读者动了——排版慢一拍、
 *    内容重排后的夹持、长文里的滚动校正都会让 `scrollTop` 自己变。只有「刚有手势」
 *    （往上滚 / 往上翻页 / 指针按在滚动区上）才认作读者在读历史，否则一律补钉底。
 *    少了这一条，长会话跑到一半跟随会自己关掉，胶囊亮着等人来点（用户报的就是这个）。
 * 5. **主动跳转要交接跟随**（2026-11-12 加）：读者点刻度跳轮时，落点由读者定，不是跟随
 *    要的位置。视口把落点经 `reader.jumped` 交回来，这里按参考实现的口径重算意图
 *    （`following = nearBottom(landed)`）：落在底上继续跟，没落在底上就是读者要读历史。
 *    跳转的逐帧补间期间（`viewport.motionActive()`）既不钉底也不采样——那一刻的位置是
 *    动画写的，不是落点。
 *
 * 内容变长（新条目、流式正文、虚拟列表补挂）交给 `ResizeObserver`：只有跟随开着才钉底，
 * 读者在读的时候一个字都不动（dsh 的 `onResize` 也是这条）。
 *
 * 量尺寸与写滚动都走 `viewport`（见 `viewport.ts` 的模块头）：这里只问「离 floor 还有多远」、
 * 只决定「要不要钉」，落点由视口执行；视口在折叠批次里自己写滚动时，会经 `reader.wrote`
 * 回报，于是下面「只认自己的写」那条照样成立。「离底够不够近」也只问视口的 `atFloor`，
 * 本文件不再自己写 `floor() - scrollTop` 那种比较（门限只有一份定义）。
 *
 * @param dep 条目数：条目变了要重钉一次（ResizeObserver 之外的第二道保险）
 * @param sessionKey 换会话时重新起算（打开会话即锚在末尾）
 * @param viewport 视口协调器：测、写 scrollTop、写占位、开关 overflow-anchor 的唯一 owner
 */
export function useFollowBottom(
  dep: number,
  sessionKey: string,
  viewport: ChatViewport,
): {
  setEnd: (node: HTMLDivElement | null) => void
  /** 末尾那个锚点（滚轮接力的钩子从它找 .chat；调用点不必再拿一次 DOM）。 */
  end: HTMLDivElement | null
  paused: boolean
  resume: () => void
  pause: () => void
} {
  const [end, setEnd] = useState<HTMLDivElement | null>(null)
  /** 跟随的意图。与「此刻离底多远」分开：距离只在落定时量一次。 */
  const following = useRef(true)
  /** 上一次由我们自己写到的位置（用来认出「这条 scroll 是我们自己引起的」）。 */
  const written = useRef(0)
  const settleTimer = useRef<number | null>(null)
  /** 滚动容器的两个动作：钉到底、立刻停跟随（给 `pause` 用）。 */
  const control = useRef<{ pin: () => void; stop: () => void } | null>(null)
  const [paused, setPaused] = useState(false)
  /** 上一次钉底是按哪条会话起的算；初值给一个空串哨兵，于是首屏也算「换了一条」。 */
  const pinnedFor = useRef('')

  useEffect(() => {
    const scroller = viewport.scroller
    if (scroller === null) return undefined
    /**
     * 「离底够近」的唯一问法：门限与算式都在视口（`atFloor` → `floorSlack() <= slack`）。
     *
     * 以前这里自己写 `floor() - viewport.scrollTop() <= 24`，等于把同一个「到底」实现了
     * 两遍：短会话（`floor() === 0`）在旧算式里判「在底」、在视口里判「不在底」，同一句话
     * 两个答案。现在只问视口，算式与容差都归它（占位非 0 时也不会分叉）。
     */
    const nearBottom = (): boolean => viewport.atFloor(FOLLOW_BOTTOM_PX)
    /**
     * 上一次钉底时的内容总高度。
     *
     * 为什么记它：内容自己变矮（工具卡跑完收起、步骤组收合、写前预览卡展开）时，
     * 浏览器会把 scrollTop 夹到新的上限，这也会发一条 scroll 事件——形状和「读者往上
     * 滚」一模一样。拿内容高度变没变来认它：变了就是内容驱动的，不判读者。
     * 不区分的话，每次内容重排都会误判一次「用户在看历史」，暂停跟随又把那颗
     * 「回到底部」胶囊翻出来，下一秒落定再收回去——流式输出时它就一直闪。
     */
    const pinnedHeight = { current: viewport.scrollHeight() }
    /**
     * 滚动区此刻是「藏起来的」（高度 0）。
     *
     * 这一态下所有测量都不可信：容器高度是 0，而内容还在、`scrollHeight` 还是几千像素，
     * 浏览器会把 `scrollTop` 夹成 0 并发一条 scroll 事件——形状和「读者一路滚到顶上」
     * 一模一样。若不认这一态，跟随会被一条夹持事件松掉，而人一动没动。
     *
     * 怎么办：藏起来的时候什么都不写、也绝不改跟随意图；重新露出来的第一条 scroll 事件
     * 认作「浏览器夹回上限」，不是读者动手——保留跟随并补一次钉底。
     */
    const hidden = (): boolean => viewport.hidden()
    /** 刚才是藏着的（下一次可见的测量要按「夹回上限」处理）。 */
    let wasHidden = false
    /** 最近一次「读者手势」的时刻（滚轮往上 / ↑ PgUp Home / 指针按在滚动区上）。 */
    let gestureAt = 0
    const pin = (): void => {
      if (hidden()) {
        wasHidden = true
        return
      }
      // 落点在视口：它写 floor() 而不是 scrollHeight，占位长出来时也停在内容底。
      // 返回值是写完之后的实际位置（可能被浏览器夹过），「只认自己的写」记的就是它。
      written.current = viewport.pin()
      pinnedHeight.current = viewport.scrollHeight()
    }
    const clearSettle = (): void => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
    /**
     * 位置落定。
     *
     * 还在跟随：只补齐最后几像素，**不重判**。以前这里无条件按距离重算一次，于是内容
     * 长高超过 24px 的瞬间就把跟随松掉，下一口 delta 又被钉回底部——胶囊跟着一开一关。
     * 读者真的松开过手（`following` 已是 false）时，才在这里按距离决定要不要恢复。
     */
    const settle = (): void => {
      clearSettle()
      if (hidden()) return
      // 逐帧补间（跳轮）还在跑：这一刻的 `scrollTop` 是动画写的，不是落点。落点由视口在
      // 补间收尾时经 `jumped` 交回来（参考实现同样在 native motion 期间不采样）。
      // 少了这一条，补间途中来的 `scrollend` 会按「还在跟随」补一次钉底，位置被拽回 floor。
      if (viewport.motionActive()) return
      if (following.current) {
        pin()
        return
      }
      if (nearBottom()) {
        following.current = true
        setPaused(false)
        pin()
      }
    }
    const schedule = (): void => {
      clearSettle()
      settleTimer.current = window.setTimeout(settle, FOLLOW_SETTLE_MS)
    }
    const onScroll = (): void => {
      const top = viewport.scrollTop()
      const heightChanged = pinnedHeight.current !== viewport.scrollHeight()
      // 补间在跑：这一段位置是动画写的（每帧都经 `wrote` 回报过），不是读者动的手。
      // 这里只记账，别让「高度变了 + 不在底」那两条判据在半路上钉一次底——那一钉会取消
      // 补间，跳轮当场作废。落点由补间收尾的 `jumped` 交回来。
      if (viewport.motionActive()) {
        written.current = top
        pinnedHeight.current = viewport.scrollHeight()
        return
      }
      if (hidden()) {
        // 藏起来的这段时间只记账：`scrollTop` 被夹成 0 不代表读者滚了。
        wasHidden = true
        written.current = top
        if (heightChanged) pinnedHeight.current = viewport.scrollHeight()
        return
      }
      if (wasHidden) {
        // 重新露出来的第一条：内容是浏览器把 scrollTop 夹回新上限，不是读者动手。
        wasHidden = false
        written.current = top
        pinnedHeight.current = viewport.scrollHeight()
        if (following.current) pin()
        else schedule()
        return
      }
      if (Math.abs(top - written.current) <= 1) {
        written.current = top
        if (heightChanged) pinnedHeight.current = viewport.scrollHeight()
        return
      }
      if (heightChanged) {
        pinnedHeight.current = viewport.scrollHeight()
        // 「高度变了」单独不算证据：流式输出时内容一直在长，读者的滚动也落在这个窗口里。
        // 真正的判据是**夹回底部**——内容变矮时浏览器把 scrollTop 夹到新上限，结果一定
        // 贴着新的底；读者往上滚不会贴着底。两条同时成立才认作内容驱动。
        // 「贴不贴底」问视口（`atFloor`），这里不再自己算 `floor() - top`。
        if (nearBottom()) {
          written.current = top
          // 已经在暂停态时仍排一次落定：内容变矮之后读者可能正好滚到了底，得让它有机会
          // 恢复跟随（跟随态不用排，`onResize` 会接着钉底）。
          if (!following.current) schedule()
          return
        }
      }
      written.current = top
      if (following.current) {
        // 松手必须有**手势**作证（2026-11-10 报障「自动跟随会中途掉线」）。
        // 走到这里的 scroll 事件，除了「读者往上滚」，还可能是：排版慢了一拍、内容重排后
        // 的夹持、以及浏览器在长文里补的滚动校正——它们都没有手势。以前一律当成读者动手，
        // 于是长会话跑到一半，跟随自己就关了，胶囊亮着，得手点一次才回来。
        // 现在只有「刚有手势」才算读者在读历史；其余一律补一次钉底，跟随不动。
        if (performance.now() - gestureAt > GESTURE_TTL_MS) {
          pin()
          return
        }
        following.current = false
      }
      // 位置真的离开底部了，就给一颗「回到底部」的回头路。
      //
      // 为什么写在 `if (following)` 外面（2026-11-10 修）：滚轮往上读时 `onWheel` 先把
      // 跟随松掉，等这条 scroll 事件到达 `following` 已经是 false，原来挂在里头的
      // `setPaused(true)` 永远走不到——胶囊不亮，往上读了一段却没有回到底部的入口。
      setPaused(true)
      schedule()
    }
    /** 读者动手：先松手，不等这一下手势滚出多远。 */
    const onGesture = (): void => {
      // 藏起来的容器上收到的滚轮/按键不是「读者在读这段历史」（多半是别处在滚，
      // 事件被冒泡上来），不改跟随意图。
      if (hidden()) return
      following.current = false
      schedule()
    }
    const onWheel = (event: WheelEvent): void => {
      // ctrl + 滚轮是缩放，不是滚动：它不该抢走正在跑的补间，也不该松掉跟随。
      if (event.ctrlKey) return
      // 其余滚轮一律先把补间停住（往下滚也一样）：补间每帧写 `scrollTop`，手滚出来的
      // 位置下一帧就被它盖回去，手感是「滚不动」。停补间与改跟随意图是两件事，分开判。
      viewport.cancelMotion()
      // 只认「往上滚」：在底部往下滚时浏览器什么也不做，这时若把跟随松掉，
      // 下一口流式内容就没人追了（点开工具卡、往下翻也一样，不该断跟随）。
      if (event.deltaY >= 0) return
      gestureAt = performance.now()
      onGesture()
    }
    const onKey = (event: KeyboardEvent): void => {
      // 任何翻页/方向键都是「手接管了」：先停补间，再判是不是往上读。与滚轮同一口径——
      // 往下翻也停补间，只是不松跟随（在底部按下翻键本来也滚不动）。
      if (!SCROLL_KEYS.has(event.key)) return
      viewport.cancelMotion()
      if (!UP_KEYS.has(event.key)) return
      gestureAt = performance.now()
      onGesture()
    }
    /**
     * 指针按在滚动区上（拖滚动条、触屏拖动、点住正文）。
     *
     * 为什么必须有这一条：拖滚动条只会发 `scroll`，既没有 wheel 也没有按键。只认后两者
     * 的话，「拖滚动条往上读」会被当成「没有手势」而被立刻钉回底部，人根本读不了。
     *
     * 两件事分开：
     * 1. **停补间**：按在滚动条上（`target` 就是滚动容器本身）或用触摸 / 触控笔按下去，
     *    就是「手接管了」，正在跑的跳轮补间立刻停在原地——不停的话补间每帧写一次
     *    `scrollTop`，会把这只手刚拖出来的位置盖回去。
     * 2. **只记时刻、不当场松手**：点开工具卡、点链接都是「按下但没有滚动」，一旦在这里
     *    松手，跟随就被这些看内容的点击打断；真正算读者往回读的，是紧随其后的那条 `scroll`。
     */
    const onPointerDown = (event: PointerEvent): void => {
      gestureAt = performance.now()
      if (event.pointerType !== 'mouse' || event.target === scroller) viewport.cancelMotion()
    }
    /** 内容变长：跟随开着才追，读者在读就一动不动。 */
    const onResize = (): void => {
      // 藏起来了就不追：这一态下 `floor()` 是「内容高 − 0」，写进去的 scrollTop 没有意义。
      if (hidden()) {
        wasHidden = true
        return
      }
      // 补间在跑（读者刚点了刻度）：这一拍钉底会把跳转按回 floor，还会顺手取消补间。
      if (viewport.motionActive()) return
      if (!following.current) return
      // 门限问视口（`atFloor`），不再自己写 `floor() - scrollTop`。
      if (!viewport.atFloor(4)) pin()
    }
    control.current = {
      pin,
      stop: () => {
        clearSettle()
        following.current = false
        setPaused(true)
      },
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('scrollend', settle)
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('keydown', onKey)
    scroller.addEventListener('pointerdown', onPointerDown, { passive: true })
    // 把「此刻还在不在跟随」借给视口：折叠批次开始时它只问这一次，落点就此定死。
    // 同时收下视口的写入回报——批次里它每帧都写 scrollTop，不回报的话下一帧
    // 「只认自己的写」就会把那些写当成读者动了。
    const releaseReader = viewport.bindReader({
      following: () => following.current,
      wrote: (top: number) => {
        written.current = top
        pinnedHeight.current = viewport.scrollHeight()
      },
      /**
       * 主动跳转（读者点刻度）的落点到了：按参考实现的口径重算意图
       * （`use-scroll-follow.ts` 的 `jump()`：`following = nearBottom(landed)`）——
       * 落点不在底就脱离跟随，在底就保持跟随，**不钉底**。
       *
       * 为什么非有这一条不可：补间是逐帧写 `scrollTop` 的，每一帧都经 `wrote` 回报，
       * 于是 `following` 一路保持 true；补间收尾那条 `scrollend` 走到 `settle` 就按
       * 「还在跟随」补一次 `pin()`，位置被写回 floor——表现就是「贴底点早轮刻度，
       * 跳上去约 100ms 后被拽回底部」。
       *
       * 为什么不用「跳转后 N 毫秒内不钉」这种时间窗口：补间时长跟着内容长度走（读的是
       * `--dsc-dur-slow`，还可能被下一帧的写入提前掐断），窗口短了盖不住、长了又会把
       * 读者正常的一下滚动当成跳转。**落点本身是事实**：在底上就继续跟，没在底上就是
       * 读者要读历史——这条判据不会因为机器慢、补间长而失准。
       */
      jumped: (landed: number) => {
        written.current = landed
        pinnedHeight.current = viewport.scrollHeight()
        // 落定之后跟随意图就按位置定死：这一刻起它和「读者自己滚到这儿」没有区别。
        const next = nearBottom()
        following.current = next
        setPaused(!next)
        // 跳转期间攒下的那条落定定时器已经没有意义：它会在补间之后再把位置钉一次。
        clearSettle()
      },
    })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : undefined
    observer?.observe(scroller)
    const content = viewport.column
    if (content !== null) observer?.observe(content)
    return () => {
      clearSettle()
      releaseReader()
      control.current = null
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('scrollend', settle)
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('keydown', onKey)
      scroller.removeEventListener('pointerdown', onPointerDown)
      observer?.disconnect()
    }
  }, [end, viewport])

  // 换会话（含首屏）那一拍先重新钉住底部，再照常跟：这一条声明在上面那个滚动监听
  // 效果**之后**，顺序有讲究——监听效果刚按当前位置（打开会话时是 scrollTop=0）
  // 判过「暂停」，这条要盖住它。
  //
  // 2026-11-10 从 useEffect 换成 useLayoutEffect：新增内容一提交就钉，钉在浏览器绘制之前。
  // useEffect 等在绘制之后才跑，那一帧里新内容已经溢出到可视区下方，下一帧才被拽回来；
  // 换成布局效果后这一帧不存在了（贴底这件事不再依赖下一帧的定时器）。
  useLayoutEffect(() => {
    if (pinnedFor.current !== sessionKey) {
      pinnedFor.current = sessionKey
      // 换会话这一拍若还有跳轮补间在跑，先停掉。`.chat` 由布局层画、切会话时原地复用，
      // `attach()` 看到容器没换就直接早退、不会 detach→stopTween，于是补间会跨会话活
      // 下来：这一拍「钉底」被上面的 `motionActive()` 挡住，补间收尾的 `jumped()` 又拿
      // 旧会话的落点去问新会话该不该跟随——新会话停在半路、胶囊亮着（审查 2026-11-12）。
      viewport.cancelMotion()
      following.current = true
      setPaused(false)
    }
    if (!following.current) return
    // 补间在跑（读者刚点了刻度）：这一拍钉底会把跳转按回 floor，还会顺手把补间掐掉，
    // 表现是「贴底点早轮刻度，恰好撞上新条目落地，点了没反应」（审查 2026-11-12）。
    // 落点由补间收尾的 `jumped` 按位置重算，这里不用补这一下。
    if (viewport.motionActive()) return
    control.current?.pin()
  }, [sessionKey, end, dep])

  const resume = (): void => {
    following.current = true
    setPaused(false)
    control.current?.pin()
  }

  /**
   * 暂停跟随（「加载更早」在放页时调）。
   *
   * 只等滚动事件判有一个缝：放页后的那一下补偿是程序性滚动，它引发的 scroll 事件
   * 下一帧才到，而流式内容可能先到一步把这口 delta 接上——跟随要是还开着，视角就被
   * 拽回底部，刚补好的阅读位置全毁。这里直接表态「不跟了」，缝就没了。
   */
  const pause = (): void => {
    control.current?.stop()
  }

  return { setEnd, end, paused, resume, pause }
}
