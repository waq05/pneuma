/**
 * 鼠标点击命中基础设施（原版 ink 没有命中测试，这里是 dsc 的最小实现）。
 *
 * 组成两件事（显示宽度是第三件，已独立成 `app/display-width.ts`，卡片页脚的列区间
 * 与渲染同源计算就靠它）：
 * - `absoluteTop` / `measuredHeight`：沿 ink DOM 的 parentNode 链累加 yoga 的
 *   getComputedTop，得到节点在帧内的绝对行——帧恒定为「终端行数 − 1」且从屏顶排
 *  （App 根盒），帧内行就是屏幕行；
 * - `useClickRegion`：组件登记一个命中判定函数，**几何在点击发生时才测量**——ink 的
 *   布局在节流渲染里才算完，注册时量到的是上一帧的尺寸，点击时（距上一次绘制总有
 *   一段人手时差）量的才是画出来的那一帧。
 *
 * 坐标约定：命中判定收到的 col/row 一律是 0 基帧内坐标（App 把 SGR 的 1 基剥掉）。
 * 测量失败（yoga 节点缺席、管道渲染等）跳过该区——点击退化为无操作，键盘不受影响。
 *
 * @module dsc-tui/app/click
 */
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { DOMElement } from 'ink'

/** ink 6.8 导出的 DOM 节点类型（ref 拿到的就是它，带 yogaNode 与 parentNode）。 */
type InkElement = DOMElement & {
  parentNode?: InkElement | null
}

/** 节点在帧内的绝对行（0 基）；量不到（非 TTY 管道、未挂载）返回 null。 */
export function absoluteTop(node: DOMElement | null | undefined): number | null {
  let y = 0
  let current: InkElement | null | undefined = node as InkElement | null | undefined
  while (current !== null && current !== undefined) {
    const top: number | undefined = current.yogaNode?.getComputedTop()
    if (typeof top !== 'number') return null
    y += top
    current = current.parentNode
  }
  return y
}

/** 节点在帧内的绝对列（0 基）；量不到返回 null（同一行里多块区域分列命中用）。 */
export function absoluteLeft(node: DOMElement | null | undefined): number | null {
  let x = 0
  let current: InkElement | null | undefined = node as InkElement | null | undefined
  while (current !== null && current !== undefined) {
    const left: number | undefined = current.yogaNode?.getComputedLeft()
    if (typeof left !== 'number') return null
    x += left
    current = current.parentNode
  }
  return x
}

/** 节点在帧内的水平区间（0 基 [left, left+width)）；量不到返回 null。 */
export function measuredSpan(
  node: DOMElement | null | undefined,
): { left: number; width: number } | null {
  const left = absoluteLeft(node)
  const width: number | null = measuredWidth(node)
  if (left === null || width === null) return null
  return { left, width }
}

/** 节点的渲染高度（行）；量不到返回 null。 */
export function measuredHeight(node: DOMElement | null | undefined): number | null {
  const height: number | undefined = (node as InkElement | null | undefined)?.yogaNode?.getComputedHeight()
  return typeof height === 'number' ? height : null
}

/** 节点的渲染宽度（列）；量不到返回 null（芯片内部「主体 / 删除钮」分列用）。 */
export function measuredWidth(node: DOMElement | null | undefined): number | null {
  const width: number | undefined = (node as InkElement | null | undefined)?.yogaNode?.getComputedWidth()
  return typeof width === 'number' ? width : null
}

/** 一个命中判定：点击发生时由 App 现量几何再询问；返回 true 表示消费了这次点击。 */
export interface ClickEntry {
  node: RefObject<DOMElement | null>
  /** (col, row, top, height) 均为 0 基帧内坐标。 */
  hit: (col: number, row: number, top: number, height: number) => boolean
  /**
   * 够不够格当**拖动目标**（按住左键划过，SGR 1002）：只有刻度列认拖动
   * （拖 = 一连串跳到该行），其余区一律不派发拖动——划过去误触比「拖不动」讨厌。
   */
  drag?: boolean
}

/** App 侧的注册表：组件渲染后登记，卸载/重渲染时自动注销。 */
export type RegisterClick = (entry: ClickEntry) => () => void

/**
 * 组件登记命中判定。
 *
 * `hit` 走 ref、**只在挂载/卸载时登记一次**：原先没有依赖数组，每次重渲染都要把
 * 帧内 80+ 个命中区退订再登记一遍（Set 的增删落在渲染提交路径上）。判定闭包拿的
 * 仍是最新 props——ref 每次渲染都刷新，判定时刻读到的是当次渲染的闭包。
 */
export function useClickRegion(
  ref: RefObject<DOMElement | null>,
  register: RegisterClick | undefined,
  hit: ClickEntry['hit'] | undefined,
  options?: { drag?: boolean },
): void {
  const hitRef = useRef(hit)
  hitRef.current = hit
  const drag = options?.drag === true
  const active = register !== undefined && hit !== undefined
  useEffect(() => {
    if (!active) return
    return register!({
      node: ref,
      hit: (col, row, top, height) => hitRef.current?.(col, row, top, height) ?? false,
      ...(drag ? { drag: true } : {}),
    })
  }, [active, register, ref, drag])
}
