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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

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
  ChainSlotSelectError,
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

  // ── chain：条目自己选举（第四形态）─────────────────────────────────────────────
  const chain = new SlotRegistry()
  chain.declare('tool.view', 'chain')
  let noSelect = null
  try {
    chain.register('tool.view', { id: 'no-select' }, 'no-select')
  } catch (error) {
    noSelect = error
  }
  check('chain 槽没给 select 当场报错', noSelect instanceof ChainSlotSelectError, String(noSelect))

  chain.register('tool.view', { id: 'builtin', priority: 100, select: (owner) => ({ verb: owner.name }) }, 'builtin')
  chain.register('tool.view', { id: 'hijack', priority: 1, select: (owner) => (owner.name === 'bash' ? '接管' : null) }, 'hijack')
  check('认领者赢过 catch-all（priority 小者先问）', chain.elect('tool.view', { name: 'bash' })?.entry.id === 'hijack')
  check('弃权（null）问下一位', chain.elect('tool.view', { name: 'read' })?.entry.id === 'builtin')
  check('matched 原样透传', chain.elect('tool.view', { name: 'read' })?.matched?.verb === 'read')

  // 先问的弃权不挡后面的：priority 更小的 picky 弃权后，链照常走到内置。
  chain.register('tool.view', { id: 'picky', priority: 0, select: () => null }, 'picky')
  check('priority 最小的弃权不挡后面的当选', chain.elect('tool.view', { name: 'read' })?.entry.id === 'builtin')

  // 全体弃权：渲染方画兜底（elect 返回 null）。
  const shy = new SlotRegistry()
  shy.declare('tool.view', 'chain')
  shy.register('tool.view', { id: 'picky', priority: 0, select: () => null }, 'picky')
  check('全员弃权返回 null', shy.elect('tool.view', { name: 'read' }) === null)

  // 同 priority 并存合法（chain 没有格子冲突），按注册序排队。
  const tied = new SlotRegistry()
  tied.declare('tool.view', 'chain')
  tied.register('tool.view', { id: 'first', priority: 5, select: () => 'a' }, 'first')
  tied.register('tool.view', { id: 'second', priority: 5, select: () => 'b' }, 'second')
  check('chain 同 priority 并存不报冲突', tied.entriesOf('tool.view').length === 2)
  check('同 priority 按注册序先问', tied.elect('tool.view', {})?.entry.id === 'first')

  // 当选者崩溃（renderFault）后退位，选举落到下一位。
  const chainHealing = new SlotRegistry()
  chainHealing.declare('tool.view', 'chain')
  chainHealing.register('tool.view', { id: 'cranky', priority: 1, select: () => 'x' }, 'cranky')
  chainHealing.register('tool.view', { id: 'backup', priority: 2, select: () => 'y' }, 'backup')
  chainHealing.reportFault(chainHealing.entriesOf('tool.view').find((entry) => entry.id === 'cranky'), new Error('渲染炸了'))
  check('当选者退位后选举落到下一位', chainHealing.elect('tool.view', {})?.entry.id === 'backup')

  // 选择器自己抛异常：视同弃权并记故障，链继续走（一个坏选择器不烧整条链）。
  const rotten = new SlotRegistry()
  rotten.declare('tool.view', 'chain')
  const rottenFaults = []
  rotten.onFault((fault) => rottenFaults.push(fault))
  rotten.register('tool.view', { id: 'throws', priority: 1, select: () => { throw new Error('选择器有 bug') } }, 'throws')
  rotten.register('tool.view', { id: 'fine', priority: 2, select: () => 'ok' }, 'fine')
  check('抛异常的选择器视同弃权', rotten.elect('tool.view', {})?.entry.id === 'fine')
  check('坏选择器被记故障并退位', rottenFaults.length === 1 && rotten.entriesOf('tool.view').length === 2)

  // elect 只对 chain 有意义；winners 对 chain 返回全部幸存候选人（诊断口径）。
  let notChain = null
  try {
    chain.elect('shell.main', {})
  } catch (error) {
    notChain = error
  }
  check('对非 chain 槽 elect 抛装配错误', notChain !== null, String(notChain))
  check('winners 对 chain 返回全部幸存候选人', chain.winners('tool.view').length === 3)
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

  const graph = composeUiBootGraph({ name: 'Pneuma', version: '9.9.9' }, rows)
  check('启动图带宿主身份', graph.host.name === 'Pneuma' && graph.host.version === '9.9.9')
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
    host: { name: 'Pneuma', version: 'test-1.2.3' },
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
  check('页面挂了启动清单外链脚本', page.body.includes('<script src="/boot.js">'), page.body.slice(0, 160))
  check(
    '页面带内容安全策略且脚本面收成 self',
    String(page.headers['content-security-policy'] ?? '').includes("script-src 'self'"),
    JSON.stringify(page.headers),
  )
  const bootScript = await http('GET', port, '/boot.js', { cookie })
  check(
    '/boot.js 注入启动清单全局名',
    bootScript.status === 200 && bootScript.body.includes('__DSC_BOOT__'),
    `${String(bootScript.status)} ${bootScript.body.slice(0, 120)}`,
  )
  check('/boot.js 注入的是宿主身份', bootScript.body.includes('Pneuma') && bootScript.body.includes('test-1.2.3'))
  const anonymousBootScript = await http('GET', port, '/boot.js')
  check('没凭据取 /boot.js 401', anonymousBootScript.status === 401, String(anonymousBootScript.status))

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
    host: { name: 'Pneuma', version: 'test' },
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
  const server = await createUiServer({
    host: { name: 'Pneuma', version: 'test' },
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
    check(
      '每个内置条目都带 api（来自各自 package.json 的 @dsc/ui 区间）',
      collected.entries.every((entry) => typeof entry.api === 'string' && entry.api !== ''),
      JSON.stringify(collected.entries.map((entry) => [entry.id, entry.api])),
    )
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
    // ── E6：插件从平台种子取基元，产物里不许再内联这些实现 ───────────────────────
    // marker 是 rollup 未 minify（build-plugins.mjs 的 `minify: false`）时的逐字函数签名：
    // Select / 图标（base、sized）/ completion-sound 的 AudioContext 单例。改前这五份
    // （settings / plugins / terminal / trace / transcript）各内联一份，改后一份都不该有；
    // 反例会把包名打出来（哪份内联了内联的是谁）。
    const inlined = bundles
      .filter((bundle) =>
        bundle.text.includes('function Select(props)') ||
        bundle.text.includes('function base(path') ||
        bundle.text.includes('function sized(size)') ||
        bundle.text.includes('reverbImpulse'),
      )
      .map((bundle) => bundle.id)
    check('没有 bundle 内联基元实现（Select / 图标 / completion-sound）', inlined.length === 0, inlined.join(','))
    const seedUsers = ['settings', 'plugins', 'terminal', 'trace', 'transcript']
    const missingSeedRequire = seedUsers.filter((id) => {
      const bundle = bundles.find((candidate) => candidate.id === id)
      return bundle === undefined || !bundle.text.includes('require("@dsc/ui-primitives")')
    })
    check(
      '改用种子的五份 bundle 都 require("@dsc/ui-primitives")',
      missingSeedRequire.length === 0,
      missingSeedRequire.join(','),
    )
    // 演示插件（hello/echo/runtime）按拍板从发布面移除（阶段 8）：点名它们的产物断言随之
    // 删除——子槽语义的活体证据由槽位注册表单测（本文件 220-240 行）承担，不靠演示 bundle。
    check('宿主侧能读到界面壳的静态页', existsSync(join(uiPluginsDir(), '..', 'assets', 'index.html')))
    const shellPage = readFileSync(join(uiPluginsDir(), '..', 'assets', 'index.html'), 'utf8')
    check('壳页面挂了入口脚本', shellPage.includes('app-'))
  }
}

