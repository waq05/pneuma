/**
 * 工具行：**默认折叠成一行「⚙  调用 xx 工具 · 状态」**，点一行才展开参数与结果
 * （用户口径：工具调用默认只报「调用了什么」，细节点开才给）。展开体缩两格、走暗淡色；
 * 不给整行套描边框，一屏能多放下几条。
 *
 * 三条实现约束：
 * 1. **展开态由调用方持有**（App 的 `expandedTools`）：卡片滚出窗口切片再滚回来、或换到
 *    回看浮层，展开与否都还在同一份状态里。
 * 2. 点击判定**行、列都量**（行在卡内、列在卡宽内）：右侧那两列是刻度栏的，别抢——
 *    只判行的话，点在刻度栏上会被卡片吃掉，反之亦然（用户报过「点哪都像点滚动条」）。
 * 3. 图标与文字之间留**两格**：`⚙` 在多数终端按双宽字形渲染，一格会被字形吃掉，
 *    看起来就是图标和文本挤在一起（用户报的「挤一块」）。
 *
 * @module dsc-tui/app/ToolCard
 */
import { Box, Text } from 'ink'
import { useRef } from 'react'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type { ToolCallView } from '../contract.js'
import { measuredSpan, useClickRegion, type RegisterClick } from './click.js'
import { GAP, INDENT, SEP, STATUS_COLOR, TEXT } from './theme.js'
import { oneLine } from '../core/strings.js'

/** 状态标签：中文硬编码，配色只取 `STATUS_COLOR` 里的状态色。 */
const STATUS_LABEL: Record<ToolCallView['status'], { text: string; color: string | undefined }> = {
  // 模型吐了工具名、参数还没到齐（对照 dsh 的 preparing 阶段）：与「执行中」同色，
  // 但它只是「接下来要干这件事」，参数与结果都还没有。
  preparing: { text: '◌ 准备中', color: STATUS_COLOR.pending },
  running: { text: '◐ 执行中', color: STATUS_COLOR.pending },
  done: { text: '✓ 完成', color: STATUS_COLOR.done },
  failed: { text: '✗ 失败', color: STATUS_COLOR.failed },
  rejected: { text: '⊘ 已拒绝', color: STATUS_COLOR.failed },
}

/** 参数摘要截断宽度（展开态那一行）。 */
const ARG_PREVIEW_LIMIT = 80
/** 结果摘要截断宽度。 */
const RESULT_PREVIEW_LIMIT = 200

/** 耗时的人话格式：890ms / 1.2s / 1m23s。 */
const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function ToolCard({
  call,
  expanded,
  onToggle,
  registerClick,
}: {
  call: ToolCallView
  /** 展开态（点整卡切换；状态由调用方持有）。 */
  expanded: boolean
  /** 点一下整卡的回调（省略 = 卡片不可点，只画折叠态）。 */
  onToggle?: () => void
  registerClick?: RegisterClick
}): JSX.Element {
  const status = STATUS_LABEL[call.status]
  const ref = useRef<DOMElement | null>(null)
  useClickRegion(
    ref,
    onToggle === undefined ? undefined : registerClick,
    onToggle === undefined
      ? undefined
      : (col, row, top, height) => {
          if (row < top || row >= top + height) return false
          const span = measuredSpan(ref.current)
          if (span === null || col < span.left || col >= span.left + span.width) return false
          onToggle()
          return true
        },
  )
  const hasResult = call.resultText !== undefined && call.resultText !== ''
  return (
    <Box ref={ref} flexDirection="column" marginLeft={INDENT.tool} gap={GAP.none}>
      <Box>
        <Box flexShrink={0}>
          <Text {...TEXT.secondary}>{`⚙  调用 ${call.name === '' ? '未知' : call.name} 工具`}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text {...TEXT.label} color={status.color}>
            {SEP.dot}
            {status.text}
          </Text>
          {call.durationMs !== undefined ? (
            <Text {...TEXT.label} color={status.color}>
              {' '}
              · {fmtDuration(call.durationMs)}
            </Text>
          ) : null}
        </Box>
      </Box>
      {expanded && call.argsText !== '' ? (
        <Box marginLeft={INDENT.detail}>
          <Text {...TEXT.secondary} wrap="truncate-end">
            ▸ {oneLine(call.argsText, ARG_PREVIEW_LIMIT)}
          </Text>
        </Box>
      ) : null}
      {expanded && hasResult ? (
        <Box marginLeft={INDENT.detail}>
          <Text {...TEXT.secondary}>↳ {oneLine(call.resultText ?? '', RESULT_PREVIEW_LIMIT)}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
