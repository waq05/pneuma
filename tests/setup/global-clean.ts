/**
 * 每轮的开跑清扫与收尾清理（`globalSetup`）。
 *
 * ## 三件事，三个时机
 *
 * 1. **开跑前**：先清「上一轮已退出、但没清干净」的目录——按 `dsc-run-<pid>.dirs`
 *    登记表判定（主人 pid 已不存活就清，不看年龄；上一轮被强杀时它的孤儿 git 可能还在跑，
 *    删除时会先收掉占着文件的进程）。再删系统临时根下超过 24 小时的 `dsc-` 目录，兜那些
 *    没走 `createTempDir`、没有登记表的散装目录。
 * 2. **整轮结束后**（teardown）：删掉**本轮创建**的目录。这是「测试跑完不留临时文件」的
 *    主路径——判据是「系统临时根**顶层** + 目录名以 `dsc-` 开头 + 创建时间不早于本轮
 *    开跑」。仓库里还有两百多处测试直接 `mkdtempSync`，它们没走 `createTempDir`（也就
 *    没有登记表），只有等所有 worker 退出后按这两条扫一遍才收得干净。
 * 3. **主进程退出时**（`exit` 事件）：再试一次第 2 步没删掉的目录，这次可以收占用进程。
 *
 * ## 为什么第 3 步不能并进 teardown
 *
 * Windows 上真正的拦路虎是 checkpoint 快照的 `git add -A`（大工作树上实测 30 秒）：
 * 测试文件跑完时它还在跑，worker 退出后它变成孤儿进程，握着
 * `<临时 HOME>/.dsc/checkpoints/<id>/repo/index.lock`（见 `tmp-clean.ts` 文件头）。
 * 实测 teardown 执行时 **worker 仍然活着**（vitest 的 `close()` 是先跑全局 teardown、
 * 后关 pool，见 `vitest/dist/chunks/cli-api.*.js` 的 `close()`），这时去杀它的子进程会让
 * 活着的 worker 收到 `execFile` 错误、可能变成「未处理拒绝」把绿跑弄红。
 *
 * 所以：teardown 只删能删的，删不掉的登记到本轮内存表；`process.once('exit')` 里 pool
 * 已关闭、worker 已退出，这时再用 Restart Manager 精确找出「打开着这些文件」的进程
 * （就是那些孤儿 git），收掉后重删。仍然删不掉的，下一轮开跑时按登记表清。
 *
 * ## 为什么收尾必须放在主进程，而不是 worker 退出时
 *
 * worker 是并行的。任何一个 worker 先退出就去扫全局，会把还在跑的 worker 的现场一起
 * 删掉——红会红成「文件不存在」，且只在机器忙、并行度高时复现。teardown 跑在所有
 * worker 之后，没有这个竞态（登记表也因此集中在主进程读写）。
 *
 * ## 失败与并发怎么处理
 *
 * - 任一用例红：worker 会写 `dsc-failed-<pid>.flag`，teardown 读到就**整轮保留**，
 *   连那些没走 `createTempDir` 的现场一起留，路径在 worker 的 stderr 里已经打过。
 *   保留的目录会在**下一轮开跑时**被清掉（登记表 pid 已死）；要长期留现场用
 *   `DSC_KEEP_TMP=1`（那一轮不登记，下一轮也不会替它删）。
 * - 另一份 vitest 还活着（`dsc-run-<pid>.lock` 且 pid 存活）：跳过本轮清理，让位。
 * - `DSC_KEEP_TMP=1`：开跑清扫、收尾清理全部跳过，连锁都不建、目录也不登记。
 *
 * ## 为什么清理写在 globalSetup 而不是 setupFiles
 *
 * `setupFiles` 每个测试文件都跑一次（591 次），扫目录没必要这么频繁；
 * `globalSetup` 一次运行只跑一次。
 *
 * @module dsc/tests/setup/global-clean
 */
import { existsSync } from 'node:fs'
import {
  acquireRunLock,
  clearRunDirs,
  clearStaleRunFailures,
  hasRunFailure,
  listDscTempDirs,
  otherRunActive,
  releaseRunLock,
  removeTempDirOrRelease,
  sweepAbandonedRunDirs,
  sweepRunTempDirs,
  sweepStaleTempDirs,
} from '../support/tmp-clean.js'

/** 把本轮 pid 传给 worker：它们按同一个 pid 登记目录、写失败标记。 */
function announceRunPid(): number {
  const pid = process.pid
  process.env.DSC_RUN_PID = String(pid)
  return pid
}

/**
 * 进程退出时要再试的目录。
 *
 * 放 `globalThis`：`globalSetup` 在 workspace 与 project 两级可能各跑一次（同一主进程、
 * 但可能是两份模块实例），`exit` 监听只能挂一次，登记的目录要能跨实例共享。
 */
interface ExitCleanupState {
  /** 本轮 teardown 没删掉的目录（exit 时再试）。 */
  dirs: Set<string>
  /** `exit` 监听是否已挂。 */
  registered: boolean
}

const EXIT_STATE_KEY = Symbol.for('dsc.tests.tmpCleanup.exitState')

function exitState(): ExitCleanupState {
  const scope = globalThis as { [key: symbol]: ExitCleanupState | undefined }
  let state = scope[EXIT_STATE_KEY]
  if (state === undefined) {
    state = { dirs: new Set<string>(), registered: false }
    scope[EXIT_STATE_KEY] = state
  }
  return state
}

