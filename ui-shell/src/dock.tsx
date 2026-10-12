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
import { IconBranch, IconFolder, IconGlobe, IconSidebar, IconTerminal } from './icons'
import { FileIcon } from './platform/file-icons'
import { canAddTab, type DockPane, type DockSurface, type DockTab, type DockTabKind } from './dock-model'
import { dockActions, dockTabMeta, useDockSurface } from './dock-state'

/** 窄视口自动全屏的阈值（对齐旧桌面版）。 */
const NARROW_VIEWPORT = 768

/** 页签 chip 上的图标与标题；preview 的 chip 用文件自己的彩色图标，见 Chip。 */
const KIND_META: Record<Exclude<DockTabKind, 'preview'>, { title: string; icon: (props: { size: number }) => JSX.Element }> = {
  guide: { title: '开始', icon: IconGlobe },
  terminal: { title: '终端', icon: IconTerminal },
  browser: { title: '浏览器', icon: IconGlobe },
  files: { title: '文件', icon: IconFolder },
  git: { title: 'Git', icon: IconBranch },
}

/** 「开始」页的入口卡（旧桌面版同款：最多四张，都带描述与快捷键角标）。 */
const GUIDE_ENTRIES: { kind: DockTabKind; title: string; description: string; tone: string; shortcut?: string }[] = [
  { kind: 'files', title: '工作区文件', description: '浏览会话工作区的文件', tone: 'tone-folder', shortcut: 'Ctrl + P' },
  { kind: 'terminal', title: '新建终端', description: '在会话工作区运行命令', tone: 'tone-terminal', shortcut: 'Ctrl + `' },
  { kind: 'browser', title: '浏览器', description: '浏览网页', tone: 'tone-browser', shortcut: 'Ctrl + T' },
  { kind: 'git', title: 'Git 管理', description: '分支、暂存与提交', tone: 'tone-git' },
]

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
    const onMove = (move: MouseEvent): void => {
      props.onResize(Math.min(820, Math.max(300, startWidth - (move.clientX - startX))))
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
          data-tip="拖拽调整宽度，双击复位"
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
            data-tip="拖拽调整分栏，双击收回分栏"
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
            向右分栏
          </button>
          <button
            className="menu-item"
            onClick={() => {
              actions.unsplit()
              setMenu(null)
            }}
          >
            收回分栏
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              actions.closeTab(menu.tabId)
              setMenu(null)
            }}
          >
            关闭页签
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
          <button className="dock-add" data-tip="新标签页" onClick={() => actions.openTab('guide')}>
            +
          </button>
        )}
        <span className="dock-strip-fill" />
        {props.chrome && (
          <>
            <button
              className="dock-chrome-btn"
              data-tip={surface.mode === 'fullscreen' ? '退出全屏' : '全屏'}
              aria-label={surface.mode === 'fullscreen' ? '退出全屏' : '全屏'}
              onClick={actions.toggleMode}
            >
              {surface.mode === 'fullscreen' ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
            </button>
            <button
              className="dock-chrome-btn"
              data-tip="收起侧边栏"
              aria-label="收起侧边栏"
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
            actions={actions}
          />
        ))}
      </div>
    </section>
  )
}

/** 一张页签的体：guide 门面 / 注册的 kind 组件（keepMounted 藏而不卸）/ 未装占位。 */
function TabBody(props: {
  tab: DockTab
  active: boolean
  expanded: boolean
  actions: typeof dockActions
}): ReactNode {
  const { tab, active, expanded } = props
  if (tab.kind === 'guide') {
    return active ? <GuideBody actions={props.actions} /> : null
  }
  const meta = dockTabMeta(tab.kind)
  if (meta === undefined) {
    // 未注册的 kind（比如那个插件没装上）：页签还在，画一句能读的占位，别给一张白板。
    return active && expanded ? (
      <div className="dock-tab-body">
        <div className="trace-empty">这块面板的界面没有装上（kind：{tab.kind}）。</div>
      </div>
    ) : null
  }
  const visible = active && expanded
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
  // preview 页签：图标是文件自己的彩色图标，标题是文件名（其它的走 KIND_META）
  const meta = props.tab.kind === 'preview' ? undefined : KIND_META[props.tab.kind]
  const title = meta !== undefined ? meta.title : basenameOf(props.tab.path ?? '')
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
      {meta !== undefined ? (
        <meta.icon size={13} />
      ) : (
        <FileIcon name={title} size={13} className="dock-chip-fileicon" />
      )}
      <span className="dock-chip-label">{title}</span>
      <span
        className="dock-chip-close"
        data-tip="关闭页签"
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

/** 「开始」页：罗盘 + 入口卡；选一项就地替换这张 guide（旧桌面版的 replaceTab 路径）。 */
function GuideBody(props: { actions: typeof dockActions }): JSX.Element {
  return (
    <div className="dock-guide">
      <span className="dock-guide-hero" aria-hidden="true">
        <CompassGlyph />
      </span>
      <div className="dock-guide-cards">
        {GUIDE_ENTRIES.map((entry) => (
          <button
            key={entry.kind}
            className="dock-guide-entry"
            onClick={() => props.actions.openTab(entry.kind, { replaceGuide: true })}
          >
            <span className={`dock-guide-icon ${entry.tone}`}>
              {entry.kind === 'files' && <IconFolder size={17} />}
              {entry.kind === 'terminal' && <IconTerminal size={17} />}
              {entry.kind === 'browser' && <IconGlobe size={17} />}
              {entry.kind === 'git' && <IconBranch size={17} />}
            </span>
            <span className="dock-guide-text">
              <span className="dock-guide-title">{entry.title}</span>
              <span className="dock-guide-desc">{entry.description}</span>
            </span>
            {entry.shortcut !== undefined && <kbd className="dock-guide-key">{entry.shortcut}</kbd>}
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
