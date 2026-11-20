/**
 * 附件纯逻辑的补盲（`packages/ui-composer/ui/attachments.ts`）：图片规范化、视频抽帧、上传回包。
 *
 * 覆盖的都是原来没走到的分支：
 * - `normalizeImage`：缩图后 canvas 编码（透明 → WebP、不透明 → JPEG 三档降质）、
 *   获取不到 2D 上下文、编码返回 null、压缩后仍超 4MiB 三条错误路径；
 * - `extractVideoFrames`：坏源、时长读不到、seek 失败、取不到帧尺寸 / 上下文这些「尽力而为」分支；
 * - `uploadFile`：回包 `ok` 但元数据缺字段（`path` 缺失）按失败处理。
 *
 * jsdom 没有 canvas 布局与媒体解码：这里把 `createImageBitmap` / `canvas.getContext` /
 * `canvas.toBlob` 与 `<video>` 元素换成可控替身，被测函数本身一行不 mock。
 *
 * @module dsc/packages/ui-composer/ui/w12-attachments.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { extractVideoFrames, normalizeImage, uploadFile } from './attachments.js'

const TARGET_IMAGE_BYTES = 4 * 1024 * 1024

/** 造一个 File。 */
function file(name: string, type: string, content = 'x'): File {
  return new File([content], name, { type })
}

/** 指定字节数的 Blob（用来卡 4MiB 阈值）。 */
function blobOf(bytes: number, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(bytes)], { type })
}

/** 假 2D 上下文：只实现被测代码用到的那两个方法。 */
interface FakeContext {
  drawImage: ReturnType<typeof vi.fn>
  getImageData: ReturnType<typeof vi.fn>
}

/** 假 ImageBitmap。 */
interface FakeBitmap {
  width: number
  height: number
  close: ReturnType<typeof vi.fn>
}

let bitmap: FakeBitmap
let context: FakeContext | null
let toBlobQueue: Array<Blob | null>
let realCreate: typeof document.createElement
let canvasCalls: Array<{ width: number; height: number; quality: number | undefined; type: string }>
let videos: FakeVideo[]

/** `<video>` 的替身：真 div 挂上媒体属性，seek 用真事件派发。 */
// 用例只借 DOM 节点能力（appendChild / addEventListener），节点本身用 div 造；
// 这里额外摆上 video 专属的四个字段（muted / playsInline / preload / crossOrigin），
// 所以显式声明在接口里，而不是直接 extends HTMLVideoElement（会与 mock 的 load/pause 冲突）。
interface FakeVideo extends HTMLDivElement {
  muted: boolean
  playsInline: boolean
  preload: string
  crossOrigin: string
  duration: number
  videoWidth: number
  videoHeight: number
  currentTime: number
  pause: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  remove: () => void
  onloadedmetadata: (() => void) | null
  onerror: (() => void) | null
  seekTimes: number[]
  throwOnSeek: boolean
}

/** 造一个假 video（真 DOM 节点，能 appendChild、能 addEventListener）。 */
function makeVideo(): FakeVideo {
  const element = realCreate('div') as unknown as FakeVideo
  let time = 0
  element.muted = true
  element.playsInline = true
  element.preload = ''
  element.crossOrigin = ''
  element.pause = vi.fn()
  element.load = vi.fn()
  element.remove = vi.fn()
  element.duration = 0
  element.videoWidth = 0
  element.videoHeight = 0
  element.onloadedmetadata = null
  element.onerror = null
  element.seekTimes = []
  element.throwOnSeek = false
  Object.defineProperty(element, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      if (element.throwOnSeek) throw new Error('seek 失败')
      time = value
      element.seekTimes.push(value)
      element.dispatchEvent(new Event('seeked'))
    },
  })
  videos.push(element)
  return element
}

