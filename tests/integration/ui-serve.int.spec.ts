/**
 * 本机界面服务的宿主半边：方法白名单与实参校验、webserver 插件真装配、信任闸 / 换票 /
 * Cookie、bundle 代际与产物表缓存（迁自 `scripts/ui-serve-test.mjs`）。
 *
 * ## 被测的是什么（探针文件头的五件事，这里逐段对应）
 *
 * 1. `core/ui-methods` 的白名单与 `validateUiArgs`：凭据 / 破坏性 / 命令执行 / 策略这几类
 *    方法不在放行面；实参的个数、类型、长度、枚举在入口被拦（纯函数段）。
 * 2. webserver 插件真装配：`apply(fakeCtx)` 后 `provide('webServer')`，`ensure()` 起真服务；
 *    启动日志里有带令牌的入口地址、签名密钥落盘且绝不进日志；被排除的方法经
 *    `/api/invoke` 调不动、且一次都没执行到。
 * 3. 信任闸与换票：Host 不对 403、`sec-fetch-site: cross-site` 403、Origin 不是本服务 403、
 *    Cookie 动一个字节 401；303 + `no-store` + `no-referrer` + 带 Max-Age 的 HttpOnly Cookie；
 *    令牌只能用一次；宿主重启后旧 Cookie 仍有效（密钥落盘）。
 * 4. bundle 代际：缺 rev 404、旧 rev 拿旧字节（上一代保留）、新 rev 拿新字节、HEAD 复用
 *    GET 的头且无体、非 GET/HEAD 405、多段 id 能伺服、路径穿越被拒。
 * 5. 产物表缓存与清单失败方向：第二次请求不再逐文件 stat（只多「根清单 + 每目录一次」）、
 *    未知 platform / 坏字段 / 坏 JSON / 旧产物都被点名进 problems。
 *
 * ## 落位与隔离
 *
 * 临时 HOME 由 `tests/setup/temp-home.ts` 给：签名密钥落 `DSC_HOME` 下、条目树读写全在
 * 临时目录。真服务的端口用 0（系统分配）；夹具目录 `mkdtempSync`。
 *
 * ## 与探针的对应
 *
 * `check()` 一条对应一个 `test`；时序敏感的段落（真装配 → 抓日志 → 换票 → 逐个拒）在
 * `beforeAll` / 段首按原次序跑完、读数记进局部对象。
 *
 * @module dsc/tests/integration/ui-serve
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { UI_COOKIE, UI_COOKIE_MAX_AGE_MS, UI_SECRET_FILE, createUiServer, type UiServerHandle } from '@pneuma/runtime/core/ui-server.js'
import { UI_ARG_SPECS, UI_METHODS, isUiMethod, validateUiArgs } from '@pneuma/runtime/core/ui-methods.js'
import { collectUiPluginArtifacts, resetUiArtifactCacheCounters, uiArtifactCacheCounters } from '@pneuma/runtime/core/ui-bundles.js'
import { resolveUiBundleRequest } from '@pneuma/runtime/core/ui-route.js'
import { checkUiRequestTrust, timingSafeEqualText, verifyUiCookie } from '@pneuma/runtime/core/ui-trust.js'
import { webserverPlugin } from '@pneuma/webserver/index.js'

/** 夹具总目录；失败现场留着翻，成功时 afterAll 删。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-serve-'))

// 探针同款：环境里带了这几个变量会把「默认不起服务」的基线改掉。
delete process.env.DSC_UI_SERVER
delete process.env.DSC_UI_ASSETS
delete process.env.DSC_UI_PORT
delete process.env.DSC_UI_HMR

afterAll(() => {
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

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

/** 一条 HTTP 响应的读数。 */
interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** 发一个 HTTP 请求（node:http，自定义 Host / Origin / sec-fetch-site 与请求体都要它）。 */
function http(method: string, port: number, path: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    // agent: false = 每个请求自己一条连接：后面要在同一端口关了再开，池子里的旧套接字
    // 被服务端掐掉时会冒 ECONNRESET（探针同款）。
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : Buffer.from(body, 'utf8'))
  })
}

/** POST 一个 invoke 请求。 */
function invoke(port: number, cookie: string, method: string, args?: unknown[]): Promise<HttpResult> {
  const payload = JSON.stringify(args === undefined ? { method } : { method, args })
  return http('POST', port, '/api/invoke', { cookie, 'content-type': 'application/json' }, payload)
}

const sleep = (ms: number): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

