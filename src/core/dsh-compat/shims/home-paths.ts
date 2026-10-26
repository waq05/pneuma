/**
 * `@deepseek-ai/dsh-home-paths` 的 Pneuma 实现（解析钩子按需顶替）。
 *
 * 只改一件事：**默认根从 `~/.dsh` 换成 Pneuma 自己的家目录**（`~/.dsc`，受
 * `DSC_HOME` 覆盖）。函数名、参数顺序、优先级（显式配置 → 环境变量 → 默认根）
 * 与 dsh 原包逐条对齐——插件里那 11 处 `resolveDshHome()` 因此不用改一行，
 * 写出来的账本落在 Pneuma 家里，而不是 dsh 家里。
 *
 * 为什么不能直接装 dsh 那个包：它的默认值是 `join(homedir(), '.dsh')`，
 * 装进来后插件会把成本账本写进 dsh 的 home，两个宿主的账本混在一份文件里。
 *
 * @module dsc/core/dsh-compat/shims/home-paths
 */
import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { dscPath } from '../../path-policy.js'

/** 用户数据根目录名（Pneuma 是 `.dsc`，dsh 是 `.dsh`）。 */
export const DSH_HOME_DIR_NAME = '.dsc'

/** 默认根的用户可见写法。 */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** 覆盖默认根的环变量（沿用 dsh 的名字，插件读的就是它）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 共享 agent 配置根目录名。 */
export const AGENTS_HOME_DIR_NAME = '.agents'

/** 共享 agent 配置根的用户可见写法。 */
export const DEFAULT_AGENTS_HOME_DISPLAY = `~/${AGENTS_HOME_DIR_NAME}`

/** 覆盖共享根的环变量。 */
export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

/**
 * 默认用户数据根。
 * @returns 绝对路径（`DSC_HOME` 有值时就是它）
 */
export function defaultDshHome(): string {
  return dscPath()
}

/**
 * 默认共享 agent 配置根。
 * @returns 绝对路径（`~/.agents`）
 */
export function defaultAgentsHome(): string {
  return join(homedir(), AGENTS_HOME_DIR_NAME)
}

/**
 * 展开 `~`、`~/`、`~\\` 前缀。
 * @param path - 可能是波浪号开头的配置值
 * @returns 展开后的路径；没有前缀就原样返回
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function resolveRoot(
  configured: string | undefined,
  env: Record<string, string | undefined>,
  envName: string,
  fallback: () => string,
): string {
  const fromEnv = env[envName]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : fallback())
  return resolve(expandHomePath(selected))
}

/**
 * 解析用户数据根。优先级：显式路径 → `$DSH_HOME` → `~/.dsc`。
 * @param configured - 显式覆盖（最高优先）
 * @param env - 读环境变量的表
 * @returns 绝对路径
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, DSH_HOME_ENV, defaultDshHome)
}

/**
 * 解析共享 agent 配置根。优先级：显式路径 → `$DSH_AGENTS_HOME` → `~/.agents`。
 * @param configured - 显式覆盖（最高优先）
 * @param env - 读环境变量的表
 * @returns 绝对路径
 */
export function resolveAgentsHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, AGENTS_HOME_ENV, defaultAgentsHome)
}

/**
 * 在用户数据根下拼路径（不创建目录）。
 * @param segments - 依次拼上的路径段
 * @returns 绝对路径
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * 在用户数据根的 `cache` 下拼路径（不创建目录）。
 * @param optionsOrSegment - 显式根覆盖，或第一个路径段
 * @param segments - 其后的路径段
 * @returns 绝对路径
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * 给用户看的根目录写法（不泄露机器绝对路径）。
 * @param resolvedHome - {@link resolveDshHome} 的返回值
 * @returns 默认根给 `~/.dsc`，否则给 `$DSH_HOME`
 */
export function dshHomeDisplay(resolvedHome: string): string {
  return resolvedHome === resolve(defaultDshHome()) ? DEFAULT_DSH_HOME_DISPLAY : `$${DSH_HOME_ENV}`
}

/**
 * 给用户看的共享根写法。
 * @param resolvedRoot - {@link resolveAgentsHome} 的返回值
 * @returns 默认根给 `~/.agents`，否则给 `$DSH_AGENTS_HOME`
 */
export function agentsHomeDisplay(resolvedRoot: string): string {
  return resolvedRoot === resolve(defaultAgentsHome()) ? DEFAULT_AGENTS_HOME_DISPLAY : `$${AGENTS_HOME_ENV}`
}

/**
 * 给文件监视器一个规范化的路径写法（末段不存在也成立）。
 *
 * 与 dsh 同义：把最深的已存在祖先走一遍 `realpath`，其余段按原名拼回去。
 * @param path - 监视目标
 * @returns 祖先已规范化的路径
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}
