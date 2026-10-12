/**
 * 内置插件：文件预览（停靠区里独占一整块的面板）。
 *
 * 形态对齐旧界面：预览是 dock 的一个**页签**——点文件（文件树里、或以后会话流里）
 * 开这个页签并整块显示（`dockOpenPreview` 的同款行为），不是挤在文件树下面的一半。
 * 交接走壳的停靠区状态：`setDockPreview` 放目标、`useDockPreview` 取目标
 * （两块面板是两个插件，不必认识对方）。
 *
 * 数据源是 dock 通道的读类 op `fs-read`（在界面通道放行面里，读类直接放行）。
 * 分流照旧界面的口径（`desktop/src/renderer/file-util.ts` 的 `previewKindFor`）：
 *   - markdown（md/mdx/markdown）→ `MarkdownView`（react-markdown + 代码块 shiki
 *     + 相对路径图片走 fs-read 转 base64）；
 *   - PDF（kind:'bytes' + application/pdf）→ `PdfView`（pdfjs 逐页渲染）；
 *   - xlsx/xlsm（kind:'bytes' 其余 mime）→ `XlsxView`（SheetJS，多 sheet 页签）；
 *   - csv/tsv → `CsvView`（papaparse，首行当表头，500 行 × 100 列截断）；
 *   - 代码/文本 → `CodeView`（shiki 按扩展名高亮，装不上语法回落纯文本）；
 *   - 图片 → `<img>`；二进制 / 超限 → 占位。
 *
 * markdown / shiki / pdf / 表格四件来自 `@dsc/ui` 的壳内置平台层（重依赖只有壳
 * vendor 里那一份，插件 bundle 不自带）。
 *
 * @module dsc-ui-shell/plugins/preview
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  CodeView,
  CsvView,
  FileIcon,
  IconCode,
  MarkdownView,
  PdfView,
  XlsxView,
  defineUiPlugin,
  getHostNative,
  registerDockPanel,
  useDockPanel,
  useDockPreview,
  useHostChannel,
} from '@dsc/ui'

/** 这一块面板在停靠区里的 id。 */
const PANEL = 'preview'

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

export default defineUiPlugin({
  name: '文件预览',
  apply(ui) {
    // 头条页签与开合钮由壳统一画（旧界面同构）——这里只报名面板、注册本体。
    // 页签图标：旧界面预览 chip 用的是「文件自己的彩色图标」（每张页签一个文件）；
    // 壳里预览是一块固定面板，取同一族里的通用文档符号。
    registerDockPanel({ id: PANEL, label: '预览', order: 40, icon: <IconCode size={13} /> })
    ui.slots.register('shell.dock', { id: 'preview.pane', order: 40 }, PreviewDock)
  },
})

/** 预览面板：整块显示「现在要看的那个文件」。没点过文件时给一句引导。 */
function PreviewDock(): ReactNode {
  const active = useDockPanel() === PANEL
  const target = useDockPreview()
  return (
    <aside className="dock" style={{ width: '100%' }} data-hidden={active ? undefined : '1'}>
      <div className="dock-body">
        {target === null ? (
          <div className="file-preview-empty">在「文件」页签里点一个文件，这里整块显示它</div>
        ) : (
          <PreviewBody path={target.path} cwd={target.cwd} />
        )}
      </div>
    </aside>
  )
}

/** 预览本体：头部（相对路径 + 用系统程序打开）+ 内容。换文件整块重读。 */
function PreviewBody({ path, cwd }: { path: string; cwd: string }): ReactNode {
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
        {/* 头部 = 彩色文件图标 + 相对路径（旧界面同款）。 */}
        <span className="file-preview-path" title={read?.path ?? path}>
          <FileIcon name={read?.path ?? path} size={14} />
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
        {read === null ? (
          note === '' ? (
            <div className="file-preview-empty">读取中…</div>
          ) : null
        ) : (
          renderBody(read, fsRead)
        )}
      </div>
    </>
  )
}

/** 按宿主给的 kind 分流（口径与旧界面 `previewKindFor` 一致）。 */
function renderBody(read: ReadResult, fsRead: (file: string) => Promise<unknown>): ReactNode {
  if (read.tooLarge) {
    return (
      <div className="file-preview-empty">
        文件过大（{formatSize(read.size ?? 0)}），仅支持预览 10MB 以内的文件。
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
    return <div className="file-preview-empty">二进制文件（{formatSize(read.size ?? 0)}），暂不支持预览。</div>
  }
  if (read.kind === 'bytes') {
    // bytes 只有两种宿主会给：application/pdf 走逐页渲染，其余（xlsx/xlsm）走
    // SheetJS 表格视图——与旧界面 previewKindFor 的口径一致。
    if (read.mime === 'application/pdf' && read.base64 !== undefined) {
      return <PdfView base64={read.base64} />
    }
    if (read.base64 !== undefined) return <XlsxView base64={read.base64} />
    return (
      <div className="file-preview-empty">
        这类文件（{read.mime ?? '未知类型'}，{formatSize(read.size ?? 0)}）要看内容请用「用系统程序打开」。
      </div>
    )
  }
  if (isMarkdown(read.path)) {
    return <MarkdownView text={read.text ?? ''} path={read.path} fsRead={fsRead} />
  }
  // csv/tsv 走表格视图（papaparse）；其余文本落到代码视图。
  if (isDelimited(read.path)) {
    return <CsvView text={read.text ?? ''} path={read.path} />
  }
  return <CodeView text={read.text ?? ''} path={read.path} />
}

/** csv/tsv 分流（旧界面 previewKindFor 同款）。 */
function isDelimited(path: string): boolean {
  const name = path.toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  return ext === 'csv' || ext === 'tsv'
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
