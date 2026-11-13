/**
 * harness 的 unit 层用例：只碰临时目录、本机回环假端点与 golden 文件。
 *
 * 真内核与真入口（`bootKernel` / `runCli`）放在同目录的 `harness.int.spec.ts`：
 * 它们要起真进程与插件图，unit 层 5 秒预算与「不碰真内核」的规矩都容不下。
 *
 * @module dsc/tests/harness.spec
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readSessionJsonl, tempHome } from './harness.js'

/** 清理栈：每条用例自己登记，红了也照样在 afterEach 里执行。 */
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** golden 测试会真的往 `tests/snapshots/golden/` 写文件；目录原先不存在时连目录一起收掉。 */
const GOLDEN_DIR = join(process.cwd(), 'tests', 'snapshots', 'golden')
const GOLDEN_DIR_EXISTED = existsSync(GOLDEN_DIR)

/** 删掉一条自测 golden；目录是本条用例新建的且空了，就顺手删目录，避免 untracked 噪声。 */
function cleanGolden(name: string): void {
  rmSync(join(GOLDEN_DIR, `${name}.txt`), { force: true })
  if (!GOLDEN_DIR_EXISTED) {
    try {
      rmSync(GOLDEN_DIR, { recursive: false })
    } catch {
      // 目录里还有别的 golden（并发或上一轮没清干净）就留着，删失败不是测试失败。
    }
  }
}

/** 每条用例独立的临时工作目录。 */
let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dsc-harness-unit-'))
  cleanups.push(() => {
    rmSync(work, { recursive: true, force: true })
  })
})

describe('tempHome', () => {
  test('把 HOME 与 USERPROFILE 同时指向新建的临时目录', () => {
    // 只改一个在另一个平台上就是「没隔离」；两个都断言，漏改一个立刻红。
    const created = tempHome()
    cleanups.push(() => {
      created.restore()
      rmSync(created.home, { recursive: true, force: true })
    })
    expect(existsSync(created.home)).toBe(true)
    expect(created.home.startsWith(tmpdir())).toBe(true)
    expect(process.env.HOME).toBe(created.home)
    expect(process.env.USERPROFILE).toBe(created.home)
  })

  test('restore 还原成调用前的值，临时目录保留（不是删掉）', () => {
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    const created = tempHome()
    created.restore()
    expect(process.env.HOME).toBe(before.HOME)
    expect(process.env.USERPROFILE).toBe(before.USERPROFILE)
    // 失败时目录要留着翻日志；这里只验证 restore 没删它，随后由用例自己收尾。
    expect(existsSync(created.home)).toBe(true)
    rmSync(created.home, { recursive: true, force: true })
  })

  test('restore 可重复调用：afterEach 与 afterAll 同时注册也不会改坏环境', () => {
    const created = tempHome()
    created.restore()
    const afterFirst = process.env.HOME
    created.restore()
    expect(process.env.HOME).toBe(afterFirst)
    rmSync(created.home, { recursive: true, force: true })
  })

  test('前缀带路径分隔符或 ".." 时拒绝：否则目录会建到临时目录外面', () => {
    expect(() => tempHome('../escape-')).toThrow(/路径分隔符|\.\./)
    expect(() => tempHome('a/b-')).toThrow(/路径分隔符/)
    expect(() => tempHome('')).toThrow(/非空字符串/)
  })
})

describe('readSessionJsonl', () => {
  test('跳过空行、坏行与非对象行，返回对象数组', () => {
    const file = join(work, 'session.jsonl')
    // 首行带 BOM、中间混入半截 JSON 与数组/数字：三种都不是会话记录，应该被剥掉。
    writeFileSync(
      file,
      '\uFEFF{"type":"meta","id":"m1"}\n\n{"type":"user","text":"hi"}\nnot-json\n[1,2]\n42\n{"type":"tool","callId":"c1"}\n',
      'utf8',
    )
    const records = readSessionJsonl(file)
    expect(records.map((record) => record.type)).toEqual(['meta', 'user', 'tool'])
  })

  test('文件不存在时抛可读错误，而不是返回空数组（空数组会让「没有 X」恒真）', () => {
    expect(() => readSessionJsonl(join(work, 'missing.jsonl'))).toThrow(/读不到会话文件/)
  })

  test('路径不是非空字符串时拒绝', () => {
    expect(() => readSessionJsonl('')).toThrow(/非空字符串/)
    expect(() => readSessionJsonl(undefined as never)).toThrow(/非空字符串/)
  })
})

