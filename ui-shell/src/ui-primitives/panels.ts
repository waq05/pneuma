/**
 * 面板尺寸与拖拽（桌面渲染层 `panels.ts` 的同构移植）：
 * 侧栏宽度、停靠面板宽度、中间对话列宽——三项都能用鼠标拖，拖完的值存在 localStorage，
 * 同时**镜像一份到 `~/.dsc/settings.json`**（`ui.panelWidths`）。
 *
 * 为什么要那份镜像：宿主每次启动、每次切工作目录都会换一个端口（`ui-server` 的
 * `port ?? 0`），而 localStorage 按源隔离——换端口就是一份空存储，光靠它的话用户拖出来的
 * 宽度每次重开都回默认（用户报障 2026-10-29）。外观镜像踩过同一个坑，处理办法一样：
 * 宿主那份当真值，localStorage 只当同一源内的快速读写层。
 *
 * 键名两边一套：localStorage 用 `dsc.sidebarWidth` 这批（与旧桌面渲染层共用，切界面宽度
 * 能延续），settings.json 用短键 `sidebar` / `thread` / `dock` / `diff` / `collapsed`。
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
  return readRootPx('--dsc-jump-lane', 36) + readRootPx('--dsc-scrollbar-w', 5)
}
/** 读档时的宽度天花板。真正的上限是当时的窗口宽，拖的时候现场算；这里只挡住存坏的脏值。 */
export const STORED_MAX = 3200

/** 各值在 localStorage 里的键（与桌面渲染层同名同义）。 */
export const PANEL_KEYS = {
  sidebarWidth: 'dsc.sidebarWidth',
  sidebarCollapsed: 'dsc.uiSidebarCollapsed',
  threadWidth: 'dsc.threadWidth',
  dockWidth: 'dsc.dockWidth',
  // 并排审查面板的宽度（旧渲染层 DiffPane 同一键：两个界面共享用户拖过的宽度）
  diffPaneWidth: 'dsc.diffPaneWidth',
} as const

/**
 * 宿主那份几何的形状（`~/.dsc/settings.json` 的 `ui.panelWidths`，与契约
 * `PanelWidthsView` 同形）。只列这五个键：面板以外的东西不归这里管。
 */
export type PanelGeometry = Partial<Record<'sidebar' | 'thread' | 'dock' | 'diff', number>> & {
  collapsed?: boolean
}

/**
 * 启动那一刻从地址里带过来的几何（`?panels=sidebar:320,dock:640,collapsed:1`）。
 *
 * 为什么还要这一份：宿主冷启动时数据通道未必就绪，启动时那次 `getUiPrefs` 可能超时，
 * 首帧就只能画默认宽——用户看到的就是「又回默认了」。桌面主进程读的是同一份
 * settings.json，它把值拼在地址里，这一份同步可得，首帧不必赌网络。
 * 只在模块求值时读一次：之后一律以 localStorage（最新）与宿主回读为准。
 */
const bootGeometry: Record<string, number | boolean> = (() => {
  const out: Record<string, number | boolean> = {}
  if (typeof window === 'undefined') return out
  const raw = new URLSearchParams(window.location.search).get('panels')
  if (raw === null) return out
  for (const part of raw.split(',')) {
    const [key = '', value = ''] = part.split(':')
    if (key === 'collapsed') {
      if (value === '1') out.collapsed = true
      continue
    }
    const px = Number(value)
    if (Number.isFinite(px) && (key === 'sidebar' || key === 'thread' || key === 'dock' || key === 'diff')) {
      out[key] = px
    }
  }
  return out
})()

/** 一处几何值：localStorage 键 → 宿主键（两边一一对应，宿主那份用短名）。 */
const HOST_KEY_OF: Readonly<Record<string, keyof PanelGeometry>> = {
  [PANEL_KEYS.sidebarWidth]: 'sidebar',
  [PANEL_KEYS.threadWidth]: 'thread',
  [PANEL_KEYS.dockWidth]: 'dock',
  [PANEL_KEYS.diffPaneWidth]: 'diff',
  [PANEL_KEYS.sidebarCollapsed]: 'collapsed',
}

