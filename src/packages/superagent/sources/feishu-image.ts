/**
 * 移植自 dsh-superagent/src/sources/feishu-image.ts（55 行，原生重写）。
 * 改动点（下载、临时目录、越界路径、扩展名的判定顺序与错误文案逐字保留；字节上限的判据换了，文案随之改，见下）：
 *   ① 删掉三个 DSH 依赖：`@deepseek-ai/dsh-agent` 的 `Agent`、`@deepseek-ai/dsh-attachment` 的
 *      `ImageAttachmentRef` / `ImageMediaType`、`@deepseek-ai/dsh-llm` 的副作用 import；
 *   ② 「把图片交给模型看」那一段换成本仓现成的附件入口：`src/core/attachments.ts:359` 的
 *      `attachmentStore()`（进程级 `AttachmentStore`，内容寻址落盘、按魔数判类型、单图 20MiB，
 *      见 `src/core/attachments.ts:49`），下载到的字节直接存成附件并返回 `AttachmentMeta`。
 *      上游的「当前模型路由是否支持图片」前置检查（`llm.resolveModelInfo`，上游 27-33 行）在这一层
 *      拿不到模型路由——`SourceAgent` 现在还是过渡的不透明值（`sources/host.ts` 顶部注释）——因此
 *      移到执行器批接入时再做（执行器批已核：没做，见下面第 2 条宿主差异）；缺它不影响下载与落盘，只是模型读不到图时才发现。
 *      上游按扩展名建 `ImageMediaType` 的那一步保留（只用于挡掉明显不是图的下载结果），真正的类型
 *      判定交给 `AttachmentStore` 的魔数 sniff；落盘前用 `sniffMedia` / `isImageMime` 再核一次，
 *      避免把非图片字节存进附件仓库，错误文案沿用上游那句。
 *   ③ `Commands`（上游 `infra/commands.ts` 的类）改从本仓 `../infra/commands.js` 取，
 *      `agent` 形参保留（`kind.ts` 的 `ThreadContext.image` 契约要求），本仓当前用不到；
 *   ④ import 路径 `.ts` → `.js`。
 *
 * 两条宿主差异（上游有、本仓没有对应物），都已核过源文件：
 * - **单图上限没有部署级配置**。上游取 `deployment` 的 `attachments.imageLimits`（取
 *   `min(maxImageBytes, maxMessageImageBytes)`，上游 46 行）；本仓全仓没有 `imageLimits` /
 *   `maxImageBytes` 这组配置（`Deployment` 里也没有），`core/attachments.ts:49` 的 `MAX_IMAGE_BYTES`
 *   （20MiB）就是唯一判据。所以这里直接用 `MAX_IMAGE_BYTES`，错误文案随之改成
 *   "The image exceeds the attachment byte limit…"：本仓没有「部署级上限」可指，不能沿用上游那句
 *   "deployment byte limit"。
 * - **「模型收不收图」的检查位置变了，且本层补不上**。上游在下载前用 `agent.ctx.get('llm')` 的
 *   `resolveModelInfo` 判 `inputModalities` 含不含 image（上游 25-33 行）。本仓执行器
 *   `executor/dsh.ts` 里没有这段检查（grep `image` / `modalities` 只有文件头注释）；兜底在投影链：
 *   `src/packages/prompt/index.ts:271-274` 的 `drop-images` 在发请求前把图换成一句说明
 *   （`ctx.llm.inputModalities` 不含 image 时）。也就是说位置从「下载前拒掉」变成「请求前剥掉」：
 *   图会下载并落盘，模型看不到时也拿不到上游那句明确错误。要在本层补，得给 `readAdmissionImage`
 *   加一个模型能力参数并改 `sources/feishu-read.ts:178` 的调用（不在本轮可写范围）。
 *
 * Downloads Feishu message images and commits them as attachments during assessment.
 *
 * @module dsc/packages/superagent/sources/feishu-image
 */
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { MAX_IMAGE_BYTES, attachmentStore, isImageMime, sniffMedia, type AttachmentMeta }
  from '../../../core/attachments.js'
import type { Commands } from '../infra/commands.js'
import type { SourceAgent } from './host.js'
import type { FeishuRef } from './feishu-read.js'

/** Extracts Feishu image keys from message text so keys remain paired with the originating message; arbitrary remote IDs are not accepted. */
export function admissionImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_[a-zA-Z0-9_-]+\b/g) ?? [])]
}

export interface AdmissionImage {
  source_message_id: string
  image_key: string
  image: AttachmentMeta
}

export async function readAdmissionImage(agent: SourceAgent, commands: Commands, ref: FeishuRef, text: string, imageKey: string, stateDir: string, signal: AbortSignal): Promise<AdmissionImage> {
  if (!admissionImageKeys(text).includes(imageKey)) throw new Error('Choose an image key from this source message')
  const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/).parse(ref.messageId)
  // 上游这里从 agent 的 ctx 取附件服务；本仓取进程级附件仓库（见文件头 ②）。`agent` 形参保留给执行器批接入。
  void agent
  const attachments = attachmentStore()
  signal.throwIfAborted()
  const directory = await mkdtemp(join(stateDir, 'admission-image-'))
  try {
    const result = z.object({ saved_path: z.string() }).parse(await commands.withSignal(signal).lark([
      'im', '+messages-resources-download', '--message-id', messageId, '--file-key', imageKey, '--type', 'image', '--output', './image',
    ], directory))
    const path = await realpath(result.saved_path)
    if (dirname(path) !== await realpath(directory)) throw new Error('Image download returned a path outside its temporary directory')
    const mediaTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
    const mediaType = mediaTypes[extname(path).toLowerCase()]
    if (!mediaType) throw new Error('The downloaded resource is not a supported PNG/JPEG/WebP/GIF image')
    const file = await stat(path)
    if (!file.isFile() || file.size > MAX_IMAGE_BYTES) throw new Error('The image exceeds the attachment byte limit or is not a regular file')
    const data = await readFile(path, { signal })
    signal.throwIfAborted()
    const sniffed = sniffMedia(data.subarray(0, 64))
    if (sniffed.kind !== 'image' || !isImageMime(sniffed.mime)) throw new Error('The downloaded resource is not a supported PNG/JPEG/WebP/GIF image')
    const image = attachments.save(`${imageKey}${extname(path)}`, data)
    signal.throwIfAborted()
    return { source_message_id: messageId, image_key: imageKey, image }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
