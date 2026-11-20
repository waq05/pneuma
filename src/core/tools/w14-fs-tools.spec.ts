/**
 * `core/tools/fs-tools.ts` 的补测（W14）：read 工具的图片分流、二进制拒读与字符硬顶。
 *
 * 三条都是「真文件才走得通」的分支，所以全部在 `createTempDir` 里造真文件：
 * 小图（走 data URL 附件）、超 6MB 的大图（拒）、带 NUL 的二进制（拒）、
 * 一百多行长文本（撞 `READ_MAX_CHARS` 字符顶，触发 withheld 说明）。
 *
 * 未覆盖面（明细里有、这里不造假）：write / edit 的 CAS 分支（182-183、249）需要在
 * `stat` 与写回之间由第三方改 mtime，不改源码没法稳定制造，见报告的不可测项。
 *
 * @module dsc/core/tools/w14-fs-tools.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/support/tmp-dir.js'
import type { ToolContext, ToolOutput } from '../tools.js'
import { createReadTool } from './fs-tools.js'

const DIR = createTempDir('dsc-w14-fs-')
const read = createReadTool()

/** 工具上下文：只填 read 真的会用的两个字段（其余按类型补个空）。 */
function ctx(cwd: string = DIR): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    sessionId: 'w14-fs-tools',
    sessionPath: join(cwd, 'session.jsonl'),
  } as unknown as ToolContext
}

/** 结果是不是图片附件形状。 */
function asOutput(value: string | ToolOutput): ToolOutput {
  if (typeof value === 'string') throw new Error(`期望图片附件输出，实际是文本：${value.slice(0, 80)}`)
  return value
}

describe('read：图片按扩展名分流', () => {
  test('小图整读成 data URL 附件，文本里说明类型与字节数', async () => {
    mkdirSync(DIR, { recursive: true })
    const file = join(DIR, 'tiny.png')
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
    const out = asOutput(await read.run({ path: file }, ctx()))
    expect(out.text).toContain('已加载图片')
    expect(out.text).toContain('image/png')
    expect(out.images?.[0]?.startsWith('data:image/png;base64,')).toBe(true)
  })

  test('超过 6MB 的图拒读，理由里点名上限', async () => {
    const file = join(DIR, 'huge.png')
    writeFileSync(file, Buffer.alloc(6 * 1024 * 1024 + 1))
    await expect(read.run({ path: file }, ctx())).rejects.toThrow(/超过 6MB 上限/)
  })
})

describe('read：二进制与字符硬顶', () => {
  test('带 NUL 字节的文件拒读，指向 bash + 格式工具', async () => {
    const file = join(DIR, 'blob.bin')
    writeFileSync(file, Buffer.from([0x61, 0x00, 0x62]))
    await expect(read.run({ path: file }, ctx())).rejects.toThrow(/二进制文件/)
  })

  test('超长输出在字符顶处截断，并教模型用 offset 续读', async () => {
    const file = join(DIR, 'long.txt')
    const line = 'x'.repeat(200)
    writeFileSync(file, Array.from({ length: 120 }, (_unused, index) => `${String(index)}-${line}`).join('\n'), 'utf8')
    const out = await read.run({ path: file }, ctx())
    expect(typeof out).toBe('string')
    expect(String(out)).toContain('字符上限')
    expect(String(out)).toContain('用 offset 续读')
  })
})
