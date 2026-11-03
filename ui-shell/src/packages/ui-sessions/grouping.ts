/**
 * 侧栏会话列表的纯数据整形（桌面渲染层 `sidebar-groups.ts` 的同构移植）：
 * 工作区分组、树分组、组内排序（含手动排序档）、搜索过滤、显示名，以及手动
 * 排序的落点纯函数（旧渲染层 `workspace-order.ts` 的 moveWithin / moveToEnd）。
 *
 * 命名约定：分组键是会话的 `cwd`，「工作区」是界面对它的称呼。
 *
 * @module dsc-ui-shell/plugins/sessions/grouping
 */
import type { SessionSummary } from '@dsc/ui'

/** 分组方式：按工作区（平铺）/ 按工作区树（目录前缀挂层级）/ 单列表。 */
export type GroupKey = 'workspace' | 'tree' | 'flat'
/** 排序方式：手动排序 / 最近更新 / 创建时间（宿主缺省档就是 manual，同旧界面）。 */
export type SortKey = 'manual' | 'recent' | 'created'
/** 归档筛选：hide 只看活动区，only 只看归档区，show 两区并成一份列表。 */
export type ArchivedFilter = 'hide' | 'show' | 'only'

/** 手动排序档里每个工作区的会话顺序（UiPrefsView.sessionOrder）。 */
export type SessionOrder = Record<string, string[]>

/** 工作区手动顺序（UiPrefsView.workspaceOrder）。 */
export type WorkspaceOrder = string[]

/** 一个工作区分组：分组键（会话 cwd）+ 该组排好序的会话 + 树分组的层级信息。 */
export interface WorkGroup {
  cwd: string
  sessions: SessionSummary[]
  /** 树分组里的层级（0 = 根）；平铺档恒 0。 */
  depth: number
  /** 树分组里的父目录（根为 null）。 */
  parent: string | null
  /** 树分组里从根到自己的目录链（含自己）。 */
  ancestors: string[]
  /** 树分组里它有没有子目录（决定折叠时整支隐藏）。 */
  hasChildren: boolean
}

/** 工作区显示名的别名表（UiPrefsView.workspaceAliases）。 */
export type WorkspaceAliases = Record<string, string>

/** 树分组的一个节点（workspace-order 的 NestedPath）。 */
interface PathNode {
  cwd: string
  depth: number
  parent: string | null
  ancestors: string[]
  hasChildren: boolean
}

/**
 * 工作区显示名：别名优先，没起别名就取路径最后一段。
 * （盘符根如 `D:\` 的最后一段是空串，回退全路径。）
 */
export function displayName(cwd: string, aliases: WorkspaceAliases): string {
  const alias = aliases[cwd]
  if (alias !== undefined && alias !== '') return alias
  const tail = lastSegment(cwd)
  return tail === '' ? cwd : tail
}

/** 取路径最后一段（两种分隔符都认；结尾是分隔符时给空串，由调用方兜底）。 */
export function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at < 0 ? trimmed : trimmed.slice(at + 1)
}

/**
 * 会话行排序：置顶块照旧排最前（置顶时间倒序）；manual 档按 `sessionOrder`
 * 里拖出来的顺序走（dsh 的 reconcileManualOrder 语义——表里没有的会话按
 * 最近使用接在所属置顶块末尾），其余档按时间。cwd 缺省（单列表）没有拖拽序。
 */
export function orderedSessions(
  cwd: string | undefined,
  list: SessionSummary[],
  sort: SortKey,
  sessionOrder: SessionOrder,
): SessionSummary[] {
  const sorted = [...list].sort((left, right) => {
    if ((left.pinnedAt ?? 0) !== (right.pinnedAt ?? 0)) return (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0)
    return sort === 'created' ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt
  })
  if (sort !== 'manual' || cwd === undefined) return sorted
  const saved = sessionOrder[cwd]
  if (saved === undefined || saved.length === 0) return sorted
  const rank = new Map(saved.map((id, index) => [id, index]))
  // 置顶块约束：拖拽只在同一块内进行，落盘序也只在块内生效，两块之间仍是置顶在前。
  const weave = (part: SessionSummary[]): SessionSummary[] =>
    [...part].sort((a, b) => {
      const ra = rank.get(a.id)
      const rb = rank.get(b.id)
      if (ra !== undefined && rb !== undefined) return ra - rb
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return 0
    })
  return [
    ...weave(sorted.filter((session) => session.pinnedAt !== undefined)),
    ...weave(sorted.filter((session) => session.pinnedAt === undefined)),
  ]
}

/**
 * 把 `source` 从 `order` 里摘出来，插到 `target` 之前（after=false）或之后（after=true）。
 * `target` 不在列表里，或者顺序本来就一样时，原样返回（旧渲染层 workspace-order.ts 同款）。
 */
export function moveWithin(order: string[], source: string, target: string, after: boolean): string[] {
  if (source === target) return order
  const rest = order.filter((item) => item !== source)
  let at = rest.indexOf(target)
  if (at < 0) return order
  if (after) at += 1
  return [...rest.slice(0, at), source, ...rest.slice(at)]
}

/** 把 `source` 挪到列表末尾（拖到「放到最后」落点）。 */
export function moveToEnd(order: string[], source: string): string[] {
  return [...order.filter((item) => item !== source), source]
}

/** 归档筛选：hide 只看活动区，only 只看归档区，show 两区并成一份列表。 */
function keepArchived(session: SessionSummary, archived: ArchivedFilter): boolean {
  if (archived === 'hide') return session.archivedAt === undefined
  if (archived === 'only') return session.archivedAt !== undefined
  return true
}

