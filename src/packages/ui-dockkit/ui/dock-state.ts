/**
 * 右侧栏（dock）的布局真源：**每个会话一份页签布局**，剪贴在这份模块状态里。
 *
 * 与旧桌面版同构（布局算法在 `./dock-model`，这一份是它的 React 接线）：
 *   - 会话切换时整份布局跟着换（`setDockSession`，壳从宿主快照的 sessionId 调）；
 *   - 任何变更**顺手落盘**（localStorage `dsc.dock.surfaces`，键与旧界面共用——
 *     两个界面切来切去时页签组不会各摆各的）；
 *   - 展示态（展开 / 全屏 / 分栏比）也在布局里，所以「切回会话，面板组还是那一套」。
 *
 * ## 页签内容从哪来
 *
 * 布局只管「有哪些页签」（kind + 可选 path），**每种 kind 长什么样**由插件经
 * {@link registerDockTab} 报名：图标 / 标题 / 渲染组件 / 是否 keepMounted。
 * 这与旧桌面版的内置页面表同构，但壳里内容归插件（终端、文件、预览各是各的），
 * 「开始」页与浏览器是壳自己的两个内置 kind。
 *
 * ## 为什么不用 React context
 *
 * 槽条目的渲染树与壳的 App 不在同一条 props 链上（插件是壳按启动图动态装上去的），
 * 而这一份状态本来就与渲染树无关——订阅式单例最贴合。
 *
 * @module dsc-ui-shell/dock-state
 */
import { useSyncExternalStore } from 'react'
import { createSignal, type ChangedFileView } from '@dsc/ui-core'
import {
  closeTab as modelCloseTab,
  defaultSurface,
  dockGuideEntries,
  dockTabKinds,
  dockTabMeta,
  focusPane as modelFocusPane,
  focusTab as modelFocusTab,
  loadSurfaces,
  openBrowserTab as modelOpenBrowserTab,
  openPreview as modelOpenPreview,
  openPatch as modelOpenPatch,
  openSubagent as modelOpenSubagent,
  openTab as modelOpenTab,
  openWorkOutput as modelOpenWorkOutput,
  placeTab as modelPlaceTab,
  removeKindTabs,
  saveSurfaces,
  setExpanded as modelSetExpanded,
  setFraction as modelSetFraction,
  setTabInfo as modelSetTabInfo,
  splitPane as modelSplitPane,
  subscribeDockKinds,
  toggleMode as modelToggleMode,
  unsplitPane as modelUnsplitPane,
  type DockActions,
  type DockGuideEntry,
  type DockSurface,
  type DockSurfaces,
  type DockTab,
  type DockTabKind,
  type DockTabKindMeta,
} from './dock-model'

export type { DockActions, DockGuideEntry, DockPane, DockSurface, DockTab, DockTabBodyProps, DockTabKind, DockTabKindMeta } from './dock-model'

// ── 布局状态（每会话一份） ────────────────────────────────────────────────────

let surfaces: DockSurfaces = loadSurfaces()
let sessionId = ''
let surface: DockSurface = surfaces[''] ?? defaultSurface()

/**
 * 变更通道（`createSignal` 的「值在别处」用法）。
 *
 * 这一个文件里其实有四份状态：布局、页签注册表、审查目标、补丁源。它们共用一条通知通道，
 * 各自的读函数（`dockSurface` / `dockTabKinds` / `dockReview` / `patchSources`）负责取出自己那份。
 * 所以这里不用 `set` 存值，只用 `notify`：谁改完谁喊一声，订阅者各自重读。
 */
const dockChannel = createSignal(0)

/**
 * 切到某个会话的布局（壳从宿主快照的 sessionId 调；没会话时传空串）。
 *
 * 切走的会话布局留在 {@link surfaces} 与 localStorage 里——切回来还是那一套页签。
 */
export function setDockSession(id: string): void {
  if (id === sessionId) return
  sessionId = id
  surface = surfaces[id] ?? defaultSurface()
  dockChannel.notify()
}

/** 派发一个布局变更：以当前会话布局为基，算完顺手落盘（布局很小，写 localStorage 便宜）。 */
function mutate(fn: (s: DockSurface) => DockSurface): void {
  const next = fn(surface)
  if (next === surface) return
  surface = next
  surfaces = { ...surfaces, [sessionId]: next }
  saveSurfaces(surfaces)
  dockChannel.notify()
}

