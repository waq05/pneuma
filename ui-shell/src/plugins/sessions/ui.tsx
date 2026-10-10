/**
 * 内置插件：左侧栏的会话列表（对照旧桌面界面 `Sidebar.tsx` 的会话区）。
 *
 * 为什么整块自己画、而不是只画「若干行」：旧界面里这一栏的滚动容器（`.sidebar-scroll`）
 * 与「新会话」按钮都在会话列表这个组件里，壳只提供 `.sidebar` 这个外壳。壳把槽条目
 * 渲染成 `display:contents`，所以这里的两个根节点会成为 `.sidebar` 的直接子节点，
 * 与旧界面的层级一致——外层 flex 列布局因此不用改一行 CSS 就能对上。
 *
 * 数据来自宿主快照（`sessions` + `sessionStates` + `status.sessionPath`），动作经界面
 * 通道调宿主方法（`refreshSessions` / `openSession` / `setSessionPinned` / `archiveSessions`
 * / `renameSession` / `listUserMessages` + `forkSession` / `listArchivedSessions` + `restoreSessions`）。
 *
 * 这一栏有两个视图：**会话**（活的，来自快照）与**归档**（`listArchivedSessions` 现拉，
 * 每行给一颗「恢复」）。归档区不订阅快照——它是一份按需读的档案，没有"每帧变"这回事。
 *
 * 样式与 class 名一律照抄旧版（`ui-shell/src/legacy/views.css` 里有对应规则，行号同
 * 旧 `desktop/src/renderer/styles.css`）：`.sidebar-scroll` 287、`.section-head` 243、
 * `.sess-item` 378、`.row-slot` 394、`.session-dot` 401、`.lead-pin` 485、
 * `.title` 459、`.when` 468、`.row-actions` 690、`.sidebar-empty` 295。
 *
 * @module dsc-ui-shell/plugins/sessions
 */
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { IconArchive, IconArchiveOff, IconBranch, IconEdit, IconPin, IconPlus, IconQueue, IconRefresh } from '@dsc/ui'
import {
  defineUiPlugin,
  useHostChannel,
  useHostSelector,
  type ArchivedSessionView,
  type HostSnapshot,
  type SessionRunState,
  type SessionSummary,
} from '@dsc/ui'

/** 空的会话列表常量：没拿到快照时共用一份，省得每帧新建数组。 */
const NO_SESSIONS: readonly SessionSummary[] = Object.freeze([])

export default defineUiPlugin({
  name: '会话列表',
  apply(ui) {
    // order 1：这一栏的主体，别的贡献排在它下面。
    ui.slots.register('shell.sidebar', { id: 'sessions.list', order: 1 }, SessionList)
  },
})

/**
 * 相对时间，文案照旧版 `sidebar-groups.ts:50-57`：刚刚 / N分钟 / N小时 / N天。
 *
 * 与旧版一致地**不做月以上换算**：旧界面这里就没有「N 个月前」，多出来的分支会
 * 让同一份列表在两个界面里显示不同文案。
 */
