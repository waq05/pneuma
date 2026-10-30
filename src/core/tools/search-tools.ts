/**
 * 搜索工具两件套：glob（文件名匹配）/ grep（内容匹配）。
 *
 * 三条口径（2026-10-30 重写，全部来自真实报障）：
 *
 *   1. **遍历时必须按 `.gitignore` 跳过**：项目里 `uv sync` 一次，`.venv` 就是几千个文件；
 *      以前的遍历把它们全收进列表再过滤，结果被这些噪声挤掉。
 *   2. **边遍历边匹配，够数就停**：旧实现先收 10000 条再过滤，`.venv` 正好能把额度吃光，
 *      于是根目录的 `main.py`、`README.md` 根本没进过列表——表现是「无匹配」，看起来像
 *      文件不存在。这不是 .gitignore 的问题，是**静默截断**，比不给结果更坏。
 *   3. **截断要说出来**：命中上限时明确写「还有更多」，不假装这就是全部。
 *
 * 跳过规则分两层：内置的大目录表（`.venv` / `node_modules` / `__pycache__` 等，即使仓库
 * 没写 `.gitignore` 也不会被他们淹没）+ 仓库自己的 `.gitignore`（从 git 根逐层读到搜索根，
 * 子目录的 `.gitignore` 在遍历到它时生效）。否定规则（`!`）按「后出现的赢」处理。
 *
 * @module dsc/core/tools/search-tools
 */
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ToolEntry } from '../tools.js'

/**
 * 无论 `.gitignore` 怎么写都跳过的目录：装依赖/缓存/编译产物，它们不是「别人的项目」，
 * 是**当前项目的噪声**。留一个是留隐患——`uv sync` 出来的是 `.venv`，pnpm 出来的是
 * `node_modules`，都会把遍历额度吃光。
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'site-packages',
  'target',
  'Pods',
])

const MAX_FILE_BYTES = 1024 * 1024

/** 大括号展开最多出几条模式：`{a,b}{c,d}` 这种组合会指数增长，得有个头。 */
const BRACE_EXPANSION_LIMIT = 64

/** 正则元字符：glob 里的字面量段搬进 RegExp 之前先过这一道。 */
const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g

/** 按顶层逗号切一段（`a,{b,c}` 里内层的逗号不切）。 */
function splitBraceOptions(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/**
 * 把 `{a,b}` 展开成多条模式（花括号展开的最小子集，支持嵌套）。
 *
 * 为什么要有（2026-10-30）：反馈里那条 `{vue,ts,js,json}` 多选模式一条都没匹配上，
 * 而且**不报错**，看起来就像「这个目录是空的」——一次误判足以让模型走错方向。
 * 只有真带逗号的 `{a,b}` 才展开：`{single}` 在 shell 里是字面量，这里保持一致。
 * `{` 没有配对的 `}` 直接报错，不静默返回空结果。
 *
 * @param pattern - 原始模式。
 * @param limit - 最多展开出几条；超出后截断（宁少不多，避免一次请求铺开几百个匹配器）。
 * @returns 展开后的模式列表（不需要展开时就是原样一条）。
 */
export function expandBraces(pattern: string, limit = BRACE_EXPANSION_LIMIT): string[] {
  const open = pattern.indexOf('{')
  if (open < 0) return [pattern]
  let depth = 0
  let close = -1
  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === '{') depth += 1
    else if (pattern[i] === '}') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close < 0) throw new Error(`glob 模式里的 { 没有配对的 }：${pattern}`)
  const options = splitBraceOptions(pattern.slice(open + 1, close))
  if (options.length < 2) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const out: string[] = []
  for (const option of options) {
    for (const expanded of expandBraces(`${prefix}${option}${suffix}`, limit)) {
      out.push(expanded)
      if (out.length >= limit) return out
    }
  }
  return out
}

