/**
 * 技能市场：从一个源浏览并安装技能。
 *
 * 支持四类源（源清单在 `~/.dsc/settings.json`，见 core/prefs.ts）：
 *   1. GitHub 目录链接，如 `https://github.com/<owner>/<repo>/tree/<ref>/<dir>`
 *      —— 用一次 `git/trees?recursive=1` 列出目录，正文与附属文件走 raw 域名；
 *   2. 索引 JSON，如 `https://example.com/skills/index.json`
 *      —— 形状 `{ skills: [{ name, description, version?, path?, files? }] }`（也接受裸数组）；
 *   3. ClawHub，即 `https://clawhub.ai/api/v1/skills?sort=downloads&limit=100`
 *      —— 官方注册中心，列表给下载/安装/星标数；安装拉它打好的 zip 整包解压；
 *   4. skills.sh，即 `https://skills.sh/api/search`
 *      —— **只有搜索接口**（`q` 至少 2 字符），没有榜单；条目指向 GitHub 仓库，
 *      安装时按 `<repo>/<skill>/SKILL.md` 在仓库树里定位后走 raw 域名。
 *
 * 三条约束：条目清单缓存 1 小时（`~/.dsc/cache/`）；GitHub 匿名限额低，
 * 有 `GITHUB_TOKEN` 就用；单文件超过 1.5 MB 或单技能附属文件超过 40 个不拉，
 * 免得一次安装把家目录灌满。
 *
 * @module dsc/core/market
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { inflateRawSync } from 'node:zlib'
import type { MarketSkillView, MarketSource } from '@pneuma/runtime/contract.js'
import { errText } from '@pneuma/runtime/core/err-text.js'
import { parseSkillMarkdown } from '@pneuma/runtime/core/skills.js'
import { dscPath } from '@pneuma/runtime/core/path-policy.js'

const CACHE_DIR = dscPath('cache')
const CACHE_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000
/**
 * 浏览阶段「补描述」的总预算。
 *
 * 为什么要有：GitHub 源的条目描述要靠逐个拉 SKILL.md 解析 frontmatter，这一跳走
 * raw 域名，不受 GitHub API 的可用性保护。2026-11-07 那次 raw 整域名故障里，19 个
 * 目录每个等满 15 秒、6 路并发跑了 4 批，整次浏览 61 秒，界面那边 30 秒就超时了。
 * 描述只是美化，不该让一个挂掉的域名决定「市场能不能打开」——所以给它一个总预算，
 * 到点就用占位描述返回，正文安装后本地解析。
 */
const ENRICH_BUDGET_MS = 6_000
/** 补描述时单个文件的超时：它只值几秒，不值得按正文那档等 15 秒。 */
const ENRICH_TIMEOUT_MS = 4_000
const MAX_EXTRA_FILES = 40
const MAX_FILE_BYTES = 1_500_000
const BROWSE_CONCURRENCY = 6

/** 安装所需的内部条目（UI 只看 MarketSkillView）。 */
export interface MarketEntry {
  name: string
  description: string
  version?: string
  source: string
  /** dir = 目录包（内含 mainFile）；flat = 单个 markdown 文件；zip = 整包归档；
   *  repo-dir = 只知道「仓库 + 技能名」，安装时去仓库树里定位目录。 */
  kind: 'dir' | 'flat' | 'zip' | 'repo-dir'
  /** 取文件的根：rawBase 存在时它是相对 raw 根的路径，否则本身就是绝对 URL。 */
  root: string
  /** 主文件名（dir 是 `SKILL.md`，flat 是 `<name>.md`；zip 用不到）。 */
  mainFile: string
  /** 附属文件（相对 root，如 `references/x.md`）。 */
  files: string[]
  /** GitHub raw 根（`https://raw.githubusercontent.com/<owner>/<repo>/<ref>`）。 */
  rawBase?: string
  /**
   * 市场侧的统计（ClawHub 给下载/安装/星标；其它源没有）。
   * 只用来展示，不进安装链路。
   */
  stats?: { downloads?: number; installs?: number; stars?: number }
}

