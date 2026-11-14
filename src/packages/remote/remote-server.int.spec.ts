/**
 * 远程控制 HTTP 层：Host 头校验（防 DNS rebinding）、createRemoteServer 桩依赖下的静态
 * 兜底与鉴权闸、远程方法白名单（迁自 `scripts/remote-host-test.mjs` 第 5、6、7 节）。
 *
 * ## 被测的是什么
 *
 *   [5] `hostHeaderAllowed`：IP 字面量 / localhost 放行，域名与端口不符拒绝——攻击者的
 *       网页解析到 127.0.0.1 时，请求从本机发出，能看的是 Host 头（web-http.ts:95 的两条规矩）。
 *   [6] `createRemoteServer` 在**桩依赖**下（不起宿主）的最小事实：静态目录不存在时 `/`
 *       返回「资产未构建」占位页（200，界面还没构建时走的就是这条）、别的路径 404、
 *       域名 Host 被 403、上传没 token 是 401 而不是 403（先过 Host 闸再过 token 闸）。
 *   [7] 白名单：凭据 / 设置 / 宿主生命周期 12 个方法一概不在 `REMOTE_METHODS` 里；
 *       壳那档放行设置页的只读投影与切模式（getModelConfig / listPresets / readPreset /
 *       usePreset，2026-10-27 报障第 5 条）；这四条**没有**被顺手放宽进移动端白名单；
 *       浏览端要用的提交 / 打断 / 切会话 / 答卡 / 看历史都在。
 *
 * ## 桩的两个关键点（探针原样，注释保留）
 *
 * - `shellUi: null`：类型上是必填（`RemoteShellUi | null`，只有「有壳」与「没有」两种）。
 *   显式给 null = 这条桩走「没开壳档」的经典资产路径——路由按 `!== null` 判空，漏了这一项
 *   会是 undefined 而不是 null，两条静态兜底断言当场 500（本探针 2026-10-13 之前一直红在
 *   这：批次 8 的 lib 对照复现过同样两条）。
 * - `snapshot()` 的桩是 `as unknown as RemoteSnapshot`：RuntimeSnapshot 的必填面（StatusView /
 *   RuntimeSurfaces）属于界面契约，由组装层自己的测试覆盖；传输层只把它原样透传给帧流
 *   （字段形状由 frames.int.spec 与 remote-ws.int.spec 覆盖），这里不需要一份真的。
 *
 * ## 隔离与端口
 *
 * 服务端口用探针的 `freePort()` 模式（先 listen 0 再关），integration 是 forks 池每文件
 * 一进程，不会撞口。上传落盘目录在 tempHome 下。被测包模块按同目录相对 import
 * （`./index.js` 等，ops-worker spec 同款）；core 侧的 pairing / tickets / uploads 在
 * tempHome 换好 HOME 之后动态 import（时序要求见 prefs.int.spec 文件头）。
 *
 * @module dsc/packages/remote/remote-server.int.spec
 */
