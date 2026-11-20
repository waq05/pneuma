/**
 * `read_image` 工具的分支补齐（覆盖率）：`packages/tools-default/image-tool.ts` 的
 * run 里四道闸——读禁路径、非图片扩展名、超 6MB、正常加载——原先整段没进过测试。
 *
 * 全部在临时目录造文件，不读真实 HOME；图片字节用 1×1 PNG 头，内容是什么不重要，
 * 工具只做 base64 透传。
 *
 * @module @pneuma/tools-default/tests/image-tool-branches
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { ToolContext, ToolOutput } from '../../../core/tools.js'
import { readImageTool } from '../image-tool.js'

/** `run` 的返回是「纯文本或结构化输出」；这几条用例走的是带图片附件的那一支。 */
function outputOf(result: string | ToolOutput): ToolOutput {
  if (typeof result === 'string') throw new Error(`期望带图片附件的结构化输出，实际是纯文本：${result}`)
  return result
}

let root = ''
let ctx: ToolContext

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsc-image-tool-'))
  ctx = {
    cwd: root,
    signal: new AbortController().signal,
    sessionId: 'image-tool-spec',
    sessionPath: join(root, 'session.jsonl'),
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** PNG 文件头 + 一点数据：工具不做解码，只认扩展名与大小。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

test('正常图片：返回图片附件（data URL，MIME 按扩展名）', async () => {
  const file = join(root, 'tiny.png')
  await writeFile(file, PNG_BYTES)
  const result = outputOf(await readImageTool.run({ path: file }, ctx))
  expect(result.text).toContain('已加载图片')
  expect(result.text).toContain('image/png')
  expect(result.text).toContain(String(PNG_BYTES.length))
  expect(result.images).toHaveLength(1)
  expect(result.images?.[0]).toBe(`data:image/png;base64,${PNG_BYTES.toString('base64')}`)
})

test('扩展名大小写不敏感；相对路径按 cwd 解析', async () => {
  await writeFile(join(root, 'SHOT.JPEG'), PNG_BYTES)
  const result = outputOf(await readImageTool.run({ path: 'SHOT.JPEG' }, ctx))
  expect(result.images?.[0]).toMatch(/^data:image\/jpeg;base64,/)
})

test('非图片扩展名：拒绝并指路 shell', async () => {
  const file = join(root, 'notes.txt')
  await writeFile(file, 'hello')
  await expect(readImageTool.run({ path: file }, ctx)).rejects.toThrow(/只接受图片/)
})

test('读禁路径（.env）：先撞路径策略，不落盘读取', async () => {
  await expect(readImageTool.run({ path: join(root, '.env') }, ctx)).rejects.toThrow(/禁止读取 \.env/)
})

test('超过 6MB：拒绝并给出压缩建议', async () => {
  const file = join(root, 'huge.png')
  // 6MB + 1：只超过上限 1 字节，边界最省内存。
  await writeFile(file, Buffer.alloc(6 * 1024 * 1024 + 1))
  await expect(readImageTool.run({ path: file }, ctx)).rejects.toThrow(/超过 6MB 上限/)
  expect((await stat(file)).size).toBeGreaterThan(6 * 1024 * 1024)
})

test('刚好 6MB：放行（上限是「超过」才拒）', async () => {
  const file = join(root, 'edge.png')
  await writeFile(file, Buffer.alloc(6 * 1024 * 1024))
  const result = outputOf(await readImageTool.run({ path: file }, ctx))
  expect(result.images?.[0]).toMatch(/^data:image\/png;base64,/)
})
