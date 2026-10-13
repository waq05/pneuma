/**
 * 右侧栏（dock）布局的纯模型：页签 / 窗格 / 会话各一份布局，零 React、零 DOM，
 * 行为单测直接跑这份源码（shots/dock-model-check.mjs）。
 *
 * 这一份**从旧渲染层原样搬来**（`desktop/src/renderer/dock-model.ts`）——旧桌面版的
 * 右侧栏就是按下面这套能力面做的，壳里不再发明第二份。持久化键（`dsc.dock.surfaces`）
 * 也是同一个：两个界面共享用户摆好的页签组（与文件预览的 `dsc.diffView` 同款思路）。
 *
 * 能力面（收窄自 dsh 的 ui-sidebar-right + ui-dockkit）：
 *   - 页签多开：终端可无限多开；浏览器 / 文件 / Git 每个布局单例（已开则聚焦）；
 *     文件预览页签（preview）按路径去重、每窗格至多 10 张（文件树单击文件的路径）；
 *   - 「开始」引导页（guide）：每个窗格至多一张，是「新标签页」的门面——
 *     入口卡选中后就地替换成那个页面（dsh 的 replaceTab: true）；
 *   - 分栏：上限两格（dsh 同款），格宽比 fraction 记在布局上；
 *   - 每个会话各一份布局（expanded / mode / 页签组），切会话各回各的面板组；
 *   - 全屏（盖住顶栏以下）与贴边（推挤正文轨道）两种展示。
 *
 * 不变量（reducer 们共同维护，测试逐条压）：
 *   - panes 至少一格、至多两格；每格至少一个页签；
 *   - 一格至多一张 guide；格内没有 guide 时才画「新标签页」钮；
 *   - 关掉激活页签自动聚焦邻位；格被清空自动补一张 guide；
 *   - activePaneId / activeTabId 永远指向存在的对象。
 *
 * @module dsc-ui-shell/dock-model
 */

export type DockTabKind =
  | 'guide' | 'terminal' | 'browser' | 'files' | 'git' | 'preview'
  /**
   * 补丁页签（一个文件一张，`path` 是它的绝对路径）：看某次 write / edit **改了什么**
   * 的 unified diff，与「文件当前内容」（preview）是**两个不同视图**。
   *
   * 为什么单开一种 kind 而不是复用 preview：两者读的是两份数据——preview 读盘上现值
   * （`fs-read`），patch 读那份已经算好的差异快照（hunks，随工具结果来）。同一份文件
   * 可以同时开着「补丁」和「当前内容」两张页签，页签条上分得清。
   */
  | 'patch'
  /**
   * 子智能体（一个子智能体一张，`path` 是它的会话文件路径）。
   *
   * 为什么单开一种 kind 而不是复用 preview：它渲染的不是文件内容，而是那个子智能体的
   * 运行记录（`peekTranscript` 回的只读条目流），而且点一行子智能体就该把它落到右侧栏
   * ——与 dsh 的 `sidebarRight.openResource(subagentChatAddress(...), {kind:'subagentchat'})`
   * 同一条路（右侧栏是只读的伴读面，不是模态框）。
   */
  | 'subagent'
  /**
   * 后台活（作业 / 持久终端会话）的**只读输出面**（一个后台活一张，`path` 是 work id）。
   *
   * 与 `subagent` 同一条理由单开一种 kind：状态面板「终端」区点一行要看的是那个后台活
   * 的输出（走 `readBackground` 的只读快照，**不是**交互式终端 `terminal` 那条可写通道），
   * 与「用户自己开的 shell」是两套东西。渲染成等宽 `<pre>`（不引 xterm），按秒轮询快照。
   *
   * 对照参考实现：后台活详情是一块独立的只读文本侧栏（`BackgroundBashOutputSidePane`），
   * 不走交互终端的可写通道——右侧栏是只读的伴读面，与 `subagent` 同一落点。
   */
  | 'work-output'

/** 一张页签：id 是毫秒 + 随机尾巴，进程内唯一即可（持久化恢复后也不与现存冲突）。 */
export interface DockTab {
  id: string
  kind: DockTabKind
  /** preview / patch = 那个文件的绝对路径；subagent = 那个子智能体的会话文件路径；work-output = 后台活 id（job-N / term-N）。 */
  path?: string
  /**
   * chip 上显示的标题（可缺）。
   *
   * 为什么要有它：子智能体的会话文件名是 uuid（`e8888…-….jsonl`），拿文件名当页签标题
   * 等于给用户一列看不懂的哈希；而它的**名字**（`reader-1`）只有开页签的那一方知道
   * （名册在 subagent 插件里）。所以标题由调用方一并交过来，壳只负责显示。
   * work-output 同样用它显示后台活的标题（作业首行 / 终端最近一条命令）。
   */
  label?: string
  /** 仅 preview 页签：打开时定位到的 1-based 行号（/review findings 的行号跳转用）。 */
  line?: number
}

