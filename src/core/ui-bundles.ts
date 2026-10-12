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

/**
 * 第三方条目的来源标记：`~/.dsc/plugins/` 的界面半边带 `origin: 'third-party'`，
 * 内置条目没有这一项。装载器按它决定去哪个目录读 bundle 字节——两边磁盘布局不同
 * （内置 `<dir>/<id>/<file>`，第三方 `<root>/<id>/ui/client.js`）。
 */
export interface ThirdPartyOrigin {
  origin: 'third-party'
  /** 相对第三方根目录的目录名（= id）。 */
  source: string
}

/** 读一个第三方 bundle 的字节（`<root>/<id>/ui/client.js`；不存在给 null）。 */
export function readThirdPartyUiPluginBundle(id: string, dir: string = thirdPartyUiRoot()): Buffer | null {
  if (!PLUGIN_ID.test(id)) return null
  const path = resolve(dir, id, 'ui', 'client.js')
  if (!inside(dir, path)) return null
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

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

// ── 第三方界面插件（阶段 7）────────────────────────────────────────────────────
//
// 住 `~/.dsc/plugins/<目录名>/`：`ui/client.js` 是界面半边，`plugin.json` 声明
// `api`（必填，@dsc/ui 区间）与可选的 `platforms`。发现、启停（plugins.json 的
// entries，键 `<目录名>/ui/client.js`）、信任（plugins.json 顶层 `uiTrust`）与
// 内置插件合成为同一张产物表——「不用分内置还是第三方，只认文件在不在」。

import { readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { UiTrustView } from '../contract.js'
import { dscPath } from './path-policy.js'
import { isPluginEnabled, isUiPluginTrusted, readUiPluginTrust, trustUiPlugin } from './plugin-registry.js'

/** 第三方 bundle 的 rev：**内容摘要**（sha256 前 16 位）。内置产物用 mtime 指纹（开发期
 *  频繁重编，快且够）；第三方的字节是「别人放进来的一份代码」，rev 承担内容复核——
 *  同一目录里换了字节，rev 必须变。 */
function contentRev(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/** 第三方插件目录（宿主插件与界面半边同住 `~/.dsc/plugins/`）。 */
export function thirdPartyUiRoot(): string {
  return dscPath('plugins')
}

/** 第三方目录里的一条发现结果（rev 已按内容算好）。 */
export interface ThirdPartyUiEntry extends UiPluginRow, ThirdPartyOrigin {
  file: string
  rev: string
}

/** 第三方发现的清单视图：合成后的条目 + 所有问题记录。 */
export interface ThirdPartyUiReport {
  entries: ThirdPartyUiEntry[]
  problems: string[]
}

/** 第三方缓存：一条发现的字节与指纹。 */
interface ThirdPartyCached {
  row: ThirdPartyUiEntry
  bytes: Buffer
  fingerprint: string
  /** 上一代（更新前的字节与 rev；旧页面还拿着旧地址时要用）。 */
  previous: { rev: string; bytes: Buffer } | null
}

/** 模块级缓存：目录 → 表。进程内只有宿主这一个写者。 */
const thirdPartyCaches = new Map<string, Map<string, ThirdPartyCached>>()

function thirdPartyCache(dir: string): Map<string, ThirdPartyCached> {
  const existing = thirdPartyCaches.get(dir)
  if (existing !== undefined) return existing
  const created = new Map<string, ThirdPartyCached>()
  thirdPartyCaches.set(dir, created)
  return created
}

/**
 * 扫第三方插件目录，合成界面半边的发现清单。
 *
 * 每一步失败/拒绝都记进 problems 并跳过那一条，不静默：
 * 目录名不成形、`plugin.json` 缺失或坏、`api` 没声明、被停用（plugins.json）、
 * 没有信任记录（首次安装要答一次）、api 区间对不上当前壳、与内置 id 撞名。
 *
 * @param shellApiVersion - 当前壳的 `@dsc/ui` 契约版本（内置清单顶层那个）
 * @param builtinIds - 内置清单里已有的 id（撞名时第三方让路）
 * @param dir - 第三方根目录，缺省 `~/.dsc/plugins`
 */
export function discoverThirdPartyUiArtifacts(
  shellApiVersion: string | undefined,
  builtinIds: ReadonlySet<string>,
  dir: string = thirdPartyUiRoot(),
): ThirdPartyUiReport {
  const entries: ThirdPartyUiEntry[] = []
  const problems: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    return { entries, problems } // 目录还没有 = 还没装过第三方，正常态
  }
  const cache = thirdPartyCache(dir)
  const trusted = readUiPluginTrust()
  for (const name of names) {
    const where = `${name}/ui/client.js`
    const manifestPath = resolve(dir, name, 'plugin.json')
    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      // 没有 plugin.json 的目录可能是宿主插件的资料目录：只在没有界面半边时当没看见。
      if (!existsClient(dir, name)) problems.push(`${where}: 没有 plugin.json（第三方界面插件必须声明 api 区间）`)
      continue
    }
    const rawApi = doc['api']
    const api = typeof rawApi === 'string' && rawApi.trim() !== '' ? rawApi.trim() : undefined
    if (api === undefined) {
      problems.push(`${where}: plugin.json 没写 api（@dsc/ui 的版本区间，如 "^1.0.0"）——第三方必须声明`)
      continue
    }
    const rawPlatforms = doc['platforms']
    const platforms = Array.isArray(rawPlatforms)
      ? rawPlatforms.filter((value): value is UiPlatform => value === 'web' || value === 'tui')
      : (['web'] as UiPlatform[])
    if (rawPlatforms !== undefined && platforms.length === 0) {
      problems.push(`${where}: platforms 不认识（${JSON.stringify(rawPlatforms)}），只认 web / tui`)
      continue
    }
    const fileKey = `${name}/ui/client.js`
    // 先判「这份代码装不装得上」（撞名、门禁），再问用户要不要信任——
    // 别让人信任一个注定进不了启动图的东西。
    if (builtinIds.has(name)) {
      problems.push(`${where}: id 与内置插件撞名，第三方这份被跳过`)
      continue
    }
    const gate = evaluateUiApiGate(api, shellApiVersion)
    if (gate !== null) {
      problems.push(`${name}: ${gate}`)
      continue
    }
    if (!isPluginEnabled(fileKey)) {
      continue // 停用不是问题：启停是用户的开关，不进 problems
    }
    if (trusted[fileKey] === undefined) {
      problems.push(`${where}: 还没有信任记录——首次安装需要在插件中心确认一次（它将能调用宿主的界面方法）`)
      continue
    }
    const bytes = readFileSyncSafe(resolve(dir, name, 'ui', 'client.js'))
    if (bytes === null) {
      problems.push(`${where}: plugin.json 在，但 ui/client.js 读不到`)
      continue
    }
    const rev = contentRev(bytes)
    const cached = cache.get(fileKey)
    const fingerprint = `${rev}`
    const row: ThirdPartyUiEntry = {
      id: name,
      file: 'client.js',
      rev,
      api,
      origin: 'third-party',
      source: name,
    }
    // 双平台插件进两个平台视图：web 行缺省（无 platform 字段），tui 行显式写。
    // origin 标记第三方：装载器按它去 ui/ 子目录读字节（磁盘布局与内置不同）。
    for (const platform of platforms) {
      entries.push({ ...row, origin: 'third-party', ...(platform === 'web' ? {} : { platform }) })
    }
    if (cached === undefined || cached.fingerprint !== fingerprint) {
      cache.set(fileKey, {
        row,
        bytes,
        fingerprint,
        previous: cached === undefined ? null : { rev: cached.row.rev, bytes: cached.bytes },
      })
    }
  }
  return { entries, problems }
}

function existsClient(dir: string, name: string): boolean {
  try {
    statSync(resolve(dir, name, 'ui', 'client.js'))
    return true
  } catch {
    return false
  }
}

/**
 * 第三方界面插件的信任卡视图：把 `~/.dsc/plugins/` 扫一遍，逐条给出「能不能装、
 * 信没信、启没启」。判定与 {@link discoverThirdPartyUiArtifacts} 同一套（目录形状 /
 * api 门禁 / 撞名 / 停用 / 信任），差别只在输出形状：那边是「装得上的条目 + 一句句
 * 问题」，这边是**每一条的状态**——插件中心的信任卡要把没信任的那些摊出来给用户确认。
 *
 * 既没有 plugin.json 也没有界面半边的目录（宿主插件的资料目录）不出现。
 *
 * @param shellApiVersion - 当前壳的 `@dsc/ui` 契约版本（内置清单顶层那个）
 * @param builtinIds - 内置清单里已有的 id（撞名时第三方让路）
 * @param dir - 第三方根目录，缺省 `~/.dsc/plugins`
 */
export function scanThirdPartyUiTrusts(
  shellApiVersion: string | undefined,
  builtinIds: ReadonlySet<string>,
  dir: string = thirdPartyUiRoot(),
): UiTrustView[] {
  const out: UiTrustView[] = []
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return out // 目录还没有 = 还没装过第三方，正常态
  }
  const trusted = readUiPluginTrust()
  for (const name of names) {
    const hasClient = existsClient(dir, name)
    let doc: Record<string, unknown> | null
    try {
      doc = JSON.parse(readFileSync(resolve(dir, name, 'plugin.json'), 'utf8')) as Record<string, unknown>
    } catch {
      doc = null
    }
    if (doc === null && !hasClient) continue
    const fileKey = `${name}/ui/client.js`
    const trust = trusted[fileKey]
    const row: UiTrustView = {
      name,
      platforms: ['web'],
      trusted: trust !== undefined,
      enabled: isPluginEnabled(fileKey),
      ...(trust === undefined ? {} : { trustedAt: trust.trustedAt }),
    }
    if (doc === null) {
      row.problem = '没有 plugin.json（第三方界面插件必须声明 api 区间）'
      out.push(row)
      continue
    }
    const rawApi = doc['api']
    const api = typeof rawApi === 'string' && rawApi.trim() !== '' ? rawApi.trim() : undefined
    if (api !== undefined) row.api = api
    const rawPlatforms = doc['platforms']
    if (Array.isArray(rawPlatforms)) {
      const platforms = rawPlatforms.filter((value): value is UiPlatform => value === 'web' || value === 'tui')
      if (platforms.length > 0) row.platforms = platforms
    }
    if (api === undefined) {
      row.problem = 'plugin.json 没写 api（@dsc/ui 的版本区间，如 "^1.0.0"）——第三方必须声明'
    } else if (builtinIds.has(name)) {
      row.problem = 'id 与内置插件撞名，这份会被跳过'
    } else {
      const gate = evaluateUiApiGate(api, shellApiVersion)
      if (gate !== null) row.problem = gate
      else if (!hasClient) row.problem = 'plugin.json 在，但 ui/client.js 读不到'
    }
    out.push(row)
  }
  return out
}

