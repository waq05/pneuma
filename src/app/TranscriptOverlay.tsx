/**
 * 回看浮层（Ctrl+O 打开 / 子代理只读转录复用同一块）：全量 transcript 的**行滚动**视口，
 * 右侧带轮数刻度栏。窗口切片、行偏移、刻度几何全在 `TranscriptViewport` 里，本组件只负责
 * 「浮层这层壳」——描边、标题行、提示行，以及把每一条交给 `ChatView` 的 `Entry` 渲染。
 *
 * 与旧版的区别：滚动单位从「条」改成「行」（一条比一屏还高的条目因此可以逐行读完，
 * 这正是「点进子代理看不到工作过程」的病根），并且条数窗口换成了「视口 ± overscan 行」
 * 的窗口——会话再长，渲染量也是有界的。
 *
 * @module dsc-tui/app/TranscriptOverlay
 */
import { Box, Text } from 'ink'
import { forwardRef } from 'react'
import type { JSX } from 'react'
import type { TranscriptEntry } from '../contract.js'
import { Entry } from './ChatView.js'
import type { RegisterClick } from './click.js'
import { HINT as HINT_TEXT } from './keymap.js'
import type { ViewportLayout } from './scroll-model.js'
import { TranscriptViewport, type TranscriptViewportApi } from './TranscriptViewport.js'
import { ACCENT, BORDER, PAD, TEXT } from './theme.js'

/**
 * 浮层固定占掉的行数：上下边框 2 + 标题 1 + 提示 1。
 * 视口行数 = 帧行数 − 状态栏行数 − 它（App 按这个算）。
 */
export const TRANSCRIPT_CHROME = 4

/** 浮层描边与内边距固定占掉的列数：边框 2 + 左右各 1 列内边距。 */
const OVERLAY_CHROME_COLUMNS = 4

/** 滚动提示行（主回看与子代理转录共用；键名统一从 `keymap` 的表里拼，不再各写一遍）。 */
const HINT = HINT_TEXT.transcript

/** 标题：主回看给「共 N 条 · 第 x-y 条」；子代理转录给「名字 · N 条」。 */
function titleText(title: string | undefined, total: number, layout: ViewportLayout): string {
  if (title !== undefined) return `${title} · ${total} 条`
  return `回看全文（共 ${total} 条 · 第 ${layout.start + 1}-${layout.end} 条）`
}

export interface TranscriptOverlayProps {
  /** 全量条目（视口自己切片）。 */
  entries: TranscriptEntry[]
  /** 全量条数（标题用；peek 失败时也会是 0）。 */
  total: number
  /** 标题（省略 = 本会话回看；子代理转录传它的名字）。 */
  title?: string
  /** 终端列数（浮层自身宽度与刻度栏门槛都用它算）。 */
  columns: number
  /** 视口行数（= 帧行数 − 状态栏 − `TRANSCRIPT_CHROME`）。 */
  viewportLines: number
  /** 子代理转录（只读 peek）与主回看的提示行不同时用。 */
  hint?: string
  registerClick?: RegisterClick
  /** 已展开的工具卡与切换回调（与聊天区同一份）：浮层里点工具卡也能展开。 */
  expandedTools?: ReadonlySet<number>
  onToggleTool?: (id: number) => void
}

export const TranscriptOverlay = forwardRef<TranscriptViewportApi, TranscriptOverlayProps>(
  function TranscriptOverlay(
    { entries, total, title, columns, viewportLines, hint, registerClick, expandedTools, onToggleTool },
    ref,
  ): JSX.Element {
    return (
      <Box
        borderStyle="round"
        borderColor={BORDER.active}
        paddingX={PAD.inline}
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
      >
        <TranscriptViewport
          ref={ref}
          entries={entries}
          columns={columns}
          maxWidth={Math.max(20, columns - PAD.page * 2 - OVERLAY_CHROME_COLUMNS)}
          viewportLines={viewportLines}
          showRail
          registerClick={registerClick}
          emptyHint="（这个会话还没有条目）"
          header={(layout) => (
            <Text {...TEXT.label} color={ACCENT} wrap="truncate-end">
              {titleText(title, total, layout)}
            </Text>
          )}
          footer={
            <Text {...TEXT.secondary} wrap="truncate-end">
              {hint ?? HINT}
            </Text>
          }
          renderEntry={(entry) => (
            <Entry
              entry={entry}
              streaming={false}
              expandThinking={false}
              expandedTools={expandedTools}
              onToggleTool={onToggleTool}
              registerClick={registerClick}
            />
          )}
        />
      </Box>
    )
  },
)
