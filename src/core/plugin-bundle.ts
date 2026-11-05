/**
 * 插件组合包（bundle）与 profile：dsh 的安装形态。
 *
 * dsh 一个「包」不是一个文件，而是一个目录：目录里的 `package.json` 用
 * `dsh.bundle.patch` 指向自己的 patch 文件（可以是一个，也可以是一组，按顺序叠），
 * 告诉宿主「我要往哪些行改配置、插几行」；真正要装的插件代码在它自己的
 * `node_modules` 里。多个包按 profile 的 `dsh.profile.bundles` 顺序叠起来，
 * 后面的层盖前面的。
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

/**
 * Pneuma 自己的插件契约版本（与产品版本号分开走）。
 *
 * 功能包在 `engines.pneuma` 里声明它要哪一代契约；装一个要求 `>=2` 的包，
 * 我们没实现过那一代，先在版本闸这里拦下，别等运行深处炸。
 */
export const RUNTIME_CONTRACT_VERSION = '1.0.0'

/** 默认接受的 Pneuma 运行时范围。 */
export const RUNTIME_CONTRACT_RANGE = '>=1.0.0 <2.0.0'

/** 一个组合包的读盘结果。 */
export interface BundleInfo {
  /** 包目录（绝对路径）。 */
  dir: string
  /** 包名（package.json 的 name）。 */
  name: string
  /** 包版本。 */
  version: string
  /**
   * patch 层，按声明顺序（空数组 = 没声明）。
   *
   * 为什么是数组：dsh 的 `dsh.bundle.patch` 允许写字符串数组，一个包一次列好几份
   * patch 文件（dsh 自己的 web-app 就是这么写的）。多层按数组顺序叠，后面的层看得见
   * 前面层 insert 的行，也盖前面的配置——与 dsh 同一个口径。
   */
  patch: readonly PatchLayer[]
  /** 读包时发现、但不影响继续的问题（数组里有非字符串项之类）。 */
  warnings: readonly string[]
  /**
   * 包里 `pneuma.client` 的原文（界面能力声明）。只读进来列给用户看，不加载——
   * dsh 的界面插件要 dsh 自己的客户端运行时，Pneuma 的界面壳是另一套契约。
   */
  client?: unknown
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
 * 只判 `engines.pneuma` 这一项：包要求哪一代 Pneuma 运行时契约。
 *
 * 单拎出来的原因：组合包的版本闸在「读包」时判一次（{@link enginesProblem}），但行级的
 * 包可能被 profile 里的副本换掉（`pneuma.resolution: overridable`），换上来那一份的要
 * 求跟组合包自己写的不一定一样。加载器挂每一行时用它再判一次（契约 §7）。
 * @param manifest - 包的 package.json
 * @returns 不满足时的中文原因；满足或没写 `engines.pneuma` 给 null
 */
export function pneumaEnginesProblem(manifest: { engines?: unknown } | null): string | null {
  const engines = manifest?.engines
  if (engines === null || engines === undefined || typeof engines !== 'object') return null
  const range = (engines as Record<string, unknown>)['pneuma']
  if (typeof range !== 'string' || range.trim() === '') return null
  try {
    if (semver.satisfies(RUNTIME_CONTRACT_VERSION, range)) return null
  } catch {
    return `版本范围写得不对（engines.pneuma = ${range}），没法判断能不能装`
  }
  return `这个包要求 Pneuma 运行时 ${range}，当前契约是 ${RUNTIME_CONTRACT_VERSION}（${RUNTIME_CONTRACT_RANGE}）`
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
  // Pneuma 原生包先看 engines.pneuma：它跟的是运行时契约，不是 dsh 契约。
  const pneumaRange = manifest.engines?.pneuma
  if (typeof pneumaRange === 'string' && pneumaRange.trim() !== '') return pneumaEnginesProblem(manifest)
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
 *
 * `bundle.patch` 两种写法都认：一个字符串（一份文件），或字符串数组（多份，按数组
 * 顺序叠）。数组里的空串与非字符串项跳过并记一条 warning，不让整份声明作废。
 * @param dir - 包目录
 * @returns 读到的信息；目录里没有 package.json 给 null
 */
export function readBundle(dir: string): BundleInfo | null {
  const manifest = readJson(join(dir, 'package.json')) as BundleManifest | null
  if (manifest === null || typeof manifest !== 'object') return null
  const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : dir.split(/[\\/]/).pop() ?? dir
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  // 两套字段都认：我们自己那族写 pneuma.bundle.patch / pneuma.client，真实 dsh 生态
  // 写 dsh.bundle.patch / pneuma.client（别人发布的包改不了）。先 pneuma、再 dsh。
  const sectionOf = (key: string): { bundle?: { patch?: unknown }; client?: unknown } | undefined => {
    const value = (manifest as Record<string, unknown>)[key]
    return value !== null && typeof value === 'object'
      ? (value as { bundle?: { patch?: unknown }; client?: unknown })
      : undefined
  }
  const own = sectionOf('pneuma')
  const foreign = sectionOf('dsh')
  const bundle = own?.client === undefined && own?.bundle === undefined ? foreign : own
  const declared = own?.bundle?.patch ?? foreign?.bundle?.patch
  /** 声明写在哪一族字段里（告警要说清是 pneuma 还是 dsh 的那一项）。 */
  const patchField = own?.bundle?.patch !== undefined ? 'pneuma' : 'dsh'
  /** 声明的 patch 文件（写字符串就是一份；写数组就按顺序全收）。 */
  const patchFiles: string[] = []
  const warnings: string[] = []
  if (typeof declared === 'string') {
    if (declared !== '') patchFiles.push(declared)
  } else if (Array.isArray(declared)) {
    declared.forEach((item, index) => {
      if (typeof item === 'string' && item !== '') {
        patchFiles.push(item)
        return
      }
      // 不是文件路径的项不猜：记一条告警跳过，别让整份声明作废。
      warnings.push(
        `${name} 的 ${patchField}.bundle.patch 第 ${String(index + 1)} 项不是文件路径（${typeof item}），已跳过`,
      )
    })
  }
  const patch: PatchLayer[] = []
  for (const relativePath of patchFiles) {
    const file = resolve(dir, relativePath)
    if (!existsSync(file)) {
      throw new Error(`${name} 声明了 pneuma.bundle.patch = ${relativePath}，但文件不存在`)
    }
    // 只有一份文件时标签保持原样（老告警文案不变）；多份时带上文件名，
    // 否则「第 N 条」这种诊断说不清是哪一份 patch 里的。
    const label = patchFiles.length > 1 ? `${name} v${version} 的 ${relativePath}` : `${name} v${version}`
    try {
      const layer = readPatchFile(file, label)
      if (layer !== null) patch.push(layer)
    } catch (error) {
      // 读失败要带着「哪个包」一起抛给调用方，由它折成一条告警。
      throw new Error(`${name} 的 patch 文件读不了：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { dir, name, version, patch, warnings, client: own?.client ?? foreign?.client }
}

/**
 * 一条版本闸豁免（profile 的 `compatibility.json`）。
 *
 * 为什么带版本：dsh 的授权是「精确包@版本 ↔ 精确运行时版本」，换一个版本就得重新同意。
 * 只按包名放行等于一次点头永久生效——用户装 1.2 时同意的风险，1.3 装上来就不用再问了。
 *
 * 两个版本字段都可缺省：老写法的 `{ "package": "名字" }` 仍然放行（按包名通配），
 * 这是给 0.8.x 写下的文件留的路；新写入的记录由 `numa plugin allow-version` 带上两个版本。
 */
export interface Exemption {
  /** 包名（与 `bundleDirOf` 的包名同形，含 scope）。 */
  package: string
  /** 精确的包版本；缺省 = 不按版本判（老写法）。 */
  version?: string
  /** 精确的运行时（dsh 插件契约）版本；缺省 = 不按运行时判。 */
  dshVersion?: string
}

/**
 * 读一条 compatibility.json 的豁免项。
 * @param entry - 原始项（字符串或对象）
 * @returns 规范化后的豁免；认不出给 null
 */
function exemptionOf(entry: unknown): Exemption | null {
  if (typeof entry === 'string') return entry === '' ? null : { package: entry }
  if (entry === null || typeof entry !== 'object') return null
  const record = entry as { package?: unknown; name?: unknown; version?: unknown; dshVersion?: unknown }
  const name = typeof record.package === 'string' ? record.package : record.name
  if (typeof name !== 'string' || name === '') return null
  return {
    package: name,
    ...(typeof record.version === 'string' && record.version !== '' ? { version: record.version } : {}),
    ...(typeof record.dshVersion === 'string' && record.dshVersion !== '' ? { dshVersion: record.dshVersion } : {}),
  }
}

/**
 * 豁免名单放不放行这一个「包@版本」。
 *
 * 版本缺省 = 按包名通配（0.8.x 写下的老记录）；运行时版本缺省 = 不按运行时判。
 * 新记录由 `numa plugin allow-version` 写入，两个版本都带上，换版本必须重新同意；
 * 记录带了版本而这一行的版本读不到时，按「对不上」处理（失败关闭）。
 * @param exemptions - 豁免名单
 * @param name - 包名
 * @param version - 这一行的包版本
 */
export function exemptionAllows(
  exemptions: readonly Exemption[],
  name: string,
  version: string | undefined,
): boolean {
  return exemptions.some((entry) => {
    if (entry.package !== name) return false
    // 版本读不到也不放行：拿不准就等于对不上（失败关闭）。
    if (entry.version !== undefined && entry.version !== version) return false
    if (entry.dshVersion !== undefined && entry.dshVersion !== DSH_CONTRACT_VERSION) return false
    return true
  })
}

/** profile 的读盘结果。 */
export interface ProfileInfo {
  /** profile 目录（绝对路径）。 */
  dir: string
  /** 要叠的包名（按顺序；缺省空数组 = 只用自己的 patch）。 */
  bundles: string[]
  /** profile 自己的 patch 层（目录里的 cordis.patch.yml）。 */
  patch: PatchLayer | null
  /** compatibility.json 里登记的豁免（精确到版本的那几条才算数，见 {@link Exemption}）。 */
  exemptions: Exemption[]
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
    ? compat.exemptions.map(exemptionOf).filter((entry): entry is Exemption => entry !== null)
    : []
  return { dir, bundles, patch, exemptions }
}

/** 某个包在 profile 里的安装目录（pnpm 的 node_modules 布局）。 */
export function bundleDirOf(profileDir: string, name: string): string {
  return join(profileDir, 'node_modules', ...name.split('/'))
}