function relativeTime(at: number): string {
  const delta = Date.now() - at
  if (!Number.isFinite(delta) || delta < 0) return ''
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)}分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}小时`
  return `${String(Math.floor(hours / 24))}天`
}

/** 运行状态 → `.session-dot` 上的 class（旧版也是 class，不是 data 属性）。 */
const DOT_CLASS: Readonly<Record<SessionRunState, string>> = {
  working: 'working',
  'awaiting-approval': 'awaiting-approval',
  'just-finished': 'just-finished',
}

/** 运行状态 → 悬浮说明。 */
const DOT_LABEL: Readonly<Record<SessionRunState, string>> = {
  working: '正在干活',
  'awaiting-approval': '等你审批',
  'just-finished': '后台跑完，还没看过',
}

function SessionList() {
  const channel = useHostChannel()
  const sessions = useHostSelector(readSessions)
  const states = useHostSelector(readStates)
  const currentPath = useHostSelector(readCurrentPath)
  const loading = useHostSelector(readLoading)
  const [fault, setFault] = useState<string | null>(null)
  /** 正在挑"从哪条消息分叉"（null = 没在挑）。 */
  const [forking, setForking] = useState<{ id: string; messages: string[] } | null>(null)
  /** 当前看的是哪一页：活着的会话，还是归档区。 */
  const [view, setView] = useState<'active' | 'archived'>('active')
  /** 归档页（只在切过去时读一次；恢复/归档后再读）。 */
  const [archived, setArchived] = useState<ArchivedSessionView[] | null>(null)

  useEffect(() => {
    void channel.invoke('refreshSessions').catch((reason: unknown) => {
      setFault(reason instanceof Error ? reason.message : String(reason))
    })
  }, [channel])

  /** 调一个宿主方法；失败就把原因摊在列表上方（不静默）。 */
  const run = async (method: string, args: unknown[]): Promise<void> => {
    setFault(null)
    try {
      await channel.invoke(method, args)
    } catch (reason) {
      setFault(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /**
   * 打开一条会话；不给 id = 新建（宿主协议里 `openSession(undefined)` 就是这个意思）。
   *
   * 开完再重扫一次列表：新建的会话要等它落盘才会出现在列表里，而且当前会话的标记与
   * 排序也跟着变——不重扫的话，刚建的会话在侧栏里看不见，用户会以为没成功。
   */
  const open = (id?: string): void => {
    void (async () => {
      await run('openSession', id === undefined ? [] : [id])
      await run('refreshSessions', [])
    })()
  }

  // 置顶在前，其余按最后写入时间倒序——与宿主给的顺序无关，界面自己定怎么排。
  /** 改名（宿主写会话标题；名字为空 = 撤销改名，交回宿主自己的推断）。 */
  const rename = (id: string, name: string): void => {
    void run('renameSession', [id, name])
  }

  /**
   * 分叉：先问宿主「这条会话里有哪些用户消息」，弹一个小选择列表，选哪条就从那里分叉。
   *
   * 为什么不直接分叉在最后一条：分叉的意思是"从某一句话重来"，选哪一句是用户的事
   * （旧界面同样先列用户消息再点）。只有一条候选时仍然弹列表——省一步点击换来的
   * 是"不知道分叉在哪"的困惑。
   */
  const startFork = (id: string): void => {
    void (async () => {
      setFault(null)
      try {
        const messages = await channel.invoke<string[]>('listUserMessages', [id])
        setForking({ id, messages })
      } catch (reason) {
        setFault(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }

  /** 真的分叉：宿主复制到第 index 条用户消息之前，返回新会话路径；分完打开它。 */
  const doFork = (id: string, index: number): void => {
    setForking(null)
    void (async () => {
      setFault(null)
      try {
        const result = await channel.invoke<{ ok: boolean; path?: string; error?: string }>('forkSession', [id, index])
        if (result.ok !== true) {
          setFault(result.error ?? '分叉失败')
          return
        }
        await run('openSession', result.path === undefined ? [] : [result.path])
        await run('refreshSessions', [])
      } catch (reason) {
        setFault(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }

  /** 读归档页（切过去、归档完、恢复完都会走）。 */
  const loadArchived = (): void => {
    setFault(null)
    void channel
      .invoke<{ items: ArchivedSessionView[] }>('listArchivedSessions')
      .then((page) => {
        setArchived(page.items)
      })
      .catch((reason: unknown) => {
        setFault(reason instanceof Error ? reason.message : String(reason))
      })
  }

  /** 归档一批（活会话列表里那一颗按钮走这里，归档完把归档页一起刷新）。 */
  const archive = (id: string): void => {
    void (async () => {
      await run('archiveSessions', [[id]])
      await run('refreshSessions', [])
      if (archived !== null) loadArchived()
    })()
  }

  /** 从归档区恢复一条：恢复完刷新归档页与活列表（它会回到活列表里）。 */
  const restore = (path: string): void => {
    void (async () => {
      await run('restoreSessions', [[path]])
      loadArchived()
      await run('refreshSessions', [])
    })()
  }

  const sorted = [...sessions].sort((left, right) => {
    const pin = (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0)
    return pin !== 0 ? pin : right.updatedAt - left.updatedAt
  })

  return (
    <>
      <button type="button" className="btn-new" data-action="new-session" onClick={() => open()}>
        <IconPlus size={15} />
        新会话
      </button>

      <div className="sidebar-scroll">
        <div className="section-head">
          <span className="side-title">{view === 'active' ? '会话' : '归档'}</span>
          <span className="head-actions">
            <button
              type="button"
              className={`shell-tab${view === 'active' ? ' on' : ''}`}
              aria-pressed={view === 'active'}
              onClick={() => {
                setView('active')
              }}
            >
              会话
            </button>
            <button
              type="button"
              className={`shell-tab${view === 'archived' ? ' on' : ''}`}
              aria-pressed={view === 'archived'}
              onClick={() => {
                setView('archived')
                loadArchived()
              }}
            >
              归档
            </button>
            <button
              type="button"
              className="icon-btn"
              data-tip={view === 'active' ? '重新读一遍会话列表' : '重新读一遍归档'}
              aria-label="刷新"
              disabled={view === 'active' && loading}
              onClick={() => {
                if (view === 'archived') loadArchived()
                else void run('refreshSessions', [])
              }}
            >
              <IconRefresh size={15} />
            </button>
          </span>
        </div>

        {fault === null ? null : <div className="sidebar-empty">列表没读出来：{fault}</div>}

        {forking === null ? null : (
          <div className="shell-fork-picker">
            <div className="settings-group-title">从哪句话分叉？</div>
            {forking.messages.length === 0 ? (
              <div className="settings-empty">这条会话里还没有用户消息。</div>
            ) : (
              forking.messages.map((text, index) => (
                <button
                  key={index}
                  type="button"
                  className="shell-fork-item"
                  title={text}
                  onClick={() => {
                    doFork(forking.id, index)
                  }}
                >
                  <span className="shell-fork-no">{index + 1}</span>
                  {oneLine(text)}
                </button>
              ))
            )}
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setForking(null)
              }}
            >
              取消
            </button>
          </div>
        )}

        {view === 'archived' ? (
          archived === null ? (
            <div className="sidebar-empty">正在读归档…</div>
          ) : archived.length === 0 ? (
            <div className="sidebar-empty">
              <IconArchive size={24} />
              <div>归档区是空的。</div>
              <div>归档的会话会留在这里，随时可以恢复。</div>
            </div>
          ) : (
            archived.map((item) => (
              <ArchivedRow
                key={item.path}
                item={item}
                onRestore={() => {
                  restore(item.path)
                }}
              />
            ))
          )
        ) : sorted.length === 0 ? (
          <div className="sidebar-empty">
            <IconQueue size={24} />
            <div>{loading ? '正在读会话列表…' : '还没有历史会话。'}</div>
            {loading ? null : <div>发送第一条消息开始。</div>}
          </div>
        ) : (
          sorted.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              state={states[session.id]}
              current={currentPath !== null && session.id === currentPath}
              onOpen={open}
              onPin={(pinned) => run('setSessionPinned', [session.id, pinned])}
              onArchive={() => {
                archive(session.id)
              }}
              onRename={(name) => rename(session.id, name)}
              onFork={() => startFork(session.id)}
            />
          ))
        )}
      </div>
    </>
  )
}

/**
 * 归档区里的一行：标题 + 原工作目录 + 归档时刻 + 一颗恢复钮。
 *
 * 它不复用 {@link SessionRow}：归档行没有"打开/置顶/分叉"这些动作（会话已经挪进 `.archived/`），
 * 硬塞进同一个组件只会让那个组件长出一堆 `if`。
 */
function ArchivedRow({ item, onRestore }: { item: ArchivedSessionView; onRestore: () => void }) {
  const title = item.title ?? baseName(item.path)
  return (
    <div className="sess-item" data-tip={`${item.cwd}
