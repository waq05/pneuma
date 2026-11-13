/**
 * 工单详情：顶部读数、交付摘要、执行会话的只读时间线，以及停止 / 重试 / 清理三颗按钮。
 *
 * 时间线读 `superagentPeekSession`（宿主只读重放执行会话的 jsonl，不拿写租约）。
 * 这里刻意**不做输入框**：它是「看它干了什么」的只读面，不是第二个对话窗口。
 *
 * 清理只在 `stage === 'ended'` 时可点，点之前过 `confirmAction` 二次确认——删的是执行
 * 智能体的工作树，动作不可逆。停止 / 重试的可用性按阶段给：已结束不再停，跑着的不重试
 * （具体的合法性最终仍由宿主判，失败就把原因摊在按钮下面）。
 *
 * @module dsc-ui-shell/superagent/detail
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronRight,
  IconRefresh,
  confirmAction,
  createT,
  formatClock,
  humanErrorText,
  useHostChannel,
  type TranscriptEntry,
} from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'
import {
  closeTicket,
  formatAt,
  stageLabelOf,
  type SuperagentTicket,
  type SuperagentView,
} from './state'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 时间线一条正文最多留多少字：这是「看个大概」的面，完整转录不归这里。 */
const ENTRY_CLIP = 1200

/** 顶部左栏（标题与读数）与右栏（按钮）的排法。 */
const HEAD_STYLE = { display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginTop: 4 } as const

/** 三颗按钮一行，放不下就折行。 */
const ACTIONS_STYLE = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const

/** 时间线一行的布局：正文在上、时刻靠右，长正文允许折行。 */
const ENTRY_ROW_STYLE = { alignItems: 'flex-start' } as const

/** 正文与摘要的空白策略：原文里的换行要留住。 */
const PRE_WRAP_STYLE = { whiteSpace: 'pre-wrap' } as const

/** 任意文本截断，超长补一个省略号（不写中文，省得再进字典）。 */
function clip(text: string): string {
  return text.length <= ENTRY_CLIP ? text : `${text.slice(0, ENTRY_CLIP)}…`
}

/** 时间线上的一行（已经翻好、截好、排好）。 */
interface TimelineRow {
  key: string
  label: string
  body: string
  clock: string
}

/**
 * 把执行会话的条目收成时间线。
 *
 * 只画「它说了什么 / 做了什么 / 等到什么」这几类；`turn-end`、`turnDiff`、
 * `context-injection` 这类记账条目对读工单的人没有信息量，跳过。
 * @param entries - `superagentPeekSession` 的返回值
 * @returns 从上到下的一行行
 */
function timelineOf(entries: readonly TranscriptEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  const push = (entry: TranscriptEntry, label: string, body: string): void => {
    if (body.trim() === '') return
    rows.push({
      key: `${String(entry.id)}-${entry.kind}`,
      label,
      body: clip(body),
      clock: formatClock(entry.ts ?? null) ?? '',
    })
  }
  for (const entry of entries) {
    switch (entry.kind) {
      case 'user':
        push(entry, t('superagent.entry.user'), entry.text)
        break
      case 'thinking':
        push(entry, t('superagent.entry.thinking'), entry.text)
        break
      case 'text':
        push(entry, t('superagent.entry.text'), entry.text)
        break
      case 'tool': {
        const result = entry.call.resultText ?? entry.call.argsText
        push(entry, t('superagent.entry.tool'), `${entry.call.name}\n${result}`)
        break
      }
      case 'plan':
        push(entry, t('superagent.entry.plan'), `${entry.plan.title}\n${entry.plan.text}`)
        break
      case 'system':
        push(entry, t('superagent.entry.system'), entry.text)
        break
      case 'subagent':
        push(entry, t('superagent.entry.subagent'), `${entry.sub.name} · ${entry.sub.role}\n${entry.sub.task}`)
        break
      default:
        // 其余是记账条目（轮尾、重试、上下文注入…），读工单的人不需要。
        break
    }
  }
  return rows
}

/** 详情页。
 * @param surface - 当前面板视图
 * @param id - 选中的工单 id（模块级信号给的）
 */
