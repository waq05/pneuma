/**
 * 界面插件包的发现与取字节（宿主半边）。
 *
 * 谁产出这些文件：界面壳的构建（`ui-shell/`）把插件 bundle 写进
 * `lib/ui/plugins/<id>/client.js`，并同时写一份 `manifest.json` 说明有哪些、
 * 依赖谁。宿主只认这份清单——**产物版本由宿主自己 stat 算**，不信构建时写下的值，
 * 这样插件文件被换掉（重新构建、手工替换）时地址跟着变，浏览器缓存不会骗人。
 *
 * 外部插件（第三方的界面半边）走同一份清单：将来它们由插件安装流程写进同一个目录，
 * 这里不用分内置还是第三方，只认文件在不在。第三方插件是真 npm 包，包名是
 * `@scope/name` 形状，所以 id 放开了 `/`；落盘一侧的路径围栏（`inside()`）照旧兜底。
 *
 * 三件事在这里定：
 *
 * 1. **清单的失败方向**：不认识的载体（`platform`）一律**丢弃并记进 problems**，不猜也不
 *    当 web 发出去——把一份给别的壳写的 bundle 塞进浏览器，表现是界面里某个插件"莫名报错"，
 *    比当场少一个插件难查得多。合法项的字段（`inject` / `external` / `file` / `id`）写坏了
 *    同样记 problems，不静默跳过。
 * 2. **产物表缓存**：`manifest.json` 的 mtime+size 是这张表的钥匙，没换就不重算，于是
 *    N 个 bundle 请求不再是 O(N²) 次 stat（原来每次请求都要读清单 + 逐个 stat 全目录）。
 *    页面每次加载与 `refresh()` 走 `force`，手工换掉文件也能立刻反映。
 * 3. **上一代响应表**：插件重建后，**已经打开、还没刷新的页面**手上还是旧 `?rev=` 地址，
 *    它的下一次请求必须还能拿到旧字节（内容寻址的地址，旧地址就该给旧内容），
 *    否则那个插件当场加载失败，用户只能手动刷新。所以换代时把旧 rev 与它的字节留下来
 *    （只留一代，与参考实现同口径）。
 *
 * @module dsc/core/ui-bundles
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies, validRange } from 'semver'
import { artifactRev, type UiPlatform, type UiPluginRow } from '../ui/manifest.js'
import { inside } from './web-static.js'

/** 清单文件名（界面壳构建时写在插件目录根部）。 */
export const UI_PLUGIN_MANIFEST = 'manifest.json'

/**
 * 认得的载体取值：`UiPlatform` 的那两个，一字不差。
 * 不在这张表里的值（写错、或将来别的壳）一律丢弃并记问题——失败关闭。
 */
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set<string>(['web', 'tui'])

/**
 * id 的合法形状：npm 包名（可带 `@scope/` 前缀），每个 `/` 分隔的段都字母数字起步，
 * 段内允许 `.` `_` `-`。
 *
 * 为什么放开 `/`：第三方界面插件就是 npm 包，`@scope/name` 是它的真名，禁掉 `/` 它们进不来。
 * 为什么放开之后仍然安全：每段必须**字母数字起步**，于是 `..`、`.`（段以点开头）、
 * 绝对路径（段以 `/` 开头）、`-flag` 这类形状都不成形；真正的围栏还有两处——
 * `readUiPluginBundle` 与 `collectUiPluginArtifacts` 里的 `inside()` 会再确认拼出来的
 * 路径没跑出插件目录。
 */
const ID_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]*'
const PLUGIN_ID = new RegExp(`^(?:@${ID_SEGMENT}/)?${ID_SEGMENT}(?:/${ID_SEGMENT})*$`)

/** 界面壳的静态产物目录（编译产物是 `lib/core/ui-bundles.js`，往上一级就是 `lib/ui`）。 */
export function uiAssetsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'assets')
}

/** 插件 bundle 目录。 */
export function uiPluginsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'plugins')
}

/** 清单里的一条：插件行 + 它的文件名。 */
export type UiPluginManifestEntry = UiPluginRow & { file: string }

/** 清单 + 已算好版本的条目。 */
export interface UiPluginArtifacts {
  entries: (UiPluginManifestEntry & { rev: string })[]
  /** 声明了但文件不在（或文件/字段不合法）的，逐条说清楚——不静默跳过。 */
  problems: string[]
  /**
   * 这份清单对应的 `@dsc/ui` 契约版本（构建产物写下的壳版本，1.0.0 起）。
   * 第三方目录合成的清单没有这一项——它们的条目必须逐条带 `api` 区间，
   * 门禁按 entry 侧的声明判（`evaluateUiApiGate`）。
   */
  apiVersion?: string
}

