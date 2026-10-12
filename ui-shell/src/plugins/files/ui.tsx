/**
 * 内置插件：工作区文件树 + git 变更（停靠区里的两块页签面板，头条由壳统一画）。
 *
 * 数据源是 dock 通道的**读类** op `fs-list`（阶段 5.2 起在界面通道放行面上，
 * 见 `src/core/dock-ops.ts` —— 读类直接放行，写类才要审批）。所以这一块在浏览器里
 * 也能用，与终端不同（终端要起进程，只走桌面窗口的原生桥）。「变更」面板走
 * `git-status` / `git-diff` 两个读类 op，见 changes.tsx。
 *
 * 点一个文件 → 交给**预览面板**整块显示（旧界面：dockOpenPreview 开 preview 页签；
 * 预览本体在 preview 插件，交接走壳的 `setDockPreview`）。
 *
 * ## 与旧界面对齐的部分
 *
 * class 名照旧界面的文件树写（`.files-pane` / `.files-bar` / `.files-cwd` /
 * `.files-list` / `.tree-item` / `.file-row` / `.file-icon` / `.file-name` /
 * `.tree-note`），所以样式一行都不用新写。懒加载 + 每级 18px 缩进（`.tree-level`）
 * 也是旧界面的口径。
 *
 * ## 已知的两处简化（写在 development-log 的诚实边界里）
 *
 * - **彩色文件图标集没搬**：旧界面那份是 `vscode-icons-js` + 一张 ~500KB 的生成映射
 *   （`file-icon-map.generated.ts`），依赖也在桌面包里。这里改用壳自己的图标集
 *   （目录各画开合两态，其余按扩展名分三四档）——同一套 1.6px 细线风格，
 *   代价是长尾扩展名不再各有专属图形。
 * - **不做虚拟滚动**：旧界面的树是一次列一层的懒加载，几千个文件的目录会全渲染。
 *   目录大了会卡，需要时再接虚拟列表。
 *
 * @module dsc-ui-shell/plugins/files
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconChevronDown, IconChevronRight, IconCode, IconFolder, IconFolderOpen } from '@dsc/ui'
import {
  defineUiPlugin,
  registerDockPanel,
  setDockPanel,
  setDockPreview,
  useDockPanel,
  useDockPreview,
  useHostChannel,
} from '@dsc/ui'
import { ChangesPanel } from './changes'

/** 文件树面板在停靠区里的 id（壳拿它决定同一时刻显示哪一块）。 */
const PANEL = 'files'
/** 变更面板的 id（同一插件的第二块面板：旧界面 dock 里它们也是两个页签）。 */
const CHANGES_PANEL = 'changes'

/** `fs-list` 回来的一个条目（宿主 `desktop-dock` 插件的形状）。 */
interface Entry {
  name: string
  dir: boolean
  size: number
}

/** `fs-list` 的回包。 */
interface Listing {
  cwd: string
  entries: Entry[]
  truncated: boolean
}

export default defineUiPlugin({
  name: '文件',
  apply(ui) {
    // 头条页签与开合钮由壳统一画（旧界面同构）——这里只报名两块面板、注册本体。
    registerDockPanel({ id: PANEL, label: '文件', order: 20 })
    registerDockPanel({ id: CHANGES_PANEL, label: '变更', order: 30 })
    ui.slots.register('shell.dock', { id: 'files.panel', order: 20 }, FilesPanel)
    ui.slots.register('shell.dock', { id: 'files.changes', order: 30 }, ChangesDock)
  },
})

/** 文件面板：工作区文件树。点一个文件交给预览面板显示（旧界面：开 preview 页签）。
 *
 * 保活对齐桌面端：面板永远渲染，被顶替或收起时 `data-hidden` 藏——已展开的目录、
 * 滚动位都活着（旧界面的 files-tree-store 在壳里的对等物）。 */
