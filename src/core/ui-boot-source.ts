/**
 * 启动图的**当前代快照**：清单 → 图 → combo 批体三者一起换代。
 *
 * 为什么要有这一层（以前是每个请求 `force: true` 现算）：
 *
 *   1. HMR 的「换代」必须建立在一个快照上——图、批地址、批字节如果各算各的，页面拿到的
 *      批 rev 与宿主登记的字节可能不是同一代；快照把三者绑成一次原子换代。
 *   2. combo 的成员集合必须来自产物表（唯一口子 `collectUiArtifactsForPlatform`），
 *      不许由请求里的 id 列表决定——快照让路由层只能按登记好的精确 URL 命中。
 *   3. `/api/boot`、`/boot.js`、`/plugins/??…` 读同一份，请求路径上不再逐个 stat/读盘。
 *
 * 换代的触发只有三种：清单指纹变（`collect` 的缓存钥匙）、显式 `refresh()`、HMR 轮询判定变。
 * 每次换代都按规则收集计数，`stats()` 给探针读「这条页面加载花了几次插件请求」。
 *
 * @module dsc/core/ui-boot-source
 */
import { UiComboTable, joinComboParts, type UiComboBatchBody } from './ui-combo.js'
import {
  collectUiArtifactsForPlatform,
  readUiArtifactBytes,
  toUiPluginRows,
  uiArtifactFilePath,
  type UiArtifactDirs,
  type UiPluginArtifacts,
} from './ui-bundles.js'
import { composeUiBootGraph, type UiBootGraph } from '../ui/manifest.js'

/** 一个批在磁盘上的现行位置（HMR 轮询按它 stat）。 */
export interface UiBootWatchRow {
  id: string
  /** 磁盘绝对路径。 */
  path: string
  file: string
  rev: string
}

/** 请求计数（探针读数面：16 个插件物化请求数 ≤3 就是数这个）。 */
export interface UiBootRequestStats {
  /** 命中批 combo 的次数。 */
  combo: number
  /** 命中单资源的次数。 */
  single: number
  /** 按 id 数的单资源次数（回退探针用）。 */
  byId: Record<string, number>
}

/** 造快照要给的几样东西。 */
export interface UiBootSourceOptions {
  host: { name: string; version: string }
  /** 内置插件目录。 */
  builtinDir: string
  /** 第三方插件根目录；不给用标准落点。 */
  thirdPartyDir?: string
}

/** 宿主侧共用的启动图快照口子。 */
export interface UiBootSource {
  /** 当下这一代（清单指纹没变就不重算）。 */
  graph(): UiBootGraph
  /** 当前积累的装载问题（第三方没信任、api 不匹配、bundle 缺失…）。 */
  problems(): string[]
  /** 强制重收产物表（界面壳重新构建后不必重启宿主）；换代会带上 combo 表。 */
  refresh(): { entries: number; problems: string[] }
  /** 组合的精确表（路由层按 URL 命中）。 */
  combos(): UiComboTable
  /** HMR 轮询要的行。 */
  watchRows(): UiBootWatchRow[]
  /** 当前产物表（诊断）。 */
  artifacts(): UiPluginArtifacts
  stats(): UiBootRequestStats
  resetStats(): void
  /** 路由层每伺服一个 /plugins 请求记一笔。 */
  countRequest(kind: 'combo' | 'single', id?: string): void
}

/** 造一份启动图快照（进程内每个伺服面一份：本机界面服务与远程壳各持自己的）。 */
export function createUiBootSource(options: UiBootSourceOptions): UiBootSource {
  const dirs: UiArtifactDirs = {
    builtinDir: options.builtinDir,
    ...(options.thirdPartyDir === undefined ? {} : { thirdPartyDir: options.thirdPartyDir }),
  }
  let artifacts = collectUiArtifactsForPlatform('web', { force: true, builtinDir: dirs.builtinDir, ...(dirs.thirdPartyDir === undefined ? {} : { thirdPartyDir: dirs.thirdPartyDir }) })
  let graph = composeUiBootGraph(options.host, toUiPluginRows(artifacts.entries))
  const combo = new UiComboTable()
  combo.replace(buildComboBodies(graph, artifacts, dirs))
  const stats: UiBootRequestStats = { combo: 0, single: 0, byId: {} }

  /**
   * 重组一代：收产物表 → 组图 → 图 rev 变了才换 combo 表。
   *
   * 「rev 没变就不换 combo」是内容摘要 rev 的直接收益：构建重写但字节没变时，
   * 批体没变、旧组合继续命中，前端也不会被推一帧假变更。
   */
  const recompose = (force: boolean): UiPluginArtifacts => {
    const fresh = collectUiArtifactsForPlatform('web', {
      force,
      builtinDir: dirs.builtinDir,
      ...(dirs.thirdPartyDir === undefined ? {} : { thirdPartyDir: dirs.thirdPartyDir }),
    })
    const freshGraph = composeUiBootGraph(options.host, toUiPluginRows(fresh.entries))
    artifacts = fresh
    if (freshGraph.rev !== graph.rev) {
      graph = freshGraph
      combo.replace(buildComboBodies(freshGraph, fresh, dirs))
    }
    return fresh
  }

  return {
    graph: () => {
      // 非强制收集：清单指纹没变时只是几次 stat，变了才重建产物表。
      recompose(false)
      return graph
    },
    problems: () => [...artifacts.problems],
    refresh: () => {
      const fresh = recompose(true)
      return { entries: fresh.entries.length, problems: fresh.problems }
    },
    combos: () => combo,
    watchRows: () => {
      const rows: UiBootWatchRow[] = []
      for (const entry of artifacts.entries) {
        const path = uiArtifactFilePath(entry, dirs)
        if (path === null) continue
        rows.push({ id: entry.id, path, file: entry.file, rev: entry.rev })
      }
      return rows
    },
    artifacts: () => artifacts,
    stats: () => ({ combo: stats.combo, single: stats.single, byId: { ...stats.byId } }),
    resetStats: () => {
      stats.combo = 0
      stats.single = 0
      for (const key of Object.keys(stats.byId)) delete stats.byId[key]
    },
    countRequest: (kind, id) => {
      if (kind === 'combo') stats.combo += 1
      else {
        stats.single += 1
        if (id !== undefined) stats.byId[id] = (stats.byId[id] ?? 0) + 1
      }
    },
  }
}

/**
 * 把图里的每个批拼成字节表。
 *
 * 成员字节从产物条目读（内置读 `<dir>/<id>/<file>`，第三方读 `<root>/<id>/ui/client.js`）；
 * 有一个成员读不到就**整批不登记**——客户端走单资源回退，与「成员缺文件在组图时就已经被判过、
 * 不进图」的口径前后一致，不会出现半截批。
 */
function buildComboBodies(
  graph: UiBootGraph,
  artifacts: UiPluginArtifacts,
  dirs: UiArtifactDirs,
): UiComboBatchBody[] {
  const byId = new Map(artifacts.entries.map((entry) => [entry.id, entry]))
  const bodies: UiComboBatchBody[] = []
  for (const batch of graph.batches) {
    if (batch.url === undefined || batch.rev === undefined) continue
    const parts: Buffer[] = []
    let complete = true
    for (const id of batch.entries) {
      const entry = byId.get(id)
      const bytes = entry === undefined ? null : readUiArtifactBytes(entry, dirs)
      if (bytes === null) {
        complete = false
        break
      }
      parts.push(bytes)
    }
    if (!complete) continue
    bodies.push({ url: `/${batch.url}`, rev: batch.rev, body: joinComboParts(parts) })
  }
  return bodies
}
