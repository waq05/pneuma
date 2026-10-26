/**
 * 会话流：把 TranscriptEntry 序列渲染成终端块。只渲染 App 算好的「可见窗口」切片
 * （整屏视口：根盒恒定高度、底对齐、老条目从顶上裁掉；回看走 Ctrl+O 浮层）。
 *
 * 排版走 theme 的三档文字：助手回答与用户输入是正文（默认前景），思考正文与系统
 * 说明是次要信息（暗淡色），思考标题是状态标签（暗淡色 + 状态色）。条目之间贴排，
 * 纵向间距只在 `ChatView` 这一处声明。
 *
 * 过程节点如实显示：中断/失败的轮有轮尾标记、输出截断与模型重试各有自己的行、
 * 轮尾有「文件已更改」聚合、计划卡带批准状态、插话带 ↩ 徽标、压缩落点画分隔线——
 * 失败轮和成功轮在终端里不再长得一样。
 *
 * @module dsc-tui/app/ChatView
 */
import { memo, useRef } from 'react'
import { Box, Text, useStdout } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX, ReactNode, Ref } from 'react'
import type { SubagentCardView, TranscriptEntry } from '../contract.js'
import { MarkdownView } from './MarkdownView.js'
import { ToolCard } from './ToolCard.js'
import { displayWidth } from './markdown.js'
import { measuredSpan, useClickRegion, type RegisterClick } from './click.js'
import { HINT } from './keymap.js'
import { useTick } from './ticker.js'
import { TranscriptViewport, type TranscriptViewportApi } from './TranscriptViewport.js'
import { ACCENT, DIFF_COLOR, GAP, INDENT, PAD, PALETTE, STATUS_COLOR, TEXT, mixHex } from './theme.js'

/** 流式思考的盲文 spinner 帧（dsh 同款字符，80-120ms 一拍）。 */
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * 用户消息之前留一行空：一句话（尤其金色的 `❯` 行）紧贴在上一轮的工具输出下面是糊的
 * ——看不出「这一轮从哪开始」。dsh 的做法是「一轮的第一条消息 marginTop=1」（
 * MessageList 的 `marginTopOnTurn`），这里同款。列表第一条也留：它上面要么是欢迎块、
 * 要么是开场提示，留一行反而把题面从引导文字里分出来。
 */
const USER_TOP_GAP = 1

/** spinner 节拍：所有 spinner 共用这一个周期（见 ticker.ts）。 */
const BRAILLE_MS = 120

/** 耗时读数节拍：同上，1 秒一格。 */
const SECONDS_MS = 1000

/**
 * 盲文 spinner：走共享节拍（同周期全局一个计时器），帧状态只重渲染自己。
 *
 * `pulse` = **呼吸色**（照 dsh 的 Kimi Code 蓝脉冲）：字形颜色沿「品牌蓝 → 冰蓝」按正弦
 * 来回，一个来回约 0.55 秒（`sin(frame * 0.9)`，与 dsh 同一个系数）。只给「思考中」用——
 * 画面上同时呼吸的东西一多就是噪音，工具卡/队友卡上的 spinner 保持恒定强调色。
 */
function BrailleSpinner({ pulse = false }: { pulse?: boolean }): JSX.Element {
  const frame = useTick(BRAILLE_MS)
  const color =
    pulse === true ? mixHex(PALETTE.brand, PALETTE.ice, (Math.sin(frame * 0.9) + 1) / 2) : PALETTE.accent
  return <Text color={color}>{BRAILLE[frame % BRAILLE.length]}</Text>
}

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 时长的人话格式（dsh duration 同款）：48s / 3m12s；不足 1 秒返回空串（不显示）。 */
const fmtSeconds = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 1) return ''
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** token 数的人话格式（与 StatusBar 的 fmtTokens 同口径：988 / 3.4k / 12k / 1.0M）。 */
const fmtTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** 瀑布窗口恒定 3 行（Kimi Code 视觉语言，dsh 同款）：高度不随输出抖动。子代理卡与
 *  思考块共用（`scroll-model.estimateLines` 里同口径）。 */
