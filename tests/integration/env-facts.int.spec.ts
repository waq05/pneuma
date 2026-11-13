/**
 * 环境快照与 PTC 调用日志（integration 层，原 `scripts/env-facts-test.mjs`）。
 *
 * 两条都来自「模型每轮都要多花一次调用」的反馈：
 *
 *   1. 快照只写「工作区有未提交改动」，不说是哪几个文件——模型只好自己 `git status`；
 *      而 `git status` 默认把中文名写成 `"\351\207\215…"` 这种八进制，第一眼认不出来。
 *      现在的快照直接列前 5 行（带 `-c core.quotePath=false`），超出部分给总数。
 *   2. `run_code` 每次把调用的工具逐条摊开，六次调用占六行。现在压成一行汇总
 *      （`glob×2、grep、bash`），只有**失败**的条目单独列——参数与原因得留着。
 *
 * ## 为什么归 integration 而不是某个包的目录
 *
 * 两段各归一个模块（`packages/session-core/prompt.ts` 的 `environmentText` 与
 * `core/ptc.ts` 的 `ptcResultBody`），没有单一被测模块；而且第一段要真起 git 子进程、
 * 真写工作树，不是纯函数。按 D23 的跨领域口径放这里。
 *
 * @module dsc/tests/integration/env-facts.int.spec
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { ptcResultBody } from '@pneuma/runtime/core/ptc.js'
import { environmentText } from '@pneuma/runtime/packages/session-core/prompt.js'

/** 本文件建的临时仓库，跑完统一删（临时 HOME 由 integration setup 管，这里只删自己建的）。 */
const trees: string[] = []

/**
 * 在指定仓库里跑一次 git。
 *
 * 显式带 `user.name` / `user.email`：CI 与开发机都没有全局 git 身份，
 * 少了这两个参数 `git commit` 会报「请配置身份」，测试红在环境而不是被测行为上。
 */
function gitIn(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/** 建一个空仓库，提交一个 `base.txt` 当基线；返回仓库目录。 */
function repoWithBaseline(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  trees.push(dir)
  gitIn(dir, ['init', '-q'])
  writeFileSync(join(dir, 'base.txt'), 'base\n', 'utf8')
  gitIn(dir, ['add', '.'])
  gitIn(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

afterAll(() => {
  for (const dir of trees) rmSync(dir, { recursive: true, force: true })
})

describe('环境快照：列出改了什么，中文名不转义', () => {
  /** 一个改过的已跟踪文件 + 一个中文名未跟踪文件：两条都该出现在快照里。 */
  const dir = repoWithBaseline('dsc-envfacts-')
  writeFileSync(join(dir, 'base.txt'), 'base changed\n', 'utf8')
  writeFileSync(join(dir, '重构计划书.md'), '# plan\n', 'utf8')
  const text = environmentText(dir)

  test('点出是哪几个文件，而不是只说「有未提交改动」', () => {
    // 只说有改动时，模型只能再跑一次 `git status`——这正是这条修复要省掉的那次调用。
    expect(text).toContain('base.txt')
    expect(text).toContain('重构计划书.md')
  })

  test('中文名不写成八进制转义', () => {
    // git 的缺省 quotePath 会把中文名写成 `"\351\207\215…"`；出现这种形状说明
    // `-c core.quotePath=false` 没带上，模型第一眼认不出文件。
    expect(text).not.toMatch(/\\\d{3}/)
  })

  test('仍然标了「有未提交改动」，且不重复说「工作区干净」', () => {
    expect(text).toContain('工作区有未提交改动')
    // 两句同时出现说明分支判定被写成了「都写一遍」，模型会收到自相矛盾的环境。
    expect(text).not.toContain('工作区干净')
  })
})

describe('环境快照：超过 5 项给总数', () => {
  test('最多列 5 个，并报出总数', () => {
    // 快照按 cwd 缓存 30 秒（设计如此，免得每轮白跑两次 git），所以换一个临时仓库再看这段。
    const many = repoWithBaseline('dsc-envfacts-many-')
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(many, `extra-${String(index)}.txt`), 'x\n', 'utf8')
    }
    const text = environmentText(many)
    expect(text).toMatch(/等 6 项/)
    // 上限写成「前 5 行」：多列一行会让长仓库的尾部快照无限长，模型读到的重点反而更少。
    expect((text.match(/extra-\d\.txt/g) ?? []).length).toBeLessThanOrEqual(5)
  })
})

describe('PTC 调用日志：成功的压成一行，失败的单独列', () => {
  /** 一次混合结果的调用记录：两个 glob、一个 grep、一个失败的 bash、一个 read。 */
  const body = ptcResultBody({
    value: { ok: true },
    calls: [
      { name: 'glob', args: '{"pattern":"a"}', ms: 12, ok: true },
      { name: 'glob', args: '{"pattern":"b"}', ms: 20, ok: true },
      { name: 'grep', args: '{"pattern":"c"}', ms: 30, ok: true },
      { name: 'bash', args: '{"command":"x"}', ms: 30000, ok: false, note: '命令超时（30000ms）' },
      { name: 'read', args: '{"path":"d"}', ms: 5, ok: true },
    ],
    logs: [],
  })

  test('汇总是一行，带调用次数', () => {
    expect(body).toContain('调了 5 次工具')
  })

  test('同类工具按次数合并（glob×2）', () => {
    // 六次调用逐条铺开时，「这一轮到底调了什么」被淹没；合并后才有可扫读的一行。
    expect(body).toMatch(/glob×2/)
  })

  test('失败条数写进汇总', () => {
    expect(body).toMatch(/失败 1 条/)
  })

  test('失败条目仍单独列，带参数与原因', () => {
    // 参数与原因是模型下一步要改的地方，不能被汇总吃掉。
    expect(body).toMatch(/✗ bash/)
    expect(body).toContain('命令超时')
  })

  test('成功条目不再逐条铺开', () => {
    expect(body).not.toMatch(/✓ /)
  })

  test('全成功时只有一行汇总', () => {
    const clean = ptcResultBody({
      value: 'done',
      calls: [{ name: 'read', args: '{}', ms: 3, ok: true }],
      logs: [],
    })
    expect(clean).toContain('这一轮调了 1 次工具（read）')
    expect(clean).not.toContain('✗')
  })
})
