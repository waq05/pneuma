/**
 * 把配置里写的一条命令解析成「能直接交给 spawn」的目标（全仓库唯一一份）。
 *
 * 为什么单拉一个模块：Windows 上 Node 只执行 PE 文件，PATH 里的 `npx` / `npm` 又往往有两份——
 * 一份无后缀的 bash 包装脚本（npm 安装器留的，本机 `D:\New Folder\npx`，2073 字节，开头
 * `#!/usr/bin/env bash`）、一份 `npx.cmd`。`existsSync` 对前者为真，可 CreateProcess 起不来：
 * 把无后缀 `npx` 的绝对路径交给 `spawn(..., {shell:false})` 实测 ENOENT；而 `.cmd` 不挂 shell
 * 又必然 EINVAL。所以候选必须**带后缀的排前面、无后缀兜底**，命中的是 `.cmd` / `.bat` 才标 `shell`。
 *
 * MCP（`packages/mcp/mcp.ts`）与 LSP（`packages/lsp/servers.ts`）各写过一份，候选顺序还相反，
 * 于是同一台机器上两边对「npx 该怎么起」给出相反答案：MCP 的官方示例 `"command": "npx"`
 * 在 Windows 上必然起不来，LSP 起得来。这里收成一份，MCP 先接上；
 * **LSP 有同款实现，暂未改（避免与在途改动冲突），后续统一到这里**——
 * 顺带提示：那边把解析结果直接交给 spawn，没有对含空格路径加引号，接过来时会一起修好。
 *
 * @module dsc/core/executable
 */
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { quoteForCmd } from './shell-quote.js'

/** `PATH` 里没写 `PATHEXT` 时按这几个后缀找可执行文件。 */
export const FALLBACK_PATHEXT: readonly string[] = ['.COM', '.EXE', '.BAT', '.CMD']

/** 一条命令解析出来的结果。 */
export interface ResolvedExecutable {
  /** 解析出来的绝对路径；一个都没找到时是原样命令。 */
  file: string
  /** true = 要经 shell 起（`.cmd` / `.bat` 只能这么跑）。 */
  shell: boolean
  /** false = `PATH` + `PATHEXT` 里没找到这条命令（这种时候 spawn 一定失败）。 */
  found: boolean
  /**
   * 交给 `spawn` 的 file 参数：`shell` 为真、路径里又有空格或 cmd 元字符时已加引号。
   * 为什么不用 `file` 直接起：`shell:true` 时 Node 只把 file 和 args 用空格拼起来，
   * 含空格的路径会被 cmd 拆成两段（本机 `D:\New Folder\npx.cmd` 实测 exit 1，加引号后 exit 0）。
   */
  spawnFile: string
}

/**
 * 解析一条命令到可执行文件。
 *
 * @param command - 配置里的命令（文件名或路径）。
 * @param env - 交给子进程的环境（从这里读 `PATH` / `PATHEXT`）。
 * @param cwd - 解析相对路径的基准目录；空串才退到进程目录。
 * @returns 找到就带绝对路径与 `found: true`；一个都找不到时 `found: false`、
 *   `file` 是原样命令（错误消息交给 {@link missingCommandReason}）。
 */
export function resolveExecutable(
  command: string,
  env: Record<string, string | undefined>,
  cwd: string,
): ResolvedExecutable {
  const windows = process.platform === 'win32'
  // 带分隔符的按路径解析，不带分隔符的按 PATH 找。
  const roots = /[\\/]/.test(command)
    ? [isAbsolute(command) ? command : resolve(cwd === '' ? process.cwd() : cwd, command)]
    : searchDirs(env).map((dir) => join(dir, command))
  const suffixes = windows ? pathextSuffixes(env) : ['']
  for (const root of roots) {
    // Windows 上带后缀的候选要排在无后缀**前面**：PATH 里无后缀的 `npm` / `npx` 往往是
    // sh 包装脚本，`statSync` 认得出它是文件（isRunnable 放行）却没法被 spawn；先撞上它就会
    // 错过同目录下真正能跑的 `npm.cmd` / `npx.cmd`，返回一个起不来的目标。
    const candidates = windows ? suffixes.map((suffix) => root + suffix).concat(root) : [root]
    for (const candidate of candidates) {
      if (!isRunnable(candidate)) continue
      const shell = windows && /\.(cmd|bat)$/i.test(candidate)
      return { file: candidate, shell, found: true, spawnFile: shell ? quoteForCmd(candidate) : candidate }
    }
  }
  return { file: command, shell: false, found: false, spawnFile: command }
}

/**
 * 「这条命令没找到」怎么说人话。
 *
 * 两种情况分开说：子进程环境里压根没有 `PATH`（宿主环境被清空 → 解析失败，不是没装），
 * 与按 PATH 找过但确实没有（多半是没装，或命令名写错）。
 *
 * @param command - 配置里写的命令。
 * @param env - 交给子进程的环境（与解析时用的是同一份）。
 * @returns 一句能直接贴进界面错误行的话。
 */
export function missingCommandReason(command: string, env: Record<string, string | undefined>): string {
  const dirs = searchDirs(env)
  const quoted = JSON.stringify(command)
  if (dirs.length === 0) {
    return `解析不了命令 ${quoted}：交给子进程的环境里没有 PATH，无从查找（这是宿主环境变量的问题，不是这个程序没装）`
  }
  const looked =
    process.platform === 'win32'
      ? [command, ...pathextSuffixes(env).map((suffix) => command + suffix)].join(' / ')
      : command
  return (
    `命令 ${quoted} 没找到：在 PATH 的 ${dirs.length} 个目录里找过 ${looked}。` +
    `要么这个程序没装（装完要重开会话，PATH 才带进来），要么设置里把命令名写错了`
  )
}

/** PATH 里的目录清单（跳过空项）。 */
function searchDirs(env: Record<string, string | undefined>): string[] {
  const raw = env.PATH ?? readEnvValue(env, 'PATH') ?? ''
  return raw
    .split(process.platform === 'win32' ? ';' : ':')
    .filter((dir) => dir !== '')
}

/** PATHEXT 拆成的后缀清单；没写就按 {@link FALLBACK_PATHEXT}。 */
function pathextSuffixes(env: Record<string, string | undefined>): readonly string[] {
  const declared = (env.PATHEXT ?? readEnvValue(env, 'PATHEXT') ?? '')
    .split(';')
    .filter((suffix) => suffix !== '')
  return declared.length > 0 ? declared : FALLBACK_PATHEXT
}

/** 读环境变量（Windows 上变量名不分大小写，所以找不到时再比一遍小写）。 */
function readEnvValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name]
  if (direct !== undefined) return direct
  if (process.platform !== 'win32') return undefined
  const wanted = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key]
  }
  return undefined
}

/** 这个路径是不是一个能跑的文件（POSIX 上还要求可执行位）。 */
function isRunnable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}
