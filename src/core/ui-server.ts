/**
 * 本机界面服务：把插件版界面伺服给浏览器（桌面窗口与远程设备看的是同一份）。
 *
 * 这是 C-真 路线里"宿主常驻的那半个 web 服务"。它比远程控制那套简单得多，因为它只服务
 * **本机回环**：没有配对码、没有设备令牌、没有推送，只有一道一次性令牌换 Cookie 的门。
 * 带得走的东西（信任闸、静态伺服、内容寻址的 bundle 地址）都从 core 共用。
 *
 * 五件事：
 *
 * 1. **进来要先换票**：宿主启动时生成一枚一次性令牌，打印成
 *    `http://127.0.0.1:<port>/?token=xxx`。浏览器带着它访问 `/`，服务下一条 HttpOnly
 *    Cookie 并 303 到 `/`——令牌就此作废（用一次），之后的 `/api/*` 与 `/plugins/*`
 *    都靠这条 Cookie。为什么不用 URL 里的令牌直接当凭据：它会被写进历史记录、
 *    被 Referer 带出去、被日志记下来；换 Cookie 只用一次，暴露面小一圈。
 *    换票响应带 `cache-control: no-store` 与 `referrer-policy: no-referrer`：这条带令牌的
 *    响应不该进任何缓存，跳转后的地址也不该把令牌漏给下一页。用 303 而不是 302：
 *    303 明确要求后续请求改用 GET，语义上不会让带体的请求被"重放"。
 *
 * 2. **三道闸收在 `core/ui-trust.ts`**：Host（防 DNS rebinding，所有路由的总闸）、
 *    `sec-fetch-site: cross-site`、以及"带了 Origin 就必须等于本服务 authority"。
 *    后两道是补充，理由与边界都写在那份文件的头注释里。
 *
 * 3. **会话 Cookie 是签名过的**：值是 `authority + 过期时间` 的 HMAC-SHA256，密钥落盘在
 *    `<DSC_HOME>/ui-secret`（0600）。为什么要落盘：原来 Cookie 值每次进程启动重新随机，
 *    宿主一重启页面就 401；密钥落盘后，同 authority（同端口）下的旧页面重启后仍然有效。
 *    为什么要签 authority：Cookie 的作用域不含端口，签上 authority 之后，"另一个回环端口
 *    反射回来的 Cookie"送到本服务也不成立。密钥本身绝不进日志。
 *
 * 4. **插件 bundle 走内容寻址**：地址里带 `?rev=<文件指纹>`；命中当下这一代或上一代才 200，
 *    其余 404（旧地址不该拿到新代码，新地址也不该拿到旧代码），命中给一年不可变缓存。
 *    HEAD 复用 GET 的头但不给体；非 GET / HEAD 回 405。解析口径在 `core/ui-route.ts`。
 *
 * 5. **启动清单注进页面**：送 index.html 之前把启动图塞进 `window.__DSC_BOOT__`
 *    （与 dsh 同一个位置、同一个名字），界面壳一进来就有，不必再发一次请求。
 *
 * @module dsc/core/ui-server
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { composeUiBootGraph, type UiBootGraph, type UiPluginRow } from '../ui/manifest.js'
import { dscPath } from './path-policy.js'
import type { UiEventsHandle } from './ui-events.js'
import { collectUiArtifactsForPlatform, uiAssetsDir, uiPluginsDir } from './ui-bundles.js'
import { isUiBundleRequest, resolveUiBundleRequest, type UiBundleResponse } from './ui-route.js'
import { checkUiRequestTrust, issueUiCookie, requestAuthority, timingSafeEqualText, verifyUiCookie } from './ui-trust.js'
import { readCookie, sendJson, sendText } from './web-http.js'
import { serveStatic } from './web-static.js'

/** 会话 Cookie 名。 */
export const UI_COOKIE = 'dsc_ui'

/** 一进来给的那条 `/?token=` 的有效期（毫秒）：够用户从终端复制到浏览器。 */
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000

/** 会话 Cookie 的有效期：30 天（与参考实现同口径）。 */
export const UI_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** 签名密钥文件（`<DSC_HOME>/ui-secret`），只放本机、权限 0600，绝不进日志。 */
export const UI_SECRET_FILE = 'ui-secret'