// ── 1. 方法白名单与实参校验（纯函数） ──────────────────────────────────────────
describe('方法白名单与实参校验（纯函数）', () => {
  const excluded = ['setProviderKey', 'saveProvider', 'removeProvider', 'runCommand', 'purgeSessions', 'setPolicy', 'installMarketSkill', 'setMarketSources']

  test('凭据 / 破坏性 / 命令执行 / 策略这几类都不在白名单', () => {
    const leaked = excluded.filter((name) => isUiMethod(name))
    expect(leaked.join(','), leaked.join(',')).toBe('')
  })

  test('dock 在放行面（读 + 写两档），term-* 一档都不给', () => {
    expect(isUiMethod('dock')).toBe(true)
    const dockSpec = (UI_ARG_SPECS as unknown as Record<string, Array<{ shape: { kind: string; values?: readonly string[] } }>>)['dock']?.[0]?.shape
    const dockOps = dockSpec !== undefined && dockSpec.kind === 'enum' ? [...(dockSpec.values ?? [])] : []
    expect(dockOps.length, dockOps.join(',')).toBeGreaterThan(0)
    expect(dockOps.every((op) => !op.startsWith('term-')), dockOps.join(',')).toBe(true)
    expect(validateUiArgs('dock', ['term-spawn', { cwd: '.' }]).ok).toBe(false)
  })

  test('界面真正要用的方法都放行', () => {
    const allowed = ['submit', 'interrupt', 'openSession', 'answerApproval', 'answerQuestion', 'answerPlan', 'setModel', 'refreshSessions', 'listModels', 'setUiPrefs', 'getUiPrefs', 'listPlugins', 'setPluginEnabled', 'listTools', 'listSkills', 'getSettingsSections', 'getSectionValues', 'setSettingValue', 'runSettingAction', 'getModelConfig', 'goalAction', 'clearTodos', 'listPresets', 'usePreset', 'editQueued', 'removeQueued', 'steerQueued', 'compact', 'setEffort', 'setMode', 'dock']
    const missing = allowed.filter((name) => !isUiMethod(name))
    expect(missing.join(','), missing.join(',')).toBe('')
  })

  test('每个放行的方法都有实参规格，规格与方法一一对应', () => {
    const specKeys = Object.keys(UI_ARG_SPECS as Record<string, unknown>)
    expect(UI_METHODS.every((name) => (UI_ARG_SPECS as Record<string, unknown>)[name] !== undefined) && specKeys.length === UI_METHODS.length, `${String(specKeys.length)} vs ${String(UI_METHODS.length)}`).toBe(true)
  })

  test('参数个数超限被拒', () => {
    expect(validateUiArgs('listModels', [1]).ok).toBe(false)
  })
  test('必传实参缺失被拒（不能把 undefined 铺给宿主）', () => {
    expect(validateUiArgs('removeQueued', []).ok).toBe(false)
  })
  test('类型不对被拒（该数字给了字符串）', () => {
    expect(validateUiArgs('removeQueued', ['第 0 条']).ok).toBe(false)
  })
  test('布尔位给了字符串被拒', () => {
    expect(validateUiArgs('setSessionPinned', ['/a.jsonl', 'yes']).ok).toBe(false)
  })
  test('超长字符串被拒', () => {
    expect(validateUiArgs('setModel', ['m'.repeat(500)]).ok).toBe(false)
  })
  test('枚举取值不对被拒；取值对时放行', () => {
    expect(validateUiArgs('setEffort', ['turbo']).ok).toBe(false)
    expect(validateUiArgs('setEffort', ['high']).ok).toBe(true)
  })
  test('字符串数组里混了非字符串被拒', () => {
    expect(validateUiArgs('archiveSessions', [['/a.jsonl', 7]]).ok).toBe(false)
  })
  test('超长 JSON 实参被拒', () => {
    expect(validateUiArgs('savePreset', [{ blob: 'x'.repeat(40000) }]).ok).toBe(false)
  })
  test('可选参数写 null = 不传（尾部空值去掉）', () => {
    const checked = validateUiArgs('interrupt', [null])
    expect(checked.ok).toBe(true)
    expect(checked.ok ? checked.args : []).toEqual([])
  })
  test('中间空一个要拒（省略只能从尾部开始）', () => {
    expect(validateUiArgs('answerPlan', [null, '意见']).ok).toBe(false)
  })
  test('正常调用通过且实参原样', () => {
    const checked = validateUiArgs('editQueued', [0, '改一下'])
    expect(checked.ok).toBe(true)
    expect(checked.ok ? JSON.stringify(checked.args) : '').toBe('[0,"改一下"]')
  })

  test('定长时间比较：等长不等值给假、等值给真', () => {
    expect(timingSafeEqualText('abc', 'abd')).toBe(false)
    expect(timingSafeEqualText('abc', 'abc')).toBe(true)
  })

  test('信任闸：Host 不是本机地址给 403', () => {
    const denial = checkUiRequestTrust({ host: 'evil.example:1234' }, 1234)
    expect(denial !== null && denial.status === 403, JSON.stringify(denial)).toBe(true)
  })
})

