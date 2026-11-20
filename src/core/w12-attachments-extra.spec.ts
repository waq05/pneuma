/**
 * 附件仓库（`core/attachments.ts`）的分支补齐：RIFF 家族的 webp/avi 嗅探、
 * 图片 MIME 判定、扩展名判定、流式落盘的四道闸（声明超限 / 空文件 / 读取中出错 /
 * 类型上限）与 mimeOf 的缺文件路径。
 *
 * 全部落在临时目录；20MB 上限用 Buffer.alloc 造，不读真实文件。
 *
 * @module dsc/core/w12-attachments-extra.spec
 */
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  AttachmentStore,
  isImageMime,
  looksLikeImage,
  looksLikeVideo,
  MAX_IMAGE_BYTES,
  sniffMedia,
} from './attachments.js'

let dir = ''
let store: AttachmentStore

/** 1×1 PNG 的字节头就够嗅探（工具只读前 64 字节）。 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsc-w12-attach-'))
  store = new AttachmentStore({ root: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 造一个最小 IncomingMessage 替身：只用到 async 迭代与 headers。 */
function fakeRequest(chunks: readonly Buffer[], headers: Record<string, string> = {}): Parameters<AttachmentStore['saveStream']>[0] {
  const stream = Readable.from(chunks)
  return Object.assign(stream, { headers }) as unknown as Parameters<AttachmentStore['saveStream']>[0]
}

describe('sniffMedia 的 RIFF 家族', () => {
  test('RIFF+WEBP 认成图片、RIFF+AVI 认成视频；别的 RIFF 退回文件', () => {
    const riff = (form: string): Buffer => {
      const head = Buffer.alloc(16)
      head.write('RIFF', 0, 'ascii')
      head.write(form, 8, 'ascii')
      return head
    }
    expect(sniffMedia(riff('WEBP'))).toEqual({ kind: 'image', mime: 'image/webp' })
    expect(sniffMedia(riff('AVI '))).toEqual({ kind: 'video', mime: 'video/x-msvideo' })
    expect(sniffMedia(riff('WAVE')).kind).toBe('file')
  })
})

describe('MIME 与扩展名判定', () => {
  test('isImageMime 只认四种可进请求体的图片', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/gif')).toBe(true)
    expect(isImageMime('image/svg+xml')).toBe(false)
    expect(isImageMime('video/mp4')).toBe(false)
  })

  test('looksLikeImage / looksLikeVideo 按扩展名、大小写不敏感', () => {
    expect(looksLikeImage('a.PNG')).toBe(true)
    expect(looksLikeImage('a.webp')).toBe(true)
    expect(looksLikeImage('a.txt')).toBe(false)
    expect(looksLikeVideo('a.MP4')).toBe(true)
    expect(looksLikeVideo('a.mkv')).toBe(true)
    expect(looksLikeVideo('a.png')).toBe(false)
  })
})

describe('AttachmentStore.save', () => {
  test('dir 暴露仓库根；同一字节第二次复用同一对象', () => {
    expect(store.dir).toBe(dir)
    const first = store.save('a.png', PNG)
    expect(first.kind).toBe('image')
    expect(store.has(first.sha)).toBe(true)
    const second = store.save('b.png', PNG)
    expect(second.sha).toBe(first.sha)
  })

  test('空文件与超大图片都被拒', () => {
    expect(() => store.save('empty.png', Buffer.alloc(0))).toThrow(/空文件不能作为附件/)
    // 带 PNG 头才算图片（否则按普通文件的 200MB 上限判，就撞不到 20MB 这条闸）。
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES + 1 - PNG.length)])
    expect(() => store.save('huge.png', huge)).toThrow(/超过 20/)
  })

  test('mimeOf：对象不存在时返回 null（不抛）', async () => {
    await expect(store.mimeOf('0'.repeat(64))).resolves.toBeNull()
  })
})

describe('AttachmentStore.saveStream 的四道闸', () => {
  test('正常小文件：流式落盘并给出 meta', async () => {
    const meta = await store.saveStream(fakeRequest([PNG]), 'a.png')
    expect(meta.kind).toBe('image')
    expect(store.has(meta.sha)).toBe(true)
  })

  test('content-length 声明就超限：读之前直接拒', async () => {
    const req = fakeRequest([PNG], { 'content-length': String(200 * 1024 * 1024 + 1) })
    await expect(store.saveStream(req, 'huge.bin')).rejects.toThrow(/超过/)
  })

  test('空流：拒绝并清掉临时文件', async () => {
    await expect(store.saveStream(fakeRequest([]), 'empty.bin')).rejects.toThrow(/空文件不能作为附件/)
  })

  test('读取中途出错：关句柄、删临时文件、原样抛错', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('上传连接断了'))
      },
    })
    const req = Object.assign(broken, { headers: {} }) as unknown as Parameters<AttachmentStore['saveStream']>[0]
    await expect(store.saveStream(req, 'broken.bin')).rejects.toThrow('上传连接断了')
  })
})
