/**
 * 插件组合包（bundle）与 profile：dsh 的安装形态。
 *
 * dsh 一个「包」不是一个文件，而是一个目录：目录里的 `package.json` 用
 * `dsh.bundle.patch` 指向自己的 patch 文件（告诉宿主「我要往哪些行改配置、插几行」），
 * 真正要装的插件代码在它自己的 `node_modules` 里。多个包按 profile 的
 * `dsh.profile.bundles` 顺序叠起来，后面的层盖前面的。
 *
 * 这一层只负责**读**：把目录读成「层」（{@link PatchLayer}）与告警。合成与挂载在
 * `core/plugin-loader` 里做（它才知道现在的行长什么样）。
 *
 * 版本闸：包的 `engines.dsh` 是一个 SemVer 范围，不写就退回 `@deepseek-ai/dsh*` 的
 * peer 范围。Pneuma 目标的是 dsh 0.2.x 的插件契约（{@link DSH_CONTRACT_VERSION}），
 * 所以比对的是**契约版本**而不是 Pneuma 自己的版本号（0.7.x 跟 dsh 不是一条线）。
 * 用户可以在 profile 目录的 `compatibility.json` 里登记豁免（`{ "exemptions": [{ "package": "名字" }] }`）。
 *
 * @module dsc/core/plugin-bundle
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import semver from 'semver'
import { readPatchFile, type PatchLayer } from './plugin-patch.js'

/**
 * Pneuma 对齐的 dsh 插件契约版本。
 *
 * 为什么是 0.2.x：dsh 的插件契约（ToolDefinition 的 output/output.schema、presentCall /
 * presentResult、bundle patch 语义）在 0.2 定型。装一个要求 `^0.3` 的包，它的契约我们
 * 没实现过，装进来只会在运行深处炸。
 */
export const DSH_CONTRACT_VERSION = '0.2.1'

/** 默认接受的 dsh 版本范围（含预发布：dsh 自己就是 rc 版在跑）。 */
export const DSH_CONTRACT_RANGE = '>=0.2.0-0 <0.3.0'

/** 一个组合包的读盘结果。 */
export interface BundleInfo {
  /** 包目录（绝对路径）。 */
  dir: string
  /** 包名（package.json 的 name）。 */
  name: string
  /** 包版本。 */
  version: string
  /** patch 层；包里没声明 patch 就是 null。 */
  patch: PatchLayer | null
}

/** 读包遇到的、不影响继续的问题（版本不满足、patch 文件缺失、含 !!js 被拒）。 */
export interface BundleProblem {
  /** 包目录。 */
  dir: string
  /** 包名（读不到 package.json 时用目录名）。 */
  name: string
  /** 人话原因。 */
  problem: string
}

