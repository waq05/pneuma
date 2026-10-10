/**
 * 内置插件：左侧栏的会话列表（对照旧桌面界面 `Sidebar.tsx` 的会话区）。
 *
 * 为什么整块自己画、而不是只画「若干行」：旧界面里这一栏的滚动容器（`.sidebar-scroll`）
 * 与「新会话」按钮都在会话列表这个组件里，壳只提供 `.sidebar` 这个外壳。壳把槽条目
 * 渲染成 `display:contents`，所以这里的两个根节点会成为 `.sidebar` 的直接子节点，
 * 与旧界面的层级一致——外层 flex 列布局因此不用改一行 CSS 就能对上。
 *
 * 数据来自宿主快照（`sessions` + `sessionStates` + `status.sessionPath`），动作经界面
 * 通道调宿主方法（`refreshSessions` / `openSession` / `setSessionPinned` / `archiveSessions`）。
 *
 * 样式与 class 名一律照抄旧版（`ui-shell/src/legacy/views.css` 里有对应规则，行号同
 * 旧 `desktop/src/renderer/styles.css`）：`.sidebar-scroll` 287、`.section-head` 243、
 * `.sess-item` 378、`.row-slot` 394、`.session-dot` 401、`.lead-pin` 485、
 * `.title` 459、`.when` 468、`.row-actions` 690、`.sidebar-empty` 295。
 *
 * @module dsc-ui-shell/plugins/sessions
 */
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { IconArchive, IconPin, IconPlus, IconQueue, IconRefresh } from '@dsc/ui'
import { defineUiPlugin, useHostChannel, useHostSelector, type HostSnapshot, type SessionRunState, type SessionSummary } from '@dsc/ui'

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
          <span className="side-title">会话</span>
          <span className="head-actions">
            <button
              type="button"
              className="icon-btn"
              data-tip="重新读一遍会话列表"
              aria-label="刷新会话列表"
              disabled={loading}
              onClick={() => void run('refreshSessions', [])}
            >
              <IconRefresh size={15} />
            </button>
          </span>
        </div>

        {fault === null ? null : <div className="sidebar-empty">列表没读出来：{fault}</div>}

        {sorted.length === 0 ? (
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
              onArchive={() => run('archiveSessions', [[session.id]])}
            />
          ))
        )}
      </div>
    </>
  )
}

/** 一行会话。DOM 与 class 照旧版 `Sidebar.tsx:579-825`，行根是 div 扮按钮（不是 button）。 */
function SessionRow({
  session,
  state,
  current,
  onOpen,
  onPin,
  onArchive,
}: {
  session: SessionSummary
  state: SessionRunState | undefined
  current: boolean
  onOpen: (id?: string) => void
  onPin: (pinned: boolean) => void
  onArchive: () => void
}) {
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

      <span className="title">{title}</span>
      <span className="when">{relativeTime(session.updatedAt)}</span>

      <span className="row-actions" onClick={stop}>
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