/** 读清单的结果：条目 + 所有"丢弃了什么"的问题记录。 */
export interface UiPluginManifestReport {
  entries: UiPluginManifestEntry[]
  problems: string[]
  /** 清单顶层的 `@dsc/ui` 契约版本；没有（第三方清单或旧构建）就没有这一项。 */
  apiVersion?: string
}

/**
 * API 门禁（阶段 7）：判断一个插件条目能不能对着「当前壳的 `@dsc/ui` 契约版本」加载。
 * 通过给 `null`；拒绝给一句**给人看的原因**（进 problems，界面诊断区原样画出来）。
 *
 * 规则（对齐 ui-plugin-parity-plan §5.1 拍板的六条）：
 *   - 内置清单（顶层带 `apiVersion`，即构建产物）的条目没写 `api` 视为与壳同源，放行；
 *   - 第三方清单（没有 `apiVersion`）的条目**必须**声明区间，缺失即拒（失败关闭）；
 *   - `workspace:` 前缀与解析不了的区间直接拒——请写具体版本区间，不做「等于当前」的猜法；
 *   - `satisfies(壳版本, 区间)` 不满足（含预发布版）即拒。
 */
export function evaluateUiApiGate(api: string | undefined, apiVersion: string | undefined): string | null {
  if (apiVersion === undefined) {
    if (api === undefined) {
      return null // 兼容旧清单（尚无 apiVersion 的构建产物）：没有声明依据，不拦
    }
    return matchGate(api, '(清单未声明 apiVersion)')
  }
  if (api === undefined) return null // 内置条目：与壳同源
  return matchGate(api, apiVersion)
}

/** 拿插件的声明区间对壳版本判一次；给拒绝理由或 null。 */
function matchGate(api: string, shellVersion: string): string | null {
  if (api.startsWith('workspace:')) {
    return `插件声明的 api 区间是「${api}」——请写具体的 semver 区间（如 ^1.0.0），这里不做「等于当前」的猜法`
  }
  const range = validRange(api)
  if (range === null) {
    return `插件声明的 api 区间「${api}」不是合法的 semver 区间（要像 ^1.0.0 / 1.x 这样）`
  }
  if (!satisfies(shellVersion, range, { includePrerelease: true })) {
    return `插件要求 @dsc/ui ${api}，当前壳 ${shellVersion}，已跳过加载`
  }
  return null
}

/** 一次 bundle 查询的结果（当前代 / 上一代 / 没有这一代）。 */
export interface UiBundleLookup {
  /** 清单里有没有这个 id + 文件名（有 = 是合法插件资源，只是版本可能对不上）。 */
  known: boolean
  /** 请求的 rev 就是当下这一代。 */
  current: boolean
  /** 请求的 rev 是上一代（刚被重建换掉的那一代）。 */
  previous: boolean
  /** 这一代的字节长度（拿得到就是确切值，配 HEAD 的 content-length）。 */
  size: number | null
  /** 这一代的字节；当前代顺带读盘，旧代只在当初服务过时才有。 */
  body: Buffer | null
}

/**
 * 读插件清单，并把所有被丢掉的行/字段记成问题。
 *
 * 文件缺失/整个 JSON 坏掉一律按空处理（界面壳还没构建就是这样，与 remote 的
 * "资产未构建"占位页同一套待遇：能起来，但没有插件）；但**坏掉的清单要说话**，
 * 不然"插件怎么不见了"只能靠猜。
 */
