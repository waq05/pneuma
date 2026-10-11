/**
 * 插件版界面的启动清单（boot graph）：宿主告诉界面壳「要加载哪几个插件包、
 * 按什么顺序、每个包从哪个地址取」。
 *
 * 这一份是宿主与浏览器壳之间的**唯一契约**（对齐 dsh 的 `window.__DSH_BOOT__`
 * 与它的 WebBootEntry / WebBootGraph）。
 *
 * 为什么顺序要算而不是照抄声明顺序：插件包之间有依赖（A 的组件要 import B 的槽），
 * 顺序错了 A 会在 B 的槽还没声明时去注册，当场报错。所以这里做一次拓扑排序，
 * 并且在成环时**报出来是哪几个包成环**而不是死循环。
 *
 * @module dsc/ui/manifest
 */

/** 插件包能跑在哪种壳里。web = 浏览器壳（桌面与远程共用），tui = 终端壳（同进程）。 */
export type UiPlatform = 'web' | 'tui'

/** 宿主发现的一个插件包（还没算地址）。 */
export interface UiPluginRow {
  /** 稳定 id，也是 /plugins/<id>/client.js 里的那一段。 */
  id: string
  /** 允许它 import 的额外模块名；其余一律拒绝（白名单，见界面壳的加载器）。 */
  external?: string[]
  /** 必须先把工厂注册好的其它插件 id。 */
  inject?: string[]
  /** 第一档预取：需要尽早出现的插件（大小药丸、状态条之类）。 */
  immediately?: boolean
  /** 缺省 web。 */
  platform?: UiPlatform
  /**
   * 插件声明的 `@dsc/ui` 契约版本区间（semver，如 `^1.0.0`）。宿主拿它对壳的
   * `apiVersion` 做门禁：不满足就不进启动图，原因写进 problems——
   * 判定在宿主侧，浏览器产物里不需要 semver。内置清单（构建产物自带
   * `apiVersion`）的条目没有这一项，视为与壳同源、总是满足。
   */
  api?: string
}

/** 清单里的一条（已经算好地址与版本）。 */
export interface UiPluginEntry {
  id: string
  /** 相对页面的地址，形如 `plugins/hello/client.js?rev=abc123`。 */
  url: string
  /** 产物版本：文件 mtime/ctime/大小算出来的短哈希，换文件就换地址。 */
  rev: string
  inject?: string[]
  external?: string[]
  immediately?: boolean
}

/** 宿主注入页面的启动图。 */
export interface UiBootGraph {
  /** 整图的一致性锚：任一条变了它就变。 */
  rev: string
  entries: UiPluginEntry[]
  /** 界面壳要显示的宿主身份（哪台机器、哪个版本）。 */
  host: { name: string; version: string }
}

/** 短哈希长度（与 dsh 的 12 位一致：够短不撞，也够眼睛扫）。 */
const HASH_LENGTH = 12

/** 摘要函数：把若干字段拼成一个短哈希。默认那份不依赖 node，浏览器壳也能算。 */
export type HashFn = (...parts: readonly string[]) => string

/**
 * 一个插件包的地址。相对路径：页面挂在 `/` 或子路径下都成立。
 * @param id - 插件 id
 * @param rev - 产物版本
 */
export function pluginBundleUrl(id: string, rev: string): string {
  return `plugins/${encodeURIComponent(id)}/client.js?rev=${rev}`
}

/** 把若干字段拼成短哈希；字段间加长度前缀，防止内容在字段边界上搬家。 */
export function shortHash(...parts: readonly string[]): string {
  // FNV-1a 32 位，重复四轮拼成 48 位——比 sha1 省一次 crypto 依赖（浏览器壳里没有 node:crypto），
  // 用途只是「换文件就换地址」，不承担安全职责。
  let out = ''
  for (let round = 0; round < 4; round += 1) {
    let hash = 0x811c9dc5 ^ round
    for (const part of parts) {
      const text = `${part.length}:${part}`
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
    }
    out += hash.toString(16).padStart(8, '0')
  }
  return out.slice(0, HASH_LENGTH)
}

