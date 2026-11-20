/**
 * 溢出落盘（`core/spill.ts`）的补充：单行就超上限时按 UTF-8 码点切（`sliceUtf8`），
 * 多字节字符不被切成半个。
 *
 * @module dsc/core/w12-spill-slice.spec
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SPILL_DEFAULTS, writeSpill, type SpillConfig } from './spill.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsc-spill-slice-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function config(overrides: Partial<SpillConfig> = {}): SpillConfig {
  return { ...SPILL_DEFAULTS, dir, maxBytes: 4_096, ...overrides }
}

describe('单行超上限的切法', () => {
  test('纯 ASCII 单行：切在字节预算上，末尾写截断说明', () => {
    const text = 'a'.repeat(6_000)
    const written = writeSpill('slice-ascii', text, config())
    expect(written.truncated).toBe(true)
    expect(written.keptLines).toBe(1)
    expect(written.totalLines).toBe(1)
    const body = readFileSync(written.path, 'utf8')
    // 4096 字节上限先扣掉 256 字节说明预算 → 正文 3840 字符
    expect(body.startsWith('a'.repeat(3_840))).toBe(true)
    expect(body).toContain('超过单文件上限')
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(3_840)
  })

  test('多字节字符：只按完整码点切，文件里没有半个汉字', () => {
    const text = '你'.repeat(2_000) // 6000 字节
    const written = writeSpill('slice-utf8', text, config())
    expect(written.truncated).toBe(true)
    const body = readFileSync(written.path, 'utf8')
    const noteIndex = body.indexOf('…（超过单文件上限')
    expect(noteIndex).toBeGreaterThan(0)
    const head = body.slice(0, noteIndex).replace(/\n$/, '')
    // 1280 个汉字 = 3840 字节，恰好用完正文预算；替换字符（U+FFFD）说明切坏了。
    expect(head).toBe('你'.repeat(1_280))
    expect(head).not.toContain('\uFFFD')
  })

  test('整段仍在预算内时不走切分：原文逐字落盘', () => {
    const text = 'single-line-without-newline'
    const written = writeSpill('slice-small', text, config())
    expect(written.truncated).toBe(false)
    expect(readFileSync(written.path, 'utf8')).toBe(text)
  })
})
