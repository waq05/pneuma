/**
 * 插件 bundle 的 HTTP 解析：把 `/plugins/<id>/<file>?rev=` 解析成「回什么字节」。
 *
 * 为什么单独一份：本机界面服务（`core/ui-server.ts`）与远程控制（`plugins/remote/routes.ts`）
 * 都要下发同一批插件 bundle——C-真 的要点正是**桌面与远程看同一份界面**，
 * 所以解析口径只能有一处，否则两边对「版本对不上该不该给」这类判断会慢慢分叉。
 *
 * @module dsc/core/ui-route
 */
import { collectUiPluginArtifacts, readUiPluginBundle, uiPluginsDir } from './ui-bundles.js'

/** 插件资源的路由前缀。 */
export const UI_BUNDLE_ROUTE = '/plugins/'

/** 解析结果：状态码 + 该回的头 + 该回的字节（404 时只有理由）。 */
export interface UiBundleResponse {
  status: number
  headers?: Record<string, string>
  body?: Buffer
  /** 不是 200 时的一句话理由（日志与诊断用）。 */
  reason?: string
}

/** 这个路径是不是插件资源请求。 */
export function isUiBundleRequest(pathname: string): boolean {
  return pathname.startsWith(UI_BUNDLE_ROUTE)
}

/**
 * 解析一个插件资源请求。
 *
 * 三条规矩：
 *   - id 与文件名都不许带路径分隔符（`..` 逃逸在解析这一层就挡掉）；
 *   - 地址里的 `rev` 与服务端当下算出来的不一致就 **404**：旧地址不该拿到新代码，
 *     新地址也不该拿到旧代码，壳会重新取清单；
 *   - 命中时给一年不可变缓存（地址里带内容指纹，同一地址的内容永不改变）。
 *
 * @param pathname - 请求路径（`/plugins/hello/client.js`）
 * @param rev - 查询参数里的版本；缺省不校验（手工排障时方便）
 * @param dir - 插件目录，缺省 `lib/ui/plugins`
 */
export function resolveUiBundleRequest(
  pathname: string,
  rev: string | null,
  dir: string = uiPluginsDir(),
): UiBundleResponse {
  const rest = pathname.slice(UI_BUNDLE_ROUTE.length)
  const slash = rest.lastIndexOf('/')
  if (slash <= 0) return { status: 404, reason: '没有这个插件资源' }
  let id: string
  try {
    id = decodeURIComponent(rest.slice(0, slash))
  } catch {
    return { status: 404, reason: '插件 id 编码不对' }
  }
  const file = rest.slice(slash + 1)
  if (file === '' || file.includes('/') || file.includes('\\')) {
    return { status: 404, reason: '没有这个插件资源' }
  }
  const entry = collectUiPluginArtifacts(dir, 'web').entries.find(
    (candidate) => candidate.id === id && candidate.file === file,
  )
  if (entry === undefined) return { status: 404, reason: '没有这个插件' }
  if (rev !== null && rev !== entry.rev) return { status: 404, reason: '插件版本对不上' }
  const body = readUiPluginBundle(id, file, dir)
  if (body === null) return { status: 404, reason: '插件文件读不出来' }
  return {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body,
  }
}
