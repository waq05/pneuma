/**
 * 界面壳的应用骨架：侧栏 + 主区（顶栏 / 消息流 / 输入区 / 状态栏）+ 诊断区。
 *
 * **这一层的 class 名与嵌套是照旧桌面界面 `App.tsx` 写的**，所以壳自己一行样式都不用写：
 * `.app`（flex 行）→ `.sidebar` + `.main`（flex 列）→ `.topbar` / `.thread-zone` /
 * `.statusbar` 全部吃 `legacy/views.css` 里现成的规则。壳新增的东西（诊断面板、宿主
 * 异常条、数据通道状态）写在 `styles.css` 里，与旧界面那套一眼能分开。
 *
 * 为什么槽条目要做成 `display:contents`（见 `styles.css`）：旧界面的布局规则全是按
 * **直接子节点**写的——侧栏是 flex 列、聊天区是 flex 列、输入区靠 `.composer-zone > *`
 * 定宽。壳为了给每个条目套错误边界必须多包一层 div，那一层会把上面这些规则全部挡掉。
 * `display:contents` 让这一层不生成盒子，插件放进去的东西就等于直接挂在外壳里。
 *
 * @module dsc-ui-shell/app
 */
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { UiBootGraph, UiPluginLoadReport } from '@dsc/ui-core'
import { NATIVE_BRIDGE_VERSION, NATIVE_OPS } from '@dsc/ui-core'
import { IconSidebar } from './icons'
import { ALLOWED_MODULES } from './boot'
import { useChannelStatus, useHostError, useHostHello, useHostSelector } from './runtime-context'
import { SlotOutlet, useSlotFaults } from './slots-react'
import { SLOT } from './slots'
import { getHostNative, setDockPanel, useDockPanel, type UiSlots } from './plugin-api'
import { ThreadResizer } from './platform/thread-resizer'
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  PANEL_KEYS,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  STORED_MAX,
  THREAD_MIN,
  readStoredFlag,
  readStoredPx,
  readSidebarDefaultPx,
  setRootVar,
  useWidthDrag,
  writeStoredFlag,
  writeStoredPx,
} from './platform/panels'

/** 应用参数。 */
export interface AppProps {
  slots: UiSlots
  boot: UiBootGraph
  reports: readonly UiPluginLoadReport[]
}

