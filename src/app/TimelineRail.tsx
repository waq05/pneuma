/**
 * 右侧那一列：**轮数刻度**（照 dsh-TUI 的 TimelineRail）。
 *
 * - 一轮一格，当前视口所在的那一轮画 `━━`、其余画 ` ─`，▲ + 刻度 + ▼ 这一块在列里
 *   **纵向居中**，两头箭头永远画（没有目标就暗色——位置固定，视线不用每帧重找）。
 *   照 dsh 的门槛：窄于 60 列、不到两轮、一屏装得下都不画。
 *
 * 整列**一次命中判定**（`row - top` 换算成列内行号），不在每行挂命中区；空档一律用
 * **固定高度的 spacer**——拿只含空格的 `Text` 当空行会被 yoga 压扁，整列跟着错位
 * （实测 16 行的列只画出 9 行、箭头落到中段）。颜色走既有调色板，不硬编码。
 *
 * **悬停**（对齐 dsh）：指针停在刻度列上时该行提亮一档；停住约 250ms 弹出
 * 一枚单行读数条（`第 N 轮 · 题面`），点下去跳哪儿与读数完全一致。三条实现约束：
 *
 * 1. 读数条是 `position="absolute"` 的子节点：**不占布局**（不弹出来就不影响任何行高），
 *    ink 6.8 的 Box 没有 `top`/`right`，绝对子节点落在**父节点的原点**上，所以它挂在
 *    悬停那一行的行盒里，再用**负 `marginLeft`** 顶到刻度列左边（实测：负 margin 认，
 *    但绝对子节点**不认**父节点的流式位置——放在列容器里会跑到列首，这也是它必须挂在
 *    行盒里的原因）。
 * 2. 指针位置只走 `pointer` 那个小 store，且**值没变不通知**（列判定在 store 里做）——
 *    鼠标划过屏幕其余地方，这个组件一次都不会重渲染。
 * 3. 拖动 = 「从刻度列上按住左键划过」：拖动会话由 App 在**按下**时开在这个区上
 *    （见 `App.dispatchMouseDrag`），划过是一条连续 scrub，与点击同一条映射（dsh 同款）。
 *
 * @module dsc-tui/app/TimelineRail
 */
import { Box, Text } from 'ink'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { JSX } from 'react'
import type { DOMElement } from 'ink'
import { absoluteTop, displayWidth, measuredSpan, useClickRegion, type RegisterClick } from './click.js'
import { useGutterPointer } from './pointer.js'
import {
  railHitRow,
  RAIL_GLYPH,
  RAIL_WIDTH,
  type RailGeometry,
  type RailRow,
} from './scroll-model.js'
import { PALETTE, RAIL_COLOR } from './theme.js'

/** 列里的一段：一行有字符（行号在几何里一一对应），或一段连续的空档。 */
export type RailSegment = { kind: 'row'; row: number } | { kind: 'gap'; rows: number }

/** 悬停多久弹读数条（对齐 dsh 的 dwell 闸：扫过不弹，停住才弹）。 */
const CHIP_DWELL_MS = 250

/** 把「逐行有/无内容」压成段序列：空档给固定高度，渲染时一行字符 = 几何里的一行。 */
export function segments(rows: Array<unknown | null>): RailSegment[] {
  const output: RailSegment[] = []
  for (let row = 0; row < rows.length; row += 1) {
    const value = rows[row]
    if (value === null || value === undefined) {
      const last = output[output.length - 1]
      if (last !== undefined && last.kind === 'gap') last.rows += 1
      else output.push({ kind: 'gap', rows: 1 })
      continue
    }
    output.push({ kind: 'row', row })
  }
  return output
}

/** 按显示宽度硬截（读数条宽度要自己算：绝对子节点的盒宽不能靠 yoga 量）。 */
function clip(text: string, maxWidth: number): string {
  let width = 0
  let index = 0
  while (index < text.length) {
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0)
    const next = width + displayWidth(char)
    if (next > maxWidth) return `${text.slice(0, index)}…`
    width = next
    index += char.length
  }
  return text
}

/** 刻度栏某一行画什么字符。 */
function glyphOf(entry: RailRow): string {
  if (entry.kind === 'up') return RAIL_GLYPH.up
  if (entry.kind === 'down') return RAIL_GLYPH.down
  return entry.active ? RAIL_GLYPH.active : RAIL_GLYPH.idle
}

/** 刻度栏某一行什么颜色（箭头分「有目标可点 / 没目标」两档）。 */
function colorOf(entry: RailRow, hovered: boolean): string {
  if (entry.kind === 'up' || entry.kind === 'down') {
    return entry.enabled ? RAIL_COLOR.arrow : RAIL_COLOR.arrowOff
  }
  if (hovered) return RAIL_COLOR.active
  return entry.active ? RAIL_COLOR.active : RAIL_COLOR.idle
}

