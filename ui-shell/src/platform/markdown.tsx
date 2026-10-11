/**
 * markdown 视图：react-markdown（会话流同款）+ remark-gfm + 代码块走 shiki
 * + 相对路径图片经宿主 fs-read 转 base64。
 *
 * 从旧渲染层 `file-preview.tsx` 的 MarkdownView / MdImage / CodeBlock 移植。
 * 与旧版的一点差异：fs-read 的通道不归平台层管——调用方传 `fsRead(file)` 取回包
 * （预览插件传 dock 通道那份），不传时相对路径图片一律显示占位。
 *
 * @module dsc-ui-shell/platform/markdown
 */
import { useEffect, useState, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightToHtml } from './highlight'

/** 宿主 fs-read 回包里 markdown 图片消费的那几个字段（形状对就行，不引契约）。 */
interface FsReadLike {
  kind?: string
  mime?: string
  base64?: string
  tooLarge?: boolean
}

/** markdown 里相对路径图片的解析口：给一个能调 `fs-read` 的函数即可。 */
export type FsRead = (file: string) => Promise<unknown>

/** Windows 风格的子路径拼接（fs-read 吃反斜杠绝对路径）。 */
function joinPath(parent: string, name: string): string {
  return /[\\/]$/.test(parent) ? parent + name : `${parent}\\${name}`
}

/** 相对路径图片的 base64 缓存（进程内一份；key = 绝对路径）。 */
const mdImageCache = new Map<string, string>()

/** markdown 里的一张图：http(s)/data 直接给 src；相对路径经 fs-read 转 data URL。 */
function MdImage(props: { src: string; alt: string; base: string; fsRead?: FsRead }): JSX.Element {
  const { src, alt, base, fsRead } = props
  const external = /^(https?:|data:|blob:)/i.test(src)
  const abs = external ? src : joinPath(base, decodeURIComponent(src))
  const cached = external ? undefined : mdImageCache.get(abs)
  const [resolved, setResolved] = useState<string | undefined>(external ? src : cached)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (external || resolved !== undefined || fsRead === undefined) return
    let on = true
    void fsRead(abs)
      .then((data) => {
        const read = data as FsReadLike
        if (!on) return
        if (read.kind === 'image' && read.tooLarge !== true && read.base64 !== undefined) {
          const url = `data:${read.mime};base64,${read.base64}`
          mdImageCache.set(abs, url)
          setResolved(url)
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (on) setFailed(true)
      })
    return () => {
      on = false
    }
  }, [external, abs, fsRead, resolved])
  if (failed || (!external && resolved === undefined)) {
    return <span className="file-md-img-missing">[图片：{alt || src}]</span>
  }
  return <img src={resolved} alt={alt} loading="lazy" />
}

/** markdown 视图：会话流同款 ReactMarkdown，代码块交给 shiki。 */
export function MarkdownView({
  text,
  path,
  fsRead,
}: {
  text: string
  path: string
  /** 相对路径图片的解析口；缺省时相对路径图片显示占位。 */
  fsRead?: FsRead
}): JSX.Element {
  const base = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  return (
    <div className="file-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            const source = typeof src === 'string' ? src : ''
            return source === '' ? (
              <span className="file-md-img-missing">[图片]</span>
            ) : (
              <MdImage src={source} alt={alt ?? ''} base={base} fsRead={fsRead} />
            )
          },
          code: ({ className, children }) => {
            const match = /language-([\w-]+)/.exec(className ?? '')
            const raw = String(children ?? '').replace(/\n$/, '')
            if (match === null) return <code className={className}>{children}</code>
            return <CodeBlock code={raw} lang={match[1]!} />
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** markdown 代码块的 shiki 高亮（语法 id 直接来自围栏标注）。 */
function CodeBlock({ code, lang }: { code: string; lang: string }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let on = true
    highlightToHtml(code, lang)
      .then((value) => {
        if (on) setHtml(value)
      })
      .catch(() => {})
    return () => {
      on = false
    }
  }, [code, lang])
  if (html === null) {
    return (
      <pre className="file-code-plain">
        <code>{code}</code>
      </pre>
    )
  }
  return <div className="file-code-body" dangerouslySetInnerHTML={{ __html: html }} />
}