/** 签名密钥长度（字节）。 */
const SECRET_BYTES = 32

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
  /** 当前积累的装载问题（第三方没信任、api 不匹配、bundle 缺失…），给调用方转成会话流。 */
  problems(): string[]
  /** 关服务（幂等）。 */
  close(): Promise<void>
}

/**
 * 取（或首次生成）界面会话的签名密钥。
 *
 * 读取时先按形状校验：文件在但内容不成形（被截断、被改坏）就重新生成一份覆盖它——
 * 那会让已下发的 Cookie 全部失效（用户重新换一次票），但比拿一段坏密钥签名安全得多。
 *
 * 落盘失败（只读盘、权限不足）不致命：退回进程内随机密钥，只是宿主重启后旧页面要重新
 * 换票。这种情况会写一行日志（**只说事、不打印密钥**）。
 */
function loadUiSigningKey(log: (line: string) => void): Buffer {
  const file = dscPath(UI_SECRET_FILE)
  let corrupt = false
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9_-]{43}$/.test(text)) {
      const key = Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
      if (key.byteLength === SECRET_BYTES) return key
    }
    corrupt = true
  } catch {
    // 首次运行：文件还没有。不算异常。
  }
  const key = randomBytes(SECRET_BYTES)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${key.toString('base64url')}\n`, { mode: 0o600 })
    if (corrupt) log(`[ui-server] 签名密钥文件形状不对，已重新生成（${file}）`)
    return key
  } catch (error) {
    log(
      `[ui-server] 签名密钥没法落盘（${error instanceof Error ? error.message : String(error)}）：`
      + '本次会话的 Cookie 只在内存里有效，宿主重启后页面要重新换票',
    )
    return key
  }
}

/** 把 bundle 解析结果写出去：200 给头（与体），其余给状态码 + 理由 + Allow 之类的头。 */
function sendBundleResponse(res: ServerResponse, resolved: UiBundleResponse): void {
  if (resolved.status === 200) {
    res.writeHead(200, resolved.headers ?? {})
    res.end(resolved.body)
    return
  }
  res.writeHead(resolved.status, { 'content-type': 'text/plain; charset=utf-8', ...(resolved.headers ?? {}) })
  res.end(resolved.reason ?? '没有这个插件资源')
}

/** 启动服务并把入口地址算出来。 */
export async function createUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const assetsDir = options.assetsDir ?? uiAssetsDir()
  const pluginsDir = options.pluginsDir ?? uiPluginsDir()
  const events = options.events ?? null
  const log = options.log ?? ((line: string): void => { process.stderr.write(`${line}\n`) })
  const ttl = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS

  // 一次性令牌：换到 Cookie 就作废；过期也作废。比对用定长时间（时序侧信道）。
  const token = randomBytes(24).toString('base64url')
  const tokenExpiresAt = Date.now() + ttl
  let tokenUsed = false
  // 会话 Cookie 的签名密钥：落盘复用，于是同 authority 下宿主重启后旧页面仍然有效。
  const signingKey = loadUiSigningKey(log)

  // 插件清单：启动时收一次，构建完界面壳可以 refresh 重收。
  let artifacts = collectUiArtifactsForPlatform('web', { builtinDir: pluginsDir })
  const manifest = artifacts.entries

  /**
   * 监听端口：listen 之后才知道（port=0 时由系统分配）。
   * 必须在造请求处理器之前声明——处理器闭包要用它做 Host 头校验，
   * 而这个绑定是在 await 之后才赋值的，声明放到 await 后面会掉进暂时性死区。
   */
  let currentPort = 0

  /** 现在这一刻的启动图（强制重算产物表：文件被换掉立刻反映出来）。 */
  const buildBoot = (): UiBootGraph => {
    // 内置 + 第三方合成（~/.dsc/plugins/ 的界面半边）；门禁与信任都在 collect 层做过。
    const fresh = collectUiArtifactsForPlatform('web', { force: true, builtinDir: pluginsDir })
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

  /**
   * 壳文档的内容安全策略。启动图走同源外链 `/boot.js`（见 transformIndex），
   * 脚本面才能收成 `'self'`——内联注入就得配 nonce，多一套机制不值得。
   * `'unsafe-inline'` 只留给 style：React 的行内样式与 xterm 的运行期样式都是
   * style 属性，收掉会全线破相；`img-src` 放开 `data:` 是预览插件的 base64 图片。
   */
  const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ')

  const transformIndex = (html: string, pathname: string): string => {
    void pathname
    const tag = `<script src="/boot.js"></script>`
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
    // 总闸：Host / Sec-Fetch-Site / Origin 三道，**所有**路由（含换票、静态、/api/*）都从这里进。
    const denial = checkUiRequestTrust(req.headers, port)
    if (denial !== null) {
      sendText(res, denial.status, denial.reason)
      return
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`)
    const method = req.method ?? 'GET'
    // Host 已经过闸，这里的 authority 一定成形；Cookie 的签名与校验都绑在它上面。
    const authority = requestAuthority(req.headers.host)
    const tokens = url.searchParams.getAll('token')

    // 凭据闸：带一次性令牌访问根路径 = 换 Cookie 并跳转（令牌就此作废）。
    if (url.pathname === '/' && tokens.length > 0) {
      if (method !== 'GET') {
        sendText(res, 405, '换票只认 GET')
        return
      }
      const valid = tokens.length === 1
        && !tokenUsed
        && Date.now() <= tokenExpiresAt
        && timingSafeEqualText(tokens[0], token)
      if (!valid) {
        sendText(res, 403, '令牌无效或已用过，请用宿主最新打印的地址')
        return
      }
      tokenUsed = true
      const expiresAt = Date.now() + UI_COOKIE_MAX_AGE_MS
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: '/',
        'referrer-policy': 'no-referrer',
        'set-cookie': [
          `${UI_COOKIE}=${issueUiCookie(signingKey, authority, expiresAt)}`,
          `Max-Age=${String(Math.floor(UI_COOKIE_MAX_AGE_MS / 1000))}`,
          `Expires=${new Date(expiresAt).toUTCString()}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Strict',
        ].join('; '),
      })
      res.end()
      return
    }
    if (!verifyUiCookie(signingKey, authority, readCookie(req.headers.cookie, UI_COOKIE), Date.now())) {
      res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
      res.end(UNAUTHORIZED_HTML)
      return
    }

    // 插件 bundle：内容寻址；HEAD 复用 GET 的头，非 GET/HEAD 405。
    // 解析口径与远程控制共用 core/ui-route.ts 那一份。
    if (isUiBundleRequest(url.pathname)) {
      sendBundleResponse(res, resolveUiBundleRequest(url.pathname, url.searchParams.get('rev'), pluginsDir, method))
      return
    }
    if (url.pathname === '/api/boot') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, '启动图只认 GET 与 HEAD')
        return
      }
      // HEAD 不用特殊处理：node 对 HEAD 只发头、不发体（content-length 照给）。
      sendJson(res, 200, buildBoot())
      return
    }
    // 启动图的外链脚本：与昔日内联注入等价（</head> 前同步执行完，页面脚本跑起来时
    // 全局已就位），但 CSP 的 script-src 才能收成 'self'。同样在 Cookie 闸之后。
    if (url.pathname === '/boot.js') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, '启动图脚本只认 GET 与 HEAD')
        return
      }
      const body = `globalThis.${BOOT_GLOBAL}=${bootJson(buildBoot())}`
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-cache',
      })
      res.end(method === 'HEAD' ? undefined : body)
      return
    }
    // 数据通道：SSE 推帧 + POST 调方法（通道本体在 core/ui-events.ts，鉴权在这一层）。
    if (events !== null && url.pathname === '/api/events') {
      if (method !== 'GET') {
        // SSE 是一条长连接，HEAD 没有意义，因此这里连 HEAD 也拒（只认 GET）。
        sendText(res, 405, '事件流只认 GET')
        return
      }
      events.handleEvents(req, res)
      return
    }
    if (events !== null && url.pathname === '/api/invoke') {
      if (method !== 'POST') {
        sendText(res, 405, '调用只认 POST')
        return
      }
      await events.handleInvoke(req, res)
      return
    }
    if (method === 'GET' || method === 'HEAD') {
      const served = serveStatic(res, url.pathname, assetsDir, {
        placeholderHtml: PLACEHOLDER_HTML,
        transformHtml: transformIndex,
        contentSecurityPolicy: CONTENT_SECURITY_POLICY,
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
    problems: () => [...artifacts.problems],
    refresh: () => {
      const fresh = collectUiArtifactsForPlatform('web', { force: true, builtinDir: pluginsDir })
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
