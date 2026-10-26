/**
 * `numa plugin` 子命令：把 dsh 生态的组合包装进来、卸掉、列一列。
 *
 *   numa plugin add <包名|tarball|本地路径> [--profile 名字]
 *   numa plugin remove <包名> [--profile 名字]
 *   numa plugin list [--profile 名字]
 *
 * 为什么要有它：dsh 的安装单位是「bundle + profile + pnpm」，一个包不是一个文件。
 * 用户在 dsh 那边装包就是 `dsh plugin add`，这里给同一条入口，只是后面转的是 pnpm
 * 与一份 `~/.dsc/profiles/<名字>/`（形状见 core/plugin-bundle.ts）。
 *
 * 三条纪律：
 *   1. 先说清 profile 落在哪、要跑什么命令，再跑——安装会动用户机器上的文件；
 *   2. 失败场景给人话（没装 pnpm / 装不上 / 包里没有 dsh.bundle.patch）；
 *   3. 装完提示重启宿主（组合包在启动装配时加载）。
 *
 * @module dsc/tools/plugin-cli
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeProfileDir } from '../core/plugin-loader.js'
import { DSH_CONTRACT_VERSION, bundleDirOf, enginesProblem, readBundle, readProfile } from '../core/plugin-bundle.js'
import { dscPath } from '../core/path-policy.js'
import { activeConfigFile } from '../core/config-store.js'

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
  if (info === null || info.patch === null) {
    console.log(installed + ' 装上了，但它没有声明 dsh.bundle.patch（不是组合包，不会往插件树插行）。')
  } else {
    console.log(installed + ' v' + info.version + ' 装上了，patch 层 ' + String(info.patch.patches.length) + ' 条。')
  }
  console.log('重启宿主后生效（组合包在启动装配时加载）。')
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
  console.log('已卸载 ' + name + '。重启宿主后生效。')
  return 0
}

function runList(args: readonly string[]): number {
  const dir = resolveProfileDir(args)
  if (!existsSync(join(dir, 'package.json'))) {
    console.log('没有这个 profile：' + dir)
    console.log('先 numa plugin add <包名> 会创建它。')
    return 0
  }
  const profile = readProfile(dir)
  console.log('profile  ' + dir)
  console.log('对照的 dsh 契约版本  ' + DSH_CONTRACT_VERSION)
  if (profile.bundles.length === 0) {
    console.log('这个 profile 里还没装组合包。')
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
    const exempt = profile.exemptions.includes(info.name)
    const patchText = info.patch === null ? '无' : String(info.patch.patches.length) + ' 条'
    console.log('  ' + info.name + ' v' + info.version + '  patch ' + patchText + '  ' + (problem === null || exempt ? '可用' : '版本不符，启动时会跳过'))
    if (problem !== null && exempt) console.log('    （已登记豁免：' + problem + '）')
    else if (problem !== null) console.log('    ' + problem)
  }
  const localPatch = join(dir, 'cordis.patch.yml')
  if (existsSync(localPatch)) console.log('  profile 自己的 patch：' + localPatch)
  return 0
}

const [, , sub, ...rest] = process.argv
const positional = rest.filter((arg, index) => !arg.startsWith('--') && rest[index - 1] !== '--profile')
let code = 1
if (sub === 'add') code = runAdd(positional[0], rest)
else if (sub === 'remove') code = runRemove(positional[0], rest)
else if (sub === 'list') code = runList(rest)
else {
  console.error('用法：numa plugin <add|remove|list> ...')
  console.error('  add <包名|tarball|本地路径> [--profile 名字]')
  console.error('  remove <包名> [--profile 名字]')
  console.error('  list [--profile 名字]')
}
process.exit(code)
