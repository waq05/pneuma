/**
 * dsh 兼容层的模块解析钩子（主线程，同步注册）。
 *
 * dsh 外部插件以裸说明符 import dsh 生态的库（`@deepseek-ai/dsh-tools` 的
 * defineTool、`@deepseek-ai/schemastery` 的 z……）。这些文件装在 `~/.dsc/plugins/`
 * 或 profile 的 `node_modules/` 下，Node 的解析走不到 dsc 自带的 node_modules。
 * 本钩子做三件事：
 *
 *   1. `@pneuma/runtime/<模块>` 永远指向应用内的 `lib/node_modules/@pneuma/runtime`
 *      ——profile 里装的插件即使自带一份运行时包，也不能变成第二份 `lib/core`。
 *   2. `@deepseek-ai/` 开头的说明符，改从 dsc 运行时的 node_modules 重新解析
 *      （双构建包因此命中与 dsh-tools 内部 import 完全相同的文件，不出现 CJS/ESM 双实例）。
 *   3. 两个 **dsh 宿主库**换成我们自己的实现（{@link SHIMS}）：它们不是随便哪个
 *      第三方包，而是「用户数据目录在哪」「凭据引用怎么建」这两件宿主才知道的事，
 *      照 dsh 的原样返回 `~/.dsh` 会把插件的账本写到别人家里去。
 *   4. 功能包的解析结果追加**代数戳**（`?g=<代数>`，见 {@link bumpGeneration}）。
 *      `lib/packages/<id>/index.js` 被一层再导出桩（`lib/node_modules/@pneuma/<id>/index.js`）
 *      挡着，改真实文件不会变 URL；戳在解析结果上，热重挂才能拿到新模块。
 *
 * 为什么用 `registerHooks`（同步、本线程）而不是 `register`（异步、hooks 线程）：
 * 注册完成即可生效，挂载路径不必等钩子线程就绪，也没有跨线程状态要传。
 *
 * 解析根可以**后加**：外部插件目录在启动时就位，profile 的组合包目录要等读到
 * 配置才知道，所以 `ensureResolveHook` 可重复调用，后加的名字追加进同一份闭包。
 *
 * @module dsc/core/dsh-compat/resolve-hook
 */
import { registerHooks, createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let registered = false

/** 允许重定向的目录（各以 `/` 结尾的 file: URL）；后加的名字追加到这份数组。 */
const roots: string[] = []

/**
 * 应用安装目录的缺省值，由 plugin-loader 在模块加载时登记。
 *
 * 为什么留这个后门：dsh-compat 插件自己也调一次 `ensureResolveHook`（兜底），
 * 它没有应用根可用。缺省值来自 loader 算好的常量，不是在这里按文件深度猜。
 */
let appRootHint: string | null = null

/**
 * dsh 兼容层此刻开没开。
 *
 * 为什么不用 import 现查：这里在解析钩子里，每次 import 都查一遍磁盘太贵，
 * 而且「关着兼容层就让 `@deepseek-ai/*` 解析失败」是**想要的行为**——
 * 插件中心会在导入失败后给出「先启用 dsh-compat」的提示。
 * `@pneuma/runtime` 的例外：它必须永远可解析，与兼容层无关。
 */
let compatEnabled = false

/** 同步兼容层开关（plugin-loader 每次挂载前调用）。 */
export function setResolveHookCompat(enabled: boolean): void {
  compatEnabled = enabled
}

/** 登记应用安装目录的缺省值（plugin-loader 在模块加载时调用一次）。 */
export function setResolveHookAppRoot(dir: string): void {
  appRootHint = dir
}

// ── 代数戳：功能包改代码不重启即生效 ───────────────────────────────────────────
//
// 代数（generation）是「功能包这一族模块的版本号」：
//
//   - **0 = 启动态**：一个戳都不加。启动路径 import 到的是
//     `lib/packages/<id>/index.js` 本身，探针裸 import 同一个文件也命中同一份实例
//     ——`@pneuma/runtime` 的单实例约定靠的就是这一点，不能破。
//   - **热重挂前 `bumpGeneration()`**：之后所有落在功能包目录里的解析结果都带
//     `?g=<代数>`。URL 变了，Node 的 ESM 缓存就不再复用旧模块。
//   - 同一代数内所有 import（不同入口、桩、包与包之间）收敛到同一个 URL，所以
//     「一代一个实例」；换代才出现新实例。
//
// 为什么必须做在解析钩子里、而不是在 loader 里改 import 说明符：再导出桩的
// `export * from '../../../packages/<id>/index.js'` 和包内部的 `./sub.js` 都不经过
// loader——只有解析钩子看得见它们。
//
// 为什么只戳功能包：`lib/core/**` 与 `@pneuma/runtime/**` 一旦被戳就会出现第二份
// 内核状态，模块级注册表会落空、沙箱会 fail-open。这两处永远排除（见
// {@link isFeaturePackageFile}）。
let generation = 0

/** 允许打戳的包目录（绝对路径）。`<应用根>/lib/packages` 由 appRootHint 直接推出。 */
const generationRoots: string[] = []

/** 当前代数（0 = 启动态，不加任何戳）。 */
export function currentGeneration(): number {
  return generation
}

/**
 * 换代：功能包下一次解析拿到的 URL 全部带上新代数。
 *
 * 调用方（plugin-loader 的热重挂）在**导入新模块之前**调它；失败不需要回退代数——
 * 旧 fiber 里的模块对象已经在内存里，代数只影响「下一次 import 拿哪一份」。
 * @returns 新代数（从 1 开始；0 永远保留给启动态）
 */
export function bumpGeneration(): number {
  generation += 1
  return generation
}

/**
 * 登记一个「功能包目录」：解析结果落在它里面时打代数戳。
 *
 * 应用自带包不用逐个登记：loader 会把 `<应用根>/lib/packages` 整个登记一次
 * （见 mountApplicationRows）。重复登记无害；外部单文件插件不登记——它的 loader
 * 缓存键 `?t=<mtime>` 本来就跟着文件变。
 * @param dir - 包目录绝对路径（`<profile>/node_modules/<包名>` 这类）
 */
export function registerGenerationRoot(dir: string): void {
  if (dir === '') return
  const normalized = resolve(dir)
  // 内核与运行时适配包永远不戳：登记它们等于给自己埋第二份 core。
  if (appRootHint !== null) {
    if (isUnder(normalized, join(appRootHint, 'lib', 'core'))) return
    if (isUnder(normalized, join(appRootHint, 'lib', 'node_modules', '@pneuma', 'runtime'))) return
  }
  if (!generationRoots.includes(normalized)) generationRoots.push(normalized)
}

/**
 * 用 Pneuma 自己的实现顶替的 dsh 宿主库。
 *
 * 只收「语义完全由宿主决定、且 dsh 的默认值在 Pneuma 上是错的」两个：
 * home-paths 的默认根是 `~/.dsh`，不当宿主就会把插件数据写进 dsh 的家目录；
 * credentials 的 credentialRef 只是「校验过的字符串」，不需要 dsh 的凭据库。
 */
const SHIMS: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-home-paths': './shims/home-paths.js',
  '@deepseek-ai/dsh-credentials': './shims/credentials.js',
}

