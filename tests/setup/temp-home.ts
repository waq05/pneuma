/**
 * integration 层的主目录隔离：每个测试文件一个临时 HOME。
 *
 * ## 为什么必须隔离
 *
 * 这一层要起真内核、真会话落盘。`core/path-policy.ts` 的 `DSC_HOME` 是模块顶层常量，
 * 由 `process.env.DSC_HOME ?? join(homedir(), '.dsc')` 一次算定，会话根目录、锁文件、
 * 侧栏索引全从它派生。不换 HOME 直接跑，测试就会往开发者真实的 `~/.dsc` 里写会话、
 * 抢真实会话的写租约——绿的是测试，脏的是用户数据。
 *
 * ## 为什么两个环境变量都改
 *
 * `os.homedir()` 在 POSIX 认 `HOME`、在 Windows 认 `USERPROFILE`。只改一个，
 * 另一半平台上隔离就是空的，而且这种漏法在 Linux CI 上永远看不出来。
 * 不设 `DSC_HOME` 是刻意的：探针（`scripts/session-dedupe-test.mjs`）走的就是 HOME，
 * 两边口径一致，隔离失效时两边一起露馅，不用维护第二套覆盖方式。
 *
 * ## 刻意不做的事
 *
 * - **不删目录**：失败时要留着翻。临时目录里躺着这次跑的会话日志与 `.lock`，
 *   断言红在哪一条、磁盘被写成什么样，全靠它。
 * - **不吞异常**：`mkdtempSync` 建不出来就让它抛。吞掉的话后续用例会落到真实主目录，
 *   而这正是本文件要防的事故；而且事故现场在测试结果里看不出来（用例照样绿）。
 *
 * @module dsc/tests/setup/temp-home
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

/** 先记住原值：还原要还原成「原来是什么」，不能一律设成空串（空串会让 homedir 退到别处）。 */
const original = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
}

/**
 * 原始主目录透传给用例（`HOME` 已被换成临时目录，这里存换之前的值）。
 *
 * 为什么要有它：有些迁移来的用例要找「真实家里装的东西」——如 dsh-ops 的 worker 二进制
 * 装在 `~/.dsc/plugins` 或 dsh 的 profiles 里，临时 HOME 里当然没有。用例从
 * `globalThis.__DSC_REAL_HOME__` 读这份值，只读不写，隔离不受影响。
 */
;(globalThis as { __DSC_REAL_HOME__?: string }).__DSC_REAL_HOME__ =
  original.HOME ?? original.USERPROFILE ?? undefined

/** 临时主目录；`mkdtempSync` 自带原子性，同机并发跑多个测试文件不会撞名。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-int-home-'))

process.env.HOME = home
process.env.USERPROFILE = home

afterAll(() => {
  // 还原环境变量（临时目录本身留着）。同一个 worker 进程里可能还排着别的测试文件，
  // 不还原就会把它们也带进这份临时 HOME——那是另一种串味，只是方向反过来。
  if (original.HOME === undefined) delete process.env.HOME
  else process.env.HOME = original.HOME
  if (original.USERPROFILE === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = original.USERPROFILE
})
