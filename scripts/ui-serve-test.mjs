/**
 * 本机界面服务（宿主半边）的回归测试：信任闸、换票与 Cookie、界面通道的方法白名单与实参校验、
 * 插件 bundle 的代际与缓存。
 *
 * 钉住的五件事（每一条都是"用户能看见的坏"或"安全边界"）：
 *
 *   1. **调用面**（`lib/core/ui-methods.js` + `lib/plugins/webserver.js`）：凭据类 / 破坏性 /
 *      任意命令执行 / 策略写入这几类方法，经真装配的服务调不动，而且**一次都没被执行到**；
 *      实参的个数、类型、长度、枚举都要在入口被拦。
 *   2. **信任闸**（`lib/core/ui-trust.js` + `lib/core/ui-server.js`）：Host 不对 403、
 *      `sec-fetch-site: cross-site` 403、Origin 不是本服务 403、什么都不带的正常请求 200。
 *   3. **换票**：303 + `cache-control: no-store` + `referrer-policy: no-referrer` +
 *      带 Max-Age 的 HttpOnly Cookie；令牌只能用一次；宿主重启后同一个 authority 的旧 Cookie
 *      仍然有效（签名密钥落盘）。
 *   4. **bundle 代际**（`lib/core/ui-route.js` + `lib/core/ui-bundles.js`）：缺 rev 404、
 *      上一代 rev 拿旧字节、未知 rev 404、HEAD 复用 GET 的头且无体、非 GET/HEAD 405、
 *      多段 id（`@scope/name`）能伺服、路径穿越仍被拒。
 *   5. **清单失败方向**（`lib/core/ui-bundles.js`）：不认识的 `platform` 丢弃并记 problems、
 *      字段写坏记 problems、产物表按清单指纹缓存（第二次请求不再逐文件 stat）。
 *
 * 全部跑在临时 HOME / DSC_HOME 上，真实 `~/.dsc` 一个字节都不写；跑完清理。
 *
 * 用法：npx tsc -p tsconfig.json && node scripts/ui-serve-test.mjs
 *
 * @module dsc/scripts/ui-serve-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 隔离 HOME / DSC_HOME：签名密钥要落盘、插件配置会被读，不隔离就污染使用者真实的那份。
const home = mkdtempSync(join(tmpdir(), 'dsc-ui-serve-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
delete process.env.DSC_UI_SERVER
delete process.env.DSC_UI_ASSETS
delete process.env.DSC_UI_PORT

const { createUiServer, UI_COOKIE, UI_COOKIE_MAX_AGE_MS, UI_SECRET_FILE } = await import('../lib/core/ui-server.js')
const { UI_METHODS, UI_ARG_SPECS, isUiMethod, validateUiArgs } = await import('../lib/core/ui-methods.js')
const { collectUiPluginArtifacts, uiArtifactCacheCounters, resetUiArtifactCacheCounters } = await import(
  '../lib/core/ui-bundles.js'
)
const { resolveUiBundleRequest } = await import('../lib/core/ui-route.js')
const { checkUiRequestTrust, timingSafeEqualText, verifyUiCookie } = await import('../lib/core/ui-trust.js')
const { webserverPlugin } = await import('../lib/plugins/webserver.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'dsc-ui-serve-'))

/** 造一个临时目录树；`files` 是相对路径 → 内容。 */
function makeTree(name, files) {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }
  return dir
}

