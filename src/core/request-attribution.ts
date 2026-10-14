/**
 * 模型请求的归因头：自标识 + 端点点名要的会话头。
 *
 * 为什么单开一节：这里全是纯字符串判断（只 import 版本号），探针能直读；
 * 「哪种端点要哪几个头」是事实，散在 fetch 旁边迟早漂。
 *
 * 当前只有一家点名要：opencode 的 Go 网关按**会话**做路由与 prompt 缓存，
 * 缺 `x-opencode-session` 直接 400 `MissingSessionID`（2026-10-14 用户报障，
 * 分析见 docs/opencode-go-session-header.md）。它同时要求客户端用**自己的**
 * 名字标识自己（通用的 node/undici 不算），所以命中它的入口连 user-agent 一起给。
 *
 * 门控形状（对齐同类客户端的实现）：**host 与 path 一起判**，不认 provider id
 * ——id 是用户随手起的，会变。host 是 `opencode.ai` 或其子域、path 规范化后正好
 * 是 `/zen/go/v1` 才算 Go 入口；普通 Zen（`/zen/v1`）与别的 OpenCode API 都不带。
 *
 * **别家端点一个字节都看不到这些头**：会话头是端点私有的，无条件多带会被挑剔的
 * 网关判 400（与 core/llm 里 `ChatMessage.ts` 那条教训同一件事——请求体如此，
 * 请求头同理）。
 *
 * @module dsc/core/request-attribution
 */
import { DSC_VERSION } from './version.js'

/**
 * 自标识的 user agent。文档要求「用自己的名字」，通用的 `node`（undici 缺省）不算。
 * 形状跟常见客户端一致：`<产品名>/<版本>`（HTTP 头里不能有空格）。
 */
export const APP_USER_AGENT = `pneuma/${DSC_VERSION}`

/** Go 网关的根域；子域也算（`www.opencode.ai` 之类）。 */
const OPENCODE_HOST = 'opencode.ai'
/** Go 入口的 path；只认这一个，普通 Zen 的 `/zen/v1` 不在其列。 */
const OPENCODE_GO_PATH = '/zen/go/v1'
/** 会话归因头的名字。 */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/**
 * 会话 id 能不能直接当头的值：HTTP 头不许出现换行等控制字符（带上会让 fetch
 * 直接抛异常，把整次请求弄坏）。合法值只放行 ASCII 字母数字与 `._:-`，长度封顶 128。
 */
const HEADER_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * 这个 baseUrl 是不是 opencode Go 入口。大小写不敏感、允许尾斜杠；
 * 认不出的 URL（用户填错、空串）一律 false——宁可漏发，不可乱发。
 *
 * @param baseUrl - 端点配置里的 baseUrl（core/config 已剥掉尾部斜杠，这里再兜一次）。
 */
export function isOpenCodeGoBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim()
  if (trimmed === undefined || trimmed === '') return false
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  const path = url.pathname.replace(/\/+$/, '').toLowerCase()
  return (host === OPENCODE_HOST || host.endsWith(`.${OPENCODE_HOST}`)) && path === OPENCODE_GO_PATH
}

/** 会话 id 的线上值；空、超长、带非法字符时返回 undefined（省略这个头，不弄坏请求）。 */
export function sessionIdHeaderValue(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  return HEADER_VALUE_PATTERN.test(trimmed) ? trimmed : undefined
}

/**
 * 按端点补的归因头。不带条件、不命中就返回空表（调用方直接展开进 headers）。
 *
 * 同一个会话的价值就在「稳定」：网关按它做路由与 prompt 缓存，所以值只取会话
 * 自己的 id，不做任何随机化；换会话才换值。
 *
 * @param baseUrl - 这次请求打向的端点。
 * @param sessionId - 这条请求属于的会话（宿主用会话 meta.id）。
 */
export function sessionAttributionHeaders(
  baseUrl: string | undefined,
  sessionId: string | undefined,
): Record<string, string> {
  if (!isOpenCodeGoBaseUrl(baseUrl)) return {}
  const value = sessionIdHeaderValue(sessionId)
  return {
    'user-agent': APP_USER_AGENT,
    // 没有可用的会话 id 就只留自标识：网关照样会报它的 MissingSessionID，
    // 报错原文比一个编出来的 id 好排查。
    ...(value === undefined ? {} : { [OPENCODE_SESSION_HEADER]: value }),
  }
}