归档于 ${new Date(item.archivedAt).toLocaleString()}`}>
      <span className="row-slot" />
      <span className="title">{title}</span>
      <span className="when">{relativeTime(item.archivedAt)}</span>
      <span className="row-actions">
        <button
          type="button"
          className="icon-btn"
          data-tip="恢复到会话列表"
          aria-label="恢复会话"
          onClick={onRestore}
        >
          <IconArchiveOff size={14} />
        </button>
      </span>
    </div>
  )
}

/** 路径里的文件名（归档行没有标题时拿它顶上）。两种分隔符都切，按仓库惯例（`ChatView.tsx:77`）。 */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** 一行会话。DOM 与 class 照旧版 `Sidebar.tsx:579-825`，行根是 div 扮按钮（不是 button）。 */
function SessionRow({
  session,
  state,
  current,
  onOpen,
  onPin,
  onArchive,
  onRename,
  onFork,
}: {
  session: SessionSummary
  state: SessionRunState | undefined
  current: boolean
  onOpen: (id?: string) => void
  onPin: (pinned: boolean) => void
  onArchive: () => void
  onRename: (name: string) => void
  onFork: () => void
}) {
  /** 改名中的草稿（null = 没在改名）。回车提交、Esc 撤销、失焦也算提交。 */
  const [draft, setDraft] = useState<string | null>(null)
  const pinned = session.pinnedAt !== undefined
  const title = session.title ?? '新会话'
  const dot = state === undefined ? undefined : DOT_CLASS[state]
  const dotLabel = state === undefined ? '' : DOT_LABEL[state]

  /** 行内按钮的点击不该顺带开会话（旧版也是这么拦的）。 */
  const stop = (event: MouseEvent): void => {
    event.stopPropagation()
  }

  return (
    <div
      className={`sess-item${current ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      data-tip={`${title}；回车打开`}
      onClick={() => onOpen(session.id)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(session.id)
      }}
    >
      {dot === undefined ? (
        // 没有运行状态时才给图钉：旧界面里这一格是「状态点 / 图钉」二选一，
        // 两样同时画会把行首撑宽。
        <span className="row-slot">
          <button
            type="button"
            className={`lead-pin${pinned ? ' pinned' : ''}`}
            data-tip={pinned ? '取消置顶' : '置顶会话'}
            aria-label={pinned ? '取消置顶' : '置顶会话'}
            onClick={(event) => {
              stop(event)
              onPin(!pinned)
            }}
          >
            <IconPin size={13} />
          </button>
        </span>
      ) : (
        <span className={`row-slot session-dot ${dot}`} data-tip={dotLabel} aria-label={dotLabel}>
          <span className="dot" />
        </span>
      )}

      {draft === null ? (
        <span className="title">{title}</span>
      ) : (
        <input
          className="shell-rename-input"
          autoFocus
          value={draft}
          aria-label="会话名"
          onClick={stop}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            // 行本身也认回车（打开会话），这里必须先拦住再决定提交还是撤销。
            event.stopPropagation()
            if (event.key === 'Enter') {
              onRename(draft.trim())
              setDraft(null)
            } else if (event.key === 'Escape') {
              setDraft(null)
            }
          }}
          onBlur={() => {
            if (draft !== null) {
              onRename(draft.trim())
              setDraft(null)
            }
          }}
        />
      )}
      <span className="when">{relativeTime(session.updatedAt)}</span>

      <span className="row-actions" onClick={stop}>
        <button
          type="button"
          className="icon-btn"
          data-tip="改名"
          aria-label="改名"
          onClick={() => {
            setDraft(title)
          }}
        >
          <IconEdit size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-tip="从某条消息分叉出新会话"
          aria-label="分叉会话"
          onClick={onFork}
        >
          <IconBranch size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-tip="归档这个会话"
          aria-label="归档这个会话"
          onClick={onArchive}
        >
          <IconArchive size={14} />
        </button>
      </span>
    </div>
  )
}

/** 一行里的用户消息：换行压成空格、超长截断（分叉选择列表用）。 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : flat
}

/** 从快照里取会话列表；取不到给共用空数组（引用稳定，选择器才拦得住重渲染）。 */
function readSessions(snapshot: HostSnapshot | null): readonly SessionSummary[] {
  const value = snapshot?.['sessions']
  return Array.isArray(value) ? (value as SessionSummary[]) : NO_SESSIONS
}

/** 会话运行状态表（会话 jsonl 路径 → 状态）。 */
function readStates(snapshot: HostSnapshot | null): Record<string, SessionRunState> {
  const value = snapshot?.['sessionStates']
  return typeof value === 'object' && value !== null ? (value as Record<string, SessionRunState>) : {}
}

/** 当前正在看的那条会话（jsonl 绝对路径）。 */
function readCurrentPath(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const path = (status as Record<string, unknown>)['sessionPath']
  return typeof path === 'string' ? path : null
}

function readLoading(snapshot: HostSnapshot | null): boolean {
  return snapshot?.['sessionsLoading'] === true
}
