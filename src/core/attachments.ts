/**
 * 附件仓库：把用户贴进来的图片、视频与其它文件存成本机对象，消息里只留引用。
 *
 * ## 为什么不再往消息里塞 base64
 *
 * 原来界面把图片压成 data URL，经 `/api/invoke` 的 64KB 请求体塞进 `submit` 的第二参
 * （`core/web-http.ts` 的 `MAX_BODY_BYTES`），所以单图只能有 32KB——普通截图压到那个
 * 档位已经看不清了（这正是「贴图这一版还不支持」的根因）。会话 jsonl 也把 base64 原样
 * 写进去，一个会话文件会膨胀到几十 MB。
 *
 * 现在照 dsh `dsh-attachment-local` 的做法拆成两步：
 *
 *   1. 字节先经 `POST /api/attachments` 落到这里，内容寻址（sha256），同字节只存一份；
 *   2. 消息里带引用 `/api/attachments/<sha>`，**组装模型请求时**再读成 data URL。
 *
 * 于是请求体只装几个短引用，会话日志也只记引用；界面 `<img>` / `<video>` 直接吃同源
 * 路由，不必再传 base64。
 *
 * ## 与 dsh 的口径对齐与差异
 *
 * 对齐：目录形状 `<DSC_HOME>/attachments/v1/objects/<sha 前 2 位>/<sha>`、内容寻址去重、
 * 只收 PNG / JPEG / WebP / GIF 四类图片、非图片文件按字节原样存、单图 20MiB。
 *
 * 差异：dsh 在服务端用 sharp 做像素级规范化（EXIF、色彩空间、长边、质量阶梯）。本仓库
 * 没有原生图像依赖，**规范化放在界面层**（`ui-shell/src/plugins/composer/attachments.ts`
 * 用 canvas 做同样的事），落到这里的已经是 8-bit sRGB 光栅。所以这里的校验只看字节与
 * 魔数：信不信扩展名/`Content-Type` 一律不信。
 *
 * ## 安全边界
 *
 * - sha 只认 64 位小写十六进制，路径拼接不接用户输入；
 * - 文件名只用于展示，落盘名永远是 sha；
 * - 单文件上限按类别分开（图片 20MiB、视频与其它文件 200MiB），上限在**写入过程中**
 *   就生效，不会先写满盘再判；
 * - 读取前校验对象仍是普通文件，长度与摘要由调用方（会话投影）自行决定要不要复核。
 *
 * @module dsc/core/attachments
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { dscPath } from './path-policy.js'

/** 单张图片上限（与 dsh `maxImageBytes` 的默认值一致）。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 单个视频 / 其它文件上限。比 dsh 的「通用文件不设限」保守，理由是本机磁盘不是仓库。 */
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024

/** 一条消息最多带多少张图片（dsh 默认 20；这里按请求体与上下文成本收到 20）。 */
export const MAX_IMAGES_PER_MESSAGE = 20

/** 附件类别：图片进模型请求的 image 块，视频与文件以「路径 + 元数据」交给模型。 */
export type AttachmentKind = 'image' | 'video' | 'file'

/** 一次落盘的结果：会话与界面只认这份元数据。 */
export interface AttachmentMeta {
  /** sha256 十六进制（64 位小写）。 */
  sha: string
  kind: AttachmentKind
  /** 用户看到的原始文件名（已安全化，仅用于展示）。 */
  name: string
  /** 实际类型（按魔数判定，不信扩展名）。 */
  mime: string
  /** 字节数。 */
  bytes: number
  /** 同源读取地址（可直接塞进 `<img src>` / `<video src>`）。 */
  url: string
  /** 本机绝对路径：交给模型用工具读，或给桌面端做原生播放。 */
  path: string
}

/** 会话与界面之间传的文件引用（视频 / 通用文件，图片走 `images` 那一列）。 */
export interface UserFileAttachment {
  sha: string
  kind: 'video' | 'file'
  name: string
  mime: string
  bytes: number
  path: string
  url?: string
  /**
   * 视频抽出来的关键帧（已上传成图片附件的引用）。
   *
   * 与 `url` 一样只给请求投影用：模型看到这些图，界面只画一张视频卡——帧是「怎么让模型
   * 看见视频」的手段，不是用户要多看六张图。日志里存引用，重放时照样能还原。
   */
  frames?: string[]
}

/** 落盘失败（上限 / 空文件 / 写盘错误）。 */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

/** 文件头魔数 sniff 的结果。 */
export interface SniffedMedia {
  kind: AttachmentKind
  mime: string
}

/** 读文件头用的字节数：视频的 ftyp 在前 16 字节内，再留一点余量。 */
const HEAD_BYTES = 64

