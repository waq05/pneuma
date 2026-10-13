/**
 * B 波探针：开发态热更（宿主轮询 → 换代 → `event: plugins` 帧）。
 *
 * 起真服务 + 真数据通道 + 真轮询器（`lib/core/ui-hmr.js`），只把「看盘」的时间缩到 120ms：
 *
 *   1. 连接建立即收到一帧 `event: plugins`（当前图；`changed`/`removed` 为空）；
 *   2. 改一个 bundle 的字节 → 等到 `{rev, changed:[id]}` 帧，图里该行 rev 同步变；
 *      旧单资源地址仍 200（上一代保留）、新地址拿新字节；旧/新批 combo 地址同理；
 *   3. **字节没变的改写不推帧**（内容摘要 rev 的门槛：构建重写/touch 不再把整批换装）；
 *   4. `plugins` 帧与快照 `frame` 帧井水不犯河水（帧号/补帧语义不被搅乱）。
 *
 * 用法：npx tsc -p tsconfig.json && node scripts/ui-hmr-test.mjs
 *
 * @module dsc/scripts/ui-hmr-test
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-ui-hmr-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
delete process.env.DSC_UI_SERVER
delete process.env.DSC_UI_ASSETS
delete process.env.DSC_UI_PORT
delete process.env.DSC_UI_HMR

const { createUiServer } = await import('../lib/core/ui-server.js')
const { createUiEvents } = await import('../lib/core/ui-events.js')
const { createUiHmr } = await import('../lib/core/ui-hmr.js')
const { UI_PLUGIN_MANIFEST } = await import('../lib/core/ui-bundles.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
    return
  }
  failures += 1
  console.error(`  FAIL  ${name}${detail === '' ? '' : `（${detail}）`}`)
}

const work = mkdtempSync(join(tmpdir(), 'dsc-ui-hmr-'))
let treeSeq = 0
function makeTree(name, files) {
  const dir = join(work, `${name}-${String(++treeSeq)}`)
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  return dir
}

function http(method, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const assetsDir = makeTree('hmr-assets', { 'index.html': '<!doctype html><html><body>壳</body></html>' })
const pluginsDir = makeTree('hmr-plugins', {
  'manifest.json': JSON.stringify({
    version: 1,
    plugins: [
      { id: 'demo-a', file: 'client.js', platform: 'web', phase: 'early' },
      { id: 'demo-b', file: 'client.js', platform: 'web' },
    ],
  }),
  'demo-a/client.js': 'module.exports={apply(){return "A-old"}}\n',
  'demo-b/client.js': 'module.exports={apply(){return "B-old"}}\n',
})

// 与 webserver 插件同一套接线：通道先建、轮询器后建，帧经 plugins 源广播。
const pluginFrames = { current: null, listeners: new Set() }
const push = (frame) => {
  pluginFrames.current = frame
  for (const listener of [...pluginFrames.listeners]) listener(frame)
}
let snapshotTick = 0
const subscribers = []
const events = createUiEvents({
  snapshot: () => ({ sessionId: 's1', tick: snapshotTick, entries: [], liveEntries: [] }),
  invoke: async () => null,
  methods: [],
  hello: () => ({ protocolVersion: 1, methods: [], host: { name: 'Muse Code', version: 'test' } }),
  subscribe: (onChange) => {
    subscribers.push(onChange)
    return () => {
      const at = subscribers.indexOf(onChange)
      if (at >= 0) subscribers.splice(at, 1)
    }
  },
  plugins: {
    // 与 webserver 插件同一套口径：没有推过帧就给「现取一份当前图」。
    initial: () => pluginFrames.current ?? (() => {
      const graph = server.boot()
      return { rev: graph.rev, changed: [], removed: [], graph }
    })(),
    subscribe: (listener) => {
      pluginFrames.listeners.add(listener)
      return () => pluginFrames.listeners.delete(listener)
    },
  },
  log: () => {},
})
const server = await createUiServer({
  host: { name: 'Muse Code', version: 'test' },
  assetsDir,
  pluginsDir,
  events,
  log: () => {},
})
const hmr = createUiHmr({
  watches: () => [
    ...server.watchRows().map((row) => ({ id: row.id, path: row.path })),
    { id: 'manifest', path: join(pluginsDir, UI_PLUGIN_MANIFEST) },
  ],
  graph: () => server.boot(),
  refresh: () => {
    server.refresh()
  },
  onFrame: push,
  pollIntervalMs: 120,
  log: () => {},
})

const token = new URL(server.url).searchParams.get('token') ?? ''
const handshake = await http('GET', server.port, `/?token=${token}`)
const cookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]

/** 收一条 SSE 流（真连接）。 */
function openSse() {
  const state = { text: '' }
  const req = request({ host: '127.0.0.1', port: server.port, method: 'GET', path: '/api/events', headers: { cookie } }, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      state.text += chunk
    })
  })
  req.on('error', () => {})
  req.end()
  return { state, close: () => req.destroy() }
}

