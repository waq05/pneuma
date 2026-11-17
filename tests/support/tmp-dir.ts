/**
 * 测试临时目录的收尾判定：**本轮有红就整轮留，全绿就整轮清**。
 *
 * ## 分工
 *
 * - 本文件（在 worker 里，随测试文件加载）只做两件事：`afterEach` / `afterAll` 里看
 *   结果，有失败就写一个「本轮有红」的标记文件。**不删任何东西**——worker 是并行的，
 *   任何一个 worker 动手删全局目录，都会把还在跑的 worker 的现场一起带走。
 * - 真正的删除在 `tests/setup/global-clean.ts` 的 teardown：所有 worker 都退出之后，
 *   主进程按创建时间清掉本轮建的全部 `dsc-` 目录；看到失败标记就一个都不动。
 *
 * ## 为什么失败判定要看两处
 *
 * `afterEach` 覆盖用例体失败（实测 `context.task.result.state` 是 `fail`）；
 * `afterAll` 覆盖 `beforeAll` 抛错——那种情况下用例根本没开跑，`afterEach` 不会执行，
 * 只有文件级结果能看出来（实测此时 `suite.result.state` 是 `fail`）。
 *
 * ## 钩子签名为什么长这样
 *
 * Vitest 4 把钩子的**第一个参数**当作 fixture 解构模式解析：写 `(_context, suite)` 会直接
 * 报 `FixtureParseError`，必须用解构（`({}, suite)`）。第二个参数才是文件级 task。
 *
 * ## 被强杀怎么办
 *
 * worker 全挂、teardown 也没跑到时目录会留下；下一轮开跑时清掉超过 24 小时的残留
 * （`sweepStaleTempDirs`），不会越积越多。
 *
 * @module dsc/tests/support/tmp-dir
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach } from 'vitest'
import { markRunFailed, TEMP_PREFIX } from './tmp-clean.js'

/** 本文件是否已确认有失败（一个布尔，细节在 vitest 报告里）。 */
let failed = false

/**
 * 本轮主进程 pid。
 *
 * 由 `tests/setup/global-clean.ts` 在 globalSetup 里写进 `DSC_RUN_PID`；没有 globalSetup
 * （直接用 `--config` 跑单层且该配置没挂）时退回 `process.ppid`——forks 池里 worker 的
 * 父进程就是主进程。
 */
function runPid(): number {
  const fromEnv = Number(process.env.DSC_RUN_PID)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  return process.ppid
}

/** 记下「本轮有红」。`markRunFailed` 写失败也不抛：清理是尽力而为。 */
function noteFailure(): void {
  if (failed) return
  failed = true
  markRunFailed(runPid())
}

afterEach((context) => {
  const state = (context as { task?: { result?: { state?: string } } }).task?.result?.state
  if (state === 'fail') noteFailure()
})

afterAll(({}, suite) => {
  // `beforeAll` 抛错时 afterEach 不会跑，只有文件级结果能看出来。
  if ((suite as { result?: { state?: string } } | undefined)?.result?.state === 'fail') noteFailure()
})

/**
 * 建一个临时目录。
 *
 * 只负责「建」和「校验前缀」；回收由整轮 teardown 统一做（见文件头）。
 *
 * @param prefix - 目录前缀，必须以 `dsc-` 开头（teardown 按前缀认领），不带路径分隔符
 * @returns 目录绝对路径
 * @throws 前缀不合法时抛 TypeError；`mkdtempSync` 失败时抛原始错误（不吞）
 */
export function createTempDir(prefix = `${TEMP_PREFIX}test-`): string {
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new TypeError('createTempDir：prefix 必须是非空字符串')
  }
  if (!prefix.startsWith(TEMP_PREFIX)) {
    // 前缀不带 dsc- 就不在 teardown 的认领范围里，等于白建。
    throw new TypeError(`createTempDir：prefix 必须以 ${JSON.stringify(TEMP_PREFIX)} 开头（收到 ${JSON.stringify(prefix)}）`)
  }
  if (prefix.includes('/') || prefix.includes('\\') || prefix.includes('..')) {
    throw new TypeError(`createTempDir：prefix 不能包含路径分隔符或 ".."（收到 ${JSON.stringify(prefix)}）`)
  }
  return mkdtempSync(join(tmpdir(), prefix))
}
