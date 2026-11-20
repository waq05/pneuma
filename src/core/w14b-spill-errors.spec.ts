/**
 * `core/spill.ts` 的缺口补齐：落盘时的撞名重试与彻底建不出文件、扫目录时条目刚被删掉、
 * 清理时删不掉文件（权限/占用）。
 *
 * `node:fs` 的四个调用被包一层可替换实现（其余函数原样透传）：这几条分支要的是「os 报
 * EEXIST / lstat 失败 / unlink 失败」，在真盘上要么要制造并发竞态、要么要改 ACL。
 * 临时目录自己建、自己清；不 sleep、不碰 `~/.dsc`。
 *
 * @module dsc/core/w14b-spill-errors.spec
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'

/** 假实现的控制面：为 null = 透传真实现。 */
const control = vi.hoisted(() => ({
  openSync: null as null | ((...args: unknown[]) => number),
  lstatSync: null as null | ((...args: unknown[]) => unknown),
  unlinkSync: null as null | ((...args: unknown[]) => void),
  readdirSync: null as null | ((...args: unknown[]) => unknown),
  /** 真实现（工厂里记下来，用例里「第一次抛、第二次真写」时要用）。 */
  actualOpenSync: null as null | ((...args: unknown[]) => number),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  control.actualOpenSync = actual.openSync as unknown as (...args: unknown[]) => number
  return {
    ...actual,
    openSync: (...args: unknown[]) =>
      control.openSync === null
        ? (actual.openSync as unknown as (...args: unknown[]) => number)(...args)
        : control.openSync(...args),
    lstatSync: (...args: unknown[]) =>
      control.lstatSync === null
        ? (actual.lstatSync as unknown as (...args: unknown[]) => unknown)(...args)
        : control.lstatSync(...args),
    unlinkSync: (...args: unknown[]) => {
      if (control.unlinkSync === null) (actual.unlinkSync as unknown as (...args: unknown[]) => void)(...args)
      else control.unlinkSync(...args)
    },
    readdirSync: (...args: unknown[]) =>
      control.readdirSync === null
        ? (actual.readdirSync as unknown as (...args: unknown[]) => unknown)(...args)
        : control.readdirSync(...args),
  }
})

const ROOT = mkdtempSync(join(tmpdir(), 'dsc-w14b-spill-'))
let dir = ''

type Spill = typeof import('./spill.js')
let spill: Spill

beforeEach(async () => {
  spill = await import('./spill.js')
  dir = mkdtempSync(join(ROOT, 'run-'))
  control.openSync = null
  control.lstatSync = null
  control.unlinkSync = null
  control.readdirSync = null
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 })
})

/** 当前配置（目录指到本用例）。 */
function config(overrides: Record<string, unknown> = {}) {
  return { ...spill.SPILL_DEFAULTS, dir, ...overrides } as Parameters<typeof spill.writeSpill>[2]
}

describe('writeSpill：建文件撞名', () => {
  test('连续三次 EEXIST：重掷三次后响亮报错', () => {
    control.openSync = () => {
      throw Object.assign(new Error('文件已存在'), { code: 'EEXIST' })
    }
    expect(() => spill.writeSpill('s1', 'hi', config())).toThrow(/连续三次都没能建出溢出文件/)
  })

  test('第一次 EEXIST、第二次成功：照常落盘（撞名只是重掷）', () => {
    let call = 0
    control.openSync = (...args) => {
      call += 1
      if (call === 1) throw Object.assign(new Error('文件已存在'), { code: 'EEXIST' })
      return control.actualOpenSync!(...args)
    }
    const written = spill.writeSpill('s1', 'hello', config())
    expect(written.bytes).toBe(5)
    control.openSync = null
  })

  test('不是撞名的 IO 错误：原样抛给调用方（不重试）', () => {
    control.openSync = () => {
      throw Object.assign(new Error('拒绝访问'), { code: 'EACCES' })
    }
    expect(() => spill.writeSpill('s1', 'hi', config())).toThrow(/拒绝访问/)
  })
})

describe('listSpillFiles：目录边扫边变', () => {
  test('条目刚被删掉（lstat 抛错）：跳过这一项，不炸整次扫描', () => {
    control.readdirSync = () => ['ghost.log']
    control.lstatSync = () => {
      throw Object.assign(new Error('没有这个文件'), { code: 'ENOENT' })
    }
    expect(spill.listSpillFiles(dir)).toEqual([])
  })
})

describe('sweepSpillDir：删不掉的文件要记账', () => {
  test('按年龄与总量两轮都删不掉：记两条 failed，kept 计数不为负', () => {
    const old = join(dir, 'old.log')
    const big = join(dir, 'big.log')
    writeFileSync(old, 'x'.repeat(64), 'utf8')
    writeFileSync(big, 'y'.repeat(64), 'utf8')
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(old, tenDaysAgo, tenDaysAgo)
    control.unlinkSync = () => {
      throw Object.assign(new Error('被占用'), { code: 'EBUSY' })
    }
    const result = spill.sweepSpillDir(config({ retentionDays: 7, maxTotalBytes: 1 }))
    expect(result.removed).toEqual([])
    expect(result.failed).toHaveLength(2)
    expect(result.failed[0]?.reason).toContain('被占用')
    // 总量那轮删不掉的文件留在「还剩」里。
    expect(result.keptFiles).toBe(1)
    expect(result.keptBytes).toBe(64)
  })
})
