/**
 * 远程控制的 HTTP 路由：静态页服务、配对、票据、吊销、上传、Web Push 订阅管理，
 * 以及把它们串起来的分发器（含 Host 校验这道总闸）。
 *
 * 为什么要单独一个模块：createRemoteServer 原本把「帧流 + WS 会话 + 七条路由 +
 * 生命周期」全装在一个 451 行的函数里；路由是其中最独立的一块——只碰 req/res 与
 * deps，不认识 socket 集合与帧流。抽出来之后传输层（remote.ts）只剩握手、帧流、
 * 生命周期，路由的增删改都在这一份里看。
 *
 * @module dsc/plugins/remote/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errText } from '../../core/err-text.js'
import { TICKET_TTL_MS } from '../../core/remote/tickets.js'
import { UPLOAD_MAX_BYTES } from '../../core/remote/uploads.js'
import { isUiBundleRequest, resolveUiResourceRequest } from '../../core/ui-route.js'
import { injectBootScriptTag, UI_CONTENT_SECURITY_POLICY } from '../../core/ui-server.js'
import { readCookie } from '../../core/web-http.js'
import { serveStatic as serveAssets } from '../../core/web-static.js'
import { bearerToken, hostHeaderAllowed, isRecord, readBody, readBodyBytes, sendJson } from './http.js'
import { REMOTE_COOKIE, REMOTE_COOKIE_MAX_AGE_MS, type RemoteServerDeps } from './types.js'

/** 资源目录不存在（界面还没构建）时 `/` 返回的占位页。 */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pneuma 远程控制</title>
  </head>
  <body style="font-family: system-ui, sans-serif; margin: 0; padding: 24px; line-height: 1.7">
    <h1 style="font-size: 20px">远程控制已就绪，但界面资产未构建</h1>
    <p>宿主这一半（HTTP + WebSocket）已经起来了，缺的是手机端的页面文件。</p>
    <p>在仓库的 <code>remote-web/</code> 下执行 <code>pnpm install &amp;&amp; pnpm build</code>，
       产物会落到 <code>lib/remote/assets</code>，刷新本页即可。</p>
    <p style="color: #666">（本机地址 <code id="here"></code>）</p>
    <script>document.getElementById('here').textContent = location.origin</script>
  </body>
</html>
`

function serveStatic(res: ServerResponse, pathname: string, assetsDir: string): void {
  serveAssets(res, pathname, assetsDir, { placeholderHtml: PLACEHOLDER_HTML })
}

/**
 * 壳档的配对页：还没配对的手机只看得到它（外加 /pair.js）。
 *
 * 为什么配对入口在这个页面而不是壳里：壳从启动那一刻就把数据通道当"已认证"用
 * （SSE + POST 靠同源 Cookie），它没有一个"先登录"的状态；配对页是这扇门，
 * 换到 Cookie 后整页跳进壳。样式全 inline（CSP 的 style-src 允许），脚本外链
 * （/pair.js，script-src 'self' 允许）。
 */
const PAIRING_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pneuma 远程配对</title>
    <style>
      :root { color-scheme: dark }
      body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #1c1c1e; color: #f2f2f7 }
      main { width: min(88vw, 360px); padding: 24px }
      h1 { font-size: 20px; margin: 0 0 8px }
      p { color: #a1a1a6; line-height: 1.7; font-size: 14px; margin: 0 0 20px }
      input { width: 100%; box-sizing: border-box; padding: 12px 14px; margin-bottom: 12px; border-radius: 10px; border: 1px solid #3a3a3c; background: #2c2c2e; color: inherit; font-size: 16px }
      button { width: 100%; padding: 12px 14px; border-radius: 10px; border: 0; background: #4c8dff; color: #fff; font-size: 16px }
      button:disabled { opacity: .5 }
      #msg { min-height: 20px; margin: 8px 0 0; font-size: 14px; color: #ff9f0a }
    </style>
  </head>
  <body>
    <main>
      <h1>Pneuma</h1>
      <p>在电脑上打开「设置 → 远程控制」，生成配对码；把它输在下面就能进入界面。</p>
      <input id="code" autocomplete="off" autocapitalize="characters" placeholder="8 位配对码" />
      <input id="name" autocomplete="off" placeholder="这台设备的名字（可留空）" />
      <button id="go">配对</button>
      <p id="msg"></p>
    </main>
    <script src="/pair.js"></script>
  </body>
</html>
`

