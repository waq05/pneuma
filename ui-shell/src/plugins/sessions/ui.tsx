/**
 * 内置插件：左侧会话列表。
 *
 * 数据全部来自宿主快照（`sessions` + `sessionStates` + `status.sessionPath`），
 * 动作经界面通道调宿主方法（`refreshSessions` / `openSession`）——插件没有别的口子。
 *
 * 为什么一进界面就拉一次 `refreshSessions`：快照里那份列表是宿主的**缓存**，宿主只在
 * 这个方法被调用时才重扫磁盘；不拉的话，新装的界面看到的是一个空列表。
 *
 * @module dsc-ui-shell/plugins/sessions
 */
import { useEffect, useState } from 'react'
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

/** 主机目录里最后一段（列表上显示「这个会话在哪个项目里」）。 */
function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? cwd
}

/** 「3 分钟前」这类相对时间；老会话显示日期。 */
function relativeTime(at: number): string {
  const delta = Date.now() - at
  if (!Number.isFinite(delta) || delta < 0) return ''
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${String(days)} 天前`
  return new Date(at).toLocaleDateString()
}

/** 运行状态点：干活中 / 等审批 / 刚跑完没看。 */
function stateLabel(state: SessionRunState | undefined): string {
  if (state === 'working') return '干活中'
  if (state === 'awaiting-approval') return '等审批'
  if (state === 'just-finished') return '刚完成'
  return ''
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
    <div className="sessions">
      <div className="sessions-head">
        <span className="sessions-title">会话</span>
        <button type="button" className="sessions-new" onClick={() => open()} data-action="new-session">
          新会话
        </button>
      </div>
      {fault === null ? null : <p className="sessions-fault">{fault}</p>}
      {sorted.length === 0 ? (
        <p className="sessions-empty">{loading ? '正在读会话列表…' : '还没有会话'}</p>
      ) : (
        <ul className="sessions-list">
          {sorted.map((session) => {
            const state = stateLabel(states[session.id])
            const current = currentPath !== null && session.id === currentPath
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className={current ? 'sessions-row current' : 'sessions-row'}
                  data-session={session.id}
                  data-current={current ? '1' : ''}
                  {...(state === '' ? {} : { 'data-state': state })}
                  onClick={() => open(session.id)}
                >
                  <span className="sessions-row-top">
                    {session.pinnedAt === undefined ? null : <span className="sessions-pin">★</span>}
                    <span className="sessions-name">{session.title ?? '(未命名)'}</span>
                    {state === '' ? null : <span className="sessions-dot" data-state={state} title={state} />}
                  </span>
                  <span className="sessions-meta">
                    {projectName(session.cwd)} · {relativeTime(session.updatedAt)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
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
