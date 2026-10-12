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
 * **手动排序拖拽**（工作区行拖动排序写 `workspaceOrder`；manual 档会话行在
 * 同一置顶块内互拖写 `sessionOrder`；指示线与「放到最后」落点同款）、
 * 底部工作目录与用量行。
 *
 * @module dsc-ui-shell/plugins/sessions
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  IconArchive,
  IconBolt,
  IconArchiveOff,
  IconBranch,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconClose,
  IconCode,
  IconCoins,
  IconCopy,
  IconEdit,
  IconFolder,
  IconFolderOpen,
  IconGear,
  IconFlatList,
  IconMore,
  IconNewChat,
  IconPin,
  IconPuzzle,
  IconPlus,
  IconQueue,
  IconRefresh,
  IconSearch,
  IconSort,
  IconStop,
  IconSwap,
  IconTerminal,
  IconTrash,
  IconTriangleRightFill,
  IconTree,
} from '@dsc/ui'
import {
  confirmAction,
  defineUiPlugin,
  getHostNative,
  setShellPage,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  useShellPage,
  type HostSnapshot,
  type SessionRunState,
  type SessionSummary,
} from '@dsc/ui'
import { buildWorkGroups, displayName, lastSegment, moveToEnd, moveWithin, orderedSessions, type ArchivedFilter, type GroupKey, type SortKey } from './grouping'

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
    // 顶栏的工作区打开组（旧界面同款：主钮开资源管理器，下拉里还有终端 / VS Code / 复制路径）。
    ui.slots.register('shell.header', { id: 'sessions.workspace-open', order: 10 }, WorkspaceOpenGroup)
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

/** 运行状态 → 悬浮说明（旧界面同一套说法）。 */
const DOT_LABEL: Readonly<Record<SessionRunState, string>> = {
  working: '这个会话正在跑',
  'awaiting-approval': '挂着等你审批',
  'just-finished': '后台已完成（点开查看）',
}

/** 侧栏本地的界面偏好副本（读写都走宿主 `getUiPrefs` / `setUiPrefs`）。 */
interface SidebarPrefs {
  group: GroupKey
  sort: SortKey
  archived: ArchivedFilter
  aliases: Record<string, string>
  /** 各工作区分组的展开状态（cwd → 展开？），与旧界面同键持久化。 */
  expansion: Record<string, boolean>
  /** 手动拖出来的工作区顺序（workspaceOrder）与组内会话顺序（sessionOrder）。 */
  order: string[]
  sessionOrder: Record<string, string[]>
}

const DEFAULT_PREFS: SidebarPrefs = {
  group: 'workspace',
  sort: 'manual',
  archived: 'hide',
  aliases: {},
  expansion: {},
  order: [],
  sessionOrder: {},
}

