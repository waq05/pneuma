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
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
      if (!fromPlugin) return nextResolve(specifier, context)

      // dsh 宿主库替身与 @deepseek-ai/* 重定向只在兼容层开着时生效：
      // 关着还放行，等于让 dsh 插件半加载，用户反而看不出「兼容层没开」。
      const shim = compatEnabled ? shimUrls.get(specifier) : undefined
      if (shim !== undefined) return { url: shim, shortCircuit: true }

      // 运行时适配包**永远**指向应用内的那一份：profile 里装的插件包即使自带 node_modules，
      // 也不能变成第二份 lib/core（两份实例会让模块级注册表落空、沙箱 fail-open）。
      const runtime = runtimeSpecifierUrl(specifier, runtimeDir)
      if (runtime !== null) return { url: runtime, shortCircuit: true }

      if (compatEnabled && specifier.startsWith('@deepseek-ai/')) {
        for (const base of bases) {
          try {
            // 借基点目录当 parent：裸说明符解析只用目录做向上查走，假文件名不要求存在
            return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(base, 'package.json')).href })
          } catch {
            // 换下一个基点；全失败就走默认解析（ERR_MODULE_NOT_FOUND，响亮）
          }
        }
      }
      return nextResolve(specifier, context)
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
