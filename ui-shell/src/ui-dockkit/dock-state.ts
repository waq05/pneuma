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
import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { ChangedFileView } from '@dsc/ui-core'
import {
  closeTab as modelCloseTab,
  defaultSurface,
  focusPane as modelFocusPane,
  focusTab as modelFocusTab,
  loadSurfaces,
  openPreview as modelOpenPreview,
  openPatch as modelOpenPatch,
  openSubagent as modelOpenSubagent,
  openTab as modelOpenTab,
  openWorkOutput as modelOpenWorkOutput,
  placeTab as modelPlaceTab,
  saveSurfaces,
  setExpanded as modelSetExpanded,
  setFraction as modelSetFraction,
  splitPane as modelSplitPane,
  toggleMode as modelToggleMode,
  unsplitPane as modelUnsplitPane,
  type DockActions,
  type DockSurface,
  type DockSurfaces,
  type DockTab,
  type DockTabKind,
} from './dock-model'

export type { DockActions, DockPane, DockSurface, DockTab, DockTabKind } from './dock-model'

// ── 布局状态（每会话一份） ────────────────────────────────────────────────────

let surfaces: DockSurfaces = loadSurfaces()
let sessionId = ''
let surface: DockSurface = surfaces[''] ?? defaultSurface()

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
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
  notify()
}

/** 派发一个布局变更：以当前会话布局为基，算完顺手落盘（布局很小，写 localStorage 便宜）。 */
function mutate(fn: (s: DockSurface) => DockSurface): void {
  const next = fn(surface)
  if (next === surface) return
  surface = next
  surfaces = { ...surfaces, [sessionId]: next }
  saveSurfaces(surfaces)
  notify()
}

/** 订阅布局变化（`useSyncExternalStore` 的订阅函数）。 */
export function subscribeDock(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前会话的布局（`useSyncExternalStore` 的取数函数；引用稳定，变更才换）。 */
export function dockSurface(): DockSurface {
  return surface
}

/**
 * 布局动作表（旧桌面版 App 里的同一套接线：开预览顺手展开侧栏）。
 *
 * 做常量而不是工厂：动作全是 `mutate` 的薄包装，没有闭包状态，引用天然稳定。
 */
export const dockActions: DockActions = {
  openTab: (kind, options) => {
    mutate((s) => modelOpenTab(s, kind, options))
  },
  openPreview: (path, line) => {
    mutate((s) => modelSetExpanded(modelOpenPreview(s, path, line), true))
  },
  openPatch: (path) => {
    mutate((s) => modelSetExpanded(modelOpenPatch(s, path), true))
  },
  openSubagent: (path, label) => {
    mutate((s) => modelSetExpanded(modelOpenSubagent(s, path, label), true))
  },
  openWorkOutput: (id, label) => {
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
  mutate((s) => modelSetExpanded(modelOpenTab(s, kind, { replaceGuide: true }), true))
}

// ── 页签内容注册表（kind → 渲染组件） ────────────────────────────────────────

/** 页签体的 props：布局对象 + 这一张现在的可见性。 */
export interface DockTabBodyProps {
  /** 这张页签（preview 用 tab.path / tab.line）。 */
  tab: DockTab
  /** 这一张是不是它窗格的激活页签。 */
  active: boolean
  /** dock 整块展开着没有（收起 = 滑出右缘；keepMounted 的终端这时仍活着）。 */
  expanded: boolean
}

/** 一种页签的界面（插件经 {@link registerDockTab} 报名）。 */
export interface DockTabKindMeta {
  kind: DockTabKind
  /** chip 上的短标题（preview 不用——标题取文件名）。 */
  label: string
  /** chip 上的小图标。 */
  icon?: ReactNode
  /** 内容组件。 */
  component: ComponentType<DockTabBodyProps>
  /**
   * 切走只藏不卸（终端的进程与输出活着）。
   * 为假时只在「激活且展开」挂载——重挂无副作用的页面（文件 / Git / 预览）省一份常驻监听。
   */
  keepMounted?: boolean
}

const kindMetas = new Map<DockTabKind, DockTabKindMeta>()
let kindSnapshot: readonly DockTabKindMeta[] = []

function rebuildKinds(): void {
  kindSnapshot = [...kindMetas.values()]
}

/**
 * 报名一种页签的界面（插件 `apply` 里调一次）。
 *
 * 返回撤销函数；重复 kind 覆盖——同一个插件重装时不该在注册表里留下两份。
 */
export function registerDockTab(meta: DockTabKindMeta): () => void {
  kindMetas.set(meta.kind, meta)
  rebuildKinds()
  notify()
  return () => {
    kindMetas.delete(meta.kind)
    rebuildKinds()
    notify()
  }
}

/** 已报名的页签界面（壳的页签条与页签体都按它画）。 */
export function dockTabKinds(): readonly DockTabKindMeta[] {
  return kindSnapshot
}

/** 某种 kind 的界面（没报名给 undefined——页签体画占位）。 */
export function dockTabMeta(kind: DockTabKind): DockTabKindMeta | undefined {
  return kindMetas.get(kind)
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
    notify()
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
  notify()
}

// ── React 接线 ───────────────────────────────────────────────────────────────

/** 当前会话的布局（组件里读它画页签条与页签体）。 */
export function useDockSurface(): DockSurface {
  return useSyncExternalStore(subscribeDock, dockSurface, dockSurface)
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
