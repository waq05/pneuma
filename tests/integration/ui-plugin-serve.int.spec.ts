/**
 * 界面服务（宿主半边）的装配行为：信任闸与换票、启动图、bundle 伺服、数据通道
 * （SSE + POST invoke）与帧往返（迁自 `scripts/ui-plugin-test.mjs` 的 [4][4b][4c][4d] 四段）。
 *
 * ## 被测的是什么
 *
 * - `createUiServer` 真起一个服务：没凭据 401 → 带令牌换 Cookie 303 → 取启动图 →
 *   取 bundle（rev 对得上 / 对不上）→ Host 头不对 403 → 令牌不能二次使用 → close 后拒连。
 * - `readUiServerConfig`（webserver 插件）：环境变量、`~/.dsc/plugins.json` 条目树、
 *   环境变量盖条目树；自定义产物目录也照它伺服。
 * - `createUiEvents` 数据通道：SSE 首帧全量、增量广播、`last-event-id` 补帧、
 *   `/api/invoke` 的白名单与实参透传、方法抛错回 `ok:false`。
 * - 帧往返：`RemoteFrameHub` 产帧 → `applyHostFrame` 并帧，全量 / 增量 / 删除 / 严格报错。
 *
 * ## 落位与隔离
 *
 * 临时 HOME 由 `tests/setup/temp-home.ts` 给（签名密钥落在 `DSC_HOME` 下、条目树写在
 * 临时目录里）；服务配置段要写 `~/.dsc/plugins.json`，同样落在临时 HOME。服务端口用 0
 * （系统分配），夹具目录用 `mkdtempSync`，真实 `~/.dsc` 一个字节都不写。
 *
 * ## 与探针的对应
 *
 * 探针的 `check()` 一条对应一个 `test`；时序敏感的段落（换票 → 断言 → 二次使用 →
 * SSE 重连补帧）在 `beforeAll` 里按原次序跑完、把读数记进局部对象，用例只读记录。
 *
 * @module dsc/tests/integration/ui-plugin-serve
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createUiServer, type UiServerHandle } from '@pneuma/runtime/core/ui-server.js'
import { createUiEvents, type UiEventsHandle } from '@pneuma/runtime/core/ui-events.js'
import { RemoteFrameHub } from '@pneuma/runtime/core/remote/frames.js'
import { applyHostFrame } from '@pneuma/ui-core/frames.js'
import { readUiServerConfig } from '@pneuma/webserver/index.js'

/** 夹具总目录；失败现场留着翻，成功时 afterAll 删。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-serve-'))

// 探针同款：环境里带了这几个变量会把「默认不起服务」的基线改掉。
delete process.env.DSC_UI_SERVER
delete process.env.DSC_UI_ASSETS
delete process.env.DSC_UI_PORT

/** 一条 HTTP 响应的读数。 */
interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** 造一个临时目录树；`files` 是相对路径 → 内容。 */
function makeTree(name: string, files: Record<string, string>): string {
  const dir = join(WORK, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }
  return dir
}

/** 发一个 HTTP 请求（用 node:http，好自定义 Host 头、Cookie 与请求体）。 */
function http(method: string, port: number, path: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    // agent: false = 每个请求自己一条连接，不给全局连接池留 keep-alive 套接字。
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : Buffer.from(body, 'utf8'))
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

/** 快照的最小形状（探针里是 JS 直写，这里收窄成 `createUiEvents` 认的那份）。 */
interface FrameLike {
  sessionId: string
  entries: ReadonlyArray<{ id: number; kind?: string; text?: string }>
  liveEntries: ReadonlyArray<unknown>
}

