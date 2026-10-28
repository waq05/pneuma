/**
 * 附件仓库自检：内容寻址、魔数校验、引用读回、HTTP 上传/读取、会话投影。
 *
 * 为什么单独一张网：图片从「base64 塞请求体」改成「先上传、再发引用」以后，任何一处
 * 口径漂了都不会立刻报错——界面可能贴得进去但模型看到空图、会话日志可能又把 base64
 * 写回去、视频可能存成 `file` 却按 `video` 发给播放器。这里把四件事钉死：
 *
 *   ① 仓库：同字节去重、空文件拒收、超限拒收、魔数说了算（不信扩展名）；
 *   ② 引用：`/api/attachments/<sha>` 能读回 data URL，缺对象时明确失败；
 *   ③ 路由：上传要过 Cookie 闸，读回支持 Range（视频拖动进度条靠它）；
 *   ④ 会话：jsonl 只写引用、内存消息拿 data URL，视频以路径句柄拼进正文。
 *
 * 全部跑在临时 HOME 里，真实 `~/.dsc` 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/attachments-test.mjs
 *
 * @module dsc/scripts/attachments-test
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-attachments-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })
writeFileSync(join(process.env.DSC_HOME, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const {
  AttachmentError,
  AttachmentStore,
  attachmentUrl,
  fileHandleText,
  formatBytes,
  parseAttachmentUrl,
  resolveImageForRequest,
  sanitizeFileRefs,
  setAttachmentStoreForTest,
  sniffMedia,
} = await import('../lib/core/attachments.js')
const { createUiServer } = await import('../lib/core/ui-server.js')
const { Session } = await import('../lib/core/session.js')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  PASS ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${extra === '' ? '' : ` — ${extra}`}`)
}

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

const root = join(home, 'store')
const store = new AttachmentStore({ root })
setAttachmentStoreForTest(store)

console.log('— 魔数 —')
check('PNG', sniffMedia(PNG).kind === 'image' && sniffMedia(PNG).mime === 'image/png')
check('JPEG', sniffMedia(JPEG).mime === 'image/jpeg')
check('MP4', sniffMedia(MP4).kind === 'video' && sniffMedia(MP4).mime === 'video/mp4')
check('WebM', sniffMedia(WEBM).mime === 'video/webm')
check('未知字节按文件', sniffMedia(Buffer.from('hello world')).kind === 'file')

console.log('— 仓库 —')
const saved = store.save('截图 1.png', PNG)
check('sha 是 64 位', /^[0-9a-f]{64}$/.test(saved.sha))
check('类别是图片', saved.kind === 'image' && saved.mime === 'image/png')
check('字节数一致', saved.bytes === PNG.length)
check('对象真的落盘', readFileSync(saved.path).equals(PNG))
check('url 是引用', saved.url === attachmentUrl(saved.sha, saved.name))
check('名字被安全化', saved.name === '截图 1.png')

const again = store.save('另一个名字.png', PNG)
check('同字节去重（sha 相同）', again.sha === saved.sha)
check('同字节只有一份对象', store.stat(saved.sha).size === PNG.length)

const video = store.save('演示.mp4', MP4)
check('视频类别', video.kind === 'video' && video.mime === 'video/mp4')

try {
  store.save('empty.png', Buffer.alloc(0))
  check('空文件拒收', false)
} catch (error) {
  check('空文件拒收', error instanceof AttachmentError)
}

const huge = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)])
try {
  store.save('huge.png', huge)
  check('超限拒收（图片 20MiB）', false)
} catch (error) {
  check('超限拒收（图片 20MiB）', error instanceof AttachmentError && error.message.includes('上限'))
}

console.log('— 引用读回 —')
const dataUrl = resolveImageForRequest(saved.url)
check('读成 data URL', dataUrl.startsWith('data:image/png;base64,'))
check('字节没有丢', Buffer.from(dataUrl.split(',')[1], 'base64').equals(PNG))
check('老 data URL 原样过', resolveImageForRequest('data:image/png;base64,AAAA') === 'data:image/png;base64,AAAA')
check('引用解析', parseAttachmentUrl(saved.url) === saved.sha)
check('不是引用回 null', parseAttachmentUrl('/api/other/1') === null)
try {
  resolveImageForRequest(attachmentUrl('0'.repeat(64)))
  check('缺对象时明确失败', false)
} catch {
  check('缺对象时明确失败', true)
}

const handle = fileHandleText([{ ...video, kind: 'video', path: 'C:\\tmp\\演示.mp4' }])
check('路径句柄带文件名', handle.includes('演示.mp4'))
check('路径句柄带摘要前缀', handle.includes(video.sha.slice(0, 12)))
check('路径句柄带只读路径', handle.includes('C:\\tmp\\演示.mp4'))
check('字节读法', formatBytes(1536) === '1.5 KB')

console.log('— 文件引用洗白 —')
const frameUrl = store.save('帧预览.jpg', PNG).url
const clean = sanitizeFileRefs([{ sha: video.sha, kind: 'video', name: '演示.mp4', mime: 'video/mp4', path: 'C:\\Windows\\win.ini' }])
check('路径按仓库重算', clean[0].path === video.path)
check('字节按仓库重算', clean[0].bytes === video.bytes)
try {
  sanitizeFileRefs([{ sha: 'f'.repeat(64), kind: 'video', name: 'x.mp4', mime: 'video/mp4' }])
  check('不存在的 sha 被拒', false)
} catch {
  check('不存在的 sha 被拒', true)
}
try {
  sanitizeFileRefs([{ sha: video.sha, kind: 'image', name: 'x', mime: 'image/png' }])
  check('图片混进 files 被拒', false)
} catch {
  check('图片混进 files 被拒', true)
}
const withFrames = sanitizeFileRefs([{ sha: video.sha, kind: 'video', name: '演示.mp4', mime: 'video/mp4', frames: [frameUrl] }])
check('视频帧引用被收下', withFrames[0].frames?.length === 1 && parseAttachmentUrl(withFrames[0].frames[0]) === parseAttachmentUrl(frameUrl))
const withoutFrames = sanitizeFileRefs([{ sha: video.sha, kind: 'video', name: '演示.mp4', mime: 'video/mp4', frames: ['/api/attachments/' + 'f'.repeat(64)] }])
check('不存在的帧被丢掉', withoutFrames[0].frames === undefined)

console.log('— HTTP 路由 —')
const server = await createUiServer({
  host: { name: 'test', version: '0.0.0' },
  attachments: store,
  port: 0,
})
const origin = `http://127.0.0.1:${server.port}`
const boot = await fetch(server.url, { redirect: 'manual' })
const cookie = (boot.headers.get('set-cookie') ?? '').split(';')[0]
check('换票拿到 Cookie', cookie.startsWith('dsc_ui='))

const denied = await fetch(`${origin}/api/attachments?name=x.png`, { method: 'POST', body: PNG })
check('没 Cookie 上传被拒', denied.status === 401)

const upload = await fetch(`${origin}/api/attachments?name=上传.png`, {
  method: 'POST',
  headers: { cookie },
  body: PNG,
})
const uploaded = await upload.json()
check('上传成功', upload.status === 200 && uploaded.ok === true)
check('上传返回引用', typeof uploaded.attachment?.url === 'string' && uploaded.attachment.sha === saved.sha)

const read = await fetch(`${origin}${uploaded.attachment.url}`, { headers: { cookie } })
const readBytes = Buffer.from(await read.arrayBuffer())
check('读回字节一致', read.status === 200 && readBytes.equals(PNG))
check('读回类型正确', read.headers.get('content-type') === 'image/png')
check('读回支持 Range', read.headers.get('accept-ranges') === 'bytes')

const ranged = await fetch(`${origin}${uploaded.attachment.url}`, {
  headers: { cookie, range: 'bytes=0-7' },
})
check('Range 回 206', ranged.status === 206)
check('Range 只给 8 字节', (await ranged.arrayBuffer()).byteLength === 8)

const videoRead = await fetch(`${origin}${video.url}`, { headers: { cookie } })
check('视频按 video/mp4 读回', videoRead.headers.get('content-type') === 'video/mp4')

console.log('— 会话投影 —')
mkdirSync(join(home, 'work'), { recursive: true })
const frame = store.save('演示-帧1.jpg', PNG)
const session = Session.create(join(home, 'work'))
session.appendUser('看这张图', [saved.url], [{ ...video, kind: 'video', frames: [frame.url] }])
const message = session.messages[0]
check('内存消息是数组', Array.isArray(message.content))
const parts = Array.isArray(message.content) ? message.content : []
const textPart = parts.find((part) => part.type === 'text')
const imageParts = parts.filter((part) => part.type === 'image_url')
check('正文带视频路径句柄', typeof textPart?.text === 'string' && textPart.text.includes('演示.mp4'))
check('用户图与视频帧都进了请求', imageParts.length === 2)
check('图片读成 data URL', typeof imageParts[0]?.image_url?.url === 'string' && imageParts[0].image_url.url.startsWith('data:image/png;base64,'))
check('消息上带文件元数据', Array.isArray(message.files) && message.files.length === 1)
const filePath = session.filePath
session.close()
// 会话日志是流式追加：close() 只负责 end()，等落盘有 finish 那一拍
await new Promise((resolveWait) => setTimeout(resolveWait, 200))
const logLine = readFileSync(filePath, 'utf8').split('\n').find((line) => line.includes('"type":"user"')) ?? ''
const logged = JSON.parse(logLine)
check('日志里没有 base64', !logLine.includes('base64'))
check('日志里是引用', logLine.includes(saved.url))
check('日志里带文件元数据', logLine.includes('"files"'))
check('帧只挂在 files 里，不进用户图片列', Array.isArray(logged.files[0].frames) && logged.files[0].frames.length === 1 && logged.images.length === 1)

const reopened = Session.load(filePath)
const replay = reopened.messages[0]
const replayParts = Array.isArray(replay.content) ? replay.content : []
check('重放恢复用户图', replayParts.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,')))
check('重放恢复视频帧', (replayParts.filter((part) => part.type === 'image_url').length) === 2)
check('重放恢复文件', Array.isArray(replay.files) && replay.files[0].sha === video.sha)
reopened.close()

setAttachmentStoreForTest(null)
await server.close()
rmSync(home, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? '全部通过' : `${String(failures)} 项失败`)
process.exit(failures === 0 ? 0 : 1)
