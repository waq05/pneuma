/**
 * 内置插件：工作区文件树 + git 变更（右侧栏「文件」「Git」两个页签的页签体）。
 *
 * 布局与开合（页签条、分栏、全屏、收起）归壳；这里报名两种 kind 的内容，
 * 页面体是旧桌面版 `Dock.tsx` 的同构：文件树的展开集 / 各层 listing / 滚动位
 * 存在 `./tree-store`（**每个工作区根一棵树**——切会话各回各的树，与旧桌面版同款）。
 *
 * 数据源是 dock 通道的**读类** op `fs-list`（读类直接放行，见 `src/core/dock-ops.ts`），
 * 所以这一块在浏览器里也能用（与终端不同）。「变更」页签走 `git-status` / `git-log` /
 * `git-diff` 三个读类 op 与 `git-stage` / `git-unstage` / `git-commit` 三个写类 op
 * （写类过审批闸），见 changes.tsx。
 *
 * 点一个文件 → 开一张**预览页签**（壳的布局模型按路径去重；旧桌面版同款）。
 *
 * ## 与旧桌面版对齐的细节
 *
 * - class 名全照旧界面（`.files-pane` / `.files-bar` / `.files-cwd` / `.files-list` /
 *   `.tree-item` / `.file-row` / `.file-icon` / `.file-name` / `.file-size` /
 *   `.tree-level` / `.tree-note`），样式一行都不用新写；
 * - 懒加载：目录展开才拉那一层；根目录行写「工作区根目录」；
 * - 树行结构：目录一行「文件夹图标（开合两态）+ 名字」、文件一行「彩色文件图标 +
 *   名字 + 大小」——树行里没有单独的箭头格，别再加回来；
 * - 目录排序：目录在前、自然序（数字按值、大小写不敏感）。
 *
 * 工作区根 = **当前会话的 cwd**（宿主 desktop-dock 插件按会话解析，切会话即换根）。
 *
 * @module dsc-ui-shell/plugins/files
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import {
  FileIcon,
  IconBranch,
  IconFolder,
  IconFolderOpen,
  IconRefresh,
  defineUiPlugin,
  registerDockTab,
  setDockPreview,
  useActivePreviewPath,
  useHostChannel,
  useHostSelector,
  type HostSnapshot,
} from '@dsc/ui'
import { ChangesPanel } from './changes'
import {
  getTree,
  needsLoad,
  orderEntries,
  setLevel,
  setScrollTop,
  subscribe as subscribeTree,
  toggleExpanded,
  type TreeEntry,
} from './tree-store'

/**
 * 通道类型从 `useHostChannel()` 的返回推出来——插件不直接 import 壳内部模块
 * （旧写法 `import type { HostChannel } from '../../host-channel'` 已随 E4 清理）。
 */
type HostChannel = ReturnType<typeof useHostChannel>

/** `fs-list` 回来的清单（宿主 `desktop-dock` 插件的形状）。 */
interface Listing {
  cwd: string
  entries: TreeEntry[]
  truncated: boolean
}

export default defineUiPlugin({
  name: '文件',
  apply() {
    // 报名两种页签界面：文件（工作区树）与 Git（变更面板）。开合/分栏归壳。
    registerDockTab({ kind: 'files', label: '文件', icon: <IconFolder size={13} />, component: FilesTab })
    registerDockTab({ kind: 'git', label: 'Git', icon: <IconBranch size={13} />, component: GitTab })
  },
})

/** 文件页签体：当前会话工作区的树。 */
function FilesTab(): ReactNode {
  const cwd = useHostSelector(readCwd)
  if (cwd === null || cwd === '') {
    // 快照还没到（宿主刚起来）：给一句能读的状态，别画一棵空树。
    return (
      <div className="files-pane">
        <div className="tree-note">读取中…</div>
      </div>
    )
  }
  return <FilesPane cwd={cwd} />
}

/** Git 页签体：变更面板（分支/暂存/提交/历史；组件自身按挂载时机重读）。 */
function GitTab(): ReactNode {
  return <ChangesPanel />
}