export function App({ slots, boot, reports }: AppProps): ReactNode {
  const failed = reports.filter((report) => !report.ok)
  const dockPanel = useDockPanel()
  const dockOn = dockPanel !== null
  // 空会话走 `.thread-main-empty`：欢迎文案与输入框垂直居中成一组（legacy 现成规则）。
  const hasEntries = useHostSelector(readHasEntries)

  // ── 面板几何（对齐桌面端 panels.ts 的三件事：侧栏宽、正文列宽、dock 宽）────────
  // 宽度只写 CSS 变量/行内样式，存档走 localStorage（与桌面渲染层共用同一批键）。
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() =>
    readStoredPx(PANEL_KEYS.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    readStoredFlag(PANEL_KEYS.sidebarCollapsed),
  )
  const [threadWidth, setThreadWidth] = useState<number | null>(() =>
    readStoredPx(PANEL_KEYS.threadWidth, THREAD_MIN, STORED_MAX),
  )
  const [dockWidth, setDockWidth] = useState<number>(() =>
    readStoredPx(PANEL_KEYS.dockWidth, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH) ?? DOCK_DEFAULT_WIDTH,
  )

  useEffect(() => {
    setRootVar('--dsc-sidebar-w', sidebarWidth === null ? null : `${String(sidebarWidth)}px`)
  }, [sidebarWidth])
  useEffect(() => {
    setRootVar('--dsc-dock-w', `${String(dockWidth)}px`)
  }, [dockWidth])
  useEffect(() => {
    // 正文列宽只有 ThreadResizer 的拖动路径会每帧写变量；这里负责把存档在启动时铺上。
    if (threadWidth !== null) setRootVar('--dsc-thread-max', `${String(threadWidth)}px`)
    return () => setRootVar('--dsc-thread-max', null)
  }, [threadWidth])

  const commitSidebarWidth = (px: number | null): void => {
    setSidebarWidth(px)
    writeStoredPx(PANEL_KEYS.sidebarWidth, px)
  }
  const commitThreadWidth = (px: number): void => {
    setThreadWidth(px)
    writeStoredPx(PANEL_KEYS.threadWidth, px)
  }
  const resetThreadWidth = (): void => {
    setThreadWidth(null)
    writeStoredPx(PANEL_KEYS.threadWidth, null)
  }
  const commitDockWidth = (px: number): void => {
    setDockWidth(px)
    writeStoredPx(PANEL_KEYS.dockWidth, px)
  }

  // 侧栏开合（Ctrl/Cmd+B）：完全收起，展开钮留在顶栏。
  const toggleSidebar = (): void => {
    setSidebarCollapsed((current) => {
      writeStoredFlag(PANEL_KEYS.sidebarCollapsed, !current)
      return !current
    })
  }

  // 全局快捷键（对齐桌面端）：Ctrl/Cmd+B 侧栏、Ctrl+P 文件面板、Ctrl+` 终端面板。
  // 插件（侧栏品牌行的折叠钮）经 window 事件请求折叠——壳是布局真源。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      if (event.key === 'b' || event.key === 'B') {
        event.preventDefault()
        toggleSidebar()
      } else if (event.key === 'p' || event.key === 'P') {
        event.preventDefault()
        setDockPanel('files')
      } else if (event.key === '`') {
        event.preventDefault()
        setDockPanel('terminal')
      }
    }
    const onToggle = (): void => toggleSidebar()
    window.addEventListener('keydown', onKey)
    window.addEventListener('shell.sidebar.toggle', onToggle)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('shell.sidebar.toggle', onToggle)
    }
  }, [])

  // dock 左缘拖宽：mousedown 后挂 window 监听，夹在 [300, 820]，双击复位 420（对齐桌面端）。
  const startDockResize = (event: ReactMouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = dockWidth
    const onMove = (move: MouseEvent): void => {
      commitDockWidth(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, startWidth - (move.clientX - startX))))
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  // 侧栏右缘拖宽（200–420，双击复位成样式表默认）。
  const sidebarDrag = useWidthDrag({
    sign: 1,
    getBase: () => sidebarWidth ?? readSidebarDefaultPx(),
    clamp: (px) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)),
    onDrag: (px) => setRootVar('--dsc-sidebar-w', `${String(px)}px`),
    onCommit: (px) => commitSidebarWidth(px),
  })

  return (
    <>
      <div className="app" data-sidebar={sidebarCollapsed ? '0' : '1'}>
        <aside className="sidebar" aria-hidden={sidebarCollapsed || undefined}>
          <div className="sidebar-header">
            <span className="brand">{boot.host.name}</span>
            <button
              type="button"
              className="icon-btn"
              title="收起侧栏（Ctrl+B）"
              aria-label="收起侧栏"
              onClick={toggleSidebar}
            >
              <IconSidebar size={16} />
            </button>
            <ChannelState />
          </div>
          <SlotOutlet slots={slots} slot={SLOT.sidebar} />
          <div
            className="sidebar-resizer"
            data-tip="拖拽调整侧栏宽度，双击复位"
            onPointerDown={sidebarDrag.onPointerDown}
            onPointerMove={sidebarDrag.onPointerMove}
            onPointerUp={sidebarDrag.onPointerUp}
            onPointerCancel={sidebarDrag.onPointerCancel}
            onDoubleClick={() => commitSidebarWidth(null)}
          />
        </aside>

        <div className="main">
          {/* 窗口控件条占位（旧界面同一行）：最小化/最大化/关闭画在窗口右上，
              顶栏的内容从这行**下面**开始，不会被原生控件盖住。 */}
          <div className="caption-bar" aria-hidden="true" />
          <div className="topbar">
            <div className="topbar-title-row">
              {sidebarCollapsed ? (
                <button
                  type="button"
                  className="icon-btn"
                  title="展开侧栏（Ctrl+B）"
                  aria-label="展开侧栏"
                  onClick={toggleSidebar}
                >
                  <IconSidebar size={16} />
                </button>
              ) : null}
              <span className="title">
                <SessionTitle />
              </span>
              <div className="drag-fill" />
              <SlotOutlet slots={slots} slot={SLOT.header} />
              <span className="shell-build" data-boot-rev={boot.rev}>
                {boot.host.version}
              </span>
            </div>
          </div>

          <HostErrorStrip />

          <div className="thread-zone" {...(dockOn ? { 'data-dock': '1' } : {})}>
            <div className={hasEntries ? 'thread-main' : 'thread-main thread-main-empty'}>
              <div className="chat-wrap">
                <div className="chat">
                  <div className="chat-inner">
                    <SlotOutlet slots={slots} slot={SLOT.main} />
                  </div>
                </div>
              </div>
              <div className="composer-zone">
                <SlotOutlet slots={slots} slot={SLOT.composer} />
              </div>
            </div>
            <ThreadResizer width={threadWidth} onCommit={commitThreadWidth} onReset={resetThreadWidth} />
            {/* 停靠面板：**常驻渲染**（对齐桌面端「收起=滑出右缘不卸载」——终端进程、
                文件树滚动位都活着），收起时用 CSS 藏掉、不在布局里占位。 */}
            <div className="dock-slot" data-open={dockOn ? '1' : '0'} aria-hidden={dockOn ? undefined : 'true'}>
              {dockOn ? (
                <div
                  className="dock-resizer"
                  data-tip="拖拽调整面板宽度，双击复位"
                  onMouseDown={startDockResize}
                  onDoubleClick={() => commitDockWidth(DOCK_DEFAULT_WIDTH)}
                />
              ) : null}
              <SlotOutlet slots={slots} slot={SLOT.dock} />
            </div>
          </div>

          <div className="statusbar">
            <SlotOutlet slots={slots} slot={SLOT.statusbar} />
          </div>
        </div>

        {/* 播报区用旧界面的浮层容器（`.dsc-toasts`），空着时它自己不可见。 */}
        <div className="dsc-toasts">
          <SlotOutlet slots={slots} slot={SLOT.notice} />
        </div>
      </div>

      <Diagnostics slots={slots} boot={boot} reports={reports} failed={failed.length} />
    </>
  )
}

