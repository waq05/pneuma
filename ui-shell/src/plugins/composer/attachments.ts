/**
 * 输入区附件的纯逻辑：上传、图片规范化、视频抽帧、提交时的拆包。
 *
 * 宿主侧已经有两条同源路由（`POST /api/attachments` 收裸字节、`GET /api/attachments/<sha>`
 * 回字节并支持 Range），所以界面里不再把 base64 塞进 JSON——图片走引用串，视频与通用文件
 * 走 `UserFileAttachment`。这里只做「浏览器侧把文件变成引用」这一段，不碰样式、不碰宿主。
 *
 * 三件事分开写的原因：
 *   - **上传**用 `XMLHttpRequest`：`fetch` 没有上传进度，而大视频必须让用户看见传到哪了；
 *   - **图片规范化**在浏览器里先缩到 2048、压到 4MiB 以内，省的是上行流量与宿主的存储；
 *   - **视频抽帧**把一段视频变成几张图，模型不支持视频输入也能「看见」关键画面。
 *
 * 探针不直接读本模块（它碰 DOM 与网络）；可测的是 `composeSubmit` / `formatBytes` 这类纯函数。
 *
 * @module dsc-ui-shell/plugins/composer/attachments
 */
import type { UserFileAttachment } from '@dsc/ui'
import type { AttachmentMeta, DraftAttachment } from './draft'

// 附件的两个类型定义在 `./draft.ts`（那边必须零 import，探针直读它）；这里只转发，
// 免得两处各抄一份。语义与字段说明看 `draft.ts`。
export type { AttachmentMeta, DraftAttachment }

/** 附件类型（与宿主 `AttachmentKind` 同值）。 */
export type AttachmentKind = AttachmentMeta['kind']

/** 一条消息最多带几张图片（与宿主 `MAX_IMAGES_PER_MESSAGE` 同值）。 */
export const MAX_IMAGES = 20
/** 单张图片在浏览器侧的上限（宿主也是 20MiB）。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** 图片压缩后的目标上限：超过就继续降质量。 */
const TARGET_IMAGE_BYTES = 4 * 1024 * 1024
/** 图片最长边上限。 */
const MAX_IMAGE_EDGE = 2048
/** 视频抽帧的最长边。 */
const MAX_FRAME_EDGE = 1280
/** 单帧 seek 超时。 */
const SEEK_TIMEOUT_MS = 5_000
/** 整段抽帧超时。 */
const FRAME_TOTAL_TIMEOUT_MS = 45_000

/** 允许的图片类型与扩展名（宿主只认这四类，界面先挡一道）。 */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const IMAGE_FORMAT_ERROR = '仅支持 PNG、JPG、WebP、GIF 格式的图片'
const IMAGE_TOO_LARGE_ERROR = '单张图片超过 20 MB，先缩小一点'

/** 本地附件 id 的自增计数（同一毫秒内加多个文件也不会撞）。 */
let nextId = 0

/** 生成一个本地唯一 id。 */
export function newAttachmentId(): string {
  nextId += 1
  return `attach-${String(Date.now())}-${String(nextId)}`
}

/** 把字节数压成一行给用户看（`1.2 MB` 这种）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
  return `${rounded} ${units[unit]}`
}

/** 文件名兜底：剪贴板里的截图常常没有名字。 */
export function displayNameOf(file: File, kind: AttachmentKind): string {
  if (file.name !== '') return file.name
  if (kind === 'image') return '粘贴的图片.png'
  if (kind === 'video') return '粘贴的视频.mp4'
  return '附件'
}

/** 按 MIME 粗分附件类型（宿主会按魔数再判一次）。 */
export function kindOf(file: File): AttachmentKind {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  return 'file'
}

/**
 * 上传一份文件字节，拿到宿主的附件元数据。
 *
 * 用 `XMLHttpRequest` 而不是 `fetch`：只有它能给上传进度（`xhr.upload.onprogress`）。
 * 失败时把服务端 JSON 的 `error` 原样抛出来（文件名非法、超上限、磁盘满都由宿主说清），
 * 拿不到 JSON 才退回 HTTP 状态码。
 *
 * @param file 要传的字节（图片可能已经过 {@link normalizeImage}）
 * @param name 文件名（路由的 `?name=`，宿主按它做安全化与展示）
 * @param onProgress 进度回调，比例 0..1
 */
