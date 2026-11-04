/**
 * 地址栏里的一行字 → 能交给原生视图加载的地址（浏览器插件的唯一判定口）。
 *
 * 口径照 dsh 的 `parseBrowserAddress`：只放行 http/https，带凭据的地址拒掉
 * （`https://user:pass@host` 既进不了鉴权流程，又会把凭据留在地址栏和页签栏里）。
 *
 * 比 dsh 多一条便利：**没写协议就补 `https://`**。用户打 `github.com` 是常态，
 * 让人工补协议没有道理；本机地址（localhost / 127.0.0.1 / [::1]）补 `http://`，
 * 因为开发服务器几乎不会是 TLS。
 *
 * 为什么要单独一个零依赖文件：它是「地址栏能去哪些地方」的唯一判定口，探针值得钉死，
 * 而探针用 Node 的类型擦除直读源码（`.tsx` 读不了）。
 *
 * @module dsc-ui-shell/plugins/browser/address
 */

/** 地址长度上限（与原生桥 MAX_PATH 对齐：更长的东西到桥那一步也会被拒）。 */
const MAX_ADDRESS = 4096

/** 本机地址：这几个补 `http://`（开发服务器基本都在本机明文跑）。 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']

/** 协议闸门：http/https 之外一律不放行（`javascript:` / `file:` / `data:` / 自造协议）。 */
export function isBrowsableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

/**
 * 把地址栏里的一行字整成可加载的 URL。
 *
 * @param input 用户敲进去的原文（可能有前后空格、可能没写协议）
 * @returns 可加载的地址；空串或不是 http/https 时给 null（调用方给一句能读的提示）
 */
export function normalizeAddress(input: string): string | null {
  const raw = input.trim()
  if (raw === '' || raw.length > MAX_ADDRESS) return null
  // 带 `://` 但协议不是 http/https：`file://` / `chrome://` 这类，直接拒
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !isBrowsableUrl(raw)) return null
  // 有 scheme 但没 `//`：冒号后面不是数字就算协议（`javascript:alert(1)`、`mailto:x`、`data:text/…`）。
  // `localhost:5173` 这种「主机:端口」不是协议，放过去补前缀。
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw) && !isBrowsableUrl(raw)) return null
  const candidate = isBrowsableUrl(raw)
    ? raw
    : `${LOCAL_HOSTS.includes(hostPart(raw)) ? 'http' : 'https'}://${raw}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.hostname === '') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  return parsed.toString()
}

/** 取「主机」那一段（补协议前缀前先看清是不是本机）。IPv6 带方括号，要整段取。 */
function hostPart(raw: string): string {
  const cut = raw.split(/[/?#]/, 1)[0] ?? ''
  if (cut.startsWith('[')) {
    const close = cut.indexOf(']')
    return (close === -1 ? cut : cut.slice(0, close + 1)).toLowerCase()
  }
  return (cut.split(':')[0] ?? '').toLowerCase()
}
