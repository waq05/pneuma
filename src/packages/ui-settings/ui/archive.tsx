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
  createT,
  getHostNative,
  useHostChannel,
  type ArchivedPage,
  type ArchivedSessionView,
  type SettingsMutation,
} from '@dsc/ui'
import { errText as text, humanErrorText } from '@dsc/ui-primitives'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

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
  if (minutes < 1) return t('settings.archive.time.justNow')
  if (minutes < 60) return t('settings.archive.time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('settings.archive.time.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('settings.archive.time.daysAgo', { count: days })
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
      .catch((error: unknown) => setNote({ tone: 'error', text: t('settings.archive.loadFailed', { message: humanErrorText(error).text }) }))
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
          setNote({ tone: 'error', text: t('settings.archive.opFailed', { message: result.error }) })
          return
        }
        setNote({ tone: 'ok', text: result.notice ?? fallbackNotice })
        load()
      })
      .catch((error: unknown) => setNote({ tone: 'error', text: t('settings.archive.opFailed', { message: humanErrorText(error).text }) }))
  }

  /** 用原生桥在文件管理器里打开回收站；桥缺席（浏览器）时说清而不是崩。 */
  const openTrash = (trashDir: string): void => {
    setNote(null)
    void getHostNative()
      .invoke<string>('openPath', [trashDir])
      .then((problem) => {
        if (problem === '') setNote({ tone: 'ok', text: t('settings.archive.trashOpened') })
        else setNote({ tone: 'error', text: t('settings.archive.openFailed', { message: problem }) })
      })
      .catch((error: unknown) =>
        setNote({ tone: 'error', text: t('settings.archive.noBridge', { message: text(error) }) }),
      )
  }

  const groups = useMemo(() => groupByWorkspace(page?.items ?? []), [page])

  return (
    <div className="settings-fields archived">
      {note === null ? null : <div className={`settings-note${note.tone === 'error' ? ' error' : ''}`}>{note.text}</div>}
      {page === null ? (
        note === null ? (
          <div className="settings-empty">{t('settings.archive.loading')}</div>
        ) : null
      ) : (
        <>
          <div className="arch-head">
            <span>
              {t('settings.archive.head.lead')} <span className="count">{String(page.items.length)}</span>{' '}
              {t('settings.archive.head.tail')}
            </span>
            <button className="btn-ghost" data-tip={t('settings.archive.reloadTip')} onClick={reload}>
              <IconRefresh size={14} /> {t('settings.archive.refresh')}
            </button>
          </div>

          {page.items.length === 0 && (
            <div className="empty-card compact">
              <span className="empty-card-icon">
                <IconArchive size={18} />
              </span>
              <div className="empty-card-title">{t('settings.archive.empty.title')}</div>
              <p className="empty-card-desc">
                {t('settings.archive.empty.desc')}
              </p>
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
                  data-tip={t('settings.archive.restoreGroupTip', { count: group.items.length })}
                  onClick={() =>
                    restore(
                      group.items.map((item) => item.path),
                      t('settings.archive.restoreGroupNotice', { count: group.items.length }),
                    )
                  }
                >
                  <IconRestart size={13} /> {t('settings.archive.restoreAll')}
                </button>
              </div>
              {group.items.map((item) => (
                <div className="arch-row" key={item.path} data-tip={item.path}>
                  <span className="title">{item.title ?? t('settings.archive.untitled')}</span>
                  <span className="when" data-tip={t('settings.archive.archivedTip', { time: new Date(item.archivedAt).toLocaleString() })}>
                    {t('settings.archive.archivedAt')} {ago(item.archivedAt)}
                  </span>
                  <span className="arch-actions">
                    <button
                      className="text-btn"
                      data-tip={t('settings.archive.restoreTip')}
                      onClick={() => restore([item.path], t('settings.archive.restoreNotice'))}
                    >
                      <IconRestart size={13} /> {t('settings.archive.restore')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ))}

          <div className="arch-foot">
            <span>{t('settings.archive.trashFoot', { count: page.trashCount })}</span>
            <button className="text-btn" data-tip={t('settings.archive.openTrashTip')} onClick={() => openTrash(page.trashDir)}>
              {t('settings.archive.openTrash')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