beforeEach(() => {
  realCreate = document.createElement.bind(document)
  videos = []
  canvasCalls = []
  toBlobQueue = []
  bitmap = { width: 4000, height: 2000, close: vi.fn() }
  context = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) })),
  }
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  )
  vi.spyOn(HTMLCanvasElement.prototype as unknown as { getContext: () => FakeContext | null }, 'getContext').mockImplementation(
    () => context,
  )
  vi.spyOn(
    HTMLCanvasElement.prototype as unknown as {
      toBlob: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void
    },
    'toBlob',
  ).mockImplementation(function mockToBlob(
    this: HTMLCanvasElement,
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number,
  ): void {
    canvasCalls.push({ width: this.width, height: this.height, quality, type: type ?? '' })
    callback(toBlobQueue.shift() ?? null)
  })
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') return makeVideo()
    return realCreate(tag)
  }) as typeof document.createElement)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('normalizeImage：缩图后的 canvas 编码分支', () => {
  test('超长的不透明图缩到 2048 后走 JPEG 0.85', async () => {
    toBlobQueue = [blobOf(1024, 'image/jpeg')]
    const output = await normalizeImage(file('shot.png', 'image/png'))
    expect(output.type).toBe('image/jpeg')
    expect(context!.getImageData).toHaveBeenCalledWith(0, 0, 2048, 1024)
    expect(context!.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2048, 1024)
    expect(canvasCalls[0]).toMatchObject({ width: 2048, height: 1024, quality: 0.85, type: 'image/jpeg' })
  })

  test('带透明像素的图输出 WebP 0.85', async () => {
    context!.getImageData.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 254]) })
    toBlobQueue = [blobOf(1024, 'image/webp')]
    const output = await normalizeImage(file('logo.png', 'image/png'))
    expect(output.type).toBe('image/webp')
    expect(canvasCalls[0]).toMatchObject({ quality: 0.85, type: 'image/webp' })
  })

  test('WebP 仍超 4MiB：抛压缩错误', async () => {
    context!.getImageData.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 0]) })
    toBlobQueue = [blobOf(TARGET_IMAGE_BYTES + 1, 'image/webp')]
    await expect(normalizeImage(file('huge.png', 'image/png'))).rejects.toThrow()
  })

  test('拿不到 2D 上下文：抛错而不是静默产出空图', async () => {
    context = null
    await expect(normalizeImage(file('shot.png', 'image/png'))).rejects.toThrow()
  })

  test('WebP 编码返回 null：抛错', async () => {
    context!.getImageData.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 10]) })
    toBlobQueue = [null]
    await expect(normalizeImage(file('logo.png', 'image/png'))).rejects.toThrow()
  })

  test('JPEG 三档都超限：按 0.85 → 0.75 → 0.6 依次退，最后抛错', async () => {
    const tooBig = (): Blob => blobOf(TARGET_IMAGE_BYTES + 1, 'image/jpeg')
    toBlobQueue = [tooBig(), tooBig(), tooBig()]
    await expect(normalizeImage(file('shot.png', 'image/png'))).rejects.toThrow()
    expect(canvasCalls.map((call) => call.quality)).toEqual([0.85, 0.75, 0.6])
  })

  test('JPEG 第一档超限、第二档合格：返回 0.75 那一版', async () => {
    toBlobQueue = [blobOf(TARGET_IMAGE_BYTES + 1, 'image/jpeg'), blobOf(1024, 'image/jpeg')]
    const output = await normalizeImage(file('shot.png', 'image/png'))
    expect(output.type).toBe('image/jpeg')
    expect(canvasCalls.map((call) => call.quality)).toEqual([0.85, 0.75])
  })

  test('JPEG 源不扫像素、也不输出 WebP', async () => {
    toBlobQueue = [blobOf(1024, 'image/jpeg')]
    const output = await normalizeImage(file('photo.jpg', 'image/jpeg'))
    expect(output.type).toBe('image/jpeg')
    expect(context!.getImageData).not.toHaveBeenCalled()
  })

  test('扩展名是 .jpg 但 MIME 写成 png：按 JPEG 处理，不扫像素', async () => {
    toBlobQueue = [blobOf(1024, 'image/jpeg')]
    await normalizeImage(file('photo.jpg', 'image/png'))
    expect(context!.getImageData).not.toHaveBeenCalled()
  })

  test('WebP 源不透明：输出 JPEG', async () => {
    toBlobQueue = [blobOf(1024, 'image/jpeg')]
    const output = await normalizeImage(file('shot.webp', 'image/webp'))
    expect(output.type).toBe('image/jpeg')
  })

  test('GIF 只取第一帧：走 canvas 编码且可能带透明', async () => {
    context!.getImageData.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 128]) })
    toBlobQueue = [blobOf(1024, 'image/webp')]
    const output = await normalizeImage(file('anim.gif', 'image/gif'))
    expect(output.type).toBe('image/webp')
  })

  test('小尺寸常见格式原样返回（不重编码）', async () => {
    bitmap = { width: 100, height: 80, close: vi.fn() }
    const source = file('icon.png', 'image/png')
    const output = await normalizeImage(source)
    expect(output).toBe(source)
    expect(canvasCalls).toHaveLength(0)
  })
})

