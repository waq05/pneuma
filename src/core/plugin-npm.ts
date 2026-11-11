/**
 * 按 npm 包形态安装 / 卸载插件组合包（宿主工具层与 CLI 共用同一套逻辑）。
 *
 * 为什么单独一个模块：dsh 的安装单位是「bundle + profile + pnpm」，不是一个 .js 文件。
 * 模型通过 `plugin_manager` 工具装包时，必须和 `numa plugin add` 走同一条路：在 profile
 * 目录里跑 `pnpm add`，再把包名并进 `dsh.profile.bundles`。如果工具层自己抄一份，两条路
 * 迟早在「失败怎么回滚」「清单怎么写」上分叉。
 *
 * 三条纪律：
 *   1. **先校验、后动盘**：包名/路径里出现空白或 shell 元字符一律拒绝，连目录都不进；
 *   2. **先存、后改**：安装前把 `package.json` 与 `pnpm-lock.yaml` 的原文读进内存，pnpm
 *      非零退出就原样写回——装一半的清单比没装更糟，用户下次启动会装配出一个不存在的包；
 *   3. **不经过 shell**：`spawn` 用 `shell: false` + 绝对路径。spec 虽然已经过滤过，但
 *      「没有第二道解释器」才是真正的保证。
 *
 * Windows 的一个坑：Node 在 Windows 上不允许 `shell: false` 直接起 `.cmd`（实测 EINVAL，
 * 见 core/executable.ts 的注释）。所以这里先解析出 `pnpm.cmd`，再读它指向的
 * `node_modules/pnpm/bin/pnpm.cjs`，用 node 直接起脚本——仍然不经过 shell，PATH 里的
 * pnpm 安装方式（npm 全局 / corepack 生成的 shim）都覆盖到了。
 *
 * @module dsc/core/plugin-npm
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { activeProfileDir } from './profile-dir.js'
import { bundleDirOf, readBundle } from './plugin-bundle.js'
import { resolveExecutable } from './executable.js'

/** 一次 npm 包形态安装 / 卸载的结果。 */
export interface NpmInstallOutcome {
  ok: boolean
  /** 成功时给用户的一句话（已装 名字@版本，patch N 条）。 */
  detail: string
  name?: string
  version?: string
  /** 组合包声明了几条 patch；不是组合包为 0。 */
  patches?: number
  /** 失败时是否把 package.json / lockfile 还原回去了。 */
  restored?: boolean
}

/** 安装 / 卸载的可选项。 */
export interface NpmBundleOptions {
  /** profile 目录；缺省用 `activeProfileDir()`。 */
  profileDir?: string
  /**
   * pnpm 可执行文件的路径；缺省按 PATH 找。
   *
   * 为什么留这个口子：自检要断言「找不到 pnpm」那条分支，必须能指定一个不存在的路径；
   * 桌面端将来要改用自带 pnpm 时也能在这里换。
   */
  pnpmPath?: string
}

/**
 * 不许出现在 spec 里的字符。
 *
 * 保守起见把空白也拦掉：`pnpm add` 的 spec 本来就不该带空格，带上多半是用户把
 * 「包名 + 一个参数」写成了一串。`$` 在 POSIX shell 里会被展开，虽然这里不过 shell，
 * 但同一个 spec 用户可能复制到终端里跑，先拒绝掉更安全。
 */