/** ClawHub 的 API 根（源地址若只填站点根，就用它拼榜单地址）。 */
const CLAWHUB_API = 'https://clawhub.ai/api/v1'

/** 源地址是不是 ClawHub（按站点域名认，用户手填 `https://clawhub.ai/` 也算）。 */
export function isClawHubSource(url: string): boolean {
  return /^https?:\/\/clawhub\.ai(?:[/?#]|$)/i.test(url.trim())
}

/** 源地址是不是 skills.sh（同样按域名认）。 */
export function isSkillsShSource(url: string): boolean {
  return /^https?:\/\/skills\.sh(?:[/?#]|$)/i.test(url.trim())
}

/**
 * ClawHub 的榜单地址：源地址已经是 API 路径就原样用（尊重用户写的 sort/limit），
 * 只填了站点根就补一份默认的「下载榜前 100」。
 */
export function clawHubListUrl(url: string): string {
  const trimmed = url.trim()
  try {
    if (new URL(trimmed).pathname.startsWith('/api/')) return trimmed
  } catch {
    // 地址坏到解析不了：交给 fetch 去报错，这里退回默认榜单
  }
  return `${CLAWHUB_API}/skills?sort=downloads&limit=100`
}

/** skills.sh 的搜索地址：源地址带 `?q=` 就原样用，否则按关键词拼一份。 */
export function skillsShSearchUrl(url: string, query: string): string {
  const trimmed = url.trim()
  if (/[?&]q=/.test(trimmed)) return trimmed
  const base = trimmed.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const path = /\/api\/search$/.test(base) ? base : `${base}/api/search`
  return `${path}?q=${encodeURIComponent(query)}&limit=100`
}

async function fetchBytes(url: string, headers: Record<string, string> = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'dsc-skill-market', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}（${url}）`)
  return new Uint8Array(await response.arrayBuffer())
}

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(url, {}, timeoutMs))
}

/** 一个条目的某个文件该从哪儿取。 */
function fileUrl(entry: MarketEntry, relative: string): string {
  const base =
    entry.rawBase !== undefined && !entry.root.startsWith('http')
      ? `${entry.rawBase}/${entry.root}`
      : entry.root
  return `${base}/${relative}`
}

/** 并发受限的 map（结果按输入顺序返回）。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await work(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

interface GitHubRef {
  owner: string
  repo: string
  ref: string
  dir: string
}

/** 解析 GitHub 目录链接（`/tree/<ref>/<dir>`，省略 dir 表示仓库根）。 */
export function parseGitHubTree(url: string): GitHubRef | null {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+?))?\/?$/i.exec(url.trim())
  if (match === null) return null
  const [, owner, repo, ref, dir] = match
  if (owner === undefined || repo === undefined || ref === undefined) return null
  return { owner, repo, ref, dir: (dir ?? '').replace(/^\/+|\/+$/g, '') }
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  return token === '' ? {} : { authorization: `Bearer ${token}` }
}

/** GitHub 源：一次递归 trees 列目录，再并发取各 SKILL.md 的 frontmatter。 */
async function browseGitHub(source: MarketSource): Promise<MarketEntry[]> {
  const ref = parseGitHubTree(source.url)
  if (ref === null) {
    throw new Error('源地址既不是 GitHub 目录链接，也不是 .json 索引（形如 https://github.com/owner/repo/tree/main/skills）')
  }
  const api = `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.ref)}?recursive=1`
  const response = await fetch(api, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsc-skill-market', ...githubHeaders() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    if (response.status === 403 || response.status === 422) {
      throw new Error(`GitHub API 拒绝（${response.status}）：匿名限额较低，设置 GITHUB_TOKEN 后重试`)
    }
    throw new Error(`GitHub API ${response.status} ${response.statusText}（${api}）`)
  }
  const payload = (await response.json()) as { tree?: { path?: string; type?: string }[] }
  const prefix = ref.dir === '' ? '' : `${ref.dir}/`
  const rawBase = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.ref}`

  const dirSkills = new Map<string, string[]>()
  const flatSkills: string[] = []
  for (const node of payload.tree ?? []) {
    const path = node.path ?? ''
    if (node.type !== 'blob') continue
    if (prefix !== '' && !path.startsWith(prefix)) continue
    const relative = prefix === '' ? path : path.slice(prefix.length)
    const segments = relative.split('/')
    if (segments.length === 1) {
      if (relative.endsWith('.md') && relative.toLowerCase() !== 'readme.md') flatSkills.push(relative)
      continue
    }
    const skillName = segments[0] as string
    const inside = segments.slice(1).join('/')
    const extras = dirSkills.get(skillName)
    if (extras === undefined) dirSkills.set(skillName, inside === 'SKILL.md' ? [] : [inside])
    else if (inside !== 'SKILL.md' && extras.length < MAX_EXTRA_FILES) extras.push(inside)
  }
  // 只有确实含 SKILL.md 的目录才算技能；上面一遍没记录 mainFile，这里按路径复查
  const blobs = new Set((payload.tree ?? []).map((node) => node.path ?? ''))

  const entries: MarketEntry[] = []
  const dirs = [...dirSkills.keys()].sort()
  /**
   * 补描述：拿 frontmatter 里的一句话说明。**有总预算**——到点就保留占位描述返回，
   * 不让一个挂掉的文件域名把整次浏览拖到界面超时（见 ENRICH_BUDGET_MS）。
   */
  const enrichDeadline = Date.now() + ENRICH_BUDGET_MS
  const enrich = async (entry: MarketEntry, relative: string): Promise<void> => {
    const remaining = enrichDeadline - Date.now()
    if (remaining <= 0) return
    try {
      const text = await fetchText(fileUrl(entry, relative), Math.min(ENRICH_TIMEOUT_MS, remaining))
      entry.description = describe(parseSkillMarkdown(text))
    } catch {
      // 取不到 frontmatter 就保留占位描述，安装时再本地解析
    }
  }
  entries.push(
    ...(await mapLimit(dirs, BROWSE_CONCURRENCY, async (name): Promise<MarketEntry> => {
      const entry: MarketEntry = {
        name,
        description: '未提供描述，安装后本地解析',
        source: source.name,
        kind: 'dir',
        root: `${prefix}${name}`,
        mainFile: 'SKILL.md',
        files: (dirSkills.get(name) ?? []).filter((file) => blobs.has(`${prefix}${name}/${file}`)),
        rawBase,
      }
      await enrich(entry, 'SKILL.md')
      return entry
    })),
  )
  entries.push(
    ...(await mapLimit(flatSkills.sort(), BROWSE_CONCURRENCY, async (path): Promise<MarketEntry> => {
      const entry: MarketEntry = {
        name: basename(path, '.md'),
        description: '未提供描述，安装后本地解析',
        source: source.name,
        kind: 'flat',
        root: path.slice(0, Math.max(0, path.lastIndexOf('/'))),
        mainFile: basename(path),
        files: [],
        rawBase,
      }
      await enrich(entry, entry.mainFile)
      return entry
    })),
  )
  return entries
}

/** 索引 JSON 源。 */
async function browseIndex(source: MarketSource): Promise<MarketEntry[]> {
  const doc = JSON.parse(await fetchText(source.url)) as unknown
  const list = Array.isArray(doc) ? doc : ((doc as { skills?: unknown }).skills ?? (doc as { items?: unknown }).items)
  if (!Array.isArray(list)) throw new Error('索引里找不到 skills 数组')
  const dirUrl = source.url.replace(/[^/]*$/, '')
  const entries: MarketEntry[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (name === '') continue
    const path = typeof item.path === 'string' && item.path !== '' ? item.path : `${name}/SKILL.md`
    const absolute = new URL(path, dirUrl).toString()
    const isFlat = /\.md$/i.test(absolute)
    entries.push({
      name,
      description: typeof item.description === 'string' ? item.description : '',
      version: typeof item.version === 'string' ? item.version : undefined,
      source: source.name,
      kind: isFlat ? 'flat' : 'dir',
      root: isFlat ? absolute.replace(/\/[^/]*$/, '') : absolute,
      mainFile: basename(absolute),
      files: Array.isArray(item.files)
        ? item.files.filter((file): file is string => typeof file === 'string')
        : [],
    })
  }
  return entries
}

/** 从一条 ClawHub 记录里取一个有限数（缺了就不给，别拿 0 冒充读数）。 */
function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 把 unknown 收成「非空字符串」，否则给空串。 */
function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * ClawHub 源：官方注册中心的榜单（默认下载榜前 100）。
 *
 * 列表已经带齐了展示要用的东西（描述、版本、下载/安装/星标），不必逐条再拉；
 * 安装时才去 `/skills/<slug>/install` 换一个 zip 的下载地址。
 */
async function browseClawHub(source: MarketSource): Promise<MarketEntry[]> {
  const payload = JSON.parse(await fetchText(clawHubListUrl(source.url))) as { items?: unknown }
  const list = Array.isArray(payload.items) ? payload.items : []
  const entries: MarketEntry[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const slug = readText(item.slug)
    const owner = readText(item.ownerHandle)
    if (slug === '' || owner === '') continue
    const stats = item.stats !== null && typeof item.stats === 'object' ? (item.stats as Record<string, unknown>) : {}
    const latest = item.latestVersion !== null && typeof item.latestVersion === 'object' ? (item.latestVersion as Record<string, unknown>) : {}
    const version = readText(latest.version)
    const summary = readText(item.summary)
    const display = readText(item.displayName)
    entries.push({
      name: slug,
      description: summary === '' ? (display === '' ? '未提供描述，安装后本地解析' : display) : summary,
      version: version === '' ? undefined : version,
      source: source.name,
      kind: 'zip',
      // root 就是「换 zip 地址」的那一次调用；安装时按它取 downloadUrl
      root:
        `${CLAWHUB_API}/skills/${encodeURIComponent(slug)}/install?owner=${encodeURIComponent(owner)}` +
        (version === '' ? '' : `&version=${encodeURIComponent(version)}`),
      mainFile: 'SKILL.md',
      files: [],
      stats: {
        downloads: readCount(stats.downloads),
        installs: readCount(stats.installs),
        stars: readCount(stats.stars),
      },
    })
  }
  return entries
}

/**
 * skills.sh 源：**只有搜索**（它的站上没有榜单接口，`/api/skills` 是 404）。
 *
 * 所以没有关键词就直说，不拿空结果冒充「这个源没东西」。搜索结果只给仓库与技能名，
 * 安装时才去 GitHub 仓库里定位 `<技能名>/SKILL.md` 所在目录。
 */
async function browseSkillsSh(source: MarketSource, query: string): Promise<MarketEntry[]> {
  const needle = query.trim()
  if (needle.length < 2) {
    throw new Error('skills.sh 只提供搜索：在上面的搜索框输入至少 2 个字符再查（它没有榜单接口）')
  }
  const payload = JSON.parse(await fetchText(skillsShSearchUrl(source.url, needle))) as { skills?: unknown }
  const list = Array.isArray(payload.skills) ? payload.skills : []
  const entries: MarketEntry[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const skillId = readText(item.skillId)
    const repo = readText(item.source)
    if (skillId === '' || repo === '') continue
    const installs = readCount(item.installs)
    entries.push({
      name: skillId,
      description:
        installs === undefined
          ? `${repo} 里的技能（安装时从仓库取正文）`
          : `${repo} 里的技能 · ${installs.toLocaleString('en-US')} 次安装`,
      source: source.name,
      kind: 'repo-dir',
      // root 存 `owner/repo`，mainFile 存技能名；安装时用 trees 接口定位目录
      root: repo,
      mainFile: skillId,
      files: [],
      stats: { installs },
    })
  }
  return entries
}

/** 描述行：有 when-to-use 就拼在后面，技能卡片一行放得下。 */
function describe(parsed: { description: string; whenToUse?: string }): string {
  if (parsed.description === '') return '（frontmatter 没写 description）'
  return parsed.whenToUse === undefined
    ? parsed.description
    : `${parsed.description} · 何时用：${parsed.whenToUse}`
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `market-${createHash('sha1').update(key.trim()).digest('hex').slice(0, 16)}.json`)
}

