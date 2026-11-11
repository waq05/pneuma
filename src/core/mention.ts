/**
 * 输入端 @ 文件提及补全（T14）：定位光标处的 @token、给候选排序、把选中路径插回正文。
 *
 * 纯逻辑模块：不碰 React、不碰网络。工作区文件清单由调用方注入 lister（dock 的 fs-list
 * 透传），探针在 node 里直测；不注入时退到本机 fs（TUI 与探针不必各包一层）。
 * 路径一律 posix 相对形态（插入正文、被 chat/markdown-text 的 matchMentionPath 识别成
 * chip、被轮尾改动卡按后缀匹配命中）。
 *
 * 多工作区（2026-11，T50）：根集合由宿主侧配置决定（`core/config.ts` 的
 * `allowedWorkspaceRoots`），界面只能在已授权根之间切换。清单可以一次遍历多个根，
 * 每个条目带 `root` 与 `label`：主根（第一个）沿用相对路径，其它根用 `<根名>/<相对>`。
 *
 * 住在这里的原因：桌面端 renderer 与终端 TUI（src/app）共用同一份逻辑——桌面经
 * vite alias `@dsc/runtime/core/mention.js` 引编译产物，TUI 直接 import 源码。
 * 2026-10 自 desktop/src/renderer/mention-complete.ts 上移，函数与常量零改动。
 *
 * @module dsc/core/mention
 */
import { readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { dedupeContainedWorkspaceRoots, sameWorkspaceRoot } from './config.js'

/** 光标处的 @ 提及查询：token 是 @ 之后的已敲字符（可为空串），start 指向 @ 本身。 */
export interface MentionQuery {
  token: string
  start: number
  /** 光标位置（token 结尾）。 */
  end: number
}

/** token 最长 64 字符：再长多半是把整段文字吸进来的误判，不触发。 */
const MAX_TOKEN_CHARS = 64

/**
 * 找光标处的 @ 提及查询。规则：
 * - 从光标往前找最近的 `@`；`@` 前必须是文本开头或空白（邮箱 `a@b` 不触发）；
 * - `@` 到光标之间不能有空白或换行（路径里的 `/` 允许）；
 * - 没有 `@` 或 token 超长返回 null。
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const at = Math.min(Math.max(caret, 0), text.length)
  let start = -1
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = text[index]
    if (char === '@') {
      start = index
      break
    }
    if (/\s/.test(char ?? '')) break
  }
  if (start < 0) return null
  if (start > 0 && !/\s/.test(text[start - 1] ?? '')) return null
  const token = text.slice(start + 1, at)
  if (token.length > MAX_TOKEN_CHARS) return null
  return { token, start, end: at }
}

/**
 * 把选中的路径插回正文：替换 `@token` 为 `@路径` 并补一个尾随空格，
 * 返回新文本与插入后的光标位置。
 */
export function insertMention(text: string, query: MentionQuery, path: string): { text: string; caret: number } {
  const inserted = `@${path} `
  const next = `${text.slice(0, query.start)}${inserted}${text.slice(query.end)}`
  return { text: next, caret: query.start + inserted.length }
}

/**
 * 候选排序：文件名前缀命中 > 文件名包含 > 路径包含 > 无命中（按路径深度与字典序兜底）；
 * 空 token 直接按深度 + 字典序给前列。同档内路径短的靠前（浅目录 ≈ 更常被提）。
 */
export function rankMentionCandidates(files: readonly string[], token: string, limit = 12): string[] {
  const query = token.toLowerCase()
  const scored: { path: string; score: number }[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    const name = lower.slice(Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1)
    let score: number
    if (query === '') {
      score = file.split('/').length * 100 + name.length
    } else if (name.startsWith(query)) {
      score = 0
    } else if (name.includes(query)) {
      score = 1000 + name.length
    } else if (lower.includes(query)) {
      score = 2000 + lower.length
    } else {
      continue
    }
    scored.push({ path: file, score: score * 1000 + Math.min(file.length, 999) })
  }
  scored.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : 1))
  return scored.slice(0, limit).map((entry) => entry.path)
}

/** 遍历时跳过的目录名（构建产物与依赖：清单里全是它们只会淹没真候选）。 */
export const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.turbo', '__pycache__', '.cache', '.venv', 'venv', 'target',
  'runtime-staging',
  // Chromium userData 的标准缓存子目录（自检/打包残留会以这些名字出现在仓库里）
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnCache', 'CachedData',
  'crashpad', 'blob_storage', 'Session Storage', 'Local Storage', 'Shared Dictionary',
])

/** 遍历上限：条数与深度都按住，超大仓库不至于把补全拖死。 */
export const WALK_MAX_FILES = 4000
export const WALK_MAX_DEPTH = 6

