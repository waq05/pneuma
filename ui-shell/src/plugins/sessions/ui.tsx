/**
 * 内置插件：左侧栏的会话列表（对照旧桌面界面 `Sidebar.tsx` 的会话区）。
 *
 * 为什么整块自己画、而不是只画「若干行」：旧界面里这一栏的滚动容器（`.sidebar-scroll`）
 * 与「新会话」按钮都在会话列表这个组件里，壳只提供 `.sidebar` 这个外壳。壳把槽条目
 * 渲染成 `display:contents`，所以这里的根节点会成为 `.sidebar` 的直接子节点，
 * 与旧界面的层级一致——外层 flex 列布局因此不用改一行 CSS 就能对上。
 *
 * 数据来自宿主快照（`sessions` + `sessionStates` + `status.sessionPath`——**含归档会话**，
 * 归档显隐走「视图选项 → 筛选会话」三档，与旧界面同一形态），动作经界面通道调宿主方法。
 * 分组/树/搜索的纯数据整形在 `grouping.ts`（桌面端 sidebar-groups.ts 的移植）。
 *
 * 交互对齐旧界面的部分：搜索框、视图选项菜单（分组/排序/筛选三组单选，写回
 * `setUiPrefs`）、工作区分组行（展开态持久化 `sessionExpansion`）、每组默认 5 条
 * 「展开剩余」、会话行右键菜单（置顶/重命名/分叉/复制 ID/停止/归档/恢复）、
 * 双击标题改名、行级快捷键（Ctrl+Alt+R / Ctrl+Alt+F / Ctrl+Shift+A）、
 * 底部工作目录与用量行。
 *
 * @module dsc-ui-shell/plugins/sessions
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  IconArchive,
  IconArchiveOff,
  IconBranch,
  IconCheck,
  IconClock,
  IconClose,
  IconCopy,
  IconEdit,
  IconFolder,
  IconFolderOpen,
  IconFlatList,
  IconMore,
  IconPin,
  IconPlus,
  IconQueue,
  IconRefresh,
  IconSearch,
  IconSort,
  IconStop,
  IconSwap,
  IconTriangleRightFill,
  IconTree,
} from '@dsc/ui'
import {
  confirmAction,
  defineUiPlugin,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  type HostSnapshot,
  type SessionRunState,
  type SessionSummary,
} from '@dsc/ui'
import { buildWorkGroups, displayName, type ArchivedFilter, type GroupKey, type SortKey } from './grouping'

/** 空的会话列表常量：没拿到快照时共用一份，省得每帧新建数组。 */
const NO_SESSIONS: readonly SessionSummary[] = Object.freeze([])

/** 每组默认露几条（旧界面同款），「展开剩余」按这个数加量。 */
const PREVIEW_COUNT = 5

/** 归档确认框的说明文案（旧界面同款：把去向说清楚，不写「确定吗」）。 */
const ARCHIVE_DETAIL_ONE =
  '会话会离开侧栏，移进「设置 → 归档」的归档区；消息一个字不删，想回来去归档里点「恢复」。'

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

/** 侧栏本地的界面偏好副本（读写都走宿主 `getUiPrefs` / `setUiPrefs`）。 */
interface SidebarPrefs {
  group: GroupKey
  sort: SortKey
  archived: ArchivedFilter
  aliases: Record<string, string>
  /** 各工作区分组的展开状态（cwd → 展开？），与旧界面同键持久化。 */
  expansion: Record<string, boolean>
}

const DEFAULT_PREFS: SidebarPrefs = { group: 'workspace', sort: 'recent', archived: 'hide', aliases: {}, expansion: {} }

