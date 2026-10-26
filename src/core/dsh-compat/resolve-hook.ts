/**
 * dsh 兼容层的模块解析钩子（主线程，同步注册）。
 *
 * dsh 外部插件以裸说明符 import dsh 生态的库（`@deepseek-ai/dsh-tools` 的
 * defineTool、`@deepseek-ai/schemastery` 的 z……）。这些文件装在 `~/.dsc/plugins/`
 * 或 profile 的 `node_modules/` 下，Node 的解析走不到 dsc 自带的 node_modules。
 * 本钩子做两件事：
 *
 *   1. `@deepseek-ai/` 开头的说明符，改从 dsc 运行时的 node_modules 重新解析
 *      （双构建包因此命中与 dsh-tools 内部 import 完全相同的文件，不出现 CJS/ESM 双实例）。
 *   2. 两个 **dsh 宿主库**换成我们自己的实现（{@link SHIMS}）：它们不是随便哪个
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
import { fileURLToPath, pathToFileURL } from 'node:url'

let registered = false

/** 允许重定向的目录（各以 `/` 结尾的 file: URL）；后加的名字追加到这份数组。 */
const roots: string[] = []

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
 * @param pluginRoots - 允许重定向的插件目录（`~/.dsc/plugins/`、profile 的 node_modules）
 */
export function ensureResolveHook(pluginRoots: readonly string[]): void {
  for (const root of pluginRoots) {
    const url = `${pathToFileURL(root).href.replace(/\/+$/, '')}/`
    if (!roots.includes(url)) roots.push(url)
  }
  if (registered) return
  registered = true

  // 解析基点：dsc 根目录（直接依赖：cordis、dsh-tools）；dsh-tools 的真实目录
  // （它的传递依赖 schemastery、dsh-brand、dsh-util-values 住在 pnpm 布局的兄弟位）。
  const runtimeRoot = fileURLToPath(new URL('../..', import.meta.url))
  const bases = [runtimeRoot]
  try {
    bases.push(join(createRequire(join(runtimeRoot, 'package.json')).resolve('@deepseek-ai/dsh-tools'), '..'))
  } catch {
    // 没装 dsh-tools 就只剩 dsc 根目录一个基点：插件 import 时会响亮失败
  }
  const shimUrls = new Map(
    Object.entries(SHIMS).map(([specifier, file]) => [specifier, new URL(file, import.meta.url).href]),
  )

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL ?? ''
      const fromPlugin = parent.startsWith('file:') && roots.some((root) => parent.startsWith(root))
      if (!fromPlugin) return nextResolve(specifier, context)

      const shim = shimUrls.get(specifier)
      if (shim !== undefined) return { url: shim, shortCircuit: true }

      if (specifier.startsWith('@deepseek-ai/')) {
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
