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
import type { ServiceRegistry, UiBootGraph, UiPluginLoadReport } from '@dsc/ui-core'
// 原生桥的两枚常量与下面那批运行时都从平台种子 `@dsc/ui-runtime` 取：`@dsc/ui-core` 是
// **故意不下发给插件**的（构建期保成 external，bundle 里当值用会在运行期撞「白名单外的模块」）。
import {
  NATIVE_BRIDGE_VERSION,
  NATIVE_OPS,
  setShellPage,
  setThreadView,
  useChannelStatus,
  useHostChannel,
  useHostError,
  useHostHello,
  useHostSelector,
  useShellPage,
  useThreadView,
} from '@dsc/ui-runtime'
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  IconBolt,
  IconChevronLeft,
  IconChevronRight,
  IconFolder,
  IconGear,
  IconPlus,
  IconPuzzle,
  IconSearch,
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
import { Dock, dockActions, openDockBrowserTab, openDockTab, setDockSession, useDockReview, useDockSurface } from '@dsc/ui-dockkit'
// 槽位契约（SLOT）与渲染出口（SlotOutlet / useSlotFaults）住 @dsc/ui-slots（E4 拆包）。
// 装载会话与热更句柄**不从这里 import**：它们的份额按结构定义在下面（AppBootSession /
// AppSyncHandle），由入口以 props 递进来——两包之间因此没有反向边（剪掉成环的那一刀）。
import { SLOT, SlotOutlet, useSlotFaults } from '@dsc/ui-slots'
// 宿主桥在 @dsc/ui-primitives（native.ts / css.ts，E4 收尾从 `@dsc/ui` 沉下来的）。
import { getHostNative } from '@dsc/ui-primitives'
// `UiSlots` 这个别名由 `SlotMap` / `SlotFactoryMap`（declare 合并认的是**文件身份**，
// 别的路径 re-export 不算，见 ui-slots/slots.ts 的同款说明）与 `UiComponent` 拼出来，
// 那三样都只在 `src/plugin-api.ts` 一个文件里。E7 把本包搬进 `src/packages/` 之后，相对
// 路径跨不出包了，改走 `@dsc/ui`（别名落点就是那个文件，文件身份不变，合并照样成立）。
// `import type` 编译期擦除、零运行期字节，包与包之间没有新增的运行时边。
import type { UiSlots } from '@dsc/ui'
// 取词器与字典：本文件随布局插件的 bundle 走，`@dsc/ui` 在那个 bundle 里是 external
// （运行期拿壳里那一份），与 `ui.tsx` 同一理由——`@dsc/ui-core` 反而进不了插件 bundle。
import { createT } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'
// 画图的那三块留在这里（它们随布局插件的 bundle 走）；共享状态全在 @dsc/ui-runtime。
import { UpdateButton } from './update-button'
// 并排审查面板已停用（2026-11-08）：审查统一走右侧栏的文件预览页签。组件文件先留着，
// 确认没人再要就整块删。
// import { ReviewPane } from './review-pane'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 骨架消费的装载会话份额（E4 起按结构定义在这里，不再反向 import 渲染器包）。
 *
 * 渲染器包的 `UiBootSession` 结构上满足它，装配点（入口的 `<App/>`）做检查；诊断区要的
 * 数据——装载报告、批状态、每插件 phase——都在这个份额里，语义与之前的
 * `getReports()` / `subscribe()` / 全局账本同一份（`getState()` 返回的就是那个账本对象）。
 */
export interface AppBootSession {
  getReports(): readonly UiPluginLoadReport[]
  getState(): AppBootLedger
  subscribe(listener: () => void): () => void
}

/** 启动账本里诊断区画的那几项（渲染器包 `UiBootState` 的结构子集）。 */
export interface AppBootLedger {
  startedAt: number
  batches: readonly {
    phase: string
    entries: readonly string[]
    state: string
    scheduledAt?: number
    startedAt?: number
    doneAt?: number
  }[]
  plugins: Record<string, {
    phase: string
    state: string
    /** 装配路径（2026-10-26 起：cordis 是默认，旧退订账本是回滚面）。 */
    via?: 'cordis' | 'ledger'
    /** 走 cordis 时那条纤维的状态码（0 待装 / 1 装载中 / 2 生效 / 3 失败 / 4 已卸）。 */
    fiber?: number
  }>
}

/** 一条页内同步失败（热更句柄的读数；与渲染器包的 `PluginSyncFailure` 同形）。 */
export interface AppSyncFailure {
  id: string
  message: string
  at: number
}

/** 骨架消费的热更句柄份额（渲染器包 `UiPluginHmr` 的结构子集）。 */
export interface AppSyncHandle {
  getFailures(): AppSyncFailure[]
  retry(): void
  subscribe(listener: () => void): () => void
}

/** 应用参数。 */
export interface AppProps {
  slots: UiSlots
  boot: UiBootGraph
  /** 服务表（A1）：诊断区那行的读数源；本体经 ServicesProvider 交给条目组件。 */
  serviceRegistry: ServiceRegistry
  /** 装载会话：报告、批状态、换装都从它读；清单取不到时 null（空壳 + 诊断）。 */
  session: AppBootSession | null
  /** 壳侧热更句柄（页内同步失败与重试按钮的读数面）。 */
  hmr: AppSyncHandle | null
  /** 清单/装载会话起不来时的原因（诊断区画它）。 */
  bootError: string | null
  /** 壳当前放行的平台模块（诊断区那一行的读数；本体住装载器，从入口传进来）。 */
  allowedModules: readonly string[]
}