function SessionList() {
  const channel = useHostChannel()
  const sessions = useHostSelector(readSessions)
  const states = useHostSelector(readStates)
  const currentPath = useHostSelector(readCurrentPath)
  const loading = useHostSelector(readLoading)
  const cwd = useHostSelector(readCwd)
  const [fault, setFault] = useState<string | null>(null)
  /** 正在挑"从哪条消息分叉"（null = 没在挑）。 */
  const [forking, setForking] = useState<{ id: string; messages: string[] } | null>(null)
  /** 界面偏好（分组/排序/筛选/别名/展开态）：mount 时读宿主，选项改动写回。 */
  const [prefs, setPrefs] = useState<SidebarPrefs>(DEFAULT_PREFS)
  /** 搜索框：开关 + 关键词。 */
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  /** 视图选项菜单的视口定位（null = 收起）。 */
  const [viewMenu, setViewMenu] = useState<{ top: number; right: number } | null>(null)
  /** 行级菜单（会话右键 / 工作区 ···）：fixed 定位贴指针或按钮。 */
  const [menu, setMenu] = useState<{ kind: 'session' | 'group'; id: string; x: number; y: number } | null>(null)
  /** 每组露几条（cwd → 条数预算）；搜索时全量放开。 */
  const [limits, setLimits] = useState<Record<string, number>>({})
  /** 「切过去还没发消息」的工作区（原生桥才给得出；浏览器里没有就空着）。 */
  const [recentCwds, setRecentCwds] = useState<string[]>([])
  /** 正在改显示名的工作区（null = 没在改）。 */
  const [groupRenaming, setGroupRenaming] = useState<{ cwd: string; value: string } | null>(null)
  /** 正在改名的会话 id（右键菜单 / Ctrl+Alt+R 请求行内改名时置上）。 */
  const [renaming, setRenaming] = useState<string | null>(null)

  useEffect(() => {
    void channel.invoke('refreshSessions').catch((reason: unknown) => {
      setFault(reason instanceof Error ? reason.message : String(reason))
    })
    void channel
      .invoke<Record<string, unknown>>('getUiPrefs', [])
      .then((value) => {
        setPrefs({
          group: readEnum(value['sessionGroup'], ['workspace', 'tree', 'flat'] as const, 'workspace'),
          sort: readEnum(value['sessionSort'], ['recent', 'created'] as const, 'recent'),
          archived: readEnum(value['archivedFilter'], ['hide', 'show', 'only'] as const, 'hide'),
          aliases: readStringRecord(value['workspaceAliases']),
          expansion: readRecord(value['sessionExpansion']),
        })
      })
      .catch(() => undefined)
    // 最近工作区：只有桌面原生桥认识它；浏览器里没有，列表里就不出现空工作区。
    const native = getHostNative()
    if (native.available) {
      void native
        .invoke<string[]>('recentCwds')
        .then((list) => {
          setRecentCwds(Array.isArray(list) ? list : [])
        })
        .catch(() => undefined)
    }
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

  /** 改一条界面偏好：先落本地（界面立刻变），写回宿主；失败把本地改回去。 */
  const patchPrefs = (patch: Partial<SidebarPrefs>): void => {
    setPrefs((current) => ({ ...current, ...patch }))
    void (async () => {
      try {
        const body: Record<string, unknown> = {}
        if (patch.group !== undefined) body['sessionGroup'] = patch.group
        if (patch.sort !== undefined) body['sessionSort'] = patch.sort
        if (patch.archived !== undefined) body['archivedFilter'] = patch.archived
        if (patch.aliases !== undefined) body['workspaceAliases'] = patch.aliases
        if (patch.expansion !== undefined) body['sessionExpansion'] = patch.expansion
        await channel.invoke('setUiPrefs', [body])
      } catch (reason) {
        setPrefs((current) => ({ ...current, ...patchOfUndo(patch) }))
        toastErr(`界面偏好没写成功：${reason instanceof Error ? reason.message : String(reason)}`)
      }
    })()
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

  /** 改名（宿主写会话标题；名字为空 = 撤销改名，交回宿主自己的推断）。 */
  const rename = (id: string, name: string): void => {
    void run('renameSession', [id, name])
  }

  /**
   * 分叉：先问宿主「这条会话里有哪些用户消息」，弹一个小选择列表，选哪条就从那里分叉。
   *
   * 为什么不直接分叉在最后一条：分叉的意思是"从某一句话重来"，选哪句是用户的事
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

  /** 归档一条：先过确认框把去向说清楚（旧界面同一句文案），再动手。 */
  const archive = (id: string, title: string): void => {
    void (async () => {
      const ok = await confirmAction({
        title: `归档会话「${title}」？`,
        detail: ARCHIVE_DETAIL_ONE,
        confirmLabel: '归档',
      })
      if (!ok) return
      await run('archiveSessions', [[id]])
      await run('refreshSessions', [])
    })()
  }

  /** 从归档区恢复一条：恢复完刷新活列表（它会回到活列表里）。 */
  const restore = (path: string): void => {
    void (async () => {
      await run('restoreSessions', [[path]])
      await run('refreshSessions', [])
      toastOk('会话已恢复到列表')
    })()
  }

  /** 复制会话 ID（右键菜单项）：uuid 没法手抄，剪贴板是唯一正道。 */
  const copyId = (id: string): void => {
    void navigator.clipboard
      .writeText(id)
      .then(() => toastOk('会话 ID 已复制'))
      .catch((reason: unknown) => toastErr(`复制失败：${reason instanceof Error ? reason.message : String(reason)}`))
  }

  /** 改工作区显示名（别名写回 uiPrefs；空串 = 撤销别名，恢复真实目录名）。 */
  const renameGroup = (cwd: string, name: string): void => {
    const aliases = { ...prefs.aliases }
    if (name.trim() === '') delete aliases[cwd]
    else aliases[cwd] = name.trim()
    patchPrefs({ aliases })
    setGroupRenaming(null)
  }

  /** 点工作区行：只切换它自己（别的组不跟着动），展开态持久化。 */
  const toggleGroup = (key: string): void => {
    const expanded = prefs.expansion[key] ?? isDefaultExpanded(key, cwd, prefs.group)
    patchPrefs({ expansion: { ...prefs.expansion, [key]: !expanded } })
    // 收组重置这一组的「展开剩余」进度（旧界面同款：下次展开从头数 5 条）。
    setLimits((current) => {
      if (current[key] === undefined) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const trimmed = query.trim().toLowerCase()
  const groups = useMemo(
    () =>
      buildWorkGroups({
        sessions: [...sessions],
        recentCwds,
        cwd: cwd ?? '',
        sort: prefs.sort,
        group: prefs.group,
        archived: prefs.archived,
        trimmed,
        aliases: prefs.aliases,
      }),
    [sessions, recentCwds, cwd, prefs.sort, prefs.group, prefs.archived, trimmed, prefs.aliases],
  )
  /** 单列表档：不分工作区，会话混成一条流（不设条数上限）。 */
  const flatSessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups])


  return (
    <>
      <button type="button" className="btn-new" data-action="new-session" onClick={() => open()}>
        <IconPlus size={15} />
        新会话
      </button>

      <div className="sidebar-scroll">
        <div className="section-head">
          <span className="side-title">{prefs.group === 'flat' ? '会话' : '工作区'}</span>
          <span className="head-actions">
            <button
              type="button"
              className={`icon-btn${searching ? ' on' : ''}`}
              data-tip="搜索会话"
              aria-label="搜索会话"
              onClick={() => {
                setSearching((current) => !current)
                setQuery('')
              }}
            >
              <IconSearch size={15} />
            </button>
            <button
              type="button"
              className={`icon-btn${viewMenu !== null ? ' on' : ''}`}
              data-tip="视图选项：分组方式、排序方式、筛选会话"
              aria-label="视图选项"
              onClick={(event) => {
                if (viewMenu !== null) {
                  setViewMenu(null)
                  return
                }
                // 用视口坐标定位：菜单挂在滚动区里的头部上，就地绝对定位会被裁掉。
                const rect = event.currentTarget.getBoundingClientRect()
                const rail = event.currentTarget.closest('.sidebar')
                const edge = rail === null ? rect.right : rail.getBoundingClientRect().right - 6
                setViewMenu({ top: rect.bottom + 6, right: window.innerWidth - edge })
              }}
            >
              <IconSort size={15} />
            </button>
          </span>
        </div>

        {searching ? (
          <div className="side-search">
            <IconSearch size={14} />
            <input
              autoFocus
              placeholder="按会话名或目录名过滤"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Escape') {
                  setSearching(false)
                  setQuery('')
                }
              }}
            />
            <button
              type="button"
              className="icon-btn"
              data-tip="清除搜索"
              aria-label="清除搜索"
              onClick={() => setSearching(false)}
            >
              <IconClose size={14} />
            </button>
          </div>
        ) : null}

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

        {sessions.length === 0 && recentCwds.length === 0 ? (
          <div className="sidebar-empty">
            <IconQueue size={24} />
            <div>{loading ? '正在读会话列表…' : '还没有历史会话。'}</div>
            {loading ? null : <div>发送第一条消息开始。</div>}
          </div>
        ) : groups.length === 0 ? (
          <div className="sidebar-empty">
            <IconQueue size={24} />
            <div>
              {trimmed !== ''
                ? `没有匹配「${query.trim()}」的会话。`
                : prefs.archived === 'only'
                  ? '还没有已归档的会话。'
                  : '活动区没有会话了：归档的那些在「视图选项 → 仅显示已归档」里。'}
            </div>
          </div>
        ) : prefs.group === 'flat' ? (
          flatSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              state={states[session.id]}
              current={currentPath !== null && session.id === currentPath}
              renameRequest={renaming === session.id}
              onOpen={open}
              onPin={(pinned) => run('setSessionPinned', [session.id, pinned])}
              onArchive={() => archive(session.id, session.title ?? '新会话')}
              onRename={(name) => rename(session.id, name)}
              onRenameDone={() => setRenaming(null)}
              onFork={() => startFork(session.id)}
              onRestore={() => restore(session.id)}
              onMenu={(x, y) => setMenu({ kind: 'session', id: session.id, x, y })}
            />
          ))
        ) : (
          groups.map((group) => {
            const key = `w:${group.cwd}`
            const expanded = prefs.expansion[key] ?? isDefaultExpanded(key, cwd, prefs.group)
            const limit = trimmed !== '' ? Number.MAX_SAFE_INTEGER : (limits[key] ?? PREVIEW_COUNT)
            const visible = expanded ? group.sessions.slice(0, limit) : []
            const rest = group.sessions.length - visible.length
            return (
              <div key={group.cwd} className={`group depth-${Math.min(group.depth, 4)}`}>
                <div
                  className={`group-row${group.cwd === cwd ? ' active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  data-tip={`${group.cwd} · ${group.sessions.length} 个会话，点击展开/收起`}
                  onClick={() => toggleGroup(key)}
                  onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    toggleGroup(key)
                  }}
                >
                  <span className="folder-icon">
                    {expanded ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}
                  </span>
                  <span className="folder-chevron">
                    <IconTriangleRightFill size={14} className={expanded ? 'arrow-open' : undefined} />
                  </span>
                  {groupRenaming?.cwd === group.cwd ? (
                    <input
                      className="row-rename"
                      autoFocus
                      value={groupRenaming.value}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setGroupRenaming({ cwd: group.cwd, value: event.target.value })}
                      onBlur={() => renameGroup(group.cwd, groupRenaming.value)}
                      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                        event.stopPropagation()
                        if (event.key === 'Enter') renameGroup(group.cwd, groupRenaming.value)
                        if (event.key === 'Escape') setGroupRenaming(null)
                      }}
                    />
                  ) : (
                    <span className="dir">{displayName(group.cwd, prefs.aliases)}</span>
                  )}
                  <span
                    className="row-actions"
                    onClick={(event) => {
                      event.stopPropagation()
                    }}
                  >
                    {prefs.archived === 'only' && group.sessions.length > 0 ? (
                      <button
                        type="button"
                        className="icon-btn"
                        data-tip="把这个工作区的会话全部恢复"
                        aria-label="全部恢复"
                        onClick={() => {
                          void (async () => {
                            await run('restoreSessions', [group.sessions.map((session) => session.id)])
                            await run('refreshSessions', [])
                            toastOk(`已恢复 ${String(group.sessions.length)} 个会话`)
                          })()
                        }}
                      >
                        <IconRefresh size={14} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`icon-btn${menu?.kind === 'group' && menu.id === key ? ' on' : ''}`}
                      data-tip="更多操作"
                      aria-label="工作区更多操作"
                      onClick={(event) => {
                        // fixed 贴按钮：默认在按钮下方 6px；底部空间放不下（菜单最高约
                        // 5 项 ≈ 180px，留余量判 240）就翻到按钮上方 6px 向上伸展
                        //（row-menu 的 bottom 定位由样式表档兜着，这里简化成夹取 top）。
                        const rect = event.currentTarget.getBoundingClientRect()
                        const y = window.innerHeight - rect.bottom >= 240 ? rect.bottom + 6 : rect.top - 200
                        setMenu({ kind: 'group', id: key, x: Math.max(8, rect.right - 200), y: Math.max(8, y) })
                      }}
                    >
                      <IconMore size={15} />
                    </button>
                  </span>
                </div>
                {expanded
                  ? visible.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        state={states[session.id]}
                        current={currentPath !== null && session.id === currentPath}
                        renameRequest={renaming === session.id}
                        onOpen={open}
                        onPin={(pinned) => run('setSessionPinned', [session.id, pinned])}
                        onArchive={() => archive(session.id, session.title ?? '新会话')}
                        onRename={(name) => rename(session.id, name)}
                        onRenameDone={() => setRenaming(null)}
                        onFork={() => startFork(session.id)}
                        onRestore={() => restore(session.id)}
                        onMenu={(x, y) => setMenu({ kind: 'session', id: session.id, x, y })}
                      />
                    ))
                  : null}
                {expanded && trimmed === '' && group.sessions.length > PREVIEW_COUNT ? (
                  <button
                    type="button"
                    className="session-overflow"
                    aria-expanded={rest === 0}
                    onClick={() => {
                      setLimits((current) => ({
                        ...current,
                        [key]:
                          rest === 0
                            ? PREVIEW_COUNT
                            : rest <= PREVIEW_COUNT
                              ? Number.MAX_SAFE_INTEGER
                              : (current[key] ?? PREVIEW_COUNT) + PREVIEW_COUNT,
                      }))
                    }}
                  >
                    {rest === 0 ? '收起' : `展开剩余 ${String(rest)} 个会话`}
                  </button>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      {/* 视图选项菜单：按视口坐标定位，所以放在滚动区外面。三组单选（分组/排序/筛选），
          选中项打勾——与旧界面同一份文案。 */}
      {viewMenu === null ? null : (
        <>
          <div className="menu-backdrop" onClick={() => setViewMenu(null)} />
          <div
            className="row-menu view-menu"
            role="menu"
            style={{ position: 'fixed', top: `${String(viewMenu.top)}px`, right: `${String(viewMenu.right)}px` }}
          >
            <div className="menu-label">分组方式</div>
            {(
              [
                ['workspace', '按工作区', <IconFolder key="i" size={15} />],
                ['tree', '按工作区树', <IconTree key="i" size={15} />],
                ['flat', '单列表', <IconFlatList key="i" size={15} />],
              ] as const
            ).map(([id, text, icon]) => (
              <MenuRadio key={id} active={prefs.group === id} text={text} icon={icon} onPick={() => patchPrefs({ group: id })} />
            ))}
            <div className="menu-sep" />
            <div className="menu-label">排序方式</div>
            {(
              [
                ['recent', '最近更新', <IconClock key="i" size={15} />],
                ['created', '创建时间', <IconClock key="i" size={15} />],
              ] as const
            ).map(([id, text, icon]) => (
              <MenuRadio key={id} active={prefs.sort === id} text={text} icon={icon} onPick={() => patchPrefs({ sort: id })} />
            ))}
            <div className="menu-sep" />
            <div className="menu-label">筛选会话</div>
            {(
              [
                ['hide', '隐藏已归档', <IconArchiveOff key="i" size={15} />],
                ['show', '全部对话（显示已归档）', <IconQueue key="i" size={15} />],
                ['only', '仅显示已归档', <IconArchive key="i" size={15} />],
              ] as const
            ).map(([id, text, icon]) => (
              <MenuRadio
                key={id}
                active={prefs.archived === id}
                text={text}
                icon={icon}
                onPick={() => patchPrefs({ archived: id })}
              />
            ))}
          </div>
        </>
      )}

      {/* 行级菜单（会话右键 / 工作区 ···）：fixed 贴指针或按钮。内容按 kind 分两份。 */}
      {menu === null
        ? null
        : menu.kind === 'session'
          ? (() => {
              const session = sessions.find((item) => item.id === menu.id)
              if (session === undefined) return null
              const archived = session.archivedAt !== undefined
              const stoppable = states[session.id] === 'working' || states[session.id] === 'awaiting-approval'
              return (
                <>
                  <div className="menu-backdrop" onClick={() => setMenu(null)} />
                  <div
                    className="row-menu"
                    style={{
                      position: 'fixed',
                      left: Math.min(menu.x, window.innerWidth - 220),
                      top: Math.min(menu.y, window.innerHeight - 240),
                    }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {archived ? (
                      <MenuItem
                        icon={<IconRefresh size={15} />}
                        text="恢复会话"
                        onClick={() => {
                          setMenu(null)
                          restore(session.id)
                        }}
                      />
                    ) : (
                      <>
                        <MenuItem
                          icon={<IconPin size={15} />}
                          text={session.pinnedAt !== undefined ? '取消置顶' : '置顶会话'}
                          onClick={() => {
                            setMenu(null)
                            void run('setSessionPinned', [session.id, session.pinnedAt === undefined])
                          }}
                        />
                        <MenuItem
                          icon={<IconEdit size={15} />}
                          text="重命名"
                          hint="Ctrl+Alt+R"
                          onClick={() => {
                            setMenu(null)
                            setRenaming(session.id)
                          }}
                        />
                        <MenuItem
                          icon={<IconSwap size={15} />}
                          text="分叉会话"
                          hint="Ctrl+Alt+F"
                          onClick={() => {
                            setMenu(null)
                            startFork(session.id)
                          }}
                        />
                        <MenuItem
                          icon={<IconCopy size={15} />}
                          text="复制会话 ID"
                          onClick={() => {
                            setMenu(null)
                            copyId(session.id)
                          }}
                        />
                        {stoppable ? (
                          <MenuItem
                            icon={<IconStop size={15} />}
                            text="停止运行"
                            onClick={() => {
                              setMenu(null)
                              void run('interrupt', [session.id])
                            }}
                          />
                        ) : null}
                        <div className="menu-sep" />
                        <MenuItem
                          icon={<IconArchive size={15} />}
                          text="归档会话"
                          hint="Ctrl+Shift+A"
                          danger
                          onClick={() => {
                            setMenu(null)
                            archive(session.id, session.title ?? '新会话')
                          }}
                        />
                      </>
                    )}
                  </div>
                </>
              )
            })()
          : (() => {
              const cwdOf = menu.id.slice(2)
              const group = groups.find((item) => item.cwd === cwdOf)
              if (group === undefined) return null
              return (
                <>
                  <div className="menu-backdrop" onClick={() => setMenu(null)} />
                  <div
                    className="row-menu"
                    style={{ position: 'fixed', left: menu.x, top: menu.y }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MenuItem
                      icon={<IconFolderOpen size={15} />}
                      text="在资源管理器中打开"
                      onClick={() => {
                        setMenu(null)
                        const native = getHostNative()
                        if (!native.available) {
                          toastErr('在资源管理器中打开要用桌面版（浏览器里没有原生桥）')
                          return
                        }
                        void native.invoke('openPath', [cwdOf]).catch((reason: unknown) => {
                          toastErr(`打开失败：${reason instanceof Error ? reason.message : String(reason)}`)
                        })
                      }}
                    />
                    <MenuItem
                      icon={<IconEdit size={15} />}
                      text="重命名显示名"
                      onClick={() => {
                        setMenu(null)
                        setGroupRenaming({ cwd: cwdOf, value: displayName(cwdOf, prefs.aliases) })
                      }}
                    />
                    {prefs.aliases[cwdOf] !== undefined ? (
                      <MenuItem
                        icon={<IconClose size={15} />}
                        text="恢复真实目录名"
                        onClick={() => {
                          setMenu(null)
                          renameGroup(cwdOf, '')
                        }}
                      />
                    ) : null}
                    {prefs.archived === 'only' && group.sessions.length > 0 ? (
                      <>
                        <div className="menu-sep" />
                        <MenuItem
                          icon={<IconRefresh size={15} />}
                          text={`恢复这 ${String(group.sessions.length)} 个会话`}
                          onClick={() => {
                            setMenu(null)
                            void (async () => {
                              await run('restoreSessions', [group.sessions.map((session) => session.id)])
                              await run('refreshSessions', [])
                              toastOk(`已恢复 ${String(group.sessions.length)} 个会话`)
                            })()
                          }}
                        />
                      </>
                    ) : null}
                  </div>
                </>
              )
            })()}

      <SidebarFooter />
    </>
  )
}

/** 视图菜单里的一组单选项（label + 打勾）。 */
function MenuRadio({
  active,
  text,
  icon,
  onPick,
}: {
  active: boolean
  text: string
  icon: React.ReactNode
  onPick: () => void
}): React.ReactNode {
  return (
    <button type="button" className={`menu-item${active ? ' on' : ''}`} role="menuitemradio" aria-checked={active} onClick={onPick}>
      {icon}
      <span className="menu-text">{text}</span>
      <span className="menu-check">{active ? <IconCheck size={14} /> : null}</span>
    </button>
  )
}

/** 行级菜单里的一项（图标 + 文案 + 可选快捷键提示；danger 走红字档）。 */
function MenuItem({
  icon,
  text,
  hint,
  danger,
  onClick,
}: {
  icon: React.ReactNode
  text: string
  hint?: string
  danger?: boolean
  onClick: () => void
}): React.ReactNode {
  return (
    <button type="button" className={`menu-item${danger === true ? ' danger' : ''}`} onClick={onClick}>
      {icon} {text}
      {hint === undefined ? null : <span className="menu-key">{hint}</span>}
    </button>
  )
}

/** 侧栏底部（旧界面同位）：当前工作目录 + 当前会话用量。 */
function SidebarFooter(): React.ReactNode {
  const cwd = useHostSelector(readCwd)
  const usage = useHostSelector(readUsageTokens)
  return (
    <div className="sidebar-footer">
      <div className="row" data-tip={cwd === null ? '还没有工作目录' : cwd}>
        <IconFolder size={14} />
        <span className="dir">{cwd === null ? '没有工作目录' : cwd}</span>
      </div>
      {usage === null ? null : (
        <div className="row" data-tip="当前会话累计用量（输入 + 输出）">
          <IconQueue size={14} />
          <span>会话用量</span>
          <span className="num">{compactTokens(usage)} tok</span>
        </div>
      )}
    </div>
  )
}

/** 用量的紧凑读法（K/M 压短；底部一行放不下千分位全值，悬浮卡有详情）。 */
function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(Math.round(value))
}

/** 从枚举字段读一个已知取值；线上来的值对不上就回落默认（旧值/新值混跑时的兜底）。 */
function readEnum<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback
}

/** 从字符串表字段读一个记录（值必须是字符串）；线上不是对象就给空表。 */
function readStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

/** 从布尔表字段读一个记录（sessionExpansion 是 cwd → 展开？）；线上不是对象就给空表。 */
function readRecord(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, boolean> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'boolean') out[key] = item
  }
  return out
}

/**
 * 分组展开的默认态（与旧界面同一口径）：当前工作区的组展开，其余收起。
 * 显式写过的键（sessionExpansion 里有的）优先于这个默认。
 */
function isDefaultExpanded(key: string, cwd: string | null, group: GroupKey): boolean {
  if (group === 'tree') return true
  return cwd !== null && key === `w:${cwd}`
}

/** patchPrefs 的撤销面：把刚打的补丁逐字段退回去。 */
function patchOfUndo(patch: Partial<SidebarPrefs>): Partial<SidebarPrefs> {
  const undo: Partial<SidebarPrefs> = {}
  if (patch.group !== undefined) undo.group = DEFAULT_PREFS.group
  if (patch.sort !== undefined) undo.sort = DEFAULT_PREFS.sort
  if (patch.archived !== undefined) undo.archived = DEFAULT_PREFS.archived
  if (patch.aliases !== undefined) undo.aliases = DEFAULT_PREFS.aliases
  if (patch.expansion !== undefined) undo.expansion = DEFAULT_PREFS.expansion
  return undo
}

/** 一行会话。DOM 与 class 照旧版 `Sidebar.tsx:579-825`，行根是 div 扮按钮（不是 button）。 */
function SessionRow({
  session,
  state,
  current,
  renameRequest,
  onOpen,
  onPin,
  onArchive,
  onRename,
  onRenameDone,
  onFork,
  onRestore,
  onMenu,
}: {
  session: SessionSummary
  state: SessionRunState | undefined
  current: boolean
  /** 外面（右键菜单 / 行级快捷键）请求进入改名：true 那一拍自动亮出输入框。 */
  renameRequest: boolean
  onOpen: (id?: string) => void
  onPin: (pinned: boolean) => void
  onArchive: () => void
  onRename: (name: string) => void
  onRenameDone: () => void
  onFork: () => void
  /** 归档行尾那颗「恢复」。 */
  onRestore: () => void
  /** 右键（或长按）：把指针位置交给上层画行级菜单。 */
  onMenu: (x: number, y: number) => void
}) {
  /** 改名中的草稿（null = 没在改名）。回车提交、Esc 撤销、失焦也算提交。 */
  const [draft, setDraft] = useState<string | null>(null)
  const pinned = session.pinnedAt !== undefined
  const archived = session.archivedAt !== undefined
  const title = session.title ?? '新会话'
  const dot = state === undefined ? undefined : DOT_CLASS[state]
  const dotLabel = state === undefined ? '' : DOT_LABEL[state]

  // 外面请求改名（右键菜单 / Ctrl+Alt+R）：这一拍亮出输入框，请求随即清掉。
  useEffect(() => {
    if (renameRequest) {
      setDraft(session.title ?? '')
      onRenameDone()
    }
  }, [renameRequest, session.title, onRenameDone])

  /** 行级快捷键（焦点在行上）：重命名 / 分叉 / 归档，与右键菜单同一批动作。 */
  const rowKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!event.ctrlKey && !event.metaKey) return
    const lower = event.key.toLowerCase()
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen(session.id)
      return
    }
    if (event.ctrlKey && event.altKey && lower === 'r') {
      event.preventDefault()
      if (!archived) {
        setDraft(session.title ?? '')
      }
      return
    }
    if (event.ctrlKey && event.altKey && lower === 'f') {
      event.preventDefault()
      onFork()
      return
    }
    if (event.ctrlKey && event.shiftKey && lower === 'a') {
      event.preventDefault()
      if (!archived) onArchive()
    }
  }

  /** 行内按钮的点击不该顺带开会话（旧版也是这么拦的）。 */
  const stop = (event: MouseEvent): void => {
    event.stopPropagation()
  }

  return (
    <div
      className={`sess-item${current ? ' active' : ''}${archived ? ' archived' : ''}`}
      role="button"
      tabIndex={0}
      data-tip={`${title}；回车打开，右键更多操作`}
      onClick={() => onOpen(session.id)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        rowKeys(event)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(event.clientX, event.clientY)
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
        <span
          className="title"
          onDoubleClick={(event) => {
            // 双击标题改名（旧界面行为）；归档行不给改（宿主只认活动区路径）。
            event.stopPropagation()
            if (!archived) setDraft(session.title ?? '')
          }}
        >
          {title}
        </span>
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
      <span className="when">{relativeTime(archived ? (session.archivedAt ?? session.updatedAt) : session.updatedAt)}</span>

      {/* 行尾 hover 钮对齐旧界面：只剩归档/恢复一件事——重命名/分叉/复制都在右键菜单里。 */}
      <span className="row-actions" onClick={stop}>
        {archived ? (
          <button
            type="button"
            className="icon-btn"
            data-tip="恢复到会话列表"
            aria-label="恢复会话"
            onClick={() => onRestore()}
          >
            <IconArchiveOff size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            data-tip="归档这个会话"
            aria-label="归档这个会话"
            onClick={onArchive}
          >
            <IconArchive size={14} />
          </button>
        )}
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

/** 当前会话的工作目录（底部行显示）。 */
function readCwd(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['cwd']
  return typeof value === 'string' && value !== '' ? value : null
}

/** 当前会话的累计 token 用量（输入 + 输出；宿主没回过用量时 null）。 */
function readUsageTokens(snapshot: HostSnapshot | null): number | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const usage = (status as Record<string, unknown>)['usage']
  if (typeof usage !== 'object' || usage === null) return null
  const input = (usage as Record<string, unknown>)['inputTokens']
  const output = (usage as Record<string, unknown>)['outputTokens']
  if (typeof input !== 'number' || typeof output !== 'number') return null
  return input + output
}
