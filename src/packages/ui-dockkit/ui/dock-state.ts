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
import { forgetDeadPatches, forgetPatch, patchOf, rememberPatch, subscribePatches } from './patch-sources'

export type { DockActions, DockGuideEntry, DockPane, DockSurface, DockTab, DockTabBodyProps, DockTabKind, DockTabKindMeta } from './dock-model'

// ── 布局状态（每会话一份） ────────────────────────────────────────────────────

let surfaces: DockSurfaces = loadSurfaces()
let sessionId = ''
let surface: DockSurface = surfaces[''] ?? defaultSurface()

/**
 * 变更通道（`createSignal` 的「值在别处」用法）。
 *
 * 这一个文件里其实有三份状态：布局、页签注册表、审查目标。它们共用一条通知通道，
 * 各自的读函数（`dockSurface` / `dockTabKinds` / `dockReview`）负责取出自己那份。
 * 所以这里不用 `set` 存值，只用 `notify`：谁改完谁喊一声，订阅者各自重读。
 * （补丁快照不在这条通道上：它按页签 id 记，有自己的订阅，见 `./patch-sources`。）
 */
const dockChannel = createSignal(0)

/**
 * 全部会话布局里还活着的页签 id（补丁快照的存活集合）。
 *
 * 为什么扫全量而不是「当前会话的布局」（P-1）：切会话只把 {@link surface} 换成另一份，
 * 原来那个会话的页签仍在 {@link surfaces} 里，切回去还要显示 diff。拿当前布局当存活
 * 集合，切到 B 就会把 A 里还开着的补丁快照全删掉，切回 A 只看到「补丁已过期」。
 * 页签 id 在进程内不复用（`dock-model` 的 `makeTab`），放开到全量不会串台。
 *
 * 当前 `surface` 单独再并一次：某会话还没改过布局时它只是 `defaultSurface()` 的临时值，
 * 不在 `surfaces` 里（这个差集里不会有补丁页签，但少一个特例少一处漏网）。
 */
function liveTabIds(): Set<string> {
  const live = new Set<string>()
  const collect = (one: DockSurface): void => {
    for (const pane of one.panes) for (const tab of pane.tabs) live.add(tab.id)
  }
  for (const one of Object.values(surfaces)) collect(one)
  collect(surface)
  return live
}

/**
 * 切到某个会话的布局（壳从宿主快照的 sessionId 调；没会话时传空串）。
 *
 * 切走的会话布局留在 {@link surfaces} 与 localStorage 里——切回来还是那一套页签。
 */
export function setDockSession(id: string): void {
  if (id === sessionId) return
  sessionId = id
  surface = surfaces[id] ?? defaultSurface()
  // 补丁快照按页签 id 存：存活集合取**全部会话**的布局，切走的会话页签还在存档里，
  // 清掉它的快照就等于切回去看到「补丁已过期」（P-1）。换了会话本身不会产生死页签，
  // 这里只是不动别人的页签。
  forgetDeadPatches(liveTabIds())
  dockChannel.notify()
}

/** 派发一个布局变更：以当前会话布局为基，算完顺手落盘（布局很小，写 localStorage 便宜）。 */
function mutate(fn: (s: DockSurface) => DockSurface): void {
  const next = fn(surface)
  if (next === surface) return
  surface = next
  surfaces = { ...surfaces, [sessionId]: next }
  saveSurfaces(surfaces)
  // 补丁快照跟着页签活：关页签、PREVIEW_MAX 淘汰、插件停用后都在这里顺手清掉（P0-11）。
  forgetDeadPatches(liveTabIds())
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
  // 被撤掉的那些页签不在了，挂在它们身上的补丁快照也一起作废（不留幽灵 diff）。
  // 存活集合同样取全部会话：别的会话里还开着的同类页签没被撤的，快照得留着。
  forgetDeadPatches(liveTabIds())
}

// ── 预览 / 审查目标 ──────────────────────────────────────────────────────────