/**
 * 窄屏（手机档）的断点——与 `styles.css` 窄屏段那个数**必须是同一个**。
 *
 * 桌面窗口最小宽 960（`desktop/electron/main/index.ts` 的 `minWidth`），永远碰不到这一档；
 * 手机远程页伺服的是同一份壳产物，靠视口宽区分，没有 UA、没有宿主标志。
 */
const NARROW_QUERY = '(max-width: 860px)'

/**
 * 当下是不是窄屏。
 *
 * 为什么不进 hook：`narrow` 的 state **首帧**就要有值（手机上收起态整条侧栏不画，
 * 晚一帧会先闪出一条 56px 窄栏再收掉），所以初始化时直接量一次。
 */
function isNarrowViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(NARROW_QUERY).matches
  )
}

/**
 * 装载报告：application 批是首帧之后才装的，报告会分批变，所以要订阅会话；
 * 清单本身取不到时没有会话，用启动失败那一条顶上（诊断区一样能画出来）。
 */
function useSessionReports(session: AppBootSession | null, bootError: string | null): readonly UiPluginLoadReport[] {
  const fallback = useMemo<readonly UiPluginLoadReport[]>(
    () => (bootError === null ? [] : [{ id: 'boot', ok: false, error: bootError }]),
    [bootError],
  )
  const [reports, setReports] = useState<readonly UiPluginLoadReport[]>(() => session?.getReports() ?? fallback)
  useEffect(() => {
    if (session === null) {
      setReports(fallback)
      return
    }
    setReports(session.getReports())
    return session.subscribe(() => {
      setReports(session.getReports())
    })
  }, [session, fallback])
  return reports
}

/** 启动账本（批次时刻、每插件 phase/rev/状态）：订阅装载会话拿的就是探针读的那一份全局。 */
function useBootLedger(session: AppBootSession | null): AppBootLedger | null {
  const [ledger, setLedger] = useState<AppBootLedger | null>(() => session?.getState() ?? null)
  useEffect(() => {
    if (session === null) {
      setLedger(null)
      return
    }
    setLedger(session.getState())
    return session.subscribe(() => {
      setLedger(session.getState())
    })
  }, [session])
  return ledger
}

/** 页内同步失败（换装失败清单）：订阅句柄。 */
function usePluginFailures(hmr: AppSyncHandle | null): AppSyncFailure[] {
  const [failures, setFailures] = useState<AppSyncFailure[]>(() => hmr?.getFailures() ?? [])
  useEffect(() => {
    if (hmr === null) {
      setFailures([])
      return
    }
    setFailures(hmr.getFailures())
    return hmr.subscribe(() => {
      setFailures(hmr.getFailures())
    })
  }, [hmr])
  return failures
}