/** 一个窗格：一排页签 + 当前激活的那张。 */
export interface DockPane {
  id: string
  tabs: DockTab[]
  activeTabId: string
}

/** 一个会话的右侧栏布局。 */
export interface DockSurface {
  panes: DockPane[]
  activePaneId: string
  /** 分栏时左格占的宽度比（0.2–0.8）；单格时无意义。 */
  fraction: number
  expanded: boolean
  mode: 'push' | 'fullscreen'
}

/** 每个会话一份布局（持久化的键就是会话 id）。 */
export type DockSurfaces = Record<string, DockSurface>

/**
 * Dock 组件的动作面：App 用 dock-model 的 reducer 实现，Dock 只管调。
 * 全部收口成回调，dock-model 本身不碰 React。
 */
export interface DockActions {
  /** 开一张页签（`replaceGuide` = 开始页入口卡的就地替换路径）。 */
  openTab(kind: DockTabKind, options?: { replaceGuide?: boolean }): void
  /** 开一张文件预览页签（同路径去重 = 聚焦；对齐 dsh 的 openResource）；line = 定位行号。 */
  openPreview(path: string, line?: number): void
  /** 开一张补丁页签（同路径去重 = 聚焦）：看那个文件某次 write / edit 改了什么。 */
  openPatch(path: string): void
  /** 开一张子智能体页签（同会话文件去重 = 聚焦）；label = chip 上显示的队友名。 */
  openSubagent(path: string, label?: string): void
  /** 开一张后台活输出页签（同 work id 去重 = 聚焦）；label = chip 上显示的后台活标题。 */
  openWorkOutput(id: string, label?: string): void
  closeTab(tabId: string): void
  focusTab(tabId: string): void
  focusPane(paneId: string): void
  splitPane(paneId: string): void
  /** 收回分栏（右格并回左格）。 */
  unsplit(): void
  /** 拖拽搬页签：落到目标窗格的末尾。 */
  placeTab(tabId: string, paneId: string): void
  setExpanded(expanded: boolean): void
  toggleMode(): void
  setFraction(fraction: number): void
}

/** 单例页签：一个布局里至多一张（已开再 openTab = 聚焦现成的）。 */
const SINGLETON_KINDS: readonly DockTabKind[] = ['browser', 'files', 'git']

/** 每窗格的预览页签上限：再开时自动关掉最旧的那张（页签条没有虚拟化，放不下无限多）。 */
const PREVIEW_MAX = 10

/** 分栏的宽度比夹取范围（对齐 dsh 的 minPaneFraction 0.2）。 */
const FRACTION_MIN = 0.2
const FRACTION_MAX = 0.8

let tabSeq = 0

