/**
 * 骨架屏（2026-10-25，P0-2）。
 *
 * 为什么补回来：`.dsc-skeleton` 在 0.6.37 被当成"从未被引用"删掉了（见
 * `legacy/primitives.css` 那条注释），于是所有"数据还没回来"的地方都是一行灰字
 * （"正在读取…"）。灰字的问题不是难看，是**页面先空一下再填**：用户看到的是
 * "什么也没有"，而不是"马上就有"。
 *
 * 用法只有两种，别造第三种：
 *   - {@link Skeleton}：一条占位（宽高按内容定，圆角缺省跟卡片/文本走）；
 *   - {@link SkeletonText}：多行文本占位（最后一行短一点，读起来像真段落）。
 *
 * 三个纪律：
 *   1. 占位块**不进可达树**（`aria-hidden`），但要给外层 `role="status"` + 一句
 *      `aria-label`，读屏用户听到的是"正在读取分区"，不是一片空白；
 *   2. 动的只有一道扫光，时长 1.4s；`prefers-reduced-motion` 时换成静态底色，
 *      **不许**在这里做布局动画（会跟真的内容到达抢帧）；
 *   3. 高度按真实内容估：占位比内容矮会造成"先缩后弹"，比内容高会造成"先空后收"。
 *
 * @module dsc-ui-shell/ui-primitives/skeleton
 */
import type { CSSProperties, JSX } from 'react'

/** 一条占位块。 */
export function Skeleton({
  width = '100%',
  height = 12,
  radius = 6,
  className,
}: {
  width?: number | string
  height?: number
  radius?: number
  className?: string
}): JSX.Element {
  const style: CSSProperties = { width, height, borderRadius: radius }
  return <span className={className === undefined ? 'dsc-skeleton' : `dsc-skeleton ${className}`} style={style} aria-hidden="true" />
}

/** 多行文本占位：最后一行收短，像一段真文字。 */
export function SkeletonText({
  lines = 3,
  gap = 8,
  widths,
}: {
  lines?: number
  gap?: number
  widths?: readonly (number | string)[]
}): JSX.Element {
  return (
    <span className="dsc-skeleton-text" style={{ gap }} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={widths?.[index] ?? (index === lines - 1 ? '62%' : '100%')} height={11} />
      ))}
    </span>
  )
}

/** 读屏用的状态行：视觉上藏起来，读屏能读到。 */
export function LoadingStatus({ label }: { label: string }): JSX.Element {
  return (
    <span className="dsc-loading-status" role="status" aria-live="polite">
      {label}
    </span>
  )
}