/**
 * 浏览一个源（1 小时内命中缓存不联网）。
 *
 * `query` 只对 skills.sh 这类**搜索型源**有意义：它的条目取决于关键词，所以缓存键
 * 要带上关键词，否则换个词查到的还是上一个词的结果。
 */
export async function browseMarketSource(
  source: MarketSource,
  options: { refresh?: boolean; query?: string } = {},
): Promise<MarketEntry[]> {
  const needle = (options.query ?? '').trim()
  const searchDriven = isSkillsShSource(source.url)
  const file = cachePath(searchDriven ? `${source.url}\u0000${needle}` : source.url)
  if (options.refresh !== true && existsSync(file)) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as { at?: number; entries?: MarketEntry[] }
      if (typeof doc.at === 'number' && Date.now() - doc.at < CACHE_TTL_MS && Array.isArray(doc.entries)) {
        return doc.entries
      }
    } catch {
      // 缓存坏了就重新拉
    }
  }
  const entries = isClawHubSource(source.url)
    ? await browseClawHub(source)
    : searchDriven
      ? await browseSkillsSh(source, needle)
      : /\.json(\?|$)/i.test(source.url.trim())
        ? await browseIndex(source)
        : await browseGitHub(source)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ at: Date.now(), entries }), 'utf8')
  return entries
}