/** 把 glob 模式转 RegExp：`**` 跨目录段，`*`/`?` 段内。 */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let source = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        source += '.*'
        i += 1
        if (normalized[i + 1] === '/') i += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(ESCAPE_RE, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

// ── .gitignore ──────────────────────────────────────────────────────────────

/** 一条忽略规则：`dir` 是它所在的目录，匹配的是相对该目录的路径。 */
interface IgnoreRule {
  dir: string
  regex: RegExp
  negate: boolean
  /** 只忽略目录（`build/` 这种写法）。 */
  dirOnly: boolean
}

/**
 * 把 `.gitignore` 的正文解析成规则表。
 *
 * 支持子集：注释、空行、`!` 否定、结尾 `/`（只匹配目录）、开头 `/`（锚定到本目录）、
 * 含 `/` 的模式（相对本目录）、不含 `/` 的模式（匹配任意层级的同名项）、`*` `?` `**`。
 * 不支持 `[a-z]` 字符集与 `\\` 转义——遇到就按字面量处理，宁可少忽略也不错忽略。
 */
export function parseGitignore(text: string, dir: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    }
    // 结尾空白在 gitignore 里要靠反斜杠转义才算内容；行尾空格直接忽略即可（本实现不处理转义）
    line = line.trimEnd()
    if (line === '') continue
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.startsWith('/') || line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (line === '') continue
    const body = globToRegExpSource(line)
    // 不含 / 的模式匹配任意层级：`*.log` 等于 `**/*.log`
    const source = anchored || line.includes('/') ? `^${body}$` : `^(?:.*/)?${body}$`
    rules.push({ dir, regex: new RegExp(source), negate, dirOnly })
  }
  return rules
}

/** glob → 正则片段（不锚定，供 gitignore 复用；与 {@link globToRegExp} 同一套语义）。 */
function globToRegExpSource(pattern: string): string {
  const normalized = pattern.replace(/\\/g, '/')
  let source = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        source += '.*'
        i += 1
        if (normalized[i + 1] === '/') i += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(ESCAPE_RE, '\\$&')
    }
  }
  return source
}

/** 这条规则对绝对路径成不成立：不在规则目录下面的直接不算。 */
function ruleMatches(rule: IgnoreRule, absPath: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false
  const rel = relative(rule.dir, absPath).replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('../') || isAbsolute(rel)) return false
  return rule.regex.test(rel)
}

/** 后出现的规则赢：命中一条就翻转一次结论。 */
function isIgnored(rules: readonly IgnoreRule[], absPath: string, isDir: boolean): boolean {
  let ignored = false
  for (const rule of rules) {
    if (ruleMatches(rule, absPath, isDir)) ignored = !rule.negate
  }
  return ignored
}