function SessionList() {
  const channel = useHostChannel()
  const sessions = useHostSelector(readSessions)
  const states = useHostSelector(readStates)
  const currentPath = useHostSelector(readCurrentPath)
  const loading = useHostSelector(readLoading)
  const cwd = useHostSelector(readCwd)
  /** 主区是不是顶在插件页上（侧栏「插件」入口的点亮态与再点回退）。 */
  const page = useShellPage()
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
  /** 工作区行拖拽（旧界面 dragCwd / dropAt 同款）：源 cwd 与落点（哪一组、上半还是下半）。 */
  const [dragCwd, setDragCwd] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ cwd: string; after: boolean } | null>(null)
  /** 会话行拖拽（manual 档、同一组、同一置顶块内互拖）。 */
  const [sessDrag, setSessDrag] = useState<{
    cwd: string
    id: string
    pinned: boolean
    over: { id: string; half: 'before' | 'after' } | null
  } | null>(null)
  /** 刚拖完的那一下会带一次 click：短暂压住组行的展开/收起（旧界面 justDragged 同款）。 */
  const justDragged = useRef(false)

  useEffect(() => {
    void channel.invoke('refreshSessions').catch((reason: unknown) => {
      setFault(reason instanceof Error ? reason.message : String(reason))
    })
    void channel
      .invoke<Record<string, unknown>>('getUiPrefs', [])
      .then((value) => {
        setPrefs({
          group: readEnum(value['sessionGroup'], ['workspace', 'tree', 'flat'] as const, 'workspace'),
          // 缺省档对齐宿主与旧界面：`manual`（宿主 prefs 的出厂值就是它）。
          sort: readEnum(value['sessionSort'], ['manual', 'recent', 'created'] as const, 'manual'),
          archived: readEnum(value['archivedFilter'], ['hide', 'show', 'only'] as const, 'hide'),
          aliases: readStringRecord(value['workspaceAliases']),
          expansion: readRecord(value['sessionExpansion']),
          order: readStringList(value['workspaceOrder']),
          sessionOrder: readStringListRecord(value['sessionOrder']),
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

  /**
   * 跑一个会话库操作（旧界面 `Sidebar.tsx` 的 run 同款）：SettingsMutation 形状的回执
   * 按 ok / notice / error 报 Toast，成功后再刷新一次列表；非 mutation 形状的调用
   * （openSession / refreshSessions / interrupt 这些回 void）原样过，各自的调用点管回执。
   *
   * 为什么必须认回执：宿主的方法失败时返回 `{ok:false, error}` 而不是抛——只看「没抛」
   * 就把失败当成功，界面会静静地什么都不发生（重命名没改、归档没动，用户只会以为卡了）。
   */
  const run = async (method: string, args: unknown[], then?: () => void): Promise<void> => {
    setFault(null)
    try {
      const result = await channel.invoke<unknown>(method, args)
      if (result !== null && typeof result === 'object' && typeof (result as { ok?: unknown }).ok === 'boolean') {
        const reply = result as { ok: boolean; error?: unknown; notice?: unknown }
        if (!reply.ok) {
          toastErr(`操作失败：${typeof reply.error === 'string' ? reply.error : '宿主没说什么原因'}`)
          return
        }
        toastOk(typeof reply.notice === 'string' && reply.notice !== '' ? reply.notice : '已完成')
        await channel.invoke('refreshSessions', [])
        then?.()
      }
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
        if (patch.order !== undefined) body['workspaceOrder'] = patch.order
        if (patch.sessionOrder !== undefined) body['sessionOrder'] = patch.sessionOrder
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
   *
   * 开任何会话同时也回对话页（旧界面 `openSession` 里 `setView('chat')` 同款）：
   * 在技能/插件整页上点会话不该把页留在原地。
   */
  const open = (id?: string): void => {
    setShellPage(null)
    void (async () => {
      await run('openSession', id === undefined ? [] : [id])
      await run('refreshSessions', [])
    })()
  }

  /**
   * 在指定工作区里新建会话（工作区行那颗「新建会话」钮，旧界面 newSessionIn 同款）。
   *
   * 新会话的 cwd 是宿主进程启动时的目录，换工作区要先切目录（原生桥 switchCwd
   * 返回值就等在那里）；切不过去（目录被删、宿主起不来）把原因摊出来，不冒出一句假成功。
   */
  const newSessionIn = (target: string): void => {
    if (target === (cwd ?? '')) {
      open()
      return
    }
    const native = getHostNative()
    if (!native.available) {
      toastErr('在别的工作区新建会话要用桌面版（浏览器里没有切目录的原生桥）')
      return
    }
    void (async () => {
      setFault(null)
      try {
        const result = await native.invoke<{ ok: boolean; cwd?: string; error?: string }>('switchCwd', [target])
        if (result !== null && typeof result === 'object' && result.ok === false) {
          setFault(result.error ?? '切换工作目录失败')
          return
        }
        open()
      } catch (reason) {
        setFault(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }

  /** 改名（宿主写会话标题；名字为空 = 撤销改名，交回宿主自己的推断）。 */
  const rename = (id: string, name: string): void => {
    void run('renameSession', [id, name])
  }

  /**
   * 删除工作区（组菜单，旧界面 onDeleteWorkspace 同款）：先把目录从最近列表撤下
   * （空组立即消失，不用等归档回包），再归档该组全部会话。归档失败时组会随会话行
   * 重新出现（分组按会话 cwd 兜底），不会丢数据。
   */
  const deleteWorkspace = (target: string, sessionsOfGroup: readonly SessionSummary[]): void => {
    void (async () => {
      const count = sessionsOfGroup.length
      const detail =
        count > 0
          ? `其下 ${String(count)} 个会话会全部归档（移进「设置 → 归档」，消息一个字不删，可恢复），工作区从侧栏移除。`
          : '该工作区还没有会话，将从侧栏移除。'
      const current = target === (cwd ?? '') ? '它仍是当前目录，新建会话后会重新出现在侧栏。' : ''
      const ok = await confirmAction({
        title: `删除工作区「${displayName(target, prefs.aliases)}」？`,
        detail: detail + current,
        confirmLabel: '删除',
      })
      if (!ok) return
      setRecentCwds((list) => list.filter((item) => item !== target))
      const native = getHostNative()
      if (native.available) {
        void native.invoke('removeRecentCwd', [target]).catch(() => undefined)
      }
      if (count === 0) {
        toastOk('已从侧栏移除该工作区')
        return
      }
      try {
        await channel.invoke('archiveSessions', [sessionsOfGroup.map((session) => session.id)])
        await run('refreshSessions', [])
        toastOk(`工作区已删除，${String(count)} 个会话已归档`)
      } catch {
        toastErr('会话归档失败，工作区随会话保留在侧栏')
      }
    })()
  }

  /** 窄栏（壳画的 rail）上的「新会话」经事件请这里开：监听器常驻，读最新的 open。 */
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const onNew = (): void => {
      openRef.current()
    }
    window.addEventListener('shell.session.new', onNew)
    return () => window.removeEventListener('shell.session.new', onNew)
  }, [])

  /**
   * 分叉：先问宿主「这条会话里有哪些用户消息」，弹一个小选择列表，选哪条就从那里分叉。
   *
   * 为什么不直接分叉在最后一条：分叉的意思是"从某一句话重来"，选哪句是用户的事
   * （旧界面同样先列用户消息再点）。位置不足两条直接报错不开框（旧界面同一句文案）。
   */
  const startFork = (id: string): void => {
    void (async () => {
      setFault(null)
      try {
        const messages = await channel.invoke<string[]>('listUserMessages', [id])
        if (messages.length < 2) {
          toastErr('可分叉的位置不足，至少需要两条用户消息')
          return
        }
        setForking({ id, messages })
      } catch (reason) {
        setFault(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }

  /** 真的分叉：宿主复制到第 index 条用户消息之前，返回新会话路径；分完打开它（旧界面同款回执）。 */
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
        toastOk(`已分叉出新会话，包含第 ${String(index + 1)} 条消息之前的内容`)
      } catch (reason) {
        setFault(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }

  /** 归档一条：先过确认框把去向说清楚（旧界面同一句文案），再动手（回执与刷新走 run）。 */
  const archive = (id: string, title: string): void => {
    void (async () => {
      const ok = await confirmAction({
        title: `归档会话「${title}」？`,
        detail: ARCHIVE_DETAIL_ONE,
        confirmLabel: '归档',
      })
      if (!ok) return
      await run('archiveSessions', [[id]])
    })()
  }

  /** 从归档区恢复一条（回执与刷新走 run——旧界面对归档/恢复一视同仁）。 */
  const restore = (path: string): void => {
    void run('restoreSessions', [[path]])
  }

  /**
   * 复制会话 ID：写进剪贴板的是会话 uuid，不是标题、也不是 jsonl 的完整路径。
   *
   * 注意 `SessionSummary.id` 存的是 jsonl 的绝对路径（宿主契约），uuid 只是它的文件名，
   * 所以这里先剥一层（旧界面同款）。
   */
  const copyId = (id: string): void => {
    const uuid = lastSegment(id).replace(/\.jsonl$/, '')
    void navigator.clipboard
      .writeText(uuid)
      .then(() => toastOk('已复制会话 ID'))
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
    patchPrefs({ expansion: { ...prefs.expansion, [key]: !isExpandedGroup(key) } })
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
        order: prefs.order,
        sessionOrder: prefs.sessionOrder,
      }),
    [sessions, recentCwds, cwd, prefs.sort, prefs.group, prefs.archived, trimmed, prefs.aliases, prefs.order, prefs.sessionOrder],
  )
  /** 单列表档：不分工作区，会话混成一条流（不设条数上限）。 */
  const flatSessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups])
  /** 树里带子分组的行（折叠它要连带收起后代，且默认展开；旧界面 parents 同款）。 */
  const parents = useMemo(() => new Set(groups.filter((item) => item.hasChildren).map((item) => item.cwd)), [groups])

  /**
   * 组行的活动指示跟选中会话走（旧界面 activeCwd 同口径）：跨工作区点开历史会话时，
   * 所属工作区的图标也跟着亮；没有选中会话（或它被筛出列表）时回落宿主 cwd。
   */
  const activeCwd = useMemo(() => {
    if (currentPath !== null) {
      const owner = sessions.find((session) => session.id === currentPath)
      if (owner !== undefined) return owner.cwd
    }
    return cwd
  }, [sessions, currentPath, cwd])

  /**
   * 当前工作区（树模式连同祖先链）自动展开并落盘——旧界面 `setGroupExpanded(currentGroup, true)`
   * 的同款：点开哪个工作区的会话，那个组就保持展开，切走再回来也不会塌。
   *
   * 「没有记录才补展开」的守卫（旧界面 Object.hasOwn 同款）：用户显式收起过的组必须尊重，
   * 否则会话列表一刷新 effect 重跑就把收起弹回去了。展开键直接用 cwd（与旧界面同一份
   * 落盘格式——老界面里存下的展开了的组，切回壳里照样认得）。
   */
  useEffect(() => {
    if (cwd === null || cwd === '') return
    const chain = [cwd]
    if (prefs.group === 'tree') {
      for (const item of groups) {
        if (item.cwd === cwd) chain.push(...item.ancestors)
      }
    }
    const patch: Record<string, boolean> = {}
    for (const key of chain) {
      if (prefs.expansion[key] === undefined) patch[key] = true
    }
    if (Object.keys(patch).length === 0) return
    patchPrefs({ expansion: { ...prefs.expansion, ...patch } })
    // patchPrefs 每次渲染都是新函数，这条 effect 只认 cwd / group / groups 这几个真值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, prefs.group, groups])

  /** 一组的展开真值（旧界面 isExpanded 同口径）：显式记录 → 默认档（树模式父节点展开、
   *  其余只有当前工作区展开）；搜索时照旧全部展开。 */
  const isExpandedGroup = (cwdOf: string): boolean => {
    if (trimmed !== '') return true
    return prefs.expansion[cwdOf] ?? isDefaultExpanded(cwdOf, cwd, prefs.group, parents)
  }

  /** 祖先里只要有一个被折叠，这一组就不出现在列表里（树折叠是连带收后代）。 */
  const hiddenByAncestor = (item: (typeof groups)[number]): boolean =>
    item.ancestors.slice(0, -1).some((ancestor) => !isExpandedGroup(ancestor))

  // ── 手动排序拖拽（旧界面 Sidebar.tsx 的同款语义）────────────────────────────

  /** 把源工作区挪到落点之前/之后，其余保持当前视觉顺序（顺序没变就不写盘）。 */
  const reorder = (source: string, target: string, after: boolean): void => {
    const current = groups.map((item) => item.cwd)
    const next = moveWithin(current, source, target, after)
    if (next.join('\n') === current.join('\n')) return
    patchPrefs({ order: next })
  }

  /** 拖到列表末尾的落点（「放到最后」）。 */
  const dropAtEnd = (source: string): void => {
    const current = groups.map((item) => item.cwd)
    const next = moveToEnd(current, source)
    if (next.join('\n') === current.join('\n')) return
    patchPrefs({ order: next })
  }

  /** 一次工作区拖拽收尾：清掉指示线，并短暂压制紧随其后的 click（点一下组行会展开/收起）。 */
  const endDrag = (): void => {
    setDragCwd(null)
    setDropAt(null)
    justDragged.current = true
    setTimeout(() => {
      justDragged.current = false
    }, 150)
  }

  /** 点工作区行 = 只切换它自己的展开/收起；刚拖完那一拍不触发。 */
  const clickGroup = (key: string): void => {
    if (justDragged.current) return
    toggleGroup(key)
  }

  /** 会话行拖拽的行内落点（指针在行的上/下半段，旧界面同款）。 */
  const sessRowHalf = (event: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  /**
   * 会话行拖拽收尾：把来源会话插到落点之前/之后，保存这一组的完整会话顺序。
   * 置顶块约束由拖拽侧保证（只允许同块目标），这里再按块校验一遍插入位，跨块的落点直接丢弃。
   */
  const commitSessDrag = (): void => {
    const current = sessDrag
    setSessDrag(null)
    if (current === null || current.over === null) return
    const { cwd: groupCwd, id: sourceId, pinned, over } = current
    if (over.id === sourceId) return
    const group = groups.find((item) => item.cwd === groupCwd)
    if (group === undefined) return
    const ordered = orderedSessions(groupCwd, group.sessions, prefs.sort, prefs.sessionOrder)
    const full = ordered.map((session) => session.id)
    const section = ordered.filter((session) => (session.pinnedAt !== undefined) === pinned)
    const sourceIndex = section.findIndex((session) => session.id === sourceId)
    if (sourceIndex === -1) return
    const withoutSource = section.filter((session) => session.id !== sourceId)
    const insertAt = withoutSource.findIndex((session) => session.id === over.id) + (over.half === 'after' ? 1 : 0)
    if (insertAt === sourceIndex) return
    const next = full.filter((id) => id !== sourceId)
    const targetIndex = next.indexOf(over.id)
    if (targetIndex === -1) return
    next.splice(targetIndex + (over.half === 'after' ? 1 : 0), 0, sourceId)
    patchPrefs({ sessionOrder: { ...prefs.sessionOrder, [groupCwd]: next } })
  }

  /**
   * 一行会话的拖拽参数（manual 档才有）：归档行不拖；只有同组、同置顶块的行接落点
   * （别的行不给 onDragOver，指针划过去不认——旧界面 dragCompatible 同款）。
   */
  const dragFor = (groupCwd: string, session: SessionSummary): {
    enabled: boolean
    mark: 'before' | 'after' | null
    onStart: (event: DragEvent<HTMLDivElement>) => void
    onOver?: (event: DragEvent<HTMLDivElement>) => void
    onDrop?: (event: DragEvent<HTMLDivElement>) => void
    onEnd: () => void
  } => {
    const compatible =
      sessDrag !== null && sessDrag.cwd === groupCwd && sessDrag.pinned === (session.pinnedAt !== undefined)
    return {
      enabled: prefs.sort === 'manual' && session.archivedAt === undefined,
      mark: sessDrag !== null && sessDrag.over !== null && sessDrag.over.id === session.id ? sessDrag.over.half : null,
      onStart: (event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', session.id)
        setSessDrag({ cwd: groupCwd, id: session.id, pinned: session.pinnedAt !== undefined, over: null })
      },
      onOver: compatible
        ? (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            const half = sessRowHalf(event)
            setSessDrag((current) =>
              current === null || (current.over?.id === session.id && current.over.half === half)
                ? current
                : { ...current, over: { id: session.id, half } },
            )
          }
        : undefined,
      onDrop: compatible
        ? (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault()
            commitSessDrag()
          }
        : undefined,
      onEnd: commitSessDrag,
    }
  }

  return (
    <>
      <button type="button" className="btn-new" data-action="new-session" onClick={() => open()}>
        <IconPlus size={15} />
        新会话
      </button>

      {/* 技能/插件一级入口（旧界面侧栏同位）：两个都是**主区独立整页**（旧界面同款），
          再点一次回对话页。 */}
      <nav className="sidebar-nav">
        <button
          type="button"
          className={`nav-item${page === 'skills' ? ' on' : ''}`}
          aria-pressed={page === 'skills'}
          onClick={() => {
            setShellPage(page === 'skills' ? null : 'skills')
          }}
        >
          <IconBolt size={15} /> 技能
        </button>
        <button
          type="button"
          className={`nav-item${page === 'plugins' ? ' on' : ''}`}
          aria-pressed={page === 'plugins'}
          onClick={() => {
            setShellPage(page === 'plugins' ? null : 'plugins')
          }}
        >
          <IconPuzzle size={15} /> 插件
        </button>
      </nav>

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
            <AddWorkspaceButton />
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
              sort={prefs.sort}
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
          <>
            {groups.filter((group) => !hiddenByAncestor(group)).map((group) => {
            const key = group.cwd
            const expanded = isExpandedGroup(key)
            const limit = trimmed !== '' ? Number.MAX_SAFE_INTEGER : (limits[key] ?? PREVIEW_COUNT)
            const visible = expanded ? group.sessions.slice(0, limit) : []
            const rest = group.sessions.length - visible.length
            // 拖拽排序只属于「按工作区」这一档：树顺序由目录层级决定，单列表没有工作区行
            const sortable = prefs.group === 'workspace' && groupRenaming === null
            // 指示线画在整个工作区块的上沿或下沿，也就是两组之间
            const drop =
              dropAt !== null && dropAt.cwd === group.cwd && dragCwd !== group.cwd
                ? dropAt.after
                  ? ' drop-below'
                  : ' drop-above'
                : ''
            return (
              <div key={group.cwd} className={`group depth-${Math.min(group.depth, 4)}${drop}`}>
                <div
                  className={`group-row${group.cwd === activeCwd ? ' active' : ''}${dragCwd === group.cwd ? ' dragging' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  data-tip={`${group.cwd} · ${group.sessions.length} 个会话，点击展开/收起${sortable ? '，拖动排序' : ''}`}
                  draggable={sortable}
                  onClick={() => clickGroup(key)}
                  onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      toggleGroup(key)
                      return
                    }
                    // 行级快捷键（旧界面 rowKeys 同款）：Ctrl+Alt+R 改这个工作区的显示名。
                    if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'r') {
                      event.preventDefault()
                      setGroupRenaming({ cwd: group.cwd, value: displayName(group.cwd, prefs.aliases) })
                    }
                  }}
                  onDragStart={(event: DragEvent<HTMLDivElement>) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', group.cwd)
                    setDragCwd(group.cwd)
                  }}
                  onDragOver={(event: DragEvent<HTMLDivElement>) => {
                    if (dragCwd === null || dragCwd === group.cwd) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    // 鼠标停在这一行的上半段就插到它前面，下半段就插到它后面
                    const rect = event.currentTarget.getBoundingClientRect()
                    const after = event.clientY > rect.top + rect.height / 2
                    if (dropAt === null || dropAt.cwd !== group.cwd || dropAt.after !== after) {
                      setDropAt({ cwd: group.cwd, after })
                    }
                  }}
                  onDrop={(event: DragEvent<HTMLDivElement>) => {
                    event.preventDefault()
                    const source = event.dataTransfer.getData('text/plain') || dragCwd
                    const after = dropAt !== null && dropAt.cwd === group.cwd ? dropAt.after : false
                    if (source !== null && source !== '') reorder(source, group.cwd, after)
                    endDrag()
                  }}
                  onDragEnd={endDrag}
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
                          void run('restoreSessions', [group.sessions.map((session) => session.id)])
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
                    {/* 行尾第二颗（旧界面同款）：在这个工作区里新建会话——
                        当前工作区直接开新会话，别的区先切目录（宿主重启）再开。 */}
                    <button
                      type="button"
                      className="icon-btn"
                      data-tip={`在 ${displayName(group.cwd, prefs.aliases)} 新建会话`}
                      aria-label="在此工作区新建会话"
                      onClick={() => {
                        newSessionIn(group.cwd)
                      }}
                    >
                      <IconNewChat size={15} />
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
                        sort={prefs.sort}
                        renameRequest={renaming === session.id}
                        drag={dragFor(group.cwd, session)}
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
          })}
            {/* 拖动时才对出现：整列表末尾的落点，保证「放到最后一个」永远有地方放 */}
            {dragCwd !== null && prefs.group === 'workspace' && groups.length > 1 ? (
              <div
                className="drop-tail"
                onDragOver={(event: DragEvent<HTMLDivElement>) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropAt(null)
                }}
                onDrop={(event: DragEvent<HTMLDivElement>) => {
                  event.preventDefault()
                  const source = event.dataTransfer.getData('text/plain') || dragCwd
                  if (source !== null && source !== '') dropAtEnd(source)
                  endDrag()
                }}
              >
                放到最后
              </div>
            ) : null}
          </>
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
                ['manual', '手动排序', <IconSwap key="i" size={15} />],
                ['recent', '最近更新', <IconClock key="i" size={15} />],
                ['created', '创建时间', <IconCalendar key="i" size={15} />],
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
                    {/* 菜单项与旧界面同一套：归档行也给置顶 / 重命名 / 分叉 / 复制 ID，
                        只是最后一组换成「恢复会话」而不是「归档会话」。 */}
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
                    {!archived && stoppable ? (
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
                    )}
                  </div>
                </>
              )
            })()
          : (() => {
              const cwdOf = menu.id
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
                    {prefs.archived === 'only' ? (
                      group.sessions.length > 0 ? (
                        <>
                          <div className="menu-sep" />
                          <MenuItem
                            icon={<IconRefresh size={15} />}
                            text={`恢复这 ${String(group.sessions.length)} 个会话`}
                            onClick={() => {
                              setMenu(null)
                              void run('restoreSessions', [group.sessions.map((session) => session.id)])
                            }}
                          />
                        </>
                      ) : null
                    ) : (
                      <>
                        <div className="menu-sep" />
                        {/* 删除工作区（原「归档这 N 个会话」）：空组也显示，否则只切过来
                            还没发消息的工作区删不掉（旧界面 0.6.45 报障后统一成这一个入口）。 */}
                        <MenuItem
                          icon={<IconTrash size={15} />}
                          text="删除工作区"
                          danger
                          onClick={() => {
                            setMenu(null)
                            deleteWorkspace(cwdOf, group.sessions)
                          }}
                        />
                      </>
                    )}
                  </div>
                </>
              )
            })()}

      {/* 分叉位置选择器（旧界面 fork-picker 同款：居中浮层 + 背景遮罩）。 */}
      {forking === null ? null : (
        <>
          <div
            className="menu-backdrop"
            onClick={() => {
              setForking(null)
            }}
          />
          <div className="fork-picker">
            <div className="fork-head">分叉到第几条消息之前？</div>
            <div className="fork-list">
              {forking.messages.map((text, index) => (
                <button key={`${String(index)}-${text}`} type="button" className="fork-item" onClick={() => doFork(forking.id, index)}>
                  <span className="no">{index + 1}</span>
                  <span className="txt">{oneLine(text)}</span>
                </button>
              ))}
            </div>
            <p className="fork-note">新会话包含这个位置之前的全部消息，原会话不变。</p>
          </div>
        </>
      )}

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

/** 侧栏底部（旧界面同位）：当前工作目录（点一下换目录）+ 当前会话用量 + 设置入口。 */
function SidebarFooter(): ReactNode {
  const cwdOf = useHostSelector(readCwd)
  const usage = useHostSelector(readUsageTokens)
  /**
   * 点目录行 = 浏览其他目录（旧界面「点击浏览其他目录」同款）：弹系统选择框，
   * 选中就切过去（原生桥 switchCwd 会重启宿主换 cwd）。
   */
  const browse = (): void => {
    const native = getHostNative()
    if (!native.available) {
      toastErr('换工作目录要用桌面版（浏览器里没有选目录的原生桥）')
      return
    }
    void (async () => {
      try {
        const dir = await native.invoke<string | null>('chooseDirectory')
        if (typeof dir !== 'string' || dir === '') return
        const result = await native.invoke<{ ok: boolean; error?: string }>('switchCwd', [dir])
        if (result !== null && typeof result === 'object' && result.ok === false) {
          toastErr(`切换失败：${result.error ?? '未知原因'}`)
        }
      } catch (reason) {
        toastErr(`切换工作目录失败：${reason instanceof Error ? reason.message : String(reason)}`)
      }
    })()
  }
  return (
    <div className="sidebar-footer">
      <div
        className="row"
        data-tip={cwdOf === null ? '还没有工作目录' : `${cwdOf}，点击浏览其他目录`}
        title={cwdOf === null ? undefined : '点击浏览其他目录'}
        onClick={browse}
      >
        <IconFolder size={14} />
        <span className="dir">{cwdOf === null ? '没有工作目录' : cwdOf}</span>
      </div>
      {/* 用量行常显（旧界面同款）：还没有请求时读作 0 tok，「不知道」与「真是 0」在这里
          本来就是一回事——这是本会话的账。 */}
      <div className="row" data-tip="当前会话累计用量（输入 + 输出）">
        <IconCoins size={14} />
        <span>会话用量</span>
        <span className="num">{formatTokens(usage ?? 0)} tok</span>
      </div>
      {/* 设置行（旧界面左下角同位）：事件请设置面板开门。 */}
      <button
        type="button"
        className="row row-btn"
        data-tip="设置：模型、权限、技能源"
        onClick={() => window.dispatchEvent(new CustomEvent('shell.settings.open'))}
      >
        <IconGear size={14} />
        <span>设置</span>
      </button>
    </div>
  )
}

// ─────────── 数量格式化：与状态栏插件里的那一份同口径，原件在旧渲染层 token-estimate.ts ───────────
// 「状态栏/侧栏上的数字怎么缩写」只有这一个口径（K/M 两级、小数末尾的 0 去掉）。

/** 去掉小数末尾多余的 0：46.0K → 46K，1.00M → 1M。 */
function trimZero(value: number): string {
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** 数量按 K / M 压短：1000 以下给原值，128000 读成 128K。 */
function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1_000) return String(Math.round(count))
  if (count < 1_000_000) return `${trimZero(count / 1_000)}K`
  return `${trimZero(count / 1_000_000)}M`
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

/** 从字符串数组字段读一份列表（workspaceOrder）；线上不是数组就给空表。 */
function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

/** 从「cwd → 字符串数组」字段读一份记录（sessionOrder）；形状不对的条目直接丢。 */
function readStringListRecord(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string[]> = {}
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) out[key] = readStringList(item)
  }
  return out
}

/**
 * 分组展开的默认态（与旧界面同一口径）：树模式只有**父节点**默认展开（子节点收起，
 * 与目录树一致），其余档只有当前工作区的组展开。显式写过的键（sessionExpansion 里有的）
 * 优先于这个默认。
 */
function isDefaultExpanded(cwdOf: string, cwd: string | null, group: GroupKey, parents: ReadonlySet<string>): boolean {
  if (group === 'tree') return parents.has(cwdOf)
  return cwd !== null && cwdOf === cwd
}

/** patchPrefs 的撤销面：把刚打的补丁逐字段退回去。 */
function patchOfUndo(patch: Partial<SidebarPrefs>): Partial<SidebarPrefs> {
  const undo: Partial<SidebarPrefs> = {}
  if (patch.group !== undefined) undo.group = DEFAULT_PREFS.group
  if (patch.sort !== undefined) undo.sort = DEFAULT_PREFS.sort
  if (patch.archived !== undefined) undo.archived = DEFAULT_PREFS.archived
  if (patch.aliases !== undefined) undo.aliases = DEFAULT_PREFS.aliases
  if (patch.expansion !== undefined) undo.expansion = DEFAULT_PREFS.expansion
  if (patch.order !== undefined) undo.order = DEFAULT_PREFS.order
  if (patch.sessionOrder !== undefined) undo.sessionOrder = DEFAULT_PREFS.sessionOrder
  return undo
}

/** 一行会话。DOM 与 class 照旧版 `Sidebar.tsx:579-825`，行根是 div 扮按钮（不是 button）。 */
function SessionRow({
  session,
  state,
  current,
  sort,
  renameRequest,
  drag,
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
  /** 排序档：`created` 时行尾时间显示创建时刻而不是最近更新（旧界面同口径）。 */
  sort: SortKey
  /** 外面（右键菜单 / 行级快捷键）请求进入改名：true 那一拍自动亮出输入框。 */
  renameRequest: boolean
  /** 手动排序档的行拖拽（enabled + 落点标记 + 事件；单列表档不给这组参数）。 */
  drag?: {
    enabled: boolean
    mark: 'before' | 'after' | null
    onStart: (event: DragEvent<HTMLDivElement>) => void
    onOver?: (event: DragEvent<HTMLDivElement>) => void
    onDrop?: (event: DragEvent<HTMLDivElement>) => void
    onEnd: () => void
  }
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
  /** 打开一条会话；归档行先拦下（旧界面同款回执：先恢复再打开）。 */
  const openRow = (): void => {
    if (archived) {
      toastErr('这个会话已归档：先点行尾的「恢复」再打开')
      return
    }
    onOpen(session.id)
  }

  // 外面请求改名（右键菜单 / Ctrl+Alt+R）：这一拍亮出输入框，请求随即清掉。
  useEffect(() => {
    if (renameRequest) {
      setDraft(session.title ?? '')
      onRenameDone()
    }
  }, [renameRequest, session.title, onRenameDone])

  /** 行级快捷键（焦点在行上）：回车打开；重命名 / 分叉 / 归档，与右键菜单同一批动作。 */
  const rowKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      openRow()
      return
    }
    if (!event.ctrlKey && !event.metaKey) return
    const lower = event.key.toLowerCase()
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
      className={`sess-item${current ? ' active' : ''}${archived ? ' archived' : ''}${
        drag?.mark === 'before' ? ' drop-above' : ''
      }${drag?.mark === 'after' ? ' drop-below' : ''}`}
      role="button"
      tabIndex={0}
      data-tip={
        archived
          ? `${title}（已归档）；恢复后才能在对话里打开`
          : `${title}；双击标题改名 · Ctrl+Alt+F 分叉 · Ctrl+Shift+A 归档`
      }
      // 改名中不拖行（旧界面 editing === null 的守卫）：输入框里选字别把整行拎起来。
      draggable={drag?.enabled === true && draft === null}
      onDragStart={drag?.enabled === true && draft === null ? drag.onStart : undefined}
      onDragOver={drag?.enabled === true && draft === null ? drag.onOver : undefined}
      onDrop={drag?.enabled === true && draft === null ? drag.onDrop : undefined}
      onDragEnd={drag?.enabled === true && draft === null ? drag.onEnd : undefined}
      onClick={openRow}
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
          className="row-rename"
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
      {/* 行尾时间在「创建时间」档读创建时刻，其余档读最近更新/归档时刻（旧界面同口径）。 */}
      <span className="when">{relativeTime(sort === 'created' ? session.createdAt : (session.archivedAt ?? session.updatedAt))}</span>

      {/* 行尾 hover 钮对齐旧界面：只剩归档/恢复一件事——重命名/分叉/复制都在右键菜单里。 */}
      <span className="row-actions" onClick={stop}>
        {archived ? (
          <button
            type="button"
            className="icon-btn"
            data-tip="恢复这个会话，移回活动区"
            aria-label="恢复会话"
            onClick={() => onRestore()}
          >
            <IconRefresh size={14} />
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

/** 「添加工作区」钮（旧界面工作区标题行的 ➕）：选目录 → 原生桥 switchCwd 切过去。
    浏览器里没有原生桥，给一句说明而不是无声无息。 */
function AddWorkspaceButton(): ReactNode {
  const native = getHostNative()
  const pick = (): void => {
    if (!native.available) {
      toastErr('添加工作区要用桌面版（浏览器里没有选目录的原生桥）')
      return
    }
    void (async () => {
      try {
        const dir = await native.invoke<string>('chooseDirectory')
        if (typeof dir !== 'string' || dir === '') return
        await native.invoke('switchCwd', [dir])
      } catch (reason) {
        toastErr(`切换工作区失败：${reason instanceof Error ? reason.message : String(reason)}`)
      }
    })()
  }
  return (
    <button
      type="button"
      className="icon-btn"
      data-tip="添加工作区（选择目录）"
      aria-label="添加工作区"
      onClick={pick}
    >
      <IconPlus size={15} />
    </button>
  )
}

/**
 * 顶栏的「工作区打开组」（旧界面同款：文件夹主钮 + caret 下拉）：
 * 主钮直接开文件资源管理器；下拉里还有终端 / VS Code / 复制路径——全走原生桥
 * （`openWorkspace` 三个档 + clipboard），浏览器里没有桥就给一句说明。
 */
function WorkspaceOpenGroup(): ReactNode {
  const cwd = useHostSelector(readCwd)
  const native = getHostNative()
  const [menuOpen, setMenuOpen] = useState(false)

  const open = (kind: 'terminal' | 'explorer' | 'vscode'): void => {
    setMenuOpen(false)
    if (cwd === null) {
      toastErr('还没有工作目录（先开一个会话或添加工作区）')
      return
    }
    if (!native.available) {
      toastErr('这条能力来自桌面外壳的原生桥，浏览器里没有它')
      return
    }
    void native
      .invoke<{ ok: boolean; error?: string }>('openWorkspace', [kind])
      .then((result) => {
        if (result !== null && typeof result === 'object' && result.ok === false) {
          toastErr(`打开失败：${result.error ?? '宿主没说什么原因'}`)
        }
      })
      .catch((reason: unknown) => {
        toastErr(`打开失败：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }

  const copyPath = (): void => {
    setMenuOpen(false)
    if (cwd === null) return
    void navigator.clipboard.writeText(cwd).then(
      () => {
        toastOk('工作区路径已复制')
      },
      () => {
        toastErr('复制失败，请手动选中')
      },
    )
  }

  return (
    <div className="ws-open">
      <button
        type="button"
        className="ws-open-main"
        data-tip="在文件资源管理器中打开工作区"
        aria-label="在文件资源管理器中打开工作区"
        onClick={() => {
          open('explorer')
        }}
      >
        <IconFolderOpen size={15} />
      </button>
      <button
        type="button"
        className={`ws-open-caret${menuOpen ? ' on' : ''}`}
        data-tip="更多打开方式"
        aria-label="更多打开方式"
        aria-expanded={menuOpen}
        onClick={() => {
          setMenuOpen((current) => !current)
        }}
      >
        <IconChevronDown size={13} />
      </button>
      {menuOpen ? (
        <>
          <div
            className="menu-backdrop"
            onClick={() => {
              setMenuOpen(false)
            }}
          />
          <div className="row-menu ws-open-menu" role="menu">
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                open('terminal')
              }}
            >
              <IconTerminal size={14} /> 在终端中打开
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                open('explorer')
              }}
            >
              <IconFolderOpen size={14} /> 在文件资源管理器中打开
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                open('vscode')
              }}
            >
              <IconCode size={14} /> 在 VS Code 中打开
            </button>
            <div className="menu-sep" />
            <button type="button" className="menu-item" onClick={copyPath}>
              <IconCopy size={14} /> 复制工作区路径
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
