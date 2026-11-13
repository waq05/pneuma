/**
 * 飞书消息里的图片：把 `img_...` 这张资源下载下来，落进 DSC 的附件仓库。
 *
 * 与上游（`feishu-image.ts:22-55`）的区别只有「落到哪」这一处：上游把字节交给 dsh 的
 * `attachments.saveImage({ data, mediaType, name })`，DSC 的对应物是
 * `core/attachments.ts` 的 `AttachmentStore.save(name, bytes)`（20MiB 上限、按魔数判类型、
 * 内容寻址去重，见 `core/attachments.ts:226-245`）。两边都是「字节进、引用出」，所以判定
 * 顺序原样保留：先确认这个 key 出自这条消息的正文，再看扩展名，再截断超出上限的，最后才落盘。
 *
 * **没搬的是「当前模型看不看得懂图片」那道前置检查**（上游 `feishu-image.ts:27-33`）：
 * 它要读 agent 的模型路由与 `llm.resolveModelInfo`，属于评估/执行侧的知识。DSC 的附件仓库
 * 只存字节、不判断模型能力，所以那道检查留给接入方（拿 `AttachmentMeta.mime` 与自己当前的
 * 模型路由比一下即可）。缺了它不是读错图：模型不支持图片时，图已经存下、只是用不上，浪费一次
 * 下载与一份字节。
 *
 * **也没有 `AbortSignal`**：`CliRun` 端口不带取消（一次调用由执行器的超时兜底）。取消语义在
 * 本层只影响「下载到一半要不要放弃」，不影响正确性。
 *
 * @module dsc/packages/superagent/adapters/feishu/image
 */
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { z } from 'zod'
import {
  MAX_IMAGE_BYTES, isImageMime, sniffMedia, type AttachmentMeta,
} from '../../../../core/attachments.js'
import { lark, type CliRun } from './cli.js'
import type { FeishuRef } from './trigger.js'

/**
 * 从正文里认出图片 key。
 *
 * 只认 `img_` 前缀并且去重：正文是外部数据，模型可能顺着别处的 id 让本层去下另一条消息的图，
 * 所以调用时还要再核一遍「这个 key 出自这条消息」（上游 `feishu-image.ts:11-14`）。
 */
export function admissionImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_[a-zA-Z0-9_-]+\b/g) ?? [])]
}

/** 落盘的结果：源消息与图片 key 一起交回，保证「这张图属于哪句话」不会在调用点被弄混。 */
export interface AdmissionImage {
  source_message_id: string
  image_key: string
  image: AttachmentMeta
}

/** 附件仓库里本模块用得到的那一个方法（`AttachmentStore` 的结构子集，测试传假仓库）。 */
export interface FeishuImageStore {
  save(name: string, bytes: Buffer): AttachmentMeta
}

/** `readFeishuImage` 的可选参数。 */
export interface FeishuImageOptions {
  /** 下载用的临时目录的父目录，缺省系统临时目录；测试传自己的目录。 */
  workDirectory?: string
}

/** 下载落地的五种图片类型；其它扩展名一律当作「下载到的不是图」拒绝（`feishu-image.ts:42-44`）。 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}

/**
 * 下载一条消息里的一张图并存成附件。
 *
 * 防的两件事都在上游有对应：
 * - **下载回来的路径必须在临时目录里**：CLI 的 `saved_path` 是它自己打印的，跑飞了就可能指向
 *   任意文件；`realpath` 之后比父目录，符号链接也绕不过去（`feishu-image.ts:40-41`）。
 * - **扩展名不是类型判据**：真正认类型的是魔数（`AttachmentStore.save` 里做），扩展名只用来
 *   给附件起个像样的名字、并挡掉「下了个 SVG 回来」这类明显不对的结果（`feishu-image.ts:42-44`）。
 *
 * @param run - 注入的 CLI 执行器
 * @param store - 注入的附件仓库（生产传 `AttachmentStore`）
 * @param ref - 源消息的回复地址
 * @param text - 源消息正文，用来核 key 的出处
 * @param imageKey - 要下载的 `img_...`
 * @param options - 临时目录的父目录
 * @returns 源消息 id、图片 key 与落盘后的附件元数据
 */
export async function readFeishuImage(run: CliRun, store: FeishuImageStore, ref: FeishuRef, text: string,
  imageKey: string, options: FeishuImageOptions = {}): Promise<AdmissionImage> {
  if (!admissionImageKeys(text).includes(imageKey)) throw new Error('Choose an image key from this source message')
  const sourceMessageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/).parse(ref.messageId)
  const directory = await mkdtemp(join(options.workDirectory ?? tmpdir(), 'feishu-image-'))
  try {
    const result = z.object({ saved_path: z.string() }).parse(await lark(run, [
      'im', '+messages-resources-download', '--message-id', sourceMessageId, '--file-key', imageKey,
      '--type', 'image', '--output', './image',
    ], directory))
    const path = await realpath(result.saved_path)
    if (dirname(path) !== await realpath(directory)) throw new Error('Image download returned a path outside its temporary directory')
    const extension = extname(path).toLowerCase()
    if (!(extension in EXTENSIONS)) throw new Error('The downloaded resource is not a supported PNG/JPEG/WebP/GIF image')
    const file = await stat(path)
    if (!file.isFile() || file.size > MAX_IMAGE_BYTES) {
      throw new Error('The image exceeds the attachment byte limit or is not a regular file')
    }
    const data = await readFile(path)
    const sniffed = sniffMedia(data.subarray(0, 64))
    if (sniffed.kind !== 'image' || !isImageMime(sniffed.mime)) {
      throw new Error('The downloaded resource is not a supported PNG/JPEG/WebP/GIF image')
    }
    const image = store.save(`${imageKey}${extension}`, data)
    // 仓库自己也会按魔数再判一次；两边结论不一致说明拼进来的不是图片字节，宁可报错也不交出去。
    if (image.kind !== 'image') throw new Error('The attachment store did not accept the image as an image')
    return { source_message_id: sourceMessageId, image_key: imageKey, image }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