// ── [4] 界面服务（真起一个） ────────────────────────────────────────────────────
describe('界面服务（真起一个）', () => {
  /** beforeAll 按探针次序跑完后的读数（键语义见各 test）。 */
  const facts: Record<string, unknown> = {}
  let server: UiServerHandle

  beforeAll(async () => {
    const assetsDir = makeTree('assets', {
      'index.html': '<!doctype html><html><head><title>壳</title></head><body><div id="root"></div></body></html>',
      'app-x.js': 'console.log("shell")',
    })
    const pluginsDir = makeTree('serve-plugins', {
      'manifest.json': JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: [{ id: 'demo', file: 'client.js', platform: 'web' }],
      }),
      'demo/client.js': 'module.exports={apply(){}}',
    })
    server = await createUiServer({
      host: { name: 'Pneuma', version: 'test-1.2.3' },
      assetsDir,
      pluginsDir,
      log: () => {},
    })
    const token = new URL(server.url).searchParams.get('token') ?? ''

    const anonymous = await http('GET', server.port, '/')
    const anonymousBoot = await http('GET', server.port, '/api/boot')
    const wrongToken = await http('GET', server.port, '/?token=nope')
    const handshake = await http('GET', server.port, `/?token=${token}`)
    const setCookie = String(handshake.headers['set-cookie']?.[0] ?? '')
    const cookie = setCookie.split(';')[0]
    const reuse = await http('GET', server.port, `/?token=${token}`)
    const badHost = await http('GET', server.port, '/', { cookie, host: `evil.example:${String(server.port)}` })
    const badPort = await http('GET', server.port, '/', { cookie, host: '127.0.0.1:1' })
    const page = await http('GET', server.port, '/', { cookie })
    const bootScript = await http('GET', server.port, '/boot.js', { cookie })
    const anonymousBootScript = await http('GET', server.port, '/boot.js')
    const boot = await http('GET', server.port, '/api/boot', { cookie })
    let graph: { entries: Array<{ id: string; url: string }> } | null = null
    try {
      graph = JSON.parse(boot.body) as { entries: Array<{ id: string; url: string }> }
    } catch {
      graph = null
    }
    const bundleUrl = graph?.entries[0]?.url ?? ''
    const bundle = await http('GET', server.port, `/${bundleUrl}`, { cookie })
    const staleRev = await http('GET', server.port, `/plugins/demo/client.js?rev=${'0'.repeat(12)}`, { cookie })
    const unknownPlugin = await http('GET', server.port, '/plugins/nope/client.js', { cookie })
    const traversal = await http('GET', server.port, '/plugins/demo/..%2F..%2Fmanifest.json', { cookie })
    const staticFile = await http('GET', server.port, '/app-x.js', { cookie })
    const missing = await http('GET', server.port, '/nope.js', { cookie })
    await server.close()
    let refused = false
    try {
      await http('GET', server.port, '/')
    } catch {
      refused = true
    }

    Object.assign(facts, {
      anonymous: anonymous.status,
      anonymousBoot: anonymousBoot.status,
      wrongToken: wrongToken.status,
      handshake: handshake.status,
      cacheControl: String(handshake.headers['cache-control'] ?? ''),
      referrerPolicy: String(handshake.headers['referrer-policy'] ?? ''),
      setCookie,
      reuse: reuse.status,
      badHost: badHost.status,
      badPort: badPort.status,
      page: page.status,
      pageBodyHasBootScript: page.body.includes('<script src="/boot.js">'),
      csp: String(page.headers['content-security-policy'] ?? ''),
      bootScriptStatus: bootScript.status,
      bootScriptBody: bootScript.body,
      anonymousBootScript: anonymousBootScript.status,
      bootStatus: boot.status,
      graphOk: graph !== null,
      graphHasDemo: graph?.entries.some((entry) => entry.id === 'demo') === true,
      graphUrlOk: graph !== null && /^plugins\/demo\/client\.js\?rev=[0-9a-f]{12}$/.test(graph.entries[0]?.url ?? ''),
      bundleStatus: bundle.status,
      bundleBodyHasApply: bundle.body.includes('apply'),
      bundleCache: String(bundle.headers['cache-control'] ?? ''),
      staleRev: staleRev.status,
      unknownPlugin: unknownPlugin.status,
      traversal: traversal.status,
      staticFile: staticFile.status,
      missing: missing.status,
      refused,
    })
  })

  test('没凭据访问根路径 401', () => {
    expect(facts['anonymous']).toBe(401)
  })
  test('没凭据取启动图 401', () => {
    expect(facts['anonymousBoot']).toBe(401)
  })
  test('错令牌 403', () => {
    expect(facts['wrongToken']).toBe(403)
  })
  test('带令牌换 Cookie 是 303（换票后一律 GET）', () => {
    expect(facts['handshake']).toBe(303)
  })
  test('换票响应不许被缓存、不带 Referer', () => {
    expect(String(facts['cacheControl'])).toContain('no-store')
    expect(String(facts['referrerPolicy'])).toContain('no-referrer')
  })
  test('下发 HttpOnly 会话 Cookie', () => {
    expect(String(facts['setCookie']).startsWith('dsc_ui=')).toBe(true)
    expect(String(facts['setCookie'])).toContain('HttpOnly')
  })
  test('令牌不能二次使用', () => {
    expect(facts['reuse']).toBe(403)
  })
  test('Host 头不是本机地址 403', () => {
    expect(facts['badHost']).toBe(403)
  })
  test('Host 头端口对不上 403', () => {
    expect(facts['badPort']).toBe(403)
  })
  test('带 Cookie 拿到页面 200', () => {
    expect(facts['page']).toBe(200)
  })
  test('页面挂了启动清单外链脚本', () => {
    expect(facts['pageBodyHasBootScript']).toBe(true)
  })
  test('页面带内容安全策略且脚本面收成 self', () => {
    expect(String(facts['csp'])).toContain("script-src 'self'")
  })
  test('/boot.js 注入启动清单全局名与宿主身份', () => {
    expect(facts['bootScriptStatus']).toBe(200)
    expect(String(facts['bootScriptBody'])).toContain('__DSC_BOOT__')
    expect(String(facts['bootScriptBody'])).toContain('Pneuma')
    expect(String(facts['bootScriptBody'])).toContain('test-1.2.3')
  })
  test('没凭据取 /boot.js 401', () => {
    expect(facts['anonymousBootScript']).toBe(401)
  })
  test('取启动图 200 且是合法 JSON', () => {
    expect(facts['bootStatus']).toBe(200)
    expect(facts['graphOk']).toBe(true)
  })
  test('启动图里有那个插件', () => {
    expect(facts['graphHasDemo']).toBe(true)
  })
  test('启动图条目带内容寻址地址', () => {
    expect(facts['graphUrlOk']).toBe(true)
  })
  test('取 bundle 200、是 JS 内容、走一年不可变缓存', () => {
    expect(facts['bundleStatus']).toBe(200)
    expect(facts['bundleBodyHasApply']).toBe(true)
    expect(String(facts['bundleCache'])).toContain('immutable')
  })
  test('版本对不上 404', () => {
    expect(facts['staleRev']).toBe(404)
  })
  test('不存在的插件 404', () => {
    expect(facts['unknownPlugin']).toBe(404)
  })
  test('插件路径逃逸拿不到东西', () => {
    expect(facts['traversal']).toBe(404)
  })
  test('静态资源 200、没有的文件 404', () => {
    expect(facts['staticFile']).toBe(200)
    expect(facts['missing']).toBe(404)
  })
  test('close 之后连不上', () => {
    expect(facts['refused']).toBe(true)
  })
})