/** 把 SSE 文本按事件名拆开（`plugins` 帧与快照 `frame` 帧分开看）。 */
function readEvents(text, name) {
  const out = []
  for (const block of text.split('\n\n')) {
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (event === name && data !== '') out.push(JSON.parse(data))
  }
  return out
}

/** 轮询等待条件成立（探针用）。 */
async function waitFor(what, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  console.error(`  等待超时：${what}`)
  return false
}

// ── 1. 连接即发当前图 ─────────────────────────────────────────────────────────
console.log('\n[1] 初始帧')
const sse = openSse()
await sleep(200)
const initial = readEvents(sse.state.text, 'plugins')
check('连接建立即收到一帧 plugins', initial.length === 1, `收到 ${String(initial.length)} 帧`)
const graph0 = server.boot()
check('初始帧是当前整图（changed/removed 为空）', initial.length === 1
  && initial[0].rev === graph0.rev && initial[0].changed.length === 0 && initial[0].removed.length === 0)
check('初始帧带 batches（首屏/应用两批）', initial.length === 1 && Array.isArray(initial[0].graph?.batches)
  && initial[0].graph.batches.length === 2, JSON.stringify(initial[0]?.graph?.batches?.map((b) => b.phase)))
check('快照 frame 帧与 plugins 帧是两种事件', readEvents(sse.state.text, 'frame').length >= 1)

const demoA = graph0.entries.find((entry) => entry.id === 'demo-a')
const demoB = graph0.entries.find((entry) => entry.id === 'demo-b')
const oldEarlyCombo = graph0.batches.find((batch) => batch.phase === 'early').url

// ── 2. 改字节 → 一帧换装 ──────────────────────────────────────────────────────
console.log('\n[2] 改字节 → plugins 帧')
const newText = 'module.exports={apply(){return "A-new!"}}\n'
writeFileSync(join(pluginsDir, 'demo-a', 'client.js'), newText)
hmr.pollNow()
const got = await waitFor('changed 含 demo-a 的帧', () =>
  readEvents(sse.state.text, 'plugins').some((frame) => frame.changed.includes('demo-a')))
