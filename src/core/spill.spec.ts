/**
 * 溢出落盘（`core/spill.ts`）：配置夹取、写文件与截断、回给模型的预览、目录清理。
 *
 * 全部在临时目录里跑；`mtime` 用 `utimesSync` 造旧的，不 sleep。
 *
 * @module dsc/core/spill.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  listSpillFiles,
  parseSpillConfig,
  spillPreview,
  spillText,
  SPILL_DEFAULTS,
  SPILL_RANGES,
  sweepSpillDir,
  writeSpill,
  type SpillConfig,
} from './spill.js'

let dir = ''

function config(overrides: Partial<SpillConfig> = {}): SpillConfig {
  return { ...SPILL_DEFAULTS, dir, ...overrides }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsc-spill-spec-'))
})

describe('parseSpillConfig', () => {
  test('缺省值；越界/类型错夹回范围与缺省', () => {
    expect(parseSpillConfig({}).thresholdChars).toBe(SPILL_DEFAULTS.thresholdChars)
    expect(parseSpillConfig({ thresholdChars: 1 }).thresholdChars).toBe(SPILL_RANGES.thresholdChars.min)
    expect(parseSpillConfig({ thresholdChars: 9_999_999 }).thresholdChars).toBe(SPILL_RANGES.thresholdChars.max)
    expect(parseSpillConfig({ keepLines: 0 }).keepLines).toBe(SPILL_RANGES.keepLines.min)
    expect(parseSpillConfig({ keepLines: 'many' }).keepLines).toBe(SPILL_DEFAULTS.keepLines)
    expect(parseSpillConfig({ maxTotalBytes: 1 }).maxTotalBytes).toBe(SPILL_RANGES.maxTotalBytes.min)
    expect(parseSpillConfig({ retentionDays: 0 }).retentionDays).toBe(SPILL_RANGES.retentionDays.min)
  })

  test('dir 支持 ~ 展开；空串落回缺省', () => {
    expect(parseSpillConfig({ dir: '~' }).dir).not.toBe('~')
    expect(parseSpillConfig({ dir: '   ' }).dir).toBe(SPILL_DEFAULTS.dir)
    expect(parseSpillConfig({ dir }).dir).toBe(dir)
  })
})

describe('writeSpill', () => {
  test('小文本：原样落盘，不截断', () => {
    const written = writeSpill('session/1', 'a\nb\nc\n', config())
    expect(existsSync(written.path)).toBe(true)
    expect(readFileSync(written.path, 'utf8')).toBe('a\nb\nc\n')
    expect(written).toMatchObject({ truncated: false, keptLines: 4, totalLines: 4 })
    expect(written.bytes).toBeGreaterThan(0)
    expect(written.path).toContain(dir)
    // 会话 id 里的路径穿越字符被换掉，文件名不越出目录。
    expect(written.path).not.toContain('session/1')
  })

  test('超过单文件上限：按整行截断并写明', () => {
    const text = Array.from({ length: 200 }, (_, index) => `line-${String(index)}-${'x'.repeat(20)}`).join('\n')
    const written = writeSpill('s1', text, config({ maxBytes: 400 }))
    expect(written.truncated).toBe(true)
    expect(written.keptLines).toBeLessThan(written.totalLines)
    const body = readFileSync(written.path, 'utf8')
    expect(body).toContain('超过单文件上限')
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(400)
  })
})

describe('spillPreview', () => {
  test('头尾各留 keepLines，中间省略行数写清楚，续读 offset 接着头之后', () => {
    const text = Array.from({ length: 10 }, (_, index) => `L${String(index)}`).join('\n')
    const preview = spillPreview('/tmp/out.log', text, config({ keepLines: 2, readChunkLines: 5 }))
    expect(preview).toContain('L0\nL1')
    expect(preview).toContain('L8\nL9')
    expect(preview).toContain('中间省略 6 行')
    expect(preview).toContain('offset=3')
    expect(preview).toContain('limit=5')
    expect(preview).toContain('[完整输出已落盘：/tmp/out.log')
  })

  test('行数不到两倍 keepLines：全部显示，不写省略', () => {
    const preview = spillPreview('/tmp/out.log', 'a\nb\nc', config({ keepLines: 5 }))
    expect(preview).toContain('a\nb\nc')
    expect(preview).not.toContain('省略')
  })

  test('文件本身被截断：只显示开头，并说明盘里只有前 N 行', () => {
    const text = Array.from({ length: 100 }, (_, index) => `L${String(index)}`).join('\n')
    const written = { path: '/tmp/out.log', bytes: 10, truncated: true, keptLines: 3, totalLines: 100 }
    const preview = spillPreview('/tmp/out.log', text, config({ keepLines: 5 }), written)
    expect(preview).toContain('L0')
    expect(preview).not.toContain('L99')
    expect(preview).toContain('文件本身按')
    expect(preview).toContain('只写了前 3 行')
  })
})

describe('listSpillFiles / sweepSpillDir', () => {
  test('目录不存在返回空；只收普通文件（子目录不算）', () => {
    expect(listSpillFiles(join(dir, 'missing'))).toEqual([])
    writeFileSync(join(dir, 'a.log'), 'x')
    mkdirSync(join(dir, 'sub'))
    expect(listSpillFiles(dir).map((file) => file.path)).toEqual([join(dir, 'a.log')])
  })

  test('保留天数：旧的删、新的留；keepPath 怎么都不删', () => {
    const old = join(dir, 'old.log')
    const fresh = join(dir, 'fresh.log')
    writeFileSync(old, 'old')
    writeFileSync(fresh, 'fresh')
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(old, tenDaysAgo, tenDaysAgo)

    const swept = sweepSpillDir(config({ retentionDays: 7 }), old)
    expect(swept.removed).not.toContain(old)
    expect(swept.keptFiles).toBe(2)
    expect(existsSync(fresh)).toBe(true)

    const withoutKeep = sweepSpillDir(config({ retentionDays: 7 }))
    expect(withoutKeep.removed).toContain(old)
    expect(withoutKeep.removedBytes).toBeGreaterThan(0)
    expect(existsSync(old)).toBe(false)
  })

  test('总量上限：从最旧的开始删到落回上限内', () => {
    const paths: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const path = join(dir, `f${String(index)}.log`)
      writeFileSync(path, 'x'.repeat(10))
      const at = new Date(Date.now() - (10 - index) * 1_000)
      utimesSync(path, at, at)
      paths.push(path)
    }
    const swept = sweepSpillDir(config({ maxTotalBytes: 20, retentionDays: 3650 }))
    // 4×10 字节 → 删最旧的两份，剩两份正好 20。
    expect(swept.removed).toEqual([paths[0], paths[1]])
    expect(swept.keptFiles).toBe(2)
    expect(swept.keptBytes).toBe(20)
  })
})

describe('spillText', () => {
  test('先落盘再给预览；预览指向真实文件', () => {
    const text = Array.from({ length: 8 }, (_, index) => `row${String(index)}`).join('\n')
    const { text: preview, written } = spillText('s1', text, config({ keepLines: 2 }))
    expect(existsSync(written.path)).toBe(true)
    expect(readFileSync(written.path, 'utf8')).toBe(text)
    expect(preview).toContain(written.path)
    expect(preview).toContain('row0')
  })
})
