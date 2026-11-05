/**
 * 浮层锚定：优先让浏览器自己贴（CSS 锚点定位），不支持时退回「量完再画」。
 *
 * 为什么要有这一层：原来的做法是打开浮层后先画在默认位置、量一次触发钮与自身高度、
 * 再在绘制前改坐标。量得到、也修得对，但有个绕不开的代价——**先有一拍错位置**（高度依赖内容时
 * 尤其明显），滚动与缩放时也得自己重算。CSS 锚点定位把这件活交给浏览器：锚点元素写
 * `anchor-name`，浮层写 `position-anchor` + `anchor()`，位置由合成器算，没有中间态。
 *
 * 为什么不是无脑切：锚点定位要 Chromium 125+（桌面端 Electron 44 没问题），手机端浏览器
 * 版本参差。所以这里做成「支持就交给浏览器、不支持就走原来的测量」，两条路都不缺。
 *
 * @module dsc-ui-shell/ui-primitives/anchored
 */
import type { CSSProperties } from 'react'

/** 锚点定位支持不支持：`CSS.supports` 在浏览器里有，Node 侧（探针/构建）没有。 */
export function anchorPositioningSupported(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  return CSS.supports('anchor-name: --dsc-anchor-probe')
}

/**
 * 由 React 的 `useId` 造一个锚点名。
 *
 * `useId` 给的是 `:r7:` 这种冒号包起来的字符串，`anchor-name` 只认自定义属性名（`--x`），
 * 冒号与下划线都得换掉。
 * @param id - `useId()` 的返回值
 * @returns 可以直接写进 `anchor-name` 的 `--dsc-anchor-*` 名字
 */
export function anchorNameOf(id: string): string {
  return '--dsc-anchor-' + id.replace(/[^a-zA-Z0-9_-]/g, '')
}

/** 一个浮层要怎么贴：贴着锚点、上下翻、宽度跟锚点走。 */
export interface AnchoredPanelOptions {
  /** 与锚点的间距（px）。 */
  gap: number
  /** 宽度策略：跟锚点一样宽（`min-width`），还是让浮层自己定。 */
  width?: 'anchor' | 'auto'
}

/** 锚点元素与浮层各自要写的样式（不支持锚点定位时两边都是空对象）。 */
export interface AnchoredStyles {
  /** 写在锚点（触发钮）上。 */
  anchor: CSSProperties
  /** 写在浮层上。 */
  panel: CSSProperties
}

/**
 * 造「锚点 + 浮层」两份样式。
 *
 * 位置约定与原来那套测量口径逐字一致：贴下缘、对齐左缘、宽度不窄于锚点；放不下时
 * 翻到上缘（`position-try-fallbacks: flip-block`，浏览器自己翻）。
 * @param name - {@link anchorNameOf} 造出来的名字
 * @param options - 间距与宽度策略
 * @returns 两份样式；调用方自己决定要不要用（`anchorPositioningSupported()`）
 */
export function anchoredStyles(name: string, options: AnchoredPanelOptions): AnchoredStyles {
  const panel: CSSProperties = {
    // 这两条不是标准 CSSProperties 的键（React 19 才认），类型上按索引签名塞进去。
    ['positionAnchor' as keyof CSSProperties]: name,
    top: `calc(anchor(bottom) + ${String(options.gap)}px)`,
    left: 'anchor(left)',
    positionTryFallbacks: 'flip-block',
  } as CSSProperties
  if (options.width === 'anchor') {
    ;(panel as Record<string, unknown>)['minWidth'] = 'anchor-size(width)'
  }
  return {
    anchor: { ['anchorName' as keyof CSSProperties]: name } as CSSProperties,
    panel,
  }
}