export function readUiPluginManifestReport(dir: string = uiPluginsDir()): UiPluginManifestReport {
  const entries: UiPluginManifestEntry[] = []
  const problems: string[] = []
  let text: string
  try {
    text = readFileSync(resolve(dir, UI_PLUGIN_MANIFEST), 'utf8')
  } catch {
    return { entries, problems }
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (error) {
    problems.push(`${UI_PLUGIN_MANIFEST}: 不是合法 JSON（${error instanceof Error ? error.message : String(error)}），整份清单作废`)
    return { entries, problems }
  }
  const plugins = (doc as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) {
    problems.push(`${UI_PLUGIN_MANIFEST}: 顶层没有 plugins 数组，整份清单作废`)
    return { entries, problems }
  }
  // 顶层 apiVersion：构建产物写下「这份清单对着哪个 @dsc/ui 版本」。有它 = 内置清单，
  // 条目无需逐条声明 api；没有（第三方清单）则条目必须逐条带 api（门禁见 evaluateUiApiGate）。
  const rawApiVersion = (doc as { apiVersion?: unknown }).apiVersion
  const apiVersion = typeof rawApiVersion === 'string' && rawApiVersion.trim() !== '' ? rawApiVersion.trim() : undefined
  if (rawApiVersion !== undefined && apiVersion === undefined) {
    problems.push(`${UI_PLUGIN_MANIFEST}: 顶层 apiVersion 不是非空字符串（${JSON.stringify(rawApiVersion)}），当没写处理`)
  }
  for (let index = 0; index < plugins.length; index += 1) {
    const raw = plugins[index]
    const where = `${UI_PLUGIN_MANIFEST} 第 ${String(index + 1)} 条`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${where}: 不是对象，丢弃`)
      continue
    }
    const record = raw as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'] : ''
    const file = typeof record['file'] === 'string' ? record['file'] : ''
    if (!PLUGIN_ID.test(id)) {
      problems.push(`${where}: id 不成形（${JSON.stringify(record['id'])}），丢弃`)
      continue
    }
    if (file === '' || file.includes('/') || file.includes('\\')) {
      problems.push(`${id}: 文件名不成形（${JSON.stringify(record['file'])}），丢弃`)
      continue
    }
    // 载体：认识的只有 web / tui 两个取值；别的（写错、或别的壳的取值）不当客户端行。
    const platform = record['platform']
    if (platform !== undefined && (typeof platform !== 'string' || !KNOWN_PLATFORMS.has(platform))) {
      problems.push(`${id}: 载体（platform）不认识（${JSON.stringify(platform)}），丢弃`)
      continue
    }
    const inject = readNameList(record['inject'], id, 'inject', problems)
    const external = readNameList(record['external'], id, 'external', problems)
    // api：插件声明的 @dsc/ui 区间（第三方必需；形状校验放门禁判定，这里只管类型）。
    const rawApi = record['api']
    const api = typeof rawApi === 'string' && rawApi.trim() !== '' ? rawApi.trim() : undefined
    if (rawApi !== undefined && api === undefined) {
      problems.push(`${id}: api 不是非空字符串（${JSON.stringify(rawApi)}），当没声明处理`)
    }
    entries.push({
      id,
      file,
      ...(inject === undefined ? {} : { inject }),
      ...(external === undefined ? {} : { external }),
      ...(record['immediately'] === true ? { immediately: true } : {}),
      ...(api === undefined ? {} : { api }),
      ...(platform === undefined ? {} : { platform: platform as UiPlatform }),
    })
  }
  return { entries, problems, ...(apiVersion === undefined ? {} : { apiVersion }) }
}

/**
 * 读一个字符串数组字段（`inject` / `external`）。
 *
 * 字段整个没写 → undefined（"没声明"，与空数组分开）；
 * 字段不是数组 → 记问题，当没声明；
 * 数组里混了非字符串 → 记问题，**留下合法的那些**：字段写坏是字段的错，不该让整个插件消失。
 */
function readNameList(value: unknown, id: string, field: string, problems: string[]): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    problems.push(`${id}: ${field} 不是数组（${JSON.stringify(value)}），当没声明处理`)
    return undefined
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item !== '') out.push(item)
    else problems.push(`${id}: ${field} 里有非字符串项（${JSON.stringify(item)}），已丢弃`)
  }
  return out
}

/** 读清单（只要条目；问题记录见 `readUiPluginManifestReport`）。 */
export function readUiPluginManifest(dir: string = uiPluginsDir()): UiPluginManifestEntry[] {
  return readUiPluginManifestReport(dir).entries
}

/** 缓存条目的内部形状：清单行 + 版本 + 字节长度。 */
interface CachedRow {
  row: UiPluginManifestEntry & { rev: string }
  size: number
}

/** 上一代：旧 rev 与它的字节长度（字节本身在 `bytes` 里另存）。 */
interface PreviousGeneration {
  rev: string
  size: number
}

/** 定位一条缓存用的键（id 与文件名都可能含 `.` `-`，用不会出现的 NUL 分隔）。 */
function cacheKey(id: string, file: string): string {
  return `${id}\u0000${file}`
}

/** 诊断计数（测试与排障用，不参与业务判断）。 */
const CACHE_COUNTERS = { manifestStats: 0, fileStats: 0, tableBuilds: 0 }

/** 读一次诊断计数（副本，改不动内部）。 */
export function uiArtifactCacheCounters(): { manifestStats: number; fileStats: number; tableBuilds: number } {
  return { ...CACHE_COUNTERS }
}

/** 清零诊断计数（测试用）。 */
export function resetUiArtifactCacheCounters(): void {
  CACHE_COUNTERS.manifestStats = 0
  CACHE_COUNTERS.fileStats = 0
  CACHE_COUNTERS.tableBuilds = 0
}

/**
 * 一个插件目录的产物表 + 上一代表 + 字节缓存。
 *
 * 为什么要缓存：`manifest.json` 加逐文件 stat 原来是**每个 bundle 请求**都跑一遍，
 * 页面上 N 个插件就是 O(N²) 次同步 stat，全发生在请求路径上、阻塞事件循环。
 * 现在钥匙是清单的 mtime+size：清单没换就直接用表，请求路径上只剩一次清单 stat。
 */
class UiArtifactCache {
  /** 上一次建表时的清单指纹；null = 还没建过。 */
  private manifestKey: string | null = null
  private entries: (UiPluginManifestEntry & { rev: string })[] = []
  private problems: string[] = []
  private apiVersion: string | undefined = undefined
  private readonly byKey = new Map<string, CachedRow>()
  /** `${id}\0${file}\0${rev}` → 字节（服务过一次才在）。 */
  private readonly bytes = new Map<string, Buffer>()
  /** `${id}\0${file}` → 上一代（重建换掉的那一代）。 */
  private readonly previous = new Map<string, PreviousGeneration>()

  constructor(
    private readonly dir: string,
    private readonly platform: 'web' | 'tui',
  ) {}

  /** 现在的清单指纹；清单还没有（没构建）也是指纹的一种取值。 */
  private fingerprint(): string {
    CACHE_COUNTERS.manifestStats += 1
    try {
      const stat = statSync(resolve(this.dir, UI_PLUGIN_MANIFEST))
      return `${String(Math.trunc(stat.mtimeMs))}:${String(stat.size)}`
    } catch {
      return 'missing'
    }
  }

  /** 建表（读清单 + 逐文件算版本）。清单没换且没要求强制，就直接返回。 */
  private rebuild(force: boolean): void {
    const fingerprint = this.fingerprint()
    if (!force && this.manifestKey === fingerprint) return
    CACHE_COUNTERS.tableBuilds += 1

    const report = readUiPluginManifestReport(this.dir)
    const problems = [...report.problems]
    const nextByKey = new Map<string, CachedRow>()
    for (const entry of report.entries) {
      if ((entry.platform ?? 'web') !== this.platform) continue
      // API 门禁（阶段 7）：插件声明的 @dsc/ui 区间对不上这份清单的契约版本就不进产物表，
      // 原因写进 problems——「不匹配就不进启动图，壳只负责把原因画出来」。带上 id：
      // 多个插件被拒时诊断区要能对上号。
      const denied = evaluateUiApiGate(entry.api, report.apiVersion)
      if (denied !== null) {
        problems.push(`${entry.id}: ${denied}`)
        continue
      }
      const path = resolve(this.dir, entry.id, entry.file)
      if (!inside(this.dir, path)) {
        problems.push(`${entry.id}: 文件跑到目录外了（${entry.file}）`)
        continue
      }
      try {
        CACHE_COUNTERS.fileStats += 1
        const stat = statSync(path)
        if (!stat.isFile()) {
          problems.push(`${entry.id}: ${entry.file} 不是文件`)
          continue
        }
        nextByKey.set(cacheKey(entry.id, entry.file), { row: { ...entry, rev: artifactRev(stat) }, size: stat.size })
      } catch {
        problems.push(`${entry.id}: 找不到 ${entry.file}（界面壳构建过了吗）`)
      }
    }

    // 换代：这一代变了或被删掉的，整条挪进上一代表（旧窗口可能还拿着它的地址）。
    // 没变的保持原样——上一代仍然是最早那一代，别把它顶掉。
    const nextPrevious = new Map<string, PreviousGeneration>()
    for (const [key, cached] of this.byKey) {
      const fresh = nextByKey.get(key)
      if (fresh !== undefined && fresh.row.rev === cached.row.rev) {
        const kept = this.previous.get(key)
        if (kept !== undefined) nextPrevious.set(key, kept)
        continue
      }
      nextPrevious.set(key, { rev: cached.row.rev, size: cached.size })
    }

    // 字节缓存只留"当下这一代 + 上一代"用得着的，别让它随重建无限长大。
    const keep = new Set<string>()
    for (const [key, cached] of nextByKey) keep.add(`${key}\u0000${cached.row.rev}`)
    for (const [key, generation] of nextPrevious) keep.add(`${key}\u0000${generation.rev}`)
    for (const key of [...this.bytes.keys()]) {
      if (!keep.has(key)) this.bytes.delete(key)
    }

    this.manifestKey = fingerprint
    this.entries = [...nextByKey.values()].map((cached) => cached.row)
    this.problems = problems
    this.apiVersion = report.apiVersion
    this.byKey.clear()
    for (const [key, cached] of nextByKey) this.byKey.set(key, cached)
    this.previous.clear()
    for (const [key, generation] of nextPrevious) this.previous.set(key, generation)
  }

  /** 现在的产物表（清单没换就不重算）。 */
  table(): UiPluginArtifacts {
    this.rebuild(false)
    return { entries: [...this.entries], problems: [...this.problems], ...(this.apiVersion === undefined ? {} : { apiVersion: this.apiVersion }) }
  }

  /** 强制重算（页面每次加载、`refresh()` 用：文件被手工换掉也立刻反映）。 */
  refresh(): UiPluginArtifacts {
    this.rebuild(true)
    return { entries: [...this.entries], problems: [...this.problems], ...(this.apiVersion === undefined ? {} : { apiVersion: this.apiVersion }) }
  }

  /**
   * 按 id + 文件名 + 版本取字节。
   *
   * @param wantBody - false（HEAD）时不读盘：长度从 stat 来，头照给、体不给。
   */
  lookup(id: string, file: string, rev: string, wantBody: boolean): UiBundleLookup {
    this.rebuild(false)
    const key = cacheKey(id, file)
    const current = this.byKey.get(key)
    if (current !== undefined && current.row.rev === rev) {
      const body = wantBody ? this.readBytes(key, id, file, rev) : null
      return { known: true, current: true, previous: false, size: current.size, body }
    }
    const generation = this.previous.get(key)
    if (generation !== undefined && generation.rev === rev) {
      // 旧代只在当初服务过时才有字节（已经打开的页面必然取过一次，所以这条路走得通）。
      return {
        known: true,
        current: false,
        previous: true,
        size: generation.size,
        body: wantBody ? (this.bytes.get(`${key}\u0000${rev}`) ?? null) : null,
      }
    }
    return { known: current !== undefined || generation !== undefined, current: false, previous: false, size: null, body: null }
  }

  /** 读当前代的字节（读过就留在内存里，下一次直接给）。 */
  private readBytes(key: string, id: string, file: string, rev: string): Buffer | null {
    const cacheKeyText = `${key}\u0000${rev}`
    const hit = this.bytes.get(cacheKeyText)
    if (hit !== undefined) return hit
    const body = readUiPluginBundle(id, file, this.dir)
    if (body !== null) this.bytes.set(cacheKeyText, body)
    return body
  }
}

/** 目录 + 载体 → 缓存（模块级：本机界面服务与远程控制共用同一份产物视图）。 */
const CACHES = new Map<string, UiArtifactCache>()

/** 取某个插件目录的产物缓存。 */
export function uiArtifactCache(dir: string, platform: 'web' | 'tui' = 'web'): UiArtifactCache {
  const absolute = resolve(dir)
  const key = `${absolute}\u0000${platform}`
  const existing = CACHES.get(key)
  if (existing !== undefined) return existing
  const created = new UiArtifactCache(absolute, platform)
  CACHES.set(key, created)
  return created
}

/**
 * 清单 + 文件现状 = 可下发的条目。缺文件的不进清单，但要单独报出来。
 *
 * @param dir - 插件目录，缺省 `lib/ui/plugins`
 * @param platform - 只取这个载体的插件（浏览器壳要 web，TUI 壳要 tui）
 * @param options - `force: true` 时无视清单指纹重算（页面加载与 refresh 用）
 */
export function collectUiPluginArtifacts(
  dir: string = uiPluginsDir(),
  platform: 'web' | 'tui' = 'web',
  options: { force?: boolean } = {},
): UiPluginArtifacts {
  const cache = uiArtifactCache(dir, platform)
  return options.force === true ? cache.refresh() : cache.table()
}

/**
 * 按内容寻址的地址取字节（含上一代）。
 *
 * @param wantBody - HEAD 请求传 false：只问长度，不读盘
 */
export function lookupUiPluginBundle(
  id: string,
  file: string,
  rev: string,
  dir: string = uiPluginsDir(),
  wantBody = true,
): UiBundleLookup {
  return uiArtifactCache(dir, 'web').lookup(id, file, rev, wantBody)
}

/** 取一个插件的 bundle 字节；不存在给 null。 */
export function readUiPluginBundle(
  id: string,
  file: string,
  dir: string = uiPluginsDir(),
): Buffer | null {
  if (!PLUGIN_ID.test(id)) return null
  const path = resolve(dir, id, file)
  if (!inside(dir, path)) return null
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}
