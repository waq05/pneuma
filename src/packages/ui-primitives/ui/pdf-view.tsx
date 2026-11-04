/**
 * PDF 视图：pdfjs 逐页渲染成 canvas 截图（≤50 页，纵向滚动的页图列表）。
 *
 * 从旧渲染层 `file-preview.tsx` 的 PdfView 移植。worker 走 `?url` 资产
 * （同源地址，CSP 的 script-src 'self' 兜得住 worker）。
 *
 * @module dsc-ui-shell/platform/pdf-view
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { createT } from '@dsc/ui-core'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui-core` 的 `createT`）。 */
const t = createT({ zh, en })

/** PDF 最多渲染的页数（pdfjs 逐页渲染，页数多时提示截断）。 */
const PDF_MAX_PAGES = 50

/** pdf 视图：吃 fs-read 给的 base64，逐页渲染成 `<img>`。 */
export function PdfView({ base64 }: { base64: string }): JSX.Element {
  const [pages, setPages] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [failed, setFailed] = useState('')
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let on = true
    void (async () => {
      const [{ getDocument, GlobalWorkerOptions }, workerUrlModule] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ])
      GlobalWorkerOptions.workerSrc = workerUrlModule.default
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const doc = await getDocument({ data: bytes }).promise
      if (!on) return
      setTotal(doc.numPages)
      const count = Math.min(doc.numPages, PDF_MAX_PAGES)
      for (let index = 1; index <= count; index += 1) {
        const page = await doc.getPage(index)
        const viewport = page.getViewport({ scale: 1.5 })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')!
        await page.render({ canvas, canvasContext: context, viewport }).promise
        if (!on) return
        const url = canvas.toDataURL('image/png')
        setPages((current) => [...current, url])
      }
    })().catch((error: unknown) => {
      if (on) setFailed(error instanceof Error ? error.message : String(error))
    })
    return () => {
      on = false
    }
  }, [base64])
  if (failed !== '') return <div className="file-preview-empty">{t('primitives.pdf.failed', { message: failed })}</div>
  return (
    <div className="file-pdf">
      {pages.length === 0 && <div className="file-preview-empty">{t('primitives.pdf.rendering')}</div>}
      {pages.map((url, index) => (
        <img key={index} className="file-pdf-page" src={url} alt={t('primitives.pdf.pageAlt', { n: index + 1 })} />
      ))}
      {total > PDF_MAX_PAGES && (
        <div className="tree-note" data-tree-note="truncated">{t('primitives.pdf.truncated', { total, shown: PDF_MAX_PAGES })}</div>
      )}
    </div>
  )
}
