/**
 * 插件「行」的 patch 层：把 dsh 的 `cordis.patch.yml` 语义搬过来。
 *
 * 为什么需要它：dsh 的插件包（bundle）自带一份 patch 列表，用 **id 指向某一行** 改配置、
 * 或 `insert` 往某个 group 里插几行。没有这层语义，组合包「插几行插件」的意图就丢了——
 * 装进去只剩一个空壳。
 *
 * 算法照 dsh 的 `vendor/include/src/index.ts` 的 `applyEntryPatches`（逐条对齐，别自创）：
 *   1. 先按 id 建索引，**递归进 group 的子行**（`group === true` 且 `config` 是数组）；
 *   2. 有 `insert` 的条目：带 id 就插到那个 group 的子行末尾（目标不是 group 就告警跳过），
 *      不带 id 就追加到顶层；插完把新行**也建进索引**（同一层后面的 patch 要能改它们）；
 *   3. 没有 `insert` 的条目必须有 id，找不到目标就告警跳过；
 *   4. 带 `name` 的条目先核对名字，不符就跳过（防「改错行」）；
 *   5. 其余键**逐个覆盖**到目标行上——注意 `config` 是整块替换，不是深合并
 *      （dsh 就是这个口径，深合并会让「删掉一个字段」表达不出来）。
 *
 * 与 dsh 唯一的有意差别：**`!!js` 一律拒绝**。dsh 允许 patch 里写 `!!js` 表达式并在加载时
 * 求值——那等于让一个插件包在宿主进程里执行任意表达式。我们读到就抛错并说清原因，
 * 不静默跳过（跳过会让「配置没生效」变成一个查不出来的谜）。
 *
 * @module dsc/core/plugin-patch
 */
import { existsSync, readFileSync } from 'node:fs'
import YAML from 'yaml'

/** 一行插件（Pneuma 侧的最小形状：id 是稳定键，name 是加载目标）。 */
export interface PluginRow {
  /** 行的稳定 id（patch 按它定位；Pneuma 里就是插件文件名或包名）。 */
  id?: string
  /** 加载目标（文件路径或包名）。 */
  name?: string
  /** 这一行的配置（patch 替换的是整块）。 */
  config?: unknown
  /** 停用这一行。 */
  disabled?: boolean | null
  /** group 行：`config` 是子行数组。 */
  group?: boolean | null
  /** 其余字段原样保留（dsh 的 inject / intercept / isolate 之类）。 */
  [key: string]: unknown
}

/** 一条 patch（dsh 的 `PatchOptions`）。 */
export interface PatchEntry {
  id?: string
  insert?: PluginRow[]
  name?: string
  [key: string]: unknown
}

/** 一层 patch：一个来源（某个 bundle 的 cordis.patch.yml、profile 自己的、或 `--patch` 覆盖层）。 */
export interface PatchLayer {
  /** 诊断里显示的来源（文件路径或 `包名 v1.2.3`）。 */
  label: string
  patches: readonly PatchEntry[]
}

/** 一层 patch 的结果。 */
export interface PatchResult {
  rows: PluginRow[]
  /** 人话告警（找不到目标行、目标不是 group、名字不符、含 `!!js` 被拒）。 */
  warnings: string[]
}

/** patch 文件里出现了 `!!js`（求值等于任意代码执行）时的错误。 */
export class PatchUnsafeError extends Error {
  constructor(file: string) {
    super(
      `${file} 里用了 !!js 表达式。dsh 会在加载时求值，那等于让插件包在 Pneuma 进程里执行任意表达式，` +
        '所以这里一律拒绝。请让插件作者改成字面量配置，或者用 Pneuma 自己的设置项。',
    )
  }
}

const isRow = (value: unknown): value is PluginRow => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 解析一份 patch 列表（YAML 文本）。
 * @param text - 文件内容
 * @param label - 诊断里怎么称呼这一层（通常是文件路径）
 * @returns 这一层的 patch 条目
 * @throws {PatchUnsafeError} 文本里出现 `!!js`
 * @throws {Error} 不是 YAML、顶层不是数组、数组元素不是 mapping
 */
