/**
 * 输入区附件（`packages/ui-composer/ui/attachments.ts`）：类型判定、名字兜底、上传协议、提交拆包。
 *
 * 上传用假 XMLHttpRequest（真浏览器的上传进度与错误分支都在这里）：不碰网络。
 * 图片重编码要走 canvas/createImageBitmap，归浏览器快照层；这里只钉「进来就先拦」的两条。
 *
 * @module dsc/packages/ui-composer/ui/attachments.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
  composeSubmit,
  displayNameOf,
  kindOf,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  newAttachmentId,
  normalizeImage,
  uploadFile,
} from './attachments.js'
import type { AttachmentMeta, DraftAttachment } from './draft.js'

/** 造一个 File（jsdom 与 Node 都有 File）。 */
function file(name: string, type: string, content = 'x'): File {
  return new File([content], name, { type })
}

function meta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    sha: 'sha-1',
    kind: 'file',
    name: 'f.txt',
    mime: 'text/plain',
    bytes: 1,
    url: '/api/attachments/sha-1',
    path: 'f.txt',
    ...overrides,
  }
}

const originalXhr = globalThis.XMLHttpRequest

afterEach(() => {
  globalThis.XMLHttpRequest = originalXhr
})

/** 可控的假 XHR：记录请求，测试自己触发回调。 */
class FakeXhr {
  static last: FakeXhr | null = null
  method = ''
  url = ''
  body: unknown = null
  status = 0
  responseText = ''
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() {
    FakeXhr.last = this
  }
  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }
  send(body: unknown): void {
    this.body = body
  }
}

function installXhr(): void {
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
}

describe('类型与命名', () => {
  test('kindOf 按 MIME 粗分三类', () => {
    expect(kindOf(file('a.png', 'image/png'))).toBe('image')
    expect(kindOf(file('a.mp4', 'video/mp4'))).toBe('video')
    expect(kindOf(file('a.pdf', 'application/pdf'))).toBe('file')
    expect(kindOf(file('a.txt', ''))).toBe('file')
  })

  test('displayNameOf：有名字就用；剪贴板截图没名字才兜底', () => {
    expect(displayNameOf(file('report.pdf', 'application/pdf'), 'file')).toBe('report.pdf')
    expect(displayNameOf(file('', 'image/png'), 'image')).toMatch(/图片|image/i)
    expect(displayNameOf(file('', 'video/mp4'), 'video')).toMatch(/视频|video/i)
    expect(displayNameOf(file('', 'application/pdf'), 'file')).toMatch(/附件|file/i)
  })

  test('newAttachmentId：形状固定、连发不撞', () => {
    const ids = Array.from({ length: 20 }, () => newAttachmentId())
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^attach-\d+-\d+$/)
  })
})

describe('uploadFile：XHR 上传协议', () => {
  test('成功：POST 到 /api/attachments?name=…，进度与元数据都回来', async () => {
    installXhr()
    const progress: number[] = []
    const promise = uploadFile(file('a.txt', 'text/plain'), 'a b.txt', (ratio) => progress.push(ratio))
    const xhr = FakeXhr.last!
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/attachments?name=a%20b.txt')
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 3, total: 4 })
    xhr.status = 200
    xhr.responseText = JSON.stringify({ ok: true, attachment: meta() })
    xhr.onload!()
    await expect(promise).resolves.toEqual(meta())
    expect(progress).toEqual([0.75])
  })

  test('服务端给了 error 就原样抛；没给就用 HTTP 状态码', async () => {
    installXhr()
    const first = uploadFile(file('a.txt', 'text/plain'), 'a.txt')
    const xhr = FakeXhr.last!
    xhr.status = 400
    xhr.responseText = JSON.stringify({ ok: false, error: '文件名不合法' })
    xhr.onload!()
    await expect(first).rejects.toThrow('文件名不合法')

    const second = uploadFile(file('a.txt', 'text/plain'), 'a.txt')
    const xhr2 = FakeXhr.last!
    xhr2.status = 500
    xhr2.responseText = 'not json'
    xhr2.onload!()
    await expect(second).rejects.toThrow(/500/)
  })

  test('ok 但元数据缺字段 / kind 不认识：按失败处理', async () => {
    installXhr()
    const bad = uploadFile(file('a.txt', 'text/plain'), 'a')
    const xhr = FakeXhr.last!
    xhr.status = 200
    xhr.responseText = JSON.stringify({ ok: true, attachment: { ...meta(), kind: 'weird' } })
    xhr.onload!()
    await expect(bad).rejects.toThrow()
  })

  test('网络错 / 超时 / 取消各给一句话', async () => {
    installXhr()
    const network = uploadFile(file('a', 'text/plain'), 'a')
    FakeXhr.last!.onerror!()
    await expect(network).rejects.toThrow()

    const timeout = uploadFile(file('a', 'text/plain'), 'a')
    FakeXhr.last!.ontimeout!()
    await expect(timeout).rejects.toThrow()

    const aborted = uploadFile(file('a', 'text/plain'), 'a')
    FakeXhr.last!.onabort!()
    await expect(aborted).rejects.toThrow()
  })
})