/** zip 里一个条目解出来的文件（相对路径 + 内容）。 */
interface ZipFile {
  path: string
  data: Uint8Array
}

/**
 * 解一个 zip（ClawHub 的包格式）。只认 stored(0) 与 deflate(8) 两种压缩法——
 * 这两条覆盖了所有正常打出来的技能包，其余压缩法当场报错，不写半份文件。
 *
 * 为什么自己解：宿主不引第三方依赖，而 Node 的 zlib 已经给了 `inflateRawSync`，
 * 剩下的只是读中央目录这一层壳（约 40 行）。
 */
function readZip(bytes: Uint8Array): ZipFile[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 从尾部往回找 End of Central Directory（签 0x06054b50），注释最长 64KB
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65_535); offset -= 1) {
    if (view.getUint32(offset, true) === 0x0605_4b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('不是 zip（找不到中央目录）：源返回的可能是错误页')
  const count = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)
  const files: ZipFile[] = []
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x0201_4b50) throw new Error('zip 中央目录损坏')
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    // 安全：拒绝穿越出目标目录的路径
    if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      throw new Error(`zip 里有不安全的路径：${name}`)
    }
    if (view.getUint32(localOffset, true) !== 0x0403_4b50) throw new Error(`zip 条目损坏：${name}`)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = bytes.subarray(start, start + compressedSize)
    if (method === 0) files.push({ path: name, data: raw })
    else if (method === 8) files.push({ path: name, data: new Uint8Array(inflateRawSync(raw)) })
    else throw new Error(`zip 用了不支持的压缩法（${String(method)}）：${name}`)
  }
  return files
}

