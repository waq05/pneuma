/**
 * 临时目录的清理原语：列、删、扫过期、以及「删不掉时把占着文件的进程收掉」。
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
 * ## Windows 上「删不掉」的真实原因（2026-11-17 实测）
 *
 * 集成层每个测试文件都起真内核；checkpoint 插件会跑影子仓库快照
 * `git -c core.autocrlf=false -c gc.auto=0 add -A`，`GIT_DIR` 指向
 * `<临时 HOME>/.dsc/checkpoints/<id>/repo`、`GIT_WORK_TREE` 指向会话工作树。
 * 本仓库工作树上这条 `git add -A` 实测要 **30 秒**；测试文件跑完、worker 退出时它还
 * 在跑，于是 git 变成**孤儿进程**，继续握着 `repo/index.lock`。收尾删目录时报
 * `EPERM`（errno=1，失败路径是目录本身；细探针定位到被锁的就是 `index.lock`），
 * 重试几百毫秒必败——要等 git 自己结束（实测 16~30 秒）。
 *
 * 更麻烦的是进程树：`worker → git（launcher）→ git.exe（真正干活）`，launcher 先退出，
 * 真正握着锁的那个进程的父进程已经不在进程表里——按「worker 的子进程」去找找不到它。
 *
 * 所以这一层用 **Restart Manager**（Windows 自带的「谁在用这个文件」接口，koffi 直接调
 * `rstrtmgr.dll`）精确定位持有者：先把目录里能删的文件删掉，只剩被占的那几个；用 RM 查出
 * 打开它们的 pid；收掉这些进程；句柄释放后再删目录。只要路径来自本轮的临时目录，杀掉的
 * 就一定是占着**我们**文件的进程，不会误伤并行的另一轮。
 *
 * ## 跨轮兜底：`dsc-run-<pid>.dirs` 登记表
 *
 * 收尾 / 进程退出时仍删不掉的目录记进登记表；**下一轮开跑时**按「登记 pid 已退出」清掉
 * （不清的用同样的 RM 流程），不依赖 24 小时门槛。没有走 `createTempDir` 的散装
 * `mkdtempSync` 仍归 24 小时过期清扫。
 *
 * @module dsc/tests/support/tmp-clean
 */
import { createRequire } from 'node:module'
import type { Dirent } from 'node:fs'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

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
 * `EPERM`/`EBUSY`。重试 5 次 × 100ms 覆盖收尾阶段的正常抖动；真正的大头是孤儿 git
 * 进程（见文件头），由 `removeTempDirOrRelease` 先收进程再重试。
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

/** 同步睡一小会：收进程后等句柄释放只能同步等（teardown / exit 都是同步回调）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 把目录里能删的都删掉，返回**删不掉**的文件（被别的进程占着的那些）。
 *
 * 只在「整目录删失败、准备收占用进程」时调用：这些目录本来就要删，先清掉没被占的
 * 文件，既缩小 Restart Manager 的查询范围，也让持有者只剩下那几个占着句柄的进程。
 */
export function collectLockedFiles(dir: string): string[] {
  const locked: string[] = []
  const walk = (current: string): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        // 子目录里如果还有删不掉的文件，这一下会失败——忽略，留给调用方。
        try {
          rmSync(path, { recursive: true, force: true })
        } catch {
          // 非空或仍被占：跳过。
        }
      } else {
        try {
          rmSync(path, { force: true })
        } catch {
          locked.push(path)
        }
      }
    }
  }
  walk(dir)
  return locked
}

// ── Restart Manager：谁打开着这些文件 ───────────────────────────────────────

/** koffi 的最小子集（只声明本文件用到的入口，不拉整包类型）。 */
interface KoffiLike {
  load(name: string): { func(definition: string): (...args: unknown[]) => unknown }
  struct(name: string, fields: Record<string, unknown>): unknown
  array(type: unknown, count: number): unknown
  alloc(type: unknown, count: number): unknown
  encode(pointer: unknown, type: unknown, value: unknown): void
  decode(pointer: unknown, type: unknown, count?: number): unknown
}