/**
 * 每个根的最小候选配额（2026-11，多根预算）：`WALK_MAX_FILES / 4` 与 200 条取小。
 *
 * 为什么需要它：所有根共用一份预算，第一个根若是个巨仓库就会把它吃满，后面的根一条
 * 候选都进不来，而且没有任何提示——用户会以为「加了根但 @ 什么也没有」。
 */
const WALK_MIN_FILES_PER_ROOT = 200

/** fs-list 透传回包的最小形状（desktop-dock 插件定义，这里只认形状）。 */
export type DirLister = (dir: string) => Promise<{ entries: { name: string; dir: boolean }[] }>

/** 一个工作区文件候选：插入路径、所属根、面板里显示的标签。 */
export interface WorkspaceFileEntry {
  /** 插入正文的路径：主根给相对路径（与旧行为一致），其它根给绝对路径（工具能直接打开）。 */
  path: string
  /** 所属根的绝对路径。 */
  root: string
  /** 候选里显示的路径：主根是相对路径；其它根是 `<根名>/<相对路径>`。 */
  label: string
}

/** 多根遍历的选项；不传 lister 时读本机文件系统（自检可注入夹具）。 */
export interface CollectWorkspaceFilesOptions {
  lister?: DirLister
}

/** 默认列举器：直接读本机 fs。目录名保持原样，交给上面的剪枝规则判。 */
const nodeDirLister: DirLister = async (dir) => ({
  entries: readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    dir: entry.isDirectory(),
  })),
})

/** 一次遍历的落点：相对所属根的 posix 路径 + 根下标。 */
interface WalkHit {
  rel: string
  rootIndex: number
}

/** 遍历预算：所有根共用，保证多根加起来仍不超过 WALK_MAX_FILES。 */
interface WalkBudget {
  left: number
}

/**
 * 深度优先遍历一个根。目录按 SKIP_DIR_NAMES 剪枝，深度到 WALK_MAX_DEPTH 即止；
 * lister 抛错时跳过该目录（权限不足的目录不该让整份清单失败）。
 *
 * `skipRoots` 是「已经被别的根收录、这里不要再进」的根：主根被一个更大的额外根包住时，
 * 外层那个根跳过主根这棵子树，同一批文件就不会以两种路径各列一遍。
 */
async function walkWorkspaceRoot(
  lister: DirLister,
  root: string,
  rel: string,
  depth: number,
  budget: WalkBudget,
  hits: WalkHit[],
  rootIndex: number,
  skipRoots: readonly string[] = [],
): Promise<void> {
  if (budget.left <= 0) return
  let entries: { name: string; dir: boolean }[]
  try {
    entries = (await lister(rel === '' ? root : join(root, rel))).entries
  } catch {
    return
  }
  for (const entry of entries) {
    if (budget.left <= 0) return
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.dir) {
      // 点开头目录（.mimosa/.zcode 这类工具状态目录）一律跳过：名字按字典序排在
      // 源码前面，历史文件一多就把整个上限吃满，源码目录反而一个都收不进。
      if (depth >= WALK_MAX_DEPTH || SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
      const abs = join(root, childRel)
      if (skipRoots.some((other) => sameWorkspaceRoot(abs, other))) continue
      await walkWorkspaceRoot(lister, root, childRel, depth + 1, budget, hits, rootIndex, skipRoots)
    } else {
      hits.push({ rel: childRel, rootIndex })
      budget.left -= 1
    }
  }
}

/** 根的短哈希：两个根连「父目录名-根目录名」都一样时用它兜底区分。 */
function shortRootHash(root: string): string {
  let hash = 5381
  for (let index = 0; index < root.length; index += 1) hash = ((hash * 33) ^ root.charCodeAt(index)) >>> 0
  return hash.toString(16).padStart(8, '0').slice(0, 4)
}

/** `child` 是否就是 `parent` 或落在它里面（两边都已是绝对路径）。 */
function rootContains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 给非主根算标签前缀：先只用根目录名；重名时换成 `父目录名-根目录名`；
 * 还重就再挂短哈希。主根（下标 0）不前缀，保持旧行为。
 *
 * `mainTopDirs` 是主根的顶层目录名：主根不前缀，但它占着 `proj/...` 这个 label 前缀——
 * 主根里恰好有个叫 `proj` 的目录、另一个根也叫 `proj` 时，两枚候选的 label 会一模一样
 * （`proj/README.md`），用户点哪条都分不清，所以主根的顶层目录名也算进撞名集合。
 */
function rootLabelPrefixes(roots: readonly string[], mainTopDirs: Iterable<string> = []): string[] {
  const baseNames = roots.map((root) => basename(root))
  const baseCounts = new Map<string, number>()
  for (const name of mainTopDirs) {
    const key = name.toLowerCase()
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1)
  }
  for (let index = 1; index < roots.length; index += 1) {
    const key = baseNames[index]!.toLowerCase()
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1)
  }
  const prefixes = roots.map(() => '')
  const used = new Map<string, number>()
  for (let index = 1; index < roots.length; index += 1) {
    const base = baseNames[index]!
    let prefix = base
    if ((baseCounts.get(base.toLowerCase()) ?? 0) > 1) prefix = `${basename(dirname(roots[index]!))}-${base}`
    const key = prefix.toLowerCase()
    const seen = used.get(key) ?? 0
    if (seen > 0) prefix = `${prefix}-${shortRootHash(roots[index]!)}`
    used.set(key, seen + 1)
    prefixes[index] = prefix
  }
  return prefixes
}