/** 按 ClawHub 的流程装一个 zip 包：先换下载地址，再整包解开写进目录。 */
async function installZipEntry(
  entry: MarketEntry,
  destRoot: string,
  target: string,
): Promise<{ target: string; files: number }> {
  const ticket = JSON.parse(await fetchText(entry.root)) as { archive?: { downloadUrl?: unknown }; ok?: unknown }
  const downloadUrl = readText(ticket.archive?.downloadUrl)
  if (ticket.ok === false || downloadUrl === '') throw new Error('源没有给出下载地址（这个技能可能已下架）')
  const files = readZip(await fetchBytes(downloadUrl))
  const main = files.find((file) => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'))
  if (main === undefined) throw new Error('包里没有 SKILL.md，不像一个技能')
  let written = 0
  for (const file of files) {
    if (file.data.byteLength > MAX_FILE_BYTES) continue
    const path = join(target, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.data)
    written += 1
  }
  return { target, files: written }
}

/**
 * 按「GitHub 仓库 + 技能名」定位目录再装（skills.sh 的条目只有这两个信息）。
 *
 * 技能在仓库里的位置不固定（`skills/<名>`、`skills/misc/<名>` 都见过），所以对
 * 仓库做一次递归 trees，取**以 `<名>/SKILL.md` 结尾**的那条路径作为技能目录。
 */
async function installRepoDirEntry(
  entry: MarketEntry,
  destRoot: string,
): Promise<{ target: string; files: number }> {
  const match = /^([^/]+)\/([^/]+)$/.exec(entry.root)
  if (match === null) throw new Error(`仓库地址认不出：${entry.root}`)
  const [, owner, repo] = match
  if (owner === undefined || repo === undefined) throw new Error(`仓库地址认不出：${entry.root}`)
  const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`
  const response = await fetch(api, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsc-skill-market', ...githubHeaders() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}（${api}）`)
  const payload = (await response.json()) as { tree?: { path?: string; type?: string }[] }
  const suffix = `${entry.mainFile}/SKILL.md`
  const blobs = (payload.tree ?? []).filter((node) => node.type === 'blob').map((node) => node.path ?? '')
  const main = blobs.find((path) => path === 'SKILL.md' || path === suffix || path.endsWith(`/${suffix}`))
  if (main === undefined) throw new Error(`仓库 ${entry.root} 里找不到 ${suffix}`)
  const dir = main.slice(0, Math.max(0, main.length - 'SKILL.md'.length)).replace(/\/$/, '')
  const prefix = dir === '' ? '' : `${dir}/`
  // 复用目录包的安装：把仓库树收成一次 GitHub 源的条目，再走同一条写盘路径
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD`
  const synthetic: MarketEntry = {
    name: entry.name,
    description: entry.description,
    version: entry.version,
    source: entry.source,
    kind: 'dir',
    root: dir,
    mainFile: 'SKILL.md',
    files: blobs
      .filter((path) => path.startsWith(prefix) && path !== main)
      .map((path) => path.slice(prefix.length))
      .slice(0, MAX_EXTRA_FILES),
    rawBase,
  }
  return installMarketEntry(synthetic, destRoot)
}

/** 拉取一个条目并写进技能目录；返回落盘位置与文件数。 */
export async function installMarketEntry(
  entry: MarketEntry,
  destRoot: string,
): Promise<{ target: string; files: number }> {
  if (entry.kind === 'repo-dir') return installRepoDirEntry(entry, destRoot)
  const target = join(destRoot, entry.kind === 'flat' ? `${entry.name}.md` : entry.name)
  if (existsSync(target)) throw new Error(`本地已有 ${entry.name}，先在技能中心删掉旧文件再装`)
  if (entry.kind === 'zip') return installZipEntry(entry, destRoot, target)
  const write = (relative: string): Promise<boolean> =>
    fetchBytes(fileUrl(entry, relative)).then((bytes) => {
      if (bytes.byteLength > MAX_FILE_BYTES) return false
      const path = join(destRoot, entry.kind === 'dir' ? entry.name : '', relative)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes)
      return true
    })
  let written = (await write(entry.mainFile)) ? 1 : 0
  if (written === 0) throw new Error(`拉取 ${entry.mainFile} 失败（文件超过 ${Math.round(MAX_FILE_BYTES / 1_048_576)} MB 上限）`)
  if (entry.kind === 'dir') {
    for (const relative of entry.files) {
      try {
        if (await write(relative)) written += 1
      } catch {
        // 附属文件取不到不阻塞安装：正文里引用的话本地会报找不到，用户可重装
      }
    }
  }
  return { target, files: written }
}

/** 内部条目 → UI 条目。 */
export function toMarketSkillView(entry: MarketEntry, installedNames: ReadonlySet<string>): MarketSkillView {
  return {
    name: entry.name,
    description: entry.description,
    source: entry.source,
    version: entry.version,
    installed: installedNames.has(entry.name),
    stats: entry.stats,
  }
}

// ── T28：插件市场（外部插件的远程安装，机制照技能市场的两类源）────────────────

/**
 * 浏览一个插件市场源，返回可安装的**单文件 .js 插件**条目：
 *   - GitHub 目录链接（`https://github.com/…/tree/<ref>/<dir>`）：目录下（递归）的
 *     `*.js` blob 各算一个插件；
 *   - 索引 JSON（`.json` 结尾）：`[{ "name", "file", "description?", "version?" }]`，
 *     file 缺省按 `<name>.js` 相对索引地址解析。
 */
export async function browsePluginMarketSource(source: MarketSource): Promise<MarketEntry[]> {
  if (/\.json(\?|$)/i.test(source.url.trim())) {
    const doc = JSON.parse(await fetchText(source.url)) as unknown
    const list = Array.isArray(doc) ? doc : ((doc as { plugins?: unknown }).plugins ?? (doc as { items?: unknown }).items)
    if (!Array.isArray(list)) throw new Error('索引里找不到 plugins 数组')
    const dirUrl = source.url.replace(/[^/]*$/, '')
    const entries: MarketEntry[] = []
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      if (name === '') continue
      const path = typeof item.file === 'string' && item.file !== '' ? item.file : `${name}.js`
      const absolute = new URL(path, dirUrl).toString()
      if (!absolute.endsWith('.js')) continue
      entries.push({
        name,
        description: typeof item.description === 'string' ? item.description : '',
        version: typeof item.version === 'string' ? item.version : undefined,
        source: source.name,
        kind: 'flat',
        root: absolute.replace(/\/[^/]*$/, ''),
        mainFile: basename(absolute),
        files: [],
      })
    }
    return entries
  }
  const ref = parseGitHubTree(source.url)
  if (ref === null) {
    throw new Error('源地址既不是 GitHub 目录链接，也不是 .json 索引（形如 https://github.com/owner/repo/tree/main/plugins）')
  }
  const api = `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.ref)}?recursive=1`
  const response = await fetch(api, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsc-plugin-market', ...githubHeaders() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    if (response.status === 403 || response.status === 422) {
      throw new Error(`GitHub API 拒绝（${response.status}）：匿名限额较低，设置 GITHUB_TOKEN 后重试`)
    }
    throw new Error(`GitHub API ${response.status} ${response.statusText}（${api}）`)
  }
  const payload = (await response.json()) as { tree?: { path?: string; type?: string; size?: number }[] }
  const prefix = ref.dir === '' ? '' : `${ref.dir}/`
  const rawBase = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.ref}`
  const entries: MarketEntry[] = []
  for (const node of payload.tree ?? []) {
    const path = node.path ?? ''
    if (node.type !== 'blob' || !path.endsWith('.js')) continue
    if (prefix !== '' && !path.startsWith(prefix)) continue
    if (node.size !== undefined && node.size > MAX_FILE_BYTES) continue
    const relative = prefix === '' ? path : path.slice(prefix.length)
    const name = basename(relative).replace(/\.js$/i, '')
    entries.push({
      name,
      description: '远程插件（安装时整份拉取，装前会过审批）',
      source: source.name,
      kind: 'flat',
      root: rawBase,
      mainFile: relative,
      files: [],
    })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 安装一个远程插件条目：只拉 mainFile（单文件 .js）写进目标目录，
 * 返回落盘路径。热挂载由调用方（plugin-manager 插件）自己做。
 */
export async function installPluginMarketEntry(entry: MarketEntry, pluginsDir: string): Promise<string> {
  const bytes = await fetchBytes(fileUrl(entry, entry.mainFile))
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`插件文件超过 ${Math.round(MAX_FILE_BYTES / 1_048_576)} MB 上限`)
  }
  const target = join(pluginsDir, basename(entry.mainFile))
  mkdirSync(pluginsDir, { recursive: true })
  writeFileSync(target, bytes)
  return target
}