const WATERFALL_ROWS = 3

/**
 * 按显示宽度硬截单行：折行会破坏瀑布的恒定 3 行窗口（dsh clipLine 同款）。
 * 逐码点走，CJK/emoji 宽字符永远不会被劈成两半。
 */
const clipLine = (text: string, maxWidth: number): string => {
  if (maxWidth <= 1) return ''
  let width = 0
  let index = 0
  while (index < text.length) {
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0)
    const charWidth = displayWidth(char)
    if (width + charWidth > maxWidth - 1) return `${text.slice(0, index)}…`
    width += charWidth
    index += char.length
  }
  return text
}

/** 文件路径的末段（显示用）。 */
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/**
 * 从**尾部**硬截单行（`clipLine` 的镜像）：`…` + 尽量多的后缀。
 *
 * 为什么要留尾：瀑布的末行是「刚吐出来的那几个字」长在行尾，留头截尾的话永远看不见
 * 最新内容（dsh 的 `truncate-start` 同义）。
 */
const clipLineStart = (text: string, maxWidth: number): string => {
  if (maxWidth <= 1) return ''
  const chars = [...text]
  let width = 0
  let index = chars.length
  while (index > 0) {
    const charWidth = displayWidth(chars[index - 1]!)
    if (width + charWidth > maxWidth - 1) break
    width += charWidth
    index -= 1
  }
  return index === 0 ? text : `…${chars.slice(index).join('')}`
}

/**
 * 思考块的**恒定 3 行瀑布窗口**（照 dsh 的 preview ticker）：取正文最后 3 行——流式时
 * 最新的话就在底部——每行硬截到框宽、**不折行**，所以块高与「流到哪一句 / 框多宽」都无关，
 * 加字不会让整块跳一下。上面还有内容时首行前缀 `…`；末行从尾部截（新词长在行尾）。
 *
 * @param text - 思考正文。
 * @param width - 正文可用列数（不含 `│ ` 引导）。
 */
const thinkingRows = (text: string, width: number): string[] => {
  const lines = text.split('\n')
  const visible = lines.slice(-WATERFALL_ROWS)
  const clipped = lines.length > visible.length
  return Array.from({ length: WATERFALL_ROWS }, (_, index) => {
    const raw = visible[index] ?? ''
    const moreAbove = index === 0 && clipped
    const room = moreAbove ? Math.max(1, width - 1) : width
    const body =
      raw === '' ? '' : index === WATERFALL_ROWS - 1 ? clipLineStart(raw, room) : clipLine(raw, room)
    // 引导符永远在：空行也画 `│ `，否则空字符串的 Text 高度是 0，瀑布会缺行
    return `│ ${moreAbove ? '…' : ''}${body}`
  })
}

/** 瀑布正文的可用列数（页边距与缩进之外再扣掉 `│ ` 两列）。 */
const thinkingWidth = (columns: number): number =>
  Math.max(8, columns - PAD.page * 2 - INDENT.detail - 2)

/**
 * 思考正文：展开态给全文，折叠态给恒定 3 行瀑布（宽度自己量，`Entry` 不必为此接 props）。
 */