export function parsePatchList(text: string, label: string): PatchEntry[] {
  // 先查 !!js：解析器遇到它要么求值要么报错，两种都不该发生，所以按文本先拦住。
  if (/!!js\b/.test(text)) throw new PatchUnsafeError(label)
  let parsed: unknown
  try {
    parsed = YAML.parse(text)
  } catch (error) {
    throw new Error(`${label} 不是合法的 YAML：${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} 的顶层必须是 YAML 数组（一行一条 patch），实际是 ${typeof parsed}`)
  }
  return parsed.map((entry, index) => {
    if (!isRow(entry)) throw new Error(`${label} 第 ${String(index + 1)} 条不是 mapping（一行一条 patch）`)
    return entry as PatchEntry
  })
}

/**
 * 读一层 patch 文件；文件不存在返回 null（= 这一层没有）。
 * @param file - 绝对路径
 * @param label - 诊断名（缺省用路径）
 * @returns 这一层；文件不存在给 null
 * @throws {PatchUnsafeError} 含 `!!js`
 */
export function readPatchFile(file: string, label = file): PatchLayer | null {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  return { label, patches: parsePatchList(text, label) }
}

/**
 * 按 dsh 的 `applyEntryPatches` 逐层套用 patch。
 *
 * 层序即调用顺序：后面的层看得见前面层 insert 进来的行（同一条 patch 列表内部也是这样）。
 * @param rows - 初始行（内置行 + 用户清单）
 * @param layers - 按顺序的 patch 层
 * @returns 套用后的行 + 告警
 */
export function applyPatchLayers(rows: readonly PluginRow[], layers: readonly PatchLayer[]): PatchResult {
  const data: PluginRow[] = structuredClone(rows as PluginRow[])
  const warnings: string[] = []
  /** id → 行（group 的子行也进来）。 */
  const index = new Map<string, PluginRow>()
  const buildIndex = (entries: readonly PluginRow[]): void => {
    for (const entry of entries) {
      if (typeof entry.id === 'string' && entry.id !== '') index.set(entry.id, entry)
      if (entry.group === true && Array.isArray(entry.config)) buildIndex(entry.config as PluginRow[])
    }
  }
  buildIndex(data)

  for (const layer of layers) {
    for (const [position, patch] of layer.patches.entries()) {
      const where = `${layer.label} 第 ${String(position + 1)} 条`
      const insert = patch.insert
      if (insert !== undefined) {
        const added = structuredClone(insert)
        if (patch.id === undefined) {
          data.push(...added)
        } else {
          const target = index.get(patch.id)
          if (target === undefined) {
            warnings.push(`${where}：要插入的 group「${patch.id}」不存在，已跳过`)
            continue
          }
          if (target.group !== true) {
            warnings.push(`${where}：目标「${patch.id}」不是 group，插不进子行，已跳过`)
            continue
          }
          if (!Array.isArray(target.config)) target.config = []
          ;(target.config as PluginRow[]).push(...added)
        }
        buildIndex(added)
        continue
      }

      if (patch.id === undefined) {
        warnings.push(`${where}：不是 insert 就必须写 id（要改哪一行），已跳过`)
        continue
      }
      const target = index.get(patch.id)
      if (target === undefined) {
        // dsh 对「目标行不在」只告警不抛：一个覆盖层可能给多个界面共用，不该要求处处都有。
        warnings.push(`${where}：找不到 id 为「${patch.id}」的行，已跳过`)
        continue
      }
      if (typeof patch.name === 'string' && patch.name !== target.name) {
        warnings.push(
          `${where}：名字对不上（这行是「${String(target.name)}」，patch 写的是「${patch.name}」），已跳过`,
        )
        continue
      }
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === 'name' || key === 'insert') continue
        target[key] = value
      }
    }
  }

  return { rows: data, warnings }
}