/**
 * 注册解析钩子（幂等；重复调用只追加解析根）。
 *
 * 注册**不与 dsh-compat 开关挂钩**：`@pneuma/runtime` 的重定向是单实例保证的一部分，
 * 关掉兼容层也得在。
 * @param pluginRoots - 允许重定向的插件目录（`~/.dsc/plugins/`、profile 的 node_modules）
 * @param appDir - 应用安装目录（运行中 Pneuma 的 package.json 所在目录）。**显式传入**：
 *   以前这里用 `new URL('../..', import.meta.url)` 按文件深度猜，多包一层目录就指错。
 */
export function ensureResolveHook(pluginRoots: readonly string[], appDir?: string): void {
  for (const root of pluginRoots) {
    const url = `${pathToFileURL(root).href.replace(/\/+$/, '')}/`
    if (!roots.includes(url)) roots.push(url)
  }
  if (registered) return
  registered = true
  if (appDir !== undefined) appRootHint = appDir
  if (appRootHint === null) {
    throw new Error('解析钩子缺少应用安装目录：请从 plugin-loader 的 ensureResolveHook 传入 appDir（或先调 setResolveHookAppRoot）。')
  }
  const appRoot = appRootHint

  // 应用侧的包统一住在 <应用根>/lib/node_modules/ 下（运行时适配包与功能包同一层）。
  const appNodeModules = join(appRoot, 'lib', 'node_modules')
  const runtimeDir = join(appNodeModules, '@pneuma', 'runtime')
  // 解析基点：应用根（直接依赖：cordis、dsh-tools）；dsh-tools 的真实目录
  // （它的传递依赖 schemastery、dsh-brand、dsh-util-values 住在 pnpm 布局的兄弟位）。
  const bases = [appRoot]
  try {
    bases.push(join(createRequire(join(appRoot, 'package.json')).resolve('@deepseek-ai/dsh-tools'), '..'))
  } catch {
    // 没装 dsh-tools 就只剩应用根一个基点：插件 import 时会响亮失败
  }
  const shimUrls = new Map(
    Object.entries(SHIMS).map(([specifier, file]) => [specifier, new URL(file, import.meta.url).href]),
  )

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL ?? ''
      const fromPlugin = parent.startsWith('file:') && roots.some((root) => parent.startsWith(root))
      // 不来自插件目录的解析也过一次代数戳：loader 自己 import 再导出桩（绝对文件 URL）
      // 时 parent 是 `lib/core/**`，桩不换 URL 就永远是同一份旧模块。
      if (!fromPlugin) return withGeneration(nextResolve(specifier, context))

      // dsh 宿主库替身与 @deepseek-ai/* 重定向只在兼容层开着时生效：
      // 关着还放行，等于让 dsh 插件半加载，用户反而看不出「兼容层没开」。
      const shim = compatEnabled ? shimUrls.get(specifier) : undefined
      if (shim !== undefined) return { url: shim, shortCircuit: true }

      // 运行时适配包**永远**指向应用内的那一份：profile 里装的插件包即使自带 node_modules，
      // 也不能变成第二份 lib/core（两份实例会让模块级注册表落空、沙箱 fail-open）。
      // 这条是短路返回、不过 withGeneration：运行时包一个戳都不许有。
      const runtime = runtimeSpecifierUrl(specifier, runtimeDir)
      if (runtime !== null) return { url: runtime, shortCircuit: true }

      if (compatEnabled && specifier.startsWith('@deepseek-ai/')) {
        for (const base of bases) {
          try {
            // 借基点目录当 parent：裸说明符解析只用目录做向上查走，假文件名不要求存在
            return withGeneration(
              nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(base, 'package.json')).href }),
            )
          } catch {
            // 换下一个基点；全失败就走默认解析（ERR_MODULE_NOT_FOUND，响亮）
          }
        }
      }
      return withGeneration(nextResolve(specifier, context))
    },
  })
}

