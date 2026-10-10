/**
 * 远程控制 HTTP 层的转发层：函数本体已经上移到 `core/web-http.ts`，
 * 本机界面服务（webserver 插件）与远程控制共用那一份。
 *
 * 为什么留这一层而不是改 remote 里所有 import：远程控制的 routes.ts / remote.ts
 * 里对 `./http.js` 的引用有一串，改它们只是搬字；留一层转发，
 * 「共用一份实现」这件事在 core 里看得见就够了。
 *
 * @module dsc/plugins/remote/http
 */
export {
  MAX_BODY_BYTES,
  bearerToken,
  hostHeaderAllowed,
  isRecord,
  readBody,
  readBodyBytes,
  readCookie,
  readLastSeq,
  sendJson,
  sendText,
} from '../../core/web-http.js'
