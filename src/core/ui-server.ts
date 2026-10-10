/**
 * 本机界面服务：把插件版界面伺服给浏览器（桌面窗口与远程设备看的是同一份）。
 *
 * 这是 C-真 路线里"宿主常驻的那半个 web 服务"。它比远程控制那套简单得多，因为它只服务
 * **本机回环**：没有配对码、没有设备令牌、没有推送，只有一道一次性令牌换 Cookie 的门。
 * 带得走的东西（Host 头防护、静态伺服、内容寻址的 bundle 地址）都从 core 共用。
 *
 * 四件事：
 *
 * 1. **进来要先换票**：宿主启动时生成一枚一次性令牌，打印成
 *    `http://127.0.0.1:<port>/?token=xxx`。浏览器带着它访问 `/`，服务下一条 HttpOnly
 *    Cookie 并 302 到 `/`——令牌就此作废（用一次），之后的 `/api/*` 与 `/plugins/*`
 *    都靠这条 Cookie。为什么不用 URL 里的令牌直接当凭据：它会被写进历史记录、
 *    被 Referer 带出去、被日志记下来；换 Cookie 只用一次，暴露面小一圈。
 *
 * 2. **Host 头必须对得上**（`core/web-http.ts` 的 hostHeaderAllowed）：DNS rebinding
 *    能让恶意网页照自己的域名打本机端口，这道闸拦的就是它，而且是**所有路由的总闸**。
 *
 * 3. **插件 bundle 走内容寻址**：地址里带 `?rev=<文件指纹>`；rev 与服务端当前算出来的
 *    不一致就 404（旧地址不该拿到新代码，新地址也不该拿到旧代码），一致则给一年不可变缓存。
 *
 * 4. **启动清单注进页面**：送 index.html 之前把启动图塞进 `window.__DSC_BOOT__`
 *    （与 dsh 同一个位置、同一个名字），界面壳一进来就有，不必再发一次请求。
 *
 * @module dsc/core/ui-server
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { composeUiBootGraph, type UiBootGraph, type UiPluginRow } from '../ui/manifest.js'
import type { UiEventsHandle } from './ui-events.js'
import { collectUiPluginArtifacts, uiAssetsDir, uiPluginsDir } from './ui-bundles.js'
import { isUiBundleRequest, resolveUiBundleRequest } from './ui-route.js'
import { hostHeaderAllowed, readCookie, sendJson, sendText } from './web-http.js'
import { serveStatic } from './web-static.js'

/** 会话 Cookie 名。 */
export const UI_COOKIE = 'dsc_ui'

/** 一进来给的那条 `/?token=` 的有效期（毫秒）：够用户从终端复制到浏览器。 */
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000

/** 启动图注入页面时用的全局名（与 dsh 的 `window.__DSH_BOOT__` 对应）。 */
export const BOOT_GLOBAL = '__DSC_BOOT__'

/** 产物目录不存在时的占位页。 */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>Muse Code 界面</title></head>
  <body style="font-family: system-ui, sans-serif; margin: 0; padding: 24px; line-height: 1.7">
    <h1 style="font-size: 20px">界面服务已就绪，但界面资产未构建</h1>
    <p>宿主这一半（HTTP + 插件下发）已经起来了，缺的是界面壳的页面文件。</p>
    <p>在仓库的 <code>ui-shell/</code> 下执行 <code>pnpm install &amp;&amp; pnpm build</code>，
       产物会落到 <code>lib/ui/assets</code> 与 <code>lib/ui/plugins/</code>，刷新本页即可。</p>
  </body>
</html>
`

/** 没带（或带错）凭据时的回话。刻意不回令牌信息，只说去哪拿。 */
const UNAUTHORIZED_HTML = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>需要凭据</title></head>
  <body style="font-family: system-ui, sans-serif; margin: 0; padding: 24px; line-height: 1.7">
    <h1 style="font-size: 20px">这个地址需要一次性令牌</h1>
    <p>请用宿主启动时打印的那条带 <code>?token=</code> 的地址访问（令牌用一次就作废）。</p>
  </body>
</html>
`

/** 造服务时要给的参数。 */
export interface UiServerOptions {
  /** 宿主身份（页面上要显示产品名与版本）。 */
  host: { name: string; version: string }
  /** 界面产物目录，缺省 `lib/ui/assets`。 */
  assetsDir?: string
  /** 插件目录，缺省 `lib/ui/plugins`。 */
  pluginsDir?: string
  /**
   * 数据通道（`/api/events` 与 `/api/invoke`）。不给就是纯静态界面服务——
   * 单元测试与「只发页面不带数据」的场景都用得着。
   */
  events?: UiEventsHandle
  /** 监听端口，0 = 让系统分配（缺省 0）。 */
  port?: number
  /** 一次性令牌有效期，缺省 10 分钟。 */
  tokenTtlMs?: number
  /** 日志（缺省写 stderr）。 */
  log?(line: string): void
}

/** 拿到的服务句柄。 */
export interface UiServerHandle {
  readonly port: number
  /** 本机根地址（不带令牌）。 */
  readonly origin: string
  /** 入口地址：带一次性令牌，给用户或桌面窗口用一次。 */
  readonly url: string
  /** 当前启动图。 */
  boot(): UiBootGraph
  /** 重新扫插件目录（界面壳重新构建后不必重启宿主）。 */
  refresh(): { entries: number; problems: string[] }
  /** 关服务（幂等）。 */
  close(): Promise<void>
}

