/**
 * 附件仓库自检（迁自 `scripts/attachments-test.mjs`）：内容寻址、魔数校验、引用读回、
 * HTTP 上传 / 读取、会话投影。
 *
 * ## 为什么单独一张网
 *
 * 图片从「base64 塞请求体」改成「先上传、再发引用」以后，任何一处口径漂了都不会立刻报错：
 * 界面可能贴得进去但模型看到空图、会话日志可能又把 base64 写回去、视频可能存成 `file`
 * 却按 `video` 发给播放器。四件事必须一起钉住：
 *
 *   ① 仓库：同字节去重、空文件拒收、超限拒收、魔数说了算（不信扩展名）；
 *   ② 引用：`/api/attachments/<sha>` 能读回 data URL，缺对象时明确失败；
 *   ③ 路由：上传要过 Cookie 闸，读回支持 Range（视频拖动进度条靠它）；
 *   ④ 会话：jsonl 只写引用、内存消息拿 data URL，视频以路径句柄拼进正文。
 *
 * ## 为什么这一条不起内核
 *
 * 被测对象是 `core/attachments.ts` 与 `core/ui-server.ts` 的附件路由——它们不经过
 * 插件装配、也不发模型请求。硬起内核只会多一个 60 秒超时风险点，验不到任何额外行为。
 * 这里起的是**真** HTTP 服务（`createUiServer`，端口 0 由系统分配），不是假 SSE 端点。
 * Cookie 换票、Range 206、401 这些都在真 TCP 上走一遍。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../harness.js'

/** 临时主目录：附件仓库、会话文件、UI 签名密钥都落在这里。 */
const home = tempHome('dsc-attachments-spec-')

type AttachmentsModule = typeof import('@pneuma/runtime/core/attachments.js')
type UiServerModule = typeof import('@pneuma/runtime/core/ui-server.js')
type SessionModule = typeof import('@pneuma/runtime/core/session.js')
type BytesModule = typeof import('@pneuma/runtime/core/bytes.js')

let attachments: AttachmentsModule
let ui: UiServerModule
let sessionCore: SessionModule
let bytes: BytesModule
/** 仓库根（内容寻址的对象都落这里）。 */
const storeRoot = join(home.home, 'store')
/** 附件仓库实例。 */
let store: InstanceType<AttachmentsModule['AttachmentStore']>
/** 起好的 UI 服务句柄。 */
let server: Awaited<ReturnType<UiServerModule['createUiServer']>>
/** 换到的会话 Cookie。 */
let cookie: string
/** 「主机:端口」基址（不带 `?token=`，拼路径用它）。 */
let origin: string

/** 一段最小 PNG（1×1，真实可解码）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
/** 一段最小 JPEG 头（只为认魔数，不解码）。 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])
/** 一段最小 MP4 头（ftyp isom）。 */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isomiso2', 'ascii'),
  Buffer.alloc(24, 0x11),
])
/** WebM 的 EBML 头 + 一点噪声。 */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]), Buffer.alloc(64, 0x22)])

/** 仓库里存好的第一张图（第 ② 节起都用它）。 */
let saved: ReturnType<InstanceType<AttachmentsModule['AttachmentStore']>['save']>
/** 仓库里存好的视频。 */
let video: ReturnType<InstanceType<AttachmentsModule['AttachmentStore']>['save']>

beforeAll(async () => {
  attachments = await import('@pneuma/runtime/core/attachments.js')
  ui = await import('@pneuma/runtime/core/ui-server.js')
  sessionCore = await import('@pneuma/runtime/core/session.js')
  bytes = await import('@pneuma/runtime/core/bytes.js')
  store = new attachments.AttachmentStore({ root: storeRoot })
  attachments.setAttachmentStoreForTest(store)
  saved = store.save('截图 1.png', PNG)
  video = store.save('演示.mp4', MP4)
})

afterAll(async () => {
  attachments.setAttachmentStoreForTest(null)
  await server?.close()
  home.restore()
})

describe('① 魔数：类别由字节决定，不信扩展名', () => {
  test('PNG', () => {
    expect(attachments.sniffMedia(PNG)).toMatchObject({ kind: 'image', mime: 'image/png' })
  })

  test('JPEG', () => {
    expect(attachments.sniffMedia(JPEG).mime).toBe('image/jpeg')
  })

  test('MP4 是 video', () => {
    expect(attachments.sniffMedia(MP4)).toMatchObject({ kind: 'video', mime: 'video/mp4' })
  })

  test('WebM 是 video/webm', () => {
    expect(attachments.sniffMedia(WEBM).mime).toBe('video/webm')
  })

  test('未知字节按 file 处理', () => {
    expect(attachments.sniffMedia(Buffer.from('hello world')).kind).toBe('file')
  })
})