export function App({ slots, boot, serviceRegistry, session, hmr, bootError, allowedModules }: AppProps): ReactNode {
  const reports = useSessionReports(session, bootError)
  const ledger = useBootLedger(session)
  const syncFailures = usePluginFailures(hmr)
  // 服务名每帧现读：application 批提供的服务在首帧之后才出现，读快照会漏。
  const services = serviceRegistry.names()
  const failed = reports.filter((report) => !report.ok)
  // 右侧栏布局（每会话一份，状态在 dock-state）；审查目标（并排栏）也住那儿。
  const surface = useDockSurface()
  const review = useDockReview()
  const sessionId = useHostSelector(readDockSessionId)
  // 主区整页（插件中心这类）：非 null 时顶栏与正文整块换成那一页（旧界面同构）。
  const page = useShellPage()
  // 正文区正在看队友的运行记录时，标题换成层级面包屑（`父会话标题 / 队友名` + 只读标）：
  // 两段由 team 插件经 window 事件递上来（`shell.teammate.view`，关掉时 detail 给 null）。
  const teammateView = useTeammateCrumbs()
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
  // 窄屏（手机档）**首帧**就要知道：收起态在手机上整条侧栏都不画（导航改挂顶栏右上角），
  // 晚一帧会先闪出一条 56px 窄栏再收掉。所以初值就地量一次，不进 effect。
  const [narrow, setNarrow] = useState<boolean>(() => isNarrowViewport())
  // 手机上「侧栏收起」是常态（浏览器里没有 Ctrl+B，也没有桌面那种可拖宽的行内侧栏）：
  // 存档里那份多半是桌面留下的 false，这里按窄屏兜一下，免得首帧先画一层抽屉再收。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => readStoredFlag(PANEL_KEYS.sidebarCollapsed) || isNarrowViewport(),
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
    // 写的是 --dsc-thread-user-max（不是 --dsc-thread-max）：空会话态在样式表里给
    // .thread-main-empty 挂了元素级的 --dsc-thread-max，根上的同名变量压不过它
    // （见 styles.css 开头的接线注释）。
    if (threadWidth !== null) setRootVar('--dsc-thread-user-max', `${String(threadWidth)}px`)
    return () => setRootVar('--dsc-thread-user-max', null)
  }, [threadWidth])

  // 窄屏（手机浏览器，含「手机端 remote-web 切壳」后的形态）：侧栏默认收起成 56px
  // 窄栏——展开态在窄屏下是浮层（styles.css 的窄屏段），正文拿全宽。
  // 只在**跨进窄屏**那一刻收一次：收不收的决定权随后仍在用户手里（Ctrl+B / 窄栏 logo）。
  //
  // 这一档同时喂给 `narrow`：手机上收起态整条侧栏不画、导航（会话/插件）改挂顶栏右上角、
  // 正文页签行也换一副（render 里三处 `narrow` 分支都读它）。
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY)
    const apply = (): void => {
      setNarrow(query.matches)
      if (query.matches) setSidebarCollapsed(true)
    }
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  // 手机档：进了整页就把抽屉收起来。抽屉里那两颗「技能 / 插件」是整页入口，点完抽屉还开着，
  // 整页就开在抽屉（与压在它上面那层遮罩）后面——看着像「点了没反应」，还得多点一下才看得见。
  useEffect(() => {
    if (narrow && page !== null) setSidebarCollapsed(true)
  }, [narrow, page])

  /**
   * 窗口变窄（或侧栏被拖宽）时把右栏夹回可用空间。
   *
   * 为什么需要（2026-10-30 报障）：存档里的宽度是按当时的窗口定的，换个小窗口之后
   * 右栏仍然是 820，正文只剩一条，中文逐字换行、输入框挤成一团。拖拽那条路径已经在
   * dock.tsx 里按现场算上限了，这里只管「不是拖出来的那些变化」——窗口缩放、侧栏拖宽、
   * 恢复会话时读到的旧存档。夹小只改内存不写盘：窗口再变宽时用户原来的宽度还在。
   */
  useEffect(() => {
    const fit = (): void => {
      const room = window.innerWidth - (sidebarWidth ?? 0) - 480
      const max = Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, room))
      setDockWidth((current) => (current > max ? max : current))
    }
    window.addEventListener('resize', fit)
    fit()
    return () => window.removeEventListener('resize', fit)
  }, [sidebarWidth])

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
        // 浏览器页签可多开（2026-10）：Ctrl+T 是「再开一张」——空态那张不自动加载页面。
        // 文件页签仍是单例（openDockTab 走的就是「已开则聚焦」）。
        openDockBrowserTab()
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
          {/* 品牌行（旧界面同款）：logo + 名字 + 更新钮 + 行尾的收起钮。整行是窗口拖拽区
              （legacy `.sidebar-header`），按钮靠各自的类自带 no-drag——没有
              这个类名点击会被当拖窗口吞掉（「点了没反应」的根因）。 */}
          <div
            className="sidebar-header"
            data-rail-hidden={sidebarCollapsed ? '1' : undefined}
            aria-hidden={sidebarCollapsed || undefined}
          >
            <img src="icon.png" alt="Pneuma" draggable={false} />
            <span className="brand">{boot.host.name}</span>
            {/* 有新版时才出现（自己判空：没新版时它渲染 null）。名字右边、收起钮左边。 */}
            <UpdateButton />
            {/* 搜索（命令面板）入口：2026-11-06 从顶栏搬到品牌行——顶栏那颗只在手机档留
                （手机上整条侧栏不画，删了就再也点不到搜索）。整行是窗口拖拽区，按钮必须
                自己带 `no-drag`，否则点击会被当成「拖窗口」吞掉。 */}
            <button
              type="button"
              className="icon-btn no-drag"
              data-tip={t('layout.nav.searchTip')}
              aria-label={t('layout.nav.search')}
              onClick={() => {
                window.dispatchEvent(new CustomEvent('shell.palette.open'))
              }}
            >
              <IconSearch size={15} />
            </button>
            <button
              type="button"
              className="icon-btn rail-toggle"
              data-tip={t('layout.nav.collapseTip')}
              title={t('layout.nav.collapseTitle')}
              aria-label={t('layout.nav.collapse')}
              onClick={toggleSidebar}
            >
              <IconSidebar size={15} />
            </button>
          </div>
          {/* 收起态：56px 图标窄栏（旧界面的 rail 分支），壳替插件画导航。
              手机档整条侧栏都不给（CSS 那条 `.app[data-rail='1'] > .sidebar`），窄栏也就不必
              画；导航的两颗（会话 / 插件）这时挂在顶栏右上角（见下面的 topbar-nav 那组）。 */}
          {sidebarCollapsed && !narrow ? <SidebarRail onExpand={toggleSidebar} /> : null}
          {/* 插件的侧栏内容：收起时整块藏起来但不卸载（见 styles.css 的说明）；
              展开态经 display:contents 包装层直排进 .sidebar（与别处槽包装同一招）。 */}
          <div className="sidebar-slot" data-rail-hidden={sidebarCollapsed ? '1' : undefined}>
            <SlotOutlet slots={slots} slot={SLOT.sidebar} />
          </div>
          {sidebarCollapsed ? null : (
            <div
              className="sidebar-resizer"
              data-tip={t('layout.nav.sidebarResizeTip')}
              onPointerDown={sidebarDrag.onPointerDown}
              onPointerMove={sidebarDrag.onPointerMove}
              onPointerUp={sidebarDrag.onPointerUp}
              onPointerCancel={sidebarDrag.onPointerCancel}
              onDoubleClick={() => commitSidebarWidth(null)}
            />
          )}
        </aside>

        {/* 手机档拉出抽屉时垫在下面的一层：点它收回。桌面档不渲染（侧栏是行内的，点哪儿
            都不该把它收掉）。z-index 由 CSS 给（39，侧栏是 40）——所以它压得住正文，
            压不住侧栏本身。 */}
        {narrow && !sidebarCollapsed ? (
          <div className="sidebar-scrim" onClick={toggleSidebar} aria-hidden="true" />
        ) : null}

        <div className="main">
          {/* 窗口控件条占位（旧界面同一行）：最小化/最大化/关闭画在窗口右上，
              顶栏的内容从这行**下面**开始，不会被原生控件盖住。整页模式也保留。 */}
          <div className="caption-bar" aria-hidden="true" />
          {page === null ? (
            <>
              <div className="topbar">
                <div className="topbar-title-row">
                  {/* 手机档的「会话」钮挂**左上角**（当天第二条反馈）：它拉出来的抽屉从左边
                      出来，钮摆在右上角会出现「点右边、左边冒出东西」，位置与结果对不上。
                      其余四颗（新会话/技能/工作目录/设置）手机上都不给——抽屉一拉就有，
                      设置入口则按同一条反馈整去掉；「插件」那颗仍在右上（它是整页跳转，
                      与抽屉不是一类，没必要挤到标题左边）。 */}
                  {narrow ? (
                    <button
                      type="button"
                      className="icon-btn topbar-nav-btn"
                      data-tip={t('layout.nav.sessions')}
                      aria-label={t('layout.nav.sessions')}
                      onClick={toggleSidebar}
                    >
                      <IconSidebar size={16} />
                    </button>
                  ) : null}
                  {/* 侧栏收起时不在这里放展开钮（旧界面顶栏没有它）：窄栏顶上那颗
                      logo 就是展开入口，Ctrl+B 也照旧。 */}
                  {teammateView === null ? (
                    <span className="title">
                      <SessionTitle />
                    </span>
                  ) : (
                    <TeammateCrumbs view={teammateView} />
                  )}
                  {/* 左簇：智能体团队（order 10）——旧界面它跟在标题后面，与右侧的操作组隔一根弹性填充 */}
                  <div className="topbar-cluster">
                    <SlotOutlet slots={slots} slot={SLOT.headerLead} />
                  </div>
                  <div className="drag-fill" />
                  {/* 搜索（命令面板）入口的**手机档**那一份（2026-11-06 起桌面档搬进侧栏
                      品牌行）：手机上整条侧栏不画，删了这颗就再也点不到搜索。 */}
                  {narrow ? (
                    <button
                      type="button"
                      className="icon-btn topbar-search"
                      data-tip={t('layout.nav.searchTip')}
                      aria-label={t('layout.nav.search')}
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent('shell.palette.open'))
                      }}
                    >
                      <IconSearch size={15} />
                    </button>
                  ) : null}
                  {/* 右簇：工作区打开组（在资源管理器打开 + 更多打开方式）。手机档由 CSS 藏掉
                      （没有原生桥，点了只会报「这条能力来自桌面外壳」）。 */}
                  <SlotOutlet slots={slots} slot={SLOT.header} />
                  {/* 手机档的「插件」钮：插件中心整页（再点回正文）。 */}
                  {narrow ? (
                    <button
                      type="button"
                      className={`icon-btn topbar-nav-btn${page === 'plugins' ? ' on' : ''}`}
                      data-tip={t('layout.nav.plugins')}
                      aria-label={t('layout.nav.plugins')}
                      aria-pressed={page === 'plugins'}
                      onClick={() => {
                        setShellPage(page === 'plugins' ? null : 'plugins')
                      }}
                    >
                      <IconPuzzle size={16} />
                    </button>
                  ) : null}
                  {/* 工作区面板开合钮：只在收起时出现（展开时由面板头条尾的收起钮管） */}
                  <DockToggle />
                </div>
                {/* 对话 / 轨迹页签（旧界面顶栏第二行同款）：两张脸共用正文位，
                    页签是显式入口——另一个入口是会话右键菜单的「查看轨迹」。
                    手机档不给这两颗页签（那 36px 让给正文），但轨迹页还有三个入口
                    （会话右键菜单、工具卡的「在轨迹中查看」药丸两处），切过去得有回头路：
                    这时那一行只画一颗「← 对话」。 */}
                {narrow ? (
                  threadView === 'trace' ? (
                    <nav className="tabs" aria-label={t('layout.nav.threadViewAria')}>
                      <button
                        type="button"
                        onClick={() => {
                          setThreadView('chat')
                        }}
                      >
                        <IconChevronLeft size={14} />
                        {t('layout.nav.chat')}
                      </button>
                    </nav>
                  ) : null
                ) : (
                  <nav className="tabs" role="tablist" aria-label={t('layout.nav.threadViewAria')}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={threadView === 'chat'}
                      className={threadView === 'chat' ? 'on' : ''}
                      onClick={() => {
                        setThreadView('chat')
                      }}
                    >
                      {t('layout.nav.chat')}
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
                      {t('layout.nav.trace')}
                    </button>
                  </nav>
                )}
              </div>

              <ConnectionBanner />
              <HostErrorStrip />

              {/* 正文轨道 + 并排审查栏（旧界面 `.thread-zone[data-review]` 同构：
                  审查开着时正文让位，右缘的拖拽条一并让位）。 */}
              <div className="thread-zone" {...(review !== null ? { 'data-review': '1' } : {})}>
                <div
                  // 正文区（消息流 + 输入区）的锚点：**宽度裁决**认这一格（状态面板自动档
                  // 的 1280px 量的是它的 clientWidth，dock 开合改它不改窗口宽）。
                  // 落点则不必是这里了——状态胶囊默认画在顶栏页签行右端，只有手机档没有
                  // 那一行时才回落到这一格的右上角。**不是 `.chat-wrap`**：空会话态里它
                  // 只有内容高、还被上下 auto 边距推着居中，认它会飘到版心（见 styles.css）。
                  data-thread-area=""
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
                    {/* 状态读数贴着输入框（对齐 dsh 的 composer dock）：空会话里输入框是被
                        居中推着的，挂在窗口最底下会隔出一大段空白，读数与输入框就不再是
                        「同一排」。页模式（插件中心这类没有输入框的页）仍用窗口底部那一份。 */}
                    <div className="statusbar">
                      <SlotOutlet slots={slots} slot={SLOT.statusbar} />
                    </div>
                  </div>
                </div>
                {review === null ? (
                  <ThreadResizer width={threadWidth} onCommit={commitThreadWidth} onReset={resetThreadWidth} />
                ) : null}
                {/* 并排审查面板已停用（2026-11-08）：审查与 Git 改动预览统一到右侧栏的文件预览页签
                    （能按扩展名渲染 markdown / 代码 / 表格 / 图片）。旧入口先留着，确认没人再要就整块删。 */}
                {/* <ReviewPane /> */}
              </div>
            </>
          ) : (
            <>
              {/* 手机档的**页头带**（2026-10-15 当天第三条反馈）：桌面侧栏常驻，页里那颗「插件」
                  钮一直看得见，再点一次就回对话；手机档顶栏被整页换掉了——进页之后回对话的入口
                  没了，连开会话抽屉的入口（也在顶栏里）都没了，用户被困在页里。这条带子就是
                  「桌面那条常驻侧栏」的手机替身：左边回对话、右边开会话抽屉，中间说清在哪一页。
                  桌面档不渲染它（那边侧栏还在，页头带只会多占一行）。 */}
              {narrow ? (
                <div className="page-strip">
                  <button
                    type="button"
                    className="icon-btn topbar-nav-btn"
                    data-tip={t('layout.nav.backToChat')}
                    aria-label={t('layout.nav.backToChat')}
                    onClick={() => {
                      setShellPage(null)
                    }}
                  >
                    <IconChevronLeft size={16} />
                  </button>
                  <span className="title">
                    {page === 'plugins' ? t('layout.nav.plugins') : t('layout.nav.skills')}
                  </span>
                  <div className="drag-fill" />
                  <button
                    type="button"
                    className="icon-btn topbar-nav-btn"
                    data-tip={t('layout.nav.sessions')}
                    aria-label={t('layout.nav.sessions')}
                    onClick={toggleSidebar}
                  >
                    <IconSidebar size={16} />
                  </button>
                </div>
              ) : null}
              {/* 整页模式（插件中心这类）：顶栏与正文整块换成页自己的，状态栏照旧占底部。 */}
              <SlotOutlet slots={slots} slot={SLOT.page} />
            </>
          )}

          {/* 页模式（没有输入框的整页）：读数仍占窗口底部；对话页的那一份贴在输入框下面
              （见上面 `.composer-zone` 里的注释），两处只会渲染一处。 */}
          {page === null ? null : (
            <div className="statusbar">
              <SlotOutlet slots={slots} slot={SLOT.statusbar} />
            </div>
          )}
        </div>

        {/* 右侧栏（dock）：**常驻挂载**（对齐旧桌面版「收起=滑出右缘不卸载」——终端进程、
            文件树滚动位都活着），布局随会话走；新会话在首条消息落盘前没有 id，先不挂。 */}
        {sessionId !== null ? <Dock width={dockWidth} onResize={commitDockWidth} /> : null}

        {/* 播报区用旧界面的浮层容器（`.dsc-toasts`），空着时它自己不可见。 */}
        <div className="dsc-toasts">
          <SlotOutlet slots={slots} slot={SLOT.notice} />
        </div>
      </div>

      <Diagnostics
        slots={slots}
        boot={boot}
        reports={reports}
        services={services}
        failed={failed.length}
        ledger={ledger}
        syncFailures={syncFailures}
        allowedModules={allowedModules}
        onRetrySync={hmr === null ? null : () => { hmr.retry() }}
      />
    </>
  )
}

