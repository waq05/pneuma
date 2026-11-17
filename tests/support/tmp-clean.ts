/**
 * 临时目录的清理原语：列、删、扫过期。
 *
 * ## 为什么单独一层，不直接写进钩子
 *
 * 删除动作要被三处共用：测试跑完的收尾（`tmp-dir.ts`）、每轮开跑的过期清扫
 * （`tests/setup/global-clean.ts`）、手动清理脚本（`pnpm run clean:test-tmp`）。
 * 写进钩子就只有钩子能用，而「删不掉」这类问题（Windows 上子进程还握着手柄）
 * 只能在钩子外面复现。这一层不 import vitest，可以用 node 直接跑。
 *
 * ## 三条边界，宁少删不多删
 *
 * 1. 路径必须在系统临时目录之下——判错一次就是删用户的文件；
 * 2. 目录名必须以 `dsc-` 开头，别的程序建的临时目录不认领；
 * 3. 软链接直接跳过：链过去可能是任意位置。
 *
 * ## 过期门槛为什么是 24 小时
 *
 * 一次全量跑约 8 分钟，比它长两个数量级才不会误伤「同时在跑的另一个 vitest」。
 * 门槛只在开跑时用（`sweepStaleTempDirs`），收尾删除不过期判断——那些目录是
 * 本次跑自己造的。
 *
 * @module dsc/tests/support/tmp-clean
 */
import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

/** 临时目录前缀：测试建的主目录一律用它，清理时按它认领。 */
export const TEMP_PREFIX = 'dsc-'

/** 过期门槛：24 小时。 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** 一个候选目录：路径 + 创建时间（判断「本轮建的」）与修改时间（判断过期）。 */
export interface TempDirInfo {
  path: string
  mtimeMs: number
  /**
   * 创建时间。Windows / macOS 的 `birthtime` 是真的创建时间；某些文件系统给 0，
   * 此时退回 `mtimeMs`——目录里刚写过文件，mtime 也会靠近创建时刻。
   */
  createdMs: number
}

/**
 * 路径 `target` 是否在 `dir` 之内（含 `dir` 本身）。
 *
 * Windows 路径大小写不敏感，统一折成小写再比；`resolve` 先把 `..` 与相对路径拍平，
 * 免得 `a/../..` 这类写法绕过判断。
 */
export function isInside(target: string, dir: string): boolean {
  const left = normalize(target)
  const right = normalize(dir)
  if (left === right) return true
  const prefix = right.endsWith(sep) ? right : right + sep
  return left.startsWith(prefix)
}

function normalize(path: string): string {
  const abs = resolve(path)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/**
 * 列出临时根下所有 `dsc-` 目录。
 *
 * 读不到根目录（权限、根不存在）返回空数组，不抛：清理是尽力而为的事，
 * 不能因为它让测试开跑就失败。
 */
export function listDscTempDirs(root = tmpdir()): TempDirInfo[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const out: TempDirInfo[] = []
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue
    const path = join(root, name)
    try {
      const info = lstatSync(path)
      // lstat 不走链接：软链接的 isDirectory 是 false，这里显式再挡一次。
      if (info.isSymbolicLink() || !info.isDirectory()) continue
      out.push({
        path,
        mtimeMs: info.mtimeMs,
        createdMs: info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs,
      })
    } catch {
      // 两次系统调用之间被别的进程删掉了：跳过，不算错。
    }
  }
  return out
}

/**
 * 删除一个临时目录。成功返回 true，删不掉返回 false（不抛）。
 *
 * `maxRetries` 是 Windows 的必需品：子进程刚退，句柄可能还压着目录，立刻删会
 * `EPERM`/`EBUSY`。重试 5 次 × 100ms 足够覆盖正常收尾；还删不掉说明真有东西占着，
 * 交给下一轮过期清扫。
 *
 * 另一条是 cwd：如果调用方忘了还原工作目录，Windows 会拒绝删除「正在使用的目录」，
 * 所以先看当前 cwd 是否在目标里，在就先退回临时根。
 */
export function removeTempDir(dir: string): boolean {
  if (!isInside(dir, tmpdir())) return false
  // 名字也要认领：调用方可能拿错路径（例如 `join(root, 'other-dir')`），
  // 只判「在临时目录里」不足以拦住它。
  if (!basename(resolve(dir)).startsWith(TEMP_PREFIX)) return false
  const current = process.cwd()
  if (isInside(current, dir)) process.chdir(tmpdir())
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    return true
  } catch {
    return false
  }
}

/** 清扫选项；只给测试与脚本留口子，正常调用不带参数。 */
export interface SweepOptions {
  /** 扫描根，缺省系统临时目录。 */
  root?: string
  /** 超过这个年龄才删，缺省 24 小时。 */
  maxAgeMs?: number
  /** 当前时间（注入用，便于验证），缺省 `Date.now()`。 */
  now?: number
}

export interface SweepResult {
  removed: string[]
  failed: string[]
}

/**
 * 删掉临时根下「上一轮或更早」留下的 `dsc-` 目录。
 *
 * 只碰年龄超过门槛的：本轮刚建的那些一定在门槛内，正在并行跑的另一个 vitest
 * 也一样，两者都不会被误删。
 */
