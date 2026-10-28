/**
 * 跟着底部的自动滚动：松手 / 只认自己的写 / 贴底门槛三条规矩（详见函数头）。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/follow
 */
import { useEffect, useRef, useState } from 'react'

/** 贴底判定（px）：与 dsh 的 `use-scroll-follow` 同一档（25px），差别只在取整。 */
const FOLLOW_BOTTOM_PX = 24

/** 位置落定的等待（ms）：dsh 是 500ms；壳里的手势距离都短，等太久反而像卡住。 */
const FOLLOW_SETTLE_MS = 180

/** 往上翻的键：只有「想回头读」才需要抢在内容增长前松手（往下滚到底不需要）。 */
const UP_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'PageUp', 'Home'])

/**
 * 跟着底部的自动滚动（对齐 dsh 的 `use-scroll-follow.ts` 与 `use-chat-reading.ts`）。
 *
 * 三条规矩，缺一条就会「粘滞」——明明往上滚了一段，下一口流式内容一到又被拽回底部：
 *
 * 1. **读者往回读就先松手**：往上滚的滚轮、`↑` / `PgUp` / `Home` 一到，跟随当场取消，
 *    不等滚动位置越过哪条线；等位置落定（`scrollend`，或 180ms 内没有新滚动）再按距离重判。
 *    只认「往上」：在底部往下滚时浏览器什么也不做，这时松手只会让下一口内容没人追。
 * 2. **只认自己的写**：钉底要写 `scrollTop`，它引发的 scroll 事件不能当成「读者动了」。
 *    记下每次写到哪儿，差在 1px 以内就当自己滚的（dsh 的 `movedByReader` 同一口径）。
 * 3. **贴底的门槛要近**：dsh 用 25px；壳原来写 160px，往上滚一小段仍算「在底部」，
 *    于是内容一长就把人拽回去，手感就是粘。
 *
 * 内容变长（新条目、流式正文、虚拟列表补挂）交给 `ResizeObserver`：只有跟随开着才钉底，
 * 读者在读的时候一个字都不动（dsh 的 `onResize` 也是这条）。
 *
 * @param dep 条目数：条目变了要重钉一次（ResizeObserver 之外的第二道保险）
 * @param sessionKey 换会话时重新起算（打开会话即锚在末尾）
 */
export function useFollowBottom(
  dep: number,
  sessionKey: string,
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
    const scroller = end?.closest('.chat')
    if (!(scroller instanceof HTMLElement)) return undefined
    const floor = (): number => Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    /**
     * 上一次钉底时的内容总高度。
     *
     * 为什么记它：内容自己变矮（工具卡跑完收起、步骤组收合、写前预览卡展开）时，
     * 浏览器会把 scrollTop 夹到新的上限，这也会发一条 scroll 事件——形状和「读者往上
     * 滚」一模一样。拿内容高度变没变来认它：变了就是内容驱动的，不判读者。
     * 不区分的话，每次内容重排都会误判一次「用户在看历史」，暂停跟随又把那颗
     * 「回到底部」胶囊翻出来，下一秒落定再收回去——流式输出时它就一直闪。
     */
    const pinnedHeight = { current: scroller.scrollHeight }
    const pin = (): void => {
      scroller.scrollTop = scroller.scrollHeight
      written.current = scroller.scrollTop
      pinnedHeight.current = scroller.scrollHeight
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
      if (following.current) {
        pin()
        return
      }
      if (floor() - scroller.scrollTop <= FOLLOW_BOTTOM_PX) {
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
      const top = scroller.scrollTop
      const heightChanged = pinnedHeight.current !== scroller.scrollHeight
      if (Math.abs(top - written.current) <= 1) {
        written.current = top
        if (heightChanged) pinnedHeight.current = scroller.scrollHeight
        return
      }
      if (heightChanged) {
        pinnedHeight.current = scroller.scrollHeight
        // 「高度变了」单独不算证据：流式输出时内容一直在长，读者的滚动也落在这个窗口里。
        // 真正的判据是**夹回底部**——内容变矮时浏览器把 scrollTop 夹到新上限，结果一定
        // 贴着新的底；读者往上滚不会贴着底。两条同时成立才认作内容驱动。
        if (floor() - top <= FOLLOW_BOTTOM_PX) {
          written.current = top
          // 已经在暂停态时仍排一次落定：内容变矮之后读者可能正好滚到了底，得让它有机会
          // 恢复跟随（跟随态不用排，`onResize` 会接着钉底）。
          if (!following.current) schedule()
          return
        }
      }
      written.current = top
      if (following.current) {
        following.current = false
        setPaused(true)
      }
      schedule()
    }
    /** 读者动手：先松手，不等这一下手势滚出多远。 */
    const onGesture = (): void => {
      following.current = false
      schedule()
    }
    const onWheel = (event: WheelEvent): void => {
      // 只认「往上滚」：在底部往下滚时浏览器什么也不做，这时若把跟随松掉，
      // 下一口流式内容就没人追了（点开工具卡、往下翻也一样，不该断跟随）。
      if (event.ctrlKey || event.deltaY >= 0) return
      onGesture()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (UP_KEYS.has(event.key)) onGesture()
    }
    /** 内容变长：跟随开着才追，读者在读就一动不动。 */
    const onResize = (): void => {
      if (!following.current) return
      if (floor() - scroller.scrollTop > 4) pin()
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
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : undefined
    observer?.observe(scroller)
    const content = scroller.firstElementChild
    if (content !== null) observer?.observe(content)
    return () => {
      clearSettle()
      control.current = null
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('scrollend', settle)
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('keydown', onKey)
      observer?.disconnect()
    }
  }, [end])

  // 换会话（含首屏）那一拍先重新钉住底部，再照常跟：这一条声明在上面那个滚动监听
  // 效果**之后**，顺序有讲究——监听效果刚按当前位置（打开会话时是 scrollTop=0）
  // 判过「暂停」，这条要盖住它。
  useEffect(() => {
    if (pinnedFor.current !== sessionKey) {
      pinnedFor.current = sessionKey
      following.current = true
      setPaused(false)
    }
    if (!following.current) return
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