/** 顶栏标题：当前会话的显示名；找不到就说「新会话」（旧界面同一口径）。 */
function SessionTitle(): ReactNode {
  const title = useHostSelector(readSessionTitle)
  return <>{title}</>
}

/**
 * 正文区正在看队友运行记录时，顶栏要的那两段（team 插件经 `window` 事件递上来）。
 *
 * 为什么走 window 事件而不是服务表：布局这层不是插件（它拿不到 `ui.provide` 的消费面），
 * 而壳里跨「插件 ↔ 外壳」的既有通路就是 `window` 事件（`shell.palette.open` /
 * `shell.sidebar.toggle` / `shell.session.new` 都是这条）。数据本身在界面侧推导
 * （team 插件用名册 + 会话清单算父会话标题），不新增快照字段、不改宿主契约。
 */
interface TeammateCrumbsView {
  /** 队友名（右段，纯文本）。 */
  name: string
  /** 派它的会话标题（左段，点一下回原会话）。 */
  parentTitle: string
  /** 派它的会话 jsonl 绝对路径；查不到时 null（那时点左段只关掉只读层）。 */
  parentPath: string | null
}

/** 面包屑的出现 / 消失（detail 为 null 表示「正文区回到普通会话」）。 */
const TEAMMATE_HINT_EVENT = 'shell.teammate.view'
/** 请正文区那层只读视图关掉（顶栏左段点一下就发它）。 */
const TEAMMATE_EXIT_EVENT = 'shell.teammate.exit'