// ── [4b] 服务配置（环境变量与插件条目树） ──────────────────────────────────────
describe('服务配置（readUiServerConfig）', () => {
  const HOME = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const DSC_HOME = join(HOME, '.dsc')

  afterAll(() => {
    delete process.env.DSC_UI_SERVER
    delete process.env.DSC_UI_PORT
    delete process.env.DSC_UI_ASSETS
  })

  test('默认不起服务、端口交给系统分配、不指定产物目录', () => {
    const defaults = readUiServerConfig(undefined)
    expect(defaults.enabled).toBe(false)
    expect(defaults.port).toBe(0)
    expect(defaults.assetsDir).toBeUndefined()
  })

  test('DSC_UI_SERVER=1 就起来', () => {
    process.env.DSC_UI_SERVER = '1'
    expect(readUiServerConfig(undefined).enabled).toBe(true)
  })

  test('DSC_UI_PORT 生效；写坏了回落到系统分配', () => {
    process.env.DSC_UI_PORT = '17399'
    expect(readUiServerConfig(undefined).port).toBe(17399)
    process.env.DSC_UI_PORT = 'abc'
    expect(readUiServerConfig(undefined).port).toBe(0)
  })

  test('DSC_UI_ASSETS 生效', () => {
    process.env.DSC_UI_ASSETS = join(WORK, 'somewhere')
    expect(readUiServerConfig(undefined).assetsDir).toBe(join(WORK, 'somewhere'))
  })

  test('条目树里 enabled / port / assetsDir 生效', () => {
    // 探针同款：先清掉前几条用例留下的环境变量——环境变量盖条目树，不清就验不到条目树。
    delete process.env.DSC_UI_SERVER
    delete process.env.DSC_UI_PORT
    delete process.env.DSC_UI_ASSETS
    mkdirSync(DSC_HOME, { recursive: true })
    writeFileSync(
      join(DSC_HOME, 'plugins.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { file: 'webserver', disabled: false, config: { enabled: true, port: 17400, assetsDir: join(WORK, 'from-file') } },
        ],
      }),
    )
    const fromFile = readUiServerConfig(undefined)
    expect(fromFile.enabled).toBe(true)
    expect(fromFile.port).toBe(17400)
    expect(fromFile.assetsDir).toBe(join(WORK, 'from-file'))
  })

  test('环境变量盖过条目树', () => {
    process.env.DSC_UI_ASSETS = join(WORK, 'from-env')
    expect(readUiServerConfig(undefined).assetsDir).toBe(join(WORK, 'from-env'))
    delete process.env.DSC_UI_ASSETS
  })

  test('自定义产物目录生效；没有插件目录也能起服务', async () => {
    const customAssets = makeTree('custom-assets', {
      'index.html': '<!doctype html><html><body>桌面渲染层产物</body></html>',
    })
    const custom = await createUiServer({
      host: { name: 'Pneuma', version: 'test' },
      assetsDir: customAssets,
      pluginsDir: join(WORK, 'no-plugins'),
      log: () => {},
    })
    const token = new URL(custom.url).searchParams.get('token') ?? ''
    const handshake = await http('GET', custom.port, `/?token=${token}`)
    const customCookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]
    const page = await http('GET', custom.port, '/', { cookie: customCookie })
    expect(page.status).toBe(200)
    expect(page.body).toContain('桌面渲染层产物')
    expect(custom.boot().entries.length).toBe(0)
    await custom.close()
  })
})

