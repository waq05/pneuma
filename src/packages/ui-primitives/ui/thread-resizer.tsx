/**
 * 中间正文列两侧的拖拽条（桌面渲染层 `ThreadResizer.tsx` 的同构移植）：
 * 向外拖对称变宽、向内拖变窄，双击复位成样式表默认的列宽（96ch）。
 *
 * 宽度只写一个 CSS 变量 `--dsc-thread-max`——正文、审批卡、输入框三处都读它
 * （legacy/views.css 里三处 max-width），所以打字的地方和读字的地方永远同宽。
 * 拖动中只改变量、不动 React 状态，松手才落盘，避免每帧重渲染整棵树。
 *
 * 把手贴着正文列（`.chat-inner`）真正渲染出来的左右边缘：量一次真实矩形把左右缘
 * 写进两个变量，样式表只管摆位（在另一层里重算居中等于把布局抄第二遍）。
 *
 * 纵向只铺**会话区**：底边停在输入区（`.composer-zone`）上沿，不伸进输入区。整层的下半截
 * 从分支钮那一行开始就是输入区（往下还有审批卡、队列条、输入卡片与状态栏），那一带不能用
 * 鼠标拖着改列宽——把手铺到那里会画出一条与分支钮、输入框并排的竖条，看着像它们的一部分。
 * 距离同样是量出来的（层底到 `.composer-zone` 上沿），因为输入框会随输入行数长高、
 * 上方还会插进审批卡与队列条，高度不是写死的数。
 *
 * @module dsc-ui-shell/platform/thread-resizer
 */
import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createT } from '@dsc/ui-core'
import { THREAD_EDGE_BUDGET, THREAD_MIN, readRightRailPx, setRootVar, useWidthDrag } from './panels'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui-core` 的 `createT`）。 */
const t = createT({ zh, en })

/** 正文列左右缘相对本层左缘的像素，写进这两个变量（见文件头：量出来比算出来稳）。 */
const COL_START_VAR = '--dsc-thread-col-start'
const COL_END_VAR = '--dsc-thread-col-end'

/** 把手底边离本层底缘的像素 = 层底到输入框上沿的距离（样式表拿它当 `bottom`）。 */
const HANDLE_BOTTOM_VAR = '--dsc-thread-handle-bottom'

/**
 * 抓手留在会话区里的最小高度（px）：窗口矮到输入框顶满整层时，至少还抓得着一条。
 * 不是审美参数——`bottom` 越过 `top` 会让盒子高度算成负的，热区直接消失，列宽就再也拖不动。
 */
const HANDLE_MIN_H = 48

export function ThreadResizer(props: {
  /** 已存档的列宽（px）。null = 还没拖过，用样式表默认的列宽。 */
  width: number | null
  /** 松手落盘（px）。 */
  onCommit(px: number): void
  /** 双击复位：删掉存档，回到样式表默认的列宽。 */
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

  /**
   * 量一次本层里的两个几何：正文列的左右缘（相对本层左缘）与输入区上沿（相对本层底缘），
   * 写进变量给两条把手用。
   *
   * 两件事互不依赖，所以输入区那一半排在前头：轨迹页没有 `.chat-inner`（它自己画 `.trace-page`），
   * 列缘量不到时也不该把「底边停在哪」一起落下。
   */
  const measure = useCallback((): void => {
    const zone = zoneOf()
    if (zone === null) return
    const zoneBox = zone.getBoundingClientRect()

    // 底边停在输入区（`.composer-zone`）上沿：那一格里从分支钮那一行开始，往下还有审批卡、
    // 队列条、输入卡片与状态栏，全都不是「会话区」。量不出来（页模式没有输入区、或它被隐藏成
    // 0 高）就撤掉变量，退回老行为——铺满整层。
    const dock = zone.querySelector<HTMLElement>('.composer-zone')
    const dockBox = dock === null ? null : dock.getBoundingClientRect()
    if (dockBox === null || dockBox.height === 0) {
      zone.style.removeProperty(HANDLE_BOTTOM_VAR)
    } else {
      const gap = zoneBox.bottom - dockBox.top
      zone.style.setProperty(
        HANDLE_BOTTOM_VAR,
        `${String(Math.round(Math.min(Math.max(gap, 0), zoneBox.height - HANDLE_MIN_H)))}px`,
      )
    }

    const column = zone.querySelector<HTMLElement>('.chat-inner')
    if (column === null) return
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
    // 输入区自己长高（多行输入、审批卡与队列条插进来）时，本层尺寸可以一点不变
    // （正文让出高度就够），所以它也得单独盯：不盯的话把手底边停在旧位置，重新压回输入区。
    // 盯的是 `.composer-zone` 而不是里面的 `.composer`：前者把分支钮、审批卡、队列条与状态栏
    // 一并算进高度，任何一种插进来它都变，一处盯完。
    const dock = zone.querySelector<HTMLElement>('.composer-zone')
    if (dock !== null) observer.observe(dock)
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
  // 变量名是 --dsc-thread-user-max：.thread-main-empty 那条元素级 --dsc-thread-max
  // 会压过根上的同名变量（空会话里拖动失效的根因），两层都引用这个用户变量。
  const onDrag = useCallback(
    (px: number): void => {
      setRootVar('--dsc-thread-user-max', `${px}px`)
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
        data-tip={t('primitives.thread.handleTip')}
        onPointerDown={left.onPointerDown}
        onPointerMove={left.onPointerMove}
        onPointerUp={left.onPointerUp}
        onPointerCancel={left.onPointerCancel}
        onDoubleClick={props.onReset}
      />
      <div
        className="thread-handle"
        data-side="right"
        data-tip={t('primitives.thread.handleTip')}
        onPointerDown={right.onPointerDown}
        onPointerMove={right.onPointerMove}
        onPointerUp={right.onPointerUp}
        onPointerCancel={right.onPointerCancel}
        onDoubleClick={props.onReset}
      />
    </>
  )
}