/**
 * 订阅「正文区正在看谁的运行记录」。
 *
 * 逐字段比对再落状态：事件可能每几秒来一次（名册轮询刷新父会话标题），值没变就别
 * 重画顶栏。事件 detail 给 null 就还原成普通标题。
 */
function useTeammateCrumbs(): TeammateCrumbsView | null {
  const [view, setView] = useState<TeammateCrumbsView | null>(null)
  useEffect(() => {
    const onView = (event: Event): void => {
      const detail = (event as CustomEvent<TeammateCrumbsView | null>).detail ?? null
      setView((current) => {
        if (detail === null) return current === null ? current : null
        if (
          current !== null &&
          current.name === detail.name &&
          current.parentTitle === detail.parentTitle &&
          current.parentPath === detail.parentPath
        ) {
          return current
        }
        return detail
      })
    }
    window.addEventListener(TEAMMATE_HINT_EVENT, onView)
    return () => {
      window.removeEventListener(TEAMMATE_HINT_EVENT, onView)
    }
  }, [])
  return view
}

/**
 * 顶栏的层级面包屑（对照 dsh 的 `nav.crumbs`）：`父会话标题 / 队友名` + 一枚「只读」小标。
 *
 * 左边那节是**回原会话**的唯一出口（正文区被只读层盖住了，输入区也在盖子下面）：
 * 点它先请 team 插件关掉那层，再 `openSession(父会话路径)`——当前本来就是父会话时
 * 宿主对「已经在看这条」直接短路（`plugins/session` 的 open 首行），所以这一步是无害的
 * 兜底（用户在看队友记录时从侧栏切去了别的会话，只读层会自动关，那时这一步才真切）。
 * 右边那节不可点：它就是「现在在哪」。
 */