// ── 2. 界面通道真装配（webserver 插件 + 假宿主） ───────────────────────────────
describe('界面通道（webserver 插件真装配）', () => {
  const HOME = process.env.HOME ?? process.env.USERPROFILE ?? ''
  /** beforeAll 的读数（键语义见各 test）。 */
  const facts: Record<string, unknown> = {}
  const calls: Array<{ method: string; args: unknown[] }> = []

  beforeAll(async () => {
    const assets = makeTree('wired-assets', { 'index.html': '<!doctype html><html><body>壳</body></html>' })
    const fakeRuntime = {
      submit: (text: unknown, images: unknown) => {
        calls.push({ method: 'submit', args: [text, images] })
      },
      listModels: () => [{ id: 'fake-model' }],
      setProviderKey: (name: unknown, key: unknown) => {
        calls.push({ method: 'setProviderKey', args: [name, key] })
        return '写进去了'
      },
      runCommand: (input: unknown) => {
        calls.push({ method: 'runCommand', args: [input] })
        return true
      },
      purgeSessions: (paths: unknown) => {
        calls.push({ method: 'purgeSessions', args: [paths] })
        return { ok: true }
      },
      setPolicy: (policy: unknown) => {
        calls.push({ method: 'setPolicy', args: [policy] })
      },
      getSnapshot: () => ({ status: { sessionId: 's-1', model: 'fake-model' }, entries: [], queued: [] }),
      subscribe: () => () => {},
    }
    const provided: Record<string, unknown> = {}
    const effects: Array<() => unknown> = []
    // 事件面：webserver 2026-10-25 起订阅 `dsc/side-ask-chunk`（旁问流式增量）转发成 SSE，
    // 所以这个假 ctx 也要有 on。返回值是退订函数（cordis 的同一形状）。
    const listeners = new Map<string, () => void>()
    const fakeCtx = {
      ui: fakeRuntime,
      provide: (name: string, service: unknown) => {
        provided[name] = service
      },
      effect: (fn: () => unknown) => {
        effects.push(fn)
      },
      on: (name: string, handler: () => void) => {
        listeners.set(name, handler)
        return () => {
          listeners.delete(name)
        }
      },
      // info 也要给：界面产物热更默认开（2026-11-05 起），启动那一刻会打一行 info。
      logger: { info: () => {}, warn: () => {} },
    }

    webserverPlugin.apply(fakeCtx as never, { enabled: true, port: 0, assetsDir: assets })
    const service = provided['webServer'] as { ensure: () => Promise<{ port: number; url: string }> } | undefined
    facts['provided'] = service !== undefined && typeof service?.ensure === 'function'
    if (service === undefined) return

    // 启动那一刻的日志要抓下来：既验「打印了入口地址」，也验「签名密钥绝不进日志」。
    // 入口地址走的是 `webserver/index.ts` 里的裸 `console.log`；vitest 在 worker 里拦截
    // console 并持有自己的输出通道，探针那种「patch process.stdout.write」在这里抓不到它，
    // 所以 patch 的对象换成 console 本身（stdout 那层一并抓，双保险）。
    let captured = ''
    const originals = new Map<string, ((...args: unknown[]) => void) | undefined>()
    const capture = (...args: unknown[]): void => {
      captured += `${args.map((arg) => String(arg)).join(' ')}\n`
    }
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      originals.set(method, console[method])
      console[method] = capture as (typeof console)[typeof method]
    }
    const stdoutWrite = process.stdout.write.bind(process.stdout)
    const stderrWrite = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((chunk: unknown) => {
      captured += String(chunk)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown) => {
      captured += String(chunk)
      return true
    }) as typeof process.stderr.write
    let running: { port: number; url: string } | null = null
    try {
      running = await service.ensure()
    } finally {
      for (const [method, original] of originals) {
        if (original !== undefined) console[method as 'log' | 'info' | 'warn' | 'error'] = original as (typeof console)['log']
      }
      process.stdout.write = stdoutWrite
      process.stderr.write = stderrWrite
    }

    const secretFile = join(HOME, '.dsc', UI_SECRET_FILE)
    const secretText = existsSync(secretFile) ? readFileSync(secretFile, 'utf8').trim() : ''
    facts['logHasTokenUrl'] = captured.includes('/?token=')
    facts['secretShape'] = /^[A-Za-z0-9_-]{43}$/.test(secretText)
    facts['secretNotInLog'] = secretText !== '' && !captured.includes(secretText)

    const wiredPort = running?.port ?? 0
    const wiredToken = new URL(running?.url ?? 'http://127.0.0.1/').searchParams.get('token') ?? ''
    const exchange = await http('GET', wiredPort, `/?token=${wiredToken}`)
    const wiredCookie = String(exchange.headers['set-cookie']?.[0] ?? '').split(';')[0]
    facts['cookie'] = wiredCookie.startsWith(`${UI_COOKIE}=`)

    const deniedSetProviderKey = await invoke(wiredPort, wiredCookie, 'setProviderKey', ['x'])
    const deniedRunCommand = await invoke(wiredPort, wiredCookie, 'runCommand', ['x'])
    const deniedPurgeSessions = await invoke(wiredPort, wiredCookie, 'purgeSessions', [['x']])
    const deniedSetPolicy = await invoke(wiredPort, wiredCookie, 'setPolicy', ['x'])
    facts['deniedSetProviderKey'] = deniedSetProviderKey.status
    facts['deniedRunCommand'] = deniedRunCommand.status
    facts['deniedPurgeSessions'] = deniedPurgeSessions.status
    facts['deniedSetPolicy'] = deniedSetPolicy.status
    facts['notExecuted'] = calls.length

    const badArg = await invoke(wiredPort, wiredCookie, 'submit')
    const tooLongArg = await invoke(wiredPort, wiredCookie, 'submit', ['x'.repeat(40000)])
    const manyArgs = await invoke(wiredPort, wiredCookie, 'listModels', [1, 2])
    const goodCall = await invoke(wiredPort, wiredCookie, 'submit', ['你好'])
    facts['badArg'] = { status: badArg.status, body: badArg.body }
    facts['tooLongArg'] = { status: tooLongArg.status, body: tooLongArg.body }
    facts['manyArgs'] = { status: manyArgs.status, body: manyArgs.body }
    facts['goodCall'] = { status: goodCall.status, body: goodCall.body }
    facts['callsAfterGood'] = calls

    const getInvoke = await http('GET', wiredPort, '/api/invoke', { cookie: wiredCookie })
    facts['invokeGet'] = getInvoke.status
    const bootGet = await http('GET', wiredPort, '/api/boot', { cookie: wiredCookie })
    const bootHead = await http('HEAD', wiredPort, '/api/boot', { cookie: wiredCookie })
    facts['bootHead'] = {
      status: bootHead.status,
      sameType: bootHead.headers['content-type'] === bootGet.headers['content-type'],
      sameLength: bootHead.headers['content-length'] === bootGet.headers['content-length'],
      emptyBody: bootHead.body === '',
    }

    // 握手报给客户端的清单也只能是子集。
    const sse = { text: '' }
    const sseReq = request(
      { host: '127.0.0.1', port: wiredPort, method: 'GET', path: '/api/events', headers: { cookie: wiredCookie }, agent: false },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          sse.text += chunk
        })
      },
    )
    // 这条连接会被我们主动掐掉，挂一个空 error 处理器：ECONNRESET 不该掀翻测试。
    sseReq.on('error', () => {})
    sseReq.end()
    await sleep(150)
    facts['sseAllowed'] = sse.text.includes('"submit"') && sse.text.includes('"listModels"')
    facts['sseExcluded'] = !sse.text.includes('setProviderKey') && !sse.text.includes('runCommand') && !sse.text.includes('purgeSessions')
    sseReq.destroy()

    for (const dispose of effects) {
      const stop = dispose()
      if (typeof stop === 'function') (stop as () => void)()
    }
    await sleep(50)
  })

  test('插件装配后 provide 了 webServer 服务', () => {
    expect(facts['provided']).toBe(true)
  })
  test('启动打印了带一次性令牌的入口地址', () => {
    expect(facts['logHasTokenUrl']).toBe(true)
  })
  test('签名密钥落盘在 DSC_HOME 下且形状正确', () => {
    expect(facts['secretShape']).toBe(true)
  })
  test('签名密钥没有出现在启动日志里', () => {
    expect(facts['secretNotInLog']).toBe(true)
  })
  test('换票拿到 Cookie', () => {
    expect(facts['cookie']).toBe(true)
  })
  test('凭据类方法经 /api/invoke 被拒（403）', () => {
    expect(facts['deniedSetProviderKey']).toBe(403)
    expect(facts['deniedRunCommand']).toBe(403)
    expect(facts['deniedPurgeSessions']).toBe(403)
    expect(facts['deniedSetPolicy']).toBe(403)
  })
  test('被排除的方法一次都没被执行到', () => {
    expect(facts['notExecuted']).toBe(0)
  })
  test('实参缺失回 ok:false 而不是执行', () => {
    const badArg = facts['badArg'] as { status: number; body: string }
    expect(badArg.status).toBe(200)
    expect(badArg.body).toContain('"ok":false')
  })
  test('超长实参被拒', () => {
    const tooLong = facts['tooLongArg'] as { status: number; body: string }
    expect(tooLong.status).toBe(200)
    expect(tooLong.body).toContain('太长')
  })
  test('参数个数超限被拒', () => {
    const many = facts['manyArgs'] as { status: number; body: string }
    expect(many.status).toBe(200)
    expect(many.body).toContain('最多收 0 个实参')
  })
  test('放行的方法正常执行，实参真的送到了宿主', () => {
    const good = facts['goodCall'] as { status: number; body: string }
    expect(good.status).toBe(200)
    expect(good.body).toContain('"ok":true')
    const callsAfterGood = facts['callsAfterGood'] as Array<{ method: string; args: unknown[] }>
    expect(callsAfterGood.length).toBe(1)
    expect(callsAfterGood[0]?.method).toBe('submit')
    expect(callsAfterGood[0]?.args[0]).toBe('你好')
  })
  test('调用端点非 POST 回 405', () => {
    expect(facts['invokeGet']).toBe(405)
  })
  test('HEAD /api/boot 与 GET 同头且无体', () => {
    const head = facts['bootHead'] as { status: number; sameType: boolean; sameLength: boolean; emptyBody: boolean }
    expect(head.status).toBe(200)
    expect(head.sameType).toBe(true)
    expect(head.sameLength).toBe(true)
    expect(head.emptyBody).toBe(true)
  })
  test('握手清单里有放行的方法、没有被排除的方法', () => {
    expect(facts['sseAllowed']).toBe(true)
    expect(facts['sseExcluded']).toBe(true)
  })
})

