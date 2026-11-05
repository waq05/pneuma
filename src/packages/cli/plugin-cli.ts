/**
 * `numa plugin` 子命令：把 dsh 生态的组合包装进来、卸掉、列一列。
 *
 *   numa plugin add <包名|tarball|本地路径> [--profile 名字]
 *   numa plugin remove <包名> [--profile 名字]
 *   numa plugin list [--profile 名字]
 *   numa plugin version-exemptions [--profile 名字]
 *   numa plugin allow-version <包名@版本> --dsh-version <运行时版本> [--accept-risk]
 *   numa plugin revoke-version <包名@版本> --dsh-version <运行时版本>

 * 为什么要有它：dsh 的安装单位是「bundle + profile + pnpm」，一个包不是一个文件。
 * 用户在 dsh 那边装包就是 `dsh plugin add`，这里给同一条入口，只是后面转的是 pnpm
 * 与一份 `~/.dsc/profiles/<名字>/`（形状见 core/plugin-bundle.ts）。
 *
 * 三条纪律：
 *   1. 先说清 profile 落在哪、要跑什么命令，再跑——安装会动用户机器上的文件；
 *   2. 失败场景给人话（没装 pnpm / 装不上 / 包里没有 dsh.bundle.patch）；
 *   3. 装完不用重启：宿主开着就把 `dsc/ui-plugins-changed` 那一类路径走完——热更轮询盯 profile 清单，
 *      变了就重算组合包（挂新行、卸删掉的包的行）。没开宿主时下次启动照常装配。
 *
 * 版本豁免的三个子命令读写 profile 目录里的 `compatibility.json`：版本闸（包的 engines
 * 对不上当前运行时）不满足的包，这是唯一的入口。授权必须带 `--accept-risk`，不带就拒绝
 * 写盘并打印风险原文——不兼容插件可能崩溃或丢数据，这条授权只对这一个版本组合有效。
 *
 * @module dsc/tools/plugin-cli
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { activeProfileDir } from '@pneuma/runtime/core/plugin-loader.js'
import {
  DSH_CONTRACT_VERSION,
  bundleDirOf,
  enginesProblem,
  exemptionAllows,
  pneumaEnginesProblem,
  readBundle,
  readProfile,
} from '@pneuma/runtime/core/plugin-bundle.js'
import { dscPath } from '@pneuma/runtime/core/path-policy.js'
import { activeConfigFile } from '@pneuma/runtime/core/config-store.js'
import { pluginDisplayOf, languageOfConfigFile } from '@pneuma/runtime/core/plugin-locale.js'

interface ProfileManifest {
  name?: string
  private?: boolean
  dsh?: { profile?: { bundles?: string[] } }
  dependencies?: Record<string, string>
  [key: string]: unknown
}

/** 取 profile 目录：--profile > 环境变量 DSC_PROFILE > config.yaml 的 profile > default。 */
function resolveProfileDir(args: readonly string[]): string {
  const at = args.indexOf('--profile')
  const fromArg = at >= 0 ? args[at + 1] : undefined
  if (typeof fromArg === 'string' && fromArg.trim() !== '') return dscPath('profiles', fromArg.trim())
  const fromEnv = activeProfileDir()
  if (fromEnv !== null) return fromEnv
  return dscPath('profiles', 'default')
}

function readManifest(dir: string): ProfileManifest {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as ProfileManifest
  } catch {
    return { name: 'pneuma-profile', private: true, dsh: { profile: { bundles: [] } } }
  }
}

function writeManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

/** 跑一条 pnpm 命令；返回退出码（输出直通给用户）。 */
function pnpm(args: string[], cwd: string): number {
  const result = spawnSync('pnpm', args, { cwd, stdio: 'inherit', shell: true })
  if (result.error !== undefined && result.error !== null) {
    console.error('没能启动 pnpm。请先装 pnpm（npm i -g pnpm），或者手动在这个目录里跑同样的命令：')
    console.error('  cd ' + cwd + ' && pnpm ' + args.join(' '))
    return 1
  }
  if (result.status === null) {
    console.error('pnpm 没有正常结束（可能被中断）。')
    return 1
  }
  return result.status
}

