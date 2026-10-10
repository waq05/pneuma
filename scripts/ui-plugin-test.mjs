/**
 * 插件版界面的地基测试：槽位注册表、启动清单、bundle 发现与本机界面服务。
 *
 * 这一层是 C-真 路线的第一块拼图（宿主下发 bundle、界面壳按槽位拼装），
 * 出问题的形状都很像「界面上一块东西莫名不见了」，所以断言要钉在四个地方：
 *
 *   1. 槽位核心（`lib/ui/slots.js`）：声明/注册/排序/取赢家/引用稳定性/退订/报错；
 *      引用稳定性单独测——它挂了的表现是界面无限重渲染，最难查；
 *   2. 启动清单（`lib/ui/manifest.js`）：拓扑排序、成环报错、地址形状、版本指纹；
 *   3. bundle 发现（`lib/core/ui-bundles.js`）：清单读写、缺文件要报出来、路径逃逸要挡住；
 *   4. 界面服务（`lib/core/ui-server.js`）：**真起一个服务**跑一遍
 *      没凭据 401 → 带令牌换 Cookie 302 → 取启动图 → 取 bundle（版本对得上/对不上）
 *      → Host 头不对 403 → 令牌不能二次使用。
 *
 * 最后还会验一遍**真实构建产物**（`lib/ui/`）：界面壳没构建时打一行 SKIP，
 * 构建过就断言清单可读、bundle 里确实 require 了壳提供的模块。
 *
 * 全部跑在临时目录上，真实 ~/.dsc 与 lib/ui 一个字节都不写。
 *
 * 用法：pnpm run build && pnpm -C ui-shell build && node scripts/ui-plugin-test.mjs
 *
 * @module dsc/scripts/ui-plugin-test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 隔离 HOME / DSC_HOME：这个探针会读插件的条目树（`~/.dsc/plugins.json`）来验配置解析，
// 不隔离就会读到使用者真实的那份，断言随环境飘。
const home = mkdtempSync(join(tmpdir(), 'dsc-ui-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
delete process.env.DSC_UI_SERVER
delete process.env.DSC_UI_ASSETS
delete process.env.DSC_UI_PORT

const { SlotRegistry, UndeclaredSlotError, DuplicateSlotIdError } = await import('../lib/ui/slots.js')
const { artifactRev, composeUiBootGraph, orderUiPlugins, pluginBundleUrl, shortHash } = await import('../lib/ui/manifest.js')
const { collectUiPluginArtifacts, readUiPluginBundle, readUiPluginManifest, uiPluginsDir } = await import(
  '../lib/core/ui-bundles.js'
)
const { inside } = await import('../lib/core/web-static.js')
const { readUiServerConfig } = await import('../lib/plugins/webserver.js')
const { isUiBundleRequest, resolveUiBundleRequest } = await import('../lib/core/ui-route.js')
const { createUiServer } = await import('../lib/core/ui-server.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'dsc-ui-'))

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

/** 发一个 HTTP 请求（用 node:http，好自定义 Host 头与 Cookie）。 */
function http(method, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// ── 1. 槽位核心 ────────────────────────────────────────────────────────────────
console.log('\n[1] 槽位核心')
{
  const slots = new SlotRegistry()
  const offMain = slots.declare('shell.main', 'list')
  check('声明后槽名可见', slots.slots.join(',') === 'shell.main', slots.slots.join(','))
  check('未声明时取登记为空', slots.entriesOf('shell.main').length === 0)
  check('未声明时取赢家为空', slots.winners('shell.main').length === 0)

  let throws = null
  try {
    slots.register('shell.nope', { id: 'x' }, {})
  } catch (error) {
    throws = error
  }
  check('注册到未声明的槽当场报错', throws instanceof UndeclaredSlotError, String(throws))
  check('报错消息里带上已知槽名', throws !== null && String(throws.message).includes('shell.main'))

  const before = slots.getVersion()
  const offLate = slots.register('shell.main', { id: 'late', order: 20 }, 'late')
  slots.register('shell.main', { id: 'early', order: 5 }, 'early')
  slots.register('shell.main', { id: 'mid-a', order: 10 }, 'mid-a')
  slots.register('shell.main', { id: 'mid-b', order: 10 }, 'mid-b')
  check('版本号随登记单调递增', slots.getVersion() > before)
  check(
    'list 槽按 order 排序、持平时按注册先后',
    slots.entriesOf('shell.main').map((entry) => entry.id).join(',') === 'early,mid-a,mid-b,late',
    slots.entriesOf('shell.main').map((entry) => entry.id).join(','),
  )
  check('注册总数正确', slots.size === 4, String(slots.size))

  const snapshotA = slots.winners('shell.main')
  const snapshotB = slots.winners('shell.main')
  check('winners 引用稳定（React 快照要求）', snapshotA === snapshotB)
  slots.register('shell.main', { id: 'later', order: 30 }, 'later')
  check('登记后快照换引用', slots.winners('shell.main') !== snapshotA)

  let duplicate = null
  try {
    slots.register('shell.main', { id: 'early' }, 'dup')
  } catch (error) {
    duplicate = error
  }
  check('同一个槽里 id 重复报错', duplicate instanceof DuplicateSlotIdError, String(duplicate))

  let declaredTwice = null
  try {
    slots.declare('shell.main', 'list')
  } catch (error) {
    declaredTwice = error
  }
  check('槽被声明两次报错', declaredTwice !== null)

  let notified = 0
  const offSub = slots.subscribe(() => {
    notified += 1
  })
  offLate()
  check('退订后登记消失', !slots.entriesOf('shell.main').some((entry) => entry.id === 'late'))
  check('退订触发了订阅者', notified === 1, String(notified))
  offSub()
  const afterUnsubscribe = notified
  slots.register('shell.main', { id: 'noisy', order: 40 }, 'noisy')
  check('退订后不再收到通知', notified === afterUnsubscribe, String(notified))
  offMain()
  check('撤回声明后槽名消失', !slots.slots.includes('shell.main'))

  const single = new SlotRegistry()
  single.declare('shell.notice', 'single')
  single.register('shell.notice', { id: 'a', order: 1 }, 'a')
  single.register('shell.notice', { id: 'b', order: 2 }, 'b')
  check('single 槽只画第一条', single.winners('shell.notice').map((entry) => entry.id).join(',') === 'a')

  const keyed = new SlotRegistry()
  keyed.declare('tool.call', 'keyed')
  keyed.register('tool.call', { id: 'read-impl', key: 'read', order: 1 }, 'read-1')
  keyed.register('tool.call', { id: 'read-other', key: 'read', order: 2 }, 'read-2')
  keyed.register('tool.call', { id: 'write-impl', key: 'write', order: 1 }, 'write')
  check(
    'keyed 槽每格只取第一条',
    keyed.winners('tool.call').map((entry) => entry.id).join(',') === 'read-impl,write-impl',
    keyed.winners('tool.call').map((entry) => entry.id).join(','),
  )
}

// ── 2. 启动清单 ────────────────────────────────────────────────────────────────
console.log('\n[2] 启动清单')
{
  check('地址形状正确', pluginBundleUrl('hello', 'abc') === 'plugins/hello/client.js?rev=abc', pluginBundleUrl('hello', 'abc'))
  check('id 会被编码', pluginBundleUrl('a b', 'abc') === 'plugins/a%20b/client.js?rev=abc')
  check('短哈希 12 位', shortHash('x').length === 12)
  check('短哈希稳定', shortHash('a', 'b') === shortHash('a', 'b'))
  check('短哈希随输入变化', shortHash('a', 'b') !== shortHash('ab', ''))
  const stat = { mtimeMs: 1000, ctimeMs: 2000, size: 30 }
  check('文件指纹稳定', artifactRev(stat) === artifactRev({ ...stat }))
  check('大小变了版本就变', artifactRev(stat) !== artifactRev({ ...stat, size: 31 }))

  const rows = [
    { id: 'c', rev: 'r3', inject: ['b'] },
    { id: 'a', rev: 'r1' },
    { id: 'b', rev: 'r2', inject: ['a'] },
  ]
  check(
    '拓扑排序：被依赖的在前',
    orderUiPlugins(rows).map((row) => row.id).join(',') === 'a,b,c',
    orderUiPlugins(rows).map((row) => row.id).join(','),
  )
  let cycle = null
  try {
    orderUiPlugins([
      { id: 'x', rev: 'r', inject: ['y'] },
      { id: 'y', rev: 'r', inject: ['x'] },
    ])
  } catch (error) {
    cycle = error
  }
  check('成环报错', cycle !== null)
  check('成环消息里列出环上成员', cycle !== null && String(cycle.message).includes('x -> y -> x'), cycle === null ? '' : String(cycle.message))

  let selfInject = null
  try {
    orderUiPlugins([{ id: 'x', rev: 'r', inject: ['x'] }])
  } catch (error) {
    selfInject = error
  }
  check('自己 inject 自己报错', selfInject !== null)

  const graph = composeUiBootGraph({ name: 'Muse Code', version: '9.9.9' }, rows)
  check('启动图带宿主身份', graph.host.name === 'Muse Code' && graph.host.version === '9.9.9')
  check('启动图条目按依赖排序', graph.entries.map((entry) => entry.id).join(',') === 'a,b,c')
  check('启动图条目带地址', graph.entries[0].url.startsWith('plugins/a/client.js?rev=r1'))
  check('启动图 rev 稳定', composeUiBootGraph({ name: 'x', version: 'y' }, rows).rev === graph.rev)
  check(
    '插件版本变了整图 rev 就变',
    composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r9' }]).rev
      !== composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r1' }]).rev,
  )
}

// ── 3. bundle 发现 ─────────────────────────────────────────────────────────────
console.log('\n[3] bundle 发现')
{
  const dir = makeTree('plugins', {
    'manifest.json': JSON.stringify({
      version: 1,
      plugins: [
        { id: 'demo', file: 'client.js', platform: 'web' },
        { id: 'tui-only', file: 'client.js', platform: 'tui' },
        { id: 'gone', file: 'client.js', platform: 'web' },
        { id: '../evil', file: 'client.js', platform: 'web' },
        { id: 'badfile', file: '../up.js', platform: 'web' },
      ],
    }),
    'demo/client.js': 'module.exports={apply(){}}',
  })
  const manifest = readUiPluginManifest(dir)
  check('清单里非法 id 被丢掉', !manifest.some((entry) => entry.id.includes('evil')), manifest.map((e) => e.id).join(','))
  check('文件名带路径分隔符的被丢掉', !manifest.some((entry) => entry.id === 'badfile'))
  check('清单保留合法项', manifest.some((entry) => entry.id === 'demo') && manifest.some((entry) => entry.id === 'gone'))

  const collected = collectUiPluginArtifacts(dir, 'web')
  check('只收 web 载体的插件', !collected.entries.some((entry) => entry.id === 'tui-only'))
  check('缺文件的进 problems 而不是静默', collected.problems.some((line) => line.includes('gone')), collected.problems.join(' | '))
  const demo = collected.entries.find((entry) => entry.id === 'demo')
  check('收到的条目带 12 位版本', demo !== undefined && demo.rev.length === 12, demo === undefined ? 'undefined' : demo.rev)

  check('路径守卫：目录内为真', inside(dir, join(dir, 'demo', 'client.js')))
  check('路径守卫：跳出去为假', !inside(dir, join(dir, '..', 'x')))
  check('取 bundle 命中', (readUiPluginBundle('demo', 'client.js', dir) ?? Buffer.alloc(0)).length > 0)
  check('取 bundle 挡住路径逃逸', readUiPluginBundle('../evil', 'client.js', dir) === null)
  check('取 bundle 挡住文件名逃逸', readUiPluginBundle('demo', '../up.js', dir) === null)
  check('清单文件坏了按空处理', readUiPluginManifest(makeTree('bad', { 'manifest.json': '{oops' })).length === 0)
  check('清单不存在按空处理', readUiPluginManifest(join(work, 'nope')).length === 0)

  // 路由解析（本机界面服务与远程控制共用这一份）
  check('路由前缀识别', isUiBundleRequest('/plugins/demo/client.js') && !isUiBundleRequest('/api/boot'))
  const hit = resolveUiBundleRequest('/plugins/demo/client.js', null, dir)
  check('路由解析命中 200', hit.status === 200 && (hit.body?.length ?? 0) > 0, String(hit.status))
  check('命中带不可变缓存', String(hit.headers?.['cache-control'] ?? '').includes('immutable'))
  check('不带 rev 时不校验版本', resolveUiBundleRequest('/plugins/demo/client.js', null, dir).status === 200)
  check(
    '给了错 rev 就 404',
    resolveUiBundleRequest('/plugins/demo/client.js', 'deadbeef', dir).status === 404,
  )
  check('目录外的 id 404', resolveUiBundleRequest('/plugins/%2E%2E/manifest.json', null, dir).status === 404)
  check('文件名带斜杠 404', resolveUiBundleRequest('/plugins/demo/a/b.js', null, dir).status === 404)
  check('未知插件 404', resolveUiBundleRequest('/plugins/nope/client.js', null, dir).status === 404)
}

// ── 4. 界面服务（真起一个） ─────────────────────────────────────────────────────
console.log('\n[4] 界面服务')
{
  const assetsDir = makeTree('assets', {
    'index.html': '<!doctype html><html><head><title>壳</title></head><body><div id="root"></div></body></html>',
    'app-x.js': 'console.log("shell")',
  })
  const pluginsDir = makeTree('serve-plugins', {
    'manifest.json': JSON.stringify({ version: 1, plugins: [{ id: 'demo', file: 'client.js', platform: 'web' }] }),
    'demo/client.js': 'module.exports={apply(){}}',
  })
  const server = await createUiServer({
    host: { name: 'Muse Code', version: 'test-1.2.3' },
    assetsDir,
    pluginsDir,
    log: () => {},
  })
  const port = server.port
  const token = new URL(server.url).searchParams.get('token') ?? ''

  const anonymous = await http('GET', port, '/')
  check('没凭据访问根路径 401', anonymous.status === 401, String(anonymous.status))
  const anonymousBoot = await http('GET', port, '/api/boot')
  check('没凭据取启动图 401', anonymousBoot.status === 401, String(anonymousBoot.status))
  const wrongToken = await http('GET', port, '/?token=nope')
  check('错令牌 403', wrongToken.status === 403, String(wrongToken.status))

  const handshake = await http('GET', port, `/?token=${token}`)
  check('带令牌换 Cookie 是 302', handshake.status === 302, String(handshake.status))
  const setCookie = String(handshake.headers['set-cookie']?.[0] ?? '')
  check('下发 HttpOnly 会话 Cookie', setCookie.startsWith('dsc_ui=') && setCookie.includes('HttpOnly'), setCookie)
  const cookie = setCookie.split(';')[0]

  const reuse = await http('GET', port, `/?token=${token}`)
  check('令牌不能二次使用', reuse.status === 403, String(reuse.status))
  const badHost = await http('GET', port, '/', { cookie, host: `evil.example:${String(port)}` })
  check('Host 头不是本机地址 403', badHost.status === 403, String(badHost.status))
  const badPort = await http('GET', port, '/', { cookie, host: '127.0.0.1:1' })
  check('Host 头端口对不上 403', badPort.status === 403, String(badPort.status))

  const page = await http('GET', port, '/', { cookie })
  check('带 Cookie 拿到页面 200', page.status === 200, String(page.status))
  check('页面注入了启动清单全局名', page.body.includes('__DSC_BOOT__'), page.body.slice(0, 120))
  check('注入的是宿主身份', page.body.includes('Muse Code') && page.body.includes('test-1.2.3'))

  const boot = await http('GET', port, '/api/boot', { cookie })
  check('取启动图 200', boot.status === 200, String(boot.status))
  let graph = null
  try {
    graph = JSON.parse(boot.body)
  } catch {
    graph = null
  }
  check('启动图是合法 JSON', graph !== null)
  check('启动图里有那个插件', graph !== null && graph.entries.some((entry) => entry.id === 'demo'))
  check('启动图条目带内容寻址地址', graph !== null && /^plugins\/demo\/client\.js\?rev=[0-9a-f]{12}$/.test(graph.entries[0].url), graph === null ? '' : String(graph.entries[0].url))

  const bundleUrl = graph.entries[0].url
  const bundle = await http('GET', port, `/${bundleUrl}`, { cookie })
  check('取 bundle 200', bundle.status === 200, String(bundle.status))
  check('bundle 是 JS 内容', bundle.body.includes('apply'), bundle.body.slice(0, 60))
  check('bundle 走一年不可变缓存', String(bundle.headers['cache-control'] ?? '').includes('immutable'), String(bundle.headers['cache-control']))
  const staleRev = await http('GET', port, `/plugins/demo/client.js?rev=${'0'.repeat(12)}`, { cookie })
  check('版本对不上 404', staleRev.status === 404, String(staleRev.status))
  const unknownPlugin = await http('GET', port, '/plugins/nope/client.js', { cookie })
  check('不存在的插件 404', unknownPlugin.status === 404, String(unknownPlugin.status))
  const traversal = await http('GET', port, '/plugins/demo/..%2F..%2Fmanifest.json', { cookie })
  check('插件路径逃逸拿不到东西', traversal.status === 404, String(traversal.status))
  const staticFile = await http('GET', port, '/app-x.js', { cookie })
  check('静态资源 200', staticFile.status === 200, String(staticFile.status))
  const missing = await http('GET', port, '/nope.js', { cookie })
  check('没有的文件 404', missing.status === 404, String(missing.status))

  await server.close()
  let refused = false
  try {
    await http('GET', port, '/')
  } catch {
    refused = true
  }
  check('close 之后连不上', refused)
}

// ── 4b. 服务配置（环境变量与插件条目树） ───────────────────────────────────────
console.log('\n[4b] 服务配置')
{
  const defaults = readUiServerConfig(undefined)
  check('默认不起服务', defaults.enabled === false)
  check('默认端口交给系统分配', defaults.port === 0, String(defaults.port))
  check('默认不指定产物目录（用 lib/ui/assets）', defaults.assetsDir === undefined)

  process.env.DSC_UI_SERVER = '1'
  check('DSC_UI_SERVER=1 就起来', readUiServerConfig(undefined).enabled === true)
  process.env.DSC_UI_PORT = '17399'
  check('DSC_UI_PORT 生效', readUiServerConfig(undefined).port === 17399, String(readUiServerConfig(undefined).port))
  process.env.DSC_UI_PORT = 'abc'
  check('端口写坏了回落到系统分配', readUiServerConfig(undefined).port === 0)
  process.env.DSC_UI_ASSETS = join(work, 'somewhere')
  check('DSC_UI_ASSETS 生效', readUiServerConfig(undefined).assetsDir === join(work, 'somewhere'))
  delete process.env.DSC_UI_SERVER
  delete process.env.DSC_UI_PORT
  delete process.env.DSC_UI_ASSETS

  // 条目树里的插件配置也要认（用户改 ~/.dsc/plugins.json 就能换目录与端口）
  const configDir = join(home, '.dsc')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'plugins.json'),
    JSON.stringify({
      version: 1,
      entries: [
        { file: 'webserver', disabled: false, config: { enabled: true, port: 17400, assetsDir: join(work, 'from-file') } },
      ],
    }),
  )
  const fromFile = readUiServerConfig(undefined)
  check('条目树里 enabled 生效', fromFile.enabled === true)
  check('条目树里 port 生效', fromFile.port === 17400, String(fromFile.port))
  check('条目树里 assetsDir 生效', fromFile.assetsDir === join(work, 'from-file'))
  process.env.DSC_UI_ASSETS = join(work, 'from-env')
  check('环境变量盖过条目树', readUiServerConfig(undefined).assetsDir === join(work, 'from-env'))
  delete process.env.DSC_UI_ASSETS

  // 换一份产物目录：服务要照它伺服（迁移期桌面窗口伺服的就是渲染层自己的产物）
  const customAssets = makeTree('custom-assets', {
    'index.html': '<!doctype html><html><body>桌面渲染层产物</body></html>',
  })
  const custom = await createUiServer({
    host: { name: 'Muse Code', version: 'test' },
    assetsDir: customAssets,
    pluginsDir: join(work, 'no-plugins'),
    log: () => {},
  })
  const token = new URL(custom.url).searchParams.get('token') ?? ''
  const handshake = await http('GET', custom.port, `/?token=${token}`)
  const cookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]
  const page = await http('GET', custom.port, '/', { cookie })
  check('自定义产物目录生效', page.status === 200 && page.body.includes('桌面渲染层产物'), page.body.slice(0, 80))
  check('没有插件目录也能起服务', custom.boot().entries.length === 0)
  await custom.close()
}