function TeammateCrumbs({ view }: { view: TeammateCrumbsView }): ReactNode {
  const channel = useHostChannel()
  return (
    <span className="crumbs" role="navigation" aria-label={t('layout.crumb.aria')}>
      <button
        type="button"
        className="crumb crumb-link"
        data-tip={t('layout.crumb.parentTip')}
        onClick={() => {
          window.dispatchEvent(new CustomEvent(TEAMMATE_EXIT_EVENT))
          if (view.parentPath === null) return
          void channel.invoke('openSession', [view.parentPath]).catch(() => undefined)
        }}
      >
        {view.parentTitle}
      </button>
      <span className="crumb-sep" aria-hidden="true">
        /
      </span>
      <span className="crumb crumb-current" aria-current="page">
        {view.name}
      </span>
      <span className="crumb-badge">{t('layout.crumb.readonly')}</span>
    </span>
  )
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
      data-tip={t('layout.nav.dockTip')}
      aria-label={t('layout.nav.dock')}
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
/**
 * 数据通道断开时的顶条（2026-10-25，P1-6）。
 *
 * 与 `HostErrorStrip` 分工：那一条报的是**宿主造帧出错**（帧还在流，但内容是错的），
 * 这一条报的是**流本身断了**（一帧都收不到）。两者都出现时两条并排，因为处理方式不同：
 * 前者要重启宿主，后者先重连。
 *
 * 为什么延迟 3 秒才出：EventSource 自己每 3 秒重连一次，宿主重启、页面刚加载时
 * 都会短暂 `connecting`——立刻弹条会天天闪。3 秒还没连上，才值得说话。
 */
function ConnectionBanner(): ReactNode {
  const channel = useHostChannel()
  const status = useChannelStatus()
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (status === 'open') {
      setShown(false)
      return undefined
    }
    const timer = window.setTimeout(() => {
      setShown(true)
    }, 3000)
    return () => {
      window.clearTimeout(timer)
    }
  }, [status])
  if (!shown) return null
  const closed = status === 'closed'
  return (
    <div className="conn-banner" data-conn={status} role="status">
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-text">{closed ? t('layout.conn.closed') : t('layout.conn.failed')}</span>
      <span className="conn-hint">
        {closed ? t('layout.conn.closedHint') : t('layout.conn.retryHint')}
      </span>
      <button
        type="button"
        className="conn-retry"
        onClick={() => {
          channel.reconnect()
        }}
      >
        {t('layout.conn.reconnect')}
      </button>
    </div>
  )
}

