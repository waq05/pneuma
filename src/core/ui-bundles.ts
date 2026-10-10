/**
 * 界面插件包的发现与取字节（宿主半边）。
 *
 * 谁产出这些文件：界面壳的构建（`ui-shell/`）把插件 bundle 写进
 * `lib/ui/plugins/<id>/client.js`，并同时写一份 `manifest.json` 说明有哪些、
 * 依赖谁。宿主只认这份清单——**产物版本由宿主自己 stat 算**，不信构建时写下的值，
 * 这样插件文件被换掉（重新构建、手工替换）时地址跟着变，浏览器缓存不会骗人。
 *
 * 外部插件（第三方的界面半边）走同一份清单：将来它们由插件安装流程写进同一个目录，
 * 这里不用分内置还是第三方，只认文件在不在。
 *
 * @module dsc/core/ui-bundles
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactRev, type UiPluginRow } from '../ui/manifest.js'
import { inside } from './web-static.js'

/** 清单文件名（界面壳构建时写在插件目录根部）。 */
export const UI_PLUGIN_MANIFEST = 'manifest.json'

/** id 的合法形状：字母数字起步，其余允许 `.` `_` `-`。挡住 `..` 与路径分隔符。 */
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

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
  /** 声明了但文件不在（或文件不合法）的，逐条说清楚——不静默跳过。 */
  problems: string[]
}

/**
 * 读插件清单。文件缺失/损坏一律按空处理（界面壳还没构建就是这样，
 * 与 remote 的「资产未构建」占位页同一套待遇：能起来，但没有插件）。
 */
export function readUiPluginManifest(dir: string = uiPluginsDir()): UiPluginManifestEntry[] {
  const file = resolve(dir, UI_PLUGIN_MANIFEST)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  const plugins = (doc as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return []
  const out: UiPluginManifestEntry[] = []
  for (const raw of plugins) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'] : ''
    const file_ = typeof record['file'] === 'string' ? record['file'] : ''
    if (!PLUGIN_ID.test(id) || file_ === '' || file_.includes('/') || file_.includes('\\')) continue
    const inject = Array.isArray(record['inject'])
      ? record['inject'].filter((name): name is string => typeof name === 'string')
      : undefined
    const external = Array.isArray(record['external'])
      ? record['external'].filter((name): name is string => typeof name === 'string')
      : undefined
    out.push({
      id,
      file: file_,
      ...(inject === undefined ? {} : { inject }),
      ...(external === undefined ? {} : { external }),
      ...(record['immediately'] === true ? { immediately: true } : {}),
      ...(record['platform'] === 'tui' ? { platform: 'tui' as const } : {}),
    })
  }
  return out
}

/**
 * 清单 + 文件现状 = 可下发的条目。缺文件的不进清单，但要单独报出来。
 * @param dir - 插件目录，缺省 `lib/ui/plugins`
 * @param platform - 只取这个载体的插件（浏览器壳要 web，TUI 壳要 tui）
 */
export function collectUiPluginArtifacts(
  dir: string = uiPluginsDir(),
  platform: 'web' | 'tui' = 'web',
): UiPluginArtifacts {
  const entries: (UiPluginManifestEntry & { rev: string })[] = []
  const problems: string[] = []
  for (const entry of readUiPluginManifest(dir)) {
    if ((entry.platform ?? 'web') !== platform) continue
    const path = resolve(dir, entry.id, entry.file)
    if (!inside(dir, path)) {
      problems.push(`${entry.id}: 文件跑到目录外了（${entry.file}）`)
      continue
    }
    try {
      const stat = statSync(path)
      if (!stat.isFile()) {
        problems.push(`${entry.id}: ${entry.file} 不是文件`)
        continue
      }
      entries.push({ ...entry, rev: artifactRev(stat) })
    } catch {
      problems.push(`${entry.id}: 找不到 ${entry.file}（界面壳构建过了吗）`)
    }
  }
  return { entries, problems }
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