function FilesPanel(): ReactNode {
  const active = useDockPanel() === PANEL
  const preview = useDockPreview()
  const channel = useHostChannel()
  const [root, setRoot] = useState<Listing | null>(null)
  /** 已展开的目录 → 它的清单（懒加载：展开才取）。 */
  const [dirs, setDirs] = useState<Record<string, Entry[]>>({})
  const [open, setOpen] = useState<readonly string[]>([])
  const [note, setNote] = useState('')

  // 根清单只在面板第一次真正打开时取（收起时不发请求）。
  useEffect(() => {
    if (!active || root !== null) return
    let alive = true
    void channel
      .invoke<Listing>('dock', ['fs-list', { dir: '.' }])
      .then((listing) => {
        if (alive) setRoot(listing)
      })
      .catch((error: unknown) => {
        if (alive) setNote(`列目录失败：${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      alive = false
    }
  }, [active, root, channel])

  /** 展开 / 收起一个目录（展开时第一次取它的清单）。 */
  const toggleDir = (dir: string): void => {
    if (open.includes(dir)) {
      setOpen(open.filter((item) => item !== dir))
      return
    }
    setOpen([...open, dir])
    if (dirs[dir] !== undefined) return
    void channel
      .invoke<Listing>('dock', ['fs-list', { dir }])
      .then((listing) => {
        setDirs((current) => ({ ...current, [dir]: listing.entries }))
      })
      .catch((error: unknown) => {
        setNote(`列目录失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** 画一个目录下的条目（递归：展开了的目录继续往下画一层）。 */
  const rowsOf = (parent: string, entries: readonly Entry[], depth: number): ReactNode[] =>
    entries.flatMap((entry) => {
      const path = joinPath(parent, entry.name)
      const row = (
        <button
          type="button"
          className={`file-row${preview?.path === path ? ' on' : ''}`}
          key={path}
          style={{ paddingLeft: 8 + depth * 18 }}
          title={entry.dir ? path : `${path}（${formatSize(entry.size)}）`}
          onClick={() => {
            if (entry.dir) {
              toggleDir(path)
              return
            }
            // 点文件 → 切到预览面板整块显示它（旧界面：dockOpenPreview 开 preview 页签）。
            setDockPreview({ path, cwd: root?.cwd ?? '' })
            setDockPanel('preview')
          }}
        >
          <span className="file-icon">{entry.dir ? chevron(open.includes(path)) : <IconCode size={14} />}</span>
          {/* 文件夹图标只给目录画（文件行画一个空 span 会在 DOM 里留一处没意义的占位）。 */}
          {entry.dir ? <span className="tree-folder">{folderIcon(open.includes(path))}</span> : null}
          <span className="file-name">{entry.name}</span>
          {entry.dir ? null : <span className="file-size">{formatSize(entry.size)}</span>}
        </button>
      )
      const children = entry.dir && open.includes(path) ? (dirs[path] ?? null) : null
      return children === null ? [row] : [row, ...rowsOf(path, children, depth + 1)]
    })

  return (
    <aside className="dock" style={{ width: '100%' }} data-hidden={active ? undefined : '1'}>
      <div className="dock-body">
        <div className="files-pane">
          <div className="files-bar">
            <span className="files-cwd" title={root?.cwd ?? ''}>
              {root === null ? '加载中…' : root.cwd}
            </span>
          </div>
          <div className="files-list">
            {note === '' ? null : <div className="tree-note">{note}</div>}
            {root === null ? null : rowsOf(root.cwd, root.entries, 0)}
            {root !== null && root.truncated ? <div className="tree-note">这个目录太长，只列了前一批</div> : null}
          </div>
        </div>
      </div>
    </aside>
  )
}

/** 变更面板（本插件的第二块 dock 面板）：git 状态 + 提交历史（变更那块在 changes.tsx）。 */
function ChangesDock(): ReactNode {
  const active = useDockPanel() === CHANGES_PANEL
  return (
    <aside className="dock" style={{ width: '100%' }} data-hidden={active ? undefined : '1'}>
      <div className="dock-body">
        <ChangesPanel />
      </div>
    </aside>
  )
}

/** 目录那一枚开合箭头（展开朝下、收起朝右。与旧界面一样，箭头与文件夹图标都有）。 */
function chevron(open: boolean): ReactNode {
  return open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />
}

/** 目录图标：开了口用 IconFolderOpen，否则 IconFolder。 */
function folderIcon(open: boolean): ReactNode {
  return open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />
}

/** Windows 风格的子路径拼接（`fs-list` / `fs-read` 都吃反斜杠绝对路径）。 */
function joinPath(parent: string, name: string): string {
  return /[\\/]$/.test(parent) ? parent + name : `${parent}\\${name}`
}

/** 文件大小的人类读法（树行与 tooltip 共用）。 */
function formatSize(size: number): string {
  if (size < 1024) return `${String(size)}B`
  if (size < 1024 * 1024) return `${String(Math.max(1, Math.round(size / 1024)))}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}
