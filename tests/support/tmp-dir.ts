/**
 * 测试临时目录的收尾判定：**本轮有红就整轮留，全绿就整轮清**。
 *
 * ## 分工
 *
 * - 本文件（在 worker 里，随测试文件加载）只做两件事：文件跑完时看**最终**结果，有失败就
 *   写一个「本轮有红」的标记文件。**不删任何东西**——worker 是并行的，任何一个 worker
 *   动手删全局目录，都会把还在跑的 worker 的现场一起带走。
 * - 真正的删除在 `tests/setup/global-clean.ts` 的 teardown：所有 worker 都退出之后，
 *   主进程按创建时间清掉本轮建的全部 `dsc-` 目录；看到失败标记就一个都不动。
 *
 * ## 为什么只能看「文件跑完」的最终结果，不能在 afterEach 里看
 *
 * 曾经在 `afterEach` 里看单次 attempt 的 `task.result.state`，有重试就会误判：第一次
 * attempt 是 `fail`，重试后通过，整轮其实是绿的，但标记已经写下了，teardown 于是保留全部
 * 临时目录，日志还会打出「本轮有用例失败」——与结论相反。
 *
 * 实测（Vitest 4.1.12，`test('x', { retry: 1 }, …)` 首个 attempt 抛错）：
 * - `afterEach` 两次 attempt 分别看到 `state=fail retry=0` 与 `state=pass retry=1`；
 * - 文件级 `afterAll` 的第二个参数是**文件 task**，它自己的 `result.state` 当时还是 `run`
 *   （不可用），但它的子树已经是最终态：重试通过的用例 `pass retry=1`，真失败 `fail`；
 * - `beforeAll` 抛错时 `afterEach` 根本不执行，此时**嵌套 suite** 的 `result.state` 是
 *   `fail`、里面用例是 `skip`——所以必须递归遍历整棵子树，不能只看文件 task 自己。
 *
 * 结论：判据 = 递归遍历文件 task 子树，任一层 `result.state === 'fail'` 才算本轮有红。
 * 这样「重试后通过」不会被记成失败，「beforeAll 抛错」也不会被漏掉（B55）。
 *
 * ## 钩子签名为什么长这样
 *
 * Vitest 4 把钩子的**第一个参数**当作 fixture 解构模式解析：写 `(_context, suite)` 会直接
 * 报 `FixtureParseError`，必须用解构（`({}, suite)`）。第二个参数才是文件级 task。
 *
 * ## 被强杀怎么办
 *
 * worker 全挂、teardown 也没跑到时目录会留下。所以每次 `createTempDir` 都把目录登记到
 * 本轮清单（`dsc-run-<pid>.dirs`，见 `tmp-clean.ts`）：下一轮开跑时按「登记 pid 已退出」
 * 删掉，不依赖 24 小时门槛。没走这里、直接 `mkdtempSync` 的散装目录仍归 24 小时清扫。
 *
 * @module dsc/tests/support/tmp-dir
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { currentRunPid, markRunFailed, registerRunDir, TEMP_PREFIX } from './tmp-clean.js'

/** 本文件是否已确认有失败（一个布尔，细节在 vitest 报告里）。 */
let failed = false

/** 记下「本轮有红」。`markRunFailed` 写失败也不抛：清理是尽力而为。 */
function noteFailure(): void {
  if (failed) return
  failed = true
  markRunFailed(currentRunPid())
}

/**
 * 只声明本文件用到的那几层：`afterAll` 第二个参数是文件 task，它的 `tasks` 是嵌套的
 * suite / test。字段全按可选写，Vitest 的类型（`RunnerTestFile` 等）不必引进来。
 */
interface TaskNode {
  result?: { state?: string }
  tasks?: readonly TaskNode[]
}

/**
 * 文件 task 子树里有没有**最终**失败。
 *
 * 递归而不是只看文件 task 自己：`beforeAll` 抛错时文件 task 与嵌套 suite 都是 `fail`，
 * 而它自己的孩子是 `skip`；重试后通过的用例在子树里是 `pass`。两条都靠这一遍遍历覆盖。
 */
function hasFailedTask(node: TaskNode): boolean {
  if (node.result?.state === 'fail') return true
  return (node.tasks ?? []).some(hasFailedTask)
}

afterAll(({}, suite) => {
  // 只看文件跑完时的最终态：重试后通过的用例在这里已经是 pass（理由见文件头）。
  if (hasFailedTask(suite as TaskNode)) noteFailure()
})

/**
 * 建一个临时目录。
 *
 * 只负责「建」「校验前缀」「登记到本轮清单」；回收由整轮 teardown 统一做（见文件头）。
 * 登记是为了下一轮能按 pid 兜底清理，**不在目录内写标记文件**——`createTempDir`
 * 也用来建临时 git 仓库，多一个未跟踪文件会改变 `git status` 读数（理由见
 * `tmp-clean.ts` 的 `registerRunDir`）。
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
  const dir = mkdtempSync(join(tmpdir(), prefix))
  // 统一成**真实路径**再交出去。
  //
  // GitHub 的 Windows runner 上 `os.tmpdir()` 给的是 8.3 短名
  // （`C:\Users\RUNNER~1\AppData\Local\Temp`），而路径策略那边会 `realpath` 成
  // `C:\Users\runneradmin\…`：两串前缀对不上，于是「工作区内写」被判到工作区外、
  // junction 指到 DSC_HOME 也认不出、`writeRootsFor` 的授权根多一份短名副本——
  // 2026-11-19 之前 Windows 车道那 12 条红全是这一个根因。
  // 先 `realpath` 一次，之后测试里派生的所有路径都只有一种写法。
  const canonical = realpathSync(dir)
  registerRunDir(canonical, currentRunPid())
  return canonical
}