check('等到一帧 changed:[demo-a]', got)
const frame1 = readEvents(sse.state.text, 'plugins').find((frame) => frame.changed.includes('demo-a'))
const graph1 = server.boot()
const demoA2 = graph1.entries.find((entry) => entry.id === 'demo-a')
check('帧里的图带新 rev', frame1 !== undefined && demoA2.rev !== demoA.rev, `${demoA.rev} → ${demoA2?.rev}`)
check('帧 rev = 新整图 rev', frame1 !== undefined && frame1.rev === graph1.rev)
check('demo-b 不在 changed 里（只换受影响的）', frame1 !== undefined && !frame1.changed.includes('demo-b'))
const newBundle = await http('GET', server.port, `/plugins/demo-a/client.js?rev=${demoA2.rev}`, { cookie })
check('新单资源地址拿新字节', newBundle.status === 200 && newBundle.body === newText, String(newBundle.status))
const oldBundle = await http('GET', server.port, `/plugins/demo-a/client.js?rev=${demoA.rev}`, { cookie })
check('旧单资源地址仍拿旧字节（上一代保留）', oldBundle.status === 200 && oldBundle.body.includes('A-old'), String(oldBundle.status))
const newCombo = graph1.batches.find((batch) => batch.phase === 'early').url
const newComboResp = await http('GET', server.port, `/${newCombo}`, { cookie })
check('新批地址 200 且体里有新字节', newComboResp.status === 200 && newComboResp.body.includes('A-new!'), String(newComboResp.status))
const oldComboResp = await http('GET', server.port, `/${oldEarlyCombo}`, { cookie })
check('旧批地址仍 200 且体里是旧字节（上一代 combo 表）', oldComboResp.status === 200 && oldComboResp.body.includes('A-old'), String(oldComboResp.status))
check('未通告的组合仍 404', (await http('GET', server.port, '/plugins/??demo-b/client.js&rev=' + '0'.repeat(12), { cookie })).status === 404)

// ── 3. 同字节改写不推帧 ───────────────────────────────────────────────────────
console.log('\n[3] 字节没变不推帧')
const framesBefore = readEvents(sse.state.text, 'plugins').length
// 重写同样的字节（mtime 变了、内容没变）：摸它两次，等两轮轮询。
writeFileSync(join(pluginsDir, 'demo-a', 'client.js'), newText)
hmr.pollNow()
await sleep(150)
writeFileSync(join(pluginsDir, 'demo-a', 'client.js'), newText)
hmr.pollNow()
await sleep(300)
const framesAfter = readEvents(sse.state.text, 'plugins').length
check('同字节改写不产生新帧（内容摘要门槛）', framesAfter === framesBefore, `${String(framesBefore)} → ${String(framesAfter)}`)
check('同字节改写不换代：rev 不动', server.boot().entries.find((entry) => entry.id === 'demo-a').rev === demoA2.rev)

// ── 4. 新增/删除插件（清单信号） ──────────────────────────────────────────────
console.log('\n[4] 清单信号')
{
  const manifest = JSON.parse(readFileSync(join(pluginsDir, 'manifest.json'), 'utf8'))
  manifest.plugins.push({ id: 'demo-c', file: 'client.js', platform: 'web' })
  mkdirSync(join(pluginsDir, 'demo-c'), { recursive: true })
  writeFileSync(join(pluginsDir, 'demo-c', 'client.js'), 'module.exports={apply(){return "C"}}\n')
  writeFileSync(join(pluginsDir, 'manifest.json'), JSON.stringify(manifest))
  hmr.pollNow()
  const added = await waitFor('changed 含 demo-c 的帧', () =>
    readEvents(sse.state.text, 'plugins').some((frame) => frame.changed.includes('demo-c')))
  check('新插件进图并推 changed:[demo-c]', added)
  // 删掉 demo-b：同时从清单与磁盘移除。
  const manifest2 = JSON.parse(readFileSync(join(pluginsDir, 'manifest.json'), 'utf8'))
  manifest2.plugins = manifest2.plugins.filter((plugin) => plugin.id !== 'demo-b')
  writeFileSync(join(pluginsDir, 'manifest.json'), JSON.stringify(manifest2))
  rmSync(join(pluginsDir, 'demo-b'), { recursive: true, force: true })
  hmr.pollNow()
  const removed = await waitFor('removed 含 demo-b 的帧', () =>
    readEvents(sse.state.text, 'plugins').some((frame) => frame.removed.includes('demo-b')))
  check('删插件推 removed:[demo-b]', removed)
}

sse.close()
hmr.stop()
events.stop()
await server.close()
rmSync(work, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
