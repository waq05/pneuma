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
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  CodeView,
  createT,
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
} from '@dsc/ui'
import { formatBytes, readCwd } from '@dsc/ui-primitives'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

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
  name: t('preview.plugin.name'),
  apply() {
    // 报名一种页签界面（kind = 'preview'）：每张预览页签自带文件路径（tab.path）——
    // 「同文件去重、每格至多 10 张」这些规则在壳的布局模型里（旧桌面版同款）。
    // 不 keepMounted：切走不挂载、切回重读盘（旧桌面版同规则——省一份常驻监听）。
    const offPreview = registerDockTab({
      kind: 'preview',
      label: t('preview.tab.label'),
      icon: <IconCode size={13} />,
      component: PreviewTab,
      // chip 上要看到「这是哪个文件」：标题取页签自己那个路径的文件名（旧口径，别丢）。
      titleFromPath: true,
    })
    // 补丁页签（kind = 'patch'）：渲染某个文件某次 write / edit 的差异快照（unified hunks）。
    // 与 preview 是两条路——那份快照随工具结果来，不读盘；页签自带路径。
    const offPatch = registerDockTab({
      kind: 'patch',
      label: t('preview.tab.patch'),
      component: PatchTab,
      titleFromPath: true,
    })
    // 两种页签一起退：只退一个的话，停用预览插件后另一半还会留着（文件预览与补丁预览
    // 是同一份代码的两个视图，生命周期必须同进同出）。
    return () => {
      offPreview()
      offPatch()
    }
  },
})

/** 预览页签体：整块显示这张页签带的那个文件。 */
function PreviewTab({ tab }: DockTabBodyProps): ReactNode {
  const cwd = useHostSelector(readCwd)
  const path = tab.path ?? ''
  if (path === '') {
    return <div className="file-preview-empty">{t('preview.empty.noPath')}</div>
  }
  return <PreviewBody tabId={tab.id} path={path} cwd={cwd ?? ''} />
}

