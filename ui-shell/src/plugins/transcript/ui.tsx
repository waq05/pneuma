/**
 * 内置插件：对话消息流。
 *
 * 数据是宿主推来的转录条目（已定稿的 `entries` + 正在流式的 `liveEntries`），
 * 按 `kind` 分别渲染。这一版刻意**只读**：输入、审批、提问都还没搬过来，
 * 所以它画得出「发生了什么」，但用户还不能从这里回话。
 *
 * 两条刻意的取舍：
 *
 *   1. **每行一个错误边界**：整个消息流是**一条**槽登记，一行渲染抛异常不该让
 *      整条流退位（壳的错误边界是按条目退位的，粒度太粗）。所以插件自己在行级兜一层。
 *   2. **markdown 还没渲染**：正文按 `pre-wrap` 原样显示。老渲染层有完整的一份
 *      markdown（代码块高亮、表格、链接），搬它是一整步，不塞在这一步里混做。
 *
 * @module dsc-ui-shell/plugins/transcript
 */
import { Component, useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import {
  defineUiPlugin,
  useHostSnapshot,
  type ChangedFileView,
  type SubagentCardView,
  type ToolCallView,
  type ToolStatus,
  type TranscriptEntry,
} from '@dsc/ui'

/** 条目本来就带 id（宿主发的正数），这里把它并进联合类型，渲染时直接用得上。 */
type Entry = TranscriptEntry & { id: number }

export default defineUiPlugin({
  name: '对话消息流',
  apply(ui) {
    // order 1：主区的主体。
    ui.slots.register('shell.main', { id: 'transcript.flow', order: 1 }, Transcript)
  },
})

function Transcript() {
  const snapshot = useHostSnapshot()
  const entries = (snapshot?.entries ?? []) as Entry[]
  const live = (snapshot?.liveEntries ?? []) as Entry[]
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const end = endRef.current
    if (end === null) return
    const scroller = end.closest('.shell-main')
    if (!(scroller instanceof HTMLElement)) return
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    // 只在「本来就在底部附近」时跟着滚：用户翻上去看历史时不该被拽回来。
    if (distance > 160) return
    end.scrollIntoView({ block: 'end' })
  }, [entries.length, live.length, snapshot?.seq])

  if (snapshot === null) {
    return <p className="flow-empty">等宿主推第一帧…</p>
  }
  if (entries.length === 0 && live.length === 0) {
    return <p className="flow-empty">这条会话还没有内容。发一条消息就开始。</p>
  }
  return (
    <div className="flow" data-entries={entries.length} data-live={live.length}>
      {entries.map((entry) => (
        <Row key={entry.id} entry={entry} live={false} />
      ))}
      {live.map((entry) => (
        <Row key={entry.id} entry={entry} live />
      ))}
      <div ref={endRef} className="flow-end" />
    </div>
  )
}

/** 一行：先按 kind 选择画法，整行套一个边界（一行坏了不影响别的行）。 */
function Row({ entry, live }: { entry: Entry; live: boolean }): ReactNode {
  return (
    <RowBoundary id={entry.id} kind={String(entry.kind)}>
      <div className={live ? 'row live' : 'row'} data-kind={String(entry.kind)} data-entry-id={entry.id}>
        <RowBody entry={entry} />
      </div>
    </RowBoundary>
  )
}

