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
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { UiBootGraph, UiPluginLoadReport } from '@dsc/ui-core'
import { NATIVE_BRIDGE_VERSION, NATIVE_OPS } from '@dsc/ui-core'
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  IconBolt,
  IconChevronRight,
  IconFolder,
  IconGear,
  IconPlus,
  IconPuzzle,
  IconSidebar,
  PANEL_KEYS,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  STORED_MAX,
  THREAD_MIN,
  ThreadResizer,
  readStoredFlag,
  readStoredPx,
  readSidebarDefaultPx,
  setRootVar,
  useWidthDrag,
  writeStoredFlag,
  writeStoredPx,
} from '@dsc/ui-primitives'
import { Dock, dockActions, openDockTab, setDockSession, useDockReview, useDockSurface } from '@dsc/ui-dockkit'
// 过渡期的向上边：`boot`（平台模块白名单的读数）、`slots` / `slots-react`（E4 的槽位包）
// 与 `@dsc/ui`（宿主桥、页 / 视图真源）——E4 拆出渲染器与槽位包后应改成包名，见 ui-layout/index.ts。
import { ALLOWED_MODULES } from '../boot'
import { SLOT } from '../slots'
import { SlotOutlet, useSlotFaults } from '../slots-react'
import { getHostNative, setShellPage, setThreadView, useShellPage, useThreadView, type UiSlots } from '@dsc/ui'
import { useChannelStatus, useHostError, useHostHello, useHostSelector } from './runtime-context'
import { ReviewPane } from './review-pane'

/** 应用参数。 */
export interface AppProps {
  slots: UiSlots
  boot: UiBootGraph
  reports: readonly UiPluginLoadReport[]
}

