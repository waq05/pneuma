/**
 * 发布页：标题（必填）+ 正文（多行）+ 起点分支（可选），提交走 `superagentPublish`。
 *
 * 成功后做两件事：切到「工单」页，并把新工单 id 放进模块级高亮信号——列表里那一行
 * 会亮一下（`./tickets.tsx` 读这个信号，几秒后自己清掉），用户不用在几十条里找。
 *
 * 失败不吞：一行红字说清哪一步挂了（`humanErrorText` 把工程错误翻成人话）。
 * 下面列 `surface.recent` 的最近 5 条（宿主给的最旧在前，这里倒过来、只取尾部 5 条）。
 *
 * @module dsc-ui-shell/superagent/publish
 */
import { useState, type ReactNode } from 'react'
import { createT, humanErrorText, useHostChannel } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'
import { formatAt, setHighlightedTicket, setSuperagentTab, type SuperagentView } from './state'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 「最近动态」最多露几条（设计文档 §8.1 的口径）。 */
const RECENT_LIMIT = 5

/** 正文块的外框：`.setting-input` 有最小宽度，塞进 flex 列里要显式放开。 */
const BODY_BLOCK_STYLE = { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } as const

/** 提交行：按钮在左、回执在右。 */
const ACTIONS_STYLE = { display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' } as const

/** 发布页。
 * @param surface - 当前面板视图（已确保 `ready`）
 */
export function PublishPage({ surface }: { surface: SuperagentView }): ReactNode {
  const channel = useHostChannel()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const submit = (): void => {
    // 回车与按钮走同一个函数：忙态时直接挡掉，别连发两张工单。
    if (busy) return
    const trimmed = title.trim()
    if (trimmed === '') {
      setNote({ tone: 'error', text: t('superagent.publish.err.titleRequired') })
      return
    }
    setBusy(true)
    setNote(null)
    const input = {
      title: trimmed,
      body: body.trim(),
      ...(base.trim() === '' ? {} : { base: base.trim() }),
    }
    void channel
      .invoke<string>('superagentPublish', [input])
      .then((id) => {
        setBusy(false)
        setTitle('')
        setBody('')
        setBase('')
        if (typeof id === 'string' && id !== '') setHighlightedTicket(id)
        // 发完就看工单：成功与否的下一步都在那一页。
        setSuperagentTab('tickets')
      })
      .catch((error: unknown) => {
        setBusy(false)
        setNote({ tone: 'error', text: t('superagent.publish.err.failed', { message: humanErrorText(error).text }) })
      })
  }

  // 宿主给的是最旧在前；界面要「最近」在前，所以取尾部 5 条再倒过来。
  const recent = surface.recent.slice(-RECENT_LIMIT).reverse()

  return (
    <div>
      <div className="settings-fields">
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">{t('superagent.publish.title.label')}</div>
          </div>
          <div className="setting-control">
            <input
              className="setting-input"
              type="text"
              aria-label={t('superagent.publish.title.label')}
              placeholder={t('superagent.publish.title.placeholder')}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
            />
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">{t('superagent.publish.base.label')}</div>
            <div className="setting-help">{t('superagent.publish.base.help')}</div>
          </div>
          <div className="setting-control">
            <input
              className="setting-input"
              type="text"
              aria-label={t('superagent.publish.base.label')}
              placeholder={t('superagent.publish.base.placeholder')}
              value={base}
              onChange={(event) => {
                setBase(event.target.value)
              }}
            />
          </div>
        </div>
      </div>

      <div style={BODY_BLOCK_STYLE}>
        <span className="setting-label">{t('superagent.publish.body.label')}</span>
        <textarea
          className="setting-input tall"
          style={{ minWidth: 0 }}
          aria-label={t('superagent.publish.body.label')}
          placeholder={t('superagent.publish.body.placeholder')}
          value={body}
          onChange={(event) => {
            setBody(event.target.value)
          }}
        />
        <span className="setting-help">{t('superagent.publish.body.help')}</span>
      </div>

      <div style={ACTIONS_STYLE}>
        <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
          {busy ? t('superagent.publish.submitting') : t('superagent.publish.submit')}
        </button>
      </div>
      {note === null ? null : (
        <div className={`settings-note${note.tone === 'error' ? ' error' : ''}`}>{note.text}</div>
      )}

      <div className="plugin-detail-config">
        <div className="settings-group-title">{t('superagent.publish.recent')}</div>
        {recent.length === 0 ? (
          <div className="settings-empty">{t('superagent.publish.recentEmpty')}</div>
        ) : (
          recent.map((item, index) => (
            <div className="setting-row" key={`${item.at}-${String(index)}`}>
              <div className="setting-text">
                <div className="setting-label">{item.text}</div>
              </div>
              <div className="setting-control">
                <span className="mono">{formatAt(item.at)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