function RowBody({ entry }: { entry: Entry }): ReactNode {
  switch (entry.kind) {
    case 'user':
      return <UserRow entry={entry} />
    case 'text':
      return <TextRow entry={entry} />
    case 'thinking':
      return <ThinkingRow entry={entry} />
    case 'tool':
      return <ToolRow entry={entry} />
    case 'system':
      return <SystemRow entry={entry} />
    case 'turn-end':
      return (
        <p className="row-turn-end" data-reason={entry.reason}>
          {entry.reason === 'completed' ? '这一轮结束' : entry.reason === 'aborted' ? '这一轮被中断' : '这一轮出错结束'}
        </p>
      )
    case 'turn-max-tokens':
      return <p className="row-dim">输出撞上了长度上限</p>
    case 'model-retry':
      return (
        <p className="row-dim">
          模型请求失败，正在重试（第 {entry.attempt} 次）：{oneLine(entry.text, 120)}
        </p>
      )
    case 'plan':
      return (
        <div className="row-card">
          <p className="row-card-head">
            计划 · {entry.plan.title}
            <span className="row-tag" data-decision={entry.plan.decision}>
              {entry.plan.decision === 'pending' ? '等你批' : entry.plan.decision === 'approved' ? '已批准' : '已拒绝'}
            </span>
          </p>
          <pre className="row-pre">{entry.plan.text}</pre>
          <p className="row-dim">{entry.plan.file}</p>
        </div>
      )
    case 'subagent':
      return <SubagentRow card={entry.sub} />
    case 'changes':
      return <ChangedRow file={entry.file} />
    case 'turnDiff':
      return (
        <div className="row-card">
          <p className="row-card-head">本回合改动的文件（{entry.files.length}）</p>
          {entry.files.map((file) => (
            <ChangedRow key={file.path} file={file} />
          ))}
        </div>
      )
    default:
      // 认不出的种类照样上屏（说清是什么），比整条流少一块好查。
      // 类型上这里已经是 never（联合类型被穷尽），所以只能从原对象上取名字。
      return <p className="row-dim">认不出的条目：{String((entry as { kind?: unknown }).kind)}</p>
  }
}

/** 用户消息：气泡 + 图上缩略图 + 「插话 / 压缩 / 非人打的」标记。 */
function UserRow({ entry }: { entry: Extract<Entry, { kind: 'user' }> }): ReactElement {
  return (
    <div className="row-user">
      <div className="row-user-bubble">
        {entry.internal === true ? (
          <p className="row-dim">子任务状态更新</p>
        ) : null}
        <p className="row-text">{entry.text}</p>
        {(entry.images ?? []).length === 0 ? null : (
          <p className="row-images">
            {entry.images?.map((source, index) => (
              <img key={index} src={source} alt={`附图 ${String(index + 1)}`} />
            ))}
          </p>
        )}
      </div>
      <p className="row-tags">
        {entry.ts === undefined ? null : <span>{clock(entry.ts)}</span>}
        {entry.steering === true ? <span className="row-tag">插话</span> : null}
        {entry.compaction === undefined ? null : <span className="row-tag">第 {entry.compaction.count} 次压缩</span>}
      </p>
    </div>
  )
}

/** 助手正文。 */
function TextRow({ entry }: { entry: Extract<Entry, { kind: 'text' }> }): ReactElement {
  return (
    <div className="row-assistant">
      <p className="row-text">{entry.text}</p>
      <UsageLine usage={entry.usage} ts={entry.ts} />
    </div>
  )
}

/** 思考：默认收起，展开才看正文（默认档位下它是最长的那块）。 */
function ThinkingRow({ entry }: { entry: Extract<Entry, { kind: 'thinking' }> }): ReactElement {
  const seconds = entry.durationMs === undefined ? null : Math.round(entry.durationMs / 1000)
  return (
    <details className="row-thinking">
      <summary>
        思考{seconds === null || seconds < 1 ? '' : ` · ${String(seconds)} 秒`} · {oneLine(entry.text, 40)}
      </summary>
      <pre className="row-pre">{entry.text}</pre>
    </details>
  )
}

/** 工具调用：一行摘要（状态点 + 工具名 + 耗时），展开看参数与结果。 */
function ToolRow({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }): ReactElement {
  const call: ToolCallView = entry.call
  return (
    <details className="row-tool" data-status={call.status}>
      <summary>
        <span className="row-dot" data-status={call.status} title={statusLabel(call.status)} />
        <code className="row-tool-name">{call.name}</code>
        {call.durationMs === undefined ? null : <span className="row-dim">{formatMs(call.durationMs)}</span>}
        {call.status === 'running' ? <span className="row-dim">跑着…</span> : null}
        {call.status === 'failed' || call.status === 'rejected' ? (
          <span className="row-tag bad">{statusLabel(call.status)}</span>
        ) : null}
        <span className="row-tool-args">{oneLine(call.argsText, 80)}</span>
      </summary>
      <div className="row-tool-body">
        {call.argsText === '' ? null : <pre className="row-pre">{call.argsText}</pre>}
        {call.resultText === undefined || call.resultText === '' ? null : (
          <>
            <p className="row-dim">结果</p>
            <pre className="row-pre">{clip(call.resultText, 4000)}</pre>
          </>
        )}
      </div>
      <UsageLine usage={entry.usage} ts={entry.ts} />
    </details>
  )
}

