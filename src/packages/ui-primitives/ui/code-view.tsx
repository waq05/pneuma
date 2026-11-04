/**
 * 代码视图：装语法期间先画纯文本，就绪后原地换 shiki 高亮 HTML。
 *
 * 从旧渲染层 `file-preview.tsx` 的 CodeView 移植（截断 5000 行 / 失败静默留纯文本 /
 * 目标行定位），作为 `@dsc/ui` web 值面转出，文件预览插件直接用。
 *
 * @module dsc-ui-shell/platform/code-view
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { highlightToHtml, langForPath } from './highlight'

/** 预览代码块的截断线数（shiki 高亮大文本很贵，超限截断并提示）。 */
const CODE_MAX_LINES = 5000

/** 代码视图：`targetLine` 给出时（1 基）挂行号列并把目标行滚进视口。 */
export function CodeView({ text, path, targetLine }: { text: string; path: string; targetLine?: number }): JSX.Element {
  const lang = useMemo(() => langForPath(path), [path])
  const lines = useMemo(() => text.split('\n'), [text])
  const truncated = lines.length > CODE_MAX_LINES
  const shown = useMemo(() => (truncated ? lines.slice(0, CODE_MAX_LINES).join('\n') : text), [lines, text, truncated])
  const [html, setHtml] = useState<string | null>(null)
  // 高亮分支是 div、纯文本回落是 pre——ref 用回调统一收 HTMLElement
  const bodyRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    let on = true
    highlightToHtml(shown, lang)
      .then((value) => {
        if (on) setHtml(value)
      })
      .catch(() => {
        // 语法装不上就留在纯文本，不报错——预览不该比文件本身更脆
      })
    return () => {
      on = false
    }
  }, [shown, lang])
  // 行号跳转：渲染完把目标行滚到视口中间并挂高亮类；换目标先摘旧高亮。
  // 目标行超出截断范围就滚到截断条，不硬来。
  useEffect(() => {
    if (targetLine === undefined) return
    const body = bodyRef.current
    if (body === null) return
    body.querySelectorAll('.file-code-line-target').forEach((node) => node.classList.remove('file-code-line-target'))
    const rows = body.querySelectorAll('.line')
    const at = Math.min(Math.max(targetLine, 1), rows.length)
    const row = rows[at - 1]
    if (row !== undefined) {
      row.classList.add('file-code-line-target')
      row.scrollIntoView({ block: 'center' })
    }
  }, [html, targetLine, shown])
  const numbered = targetLine !== undefined
  return (
    <div className={numbered ? 'file-code file-code--numbered' : 'file-code'}>
      {truncated && <div className="tree-note" data-tree-note="truncated">文件较大，仅高亮前 {CODE_MAX_LINES} 行</div>}
      {html !== null ? (
        <div ref={(node) => { bodyRef.current = node }} className="file-code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre ref={(node) => { bodyRef.current = node }} className="file-code-plain">
          {shown.split('\n').map((row, index) => (
            <span key={index} className="line">{`${row}\n`}</span>
          ))}
        </pre>
      )}
    </div>
  )
}