function HostErrorStrip(): ReactNode {
  const error = useHostError()
  if (error === null) return null
  return (
    <p className="host-error" data-host-error="1">
      {t('layout.host.error', { message: error })}
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
      <button
        type="button"
        className="rail-logo"
        data-tip={t('layout.nav.expandTip')}
        title={t('layout.nav.expandTitle')}
        aria-label={t('layout.nav.expand')}
        onClick={onExpand}
      >
        <img src="icon.png" alt="Pneuma" draggable={false} />
      </button>
      <button
        type="button"
        className="rail-btn"
        data-tip={t('layout.nav.newSession')}
        aria-label={t('layout.nav.newSession')}
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
          data-tip={t('layout.nav.skills')}
          aria-label={t('layout.nav.skills')}
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
          data-tip={t('layout.nav.plugins')}
          aria-label={t('layout.nav.plugins')}
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
          data-tip={cwd === null ? t('layout.nav.cwdTip') : t('layout.nav.cwdTipAt', { cwd })}
          aria-label={t('layout.nav.cwdAria')}
          onClick={onExpand}
        >
          <IconFolder size={18} />
        </button>
        {/* 设置收进左下角（对照 dsh 的底部锚位），窄栏里排在目录按钮下面。 */}
        <button
          type="button"
          className="rail-btn"
          data-tip={t('layout.nav.settingsTip')}
          aria-label={t('layout.nav.settings')}
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

/** 纤维状态码 → 人话（与 `ui-renderer/cordis-host.ts` 的 FIBER_STATE_TEXT 同口径）。
 *
 * 为什么在这里再写一份：诊断区住 `ui-layout`，装载器住 `ui-renderer`，后者 import 前者，
 * 反过来引就成环（E4 收尾时剪掉的那条边）。六行字，重复比成环便宜。
 *
 * 每条值是一枚取词函数而不是字符串：键与译文都在本包字典里，语言在页面生命周期里定死，
 * 但延到取词那一刻拼字符串，模块加载时就不必先读启动图。 */
const FIBER_TEXT: Readonly<Record<number, () => string>> = {
  0: () => t('layout.fiber.pending'),
  1: () => t('layout.fiber.loading'),
  2: () => t('layout.fiber.active'),
  3: () => t('layout.fiber.failed'),
  4: () => t('layout.fiber.disposed'),
  5: () => t('layout.fiber.disposed'),
}

function fiberStateText(state: number | undefined): string {
  if (state === undefined) return t('layout.fiber.unknown')
  const text = FIBER_TEXT[state]
  return text === undefined ? t('layout.fiber.number', { state }) : text()
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
  services,
  failed,
  ledger,
  syncFailures,
  allowedModules,
  onRetrySync,
}: {
  slots: UiSlots
  boot: UiBootGraph
  reports: readonly UiPluginLoadReport[]
  services: readonly string[]
  failed: number
  ledger: AppBootLedger | null
  syncFailures: readonly AppSyncFailure[]
  /** 壳当前放行的平台模块（装载器按 MODULES 算出来，入口传进来）。 */
  allowedModules: readonly string[]
  /** 页内同步失败的重试入口；没有热更句柄时 null（没得重试）。 */
  onRetrySync: (() => void) | null
}): ReactNode {
  const faults = useSlotFaults(slots)
  const [forced] = useState(() => new URLSearchParams(location.search).has('diag'))
  const native = getHostNative()
  const probe = useNativeProbe()
  // 数据通道读数住这里（原来挂在侧栏头上写「已连接」占着用户视野；旧界面头上没有它）。
  const channel = useChannelStatus()
  const hello = useHostHello()
  if (!forced && failed === 0 && faults.length === 0 && syncFailures.length === 0) return null
  const batchRev = (phase: string): string =>
    boot.batches.find((batch) => batch.phase === phase)?.rev ?? ''
  return (
    <details className="diagnostics">
      <summary>
        {t('layout.diag.summary', {
          plugins: reports.length,
          slots: slots.slots.length,
          faults: faults.length === 0 ? '' : t('layout.diag.faults', { count: faults.length }),
        })}
      </summary>
      <ul className="diag-plugins">
        {reports.map((report) => (
          <li key={report.id} className={report.ok ? 'ok' : 'bad'} data-plugin={report.id}>
            <code>{report.id}</code>{' '}
            {report.ok
              ? t('layout.diag.loaded')
              : t('layout.diag.failed', { reason: report.error ?? t('layout.common.unknown') })}
            {report.name === undefined ? '' : t('layout.diag.nameNote', { name: report.name })}
            {report.provides === undefined
              ? ''
              : t('layout.diag.provides', { list: report.provides.join(t('layout.common.listSep')) })}
            {report.ok && (report.attempts ?? 1) > 1 ? t('layout.diag.retries', { count: String(report.attempts) }) : ''}
            <span data-plugin-phase={ledger?.plugins[report.id]?.phase ?? ''}>
              {' '}· {ledger?.plugins[report.id]?.phase === 'early' ? t('layout.diag.phaseEarly') : t('layout.diag.phaseApp')}
            </span>
            {/* 装配路径与纤维状态（2026-10-26 起：装插件走 cordis，旧账本是回滚面）。
                两个 data 属性是探针的读面：隐藏的 DOM 照样命中。 */}
            <span
              data-plugin-via={ledger?.plugins[report.id]?.via ?? ''}
              data-plugin-fiber={ledger?.plugins[report.id]?.fiber ?? ''}
            >
              {' '}· {ledger?.plugins[report.id]?.via === 'cordis'
                ? t('layout.diag.viaCordis', { state: fiberStateText(ledger?.plugins[report.id]?.fiber) })
                : t('layout.diag.viaLedger')}
            </span>
          </li>
        ))}
        {reports.length === 0 ? <li className="empty">{t('layout.diag.noPlugins')}</li> : null}
      </ul>
      {/* 批次读数（A2）：每批的状态、时刻与 rev。`data-batch*` 属性是探针的读面，
          桌面自检与浏览器走查都靠 querySelector 读它（隐藏的 DOM 照样命中）。 */}
      {ledger === null ? null : (
        <p className="diag-line diag-batches">
          {t('layout.diag.batches')}
          {ledger.batches.map((batch) => {
            const loaded = batch.entries.filter((id) => ledger.plugins[id]?.state === 'loaded').length
            const at = batch.doneAt ?? batch.startedAt ?? batch.scheduledAt
            return (
              <span
                key={batch.phase}
                data-batch={batch.phase}
                data-batch-state={batch.state}
                data-batch-loaded={`${String(loaded)}/${String(batch.entries.length)}`}
                data-batch-rev={batchRev(batch.phase)}
                style={{ marginRight: 10 }}
              >
                {t('layout.diag.batch', {
                  phase: batch.phase === 'early' ? t('layout.diag.batchEarly') : t('layout.diag.batchApp'),
                  loaded,
                  total: batch.entries.length,
                  state: batch.state,
                  at: at === undefined ? '' : t('layout.diag.batchAt', { ms: Math.round(at - ledger.startedAt) }),
                  rev: batchRev(batch.phase) === '' ? '' : t('layout.diag.rev', { rev: batchRev(batch.phase) }),
                })}
              </span>
            )
          })}
        </p>
      )}
      {/* 页内同步失败（HMR 换装失败）：只影响这个页面、不动宿主启停；给一个重试入口。 */}
      {syncFailures.length === 0 ? null : (
        <ul className="diag-plugins">
          {syncFailures.map((failure) => (
            <li key={failure.id} className="bad" data-sync-failure={failure.id}>
              <code>{failure.id}</code> {t('layout.diag.syncFailed', { message: failure.message })}
            </li>
          ))}
        </ul>
      )}
      {onRetrySync === null ? null : (
        <p className="diag-line">
          <button type="button" data-sync-retry="1" onClick={onRetrySync}>
            {t('layout.diag.retrySync')}
          </button>
        </p>
      )}
      {faults.length === 0 ? null : (
        <ul className="diag-plugins">
          {faults.map((fault, index) => (
            <li key={`${fault.slot}|${fault.id}|${String(index)}`} className="bad" data-fault={fault.slot}>
              <code>{fault.slot}</code>
              {fault.id === '' ? '' : ` / ${fault.id}`}
              {t('layout.diag.fault', {
                phase:
                  fault.phase === 'render'
                    ? t('layout.diag.phaseRender')
                    : fault.phase === 'contribute'
                      ? t('layout.diag.phaseContribute')
                      : t('layout.diag.phaseUnmount'),
                message: fault.error.message,
              })}
            </li>
          ))}
        </ul>
      )}
      <p className="diag-line">
        {t('layout.diag.manifest', {
          rev: boot.rev,
          list: boot.entries.map((entry) => entry.id).join(t('layout.common.listSep')) || t('layout.common.empty'),
        })}
      </p>
      <p className="diag-line">
        {t('layout.diag.slots', { list: slots.slots.join(t('layout.common.listSep')) || t('layout.common.none') })}
      </p>
      {/* 服务表（A1）：谁提供了什么——插件之间协作出问题时第一时间看它。 */}
      <p className="diag-line" data-services={services.join(',')}>
        {t('layout.diag.services', { list: services.join(t('layout.common.listSep')) || t('layout.common.none') })}
      </p>
      <p className="diag-line">
        {t('layout.diag.modules', { list: allowedModules.join(t('layout.common.listSep')) })}
      </p>
      {/* 数据通道在不在、通不通：断了要醒目（凭据失效后重连也回不来），
          所以这一行留在诊断区；排查「界面冻住」时第一时间看它。 */}
      <p className="diag-line diag-channel" data-channel={channel} data-protocol={hello?.protocolVersion ?? ''}>
        {t('layout.diag.channel', {
          state:
            channel === 'open'
              ? t('layout.diag.channelOpen', {
                  detail:
                    hello === null
                      ? ''
                      : t('layout.diag.channelOpenDetail', {
                          version: String(hello.protocolVersion),
                          count: hello.methods.length,
                        }),
                })
              : channel === 'connecting'
                ? t('layout.diag.channelConnecting')
                : t('layout.diag.channelClosed'),
        })}
      </p>
      {/* 原生桥在不在：桌面窗口里有（走 preload 的 window.dscNative），浏览器里没有。
          写在诊断区是因为它决定了插件能不能做"打开路径/系统通知"这类事，而这件事
          只看代码看不出来（同一个壳两种载体）。 */}
      <p className="diag-line" data-native={native.available ? 'on' : 'off'} data-native-probe={probe.state}>
        {t('layout.diag.native', {
          state: native.available
            ? t('layout.diag.nativeReady', {
                version: String(native.version ?? '?'),
                count: NATIVE_OPS.length,
                list: NATIVE_OPS.join(t('layout.common.listSep')),
              })
            : t('layout.diag.nativeAbsent'),
        })}
        {native.available && native.version !== null && native.version !== NATIVE_BRIDGE_VERSION
          ? t('layout.diag.nativeMismatch', {
              expected: String(NATIVE_BRIDGE_VERSION),
              actual: String(native.version),
            })
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
          detail: t('layout.diag.probeOk', { count: Array.isArray(list) ? list.length : 0 }),
        })
      })
      .catch((error: unknown) => {
        if (!alive) return
        const message = error instanceof Error ? error.message : String(error)
        // 桥本来就不在（浏览器 / 远程壳）——那是**预期**，不是故障：降级路径就该长这样。
        setProbe(
          native.available
            ? { state: 'error', detail: t('layout.diag.probeFailed', { message }) }
            : { state: 'off', detail: t('layout.diag.probeDegraded', { message }) },
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
  if (typeof status !== 'object' || status === null || !Array.isArray(sessions)) return t('layout.nav.newSession')
  const path = (status as Record<string, unknown>)['sessionPath']
  if (typeof path !== 'string') return t('layout.nav.newSession')
  for (const item of sessions) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (record['id'] !== path) continue
    const title = record['title']
    return typeof title === 'string' && title !== '' ? title : t('layout.nav.newSession')
  }
  return t('layout.nav.newSession')
}

/** 消息流里有没有**对话内容**（含直播尾）：空会话的居中欢迎态靠它切换。
    开场 system 条目（会话标、启动期的配置/沙箱提示）不算——它们只进日志与轨迹，
    首屏不铺；口径与消息流的欢迎态判定一致，两边不能各说各话。 */
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