/** 侧栏分组要的全部输入（都是值，不是 React 状态）。 */
export interface GroupInput {
  sessions: SessionSummary[]
  /** 「切过去还没发消息」的工作区也要出现在列表里（原生桥给；浏览器里没有就空着）。 */
  recentCwds: string[]
  /** 当前活动工作区（manual 档没排过序时活动组置顶）。 */
  cwd: string
  sort: SortKey
  group: GroupKey
  archived: ArchivedFilter
  /** 搜索词（已 trim + 小写；空串 = 不过滤）。 */
  trimmed: string
  aliases: WorkspaceAliases
  /** 手动拖出来的工作区顺序（cwd 绝对路径）。 */
  order: WorkspaceOrder
  /** 手动拖出来的组内会话顺序（cwd → 会话 id 序列）。 */
  sessionOrder: SessionOrder
}

/**
 * 把会话库整理成侧栏要的工作区分组列表：
 * 归档筛选 → 分桶（cwd）→ 搜索过滤 → 组内排序 → 组间排序 → （tree 档）按目录前缀挂树。
 */
export function buildWorkGroups(input: GroupInput): WorkGroup[] {
  const { sessions, recentCwds, cwd, sort, group, archived, trimmed, aliases, order, sessionOrder } = input
  const map = new Map<string, SessionSummary[]>()
  // 只有「切过去还没发消息」的工作区没有会话，也要留在列表里；只看归档时它们没意义
  if (archived !== 'only') for (const dir of recentCwds) map.set(dir, [])
  for (const session of sessions) {
    if (!keepArchived(session, archived)) continue
    const key = session.cwd || '(未指定)'
    const list = map.get(key) ?? []
    list.push(session)
    map.set(key, list)
  }
  const match = (dir: string, list: SessionSummary[]): boolean =>
    trimmed === '' ||
    displayName(dir, aliases).toLowerCase().includes(trimmed) ||
    dir.toLowerCase().includes(trimmed) ||
    list.some((session) => (session.title ?? '新会话').toLowerCase().includes(trimmed))
  const visible = [...map.entries()].filter(([dir, list]) => match(dir, list))
  const rank = (dir: string): number => order.indexOf(dir)
  const lastUsed = (list: SessionSummary[]): number => list.reduce((max, s) => Math.max(max, s.updatedAt), 0)
  const lastCreated = (list: SessionSummary[]): number => list.reduce((max, s) => Math.max(max, s.createdAt), 0)
  const sorted = visible
    .map(([dir, list]) => [dir, orderedSessions(dir, list, sort, sessionOrder)] as [string, SessionSummary[]])
    .sort((a, b) => {
      if (sort === 'manual') {
        // 手动排过序就完全按手动顺序（活动组不再抢位）；没排过则活动组置顶，其余按最近使用
        if (order.length > 0) {
          const ra = rank(a[0])
          const rb = rank(b[0])
          if (ra !== rb) {
            if (ra < 0) return 1
            if (rb < 0) return -1
            return ra - rb
          }
        } else if ((a[0] === cwd) !== (b[0] === cwd)) {
          return a[0] === cwd ? -1 : 1
        }
        return lastUsed(b[1]) - lastUsed(a[1])
      }
      // 最近更新 / 创建时间这两档两级都按时间，不再人为把活动组顶上去
      return sort === 'created' ? lastCreated(b[1]) - lastCreated(a[1]) : lastUsed(b[1]) - lastUsed(a[1])
    })
  if (group !== 'tree') {
    return sorted.map(
      ([dir, list]): WorkGroup => ({ cwd: dir, sessions: list, depth: 0, parent: null, ancestors: [], hasChildren: false }),
    )
  }
  const lists = new Map(sorted)
  return nestByPath(sorted.map(([dir]) => dir)).map((node) => ({ ...node, sessions: lists.get(node.cwd) ?? [] }))
}

/**
 * 目录前缀挂树（桌面渲染层 `workspace-order.ts` 的同构移植）：大小写与分隔符不敏感地
 * 找出「谁的路径是另一个的前缀」，前缀目录成为父节点。顺序保持输入序（父先于子）。
 */
function nestByPath(dirs: readonly string[]): PathNode[] {
  /** 比较键：分隔符统一成 `/`、整体小写——`D:\work` 与 `d:/work` 是同一个目录。 */
  const norm = (dir: string): string => dir.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  const nodes = new Map<string, PathNode>()
  for (const dir of dirs) {
    nodes.set(norm(dir), { cwd: dir, depth: 0, parent: null, ancestors: [dir], hasChildren: false })
  }
  for (const dir of dirs) {
    const key = norm(dir)
    const self = nodes.get(key)
    if (self === undefined) continue
    // 找自己的最长真前缀父目录：在已登记的目录里挑「是前缀且最长」的那个。
    let best: PathNode | null = null
    for (const [otherKey, other] of nodes) {
      if (otherKey === key) continue
      if (!key.startsWith(`${otherKey}/`)) continue
      if (best === null || otherKey.length > norm(best.cwd).length) best = other
    }
    if (best !== null) {
      self.parent = best.cwd
      self.depth = best.depth + 1
      self.ancestors = [...best.ancestors, self.cwd]
      best.hasChildren = true
    }
  }
  // 输出顺序：父在子前（children 挂出来时 DOM 层级才对），同层保持输入序。
  const out: PathNode[] = []
  const walk = (parent: string | null): void => {
    for (const node of nodes.values()) {
      if (node.parent !== parent) continue
      out.push(node)
      walk(node.cwd)
    }
  }
  walk(null)
  // 兜底：理论上每个节点都被 walk 到（parent 链有限），但防御一次环/丢失。
  for (const node of nodes.values()) if (!out.includes(node)) out.push(node)
  return out
}
