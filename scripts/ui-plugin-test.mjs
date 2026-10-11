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

const {
  SlotRegistry,
  UndeclaredSlotError,
  DuplicateSlotError,
  SlotKindConflictError,
  KeyedSlotKeyError,
} = await import('../lib/ui/slots.js')
const { artifactRev, composeUiBootGraph, orderUiPlugins, pluginBundleUrl, shortHash } = await import('../lib/ui/manifest.js')
const { collectUiPluginArtifacts, readUiPluginBundle, readUiPluginManifest, uiPluginsDir } = await import(
  '../lib/core/ui-bundles.js'
)
const { inside } = await import('../lib/core/web-static.js')
const { readUiServerConfig } = await import('../lib/plugins/webserver.js')
const { isUiBundleRequest, resolveUiBundleRequest } = await import('../lib/core/ui-route.js')
const { createUiServer } = await import('../lib/core/ui-server.js')
const { createUiEvents } = await import('../lib/core/ui-events.js')
const { RemoteFrameHub } = await import('../lib/core/remote/frames.js')

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

/** 发一个 HTTP 请求（用 node:http，好自定义 Host 头、Cookie 与请求体）。 */
function http(method, port, path, headers = {}, body = undefined) {
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
    req.end(body === undefined ? undefined : Buffer.from(body, 'utf8'))
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
  check('同一个格子同 priority 重复报错', duplicate instanceof DuplicateSlotError, String(duplicate))
  check(
    '重复报错里点名占位者并给出改法',
    duplicate !== null && String(duplicate.message).includes('early') && String(duplicate.message).includes('priority'),
    duplicate === null ? '' : String(duplicate.message),
  )

  let declaredTwice = null
  try {
    slots.declare('shell.main', 'keyed')
  } catch (error) {
    declaredTwice = error
  }
  check('同一个槽声明成两种形态报错', declaredTwice instanceof SlotKindConflictError, String(declaredTwice))
  const offAgain = slots.declare('shell.main', 'list')
  check('同形态重复声明合法（引用计数 +1）', slots.slots.includes('shell.main'))
  offAgain()

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
  single.register('shell.notice', { id: 'b', order: 2, priority: 1 }, 'b')
  check('single 槽只画一条（priority 小的胜）', single.winners('shell.notice').map((entry) => entry.id).join(',') === 'a')

  const keyed = new SlotRegistry()
  keyed.declare('tool.call', 'keyed')
  keyed.register('tool.call', { id: 'read-impl', key: 'read', order: 1 }, 'read-1')
  keyed.register('tool.call', { id: 'read-other', key: 'read', order: 2, priority: 1 }, 'read-2')
  keyed.register('tool.call', { id: 'write-impl', key: 'write', order: 1 }, 'write')
  check(
    'keyed 槽每格只取一条',
    keyed.winners('tool.call').map((entry) => entry.id).join(',') === 'read-impl,write-impl',
    keyed.winners('tool.call').map((entry) => entry.id).join(','),
  )

  // 遮蔽：同一个格子里可以合法地放多份，priority 小的胜；同 priority 是装配错误。
  const shadow = new SlotRegistry()
  shadow.declare('tool.card', 'list')
  shadow.register('tool.card', { id: 'builtin', order: 1 }, 'builtin')
  shadow.register('tool.card', { id: 'builtin', order: 1, priority: -1 }, 'override')
  check(
    '同 id 不同 priority 是合法替换（小者胜）',
    shadow.winners('tool.card').map((entry) => entry.component).join(',') === 'override',
    shadow.winners('tool.card').map((entry) => entry.component).join(','),
  )
  check('被遮蔽的那份仍在登记表里（诊断看得见）', shadow.entriesOf('tool.card').length === 2)

  // keyed 不给 key 会把所有登记静默压成一格，必须当场报错。
  const keyless = new SlotRegistry()
  keyless.declare('tool.call', 'keyed')
  let noKey = null
  try {
    keyless.register('tool.call', { id: 'x' }, 'x')
  } catch (error) {
    noKey = error
  }
  check('keyed 槽没给 key 当场报错', noKey instanceof KeyedSlotKeyError, String(noKey))

  // 子槽 + injectSlot：贡献者可以比声明者先加载，不必靠顺序排依赖。
  const nested = new SlotRegistry()
  nested.declare('shell.main', 'list')
  let echoes = 0
  const offWait = nested.injectSlot('card.footer', () => {
    echoes += 1
    return nested.register('card.footer', { id: 'echo' }, 'echo')
  })
  check('等一个还没声明的槽不会跑贡献', echoes === 0, String(echoes))
  const offCard = nested.register('shell.main', { id: 'card', children: { 'card.footer': 'list' } }, 'card')
  check('声明者一登记，等待者就被叫醒', echoes === 1, String(echoes))
  check('子槽里出现了贡献', nested.winners('card.footer').map((entry) => entry.component).join(',') === 'echo')
  check(
    '条目记住了自己声明的子槽',
    nested.entriesOf('shell.main')[0].children.join(',') === 'card.footer',
    nested.entriesOf('shell.main')[0].children.join(','),
  )
  offCard()
  check('声明者退订后子槽消失', nested.spec('card.footer') === undefined)
  nested.declare('card.footer', 'list')
  check('槽重新声明时等待者再贡献一次', echoes === 2, String(echoes))
  offWait()

  // 引用计数：多份登记可以把同一个子槽当共享扩展点。
  const shared = new SlotRegistry()
  shared.declare('shell.main', 'list')
  shared.register('shell.main', { id: 'c1', children: { 'list.footer': 'list' } }, 'c1')
  shared.register('shell.main', { id: 'c2', children: { 'list.footer': 'list' } }, 'c2')
  check('同名同形态的子槽可被多份登记共享', shared.spec('list.footer') === 'list')
  let badChild = null
  try {
    shared.register('shell.main', { id: 'c3', children: { 'list.footer': 'single' } }, 'c3')
  } catch (error) {
    badChild = error
  }
  check('同名不同形态的子槽报错', badChild instanceof SlotKindConflictError, String(badChild))

  // 按槽的版本号：一个槽的登记不该让别的槽的快照换引用（否则一次登记放大成整页重渲染）。
  const isolated = new SlotRegistry()
  isolated.declare('a', 'list')
  isolated.declare('b', 'list')
  isolated.register('a', { id: 'x' }, 'x')
  const versionA = isolated.version('a')
  const snapshotA2 = isolated.winners('a')
  isolated.register('b', { id: 'y' }, 'y')
  check('登记 b 不动 a 的版本号', isolated.version('a') === versionA)
  check('登记 b 不让 a 的快照换引用', isolated.winners('a') === snapshotA2)
  check('全局版本号仍然前进（诊断区靠它）', isolated.getVersion() > 0)

  // 崩溃退位：格子里的下一名顶上，故障记下来给诊断看。
  const healing = new SlotRegistry()
  healing.declare('notice', 'single')
  healing.register('notice', { id: 'first' }, 'first')
  healing.register('notice', { id: 'second', priority: 1 }, 'second')
  check('退位前画 priority 小的那个', healing.winners('notice')[0].component === 'first')
  const recorded = []
  const offFault = healing.onFault((fault) => recorded.push(fault))
  healing.reportFault(healing.entriesOf('notice').find((entry) => entry.component === 'first'), new Error('炸了'))
  check('崩过的条目退位，下一名顶上', healing.winners('notice')[0].component === 'second')
  check('故障被记录并广播', recorded.length === 1 && recorded[0].phase === 'render', JSON.stringify(recorded))
  check('故障表可读（诊断区用）', healing.faults.length === 1)
  check('退位是一次性的（不自动复活）', healing.winners('notice').length === 1)
  offFault()
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
  check(
    '指纹取毫秒原值（同毫秒不同小数能分开，避免复查拿旧字节）',
    artifactRev({ ...stat, mtimeMs: 1000.5 }) !== artifactRev({ ...stat, mtimeMs: 1000.9 }),
  )
  check(
    '可换摘要函数（宿主侧传 sha256 那份）',
    artifactRev(stat, (...parts) => parts.join('/')).includes('/'),
  )

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

  let dupId = null
  try {
    orderUiPlugins([
      { id: 'x', rev: 'r1' },
      { id: 'x', rev: 'r2' },
    ])
  } catch (error) {
    dupId = error
  }
  check('清单里两个 id 相同报错（不能静默少装一个）', dupId !== null, dupId === null ? '' : String(dupId.message))

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
  check(
    '只改声明（不动 bundle）整图 rev 也变',
    composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r', immediately: true }]).rev
      !== composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r' }]).rev,
  )
  check(
    '改 external 声明整图 rev 也变',
    composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r', external: ['react-dom'] }]).rev
      !== composeUiBootGraph({ name: 'x', version: 'y' }, [{ id: 'a', rev: 'r' }]).rev,
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
        { id: '@scope/name', file: 'client.js', platform: 'web' },
        { id: 'tui-only', file: 'client.js', platform: 'tui' },
        { id: 'gone', file: 'client.js', platform: 'web' },
        { id: '../evil', file: 'client.js', platform: 'web' },
        { id: 'badfile', file: '../up.js', platform: 'web' },
      ],
    }),
    'demo/client.js': 'module.exports={apply(){}}',
    '@scope/name/client.js': 'module.exports={apply(){}}',
  })
  const manifest = readUiPluginManifest(dir)
  check('清单里非法 id 被丢掉', !manifest.some((entry) => entry.id.includes('evil')), manifest.map((e) => e.id).join(','))
  check('文件名带路径分隔符的被丢掉', !manifest.some((entry) => entry.id === 'badfile'))
  check('清单保留合法项', manifest.some((entry) => entry.id === 'demo') && manifest.some((entry) => entry.id === 'gone'))
  check(
    '作用域名形状的 id（@scope/name）保留',
    manifest.some((entry) => entry.id === '@scope/name'),
    manifest.map((e) => e.id).join(','),
  )

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
  const hit = resolveUiBundleRequest('/plugins/demo/client.js', demo.rev, dir)
  check('路由解析命中 200', hit.status === 200 && (hit.body?.length ?? 0) > 0, String(hit.status))
  check('命中带不可变缓存', String(hit.headers?.['cache-control'] ?? '').includes('immutable'))
  check(
    '缺 rev 一律 404（地址不带指纹就不是内容寻址地址）',
    resolveUiBundleRequest('/plugins/demo/client.js', null, dir).status === 404,
  )
  check(
    '给了错 rev 就 404',
    resolveUiBundleRequest('/plugins/demo/client.js', 'deadbeef', dir).status === 404,
  )
  check(
    '非 GET/HEAD 回 405 并带 Allow',
    resolveUiBundleRequest('/plugins/demo/client.js', demo.rev, dir, 'POST').status === 405,
  )
  const head = resolveUiBundleRequest('/plugins/demo/client.js', demo.rev, dir, 'HEAD')
  check(
    'HEAD 复用 GET 的头但不给体',
    head.status === 200 && head.body === undefined && head.headers?.['content-length'] !== undefined,
    `status=${String(head.status)} body=${String(head.body === undefined)}`,
  )
  const scoped = collected.entries.find((entry) => entry.id === '@scope/name')
  check(
    '多段 id（@scope/name）能按内容寻址取到',
    scoped !== undefined && resolveUiBundleRequest('/plugins/@scope/name/client.js', scoped.rev, dir).status === 200,
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
  check('带令牌换 Cookie 是 303（换票后一律 GET）', handshake.status === 303, String(handshake.status))
  check(
    '换票响应不许被缓存、不带 Referer',
    String(handshake.headers?.['cache-control'] ?? '').includes('no-store')
      && String(handshake.headers?.['referrer-policy'] ?? '').includes('no-referrer'),
    JSON.stringify(handshake.headers),
  )
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

// ── 4c. 数据通道（SSE 推帧 + POST 调方法） ─────────────────────────────────────
console.log('\n[4c] 数据通道')
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const assetsDir = makeTree('events-assets', { 'index.html': '<!doctype html><html><body>x</body></html>' })
  const pluginsDir = makeTree('events-plugins', {
    'manifest.json': JSON.stringify({ version: 1, plugins: [] }),
  })

  // 假宿主：一份会变的快照 + 两个方法（一个正常、一个抛错）
  let tick = 0
  const subscribers = []
  const snapshot = () => ({
    sessionId: 'sess-1',
    status: { sessionId: 'sess-1', model: 'fake-model', turnState: 'idle' },
    entries: [{ id: 1, kind: 'user', text: `第 ${String(tick)} 帧` }],
    liveEntries: [],
  })
  const events = createUiEvents({
    snapshot,
    invoke: async (method, args) => {
      if (method === 'boom') throw new Error('方法炸了')
      return { method, args, tick }
    },
    methods: ['ok', 'boom'],
    hello: () => ({ protocolVersion: 1, methods: ['ok', 'boom'], host: { name: 'Muse Code', version: 'test' } }),
    subscribe: (onChange) => {
      subscribers.push(onChange)
      return () => {
        const at = subscribers.indexOf(onChange)
        if (at >= 0) subscribers.splice(at, 1)
      }
    },
    throttleMs: 20,
  })
  const server = await createUiServer({
    host: { name: 'Muse Code', version: 'test' },
    assetsDir,
    pluginsDir,
    events,
    log: () => {},
  })
  const token = new URL(server.url).searchParams.get('token') ?? ''
  const handshake = await http('GET', server.port, `/?token=${token}`)
  const cookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]

  const anonymous = await http('POST', server.port, '/api/invoke', { 'content-type': 'application/json' }, '{}')
  check('没凭据调方法 401', anonymous.status === 401, String(anonymous.status))

  /** 开一条 SSE 连接并读一小段（返回快照文本的读取器）。 */
  const openSse = async (headers = {}) => {
    const state = { text: '' }
    const req = request(
      { host: '127.0.0.1', port: server.port, method: 'GET', path: '/api/events', headers },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          state.text += chunk
        })
      },
    )
    req.end()
    await sleep(120)
    return { state, close: () => req.destroy() }
  }

  const first = await openSse({ cookie })
  check('SSE 连接建立', first.state.text.includes('event: hello'), first.state.text.slice(0, 80))
  check('握手带协议版本与放行方法', first.state.text.includes('"protocolVersion":1') && first.state.text.includes('"ok"'))
  check('首帧是全量（含 seq 与 full）', first.state.text.includes('event: frame') && first.state.text.includes('"full":true'))
  check('首帧带宿主状态', first.state.text.includes('fake-model'))

  // 第二个连接（补帧要有人接着收才测得出：没有连接时不会造帧——那是有意的省算）
  const second = await openSse({ cookie })
  check('第二个连接也拿到全量帧', second.state.text.includes('"full":true'))

  // 宿主变一次 → 两条连接都该收到增量帧
  tick = 1
  for (const notify of [...subscribers]) notify()
  await sleep(150)
  check('宿主变化推来下一帧（增量）', first.state.text.includes('"type":"delta"'), first.state.text.slice(-160))
  check('另一条连接也收到了', second.state.text.includes('"type":"delta"'))
  const pushedSeq = Number(/"seq":(\d+)/.exec(second.state.text.split('event: frame').pop() ?? '')?.[1] ?? 0)
  check('推来的帧带单调帧号', pushedSeq > 2, String(pushedSeq))

  // 断开一号连接，宿主再变一次（只有二号在收）
  first.close()
  tick = 2
  for (const notify of [...subscribers]) notify()
  await sleep(150)

  // 一号带着「我已经收到 N 帧」重连：应该只补它漏掉的那一帧
  const resumed = await openSse({ cookie, 'last-event-id': String(pushedSeq) })
  check('带 last-event-id 重连时补帧', resumed.state.text.includes(`"seq":${String(pushedSeq + 1)}`), resumed.state.text.slice(-160))
  check('补帧不重发已经收到的帧', !resumed.state.text.includes(`"seq":${String(pushedSeq)}`), resumed.state.text.slice(0, 200))
  resumed.close()
  second.close()

  // 调用：正常 / 抛错 / 不在白名单
  const okCall = await http(
    'POST',
    server.port,
    '/api/invoke',
    { cookie, 'content-type': 'application/json' },
    JSON.stringify({ method: 'ok', args: [1, 'a'] }),
  )
  check('合法调用 200 且回值', okCall.status === 200 && okCall.body.includes('"ok":true'), okCall.body)
  check('调用参数原样送到宿主', okCall.body.includes('"args":[1,"a"]'), okCall.body)
  const boomCall = await http(
    'POST',
    server.port,
    '/api/invoke',
    { cookie, 'content-type': 'application/json' },
    JSON.stringify({ method: 'boom' }),
  )
  check('方法抛错回 ok:false 而不是 5xx', boomCall.status === 200 && boomCall.body.includes('方法炸了'), boomCall.body)
  const deniedCall = await http(
    'POST',
    server.port,
    '/api/invoke',
    { cookie, 'content-type': 'application/json' },
    JSON.stringify({ method: 'exit' }),
  )
  check('白名单外的方法 403', deniedCall.status === 403, String(deniedCall.status))
  const badBody = await http('POST', server.port, '/api/invoke', { cookie, 'content-type': 'application/json' }, '不是 JSON')
  check('请求体不是 JSON 400', badBody.status === 400, String(badBody.status))

  check('通道报出连接数', events.clients >= 0)
  events.stop()
  await server.close()
}