/**
 * 旧签名：注入 lister、单根遍历，返回相对路径字符串。
 *
 * 保留它是为了 TUI（`tui/app/Composer.tsx`）不被多根改动波及：传 `(lister)` 或
 * `(lister, root)` 时结果与 2026-10 版逐字一致。
 */
export function collectWorkspaceFiles(lister: DirLister, root?: string): Promise<string[]>
/**
 * 新签名：一次遍历多个根（或单根字符串），返回带 `root` / `label` 的候选条目。
 *
 * - 主根 = 第一个根，`path` 是相对路径、`label` 与 `path` 相同（旧行为）；
 * - 其它根，`path` 是绝对路径（工具能直接打开），`label` 带 `<根名>/` 前缀；
 * - 总条数各根共用 WALK_MAX_FILES 上限，同一个文件出现在多个根下按根分别列出。
 */
export function collectWorkspaceFiles(
  roots: string | readonly string[],
  options?: CollectWorkspaceFilesOptions,
): Promise<WorkspaceFileEntry[]>
export async function collectWorkspaceFiles(
  rootsOrLister: string | readonly string[] | DirLister,
  optionsOrRoot: CollectWorkspaceFilesOptions | string = {},
): Promise<string[] | WorkspaceFileEntry[]> {
  // 旧签名：第一个参数是函数。root 缺省 '.'（TUI 的老调用）。
  if (typeof rootsOrLister === 'function') {
    const root = typeof optionsOrRoot === 'string' && optionsOrRoot !== '' ? optionsOrRoot : '.'
    const hits: WalkHit[] = []
    await walkWorkspaceRoot(rootsOrLister, root, '', 0, { left: WALK_MAX_FILES }, hits, 0)
    const prefix = root === '.' ? '' : root.replace(/\\/g, '/').replace(/\/+$/, '')
    return hits.map((hit) => (prefix === '' ? hit.rel : `${prefix}/${hit.rel}`))
  }

  const lister = typeof optionsOrRoot === 'string' ? nodeDirLister : (optionsOrRoot.lister ?? nodeDirLister)
  const requested = (typeof rootsOrLister === 'string' ? [rootsOrLister] : [...rootsOrLister]).map((root) => resolve(root))
  // 嵌套的根按 realpath 收成一份：被包含的那条不再单独遍历，同一批文件只列一次。
  const roots = dedupeContainedWorkspaceRoots(requested)
  if (roots.length === 0) return []
  const hits: WalkHit[] = []
  const budget: WalkBudget = { left: WALK_MAX_FILES }
  // 每根的最小配额：总预算的 1/4 与 200 条取小；根多到均分不足 1 条时按根数降档。
  const minPerRoot = Math.max(1, Math.min(WALK_MIN_FILES_PER_ROOT, Math.floor(WALK_MAX_FILES / roots.length)))
  for (let index = 0; index < roots.length && budget.left > 0; index += 1) {
    const remaining = roots.length - index - 1
    // 先给后面的每个根留出最小配额，第一个巨根就不能把预算吃光。
    const reserve = Math.min(minPerRoot * remaining, Math.max(0, budget.left - 1))
    const allowance = budget.left - reserve
    const local: WalkBudget = { left: allowance }
    // 只有主根可能被别的根包住（其余被包含的根已经在收口时丢掉了）：外层根跳过主根子树。
    const skipRoots = index !== 0 && rootContains(roots[index]!, roots[0]!) ? [roots[0]!] : []
    await walkWorkspaceRoot(lister, roots[index]!, '', 0, local, hits, index, skipRoots)
    budget.left -= allowance - Math.max(0, local.left)
  }
  // 主根的顶层目录名也占着 `<名字>/...` 这个 label 前缀，要参与撞名判定（见 rootLabelPrefixes）。
  const mainTopDirs = new Set<string>()
  for (const hit of hits) {
    if (hit.rootIndex !== 0) continue
    const slash = hit.rel.indexOf('/')
    if (slash > 0) mainTopDirs.add(hit.rel.slice(0, slash))
  }
  const prefixes = rootLabelPrefixes(roots, mainTopDirs)
  return hits.map((hit) => {
    const root = roots[hit.rootIndex]!
    const main = hit.rootIndex === 0
    return {
      path: main ? hit.rel : resolve(root, hit.rel),
      root,
      label: main ? hit.rel : `${prefixes[hit.rootIndex]}/${hit.rel}`,
    }
  })
}