/** 订阅布局变化（`useSyncExternalStore` 的订阅函数）。 */
export function subscribeDock(listener: () => void): () => void {
  return dockChannel.subscribe(listener)
}

/** 当前会话的布局（`useSyncExternalStore` 的取数函数；引用稳定，变更才换）。 */
export function dockSurface(): DockSurface {
  return surface
}

/**
 * 这个 kind 现在有没有界面（guide 是壳自己的门面，永远有）。
 *
 * 停用一个界面插件之后，别处那些「按 id 张罗开页签」的入口（Ctrl+P、桌面侧事件、
 * 工具卡的「打开」）会继续被触发；这里统一挡掉，免得开出一张渲染不出内容的空壳，
 * 也免得顺手把右栏展开成一片空白。
 */
function hasDockKind(kind: DockTabKind): boolean {
  return kind === 'guide' || dockTabMeta(kind) !== undefined
}

/**
 * 布局动作表（旧桌面版 App 里的同一套接线：开预览顺手展开侧栏）。
 *
 * 做常量而不是工厂：动作全是 `mutate` 的薄包装，没有闭包状态，引用天然稳定。
 */
export const dockActions: DockActions = {
  openTab: (kind, options) => {
    if (!hasDockKind(kind)) return
    mutate((s) => modelOpenTab(s, kind, options))
  },
  openPreview: (path, line) => {
    if (!hasDockKind('preview')) return
    mutate((s) => modelSetExpanded(modelOpenPreview(s, path, line), true))
  },
  openBrowserTab: (url, label, id) => {
    if (!hasDockKind('browser')) return
    mutate((s) => modelSetExpanded(modelOpenBrowserTab(s, url, label, id), true))
  },
  setTabInfo: (tabId, patch) => {
    // 不展开：这是网页自己在回填标题 / 地址，不是用户点了一下（不该把侧栏顶出来）
    mutate((s) => modelSetTabInfo(s, tabId, patch))
  },
  openPatch: (path) => {
    if (!hasDockKind('patch')) return
    mutate((s) => modelSetExpanded(modelOpenPatch(s, path), true))
  },
  openSubagent: (path, label) => {
    if (!hasDockKind('subagent')) return
    mutate((s) => modelSetExpanded(modelOpenSubagent(s, path, label), true))
  },
  openWorkOutput: (id, label) => {
    if (!hasDockKind('work-output')) return
    mutate((s) => modelSetExpanded(modelOpenWorkOutput(s, id, label), true))
  },
  closeTab: (tabId) => {
    mutate((s) => modelCloseTab(s, tabId))
  },
  focusTab: (tabId) => {
    mutate((s) => modelFocusTab(s, tabId))
  },
  focusPane: (paneId) => {
    mutate((s) => modelFocusPane(s, paneId))
  },
  splitPane: (paneId) => {
    mutate((s) => modelSplitPane(s, paneId))
  },
  unsplit: () => {
    mutate((s) => modelUnsplitPane(s))
  },
  placeTab: (tabId, paneId) => {
    mutate((s) => modelPlaceTab(s, tabId, paneId))
  },
  setExpanded: (expanded) => {
    mutate((s) => modelSetExpanded(s, expanded))
  },
  toggleMode: () => {
    mutate((s) => modelToggleMode(s))
  },
  setFraction: (fraction) => {
    mutate((s) => modelSetFraction(s, fraction))
  },
}

/** 展开右侧栏并就地替换「开始」页（开始页入口卡与快捷键的路径，旧界面同款）。 */
export function openDockTab(kind: DockTabKind): void {
  // 没报名的 kind 连栏都不展开：Ctrl+P 打在已停用的文件插件上时，用户不该看见一片空白。
  if (!hasDockKind(kind)) return
  mutate((s) => modelSetExpanded(modelOpenTab(s, kind, { replaceGuide: true }), true))
}