export function uploadFile(
  file: File | Blob,
  name: string,
  onProgress?: (ratio: number) => void,
): Promise<AttachmentMeta> {
  return new Promise<AttachmentMeta>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/attachments?name=${encodeURIComponent(name)}`)
    xhr.responseType = 'text'
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return
      onProgress?.(Math.min(1, event.loaded / event.total))
    }
    xhr.onload = () => {
      const parsed = parseAttachmentResponse(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300 && parsed.ok && parsed.meta !== null) {
        resolve(parsed.meta)
        return
      }
      reject(new Error(parsed.error !== '' ? parsed.error : `上传失败（HTTP ${String(xhr.status)}）`))
    }
    xhr.onerror = () => {
      reject(new Error('上传失败：网络连接中断'))
    }
    xhr.ontimeout = () => {
      reject(new Error('上传失败：等宿主响应超时'))
    }
    xhr.onabort = () => {
      reject(new Error('上传已取消'))
    }
    xhr.send(file)
  })
}

/** 解析上传回包：成功回 `{ ok: true, attachment }`，失败回 `{ ok: false, error }`。 */
function parseAttachmentResponse(text: string): { ok: boolean; meta: AttachmentMeta | null; error: string } {
  let body: unknown = null
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return { ok: false, meta: null, error: '' }
  }
  if (typeof body !== 'object' || body === null) return { ok: false, meta: null, error: '' }
  const record = body as Record<string, unknown>
  const error = typeof record['error'] === 'string' ? record['error'] : ''
  if (record['ok'] !== true) return { ok: false, meta: null, error }
  const meta = record['attachment']
  if (typeof meta !== 'object' || meta === null) return { ok: false, meta: null, error }
  const item = meta as Record<string, unknown>
  const kind = item['kind']
  if (kind !== 'image' && kind !== 'video' && kind !== 'file') return { ok: false, meta: null, error }
  if (
    typeof item['sha'] !== 'string' ||
    typeof item['name'] !== 'string' ||
    typeof item['mime'] !== 'string' ||
    typeof item['bytes'] !== 'number' ||
    typeof item['url'] !== 'string' ||
    typeof item['path'] !== 'string'
  ) {
    return { ok: false, meta: null, error }
  }
  return {
    ok: true,
    meta: {
      sha: item['sha'],
      kind,
      name: item['name'],
      mime: item['mime'],
      bytes: item['bytes'],
      url: item['url'],
      path: item['path'],
    },
    error,
  }
}

/**
 * 把用户拖进来 / 粘进来的图片整理成可以直接上传的字节。
 *
 * 规则（与需求逐条对应）：
 * - 只认 PNG / JPEG / WebP / GIF（`file.type` 不认识就看扩展名），其余直接报错；
 * - 已经 ≤ 2048px、≤ 4MiB 的 PNG / JPEG / WebP **原样返回**，不重编码（保住清晰度）；
 * - 更大或更长的先等比缩到最长边 2048；带透明的输出 WebP 0.85，不透明的输出 JPEG 0.85，
 *   超过 4MiB 依次退到 0.75、0.6，仍超就报错；
 * - GIF 只取第一帧（`createImageBitmap` 天然只解第一帧）。
 *
 * @param file 用户给的图片文件
 * @throws 格式不支持、源文件超过 20MiB、压缩后仍超过 4MiB
 */
export async function normalizeImage(file: File): Promise<Blob> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error(IMAGE_TOO_LARGE_ERROR)
  const mime = file.type.toLowerCase()
  if (!IMAGE_MIME.has(mime) && !IMAGE_EXT.test(file.name)) throw new Error(IMAGE_FORMAT_ERROR)
  const gif = mime === 'image/gif' || /\.gif$/i.test(file.name)
  const direct =
    !gif &&
    (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/webp') &&
    file.size <= TARGET_IMAGE_BYTES

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const edge = Math.max(bitmap.width, bitmap.height)
    const scale = edge > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / edge : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const resized = width !== bitmap.width || height !== bitmap.height

    // 不需要缩、本来就是常见格式：直接交原件，别为了「统一编码」糊一层。
    if (direct && !resized) return file

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('图片处理失败：浏览器画布不可用')
    context.drawImage(bitmap, 0, 0, width, height)

    const hasAlpha = mayHaveAlpha(mime, file.name) && canvasHasTransparency(context, width, height)
    if (hasAlpha) {
      const webp = await canvasToBlob(canvas, 'image/webp', 0.85)
      if (webp === null) throw new Error('图片处理失败：无法编码 WebP')
      if (webp.size > TARGET_IMAGE_BYTES) throw new Error('图片压缩后仍超过 4 MB，先换一张小一点的')
      return webp
    }

    for (const quality of [0.85, 0.75, 0.6]) {
      const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality)
      if (jpeg === null) throw new Error('图片处理失败：无法编码 JPEG')
      if (jpeg.size <= TARGET_IMAGE_BYTES) return jpeg
    }
    throw new Error('图片压缩后仍超过 4 MB，先换一张小一点的')
  } finally {
    bitmap.close()
  }
}

/** 这个来源有没有可能带透明通道（JPEG 永远没有，不用扫像素）。 */
function mayHaveAlpha(mime: string, name: string): boolean {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return false
  if (/\.jpe?g$/i.test(name)) return false
  return true
}

/** 扫一遍画布像素，看有没有非不透明的点（整图都 alpha=255 就当不透明）。 */
function canvasHasTransparency(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const data = context.getImageData(0, 0, width, height).data
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) return true
  }
  return false
}

/** `canvas.toBlob` 的 Promise 包装（null 表示编码失败，交给调用方决定报什么错）。 */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob)
    }, type, quality)
  })
}

/**
 * 从视频里均匀抽几帧，压成 JPEG 返回。
 *
 * 抽帧是**尽力而为**：加载失败、时长读不到、某一帧 seek 超时，都只返回已经拿到的帧，
 * 不抛错——抽帧失败不能挡住用户把消息发出去。单帧 5 秒、整段 45 秒两道上限，
 * 防止损坏的视频把输入区一直挂在「上传中」。
 *
 * @param url 视频地址（宿主的 `/api/attachments/<sha>`，同源带 Cookie）
 * @param count 抽几帧（默认 6）
 */
export async function extractVideoFrames(url: string, count = 6): Promise<Blob[]> {
  const frames: Blob[] = []
  if (typeof document === 'undefined' || count <= 0) return frames

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  video.crossOrigin = 'anonymous'
  video.setAttribute('aria-hidden', 'true')
  video.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(video)

  return new Promise<Blob[]>((resolve) => {
    let finished = false
    let totalTimer = 0

    const finish = (): void => {
      if (finished) return
      finished = true
      window.clearTimeout(totalTimer)
      video.pause()
      // 视频是宿主的同源 URL，没有本模块创建的 objectURL；若调用方传入的正是 blob:，
      // 由创建它的人负责释放（这里只摘掉 src，避免 element 继续占着解码器）。
      video.removeAttribute('src')
      video.load()
      video.remove()
      resolve(frames)
    }

    totalTimer = window.setTimeout(finish, FRAME_TOTAL_TIMEOUT_MS)

    video.onerror = () => {
      finish()
    }

    video.onloadedmetadata = () => {
      void (async () => {
        const duration = video.duration
        if (!Number.isFinite(duration) || duration <= 0) {
          finish()
          return
        }
        for (let index = 0; index < count; index += 1) {
          if (finished) return
          const time = (duration * (index + 0.5)) / count
          const sought = await seekTo(video, time)
          if (!sought || finished) break
          const frame = await grabFrame(video)
          if (frame !== null) frames.push(frame)
        }
        finish()
      })()
    }

    video.src = url
  })
}

/** 把视频 seek 到指定时间；成功等 `seeked`，超时或出错返回 false。 */
function seekTo(video: HTMLVideoElement, time: number): Promise<boolean> {
  if (Math.abs(video.currentTime - time) < 0.001) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      video.removeEventListener('seeked', onSeeked)
      resolve(false)
    }, SEEK_TIMEOUT_MS)
    function onSeeked(): void {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      resolve(true)
    }
    video.addEventListener('seeked', onSeeked)
    try {
      video.currentTime = time
    } catch {
      if (!settled) {
        settled = true
        window.clearTimeout(timer)
        video.removeEventListener('seeked', onSeeked)
        resolve(false)
      }
    }
  })
}

/** 把当前画面画到 canvas（最长边 1280）再编码成 JPEG。 */
async function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (sourceWidth <= 0 || sourceHeight <= 0) return null
  const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) return null
  context.drawImage(video, 0, 0, width, height)
  return canvasToBlob(canvas, 'image/jpeg', 0.82)
}

/** 一次提交要带的东西（`files` 是视频与通用文件，图片单独一列）。 */
export interface SubmitPayload {
  images: string[]
  files: UserFileAttachment[]
  /** 因为超过 20 张而被截掉的图片数（0 = 一张没丢）。 */
  dropped: number
}

/**
 * 把草稿附件拆成宿主 `submit` 要的两列。
 *
 * 顺序：纯图片按添加顺序进 `images`；视频与通用文件按添加顺序进 `files`，视频的关键帧挂在
 * 它自己的 `frames` 上——帧只进模型请求，界面气泡仍只画一张视频卡（宿主投影时展开）。
 * 图片总数（含帧）超过 20 时**从后面截**，并把截掉的张数交回去，由界面提示用户。
 */
export function composeSubmit(list: readonly DraftAttachment[]): SubmitPayload {
  const images: string[] = []
  const files: UserFileAttachment[] = []
  for (const item of list) {
    if (item.meta === null) continue
    if (item.kind === 'image') {
      images.push(item.meta.url)
      continue
    }
    files.push({
      sha: item.meta.sha,
      kind: item.kind,
      name: item.meta.name,
      mime: item.meta.mime,
      bytes: item.meta.bytes,
      path: item.meta.path,
      ...(item.kind === 'video' && item.frames.length > 0 ? { frames: [...item.frames] } : {}),
    })
  }
  const frameCount = files.reduce((sum, file) => sum + (file.frames?.length ?? 0), 0)
  const dropped = Math.max(0, images.length + frameCount - MAX_IMAGES)
  // 超预算时先砍帧（用户自己贴的图优先），从后往前砍，砍完把视频的 frames 收窄。
  let budget = Math.max(0, MAX_IMAGES - images.length)
  for (const file of files) {
    if (file.frames === undefined) continue
    const keep = Math.min(file.frames.length, budget)
    budget -= keep
    if (keep === 0) delete file.frames
    else if (keep < file.frames.length) file.frames = file.frames.slice(0, keep)
  }
  return { images: images.slice(0, MAX_IMAGES), files, dropped }
}