export function DetailPage({ surface, id }: { surface: SuperagentView; id: string }): ReactNode {
  const channel = useHostChannel()
  const ticket = surface.tickets.find((item) => item.id === id) ?? null
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [peekError, setPeekError] = useState('')
  const [busy, setBusy] = useState<'stop' | 'retry' | 'clean' | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  /** 请求编号：连着点两次刷新时，只认最后一次的响应。 */
  const requestRef = useRef(0)

  const load = useCallback((silent = false): void => {
    const token = requestRef.current + 1
    requestRef.current = token
    // 静默刷新（自动轮询）不动 loading 与错误：转圈闪一下、或一次网络抖动把整块时间线
    // 换成红字，都是打扰。手动点刷新时才报。
    if (!silent) {
      setLoading(true)
      setPeekError('')
    }
    void channel
      .invoke<TranscriptEntry[]>('superagentPeekSession', [{ id }])
      .then((list) => {
        if (requestRef.current !== token) return
        setEntries(Array.isArray(list) ? list : [])
      })
      .catch((error: unknown) => {
        if (requestRef.current !== token || silent) return
        setEntries([])
        setPeekError(humanErrorText(error).text)
      })
      .finally(() => {
        if (requestRef.current === token && !silent) setLoading(false)
      })
  }, [channel, id])

  // 换一张工单就重读；组件卸载后迟到的响应由上面的编号挡掉。
  useEffect(() => {
    if (ticket === null) return
    setEntries(null)
    setNote(null)
    load()
    // 只认工单 id：ticket 是每次渲染重新找出来的对象。
  }, [ticket === null, load])

  /**
   * 工单还在跑时自动重读时间线。
   *
   * 为什么只轮询 `working` / `idle`：已结束的工单转录不会再变，`person` 那几档在等人
   * （worker 停着），轮询只会白读盘。5 秒是「人眼觉得跟得上」与「读盘次数」之间的折中：
   * 详情页一次读的是执行会话的 jsonl，工单跑久了这个文件会很大。
   */
  const live = ticket !== null && (ticket.stage.stage === 'working' || ticket.stage.stage === 'idle')
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => {
      load(true)
    }, 5000)
    return () => {
      clearInterval(timer)
    }
  }, [live, load])

  /** 停 / 重试 / 清理共用的执行壳：忙态、成功回执、失败原因都在这里收口。 */
  const act = (kind: 'stop' | 'retry' | 'clean', run: () => Promise<unknown>, okText: string): void => {
    if (busy !== null) return
    setBusy(kind)
    setNote(null)
    void run()
      .then(() => {
        setBusy(null)
        setNote({ tone: 'ok', text: okText })
        load()
      })
      .catch((error: unknown) => {
        setBusy(null)
        setNote({ tone: 'error', text: t('superagent.detail.actionFailed', { message: humanErrorText(error).text }) })
      })
  }

  const clean = (): void => {
    void confirmAction({
      title: t('superagent.detail.clean.title'),
      detail: t('superagent.detail.clean.detail'),
      confirmLabel: t('superagent.detail.clean.confirm'),
      danger: true,
    }).then((ok) => {
      if (!ok) return
      act('clean', () => channel.invoke('superagentCleanWorktree', [{ id }]), t('superagent.detail.clean.ok'))
    })
  }

  if (ticket === null) {
    return (
      <div className="plugin-detail">
        <div className="plugin-detail-top">
          <button type="button" className="plugin-back" onClick={closeTicket}>
            <IconChevronRight size={14} />
            {t('superagent.detail.back')}
          </button>
        </div>
        <div className="settings-empty">{t('superagent.detail.missing')}</div>
      </div>
    )
  }

  const ended = ticket.stage.stage === 'ended'
  const running = ticket.stage.stage === 'working'
  const clock = formatAt(ticket.at)
  const rows = timelineOf(entries ?? [])

  return (
    <div className="plugin-detail">
      <div className="plugin-detail-top">
        <button type="button" className="plugin-back" onClick={closeTicket}>
          <IconChevronRight size={14} />
          {t('superagent.detail.back')}
        </button>
      </div>

      <div style={HEAD_STYLE}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div className="plugin-name">{ticket.title === '' ? ticket.id : ticket.title}</div>
          <div className="plugin-detail-meta">
            <span>
              {t('superagent.detail.id')}: <span className="mono">{ticket.id}</span>
            </span>
            <span className="plugin-detail-src">
              {t('superagent.detail.stage')}: {stageLabelOf(ticket.stage)}
            </span>
          </div>
          <div className="plugin-detail-meta">
            {clock === '' ? null : (
              <span>
                {t('superagent.detail.at')}: <span className="mono">{clock}</span>
              </span>
            )}
            {ticket.branch === undefined ? null : (
              <span className="mono">
                {t('superagent.detail.branch')}: {ticket.branch}
              </span>
            )}
          </div>
        </div>
        <div style={ACTIONS_STYLE}>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null || ended}
            onClick={() => {
              act('stop', () => channel.invoke('superagentStopTicket', [{ id }]), t('superagent.detail.stop.ok'))
            }}
          >
            {t('superagent.detail.stop')}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null || running}
            onClick={() => {
              act('retry', () => channel.invoke('superagentRetryTicket', [{ id }]), t('superagent.detail.retry.ok'))
            }}
          >
            {t('superagent.detail.retry')}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null || !ended}
            title={ended ? undefined : t('superagent.detail.clean.hint')}
            onClick={clean}
          >
            {t('superagent.detail.clean')}
          </button>
        </div>
      </div>

      {note === null ? null : (
        <div className={`settings-note${note.tone === 'error' ? ' error' : ''}`}>{note.text}</div>
      )}

      {ticket.summary === undefined ? null : (
        <div className="plugin-detail-config">
          <div className="settings-group-title">{t('superagent.detail.summary')}</div>
          <div className="setting-help" style={PRE_WRAP_STYLE}>
            {ticket.summary}
          </div>
        </div>
      )}

      <div className="plugin-detail-config">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="settings-group-title">{t('superagent.detail.timeline')}</div>
          <button
            type="button"
            className="icon-btn"
            title={t('superagent.detail.timeline.refresh')}
            aria-label={t('superagent.detail.timeline.refresh')}
            disabled={loading}
            onClick={() => { load() }}
          >
            <IconRefresh size={16} />
          </button>
        </div>

        {loading ? (
          <div className="settings-loading" role="status">
            {t('superagent.detail.timeline.loading')}
          </div>
        ) : peekError !== '' ? (
          <div className="settings-note error">
            {t('superagent.detail.timeline.failed', { message: peekError })}
          </div>
        ) : rows.length === 0 ? (
          <div className="settings-empty">{t('superagent.detail.timeline.empty')}</div>
        ) : (
          <div className="settings-fields">
            {rows.map((row) => (
              <div className="setting-row" style={ENTRY_ROW_STYLE} key={row.key}>
                <div className="setting-text">
                  <div className="setting-label">{row.label}</div>
                  <div className="setting-help" style={PRE_WRAP_STYLE}>
                    {row.body}
                  </div>
                </div>
                <div className="setting-control">
                  <span className="mono">{row.clock}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
