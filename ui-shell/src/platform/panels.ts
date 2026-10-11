/**
 * 面板尺寸与拖拽（桌面渲染层 `panels.ts` 的同构移植）：
 * 侧栏宽度、停靠面板宽度、中间对话列宽——三项都能用鼠标拖，拖完的值存在 localStorage。
 *
 * 为什么不写进 ~/.dsc/settings.json：那份文件存的是跨机器的用户偏好，而
 * 「这个窗口在这台机器上拖成多宽」属于窗口几何，留在本地。**localStorage 键与
 * 桌面渲染层共用同一批**（`dsc.sidebarWidth` / `dsc.threadWidth` / `dsc.dockWidth`）：
 * 桌面窗口与新壳加载的是同一个源（宿主伺服的页面），共用键意味着从旧界面切到壳
 * 时拖过的宽度延续，而不是两边各记一份。
 *
 * @module dsc-ui-shell/platform/panels
 */
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'

/** 侧栏拖拽下限：比样式表默认的 237px 再窄一点，容得下短工作区名。 */
export const SIDEBAR_MIN = 200
/** 侧栏拖拽上限：再宽就快把正文挤没了，要宽正文请用正文两侧的拖拽条。 */
export const SIDEBAR_MAX = 420

/** 中间列拖拽下限：480px 以下正文会窄到没法读。 */
export const THREAD_MIN = 480
/** 中间列两侧要留给拖拽条和 safe 区的宽度：24px 内缩 + 10px 热区，两边各一份，再留点余量。 */
export const THREAD_EDGE_BUDGET = 80
/** 停靠面板拖宽区间（与桌面渲染层同一组数字）。 */
export const DOCK_MIN_WIDTH = 300
export const DOCK_MAX_WIDTH = 820
export const DOCK_DEFAULT_WIDTH = 420
/**
 * 右缘那两条轨道占掉的宽度：回合刻度条的专属轨道（`--dsc-jump-lane`）加上竖向滚动条。
 * 数字从样式表现读（见 readRootPx），tokens.css 里改了轨道宽这里跟着变。
 */
export function readRightRailPx(): number {
  return readRootPx('--dsc-jump-lane', 32) + readRootPx('--dsc-scrollbar-w', 5)
}
/** 读档时的宽度天花板。真正的上限是当时的窗口宽，拖的时候现场算；这里只挡住存坏的脏值。 */
export const STORED_MAX = 3200

/** 各值在 localStorage 里的键（与桌面渲染层同名同义）。 */
export const PANEL_KEYS = {
  sidebarWidth: 'dsc.sidebarWidth',
  sidebarCollapsed: 'dsc.uiSidebarCollapsed',
  threadWidth: 'dsc.threadWidth',
  dockWidth: 'dsc.dockWidth',
} as const

/**
 * 读一个存过的面板宽度。没存过、存坏、或落在区间外都算没有。
 */
export function readStoredPx(key: string, min: number, max: number): number | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const px = Number(raw)
    return Number.isFinite(px) && px >= min && px <= max ? px : null
  } catch {
    return null
  }
}

/** 落盘一个面板宽度；传 null 表示复位（删键，回到样式表默认宽）。 */
export function writeStoredPx(key: string, px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(px))
  } catch {
    // 隐私模式或配额满都会抛；大不了下次启动回到默认宽，不该打断拖动。
  }
}

/** 读一个开关（侧栏收起状态）。 */
export function readStoredFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/** 落盘一个开关。 */
export function writeStoredFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // 写不进去就算了，这只影响下次启动记不记得住。
  }
}

/** 往根元素上写一个 CSS 变量，把拖出来的宽度交给样式表；null = 撤掉行内值。 */
export function setRootVar(name: string, value: string | null): void {
  const root = document.documentElement
  if (value === null) root.style.removeProperty(name)
  else root.style.setProperty(name, value)
}