/** 启动服务并把入口地址算出来。 */
export async function createUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const assetsDir = options.assetsDir ?? uiAssetsDir()
  const pluginsDir = options.pluginsDir ?? uiPluginsDir()
  const events = options.events ?? null
  const log = options.log ?? ((line: string): void => { process.stderr.write(`${line}\n`) })
  const ttl = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS

  // 一次性令牌：换到 Cookie 就作废；过期也作废。
  const token = randomBytes(24).toString('base64url')
  const tokenExpiresAt = Date.now() + ttl
  let tokenUsed = false
  const session = randomBytes(24).toString('base64url')

  // 插件清单：启动时收一次，构建完界面壳可以 refresh 重收。
  let artifacts = collectUiPluginArtifacts(pluginsDir, 'web')
  const manifest = artifacts.entries

  /**
   * 监听端口：listen 之后才知道（port=0 时由系统分配）。
   * 必须在造请求处理器之前声明——处理器闭包要用它做 Host 头校验，
   * 而这个绑定是在 await 之后才赋值的，声明放到 await 后面会掉进暂时性死区。
   */
  let currentPort = 0

  /** 现在这一刻的启动图（每次调用重算 rev，文件被换掉立刻反映出来）。 */
  const buildBoot = (): UiBootGraph => {
    const fresh = collectUiPluginArtifacts(pluginsDir, 'web')
    artifacts = fresh
    const rows: (UiPluginRow & { rev: string })[] = fresh.entries.map((entry) => ({
      id: entry.id,
      rev: entry.rev,
      ...(entry.inject === undefined ? {} : { inject: entry.inject }),
      ...(entry.external === undefined ? {} : { external: entry.external }),
      ...(entry.immediately === true ? { immediately: true } : {}),
    }))
    return composeUiBootGraph(options.host, rows)
  }

  /** 启动图求值一次给注入用（页面每次请求都注入当下的那一份）。 */
  const bootJson = (graph: UiBootGraph): string =>
    JSON.stringify(graph).replace(/</g, '\\u003c')

  const transformIndex = (html: string, pathname: string): string => {
    void pathname
    const tag = `<script>globalThis.${BOOT_GLOBAL}=${bootJson(buildBoot())}</script>`
    const head = html.indexOf('</head>')
    return head < 0 ? `${tag}${html}` : `${html.slice(0, head)}${tag}${html.slice(head)}`
  }

  const server: Server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      log(`[ui-server] 请求处理失败：${reason}`)
      if (!res.headersSent) sendText(res, 500, '内部错误')
      else res.end()
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = currentPort
    // 总闸一：Host 头必须是本机的 IP 字面量或 localhost，且端口对得上。
    if (!hostHeaderAllowed(req.headers.host, port)) {
      sendText(res, 403, 'Host 头不被接受')
      return
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`)
    const queryToken = url.searchParams.get('token')
    const cookie = readCookie(req.headers.cookie, UI_COOKIE)

    // 总闸二：凭据。带一次性令牌访问根路径 = 换 Cookie 并跳转（令牌就此作废）。
    if (url.pathname === '/' && queryToken !== null) {
      if (tokenUsed || Date.now() > tokenExpiresAt || queryToken !== token) {
        sendText(res, 403, '令牌无效或已用过，请用宿主最新打印的地址')
        return
      }
      tokenUsed = true
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${UI_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
      })
      res.end()
      return
    }
    if (cookie !== session) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
      res.end(UNAUTHORIZED_HTML)
      return
    }

    // 插件 bundle：内容寻址，rev 对不上就 404（旧地址不拿新代码）。
    // 解析口径与远程控制共用 core/ui-route.ts 那一份。
    if (req.method === 'GET' && isUiBundleRequest(url.pathname)) {
      const resolved = resolveUiBundleRequest(url.pathname, url.searchParams.get('rev'), pluginsDir)
      if (resolved.status !== 200 || resolved.body === undefined) {
        sendText(res, resolved.status, resolved.reason ?? '没有这个插件资源')
        return
      }
      res.writeHead(resolved.status, resolved.headers)
      res.end(resolved.body)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/boot') {
      sendJson(res, 200, buildBoot())
      return
    }
    // 数据通道：SSE 推帧 + POST 调方法（通道本体在 core/ui-events.ts，鉴权在这一层）。
    if (events !== null && req.method === 'GET' && url.pathname === '/api/events') {
      events.handleEvents(req, res)
      return
    }
    if (events !== null && req.method === 'POST' && url.pathname === '/api/invoke') {
      await events.handleInvoke(req, res)
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = serveStatic(res, url.pathname, assetsDir, {
        placeholderHtml: PLACEHOLDER_HTML,
        transformHtml: transformIndex,
      })
      if (!served) log(`[ui-server] 未命中静态文件：${url.pathname}`)
      return
    }
    sendText(res, 405, '不支持这个请求方法')
  }

  /** 监听：port=0 时由系统分配，绑完才知道端口。 */
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectListen(new Error('界面服务监听失败：拿不到端口'))
        return
      }
      currentPort = address.port
      resolveListen()
    })
  })

  const handle: UiServerHandle = {
    get port() {
      return currentPort
    },
    get origin() {
      return `http://127.0.0.1:${String(currentPort)}`
    },
    get url() {
      return `http://127.0.0.1:${String(currentPort)}/?token=${token}`
    },
    boot: () => buildBoot(),
    refresh: () => {
      const fresh = collectUiPluginArtifacts(pluginsDir, 'web')
      artifacts = fresh
      return { entries: fresh.entries.length, problems: fresh.problems }
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
        server.closeAllConnections()
      }),
  }

  // 清单为空也要说清楚：多半是界面壳还没构建，不是插件写错了。
  if (manifest.length === 0) {
    log(`[ui-server] 插件目录里没有可下发的界面插件（${pluginsDir}）；界面壳构建过了吗`)
  } else {
    log(`[ui-server] 已登记 ${String(manifest.length)} 个界面插件`)
  }
  for (const problem of artifacts.problems) log(`[ui-server] ${problem}`)

  return handle
}