describe('normalizeImage：先拦两种情况', () => {
  test('超过 20MiB 的图片直接拒', async () => {
    const big = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'big.png', { type: 'image/png' })
    await expect(normalizeImage(big)).rejects.toThrow()
  })

  test('既不是图片 MIME、扩展名也不对：拒', async () => {
    await expect(normalizeImage(file('a.exe', 'application/octet-stream'))).rejects.toThrow()
    await expect(normalizeImage(file('a.txt', ''))).rejects.toThrow()
  })
})

describe('composeSubmit：两列拆包与 20 张预算', () => {
  function draft(overrides: Partial<DraftAttachment>): DraftAttachment {
    return {
      id: newAttachmentId(),
      kind: 'file',
      name: 'f.txt',
      mime: 'text/plain',
      bytes: 1,
      meta: meta(),
      previewUrl: '/api/attachments/sha-1',
      frames: [],
      uploading: null,
      error: null,
      ...overrides,
    }
  }

  test('图片进 images、视频与文件进 files，视频帧挂在它自己那条上', () => {
    const payload = composeSubmit([
      draft({ kind: 'image', meta: meta({ kind: 'image', url: '/img/1' }) }),
      draft({ kind: 'video', meta: meta({ kind: 'video', sha: 'v', name: 'v.mp4', mime: 'video/mp4' }), frames: ['/f/1', '/f/2'] }),
      draft({ kind: 'file', meta: meta({ sha: 'd', name: 'd.pdf' }) }),
      draft({ meta: null }),
    ])
    expect(payload.images).toEqual(['/img/1'])
    expect(payload.dropped).toBe(0)
    expect(payload.files).toHaveLength(2)
    expect(payload.files[0]).toMatchObject({ sha: 'v', kind: 'video', frames: ['/f/1', '/f/2'] })
    expect(payload.files[1]).toMatchObject({ sha: 'd', kind: 'file' })
    expect(payload.files[1]).not.toHaveProperty('frames')
  })

  test('图片超过 20 张：从后面截，并交回丢了几张', () => {
    const images = Array.from({ length: MAX_IMAGES + 3 }, (_, index) =>
      draft({ kind: 'image', meta: meta({ kind: 'image', sha: `s${String(index)}`, url: `/img/${String(index)}` }) }),
    )
    const payload = composeSubmit(images)
    expect(payload.images).toHaveLength(MAX_IMAGES)
    expect(payload.dropped).toBe(3)
    expect(payload.images.at(-1)).toBe(`/img/${String(MAX_IMAGES - 1)}`)
  })

  test('帧也占图片预算：先砍帧，用户自己贴的图优先', () => {
    const two = Array.from({ length: 2 }, (_, index) =>
      draft({ kind: 'image', meta: meta({ kind: 'image', url: `/img/${String(index)}` }) }),
    )
    const frames = Array.from({ length: 25 }, (_, index) => `/frame/${String(index)}`)
    const payload = composeSubmit([
      ...two,
      draft({ kind: 'video', meta: meta({ kind: 'video', sha: 'v' }), frames }),
      draft({ kind: 'video', meta: meta({ kind: 'video', sha: 'w' }), frames: ['/f/a', '/f/b'] }),
    ])
    expect(payload.images).toHaveLength(2)
    expect(payload.dropped).toBe(2 + 25 + 2 - MAX_IMAGES)
    // 预算 18：第一条视频留 18 帧，第二条视频一帧也不留（frames 字段整个去掉）。
    expect(payload.files[0]!.frames).toHaveLength(18)
    expect(payload.files[1]).not.toHaveProperty('frames')
  })
})
