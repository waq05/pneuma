/**
 * 功能包热更的宿主半侧：轮询已挂载行的包目录 → 换代 → 重挂那一行。
 *
 * 为什么是**轮询**而不是 fs.watch / chokidar（与 core/ui-hmr 同一个结论）：
 *
 *   1. 文件监听在网络盘/挂载盘上没有 inotify；Windows 上 fs.watch 尤不可靠。
 *   2. 构建是「写临时文件再 rename」：rename 之后 inotify 有时只给旧句柄一个事件，
 *      拿 stat 当唯一真相反而不会漏。
 *   3. 这里最省事的实现只要一次 `statSync` 轮询（1000ms 一轮），比多一条构建脚本 →
 *      宿主的 IPC 通道便宜，也不会在打包场景里引入 chokidar 这个依赖。
 *
 * 监视对象**不是入口文件**：应用自带包的入口是一层再导出桩
 * （`lib/node_modules/@pneuma/<id>/index.js`），改真实代码时桩的 mtime 永远不变。
 * 所以要盯「包目录下所有 .js/.json」+ 桩指回的真实目录（见 {@link watchDirsOf}）。
 *
 * **库包没有行，但改它也得让引用它的行换新代码**：所以这里多盯一层「库包目录」，
 * 并维护一张「库包 → 引用它的行」的图（扫各包构建产物里的静态 import 得到）。库包
 * 变了就把引用它的行合并成一批重挂，一次只换一代；没有引用方的库包不盯、不重挂、
 * 不写日志。
 *
 * 与 ui-hmr 的另两处同构：
 *
 *   - 单个文件读不到（构建 swap 的中间态）**不放弃整轮**，下一轮照常比；
 *   - 一次变更可能同时落好几个文件，去抖窗口里的变化合并成一次重挂。
 *
 * 开关：环境变量 `DSC_HOT=0` 关闭，默认开。失败写 meta.problem（由
 * plugin-loader 的 remountExternalPlugin 负责）并在这里记一行 warn，不静默。
 *
 * @module dsc/core/plugin-watch
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  APP_INSTALL_DIR,
  listMountedPluginSources,
  pluginPackageDirOf,
  remountExternalPlugins,
  remountExternalPlugin,
  type ProfileReconcileResult,
  type RemountResult,
} from './plugin-loader.js'

/** 轮询到一个要看的行：行 id + 它的磁盘入口。 */
export interface PluginWatchTarget {
  identity: string
  file: string
}

/** 日志出口（宿主传 ctx.logger 的 info/warn；自检可以传空实现）。 */
export interface PluginWatchLogger {
  info(line: string): void
  warn(line: string): void
}

/** 造轮询器要给的几样东西（全部可替换，方便自检单独驱动）。 */
export interface PluginWatchOptions {
  /** 要盯的行（每次调用现取：新挂上的行下一轮自动纳入，卸掉的自动退出）。 */
  targets?(): PluginWatchTarget[]
  /** 一个入口文件对应的要递归看的目录（缺省见 {@link watchDirsOf}）。 */
  dirsOf?(file: string): string[]
  /** 重挂一行（缺省走 plugin-loader 的 remountExternalPlugin）。 */
  remount?(identity: string): Promise<RemountResult>
  /**
   * 批量重挂（缺省走 plugin-loader 的 remountExternalPlugins：同一批只换一代）。
   *
   * 库包变更一次可能命中多行，逐行重挂会各换一代、同一个库被解析成两份实例；
   * 所以这一路必须能批量。自检换了 {@link remount} 又没给这一项时，退化成逐行调用。
   */
  remountMany?(identities: readonly string[]): Promise<RemountResult[]>
  /**
   * 应用安装目录（缺省 {@link APP_INSTALL_DIR}）。
   *
   * 库包清单与真实代码目录都从这里推：`<appDir>/lib/node_modules/@pneuma/*` 的清单
   * 说哪些是库包，再导出桩指回 `<appDir>/lib/packages/<id>`。
   */
  appDir?: string
  /** 轮询间隔（毫秒），缺省 1000。 */
  pollIntervalMs?: number
  /** 去抖窗口（毫秒），缺省 200。 */
  debounceMs?: number
  /**
   * profile 目录：这里的三份清单（package.json / compatibility.json /
   * cordis.patch.yml）变了就重算组合包，装包/卸包不必重启宿主。
   *
   * 不传 = 这一路不启用（探针/自检不受影响）；与行、库包两路共用同一个定时器
   * 与去抖窗口，不另起 setInterval。
   */
  profileDir?: string
  /**
   * 重算组合包（缺省动态 import plugin-loader 的 reconcileProfileBundles）。
   *
   * 自检注入它就能只验「清单变了 → 重算一次」，不必真铺一套能挂上的组合包。
   */
  reconcile?(profileDir: string): Promise<ProfileReconcileResult>
  /**
   * 组合包重算挂在哪个内核上（只有 profileDir 这一路用）。
   *
   * 轮询器自己不知道内核是哪一个：{@link startPluginWatch} 把 root 传进来，
   * 缺省的重算实现靠它调加载器。
   */
  root?: Context
  logger?: PluginWatchLogger
}