export function App({ slots, boot, reports }: AppProps): ReactNode {
  const failed = reports.filter((report) => !report.ok)
  // 右侧栏布局（每会话一份，状态在 dock-state）；审查目标（并排栏）也住那儿。
  const surface = useDockSurface()
  const review = useDockReview()
  const sessionId = useHostSelector(readDockSessionId)
  // 主区整页（插件中心这类）：非 null 时顶栏与正文整块换成那一页（旧界面同构）。
  const page = useShellPage()
  // 正文区的两张脸：对话（消息流）/ 轨迹（执行过程）。轨迹激活时 `.chat-wrap` 整块
  // 换成 `shell.thread` 槽（输入区与状态栏照旧，旧界面同构）。
  const threadView = useThreadView()
  // 空会话走 `.thread-main-empty`：欢迎文案与输入框垂直居中成一组（legacy 现成规则）。
  const hasEntries = useHostSelector(readHasEntries)

  // 会话切换 → 右侧栏整份布局跟着换（旧桌面版 App 的同款接线：surface 按会话取）。
  // 新会话在首条消息落盘前没有 sessionId（null）——那时先切到空布局，Dock 不渲染。
  useEffect(() => {
    setDockSession(sessionId ?? '')
  }, [sessionId])
  // `?dock=1` 自检钩子：展开右侧栏停在「开始」页（会话 id 到了才开得动，排在后面）。
  const shotDock = useMemo(() => new URLSearchParams(location.search).has('dock'), [])
  useEffect(() => {
    if (!shotDock || sessionId === null) return
    openDockTab('guide')
  }, [shotDock, sessionId])

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
    // 正文列宽只有 ThreadResizer 的拖动路径会每帧写变量；这里负责把存档在启动时铺上。
    if (threadWidth !== null) setRootVar('--dsc-thread-max', `${String(threadWidth)}px`)
    return () => setRootVar('--dsc-thread-max', null)
  }, [threadWidth])

  // 窄屏（手机浏览器，含「手机端 remote-web 切壳」后的形态）：侧栏默认收起成 56px
  // 窄栏——展开态在窄屏下是浮层（styles.css 的窄屏段），正文拿全宽。
  // 只在**跨进窄屏**那一刻收一次：收不收的决定权随后仍在用户手里（Ctrl+B / 窄栏 logo）。
  useEffect(() => {
    const query = window.matchMedia('(max-width: 860px)')
    const apply = (): void => {
      if (query.matches) setSidebarCollapsed(true)
    }
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

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

  // 全局快捷键（对齐桌面版）：Ctrl/Cmd+B 侧栏、Ctrl+P 文件页签、Ctrl+` 终端页签、
  // Ctrl+T 浏览器页签。后三个开页 = 展开右侧栏 +（开始页还挂着时就地替换）——旧桌面版
  // 的 openDock 同一套接线。插件（侧栏品牌行的折叠钮）经 window 事件请求折叠——壳是布局真源。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod || event.altKey || event.shiftKey) return
      if (event.key === 'b' || event.key === 'B') {
        event.preventDefault()
        toggleSidebar()
      } else if (event.key === 'p' || event.key === 'P') {
        event.preventDefault()
        openDockTab('files')
      } else if (event.key === '`' || event.code === 'Backquote') {
        event.preventDefault()
        openDockTab('terminal')
      } else if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        openDockTab('browser')
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

  // 侧栏右缘拖宽（200–420，双击复位成样式表默认）。右侧栏的拖宽手柄在 Dock 组件里
  // （贴 aside 左缘的 `.dock-resizer`，旧桌面版同款）。
  const sidebarDrag = useWidthDrag({
    sign: 1,
    getBase: () => sidebarWidth ?? readSidebarDefaultPx(),
    clamp: (px) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)),
    onDrag: (px) => setRootVar('--dsc-sidebar-w', `${String(px)}px`),
    onCommit: (px) => commitSidebarWidth(px),
  })

  return (
    <>
      <div className="app" data-rail={sidebarCollapsed ? '1' : '0'}>
        <aside className={`sidebar${sidebarCollapsed ? ' rail' : ''}`}>
          {/* 品牌行（旧界面同款）：logo + 名字 + 行尾的收起钮。整行是窗口拖拽区
              （legacy `.sidebar-header`），按钮靠 `.rail-toggle` 自带 no-drag——没有
              这个类名点击会被当拖窗口吞掉（「点了没反应」的根因）。 */}
          <div
            className="sidebar-header"
            data-rail-hidden={sidebarCollapsed ? '1' : undefined}
            aria-hidden={sidebarCollapsed || undefined}
          >
            <img src="icon.png" alt="Muse Code" draggable={false} />
            <span className="brand">{boot.host.name}</span>
            <button
              type="button"
              className="icon-btn rail-toggle"
              data-tip="收起侧边栏，快捷键 Ctrl+B"
              title="收起侧栏（Ctrl+B）"
              aria-label="收起侧栏"
              onClick={toggleSidebar}
            >
              <IconSidebar size={15} />
            </button>
          </div>
          {/* 收起态：56px 图标窄栏（旧界面的 rail 分支），壳替插件画导航。 */}
          {sidebarCollapsed ? <SidebarRail onExpand={toggleSidebar} /> : null}
          {/* 插件的侧栏内容：收起时整块藏起来但不卸载（见 styles.css 的说明）；
              展开态经 display:contents 包装层直排进 .sidebar（与别处槽包装同一招）。 */}
          <div className="sidebar-slot" data-rail-hidden={sidebarCollapsed ? '1' : undefined}>
            <SlotOutlet slots={slots} slot={SLOT.sidebar} />
          </div>
          {sidebarCollapsed ? null : (
            <div
              className="sidebar-resizer"
              data-tip="拖拽调整侧栏宽度，双击复位"
              onPointerDown={sidebarDrag.onPointerDown}
              onPointerMove={sidebarDrag.onPointerMove}
              onPointerUp={sidebarDrag.onPointerUp}
              onPointerCancel={sidebarDrag.onPointerCancel}
              onDoubleClick={() => commitSidebarWidth(null)}
            />
          )}
        </aside>

        <div className="main">
          {/* 窗口控件条占位（旧界面同一行）：最小化/最大化/关闭画在窗口右上，
              顶栏的内容从这行**下面**开始，不会被原生控件盖住。整页模式也保留。 */}
          <div className="caption-bar" aria-hidden="true" />
          {page === null ? (
            <>
              <div className="topbar">
                <div className="topbar-title-row">
                  {/* 侧栏收起时不在这里放展开钮（旧界面顶栏没有它）：窄栏顶上那颗
                      logo 就是展开入口，Ctrl+B 也照旧。 */}
                  <span className="title">
                    <SessionTitle />
                  </span>
                  {/* 左簇：子智能体、智能体团队——旧界面它们跟在标题后面，与右侧的操作组隔一根弹性填充 */}
                  <div className="topbar-cluster">
                    <SlotOutlet slots={slots} slot={SLOT.headerLead} />
                  </div>
                  <div className="drag-fill" />
                  {/* 右簇：工作区打开组（在资源管理器打开 + 更多打开方式） */}
                  <SlotOutlet slots={slots} slot={SLOT.header} />
                  {/* 工作区面板开合钮：只在收起时出现（展开时由面板头条尾的收起钮管） */}
                  <DockToggle />
                </div>
                {/* 对话 / 轨迹页签（旧界面顶栏第二行同款）：两张脸共用正文位，
                    页签是显式入口——另一个入口是会话右键菜单的「查看轨迹」。 */}
                <nav className="tabs" role="tablist" aria-label="正文区视图">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={threadView === 'chat'}
                    className={threadView === 'chat' ? 'on' : ''}
                    onClick={() => {
                      setThreadView('chat')
                    }}
                  >
                    对话
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={threadView === 'trace'}
                    className={threadView === 'trace' ? 'on' : ''}
                    onClick={() => {
                      setThreadView('trace')
                    }}
                  >
                    轨迹
                  </button>
                </nav>
              </div>

              <HostErrorStrip />

              {/* 正文轨道 + 并排审查栏（旧界面 `.thread-zone[data-review]` 同构：
                  审查开着时正文让位，右缘的拖拽条一并让位）。 */}
              <div className="thread-zone" {...(review !== null ? { 'data-review': '1' } : {})}>
                <div
                  className={
                    // 空会话的垂直居中态只给对话页（旧界面 `tab !== 'trace' && empty` 同款）：
                    // 轨迹页有自己的空态文案，不该跟着输入框居中。
                    threadView === 'chat' && hasEntries ? 'thread-main' : threadView === 'chat' ? 'thread-main thread-main-empty' : 'thread-main'
                  }
                >
                  {threadView === 'trace' ? (
                    // 轨迹页（`shell.thread` 槽）：自己画 `.trace-page > .chat`，
                    // 输入区照旧跟在下面——两张脸在旧界面里就是这样的兄弟关系。
                    <SlotOutlet slots={slots} slot={SLOT.thread} />
                  ) : (
                    <div className="chat-wrap">
                      <div className="chat">
                        <div className="chat-inner">
                          <SlotOutlet slots={slots} slot={SLOT.main} />
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="composer-zone">
                    <SlotOutlet slots={slots} slot={SLOT.composer} />
                  </div>
                </div>
                {review === null ? (
                  <ThreadResizer width={threadWidth} onCommit={commitThreadWidth} onReset={resetThreadWidth} />
                ) : null}
                <ReviewPane />
              </div>
            </>
          ) : (
            // 整页模式（插件中心这类）：顶栏与正文整块换成页自己的，状态栏照旧占底部。
            <SlotOutlet slots={slots} slot={SLOT.page} />
          )}

          <div className="statusbar">
            <SlotOutlet slots={slots} slot={SLOT.statusbar} />
          </div>
        </div>

        {/* 右侧栏（dock）：**常驻挂载**（对齐旧桌面版「收起=滑出右缘不卸载」——终端进程、
            文件树滚动位都活着），布局随会话走；新会话在首条消息落盘前没有 id，先不挂。 */}
        {sessionId !== null ? <Dock width={dockWidth} onResize={commitDockWidth} /> : null}

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

/** 顶栏的「工作区面板」开合钮：只在收起时出现（旧桌面版同款——展开时由页签条尾的
 *  收起钮管，同一颗钮不该出现两处）。点开回到上次那套页签布局（布局本身记在会话上）。 */
function DockToggle(): ReactNode {
  const surface = useDockSurface()
  if (surface.expanded) return null
  return (
    <button
      type="button"
      className="icon-btn dock-toggle"
      data-tip="工作区面板：开始、终端、浏览器、文件、Git"
      aria-label="工作区面板"
      onClick={() => {
        dockActions.setExpanded(true)
      }}
    >
      <IconSidebar size={15} />
    </button>
  )
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

/**
 * 收起态的 56px 图标窄栏（旧界面 `Sidebar.tsx` 的 rail 分支同构）。
 *
 * 为什么由壳画而不是插件：窄栏内容（logo/新会话/技能/插件/目录/设置）就是**壳的
 * 导航替身**，与展开态里插件画的侧栏内容一一对应；插件内容这时整块藏在槽里
 * （不卸载），窄栏上的「新会话」经 `shell.session.new` 事件请会话列表插件去开。
 */
function SidebarRail({ onExpand }: { onExpand: () => void }): ReactNode {
  const page = useShellPage()
  const cwd = useHostSelector(readRailCwd)
  return (
    <>
      {/* 窄栏里 logo 就代表「点开侧栏」，不再另摆一颗开关（旧界面同款）。 */}
      <button type="button" className="rail-logo" data-tip="展开侧边栏，快捷键 Ctrl+B" title="展开侧栏（Ctrl+B）" aria-label="展开侧栏" onClick={onExpand}>
        <img src="icon.png" alt="Muse Code" draggable={false} />
      </button>
      <button
        type="button"
        className="rail-btn"
        data-tip="新会话"
        aria-label="新会话"
        onClick={() => {
          window.dispatchEvent(new CustomEvent('shell.session.new'))
        }}
      >
        <IconPlus size={18} />
      </button>
      <nav className="rail-nav">
        <button
          type="button"
          className={`rail-btn${page === 'skills' ? ' on' : ''}`}
          data-tip="技能"
          aria-label="技能"
          aria-pressed={page === 'skills'}
          onClick={() => {
            setShellPage(page === 'skills' ? null : 'skills')
          }}
        >
          <IconBolt size={18} />
        </button>
        <button
          type="button"
          className={`rail-btn${page === 'plugins' ? ' on' : ''}`}
          data-tip="插件"
          aria-label="插件"
          aria-pressed={page === 'plugins'}
          onClick={() => {
            setShellPage(page === 'plugins' ? null : 'plugins')
          }}
        >
          <IconPuzzle size={18} />
        </button>
      </nav>
      <div className="rail-foot">
        <button
          type="button"
          className="rail-btn"
          data-tip={cwd === null ? '展开侧栏后可选择会话' : `工作目录 ${cwd}，展开侧栏后可选择会话`}
          aria-label="展开侧栏（查看工作目录）"
          onClick={onExpand}
        >
          <IconFolder size={18} />
        </button>
        {/* 设置收进左下角（对照 dsh 的底部锚位），窄栏里排在目录按钮下面。 */}
        <button
          type="button"
          className="rail-btn"
          data-tip="设置：外观、模型、模式、技能、插件"
          aria-label="设置"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('shell.settings.open'))
          }}
        >
          <IconGear size={18} />
        </button>
      </div>
    </>
  )
}

/** 窄栏那颗「工作目录」按钮的悬浮说明要的 cwd（没有会话时给 null）。 */
function readRailCwd(snapshot: Record<string, unknown> | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const cwd = (status as Record<string, unknown>)['cwd']
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
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
  // 数据通道读数住这里（原来挂在侧栏头上写「已连接」占着用户视野；旧界面头上没有它）。
  const channel = useChannelStatus()
  const hello = useHostHello()
  if (!forced && failed === 0 && faults.length === 0) return null
  return (
    <details className="diagnostics">
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
      {/* 数据通道在不在、通不通：断了要醒目（凭据失效后重连也回不来），
          所以这一行留在诊断区；排查「界面冻住」时第一时间看它。 */}
      <p className="diag-line diag-channel" data-channel={channel} data-protocol={hello?.protocolVersion ?? ''}>
        数据通道：
        {channel === 'open'
          ? `已连接${hello === null ? '' : `（协议 v${String(hello.protocolVersion)}，放行 ${String(hello.methods.length)} 个方法）`}`
          : channel === 'connecting'
            ? '连接中…'
            : '已断开（请用宿主新打印的地址重开）'}
      </p>
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

/** 右侧栏布局的会话键：宿主快照里的当前会话 uuid（与旧桌面版同一口径——布局存档
    的键就是它，两个界面共享用户摆好的页签组）。新会话落盘前是 null。 */
function readDockSessionId(snapshot: Record<string, unknown> | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['sessionId']
  return typeof value === 'string' && value !== '' ? value : null
}