/** 拉一层目录的 listing 进 store（成功置 ready、失败存 message，渲染侧自己画状态行）。 */
function loadLevel(channel: HostChannel, cwd: string, path: string): void {
  void channel
    .invoke<Listing>('dock', ['fs-list', { dir: path }])
    .then((data) => {
      setLevel(cwd, path, { kind: 'ready', entries: data.entries, truncated: data.truncated === true })
    })
    .catch((error: unknown) => {
      setLevel(cwd, path, { kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
}

/** 树的状态行（加载中/为空/失败/截断），旧桌面版 `.tree-note` 同位。 */
function TreeNote({ kind, message }: { kind: 'loading' | 'empty' | 'failed' | 'truncated'; message?: string }): ReactNode {
  const text = kind === 'loading' ? '读取中…' : kind === 'empty' ? '（空目录）' : kind === 'truncated' ? '条目过多，已截断显示' : (message ?? '读取失败')
  return (
    <div className="tree-note" data-tree-note={kind}>
      {text}
    </div>
  )
}

/**
 * 树的一层：本层状态行 + 条目行 + 已展开子层（递归）。
 *
 * `cwd` 是树的身份（一个工作区根一棵树），`path` 是本层目录的绝对路径；
 * 两者分开是因为子层的绝对路径都从根拼出来，而 store 按 cwd 找树。
 */
function TreeLevel({ cwd, path, depth }: { cwd: string; path: string; depth: number }): ReactNode {
  const channel = useHostChannel()
  const previewPath = useActivePreviewPath()
  const tree = useSyncExternalStore(subscribeTree, () => getTree(cwd))
  const level = tree.levels[path]
  // 根层由 FilesPane 拉；子层展开时若还没 listing（store 里没有或失败过），这里补拉
  useEffect(() => {
    if (depth > 0 && needsLoad(cwd, path)) loadLevel(channel, cwd, path)
  }, [cwd, path, depth, channel])
  if (level === undefined || level.kind === 'loading') return <TreeNote kind="loading" />
  if (level.kind === 'failed') return <TreeNote kind="failed" message={level.message} />
  const entries = orderEntries(level.entries)
  if (entries.length === 0) return <TreeNote kind="empty" />
  return (
    <>
      {level.truncated ? <TreeNote kind="truncated" /> : null}
      {entries.map((entry) => {
        const entryPath = joinPath(path, entry.name)
        if (entry.dir) {
          const expanded = tree.expanded.includes(entryPath)
          return (
            <div key={entry.name} className="tree-item" data-tree-entry="directory">
              <button className="file-row" aria-expanded={expanded} onClick={() => toggleExpanded(cwd, entryPath)}>
                <span className="file-icon tree-folder">{expanded ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}</span>
                <span className="file-name">{entry.name}</span>
              </button>
              {expanded && (
                <div className="tree-level">
                  <TreeLevel cwd={cwd} path={entryPath} depth={depth + 1} />
                </div>
              )}
            </div>
          )
        }
        return (
          <button
            key={entry.name}
            className={`file-row${previewPath === entryPath ? ' on' : ''}`}
            data-tree-entry="file"
            title={entryPath}
            onClick={() => setDockPreview({ path: entryPath })}
          >
            <span className="file-icon">
              <FileIcon name={entry.name} size={15} />
            </span>
            <span className="file-name">{entry.name}</span>
            <span className="file-size">{formatSize(entry.size)}</span>
          </button>
        )
      })}
    </>
  )
}

/**
 * 文件树面板本体（旧桌面版 FilesPane 同构）：根行 + 滚动区。
 *
 * 保活对齐旧桌面版：树状态在 store（进程内），页签切走重挂后展开集与滚动位原样回来；
 * 切会话（cwd 变）就换到那棵树——两棵树的展开与滚动各记各的。
 */
function FilesPane({ cwd }: { cwd: string }): ReactNode {
  const channel = useHostChannel()
  const tree = useSyncExternalStore(subscribeTree, () => getTree(cwd))
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)

  /** 刷新 = 重拉根层与全部已展开层（先标 loading，回来原地换内容）。 */
  const loadAll = (): void => {
    for (const path of tree.expanded) setLevel(cwd, path, { kind: 'loading' })
    for (const path of tree.expanded) loadLevel(channel, cwd, path)
  }

  // 首挂与切会话：根层没有 listing（或上次失败）就拉一次。
  useEffect(() => {
    if (needsLoad(cwd, cwd)) loadLevel(channel, cwd, cwd)
  }, [cwd, channel])

  // 滚动位：挂载时从 store 播种，卸载时写回（旧桌面版同款——滚动本身不重渲染）
  useEffect(() => {
    const body = bodyRef.current
    if (body !== null && tree.scrollTop > 0) body.scrollTop = tree.scrollTop
    return () => {
      if (bodyRef.current !== null) setScrollTop(cwd, scrollTopRef.current)
    }
  }, [cwd, tree.scrollTop])

  const relative = tree.root.slice(cwd.length)
  return (
    <div className="files-pane">
      <div className="files-bar">
        <span className="files-cwd" data-tip={tree.root} data-files-root title={tree.root}>
          {relative === '' ? '工作区根目录' : relative}
        </span>
        <button type="button" className="icon-btn" data-tip="刷新" aria-label="刷新文件树" onClick={loadAll}>
          <IconRefresh size={13} />
        </button>
      </div>
      <div
        ref={bodyRef}
        className="files-list"
        onScroll={(event) => {
          scrollTopRef.current = event.currentTarget.scrollTop
        }}
      >
        <TreeLevel cwd={cwd} path={tree.root} depth={0} />
      </div>
    </div>
  )
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

/** 当前会话的工作目录（文件树的根；与侧栏底部同一字段）。 */
function readCwd(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['cwd']
  return typeof value === 'string' && value !== '' ? value : null
}
