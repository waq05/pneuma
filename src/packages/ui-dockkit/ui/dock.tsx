/**
 * 右侧栏（dock）：多页签面板的渲染层——**从旧桌面版 `Dock.tsx` 搬来**，
 * 布局算法在 `./dock-model`，状态在 `./dock-state`，这一份只管画。
 *
 * 结构（与旧桌面版逐块同构）：
 *   - 页签条：chip（图标 + 标题）可点击聚焦、中键关闭、右键菜单（关闭 / 向右分栏 /
 *     收回分栏）、可拖拽跨窗格；条尾是 chrome 两钮——全屏切换与收起；
 *     格内没有「开始」页时画 `+` 钮（就地开/聚焦一张 guide）。
 *   - 「开始」页（guide）：罗盘 + 入口卡，选中一项就地替换成那个页面——它是门面，
 *     不是常驻内容。
 *   - 页面体挂载规则：报名了 `keepMounted` 的 kind（终端）切页签/窗格只藏不卸，
 *     进程与输出存活；其余 kind 只在激活且展开时挂载。
 *   - 展示：贴边（占正文轨道）与全屏（盖住顶栏以下、保留轨道宽度）两种，窄视口
 *     （<768px，对齐旧桌面版）自动全屏；收起是整块滑出右缘，不卸载内容。
 *
 * @module dsc-ui-shell/dock
 */
import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { IconBranch, IconFolder, IconGlobe, IconSidebar, IconTerminal, FileIcon } from '@dsc/ui-primitives'
import {
  canAddTab,
  dockTabMeta,
  registerDockTab,
  type DockGuideEntry,
  type DockPane,
  type DockSurface,
  type DockTab,
  type DockTabBodyProps,
  type DockTabKind,
} from './dock-model'
import { dockActions, useDockGuideEntries, useDockSurface, useDockTabKinds } from './dock-state'
import { createT } from '@dsc/ui-core'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui-core` 的 `createT`）。 */
const t = createT({ zh, en })

/** 窄视口自动全屏的阈值（对齐旧桌面版）。 */
const NARROW_VIEWPORT = 768

/** 正文至少留多宽：与 legacy/views.css 里 .thread-main 的 min-width 同源。 */
const THREAD_FLOOR = 480

/** 侧栏此刻占多宽（收起时是 0）：从 DOM 现量，比读 CSS 变量更不容易漂。 */
function sidebarWidth(): number {
  const sidebar = document.querySelector('.sidebar')
  return sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect().width : 0
}

/**
 * 右侧栏此刻最多能拖多宽。
 *
 * 只看固定的 820 上限是不够的（2026-10-30 报障）：窗口不够宽时拖到 820 会把正文压到
 * 一百来像素，中文逐字换行、输入框控件叠成一团。这里按「窗口宽 − 侧栏 − 正文保底」
 * 现算，再把配置上限取小——空间不够时先保正文，右栏停在那儿不再变宽。
 */
function dockDragLimit(): number {
  const room = window.innerWidth - sidebarWidth() - THREAD_FLOOR
  return Math.min(820, Math.max(300, room))
}

/**
 * 「开始」页的**壳自带**入口卡：文件 / 终端 / 浏览器 / Git 这四张。
 *
 * 为什么这四张留在壳里而不是各家插件自己报：它们开的是壳自己的四种内置页面
 * （kind 久已在 `DockTabKind` 的闭集合里），文案也一直住在 dockkit 的字典里。
 * 但「留在壳里」不等于「一直画」——下面按报名表过滤：**那种页签没报名（插件停用）
 * 就不画它这张卡**，与插件自己报名的入口卡同一条规矩。
 *
 * 旁问（2026-10-26 从左侧栏搬来）不在这张表里：它归 `ui-ask`，由插件报名时一并
 * 交上来（见 `DockTabKindMeta.guide`）——它在壳里硬编码过一份，插件停用后那张卡
 * 还留在开始页上（2026-11-06 报障）。
 */
const GUIDE_DEFAULTS: ReadonlyArray<DockGuideEntry & { kind: DockTabKind }> = [
  {
    kind: 'files',
    title: t('dockkit.guide.files.title'),
    description: t('dockkit.guide.files.desc'),
    tone: 'tone-folder',
    shortcut: 'Ctrl + P',
    icon: <IconFolder size={17} />,
  },
  {
    kind: 'terminal',
    title: t('dockkit.guide.terminal.title'),
    description: t('dockkit.guide.terminal.desc'),
    tone: 'tone-terminal',
    shortcut: 'Ctrl + `',
    icon: <IconTerminal size={17} />,
  },
  {
    kind: 'browser',
    title: t('dockkit.guide.browser.title'),
    description: t('dockkit.guide.browser.desc'),
    tone: 'tone-browser',
    shortcut: 'Ctrl + T',
    icon: <IconGlobe size={17} />,
  },
  {
    kind: 'git',
    title: t('dockkit.guide.git.title'),
    description: t('dockkit.guide.git.desc'),
    tone: 'tone-git',
    icon: <IconBranch size={17} />,
  },
]