const FORBIDDEN_IN_SPEC = /[\s;&|><`$]/

/** spec 长度上限：够写下任何正常包名/路径，同时挡住一整段粘贴进来的命令行。 */
const MAX_SPEC_LENGTH = 300

/** pnpm 的超时（毫秒）。网络卡住时不能让工具一直挂着。 */
const PNPM_TIMEOUT_MS = 120_000

/** pnpm 失败时带多少字符的 stderr 给用户。 */
const STDERR_TAIL = 500

/** JSON 对象（宽松读盘用）。 */
type JsonObject = Record<string, unknown>

/** 一次安装前的磁盘快照：文件不存在记 null，回滚时删掉它。 */
interface ManifestSnapshot {
  packageJson: string | null
  lockfile: string | null
}

/** 跑一条 pnpm 命令的结果。 */
interface PnpmResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** 起进程本身就失败时的错误码（ENOENT / EINVAL…）。 */
  spawnError?: string
  /** 没解析出可用的 pnpm 时的原因（还没起进程）。 */
  problem?: string
}

/** 交给 spawn 的目标：`file` + 固定前缀参数（node 起 pnpm.cjs 时前缀是脚本路径）。 */
interface SpawnTarget {
  file: string
  prefix: string[]
}

/**
 * 校验 spec：不合法返回中文原因，合法返回 null。
 *
 * 放在最前面是纪律，不是形式：spec 会原样进 `pnpm add` 的参数表，校验失败时连
 * profile 目录都不该碰（自检里断言 package.json 逐字节不变）。
 * @param spec - 包名、`file:` 路径、绝对路径、https tarball 或 `name@version`
 * @returns 不合法时的中文原因；合法给 null
 */
function specProblem(spec: unknown): string | null {
  if (typeof spec !== 'string') return '没给包名或路径'
  const text = spec.trim()
  if (text === '') return '包名或路径是空的'
  if (text.length > MAX_SPEC_LENGTH) {
    return `写得太长（${String(text.length)} 字符，上限 ${String(MAX_SPEC_LENGTH)}）`
  }
  if (FORBIDDEN_IN_SPEC.test(text)) {
    return '里面有空白或 shell 元字符（; & | > < ` $ 等），不交给 pnpm，也不动盘'
  }
  return null
}

/** 把未知值当 JSON 对象读。 */
function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

/** 读一份文件原文；不存在给 null。 */
function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 解析 profile 的 package.json；坏文件不 throw（回滚靠原文，不靠解析）。 */
function parseManifest(text: string | null): JsonObject {
  if (text === null) return {}
  try {
    return asObject(JSON.parse(text) as unknown) ?? {}
  } catch {
    return {}
  }
}