describe('② 仓库：内容寻址、去重、拒收', () => {
  test('sha 是 64 位十六进制', () => {
    expect(saved.sha).toMatch(/^[0-9a-f]{64}$/)
  })

  test('类别、mime、字节数都与输入一致', () => {
    expect(saved.kind).toBe('image')
    expect(saved.mime).toBe('image/png')
    expect(saved.bytes).toBe(PNG.length)
  })

  test('对象真的落盘，字节一模一样', () => {
    expect(readFileSync(saved.path).equals(PNG)).toBe(true)
  })

  test('url 是引用形状，名字被安全化后保留', () => {
    expect(saved.url).toBe(attachments.attachmentUrl(saved.sha, saved.name))
    expect(saved.name).toBe('截图 1.png')
  })

  test('同字节去重：sha 相同且只有一份对象', () => {
    const again = store.save('另一个名字.png', PNG)
    expect(again.sha).toBe(saved.sha)
    const objectStat = store.stat(saved.sha)
    expect(objectStat).not.toBeNull()
    expect(objectStat?.size).toBe(PNG.length)
  })

  test('视频类别', () => {
    expect(video).toMatchObject({ kind: 'video', mime: 'video/mp4' })
  })

  test('空文件拒收（AttachmentError）', () => {
    expect(() => store.save('empty.png', Buffer.alloc(0))).toThrow(attachments.AttachmentError)
  })

  test('超限拒收（图片 20MiB），且说明是上限', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)])
    expect(() => store.save('huge.png', huge)).toThrow(/上限/)
  })
})