function ensureProfile(dir: string): ProfileManifest {
  mkdirSync(dir, { recursive: true })
  const manifest = readManifest(dir)
  manifest.name ??= 'pneuma-profile'
  manifest.private = true
  manifest.dsh = { profile: { bundles: manifest.dsh?.profile?.bundles ?? [] } }
  if (!existsSync(join(dir, 'package.json'))) writeManifest(dir, manifest)
  return manifest
}

// ── 版本豁免（profile 里的 compatibility.json）───────────────────────────────────
//
// 版本闸在 core/plugin-bundle.ts 读这份文件，形状是 `{ exemptions: [...] }`，**只认每项的
// package**（包名）。这里写进去的 version / dshVersion 不参与放行判定，是给人和撤销用的账本：
// 一条授权只对「这个包的这个版本 × 这一个运行时」有意义，撤销时按这个组合精确删。

/** compatibility.json 里一条豁免记录。 */
interface CompatibilityRecord {
  /** 包名（版本闸按它匹配，唯一参与判定的字段）。 */
  package: string
  /** 登记时那个包的精确版本；手改的老记录可能没有。 */
  version?: string
  /** 登记时跑着的 dsh 插件契约版本；手改的老记录可能没有。 */
  dshVersion?: string
}

/** 读 compatibility.json 的结果。 */
interface CompatibilityFile {
  records: CompatibilityRecord[]
  /** 文件存在但解析不了：这时绝不写盘，免得把用户的授权盖掉。 */
  broken: boolean
  /** 文件在不在（区分「没登记过」和「文件没了」）。 */
  exists: boolean
}

/**
 * 读 profile 的豁免账本。
 * @param dir - profile 目录
 * @returns 记录（形状不对的条目丢掉）、是否读不懂、文件在不在
 */
function readCompatibility(dir: string): CompatibilityFile {
  const file = join(dir, 'compatibility.json')
  if (!existsSync(file)) return { records: [], broken: false, exists: false }
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return { records: [], broken: true, exists: true }
  }
  const list = (doc as { exemptions?: unknown } | null)?.exemptions
  if (!Array.isArray(list)) return { records: [], broken: false, exists: true }
  const records: CompatibilityRecord[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const name = raw['package']
    if (typeof name !== 'string' || name === '') continue
    const version = raw['version']
    const dshVersion = raw['dshVersion']
    records.push({
      package: name,
      ...(typeof version === 'string' && version !== '' ? { version } : {}),
      ...(typeof dshVersion === 'string' && dshVersion !== '' ? { dshVersion } : {}),
    })
  }
  return { records, broken: false, exists: true }
}

/**
 * 写回 compatibility.json：保留文件里我们不认识的顶层键，只换 `exemptions`。
 *
 * 为什么不做整份覆盖：这份文件可能还有别人（dsh 或用户手改）写的内容，丢掉一行就是丢掉
 * 一次授权。调用方必须先用 {@link readCompatibility} 排除 broken。
 */
function writeCompatibility(dir: string, records: readonly CompatibilityRecord[]): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'compatibility.json')
  let doc: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>
  } catch {
    doc = {}
  }
  writeFileSync(file, JSON.stringify({ ...doc, exemptions: records }, null, 2) + '\n', 'utf8')
}

/** 精确版本（不含区间/通配符）：豁免记的是「哪一个版本被放行」，写区间没有意义。 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** npm 包名（含 scope）。 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** 把 `包名@版本` 拆开；不是精确版本给 null（别把 `foo@^1` 记成一次授权）。 */
function parseVersionSpec(spec: string | undefined): { name: string; version: string } | null {
  if (spec === undefined) return null
  const at = spec.lastIndexOf('@')
  if (at <= 0) return null
  const name = spec.slice(0, at)
  const version = spec.slice(at + 1)
  if (!PACKAGE_NAME.test(name) || !EXACT_VERSION.test(version)) return null
  return { name, version }
}

/** 带值的长选项：位置参数要跳过它们的值（`--dsh-version 0.2.1` 里的版本号不是包名）。 */
const VALUE_FLAGS = ['--profile', '--dsh-version']