/** 读根元素上某个 CSS 变量的当前值（px 数），免得这里再抄一份常量。 */
export function readRootPx(name: string, fallback: number): number {
  const px = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(px) && px > 0 ? px : fallback
}

/** 侧栏的样式表默认宽（`--dsc-sidebar-w`，tokens.css 里是 237px）。 */
export function readSidebarDefaultPx(): number {
  return readRootPx('--dsc-sidebar-w', 237)
}

/** 一次拖拽宽度所需的全部回调，见 `useWidthDrag`。 */
export interface WidthDragOptions {
  /** 按下瞬间的基准宽度（px）。要取当时的真实生效值，别取一个猜的默认数。 */
  getBase(): number
  /** 鼠标向右移 1px，宽度变多少 px。侧栏分界线是 1；正文右侧拖拽条是 2，左侧是 -2。 */
  sign: number
  /** 把宽度夹进本面板允许的区间。 */
  clamp(px: number): number
  /** 拖动中的每一帧（已夹好）。 */
  onDrag(px: number): void
  /** 松手：把最终宽度落盘。 */
  onCommit(px: number): void
  /** 是否把鼠标竖向位置写进热区的 `--dsc-handle-y`，供高亮跟着走。默认不写。 */
  trackPointerY?: boolean
}

/** `useWidthDrag` 交回给热区的事件处理器。 */
export interface WidthDragHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void
  onPointerCancel(event: ReactPointerEvent<HTMLElement>): void
}

/**
 * 拖一条竖直边界改宽度：按下抓指针，移动回灌新宽度，松手落盘，取消则退回原宽。
 *
 * 用 Pointer Capture 而不是挂 window 监听：指针被这条热区攥住，拖出窗口再回来
 * 还在接着拖。移动按帧合并，一帧最多改一次宽度。拖动期间给 body 挂 `.resizing`
 * （锁光标、禁选中、关掉面板的宽度过渡——样式在 legacy/views.css）。
 */
export function useWidthDrag(options: WidthDragOptions): WidthDragHandlers {
  const base = useRef(0)
  const originX = useRef(0)
  const latestX = useRef(0)
  const dragging = useRef(false)
  const frame = useRef<number | null>(null)
  // 处理器要保持稳定，所以每次读最新的回调，而不是把回调闭进处理器里。
  const cb = useRef(options)
  cb.current = options

  const cancelFrame = (): void => {
    if (frame.current === null) return
    cancelAnimationFrame(frame.current)
    frame.current = null
  }
  const widthAt = (clientX: number): number =>
    cb.current.clamp(base.current + cb.current.sign * (clientX - originX.current))
  const release = (event: ReactPointerEvent<HTMLElement>): void => {
    dragging.current = false
    cancelFrame()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.currentTarget.toggleAttribute('data-dragging', false)
    document.body.classList.remove('resizing')
  }

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    base.current = cb.current.getBase()
    originX.current = event.clientX
    latestX.current = event.clientX
    dragging.current = true
    event.currentTarget.toggleAttribute('data-dragging', true)
    document.body.classList.add('resizing')
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (!dragging.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    latestX.current = event.clientX
    if (cb.current.trackPointerY === true) {
      const box = event.currentTarget.getBoundingClientRect()
      event.currentTarget.style.setProperty('--dsc-handle-y', `${event.clientY - box.top}px`)
    }
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      cb.current.onDrag(widthAt(latestX.current))
    })
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (!dragging.current) return
    // 只按了一下没拖动，就别用当时被窗口夹过的显示值去覆盖更宽的存档。
    const moved = event.clientX !== originX.current
    const px = widthAt(event.clientX)
    release(event)
    if (moved) cb.current.onCommit(px)
  }, [])

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (!dragging.current) return
    release(event)
    // 中途被打断：丢掉这一趟的拖动，回到已存档的宽度。
    cb.current.onDrag(cb.current.getBase())
  }, [])

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