// ── [4c] 数据通道（SSE 推帧 + POST 调方法） ─────────────────────────────────────
describe('数据通道（SSE 推帧 + POST 调方法）', () => {
  /** 假宿主状态（探针同款：会变的 tick + 两个方法）。 */
  let events: UiEventsHandle
  let server: UiServerHandle
  let cookie = ''
  let tick = 0
  const subscribers: Array<() => void> = []
  /** 各条 SSE 连接（close 时统一收口）。 */
  const streams: Array<{ state: { text: string }; close: () => void }> = []

  /** 开一条 SSE 连接并读一小段（返回快照文本的读取器）。 */
  function openSse(headers: Record<string, string> = {}): { state: { text: string }; close: () => void } {
    const state = { text: '' }
    const req = request(
      { host: '127.0.0.1', port: server.port, method: 'GET', path: '/api/events', headers, agent: false },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          state.text += chunk
        })
      },
    )
    req.on('error', () => {})
    req.end()
    const stream = { state, close: (): void => {
      req.destroy()
    } }
    streams.push(stream)
    return stream
  }

  /** beforeAll 的读数（键语义见各 test）。 */
  const facts: Record<string, unknown> = {}
  const invokeResults: Array<{ label: string; status: number; body: string }> = []
  const first: { state: { text: string }; close: () => void } = { state: { text: '' }, close: (): void => {} }
  const second: { state: { text: string }; close: () => void } = { state: { text: '' }, close: (): void => {} }
  const resumed: { state: { text: string }; close: () => void } = { state: { text: '' }, close: (): void => {} }
  let pushedSeq = 0

  beforeAll(async () => {
    const assetsDir = makeTree('events-assets', { 'index.html': '<!doctype html><html><body>x</body></html>' })
    const pluginsDir = makeTree('events-plugins', {
      'manifest.json': JSON.stringify({ version: 1, apiVersion: '2.0.0', plugins: [] }),
    })
    events = createUiEvents({
      snapshot: (): FrameLike & Record<string, unknown> => ({
        sessionId: 'sess-1',
        status: { sessionId: 'sess-1', model: 'fake-model', turnState: 'idle' },
        entries: [{ id: 1, kind: 'user', text: `第 ${String(tick)} 帧` }],
        liveEntries: [],
      }),
      invoke: async (method, args) => {
        if (method === 'boom') throw new Error('方法炸了')
        return { method, args, tick }
      },
      methods: ['ok', 'boom'],
      hello: () => ({ protocolVersion: 1, methods: ['ok', 'boom'], host: { name: 'Pneuma', version: 'test' } }),
      subscribe: (onChange) => {
        subscribers.push(onChange)
        return () => {
          const at = subscribers.indexOf(onChange)
          if (at >= 0) subscribers.splice(at, 1)
        }
      },
      throttleMs: 20,
    })
    server = await createUiServer({
      host: { name: 'Pneuma', version: 'test' },
      assetsDir,
      pluginsDir,
      events,
      log: () => {},
    })
    const token = new URL(server.url).searchParams.get('token') ?? ''
    const handshake = await http('GET', server.port, `/?token=${token}`)
    cookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]

    const anonymous = await http('POST', server.port, '/api/invoke', { 'content-type': 'application/json' }, '{}')
    invokeResults.push({ label: 'anonymous', status: anonymous.status, body: anonymous.body })

    Object.assign(first, openSse({ cookie }))
    await sleep(120)
    Object.assign(second, openSse({ cookie }))
    await sleep(120)

    // 宿主变一次 → 两条连接都该收到增量帧
    tick = 1
    for (const notify of [...subscribers]) notify()
    await sleep(150)
    pushedSeq = Number(/"seq":(\d+)/.exec(second.state.text.split('event: frame').pop() ?? '')?.[1] ?? 0)

    // 断开一号连接，宿主再变一次（只有二号在收）
    first.close()
    tick = 2
    for (const notify of [...subscribers]) notify()
    await sleep(150)

    // 一号带着「我已经收到 N 帧」重连：应该只补它漏掉的那一帧
    Object.assign(resumed, openSse({ cookie, 'last-event-id': String(pushedSeq) }))
    await sleep(150)

    const call = async (payload: string, headers: Record<string, string> = { cookie, 'content-type': 'application/json' }): Promise<void> => {
      const res = await http('POST', server.port, '/api/invoke', headers, payload)
      invokeResults.push({ label: payload, status: res.status, body: res.body })
    }
    await call(JSON.stringify({ method: 'ok', args: [1, 'a'] }))
    await call(JSON.stringify({ method: 'boom' }))
    await call(JSON.stringify({ method: 'exit' }))
    await call('不是 JSON')
  })

  afterAll(async () => {
    for (const stream of streams.splice(0)) stream.close()
    events.stop()
    await server.close()
  })

  test('没凭据调方法 401', () => {
    const anonymous = invokeResults.find((call) => call.label === 'anonymous')
    expect(anonymous?.status).toBe(401)
  })
  test('SSE 连接建立，握手带协议版本与放行方法', () => {
    expect(first.state.text).toContain('event: hello')
    expect(first.state.text).toContain('"protocolVersion":1')
    expect(first.state.text).toContain('"ok"')
  })
  test('首帧是全量（含 seq 与 full）且带宿主状态', () => {
    expect(first.state.text).toContain('event: frame')
    expect(first.state.text).toContain('"full":true')
    expect(first.state.text).toContain('fake-model')
  })
  test('第二个连接也拿到全量帧', () => {
    expect(second.state.text).toContain('"full":true')
  })
  test('宿主变化推来下一帧（增量），另一条连接也收到了', () => {
    expect(first.state.text).toContain('"type":"delta"')
    expect(second.state.text).toContain('"type":"delta"')
  })
  test('推来的帧带单调帧号', () => {
    expect(pushedSeq).toBeGreaterThan(2)
  })
  test('带 last-event-id 重连时补帧，不重发已收到的帧', () => {
    expect(resumed.state.text).toContain(`"seq":${String(pushedSeq + 1)}`)
    expect(resumed.state.text.includes(`"seq":${String(pushedSeq)}`)).toBe(false)
  })
  test('合法调用 200 且回值、参数原样送到宿主', () => {
    const okCall = invokeResults.find((call) => call.label === JSON.stringify({ method: 'ok', args: [1, 'a'] }))
    expect(okCall?.status).toBe(200)
    expect(okCall?.body).toContain('"ok":true')
    expect(okCall?.body).toContain('"args":[1,"a"]')
  })
  test('方法抛错回 ok:false 而不是 5xx', () => {
    const boomCall = invokeResults.find((call) => call.label === JSON.stringify({ method: 'boom' }))
    expect(boomCall?.status).toBe(200)
    expect(boomCall?.body).toContain('方法炸了')
  })
  test('白名单外的方法 403', () => {
    const denied = invokeResults.find((call) => call.label === JSON.stringify({ method: 'exit' }))
    expect(denied?.status).toBe(403)
  })
  test('请求体不是 JSON 400', () => {
    const bad = invokeResults.find((call) => call.label === '不是 JSON')
    expect(bad?.status).toBe(400)
  })
  test('通道报出连接数', () => {
    expect(events.clients).toBeGreaterThanOrEqual(0)
  })
})