/**
 * 按文件头认类型。
 *
 * 只认常见、能给模型或播放器直接用的格式；认不出的按 `file` 原样存（模型拿路径自己看）。
 * 图片四类与 dsh 一致：PNG / JPEG / WebP / GIF。
 */
export function sniffMedia(head: Buffer): SniffedMedia {
  if (head.length >= 8
    && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return { kind: 'image', mime: 'image/png' }
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { kind: 'image', mime: 'image/jpeg' }
  }
  if (head.length >= 6) {
    const gif = head.subarray(0, 6).toString('ascii')
    if (gif === 'GIF87a' || gif === 'GIF89a') return { kind: 'image', mime: 'image/gif' }
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF') {
    const form = head.subarray(8, 12).toString('ascii')
    if (form === 'WEBP') return { kind: 'image', mime: 'image/webp' }
    if (form === 'AVI ') return { kind: 'video', mime: 'video/x-msvideo' }
  }
  // MP4 / MOV / M4V：`ftyp` 在偏移 4，品牌在偏移 8。
  if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('ascii')
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime' }
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return { kind: 'video', mime: 'video/x-m4v' }
    return { kind: 'video', mime: 'video/mp4' }
  }
  // Matroska / WebM 的 EBML 头；不再细分容器（浏览器按实际编码解）。
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { kind: 'video', mime: 'video/webm' }
  }
  return { kind: 'file', mime: 'application/octet-stream' }
}

/** 按魔数结果判断一个对象是不是可渲染图片。 */
export function isImageMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/gif'
}

/** 类别对应的单文件上限。 */
export function limitFor(kind: AttachmentKind): number {
  return kind === 'image' ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES
}

/** sha 的合法形状：64 位小写十六进制。 */
const SHA = /^[0-9a-f]{64}$/

/** 把原始文件名洗成可展示的一段（只展示，不参与落盘路径）。 */
export function displayName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = last
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .trim()
    .slice(0, 120)
  return cleaned === '' ? 'attachment' : cleaned
}

/** 附件在界面通道里的读取地址。 */
export function attachmentUrl(sha: string, name?: string): string {
  return name === undefined || name === ''
    ? `/api/attachments/${sha}`
    : `/api/attachments/${sha}?name=${encodeURIComponent(name)}`
}

/** 从任意字符串里认出附件引用；不是引用就回 null。 */
export function parseAttachmentUrl(value: string): string | null {
  const match = /^\/api\/attachments\/([0-9a-f]{64})(?:\?|$)/.exec(value)
  return match === null ? null : match[1]
}

/** 造仓库时要给的东西（自检换成临时目录）。 */
export interface AttachmentStoreOptions {
  /** 根目录，缺省 `<DSC_HOME>/attachments/v1`。 */
  root?: string
}

/**
 * 内容寻址附件仓库。
 *
 * 目录形状：`<root>/objects/<sha 前两位>/<sha>`，临时文件在 `<root>/tmp/`。
 * 同一个字节序列落两次是同一个对象（第二次直接复用，不重写）。
 */
export class AttachmentStore {
  private readonly root: string

  constructor(options: AttachmentStoreOptions = {}) {
    this.root = options.root ?? dscPath('attachments', 'v1')
  }

  /** 仓库根目录。 */
  get dir(): string {
    return this.root
  }

  /** 对象的绝对路径（只接受合法 sha，别的一律抛）。 */
  pathOf(sha: string): string {
    if (!SHA.test(sha)) throw new AttachmentError(`附件 id 不合法：${sha}`)
    return join(this.root, 'objects', sha.slice(0, 2), sha)
  }

  /** 对象是否已经在仓库里。 */
  has(sha: string): boolean {
    try {
      return statSync(this.pathOf(sha)).isFile()
    } catch {
      return false
    }
  }

  /** 落盘一段已知字节（浏览器上传的小文件、自检都走这条）。 */
  save(name: string, bytes: Buffer): AttachmentMeta {
    const sniffed = sniffMedia(bytes.subarray(0, HEAD_BYTES))
    const limit = limitFor(sniffed.kind)
    if (bytes.length === 0) throw new AttachmentError('空文件不能作为附件')
    if (bytes.length > limit) {
      throw new AttachmentError(`${sniffed.kind === 'image' ? '图片' : '文件'}超过 ${formatBytes(limit)} 上限`)
    }
    const sha = createHash('sha256').update(bytes).digest('hex')
    const target = this.pathOf(sha)
    if (!existsSync(target)) {
      const tmpDirectory = join(this.root, 'tmp')
      mkdirSync(tmpDirectory, { recursive: true })
      mkdirSync(join(this.root, 'objects', sha.slice(0, 2)), { recursive: true })
      const tmp = join(tmpDirectory, `${sha}.${randomBytes(4).toString('hex')}`)
      writeFileSync(tmp, bytes)
      this.publish(tmp, target)
    }
    return this.meta(sha, sniffed, name, bytes.length)
  }