/**
 * 打开一张文件预览页签（文件树点一个文件、改动卡点「打开」都走它）。
 *
 * `cwd` 保留在签名里只是为了调用方少改（旧面板时代的交接结构），打开页签只需要路径——
 * 页面显示用的相对路径由预览组件自己按当前会话 cwd 裁。
 *
 * 带上 `patch`（write / edit 工具卡点文件名那条路）就开**补丁页签**、并把这份「改了什么」
 * 的差异快照记到那张页签 id 上（{@link rememberPatch}），与「文件当前内容」（preview）
 * 分开成两个视图。
 * 单一入口（对齐参考实现的 onOpenCodeViewer(source)）：调用方只说「开这个文件的这种源」，
 * 是内容还是补丁由带没带 patch 决定，页签 kind 由壳挑。
 */
export function setDockPreview(target: { path: string; cwd?: string; patch?: ChangedFileView }): void {
  if (target.patch !== undefined) {
    if (!hasDockKind('patch')) return
    const patch = target.patch
    mutate((s) => {
      const next = modelSetExpanded(modelOpenPatch(s, target.path), true)
      // 快照挂在**结果布局里那张页签**上：同路径已有补丁页签时就是它（聚焦并换成新快照）。
      const tabId = tabIdOf(next, 'patch', target.path)
      if (tabId !== undefined) rememberPatch(tabId, patch)
      return next
    })
    return
  }
  // 不带 patch（文件树点开某文件）= 「看这个文件现在的内容」：这张页签上一刀挂过的
  // 差异快照必须清掉，否则页签头还挂着旧的 +N/−N、点「改动」看到旧 hunks（P-3）。
  // 新建的页签本来没有快照，清一次无害；同文件已有预览页签时 `openPreview` 按路径
  // 复用那一张，这里取到的正好是它的 id。
  //
  // 注意清快照写在 `mutate` 的回调里（与上面 rememberPatch 同一位置）：回调每次都会
  // 执行，而 `mutate` 在布局原样不变时会跳过落盘与清理，写在外面就漏掉那种情形。
  // 与 `setDockFileView`（先开页签、再 rememberPatch）方向相反，两者不会互相踩。
  if (!hasDockKind('preview')) return
  mutate((s) => {
    const next = modelSetExpanded(modelOpenPreview(s, target.path), true)
    const tabId = tabIdOf(next, 'preview', target.path)
    if (tabId !== undefined) forgetPatch(tabId)
    return next
  })
}

/** 一份布局里某 kind + path 那张页签的 id（刚算完的新布局里找；找不到就是 undefined）。 */
function tabIdOf(next: DockSurface, kind: DockTabKind, path: string): string | undefined {
  for (const pane of next.panes) {
    for (const tab of pane.tabs) {
      if (tab.kind === kind && tab.path === path) return tab.id
    }
  }
  return undefined
}

/**
 * 读某张页签挂着的补丁源（补丁页签 / 带「改动」开关的预览页签都读它）。
 *
 * 键是**页签 id**：快照的生命周期跟页签走——关掉再开是另一张页签，这里读到的就是
 * null（P0-11：旧实现按文件路径记，关页签再开同一文件会显示上一刀的 hunks）。
 * 快照只在内存（hunks 可能很大，不落入 `dsc.dock.surfaces`）：重启后是 null，补丁页签
 * 提示「补丁已过期」并给「打开原文件」的出口（见 preview 插件的 PatchTab）。
 */
export function useDockPatchSource(tabId: string): ChangedFileView | null {
  return useSyncExternalStore(
    subscribePatches,
    () => patchOf(tabId),
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

/**
 * 打开一张**文件预览页签**，并顺手把这道改动的差异快照挂上（页签头部因此多一个
 * 「改动 / 预览」切换）。
 *
 * 为什么不是 {@link setDockPreview} 带 patch 那条路：那条开的是**补丁页签**、默认就画 diff；
 * 轮尾「文件已更改」卡的「审查」与 Git 面板点文件行，要的是「先看渲染好的文件，想看改动
 * 再切」。两份数据是同一个源（{@link patchSources}），差别只在页签种类与默认视图。
 */
export function setDockFileView(target: { path: string; patch: ChangedFileView }): void {
  if (!hasDockKind('preview')) return
  const patch = target.patch
  mutate((s) => {
    const next = modelSetExpanded(modelOpenPreview(s, target.path), true)
    // 先开页签、再按**结果布局里那张页签的 id** 记快照：同文件已有预览页签就记在它身上。
    const tabId = tabIdOf(next, 'preview', target.path)
    if (tabId !== undefined) rememberPatch(tabId, patch)
    return next
  })
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