/** 读 `dsh.profile.bundles` 里的包名（只留非空字符串）。 */
function bundlesOf(manifest: JsonObject): string[] {
  const dsh = asObject(manifest['dsh'])
  const profile = asObject(dsh?.['profile'])
  const raw = profile?.['bundles']
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

/** 把包名并进（或移出）`dsh.profile.bundles`，保留文件里其它字段。 */
function withBundles(manifest: JsonObject, bundles: readonly string[]): JsonObject {
  const dsh = asObject(manifest['dsh']) ?? {}
  const profile = asObject(dsh['profile']) ?? {}
  return { ...manifest, dsh: { ...dsh, profile: { ...profile, bundles: [...bundles] } } }
}

/** 写回 profile 的 package.json（缩进与 CLI 一致，手改时好读）。 */
function writeManifest(dir: string, manifest: JsonObject): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

/** 安装前存一份原文。 */
function snapshotOf(dir: string): ManifestSnapshot {
  return {
    packageJson: readTextOrNull(join(dir, 'package.json')),
    lockfile: readTextOrNull(join(dir, 'pnpm-lock.yaml')),
  }
}

/**
 * 把快照原样写回。
 *
 * 快照里是 null 表示「安装前本来没有这个文件」：pnpm 失败时可能已经生成了一份空 lockfile，
 * 这时要删掉，而不是留一份用户没写过的文件。
 * @returns 是否全部写回成功
 */
function restoreSnapshot(dir: string, snapshot: ManifestSnapshot): boolean {
  try {
    if (snapshot.packageJson === null) rmSync(join(dir, 'package.json'), { force: true })
    else writeFileSync(join(dir, 'package.json'), snapshot.packageJson, 'utf8')
    if (snapshot.lockfile === null) rmSync(join(dir, 'pnpm-lock.yaml'), { force: true })
    else writeFileSync(join(dir, 'pnpm-lock.yaml'), snapshot.lockfile, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 取一段文本的末尾若干字符（stderr 常常前几百行是噪音，结论在最后）。 */
function tail(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : '…' + trimmed.slice(trimmed.length - max)
}

/** 把一个路径串里指向 pnpm 脚本的那一段抠出来（`pnpm.cmd` 的正文）。 */
function pnpmScriptOf(launcher: string): string | null {
  const dir = dirname(launcher)
  let body = ''
  try {
    body = readFileSync(launcher, 'utf8')
  } catch {
    // 读不到就退回约定位置（npm 全局安装的固定布局）
  }
  // `%dp0%` / `%~dp0` 是 .cmd 里的「本文件所在目录」。
  const expanded = body.replace(/%~dp0%?/gi, dir + '\\')
  const matched = /[^\s"'()=]*pnpm\.(?:cjs|mjs|js)\b/i.exec(expanded)
  if (matched !== null) {
    const candidate = resolve(dir, matched[0])
    if (existsSync(candidate)) return candidate
  }
  const conventional = join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  return existsSync(conventional) ? conventional : null
}

/** 用 node 起一个 .js 脚本（pnpm 的入口就是一个 CommonJS 脚本）。 */
function nodeTarget(script: string): SpawnTarget {
  const node = resolveExecutable('node', process.env, process.cwd())
  // 找到 PATH 里的 node 就用它；找不到时退回当前进程（Node 跑测试时就是 node 本身）。
  return { file: node.found && !node.shell ? node.file : process.execPath, prefix: [script] }
}

/**
 * 解析出「怎么起 pnpm」。
 *
 * 顺序：显式路径 > PATH。Windows 上 `.cmd` 不能 `shell: false` 直接起（Node 会 EINVAL），
 * 所以换成 `node <pnpm.cjs>`；`.exe` / POSIX 的可执行 shim 直接起。
 * @param override - 调用方指定的 pnpm 路径
 * @returns 起进程的目标；解析不出时带中文原因
 */
function pnpmTarget(override: string | undefined): { ok: true; target: SpawnTarget } | { ok: false; problem: string } {
  const requested = override !== undefined && override.trim() !== '' ? override.trim() : 'pnpm'
  const resolved = resolveExecutable(requested, process.env, process.cwd())
  if (!resolved.found) {
    return {
      ok: false,
      problem: `找不到 pnpm：桌面端请确认自带 pnpm/corepack（找过 ${requested}）`,
    }
  }
  const lower = resolved.file.toLowerCase()
  if (lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')) {
    return { ok: true, target: nodeTarget(resolved.file) }
  }
  if (!(process.platform === 'win32' && /\.(cmd|bat)$/.test(lower))) {
    // 原生可执行文件（Windows 的 pnpm.exe）或 POSIX 上带 shebang 的 shim 都能直接起。
    return { ok: true, target: { file: resolved.file, prefix: [] } }
  }
  const script = pnpmScriptOf(resolved.file)
  if (script === null) {
    return {
      ok: false,
      problem: `找到了 ${resolved.file}，但读不出它指向的 pnpm 脚本；请把 pnpm 装成 npm 全局包或改用 pnpm.exe`,
    }
  }
  return { ok: true, target: nodeTarget(script) }
}

/**
 * 把 spec 换成 pnpm 认得的写法。
 *
 * Windows 的绝对路径带反斜杠，`file:` 后面的反斜杠会被 pnpm 当成转义；统一成正斜杠。
 * 裸绝对路径也补成 `file:`——否则 pnpm 会把它当成一个不存在的包名去仓库里找。
 */
function pnpmSpec(spec: string): string {
  if (spec.startsWith('file:')) return 'file:' + spec.slice('file:'.length).replace(/\\/g, '/')
  if (isAbsolute(spec)) return 'file:' + spec.replace(/\\/g, '/')
  return spec
}

/** 起一条 pnpm 命令：不经过 shell、120 秒超时、输出全收进内存。 */
function runPnpm(args: string[], cwd: string, pnpmPath: string | undefined): Promise<PnpmResult> {
  return new Promise((done) => {
    const resolved = pnpmTarget(pnpmPath)
    if (!resolved.ok) {
      done({ code: null, signal: null, stdout: '', stderr: '', problem: resolved.problem })
      return
    }
    let child
    try {
      child = spawn(resolved.target.file, [...resolved.target.prefix, ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        timeout: PNPM_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      done({ code: null, signal: null, stdout: '', stderr: '', spawnError: code })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      done({ code: null, signal: null, stdout, stderr, spawnError: error.code ?? 'UNKNOWN' })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      done({ code, signal, stdout, stderr })
    })
  })
}

/** pnpm 起不来 / 超时时怎么说人话。 */
function runProblem(result: PnpmResult): string | null {
  if (result.problem !== undefined) return result.problem
  if (result.spawnError === 'ENOENT') return '找不到 pnpm：桌面端请确认自带 pnpm/corepack'
  if (result.spawnError !== undefined) return `没能启动 pnpm（${result.spawnError}）`
  if (result.code === null && result.signal !== null) return `pnpm 没有正常结束（收到 ${result.signal}，可能是超时或被杀）`
  return null
}

/** 从 spec 里抠出「包名」；本地路径 / tarball 不是包名，给 null。 */
function nameFromSpec(spec: string): string | null {
  if (spec.startsWith('file:') || isAbsolute(spec) || spec.startsWith('.') || /^https?:/i.test(spec)) return null
  const at = spec.lastIndexOf('@')
  // `@scope/name` 开头的 @ 是 scope，不是版本分隔符。
  const name = at > 0 ? spec.slice(0, at) : spec
  return name !== '' ? name : null
}

/**
 * 认出这次装进来的包叫什么。
 *
 * 顺序有讲究：
 *   1. `file:` / 绝对路径 → 直接读被装目录自己的 package.json（最可靠）；
 *   2. 对比安装前后 `dependencies` 的键（tarball、`name@range` 都适用）；
 *   3. 最后才从 spec 里猜（`name@range` 这种写法包名就在字符串里）。
 * @param spec - 原始 spec
 * @param before - 安装前的 package.json 原文
 * @param after - 安装后重读的 package.json
 */
function installedNameOf(spec: string, before: string | null, after: JsonObject): string | null {
  const local = spec.startsWith('file:') ? spec.slice('file:'.length) : isAbsolute(spec) ? spec : null
  if (local !== null) {
    const text = readTextOrNull(resolve(local, 'package.json'))
    let manifest: JsonObject | null = null
    try {
      manifest = asObject(JSON.parse(text ?? 'null') as unknown)
    } catch {
      // 本地包的清单坏了不致命：下面的依赖键对比还能认出名字。
    }
    const name = manifest?.['name']
    if (typeof name === 'string' && name !== '') return name
  }
  const beforeManifest = parseManifest(before)
  const oldDeps = asObject(beforeManifest['dependencies']) ?? {}
  const newDeps = asObject(after['dependencies']) ?? {}
  const added = Object.keys(newDeps).filter((key) => !(key in oldDeps))
  if (added.length > 0) return added[added.length - 1] ?? null
  return nameFromSpec(spec)
}

/** 包里声明的 patch 总条数（数组写法要按层累计）。 */
function patchCountOf(info: ReturnType<typeof readBundle>): number {
  if (info === null) return 0
  return info.patch.reduce((sum, layer) => sum + layer.patches.length, 0)
}

/**
 * 在 profile 里按 npm 包形态安装一个插件包。
 *
 * 成功 = pnpm add 返回 0 **且** 包名写进了 `dsh.profile.bundles`。失败 = 磁盘回到
 * 调用前的状态（`restored: true`），并带上 pnpm 的最后一段 stderr。
 * @param spec - 包名、`name@version`、`file:` 路径、绝对路径或 https tarball
 * @param options - profile 目录与 pnpm 路径
 * @returns 结果与给用户的一句话
 */
export async function installNpmBundle(
  spec: string,
  options: NpmBundleOptions = {},
): Promise<NpmInstallOutcome> {
  const invalid = specProblem(spec)
  if (invalid !== null) return { ok: false, detail: `拒绝安装：${invalid}。` }
  const trimmed = spec.trim()
  const dir = options.profileDir !== undefined && options.profileDir.trim() !== ''
    ? options.profileDir.trim()
    : activeProfileDir()
  if (dir === null) {
    return { ok: false, detail: '没有生效的 profile：先跑一次 numa，让默认 profile（~/.dsc/profiles/default）铺好再装。' }
  }
  mkdirSync(dir, { recursive: true })
  const snapshot = snapshotOf(dir)
  // pnpm 需要一个 package.json 才把目录当项目；没有就铺一份最小形态（失败时会随快照回滚）。
  if (snapshot.packageJson === null) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pneuma-profile', private: true }, null, 2) + '\n', 'utf8')
  }
  const result = await runPnpm(['add', pnpmSpec(trimmed)], dir, options.pnpmPath)
  const problem = runProblem(result)
  if (problem !== null || result.code !== 0) {
    const restored = restoreSnapshot(dir, snapshot)
    const reason = problem ?? `pnpm 退出码 ${String(result.code)}`
    const log = tail(result.stderr !== '' ? result.stderr : result.stdout, STDERR_TAIL)
    return {
      ok: false,
      detail:
        `安装失败：${reason}` +
        (log === '' ? '' : `。pnpm 输出：${log}`) +
        (restored ? '（已还原 package.json 与 pnpm-lock.yaml）' : '（还原失败，请检查 profile 目录）'),
      restored,
    }
  }
  // 关键：重读磁盘上那份 package.json。pnpm add 已经改过 dependencies，拿安装前那份往回写
  // 会把 pnpm 刚写进去的依赖删掉，装完等于白装。
  const afterText = readTextOrNull(join(dir, 'package.json'))
  const after = parseManifest(afterText)
  const name = installedNameOf(trimmed, snapshot.packageJson, after)
  if (name === null) {
    return {
      ok: false,
      detail: 'pnpm 返回成功，但认不出装进来的是哪个包（包的 package.json 读不到），没有写进 profile 清单；请用 numa plugin add 手动确认。',
      restored: false,
    }
  }
  const bundles = bundlesOf(after)
  if (!bundles.includes(name)) writeManifest(dir, withBundles(after, [...bundles, name]))
  const info = readBundle(bundleDirOf(dir, name))
  const patches = patchCountOf(info)
  const version = info?.version
  const label = version === undefined ? name : `${name}@${version}`
  // 三种结果分开说：读得到包 → 报版本与 patch 条数；读不到 → 明说「条数未知」，别把
  // 一次读盘失败说成「这个包不是组合包」（那会让用户以为包装错了）。
  const detail = info === null
    ? `已装 ${name}，但读不到它的 package.json（patch 条数未知），包名已写进 profile 清单`
    : patches === 0
      ? `已装 ${label}，patch 0 条（不是组合包，不会往插件树插行）`
      : `已装 ${label}，patch ${String(patches)} 条`
  return { ok: true, detail, name, ...(version === undefined ? {} : { version }), patches }
}

/**
 * 从 profile 里卸掉一个 npm 包。
 *
 * 先跑 `pnpm remove`，成功后再重读清单删 `dsh.profile.bundles` 与 `dependencies` 里的那一行
 * （pnpm 自己已经删了 dependencies，这里再删一次是兜底：手改过的清单里可能还留着）。
 * 失败同样回滚，不让清单与 node_modules 对不上。
 * @param name - 包名
 * @param options - profile 目录与 pnpm 路径
 */
export async function removeNpmBundle(
  name: string,
  options: NpmBundleOptions = {},
): Promise<NpmInstallOutcome> {
  const invalid = specProblem(name)
  if (invalid !== null) return { ok: false, detail: `拒绝卸载：${invalid}。` }
  const trimmed = name.trim()
  const dir = options.profileDir !== undefined && options.profileDir.trim() !== ''
    ? options.profileDir.trim()
    : activeProfileDir()
  if (dir === null) {
    return { ok: false, detail: '没有生效的 profile：先跑一次 numa，让默认 profile（~/.dsc/profiles/default）铺好再卸。' }
  }
  const snapshot = snapshotOf(dir)
  const result = await runPnpm(['remove', trimmed], dir, options.pnpmPath)
  const problem = runProblem(result)
  if (problem !== null || result.code !== 0) {
    const restored = restoreSnapshot(dir, snapshot)
    const reason = problem ?? `pnpm 退出码 ${String(result.code)}`
    const log = tail(result.stderr !== '' ? result.stderr : result.stdout, STDERR_TAIL)
    return {
      ok: false,
      detail:
        `卸载失败：${reason}` +
        (log === '' ? '' : `。pnpm 输出：${log}`) +
        (restored ? '（已还原 package.json 与 pnpm-lock.yaml）' : '（还原失败，请检查 profile 目录）'),
      restored,
    }
  }
  const after = parseManifest(readTextOrNull(join(dir, 'package.json')))
  const kept = bundlesOf(after)
  const bundles = kept.filter((item) => item !== trimmed)
  const deps = asObject(after['dependencies'])
  const hadDependency = deps !== null && trimmed in deps
  if (hadDependency) delete (deps as JsonObject)[trimmed]
  // 只有真的动了两处之一才写盘：pnpm remove 已经改过清单，没变化时再写一遍只会
  // 把用户手写的缩进/键顺序换掉。
  const changed = hadDependency || bundles.length !== kept.length
  if (changed) writeManifest(dir, withBundles(after, bundles))
  return {
    ok: true,
    detail: changed ? `已卸载 ${trimmed}，profile 清单里也去掉了这一行。` : `已卸载 ${trimmed}。`,
    name: trimmed,
  }
}
