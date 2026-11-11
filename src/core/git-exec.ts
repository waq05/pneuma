/**
 * 受控执行 git 的公共层：`execFile` 固定子命令数组（无 shell、无拼接）＋ `--porcelain -z`
 * 输出的解析与路径基准换算。
 *
 * 谁在用：`desktop-dock` 插件（dock 面板的文件与 git 那一批 op）与 `git` 插件（当前工作区
 * 的分支/改动读数快照面）。两处都在读同一个工作区的现状，执行姿势与解析规则必须**只有
 * 一份**——尤其是 `-z` 的 rename 双记录：漏跳过紧跟的那条，一次重命名会被数成两个改动。
 *
 * 路径基准：git 报的永远是**仓库根相对**路径，而 dsc 的文件读取边界与界面展示都以**会话
 * 工作目录**为基准。两套基准在这一层一刀切开（{@link toWorkspacePath}）：工作目录之外的
 * 变更整条不列，既不越出安全边界，也不让界面上点一行得到「读不到这个条目」。
 *
 * @module dsc/core/git-exec
 */
import { execFile } from 'node:child_process'

/**
 * 受控执行 git（固定首参字面量 + 参数数组；无 shell）。超时由 execFile 自己收进程。
 *
 * @param env - 额外环境变量（影子仓库靠 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`
 *   隔离，见 `packages/checkpoint/shadow.ts`）。不传 = 与从前完全一致。
 *
 * 为什么先剥掉继承来的 `GIT_*`：用户 shell 里只要设过 `GIT_DIR`（git worktree、
 * 多仓并行时很常见），每条命令都会被带到那个仓去；只叠我们自己的值挡不住没传的那几个。
 * 剥干净再叠，调用方给什么就是什么，没给的一律按「普通 git」走。
 */
export function git(
  cwd: string,
  args: string[],
  timeoutMs = 15000,
  env?: Record<string, string | undefined>,
): Promise<string> {
  // 只把有值的键交给 execFile：`undefined` 在这里表示「这次不覆盖」，不是要写一个
  // 字符串 "undefined" 进去；显式过滤，子进程拿到的环境只有一种解释。
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    // Windows 的环境变量名不区分大小写：`Git_Dir` 一样会影响 git，按大写判才剥得干净。
    if (key.toUpperCase().startsWith('GIT_') || value === undefined) continue
    childEnv[key] = value
  }
  if (env !== undefined) {
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[key] = value
    }
  }
  return new Promise((resolveDone, rejectDone) => {
    execFile(
      'git',
      args,
      // timeout 原来只在自己这层 reject，git 进程继续跑（2026-09-29 审查）：
      // 交给 execFile 的 timeout + killSignal，超时连进程一起收掉。
      { cwd, env: childEnv, maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== undefined && error !== null) {
          rejectDone(new Error(String(stderr || error.message).slice(0, 800)))
        } else {
          resolveDone(String(stdout))
        }
      },
    )
  })
}

/**
 * `--porcelain=v1 -z` 的输出解析。
 *
 * 为什么必须带 `-z`：默认（不带 -z）的 porcelain 会对非 ASCII 路径做 C 引号转义
 * （`?? "DeepSeek\351\262\270\351\261\274.svg"`），界面照着这个串去 diff / 暂存
 * 都对不上号；-z 用 NUL 分隔、路径原样给。
 * rename / copy 记录后面还跟一条「原路径」记录（R  c.txt\0a.txt\0），要连同跳过。
 */
export function parsePorcelainZ(text: string): { code: string; file: string }[] {
  const records = text.split('\0')
  const entries: { code: string; file: string }[] = []
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at] ?? ''
    if (record === '') continue
    const code = record.slice(0, 2)
    entries.push({ code, file: record.slice(3) })
    if (code[0] === 'R' || code[0] === 'C') at += 1
  }
  return entries
}

/** 工作目录在仓库里的前缀（`git rev-parse --show-prefix` 的 `sub/` 形式；仓库根处为空串）。 */
export async function repoPrefix(cwd: string): Promise<string> {
  const out = await git(cwd, ['rev-parse', '--show-prefix']).catch(() => '')
  return out.trim().replace(/\\/g, '/')
}

/**
 * 把 git 报的**仓库根相对**路径 rebase 到**工作目录相对**；落在工作目录之外给 null。
 *
 * 命令仍然按仓库根相对的路径给（git 自己按 cwd 解释 pathspec 也没问题），展示一律用
 * 这份剥过前缀的路径。
 */
export function toWorkspacePath(repoPath: string, prefix: string): string | null {
  if (prefix === '') return repoPath
  const dir = prefix.replace(/\/+$/, '')
  if (repoPath === dir || repoPath === dir + '/') return '.'
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null
}