import { createServer as httpCreateServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../tests/harness.js'
import { hostHeaderAllowed } from './http.js'
import { REMOTE_METHODS, REMOTE_SHELL_METHODS } from './types.js'
import type { RemoteServerHandle, RemoteSnapshot } from './types.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见 prefs.int.spec 文件头）。 */
const home = tempHome('dsc-remote-server-')

delete process.env['DSC_HOME']

type CoreRemoteModule = typeof import('@pneuma/runtime/core/remote/uploads.js')
type PairingModule = typeof import('@pneuma/runtime/core/remote/pairing.js')
type TicketsModule = typeof import('@pneuma/runtime/core/remote/tickets.js')
type ServerModule = typeof import('./index.js')
let coreMod: CoreRemoteModule
let pairingMod: PairingModule
let ticketsMod: TicketsModule
let serverMod: ServerModule

/** 由系统挑一个空闲端口（先 listen 0 再关掉，紧接着给桩服务用）。 */
async function freePort(): Promise<number> {
  return await new Promise((resolvePort) => {
    const probe = httpCreateServer()
    probe.listen(0, '127.0.0.1', () => {
      const chosen = (probe.address() as { port: number }).port
      probe.close(() => resolvePort(chosen))
    })
  })
}

/** 一个最小 HTTP 调用器：body 可以是字符串也可以是 Buffer（原始字节）。 */
type RequestFn = typeof httpRequest
interface HttpCallOptions {
  host?: string
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
}
const httpCall = (port: number, path: string, options: HttpCallOptions = {}): Promise<{ status: number | undefined; body: string }> =>
  new Promise((resolveCall, rejectCall) => {
    const headers: Record<string, string> = { ...(options.host === undefined ? {} : { host: options.host }), ...(options.headers ?? {}) }
    if (typeof options.body === 'string') headers['content-length'] = String(Buffer.byteLength(options.body))
    if (Buffer.isBuffer(options.body)) headers['content-length'] = String(options.body.length)
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolveCall({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', rejectCall)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })

/** 探针的最小快照桩（为什么可以不完整：见文件头「桩的两个关键点」）。 */
const snapshotOf = (): RemoteSnapshot =>
  ({
    sessionId: 's',
    cwd: 'c',
    status: {},
    surfaces: {},
    sessions: [],
    sessionsLoading: false,
    entries: [],
    liveEntries: [],
  }) as unknown as RemoteSnapshot

/** 第 6 节的桩服务句柄与其端口（beforeAll 起，afterAll 收）。 */
let server: RemoteServerHandle
let stubPort = 0

beforeAll(async () => {
  coreMod = await import('@pneuma/runtime/core/remote/uploads.js')
  pairingMod = await import('@pneuma/runtime/core/remote/pairing.js')
  ticketsMod = await import('@pneuma/runtime/core/remote/tickets.js')
  serverMod = await import('./index.js')
  stubPort = await freePort()
  const served: string[] = []
  const created = serverMod.createRemoteServer({
    port: stubPort,
    lan: false,
    throttleMs: 80,
    // 指到一个不存在的目录：界面还没构建时走的就是这一条
    assetsDir: join(home.home, '没有这个目录'),
    pairing: new pairingMod.RemotePairing({ dir: join(home.home, 'pairing-server') }),
    tickets: new ticketsMod.TicketStore(),
    // shellUi 必须显式给 null：漏了这一项会是 undefined 而不是 null，静态兜底两条当场 500
    shellUi: null,
    uploads: new coreMod.RemoteUploads({ dir: join(home.home, 'uploads-stub') }),
    invoke: async () => null,
    snapshot: snapshotOf,
    subscribe: () => () => {},
    notice: (text: string) => served.push(text),
    pushEnabled: () => false,
    pushPublicKey: () => null,
    pushSubscribe: () => ({ ok: false, error: '桩不该被调到' }),
    pushUnsubscribe: () => false,
  })
  await created.ready
  server = created
})

afterAll(() => {
  server?.close()
  home.restore()
})

describe('Host 头校验（防 DNS rebinding）', () => {
  const port = 17321
  test('127.0.0.1:端口 放行', () => {
    expect(hostHeaderAllowed('127.0.0.1:17321', port)).toBe(true)
  })
  test('localhost:端口 放行', () => {
    expect(hostHeaderAllowed('localhost:17321', port)).toBe(true)
  })
  test('局域网 IP 字面量放行（手机就是用这个地址连的）', () => {
    expect(hostHeaderAllowed('192.168.1.7:17321', port)).toBe(true)
  })
  test('[::1]:端口 放行', () => {
    expect(hostHeaderAllowed('[::1]:17321', port)).toBe(true)
  })
  test('域名拒绝（攻击者的网页就长这样）', () => {
    expect(hostHeaderAllowed('evil.example.com:17321', port)).toBe(false)
  })
  test('端口不符拒绝', () => {
    expect(hostHeaderAllowed('127.0.0.1:9999', port)).toBe(false)
  })
  test('没带端口拒绝', () => {
    expect(hostHeaderAllowed('127.0.0.1', port)).toBe(false)
  })
  test('没有 Host 头拒绝', () => {
    expect(hostHeaderAllowed(undefined, port)).toBe(false)
  })
})

describe('HTTP 服务端（桩依赖）', () => {
  test('静态目录不存在时 / 返回「资产未构建」占位页', async () => {
    const home1 = await httpCall(stubPort, '/')
    expect(home1.status).toBe(200)
    expect(home1.body.includes('资产未构建')).toBe(true)
  })

  test('别的路径找不到就 404', async () => {
    const missing = await httpCall(stubPort, '/app-missing.js')
    expect(missing.status).toBe(404)
  })

  test('桩服务同样拦域名 Host（403）', async () => {
    const wrongHost = await httpCall(stubPort, '/', { host: `evil.example.com:${String(stubPort)}` })
    expect(wrongHost.status).toBe(403)
  })

  test('上传也要过 Host 检查与 token 检查（没 token → 401，不是 403）', async () => {
    const uploadNoAuth = await httpCall(stubPort, '/api/upload?filename=a.txt', { method: 'POST', body: 'x' })
    expect(uploadNoAuth.status).toBe(401)
  })
})

describe('远程方法白名单', () => {
  const blocked = [
    'saveProvider',
    'removeProvider',
    'setProviderKey',
    'setDefaultModel',
    'setSettingValue',
    'runSettingAction',
    'installMarketSkill',
    'setSkillEnabled',
    'setMarketSources',
    'dock',
    'runCommand',
    'exit',
  ]

  test('凭据 / 设置 / 宿主生命周期操作一概不在远程白名单里', () => {
    const leaked = blocked.filter((method) => (REMOTE_METHODS as readonly string[]).includes(method))
    expect(leaked.join('、')).toBe('')
  })

  // 2026-10-27 报障第五条：手机上设置 → 模型 / 模式整页打不开（getModelConfig / listPresets
  // 不在白名单里）。补的是**只读**那两条与切模式，写入类继续挡着（下面那条挡单断言覆盖）。
  test('壳放行设置页的只读投影与切模式（模型页 / 模式页 / 输入区那颗模式 chip）', () => {
    const missing = ['getModelConfig', 'listPresets', 'readPreset', 'usePreset'].filter(
      (method) => !(REMOTE_SHELL_METHODS as readonly string[]).includes(method),
    )
    expect(missing.join('、')).toBe('')
  })

  test('移动端白名单本身没被顺手放宽（这两条只在壳那一档）', () => {
    const widened = ['getModelConfig', 'listPresets', 'readPreset', 'usePreset'].filter((method) =>
      (REMOTE_METHODS as readonly string[]).includes(method),
    )
    expect(widened.join('、')).toBe('')
  })

  test('浏览端要用的那几个都在（提交 / 打断 / 切会话 / 答卡 / 看历史）', () => {
    const missing = ['submit', 'interrupt', 'openSession', 'answerApproval', 'answerPlan', 'answerQuestion', 'listArchivedSessions'].filter(
      (method) => !(REMOTE_METHODS as readonly string[]).includes(method),
    )
    expect(missing.join('、')).toBe('')
  })
})