/** 预览本体：头部（相对路径 + 用系统程序打开）+ 内容。换文件整块重读。 */
function PreviewBody({ tabId, path, cwd }: { tabId: string; path: string; cwd: string }): ReactNode {
  const channel = useHostChannel()
  const native = getHostNative()
  const [read, setRead] = useState<ReadResult | null>(null)
  /** 这张页签挂着改动快照时，「改动」视图（unified diff）与「预览」视图（渲染后的文件）互切。 */
  const patchSource = useDockPatchSource(tabId)
  const [patchView, setPatchView] = useState(false)
  const [note, setNote] = useState('')

  // 换文件就重新读；旧的那一份先清掉，免得一闪而过的是上一个文件的内容。
  useEffect(() => {
    setRead(null)
    setPatchView(false)
    setNote('')
    if (path === '') return undefined
    let alive = true
    void channel
      .invoke<ReadResult>('dock', ['fs-read', { file: path }])
      .then((result) => {
        if (alive) setRead(result)
      })
      .catch((error: unknown) => {
        if (alive) setNote(t('preview.readFailed', { message: error instanceof Error ? error.message : String(error) }))
      })
    return () => {
      alive = false
    }
  }, [path, channel])

  /** markdown 里相对路径图片的解析口：把 dock 的 fs-read 交给平台层。 */
  const fsRead = (file: string): Promise<unknown> => channel.invoke('dock', ['fs-read', { file }])

  /**
   * 改动覆盖的新文件行区间（hunk 的 `newStart..newStart+newCount-1`，1 基闭区间）。
   * 渲染视图拿它给 markdown 的块标「改过」；纯删除的 hunk（newCount=0）退化成它落点那一行。
   */
  const changedRanges = useMemo<ReadonlyArray<readonly [number, number]>>(() => {
    if (patchSource === null) return []
    return patchSource.hunks.map((hunk) => [hunk.newStart, Math.max(hunk.newStart, hunk.newStart + hunk.newCount - 1)] as const)
  }, [patchSource])

  /** 用系统程序打开（原生桥；浏览器里没有桥，按钮禁用并说明原因）。 */
  const openWithSystem = (): void => {
    void native.invoke('openPath', [read?.path ?? path]).catch((error: unknown) => {
      setNote(t('preview.openFailed', { message: error instanceof Error ? error.message : String(error) }))
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
        {patchSource === null ? null : (
          <>
            <span className="changes-counts">
              {patchSource.status === 'added' && <span className="diff-badge">{t('preview.patch.added')}</span>}
              <span className="changes-added">{`+${String(patchSource.added)}`}</span>
              <span className="changes-removed">{`-${String(patchSource.removed)}`}</span>
            </span>
            <button
              type="button"
              className="btn-ghost"
              data-tip={patchView ? t('preview.patchView.toContentTip') : t('preview.patchView.toPatchTip')}
              onClick={() => {
                setPatchView((current) => !current)
              }}
            >
              {patchView ? t('preview.patchView.toContent') : t('preview.patchView.toPatch')}
            </button>
          </>
        )}
        <button
          type="button"
          className="btn-ghost"
          disabled={!native.available}
          title={native.available ? t('preview.systemTip.on') : t('preview.systemTip.off')}
          onClick={openWithSystem}
        >
          {t('preview.systemOpen')}
        </button>
      </div>
      <div className="file-preview-body">
        {note === '' ? null : <div className="tree-note">{note}</div>}
        {patchView && patchSource !== null ? (
          <>
            {patchSource.truncated === true && <p className="diff-note">{t('preview.patch.truncated')}</p>}
            <DiffRows hunks={patchSource.hunks} path={path} />
          </>
        ) : read === null ? (
          note === '' ? (
            <div className="file-preview-empty">{t('preview.reading')}</div>
          ) : null
        ) : (
          renderBody(read, fsRead, changedRanges)
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
  // 按**页签 id** 读：关掉这张补丁页签再开同文件是另一张页签，不会捡到上一刀的快照（P0-11）。
  const source = useDockPatchSource(tab.id)
  if (path === '') {
    return <div className="file-preview-empty">{t('preview.empty.noPatchPath')}</div>
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
      setNote(t('preview.openFailed', { message: error instanceof Error ? error.message : String(error) }))
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
            {source.status === 'added' && <span className="diff-badge">{t('preview.patch.added')}</span>}
            <span className="changes-added">{`+${String(source.added)}`}</span>
            <span className="changes-removed">{`-${String(source.removed)}`}</span>
          </span>
        )}
        <button
          type="button"
          className="btn-ghost"
          data-tip={t('preview.patch.openTip')}
          onClick={() => setDockPreview({ path })}
        >
          {t('preview.patch.open')}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!native.available}
          title={native.available ? t('preview.systemTip.on') : t('preview.systemTip.off')}
          onClick={openWithSystem}
        >
          {t('preview.systemOpen')}
        </button>
      </div>
      <div className="file-preview-body">
        {note === '' ? null : <div className="tree-note">{note}</div>}
        {source === null ? (
          <div className="file-preview-empty">{t('preview.patch.gone')}</div>
        ) : (
          <>
            {source.truncated === true && (
              <p className="diff-note">{t('preview.patch.truncated')}</p>
            )}
            <DiffRows hunks={source.hunks} path={path} />
          </>
        )}
      </div>
    </>
  )
}

/** 按宿主给的 kind 分流（口径与旧界面 `previewKindFor` 一致）。 */
function renderBody(
  read: ReadResult,
  fsRead: (file: string) => Promise<unknown>,
  /** 改动覆盖的新文件行区间：markdown 的块标色用；空数组 = 不标。 */
  changedRanges: ReadonlyArray<readonly [number, number]>,
): ReactNode {
  if (read.tooLarge) {
    return (
      <div className="file-preview-empty">{t('preview.tooLarge', { size: formatBytes(read.size ?? 0) })}</div>
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
    return <div className="file-preview-empty">{t('preview.binary', { size: formatBytes(read.size ?? 0) })}</div>
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
        {t('preview.unknownType', { mime: read.mime ?? t('preview.unknownMime'), size: formatBytes(read.size ?? 0) })}
      </div>
    )
  }
  if (isMarkdown(read.path)) {
    return <MarkdownView text={read.text ?? ''} path={read.path} fsRead={fsRead} changedRanges={changedRanges} />
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

