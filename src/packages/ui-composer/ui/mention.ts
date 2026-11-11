/**
 * @ 文件提及补全（对照桌面渲染层 Composer.tsx 的同名能力）：
 * 输入 `@` 触发，候选是工作区文件（模糊过滤），↑↓ 选、Tab/Enter 补、Esc 关且同 token 不再弹。
 *
 * 文件清单来自 dock 通道的 `fs-list` **懒递归**：根集合先问 `fs-roots`（会话 cwd 恒在
 * 首位，后面是配置里的 `workspaceRoots`）。多根共享 500 条 / 深度 4 的预算，并给每个根
 * 留 100 条最小份额，避免第一个巨根把预算吃光。主根（会话 cwd）候选仍是相对路径，其它根
 * 给绝对路径（正斜杠，插进正文后工具能直接打开）。结果缓存 60 秒，**缓存键带根集合**——
 * 根一变就重扫。宿主没有 `fs-roots`（旧版本）或它调用失败时退回单根，行为与从前一致。
 *
 * @module dsc-ui-shell/plugins/composer/mention
 */
import { useRef, useState } from 'react'
import type { useHostChannel } from '@dsc/ui'

/** 一次多根遍历的总条目上限（防大仓库把界面拖死；桌面端遍历同样有预算）。 */
export const MAX_FILES = 500
/** 递归深度上限（根为第 1 层）。 */
export const MAX_DEPTH = 4
/**
 * 每个根的最小候选份额（2026-11，多根预算）。
 *
 * 为什么需要它：所有根共用一份预算，第一个根若是个巨仓库就会把它吃满，后面的根一条
 * 候选都进不来——用户会以为「加了根但 @ 什么也没有」。根多到均分不足 100 时按根数降档。
 */
export const MIN_FILES_PER_ROOT = 100
/** 清单缓存时长：60 秒内根集合没变就不再扫盘。 */
const CACHE_MS = 60_000
/** 候选面板最多露几条。 */
const MAX_CANDIDATES = 8

/** 一个已授权的工作区根（`main` = 会话 cwd，候选走相对路径）。 */
export interface MentionRoot {
  path: string
  main: boolean
}

/** 模块级缓存：60 秒内所有 @ 触发共用一份清单；键里带根集合，根变了就重扫。 */
let cache: { at: number; key: string; files: string[] } | null = null

/** 绝对路径统一成正斜杠（插进正文后 Windows 上也能被工具直接打开）。 */
function posix(path: string): string {
  return path.replaceAll('\\', '/')
}

/** 缓存键：根集合的绝对路径 + 主根标记（顺序敏感）。 */
function rootsCacheKey(roots: readonly MentionRoot[]): string {
  return roots.map((root) => `${root.main ? '*' : ''}${posix(root.path)}`).join('\n')
}

/** `fs-roots` 回包的最小形状（desktop-dock 插件定义，这里只认形状）。 */
interface RootsReply {
  cwd?: string
  roots?: Array<{ path?: unknown; name?: unknown; main?: unknown }>
}

/**
 * 问宿主已授权根。旧宿主没有这个 op、或宿主直接抛错时返回 null——调用方退回单根，
 * 不能因为新 op 不存在就把 @ 补全弄坏。
 */
async function listRoots(channel: ReturnType<typeof useHostChannel>): Promise<MentionRoot[] | null> {
  try {
    const reply = await channel.invoke<RootsReply>('dock', ['fs-roots'])
    const rows = Array.isArray(reply?.roots) ? reply.roots : []
    const roots: MentionRoot[] = []
    rows.forEach((row, index) => {
      if (typeof row?.path !== 'string' || row.path === '') return
      // 契约是「第一个恒为会话 cwd」；`main` 标记兜底，正常两者一致。
      roots.push({ path: row.path, main: row.main === true || index === 0 })
    })
    return roots.length === 0 ? null : roots
  } catch {
    return null
  }
}

