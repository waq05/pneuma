/**
 * 只读图片的工具（对齐 dsh `tool-fs` 的 `readImage` 能力）。
 *
 * 为什么单独存在而不是复用 read：极简档要测「模型手上只有一条 shell」的基础表现，
 * 参考实现那一档只留 `readImage: true`、把 `read` 关掉；Pneuma 的 read 同时能读文本，
 * 直接给它就等于把「只能靠 shell 看文件」这条前提破了。所以这个工具只认图片，
 * 只挂在极简档（`presets: ['minimal']`），标准档看不见它。
 *
 * 放在独立文件里而不是并进 fs-tools：README 的「工具集 N 件」按
 * `bash / fs-tools / search-tools` 三个文件数工具，极简档专用的这一件不该改变那个口径。
 *
 * @module dsc/core/tools/image-tool
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ToolEntry } from '../tools.js'
import { noteRead, readBlockReason } from '../path-policy.js'

/** read 认得的图片扩展名 → MIME（data URL 前缀用；与 fs-tools 的 read 同一条红线）。 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

/** 一张图进上下文的尺寸上限：6MB 原图 base64 后约 8MB，与输入框贴图同一条红线。 */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024

const abs = (cwd: string, p: unknown): string => {
  if (typeof p !== 'string' || p === '') throw new Error('path 必须是非空字符串')
  return isAbsolute(p) ? p : resolve(cwd, p)
}

export const readImageTool: ToolEntry = {
  name: 'read_image',
  description: '看一张图片（png/jpg/gif/webp/bmp/svg），直接作为图片附件加载；文本文件请用 shell 读。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '图片路径（绝对或相对当前目录）' } },
    required: ['path'],
  },
  risk: 'read',
  presets: ['minimal'],
  async run(args, ctx) {
    const file = abs(ctx.cwd, args.path)
    const blocked = readBlockReason(file)
    if (blocked !== null) throw new Error(blocked)
    const mime = IMAGE_MIME[file.slice(file.lastIndexOf('.') + 1).toLowerCase()]
    if (mime === undefined) {
      throw new Error('read_image 只接受图片（png/jpg/gif/webp/bmp/svg）；文本文件请用 shell 命令读')
    }
    const stat = await fs.stat(file)
    if (stat.size > IMAGE_MAX_BYTES) {
      throw new Error(`这张图有 ${Math.round(stat.size / 1024 / 1024)}MB，超过 6MB 上限；先压缩或缩小再看`)
    }
    const bytes = await fs.readFile(file)
    noteRead(file, ctx.sessionId)
    return {
      text: `已加载图片 ${file}（${mime}，${stat.size} 字节），图在附件里。`,
      images: [`data:${mime};base64,${bytes.toString('base64')}`],
    }
  },
}