/** package.json 里可能出现的那几个字段（宽松读，逐项校验）。 */
interface BundleManifest {
  name?: unknown
  version?: unknown
  engines?: { dsh?: unknown; [key: string]: unknown }
  peerDependencies?: Record<string, unknown>
  dsh?: { bundle?: { patch?: unknown } | unknown } | unknown
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

/**
 * 判一个包的 dsh 版本要求能不能满足。
 *
 * 读的顺序与 dsh 一致：`engines.dsh` → `peerDependencies` 里任一 `@deepseek-ai/dsh*`。
 * 两者都没有就当作不设限（dsh 自己允许）。
 * @param manifest - 包的 package.json
 * @returns 不满足时的中文原因；满足或没设限给 null
 */
export function enginesProblem(manifest: BundleManifest): string | null {
  const raw =
    typeof manifest.engines?.dsh === 'string'
      ? manifest.engines.dsh
      : Object.entries(manifest.peerDependencies ?? {})
          .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
          .map(([, range]) => range)
          .find((range): range is string => typeof range === 'string')
  if (raw === undefined) return null
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let ok = false
  try {
    ok = semver.satisfies(DSH_CONTRACT_VERSION, raw, { includePrerelease: true })
  } catch {
    return `版本范围写得不对（${raw}），没法判断能不能装`
  }
  if (ok) return null
  return (
    `这个包要求 dsh ${raw}，Pneuma 对齐的插件契约是 dsh ${DSH_CONTRACT_VERSION}（${DSH_CONTRACT_RANGE}）` +
    '。装进来它用到的新契约 Pneuma 没有，会在运行深处出错，所以先不装。' +
    '如果你确认能用，在 profile 目录的 compatibility.json 里登记豁免。'
  )
}

/**
 * 读一个组合包目录。
 * @param dir - 包目录
 * @returns 读到的信息；目录里没有 package.json 给 null
 */
export function readBundle(dir: string): BundleInfo | null {
  const manifest = readJson(join(dir, 'package.json')) as BundleManifest | null
  if (manifest === null || typeof manifest !== 'object') return null
  const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : dir.split(/[\\/]/).pop() ?? dir
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  // dsh 的字段形状是 dsh.bundle.patch = '相对路径'
  const bundle = manifest.dsh as { bundle?: { patch?: unknown } } | undefined
  const patchPath = bundle?.bundle?.patch
  const patchFile = typeof patchPath === 'string' && patchPath !== '' ? resolve(dir, patchPath) : null
  let patch: PatchLayer | null = null
  if (patchFile !== null) {
    try {
      patch = readPatchFile(patchFile, `${name} v${version}`)
    } catch (error) {
      // 读失败要带着「哪个包」一起抛给调用方，由它折成一条告警。
      throw new Error(`${name} 的 patch 文件读不了：${error instanceof Error ? error.message : String(error)}`)
    }
    if (patch === null) {
      throw new Error(`${name} 声明了 dsh.bundle.patch = ${patchPath}，但文件不存在`)
    }
  }
  return { dir, name, version, patch }
}

/** profile 的读盘结果。 */
export interface ProfileInfo {
  /** profile 目录（绝对路径）。 */
  dir: string
  /** 要叠的包名（按顺序；缺省空数组 = 只用自己的 patch）。 */
  bundles: string[]
  /** profile 自己的 patch 层（目录里的 cordis.patch.yml）。 */
  patch: PatchLayer | null
  /** compatibility.json 里登记豁免的包名。 */
  exemptions: string[]
}

/**
 * 读一个 profile 目录。
 *
 * 约定的目录形状（与 dsh 一致）：
 * ```
 * ~/.dsc/profiles/<名字>/
 *   package.json        # { "dsh": { "profile": { "bundles": ["包名", ...] } } }
 *   cordis.patch.yml    # 这一层自己的 patch（可选）
 *   compatibility.json  # { "exemptions": [{ "package": "包名" }] }（可选）
 *   node_modules/       # pnpm 装的包
 * ```
 * @param dir - profile 目录
 * @returns 包顺序、自己的 patch 层与豁免名单
 */
export function readProfile(dir: string): ProfileInfo {
  const manifest = readJson(join(dir, 'package.json')) as
    | { dsh?: { profile?: { bundles?: unknown } } }
    | null
  const rawBundles = manifest?.dsh?.profile?.bundles
  const bundles = Array.isArray(rawBundles)
    ? rawBundles.filter((name): name is string => typeof name === 'string' && name !== '')
    : []
  const patch = readPatchFile(join(dir, 'cordis.patch.yml'), `profile ${dir.split(/[\\/]/).pop() ?? dir}`)
  const compat = readJson(join(dir, 'compatibility.json')) as { exemptions?: unknown } | null
  const exemptions = Array.isArray(compat?.exemptions)
    ? compat.exemptions
        .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as { package?: unknown }).package : undefined))
        .filter((name): name is string => typeof name === 'string' && name !== '')
    : []
  return { dir, bundles, patch, exemptions }
}

/** 某个包在 profile 里的安装目录（pnpm 的 node_modules 布局）。 */
export function bundleDirOf(profileDir: string, name: string): string {
  return join(profileDir, 'node_modules', ...name.split('/'))
}