/**
 * 展开右侧栏并**开一张新的浏览器页签**（Ctrl+T、页面自己 `window.open` 都走它）。
 *
 * 为什么要单独一个入口而不是让调用方拼 `openTab('browser')`：浏览器可多开之后，
 * 「新开一张」与「就地替换开始页」是两种语义（后者是门面入口卡的路径）。插件只说
 * 「开一张浏览器页签」，页签类型与「顺手展开」这两条策略归布局这一层——
 * 与 {@link setDockPreview} 同一性质。
 *
 * @param url 直接进的地址；不给就是空态页签
 * @param viewId 指定页签 id（= 原生视图 id）；只有「桌面侧指名一台视图」那条路会传。
 *   为什么要能指定：浏览器页签的原生视图 id 就是 `tab.id`，而 agent 那条链路上，
 *   桌面主进程是按宿主台账里的 viewId 指认它要开/要驱动的那台视图的——这个 id 得由
 *   **桌面侧发号、壳照用**，不能由壳自己发号（那样两边对不上号）。不给就照旧自己发。
 */
export function openDockBrowserTab(url?: string, viewId?: string): void {
  dockActions.openBrowserTab(url, undefined, viewId)
}

// ── 页签内容注册表：谁改谁喊（报名表本体在 dock-model） ────────────────────────

/**
 * 报名表变化 → 布局层做两件事：
 *   1. 某个 kind 被撤销（插件停用）时，把它**已经开着**的页签全部关掉——不然页签条上
 *      留一张点开只有「界面没装上」的壳，或者更糟：组件还活着、看着像插件没停。
 *   2. 通知订阅者重画：开始页入口卡与 chip 的标题图标都从报名表来，表变了界面就得变。
 */
subscribeDockKinds((removed) => {
  if (removed !== undefined) pruneDockKind(removed)
  dockChannel.notify()
})

/**
 * 把一个 kind 已开着的页签从**每个会话**的布局里撤掉，并重新落盘。
 *
 * 为什么要扫全部会话而不是当前那个：布局是按会话存的，A 会话开着旁问、切到 B 会话
 * 停用插件，A 的存档里那张页签不能留着——下次切回去就是一张空壳。
 */
function pruneDockKind(kind: DockTabKind): void {
  let changed = false
  const next: DockSurfaces = {}
  const current = removeKindTabs(surface, kind)
  if (current !== surface) {
    surface = current
    changed = true
  }
  for (const [id, stored] of Object.entries(surfaces)) {
    const pruned = id === sessionId ? surface : removeKindTabs(stored, kind)
    if (pruned !== stored) changed = true
    next[id] = pruned
  }
  next[sessionId] = surface
  surfaces = next
  if (!changed) return
  saveSurfaces(surfaces)
}

// ── 预览 / 审查目标 ──────────────────────────────────────────────────────────

/**
 * 打开一张文件预览页签（文件树点一个文件、改动卡点「打开」都走它）。
 *
 * `cwd` 保留在签名里只是为了调用方少改（旧面板时代的交接结构），打开页签只需要路径——
 * 页面显示用的相对路径由预览组件自己按当前会话 cwd 裁。
 *
 * 带上 `patch`（write / edit 工具卡点文件名那条路）就开**补丁页签**、并把这份「改了什么」
 * 的差异快照存进 {@link patchSources}，与「文件当前内容」（preview）分开成两个视图。
 * 单一入口（对齐参考实现的 onOpenCodeViewer(source)）：调用方只说「开这个文件的这种源」，
 * 是内容还是补丁由带没带 patch 决定，页签 kind 由壳挑。
 */
export function setDockPreview(target: { path: string; cwd?: string; patch?: ChangedFileView }): void {
  if (target.patch !== undefined) {
    patchSources.set(target.path, target.patch)
    dockChannel.notify()
    dockActions.openPatch(target.path)
    return
  }
  dockActions.openPreview(target.path)
}

/**
 * 补丁源表（文件绝对路径 → 那份差异快照）：**只在内存**，不落盘。
 *
 * 为什么不挂在页签上：hunks 可能很大，落进 localStorage（`dsc.dock.surfaces`）会把存档
 * 撑爆。页签只登记路径（可恢复），差异快照过不了重启——重启后回到补丁页签会提示
 * 「补丁已过期」，并给「打开原文件」的出口（见 preview 插件的 PatchTab）。
 */