// ── 5. 真实构建产物 ───────────────────────────────────────────────────────────
console.log('\n[5] 真实构建产物')
{
  const manifestFile = join(uiPluginsDir(), 'manifest.json')
  if (!existsSync(manifestFile)) {
    console.log('  SKIP  界面壳未构建（lib/ui/plugins/manifest.json 不在）——先跑 pnpm -C ui-shell build')
  } else {
    const collected = collectUiPluginArtifacts()
    check('产物里有界面插件', collected.entries.length > 0, JSON.stringify(collected.entries.map((e) => e.id)))
    check('产物没有缺文件的问题', collected.problems.length === 0, collected.problems.join(' | '))
    const first = collected.entries[0]
    const body = readUiPluginBundle(first.id, first.file) ?? Buffer.alloc(0)
    const text = body.toString('utf8')
    check('插件 bundle 不内联 React（由壳提供）', text.includes('require("react")'), text.slice(0, 200))
    check('插件 bundle 引用壳的插件 API', text.includes('require("@dsc/ui")'))
    check('插件 bundle 是工厂形状（导出 apply）', text.includes('apply'))
    check('宿主侧能读到界面壳的静态页', existsSync(join(uiPluginsDir(), '..', 'assets', 'index.html')))
    const shellPage = readFileSync(join(uiPluginsDir(), '..', 'assets', 'index.html'), 'utf8')
    check('壳页面挂了入口脚本', shellPage.includes('app-'))
  }
}

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
