/**
 * 子进程环境筛选：MCP server 与 LSP 语言服务器共用这一份白名单。
 *
 * 为什么单独一个模块：两个包（`packages/mcp`、`packages/lsp`）都要起第三方子进程，
 * 白名单只能有一份——各写一份迟早一边加了变量另一边没加。放在 `core/` 而不是任一包里，
 * 是为了让 lsp 不必依赖 mcp 包。
 *
 * 行为约束（改动前先想清楚）：只放白名单里的系统变量，加上调用方显式声明的名字；
 * 声明了名字但没给值时，从父环境取同名变量。`process.env` 里还有用户的模型 key 与
 * 各种令牌，第三方程序没有理由看见它们。
 *
 * @module dsc/core/child-env
 */

/**
 * 允许带进子进程的系统环境变量。
 * 其余一律不传：`process.env` 里有用户的模型 key 与各种令牌，MCP server 是第三方程序，
 * 没有理由让它看见。要传的按 server 配置显式声明。
 */
export const BASE_ENV_NAMES: readonly string[] = [
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LANG',
]

/**
 * 按白名单拼子进程环境。
 *
 * 只放 {@link BASE_ENV_NAMES} 里的系统变量，加上配置里显式声明的名字；
 * 声明了名字但没给值时，从父环境取同名变量（写 `{"GITHUB_TOKEN": ""}` 也能带上宿主的那个）。
 *
 * @param declaredNames - 配置里显式声明的变量名。
 * @param values - 这些名字对应的值（缺了就从 parent 取）。
 * @param parent - 父进程环境，通常是 `process.env`。
 * @returns 交给 spawn 的环境对象（不含任何未声明的变量）。
 */
export function buildChildEnv(
  declaredNames: readonly string[],
  values: Record<string, string>,
  parent: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of BASE_ENV_NAMES) {
    const value = readEnv(parent, name)
    if (value !== undefined && value !== '') env[name] = value
  }
  for (const name of declaredNames) {
    const value = values[name] ?? readEnv(parent, name)
    if (value !== undefined && value !== '') env[name] = value
  }
  return env
}

/** 按名字读环境变量；Windows 的变量名不分大小写，所以找不到时再比一遍小写。 */
function readEnv(parent: Record<string, string | undefined>, name: string): string | undefined {
  const direct = parent[name]
  if (direct !== undefined) return direct
  if (process.platform !== 'win32') return undefined
  const wanted = name.toLowerCase()
  for (const key of Object.keys(parent)) {
    if (key.toLowerCase() === wanted) return parent[key]
  }
  return undefined
}
