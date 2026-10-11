/**
 * 设置 → 归档：按工作区分组列出已归档会话，支持恢复（单条 / 整组）与回收站说明。
 *
 * 版式整体搬旧桌面端 `ArchivedView.tsx`（同一套 class：`arch-*`，样式在
 * `legacy/views.css:5563+` 原样等着）。与旧面板的两处差异，都来自界面通道的方法面：
 *
 *  - **永久删除不做**：`purgeSessions` 被有意排除在界面通道之外（不可逆的破坏性操作）。
 *    归档件本来就有 30 天回收站语义（`ArchivedPage.trashCount`），放着不动宿主会自动清；
 *    真要立刻删，旧界面（回退路）里仍然有这个按钮。
 *  - **「打开回收站目录」走原生桥的 `openPath`**：只在桌面窗口有效；浏览器里桥缺席，
 *    点了给一句人话，不崩。
 *
 * @module dsc-ui-shell/plugins/settings/archive
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  IconArchive,
  IconRefresh,
  IconRestart,
  getHostNative,
  useHostChannel,
  type ArchivedPage,
  type ArchivedSessionView,
  type SettingsMutation,
} from '@dsc/ui'

/** 拿异常的文字形态。 */
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 按工作区分组：组内按归档时间倒序，组之间按各自最新的归档时间倒序。 */
function groupByWorkspace(items: ArchivedSessionView[]): Array<{ cwd: string; items: ArchivedSessionView[] }> {
  const map = new Map<string, ArchivedSessionView[]>()
  for (const item of items) {
    const list = map.get(item.cwd) ?? []
    list.push(item)
    map.set(item.cwd, list)
  }
  return [...map.entries()]
    .map(([cwd, list]) => ({ cwd, items: [...list].sort((a, b) => b.archivedAt - a.archivedAt) }))
    .sort((a, b) => (b.items[0]?.archivedAt ?? 0) - (a.items[0]?.archivedAt ?? 0))
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function ago(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${String(days)} 天前`
  return new Date(ts).toLocaleDateString()
}

export function ArchiveGroup(): ReactNode {
  const channel = useHostChannel()
  const [page, setPage] = useState<ArchivedPage | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  /** 只取数据不动说明——操作回执（行内说明）不能被随之而来的重取抹掉。 */
  const load = (): void => {
    void channel
      .invoke<ArchivedPage>('listArchivedSessions')
      .then(setPage)
      .catch((error: unknown) => setNote({ tone: 'error', text: `读取归档失败：${text(error)}` }))
  }
  const reload = (): void => {
    setNote(null)
    load()
  }
  useEffect(reload, [channel])

  /** 恢复一批会话（单条与整组同一条路），回执走行内说明并重取（文件已被挪走）。 */
  const restore = (paths: string[], fallbackNotice: string): void => {
    setNote(null)
    void channel
      .invoke<SettingsMutation>('restoreSessions', [paths])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: `操作失败：${result.error}` })
          return
        }
        setNote({ tone: 'ok', text: result.notice ?? fallbackNotice })
        load()
      })
      .catch((error: unknown) => setNote({ tone: 'error', text: `操作失败：${text(error)}` }))
  }

  /** 用原生桥在文件管理器里打开回收站；桥缺席（浏览器）时说清而不是崩。 */
  const openTrash = (trashDir: string): void => {
    setNote(null)
    void getHostNative()
      .invoke<string>('openPath', [trashDir])
      .then((problem) => {
        if (problem === '') setNote({ tone: 'ok', text: '已在文件管理器里打开回收站' })
        else setNote({ tone: 'error', text: `打开失败：${problem}` })
      })
      .catch((error: unknown) =>
        setNote({ tone: 'error', text: `这个窗口里没有原生桥，打不开目录（桌面窗口可用）：${text(error)}` }),
      )
  }

  const groups = useMemo(() => groupByWorkspace(page?.items ?? []), [page])

  return (
    <div className="settings-fields archived">
      {note === null ? null : <div className={`settings-note${note.tone === 'error' ? ' error' : ''}`}>{note.text}</div>}
      {page === null ? (
        note === null ? (
          <div className="settings-empty">正在读取归档会话…</div>
        ) : null
      ) : (
        <>
          <div className="arch-head">
            <span>
              已归档会话 <span className="count">{String(page.items.length)}</span> 个
            </span>
            <button className="btn-ghost" data-tip="重新读取归档区" onClick={reload}>
              <IconRefresh size={14} /> 刷新
            </button>
          </div>

          {page.items.length === 0 && (
            <div className="settings-empty">
              归档区是空的。在侧栏会话行点击归档按钮可归档单个会话，或在工作区行点击归档按钮归档整组会话。
            </div>
          )}

          {groups.map((group) => (
            <div className="arch-group" key={group.cwd}>
              <div className="arch-group-head">
                <IconArchive size={14} />
                <span className="dir" data-tip={group.cwd}>
                  {lastSegment(group.cwd)}
                </span>
                <span className="count">{String(group.items.length)}</span>
                <button
                  className="text-btn"
                  data-tip={`恢复这个工作区里的 ${String(group.items.length)} 个会话`}
                  onClick={() =>
                    restore(
                      group.items.map((item) => item.path),
                      `已恢复这个工作区的 ${String(group.items.length)} 个会话`,
                    )
                  }
                >
                  <IconRestart size={13} /> 全部恢复
                </button>
              </div>
              {group.items.map((item) => (
                <div className="arch-row" key={item.path} data-tip={item.path}>
                  <span className="title">{item.title ?? '未命名会话'}</span>
                  <span className="when" data-tip={`${new Date(item.archivedAt).toLocaleString()} 归档`}>
                    归档于 {ago(item.archivedAt)}
                  </span>
                  <span className="arch-actions">
                    <button
                      className="text-btn"
                      data-tip="放回会话列表，回到原工作区"
                      onClick={() => restore([item.path], '已恢复到会话列表')}
                    >
                      <IconRestart size={13} /> 恢复
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ))}

          <div className="arch-foot">
            <span>
              回收站 <span className="mono">{page.trashDir}</span> 保留 30 天后自动清空，现在里面有{' '}
              {String(page.trashCount)} 个文件。
              「永久删除」是有意不放进这个界面的操作（不可逆），旧界面里仍有入口。
            </span>
            <button className="text-btn" data-tip="在文件管理器里打开回收站" onClick={() => openTrash(page.trashDir)}>
              打开回收站目录
            </button>
          </div>
        </>
      )}
    </div>
  )
}