// ── [4d] 帧往返（宿主产 → 壳并） ────────────────────────────────────────────────
describe('帧往返（宿主产 → 壳并）', () => {
  /** 快照构造器（探针同款）。 */
  const snap = (text: string, live: Array<{ id: number; kind: string; text: string }>): FrameLike & Record<string, unknown> => ({
    sessionId: 's-1',
    status: { sessionId: 's-1', model: 'm' },
    entries: [
      { id: 1, kind: 'user', text: '第一条' },
      { id: 2, kind: 'assistant', text },
    ],
    liveEntries: live,
  })

  /** 起一个 hub 并收第一帧全量（其余用例在它之上做增量）。 */
  function firstFrame(): { hub: RemoteFrameHub; state: ReturnType<typeof applyHostFrame> } {
    const hub = new RemoteFrameHub()
    const frame = JSON.parse(hub.build(snap('甲', []), true).text) as Record<string, unknown>
    return { hub, state: applyHostFrame(null, frame) }
  }

  test('全量帧并进空状态；状态字段进 meta', () => {
    const { state } = firstFrame()
    expect(state.entries.length).toBe(2)
    expect(state.entries[0]?.text).toBe('第一条')
    expect((state['status'] as { model?: string } | undefined)?.model).toBe('m')
  })

  test('增量帧更新已有条目、带上直播尾、帧号单调前进', () => {
    const { hub, state } = firstFrame()
    const second = JSON.parse(hub.build(snap('乙', [{ id: -1, kind: 'thinking', text: '想…' }]), false).text) as Record<string, unknown>
    const merged = applyHostFrame(state, second)
    expect(merged.entries.find((entry) => entry.id === 2)?.text).toBe('乙')
    expect(merged.liveEntries.length).toBe(1)
    expect(merged.liveEntries[0]?.id).toBe(-1)
    expect(merged.seq).toBe(2)
  })

  test('消失的条目被删掉；直播尾清空', () => {
    const { hub, state } = firstFrame()
    const withLive = applyHostFrame(
      state,
      JSON.parse(hub.build(snap('乙', [{ id: -1, kind: 'thinking', text: '想…' }]), false).text) as Record<string, unknown>,
    )
    const third = JSON.parse(
      hub.build({ ...snap('乙', []), entries: [{ id: 1, kind: 'user', text: '第一条' }] }, false).text,
    ) as Record<string, unknown>
    const merged = applyHostFrame(withLive, third)
    expect(merged.entries.length).toBe(1)
    expect(merged.entries[0]?.id).toBe(1)
    expect(merged.liveEntries.length).toBe(0)
  })

  test('缺 seq 的帧当场报错（严格版）', () => {
    const { state } = firstFrame()
    expect(() => applyHostFrame(state, { type: 'delta', full: false })).toThrow()
  })

  test('条目缺 id 当场报错', () => {
    const { state } = firstFrame()
    expect(() => applyHostFrame(state, { type: 'snapshot', full: true, seq: 9, entries: [{ kind: 'user' }] })).toThrow()
  })
})
