/**
 * 内置插件：文件预览（右侧栏里的预览页签）。
 *
 * 形态对齐旧界面：预览是 dock 的一个**页签**——点文件（文件树里、改动卡「打开」）
 * 开这个页签并整块显示（旧桌面版 `openPreview` 同款）：同一份文件按路径去重、
 * 每窗格至多 10 张，这些规则都在壳的布局模型里。页签自带路径（tab.path），
 * 这里不读任何「预览目标」状态。
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
  DiffRows,
  FileIcon,
  IconCode,
  MarkdownView,
  PdfView,
  XlsxView,
  defineUiPlugin,
  getHostNative,
  registerDockTab,
  setDockPreview,
  useDockPatchSource,
  useHostChannel,
  useHostSelector,
  type ChangedFileView,
  type DockTabBodyProps,
  type HostSnapshot,
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

export default defineUiPlugin({
  name: '文件预览',
  apply() {
    // 报名一种页签界面（kind = 'preview'）：每张预览页签自带文件路径（tab.path）——
    // 「同文件去重、每格至多 10 张」这些规则在壳的布局模型里（旧桌面版同款）。
    // 不 keepMounted：切走不挂载、切回重读盘（旧桌面版同规则——省一份常驻监听）。
    registerDockTab({ kind: 'preview', label: '预览', icon: <IconCode size={13} />, component: PreviewTab })
    // 补丁页签（kind = 'patch'）：渲染某个文件某次 write / edit 的差异快照（unified hunks）。
    // 与 preview 是两条路——那份快照随工具结果来，不读盘；页签自带路径。
    registerDockTab({ kind: 'patch', label: '补丁', component: PatchTab })
  },
})

/** 预览页签体：整块显示这张页签带的那个文件。 */
function PreviewTab({ tab }: DockTabBodyProps): ReactNode {
  const cwd = useHostSelector(readCwd)
  const path = tab.path ?? ''
  if (path === '') {
    return <div className="file-preview-empty">这张预览页签没有文件路径（关掉它，从文件树重新点一个）。</div>
  }
  return <PreviewBody path={path} cwd={cwd ?? ''} />
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

/** 补丁页签体：整块显示这张页签那个文件**某一次改动的差异快照**（不是文件当前内容）。 */
function PatchTab({ tab }: DockTabBodyProps): ReactNode {
  const cwd = useHostSelector(readCwd)
  const path = tab.path ?? ''
  // 补丁源只在内存（hunks 不落盘）：重启/换会话后这里会是 null，页签体给「已过期」的说明。
  const source = useDockPatchSource(path)
  if (path === '') {
    return <div className="file-preview-empty">这张补丁页签没有文件路径（关掉它，从工具卡重新点一个）。</div>
  }
  return <PatchBody path={path} cwd={cwd ?? ''} source={source} />
}

/**
 * 补丁本体：头部（相对路径 + 增删计数 + 「打开原文件」/「用系统程序打开」）+ unified diff。
 *
 * 差异正文复用审查面板那份 `DiffRows`（hunk 头 + 逐行加色，unified/split 走同一套），
 * 不引新依赖。「打开原文件」走 {@link setDockPreview} 的**无 patch** 形态，开的是预览页签
 * （文件当前内容）——与补丁视图是两个视图，正是参考实现里 diff 页签旁边的那个入口。
 */
function PatchBody({ path, cwd, source }: { path: string; cwd: string; source: ChangedFileView | null }): ReactNode {
  const native = getHostNative()
  const [note, setNote] = useState('')
  const openWithSystem = (): void => {
    void native.invoke('openPath', [path]).catch((error: unknown) => {
      setNote(`打不开：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return (
    <>
      <div className="file-preview-head">
        {/* 头部 = 彩色文件图标 + 相对路径 + 增删计数（改动卡同款计数样式）。 */}
        <span className="file-preview-path" title={path}>
          <FileIcon name={path} size={14} />
          {shortPath(path, cwd)}
        </span>
        {source === null ? null : (
          <span className="changes-counts">
            {source.status === 'added' && <span className="diff-badge">新增</span>}
            <span className="changes-added">{`+${String(source.added)}`}</span>
            <span className="changes-removed">{`-${String(source.removed)}`}</span>
          </span>
        )}
        <button
          type="button"
          className="btn-ghost"
          data-tip="打开该文件的当前内容（补丁看的是修改当时的快照）"
          onClick={() => setDockPreview({ path })}
        >
          打开原文件
        </button>
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
        {source === null ? (
          <div className="file-preview-empty">
            这份补丁已经不在了（应用重启或切回会话后差异快照不再保留）。点「打开原文件」看该文件的当前内容。
          </div>
        ) : (
          <>
            {source.truncated === true && (
              <p className="diff-note">改动较大，这里只显示了前一部分（完整改动以文件当前内容为准）。</p>
            )}
            <DiffRows hunks={source.hunks} path={path} />
          </>
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

/** 当前会话的工作目录（把绝对路径裁成短路径用；与侧栏底部同一字段）。 */
function readCwd(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['cwd']
  return typeof value === 'string' && value !== '' ? value : null
}