/** 轮询器句柄。 */
export interface PluginWatchHandle {
  /** 立刻扫一轮并立即重挂（自检与「保存后马上推」用；正常靠定时器）。 */
  pollNow(): Promise<void>
  stop(): void
  /** 还在跑（被 DSC_HOT=0 关掉时是 false）。 */
  readonly running: boolean
  /**
   * 换/补 profile 这一路（null = 关掉）。
   *
   * 为什么需要：轮询器可能由装配路径先拉起，宿主启动路径后到，那时才知道 profile
   * 在哪。补这一路不能重启轮询器——基线一丢，已挂的行会被当成「刚刚变了」。
   */
  setProfileDir(profileDir: string | null): void
}

/** 一个文件的指纹：只取「改了才会变」的两项。 */
interface FileStamp {
  mtimeMs: number
  size: number
}

/** 一个行上一轮的扫描结果。 */
interface TargetState {
  file: string
  stamps: Map<string, FileStamp>
}

/** 缺省日志：没接宿主 logger 时写 stderr（与 ui-hmr 一致）。 */
const stderrLogger: PluginWatchLogger = {
  info: (line) => process.stderr.write(line + '\n'),
  warn: (line) => process.stderr.write(line + '\n'),
}

/**
 * 一行要看的目录：包目录（含 package.json 的那层）+ 再导出桩指回的真实目录。
 *
 * 只看入口文件会漏掉「桩没变、真实代码变了」这个最常见的场景；而只按包名猜
 * `lib/packages/<id>` 会把包名与目录名不一致的包（`@pneuma/runtime-adapter`）漏掉，
 * 所以直接顺着桩里的再导出说明符找。
 * @param file - 入口文件绝对路径
 */
export function watchDirsOf(file: string): string[] {
  const dirs = new Set<string>()
  const pkgDir = pluginPackageDirOf(file)
  if (pkgDir !== null) dirs.add(pkgDir)
  const target = reexportTargetOf(file)
  if (target !== null) dirs.add(dirname(target))
  return [...dirs]
}

/**
 * 入口文件是不是一层再导出桩；是的话返回它指回的真实文件。
 *
 * 构建脚本（scripts/build-packages.mjs 的 stubBody）写出来的就是这一行
 * `export * from '<相对路径>';`。只认这一种形状：认不出就当普通模块，不猜。
 */
function reexportTargetOf(file: string): string | null {
  try {
    // 桩只有一行；大文件不用读（也避免每次轮询把产物整份读进内存）。
    if (statSync(file).size > 4096) return null
    const text = readFileSync(file, 'utf8').trim()
    const matched = /^export\s+\*\s+from\s+['"]([^'"]+)['"];?$/.exec(text)
    if (matched === null) return null
    const specifier = matched[1]
    if (specifier === undefined || !specifier.startsWith('.')) return null
    return resolve(dirname(file), specifier)
  } catch {
    return null
  }
}

