/**
 * 停靠面板的开合状态（壳的布局真源）。
 *
 * 为什么放在壳这一侧而不是插件自己的 state：打开面板要**改壳的布局**——
 * `.thread-zone` 从「一列」变成「正文 + 面板」两列（见 `styles.css` 的 `[data-dock]`）。
 * 插件只该说「我要一块停靠区」，怎么让位是壳的事。所以这一份是个极小的订阅式状态：
 * 插件写、壳读，双方都不必认识对方。
 *
 * 为什么不用 React context：槽条目的渲染树与壳的 App 不在同一条 props 链上
 * （插件是壳按启动图动态装上去的），而这一份状态本来就与渲染树无关。
 *
 * 四样东西都挂在同一份订阅上（同一次 notify，各自取各自的快照）：
 * - **当前面板**（开合真源）；
 * - **面板清单**（注册表）：每块面板开工时报名 id/标题/顺序，壳的头条按它画页签——
 *   旧界面 dock 的多页签就是这么来的，壳里页签与面板因此不必互相硬编；
 * - **预览目标**：文件面板点一个文件 → 预览面板显示它（两块面板是两个插件，
 *   目标文件放这里做一次性交接）；
 * - **审查目标**：轮尾「文件已更改」卡点「审查」→ 审查面板显示那一轮的文件清单与
 *   当前文件下标（旧界面是并排右栏，壳里并进停靠区做同一件事）。
 *
 * @module dsc-ui-shell/dock-state
 */
import type { ReactNode } from 'react'
import type { ChangedFileView } from '@dsc/ui-core'

/**
 * 当前打开的是哪一块面板（`null` = 收起）。
 *
 * 为什么是"面板 id"而不是一个布尔：停靠区里可以有几块互斥的面板（终端 / 文件 /
 * 变更 / 预览），同一时刻只该显示一块，而"谁被点开了"这件事只能有一个真源。
 */
let panel: string | null = null

/** 订阅者（开合 / 面板清单 / 预览目标三样共用这一份，改动都走同一次通知）。 */
const listeners = new Set<() => void>()

/**
 * 上一次打开过的面板 id：顶栏那颗「工作区面板」开合钮在收起态点开时用它
 * （旧界面同款手感——收起前看的是哪个，展开就回哪个；没开过就默认文件）。
 */
let lastPanel = 'files'

/** 现在开的是哪一块面板（`useSyncExternalStore` 的取数函数；null = 收起）。 */
export function dockPanel(): string | null {
  return panel
}

/** 收起前最后看过的面板（顶栏开合钮的展开目标）。 */
export function lastDockPanel(): string {
  return lastPanel
}

/**
 * 打开某一块面板（`null` = 收起）。
 *
 * 面板的**内容**由插件自己决定渲染什么；收起时壳不渲染 `shell.dock` 这个槽，
 * 于是所有面板都被卸载——这是有意的：收起面板不该在布局里留一条看不见的占位。
 */
export function setDockPanel(next: string | null): void {
  if (next === panel) return
  if (next !== null) lastPanel = next
  panel = next
  for (const listener of listeners) listener()
}

/** 订阅开合变化（`useSyncExternalStore` 的订阅函数）。 */
export function subscribeDock(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 停靠面板在头条里的报名（壳按顺序画页签）。 */
export interface DockPanelMeta {
  /** 面板 id（与 `setDockPanel` 用同一个值）。 */
  id: string
  /** 页签上的短标题。 */
  label: string
  /** 页签顺序（小的在左）。 */
  order: number
  /**
   * 页签上的小图标（旧界面 dock 的 chip 就是「图标 + 标题」）。
   * 存 ReactNode 而不是组件：不同面板的图标来自不同图标集，壳不必认识它们。
   */
  icon?: ReactNode
}

const metas = new Map<string, DockPanelMeta>()
let metasSnapshot: readonly DockPanelMeta[] = []

function rebuildMetas(): void {
  metasSnapshot = [...metas.values()].sort((a, b) => a.order - b.order)
}

/**
 * 报名一块停靠面板（插件 `apply` 里调一次）。
 *
 * 返回撤销函数（插件卸载时把页签也带走）；重复 id 覆盖——同一个插件重装时
 * 不该在头条里留下两枚同名页签。
 */
export function registerDockPanel(meta: DockPanelMeta): () => void {
  metas.set(meta.id, meta)
  rebuildMetas()
  for (const listener of listeners) listener()
  return () => {
    metas.delete(meta.id)
    rebuildMetas()
    for (const listener of listeners) listener()
  }
}

/** 已报名的面板清单（排好序；壳的头条按它画页签）。 */
export function dockPanels(): readonly DockPanelMeta[] {
  return metasSnapshot
}

/** 预览目标：文件面板点的一个文件（预览面板显示它）。 */
export interface DockPreview {
  path: string
  cwd: string
}

let preview: DockPreview | null = null

/** 现在要预览哪个文件；没点过是 null。 */
export function dockPreview(): DockPreview | null {
  return preview
}

/** 交接预览目标（文件面板点文件时调；通知与开合共用同一份订阅）。 */
export function setDockPreview(next: DockPreview | null): void {
  preview = next
  for (const listener of listeners) listener()
}

/**
 * 审查目标：轮尾「文件已更改」卡的「审查」把**那一轮的文件清单**交给审查面板。
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

/** 交接审查目标（卡上点「审查」时调；面板读它画）。 */
export function setDockReview(next: DockReview | null): void {
  review = next
  for (const listener of listeners) listener()
}