/** git 根：从 `dir` 往上找带 `.git` 的目录；找不到就用 `dir` 自己。 */
async function findGitRoot(dir: string): Promise<string> {
  let current = resolve(dir)
  for (;;) {
    try {
      await fs.stat(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(dir)
      current = parent
    }
  }
}

/** 从 git 根到 `root` 沿途每一层的 `.gitignore` 依次读进来（祖先的规则先于子目录）。 */
async function loadIgnoreChain(root: string): Promise<IgnoreRule[]> {
  const gitRoot = await findGitRoot(root)
  const chain: string[] = []
  let current = resolve(root)
  for (;;) {
    chain.unshift(current)
    if (current === gitRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const rules: IgnoreRule[] = []
  for (const dir of chain) {
    try {
      const text = await fs.readFile(join(dir, '.gitignore'), 'utf8')
      rules.push(...parseGitignore(text, dir))
    } catch {
      // 没有 .gitignore 是常态
    }
  }
  return rules
}

// ── 遍历 ────────────────────────────────────────────────────────────────────

/**
 * 递归遍历，**边遍历边交给回调**：回调返回 false 表示「够了，别走了」。
 *
 * 与旧实现（先收 10000 条再过滤）的区别：额度按「命中的文件」算，不按「走过的文件」算，
 * 所以 `.venv` 再大也挤不掉别的结果。目录级的忽略在这里判定——命中就整棵子树不进去。
 *
 * @param dir - 当前目录
 * @param rules - 继承下来的忽略规则；本目录的 `.gitignore` 在这里读入并继续往下传
 * @param visit - 对每个文件调用一次；返回 false 立刻停
 */
async function walkFiles(
  dir: string,
  rules: readonly IgnoreRule[],
  visit: (file: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  let local = rules
  try {
    const text = await fs.readFile(join(dir, '.gitignore'), 'utf8')
    local = [...rules, ...parseGitignore(text, dir)]
  } catch {
    // 没有就是没有
  }
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return true
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      if (isIgnored(local, full, true)) continue
      const more = await walkFiles(full, local, visit)
      if (!more) return false
    } else if (entry.isFile()) {
      if (isIgnored(local, full, false)) continue
      if (!(await visit(full))) return false
    }
  }
  return true
}

const displayPath = (root: string, file: string): string => relative(root, file).replace(/\\/g, '/')

/** 截断时补的那句话：说清「这不是全部」，并给出缩小范围的办法。 */
const truncatedNote = (shown: number): string =>
  `\n（只显示前 ${String(shown)} 条，还有更多；把 pattern 或 path 收窄一点再看全部）`

export const globTool: ToolEntry = {
  name: 'glob',
  description:
    '按文件名模式查找文件（相对当前目录）。支持 ** 跨目录、* 段内通配、? 单字符、{a,b} 花括号多选。' +
    '默认跳过 .gitignore 命中的文件与 node_modules/.venv/__pycache__ 等大目录。' +
    '例：**/*.ts、src/*.json、**/*.{vue,ts,js}。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式（支持 {a,b} 多选）' },
      path: { type: 'string', description: '搜索根目录（默认当前目录）' },
      limit: { type: 'number', description: '最多返回条数（默认 100）' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  async run(args, ctx) {
    if (typeof args.pattern !== 'string' || args.pattern === '') throw new Error('pattern 必须是非空字符串')
    const root = typeof args.path === 'string' && args.path !== ''
      ? (isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path))
      : ctx.cwd
    const limit = Math.max(1, typeof args.limit === 'number' ? Math.floor(args.limit) : 100)
    // {a,b} 先展开成多条模式再逐条编译：`**/*.{vue,ts}` 以前被当成字面量，静默给「无匹配」。
    const matchers = expandBraces(args.pattern).map(globToRegExp)
    const rules = await loadIgnoreChain(root)
    const hits: string[] = []
    let truncated = false
    await walkFiles(root, rules, (file) => {
      const rel = displayPath(root, file)
      if (!matchers.some((matcher) => matcher.test(rel))) return true
      if (hits.length >= limit) {
        truncated = true
        return false
      }
      hits.push(rel)
      return true
    })
    if (hits.length === 0) return `（无匹配：${args.pattern}）`
    return `${hits.join('\n')}${truncated ? truncatedNote(limit) : ''}`
  },
}

export const grepTool: ToolEntry = {
  name: 'grep',
  description:
    '在目录内按行搜索内容（正则或纯文本），返回 文件:行号: 内容。跳过二进制与大文件，' +
    '并默认跳过 .gitignore 命中的文件与 node_modules/.venv/__pycache__ 等大目录。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索内容（正则；非法正则退化为字面量）' },
      path: { type: 'string', description: '搜索根目录或单文件（默认当前目录）' },
      maxResults: { type: 'number', description: '最多返回行数（默认 100）' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  async run(args, ctx) {
    if (typeof args.pattern !== 'string' || args.pattern === '') throw new Error('pattern 必须是非空字符串')
    let matcher: RegExp
    try {
      matcher = new RegExp(args.pattern, 'i')
    } catch {
      matcher = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    const maxResults = Math.max(1, typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : 100)
    const root = typeof args.path === 'string' && args.path !== ''
      ? (isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path))
      : ctx.cwd
    const rootStat = await fs.stat(root)
    const lines: string[] = []
    /** 读一个文件、把命中的行攒进去；返回 false 表示「够数了」。 */
    const scan = async (file: string): Promise<boolean> => {
      let stat
      try {
        stat = await fs.stat(file)
      } catch {
        return true
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return true
      let content: string
      try {
        content = await fs.readFile(file, 'utf8')
      } catch {
        return true
      }
      if (content.includes('\0')) return true
      const split = content.split(/\r?\n/)
      for (let index = 0; index < split.length; index += 1) {
        if (lines.length >= maxResults) return false
        if (matcher.test(split[index])) {
          lines.push(`${displayPath(root, file)}:${String(index + 1)}: ${split[index].trim().slice(0, 200)}`)
        }
      }
      return true
    }
    let truncated = false
    if (rootStat.isFile()) {
      await scan(root)
    } else {
      const rules = await loadIgnoreChain(root)
      // 边遍历边扫：够数就停，不需要先把几千个路径攒进数组（旧毛病的来源之一）。
      await walkFiles(root, rules, async (file) => {
        if (lines.length >= maxResults) {
          truncated = true
          return false
        }
        return scan(file)
      })
    }
    if (lines.length === 0) return `（无匹配：${args.pattern}）`
    return `${lines.join('\n')}${truncated ? truncatedNote(maxResults) : ''}`
  },
}