/** 系统提示行（含压缩落点标记）。 */
function SystemRow({ entry }: { entry: Extract<Entry, { kind: 'system' }> }): ReactElement {
  return (
    <p className="row-system">
      {entry.compaction === undefined ? null : <span className="row-tag">第 {entry.compaction.count} 次压缩</span>}
      {entry.text}
    </p>
  )
}

/** 队友内联卡：状态 + 任务 + 轮数/工具数 + 当前工具。 */
function SubagentRow({ card }: { card: SubagentCardView }): ReactElement {
  return (
    <div className="row-card" data-subagent={card.name}>
      <p className="row-card-head">
        <span className="row-dot" data-status={card.state} title={card.state} />
        队友 {card.name}（{card.role}）
        <span className="row-dim">
          {card.rounds} 轮 / {card.toolCalls} 次工具
          {card.tokens === undefined ? '' : ` / ${String(card.tokens)} tokens`}
        </span>
      </p>
      <p className="row-dim">{oneLine(card.task, 160)}</p>
      {card.lastTool === undefined ? null : (
        <p className="row-dim">
          当前工具 <code>{card.lastTool.name}</code> · {card.lastTool.status}
        </p>
      )}
      {card.error === undefined ? null : <p className="row-tag bad">{card.error}</p>}
    </div>
  )
}

/** 一个文件的实际改动：路径 + 增删行数。 */
function ChangedRow({ file }: { file: ChangedFileView }): ReactElement {
  return (
    <p className="row-changed" data-file={file.path}>
      <code>{file.path}</code>
      <span className="row-added">+{file.added}</span>
      <span className="row-removed">−{file.removed}</span>
      {file.status === 'added' ? <span className="row-tag">新建</span> : null}
      {file.truncated === true ? <span className="row-tag">只显示前一部分</span> : null}
    </p>
  )
}

/** 一行用量（轮内最后一条才是整轮真值，这里只是把读数摊出来）。 */
function UsageLine({ usage, ts }: { usage?: { inputTokens: number; outputTokens: number }; ts?: number }): ReactElement | null {
  if (usage === undefined && ts === undefined) return null
  return (
    <p className="row-tags">
      {ts === undefined ? null : <span>{clock(ts)}</span>}
      {usage === undefined ? null : (
        <span>
          入 {usage.inputTokens} / 出 {usage.outputTokens} tokens
        </span>
      )}
    </p>
  )
}

/** 行级错误边界：一行渲染崩了只让那一行显示原因，别的行照旧。 */
class RowBoundary extends Component<{ id: number; kind: string; children: ReactNode }, { error: string | null }> {
  constructor(props: { id: number; kind: string; children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <p className="row-crash" data-kind={this.props.kind} data-entry-id={this.props.id}>
          这条（{this.props.kind}）画不出来：{this.state.error}
        </p>
      )
    }
    return this.props.children
  }
}

/** 工具状态 → 中文。 */
function statusLabel(status: ToolStatus | SubagentCardView['state']): string {
  if (status === 'running' || status === 'working') return '进行中'
  if (status === 'done' || status === 'idle') return '完成'
  if (status === 'failed') return '失败'
  if (status === 'rejected') return '被拒'
  if (status === 'stopped') return '被打断'
  return '准备中'
}

/** 时刻 → `HH:MM`。 */
function clock(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 毫秒 → 「1.2 秒」/「340 毫秒」。 */
function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${String(ms)} 毫秒`
}

/** 掐成一行（摘要行上用；换行一律换成空格）。 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 长文本按字符截断（工具结果可能很长）。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（还有 ${String(text.length - max)} 个字符）`
}
