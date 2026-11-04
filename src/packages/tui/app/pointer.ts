/**
 * 指针位置（SGR 1003 的运动事件）——只服务右侧刻度列的悬停。
 *
 * 为什么单开一个模块：运动事件是**高频**的（鼠标划过屏幕每秒几十上百条）。要是把位置
 * 存进 App 的 state，每动一下就是一次全树重渲染；这里只发布「指针在右侧那 RAIL_WIDTH 列
 * 上、在第几行」这一个事实，而且**值没变就不通知**。订户只有刻度列那一个小部件，
 * 指针在别处时它们一次渲染都不会有。
 *
 * 没有「离开」事件可听（SGR 不发），所以离开靠**列判定**自然清掉；终端尺寸变了也照此
 * 重新判定（列数由调用方每次传入，不在这里缓存）。
 *
 * @module dsc-tui/app/pointer
 */
import { useSyncExternalStore } from 'react'
import { PAD } from './theme.js'
import { RAIL_WIDTH } from './scroll-model.js'

/** 指针在刻度列上时的终端行号（1 基，SGR 原样）；不在那几列上 = null。 */
let gutterRow: number | null = null
const listeners = new Set<() => void>()

/**
 * 指针是不是落在右侧刻度列上。
 *
 * 列要算准：帧有 `PAD.page` 列页边距，刻度列是**内容列的最后 RAIL_WIDTH 列**——直接拿
 * 终端右缘（`columns - RAIL_WIDTH`）判会整体偏两列，指针压在刻度上也不认（第一次实现
 * 就是这么错的，走查里点不亮）。
 */
export function onGutter(col: number, columns: number): boolean {
  return col - 1 >= columns - PAD.page - RAIL_WIDTH
}

/** 记一次指针位置（运动事件每来一条调一次）。 */
export function publishPointer(col: number, row: number, columns: number): void {
  const next = onGutter(col, columns) ? row : null
  if (next === gutterRow) return
  gutterRow = next
  for (const listener of [...listeners]) listener()
}

/** 清掉指针（失焦/退出这类没有 leave 事件的场合由调用方兜底）。 */
export function clearPointer(): void {
  if (gutterRow === null) return
  gutterRow = null
  for (const listener of [...listeners]) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 指针在刻度列上时的终端行号（1 基）；不在 = null。 */
export function useGutterPointer(): number | null {
  return useSyncExternalStore(subscribe, () => gutterRow)
}

/** 测试注入口：直接读当前值（探针不挂 React 也能验通知语义）。 */
export function readPointer(): number | null {
  return gutterRow
}