/** 发一个 HTTP 请求（用 node:http，好自定义 Host / Origin / sec-fetch-site 与请求体）。 */
function http(method, port, path, headers = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    // agent: false = 每个请求自己一条连接：不往全局连接池里留 keep-alive 套接字。
    // 后面要 close 服务再在同一个端口上重启，池子里的旧套接字被服务端掐掉时会冒 ECONNRESET。
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
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

/** POST 一个 invoke 请求。 */
function invoke(port, cookie, method, args) {
  const payload = JSON.stringify(args === undefined ? { method } : { method, args })
  return http('POST', port, '/api/invoke', { cookie, 'content-type': 'application/json' }, payload)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 1. 界面通道的方法白名单与实参校验（纯函数） ─────────────────────────────────
console.log('\n[1] 方法白名单与实参校验')
{
  const excluded = ['setProviderKey', 'saveProvider', 'removeProvider', 'runCommand', 'purgeSessions', 'setPolicy', 'installMarketSkill', 'setMarketSources']
  check('凭据 / 破坏性 / 命令执行 / 策略这几类都不在白名单', excluded.every((name) => !isUiMethod(name)), excluded.filter(isUiMethod).join(','))
  // `dock` 从 2026-10-10（阶段 5.2）起在放行面，但**只放读 + 写两档**：终端那三档
  // （term-spawn / term-input / term-kill）只走桌面窗口的原生桥，不进这条 HTTP 面。
  check('dock 在放行面（读 + 写两档）', isUiMethod('dock'))
  const dockOpShape = UI_ARG_SPECS['dock'][0].shape
  const dockOps = dockOpShape.kind === 'enum' ? [...dockOpShape.values] : []
  check('dock 放行的 op 里一个 term-* 都没有', dockOps.length > 0 && dockOps.every((op) => !op.startsWith('term-')), dockOps.join(','))
  check('HTTP 面里传 term-spawn 被实参校验拒', !validateUiArgs('dock', ['term-spawn', { cwd: '.' }]).ok)
  const allowed = ['submit', 'interrupt', 'openSession', 'answerApproval', 'answerQuestion', 'answerPlan', 'setModel', 'refreshSessions', 'listModels', 'setUiPrefs', 'getUiPrefs', 'listPlugins', 'setPluginEnabled', 'listTools', 'listSkills', 'getSettingsSections', 'getSectionValues', 'setSettingValue', 'runSettingAction', 'getModelConfig', 'goalAction', 'clearTodos', 'listPresets', 'usePreset', 'editQueued', 'removeQueued', 'steerQueued', 'compact', 'setEffort', 'setMode', 'dock']
  check('界面真正要用的方法都放行', allowed.every((name) => isUiMethod(name)), allowed.filter((name) => !isUiMethod(name)).join(','))
  check('每个放行的方法都有实参规格', UI_METHODS.every((name) => UI_ARG_SPECS[name] !== undefined) && Object.keys(UI_ARG_SPECS).length === UI_METHODS.length, `${String(Object.keys(UI_ARG_SPECS).length)} vs ${String(UI_METHODS.length)}`)

  const tooMany = validateUiArgs('listModels', [1])
  check('参数个数超限被拒', !tooMany.ok, JSON.stringify(tooMany))
  const missingRequired = validateUiArgs('removeQueued', [])
  check('必传实参缺失被拒（不能把 undefined 铺给宿主）', !missingRequired.ok, JSON.stringify(missingRequired))
  const wrongType = validateUiArgs('removeQueued', ['第 0 条'])
  check('类型不对被拒（该数字给了字符串）', !wrongType.ok, JSON.stringify(wrongType))
  const wrongBool = validateUiArgs('setSessionPinned', ['/a.jsonl', 'yes'])
  check('布尔位给了字符串被拒', !wrongBool.ok, JSON.stringify(wrongBool))
  const tooLong = validateUiArgs('setModel', ['m'.repeat(500)])
  check('超长字符串被拒', !tooLong.ok, JSON.stringify(tooLong))
  const badEnum = validateUiArgs('setEffort', ['turbo'])
  check('枚举取值不对被拒', !badEnum.ok, JSON.stringify(badEnum))
  check('枚举取值对时放行', validateUiArgs('setEffort', ['high']).ok)
  const badItem = validateUiArgs('archiveSessions', [['/a.jsonl', 7]])
  check('字符串数组里混了非字符串被拒', !badItem.ok, JSON.stringify(badItem))
  const bigJson = validateUiArgs('savePreset', [{ blob: 'x'.repeat(40000) }])
  check('超长 JSON 实参被拒', !bigJson.ok, JSON.stringify(bigJson))
  const nullOptional = validateUiArgs('interrupt', [null])
  check('可选参数写 null = 不传（尾部空值去掉）', nullOptional.ok && nullOptional.args.length === 0, JSON.stringify(nullOptional))
  const gap = validateUiArgs('answerPlan', [null, '意见'])
  check('中间空一个要拒（省略只能从尾部开始）', !gap.ok, JSON.stringify(gap))
  const okCall = validateUiArgs('editQueued', [0, '改一下'])
  check('正常调用通过且实参原样', okCall.ok && JSON.stringify(okCall.args) === '[0,"改一下"]', JSON.stringify(okCall))
  check('定长时间比较：等长不等值给假、等值给真', timingSafeEqualText('abc', 'abd') === false && timingSafeEqualText('abc', 'abc') === true)
  const trustBadHost = checkUiRequestTrust({ host: 'evil.example:1234' }, 1234)
  check('信任闸：Host 不是本机地址给 403', trustBadHost !== null && trustBadHost.status === 403, JSON.stringify(trustBadHost))
}

// ── 2. 界面通道真装配（webserver 插件 + 假宿主） ───────────────────────────────
console.log('\n[2] 界面通道（真装配）')
{
  const assets = makeTree('wired-assets', { 'index.html': '<!doctype html><html><body>壳</body></html>' })
  const calls = []
  const fakeRuntime = {
    submit: (text, images) => {
      calls.push({ method: 'submit', args: [text, images] })
    },
    listModels: () => [{ id: 'fake-model' }],
    setProviderKey: (name, key) => {
      calls.push({ method: 'setProviderKey', args: [name, key] })
      return '写进去了'
    },
    runCommand: (input) => {
      calls.push({ method: 'runCommand', args: [input] })
      return true
    },
    purgeSessions: (paths) => {
      calls.push({ method: 'purgeSessions', args: [paths] })
      return { ok: true }
    },
    setPolicy: (policy) => {
      calls.push({ method: 'setPolicy', args: [policy] })
    },
    getSnapshot: () => ({ status: { sessionId: 's-1', model: 'fake-model' }, entries: [], queued: [] }),
    subscribe: () => () => {},
  }
  const provided = {}
  const effects = []
  const ctx = {
    ui: fakeRuntime,
    provide: (name, service) => {
      provided[name] = service
    },
    effect: (fn) => {
      effects.push(fn)
    },
    logger: { warn: () => {} },
  }
  webserverPlugin.apply(ctx, { enabled: true, port: 0, assetsDir: assets })
  const service = provided['webServer']
  check('插件装配后 provide 了 webServer 服务', service !== undefined && typeof service.ensure === 'function')

  // 启动那一刻的日志要抓下来：既验"打印了入口地址"，也验"签名密钥绝不进日志"。
  let captured = ''
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk) => {
    captured += String(chunk)
    return true
  }
  process.stderr.write = (chunk) => {
    captured += String(chunk)
    return true
  }
  let running = null
  try {
    running = await service.ensure()
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }
  const secretFile = join(process.env.DSC_HOME, UI_SECRET_FILE)
  const secretText = existsSync(secretFile) ? readFileSync(secretFile, 'utf8').trim() : ''
  check('启动打印了带一次性令牌的入口地址', captured.includes('/?token='), captured.slice(0, 120))
  check('签名密钥落盘在 DSC_HOME 下且形状正确', /^[A-Za-z0-9_-]{43}$/.test(secretText))
  check('签名密钥没有出现在启动日志里', secretText !== '' && !captured.includes(secretText))

  const wiredPort = running.port
  const wiredToken = new URL(running.url).searchParams.get('token') ?? ''
  const exchange = await http('GET', wiredPort, `/?token=${wiredToken}`)
  const wiredCookie = String(exchange.headers['set-cookie']?.[0] ?? '').split(';')[0]
  check('换票拿到 Cookie', wiredCookie.startsWith(`${UI_COOKIE}=`), wiredCookie)

  const denied = {}
  for (const name of ['setProviderKey', 'runCommand', 'purgeSessions', 'setPolicy']) {
    denied[name] = await invoke(wiredPort, wiredCookie, name, ['x'])
  }
  check('setProviderKey 经 /api/invoke 被拒', denied['setProviderKey'].status === 403, `${String(denied['setProviderKey'].status)} ${denied['setProviderKey'].body}`)
  check('runCommand 被拒', denied['runCommand'].status === 403, String(denied['runCommand'].status))
  check('purgeSessions 被拒', denied['purgeSessions'].status === 403, String(denied['purgeSessions'].status))
  check('setPolicy 被拒', denied['setPolicy'].status === 403, String(denied['setPolicy'].status))
  check('被排除的方法一次都没被执行到', calls.length === 0, JSON.stringify(calls))

  const badArg = await invoke(wiredPort, wiredCookie, 'submit')
  check('实参缺失回 ok:false 而不是执行', badArg.status === 200 && badArg.body.includes('"ok":false'), badArg.body)
  const tooLongArg = await invoke(wiredPort, wiredCookie, 'submit', ['x'.repeat(40000)])
  check('超长实参被拒', tooLongArg.status === 200 && tooLongArg.body.includes('太长'), tooLongArg.body)
  const manyArgs = await invoke(wiredPort, wiredCookie, 'listModels', [1, 2])
  check('参数个数超限被拒', manyArgs.status === 200 && manyArgs.body.includes('最多收 0 个实参'), manyArgs.body)
  const goodCall = await invoke(wiredPort, wiredCookie, 'submit', ['你好'])
  check('放行的方法正常执行', goodCall.status === 200 && goodCall.body.includes('"ok":true'), goodCall.body)
  check('实参真的送到了宿主', calls.length === 1 && calls[0].method === 'submit' && calls[0].args[0] === '你好', JSON.stringify(calls))

  const getInvoke = await http('GET', wiredPort, '/api/invoke', { cookie: wiredCookie })
  check('调用端点非 POST 回 405', getInvoke.status === 405, String(getInvoke.status))
  const bootGet = await http('GET', wiredPort, '/api/boot', { cookie: wiredCookie })
  const bootHead = await http('HEAD', wiredPort, '/api/boot', { cookie: wiredCookie })
  check('HEAD /api/boot 与 GET 同头且无体', bootHead.status === 200
    && bootHead.headers['content-type'] === bootGet.headers['content-type']
    && bootHead.headers['content-length'] === bootGet.headers['content-length']
    && bootHead.body === '', `${JSON.stringify(bootHead.headers)} ${JSON.stringify(bootHead.body)}`)

  // 握手报给客户端的清单也只能是子集。
  const sse = { text: '' }
  const sseReq = request({ host: '127.0.0.1', port: wiredPort, method: 'GET', path: '/api/events', headers: { cookie: wiredCookie }, agent: false }, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      sse.text += chunk
    })
    res.on('error', () => {})
  })
  // 这条连接会被我们主动掐掉，挂一个空 error 处理器：破坏连接冒出来的 ECONNRESET 不该掀翻测试。
  sseReq.on('error', () => {})
  sseReq.end()
  await sleep(150)
  check('握手清单里有放行的方法', sse.text.includes('"submit"') && sse.text.includes('"listModels"'), sse.text.slice(0, 200))
  check('握手清单里没有被排除的方法', !sse.text.includes('setProviderKey') && !sse.text.includes('runCommand') && !sse.text.includes('purgeSessions'), sse.text.slice(0, 200))
  sseReq.destroy()

  for (const dispose of effects) {
    const stop = dispose()
    if (typeof stop === 'function') stop()
  }
  await sleep(50)
}