interface RestartManagerApi {
  /** 查这些文件正被哪些进程打开；不可用时返回 null。 */
  holders(paths: readonly string[]): number[] | null
}

/** 懒加载：只有真的删不掉时才碰 FFI，正常跑一次都不加载。 */
let restartManagerCache: RestartManagerApi | null | undefined

/**
 * 加载 Windows Restart Manager 绑定（`rstrtmgr.dll`）。
 *
 * 为什么用它而不是遍历进程表猜：实测真正握着 `index.lock` 的 git 进程的父进程（git 的
 * launcher）已经退出，按「worker 的子进程」根本找不到它；`Get-CimInstance` 也看不到
 * 文件句柄。Restart Manager 是系统自带的「谁在用这个文件」接口，按文件查 pid，精确。
 *
 * 非 Windows、或 koffi 不可用（裁剪安装）时返回不可用：删不掉的目录交给跨轮登记表。
 */
function restartManager(): RestartManagerApi | null {
  if (restartManagerCache !== undefined) return restartManagerCache
  if (process.platform !== 'win32') {
    restartManagerCache = null
    return null
  }
  try {
    const require = createRequire(import.meta.url)
    const koffi = require('koffi') as KoffiLike
    const lib = koffi.load('rstrtmgr.dll')
    const filetime = koffi.struct('FILETIME', { dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' })
    const uniqueProcess = koffi.struct('RM_UNIQUE_PROCESS', {
      dwProcessId: 'int32',
      ProcessStartTime: filetime,
    })
    const processInfo = koffi.struct('RM_PROCESS_INFO', {
      Process: uniqueProcess,
      strAppName: koffi.array('char16_t', 256),
      strServiceName: koffi.array('char16_t', 64),
    })
    const RmStartSession = lib.func('uint32 RmStartSession(_Out_ uint32_t *pSessionHandle, int dwSessionFlags, char16_t *strSessionKey)')
    const RmEndSession = lib.func('uint32 RmEndSession(uint32_t pSessionHandle)')
    const RmRegisterResources = lib.func(
      'uint32 RmRegisterResources(uint32_t pSessionHandle, uint32_t nFiles, const char16_t **rgsFilenames, uint32_t nApplications, void *rgApplications, uint32_t nServices, char16_t **rgsServiceNames)',
    )
    const RmGetList = lib.func(
      'uint32 RmGetList(uint32_t dwSessionHandle, _Out_ uint32_t *pnProcInfoNeeded, _Inout_ uint32_t *pnProcInfo, RM_PROCESS_INFO *rgAffectedApps, _Inout_ uint32_t *lpdwRebootReasons)',
    )
    restartManagerCache = {
      holders(paths: readonly string[]): number[] | null {
        const session = koffi.alloc('uint32_t', 1)
        if (Number(RmStartSession(session, 0, `dsc-rm-${String(Date.now())}`)) !== 0) return null
        const handle = koffi.decode(session, 'uint32_t')
        try {
          if (Number(RmRegisterResources(handle, paths.length, paths, 0, null, 0, null)) !== 0) return null
          const needed = koffi.alloc('uint32_t', 1)
          const count = koffi.alloc('uint32_t', 1)
          const reasons = koffi.alloc('uint32_t', 1)
          koffi.encode(count, 'uint32_t', 0)
          koffi.encode(reasons, 'uint32_t', 0)
          // 先拿所需条数（ERROR_MORE_DATA = 234），再按条数取。
          let rc = Number(RmGetList(handle, needed, count, null, reasons))
          if (rc === 0) return []
          if (rc !== 234) return null
          const size = koffi.decode(needed, 'uint32_t') as number
          if (size <= 0) return []
          const infos = koffi.alloc(processInfo, size)
          koffi.encode(count, 'uint32_t', size)
          rc = Number(RmGetList(handle, needed, count, infos, reasons))
          if (rc !== 0) return null
          const list = koffi.decode(infos, processInfo, size) as { Process: { dwProcessId: number } }[]
          return list.map((info) => Number(info.Process.dwProcessId)).filter((pid) => Number.isInteger(pid) && pid > 0)
        } finally {
          RmEndSession(handle)
        }
      },
    }
    return restartManagerCache
  } catch {
    restartManagerCache = null
    return null
  }
}

/** 谁打开着这些文件（Windows Restart Manager；其它平台或不可用返回空数组）。 */
export function processesHoldingFiles(paths: readonly string[]): number[] {
  if (paths.length === 0) return []
  const api = restartManager()
  if (api === null) return []
  return api.holders(paths) ?? []
}

export interface ReleaseResult {
  /** 目录最终是否删掉。 */
  removed: boolean
  /** 为释放句柄而收掉的进程 pid（空表示没找到/没权限）。 */
  killed: number[]
}

/**
 * 删目录；删不掉就找出占着文件的进程收掉，再删一次。
 *
 * 只在「这个目录确定属于本轮 / 确定是上一轮遗留」时调用（收尾的 exit 钩子、开跑前的
 * 登记表清扫）：杀进程的影响面严格限定在「打开着我们自己临时目录里文件」的进程，
 * 不会碰到另一份并行运行的 vitest。
 *
 * 为什么要多轮：一次可能不只一个持有者（git 的 `add` 与 `ls-files` 快照并存），也可能
 * 刚查到持有者它就自己退了。每轮都是「清掉能删的文件 → 查持有者 → 收掉新出现的 →
 * 再删」，最多 4 轮；每轮之间给句柄释放留一拍。
 */
export function removeTempDirOrRelease(dir: string): ReleaseResult {
  if (removeTempDir(dir)) return { removed: true, killed: [] }
  if (process.platform !== 'win32') return { removed: false, killed: [] }
  const killed: number[] = []
  for (let round = 0; round < 4; round += 1) {
    const locked = collectLockedFiles(dir)
    // 被占的只有文件时按文件查；一个都查不出来时再拿目录本身兜一次（cwd / 目录句柄）。
    const holders = locked.length > 0 ? processesHoldingFiles(locked) : processesHoldingFiles([dir])
    const fresh = [...new Set(holders)].filter((pid) => pid !== process.pid && !killed.includes(pid))
    for (const pid of fresh) {
      try {
        process.kill(pid, 'SIGKILL')
        killed.push(pid)
      } catch {
        // 已退出 / 没权限：忽略，交给下一轮或下一轮运行兜底。
      }
    }
    // 刚杀完要给句柄释放留一拍；只是持有者自己退了、没杀到东西，也等一小拍再试。
    sleepSync(fresh.length > 0 ? 150 : 80)
    if (removeTempDir(dir)) return { removed: true, killed }
    if (locked.length === 0 && fresh.length === 0) break
  }
  return { removed: false, killed }
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
 * 删掉临时根下「上一轮或更早」留下的、没有登记主人的 `dsc-` 目录。
 *
 * 只看年龄超过门槛的：本轮刚建的那些一定在门槛内，正在并行跑的另一个 vitest
 * 也一样，两者都不会被误删。有登记表的目录不归这里管（`sweepAbandonedRunDirs`
 * 按 pid 判定，比年龄准）。
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
// 三个小文件，都放在系统临时根下、都带 `dsc-` 前缀：
//   - `dsc-run-<pid>.lock`：本轮正在跑。用来认出「另一份 vitest 还活着」；
//   - `dsc-failed-<pid>.flag`：本轮有红。teardown 读到就整轮保留现场；
//   - `dsc-run-<pid>.dirs`：本轮建过的目录清单（跨轮兜底：下一轮开跑时清）。

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
export function processAlive(pid: number): boolean {
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

// ── 本轮目录清单（跨轮兜底） ────────────────────────────────────────────────

/**
 * 本轮主进程 pid。
 *
 * `globalSetup` 把它写进 `DSC_RUN_PID`，worker 继承；没有 globalSetup 的配置
 * （直接用 `--config` 跑单层）退回 `process.ppid`——forks 池里 worker 的父进程就是主进程。
 */
export function currentRunPid(): number {
  const fromEnv = Number(process.env.DSC_RUN_PID)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  return process.ppid
}

/** `DSC_KEEP_TMP=1`：明确要求保留现场，不登记（下一轮也就不该替它清）。 */
function keepTmpRequested(): boolean {
  return process.env.DSC_KEEP_TMP === '1'
}

/** 本轮目录清单路径。 */
export function runDirsPath(runPid: number, root = tmpdir()): string {
  return join(root, `dsc-run-${String(runPid)}.dirs`)
}

/**
 * 登记一个本轮建的临时目录。
 *
 * 由 `tmp-dir.ts` 的 `createTempDir` 调用：**不写目录内的标记文件**，而是集中记在
 * 临时根下的 `dsc-run-<pid>.dirs`。为什么不在目录里放 `.dsc-run-pid`：`createTempDir`
 * 也用来建临时 git 仓库（`harness.tempRepo()`），多一个未跟踪文件会改变
 * `git status` 的读数，把 `turnDiff` / env-facts 这类用例带歪。登记表在目录外，
 * 对被测工作区零影响。
 */
export function registerRunDir(dir: string, runPid: number, root = tmpdir()): void {
  if (keepTmpRequested()) return
  // 只登记「临时根顶层的 dsc- 目录」（createTempDir 的产物一定长这样）：
  // 清单被篡改或路径写错时，下一轮也不会拿它去删别的位置。
  if (!isInside(dir, root)) return
  if (normalize(dirname(resolve(dir))) !== normalize(root)) return
  if (!basename(resolve(dir)).startsWith(TEMP_PREFIX)) return
  try {
    appendFileSync(runDirsPath(runPid, root), `${dir}\n`, 'utf8')
  } catch {
    // 临时根不可写：没有登记表就退回「24 小时过期清扫」这条老路。
  }
}

/** 读某个登记表里的目录清单。 */
function readDirManifest(path: string): string[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** 清掉本轮目录清单（收尾清干净后不需要它了）。 */
export function clearRunDirs(runPid: number, root = tmpdir()): void {
  try {
    rmSync(runDirsPath(runPid, root), { force: true })
  } catch {
    // 下一轮按 pid 判定再清。
  }
}

/**
 * 删掉「上一轮已经退出、但没清干净」的目录，并把它的登记表一起收掉。
 *
 * 判据是「登记表名字里的 pid 已不存活」——比 24 小时年龄准得多：绿跑被强杀、
 * CI 取消、孤儿进程占着句柄导致收尾失败，都靠这一步在**下一轮开跑时**清掉。
 * 本轮自己的登记表（pid === selfPid）**绝不**动；pid 还活着的另一份 vitest 也不动。
 *
 * 不看目录年龄：15 秒前被强杀的那一轮，下一轮开跑时就该把它清掉，等 60 秒门槛
 * 反而会让「下一轮残留 = 0」不成立。pid 已死 + 清单来自我们自己的登记机制，
 * 归属是确定的，不需要年龄兜底。
 *
 * 删除用 `removeTempDirOrRelease`：上一轮被强杀时它的孤儿 git 可能还在跑，照样能收。
 */
export function sweepAbandonedRunDirs(selfPid: number, root = tmpdir()): SweepResult {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return { removed: [], failed: [] }
  }
  const removed: string[] = []
  const failed: string[] = []
  for (const name of entries) {
    if (!name.startsWith('dsc-run-') || !name.endsWith('.dirs')) continue
    const pid = Number(name.slice('dsc-run-'.length, -'.dirs'.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) continue
    if (processAlive(pid)) continue
    const manifestPath = join(root, name)
    let remaining = 0
    for (const dir of readDirManifest(manifestPath)) {
      // 清单内容也要过一遍认领边界：只删临时根顶层、`dsc-` 开头的真目录。
      if (!isInside(dir, root)) continue
      if (normalize(dirname(resolve(dir))) !== normalize(root)) continue
      if (!basename(resolve(dir)).startsWith(TEMP_PREFIX)) continue
      if (!existsSync(dir)) continue
      if (removeTempDirOrRelease(dir).removed) removed.push(dir)
      else {
        failed.push(dir)
        remaining += 1
      }
    }
    if (remaining === 0) {
      try {
        rmSync(manifestPath, { force: true })
      } catch {
        // 删不掉就留着，下一轮再试。
      }
    }
  }
  return { removed, failed }
}
