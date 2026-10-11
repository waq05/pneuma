/**
 * 内置插件：文件预览（文件面板右半边）。
 *
 * 它往**别人开的**子槽里放东西：`files.preview` 是 `files` 插件在它的面板里开的子槽，
 * 渲染位置由那一侧决定（`renderSlot('files.preview', { path, cwd })`）。两个插件因此
 * 不必知道对方是谁、也不必排加载顺序——本插件用 `injectSlot` 等那个声明出现
 * （与示例插件 `echo` 等 `hello` 是同一套机制）。
 *
 * 数据源是 dock 通道的读类 op `fs-read`（在界面通道放行面里，读类直接放行）。
 * 分流照旧界面的口径（`desktop/src/renderer/file-util.ts` 的 `previewKindFor`）：
 *   - markdown（md/mdx/markdown）→ `MarkdownView`（react-markdown + 代码块 shiki
 *     + 相对路径图片走 fs-read 转 base64）；
 *   - PDF（kind:'bytes' + application/pdf）→ `PdfView`（pdfjs 逐页渲染）；
 *   - 代码/文本 → `CodeView`（shiki 按扩展名高亮，装不上语法回落纯文本）；
 *   - 图片 → `<img>`；二进制 / 超限 → 占位；xlsx（bytes 其余 mime）→ 占位 +
 *     用系统程序打开。
 *
 * markdown / shiki / pdf 三件来自 `@dsc/ui` 的壳内置平台层（重依赖只有壳 vendor
 * 里那一份，插件 bundle 不自带）。与旧界面剩余的差距：**csv/xlsx 表格视图没搬**
 * （csv 落到代码视图按纯文本看；xlsx 仍走「用系统程序打开」）。
 *
 * @module dsc-ui-shell/plugins/preview
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  CodeView,
  MarkdownView,
  PdfView,
  defineUiPlugin,
  getHostNative,
  useHostChannel,
  type SlotComponentProps,
} from '@dsc/ui'

/** `fs-read` 回来的形状（宿主 `desktop-dock` 插件的契约）。 */
interface ReadResult {
  path: string
  kind: 'text' | 'image' | 'bytes' | 'binary'
  mime?: string
  base64?: string
  text?: string
  size?: number
  tooLarge: boolean
}

/** 预览块的 owner props（`files` 面板给的那两个）。 */
interface PreviewProps {
  path?: string
  cwd?: string
}

export default defineUiPlugin({
  name: '文件预览',
  apply(ui) {
    // 等 `files.preview` 这个子槽被声明（声明方是 files 插件，加载顺序不保证）。
    ui.slots.injectSlot('files.preview', () =>
      ui.slots.register('files.preview', { id: 'preview.pane', order: 1 }, PreviewPane),
    )
  },
})

function PreviewPane({ path = '', cwd = '' }: SlotComponentProps<PreviewProps>): ReactNode {
  const channel = useHostChannel()
  const native = getHostNative()
  const [read, setRead] = useState<ReadResult | null>(null)
  const [note, setNote] = useState('')

  // 换文件就重新读；旧的那一份先清掉，免得一闪而过的是上一个文件的内容。
  useEffect(() => {
    setRead(null)
    setNote('')
    if (path === '') return undefined
    let alive = true
    void channel
      .invoke<ReadResult>('dock', ['fs-read', { file: path }])
      .then((result) => {
        if (alive) setRead(result)
      })
      .catch((error: unknown) => {
        if (alive) setNote(`读文件失败：${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      alive = false
    }
  }, [path, channel])

  /** markdown 里相对路径图片的解析口：把 dock 的 fs-read 交给平台层。 */
  const fsRead = (file: string): Promise<unknown> => channel.invoke('dock', ['fs-read', { file }])

  /** 用系统程序打开（原生桥；浏览器里没有桥，按钮禁用并说明原因）。 */
  const openWithSystem = (): void => {
    void native.invoke('openPath', [read?.path ?? path]).catch((error: unknown) => {
      setNote(`打不开：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  return (
    <>
      <div className="file-preview-head">
        <span className="file-preview-path" title={read?.path ?? path}>
          {shortPath(read?.path ?? path, cwd)}
        </span>
        <button
          type="button"
          className="btn-ghost"
          disabled={!native.available}
          title={native.available ? '用系统默认程序打开这个文件' : '这条能力来自桌面外壳的原生桥，浏览器里没有它'}
          onClick={openWithSystem}
        >
          用系统程序打开
        </button>
      </div>
      <div className="file-preview-body">
        {note === '' ? null : <div className="tree-note">{note}</div>}
        {read === null ? null : renderBody(read, fsRead)}
      </div>
    </>
  )
}

/** 按宿主给的 kind 分流（口径与旧界面 `previewKindFor` 一致）。 */
function renderBody(read: ReadResult, fsRead: (file: string) => Promise<unknown>): ReactNode {
  if (read.tooLarge) {
    return (
      <div className="file-preview-empty">
        这个文件太大（{formatSize(read.size ?? 0)}），这里不预览——用「用系统程序打开」看它。
      </div>
    )
  }
  if (read.kind === 'image') {
    return (
      <div className="file-preview-img">
        <img src={`data:${read.mime ?? 'image/png'};base64,${read.base64 ?? ''}`} alt={read.path} />
      </div>
    )
  }
  if (read.kind === 'binary') {
    return <div className="file-preview-empty">二进制文件（{formatSize(read.size ?? 0)}），这里不预览。</div>
  }
  if (read.kind === 'bytes') {
    // bytes 只有两种宿主会给：application/pdf 走逐页渲染，其余（xlsx 等）给占位。
    if (read.mime === 'application/pdf' && read.base64 !== undefined) {
      return <PdfView base64={read.base64} />
    }
    return (
      <div className="file-preview-empty">
        这类文件（{read.mime ?? '未知类型'}，{formatSize(read.size ?? 0)}）要看内容请用「用系统程序打开」。
      </div>
    )
  }
  if (isMarkdown(read.path)) {
    return <MarkdownView text={read.text ?? ''} path={read.path} fsRead={fsRead} />
  }
  return <CodeView text={read.text ?? ''} path={read.path} />
}

/** markdown 分流：md / mdx / markdown 三个扩展名（旧界面 previewKindFor 同款）。 */
function isMarkdown(path: string): boolean {
  const name = path.toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  return ext === 'md' || ext === 'mdx' || ext === 'markdown'
}

/** 展示用的短路径：工作目录内给相对路径，其余原样（与旧界面 `displayPathOf` 的口径一致）。 */
function shortPath(path: string, cwd: string): string {
  if (path === '' || cwd === '') return path
  const posix = path.replace(/\\/g, '/')
  const base = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  return posix.toLowerCase().startsWith(base.toLowerCase()) ? posix.slice(base.length) : posix
}

/** 文件大小的人类读法（与文件树那份同口径）。 */
function formatSize(size: number): string {
  if (size < 1024) return `${String(size)}B`
  if (size < 1024 * 1024) return `${String(Math.max(1, Math.round(size / 1024)))}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}
