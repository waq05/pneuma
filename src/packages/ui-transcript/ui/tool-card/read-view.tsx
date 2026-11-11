/**
 * `read` 工具卡的渲染体：头行一枚行号区间、展开体一份内容预览（行号一列 + 原文一列）。
 *
 * 两块分工：
 *  - {@link ReadRange} 挂在头行，只说「哪一段」（`第 40–79 行` / `第 40 行起`）。头行的文件路径
 *    本来就是可点的（`factory.tsx` 的 `IntendedPreview` → `OpenPathButton`），这里只补区间；
 *  - {@link ReadBody} 挂在展开体，把结果正文按行摊开。**限高内滚**：一次读 2000 行铺进会话流
 *    会把上面几十条消息推到屏幕外，所以高度封在 `min(320px, 40vh)`、超出自己滚（`.tc-read-lines`）。
 *
 * 外观与终端块同一档（等宽 + 四级底 + 三级描边 + 块圆角，见 `views.css`），不另造视觉语言。
 *
 * 三种「没有正文」的情况分开画，不共用一句占位：
 *  - 解析出了结构、但文件是空的（宿主回 `路径\n1\t` 这种真实形状，见 `read-model.ts`）→
 *    头行说「（空文件）」、展开体也只说这一句；
 *  - 解析不出结构、但有结果原文 → 原样摊出来（工具报错时那就是原因，藏起来等于让人猜）；
 *  - 什么都没有、还在跑 → 一句「正在读取」（跑完仍没有结果就什么都不画）。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/read-view
 */
import type { ReactNode } from 'react'
import { createT, type ToolCallView } from '@dsc/ui'
import { readSpanOf, type ReadCall, type ReadPreview } from './read-model'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../../locale/ui.zh.json'
import en from '../../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 头行那枚区间读数。
 *
 * 三种说法，按「说得清多少」分：起点终点都知道 → `第 40–79 行`；只说得出起点 → `第 40 行起`；
 * 只有一行 → `第 40 行`。文件总行数只进悬停说明，不占头行的字——那一行还有动词、路径、状态。
 */
export function ReadRange({ call, preview }: { call: ReadCall; preview: ReadPreview | null }): ReactNode {
  const span = readSpanOf(call, preview)
  const text = span.empty
    ? t('transcript.tool.readEmpty')
    : span.to === null
      ? t('transcript.tool.readFrom', { from: span.from })
      : span.to === span.from
        ? t('transcript.tool.readLine', { line: span.from })
        : t('transcript.tool.readRange', { from: span.from, to: span.to })
  return (
    <span className="tc-range" title={span.total === null ? undefined : t('transcript.tool.readTotal', { total: span.total })}>
      {text}
    </span>
  )
}

/**
 * 展开体的内容预览。
 *
 * @param call 这条工具调用（只读状态与结果原文）
 * @param preview 结果解析（还没落地、或形状认不出时是 null；空文件时 `empty` 为真）
 */
export function ReadBody({ call, preview }: { call: ToolCallView; preview: ReadPreview | null }): ReactNode {
  if (preview !== null && preview.lines.length > 0) {
    return (
      <div className="tc-read">
        <div className="tc-read-lines">
          {preview.lines.map((line) => (
            <div className="tc-read-line" key={line.number}>
              <span className="tc-read-no" aria-hidden="true">
                {line.number}
              </span>
              <span className="tc-read-text">{line.text}</span>
            </div>
          ))}
        </div>
        {preview.notes.length > 0 ? <p className="tc-read-note">{preview.notes.join(' ')}</p> : null}
      </div>
    )
  }
  if (preview !== null && preview.empty) {
    return (
      <div className="tc-read" data-read-empty="1">
        <p className="tc-read-note">{t('transcript.tool.readEmpty')}</p>
        {preview.notes.length > 0 ? <p className="tc-read-note">{preview.notes.join(' ')}</p> : null}
      </div>
    )
  }
  const raw = typeof call.resultText === 'string' ? call.resultText.trim() : ''
  if (raw !== '') {
    return (
      <div className="tc-read">
        <pre className="tc-read-raw">{raw}</pre>
      </div>
    )
  }
  if (call.status === 'running') {
    return (
      <div className="tc-read">
        <p className="tc-read-note">{t('transcript.tool.readWaiting')}</p>
      </div>
    )
  }
  return null
}