/**
 * 「开始」页自己也是一种报名的页签（壳自带的那一种）。
 *
 * 为什么把 guide 也塞进报名表：页签条画 chip 时要属于它的标题与图标，页签体要它的
 * 组件。旧写法在 `KIND_META` 里给 guide 单开一格、在 `TabBody` 里单开一个 if——
 * 两处都可能漏改，而「漏掉的那种 kind 在插件停用后还留着」正是这次要根治的形态。
 */
registerDockTab({
  kind: 'guide',
  label: t('dockkit.kind.guide'),
  icon: <IconGlobe size={13} />,
  component: GuideBody,
})

/** 右侧栏组件：贴边/全屏两种展示，收起时整块滑出右缘（内容不卸载）。 */
export function Dock(props: {
  /** 贴边模式的宽度（px）；拖拽调宽、双击复位由壳负责存档。 */
  width: number
  onResize(width: number): void
}): JSX.Element {
  const surface = useDockSurface()
  const actions = dockActions
  // 窄视口自动全屏（对齐旧桌面版）：只影响展示，不写回布局
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_VIEWPORT)
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < NARROW_VIEWPORT)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const fullscreen = narrow || surface.mode === 'fullscreen'

  // 右键菜单：哪张页签 + 弹在屏幕哪个点（fixed 定位贴着指针）
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const setMenuTab = useCallback((tabId: string | null, x?: number, y?: number): void => {
    setMenu(tabId === null ? null : { tabId, x: x ?? 0, y: y ?? 0 })
  }, [])

  // 左边缘拖拽调宽：mousedown 后挂 window 监听，双击复位由拖拽条处理
  const startResize = (event: ReactMouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = props.width
    // 上限在按下这一刻算一次：拖的过程中窗口不会变宽，跟着每帧算反而会让手感发飘
    const limit = dockDragLimit()
    const onMove = (move: MouseEvent): void => {
      props.onResize(Math.min(limit, Math.max(300, startWidth - (move.clientX - startX))))
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

  // 分栏拖拽条：按指针在窗格行里的横坐标比例调 fraction
  const panesRef = useRef<HTMLDivElement | null>(null)
  const startSplit = (event: ReactMouseEvent): void => {
    event.preventDefault()
    const host = panesRef.current
    if (host === null) return
    const onMove = (move: MouseEvent): void => {
      const rect = host.getBoundingClientRect()
      if (rect.width === 0) return
      actions.setFraction((move.clientX - rect.left) / rect.width)
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

  return (
    <aside
      className={`dock${fullscreen ? ' mode-fullscreen' : ''}${surface.expanded ? '' : ' collapsed'}`}
      style={fullscreen ? undefined : { width: props.width, marginRight: surface.expanded ? undefined : -props.width }}
      aria-hidden={!surface.expanded || undefined}
    >
      {!fullscreen && (
        <div
          className="dock-resizer"
          data-tip={t('dockkit.resizer.tip')}
          onMouseDown={startResize}
          onDoubleClick={() => props.onResize(420)}
        />
      )}
      {/* 非全屏时自带的窗口控件条：贴边模式的 dock 整高顶到窗口顶，没有这条的话
          页签条会骑进原生最小化/最大化/关闭的高度里，条尾 chrome 两钮会被盖住。 */}
      {!fullscreen && <div className="caption-bar" aria-hidden="true" />}
      <div className="dock-panes" ref={panesRef}>
        {surface.panes.map((item, index) => (
          <Pane
            key={item.id}
            surface={surface}
            pane={item}
            active={item.id === surface.activePaneId}
            actions={actions}
            fraction={surface.fraction}
            first={index === 0}
            chrome={index === surface.panes.length - 1}
            menuTab={menu}
            setMenuTab={setMenuTab}
          />
        ))}
        {surface.panes.length === 2 && (
          <div
            className="dock-split"
            data-tip={t('dockkit.split.tip')}
            onMouseDown={startSplit}
            onDoubleClick={actions.unsplit}
          />
        )}
      </div>
      {menu !== null && <div className="menu-backdrop" onClick={() => setMenu(null)} />}
      {menu !== null && (
        <div
          className="row-menu dock-tab-menu"
          style={{
            position: 'fixed',
            left: Math.min(menu.x, window.innerWidth - 140),
            // dock 区贴着窗口底缘：不夹取的话菜单下半截会伸出窗外
            top: Math.min(menu.y, window.innerHeight - 120),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="menu-item"
            onClick={() => {
              actions.splitPane(menu.tabId)
              setMenu(null)
            }}
          >
            {t('dockkit.menu.split')}
          </button>
          <button
            className="menu-item"
            onClick={() => {
              actions.unsplit()
              setMenu(null)
            }}
          >
            {t('dockkit.menu.unsplit')}
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              actions.closeTab(menu.tabId)
              setMenu(null)
            }}
          >
            {t('dockkit.closeTab')}
          </button>
        </div>
      )}
    </aside>
  )
}

/** 一个窗格：页签条（chips + 加号 + chrome）与页面体。 */
function Pane(props: {
  surface: DockSurface
  pane: DockPane
  active: boolean
  actions: typeof dockActions
  fraction: number
  first: boolean
  /** chrome 两钮（全屏/收起）只骑在最右窗格的条尾（对齐旧桌面版）。 */
  chrome: boolean
  menuTab: { tabId: string; x: number; y: number } | null
  setMenuTab(tabId: string | null, x?: number, y?: number): void
}): JSX.Element {
  const { surface, pane, actions } = props
  return (
    <section
      className="dock-pane"
      style={
        surface.panes.length === 2
          ? { flex: `0 0 calc(${((props.first ? props.fraction : 1 - props.fraction) * 100).toString()}% - 4px)` }
          : undefined
      }
      onMouseDown={() => {
        if (!props.active) actions.focusPane(pane.id)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const tabId = event.dataTransfer.getData('text/plain')
        if (tabId !== '') actions.placeTab(tabId, pane.id)
      }}
    >
      <div className="dock-strip">
        {pane.tabs.map((tab) => (
          <Chip
            key={tab.id}
            tab={tab}
            on={props.active && pane.activeTabId === tab.id}
            actions={actions}
            onMenu={props.setMenuTab}
            menuOpen={props.menuTab?.tabId === tab.id}
          />
        ))}
        {canAddTab(pane) && (
          <button className="dock-add" data-tip={t('dockkit.add.tip')} onClick={() => actions.openTab('guide')}>
            +
          </button>
        )}
        <span className="dock-strip-fill" />
        {props.chrome && (
          <>
            <button
              className="dock-chrome-btn"
              data-tip={surface.mode === 'fullscreen' ? t('dockkit.chrome.exitFullscreen') : t('dockkit.chrome.fullscreen')}
              aria-label={surface.mode === 'fullscreen' ? t('dockkit.chrome.exitFullscreen') : t('dockkit.chrome.fullscreen')}
              onClick={actions.toggleMode}
            >
              {surface.mode === 'fullscreen' ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
            </button>
            <button
              className="dock-chrome-btn"
              data-tip={t('dockkit.chrome.collapse')}
              aria-label={t('dockkit.chrome.collapse')}
              onClick={() => actions.setExpanded(false)}
            >
              <IconSidebar size={15} />
            </button>
          </>
        )}
      </div>
      <div className="dock-pane-body">
        {pane.tabs.map((tab) => (
          <TabBody
            key={tab.id}
            tab={tab}
            active={props.active && pane.activeTabId === tab.id}
            expanded={surface.expanded}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * 一张页签的体：报名的组件（keepMounted 藏而不卸）/ 未报名占位。
 *
 * 「开始」页也是报名进来的一种 kind（见文件尾的 `registerDockTab`），这里不再有
 * 「guide 特殊、其余走报名表」的分叉——分叉漏一条，被漏的那条就会在插件停用后
 * 继续画出来。
 */
function TabBody(props: DockTabBodyProps): ReactNode {
  const { tab, active, expanded } = props
  const meta = dockTabMeta(tab.kind)
  if (meta === undefined) {
    // 未注册的 kind（比如那个插件没装上）：页签还在，画一句能读的占位，别给一张白板。
    return active && expanded ? (
      <div className="dock-tab-body">
        <div className="trace-empty">{t('dockkit.missing', { kind: tab.kind })}</div>
      </div>
    ) : null
  }
  if (meta.keepMounted === true) {
    // 终端：藏起来不卸载，进程与输出都活着
    return (
      <div className="dock-tab-body" style={active ? undefined : { display: 'none' }}>
        <meta.component tab={tab} active={active} expanded={expanded} />
      </div>
    )
  }
  return active && expanded ? (
    <div className="dock-tab-body">
      <meta.component tab={tab} active={active} expanded={expanded} />
    </div>
  ) : null
}

/** 页签 chip：图标 + 标题，hover 出关闭点；中键关闭；拖拽搬移；右键开菜单。 */
function Chip(props: {
  tab: DockTab
  on: boolean
  actions: typeof dockActions
  onMenu(tabId: string | null, x: number, y: number): void
  menuOpen: boolean
}): JSX.Element {
  // 标题与图标都从报名表来（谁报名谁负责）。preview / patch 例外：图标用文件自己的彩色图标。
  const meta = dockTabMeta(props.tab.kind)
  const fileIcon = props.tab.kind === 'preview' || props.tab.kind === 'patch'
  // 标题来源三档：页签自带的 label（子智能体那种「文件名不可读」的页签）→ 类别名 → 路径尾段。
  const title =
    props.tab.label !== undefined && props.tab.label !== ''
      ? props.tab.label
      : meta === undefined || meta.titleFromPath === true
        ? basenameOf(props.tab.path ?? '')
        : meta.label
  return (
    <button
      className={`dock-chip${props.on ? ' on' : ''}${props.menuOpen ? ' menu' : ''}`}
      onClick={() => props.actions.focusTab(props.tab.id)}
      onAuxClick={(event) => {
        if (event.button === 1) props.actions.closeTab(props.tab.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        props.onMenu(props.menuOpen ? null : props.tab.id, event.clientX, event.clientY)
      }}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('text/plain', props.tab.id)}
      title={title}
    >
      {fileIcon || meta?.icon === undefined ? (
        <FileIcon name={title} size={13} className="dock-chip-fileicon" />
      ) : (
        meta.icon
      )}
      <span className="dock-chip-label">{title}</span>
      <span
        className="dock-chip-close"
        data-tip={t('dockkit.closeTab')}
        onClick={(event) => {
          event.stopPropagation()
          props.actions.closeTab(props.tab.id)
        }}
      >
        ✕
      </span>
    </button>
  )
}

/**
 * 「开始」页：罗盘 + 入口卡；选一项就地替换这张 guide（旧桌面版的 replaceTab 路径）。
 *
 * 卡的来源只有两处：壳自带的四张（按报名表过滤）与插件报名时交上来的（`guide`
 * 字段）。**没有第三处**——硬编码一张属于插件的卡，就等于给「停用后仍显示」留了后门。
 */
function GuideBody(): JSX.Element {
  const kinds = useDockTabKinds()
  const contributed = useDockGuideEntries()
  // 两张来源合成一张表，每项都带着「点它开哪种页签」：
  //   - 壳自带的四张：只在那种页签报名着的时候画（插件停用 → 卡消失）；
  //   - 插件报名的：报名表里 `guide` 与 kind 本来就绑在同一个 meta 上，按身份反查。
  const entries: { kind: DockTabKind; card: DockGuideEntry }[] = [
    ...GUIDE_DEFAULTS.filter((item) => kinds.some((meta) => meta.kind === item.kind)).map((item) => ({
      kind: item.kind,
      card: item,
    })),
    ...contributed.flatMap((card) => {
      const meta = kinds.find((item) => item.guide === card)
      return meta === undefined ? [] : [{ kind: meta.kind, card }]
    }),
  ]
  return (
    <div className="dock-guide">
      <span className="dock-guide-hero" aria-hidden="true">
        <CompassGlyph />
      </span>
      <div className="dock-guide-cards">
        {entries.map(({ kind, card }) => (
          <button
            key={kind}
            className="dock-guide-entry"
            onClick={() => dockActions.openTab(kind, { replaceGuide: true })}
          >
            <span className={`dock-guide-icon ${card.tone}`}>{card.icon}</span>
            <span className="dock-guide-text">
              <span className="dock-guide-title">{card.title}</span>
              <span className="dock-guide-desc">{card.description}</span>
            </span>
            {card.shortcut !== undefined && <kbd className="dock-guide-key">{card.shortcut}</kbd>}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 罗盘（旧桌面版开始页的 hero 图形）：圆环 + 指针。 */
function CompassGlyph(): JSX.Element {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.4" opacity="0.45" />
      <path d="M15.8 8.2 13.4 13.4 8.2 15.8 10.6 10.6Z" fill="currentColor" opacity="0.6" />
    </svg>
  )
}

/** 全屏展开图形（四角向外的取景框）。 */
function FullscreenGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.33 10.4v2.76c0 .28.22.5.5.5h2.66v1H2.83a1.5 1.5 0 0 1-1.5-1.5V10.4h1Zm12.34 2.76a1.5 1.5 0 0 1-1.5 1.5h-2.67v-1h2.67a.5.5 0 0 0 .5-.5V10.4h1v2.76ZM13.17 1.33a1.5 1.5 0 0 1 1.5 1.5v2.57h-1V2.83a.5.5 0 0 0-.5-.5h-2.67v-1h2.67ZM5.5 2.33H2.83a.5.5 0 0 0-.5.5v2.57h-1V2.83a1.5 1.5 0 0 1 1.5-1.5H5.5v1Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** 退出全屏图形（两个对角的收拢箭头）。 */
function ExitFullscreenGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9 2.5V6c0 .27.1.52.29.71.19.18.44.29.71.29h3.5" stroke="currentColor" />
      <path d="M7 13.5V10a1 1 0 0 0-1-1H2.5" stroke="currentColor" />
    </svg>
  )
}

/** 路径尾段（preview chip 的标题）。 */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}