/**
 * 挂一次 `exit` 收尾：pool 已关闭、worker 已退出，孤儿进程可以被安全收掉。
 *
 * `exit` 回调只能同步执行，所以「查占用进程 / kill / 删除」全部走同步口。
 * 它只在本轮 teardown 确实留下东西时才挂，正常情况下一次都不跑。
 */
function ensureExitCleanup(runPid: number): void {
  const state = exitState()
  if (state.registered) return
  state.registered = true
  process.once('exit', () => {
    try {
      if (state.dirs.size > 0) runExitCleanup(runPid, state)
    } catch {
      // 退出钩子里抛什么都晚了：宁可不留日志，也不能把退出码改掉。
    }
  })
}

/** `exit` 时真正干活：收占用进程 → 再删一轮 → 结论。 */
function runExitCleanup(runPid: number, state: ExitCleanupState): void {
  const killed = new Set<number>()
  for (const dir of [...state.dirs]) {
    if (!existsSync(dir)) {
      state.dirs.delete(dir)
      continue
    }
    const result = removeTempDirOrRelease(dir)
    for (const pid of result.killed) killed.add(pid)
    if (result.removed) state.dirs.delete(dir)
  }
  if (state.dirs.size === 0) {
    clearRunDirs(runPid)
    if (killed.size > 0) {
      console.log(
        `[测试临时目录] 进程退出时收掉 ${String(killed.size)} 个占着临时目录的残留进程，本轮临时目录已清干净`,
      )
    }
    return
  }
  const killedNote = killed.size > 0 ? `（已收掉 ${String(killed.size)} 个占用进程）` : ''
  console.warn(
    `[测试临时目录] ${String(state.dirs.size)} 个目录本轮仍删不掉${killedNote}，已登记，下一轮开跑时清理：\n  ${[...state.dirs].join('\n  ')}`,
  )
}

export default function globalSetup(): () => void {
  if (process.env.DSC_KEEP_TMP === '1') {
    // 明确要求保留：连锁都不建，收尾什么都不做。
    return () => {}
  }

  const runPid = announceRunPid()
  const startedAt = Date.now()
  const lock = acquireRunLock(runPid)

  // 先清上一轮已退出的登记目录（按 pid 判定，不看年龄），再清 24 小时的散装残留。
  const abandoned = sweepAbandonedRunDirs(runPid)
  if (abandoned.removed.length > 0) {
    console.log(`[测试临时目录] 开跑前清理 ${abandoned.removed.length} 个上一轮残留目录（登记表主人已退出）`)
  }
  if (abandoned.failed.length > 0) {
    // 不抛：删不掉通常是占用进程还没退，等它自己结束；下一轮还会再试。
    console.warn(`[测试临时目录] ${abandoned.failed.length} 个上一轮目录暂时删不掉（多半被仍在退出的子进程占着），下一轮再试`)
  }

  // 上一轮被强杀会留下失败标记；不清掉的话本轮全绿也会被当成「有红」而保留现场。
  clearStaleRunFailures(runPid)

  const stale = sweepStaleTempDirs()
  if (stale.removed.length > 0) {
    console.log(`[测试临时目录] 开跑前清理 ${stale.removed.length} 个过期目录（超过 24 小时）`)
  }
  if (stale.failed.length > 0) {
    // 不抛：删不掉通常是别的进程还占着，不该让本轮跑不起来。下一轮还会再试。
    console.warn(`[测试临时目录] ${stale.failed.length} 个过期目录删不掉（多半被其它进程占用），下一轮再试`)
  }

  return () => {
    releaseRunLock(lock)
    // 只读不消费：teardown 可能在 workspace 与 project 两级各跑一次，消费掉会让第二次
    // 误判成全绿、把失败现场删掉。旧标记由下一轮 setup 的 clearStaleRunFailures 清。
    if (hasRunFailure(runPid)) {
      // 保留归保留，得告诉人去哪看：不打印路径的话「失败现场」等于没留。
      const kept = listDscTempDirs()
        .filter((entry) => entry.createdMs >= startedAt)
        .map((entry) => entry.path)
      console.warn(
        `[测试临时目录] 本轮有用例失败，保留 ${String(kept.length)} 个目录（下一轮开跑时清理；` +
          `要长期留用 DSC_KEEP_TMP=1）：\n  ${kept.join('\n  ')}`,
      )
      return
    }
    if (otherRunActive(runPid)) {
      console.warn('[测试临时目录] 另一份 vitest 正在运行，跳过本轮清理')
      return
    }
    const removedNow = sweepRunTempDirs({ since: startedAt })
    if (removedNow.removed.length > 0) {
      console.log(`[测试临时目录] 收尾清理 ${removedNow.removed.length} 个本轮目录`)
    }
    if (removedNow.failed.length === 0) {
      clearRunDirs(runPid)
      return
    }
    // 此刻 worker 还活着（vitest 先跑全局 teardown、后关 pool），它的子进程动不得；
    // 登记下来，等进程退出、worker 死透之后再收占用进程并重删。
    const state = exitState()
    for (const dir of removedNow.failed) state.dirs.add(dir)
    ensureExitCleanup(runPid)
    console.warn(
      `[测试临时目录] ${String(removedNow.failed.length)} 个目录此刻删不掉（worker 尚未退出，子进程占着句柄），` +
        `进程退出时再收；仍不行则下一轮开跑时清理`,
    )
  }
}
