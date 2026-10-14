/**
 * 「停 500ms 出卡、移开 1s 后收」的悬停计时（出卡的 500ms 照 dsh HoverCard 的节奏；
 * 收卡的 1s 是**本壳有意分道**，见下）。轮尾「文件已更改」卡的文件行与正文里的文件
 * 提及 chip 两处共用同一份；收卡的延迟同时留出「把鼠标移进卡里读 diff」的间隙——
 * 移进去了 keep() 就续命，读完移开再由卡自己那条 mouseleave 起同一条倒计时。
 *
 * 为什么收卡不是参考实现的 100ms（2026-10-14 用户报的）：预览卡是一块能读的 diff，
 * 100ms 让「从行上挪进卡里」几乎来不及——手一抖卡就没了；用户要的是「鼠标移出预览
 * 1 秒才收」。旧渲染层那份仍是 100ms（冻结不动），这条差异只在壳侧。
 *
 * @module dsc-ui-shell/platform/hover-delay
 */
import { useEffect, useRef, useState } from 'react'

/** 悬停多久才出卡（ms）：短了划过就闪，长了像坏了。 */
const HOVER_DELAY_MS = 500
/** 移开多久后收卡（ms）：1 秒（用户口径：鼠标移出预览 1s 才收）。 */
const HOVER_CLOSE_MS = 1000

/** 出卡后挂在 state 上的三样：悬停对象、触发元素的矩形、预览卡的基准宽度。 */
export interface HoverState<T> {
  item: T
  anchor: DOMRect
  cardWidth: number
}

export function useHoverDelay<T>(): {
  hover: HoverState<T> | null
  /** 元素上停下来了：起出卡计时（已有的收卡倒计时一并取消）。 */
  arm: (item: T, anchor: DOMRect, cardWidth?: number) => void
  /** 鼠标移开：起收卡倒计时（行上移开、鼠标离开卡，都走这一条）。 */
  disarm: () => void
  /** 鼠标进了卡里：取消收卡倒计时。 */
  keep: () => void
  /** 立刻收卡（Esc / 换行）。 */
  close: () => void
} {
  const [hover, setHover] = useState<HoverState<T> | null>(null)
  const armRef = useRef<number | null>(null)
  const closeRef = useRef<number | null>(null)
  const clearArm = (): void => {
    if (armRef.current !== null) {
      window.clearTimeout(armRef.current)
      armRef.current = null
    }
  }
  const clearClose = (): void => {
    if (closeRef.current !== null) {
      window.clearTimeout(closeRef.current)
      closeRef.current = null
    }
  }
  useEffect(
    () => () => {
      clearArm()
      clearClose()
    },
    [],
  )
  const arm = (item: T, anchor: DOMRect, cardWidth = 520): void => {
    clearArm()
    clearClose()
    armRef.current = window.setTimeout(() => setHover({ item, anchor, cardWidth }), HOVER_DELAY_MS)
  }
  const disarm = (): void => {
    clearArm()
    clearClose()
    closeRef.current = window.setTimeout(() => setHover(null), HOVER_CLOSE_MS)
  }
  return {
    hover,
    arm,
    disarm,
    keep: clearClose,
    close: (): void => {
      clearArm()
      clearClose()
      setHover(null)
    },
  }
}