/**
 * 递归列出目录下的 .js / .json（跳过 node_modules 与 .git，深度封顶 6 层）。
 *
 * 跳 node_modules 是必须的：包目录里可能有自己的依赖，它们的变更不代表这个包变了。
 */
function listSourceFiles(dir: string, depth = 0): string[] {
  if (depth > 6) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path, depth + 1))
      continue
    }
    if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.json'))) files.push(path)
  }
  return files
}

/** 一个文件的指纹；读不到给 null（构建中间态按「这轮没这文件」处理）。 */
function stampOf(file: string): FileStamp | null {
  try {
    const stats = statSync(file)
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return null
  }
}

/** profile 目录里要盯的三份清单：任何一份变了，行集合都可能跟着变。 */
const PROFILE_FILES = ['package.json', 'compatibility.json', 'cordis.patch.yml'] as const

/** profile 清单的指纹：文件 → 指纹；读不到给 null（删掉了也算「变了」）。 */
function profileStampsOf(dir: string): Map<string, FileStamp | null> {
  const stamps = new Map<string, FileStamp | null>()
  for (const name of PROFILE_FILES) {
    const file = join(dir, name)
    stamps.set(file, stampOf(file))
  }
  return stamps
}

/** 两张 profile 指纹表是否一样（文件出现/消失也算变）。 */
function sameProfileStamps(
  left: Map<string, FileStamp | null>,
  right: Map<string, FileStamp | null>,
): boolean {
  if (left.size !== right.size) return false
  for (const [file, stamp] of left) {
    const other = right.get(file)
    if (other === undefined) return false
    if (stamp === null || other === null) {
      if (stamp !== other) return false
      continue
    }
    if (stamp.mtimeMs !== other.mtimeMs || stamp.size !== other.size) return false
  }
  return true
}

/** 两份指纹表是否一模一样（少了文件也算变）。 */
function sameStamps(left: Map<string, FileStamp>, right: Map<string, FileStamp>): boolean {
  if (left.size !== right.size) return false
  for (const [file, stamp] of left) {
    const other = right.get(file)
    if (other === undefined || other.mtimeMs !== stamp.mtimeMs || other.size !== stamp.size) return false
  }
  return true
}

/** 一张库包依赖图：哪一行 import 了哪个库包、库包要盯哪些目录。 */
interface LibraryGraph {
  /** 行身份 → 它 import 的库包名。 */
  rows: Map<string, Set<string>>
  /** 库包名 → 引用它的行身份。 */
  referrers: Map<string, Set<string>>
  /** 库包名 → 要盯的目录（真实代码目录 + 再导出桩目录）。 */
  dirs: Map<string, string[]>
}

/** 应用里没有库包时的空图：省掉扫全部包内容的开销。 */
function emptyLibraryGraph(): LibraryGraph {
  return { rows: new Map(), referrers: new Map(), dirs: new Map() }
}

/**
 * 应用里哪些包是库包（清单里 `pneuma.library === true`），以及各自要盯的目录。
 *
 * 从 `lib/node_modules/@pneuma/*` 读：这是构建产物里包名的权威来源（源目录名可能
 * 与包名不一致，例如 runtime），解析钩子判「是不是库包」也用同一份清单。
 * @param appDir - 应用安装目录
 */
function libraryEntriesOf(appDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const scopeDir = join(appDir, 'lib', 'node_modules', '@pneuma')
  let entries
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true })
  } catch {
    // 还没构建（没有 lib/node_modules）：没有库包可盯。
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let manifest: { pneuma?: { library?: unknown } }
    try {
      manifest = JSON.parse(readFileSync(join(scopeDir, entry.name, 'package.json'), 'utf8')) as typeof manifest
    } catch {
      continue
    }
    if (manifest?.pneuma?.library !== true) continue
    // 库包的真实代码在再导出桩指回的那一层；watchDirsOf 两处都收。
    out.set(entry.name, watchDirsOf(join(scopeDir, entry.name, 'index.js')))
  }
  return out
}