describe('③ 引用读回：data URL、缺对象、老 data URL', () => {
  test('读成 data URL，字节没有丢', () => {
    const dataUrl = attachments.resolveImageForRequest(saved.url)
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(Buffer.from(dataUrl.split(',')[1] ?? '', 'base64').equals(PNG)).toBe(true)
  })

  test('老 data URL 原样过（兼容旧会话）', () => {
    expect(attachments.resolveImageForRequest('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
  })

  test('引用解析得出 sha，非引用回 null', () => {
    expect(attachments.parseAttachmentUrl(saved.url)).toBe(saved.sha)
    expect(attachments.parseAttachmentUrl('/api/other/1')).toBeNull()
  })

  test('缺对象时明确失败（不静默给空图）', () => {
    expect(() => attachments.resolveImageForRequest(attachments.attachmentUrl('0'.repeat(64)))).toThrow()
  })

  test('路径句柄：带文件名、摘要前缀、只读路径', () => {
    const handle = attachments.fileHandleText([{ ...video, kind: 'video', path: 'C:\\tmp\\演示.mp4' }])
    expect(handle).toContain('演示.mp4')
    expect(handle).toContain(video.sha.slice(0, 12))
    expect(handle).toContain('C:\\tmp\\演示.mp4')
  })

  test('字节格式化', () => {
    expect(bytes.formatBytes(1536)).toBe('1.5 KB')
  })
})

describe('④ 文件引用洗白：路径与字节按仓库重算', () => {
  test('路径与字节以仓库为准（不认客户端说的）', () => {
    const clean = attachments.sanitizeFileRefs([
      { sha: video.sha, kind: 'video', name: '演示.mp4', mime: 'video/mp4', path: 'C:\\Windows\\win.ini' },
    ])
    expect(clean[0]?.path).toBe(video.path)
    expect(clean[0]?.bytes).toBe(video.bytes)
  })

  test('不存在的 sha 被拒', () => {
    expect(() =>
      attachments.sanitizeFileRefs([{ sha: 'f'.repeat(64), kind: 'video', name: 'x.mp4', mime: 'video/mp4' }]),
    ).toThrow()
  })

  test('图片混进 files 被拒（图片走 content 里的 image 块）', () => {
    expect(() =>
      attachments.sanitizeFileRefs([{ sha: video.sha, kind: 'image', name: 'x', mime: 'image/png' }]),
    ).toThrow()
  })

  test('视频帧引用被收下；不存在的帧被丢掉', () => {
    const frame = store.save('帧预览.jpg', PNG)
    const withFrames = attachments.sanitizeFileRefs([
      { sha: video.sha, kind: 'video', name: '演示.mp4', mime: 'video/mp4', frames: [frame.url] },
    ])
    expect(withFrames[0]?.frames).toHaveLength(1)
    const withoutFrames = attachments.sanitizeFileRefs([
      { sha: video.sha, kind: 'video', name: '演示.mp4', mime: 'video/mp4', frames: [`/api/attachments/${'f'.repeat(64)}`] },
    ])
    expect(withoutFrames[0]?.frames).toBeUndefined()
  })
})

describe('⑤ HTTP 路由：换票、Cookie 闸、Range', () => {
  beforeAll(async () => {
    server = await ui.createUiServer({ host: { name: 'test', version: '0.0.0' }, attachments: store, port: 0 })
    const boot = await fetch(server.url, { redirect: 'manual' })
    cookie = (boot.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    // server.url 带 ?token=…：往它后面直接拼路径会把路径拼进查询串，请求落到根路由。
    // 这里用「主机:端口」自己拼，与探针同一个口径。
    origin = `http://127.0.0.1:${server.port}`
  })

  test('换票拿到会话 Cookie', () => {
    expect(cookie.startsWith('dsc_ui=')).toBe(true)
  })

  test('没 Cookie 上传被拒（401）', async () => {
    const denied = await fetch(`${origin}/api/attachments?name=x.png`, { method: 'POST', body: PNG })
    expect(denied.status).toBe(401)
  })

  test('上传成功并返回引用（sha 与仓库算出来的一致）', async () => {
    const upload = await fetch(`${origin}/api/attachments?name=上传.png`, {
      method: 'POST',
      headers: { cookie },
      body: PNG,
    })
    expect(upload.status).toBe(200)
    const uploaded = (await upload.json()) as { ok?: boolean; attachment?: { url?: string; sha?: string } }
    expect(uploaded.ok).toBe(true)
    expect(uploaded.attachment?.sha).toBe(saved.sha)
    expect(typeof uploaded.attachment?.url).toBe('string')
  })

  test('读回字节一致、类型正确、声明支持 Range', async () => {
    const read = await fetch(`${origin}${saved.url}`, { headers: { cookie } })
    const body = Buffer.from(await read.arrayBuffer())
    expect(read.status).toBe(200)
    expect(body.equals(PNG)).toBe(true)
    expect(read.headers.get('content-type')).toBe('image/png')
    expect(read.headers.get('accept-ranges')).toBe('bytes')
  })

  test('Range 请求回 206 且只给 8 字节', async () => {
    const ranged = await fetch(`${origin}${saved.url}`, { headers: { cookie, range: 'bytes=0-7' } })
    expect(ranged.status).toBe(206)
    expect((await ranged.arrayBuffer()).byteLength).toBe(8)
  })

  test('视频按 video/mp4 读回', async () => {
    const videoRead = await fetch(`${origin}${video.url}`, { headers: { cookie } })
    expect(videoRead.headers.get('content-type')).toBe('video/mp4')
  })
})

describe('⑥ 会话投影：内存拿 data URL，日志只写引用', () => {
  /** 会话实例与它的文件路径。 */
  let session: ReturnType<SessionModule['Session']['create']>
  let filePath: string
  /** 视频帧的引用。 */
  let frame: ReturnType<InstanceType<AttachmentsModule['AttachmentStore']>['save']>

  beforeAll(async () => {
    mkdirSync(join(home.home, 'work'), { recursive: true })
    frame = store.save('演示-帧1.jpg', PNG)
    session = sessionCore.Session.create(join(home.home, 'work'))
    session.appendUser('看这张图', [saved.url], [{ ...video, kind: 'video', frames: [frame.url] }])
    filePath = session.filePath
    // 会话日志是流式追加：close() 只负责 end()，等落盘有 finish 那一拍。
    session.close()
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  })

  test('内存消息是数组，正文带视频路径句柄', () => {
    const message = session.messages[0]
    expect(Array.isArray(message?.content)).toBe(true)
    const parts = Array.isArray(message?.content) ? message.content : []
    const textPart = parts.find((part) => part.type === 'text')
    expect(textPart?.type === 'text' ? textPart.text : '').toContain('演示.mp4')
  })

  test('用户图与视频帧都进了请求（两张 image 块）', () => {
    const parts = Array.isArray(session.messages[0]?.content) ? session.messages[0]!.content as Array<{ type: string }> : []
    const images = parts.filter((part) => part.type === 'image_url')
    expect(images).toHaveLength(2)
  })

  test('图片读成 data URL', () => {
    const parts = Array.isArray(session.messages[0]?.content)
      ? (session.messages[0]!.content as Array<{ type: string; image_url?: { url?: string } }>)
      : []
    const first = parts.find((part) => part.type === 'image_url')
    expect(first?.image_url?.url?.startsWith('data:image/png;base64,')).toBe(true)
  })

  test('消息上带文件元数据', () => {
    expect(Array.isArray(session.messages[0]?.files)).toBe(true)
    expect(session.messages[0]?.files).toHaveLength(1)
  })

  test('日志里没有 base64，写的是引用与文件元数据', () => {
    const logLine = readFileSync(filePath, 'utf8')
      .split('\n')
      .find((line) => line.includes('"type":"user"')) ?? ''
    expect(logLine).not.toContain('base64')
    expect(logLine).toContain(saved.url)
    expect(logLine).toContain('"files"')
  })

  test('帧只挂在 files 里，不进用户图片列（日志形状）', () => {
    const logLine = readFileSync(filePath, 'utf8')
      .split('\n')
      .find((line) => line.includes('"type":"user"')) ?? ''
    const logged = JSON.parse(logLine) as { files: Array<{ frames?: unknown[] }>; images: unknown[] }
    expect(logged.files[0]?.frames).toHaveLength(1)
    expect(logged.images).toHaveLength(1)
  })

  test('重开会话恢复用户图、视频帧与文件', () => {
    const reopened = sessionCore.Session.load(filePath)
    const replay = reopened.messages[0]
    const parts = Array.isArray(replay?.content) ? (replay.content as Array<{ type: string; image_url?: { url?: string } }>) : []
    const images = parts.filter((part) => part.type === 'image_url')
    expect(images).toHaveLength(2)
    expect(images.every((part) => part.image_url?.url?.startsWith('data:image/png;base64,'))).toBe(true)
    expect(replay?.files?.[0]?.sha).toBe(video.sha)
    reopened.close()
  })
})