// ── 4d. 宿主产帧 → 壳消费（往返一致性） ────────────────────────────────────────
console.log('\n[4d] 帧往返（宿主产 → 壳并）')
{
  const hub = new RemoteFrameHub()
  const applyHostFrame = (await import('../lib/ui/frames.js')).applyHostFrame

  const snap = (text, live) => ({
    sessionId: 's-1',
    status: { sessionId: 's-1', model: 'm' },
    entries: [
      { id: 1, kind: 'user', text: '第一条' },
      { id: 2, kind: 'assistant', text },
    ],
    liveEntries: live,
  })

  const first = JSON.parse(hub.build(snap('甲', []), true).text)
  let state = applyHostFrame(null, first)
  check('全量帧并进空状态', state.entries.length === 2 && state.entries[0].text === '第一条')
  check('状态字段进 meta', state['status']?.model === 'm', JSON.stringify(state['status']))

  const second = JSON.parse(hub.build(snap('乙', [{ id: -1, kind: 'thinking', text: '想…' }]), false).text)
  state = applyHostFrame(state, second)
  check('增量帧更新已有条目', state.entries.find((entry) => entry.id === 2)?.text === '乙')
  check('增量帧带上直播尾', state.liveEntries.length === 1 && state.liveEntries[0].id === -1)
  check('帧号单调前进', state.seq === 2, String(state.seq))

  const third = JSON.parse(hub.build({ ...snap('乙', []), entries: [{ id: 1, kind: 'user', text: '第一条' }] }, false).text)
  state = applyHostFrame(state, third)
  check('消失的条目被删掉', state.entries.length === 1 && state.entries[0].id === 1)
  check('条目不变量：直播尾清空', state.liveEntries.length === 0)

  let threw = null
  try {
    applyHostFrame(state, { type: 'delta', full: false })
  } catch (error) {
    threw = error
  }
  check('缺 seq 的帧当场报错（严格版）', threw !== null)
  let threw2 = null
  try {
    applyHostFrame(state, { type: 'snapshot', full: true, seq: 9, entries: [{ kind: 'user' }] })
  } catch (error) {
    threw2 = error
  }
  check('条目缺 id 当场报错', threw2 !== null)
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
    const bundles = collected.entries.map((entry) => ({
      id: entry.id,
      text: (readUiPluginBundle(entry.id, entry.file) ?? Buffer.alloc(0)).toString('utf8'),
    }))
    // 加载器用 <script> 执行 bundle（要的 CSP 只是 script-src 'self'），
    // 所以每份产物外面必须包一层「把工厂注册进全局表」的壳。
    check(
      '每个 bundle 都注册进全局工厂表',
      bundles.every((bundle) => bundle.text.startsWith('(globalThis.__DSC_UI_FACTORIES__')),
      bundles.filter((b) => !b.text.startsWith('(globalThis.__DSC_UI_FACTORIES__')).map((b) => b.id).join(','),
    )
    check(
      '工厂签名是受控的 require/module/exports',
      bundles.every((bundle) => bundle.text.includes('function (require, module, exports) {')),
    )
    const reactUser = bundles.find((bundle) => bundle.text.includes('useState')) ?? bundles[0]
    check('用 React 的 bundle 走 require 而不是内联', reactUser.text.includes('require("react")'), reactUser.id)
    check(
      '没有 bundle 内联 React 实现（那会让 hooks 崩）',
      bundles.every((bundle) => !bundle.text.includes('__SECRET_INTERNALS') && !bundle.text.includes('Minified React error')),
    )
    check('插件 bundle 引用壳的插件 API', bundles.every((bundle) => bundle.text.includes('require("@dsc/ui")')))
    check('插件 bundle 是工厂形状（导出 apply）', bundles.every((bundle) => bundle.text.includes('apply')))
    // 演示插件（hello/echo/runtime）按拍板从发布面移除（阶段 8）：点名它们的产物断言随之
    // 删除——子槽语义的活体证据由槽位注册表单测（本文件 220-240 行）承担，不靠演示 bundle。
    check('宿主侧能读到界面壳的静态页', existsSync(join(uiPluginsDir(), '..', 'assets', 'index.html')))
    const shellPage = readFileSync(join(uiPluginsDir(), '..', 'assets', 'index.html'), 'utf8')
    check('壳页面挂了入口脚本', shellPage.includes('app-'))
  }
}

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