/** 顶栏标题：当前会话的显示名；找不到就说「新会话」（旧界面同一口径）。 */
function SessionTitle(): ReactNode {
  const title = useHostSelector(readSessionTitle)
  return <>{title}</>
}

/**
 * 宿主那一侧的异常（帧造不出来、或凭据失效）。
 *
 * 为什么单独占一行：帧流一旦停住，界面会「静静地冻在最后一帧」，看不出是宿主的问题；
 * 把原因摊出来，用户才知道该刷新还是该重启宿主。正常时不占位置。
 */
function HostErrorStrip(): ReactNode {
  const error = useHostError()
  if (error === null) return null
  return (
    <p className="host-error" data-host-error="1">
      宿主状态异常：{error}
    </p>
  )
}

/** 侧栏头上的数据通道状态：通不通、协议版本、放行了多少方法。 */
function ChannelState(): ReactNode {
  const status = useChannelStatus()
  const hello = useHostHello()
  const text =
    status === 'open'
      ? '已连接'
      : status === 'connecting'
        ? '连接中…'
        : '已断开（请用宿主新打印的地址重开）'
  return (
    <span
      className="channel-state"
      data-channel={status}
      data-protocol={hello?.protocolVersion ?? ''}
      data-tip={
        hello === null
          ? '还没拿到宿主握手'
          : `协议 v${String(hello.protocolVersion)}，放行 ${String(hello.methods.length)} 个方法`
      }
    >
      {text}
    </span>
  )
}

/** 诊断区：清单里有什么、谁装上了、谁没起来、哪一块崩了、壳放行的模块有哪些。
 *
 * 默认**不渲染**（旧界面没有这个东西，用户视野里不该有一行开发者读数）；
 * 有插件装载失败或槽位故障时自动出现，`?diag=1` 强制常显（自检与排障用）——
 * 自检脚本 querySelector 读 `data-native` 行，隐藏的 DOM 照样命中，不受影响。 */