/** 配对页的脚本（外链；配对成功服务器已经下好 HttpOnly Cookie，整页跳进壳）。 */
const PAIRING_JS = `(() => {
  var code = document.getElementById('code')
  var name = document.getElementById('name')
  var go = document.getElementById('go')
  var msg = document.getElementById('msg')
  go.addEventListener('click', function () {
    if (code.value.trim() === '') { msg.textContent = '先填配对码'; return }
    go.disabled = true
    msg.textContent = '配对中…'
    fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.value.trim(), deviceName: name.value.trim() }),
    })
      .then(function (res) { return res.json() })
      .then(function (doc) {
        if (!doc.ok) { msg.textContent = doc.error || '配对失败'; go.disabled = false; return }
        location.href = '/'
      })
      .catch(function (error) { msg.textContent = '配对失败：' + error; go.disabled = false })
  })
})()
`

/** 造路由处理器要的闭包状态：宿主能力 + 「吊销设备要顺手断连接」的回调。 */
export interface RouteContext {
  deps: RemoteServerDeps
  /** 断开指定设备（或全部）的连接；吊销路由用（连接集合在传输层手里）。 */
  closeDevices(deviceId?: string): number
}

/**
 * 造出 HTTP 请求分发器：所有路由（含静态页面与上传）先过 Host 检查——DNS rebinding
 * 就是从这一条进来的，所以它是总闸不是某条路由自己的事。
 */