  /**
   * 把一条 HTTP 请求体流式落盘。
   *
   * 为什么要流式：视频动辄几十 MB，先 `readBodyBytes` 攒进内存会顶出一整份缓冲。
   * 边写边算 sha，超限时立刻停写并删临时文件，客户端拿到 413。
   */
  async saveStream(req: IncomingMessage, name: string): Promise<AttachmentMeta> {
    const tmpDirectory = join(this.root, 'tmp')
    mkdirSync(tmpDirectory, { recursive: true })
    const tmp = join(tmpDirectory, `${Date.now().toString(36)}.${randomBytes(6).toString('hex')}`)
    const hash = createHash('sha256')
    const declared = Number(req.headers['content-length'] ?? '')
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
      throw new AttachmentError(`文件超过 ${formatBytes(MAX_MEDIA_BYTES)} 上限`)
    }
    const handle = await open(tmp, 'w')
    let bytes = 0
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        bytes += buffer.length
        if (bytes > MAX_MEDIA_BYTES) throw new AttachmentError(`文件超过 ${formatBytes(MAX_MEDIA_BYTES)} 上限`)
        hash.update(buffer)
        await handle.write(buffer)
      }
    } catch (error) {
      await handle.close()
      await rm(tmp, { force: true })
      throw error
    }
    await handle.close()
    if (bytes === 0) {
      await rm(tmp, { force: true })
      throw new AttachmentError('空文件不能作为附件')
    }
    const sha = hash.digest('hex')
    const head = await readHead(tmp)
    const sniffed = sniffMedia(head)
    const limit = limitFor(sniffed.kind)
    if (bytes > limit) {
      await rm(tmp, { force: true })
      throw new AttachmentError(`${sniffed.kind === 'image' ? '图片' : '文件'}超过 ${formatBytes(limit)} 上限`)
    }
    const target = this.pathOf(sha)
    mkdirSync(join(this.root, 'objects', sha.slice(0, 2)), { recursive: true })
    if (!existsSync(target)) this.publish(tmp, target)
    else await rm(tmp, { force: true })
    return this.meta(sha, sniffed, name, bytes)
  }

  /** 读整段字节（组装模型请求时用；只给图片，视频不走这条）。 */
  read(sha: string): Buffer {
    return readFileSync(this.pathOf(sha))
  }

  /** 对象的字节数与修改时间；对象不存在时回 null。 */
  stat(sha: string): { size: number; mtimeMs: number } | null {
    try {
      const info = statSync(this.pathOf(sha))
      return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null
    } catch {
      return null
    }
  }

  /** 给 HTTP 路由用的类型判定：只读文件头。 */
  async mimeOf(sha: string): Promise<{ mime: string; size: number } | null> {
    const path = this.pathOf(sha)
    try {
      const info = await stat(path)
      if (!info.isFile()) return null
      const head = await readHead(path)
      return { mime: sniffMedia(head).mime, size: info.size }
    } catch {
      return null
    }
  }

  /** 元数据组装（路径与 url 一处生成，避免两边漂移）。 */
  private meta(sha: string, sniffed: SniffedMedia, name: string, bytes: number): AttachmentMeta {
    const safeName = displayName(name)
    return {
      sha,
      kind: sniffed.kind,
      name: safeName,
      mime: sniffed.mime,
      bytes,
      url: attachmentUrl(sha, safeName),
      path: this.pathOf(sha),
    }
  }

  /** 把临时文件发布成正式对象：临时文件与目标同盘，改名是原子的。 */
  private publish(tmp: string, target: string): void {
    try {
      renameSync(tmp, target)
    } catch (error) {
      // Windows 上目标恰好被另一个并发写入创建时 rename 会失败：删掉临时文件，认对方那份。
      try {
        unlinkSync(tmp)
      } catch {
        // 临时文件删不掉不影响结果
      }
      if (!existsSync(target)) throw error
    }
  }
}

/** 进程级默认仓库：界面路由与会话投影共用一份。 */
let defaultStore: AttachmentStore | null = null

/** 取（首次创建）默认仓库。 */
export function attachmentStore(): AttachmentStore {
  defaultStore ??= new AttachmentStore()
  return defaultStore
}

/** 自检替换默认仓库（只给测试脚本用）。 */
export function setAttachmentStoreForTest(store: AttachmentStore | null): void {
  defaultStore = store
}

/**
 * 把一条图片引用读成 data URL（组装模型请求时用）。
 *
 * - `data:` 开头的老写法原样返回（老会话兼容）；
 * - `/api/attachments/<sha>` 读成 base64；文件不在了就抛错，让这一轮明确失败，
 *   而不是把一条坏链接发给端点；
 * - 其它字符串（远端 http 图）原样返回。
 */
