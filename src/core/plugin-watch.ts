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
  listMountedPluginSources,
  pluginPackageDirOf,
  remountExternalPlugin,
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
  /** 轮询间隔（毫秒），缺省 1000。 */
  pollIntervalMs?: number
  /** 去抖窗口（毫秒），缺省 200。 */
  debounceMs?: number
  logger?: PluginWatchLogger
}

/** 轮询器句柄。 */
export interface PluginWatchHandle {
  /** 立刻扫一轮并立即重挂（自检与「保存后马上推」用；正常靠定时器）。 */
  pollNow(): Promise<void>
  stop(): void
  /** 还在跑（被 DSC_HOT=0 关掉时是 false）。 */
  readonly running: boolean
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

/** 两份指纹表是否一模一样（少了文件也算变）。 */
function sameStamps(left: Map<string, FileStamp>, right: Map<string, FileStamp>): boolean {
  if (left.size !== right.size) return false
  for (const [file, stamp] of left) {
    const other = right.get(file)
    if (other === undefined || other.mtimeMs !== stamp.mtimeMs || other.size !== stamp.size) return false
  }
  return true
}

/**
 * 造一个功能包轮询器。
 *
 * 生命周期：`createPluginWatch` 立刻做一轮基线扫描（启动前就改过的文件不会被当成
 * 「刚刚变了」），之后按 `pollIntervalMs` 轮询；发现变化先攒进待办，去抖窗口结束
 * 才重挂（同一轮构建写多个文件只换一次）。
 */
export function createPluginWatch(options: PluginWatchOptions = {}): PluginWatchHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const debounceMs = options.debounceMs ?? 200
  const logger = options.logger ?? stderrLogger
  const targets = options.targets ?? listMountedPluginSources
  const dirsOf = options.dirsOf ?? watchDirsOf
  const remount = options.remount ?? remountExternalPlugin
  /** 上一轮的指纹（行 id → 文件 → 指纹）。 */
  let baseline = new Map<string, TargetState>()
  /** 攒着等去抖结束的行 id。 */
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let flushing = false
  let running = true

  /** 扫一轮，返回「相对上一轮变了」的行 id；顺带把基线换成这一轮。 */
  const scan = (): string[] => {
    const changed: string[] = []
    const next = new Map<string, TargetState>()
    for (const target of targets()) {
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
        changed.push(target.identity)
      }
      next.set(target.identity, { file: target.file, stamps })
    }
    baseline = next
    return changed
  }

  /** 去抖结束：把攒着的行真的重挂掉。 */
  const flush = async (): Promise<void> => {
    if (stopped || flushing) return
    flushing = true
    const ids = [...pending]
    pending.clear()
    try {
      // 去抖窗口里可能已经卸载：只重挂现在还挂着的行。
      const alive = new Set(targets().map((target) => target.identity))
      for (const identity of ids) {
        if (!alive.has(identity)) continue
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

  /** 扫一轮；有变化就进待办并重排去抖定时器。 */
  const poll = (): void => {
    if (stopped || flushing) return
    let changed: string[]
    try {
      changed = scan()
    } catch (error) {
      // 一轮读盘出错（权限、构建删目录）不该打死轮询：记一行，下一轮继续。
      logger.warn(`[plugin-watch] 轮询出错：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (changed.length === 0) return
    for (const identity of changed) pending.add(identity)
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
      let changed: string[]
      try {
        changed = scan()
      } catch (error) {
        logger.warn(`[plugin-watch] 轮询出错：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      for (const identity of changed) pending.add(identity)
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
      baseline = new Map()
    },
    get running() {
      return running
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
 * 启动功能包热更轮询（幂等；`DSC_HOT=0` 关闭，默认开）。
 *
 * 由 plugin-loader 在 {@link mountApplicationRows} 末尾拉起，宿主不必再调；手工调用
 * 也安全（同一个进程只会有一个轮询器）。
 */
export function startPluginWatch(root: Context): PluginWatchHandle {
  if (shared !== null) return shared
  if (process.env['DSC_HOT'] === '0') return inertHandle()
  const logger = loggerOf(root)
  const handle = createPluginWatch({ logger })
  shared = handle
  logger.info('[plugin-watch] 功能包热更已开（轮询 1000ms，去抖 200ms；DSC_HOT=0 可关）')
  return handle
}

/** 停掉进程里的轮询器（自检与宿主退出时用）。 */
export function stopPluginWatch(): void {
  shared?.stop()
  shared = null
}