export function sweepStaleTempDirs(options: SweepOptions = {}): SweepResult {
  const root = options.root ?? tmpdir()
  const maxAgeMs = options.maxAgeMs ?? STALE_AFTER_MS
  const now = options.now ?? Date.now()
  const removed: string[] = []
  const failed: string[] = []
  for (const entry of listDscTempDirs(root)) {
    if (now - entry.mtimeMs < maxAgeMs) continue
    if (removeTempDir(entry.path)) removed.push(entry.path)
    else failed.push(entry.path)
  }
  return { removed, failed }
}

/**
 * 删掉「本轮建」的目录：创建时间不早于 `since` 的那些。
 *
 * 为什么按创建时间而不是「全部 `dsc-` 目录」：同一台机器上可能还有另一份 vitest 在跑
 * （开发者本地、或两个 CI job 共用 runner），按创建时间切只影响本轮，边界之外的不碰。
 * 真正防并发的那道闸是 `otherRunActive()`——这一层只是把范围收窄。
 */
export function sweepRunTempDirs(options: { root?: string; since: number }): SweepResult {
  const root = options.root ?? tmpdir()
  const removed: string[] = []
  const failed: string[] = []
  for (const entry of listDscTempDirs(root)) {
    if (entry.createdMs < options.since) continue
    if (removeTempDir(entry.path)) removed.push(entry.path)
    else failed.push(entry.path)
  }
  return { removed, failed }
}

// ── 本轮运行的标记文件 ──────────────────────────────────────────────────────
//
// 两个小文件，都放在系统临时根下、都带 `dsc-` 前缀：
//   - `dsc-run-<pid>.lock`：本轮正在跑。用来认出「另一份 vitest 还活着」；
//   - `dsc-failed-<pid>.flag`：本轮有红。teardown 读到就整轮保留现场。

/** 本轮锁文件路径。`pid` 用主进程的（worker 里是 `process.ppid`）。 */
export function runLockPath(runPid: number, root = tmpdir()): string {
  return join(root, `dsc-run-${String(runPid)}.lock`)
}

/** 本轮失败标记路径。 */
export function failureMarkerPath(runPid: number, root = tmpdir()): string {
  return join(root, `dsc-failed-${String(runPid)}.flag`)
}

/** 写本轮锁；写失败返回 null（清理是尽力而为，不该让整轮跑不起来）。 */
export function acquireRunLock(runPid: number, root = tmpdir()): string | null {
  const path = runLockPath(runPid, root)
  try {
    writeFileSync(path, `${String(runPid)}\n`, 'utf8')
    return path
  } catch {
    return null
  }
}

/** 删本轮锁。 */
export function releaseRunLock(path: string | null): void {
  if (path === null) return
  try {
    rmSync(path, { force: true })
  } catch {
    // 删不掉就留着；下一轮 `otherRunActive` 会看 pid 是否还活着，僵尸锁不会被当真。
  }
}

/** 记一笔「本轮有红」。worker 与主进程同机，路径一致。 */
export function markRunFailed(runPid: number, root = tmpdir()): void {
  try {
    writeFileSync(failureMarkerPath(runPid, root), `${String(runPid)}\n`, 'utf8')
  } catch {
    // 写不进去也不影响测试结果；最多是失败现场被清掉，下次用 DSC_KEEP_TMP 复现。
  }
}

/**
 * 本轮是否有红（只读，不消费）。
 *
 * 为什么不消费：`globalSetup` 在 workspace 与 project 两级都可能被调用，teardown 也可能
 * 跑不止一次。消费型判定会让第二次 teardown 误以为全绿、把失败现场删掉（实测踩过）。
 * 旧标记由下一轮开跑的 `clearStaleRunFailures` 清。
 */
export function hasRunFailure(runPid: number, root = tmpdir()): boolean {
  return existsSync(failureMarkerPath(runPid, root))
}

/**
 * 清掉「不是本轮、且进程已退出」的旧失败标记。
 *
 * 只清死进程的：同一台机器上另一份还在跑的 vitest 也有标记，删了会丢它的失败现场。
 */
export function clearStaleRunFailures(selfPid: number, root = tmpdir()): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of entries) {
    if (!name.startsWith('dsc-failed-') || !name.endsWith('.flag')) continue
    const pid = Number(name.slice('dsc-failed-'.length, -'.flag'.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) continue
    if (processAlive(pid)) continue
    const path = join(root, name)
    try {
      rmSync(path, { force: true })
      removed.push(path)
    } catch {
      // 删不掉就留着，下一轮再试；不影响本轮。
    }
  }
  return removed
}

/** pid 是否还活着。`EPERM` 说明进程在、只是没权限发信号，也算活着。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 是否还有**另一份** vitest 在跑。
 *
 * 只认 `dsc-run-<pid>.lock` 且 pid 仍存活（`process.kill(pid, 0)` 不抛）。自己的锁按
 * pid 排除。ENOENT 之类一律当作「没有」——判错的代价是少清一轮，不是删错东西。
 */
export function otherRunActive(selfPid: number, root = tmpdir()): boolean {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return false
  }
  for (const name of entries) {
    if (!name.startsWith('dsc-run-') || !name.endsWith('.lock')) continue
    const pid = Number(name.slice('dsc-run-'.length, -'.lock'.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) continue
    if (processAlive(pid)) return true
  }
  return false
}