/** 位置参数（去掉选项名与它们的值）。 */
function positionalsOf(args: readonly string[]): string[] {
  return args.filter((arg, index) => !arg.startsWith('--') && !VALUE_FLAGS.includes(args[index - 1] ?? ''))
}

/** 取一个带值选项的值；没写或空给 null。 */
function flagValue(args: readonly string[], flag: string): string | null {
  const at = args.indexOf(flag)
  if (at < 0) return null
  const value = args[at + 1]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 从 pnpm add 之后认出这个包叫什么。
 *
 * npm 包名直接可用；`file:` 前缀与本地路径/tarball 要去读被装那个包自己的 package.json。
 * 认不出给 null（调用方只提示，不写清单——宁可少一行，也不要写一个假包名）。
 */
function resolveInstalledName(target: string): string | null {
  const local = target.startsWith('file:') ? target.slice('file:'.length) : target
  if (!target.startsWith('.') && !target.startsWith('/') && !target.startsWith('file:') && !target.endsWith('.tgz')) {
    return target
  }
  try {
    const pkg = JSON.parse(readFileSync(join(local, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : null
  } catch {
    return null
  }
}

function runAdd(target: string | undefined, args: readonly string[]): number {
  if (target === undefined) {
    console.error('用法：numa plugin add <包名|tarball|本地路径> [--profile 名字]')
    // 版本闸不过的包 add 能装上、启动时会被跳过；唯一的出路是登记豁免，这里把那条命令摆出来。
    console.error('  版本闸不过（包的 engines 对不上当前运行时）时，确认风险后登记豁免：')
    console.error('  numa plugin allow-version <包名@版本> --dsh-version ' + DSH_CONTRACT_VERSION + ' --accept-risk')
    return 1
  }
  const dir = resolveProfileDir(args)
  const manifest = ensureProfile(dir)
  console.log('profile  ' + dir)
  console.log('配置    ' + activeConfigFile() + '（profile 生效要看这里或 DSC_PROFILE）')
  console.log('要跑    pnpm add ' + target)
  const code = pnpm(['add', target], dir)
  if (code !== 0) {
    console.error('安装失败。常见原因：包名写错、网络不通、pnpm 仓库权限、包要求更老的 Node。')
    return code
  }
  const installed = resolveInstalledName(target)
  if (installed === null) {
    console.error('装完了，但认不出这个包叫什么（tarball 的 package.json 读不到），先不同步到 profile 清单。')
    return 1
  }
  // pnpm add 已经改过 package.json（dependencies 那一行由它写），所以**重读**再合并，
  // 别拿装之前那份覆盖回去。
  const after = readManifest(dir)
  const bundles = new Set(after.dsh?.profile?.bundles ?? manifest.dsh?.profile?.bundles ?? [])
  bundles.add(installed)
  after.dsh = { profile: { bundles: [...bundles] } }
  writeManifest(dir, after)

  const info = readBundle(bundleDirOf(dir, installed))
  // patch 可以声明多份文件（dsh 的字符串数组写法），条数要按全部层累计。
  const patchCount = info === null ? 0 : info.patch.reduce((sum, layer) => sum + layer.patches.length, 0)
  if (info === null || patchCount === 0) {
    console.log(installed + ' 装上了，但它没有声明 dsh.bundle.patch（不是组合包，不会往插件树插行）。')
  } else {
    console.log(installed + ' v' + info.version + ' 装上了，patch 层 ' + String(patchCount) + ' 条。')
  }
  // 0.9 起宿主开着就能挂上（core/plugin-watch 盯 profile 清单），别再让人白重启一次。
  console.log('宿主开着的话下一轮轮询就挂上（约 1 秒）；没开则下次启动装配。')
  return 0
}

function runRemove(name: string | undefined, args: readonly string[]): number {
  if (name === undefined) {
    console.error('用法：numa plugin remove <包名> [--profile 名字]')
    return 1
  }
  const dir = resolveProfileDir(args)
  const manifest = ensureProfile(dir)
  manifest.dsh = { profile: { bundles: (manifest.dsh?.profile?.bundles ?? []).filter((item) => item !== name) } }
  if (manifest.dependencies !== undefined) delete manifest.dependencies[name]
  writeManifest(dir, manifest)
  const code = pnpm(['remove', name], dir)
  if (code !== 0) {
    console.error('卸载 pnpm 包时出错（profile 清单里已经去掉了这一行）。')
    return code
  }
  console.log('已卸载 ' + name + '。宿主开着的话下一轮轮询就卸掉；没开则下次启动生效。')
  return 0
}

/**
 * 应用自带的包（`<应用根>/lib/node_modules/@pneuma/**`）。
 *
 * 本文件编译后在 `lib/packages/cli/`，所以往上是三层才是应用根（`lib/packages/cli` →
 * `lib/packages` → `lib` → 根）。它原来住 `lib/tools/`，那时是两层——搬家时必须一起改，
 * 不改的表现就是去 `lib/lib/node_modules` 找一个不存在的 base，`numa plugin list` 列 0 行。
 */
const APP_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** 读 ~/.dsc/plugins.json 的条目树（CLI 不启内核，只能自己读一眼）。 */
function readEntries(): Map<string, boolean> {
  const out = new Map<string, boolean>()
  try {
    const doc = JSON.parse(readFileSync(dscPath('plugins.json'), 'utf8')) as { entries?: unknown }
    if (!Array.isArray(doc.entries)) return out
    for (const entry of doc.entries) {
      if (entry !== null && typeof entry === 'object') {
        const file = (entry as { file?: unknown }).file
        if (typeof file === 'string') out.set(file, (entry as { disabled?: unknown }).disabled === true)
      }
    }
  } catch {
    // 没有条目树就是全默认
  }
  return out
}

/** 一个包的清单里这一屏要用的几个字段。 */
interface RowPackage {
  version: string
  title: string
  /** `pneuma.resolution`：pinned 的包不接受 profile 覆盖。 */
  pinned: boolean
  /** `engines` 原文：这一行会不会被版本闸拦下，只有它知道。 */
  engines: unknown
}

/**
 * 读一个包目录的清单；目录不在给 null（显示成「缺件」）。
 * @param dir - 包目录
 * @param language - 显示语言：标题先查 `locale/<语言>.json`，没译过用清单原文
 */
function readRowPackage(dir: string, language: string): RowPackage | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    const pneuma = manifest['pneuma'] as { title?: unknown; resolution?: unknown } | undefined
    return {
      version: String(manifest['version'] ?? '?'),
      title: pluginDisplayOf(manifest, dir, language).title ?? '',
      pinned: pneuma?.resolution === 'pinned',
      engines: manifest['engines'],
    }
  } catch {
    return null
  }
}

/**
 * 列出应用自带的全部行：读 `@pneuma/base` 的 patch，再逐个包读 package.json。
 *
 * 为什么要读磁盘而不是写死清单：这一屏的意义就是「应用里到底装了什么、哪一行关了」，
 * 写死等于又造了一份会和构建产物漂移的表。
 * @param profileDir - 用户 profile 目录（看有没有覆盖版）
 * @param profileActive - 这个 profile 现在真的生效吗（没生效就不算覆盖）
 */
function listApplicationRows(profileDir: string, profileActive: boolean): void {
  const basePatch = join(APP_ROOT, 'lib', 'node_modules', '@pneuma', 'base', 'cordis.patch.yml')
  if (!existsSync(basePatch)) {
    console.log('应用自带的包清单没找到（' + basePatch + '）：先跑 pnpm build。')
    return
  }
  const entries = readEntries()
  // 语言只读一次：这一屏要读几十个包，逐包读配置没有意义。
  const language = languageOfConfigFile(activeConfigFile())
  let rows: unknown
  try {
    rows = YAML.parse(readFileSync(basePatch, 'utf8'))
  } catch (error) {
    console.log('应用自带的包清单读不了：' + (error instanceof Error ? error.message : String(error)))
    return
  }
  const insert = []
  for (const entry of Array.isArray(rows) ? rows : []) {
    if (entry !== null && typeof entry === 'object') insert.push(...(((entry as { insert?: unknown }).insert ?? []) as unknown[]))
  }
  console.log('应用自带  ' + APP_ROOT + '（' + String(insert.length) + ' 行）')
  let overridden = 0
  for (const row of insert) {
    if (row === null || typeof row !== 'object') continue
    const id = String((row as { id?: unknown }).id ?? '')
    const name = String((row as { name?: unknown }).name ?? '')
    const rowOff = (row as { disabled?: unknown }).disabled === true
    const parts = name.split('/')
    const app = readRowPackage(join(APP_ROOT, 'lib', 'node_modules', ...parts), language)
    // 覆盖版只在这个 profile 真的生效时才算数（内核走的是 activeProfileDir 那一条）。
    const profilePkg = profileActive
      ? readRowPackage(join(profileDir, 'node_modules', ...parts), language)
      : null
    // pinned 的包不接受覆盖：profile 里有同名副本也不生效，照旧显示应用那份。
    const useProfile = profilePkg !== null && app?.pinned !== true
    if (useProfile) overridden += 1
    const effective = useProfile ? profilePkg : app
    const version = effective === null || effective === undefined ? '缺件' : effective.version
    const title = effective === null || effective === undefined ? '' : effective.title
    const off = entries.has(id) ? entries.get(id) === true : rowOff
    // 版本闸不过比「用的是哪份」更该先说：这一行启动时会被跳过，不管它来自哪。
    const gate = effective === null || effective === undefined ? null : pneumaEnginesProblem({ engines: effective.engines })
    // 来源放在行尾：中文列宽按显示宽度算才有对齐可言，这里不值得为它引入宽度计算。
    const note =
      gate !== null
        ? '  ← 版本闸不过，启动会跳过这一行：' + gate
        : profilePkg === null || profilePkg === undefined
          ? ''
          : useProfile
            ? '  ← profile 覆盖'
            : '  ← 应用（profile 里的同名副本因 pinned 不生效）'
    console.log('  ' + id.padEnd(20) + ' v' + version.padEnd(9) + (off ? '关 ' : '开 ') + title + note)
  }
  if (overridden > 0) console.log('  其中 ' + String(overridden) + ' 行用的是 profile 里的覆盖版')
}

/** 授权的风险原文：拒绝写盘时与写盘前各打一次，用户看到的必须是同一句话。 */
const RISK_TEXT = '不兼容插件可能崩溃或丢数据，这条授权只对这一个版本组合有效。'

/**
 * `numa plugin version-exemptions`：列出当前 profile 的豁免账本。
 *
 * 为什么把「当前运行时」一起打出来：账本记的是历史授权，换过运行时以后哪些还对得上，
 * 只有拿当前版本比一遍才知道。老记录只写了包名（手改的），单独标出来。
 */
function runVersionExemptions(args: readonly string[]): number {
  const dir = resolveProfileDir(args)
  console.log('profile  ' + dir)
  console.log('运行时  dsh 插件契约 ' + DSH_CONTRACT_VERSION)
  const file = readCompatibility(dir)
  if (file.broken) {
    console.error('compatibility.json 解析不了（' + join(dir, 'compatibility.json') + '）：读不懂就不猜内容，先修好这份文件。')
    return 1
  }
  if (!file.exists || file.records.length === 0) {
    console.log('没有登记豁免')
    return 0
  }
  for (const record of file.records) {
    const version = record.version ?? '(整包，未记录版本)'
    const dshVersion = record.dshVersion ?? '(未记录运行时)'
    const note =
      record.dshVersion === undefined
        ? '  ← 老记录：只按包名放行'
        : record.dshVersion === DSH_CONTRACT_VERSION
          ? '  ← 对当前运行时有效'
          : '  ← 不是当前运行时，这条授权现在不起作用'
    console.log('  ' + record.package + '@' + version + '  dsh ' + dshVersion + note)
  }
  return 0
}

/**
 * `numa plugin allow-version`：把「包 × 版本 × 运行时」这一条授权写进 profile。
 *
 * 不带 `--accept-risk` 一律拒绝写盘并打印风险原文：这是「用户知情」的唯一凭据，
 * 不能靠默认值代替。运行时版本必须是当前这一份，授权对未来版本无效。
 */
function runAllowVersion(spec: string | undefined, args: readonly string[]): number {
  const parsed = parseVersionSpec(spec)
  if (parsed === null) {
    console.error('用法：numa plugin allow-version <包名@版本> --dsh-version <运行时版本> [--accept-risk]')
    console.error('  版本写精确版本（如 1.2.3）；^1.2 / latest 这类区间不认，授权只对确定的版本有意义。')
    return 1
  }
  const dshVersion = flagValue(args, '--dsh-version')
  if (dshVersion === null) {
    console.error('缺 --dsh-version：写清这次授权对哪个运行时有效。当前运行时是 ' + DSH_CONTRACT_VERSION + '。')
    console.error(
      '  numa plugin allow-version ' + parsed.name + '@' + parsed.version + ' --dsh-version ' + DSH_CONTRACT_VERSION + ' --accept-risk',
    )
    return 1
  }
  if (dshVersion !== DSH_CONTRACT_VERSION) {
    console.error(
      '运行时对不上：这个应用跑的是 dsh 插件契约 ' + DSH_CONTRACT_VERSION + '，不是 ' + dshVersion + '。' +
        '授权只对正在跑的那个版本有意义，请用 --dsh-version ' + DSH_CONTRACT_VERSION + '。',
    )
    return 1
  }
  if (!args.includes('--accept-risk')) {
    console.error(RISK_TEXT)
    console.error('没给 --accept-risk 就不写盘。确认要授权，重跑并加上它：')
    console.error(
      '  numa plugin allow-version ' + parsed.name + '@' + parsed.version + ' --dsh-version ' + dshVersion + ' --accept-risk',
    )
    return 1
  }
  const dir = resolveProfileDir(args)
  const file = readCompatibility(dir)
  if (file.broken) {
    console.error('compatibility.json 解析不了（' + join(dir, 'compatibility.json') + '）：这次不写盘，先修好它。')
    return 1
  }
  console.log('profile  ' + dir)
  console.log('风险    ' + RISK_TEXT)
  const already = file.records.some(
    (record) => record.package === parsed.name && record.version === parsed.version && record.dshVersion === dshVersion,
  )
  if (already) {
    console.log('这条授权已经在册：' + parsed.name + '@' + parsed.version + ' × dsh ' + dshVersion)
    return 0
  }
  writeCompatibility(dir, [...file.records, { package: parsed.name, version: parsed.version, dshVersion }])
  console.log('已登记豁免：' + parsed.name + '@' + parsed.version + ' × dsh ' + dshVersion)
  console.log('说明   这条授权只放行 ' + parsed.name + ' v' + parsed.version + ' × dsh ' + dshVersion + '；换任一版本都要重新授权。')
  console.log('撤销   numa plugin revoke-version ' + parsed.name + '@' + parsed.version + ' --dsh-version ' + dshVersion)
  console.log('生效   宿主开着的话下一轮轮询就重算；没开则下次启动生效。')
  return 0
}

/**
 * `numa plugin revoke-version`：删掉「包 × 版本 × 运行时」这一条授权。
 *
 * 老记录没记运行时（手改的），撤销这个包这个版本时一并删掉：它本来就没有版本组合可言，
 * 留着只会在账本里冒充一次精确授权。
 */
function runRevokeVersion(spec: string | undefined, args: readonly string[]): number {
  const parsed = parseVersionSpec(spec)
  if (parsed === null) {
    console.error('用法：numa plugin revoke-version <包名@版本> --dsh-version <运行时版本>')
    console.error('  版本写精确版本（如 1.2.3），与当初 allow-version 写的一致。')
    return 1
  }
  const dshVersion = flagValue(args, '--dsh-version')
  if (dshVersion === null) {
    console.error('缺 --dsh-version：撤销的是「这个版本 × 哪一个运行时」那一条，写清运行时。')
    console.error('  numa plugin revoke-version ' + parsed.name + '@' + parsed.version + ' --dsh-version ' + DSH_CONTRACT_VERSION)
    return 1
  }
  const dir = resolveProfileDir(args)
  const file = readCompatibility(dir)
  if (file.broken) {
    console.error('compatibility.json 解析不了（' + join(dir, 'compatibility.json') + '）：这次不写盘，先修好它。')
    return 1
  }
  console.log('profile  ' + dir)
  const kept = file.records.filter(
    (record) =>
      !(
        record.package === parsed.name &&
        record.version === parsed.version &&
        (record.dshVersion === dshVersion || record.dshVersion === undefined)
      ),
  )
  if (kept.length === file.records.length) {
    console.log('没有这条授权，什么都没改：' + parsed.name + '@' + parsed.version + ' × dsh ' + dshVersion)
    return 0
  }
  writeCompatibility(dir, kept)
  console.log('已撤销：' + parsed.name + '@' + parsed.version + ' × dsh ' + dshVersion)
  console.log('生效   宿主开着的话下一轮轮询就重算；没开则下次启动生效。')
  return 0
}

function runList(args: readonly string[]): number {
  const dir = resolveProfileDir(args)
  // 覆盖只在「这个 profile 是生效的那一个」时才成立：--profile 指别处时，内核仍用 activeProfileDir。
  const active = activeProfileDir()
  listApplicationRows(dir, active !== null && dir === active)
  console.log('')
  console.log('profile  ' + dir)
  console.log('对照的 dsh 契约版本  ' + DSH_CONTRACT_VERSION)
  if (!existsSync(join(dir, 'package.json'))) {
    console.log('（还没建这个 profile；首次启动会自动铺默认 profile）')
    return 0
  }
  const profile = readProfile(dir)
  if (profile.bundles.length === 0) {
    console.log('（没有额外组合包）')
    return 0
  }
  for (const name of profile.bundles) {
    const bundleDir = bundleDirOf(dir, name)
    if (!existsSync(bundleDir)) {
      console.log('  ' + name + '  （目录不在，先 pnpm install）')
      continue
    }
    let info
    try {
      info = readBundle(bundleDir)
    } catch (error) {
      console.log('  ' + name + '  （读不了：' + (error instanceof Error ? error.message : String(error)) + '）')
      continue
    }
    if (info === null) {
      console.log('  ' + name + '  （没有 package.json）')
      continue
    }
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    const problem = enginesProblem(manifest)
    // 豁免按 dsh 的口径判：包名 + 版本（老记录只写包名，按包名通配）。
    const exempt = exemptionAllows(profile.exemptions, info.name, info.version)
    const patchCount = info.patch.reduce((sum, layer) => sum + layer.patches.length, 0)
    const patchText = patchCount === 0 ? '无' : String(patchCount) + ' 条'
    console.log('  ' + info.name + ' v' + info.version + '  patch ' + patchText + '  ' + (problem === null || exempt ? '可用' : '版本不符，启动时会跳过'))
    if (problem !== null && exempt) console.log('    （已登记豁免：' + problem + '）')
    else if (problem !== null) console.log('    ' + problem)
  }
  const localPatch = join(dir, 'cordis.patch.yml')
  if (existsSync(localPatch)) console.log('  profile 自己的 patch：' + localPatch)
  return 0
}

const [, , sub, ...rest] = process.argv
const positional = positionalsOf(rest)
let code = 1
if (sub === 'add') code = runAdd(positional[0], rest)
else if (sub === 'remove') code = runRemove(positional[0], rest)
else if (sub === 'list') code = runList(rest)
else if (sub === 'version-exemptions') code = runVersionExemptions(rest)
else if (sub === 'allow-version') code = runAllowVersion(positional[0], rest)
else if (sub === 'revoke-version') code = runRevokeVersion(positional[0], rest)
else {
  console.error('用法：numa plugin <add|remove|list|version-exemptions|allow-version|revoke-version> ...')
  console.error('  add <包名|tarball|本地路径> [--profile 名字]')
  console.error('  remove <包名> [--profile 名字]')
  console.error('  list [--profile 名字]')
  console.error('  version-exemptions [--profile 名字]')
  console.error('  allow-version <包名@版本> --dsh-version <运行时版本> --accept-risk')
  console.error('  revoke-version <包名@版本> --dsh-version <运行时版本>')
  console.error('  （版本豁免写进 profile 的 compatibility.json；不被 --accept-risk 授权就不写盘）')
}
process.exit(code)
