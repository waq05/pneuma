/**
 * 中间正文列两侧的拖拽条（桌面渲染层 `ThreadResizer.tsx` 的同构移植）：
 * 向外拖对称变宽、向内拖变窄，双击复位成样式表默认的 76ch。
 *
 * 宽度只写一个 CSS 变量 `--dsc-thread-max`——正文、审批卡、输入框三处都读它
 * （legacy/views.css 里三处 max-width），所以打字的地方和读字的地方永远同宽。
 * 拖动中只改变量、不动 React 状态，松手才落盘，避免每帧重渲染整棵树。
 *
 * 把手贴着正文列（`.chat-inner`）真正渲染出来的左右边缘：量一次真实矩形把左右缘
 * 写进两个变量，样式表只管摆位（在另一层里重算居中等于把布局抄第二遍）。
 *
 * @module dsc-ui-shell/platform/thread-resizer
 */
import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { THREAD_EDGE_BUDGET, THREAD_MIN, readRightRailPx, setRootVar, useWidthDrag } from './panels'

/** 正文列左右缘相对本层左缘的像素，写进这两个变量（见文件头：量出来比算出来稳）。 */
const COL_START_VAR = '--dsc-thread-col-start'
const COL_END_VAR = '--dsc-thread-col-end'

export function ThreadResizer(props: {
  /** 已存档的列宽（px）。null = 还没拖过，用样式表默认的 76ch。 */
  width: number | null
  /** 松手落盘（px）。 */
  onCommit(px: number): void
  /** 双击复位：删掉存档，回到 76ch。 */
  onReset(): void
}): ReactNode {
  /** 把想要的宽度夹成当前能生效的宽度。没存档时取「真实渲染出来的宽」。 */
  const resolve = (px: number | null): number => {
    const zone = leftRef.current?.parentElement ?? null
    if (zone === null) return THREAD_MIN
    const max = Math.max(THREAD_MIN, zone.clientWidth - THREAD_EDGE_BUDGET - readRightRailPx())
    if (px === null) {
      const column = zone.querySelector<HTMLElement>('.chat-inner')
      return Math.min(Math.max(column?.offsetWidth ?? THREAD_MIN, THREAD_MIN), max)
    }
    return Math.min(Math.max(px, THREAD_MIN), max)
  }

  // 本层（.thread-zone）是哪个元素：两条把手是它的直接子项，往上一格就是它。
  // React 的 layout 阶段是「子先于父」，父元素的 ref 可能还没挂上，所以从把手往上取。
  const leftRef = useRef<HTMLDivElement | null>(null)
  const zoneOf = useCallback((): HTMLElement | null => leftRef.current?.parentElement ?? null, [])

  /** 量一次正文列的两个边缘（相对本层的左缘），写进变量给两条把手用。 */
  const measure = useCallback((): void => {
    const zone = zoneOf()
    if (zone === null) return
    const column = zone.querySelector<HTMLElement>('.chat-inner')
    if (column === null) return
    const zoneBox = zone.getBoundingClientRect()
    const columnBox = column.getBoundingClientRect()
    zone.style.setProperty(COL_START_VAR, `${String(columnBox.left - zoneBox.left)}px`)
    zone.style.setProperty(COL_END_VAR, `${String(columnBox.right - zoneBox.left)}px`)
  }, [zoneOf])

  // 挂载后先量一次，然后跟着三路信号重量：根变量变化（MutationObserver）、
  // 正文列尺寸变化（ResizeObserver）、窗口 resize 兜底。三路都指向同一个 measure()。
  useLayoutEffect(() => {
    measure()
    const zone = zoneOf()
    if (zone === null) return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(zone)
    const column = zone.querySelector<HTMLElement>('.chat-inner')
    if (column !== null) observer.observe(column)
    const rootWatcher = new MutationObserver(measure)
    rootWatcher.observe(document.documentElement, { attributeFilter: ['style'], attributes: true })
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      rootWatcher.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure, zoneOf, props.width])

  const getBase = useCallback((): number => resolve(props.width), [props.width])
  const clamp = useCallback((px: number): number => resolve(px), [props.width])
  // 拖动中列宽每帧都在变，顺手重量一次，把手与列缘同帧对齐。
  const onDrag = useCallback(
    (px: number): void => {
      setRootVar('--dsc-thread-max', `${px}px`)
      measure()
    },
    [measure],
  )
  const shared = { getBase, clamp, onDrag, trackPointerY: true }
  const left = useWidthDrag({ ...shared, sign: -2, onCommit: props.onCommit })
  const right = useWidthDrag({ ...shared, sign: 2, onCommit: props.onCommit })

  return (
    <>
      <div
        ref={leftRef}
        className="thread-handle"
        data-side="left"
        data-tip="拖拽调整正文宽度，双击复位"
        onPointerDown={left.onPointerDown}
        onPointerMove={left.onPointerMove}
        onPointerUp={left.onPointerUp}
        onPointerCancel={left.onPointerCancel}
        onDoubleClick={props.onReset}
      />
      <div
        className="thread-handle"
        data-side="right"
        data-tip="拖拽调整正文宽度，双击复位"
        onPointerDown={right.onPointerDown}
        onPointerMove={right.onPointerMove}
        onPointerUp={right.onPointerUp}
        onPointerCancel={right.onPointerCancel}
        onDoubleClick={props.onReset}
      />
    </>
  )
}