/**
 * 宿主那份几何的内存副本：启动时由 {@link primePanelGeometry} 灌进来，
 * 之后每次落盘就地更新——写的时候要发整份（宿主是「整键替换」的补丁语义）。
 */
let remembered: Record<string, number | boolean> = {}

/** 落盘的出口（由壳入口注册；没注册时只写 localStorage）。 */
let saver: ((geometry: PanelGeometry) => void) | null = null

/**
 * 灌入宿主那份几何。启动时调一次，之后由写入路径自己维护。
 *
 * @param values 宿主 `getUiPrefs().panelWidths`；空对象 = 没拖过任何一项
 */
export function primePanelGeometry(values: PanelGeometry): void {
  remembered = { ...values }
}

/**
 * 注册落盘出口。壳入口接到宿主通道后调一次，把整份几何交给 `setUiPrefs`。
 *
 * @param fn 收到的是**整份**几何（不是单个键），因为宿主补丁是整键替换
 */
export function setPanelGeometrySaver(fn: ((geometry: PanelGeometry) => void) | null): void {
  saver = fn
}

/**
 * 把一次改动记进内存副本并发给宿主。没注册出口、或不是面板的键就只留在内存里。
 *
 * @param key localStorage 键
 * @param value 新值；null = 复位（这一项从此用样式表默认）
 */
function remember(key: string, value: number | boolean | null): void {
  const hostKey = HOST_KEY_OF[key]
  if (hostKey === undefined) return
  if (value === null) delete remembered[hostKey]
  else remembered[hostKey] = value
  saver?.({ ...remembered } as PanelGeometry)
}

/**
 * 读一个存过的面板宽度：先问 localStorage（同源内的最新值），没有再问宿主那份
 * （跨宿主重启的那份）。没存过、存坏、或落在区间外都算没有。
 */
export function readStoredPx(key: string, min: number, max: number): number | null {
  const valid = (px: number): boolean => Number.isFinite(px) && px >= min && px <= max
  try {
    const raw = localStorage.getItem(key)
    // 存坏了（手改、旧版本残留）不算「有值」：接着问宿主那份，别让一条脏键把好的挡住。
    if (raw !== null) {
      const px = Number(raw)
      if (valid(px)) return px
    }
  } catch {
    // 隐私模式读不了；往下走宿主那份。
  }
  const hostKey = HOST_KEY_OF[key]
  if (hostKey === undefined) return null
  const fromBoot = bootGeometry[hostKey]
  if (typeof fromBoot === 'number' && valid(fromBoot)) return fromBoot
  const fallback = remembered[hostKey]
  return typeof fallback === 'number' && valid(fallback) ? fallback : null
}

/** 落盘一个面板宽度；传 null 表示复位（删键，回到样式表默认宽）。 */
export function writeStoredPx(key: string, px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(px))
  } catch {
    // 隐私模式或配额满都会抛；宿主那份照记，下次启动仍能读回来。
  }
  remember(key, px)
}

/** 读一个开关（侧栏收起状态）：localStorage 里有这个键就以它为准，否则看宿主那份。 */
export function readStoredFlag(key: string): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) return raw === '1'
  } catch {
    // 读不了就落到宿主那份。
  }
  const hostKey = HOST_KEY_OF[key]
  if (hostKey === undefined) return false
  const fromBoot = bootGeometry[hostKey]
  if (typeof fromBoot === 'boolean') return fromBoot
  const fallback = remembered[hostKey]
  return typeof fallback === 'boolean' ? fallback : false
}

/** 落盘一个开关。 */
export function writeStoredFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // 写不进去就算了，宿主那份还会记一笔。
  }
  remember(key, on)
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