describe('uploadFile：回包元数据缺字段按失败处理', () => {
  /** 可控的假 XHR。 */
  class FakeXhr {
    static last: FakeXhr | null = null
    status = 0
    responseText = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    ontimeout: (() => void) | null = null
    onabort: (() => void) | null = null
    upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
      onprogress: null,
    }
    constructor() {
      FakeXhr.last = this
    }
    open(): void {}
    send(): void {}
  }

  const original = globalThis.XMLHttpRequest
  afterEach(() => {
    globalThis.XMLHttpRequest = original
  })

  test('ok:true 但 attachment 少了 path：整个上传按失败抛', async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
    const promise = uploadFile(file('a.txt', 'text/plain'), 'a.txt')
    const xhr = FakeXhr.last!
    xhr.status = 200
    xhr.responseText = JSON.stringify({
      ok: true,
      attachment: { sha: 's', kind: 'file', name: 'a.txt', mime: 'text/plain', bytes: 1, url: '/api/attachments/s' },
    })
    xhr.onload!()
    await expect(promise).rejects.toThrow()
  })
})

describe('extractVideoFrames：尽力而为的抽帧', () => {
  test('正常：按 count 均匀 seek，并把每帧缩到最长边 1280', async () => {
    toBlobQueue = [blobOf(10), blobOf(10), blobOf(10)]
    const promise = extractVideoFrames('http://host/api/attachments/v', 3)
    const video = videos.at(-1)!
    video.duration = 30
    video.videoWidth = 1920
    video.videoHeight = 1080
    video.onloadedmetadata!()
    const frames = await promise
    expect(frames).toHaveLength(3)
    expect(video.seekTimes).toEqual([5, 15, 25])
    expect(canvasCalls[0]).toMatchObject({ width: 1280, height: 720, type: 'image/jpeg' })
  })

  test('时长读不到（0）：不抽帧、也不抛', async () => {
    const promise = extractVideoFrames('http://host/api/attachments/v')
    const video = videos.at(-1)!
    video.duration = 0
    video.onloadedmetadata!()
    await expect(promise).resolves.toEqual([])
  })

  test('源加载失败：返回空数组，finish 重复调用只收一次', async () => {
    const promise = extractVideoFrames('http://host/api/attachments/v')
    const video = videos.at(-1)!
    video.onerror!()
    video.onerror!()
    await expect(promise).resolves.toEqual([])
    expect(video.remove).toHaveBeenCalledTimes(1)
  })

  test('count 为 0：直接返回空数组（不碰 DOM）', async () => {
    await expect(extractVideoFrames('http://host/api/attachments/v', 0)).resolves.toEqual([])
    expect(videos).toHaveLength(0)
  })

  test('seek 抛错：停在原地收工，不把异常抛给调用方', async () => {
    const promise = extractVideoFrames('http://host/api/attachments/v', 3)
    const video = videos.at(-1)!
    video.duration = 30
    video.videoWidth = 640
    video.videoHeight = 360
    video.throwOnSeek = true
    video.onloadedmetadata!()
    await expect(promise).resolves.toEqual([])
    expect(canvasCalls).toHaveLength(0)
  })

  test('取不到视频尺寸：这一帧返回 null，继续下一帧', async () => {
    const promise = extractVideoFrames('http://host/api/attachments/v', 2)
    const video = videos.at(-1)!
    video.duration = 10
    video.videoWidth = 0
    video.videoHeight = 0
    video.onloadedmetadata!()
    await expect(promise).resolves.toEqual([])
    expect(canvasCalls).toHaveLength(0)
  })

  test('抽帧时拿不到 2D 上下文：跳过该帧', async () => {
    toBlobQueue = [blobOf(10)]
    const promise = extractVideoFrames('http://host/api/attachments/v', 1)
    const video = videos.at(-1)!
    video.duration = 10
    video.videoWidth = 640
    video.videoHeight = 360
    context = null
    video.onloadedmetadata!()
    await expect(promise).resolves.toEqual([])
  })
})