export function resolveImageForRequest(url: string): string {
  if (url.startsWith('data:')) return url
  const sha = parseAttachmentUrl(url)
  if (sha === null) return url
  const store = attachmentStore()
  const mimeOfFile = store.stat(sha)
  if (mimeOfFile === null) throw new AttachmentError(`附件不存在：${sha.slice(0, 12)}…`)
  const head = readFileSync(store.pathOf(sha)).subarray(0, HEAD_BYTES)
  const sniffed = sniffMedia(head)
  if (sniffed.kind !== 'image') throw new AttachmentError(`这个附件不是图片：${sha.slice(0, 12)}…`)
  return `data:${sniffed.mime};base64,${store.read(sha).toString('base64')}`
}

/**
 * 文件类附件给模型看的那一段文字。
 *
 * 形状照 dsh 的文件句柄：一行说清「是什么、多大、摘要前缀、在哪」。模型拿到路径后
 * 用文件工具自己读（视频自己没有解码能力的端点也读不懂，所以这里不承诺「能看画面」）。
 */
export function fileHandleText(files: readonly UserFileAttachment[]): string {
  if (files.length === 0) return ''
  const lines = files.map((file) => {
    const kind = file.kind === 'video' ? '视频' : '文件'
    return `[${kind}附件] ${file.name}（${file.mime} · ${formatBytes(file.bytes)} · sha256:${file.sha.slice(0, 12)}）\n只读路径：${file.path}`
  })
  return lines.join('\n')
}

/** 字节数读成人类可读的一段（本模块与界面提示共用同一种写法）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 按扩展名给一个「像不像图片」的提示（只用于界面提前选路，不参与安全判断）。 */
export function looksLikeImage(name: string): boolean {
  const ext = extname(name).toLowerCase()
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif'
}

/** 按扩展名给一个「像不像视频」的提示（同上）。 */
export function looksLikeVideo(name: string): boolean {
  const ext = extname(name).toLowerCase()
  return ext === '.mp4' || ext === '.m4v' || ext === '.mov' || ext === '.webm' || ext === '.mkv' || ext === '.avi'
}

/**
 * 校验并洗白「页面传来的文件引用」。
 *
 * 为什么必须在入口洗：界面通道的实参来自网络，页面（含第三方插件）可以编任意
 * `path`——把 `C:\Users\…\credentials.yaml` 塞进来，宿主就会把那条路径写进模型
 * 看得到的句柄里，等于把「模型可读范围」交给页面决定。所以路径一律不信：只认
 * 仓库按 sha 算出来的那一条；其它字段只做类型与长度收口。
 */
export function sanitizeFileRefs(value: unknown): UserFileAttachment[] {
  if (!Array.isArray(value)) throw new AttachmentError('附件清单必须是数组')
  if (value.length > 20) throw new AttachmentError('一条消息最多带 20 个文件')
  const store = attachmentStore()
  const out: UserFileAttachment[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') throw new AttachmentError('附件项形状不对')
    const record = item as Record<string, unknown>
    const sha = record['sha']
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new AttachmentError('附件 id 不合法')
    const kind = record['kind']
    if (kind !== 'video' && kind !== 'file') throw new AttachmentError('附件类别只能是 video 或 file')
    if (!store.has(sha)) throw new AttachmentError(`附件不存在：${sha.slice(0, 12)}…`)
    const info = store.stat(sha)
    if (info === null) throw new AttachmentError(`附件不存在：${sha.slice(0, 12)}…`)
    const name = typeof record['name'] === 'string' ? displayName(record['name']) : 'attachment'
    const mime = typeof record['mime'] === 'string' ? record['mime'].slice(0, 100) : 'application/octet-stream'
    // 视频关键帧：只认仓库里真的存在、且确实是图片的对象（页面给的顺序照收）。
    const rawFrames = record['frames']
    const frames: string[] = []
    if (rawFrames !== undefined) {
      if (!Array.isArray(rawFrames) || rawFrames.length > 12) throw new AttachmentError('视频帧清单不合法')
      for (const frame of rawFrames) {
        const frameSha = typeof frame === 'string' ? (parseAttachmentUrl(frame) ?? (/^[0-9a-f]{64}$/.test(frame) ? frame : null)) : null
        if (frameSha === null || !store.has(frameSha)) continue
        frames.push(attachmentUrl(frameSha))
      }
    }
    out.push({
      sha,
      kind,
      name,
      mime,
      bytes: info.size,
      path: store.pathOf(sha),
      url: attachmentUrl(sha, name),
      ...(frames.length === 0 ? {} : { frames }),
    })
  }
  return out
}

/** 读文件头（异步路由用）。 */
async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