export function createRequestHandler(ctx: RouteContext): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { deps } = ctx

  /** 从 Authorization 头或设备 Cookie 认设备；认不出给 null。 */
  const deviceOf = (req: IncomingMessage) => {
    const token = bearerToken(req.headers.authorization) ?? readCookie(req.headers.cookie, REMOTE_COOKIE)
    return token === null ? null : deps.pairing.verifyToken(token)
  }

  /** 请求体读不动（超限 / 连接断了）时的统一回应：让这一条连接用完就关。 */
  const failBody = (res: ServerResponse, status: number, error: unknown): void => {
    res.setHeader('connection', 'close')
    sendJson(res, status, { ok: false, error: errText(error) })
  }

  /** 读一个 JSON 体；不是 JSON 或读不动时自己回话并返回 null（包一层是为了跟「body 就是 null」区分开）。 */
  const readJsonBody = async (req: IncomingMessage, res: ServerResponse): Promise<{ value: unknown } | null> => {
    let body: string
    try {
      body = await readBody(req)
    } catch (error) {
      failBody(res, 413, error)
      return null
    }
    try {
      return { value: JSON.parse(body === '' ? '{}' : body) }
    } catch {
      sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
      return null
    }
  }

  /** 配对：码换设备 token。 */
  const handlePair = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const parsed = await readJsonBody(req, res)
    if (parsed === null) return
    const doc = isRecord(parsed.value) ? parsed.value : {}
    const code = typeof doc['code'] === 'string' ? doc['code'] : ''
    const name =
      typeof doc['deviceName'] === 'string' ? doc['deviceName'] : typeof doc['name'] === 'string' ? doc['name'] : ''
    const outcome = deps.pairing.verifyCode(code, name)
    if (!outcome.ok) {
      deps.notice(`远程配对失败：${outcome.error}`)
      sendJson(res, outcome.status, { ok: false, error: outcome.error })
      return
    }
    deps.notice(`远程设备「${outcome.name}」已配对，可以在设置里吊销`)
    // 顺手把设备 token 包进 HttpOnly Cookie：壳档的 SSE（EventSource 带不了自定义头）
    // 与 POST invoke 靠它认设备；经典档的 Bearer 流程不受影响（token 照旧回给调用方）。
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie':
        `${REMOTE_COOKIE}=${outcome.token}; Max-Age=${String(Math.floor(REMOTE_COOKIE_MAX_AGE_MS / 1000))}; ` +
        'Path=/; HttpOnly; SameSite=Lax',
    })
    res.end(JSON.stringify({ ok: true, token: outcome.token, deviceId: outcome.deviceId, name: outcome.name }))
  }

  /** 取票据：设备 token 换一张 30 秒的一次性 WS 票据。 */
  const handleTicket = (req: IncomingMessage, res: ServerResponse): void => {
    const device = deviceOf(req)
    if (device === null) {
      sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })
      return
    }
    sendJson(res, 200, { ok: true, ticket: deps.tickets.issue(device.deviceId), expiresInMs: TICKET_TTL_MS })
  }

  /** 吊销 token（设备管理就走这一条）。 */
  const handleRevoke = (url: URL, req: IncomingMessage, res: ServerResponse): void => {
    const token = url.searchParams.get('token') ?? bearerToken(req.headers.authorization) ?? ''
    if (token === '') {
      sendJson(res, 400, { ok: false, error: '要吊销哪个 token：把 token 放在查询参数或 Authorization 头里' })
      return
    }
    const revoked = deps.pairing.revoke(token)
    // 吊销不只是「下次连不上」：这台设备已经建好的连接当场断掉。
    if (revoked !== null) ctx.closeDevices(revoked.deviceId)
    deps.notice(revoked !== null ? `远程设备「${revoked.name}」已吊销` : '吊销请求里的 token 不认识（可能已经吊销过了）')
    sendJson(res, 200, { ok: true, revoked: revoked !== null })
  }

  /**
   * 上传：`POST /api/upload?filename=<urlencoded>`，body 是原始字节。
   *
   * 这条路由**不受 64KB 请求体上限约束**（上限由 uploads.ts 的 20MB 说了算），
   * 但要过和其它路由一样的 Host 检查与设备 token 检查。
   */
  const handleUpload = async (url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const device = deviceOf(req)
    if (device === null) {
      sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })
      return
    }
    let data: Buffer
    try {
      data = await readBodyBytes(req, UPLOAD_MAX_BYTES)
    } catch (error) {
      failBody(res, 413, error)
      return
    }
    const filename = url.searchParams.get('filename') ?? ''
    if (filename.trim() === '') {
      sendJson(res, 400, { ok: false, error: '要上传的文件得带上 ?filename=…' })
      return
    }
    let outcome
    try {
      outcome = deps.uploads.save(filename, data)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `写盘失败：${errText(error)}` })
      return
    }
    if (!outcome.ok) {
      sendJson(res, 400, { ok: false, error: outcome.error })
      return
    }
    deps.notice(`远程设备「${device.name}」上传了 ${outcome.name}（${String(outcome.size)} 字节）`)
    sendJson(res, 200, outcome)
  }

  /** VAPID 公钥：只要 Host 检查，不要 token（浏览器订阅前得先拿到它）。 */
  const handlePushKey = (res: ServerResponse): void => {
    if (!deps.pushEnabled()) {
      sendJson(res, 200, { ok: true, publicKey: null })
      return
    }
    sendJson(res, 200, { ok: true, publicKey: deps.pushPublicKey() })
  }

  /** 浏览器订阅入库（按 endpoint 去重）。 */
  const handlePushSubscribe = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!deps.pushEnabled()) {
      sendJson(res, 403, { ok: false, error: '浏览器推送没开：先在电脑上「设置 → 远程控制」里打开' })
      return
    }
    const device = deviceOf(req)
    if (device === null) {
      sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })
      return
    }
    const payload = await readJsonBody(req, res)
    if (payload === null) return
    const outcome = deps.pushSubscribe(payload.value, device.deviceId)
    sendJson(res, outcome.ok ? 200 : 400, outcome)
  }

  /** 退订：body `{endpoint}`。 */
  const handlePushUnsubscribe = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!deps.pushEnabled()) {
      sendJson(res, 403, { ok: false, error: '浏览器推送没开：先在电脑上「设置 → 远程控制」里打开' })
      return
    }
    const device = deviceOf(req)
    if (device === null) {
      sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })
      return
    }
    const payload = await readJsonBody(req, res)
    if (payload === null) return
    const endpoint = isRecord(payload.value) && typeof payload.value['endpoint'] === 'string' ? payload.value['endpoint'] : ''
    if (endpoint.trim() === '') {
      sendJson(res, 400, { ok: false, error: 'body 里要带 {endpoint}' })
      return
    }
    sendJson(res, 200, { ok: true, removed: deps.pushUnsubscribe(endpoint) })
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!hostHeaderAllowed(req.headers.host, deps.port)) {
      sendJson(res, 403, { ok: false, error: 'Host 头不是本机地址，拒绝服务' })
      return
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(deps.port)}`)
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      await handlePair(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/ticket') {
      handleTicket(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/revoke') {
      handleRevoke(url, req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      await handleUpload(url, req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/push-key') {
      handlePushKey(res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/push-subscribe') {
      await handlePushSubscribe(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/push-unsubscribe') {
      await handlePushUnsubscribe(req, res)
      return
    }
    const shell = deps.shellUi
    if (shell !== null) {
      // 配对页的脚本先于凭据闸：还没配对的浏览器只有两样东西拿得到——配对页与它。
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/pair.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : PAIRING_JS)
        return
      }
      if (!shell.authenticated(req)) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': UI_CONTENT_SECURITY_POLICY,
          })
          res.end(req.method === 'HEAD' ? undefined : PAIRING_HTML)
          return
        }
        sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })
        return
      }
      // 数据通道（壳档）：SSE 推帧 + POST 调方法。方法面是远程子集、实参过
      // validateUiArgs（都在 remote.ts 装配时定好，这里只按凭据放行）。
      if (req.method === 'POST' && url.pathname === '/api/invoke') {
        await shell.events.handleInvoke(req, res)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        shell.events.handleEvents(req, res)
        return
      }
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      // 插件 bundle：与本机界面服务同一份解析（C-真 的桌面与远程看同一份界面，
      // 插件 bundle 自然也要能从远程这一侧取到）。combo 批走同一份精确表：
      // 手机壳的启动图也带 batches，批地址必须能从这一侧伺服，否则每次都要回退单资源。
      if (isUiBundleRequest(url.pathname)) {
        const resolved = resolveUiResourceRequest(url.pathname, url.search, undefined, req.method, shell?.combos())
        if (resolved.status !== 200 || resolved.body === undefined) {
          res.writeHead(resolved.status, { 'content-type': 'text/plain; charset=utf-8', ...(resolved.headers ?? {}) })
          res.end(resolved.reason ?? '没有这个插件资源')
          return
        }
        res.writeHead(resolved.status, resolved.headers)
        res.end(resolved.body)
        return
      }
      if (shell !== null) {
        // 启动图：与本地界面服务同一份当前代快照（清单没变就不重算；内容寻址不了，禁缓存）。
        if (url.pathname === '/boot.js') {
          const body = `globalThis.__DSC_BOOT__=${JSON.stringify(shell.boot()).replace(/</g, '\\u003c')}`
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
          })
          res.end(req.method === 'HEAD' ? undefined : body)
          return
        }
        if (url.pathname === '/api/boot') {
          sendJson(res, 200, shell.boot())
          return
        }
        // 壳产物：index.html 补外链启动图标签，同一份 CSP（与本机界面服务同策略）。
        serveAssets(res, url.pathname, shell.assetsDir, {
          transformHtml: injectBootScriptTag,
          contentSecurityPolicy: UI_CONTENT_SECURITY_POLICY,
        })
        return
      }
      serveStatic(res, url.pathname, deps.assetsDir)
      return
    }
    sendJson(res, 404, { ok: false, error: '没有这条路由' })
  }
}
