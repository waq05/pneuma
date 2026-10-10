/**
 * 静态资源伺服：把界面产物目录挂在 HTTP 上。
 *
 * 原来这段长在 `plugins/remote/routes.ts` 里（服务手机端界面）。本机界面服务要的是
 * 同一件事（服务 `lib/ui/assets`），只多一个「送 index.html 之前改写一下」的钩子——
 * 宿主就是靠它把启动清单注进页面的。所以上移到 core，两处共用。
 *
 * @module dsc/core/web-static
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

/** 认得的扩展名 → content-type；认不得的按二进制发。 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 目标路径必须在给定目录里面（`..` 与绝对路径都挡掉）。 */
export function inside(dir: string, target: string): boolean {
  const root = resolve(dir)
  return target === root || target.startsWith(root + sep)
}

/** 伺服一个静态目录时要调的那几个旋钮。 */
export interface StaticOptions {
  /** 目录不存在（界面还没构建）时 `/` 返回的占位页；不传就回 404。 */
  placeholderHtml?: string
  /** index.html 送出前的改写钩子（注入启动清单）。 */
  transformHtml?(html: string, pathname: string): string
  /**
   * 缓存策略。界面产物带内容哈希、index.html 不带，所以默认 no-cache（刷新就能拿到新版）；
   * 插件 bundle 走内容寻址，调用方会显式传一年不可变。
   */
  cacheControl?: string
}

/**
 * 伺服静态文件；无论命中与否**都会应答**（命中 200、`/` 回占位页、其余 404）。
 * @param res - HTTP 应答
 * @param pathname - 请求路径（`/`、`/app-abc.js`）
 * @param dir - 产物目录
 * @param options - 改写与缓存策略
 * @returns 命中了真实文件就是 true（调用方拿它决定要不要记日志）
 */
export function serveStatic(
  res: ServerResponse,
  pathname: string,
  dir: string,
  options: StaticOptions = {},
): boolean {
  const cacheControl = options.cacheControl ?? 'no-cache'
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const target = resolve(dir, rel)
  if (inside(dir, target) && existsSync(target) && statSync(target).isFile()) {
    const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
    let body: Buffer | string = readFileSync(target)
    if (body.length > 0 && (target.endsWith('.html') || target.endsWith('.htm')) && options.transformHtml !== undefined) {
      body = options.transformHtml(body.toString('utf8'), pathname)
    }
    const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    res.writeHead(200, {
      'content-type': type,
      'content-length': buffer.length,
      'cache-control': cacheControl,
    })
    res.end(buffer)
    return true
  }
  if (pathname === '/' && options.placeholderHtml !== undefined) {
    const body = options.placeholderHtml
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-cache',
    })
    res.end(body)
    return false
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('没有这个文件')
  return false
}