/** 候选路径：主根相对、其它根绝对（正斜杠）；绝对根去掉尾部分隔符再拼。 */
function candidatePath(root: MentionRoot, rel: string): string {
  if (root.main) return rel
  const base = posix(root.path).replace(/\/+$/, '')
  return base === '' ? `/${rel}` : `${base}/${rel}`
}

/**
 * 懒递归一个根，把候选追加进 `files`；最多收 `limit` 条。
 *
 * `root === null` 是退回单根时的形态：`fs-list` 不带 `root`，候选是相对 cwd 的路径，
 * 与 2026-10 版逐字一致。单个目录列举失败只跳过这一层（权限不足不该让整份清单失败）。
 */
async function scanRoot(
  channel: ReturnType<typeof useHostChannel>,
  root: MentionRoot | null,
  limit: number,
  files: string[],
): Promise<void> {
  let left = limit
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || left <= 0) return
    let entries: Array<{ name: string; dir: boolean }> = []
    try {
      const listing = await channel.invoke<{ entries: Array<{ name: string; dir: boolean }> }>('dock', [
        'fs-list',
        root === null ? { dir } : { dir, root: root.path },
      ])
      entries = listing.entries ?? []
    } catch {
      return
    }
    for (const entry of entries) {
      if (left <= 0) return
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`
      if (entry.dir) {
        // 目录本身不进清单，但目录名参与过滤（路径里带着它）。
        await walk(path, depth + 1)
      } else {
        files.push(root === null ? path.replaceAll('\\', '/') : candidatePath(root, path))
        left -= 1
      }
    }
  }
  await walk('.', 1)
}

/** 单根兜底：与旧实现同一套预算与路径形态，`fs-list` 不传 root。 */
async function listSingleRootFiles(channel: ReturnType<typeof useHostChannel>): Promise<string[]> {
  const files: string[] = []
  await scanRoot(channel, null, MAX_FILES, files)
  return files
}

/** 多根遍历：所有根共享 MAX_FILES，先给后面的根留足最小份额，再让当前根用剩下的。 */
async function listMultiRootFiles(
  channel: ReturnType<typeof useHostChannel>,
  roots: readonly MentionRoot[],
): Promise<string[]> {
  const files: string[] = []
  let left = MAX_FILES
  const minPerRoot = Math.max(1, Math.min(MIN_FILES_PER_ROOT, Math.floor(MAX_FILES / roots.length)))
  for (let index = 0; index < roots.length && left > 0; index += 1) {
    const remaining = roots.length - index - 1
    // 先扣掉后面每个根的最小份额，第一个巨根就不能把预算吃光。
    const reserve = Math.min(minPerRoot * remaining, Math.max(0, left - 1))
    const allowance = left - reserve
    const before = files.length
    await scanRoot(channel, roots[index]!, allowance, files)
    left -= files.length - before
  }
  return files
}

/**
 * 列举工作区文件（多根；宿主不支持 `fs-roots` 时退回单根相对路径）。
 *
 * 导出是为了让 `scripts/ui-mention-roots-test.mjs` 用假通道直接驱动：界面只通过
 * {@link useMention} 用它。
 */
export async function listWorkspaceFiles(channel: ReturnType<typeof useHostChannel>): Promise<string[]> {
  const roots = await listRoots(channel)
  // 拿不到根时用哨兵键走单根：与「只有一个主根」区分开，宿主升级后能立刻换到多根。
  const key = roots === null ? '\u0000single' : rootsCacheKey(roots)
  const now = Date.now()
  if (cache !== null && cache.key === key && now - cache.at < CACHE_MS) return cache.files
  const files = roots === null
    ? await listSingleRootFiles(channel)
    : await listMultiRootFiles(channel, roots)
  cache = { at: now, key, files }
  return files
}

/** 一个候选：显示路径 + 简单的匹配分（越小越靠前）。 */
function rankFiles(files: readonly string[], query: string): string[] {
  const q = query.toLowerCase()
  const scored: Array<{ path: string; score: number }> = []
  for (const path of files) {
    const lower = path.toLowerCase()
    // 文件名前缀 > 文件名含 > 路径含；其余不要。
    const nameAt = lower.lastIndexOf('/')
    const name = nameAt < 0 ? lower : lower.slice(nameAt + 1)
    let score: number | null = null
    if (q === '') score = 0
    else if (name.startsWith(q)) score = 0
    else if (name.includes(q)) score = 1
    else if (lower.includes(q)) score = 2
    if (score !== null) scored.push({ path, score })
  }
  return scored
    .sort((left, right) => left.score - right.score || left.path.length - right.path.length)
    .slice(0, MAX_CANDIDATES)
    .map((item) => item.path)
}

/** 从光标位置往前找 @token；找到返回（起始下标、已输入的查询词）。 */
function tokenBefore(value: string, caret: number): { from: number; query: string } | null {
  let at = -1
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = value[index]
    if (char === '@') {
      at = index
      break
    }
    // 空白或换行截断：@token 不跨词。
    if (char === ' ' || char === '\n' || char === '\t') return null
  }
  if (at < 0) return null
  // @ 后面的字符才算查询词；紧跟标点的不算（@path/to 需要支持斜杠）。
  const query = value.slice(at + 1, caret)
  if (query.length > 120) return null
  return { from: at, query }
}

/** @ 补全面板的全部状态与动作（Composer 挂一份）。 */
export interface MentionApi {
  open: boolean
  items: readonly string[]
  loading: boolean
  at: number
  track(value: string, caret: number): void
  move(delta: number): void
  pick(): void
  close(): void
}

export function useMention(options: {
  channel: ReturnType<typeof useHostChannel>
  area: React.RefObject<HTMLTextAreaElement | null>
  apply(next: string, caret: number): void
}): MentionApi {
  const { channel, area, apply } = options
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(false)
  const [at, setAt] = useState(0)
  /** 最近一次输入的上下文（value/caret/@ 起点/query）：pick 重构文本要用。 */
  const latest = useRef<{ value: string; caret: number; from: number; query: string } | null>(null)
  /** 用户对这个 token 明确按过 Esc：同一个 token 位置不再弹（旧界面同款）。 */
  const dismissed = useRef<string | null>(null)
  /** 当前候选（pick 从这里取选中项，避开 state 时序）。 */
  const current = useRef<readonly string[]>([])

  const track = (value: string, caret: number): void => {
    const token = tokenBefore(value, caret)
    if (token === null) {
      latest.current = null
      if (open) setOpen(false)
      return
    }
    const key = `${token.from}:${token.query}`
    if (dismissed.current === key) return
    latest.current = { value, caret, ...token }
    setOpen(true)
    // 已有清单先就地过滤（每敲一个字都重扫会闪），随后再按根集合校验/重扫。
    if (cache === null) {
      setLoading(true)
    } else {
      const ranked = rankFiles(cache.files, token.query)
      current.current = ranked
      setItems(ranked)
      setAt(0)
    }
    void listWorkspaceFiles(channel)
      .then((files) => {
        setLoading(false)
        // 迟到的一帧按**此刻**的 query 过滤：用户可能已经多敲了几个字。
        const currentToken = latest.current
        if (currentToken === null) return
        const ranked = rankFiles(files, currentToken.query)
        current.current = ranked
        setItems(ranked)
        setAt(0)
      })
      .catch(() => {
        setLoading(false)
      })
  }

  const move = (delta: number): void => {
    const count = current.current.length
    if (count === 0) return
    setAt((index) => (index + delta + count) % count)
  }

  const close = (): void => {
    const token = latest.current
    if (token !== null) dismissed.current = `${token.from}:${token.query}`
    latest.current = null
    setOpen(false)
  }

  const pick = (): void => {
    const token = latest.current
    const path = current.current[at]
    if (token === null || path === undefined) return
    // 替换 @token 为 @path + 空格，光标落在插入文本之后。
    const before = token.value.slice(0, token.from)
    const after = token.value.slice(token.caret)
    const inserted = `@${path} `
    const next = `${before}${inserted}${after}`
    const caret = token.from + inserted.length
    latest.current = null
    setOpen(false)
    apply(next, caret)
    area.current?.focus()
  }

  return { open, items, loading, at, track, move, pick, close }
}