// ── 3-6. 真起服务：信任闸 / 换票 / bundle 代际 / 缓存 / 重启 Cookie ─────────────
describe('信任闸、换票、bundle 代际与缓存（真起服务）', () => {
  const assetsDir = makeTree('serve-assets', {
    'index.html': '<!doctype html><html><head><title>壳</title></head><body><div id="root"></div></body></html>',
  })
  const pluginsDir = makeTree('serve-plugins', {
    'manifest.json': JSON.stringify({
      version: 1,
      apiVersion: '2.0.0',
      plugins: [
        { id: 'demo', file: 'client.js', platform: 'web' },
        { id: '@scope/name', file: 'client.js', platform: 'web' },
      ],
    }),
    'demo/client.js': 'module.exports={apply(){return "old"}}',
    '@scope/name/client.js': 'module.exports={apply(){return "scoped"}}',
  })

  /** 时序敏感段落共享的服务与凭据。 */
  let server: UiServerHandle
  let cookie = ''
  let oldRev = ''
  let newRev = ''
  let earlyComboUrl = ''
  /** 换票握手（令牌一次性，只能在这里换一次，用例读捕获值）。 */
  let handshake: HttpResult | null = null

  beforeAll(async () => {
    server = await createUiServer({ host: { name: 'Pneuma', version: 'test' }, assetsDir, pluginsDir, log: () => {} })
    const token = new URL(server.url).searchParams.get('token') ?? ''
    handshake = await http('GET', server.port, `/?token=${token}`)
    cookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]
    const boot = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as {
      entries: Array<{ id: string; url: string }>
    }
    const demoUrl = boot.entries.find((entry) => entry.id === 'demo')?.url ?? ''
    oldRev = /rev=([0-9a-f]{12})/.exec(demoUrl)?.[1] ?? ''
  })

  afterAll(async () => {
    await server.close()
  })

  test('没凭据访问 401', async () => {
    const anonymous = await http('GET', server.port, '/')
    expect(anonymous.status).toBe(401)
  })

  test('换票是 303、no-store、no-referrer，Cookie 带 Max-Age / HttpOnly / SameSite=Strict / Path=/', () => {
    // 握手在 beforeAll 已经换过（令牌一次性）；这里只读捕获值。
    expect(handshake?.status).toBe(303)
    expect(String(handshake?.headers['cache-control'] ?? '')).toBe('no-store')
    expect(String(handshake?.headers['referrer-policy'] ?? '')).toBe('no-referrer')
    const setCookie = String(handshake?.headers['set-cookie']?.[0] ?? '')
    expect(setCookie).toContain(`Max-Age=${String(Math.floor(UI_COOKIE_MAX_AGE_MS / 1000))}`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie.split(';')[0]?.split('=')[1]?.split('.').length).toBe(3)
  })

  test('令牌不能二次使用', async () => {
    const token = new URL(server.url).searchParams.get('token') ?? ''
    const reuse = await http('GET', server.port, `/?token=${token}`)
    expect(reuse.status).toBe(403)
  })

  test('sec-fetch-site: cross-site → 403', async () => {
    const crossSite = await http('GET', server.port, '/', { cookie, 'sec-fetch-site': 'cross-site' })
    expect(crossSite.status).toBe(403)
  })

  test('same-origin + 本服务 Origin → 200；坏 Origin / 不透明 Origin → 403', async () => {
    const sameOrigin = await http('GET', server.port, '/', { cookie, 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${String(server.port)}` })
    expect(sameOrigin.status).toBe(200)
    const badOrigin = await http('GET', server.port, '/', { cookie, origin: 'http://evil.example' })
    expect(badOrigin.status).toBe(403)
    const opaqueOrigin = await http('GET', server.port, '/', { cookie, origin: 'null' })
    expect(opaqueOrigin.status).toBe(403)
  })

  test('什么都不带的正常请求 → 200；Host 不是本机地址 → 403', async () => {
    const plain = await http('GET', server.port, '/', { cookie })
    expect(plain.status).toBe(200)
    const badHost = await http('GET', server.port, '/', { cookie, host: `evil.example:${String(server.port)}` })
    expect(badHost.status).toBe(403)
  })

  test('Cookie 动一个字节就 401；没 Cookie 时校验直接给假', async () => {
    const tampered = await http('GET', server.port, '/', { cookie: `${cookie}x` })
    expect(tampered.status).toBe(401)
    expect(verifyUiCookie(Buffer.alloc(32, 7), `127.0.0.1:${String(server.port)}`, null, Date.now())).toBe(false)
  })

  test('缺 rev 一律 404（不混进不可变缓存），解析层同样拒', async () => {
    const missRev = await http('GET', server.port, '/plugins/demo/client.js', { cookie })
    expect(missRev.status).toBe(404)
    expect(resolveUiBundleRequest('/plugins/demo/client.js', null, pluginsDir).status).toBe(404)
  })

  test('当下这一代 200 且给一年不可变缓存；HEAD 与 GET 同状态、同头、无体', async () => {
    const boot = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as {
      entries: Array<{ id: string; url: string }>
      batches: Array<{ phase: string; url?: string }>
    }
    const demoUrl = boot.entries.find((entry) => entry.id === 'demo')?.url ?? ''
    const first = await http('GET', server.port, `/${demoUrl}`, { cookie })
    expect(first.status).toBe(200)
    expect(String(first.headers['cache-control'] ?? '')).toContain('immutable')
    const headBundle = await http('HEAD', server.port, `/${demoUrl}`, { cookie })
    expect(headBundle.status).toBe(200)
    expect(headBundle.headers['content-type']).toBe(first.headers['content-type'])
    expect(headBundle.headers['content-length']).toBe(first.headers['content-length'])
    expect(headBundle.headers['cache-control']).toBe(first.headers['cache-control'])
    expect(headBundle.body).toBe('')
    earlyComboUrl = boot.batches.find((batch) => batch.phase === 'early')?.url ?? ''
  })

  test('bundle 上非 GET/HEAD 回 405 带 Allow；静态资源上同样 405', async () => {
    const boot = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as {
      entries: Array<{ id: string; url: string }>
    }
    const demoUrl = boot.entries.find((entry) => entry.id === 'demo')?.url ?? ''
    const postBundle = await http('POST', server.port, `/${demoUrl}`, { cookie })
    expect(postBundle.status).toBe(405)
    expect(String(postBundle.headers['allow'] ?? '')).toContain('GET')
    expect((await http('DELETE', server.port, '/', { cookie })).status).toBe(405)
  })

  test('多段 id（@scope/name）能伺服；各种穿越与未知 id 被拒', async () => {
    const boot = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as {
      entries: Array<{ id: string; url: string }>
    }
    const scopedUrl = boot.entries.find((entry) => entry.id === '@scope/name')?.url ?? ''
    const scoped = await http('GET', server.port, `/${scopedUrl}`, { cookie })
    expect(scoped.status).toBe(200)
    expect(scoped.body).toContain('scoped')
    expect((await http('GET', server.port, '/plugins/demo/..%2F..%2Fmanifest.json', { cookie })).status).toBe(404)
    expect((await http('GET', server.port, '/plugins//etc/passwd/client.js', { cookie })).status).toBe(404)
    expect((await http('GET', server.port, '/plugins/@scope/%2E%2E%2F%2E%2E%2Fsecret/client.js', { cookie })).status).toBe(404)
    expect((await http('GET', server.port, `/plugins/nope/client.js?rev=${'0'.repeat(12)}`, { cookie })).status).toBe(404)
  })

  test('重建后旧 rev 仍拿旧字节（上一代保留），新 rev 拿新字节', async () => {
    // 重建：换掉 demo 的字节与清单本身（mtime/size 变 = 产物表换代）
    writeFileSync(join(pluginsDir, 'demo', 'client.js'), 'module.exports={apply(){return "brand new"}}')
    writeFileSync(
      join(pluginsDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        note: 'v2',
        plugins: [
          { id: 'demo', file: 'client.js', platform: 'web' },
          { id: '@scope/name', file: 'client.js', platform: 'web' },
        ],
      }),
    )
    const stale = await http('GET', server.port, `/plugins/demo/client.js?rev=${oldRev}`, { cookie })
    expect(stale.status).toBe(200)
    expect(stale.body.includes('old')).toBe(true)
    expect(stale.body.includes('brand new')).toBe(false)
    const boot2 = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as {
      entries: Array<{ id: string; url: string }>
    }
    newRev = /rev=([0-9a-f]{12})/.exec(boot2.entries.find((entry) => entry.id === 'demo')?.url ?? '')?.[1] ?? ''
    expect(newRev !== oldRev, `${oldRev} → ${newRev}`).toBe(true)
    const freshBundle = await http('GET', server.port, `/plugins/demo/client.js?rev=${newRev}`, { cookie })
    expect(freshBundle.status).toBe(200)
    expect(freshBundle.body.includes('brand new')).toBe(true)
    expect((await http('GET', server.port, `/plugins/demo/client.js?rev=${'f'.repeat(12)}`, { cookie })).status).toBe(404)
  })

  test('两次请求内容一致；第二次只多「根清单 + 每目录一次」的 stat，不重算产物表', async () => {
    const bundlePath = `/plugins/demo/client.js?rev=${newRev}`
    resetUiArtifactCacheCounters()
    const warm = await http('GET', server.port, bundlePath, { cookie })
    const afterFirst = uiArtifactCacheCounters()
    const again = await http('GET', server.port, bundlePath, { cookie })
    const afterSecond = uiArtifactCacheCounters()
    expect(warm.status).toBe(200)
    expect(again.body).toBe(warm.body)
    expect(afterFirst.fileStats).toBe(0)
    // 2.0 起「谁是插件」看目录：每次指纹要 stat 一次根清单 + 每个产物目录一次自述
    //（目录数含 @scope 这一层壳目录），但**不读字节、不重建产物表**。
    const pluginDirs = readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    expect(
      afterSecond.manifestStats === afterFirst.manifestStats + 1 + pluginDirs &&
        afterSecond.fileStats === afterFirst.fileStats &&
        afterSecond.tableBuilds === afterFirst.tableBuilds,
      `${JSON.stringify(afterFirst)} → ${JSON.stringify(afterSecond)}`,
    ).toBe(true)
  })

  test('宿主重启后同一个 authority 的旧 Cookie 仍然有效，重启后换的新 Cookie 也能用', async () => {
    expect((await http('GET', server.port, '/', { cookie })).status).toBe(200)
    const oldPort = server.port
    await server.close()
    server = await createUiServer({ host: { name: 'Pneuma', version: 'test' }, assetsDir, pluginsDir, port: oldPort, log: () => {} })
    const afterRestart = await http('GET', server.port, '/', { cookie })
    expect(afterRestart.status).toBe(200)
    const newToken = new URL(server.url).searchParams.get('token') ?? ''
    const freshCookie = String((await http('GET', server.port, `/?token=${newToken}`)).headers['set-cookie']?.[0] ?? '').split(';')[0]
    expect((await http('GET', server.port, '/', { cookie: freshCookie })).status).toBe(200)
  })

  test('上一代 combo 地址在换代后仍然 200（上一代保留）', async () => {
    if (earlyComboUrl === '') return
    const oldComboResp = await http('GET', server.port, `/${earlyComboUrl}`, { cookie })
    expect(oldComboResp.status).toBe(200)
    expect(oldComboResp.body).toContain('old')
  })
})

// ── 7. 产物自述的失败方向（纯文件系统） ────────────────────────────────────────
describe('产物自述的失败方向（纯文件系统）', () => {
  const bundle = (platforms: string[]): string => JSON.stringify({ apiVersion: '2.0.0', file: 'client.js', platforms })
  let ids: string[] = []
  let problems = ''

  beforeAll(() => {
    const dir = makeTree('manifest-guard', {
      'manifest.json': JSON.stringify({ version: 1, apiVersion: '2.0.0' }),
      'ok/bundle.json': bundle(['web']),
      'ok/client.js': 'ok',
      'tui-only/bundle.json': bundle(['tui']),
      'tui-only/client.js': 'tui',
      'both/bundle.json': bundle(['web', 'tui']),
      'both/client.js': 'both',
      'future/bundle.json': bundle(['electron']),
      'future/client.js': 'future',
      'bad-ext/bundle.json': JSON.stringify({ apiVersion: '2.0.0', file: 'client.js', platforms: ['web'], external: 'react' }),
      'bad-ext/client.js': 'ext',
      'bad-inject/bundle.json': JSON.stringify({ apiVersion: '2.0.0', file: 'client.js', platforms: ['web'], inject: ['a', 5] }),
      'bad-inject/client.js': 'inject',
      'badfile/bundle.json': JSON.stringify({ apiVersion: '2.0.0', file: '../up.js', platforms: ['web'] }),
      'badfile/client.js': 'badfile',
      'bad-json/bundle.json': '{oops',
      'bad-json/client.js': 'bad-json',
      // 旧产物：有 client.js、没有自述——要说话（否则升级宿主后它静默消失）
      'old-build/client.js': 'old',
    })
    const collected = collectUiPluginArtifacts(dir, 'web')
    ids = collected.entries.map((entry) => entry.id)
    problems = collected.problems.join(' | ')
  })

  test('认得的 web 插件进清单', () => {
    expect(ids.includes('ok') && ids.length === 4, ids.join(',')).toBe(true)
  })
  test('未知 platform 被丢弃（失败关闭）且写进 problems', () => {
    expect(ids.includes('future'), ids.join(',')).toBe(false)
    expect(problems.includes('future') && problems.includes('platforms'), problems).toBe(true)
  })
  test('tui 是认得的取值：被 web 过滤掉且不算问题', () => {
    expect(!ids.includes('tui-only') && !problems.includes('tui-only'), problems).toBe(true)
  })
  test('一份产物声明两个载体：web 视图里只有它一条', () => {
    expect(ids.filter((id) => id === 'both').length, ids.join(',')).toBe(1)
  })
  test('字段不是数组记进 problems', () => {
    expect(problems.includes('bad-ext') && problems.includes('external'), problems).toBe(true)
  })
  test('数组里混非字符串记进 problems 且保留合法项', () => {
    const collected = collectUiPluginArtifacts(join(WORK, 'manifest-guard'), 'web')
    expect(problems.includes('bad-inject') && problems.includes('inject'), problems).toBe(true)
    expect(collected.entries.find((entry) => entry.id === 'bad-inject')?.inject?.join(',')).toBe('a')
  })
  test('非法文件名记进 problems', () => {
    expect(problems.includes('badfile'), problems).toBe(true)
  })
  test('坏掉的 JSON 记进 problems 并跳过这一份', () => {
    expect(problems.includes('bad-json') && !ids.includes('bad-json'), problems).toBe(true)
  })
  test('旧产物（有 client.js 没自述）被点名，不静默少一个', () => {
    expect(problems.includes('old-build') && problems.includes('bundle.json'), problems).toBe(true)
  })
})
