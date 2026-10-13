/**
 * 开发态热更的宿主半侧：轮询产物指纹 → 换代 → 产出「哪几个插件变了」的帧。
 *
 * 为什么是**轮询**而不是 fs.watch / chokidar（与参考实现同一个结论）：
 *
 *   1. 文件监听在网络盘/挂载盘上没有 inotify；而构建「写临时文件再 rename」的语义各平台
 *      不同（Windows 上 fs.watch 尤不可靠）。
 *   2. dsc 的开发循环是 `pnpm -C ui-shell build:plugins`（或手改 `lib/ui/plugins/<id>/client.js`），
 *      两者都只会让 stat 变；监听需要构建脚本与宿主多一条 IPC，省下的只是一次 500ms 轮询。
 *
 * 三类信号各管一段：
 *
 *   - **成员文件 stat**（每个图行的磁盘路径）：构建/手改的最常见形态；
 *   - **清单 stat**（`manifest.json` / 第三方 `plugin.json`）：新增/删掉一个插件的信号；
 *   - **内容摘要 rev**（换代时算）：gate 掉「文件被重写但字节没变」的假变更——
 *     这正是内置 rev 改内容摘要之后白拿的一段，改前每轮构建都会把 16 个插件全推一遍。
 *
 * 读不到某个文件（构建 swap 的中间态、或插件目录刚被删）时**不放弃整轮**：记一次
 * 「下轮强制比对」继续读完其余文件。这既保证这期间发生的写入不会丢，也让「已被删掉的
 * 插件」能靠下一轮换代从图里退场（它的 watch 还在删之前那份行表里）。
 *
 * 这个模块不依赖 cordis、不碰 HTTP：可被 node 探针单独驱动（`scripts/ui-hmr-test.mjs`）。
 *
 * @module dsc/core/ui-hmr
 */
import { statSync } from 'node:fs'
import type { UiBootGraph } from '../ui/manifest.js'

/** 要轮询的一个文件。 */
export interface UiHmrWatch {
  /** 身份（插件 id，或 `manifest` 这类目录级信号）。 */
  id: string
  path: string
}

/** 宿主推给页面的帧：`changed` 换装、`removed` 卸载、`graph` 是新图（壳据此对齐）。 */
export interface UiHmrFrame {
  rev: string
  changed: string[]
  removed: string[]
  graph: UiBootGraph
}

/** 造轮询器要给的几样东西。 */
export interface UiHmrOptions {
  /** 要轮询的文件（每次调用现取，新增行下一轮自动纳入）。 */
  watches(): UiHmrWatch[]
  /** 当前这一代的图（换代前后各取一次做 diff）。 */
  graph(): UiBootGraph
  /** 强制重收产物表 + 重组图 + 换 combo 表（`core/ui-boot-source.ts` 的 refresh）。 */
  refresh(): void
  /** 有真实变更时叫一次。 */
  onFrame(frame: UiHmrFrame): void
  /** 轮询间隔（毫秒），缺省 500（与参考实现的默认一致）。 */
  pollIntervalMs?: number
  log?(line: string): void
}

/** 轮询器句柄。 */
export interface UiHmrHandle {
  /** 立刻跑一轮（测试与「保存后马上推」用；正常靠定时器）。 */
  pollNow(): void
  stop(): void
}

/** 一个文件的三元指纹（mtime 毫秒原值/ctime/大小——与旧版内置 rev 同一套）。 */
interface FileStat {
  mtimeMs: number
  ctimeMs: number
  size: number
}

function sameStat(a: FileStat, b: FileStat | undefined): boolean {
  return b !== undefined && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size
}

/** 造一个开发态轮询器。 */
export function createUiHmr(options: UiHmrOptions): UiHmrHandle {
  const intervalMs = options.pollIntervalMs ?? 500
  const log = options.log ?? ((line: string): void => { process.stderr.write(`${line}\n`) })
  let baseline: Map<string, FileStat> | null = null
  /**
   * 上一代图（轮询器自己的基线）。
   *
   * 为什么不去问 options.graph() 当「变更前」：`graph()` 本身会做一次非强制收集，
   * 清单类变化（新增/删插件会改 manifest.json）在它那一问里就被收进来了——再 diff 就只剩
   * 「无变化」。基线必须是**上一次推给页面的那一份**，与宿主快照当前的取值无关。
   */
  let lastGraph = options.graph()
  /** 上一次轮询里有文件读不到（swap 中间态）：下一轮无论指纹如何都强制比对一次。 */
  let retryNext = false
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  /**
   * 读一遍所有 watch 的指纹。
   *
   * 单个文件读不到（构建 swap 中间态、或插件目录刚被删）**不中断整轮**：
   * 记 `missing` 并继续读别的——整轮中止会让「已被删掉的插件」永远进不了下一轮
   * （它的 watch 也在删之前的那份行表里，越抛越走不到换代）。
   */
  const syncBaseline = (): { stats: Map<string, FileStat>; missing: boolean } => {
    const stats = new Map<string, FileStat>()
    let missing = false
    for (const watch of options.watches()) {
      try {
        const stat = statSync(watch.path)
        stats.set(watch.id, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size })
      } catch {
        missing = true
      }
    }
    return { stats, missing }
  }

  const poll = (): void => {
    if (stopped) return
    const synced = syncBaseline()
    const current = synced.stats
    if (baseline === null) {
      baseline = current
      return
    }
    const known = baseline
    const touched = retryNext
      || synced.missing
      || current.size !== known.size
      || [...current].some(([id, stat]) => !sameStat(stat, known.get(id)))
    if (!touched) return
    retryNext = false

    // 元数据变了不代表内容变了（重写相同字节 / touch）：换代后按 rev diff，没变就什么都不推。
    options.refresh()
    const after = options.graph()
    const beforeRev = new Map(lastGraph.entries.map((entry) => [entry.id, entry.rev]))
    const afterRev = new Map(after.entries.map((entry) => [entry.id, entry.rev]))
    const changed = after.entries.filter((entry) => beforeRev.get(entry.id) !== entry.rev).map((entry) => entry.id)
    const removed = lastGraph.entries.filter((entry) => !afterRev.has(entry.id)).map((entry) => entry.id)
    const grew = after.rev !== lastGraph.rev
    lastGraph = after
    const resync = syncBaseline()
    baseline = resync.stats
    if (resync.missing) retryNext = true
    if (changed.length === 0 && removed.length === 0 && !grew) return
    options.onFrame({ rev: after.rev, changed, removed, graph: after })
  }

  timer = setInterval(() => {
    try {
      poll()
    } catch (error) {
      // 轮询里任何没接住的异常都不该打死定时器：记一行，下一轮继续。
      log(`[ui-hmr] 轮询出错：${error instanceof Error ? error.message : String(error)}`)
    }
  }, intervalMs)
  timer.unref?.()

  return {
    pollNow: () => {
      try {
        poll()
      } catch (error) {
        log(`[ui-hmr] 轮询出错：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    stop: () => {
      stopped = true
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}
