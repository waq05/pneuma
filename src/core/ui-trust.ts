/**
 * 浏览器信任闸：本机界面服务（`core/ui-server.ts`）所有路由进门前的三道检查，
 * 外加会话 Cookie 的签名 / 校验与定长时间比较。
 *
 * 为什么单独一份、为什么是三道：只校验 Host 头挡得住 DNS rebinding，挡不住
 * 「同机另一个回环服务反射的页面」——Cookie 的作用域**不含端口**，`127.0.0.1:1111`
 * 下发的 Cookie，浏览器照样会带给 `127.0.0.1:2222`；只要那个端口上的服务能反射
 * 攻击者写的内容，`credentials:'include'` 的 fetch 就能把本服务的 Cookie 送过来。
 * 端口闸之外再补两道，正是要收紧这条缝：
 *
 *   1. **Host**（`core/web-http.ts` 的 hostHeaderAllowed）：hostname 必须是 IP 字面量或
 *      localhost，且端口等于本服务真正在听的端口。DNS rebinding 能让恶意域名解析到
 *      127.0.0.1，浏览器于是带着**攻击者的域名**打本机端口——Host 是 rebinding 唯一
 *      伪造不了的头，所以它是总闸。
 *   2. **Sec-Fetch-Site: cross-site** 一律拒。现代浏览器在每个 fetch 上标注发起方关系，
 *      显式的跨站标记不用看 Origin 就该拒。
 *   3. **Origin**：带了就必须等于本服务的 authority（比较口径与 Host 一致，即
 *      WHATWG URL 归一化后的 host，大小写与冗余默认端口都不影响判定）；字面量 `null`
 *      （沙箱 iframe、file: 页面）是不透明来源，一并拒。
 *
 * **第 2、3 道是补充，不能取代第 1 道**：纯 HTTP 下浏览器的读请求（图片、导航）既不带
 * Origin 也不带 Fetch-Metadata（那两个头只发给"可信目的地"），所以一个不带任何浏览器标记
 * 的请求仍可能是 rebinding 出来的浏览器读——那种情况下只有 Host 能说明问题。
 *
 * Cookie 也是信任的一部分：值是 HMAC 签名的 `authority + 过期时间`，签名密钥由宿主持有。
 * 签名把 Cookie 钉死在某个 authority 上，于是「另一个端口上的服务反射出来的 Cookie」
 * 即使被送回来也不成立（它的 authority 不是本服务）。
 *
 * @module dsc/core/ui-trust
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { hostHeaderAllowed } from './web-http.js'

/** 被拒时的回话：状态码 + 一句话理由（理由只进日志/响应体，不泄露任何凭据）。 */
export interface UiTrustDenial {
  status: number
  reason: string
}

/** 取一个头的第一个值（同名头出现多次时 node 会给数组）。 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.length === 0 ? undefined : value[0]
  return value
}

/**
 * Host 头归一化成本服务的 authority（`127.0.0.1:17321`、`[::1]:17321`）。
 * 解析不了给空串——空串与任何真实 authority 都不等，凭据校验因此必然不过（失败关闭）。
 */
export function requestAuthority(host: string | undefined): string {
  if (host === undefined || host.trim() === '') return ''
  try {
    return new URL(`http://${host}`).host
  } catch {
    return ''
  }
}

/**
 * 三道闸。通过给 `null`，被拒给状态码与理由。
 *
 * @param headers - 请求头
 * @param port - 本服务真正在听的端口（Host 闸要比对它）
 */
export function checkUiRequestTrust(headers: IncomingHttpHeaders, port: number): UiTrustDenial | null {
  // 闸一：Host（总闸，所有路由都过，包括换票与静态资源）。
  const host = firstHeader(headers.host)
  if (!hostHeaderAllowed(host ?? null, port)) return { status: 403, reason: 'Host 头不被接受' }

  // 闸二：显式的跨站标记。
  const site = firstHeader(headers['sec-fetch-site'])
  if (site !== undefined && site.trim().toLowerCase() === 'cross-site') {
    return { status: 403, reason: '跨站请求不被接受（sec-fetch-site: cross-site）' }
  }

  // 闸三：Origin（带了就必须是它自己）。
  const origin = firstHeader(headers.origin)
  if (origin !== undefined) {
    const expected = requestAuthority(host)
    if (expected === '' || originAuthority(origin) !== expected) {
      return { status: 403, reason: '请求来源（Origin）不是本服务' }
    }
  }

  return null
}

/** Origin 归一化：解析不了（含字面量 `null`）给空串，必然不等于任何真实 authority。 */
function originAuthority(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return ''
  }
}

/**
 * 定长时间比较两段文本（令牌、签名都用它）。
 *
 * 为什么不能用 `!==`：字符串比较在第一个不同的字节就返回，逐字节的耗时差能被
 * 本机进程用统计手法读出来，从而一个字节一个字节地试出令牌。长度不等直接返回 false
 * ——`timingSafeEqual` 对不等长的入参会抛异常，而长度本身不是秘密。
 */
export function timingSafeEqualText(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/** 会话 Cookie 的版本前缀：格式一改就递增，旧值一律不认（失败关闭）。 */
const COOKIE_VERSION = 'v1'

/** 签名体：authority 与过期时间戳，用 `|` 分隔（两段都不含 `|`，拼不出歧义）。 */
function cookieBody(authority: string, expiresAt: number): string {
  return `${authority}|${String(expiresAt)}`
}

/** 用签名密钥算一段 HMAC-SHA256。 */
function sign(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(body).digest()
}

/**
 * 解 base64url。只认 base64url 字符集，别的（含填充 `=`）一律不成形——
 * Cookie 值是我们自己发的，任何越界字符都说明它被动过。
 */
function decodeBase64Url(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null
  const decoded = Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  return decoded.byteLength === 0 ? null : decoded
}

/**
 * 签一条会话 Cookie 的值。
 *
 * @param key - 宿主持有的签名密钥
 * @param authority - 本服务的 authority（从 Host 头取，已过信任闸）
 * @param expiresAt - 过期时刻（毫秒时间戳）
 */
export function issueUiCookie(key: Buffer, authority: string, expiresAt: number): string {
  const body = cookieBody(authority, expiresAt)
  return `${COOKIE_VERSION}.${String(expiresAt)}.${sign(key, body).toString('base64url')}`
}

/**
 * 校验一条会话 Cookie 的值。
 *
 * 四件事都要成立：版本对得上、过期时间还没到、签名是密钥算出来的、且它签的 authority
 * 就是这次请求的 authority。签名校验用定长时间比较；过期时间戳按 Cookie 里的**原文**
 * 重新拼签名体，所以改写成 `1e3` 这类等价但不同文本的形式也会因签名不符而失败。
 *
 * @param key - 宿主持有的签名密钥
 * @param authority - 这次请求的 authority
 * @param value - Cookie 里的值（没带给 null）
 * @param now - 现在（毫秒时间戳，测试可注入）
 */
export function verifyUiCookie(key: Buffer, authority: string, value: string | null, now: number): boolean {
  if (value === null) return false
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const version = parts[0]
  const expiresText = parts[1]
  const signatureText = parts[2]
  if (version !== COOKIE_VERSION) return false
  const expiresAt = Number(expiresText)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false
  const actual = decodeBase64Url(signatureText)
  if (actual === null) return false
  const expected = sign(key, cookieBody(authority, expiresAt))
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}
