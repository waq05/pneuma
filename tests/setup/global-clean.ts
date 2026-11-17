/**
 * 每轮的开跑清扫与收尾清理（`globalSetup`）。
 *
 * ## 两件事，两个时机
 *
 * 1. **开跑前**：删掉系统临时根下超过 24 小时的 `dsc-` 目录。上一轮被强杀、CI 取消
 *    留下的残留靠这一步收掉；门槛远大于一次全量跑，不会误伤同时在跑的另一份。
 * 2. **整轮结束后**（teardown）：删掉**本轮创建**的目录。这是「测试跑完不留临时文件」
 *    的主路径——判据是「系统临时根**顶层** + 目录名以 `dsc-` 开头 + 创建时间不早于本轮
 *    开跑」。仓库里还有两百多处测试直接 `mkdtempSync`，它们没走 `createTempDir`（也就
 *    没有失败标记），只有等所有 worker 退出后按这两条扫一遍才收得干净。
 *
 * ## 为什么收尾必须放在主进程，而不是 worker 退出时
 *
 * worker 是并行的。任何一个 worker 先退出就去扫全局，会把还在跑的 worker 的现场一起
 * 删掉——红会红成「文件不存在」，且只在机器忙、并行度高时复现。teardown 跑在所有
 * worker 之后，没有这个竞态。
 *
 * ## 失败与并发怎么处理
 *
 * - 任一用例红：worker 会写 `dsc-failed-<pid>.flag`，teardown 读到就**整轮保留**，
 *   连那些没走 `createTempDir` 的现场一起留，路径在 worker 的 stderr 里已经打过。
 * - 另一份 vitest 还活着（`dsc-run-<pid>.lock` 且 pid 存活）：跳过本轮清理，让位。
 * - `DSC_KEEP_TMP=1`：开跑清扫、收尾清理全部跳过，连锁都不建。
 *
 * ## 为什么清理写在 globalSetup 而不是 setupFiles
 *
 * `setupFiles` 每个测试文件都跑一次（591 次），扫目录没必要这么频繁；
 * `globalSetup` 一次运行只跑一次。
 *
 * @module dsc/tests/setup/global-clean
 */
import {
  acquireRunLock,
  clearStaleRunFailures,
  hasRunFailure,
  listDscTempDirs,
  otherRunActive,
  releaseRunLock,
  sweepRunTempDirs,
  sweepStaleTempDirs,
} from '../support/tmp-clean.js'

/** 把本轮 pid 传给 worker：它们按同一个 pid 写失败标记。 */
function announceRunPid(): number {
  const pid = process.pid
  process.env.DSC_RUN_PID = String(pid)
  return pid
}

export default function globalSetup(): () => void {
  if (process.env.DSC_KEEP_TMP === '1') {
    // 明确要求保留：连锁都不建，收尾什么都不做。
    return () => {}
  }

  const runPid = announceRunPid()
  const startedAt = Date.now()
  const lock = acquireRunLock(runPid)

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
        `[测试临时目录] 本轮有用例失败，保留 ${String(kept.length)} 个目录（DSC_KEEP_TMP=1 亦会走到这里）：\n  ${kept.join('\n  ')}`,
      )
      return
    }
    if (otherRunActive(runPid)) {
      console.warn('[测试临时目录] 另一份 vitest 正在运行，跳过本轮清理')
      return
    }
    const result = sweepRunTempDirs({ since: startedAt })
    if (result.removed.length > 0) {
      console.log(`[测试临时目录] 收尾清理 ${result.removed.length} 个本轮目录`)
    }
    if (result.failed.length > 0) {
      console.warn(`[测试临时目录] ${result.failed.length} 个目录删不掉（多半被子进程占用），24 小时后的开跑清扫会再清`)
    }
  }
}