/**
 * `@pneuma/runtime` 说明符 → 应用内运行时包里对应的文件 URL。
 *
 * 运行时包只导出通配子路径（没有 `.` 聚合模块），所以只处理 `@pneuma/runtime/<子路径>`；
 * 裸说明符交给正常解析去报「没有 . 入口」，这是它本来就该有的错。
 * @param specifier - 被 import 的说明符
 * @param runtimeDir - 应用内 `lib/node_modules/@pneuma/runtime` 的绝对路径
 * @returns 目标文件 URL；不是运行时包的子路径给 null
 */
function runtimeSpecifierUrl(specifier: string, runtimeDir: string): string | null {
  const prefix = '@pneuma/runtime/'
  if (!specifier.startsWith(prefix) || specifier.length === prefix.length) return null
  return pathToFileURL(join(runtimeDir, specifier.slice(prefix.length))).href
}

/**
 * 给一次解析结果加代数戳（0 代原样返回）。
 *
 * 已有查询串的 URL 用 `URLSearchParams.set` 追加 `&g=`，不会覆盖 loader 的 `?t=`；
 * 已经有 `g` 的不重复追加（同一 URL 被多层解析时结果稳定，缓存才不会抖）。
 * @param result - 默认解析（nextResolve）的返回值
 * @returns 同样形状的结果，必要时换 url
 */
function withGeneration<T extends { url: string }>(result: T): T {
  if (generation === 0) return result
  const url = result.url
  if (!url.startsWith('file:')) return result
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return result
  }
  if (parsed.searchParams.has('g')) return result
  let file: string
  try {
    // fileURLToPath 只看 pathname：带查询串的文件 URL 也能还原成磁盘路径。
    file = fileURLToPath(parsed)
  } catch {
    return result
  }
  if (!isFeaturePackageFile(file)) return result
  parsed.searchParams.set('g', String(generation))
  return { ...result, url: parsed.href }
}

/**
 * 这个文件属不属于「功能包」。
 *
 * 规则：`<应用根>/lib/packages/**` 与登记过的包目录（profile 的
 * `node_modules/<包名>`）算；`lib/core/**`、`@pneuma/runtime/**` 与别的 node_modules
 * 依赖不算。后两条是硬要求——多一份 core 会让模块级注册表落空、沙箱 fail-open。
 * @param file - 解析结果的磁盘路径（已去掉查询串）
 */
function isFeaturePackageFile(file: string): boolean {
  if (appRootHint !== null) {
    if (isUnder(file, join(appRootHint, 'lib', 'core'))) return false
    if (isUnder(file, join(appRootHint, 'lib', 'node_modules', '@pneuma', 'runtime'))) return false
    if (isUnder(file, join(appRootHint, 'lib', 'packages'))) return true
  }
  return generationRoots.some((root) => isUnder(file, root))
}

/** `file` 在不在目录 `dir` 里（按路径段比较；Windows 下大小写不敏感）。 */
function isUnder(file: string, dir: string): boolean {
  const target = comparablePath(file)
  const base = comparablePath(dir)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** 比较用的路径：绝对化 + Windows 下统一小写。 */
function comparablePath(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
