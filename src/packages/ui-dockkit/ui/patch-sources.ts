/**
 * 补丁快照表：**页签 id → 那份差异快照**，只在内存。
 *
 * 为什么按页签记而不是按文件路径记（P0-11）：同一份文件既可能开补丁页签、也可能开
 * 带「改动」开关的预览页签；关掉再开是**另一张页签**。按路径记的话，上一刀的 hunks
 * 会跟着文件名留在表里，新页签一打开就显示旧 diff。按页签 id 记，快照的生命周期与
 * 页签一致：关页签、被 `PREVIEW_MAX` 淘汰、插件停用批量撤、换会话都只改布局，所以
 * 「算完新布局清一遍」就够（见 {@link forgetDeadPatches}）。清的时候存活集合要取
 * **全部会话**的布局——切会话只是换了当前那一份，别的会话的页签并没有消失。
 *
 * 为什么不落盘：hunks 可能很大，写进 `dsc.dock.surfaces` 会把存档撑爆。重启后补丁
 * 页签读不到快照，显示「补丁已过期」（见 preview 插件的 PatchTab）。
 *
 * 纯模块：不 import React，只提供一个订阅接口给 `useSyncExternalStore` 用。
 *
 * @module dsc-ui-shell/dock-patch-sources
 */
import type { ChangedFileView } from '@dsc/ui-core'

const patches = new Map<string, ChangedFileView>()
const listeners = new Set<() => void>()

/** 变化通知（订阅者各自重读；与布局通道分开，换一份快照不必惊动整个布局）。 */
function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** 订阅补丁快照变化（`useSyncExternalStore` 的订阅函数）。 */
export function subscribePatches(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 记下某张页签的差异快照；同一张页签再记 = 换成最新那一刀。 */
export function rememberPatch(tabId: string, patch: ChangedFileView): void {
  if (tabId === '') return
  patches.set(tabId, patch)
  notify()
}

/** 读某张页签的差异快照；没记过（或重启后）是 null。 */
export function patchOf(tabId: string): ChangedFileView | null {
  return patches.get(tabId) ?? null
}

/** 忘掉一张页签的差异快照（页签关掉时用；兜底清理由 {@link forgetDeadPatches} 做）。 */
export function forgetPatch(tabId: string): void {
  if (patches.delete(tabId)) notify()
}

/**
 * 忘掉所有「不在给定存活集合里」的页签快照。
 *
 * 布局是唯一的存活凭据：每一次布局变更（关页签、淘汰、批量撤、切会话）算完新布局后
 * 喊一次，全表的键都收敛到「还活着的页签」。
 *
 * @param liveTabIds 还活着的页签 id。**传全部会话的布局**（`dock-state` 的
 *   `liveTabIds()` 扫的是 `Object.values(surfaces)` 再并上当前 `surface`）：切会话只
 *   把当前布局换成另一份，原来那个会话的页签仍存在存档里、切回去还要显示 diff；只传
 *   当前布局，切到 B 就会把 A 里还开着的补丁快照全删掉，切回 A 只能看到「补丁已过期」
 *   （P-1，相对按路径记的旧实现是退步）。页签 id 在进程内不复用（`dock-model` 的
 *   `makeTab`），所以放开到全量不会串台。
 *
 * 为什么收 id 而不是收布局：这里只关心「哪些 id 还活着」，与布局结构无关；由调用方
 * 决定扫哪几份会话布局，这个模块不必知道 `DockSurfaces` 的形状。
 */
export function forgetDeadPatches(liveTabIds: Iterable<string>): void {
  const live = new Set(liveTabIds)
  let changed = false
  for (const tabId of [...patches.keys()]) {
    if (live.has(tabId)) continue
    patches.delete(tabId)
    changed = true
  }
  if (changed) notify()
}