function ThinkingBody({ text, expanded }: { text: string; expanded: boolean }): JSX.Element | null {
  const { stdout } = useStdout()
  if (expanded) return <Text {...TEXT.secondary}>{text}</Text>
  if (text === '') return null
  return (
    <>
      {thinkingRows(text, thinkingWidth(stdout?.columns ?? 100)).map((row, index) => (
        <Text key={index} {...TEXT.secondary} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </>
  )
}

/** 子代理卡的运行状态词与颜色（对照 dsh SubagentMessage 的 status()）。 */
const SUBAGENT_STATUS: Record<SubagentCardView['state'], { glyph: string; label: string; color: string | undefined }> = {
  working: { glyph: '◐', label: '运行中', color: STATUS_COLOR.pending },
  idle: { glyph: '✓', label: '已完成', color: STATUS_COLOR.done },
  failed: { glyph: '✗', label: '失败', color: STATUS_COLOR.failed },
  stopped: { glyph: '×', label: '已停止', color: STATUS_COLOR.failed },
}

/** 子代理卡：跑动时 = 头行（状态点 + bold 任务 + 模型/轮数/工具数/耗时/token）
 * + 当前工具行 + 恒定 3 行输出瀑布（dim、`│` 引导）；收工折成头行一行（失败保留
 * 一条错误行）。整卡可点，点了开队友的只读转录浮层。
 */
function SubagentCard({
  sub,
  onOpen,
  registerClick,
}: {
  sub: SubagentCardView
  onOpen?: (file: string) => void
  registerClick?: RegisterClick
}): JSX.Element {
  const { stdout } = useStdout()
  const ref = useRef<DOMElement | null>(null)
  const settled = sub.state !== 'working'
  // 跑动时头部耗时每秒跳一格（共享 1s 节拍；收工停表，不停着一张卡一个计时器）
  useTick(SECONDS_MS, !settled && sub.startedAt !== undefined)
  const info = SUBAGENT_STATUS[sub.state]
  const clickable = onOpen !== undefined && sub.file !== undefined
  useClickRegion(
    ref,
    clickable ? registerClick : undefined,
    clickable
      ? (col, row, top, height) => {
          if (row < top || row >= top + height) return false
          // 行对列也要对：卡片右边与刻度栏同屏时，点在刻度栏上应归刻度栏（跳轮），
          // 点卡片正文才开队友转录
          const span = measuredSpan(ref.current)
          if (span === null || col < span.left || col >= span.left + span.width) return false
          onOpen!(sub.file!)
          return true
        }
      : undefined,
  )
  const columns = stdout?.columns ?? 100
  // 卡片缩进 2 + 瀑布引导 `│ ` 前缀 4，与 dsh 的 WATERFALL_GUTTER 同口径
  const rowWidth = Math.max(20, columns - PAD.page * 2 - INDENT.detail - 2)
  const elapsed =
    sub.startedAt === undefined ? undefined : (sub.finishedAt ?? Date.now()) - sub.startedAt
  const seconds = elapsed === undefined ? '' : fmtSeconds(elapsed)
  const activity = settled ? [] : (sub.outputLines ?? []).slice(-WATERFALL_ROWS)
  return (
    <Box ref={ref} flexDirection="column" marginLeft={INDENT.detail} gap={GAP.none}>
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          <Text color={info.color}>{sub.state === 'working' ? <BrailleSpinner /> : info.glyph}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold color={PALETTE.text}>
            {`子代理：${oneLine(sub.task, 42)}`}
          </Text>
        </Box>
        <Box minWidth={0}>
          <Text {...TEXT.secondary} wrap="truncate-end">
            {`· ${sub.model ?? 'default'} · ${sub.rounds}轮 · ${sub.toolCalls}工具`}
            {seconds === '' ? '' : ` · ${seconds}`}
            {sub.tokens === undefined ? '' : ` · ${fmtTokens(sub.tokens)} tok`}
            {` · `}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={info.color}>{info.label}</Text>
        </Box>
      </Box>
      {!settled && sub.lastTool !== undefined ? (
        <Text {...TEXT.secondary} wrap="truncate-end">
          {`  ${sub.lastTool.status === 'done' ? '✓ ' : sub.lastTool.status === 'failed' ? '✗ ' : ''}${sub.lastTool.name}`}
          {sub.lastTool.args !== '' ? ` (${clipLine(sub.lastTool.args, Math.max(10, rowWidth - sub.lastTool.name.length - 6))})` : ''}
        </Text>
      ) : null}
      {!settled
        ? Array.from({ length: WATERFALL_ROWS }, (_, index) => (
            <Text key={`wf-${index}`} {...TEXT.secondary} wrap="truncate-end">
              {`  │ ${clipLine(activity[index] ?? '', rowWidth)}`}
            </Text>
          ))
        : null}
      {settled && sub.state === 'failed' && sub.error !== undefined ? (
        <Text color={STATUS_COLOR.failed} wrap="truncate-end">
          {`  └ ${clipLine(sub.error, rowWidth)}`}
        </Text>
      ) : null}
    </Box>
  )
}

/** 压缩落点的分隔线（system 通知与重放摘要共用一条样式）。 */
function CompactionRule({ count }: { count: number }): JSX.Element {
  return (
    <Text {...TEXT.label} color={ACCENT}>
      ⎯ 已压缩历史 · 第 {count} 次 ⎯
    </Text>
  )
}

/**
 * 滚离尾部时**浮在视口第一行**上的那一行（照 dsh 的 `PinnedTurnHeader`）：**当前轮的题面**。
 *
 * 往上读的时候，屏幕上永远有一行告诉你「现在读的是哪一轮」——长会话里最贵的认知负担
 * 就是这个；点它跳回本轮题面（dsh 同语义）。
 *
 * 硬性只占一行、**且不挤掉内容行**（它由 TranscriptViewport 用零高容器 + 负 margin 浮上去，
 * 见那边 `pinned` 的注释）：挤掉一行会改内容坐标（同样格数滚回来差一行到不了底）与刻度栏
 * 位置。所以这里把文本**补齐到满宽**——浮层要盖住下面那一行，只画 `❯ …` 几个字符的话
 * 后半行会露出底下的正文。
 */
function PinnedTurn({
  text,
  turn,
  width,
  onPick,
  registerClick,
}: {
  text: string
  turn: number
  /** 要盖满的列数（浮层的宽度；正文列宽减掉刻度栏那两列）。 */
  width: number
  onPick: (turn: number) => void
  registerClick?: RegisterClick
}): JSX.Element {
  const ref = useRef<DOMElement | null>(null)
  useClickRegion(ref, registerClick, (col, row, top, height) => {
    if (row < top || row >= top + height) return false
    // 行对列也要对（钉住行只占正文那几列）：点在右侧刻度栏上不该被它吃掉
    const span = measuredSpan(ref.current)
    if (span === null || col < span.left || col >= span.left + span.width) return false
    onPick(turn)
    return true
  })
  const label = clipLine(`❯ ${text}`, width)
  return (
    <Box ref={ref} height={1} flexShrink={0} overflow="hidden">
      <Text color={PALETTE.userPrompt} bold wrap="truncate-end">
        {label.padEnd(Math.max(0, width), ' ')}
      </Text>
    </Box>
  )
}

/** 用户消息的图片行：整行可点，点了开半块真彩预览（没有回调时退化为纯说明）。 */
function ImageLine({
  count,
  onPreview,
  registerClick,
}: {
  count: number
  onPreview?: () => void
  registerClick?: RegisterClick
}): JSX.Element {
  const ref = useRef<DOMElement | null>(null)
  useClickRegion(
    ref,
    onPreview === undefined ? undefined : registerClick,
    onPreview === undefined
      ? undefined
      : (col, row, top, height) => {
          if (row < top || row >= top + height) return false
          onPreview()
          return true
        },
  )
  return (
    <Box ref={ref} marginLeft={INDENT.detail}>
      <Text {...TEXT.secondary} color={onPreview === undefined ? undefined : ACCENT}>
        🖼 {count} 张图片{onPreview === undefined ? '' : ' · 点击预览'}
      </Text>
    </Box>
  )
}

/**
 * 单条条目的渲染（回看浮层复用同一份，直播光标由 streaming 控制）。
 *
 * `memo` 是救命的：定稿条目在 `transcript.entries` 里是**同一个对象引用**，而快照
 * 每次重建都会换掉直播尾——没有 memo 时每个增量都要把窗口里 80 条全部重渲染一遍。
 * 前提是 props 里没有每帧新建的值（回调在 App 侧已 `useCallback`，见 handleOpenAgent）。
 */
export const Entry = memo(function Entry({
  entry,
  streaming,
  expandThinking,
  expandedTools,
  onToggleTool,
  onPreviewImages,
  onOpenAgent,
  registerClick,
}: {
  entry: TranscriptEntry
  streaming: boolean
  expandThinking: boolean
  /** 已经展开的工具卡（点一行工具卡切换；状态由 App 持有）。 */
  expandedTools?: ReadonlySet<number>
  /** 点工具卡的回调（省略 = 工具卡不可点）。 */
  onToggleTool?: (id: number) => void
  /** 用户消息图片行的点击回调（省略 = 图片行不可点）。 */
  onPreviewImages?: (images: string[]) => void
  /** 子代理卡的点击回调（省略 = 卡片不可点）：打开队友的只读转录浮层。 */
  onOpenAgent?: (file: string) => void
  registerClick?: RegisterClick
}): JSX.Element | null {
  switch (entry.kind) {
    case 'user':
      // 运行时投进来的消息（队友干完活的 <teammate-report> 汇报）：不是人打的字，
      // 只报一行「子任务状态更新」，正文留在会话里给模型看（对照 dsh 的 turn-trigger 节点，
      // 那边默认也只是一行标题）。终端界面不做展开——要看原文去桌面端或会话 jsonl。
      if (entry.internal === true) {
        return <Text {...TEXT.secondary}>⌸ 子任务状态更新</Text>
      }
      return (
        <Box flexDirection="column" gap={GAP.none} marginTop={USER_TOP_GAP}>
          {entry.compaction !== undefined ? <CompactionRule count={entry.compaction.count} /> : null}
          {/* 用户行金色粗体（dsh userPromptLabel），自然折行续行对齐文字列 */}
          <Box>
            <Text color={PALETTE.userPrompt} bold>
              ❯{entry.steering === true ? ' ↩' : ''}{' '}
            </Text>
            <Text color={PALETTE.userPrompt} bold>
              {entry.text}
            </Text>
          </Box>
          {entry.images !== undefined && entry.images.length > 0 ? (
            <ImageLine
              count={entry.images.length}
              onPreview={
                onPreviewImages === undefined ? undefined : () => onPreviewImages(entry.images ?? [])
              }
              registerClick={registerClick}
            />
          ) : null}
        </Box>
      )
    case 'thinking': {
      // 标签与内容分行（0.6.57）；0.6.59 对齐 dsh：⚓ + 斜体标签，流式时盲文 spinner；
      // 0.6.60 补时长（≥1s 才显示 · Ns，重放老日志没有这一项就自然不显示）；
      // 本批把折叠态从「压成一行的 100 字预览」换成 dsh 的**恒定 3 行瀑布**（见 thinkingRows）。
      const seconds = entry.durationMs === undefined ? '' : fmtSeconds(entry.durationMs)
      return (
        <Box flexDirection="column" gap={GAP.none}>
          <Text italic {...TEXT.secondary}>
            {streaming ? <BrailleSpinner pulse /> : <Text color={STATUS_COLOR.pending}>⚓</Text>}{' '}
            {streaming ? '思考中' : '思考'}
            {seconds === '' ? '' : ` · ${seconds}`}
            {expandThinking ? '' : HINT.thinkingExpand}
          </Text>
          <Box marginLeft={INDENT.detail} flexDirection="column">
            {/* 思考正文：暗淡、**不斜体**（对齐 dsh 的 `StreamingMarkdown dimColor`——
                那边只有标签行是斜体，正文是纯暗淡）。终端没有字号这一维，「小一号」在
                这里就是暗淡色 + 不斜体：斜体让长中文段落挤在一起更难读，也把思考与
                标答的视觉重量拉平了。 */}
            <ThinkingBody text={entry.text} expanded={expandThinking} />
          </Box>
        </Box>
      )
    }
    case 'text':
      return (
        <Box>
          <MarkdownView source={entry.text} cursor={streaming} />
        </Box>
      )
    case 'tool':
      return (
        <ToolCard
          call={entry.call}
          expanded={expandedTools?.has(entry.id) === true}
          {...(onToggleTool === undefined ? {} : { onToggle: () => onToggleTool(entry.id) })}
          registerClick={registerClick}
        />
      )
    case 'subagent':
      return <SubagentCard sub={entry.sub} onOpen={onOpenAgent} registerClick={registerClick} />
    case 'plan': {
      const state =
        entry.plan.decision === 'approved'
          ? { text: '已批准', color: STATUS_COLOR.done }
          : entry.plan.decision === 'rejected'
            ? { text: '未批准', color: STATUS_COLOR.failed }
            : { text: '待评审', color: STATUS_COLOR.waiting }
      return (
        <Box flexDirection="column" marginLeft={INDENT.tool} gap={GAP.none}>
          <Text>
            <Text {...TEXT.secondary}>📋 计划 </Text>
            <Text {...TEXT.body}>{oneLine(entry.plan.title, 60)}</Text>
            <Text {...TEXT.label} color={state.color}>
              {' '}
              · {state.text}
            </Text>
          </Text>
          <Box marginLeft={INDENT.detail}>
            <Text {...TEXT.secondary}>{entry.plan.file}</Text>
          </Box>
        </Box>
      )
    }
    case 'system':
      return (
        <Box flexDirection="column" gap={GAP.none}>
          {entry.compaction !== undefined ? <CompactionRule count={entry.compaction.count} /> : null}
          <Text {...TEXT.secondary}>ⓘ {entry.text}</Text>
        </Box>
      )
    case 'turn-end':
      return (
        <Text {...TEXT.label} color={entry.reason === 'error' ? STATUS_COLOR.failed : STATUS_COLOR.waiting}>
          {entry.reason === 'error' ? '✗ 过程失败' : '⏹ 已停止'}
        </Text>
      )
    case 'turn-max-tokens':
      return (
        <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
          ⚠ 输出达到长度上限，本轮被截断
        </Text>
      )
    case 'model-retry':
      return (
        <Text {...TEXT.secondary}>
          ↻ 第 {entry.attempt} 次重试：{oneLine(entry.text, 120)}
        </Text>
      )
    case 'changes':
      return (
        <Text {...TEXT.secondary}>
          ✎ {baseName(entry.file.path)}{' '}
          <Text color={DIFF_COLOR.add}>+{entry.file.added}</Text>{' '}
          <Text color={DIFF_COLOR.del}>−{entry.file.removed}</Text>
        </Text>
      )
    case 'turnDiff': {
      const added = entry.files.reduce((sum, file) => sum + file.added, 0)
      const removed = entry.files.reduce((sum, file) => sum + file.removed, 0)
      const names = entry.files
        .slice(0, 3)
        .map((file) => baseName(file.path))
        .join('、')
      return (
        <Text {...TEXT.label}>
          ✎ 本轮改动 {entry.files.length} 个文件（+{added} −{removed}）
          {names !== '' ? `：${names}${entry.files.length > 3 ? '…' : ''}` : ''}
        </Text>
      )
    }
    default:
      return null
  }
})

export function ChatView({
  entries,
  turnState,
  expandThinking,
  empty,
  welcome,
  maxWidth,
  columns,
  railCenterLines,
  expandedTools,
  onToggleTool,
  onPreviewImages,
  onOpenAgent,
  onPickTurn,
  registerClick,
  viewportRef,
  onAtTailChange,
}: {
  /** 全量条目（窗口切片、行偏移、刻度几何都在 TranscriptViewport 里按行算）。 */
  entries: TranscriptEntry[]
  turnState: 'idle' | 'thinking' | 'working' | 'awaiting-approval'
  expandThinking: boolean
  /** 全会话一条都没有（和「窗口恰好翻空」区分开，只有前者画开场提示）。 */
  empty: boolean
  /**
   * 挂在会话流最顶上的头部（启动欢迎页）：**随内容一起从顶上滚走**（对齐 codex 的
   * session header / dsh 的 LogoHeader——不独占屏幕，也不永久占位），所以它是流里的
   * 第一个「条目」，不是固定表头。
   */
  welcome?: ReactNode
  /** 没画刻度栏时可用的内容宽度（列）。 */
  maxWidth: number
  /** 终端总列数（刻度栏门槛）。 */
  columns: number
  /**
   * 刻度栏**居中**用的高度（省略 = 视口行数）。聊天区可用高度会随「回到底部」胶囊、
   * 草稿行数变化，按它居中会让整块刻度每滚一下上下挪一行，所以调用方传「帧高 − 状态栏」。
   */
  railCenterLines?: number
  /** 已展开的工具卡（点一行工具卡切换）。 */
  expandedTools?: ReadonlySet<number>
  /** 点工具卡的回调（省略 = 工具卡不可点）。 */
  onToggleTool?: (id: number) => void
  /** 用户消息图片行的点击预览回调（省略 = 图片行不可点）。 */
  onPreviewImages?: (images: string[]) => void
  /** 子代理卡点击回调（省略 = 卡片不可点）：打开队友的只读转录浮层。 */
  onOpenAgent?: (file: string) => void
  /** 顶部钉住的轮头被点击（参数是轮下标）：跳回那一轮的题面。 */
  onPickTurn?: (turn: number) => void
  registerClick?: RegisterClick
  /** 视口手柄（App 的键位与鼠标打这里）。 */
  viewportRef?: Ref<TranscriptViewportApi>
  /** 「是不是贴着最新」变化时回调（回到底部的那颗胶囊用）。 */
  onAtTailChange?: (atTail: boolean) => void
}): JSX.Element {
  // 直播尾（负 id）与最后定稿 text 条目才带光标闪烁位。
  const lastId = entries[entries.length - 1]?.id
  // 流头部（欢迎页 + 一句开场提示）当流里的第一块，跟着内容一起滚
  const leading =
    welcome === undefined && !empty ? undefined : (
      <>
        {welcome}
        {empty ? (
          <Box marginLeft={INDENT.detail}>
            <Text {...TEXT.secondary}>{HINT.empty}</Text>
          </Box>
        ) : null}
      </>
    )
  return (
    <TranscriptViewport
      ref={viewportRef}
      entries={entries}
      maxWidth={maxWidth}
      columns={columns}
      {...(railCenterLines === undefined ? {} : { railCenterLines })}
      showRail
      expandThinking={expandThinking}
      registerClick={registerClick}
      onAtTailChange={onAtTailChange}
      emptyHint={HINT.empty}
      // 滚离尾部时浮住当前轮的题面（视口把「当前轮」与正文列宽算好给进来，见 TranscriptViewport 的 `pinned`）
      pinned={(active, _layout, width) => {
        if (onPickTurn === undefined) return null
        const source = entries.find((item) => item.id === active.id)
        if (source === undefined || source.kind !== 'user') return null
        return (
          <PinnedTurn
            text={oneLine(source.text, 240)}
            turn={active.index}
            width={width}
            onPick={onPickTurn}
            registerClick={registerClick}
          />
        )
      }}
      renderEntry={(entry) => (
        <Entry
          entry={entry}
          streaming={entry.id === lastId && entry.id < 0 && (turnState === 'thinking' || turnState === 'working')}
          expandThinking={expandThinking}
          expandedTools={expandedTools}
          onToggleTool={onToggleTool}
          onPreviewImages={onPreviewImages}
          onOpenAgent={onOpenAgent}
          registerClick={registerClick}
        />
      )}
      {...(leading === undefined ? {} : { leading })}
    />
  )
}