/** 造一张新页签的 id：同毫秒内也不撞。 */
function freshId(): string {
  tabSeq += 1
  return `t${Date.now().toString(36)}${tabSeq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

function freshPaneId(): string {
  return `p${freshId()}`
}

/** 造一张指定种类的页签（preview 页签带文件路径）。 */
export function makeTab(kind: DockTabKind, path?: string): DockTab {
  return path === undefined ? { id: freshId(), kind } : { id: freshId(), kind, path }
}

/** 默认布局：一格、只有一张「开始」。新会话第一次打开右侧栏就是它。 */
export function defaultSurface(): DockSurface {
  const tab = makeTab('guide')
  const pane: DockPane = { id: freshPaneId(), tabs: [tab], activeTabId: tab.id }
  return { panes: [pane], activePaneId: pane.id, fraction: 0.5, expanded: false, mode: 'push' }
}

/** 布局里的一个窗格（找不到返回 undefined：调用方按不变量处理，这里不抛）。 */
export function paneOf(surface: DockSurface, paneId: string): DockPane | undefined {
  return surface.panes.find((pane) => pane.id === paneId)
}

/** 当前激活窗格。 */
export function activePane(surface: DockSurface): DockPane {
  return paneOf(surface, surface.activePaneId) ?? surface.panes[0]!
}

/** 某窗格现在能不能加「新标签页」（对齐 dsh：格内已有 guide 就不画加号）。 */
export function canAddTab(pane: DockPane): boolean {
  return !pane.tabs.some((tab) => tab.kind === 'guide')
}

/**
 * 开一张页签。`paneId` 缺省 = 激活窗格；`replaceGuide` = 就地替换该窗格里的
 * guide（开始页入口卡的路径）。返回新 surface；无可替换的 guide 时原样返回。
 */
export function openTab(surface: DockSurface, kind: DockTabKind, options?: { paneId?: string; replaceGuide?: boolean }): DockSurface {
  const pane = paneOf(surface, options?.paneId ?? surface.activePaneId) ?? activePane(surface)
  // 单例页签：布局里已有（任何格）就聚焦过去，不再开第二张
  if (SINGLETON_KINDS.includes(kind)) {
    const existing = surface.panes.flatMap((item) => item.tabs).find((tab) => tab.kind === kind)
    if (existing !== undefined) return focusTab(surface, existing.id)
  }
  if (options?.replaceGuide === true) {
    const guideIndex = pane.tabs.findIndex((tab) => tab.kind === 'guide')
    if (guideIndex === -1) return surface
    const replacement = makeTab(kind)
    const tabs = pane.tabs.map((tab, index) => (index === guideIndex ? replacement : tab))
    return replacePane(surface, pane.id, { ...pane, tabs, activeTabId: replacement.id })
  }
  // guide 是门面不是内容：再开 guide = 聚焦现成的；其它种类直接追加到末尾
  // （快捷键开的页面不挤掉 guide，用户回得来；入口卡的路径走上面的 replaceGuide）
  const existingGuide = pane.tabs.find((tab) => tab.kind === 'guide')
  if (kind === 'guide' && existingGuide !== undefined) {
    return focusTab(surface, existingGuide.id)
  }
  const tab = makeTab(kind)
  const tabs = [...pane.tabs, tab]
  return replacePane(surface, pane.id, { ...pane, tabs, activeTabId: tab.id })
}

/**
 * 开一张文件预览页签（对齐 dsh 的 openResource → file: 页签）：同一份文件
 * （按绝对路径认）在哪个窗格都只有一张，已开即聚焦（带上新的定位行号）；
 * 新开的追加到激活窗格末尾；该窗格预览页签到上限时关掉最旧的一张，给新的让位。
 */
export function openPreview(surface: DockSurface, path: string, line?: number): DockSurface {
  const patched = line === undefined ? {} : { line }
  const existing = surface.panes.flatMap((pane) => pane.tabs).find((tab) => tab.kind === 'preview' && tab.path === path)
  if (existing !== undefined) {
    const focused = focusTab(surface, existing.id)
    return line === undefined
      ? focused
      : {
          ...focused,
          panes: focused.panes.map((pane) => ({
            ...pane,
            tabs: pane.tabs.map((tab) => (tab.id === existing.id ? { ...tab, line } : tab)),
          })),
        }
  }
  const pane = activePane(surface)
  let tabs = [...pane.tabs]
  const previews = tabs.filter((tab) => tab.kind === 'preview')
  if (previews.length >= PREVIEW_MAX) {
    const oldest = previews[0]!
    tabs = tabs.filter((tab) => tab.id !== oldest.id)
  }
  const tab = { ...makeTab('preview', path), ...patched }
  tabs = [...tabs, tab]
  return replacePane(surface, pane.id, { ...pane, tabs, activeTabId: tab.id })
}

/**
 * 开一张补丁页签（照 {@link openPreview} 的形状）：同一个文件（按绝对路径认）只有一张，
 * 已开即聚焦；新开的追加到激活窗格末尾，不设上限。页签不认识补丁内容——那份差异快照
 * 存在壳的补丁源表里（见 dock-state 的 setDockPreview），这里只登记「哪个文件」。
 */
export function openPatch(surface: DockSurface, path: string): DockSurface {
  const existing = surface.panes.flatMap((pane) => pane.tabs).find((tab) => tab.kind === 'patch' && tab.path === path)
  if (existing !== undefined) return focusTab(surface, existing.id)
  const pane = activePane(surface)
  const tab = makeTab('patch', path)
  return replacePane(surface, pane.id, { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id })
}

/**
 * 开一张子智能体页签（照 {@link openPreview} 的形状）：同一个子智能体（按会话文件认）
 * 只有一张，已开即聚焦；新开的追加到激活窗格末尾，不设上限——右侧栏同时盯着几个队友
 * 是正常用法，而且它们各自只读、不吃内存里的大对象。
 */
export function openSubagent(surface: DockSurface, path: string, label?: string): DockSurface {
  const existing = surface.panes.flatMap((pane) => pane.tabs).find((tab) => tab.kind === 'subagent' && tab.path === path)
  if (existing !== undefined) {
    const focused = focusTab(surface, existing.id)
    return label === undefined
      ? focused
      : {
          ...focused,
          panes: focused.panes.map((pane) => ({
            ...pane,
            tabs: pane.tabs.map((tab) => (tab.id === existing.id ? { ...tab, label } : tab)),
          })),
        }
  }
  const pane = activePane(surface)
  const tab = { ...makeTab('subagent', path), ...(label === undefined ? {} : { label }) }
  return replacePane(surface, pane.id, { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id })
}

/**
 * 开一张后台活输出页签（照 {@link openSubagent} 的形状）：同一个后台活（按 work id 认）
 * 只有一张，已开即聚焦；新开的追加到激活窗格末尾，不设上限（同时盯几个后台活是正常用法，
 * 每个只读、按秒轮询，不吃内存里的大对象）。
 */
export function openWorkOutput(surface: DockSurface, id: string, label?: string): DockSurface {
  const existing = surface.panes.flatMap((pane) => pane.tabs).find((tab) => tab.kind === 'work-output' && tab.path === id)
  if (existing !== undefined) {
    const focused = focusTab(surface, existing.id)
    return label === undefined
      ? focused
      : {
          ...focused,
          panes: focused.panes.map((pane) => ({
            ...pane,
            tabs: pane.tabs.map((tab) => (tab.id === existing.id ? { ...tab, label } : tab)),
          })),
        }
  }
  const pane = activePane(surface)
  const tab = { ...makeTab('work-output', id), ...(label === undefined ? {} : { label }) }
  return replacePane(surface, pane.id, { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id })
}

/** 找到持有某张页签的窗格 id。 */
function ownerPaneId(surface: DockSurface, tabId: string): string | undefined {
  return surface.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId))?.id
}

/** 不可变替换一个窗格（含 activePane 兜底指向校验由调用方不变量保证）。 */
function replacePane(surface: DockSurface, paneId: string, next: DockPane): DockSurface {
  return { ...surface, panes: surface.panes.map((pane) => (pane.id === paneId ? next : pane)) }
}

/**
 * 关一张页签。格被清空自动补一张 guide；只剩一格时格不会消失（对齐 dsh：
 * 关的是内容，栏架子和「开始」门面永远在）。
 */
export function closeTab(surface: DockSurface, tabId: string): DockSurface {
  const owner = surface.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId))
  if (owner === undefined) return surface
  const index = owner.tabs.findIndex((tab) => tab.id === tabId)
  const tabs = owner.tabs.filter((tab) => tab.id !== tabId)
  if (tabs.length === 0) {
    const guide = makeTab('guide')
    return replacePane(surface, owner.id, { ...owner, tabs: [guide], activeTabId: guide.id })
  }
  const activeTabId = owner.activeTabId === tabId ? (tabs[index] ?? tabs[tabs.length - 1]!).id : owner.activeTabId
  return replacePane(surface, owner.id, { ...owner, tabs, activeTabId })
}

/** 聚焦一张页签（顺带把它所在的窗格设为激活）。 */
export function focusTab(surface: DockSurface, tabId: string): DockSurface {
  const paneId = ownerPaneId(surface, tabId)
  if (paneId === undefined) return surface
  return {
    ...replacePane({ ...surface, activePaneId: paneId }, paneId, {
      ...paneOf(surface, paneId)!,
      activeTabId: tabId,
    }),
  }
}

/** 聚焦一个窗格。 */
export function focusPane(surface: DockSurface, paneId: string): DockSurface {
  return paneOf(surface, paneId) === undefined ? surface : { ...surface, activePaneId: paneId }
}

/**
 * 把激活窗格一分为二（右侧新格），激活页签跟着过去。上限两格（dsh 同款）；
 * 已经两格或激活页签是格内唯一内容且是 guide 时不动（空门面不值得分）。
 */
export function splitPane(surface: DockSurface, paneId?: string): DockSurface {
  if (surface.panes.length >= 2) return surface
  const pane = paneOf(surface, paneId ?? surface.activePaneId) ?? activePane(surface)
  if (pane.tabs.length <= 1 && pane.tabs[0]?.kind === 'guide') return surface
  const rest = pane.tabs.filter((tab) => tab.id !== pane.activeTabId)
  const moving = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0]!
  if (rest.length === 0) {
    // 原格清空补 guide，激活页签搬进右格
    const guide = makeTab('guide')
    const left: DockPane = { ...pane, tabs: [guide], activeTabId: guide.id }
    const right: DockPane = { id: freshPaneId(), tabs: [moving], activeTabId: moving.id }
    return { ...surface, panes: [left, right], activePaneId: right.id }
  }
  const left: DockPane = { ...pane, tabs: rest, activeTabId: rest[rest.length - 1]!.id }
  const right: DockPane = { id: freshPaneId(), tabs: [moving], activeTabId: moving.id }
  return { ...surface, panes: [left, right], activePaneId: right.id }
}

/** 收回分栏：右格的页签全部并回左格，回到单格；左格已有 guide 时右格的 guide 让路（格内至多一张）。 */
export function unsplitPane(surface: DockSurface): DockSurface {
  if (surface.panes.length < 2) return surface
  const [left, right] = surface.panes as [DockPane, DockPane]
  const rightTabs = left.tabs.some((tab) => tab.kind === 'guide')
    ? right.tabs.filter((tab) => tab.kind !== 'guide')
    : right.tabs
  const mergedTabs = [...left.tabs, ...rightTabs]
  const merged: DockPane = {
    id: left.id,
    tabs: mergedTabs,
    activeTabId: mergedTabs.some((tab) => tab.id === left.activeTabId)
      ? left.activeTabId
      : (mergedTabs.find((tab) => tab.id === right.activeTabId) ?? mergedTabs[0]!).id,
  }
  return { ...surface, panes: [merged], activePaneId: merged.id, fraction: 0.5 }
}

/**
 * 拖拽搬页签：把一张页签挪到目标窗格的 `index` 位置（缺省 = 末尾）。
 * 源格因此清空时自动补 guide；跨格搬单例页签永远允许（格内单例由 openTab 保证，
 * 这里搬的是已存在的张）。
 */
export function placeTab(surface: DockSurface, tabId: string, toPaneId: string, index?: number): DockSurface {
  const from = surface.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId))
  const to = paneOf(surface, toPaneId)
  if (from === undefined || to === undefined) return surface
  const tab = from.tabs.find((item) => item.id === tabId)!
  if (from.id === to.id) {
    const without = from.tabs.filter((item) => item.id !== tabId)
    const at = Math.max(0, Math.min(index ?? without.length, without.length))
    const tabs = [...without.slice(0, at), tab, ...without.slice(at)]
    return replacePane(surface, to.id, { ...to, tabs, activeTabId: tabId })
  }
  const fromRest = from.tabs.filter((item) => item.id !== tabId)
  const at = Math.max(0, Math.min(index ?? to.tabs.length, to.tabs.length))
  const toTabs = [...to.tabs.slice(0, at), tab, ...to.tabs.slice(at)]
  let next = replacePane({ ...surface, activePaneId: to.id }, to.id, { ...to, tabs: toTabs, activeTabId: tabId })
  if (fromRest.length === 0) {
    const guide = makeTab('guide')
    next = replacePane(next, from.id, { ...from, tabs: [guide], activeTabId: guide.id })
  } else {
    next = replacePane(next, from.id, {
      ...from,
      tabs: fromRest,
      activeTabId: from.activeTabId === tabId ? fromRest[Math.max(0, from.tabs.findIndex((item) => item.id === tabId) - 1)]!.id : from.activeTabId,
    })
  }
  return next
}

/** 开合右侧栏（每会话各自记忆，对齐 dsh 的 expanded 在 surface 上）。 */
export function setExpanded(surface: DockSurface, expanded: boolean): DockSurface {
  return { ...surface, expanded }
}

/** 贴边 ⇄ 全屏。 */
export function toggleMode(surface: DockSurface): DockSurface {
  return { ...surface, mode: surface.mode === 'push' ? 'fullscreen' : 'push' }
}

/** 调分栏宽比（拖拽条），夹到 0.2–0.8。 */
export function setFraction(surface: DockSurface, fraction: number): DockSurface {
  if (!Number.isFinite(fraction)) return surface
  return { ...surface, fraction: Math.min(FRACTION_MAX, Math.max(FRACTION_MIN, fraction)) }
}

// ── 持久化（localStorage） ────────────────────────────────────────────────────

const STORAGE_KEY = 'dsc.dock.surfaces'
/** 最多记住多少个会话的布局：会话是流水，旧的让路。 */
const MAX_SESSIONS = 30

/** 存档能不能读成一份布局（认不出就地作废，回默认值，不把右侧栏带崩）。 */
function parseSurface(value: unknown): DockSurface | null {
  if (typeof value !== 'object' || value === null) return null
  const doc = value as Partial<DockSurface>
  if (!Array.isArray(doc.panes) || doc.panes.length === 0 || doc.panes.length > 2) return null
  const panes: DockPane[] = []
  for (const raw of doc.panes) {
    const pane = raw as Partial<DockPane>
    if (!Array.isArray(pane.tabs) || pane.tabs.length === 0) return null
    const tabs: DockTab[] = []
    for (const item of pane.tabs) {
      const entry = item as Partial<DockTab>
      if (typeof entry?.id !== 'string' || typeof entry?.kind !== 'string') return null
      if (!['guide', 'terminal', 'browser', 'files', 'git', 'preview', 'patch', 'subagent', 'work-output'].includes(entry.kind)) return null
      // preview / patch 页签落盘要带路径；路径丢了这张页签就没有内容，整格作废重画。
      // patch 只存路径，差异快照（hunks）不落盘——启动后回到该页签会提示补丁已过期。
      if (entry.kind === 'preview') {
        if (typeof entry.path !== 'string' || entry.path === '') return null
        tabs.push({ id: entry.id, kind: 'preview', path: entry.path, ...(typeof entry.line === 'number' ? { line: entry.line } : {}) })
      } else if (entry.kind === 'patch') {
        if (typeof entry.path !== 'string' || entry.path === '') return null
        tabs.push({ id: entry.id, kind: 'patch', path: entry.path })
      } else if (entry.kind === 'subagent') {
        // 子智能体页签：路径就是它的全部内容（丢了这张页签没东西可读），label 是标题。
        if (typeof entry.path !== 'string' || entry.path === '') return null
        tabs.push({
          id: entry.id,
          kind: 'subagent',
          path: entry.path,
          ...(typeof entry.label === 'string' && entry.label !== '' ? { label: entry.label } : {}),
        })
      } else if (entry.kind === 'work-output') {
        // 后台活输出页签：path 是 work id（丢了就不知道读谁），label 是标题。
        if (typeof entry.path !== 'string' || entry.path === '') return null
        tabs.push({
          id: entry.id,
          kind: 'work-output',
          path: entry.path,
          ...(typeof entry.label === 'string' && entry.label !== '' ? { label: entry.label } : {}),
        })
      } else {
        tabs.push({ id: entry.id, kind: entry.kind as DockTabKind })
      }
    }
    if (typeof pane.id !== 'string' || typeof pane.activeTabId !== 'string' || !tabs.some((tab) => tab.id === pane.activeTabId)) return null
    panes.push({ id: pane.id, tabs, activeTabId: pane.activeTabId })
  }
  if (typeof doc.activePaneId !== 'string' || !panes.some((pane) => pane.id === doc.activePaneId)) return null
  return {
    panes,
    activePaneId: doc.activePaneId,
    fraction: typeof doc.fraction === 'number' && Number.isFinite(doc.fraction) ? Math.min(FRACTION_MAX, Math.max(FRACTION_MIN, doc.fraction)) : 0.5,
    expanded: doc.expanded === true,
    mode: doc.mode === 'fullscreen' ? 'fullscreen' : 'push',
  }
}

/**
 * 读存档。存坏了 / 认不出的会话直接丢（该会话回默认布局），绝不因存档把启动带崩。
 */
export function loadSurfaces(): DockSurfaces {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const surfaces: DockSurfaces = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      const surface = parseSurface(value)
      if (surface !== null) surfaces[sessionId] = surface
    }
    return surfaces
  } catch {
    return {}
  }
}

/** 落盘；超出上限的旧会话布局按「键序先后」丢最前的（插入序即使用序的老新）。 */
export function saveSurfaces(surfaces: DockSurfaces): void {
  try {
    const ids = Object.keys(surfaces)
    const trimmed = ids.length <= MAX_SESSIONS ? surfaces : Object.fromEntries(ids.slice(ids.length - MAX_SESSIONS).map((id) => [id, surfaces[id]]))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // 隐私模式 / 配额满：布局只是便利，存不进去就下次按默认画
  }
}