/** 文件系统指纹：mtime / ctime / 大小三项，够判「文件换了没有」。 */
export interface ArtifactStat {
  mtimeMs: number
  ctimeMs: number
  size: number
}

/**
 * 由文件指纹算产物版本（不读文件内容，构建后立刻能算）。
 *
 * 指纹取毫秒原值而不是取整：同一毫秒内、大小又恰好相同的重写会算出同一个版本，
 * 那样浏览器一年内都不会回源拿新字节。
 * @param stat - 文件指纹
 * @param hash - 摘要函数；宿主侧传 sha256 那份（浏览器壳用不到这个函数）
 */
export function artifactRev(stat: ArtifactStat, hash: HashFn = shortHash): string {
  return hash('artifact', String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size))
}

/**
 * 拓扑排序：被依赖的排在依赖者前面。
 *
 * 快照顺序来自宿主的扫描顺序（调用方传进来的顺序），只有依赖边会改变它，
 * 所以同一批插件每次算出来的顺序都一样，界面不会重排。
 *
 * 顺序只是**优化**不是正确性前提：插件要往别人声明的槽里放东西，用
 * `slots.injectSlot` 等声明出现即可，排不排都能成。
 *
 * @param rows - 宿主发现的插件包
 * @returns 排好序的一份新数组
 * @throws {Error} 成环或 id 重复时抛出（后者会让界面静默少一块，不能放过）
 */
export function orderUiPlugins<T extends UiPluginRow>(rows: readonly T[]): T[] {
  const byId = new Map<string, T>()
  for (const row of rows) {
    if (byId.has(row.id)) {
      throw new Error(`启动清单里有两个 id 相同的界面插件：${row.id}（按 id 去重会静默少装一个）`)
    }
    byId.set(row.id, row)
  }
  const ordered: T[] = []
  const placed = new Set<string>()
  const open: string[] = []
  const visit = (row: T): void => {
    if (placed.has(row.id)) return
    const cycleStart = open.indexOf(row.id)
    if (cycleStart >= 0) {
      throw new Error(
        `界面插件依赖成环：${[...open.slice(cycleStart), row.id].join(' -> ')}`
        + '（inject 是「先注册工厂」的边，不能互相等）',
      )
    }
    open.push(row.id)
    for (const name of row.inject ?? []) {
      if (name === row.id) throw new Error(`界面插件 ${row.id} 把自己写进了 inject`)
      const dependency = byId.get(name)
      if (dependency !== undefined) visit(dependency)
    }
    open.pop()
    placed.add(row.id)
    ordered.push(row)
  }
  for (const row of rows) visit(row)
  return ordered
}

/**
 * 由「插件 id + 产物版本」拼出启动图。顺序在这里定，地址在这里算。
 *
 * 整图 rev 对**整条 entry**（含 inject / external / immediately）做摘要，不是只对
 * id 与产物版本做：只改清单里的声明（不动 bundle）时整图 rev 也必须跟着变，
 * 否则「靠 rev 判断要不要重载」的那一侧会漏掉声明类变更。
 * @param host - 宿主身份
 * @param artifacts - 已算出 rev 的插件包（顺序即扫描顺序）
 */
export function composeUiBootGraph(
  host: { name: string; version: string },
  artifacts: readonly (UiPluginRow & { rev: string })[],
): UiBootGraph {
  const entries: UiPluginEntry[] = orderUiPlugins(artifacts).map((artifact) => ({
    id: artifact.id,
    url: pluginBundleUrl(artifact.id, artifact.rev),
    rev: artifact.rev,
    ...(artifact.inject === undefined ? {} : { inject: artifact.inject }),
    ...(artifact.external === undefined ? {} : { external: artifact.external }),
    ...(artifact.immediately === true ? { immediately: true } : {}),
  }))
  const rev = shortHash('uiboot', JSON.stringify(entries))
  return { rev, entries, host }
}
