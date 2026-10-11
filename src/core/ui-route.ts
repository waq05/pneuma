/**
 * 插件 bundle 的 HTTP 解析：把 `/plugins/<id>/<file>?rev=` 解析成「回什么字节」。
 *
 * 为什么单独一份：本机界面服务（`core/ui-server.ts`）与远程控制（`plugins/remote/routes.ts`）
 * 都要下发同一批插件 bundle——C-真 的要点正是**桌面与远程看同一份界面**，
 * 所以解析口径只能有一处，否则两边对「版本对不上该不该给」这类判断会慢慢分叉。
 *
 * 四条规矩：
 *
 *   - **id 可以是多段**（`@scope/name`）：解析口径是"最后一个 `/` 之前全是 id"，
 *     最后一个 `/` 之后是文件名；文件名不许再带分隔符，id 的形状由
 *     `core/ui-bundles.ts` 的 `PLUGIN_ID` 与 `inside()` 围栏共同把关。
 *   - **缺 rev 一律 404**：地址里没有内容指纹就不是内容寻址的地址，绝不能混进
 *     "一年不可变"那一档——否则一旦被（代理）缓存，升级后一年不回源，用户看到的是旧界面。
 *   - **rev 对得上给当下这一代，对上前一代给旧字节**：插件刚重建时，已经打开、还没刷新的
 *     页面手上还是旧地址，它必须还能拿到旧字节，否则那个插件当场加载失败、只能手动刷新。
 *     两代都没有才 404（旧地址不该拿到新代码，新地址也不该拿到旧代码）。
 *   - **方法是 GET / HEAD**：HEAD 复用 GET 的头但不给体；其余方法 405（带 Allow）。
 *
 * @module dsc/core/ui-route
 */
import { lookupUiPluginBundle, lookupThirdPartyUiBundle, uiPluginsDir } from './ui-bundles.js'

/** 插件资源的路由前缀。 */
export const UI_BUNDLE_ROUTE = '/plugins/'

/** 内容寻址的命中给一年不可变缓存（地址里带内容指纹，同一地址的内容永不改变）。 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

/** 解析结果：状态码 + 该回的头 + 该回的字节（非 200 时只有理由）。 */
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
 * @param pathname - 请求路径（`/plugins/@scope/name/client.js`）
 * @param rev - 查询参数里的版本；缺省（null / 空串）一律 404——地址不带指纹就不是内容寻址
 * @param dir - 插件目录，缺省 `lib/ui/plugins`
 * @param method - 请求方法，缺省 GET；非 GET / HEAD 回 405
 */
export function resolveUiBundleRequest(
  pathname: string,
  rev: string | null,
  dir: string = uiPluginsDir(),
  method: string = 'GET',
): UiBundleResponse {
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { allow: 'GET, HEAD' }, reason: '插件资源只认 GET 与 HEAD' }
  }
  const rest = pathname.slice(UI_BUNDLE_ROUTE.length)
  // 最后一个 `/` 之前全是 id（`@scope/name` 这类多段 id 因此成立），之后是文件名。
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
  if (rev === null || rev === '') {
    return { status: 404, reason: '插件地址缺少 rev：内容寻址的地址必须带版本' }
  }
  const wantBody = method !== 'HEAD'
  const found = lookupUiPluginBundle(id, file, rev, dir, wantBody)
  if (!found.known) {
    // 内置清单里没有 → 查第三方（~/.dsc/plugins/ 的界面半边）。两边同一份回话口径。
    const third = lookupThirdPartyUiBundle(id, file, rev, undefined, wantBody)
    if (third.known && (third.current || third.previous)) {
      const headers: Record<string, string> = {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': String(third.size ?? 0),
        'cache-control': IMMUTABLE_CACHE,
      }
      if (!wantBody || third.body === null) return { status: 200, headers }
      return { status: 200, headers, body: third.body }
    }
    return { status: 404, reason: third.known ? '插件版本对不上' : '没有这个插件' }
  }
  if (!found.current && !found.previous) return { status: 404, reason: '插件版本对不上' }
  if (found.size === null || (wantBody && found.body === null)) {
    return {
      status: 404,
      // 旧代字节没留下（宿主重启过之类）：说清楚怎么办，别让用户对着 404 猜。
      reason: found.previous ? '插件已经重建，上一代的字节不再保留，刷新页面即可' : '插件文件读不出来',
    }
  }
  const headers: Record<string, string> = {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': String(found.size),
    'cache-control': IMMUTABLE_CACHE,
  }
  if (!wantBody || found.body === null) return { status: 200, headers }
  return { status: 200, headers, body: found.body }
}