/**
 * 落一条信任记录（信任卡「确认信任」的终点）：先按发现层的同一批判定复核一遍，
 * 全过才写 plugins.json 的 `uiTrust` 段。
 *
 * 目录名在这里**先钉死形状**：它会拼成路径（`<dir>/<name>/ui/client.js`），
 * 带分隔符或 `..` 的名字要在拼路径之前挡住（路径穿越）。
 */
export function trustThirdPartyUiPlugin(
  name: string,
  shellApiVersion: string | undefined,
  builtinIds: ReadonlySet<string>,
  dir: string = thirdPartyUiRoot(),
): { ok: true; notice?: string } | { ok: false; error: string } {
  if (name === '' || name.length > 200) return { ok: false, error: '插件目录名不合法' }
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    return { ok: false, error: '插件目录名不合法（不能带路径分隔符）' }
  }
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(readFileSync(resolve(dir, name, 'plugin.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return { ok: false, error: `读不到 ${name}/plugin.json——目录名对吗？（要的是 ~/.dsc/plugins/<目录名>）` }
  }
  const rawApi = doc['api']
  const api = typeof rawApi === 'string' && rawApi.trim() !== '' ? rawApi.trim() : undefined
  if (api === undefined) return { ok: false, error: `${name}: plugin.json 没写 api（@dsc/ui 的版本区间），装不上` }
  if (builtinIds.has(name)) return { ok: false, error: `${name}: id 与内置插件撞名，这份会被跳过` }
  const gate = evaluateUiApiGate(api, shellApiVersion)
  if (gate !== null) return { ok: false, error: `${name}: ${gate}` }
  if (!existsClient(dir, name)) return { ok: false, error: `${name}: ui/client.js 读不到，装不上` }
  if (isUiPluginTrusted(`${name}/ui/client.js`)) {
    return { ok: true, notice: `「${name}」早就信任过了——重启宿主（或刷新页面）后装载` }
  }
  trustUiPlugin(`${name}/ui/client.js`)
  return { ok: true, notice: `已信任「${name}」——重启宿主（或刷新页面）后装载` }
}

function readFileSyncSafe(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

/**
 * 这个启停键是不是第三方界面插件（`<目录名>/ui/client.js`，住 `~/.dsc/plugins/<目录名>/ui/`）。
 *
 * 热启停（plugin-loader 的 setPluginEnabledHot）只认**宿主半边**的 .js 文件；界面半边
 * 在页面加载时按 plugins.json 的启停现场合成，没有「热挂载」这回事。runtime 用这个
 * 判定把界面半边的开关导向「写盘 + 提示刷新」，而不是去挂一个不存在的宿主插件。
 */
export function isThirdPartyUiEntry(file: string): boolean {
  const at = file.indexOf('/ui/')
  if (at <= 0) return false
  const name = file.slice(0, at)
  if (/[\\/]/.test(name)) return false
  return existsClient(thirdPartyUiRoot(), name)
}

/**
 * 第三方 bundle 的内容寻址查询：rev 对上当前给字节，对上上一代给旧字节，都没有 404。
 * 形状与内置的 `lookupUiPluginBundle` 同一份 `UiBundleLookup`——伺服路由先查内置、
 * 再查这里，两边口径一致。
 */
export function lookupThirdPartyUiBundle(
  id: string,
  file: string,
  rev: string,
  dir: string = thirdPartyUiRoot(),
  wantBody = true,
): UiBundleLookup {
  void file // 第三方的文件名固定 client.js；file 参与 key 但查询按 id 定位
  const empty: UiBundleLookup = { known: false, current: false, previous: false, size: null, body: null }
  if (!PLUGIN_ID.test(id)) return empty
  const cache = thirdPartyCaches.get(dir)
  const cached = cache?.get(`${id}/ui/client.js`)
  if (cached === undefined) return { ...empty, known: false }
  if (cached.row.rev === rev) {
    return { known: true, current: true, previous: false, size: cached.bytes.length, body: wantBody ? cached.bytes : null }
  }
  if (cached.previous !== null && cached.previous.rev === rev) {
    return { known: true, current: false, previous: true, size: cached.previous.bytes.length, body: wantBody ? cached.previous.bytes : null }
  }
  return { known: true, current: false, previous: false, size: null, body: null }
}

/**
 * 一个平台视图下的**全部**界面插件：内置（构建产物清单）+ 第三方（`~/.dsc/plugins/`
 * 里带界面半边的目录）。启动图（web）与终端装载器（tui）都从这一个口子取，
 * 谁也不许自己再拼一份——口径分叉就是从这里开始的。
 */
export function collectUiArtifactsForPlatform(
  platform: 'web' | 'tui',
  options: { force?: boolean; builtinDir?: string; thirdPartyDir?: string } = {},
): UiPluginArtifacts {
  const builtin = collectUiPluginArtifacts(options.builtinDir, platform, { force: options.force })
  const third = discoverThirdPartyUiArtifacts(builtin.apiVersion, new Set(builtin.entries.map((entry) => entry.id)), options.thirdPartyDir)
  const entries = [
    ...builtin.entries,
    ...third.entries.filter((entry) => (entry.platform ?? 'web') === platform),
  ]
  const problems = [...builtin.problems, ...third.problems]
  return { entries, problems, ...(builtin.apiVersion === undefined ? {} : { apiVersion: builtin.apiVersion }) }
}