/**
 * 悬浮读数条：单行、暗底、宽度自己算，用负 `marginLeft` 从行盒（= 刻度列）向左顶出去。
 * 绝对定位 → 不占布局；行盒只有两列宽，所以宽度必须是显式的（否则文字会按 2 列折行）。
 */
function HoverChip({ label }: { label: string }): JSX.Element {
  const width = displayWidth(label) + 2
  return (
    <Box position="absolute" height={1} width={width} marginLeft={-(width + 1)} backgroundColor={PALETTE.surface}>
      <Text color={PALETTE.surfaceText} wrap="truncate-end">
        {` ${label} `}
      </Text>
    </Box>
  )
}

/** 指针在刻度列上的第几行（列内 0 基）；不在列上/量不到几何 = null。 */
function useHoverRow(ref: RefObject<DOMElement | null>, rows: number): number | null {
  const pointerRow = useGutterPointer()
  const top = absoluteTop(ref.current)
  if (pointerRow === null || top === null) return null
  const local = pointerRow - 1 - top
  return local >= 0 && local < rows ? local : null
}

/** 停住才弹、弹出来就跟着走（原样照 dsh 的 dwell 语义）。 */
function useChipRow(hovered: number | null): number | null {
  const [chipRow, setChipRow] = useState<number | null>(null)
  useEffect(() => {
    if (hovered === null) {
      setChipRow(null)
      return
    }
    if (chipRow === hovered) return
    if (chipRow !== null) {
      setChipRow(hovered)
      return
    }
    const timer = setTimeout(() => setChipRow(hovered), CHIP_DWELL_MS)
    return () => clearTimeout(timer)
  }, [hovered, chipRow])
  return chipRow
}

/** 一行的行盒：`height={1}` + 不收缩——读数条按行盒的原点定位，压扁一行整块就错位。 */
function RailLine({ children, color, chip }: { children: string; color: string; chip?: JSX.Element | null }): JSX.Element {
  return (
    <Box height={1} flexShrink={0}>
      <Text color={color}>{children}</Text>
      {chip}
    </Box>
  )
}

export function TimelineRail({
  geometry,
  registerClick,
  onPickTurn,
  turnText,
}: {
  /** 每一行画什么（`scroll-model` 的 `railGeometry`）。 */
  geometry: RailGeometry
  registerClick?: RegisterClick
  /** 点了某一轮的刻度，或点了某一头的箭头（箭头直接给几何名下那一轮）。 */
  onPickTurn: (turn: number) => void
  /** 读数条上的题面预览（刻度 → 该轮题面首行；省略 = 只报轮号）。 */
  turnText?: (turn: number) => string | null
}): JSX.Element {
  const ref = useRef<DOMElement | null>(null)
  const hovered = useHoverRow(ref, geometry.rows.length)
  const chipRow = useChipRow(hovered)
  useClickRegion(
    ref,
    registerClick,
    (col, row, top, height) => {
      if (row < top || row >= top + height) return false
      // 列也要对得上：整块只占最右两列（页边距之内）。上一版只判行，于是正文里点一下
      // 也会跳到某一轮（用户报障：「左键点任意位置都被当成点滚动条」）。
      const span = measuredSpan(ref.current)
      if (span === null || col < span.left || col >= span.left + span.width) return false
      const hit = railHitRow(geometry, row - top)
      if (hit === null) return false
      if (hit === 'up' || hit === 'down') {
        // 暗箭头（没有目标）点了什么也不做——「画得出 = 点得中，暗 = 保证的空操作」
        const target = hit === 'up' ? geometry.up : geometry.down
        if (target !== null) onPickTurn(target)
        return true
      }
      onPickTurn(hit)
      return true
    },
    // 认拖动：按住左键划过刻度列 = 一路跳（scrub），与点击同一条映射
    { drag: true },
  )
  return (
    <Box ref={ref} width={RAIL_WIDTH} flexShrink={0} flexDirection="column">
      {segments(geometry.rows).map((segment, index) =>
        segment.kind === 'gap' ? (
          <Box key={`gap-${index}`} height={segment.rows} flexShrink={0} />
        ) : (
          <RailLine
            key={`row-${segment.row}`}
            color={colorOf(geometry.rows[segment.row]!, hovered === segment.row)}
            chip={chipRow === segment.row ? <HoverChip label={tickLabel(geometry.rows[segment.row]!, turnText)} /> : null}
          >
            {glyphOf(geometry.rows[segment.row]!)}
          </RailLine>
        ),
      )}
    </Box>
  )
}

/** 刻度那行的读数条文案：`第 N 轮 · 题面预览`（没有预览就只报轮号）。 */
function tickLabel(entry: RailRow, turnText: ((turn: number) => string | null) | undefined): string {
  if (entry.kind !== 'tick') return ''
  const head = `第 ${entry.turn + 1} 轮`
  const text = turnText?.(entry.turn) ?? null
  return text === null || text === '' ? head : `${head} · ${clip(text, 24)}`
}