const patchSources = new Map<string, ChangedFileView>()

/**
 * 读某个文件的补丁源（补丁页签体用）；没开过补丁、或重启后失效就是 null。
 *
 * 与布局订阅同一条通道：setDockPreview 存进来源表后 notify，页签体据此重渲染。
 */
export function useDockPatchSource(path: string): ChangedFileView | null {
  return useSyncExternalStore(
    subscribeDock,
    () => patchSources.get(path) ?? null,
    () => null,
  )
}

/**
 * 打开一张子智能体页签（那一条队友消息里的「在右侧栏看运行记录」、状态面板点一行都走它）。
 *
 * 为什么与 {@link setDockPreview} 并排放在这里而不是塞进 `dockActions`：动作面
 * （`DockActions`）是「Dock 组件自己会调的那些」，而这是一个**插件发起的目标式请求**
 * （给一个子智能体、把右侧栏开到它上面），与预览同一性质——壳是布局真源，插件只说意图。
 */
export function setDockSubagent(target: { path: string; label?: string }): void {
  dockActions.openSubagent(target.path, target.label)
}

/**
 * 打开一张后台活输出页签（状态面板「终端」区点一行走它）。
 *
 * 与 {@link setDockSubagent} 同一性质：插件发起的目标式请求（给一个后台活 id、把右侧栏
 * 开到它的只读输出面上），壳是布局真源，插件只说意图。`id` 是 job-N / term-N。
 */
export function setDockWorkOutput(target: { id: string; label?: string }): void {
  dockActions.openWorkOutput(target.id, target.label)
}

/**
 * 审查目标：轮尾「文件已更改」卡的「审查」把**那一轮的文件清单**交给并排审查面板。
 *
 * 为什么带 index：卡上点的是第几个文件，面板打开就该定位到第几个——
 * 旧界面的并排审查栏是同一个语义（onReview(files, index)）。
 */
export interface DockReview {
  files: ChangedFileView[]
  index: number
  cwd: string
}

let review: DockReview | null = null

/** 现在要审查哪一轮的哪些文件；没点过是 null。 */
export function dockReview(): DockReview | null {
  return review
}

/** 交接审查目标（卡上点「审查」时调；并排面板读它画）。 */
export function setDockReview(next: DockReview | null): void {
  review = next
  dockChannel.notify()
}

// ── React 接线 ───────────────────────────────────────────────────────────────

/** 当前会话的布局（组件里读它画页签条与页签体）。 */
export function useDockSurface(): DockSurface {
  return useSyncExternalStore(subscribeDock, dockSurface, dockSurface)
}

/**
 * 现在报名的页签种类（页签条与开始页入口卡都按它画）。
 *
 * 与 {@link subscribeDockKinds} 走同一条通道（报名表变化时 dock-state 也 notify 一次），
 * 所以插件装/卸那一帧界面就会跟上，不必刷新页面。
 */
export function useDockTabKinds(): readonly DockTabKindMeta[] {
  return useSyncExternalStore(subscribeDock, dockTabKinds, dockTabKinds)
}

/** 现在报名的「开始」页入口卡（没插件报名就是空数组）。 */
export function useDockGuideEntries(): readonly DockGuideEntry[] {
  return useSyncExternalStore(subscribeDock, dockGuideEntries, dockGuideEntries)
}

/** 现在要审查哪一轮的哪些文件（并排面板读它；没点过是 null）。 */
export function useDockReview(): DockReview | null {
  return useSyncExternalStore(subscribeDock, dockReview, () => null)
}

/**
 * 当前激活的预览页签路径（文件树拿它给正在预览的那一行点亮）。
 *
 * 从布局里推，而不是另存一份「预览目标」——目标就是那张活着的页签，
 * 关掉页签、切走激活页签，高亮跟着消失，不会留下幽灵状态。
 */
export function useActivePreviewPath(): string | null {
  return useSyncExternalStore(
    subscribeDock,
    () => {
      const activePane = surface.panes.find((pane) => pane.id === surface.activePaneId) ?? surface.panes[0]
      const tab = activePane?.tabs.find((item) => item.id === activePane.activeTabId)
      return tab?.kind === 'preview' && tab.path !== undefined ? tab.path : null
    },
    () => null,
  )
}