function Diagnostics({
  slots,
  boot,
  reports,
  failed,
}: {
  slots: UiSlots
  boot: UiBootGraph
  reports: readonly UiPluginLoadReport[]
  failed: number
}): ReactNode {
  const faults = useSlotFaults(slots)
  const [forced] = useState(() => new URLSearchParams(location.search).has('diag'))
  const native = getHostNative()
  const probe = useNativeProbe()
  if (!forced && failed === 0 && faults.length === 0) return null
  return (
    <details className="diagnostics" open={failed > 0 || faults.length > 0}>
      <summary>
        诊断（{reports.length} 个插件 / {slots.slots.length} 个槽
        {faults.length === 0 ? '' : ` / ${String(faults.length)} 处故障`}）
      </summary>
      <ul className="diag-plugins">
        {reports.map((report) => (
          <li key={report.id} className={report.ok ? 'ok' : 'bad'} data-plugin={report.id}>
            <code>{report.id}</code> {report.ok ? '已装上' : `失败：${report.error ?? '未知原因'}`}
            {report.name === undefined ? '' : `（${report.name}）`}
            {report.ok && (report.attempts ?? 1) > 1 ? `（重试 ${String(report.attempts)} 次才成功）` : ''}
          </li>
        ))}
        {reports.length === 0 ? <li className="empty">启动清单里没有插件</li> : null}
      </ul>
      {faults.length === 0 ? null : (
        <ul className="diag-plugins">
          {faults.map((fault, index) => (
            <li key={`${fault.slot}|${fault.id}|${String(index)}`} className="bad" data-fault={fault.slot}>
              <code>{fault.slot}</code>
              {fault.id === '' ? '' : ` / ${fault.id}`} 在
              {fault.phase === 'render' ? '渲染' : fault.phase === 'contribute' ? '贡献槽位' : '卸载'}时出错：
              {fault.error.message}
            </li>
          ))}
        </ul>
      )}
      <p className="diag-line">
        清单 {boot.rev}：{boot.entries.map((entry) => entry.id).join('、') || '空'}
      </p>
      <p className="diag-line">槽：{slots.slots.join('、') || '无'}</p>
      <p className="diag-line">放行的模块：{ALLOWED_MODULES.join('、')}</p>
      {/* 原生桥在不在：桌面窗口里有（走 preload 的 window.dscNative），浏览器里没有。
          写在诊断区是因为它决定了插件能不能做"打开路径/系统通知"这类事，而这件事
          只看代码看不出来（同一个壳两种载体）。 */}
      <p className="diag-line" data-native={native.available ? 'on' : 'off'} data-native-probe={probe.state}>
        原生桥：
        {native.available
          ? `v${String(native.version ?? '?')} 已就绪（${String(NATIVE_OPS.length)} 个操作：${NATIVE_OPS.join('、')}）`
          : '浏览器里没有（桌面窗口才有）'}
        {native.available && native.version !== null && native.version !== NATIVE_BRIDGE_VERSION
          ? ` ⚠ 版本对不上：这一版壳按 v${String(NATIVE_BRIDGE_VERSION)} 写，外壳的桥是 v${String(native.version)}（多半是壳产物没跟着外壳一起重建）`
          : ''}
        {probe.detail === '' ? '' : ` · ${probe.detail}`}
      </p>
    </details>
  )
}

/**
 * 原生桥的自检读数：**真的调一次**只读操作（`recentCwds`）看回不回得来。
 *
 * 为什么值得摆在诊断区：桥"在"与桥"通"是两件事——白名单装错了、主进程那一侧没注册、
 * preload 没挂上，都会表现成"界面上那个按钮点了没反应"。这里把结论直接写出来：
 * 桌面上应是「n 个最近工作区」，浏览器里应是桥那句"没有"的人话（也就是**降级路径真的走过**）。
 */
function useNativeProbe(): { state: 'pending' | 'ok' | 'off' | 'error'; detail: string } {
  const [probe, setProbe] = useState<{ state: 'pending' | 'ok' | 'off' | 'error'; detail: string }>({
    state: 'pending',
    detail: '',
  })
  useEffect(() => {
    const native = getHostNative()
    let alive = true
    void native
      .invoke<unknown>('recentCwds')
      .then((list) => {
        if (!alive) return
        setProbe({
          state: 'ok',
          detail: `试点 recentCwds 回了 ${String(Array.isArray(list) ? list.length : 0)} 个最近工作区`,
        })
      })
      .catch((error: unknown) => {
        if (!alive) return
        const message = error instanceof Error ? error.message : String(error)
        // 桥本来就不在（浏览器 / 远程壳）——那是**预期**，不是故障：降级路径就该长这样。
        setProbe(
          native.available
            ? { state: 'error', detail: `试点未通过：${message}` }
            : { state: 'off', detail: `降级正常：${message}` },
        )
      })
    return () => {
      alive = false
    }
  }, [])
  return probe
}

/** 当前会话的显示名：从会话列表里按 `status.sessionPath` 找。 */
function readSessionTitle(snapshot: Record<string, unknown> | null): string {
  const status = snapshot?.['status']
  const sessions = snapshot?.['sessions']
  if (typeof status !== 'object' || status === null || !Array.isArray(sessions)) return '新会话'
  const path = (status as Record<string, unknown>)['sessionPath']
  if (typeof path !== 'string') return '新会话'
  for (const item of sessions) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (record['id'] !== path) continue
    const title = record['title']
    return typeof title === 'string' && title !== '' ? title : '新会话'
  }
  return '新会话'
}

/** 消息流里有没有**对话内容**（含直播尾）：空会话的居中欢迎态靠它切换。
    开场 system 条目（会话标、「没有可用的模型端点」这类提示）不算——欢迎态自己把它们
    画成注脚；口径与消息流的欢迎态判定一致，两边不能各说各话。 */
function readHasEntries(snapshot: Record<string, unknown> | null): boolean {
  const entries = snapshot?.['entries']
  if (Array.isArray(entries) && entries.some((entry) => (entry as { kind?: unknown })['kind'] !== 'system')) {
    return true
  }
  const live = snapshot?.['liveEntries']
  return Array.isArray(live) && live.length > 0
}