// ── 3. 信任闸 / 换票 / bundle（真起服务，临时产物目录） ────────────────────────
console.log('\n[3] 信任闸与换票')
const assetsDir = makeTree('serve-assets', {
  'index.html': '<!doctype html><html><head><title>壳</title></head><body><div id="root"></div></body></html>',
})
const pluginsDir = makeTree('serve-plugins', {
  'manifest.json': JSON.stringify({
    version: 1,
    plugins: [
      { id: 'demo', file: 'client.js', platform: 'web' },
      { id: '@scope/name', file: 'client.js', platform: 'web' },
    ],
  }),
  'demo/client.js': 'module.exports={apply(){return "old"}}',
  '@scope/name/client.js': 'module.exports={apply(){return "scoped"}}',
})
const server = await createUiServer({ host: { name: 'Pneuma', version: 'test' }, assetsDir, pluginsDir, log: () => {} })
const port = server.port
const token = new URL(server.url).searchParams.get('token') ?? ''
let cookie = ''
{
  const anonymous = await http('GET', port, '/')
  check('没凭据访问 401', anonymous.status === 401, String(anonymous.status))

  const handshake = await http('GET', port, `/?token=${token}`)
  check('带令牌换票是 303', handshake.status === 303, String(handshake.status))
  check('换票响应 no-store', String(handshake.headers['cache-control'] ?? '') === 'no-store', String(handshake.headers['cache-control']))
  check('换票响应 no-referrer', String(handshake.headers['referrer-policy'] ?? '') === 'no-referrer', String(handshake.headers['referrer-policy']))
  const setCookie = String(handshake.headers['set-cookie']?.[0] ?? '')
  check('Cookie 带 Max-Age（30 天）', setCookie.includes(`Max-Age=${String(Math.floor(UI_COOKIE_MAX_AGE_MS / 1000))}`), setCookie)
  check('Cookie 带 HttpOnly / SameSite=Strict / Path=/', setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict') && setCookie.includes('Path=/'), setCookie)
  check('Cookie 值是签名过的三段，不是明文会话号', setCookie.split(';')[0].split('=')[1].split('.').length === 3, setCookie.split(';')[0])
  cookie = setCookie.split(';')[0]

  const reuse = await http('GET', port, `/?token=${token}`)
  check('令牌不能二次使用', reuse.status === 403, String(reuse.status))

  const crossSite = await http('GET', port, '/', { cookie, 'sec-fetch-site': 'cross-site' })
  check('sec-fetch-site: cross-site → 403', crossSite.status === 403, String(crossSite.status))
  const sameOrigin = await http('GET', port, '/', { cookie, 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${String(port)}` })
  check('same-origin + 本服务 Origin → 200', sameOrigin.status === 200, String(sameOrigin.status))
  const badOrigin = await http('GET', port, '/', { cookie, origin: 'http://evil.example' })
  check('Origin 不是本服务 → 403', badOrigin.status === 403, String(badOrigin.status))
  const opaqueOrigin = await http('GET', port, '/', { cookie, origin: 'null' })
  check('Origin: null（不透明来源）→ 403', opaqueOrigin.status === 403, String(opaqueOrigin.status))
  const plain = await http('GET', port, '/', { cookie })
  check('什么都不带的正常请求 → 200', plain.status === 200, String(plain.status))
  const badHost = await http('GET', port, '/', { cookie, host: `evil.example:${String(port)}` })
  check('Host 不是本机地址 → 403', badHost.status === 403, String(badHost.status))

  const tampered = await http('GET', port, '/', { cookie: `${cookie}x` })
  check('Cookie 动一个字节就 401', tampered.status === 401, String(tampered.status))
  check('没 Cookie 时校验直接给假', verifyUiCookie(Buffer.alloc(32, 7), `127.0.0.1:${String(port)}`, null, Date.now()) === false)

  // ── 4. bundle：代际、方法、多段 id、路径穿越 ─────────────────────────────────
  console.log('\n[4] bundle 代际与方法')
  const boot = JSON.parse((await http('GET', port, '/api/boot', { cookie })).body)
  const demoUrl = boot.entries.find((entry) => entry.id === 'demo').url
  const scopedUrl = boot.entries.find((entry) => entry.id === '@scope/name').url
  const oldRev = /rev=([0-9a-f]{12})/.exec(demoUrl)[1]

  const missRev = await http('GET', port, '/plugins/demo/client.js', { cookie })
  check('缺 rev 一律 404（不混进不可变缓存）', missRev.status === 404, String(missRev.status))
  check('解析层同样拒缺 rev', resolveUiBundleRequest('/plugins/demo/client.js', null, pluginsDir).status === 404)

  const first = await http('GET', port, `/${demoUrl}`, { cookie })
  check('当下这一代 200 且给一年不可变缓存', first.status === 200 && String(first.headers['cache-control'] ?? '').includes('immutable'), `${String(first.status)} ${String(first.headers['cache-control'])}`)

  const headBundle = await http('HEAD', port, `/${demoUrl}`, { cookie })
  check('HEAD 与 GET 同状态、同头', headBundle.status === 200
    && headBundle.headers['content-type'] === first.headers['content-type']
    && headBundle.headers['content-length'] === first.headers['content-length']
    && headBundle.headers['cache-control'] === first.headers['cache-control'], JSON.stringify(headBundle.headers))
  check('HEAD 没有体', headBundle.body === '', JSON.stringify(headBundle.body.slice(0, 40)))

  const postBundle = await http('POST', port, `/${demoUrl}`, { cookie })
  check('bundle 上非 GET/HEAD 回 405', postBundle.status === 405, String(postBundle.status))
  check('405 带 Allow', String(postBundle.headers['allow'] ?? '').includes('GET'), String(postBundle.headers['allow']))
  check('静态资源上非 GET/HEAD 回 405', (await http('DELETE', port, '/', { cookie })).status === 405)

  const scoped = await http('GET', port, `/${scopedUrl}`, { cookie })
  check('多段 id（@scope/name）能伺服', scoped.status === 200 && scoped.body.includes('scoped'), `${String(scoped.status)} ${scoped.body.slice(0, 40)}`)
  check('路径穿越（编码的 ../）仍被拒', (await http('GET', port, '/plugins/demo/..%2F..%2Fmanifest.json', { cookie })).status === 404)
  check('绝对路径形状的 id 被拒', (await http('GET', port, '/plugins//etc/passwd/client.js', { cookie })).status === 404)
  check('多段 id 之下的编码穿越被拒', (await http('GET', port, '/plugins/@scope/%2E%2E%2F%2E%2E%2Fsecret/client.js', { cookie })).status === 404)
  check('不存在的插件 404', (await http('GET', port, `/plugins/nope/client.js?rev=${'0'.repeat(12)}`, { cookie })).status === 404)

  // 重建：换掉 demo 的字节与清单本身（mtime/size 变 = 产物表换代）
  writeFileSync(join(pluginsDir, 'demo', 'client.js'), 'module.exports={apply(){return "brand new"}}')
  writeFileSync(
    join(pluginsDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      note: 'v2',
      plugins: [
        { id: 'demo', file: 'client.js', platform: 'web' },
        { id: '@scope/name', file: 'client.js', platform: 'web' },
      ],
    }),
  )
  const stale = await http('GET', port, `/plugins/demo/client.js?rev=${oldRev}`, { cookie })
  check('重建后旧 rev 仍拿到旧字节（已打开的页面不用手动刷新）', stale.status === 200 && stale.body.includes('old'), `${String(stale.status)} ${stale.body.slice(0, 60)}`)
  check('旧 rev 拿到的确实是旧内容（不是新字节）', !stale.body.includes('brand new'), stale.body.slice(0, 60))
  const boot2 = JSON.parse((await http('GET', port, '/api/boot', { cookie })).body)
  const newRev = /rev=([0-9a-f]{12})/.exec(boot2.entries.find((entry) => entry.id === 'demo').url)[1]
  check('重建后 rev 变了', newRev !== oldRev, `${oldRev} → ${newRev}`)
  const freshBundle = await http('GET', port, `/plugins/demo/client.js?rev=${newRev}`, { cookie })
  check('新 rev 拿到新字节', freshBundle.status === 200 && freshBundle.body.includes('brand new'), freshBundle.body.slice(0, 60))
  check('从没出现过的 rev 404', (await http('GET', port, `/plugins/demo/client.js?rev=${'f'.repeat(12)}`, { cookie })).status === 404)

  // ── 5. 产物表缓存 ─────────────────────────────────────────────────────────
  console.log('\n[5] 产物表缓存')
  const bundlePath = `/plugins/demo/client.js?rev=${newRev}`
  resetUiArtifactCacheCounters()
  const warm = await http('GET', port, bundlePath, { cookie })
  const afterFirst = uiArtifactCacheCounters()
  const again = await http('GET', port, bundlePath, { cookie })
  const afterSecond = uiArtifactCacheCounters()
  check('两次请求内容一致', warm.status === 200 && again.body === warm.body, `${String(warm.status)} ${String(again.status)}`)
  check('第一次请求之后不再逐文件 stat', afterFirst.fileStats === 0, JSON.stringify(afterFirst))
  check('第二次请求只多一次清单 stat，不重算产物表', afterSecond.manifestStats === afterFirst.manifestStats + 1
    && afterSecond.fileStats === afterFirst.fileStats
    && afterSecond.tableBuilds === afterFirst.tableBuilds, `${JSON.stringify(afterFirst)} → ${JSON.stringify(afterSecond)}`)
}

// ── 6. 宿主重启：旧 Cookie 仍然有效（签名密钥落盘） ───────────────────────────
console.log('\n[6] 宿主重启后的 Cookie')
{
  check('重启前拿到的 Cookie 能用', (await http('GET', port, '/', { cookie })).status === 200)
  await server.close()
  const restarted = await createUiServer({ host: { name: 'Pneuma', version: 'test' }, assetsDir, pluginsDir, port, log: () => {} })
  const afterRestart = await http('GET', restarted.port, '/', { cookie })
  check('宿主重启后同一个 authority 的旧 Cookie 仍然有效', afterRestart.status === 200, String(afterRestart.status))
  const newToken = new URL(restarted.url).searchParams.get('token') ?? ''
  const freshCookie = String((await http('GET', restarted.port, `/?token=${newToken}`)).headers['set-cookie']?.[0] ?? '').split(';')[0]
  check('重启后换的新 Cookie 也能用', (await http('GET', restarted.port, '/', { cookie: freshCookie })).status === 200)
  await restarted.close()
}

// ── 7. 清单的失败方向（纯文件系统） ───────────────────────────────────────────
console.log('\n[7] 清单失败方向')
{
  const dir = makeTree('manifest-guard', {
    'manifest.json': JSON.stringify({
      version: 1,
      plugins: [
        { id: 'ok', file: 'client.js', platform: 'web' },
        { id: 'tui-only', file: 'client.js', platform: 'tui' },
        { id: 'future', file: 'client.js', platform: 'electron' },
        { id: 'bad-ext', file: 'client.js', platform: 'web', external: 'react' },
        { id: 'bad-inject', file: 'client.js', platform: 'web', inject: ['a', 5] },
        { id: '../evil', file: 'client.js', platform: 'web' },
        { id: 'badfile', file: '../up.js', platform: 'web' },
        'nope',
      ],
    }),
    'ok/client.js': 'ok',
    'tui-only/client.js': 'tui',
    'bad-ext/client.js': 'ext',
    'bad-inject/client.js': 'inject',
  })
  const collected = collectUiPluginArtifacts(dir, 'web')
  const ids = collected.entries.map((entry) => entry.id)
  const problems = collected.problems.join(' | ')
  check('认得的 web 插件进清单', ids.includes('ok') && ids.length === 3, ids.join(','))
  check('未知 platform 被丢弃（失败关闭）', !ids.includes('future'), ids.join(','))
  check('未知 platform 写进 problems', problems.includes('future') && problems.includes('platform'), problems)
  check('tui 是认得的取值：被 web 过滤掉且不算问题', !ids.includes('tui-only') && !problems.includes('tui-only'), problems)
  check('字段不是数组记进 problems', problems.includes('bad-ext') && problems.includes('external'), problems)
  check('数组里混非字符串记进 problems 且保留合法项', problems.includes('bad-inject') && problems.includes('inject')
    && collected.entries.find((entry) => entry.id === 'bad-inject')?.inject?.join(',') === 'a', problems)
  check('非法 id 记进 problems', problems.includes('evil'), problems)
  check('非法文件名记进 problems', problems.includes('badfile'), problems)
  check('非对象的行记进 problems', problems.includes('第 8 条'), problems)
}

rmSync(work, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