/** 构建产物里认这四种静态依赖写法（与 scripts/plugin-dep-graph.mjs 同一套口径）。 */
const LIB_IMPORT_PATTERNS = [
  /(?:^|\s)(?:import|export)\b[^\n]*?from\s*['"](@pneuma\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](@pneuma\/[^'"]+)['"]/g,
  /^\s*import\s+['"](@pneuma\/[^'"]+)['"]/gm,
  /\brequire\s*\(\s*['"](@pneuma\/[^'"]+)['"]/g,
]

/** 一段构建产物里静态 import 的 `@pneuma/<name>`（运行时包不算包依赖）。 */
function importedPneumaNames(source: string): string[] {
  const names: string[] = []
  for (const pattern of LIB_IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      const name = match[1].slice('@pneuma/'.length).split('/')[0]
      if (name !== undefined && name !== '' && name !== 'runtime') names.push(name)
    }
  }
  return names
}

/**
 * 建「库包 → 引用它的行」的图。
 *
 * 扫的是**行自己的构建产物**（不是 lib/packages 全量）：行入口经过再导出桩指回
 * `lib/packages/<id>`，与用户 profile 里装的覆盖版包也走同一条路。这样不用假设
 * 「行来自应用自带包」，外部插件 import 库包同样算得出来。
 * @param targets - 当前挂载的行
 * @param dirsOf - 入口 → 要扫的目录
 * @param appDir - 应用安装目录（读库包清单）
 */