// ── 5b. 分包落点（packages.json ↔ tsconfig paths） ─────────────────────────────
// 逻辑分包没有 workspace 的依赖图兜底：包名 → 源码落点分四处（配方见 ui-shell/packages.md）。
// 这里钉住最容易静默漂移的一对——packages.json 与 tsconfig 的 paths（tsconfig 读不了 JSON，
// 只能手抄）：不一致的表现是「编译期按一种类型、构建期解析到另一份实现」，最坏是两份 React。
console.log('\n[5b] 分包落点')
{
  const uiShell = fileURLToPath(new URL('../ui-shell/', import.meta.url))
  const packages = JSON.parse(readFileSync(join(uiShell, 'packages.json'), 'utf8'))
  const shellPackage = JSON.parse(readFileSync(join(uiShell, 'package.json'), 'utf8'))
  const tsconfig = JSON.parse(readFileSync(join(uiShell, 'tsconfig.json'), 'utf8'))
  const paths = tsconfig.compilerOptions?.paths ?? {}
  const names = Object.keys(packages)

  check('packages.json 登记了插件 API 与共享核心两个包名', names.includes('@dsc/ui') && names.includes('@dsc/ui-core'), names.join(','))
  const resolved = Object.fromEntries(names.map((name) => [name, resolve(uiShell, packages[name])]))
  check(
    'packages.json 的每个落点都在盘上',
    names.every((name) => existsSync(resolved[name])),
    names.filter((name) => !existsSync(resolved[name])).join(','),
  )
  const tsNames = Object.keys(paths)
  const missingInTs = names.filter((name) => !tsNames.includes(name))
  const extraInTs = tsNames.filter((name) => !names.includes(name))
  check(
    'tsconfig paths 与 packages.json 键集一致',
    missingInTs.length === 0 && extraInTs.length === 0,
    `tsconfig 缺：${missingInTs.join('、') === '' ? '(无)' : missingInTs.join('、')}；tsconfig 多：${extraInTs.join('、') === '' ? '(无)' : extraInTs.join('、')}`,
  )
  const mismatched = names.filter(
    (name) => paths[name] !== undefined && resolve(uiShell, paths[name][0]) !== resolved[name],
  )
  check(
    '同一包名的落点在两处指向同一个文件',
    mismatched.length === 0,
    mismatched.map((name) => `${name}: tsconfig=${JSON.stringify(paths[name])} packages=${packages[name]}`).join(' | '),
  )

  // @dsc/ui-core 的边界锚：src/ui/package.json 是它的包身份，逻辑落点必须与它声明的入口一致；
  // 版本与壳同源（契约版本纪律：@dsc/ui 的导出面变了，两处一起动）。
  const corePackage = JSON.parse(readFileSync(join(uiShell, '..', 'src', 'ui', 'package.json'), 'utf8'))
  check('src/ui/package.json 就是 @dsc/ui-core 的包身份', corePackage.name === '@dsc/ui-core', String(corePackage.name))
  check(
    '@dsc/ui-core 的落点 = 它声明的 types 入口',
    resolve(uiShell, String(packages['@dsc/ui-core'])) === resolve(uiShell, '..', 'src', 'ui', String(corePackage.types)),
    `${String(packages['@dsc/ui-core'])} ≠ src/ui/${String(corePackage.types)}`,
  )
  check('@dsc/ui-core 的版本与壳 apiVersion 同源', corePackage.version === shellPackage.version, `${String(corePackage.version)} ≠ ${String(shellPackage.version)}`)

  // 两个构建消费方必须真接在 packages.json 上（不是各写一份 alias）——改了这里就该红。
  check('vite.config.ts 从 packages.json 生成 alias', readFileSync(join(uiShell, 'vite.config.ts'), 'utf8').includes('packages.json'))
  check('build-plugins.mjs 从 packages.json 生成 alias', readFileSync(join(uiShell, 'build-plugins.mjs'), 'utf8').includes('packages.json'))

  // @dsc/ui-core 故意不下发给插件：平台模块表里没有它（build-plugins 的 EXTERNAL 保它外部化，
  // 插件当值用时运行期拿到「白名单外的模块」那句错，而不是静默内联一份私有实现）。
  const platformModules = JSON.parse(readFileSync(join(uiShell, 'src', 'platform-modules.json'), 'utf8'))
  check('@dsc/ui-core 不在平台模块表里（故意不给插件）', !platformModules.includes('@dsc/ui-core'), platformModules.join(','))

  // ── 包内分层：五个逻辑包的单向依赖（E2/E3/E5/E4） ─────────────────────────────
  // 逻辑分包没有 workspace 的依赖图兜底：反向依赖编译器不拦，症状是运行期解析出两份实现
  // （hooks 直接崩）或插件 bundle 把整层内联进去。这里对各包逐文件走查 import 说明符
  // （先剔注释再取 `from '…'` / `import('…')` / 裸 `import '…'`），把
  // 「primitives / slots ← dockkit ← layout ← renderer」这条单向链钉死。
  const layerDirs = {
    '@dsc/ui-primitives': join(uiShell, 'src', 'ui-primitives'),
    '@dsc/ui-slots': join(uiShell, 'src', 'ui-slots'),
    '@dsc/ui-dockkit': join(uiShell, 'src', 'ui-dockkit'),
    '@dsc/ui-layout': join(uiShell, 'src', 'ui-layout'),
    '@dsc/ui-renderer': join(uiShell, 'src', 'ui-renderer'),
  }
  // 每包**不许**出现的包名：往上走的那些。`@dsc/ui`（聚合面）转出的正是这些包，
  // 从下面往回引等于把插件 API 拖进环里（alias 会解析出第二份实现）。
  // ui-layout 不许引 `@dsc/ui-renderer`：E4 把那条反向边（读白名单与装载账本）剪成
  // props 递值，这条禁止是防回归——`ui-layout → ui-renderer → ui-layout` 一旦复活就是环。
  // ui-layout 不许引 `@dsc/ui`：E4 收尾把宿主桥与读色沉到 `@dsc/ui-primitives`
  // （native.ts / css.ts）、把页 / 视图真源连同读 hook 留在 ui-layout 自己家里，
  // 那条 `ui-layout → @dsc/ui → ui-layout` 的环随之剪断；这条禁止同样是防回归
  // （之前它只是「过渡期放行」，靠人记得别再加一处）。
  const forbiddenUpward = {
    '@dsc/ui-primitives': ['@dsc/ui-dockkit', '@dsc/ui-slots', '@dsc/ui-layout', '@dsc/ui-renderer', '@dsc/ui'],
    '@dsc/ui-slots': ['@dsc/ui-dockkit', '@dsc/ui-layout', '@dsc/ui-renderer', '@dsc/ui'],
    '@dsc/ui-dockkit': ['@dsc/ui-slots', '@dsc/ui-layout', '@dsc/ui-renderer', '@dsc/ui'],
    '@dsc/ui-layout': ['@dsc/ui-renderer', '@dsc/ui'],
    '@dsc/ui-renderer': [],
  }
  // 每包**刻意保留**的相对边（白名单之外，任何一处走出包的相对 import 都会红）：
  //   - ui-slots 的 `../plugin-api`：`declare module` 的合并落在**文件身份**上（re-export
  //     与包名 alias 不参与合并），且 SlotMap / UiComponent 等契约类型只能从那个文件取——
  //     纯类型面，擦除后零字节。这是机制要求，不是过渡态。
  //   - ui-layout 的 `../plugin-api`：同一条机制要求的类型面——`UiSlots` 别名由
  //     `SlotMap` / `SlotFactoryMap`（同上，只在那一个文件里）与 `UiComponent` 拼成，
  //     而 app.tsx 的 props 要它。`import type`，零运行期字节。
  //   - ui-layout 的过渡边已随 E4 清零（原 `../boot` / `../slots` / `../slots-react` /
  //     `../hmr` 四条：两条换包名、两条改成 props 递值），`@dsc/ui` 那条向上边也清零
  //     （宿主桥与读色沉到 ui-primitives、页 / 视图真源留在本包）。
  const packageTransitionEdges = {
    '@dsc/ui-slots': new Set(['../plugin-api']),
    '@dsc/ui-layout': new Set(['../plugin-api']),
  }
  const sourceFilesOf = (dir, out = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) sourceFilesOf(file, out)
      else if (/\.tsx?$/.test(entry.name)) out.push(file)
    }
    return out
  }
  const importsOf = (text) => {
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    const specs = new Set()
    for (const m of clean.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1])
    for (const m of clean.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) specs.add(m[1])
    for (const m of clean.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.add(m[1])
    return [...specs]
  }

  const layerNames = Object.keys(layerDirs)
  check(
    '五个逻辑包的入口都在盘上',
    layerNames.every((name) => existsSync(join(layerDirs[name], 'index.ts'))),
    layerNames.filter((name) => !existsSync(join(layerDirs[name], 'index.ts'))).join(','),
  )
  // 包身份与 @dsc/ui-core 同一套纪律：name = 包名、private、version 与壳同源（契约版本
  // 一起走）、types 指入口。写错了不会影响构建，只会让「这是哪个包」在以后认不出来。
  const badIdentity = layerNames.filter((name) => {
    const pkg = JSON.parse(readFileSync(join(layerDirs[name], 'package.json'), 'utf8'))
    return (
      pkg.name !== name ||
      pkg.private !== true ||
      pkg.version !== shellPackage.version ||
      pkg.types !== 'index.ts'
    )
  })
  check('五个逻辑包的包身份与壳同源（name / private / version / types）', badIdentity.length === 0, badIdentity.join('、'))

  const upwardEdges = []
  const outsideEdges = []
  for (const name of layerNames) {
    const dir = layerDirs[name]
    for (const file of sourceFilesOf(dir)) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        if (forbiddenUpward[name].includes(spec)) {
          upwardEdges.push(`${relative(uiShell, file)} → ${spec}`)
          continue
        }
        if (!spec.startsWith('.')) continue
        const target = resolve(dirname(file), spec)
        if (target === dir || target.startsWith(dir + sep)) continue
        // 样式表与数据 JSON 没有**模块身份**：重复加载顶多是层叠/数据副本的琐事，
        // 不是这个检查要防的「两份实现」（两份 React 那种）。入口的 legacy/*.css 与
        // 装载器的 ../platform-modules.json 因此按扩展名放行。
        if (/\.(css|json)$/.test(spec)) continue
        if ((packageTransitionEdges[name] ?? new Set()).has(spec)) continue
        outsideEdges.push(`${relative(uiShell, file)} → ${spec}`)
      }
    }
  }
  check('包内不出现反向依赖（primitives / slots ← dockkit ← layout ← renderer）', upwardEdges.length === 0, upwardEdges.join('；'))
  check('相对 import 不出包（契约类型边与资源文件除外）', outsideEdges.length === 0, outsideEdges.join('；'))

  // ── E6：三个平台种子词三处一致（JSON ↔ boot.ts 的 MODULES ↔ 诊断读数）───────────
  // 这取代了 E4 时那条「三个新包不在平台模块表里」的断言：当时三个包还不该下发给插件
  // （alias 已登记但种子表未扩，插件按包名 require 会撞「白名单外的模块」）；E6 的任务正是
  // 把这张表扩到它们——所以断言反向。MODULE_DRIFT 只在 console 里报，探针才是闸门。
  const bootTs = readFileSync(join(uiShell, 'src', 'ui-renderer', 'boot.ts'), 'utf8')
  const seedPackages = ['@dsc/ui-slots', '@dsc/ui-primitives', '@dsc/ui-dockkit']
  for (const name of seedPackages) {
    check(`平台模块表含 ${name}（E6 起下发给插件）`, platformModules.includes(name), platformModules.join(','))
    check(
      `${name} 在 boot.ts 的 MODULES 里挂了实现`,
      new RegExp(`^\\s*'${name}':`, 'm').test(bootTs) && bootTs.includes(`from '${name}'`),
    )
  }
  // JSON 与 MODULES 键集**且顺序**全等：诊断区那行读数按 MODULES 的键顺序显示，
  // 顺序漂了不致命，但两边同源才撑得起「改一处就齐」的纪律。
  const modulesBlock = /const MODULES[^{]*\{([\s\S]*?)\n\}/.exec(bootTs)?.[1] ?? ''
  const modKeys = [...modulesBlock.matchAll(/^\s{2}(?:'([^']+)'|([A-Za-z][^:\s]*)):\s/gm)].map((m) => m[1] ?? m[2])
  check(
    'platform-modules.json 与 boot.ts MODULES 键集且顺序全等',
    modKeys.length === platformModules.length && platformModules.every((name, index) => modKeys[index] === name),
    `MODULES=${modKeys.join(',')} | json=${platformModules.join(',')}`,
  )
  check(
    '跑在种子里的是三个包（不是 @dsc/ui-core——它继续故意不给）',
    seedPackages.every((name) => platformModules.includes(name)) && !platformModules.includes('@dsc/ui-core'),
  )
}

// ── 5c. 槽位契约表（D1）：壳槽键集在源码声明与产物里对得上（防「表改了一半」）─────
console.log('\n[5c] 槽位契约表')
{
  const shellDir = fileURLToPath(new URL('../ui-shell/', import.meta.url))
  // E4 起槽位契约（含 9 个壳槽的 declare module）住 `@dsc/ui-slots` 包。
  const slotsSource = readFileSync(join(shellDir, 'src', 'ui-slots', 'slots.ts'), 'utf8')
  // SLOT 常量表的值（9 个壳槽名）与 declare module 块里并进 SlotMap 的键集必须一致。
  // 前者被 `{ [K in ShellSlot]: SlotMap[K]['kind'] }` 钉死（少并一个键是编译错）；
  // 这里再钉一遍产物层——契约表是插件作者看的东西，不能只活在源码里。
  const constSlots = [...slotsSource.matchAll(/^\s+\w+: '(shell\.[\w.]+)',/gm)].map((match) => match[1])
  const declaredSlots = [...slotsSource.matchAll(/'((?:shell\.)[\w.]+)': \{ kind:/g)].map((match) => match[1])
  check(
    '壳槽常量表 9 个键、SlotMap 声明 9 个键、两边集合一致',
    constSlots.length === 9 &&
      declaredSlots.length === 9 &&
      constSlots.every((name) => declaredSlots.includes(name)),
    `const=${constSlots.join(',')} declared=${declaredSlots.join(',')}`,
  )

  // 产物层：应用 bundle 里必须找得到全部壳槽名（构建没把它们摇掉）。
  const assets = join(shellDir, '..', 'lib', 'ui', 'assets')
  const appFile = readdirSync(assets).find((name) => name.startsWith('app-') && name.endsWith('.js'))
  const appBundle = appFile === undefined ? '' : readFileSync(join(assets, appFile), 'utf8')
  check('应用产物里含全部 9 个壳槽名', constSlots.length === 9 && constSlots.every((name) => appBundle.includes(name)), appFile ?? '缺 app-*.js')

  // 跨插件复用点（D2）：transcript 注册的 Factory 名 / children 槽名与 trace 的消费点都在产物里。
  const readBundle = (id) => readFileSync(join(shellDir, '..', 'lib', 'ui', 'plugins', id, 'client.js'), 'utf8')
  check(
    'transcript 产物含 tool-card Factory 与 footer 槽名',
    readBundle('transcript').includes('transcript.tool-card') && readBundle('transcript').includes('transcript.toolcard.footer'),
  )
  check('trace 产物含对 transcript.tool-card 的消费点', readBundle('trace').includes('transcript.tool-card'))
  // 工具卡的「可点路径」（read / write / edit → 右侧文件预览）：类名与落点属性是自检的
  // 选择器，构建把它们摇掉就没得点了——这里钉产物里这条链还在。
  check(
    'transcript 产物含工具卡可点路径（tc-path-btn / data-tc-open）',
    readBundle('transcript').includes('tc-path-btn') && readBundle('transcript').includes('data-tc-open'),
  )
  // 工具卡的文件名 chip：edit / write 开补丁视图（data-tc-source=patch），read 开当前内容。
  // 补丁页签的渲染（DiffRows）在 preview 产物里——构建把这两条链摇掉就没得点了。
  check(
    'transcript 产物含 chip 的补丁/内容分流（data-tc-source / opensPatch）',
    readBundle('transcript').includes('data-tc-source') && readBundle('transcript').includes('opensPatch'),
  )
  check(
    'preview 产物含 patch 页签与 DiffRows 渲染',
    /kind:\s*["']patch["']/.test(readBundle('preview')) && readBundle('preview').includes('DiffRows'),
  )
}

// ── 6. A1 服务注入（provide/consume + inject 硬依赖 + 冲突人话）─────────────────
console.log('\n[6] A1 服务注入')
{
  const { loadTuiPlugins } = await import('../lib/ui/tui-plugins.js')
  const { ServiceRegistry, ServiceConflictError, unmetInjections } = await import('../lib/ui/services.js')

  // 乱序清单：inject 指向提供者的插件 id，拓扑排序必须把提供者排前面。
  const ordered = orderUiPlugins([
    { id: 'beta', inject: ['alpha'] },
    { id: 'alpha' },
  ])
  check('乱序清单按 inject 拓扑排好（提供者在前）', ordered.map((row) => row.id).join(',') === 'alpha,beta', ordered.map((row) => row.id).join(','))

  /** 造一个 TUI 插件 bundle（工厂格式与真实产物一致）。 */
  const bundle = (id, body) =>
    `(globalThis.__DSC_UI_FACTORIES__ ??= {})[${JSON.stringify(id)}] = function (require, module, exports) {\n${body}\n};\n`
  const runtime = { getSnapshot: () => ({}), subscribe: () => () => undefined }
  const host = { name: '探针', version: '0.0.0-probe', platform: 'tui' }

  // 用例一：A provide、B consume，拿到的是同一个对象；装载结果带服务名快照；卸载后释放。
  const good = makeTree('a1-good', {
    'manifest.json': JSON.stringify({
      version: 1,
      plugins: [
        { id: 'beta', file: 'client.js', platform: 'tui', inject: ['alpha'] },
        { id: 'alpha', file: 'client.js', platform: 'tui' },
      ],
    }),
    'alpha/client.js': bundle(
      'alpha',
      `module.exports = { name: '甲方', apply(ui) { const seat = { kind: 'shared', n: 1 }; globalThis.__PROBE_PROVIDED = seat; ui.provide('probe.seat', seat) } };`,
    ),
    'beta/client.js': bundle(
      'beta',
      `module.exports = { name: '乙方', apply(ui) { globalThis.__PROBE_CONSUMED = ui.consume('probe.seat'); globalThis.__PROBE_BETA_APPLIED = true } };`,
    ),
  })
  delete globalThis.__PROBE_PROVIDED
  delete globalThis.__PROBE_CONSUMED
  delete globalThis.__PROBE_BETA_APPLIED
  const services = new ServiceRegistry()
  const reports = []
  const registry = new SlotRegistry()
  const load = loadTuiPlugins({ registry, runtime, host, pluginsDir: good, services, onReport: (report) => reports.push(report) })
  const alphaReport = load.reports.find((report) => report.id === 'alpha')
  const betaReport = load.reports.find((report) => report.id === 'beta')
  check('提供者先装上', alphaReport?.ok === true, JSON.stringify(alphaReport))
  check('消费者装上（乱序清单由拓扑 + 重试兜底）', betaReport?.ok === true, JSON.stringify(betaReport))
  check('consume 拿到 provide 的同一个对象', globalThis.__PROBE_CONSUMED === globalThis.__PROBE_PROVIDED && globalThis.__PROBE_PROVIDED !== undefined)
  check('报告记录 provide 过的服务名', alphaReport?.provides?.join(',') === 'probe.seat', JSON.stringify(alphaReport?.provides))
  check('装载结果带服务名快照', load.services.join(',') === 'probe.seat', load.services.join(','))
  check('服务表登记了提供者', services.providerOf('probe.seat') === 'alpha', String(services.providerOf('probe.seat')))
  load.disposeAll()
  check('卸载后服务被释放', services.names().length === 0, services.names().join(','))

  // 用例二：提供者缺席 → 消费者不 apply，报告一行中文原因。
  delete globalThis.__PROBE_BETA_APPLIED
  const missing = makeTree('a1-missing', {
    'manifest.json': JSON.stringify({
      version: 1,
      plugins: [{ id: 'beta', file: 'client.js', platform: 'tui', inject: ['probe.seat'] }],
    }),
    'beta/client.js': bundle(
      'beta',
      `module.exports = { apply(ui) { globalThis.__PROBE_BETA_APPLIED = true } };`,
    ),
  })
  const load2 = loadTuiPlugins({ registry, runtime, host, pluginsDir: missing, onReport: () => undefined })
  const beta2 = load2.reports.find((report) => report.id === 'beta')
  check('提供者缺席时消费者不 apply', beta2?.ok === false && globalThis.__PROBE_BETA_APPLIED === undefined, JSON.stringify(beta2))
  check('报告里有一行中文原因（服务还没有提供者）', String(beta2?.error).includes('服务 probe.seat 还没有提供者'), String(beta2?.error))
  check('缺席的服务不进装载结果快照', load2.services.length === 0, load2.services.join(','))
  load2.disposeAll()

  // 用例三：提供者 apply 抛错 → 消费者报告「插件 X 没装上」。
  const broken = makeTree('a1-broken', {
    'manifest.json': JSON.stringify({
      version: 1,
      plugins: [
        { id: 'beta', file: 'client.js', platform: 'tui', inject: ['alpha'] },
        { id: 'alpha', file: 'client.js', platform: 'tui' },
      ],
    }),
    'alpha/client.js': bundle('alpha', `module.exports = { apply() { throw new Error('甲方的装配炸了') } };`),
    'beta/client.js': bundle('beta', `module.exports = { apply() {} };`),
  })
  const load3 = loadTuiPlugins({ registry, runtime, host, pluginsDir: broken, onReport: () => undefined })
  const beta3 = load3.reports.find((report) => report.id === 'beta')
  check(
    '提供者没装上时消费者报告「插件 alpha 没装上：…」',
    beta3?.ok === false && String(beta3?.error).includes('插件 alpha 没装上') && String(beta3?.error).includes('甲方的装配炸了'),
    String(beta3?.error),
  )
  check('两个失败者都重试过一轮（attempts=2）', beta3?.attempts === 2, String(beta3?.attempts))
  load3.disposeAll()

  // 用例四：重复 provide 抛人话（跨插件重名冲突落在服务表这一处）。
  const dup = new ServiceRegistry()
  dup.provide('probe.seat', 1, '甲')
  let conflict = null
  try {
    dup.provide('probe.seat', 2, '乙')
  } catch (error) {
    conflict = error
  }
  check('重复 provide 抛 ServiceConflictError', conflict instanceof ServiceConflictError, String(conflict))
  check(
    '冲突人话里带两个插件 id',
    conflict !== null && String(conflict.message).includes('甲') && String(conflict.message).includes('乙'),
    conflict === null ? '' : String(conflict.message),
  )

  // 用例五：unmetInjections 的两档文案分开（没有提供者 / 提供者没装上）。
  const empty = new ServiceRegistry()
  check(
    '「没有提供者」与「提供者没装上」是两档文案',
    unmetInjections(['svc.x'], () => undefined, empty).join('；').includes('服务 svc.x 还没有提供者') &&
      unmetInjections(['plug.a'], () => ({ ok: false, error: '炸了' }), empty).join('；').includes('插件 plug.a 没装上：炸了'),
  )

  // 用例六：同名时的**优先级**——`inject` 先按「清单里另一个插件的 id」解，再按「服务名」解。
  // 为什么值得钉：两条路的语义不同（id = 「那条插件的工厂注册好了吗」，服务名 = 「有提供者吗」），
  // 一旦颠倒，按 id 写依赖的插件会开始按服务名判定，报错文案与「谁没装上」都会指错人。
  const both = new ServiceRegistry()
  both.provide('plug.b', { ok: 1 }, 'plug.b')
  check(
    '名字既是插件 id 又是服务名：以插件那条为准（它没装上就是没满足，哪怕服务在）',
    unmetInjections(['plug.b'], () => ({ ok: false, error: '炸了' }), both).join('；').includes('插件 plug.b 没装上'),
  )
  check(
    '名字是插件 id 且那条插件装上了：服务表里没有它也算满足（不回落去查服务名）',
    unmetInjections(['plug.b'], () => ({ ok: true }), empty).length === 0,
  )
}

// ── 7. D3 席位（共享实例 / 懒建 / 释放 / 浅拷贝口径）─────────────────────────────
console.log('\n[7] D3 席位')
{
  const { defineStore } = await import('../lib/ui/store.js')

  const slots = new SlotRegistry()
  slots.declare('probe.one', 'list')
  slots.declare('probe.two', 'list')
  const seat = defineStore({
    init: () => ({ list: [], nested: { n: 1 } }),
    actions: {
      setList: (draft, list) => {
        draft.list = list
      },
    },
  })

  // 懒建：register 只记 handle（不建实例），第一次渲染读（seat()）才 create()。
  let creates = 0
  const counted = { spec: seat.spec, create: () => (creates += 1, seat.create()) }
  const offA = slots.register('probe.one', { id: 'a', store: counted }, 'A')
  check('register 不建实例（懒建）', creates === 0, String(creates))

  // 同一个 handle 的两个登记共享一个实例（身份就是 handle 对象，不认字符串键）。
  const offB = slots.register('probe.two', { id: 'b', store: counted }, 'B')
  const instance = slots.seat(counted)
  check('首次渲染读才建实例', creates === 1, String(creates))
  check('两个登记共享同一个实例', instance !== undefined && instance === slots.seat(counted))

  // draft 剥掉：组件调用只给业务实参；写入换顶层引用、未触碰的嵌套值按引用保留。
  const before = instance.getSnapshot()
  instance.actions.setList(['x'])
  const after = instance.getSnapshot()
  check('actions 只收业务实参（draft 已烘掉）', after.list.join(',') === 'x')
  check('写入换顶层引用（React 快照比较成立）', before !== after)
  check('浅拷贝口径：未触碰的嵌套值按引用保留', before.nested === after.nested)

  // 订阅与退订。
  let hits = 0
  const off = instance.subscribe(() => {
    hits += 1
  })
  instance.set({ ...after, list: ['y'] })
  check('订阅收到写入', hits === 1, String(hits))
  off()
  instance.set({ ...after, list: ['z'] })
  check('退订后不再通知', hits === 1, String(hits))

  // 释放：最后一个持有者卸载后席位消失（下次登记重建新实例）。
  offA()
  check('还有持有者时席位仍在', slots.seat(counted) !== undefined)
  offB()
  check('最后一个持有者卸载后席位释放', slots.seat(counted) === undefined)
  check('未登记过的 handle 读不到席位', slots.seat(seat) === undefined)
}

// ── 8. D2 Factory（注册表运行期：定义账 / children 进声明表 / 卸载 collapse / 故障记账）──
console.log('\n[8] D2 Factory')
{
  const { SlotAssemblyError } = await import('../lib/ui/slots.js')
  const slots = new SlotRegistry()
  slots.declare('probe.main', 'list')
  const definition = () => slots.registerFactory(
    { name: 'probe.card', children: { 'probe.card.footer': 'list' }, slots: { a: {}, b: {} } },
    () => null,
  )

  let versions = 0
  const offSub = slots.subscribeFactory('probe.card', () => {
    versions += 1
  })
  const off = definition()
  check('Factory 注册后 children 进声明表（形态正确）', slots.spec('probe.card.footer') === 'list', String(slots.spec('probe.card.footer')))
  check('读得到定义与声明的局部位置', slots.factory('probe.card')?.slots.join(',') === 'a,b', String(slots.factory('probe.card')?.slots.join(',')))
  check('定义注册通知订阅者（版本 +1）', versions === 1 && slots.factoryVersion('probe.card') === 1, `${String(versions)}/${String(slots.factoryVersion('probe.card'))}`)

  let duplicate = null
  try {
    definition()
  } catch (error) {
    duplicate = error
  }
  check('同名第二次注册抛装配错误（人话里带名字）', duplicate instanceof SlotAssemblyError && String(duplicate.message).includes('probe.card'), String(duplicate))
  check('重复注册失败不留下多余的子槽声明', slots.spec('probe.card.footer') === 'list')

  slots.reportFactoryFault('probe.card', 'a', new Error('局部组件炸了'))
  const fault = slots.faults.at(-1)
  check(
    'Factory 故障进同一本故障账（slot 记 factory:<名>），定义不摘除',
    fault?.slot === 'factory:probe.card' && fault?.id === 'a' && slots.factory('probe.card') !== undefined,
    JSON.stringify(fault),
  )

  off()
  check('卸载后定义消失、children 递归 collapse', slots.factory('probe.card') === undefined && slots.spec('probe.card.footer') === undefined, String(slots.spec('probe.card.footer')))
  check('定义卸载也通知订阅者', versions === 2, String(versions))

  const offAgain = definition()
  check('卸载后同一个名字可以重新注册', slots.factory('probe.card') !== undefined)
  offAgain()
  offSub()
}

// ── 9. 设置回执的结构化载荷（宿主发了，壳不能丢）─────────────────────────────────
// 这一批的教训：`runSettingAction` 的回执除了 `notice` 还带 `data`（配对码 / 发布页链接），
// 旧界面据此弹「手机连接」弹窗、打开浏览器；壳第一版只读了 `notice`，于是点「连接手机」
// 只出一行说明、二维码根本不出现——用户看到的就是「点了没反应」（配对码其实已经签发，
// 而且每次点都会作废上一张，人却永远看不见）。
//
// 所以这里钉一条**对着契约**的断言：`SettingsMutationOk.data` 联合里出现的每一种 `kind`，
// 壳的设置插件源码里都必须有出口。契约将来加一种载荷而壳没跟上，这条当场红——比下次靠
// 用户截图报障强。最后再查一遍**产物**：源码修了但没重建，跑在用户机器上的还是旧界面。
console.log('\n[9] 设置回执的结构化载荷')
{
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const contractText = readFileSync(join(repoRoot, 'src', 'contract.ts'), 'utf8')
  const interfaceBody = (name) =>
    new RegExp(`interface ${name} \\{[\\s\\S]*?\\n\\}`).exec(contractText)?.[0] ?? ''
  const okBlock = interfaceBody('SettingsMutationOk')
  const payloadNames = [...okBlock.matchAll(/data\?:\s*([A-Za-z| ]+)/g)]
    .flatMap((match) => match[1].split('|').map((piece) => piece.trim()))
    .filter((piece) => piece !== '')
  check('从契约读到了 SettingsMutationOk.data 的载荷类型', payloadNames.length > 0, okBlock)
  const kinds = payloadNames.map((name) => ({
    name,
    kind: /kind:\s*'([a-z-]+)'/.exec(interfaceBody(name))?.[1] ?? '',
  }))
  check(
    '每种载荷都带一个 kind 判别位（壳按它对出口）',
    kinds.length > 0 && kinds.every((item) => item.kind !== ''),
    JSON.stringify(kinds),
  )

  const settingsDir = join(repoRoot, 'ui-shell', 'src', 'plugins', 'settings')
  const sources = readdirSync(settingsDir)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => readFileSync(join(settingsDir, file), 'utf8'))
    .join('\n')
  /**
   * 一种载荷的「出口」长什么样：对该 `kind` 的**正向**分派。
   *
   * 为什么不能只查字符串在不在：`!== '<kind>'`（「宿主没给这份数据」的兜底分支）或
   * 一个同名 CSS 类（`pair-code-row`）都能满足「出现过」这种松断言，而它们都不是出口——
   * 收紧成「比较时不带否定」「或 case 标签」两种正向写法。
   */
  const outletFor = (kind) =>
    new RegExp(`kind\\s*={2,3}\\s*['"]${kind}['"]`).test(sources) ||
    new RegExp(`case\\s*['"]${kind}['"]\\s*:`).test(sources)
  const unhandled = kinds.filter((item) => !outletFor(item.kind))
  check(
    '壳的设置插件对每一种载荷都有正向出口',
    unhandled.length === 0,
    unhandled.map((item) => item.kind).join(','),
  )
  // 配对码是「要一直看得见」的那种载荷：出口必须是弹窗（码 + 二维码 + 倒计时），
  // 不能退化成一句一闪就没的行内说明。
  check('配对码载荷交给弹窗（不是一行说明）', sources.includes('<PairModal') && outletFor('pair-code'))

  // 弹窗里那两行读数的版式契约：配对码行与可扫地址行都**整行居中**（用户点名的）。
  // 地址行原来借的是设置页 info 行的版式（「值靠右、动作贴行尾」），且它那句
  // `white-space: normal` 挂在 `.pair-url .mono` 上——类数比 `.setting-info > span:first-child`
  // 少一档、一直没生效，长地址会被省略号截掉（地址里带着配对码，截了就没法照着输）。
  const viewsCss = readFileSync(join(repoRoot, 'ui-shell', 'src', 'legacy', 'views.css'), 'utf8')
  const cssBlock = (pattern) => new RegExp(`\\n${pattern} \\{[\\s\\S]*?\\n\\}`).exec(viewsCss)?.[0] ?? ''
  const urlBlock = cssBlock('\\.pair-url')
  const urlTextBlock = cssBlock('\\.pair-url-text')
  check(
    '可扫地址行整行居中（不再走 info 行的「值靠右」）',
    urlBlock.includes('justify-content: center') && urlBlock.includes('text-align: center'),
    urlBlock,
  )
  check(
    '可扫地址能折行、不截断（长地址要照着输进手机）',
    sources.includes('pair-url-text') && urlTextBlock.includes('white-space: normal'),
    urlTextBlock,
  )

  const bundleFile = join(uiPluginsDir(), 'settings', 'client.js')
  if (!existsSync(bundleFile)) {
    console.log('  SKIP  设置插件产物不在——先跑 pnpm -C ui-shell build')
  } else {
    const bundle = readFileSync(bundleFile, 'utf8')
    const outletInBundle = (kind) =>
      new RegExp(`kind\\s*={2,3}\\s*['"]${kind}['"]`).test(bundle) ||
      new RegExp(`case\\s*['"]${kind}['"]\\s*:`).test(bundle)
    const missing = kinds.filter((item) => !outletInBundle(item.kind))
    check(
      '设置插件产物里带着每一种载荷的出口（改完壳要重建）',
      missing.length === 0,
      missing.map((item) => item.kind).join(','),
    )
    check(
      '设置插件产物里带着配对弹窗（画得出二维码的那张）',
      bundle.includes('pair-card') && bundle.includes('pair-qr-img') && outletInBundle('pair-code'),
    )
  }
}

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