function buildLibraryGraph(
  targets: readonly PluginWatchTarget[],
  dirsOf: (file: string) => string[],
  appDir: string,
): LibraryGraph {
  const libraries = libraryEntriesOf(appDir)
  if (libraries.size === 0) return emptyLibraryGraph()
  const graph = emptyLibraryGraph()
  for (const target of targets) {
    const found = new Set<string>()
    for (const dir of dirsOf(target.file)) {
      for (const file of listSourceFiles(dir)) {
        // 只读 .js：package.json 里没有 import 语句，读它只是白花钱。
        if (!file.endsWith('.js')) continue
        let source
        try {
          source = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        for (const name of importedPneumaNames(source)) if (libraries.has(name)) found.add(name)
      }
    }
    if (found.size === 0) continue
    graph.rows.set(target.identity, found)
    for (const name of found) {
      const referrers = graph.referrers.get(name) ?? new Set<string>()
      referrers.add(target.identity)
      graph.referrers.set(name, referrers)
      const dirs = libraries.get(name)
      if (dirs !== undefined) graph.dirs.set(name, dirs)
    }
  }
  return graph
}

/**
 * 造一个功能包 / 库包轮询器。
 *
 * 生命周期：`createPluginWatch` 立刻做一轮基线扫描（启动前就改过的文件不会被当成
 * 「刚刚变了」），之后按 `pollIntervalMs` 轮询；发现变化先攒进待办，去抖窗口结束
 * 才重挂（同一轮构建写多个文件只换一次）。
 *
 * 三类变更分开记：行自己的目录变了 → 逐行重挂；库包目录变了 → 把引用它的行合并成
 * 一批重挂（一次换代）；profile 清单变了 → 重算组合包（挂新行、卸删掉的包的行）。
 * 三类共用同一个定时器与去抖窗口，同一窗口里命中同一行时只处理一次。
 */
export function createPluginWatch(options: PluginWatchOptions = {}): PluginWatchHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const debounceMs = options.debounceMs ?? 200
  const logger = options.logger ?? stderrLogger
  const targets = options.targets ?? listMountedPluginSources
  const dirsOf = options.dirsOf ?? watchDirsOf
  const remount = options.remount ?? remountExternalPlugin
  // 批量重挂缺省走 loader 的批量实现（同一批只换一代）；自检换了 remount 又没给
  // remountMany 时退化成逐行调用，别让库包这一路偷偷用真实 loader。
  const remountMany =
    options.remountMany ??
    (options.remount === undefined
      ? remountExternalPlugins
      : async (ids: readonly string[]): Promise<RemountResult[]> => {
          const results: RemountResult[] = []
          for (const id of ids) results.push(await remount(id))
          return results
        })
  const appDir = options.appDir ?? APP_INSTALL_DIR
  /** profile 清单这一路：目录（null = 不启用）。 */
  let profileDir = options.profileDir ?? null
  /** profile 清单上一轮的指纹（null = 还没立过基线）。 */
  let profileBaseline: Map<string, FileStamp | null> | null = null
  /** 攒着等去抖结束的 profile 目录（null = 这一轮没有清单变更）。 */
  let pendingProfileDir: string | null = null
  // 缺省的重算实现：动态 import 加载器（静态 import 会成环），挂到调用方给的内核上。
  const reconcile =
    options.reconcile ??
    (async (dir: string): Promise<ProfileReconcileResult> => {
      const kernelRoot = options.root
      if (kernelRoot === undefined) throw new Error('没有内核 root，组合包重算无从下手')
      const loader = await import('./plugin-loader.js')
      return loader.reconcileProfileBundles(kernelRoot, dir)
    })
  /** 上一轮的指纹（行 id → 文件 → 指纹）。 */
  let baseline = new Map<string, TargetState>()
  /** 库包上一轮的指纹（库包名 → 文件 → 指纹）。 */
  let libraryBaseline = new Map<string, Map<string, FileStamp>>()
  /** 攒着等去抖结束的行 id（行自己改代码的那些）。 */
  const pending = new Set<string>()
  /** 攒着等去抖结束的库包（库包名 → 受影响的行）。 */
  const pendingByLibrary = new Map<string, Set<string>>()
  /** 库包 → 行 的依赖图：启动时建一次，行集合或行代码变了才重建。 */
  let graph: LibraryGraph | null = null
  let graphSignature = ''
  let graphDirty = true
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let flushing = false
  let running = true

  /** 按需建图：行集合变了、或上一次重挂改过行代码，就重扫一遍 import。 */
  const ensureGraph = (list: readonly PluginWatchTarget[]): LibraryGraph => {
    const signature = list.map((target) => target.identity + '\u0000' + target.file).join('\n')
    if (graph !== null && !graphDirty && signature === graphSignature) return graph
    graph = buildLibraryGraph(list, dirsOf, appDir)
    graphSignature = signature
    graphDirty = false
    return graph
  }

  /**
   * profile 清单比上一轮：变了返回 true。
   *
   * 第一次只立基线——启动前就装好的包不该被当成「刚刚装了包」再重算一遍。
   */
  const scanProfile = (): boolean => {
    if (profileDir === null) return false
    const stamps = profileStampsOf(profileDir)
    const previous = profileBaseline
    profileBaseline = stamps
    return previous !== null && !sameProfileStamps(previous, stamps)
  }

  /** 扫一轮，返回「相对上一轮变了」的行、库包与 profile 清单；顺带把基线换成这一轮。 */
  const scan = (): {
    rows: string[]
    libraries: Array<{ name: string; rows: string[] }>
    profile: boolean
  } => {
    const list = targets()
    const currentGraph = ensureGraph(list)
    const changedRows: string[] = []
    const next = new Map<string, TargetState>()
    for (const target of list) {
      const dirs = dirsOf(target.file)
      const files = new Set<string>([target.file])
      for (const dir of dirs) for (const file of listSourceFiles(dir)) files.add(file)
      const stamps = new Map<string, FileStamp>()
      for (const file of files) {
        const stamp = stampOf(file)
        if (stamp !== null) stamps.set(file, stamp)
      }
      const previous = baseline.get(target.identity)
      // 第一次见到的行只建立基线，不算变更（否则每挂一个新行都要白重挂一次）。
      if (previous !== undefined && previous.file === target.file && !sameStamps(previous.stamps, stamps)) {
        changedRows.push(target.identity)
      }
      next.set(target.identity, { file: target.file, stamps })
    }
    baseline = next

    // 库包：只盯「至少有一行引用它」的那些。没有引用方的库包改了也不该重挂，
    // 所以它们连目录都不进图，不会产生事件。
    const changedLibraries: Array<{ name: string; rows: string[] }> = []
    const nextLibrary = new Map<string, Map<string, FileStamp>>()
    for (const [name, dirs] of currentGraph.dirs) {
      const stamps = new Map<string, FileStamp>()
      for (const dir of dirs) {
        for (const file of listSourceFiles(dir)) {
          const stamp = stampOf(file)
          if (stamp !== null) stamps.set(file, stamp)
        }
      }
      const previousStamps = libraryBaseline.get(name)
      // 第一次见到的库包也只立基线：否则刚启动就会因为「库包已经在这」白重挂一轮。
      if (previousStamps !== undefined && !sameStamps(previousStamps, stamps)) {
        const referrers = currentGraph.referrers.get(name)
        if (referrers !== undefined && referrers.size > 0) {
          changedLibraries.push({ name, rows: [...referrers] })
        }
      }
      nextLibrary.set(name, stamps)
    }
    libraryBaseline = nextLibrary
    return { rows: changedRows, libraries: changedLibraries, profile: scanProfile() }
  }

  /** 库包变更命中的行：合并成一批，一次换代。 */
  const flushLibraryRows = async (
    rows: string[],
    namesByRow: Map<string, Set<string>>,
  ): Promise<void> => {
    let results: RemountResult[]
    try {
      // 走 loader 的批量重挂：同一批只 bump 一次代数。
      results = await remountMany(rows)
    } catch (error) {
      logger.warn(
        `[plugin-watch] 库包变更后重挂出错：${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    let okCount = 0
    rows.forEach((identity, index) => {
      const result = results[index]
      if (result === undefined) return
      if (result.ok) {
        okCount += 1
        return
      }
      // meta.problem 由 remountExternalPlugin 写；这里补一行日志，保证「失败看得见」。
      logger.warn(`[plugin-watch] ${identity} 热重挂失败，旧版本继续运行：${result.problem ?? '原因不明'}`)
    })
    if (okCount === 0) return
    const names = [...new Set(rows.flatMap((identity) => [...(namesByRow.get(identity) ?? [])]))]
    const generation = results.find((result) => result.ok)?.generation ?? 0
    // 一次库变更只写一行 info：命中两行时写两行日志只会把「到底换了几代」淹掉。
    logger.info(
      `[plugin-watch] 库包 ${names.join('、')} 变了：已重挂 ${okCount} 行（代数 ${String(generation)}）`,
    )
  }

  /**
   * 重算组合包：清单变了才走这一支。
   *
   * 这里只写日志，不抛：一个包装不上（缺依赖、版本闸没过）不该让轮询停掉，
   * 也不该连累同一窗口里那些纯粹改代码的行。
   */
  const reconcileProfile = async (dir: string): Promise<void> => {
    logger.info('[plugin-watch] profile 清单变了，重算组合包')
    let result: ProfileReconcileResult
    try {
      result = await reconcile(dir)
    } catch (error) {
      // 行 id 重复、同名包解析出两个目录这类配置错误会从这里抛：原文照写，别让「装不上」变成谜。
      logger.warn(`[plugin-watch] 重算组合包出错：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const failure of result.failures) {
      logger.warn(`[plugin-watch] ${failure.name} 没挂上：${failure.problem}`)
    }
    for (const warning of result.warnings) logger.warn(`[plugin-watch] 组合包：${warning}`)
    logger.info(`[plugin-watch] 挂了 ${String(result.mounted.length)} 行 / 卸了 ${String(result.unmounted.length)} 行`)
    // 行集合变了，库包依赖图要重扫（新挂的行可能 import 了别的库包）。
    if (result.mounted.length > 0 || result.unmounted.length > 0) graphDirty = true
  }

  /** 去抖结束：把攒着的行真的重挂掉，顺带重算组合包。 */
  const flush = async (): Promise<void> => {
    if (stopped || flushing) return
    flushing = true
    const direct = [...pending]
    const byLibrary = new Map(pendingByLibrary)
    const profileToReconcile = pendingProfileDir
    pending.clear()
    pendingByLibrary.clear()
    pendingProfileDir = null
    try {
      // 先重算组合包：它会挂上新行、卸掉删掉的包的行，活跃集合要在它之后取。
      if (profileToReconcile !== null) await reconcileProfile(profileToReconcile)
      // 去抖窗口里可能已经卸载：只重挂现在还挂着的行。
      const alive = new Set(targets().map((target) => target.identity))
      // 库包命中的行先去重再合成一批：同一行被两个库包同时命中，也只换一次。
      const libraryRows = new Set<string>()
      const namesByRow = new Map<string, Set<string>>()
      for (const [name, rows] of byLibrary) {
        for (const identity of rows) {
          if (!alive.has(identity)) continue
          libraryRows.add(identity)
          const names = namesByRow.get(identity) ?? new Set<string>()
          names.add(name)
          namesByRow.set(identity, names)
        }
      }
      if (libraryRows.size > 0) await flushLibraryRows([...libraryRows], namesByRow)
      // 行自己的代码变了，它 import 了哪些库包可能也变了：下一轮重建依赖图。
      if (direct.length > 0) graphDirty = true
      for (const identity of direct) {
        // 同一行已经按「库包变更」重挂过就不再重挂第二次（一次变更只换一次）。
        if (!alive.has(identity) || libraryRows.has(identity)) continue
        // 单个行出事不拖累其余行：一行抛了，后面的还是要换上新代码。
        try {
          const result = await remount(identity)
          if (result.ok) {
            logger.info(`[plugin-watch] ${identity} 已换成新代码（代数 ${String(result.generation)}）`)
          } else {
            // meta.problem 由 remountExternalPlugin 写；这里补一行日志，保证「失败看得见」。
            logger.warn(`[plugin-watch] ${identity} 热重挂失败，旧版本继续运行：${result.problem ?? '原因不明'}`)
          }
        } catch (error) {
          logger.warn(
            `[plugin-watch] ${identity} 重挂出错：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    } finally {
      flushing = false
    }
  }

  /** 把一轮扫描结果记进待办（行、库包、profile 清单分开记，flush 时分别处理）。 */
  const applyChanges = (outcome: {
    rows: string[]
    libraries: Array<{ name: string; rows: string[] }>
    profile: boolean
  }): void => {
    for (const identity of outcome.rows) pending.add(identity)
    for (const item of outcome.libraries) pendingByLibrary.set(item.name, new Set(item.rows))
    if (outcome.profile && profileDir !== null) pendingProfileDir = profileDir
  }

  /** 扫一轮；有变化就进待办并重排去抖定时器。 */
  const poll = (): void => {
    if (stopped || flushing) return
    let outcome: {
      rows: string[]
      libraries: Array<{ name: string; rows: string[] }>
      profile: boolean
    }
    try {
      outcome = scan()
    } catch (error) {
      // 一轮读盘出错（权限、构建删目录）不该打死轮询：记一行，下一轮继续。
      logger.warn(`[plugin-watch] 轮询出错：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (outcome.rows.length === 0 && outcome.libraries.length === 0 && !outcome.profile) return
    applyChanges(outcome)
    // 同一文件连续变化合并成一次：每有新变更就重置去抖窗口。
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void flush().catch((error: unknown) => {
        logger.warn(`[plugin-watch] 重挂出错：${error instanceof Error ? error.message : String(error)}`)
      })
    }, debounceMs)
    timer.unref?.()
  }

  // 先立基线：启动前就改过的文件不算「刚刚变了」，否则一开轮询就白重挂一轮。
  try {
    scan()
  } catch {
    // 首次扫描失败留给轮询里再报（通常是临时目录还没建好）。
  }
  const ticker = setInterval(poll, pollIntervalMs)
  ticker.unref?.()

  return {
    async pollNow() {
      if (stopped) return
      let outcome: {
        rows: string[]
        libraries: Array<{ name: string; rows: string[] }>
        profile: boolean
      }
      try {
        outcome = scan()
      } catch (error) {
        logger.warn(`[plugin-watch] 轮询出错：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      applyChanges(outcome)
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      try {
        await flush()
      } catch (error) {
        logger.warn(`[plugin-watch] 重挂出错：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    stop() {
      stopped = true
      running = false
      if (timer !== null) clearTimeout(timer)
      timer = null
      clearInterval(ticker)
      pending.clear()
      pendingByLibrary.clear()
      pendingProfileDir = null
      baseline = new Map()
      libraryBaseline = new Map()
      profileBaseline = null
      graph = null
      graphSignature = ''
      graphDirty = true
    },
    get running() {
      return running
    },
    setProfileDir(dir) {
      if (stopped || dir === profileDir) return
      profileDir = dir
      // 基线**当场**立：刚接上就重算等于把「已经在这」当成「刚刚变了」，但拖到下一轮
      // 再立也不行——这一秒里装好的包会被当成「启动前就在」，白白漏掉一次重算。
      profileBaseline = dir === null ? null : profileStampsOf(dir)
      pendingProfileDir = null
    },
  }
}

/** 进程里那一个轮询器（插件运行时本身是进程级的：rootRef / pluginSources 都是单份）。 */
let shared: PluginWatchHandle | null = null

/** 被 DSC_HOT=0 关掉时的空句柄：不建定时器、不扫盘。 */
function inertHandle(): PluginWatchHandle {
  return {
    async pollNow() {
      // 关着就是关着：探针想手动驱动请直接用 createPluginWatch。
    },
    stop() {
      // 没有东西可停。
    },
    running: false,
    setProfileDir() {
      // 关着就是关着：profile 清单这一路也不启用。
    },
  }
}

/** 宿主 logger 的适配：cordis 的 ctx.logger 在内核里一定在，裸 Context 上兜底到 stderr。 */
function loggerOf(root: Context): PluginWatchLogger {
  try {
    const logger = root.logger
    if (typeof logger?.info === 'function' && typeof logger?.warn === 'function') {
      return {
        info: (line) => logger.info(line),
        warn: (line) => logger.warn(line),
      }
    }
  } catch {
    // 没有日志服务就用 stderr；热更失败不能因为日志出不来而消失。
  }
  return stderrLogger
}

/**
 * 启动功能包 / 库包 / profile 清单热更轮询（幂等；`DSC_HOT=0` 关闭，默认开）。
 *
 * 由 plugin-loader 在 {@link mountApplicationRows} 末尾与 `mountAllExternalPlugins`
 * 里拉起，宿主不必再调；手工调用也安全（同一个进程只会有一个轮询器）。
 *
 * 两条启动路径的先后不保证：先到的那次只带 appDir，后到的带 profileDir 时
 * 这里不重建轮询器，只把「profile 清单」这一路补上（`setProfileDir` 会重立基线）。
 * @param root - 内核 root（组合包重算要用它）
 * @param options.appDir - 应用安装目录（缺省 {@link APP_INSTALL_DIR}）；库包清单从这里读
 * @param options.profileDir - profile 目录；不传 = 清单这一路不启用
 */
export function startPluginWatch(
  root: Context,
  options: { appDir?: string; profileDir?: string } = {},
): PluginWatchHandle {
  if (shared !== null) {
    // 第二次调用只补 profile 这一路：已有轮询器的定时器与基线都不动。
    if (options.profileDir !== undefined) shared.setProfileDir(options.profileDir)
    return shared
  }
  if (process.env['DSC_HOT'] === '0') return inertHandle()
  const logger = loggerOf(root)
  const handle = createPluginWatch({
    root,
    logger,
    ...(options.appDir === undefined ? {} : { appDir: options.appDir }),
    ...(options.profileDir === undefined ? {} : { profileDir: options.profileDir }),
  })
  shared = handle
  logger.info('[plugin-watch] 功能包 / 库包 / profile 清单热更已开（轮询 1000ms，去抖 200ms；DSC_HOT=0 可关）')
  return handle
}

/** 停掉进程里的轮询器（自检与宿主退出时用）。 */
export function stopPluginWatch(): void {
  shared?.stop()
  shared = null
}
