/**
 * 界面数据通道（宿主 → 壳）的协议测试：帧序号不变量、重连补帧、全量帧广播、心跳/错误/上限。
 *
 * 为什么单开一份（而不是塞进 `ui-plugin-test.mjs`）：这一层出问题的形状都是「界面某个数字
 * 不动了，而且不报错」，只能靠钉死协议语义的断言来发现。断言钉在五件事上：
 *
 *   1. `lib/ui/frames.js` 的三条序号不变量：首帧必须全量、回退帧丢弃、增量跳号抛可识别错误；
 *   2. **断线期间的变化不能丢**：一条连接都没有时不造帧，重连时 `resume(after)` 返回的是
 *      空数组（不是 null），必须靠 `missedWhileIdle` 补一帧全量；
 *   3. **全量帧是全体共用的**：hub 的 diff 基准只有一份，新连接引发的全量帧若不广播给
 *      老连接，老标签页会永久少条目；
 *   4. 心跳、造帧失败要报错（日志 + `event: error`）、连接数上限；
 *   5. 慢客户端（从不读响应）连续多帧写不进时被断开，而不是把帧堆在宿主内存里。
 *
 * 隔离：HOME / USERPROFILE / DSC_HOME 全换成临时目录，所有服务与文件都在临时目录里，
 * 跑完删干净——真实 `~/.dsc` 一个字节都不写。
 *
 * 用法：npx tsc -p tsconfig.json && node scripts/ui-events-test.mjs
 *
 * @module dsc/scripts/ui-events-test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-ui-events-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
delete process.env.DSC_UI_SERVER
delete process.env.DSC_UI_ASSETS
delete process.env.DSC_UI_PORT

const { applyHostFrame, HostFrameError, HostFrameGapError } = await import('../lib/ui/frames.js')
const { RemoteFrameHub } = await import('../lib/core/remote/frames.js')
const { createUiEvents } = await import('../lib/core/ui-events.js')
const { createUiServer } = await import('../lib/core/ui-server.js')

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'dsc-ui-events-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询等一个条件成立；超时就返回它当下（多半是 false）的值。 */
async function waitFor(condition, timeoutMs = 1500, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await sleep(stepMs)
  }
  return condition()
}

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

/** 发一个 HTTP 请求（要自定义 Host 头、Cookie 与请求体，所以用 node:http）。 */
function http(method, port, path, headers = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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

/** 假宿主：一份会变的快照 + 手动触发「宿主变了」的入口。 */
function makeHost(text = (tick) => `第 ${tick} 帧`) {
  let tick = 0
  const subscribers = []
  return {
    get tick() {
      return tick
    },
    set tick(next) {
      tick = next
    },
    snapshot: () => ({
      sessionId: 'sess-1',
      tick,
      entries: [{ id: 1, kind: 'user', text: text(tick) }],
      liveEntries: [],
    }),
    subscribe: (onChange) => {
      subscribers.push(onChange)
      return () => {
        const at = subscribers.indexOf(onChange)
        if (at >= 0) subscribers.splice(at, 1)
      }
    },
    notify: () => {
      for (const notify of [...subscribers]) notify()
    },
  }
}

let treeSeq = 0
/** 起一个真界面服务（带数据通道），返回端口、Cookie 与通道句柄。 */
async function startServer({ host, ...eventsOptions }) {
  const assetsDir = makeTree(`events-assets-${String(++treeSeq)}`, {
    'index.html': '<!doctype html><html><body>壳</body></html>',
  })
  const pluginsDir = makeTree(`events-plugins-${String(treeSeq)}`, {
    'manifest.json': JSON.stringify({ version: 1, plugins: [] }),
  })
  const events = createUiEvents({
    snapshot: host.snapshot,
    invoke: async (method, args) => ({ method, args }),
    methods: ['ping'],
    hello: () => ({ protocolVersion: 1, methods: ['ping'], host: { name: 'Muse Code', version: 'test' } }),
    subscribe: host.subscribe,
    log: () => {},
    ...eventsOptions,
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
  return {
    events,
    port: server.port,
    cookie,
    close: async () => {
      events.stop()
      await server.close()
    },
  }
}

/** 开一条 SSE 连接，收一小段文本。 */
function sseOpener(port) {
  return async (headers = {}) => {
    const state = { text: '' }
    const req = request(
      { host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          state.text += chunk
        })
      },
    )
    // 主动断开时 socket 可能报 ECONNRESET：这里吞掉，别让它把测试进程带走
    req.on('error', () => {})
    req.end()
    await sleep(120)
    return { state, close: () => req.destroy() }
  }
}

/** 把 SSE 文本拆成帧对象（只取 `event: frame` 的 data）。 */
function readFrames(text) {
  const out = []
  for (const block of text.split('\n\n')) {
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (event === 'frame' && data !== '') out.push(JSON.parse(data))
  }
  return out
}

/** 模拟壳：把收到的帧按序并起来。缺口/认不出时返回带 failed 的标记（断言会报出来）。 */
function settle(text) {
  try {
    return readFrames(text).reduce((state, frame) => applyHostFrame(state, frame), null)
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
}

// ── 1. 帧归并的序号不变量（P1-3） ───────────────────────────────────────────────
console.log('\n[1] 帧归并的序号不变量')
{
  const hub = new RemoteFrameHub()
  const snap = (text) => ({ sessionId: 's-1', entries: [{ id: 1, kind: 'user', text }], liveEntries: [] })
  const full = JSON.parse(hub.build(snap('甲'), true).text)
  const delta = JSON.parse(hub.build(snap('乙'), false).text)

  let firstDelta = null
  try {
    applyHostFrame(null, delta)
  } catch (error) {
    firstDelta = error
  }
  check('第一帧是增量帧时当场报错', firstDelta instanceof HostFrameError, String(firstDelta))
  check(
    '报错说清是「首帧必须全量」这条规则',
    firstDelta instanceof HostFrameError && firstDelta.message.includes('全量'),
    firstDelta === null ? '' : firstDelta.message,
  )
  check('第一帧是全量帧时成功', applyHostFrame(null, full).entries.length === 1)

  const state = applyHostFrame(null, full)
  check('回退帧被丢弃（返回原状态）', applyHostFrame(state, { ...full, seq: full.seq - 1 }) === state)
  check('重复帧被丢弃（返回原状态）', applyHostFrame(state, { ...full }) === state)

  let gap = null
  try {
    applyHostFrame(state, { type: 'delta', full: false, seq: state.seq + 5, meta: {}, added: [], updated: [], removedIds: [], liveEntries: [] })
  } catch (error) {
    gap = error
  }
  check('增量跳号抛可识别的 HostFrameGapError', gap instanceof HostFrameGapError, String(gap))
  check('缺口错误仍是 HostFrameError（只判「帧有问题」的调用方不必改）', gap instanceof HostFrameError)

  const jumped = applyHostFrame(state, { ...full, seq: state.seq + 9 })
  check('全量帧跳号不算缺口（它自带完整状态）', jumped.seq === state.seq + 9, String(jumped.seq))
  check('全量帧跳号之后接着收增量也认（游标已对齐）', applyHostFrame(jumped, { ...delta, seq: jumped.seq + 1 }).seq === jumped.seq + 1)
}

// ── 2. 断线期间的变化不许丢（P0-1） ─────────────────────────────────────────────
console.log('\n[2] 一条连接都没有的期间发生的变化（P0-1）')
{
  const host = makeHost()
  const harness = await startServer({ host, throttleMs: 20 })
  const open = sseOpener(harness.port)

  const first = await open({ cookie: harness.cookie })
  const firstFrames = readFrames(first.state.text)
  check('接上先给一帧全量', firstFrames.length === 1 && firstFrames[0].full === true, first.state.text.slice(0, 120))
  check('全量帧带 seq', typeof firstFrames[0]?.seq === 'number')
  const lastSeq = firstFrames[0].seq

  first.close()
  check('客户端断开后宿主摘掉这条连接', await waitFor(() => harness.events.clients === 0), `clients=${String(harness.events.clients)}`)

  // 一条连接都没有的时候宿主变了一次：这时不造帧，于是 hub 的 seq 不前进，
  // 重连时 resume(lastSeq) 返回的是空数组——只判 null 的实现会一帧都不补。
  host.tick = 1
  host.notify()
  await sleep(80)

  const back = await open({ cookie: harness.cookie, 'last-event-id': String(lastSeq) })
  const backFrames = readFrames(back.state.text)
  check(
    '重连带 last-event-id 时补到的是全量帧（不是「补了个空数组」）',
    backFrames.length === 1 && backFrames[0].full === true,
    back.state.text.slice(-200),
  )
  check('补的这一帧是最新状态（断线期间的变化补上了）', backFrames[0]?.entries?.[0]?.text === '第 1 帧', JSON.stringify(backFrames))
  check(
    '空转期间确实没造帧（seq 只前进一格）',
    backFrames[0]?.seq === lastSeq + 1,
    `lastSeq=${String(lastSeq)} got=${String(backFrames[0]?.seq)}`,
  )
  check('壳把这一帧并进去就是最新状态', settle(back.state.text)?.entries?.[0]?.text === '第 1 帧')

  back.close()
  await harness.close()
}

// ── 3. 全量帧必须广播给全体（P0-2） ─────────────────────────────────────────────
console.log('\n[3] 新连接引发的全量帧要广播给全体（P0-2）')
{
  const host = makeHost()
  // 节流窗口拉长到 400 毫秒：这样「宿主变了但还没进帧流」这段一定存在，
  // 新连接正是在这个窗口里插进来的（现实里就是一个新标签页刚被打开）。
  const harness = await startServer({ host, throttleMs: 400 })
  const open = sseOpener(harness.port)

  const a = await open({ cookie: harness.cookie })
  const b = await open({ cookie: harness.cookie })
  check('两条连接各自拿到全量帧', readFrames(a.state.text).at(-1)?.full === true && readFrames(b.state.text).at(-1)?.full === true)

  host.tick = 1
  host.notify()
  // 趁节流没到点，第三个连接插进来：它接不上缓冲，宿主会造一帧全量
  const c = await open({ cookie: harness.cookie })
  const broadcast = readFrames(c.state.text).at(-1)
  check('新连接拿到的这一帧是全量', broadcast?.full === true, JSON.stringify(broadcast)?.slice(0, 120))
  check('这一帧带着刚发生的变化', broadcast?.entries?.[0]?.text === '第 1 帧', JSON.stringify(broadcast?.entries))

  // 等节流那一帧真的到点（它现在算出来是「相对新基准没有变化」）
  await sleep(700)
  check(
    '老连接也收到了那一帧全量（帧号一模一样）',
    readFrames(a.state.text).some((frame) => frame.seq === broadcast.seq && frame.full === true),
    readFrames(a.state.text).map((frame) => frame.seq).join(','),
  )
  check(
    '另一个老连接同样收到了',
    readFrames(b.state.text).some((frame) => frame.seq === broadcast.seq && frame.full === true),
    readFrames(b.state.text).map((frame) => frame.seq).join(','),
  )

  for (const [name, client] of [['A', a], ['B', b], ['C', c]]) {
    const state = settle(client.state.text)
    check(`${name} 的最终状态是最新的（条目没丢）`, state?.entries?.[0]?.text === '第 1 帧', JSON.stringify(state?.entries ?? state))
  }
  check(
    '两个老连接的最终状态逐字节一致',
    JSON.stringify(settle(a.state.text)?.entries) === JSON.stringify(settle(b.state.text)?.entries),
    JSON.stringify(settle(a.state.text)),
  )
  check('三条连接都还在（没有谁被踢掉）', harness.events.clients === 3, String(harness.events.clients))

  a.close()
  b.close()
  c.close()
  await harness.close()
}

// ── 4. 心跳、造帧失败、连接上限 ────────────────────────────────────────────────
console.log('\n[4] 心跳、错误帧、连接上限')
{
  const host = makeHost()
  const logs = []
  let snapshotOk = true
  const brokenSnapshot = { sessionId: 'sess-1', tick: 9, entries: 3, liveEntries: [] } // entries 不是数组 → 造帧会抛
  const harness = await startServer({
    host: {
      ...host,
      snapshot: () => (snapshotOk ? host.snapshot() : brokenSnapshot),
    },
    throttleMs: 20,
    heartbeatMs: 60,
    maxClients: 3,
    log: (line) => logs.push(line),
  })
  const open = sseOpener(harness.port)

  const a = await open({ cookie: harness.cookie })
  check('流的 retry 是 3000 毫秒（500 会打成重连风暴）', a.state.text.includes('retry: 3000'), a.state.text.slice(0, 40))
  check('心跳注释行按时到达', await waitFor(() => a.state.text.includes(': keep-alive'), 1200), a.state.text.slice(-60))

  snapshotOk = false
  host.tick = 1
  host.notify()
  await sleep(150)
  check('造帧失败给页面发 event: error（不再静默吞掉）', a.state.text.includes('event: error'), a.state.text.slice(-240))
  check('错误事件里带得出原因', /event: error\ndata: \{"error":".+"\}/.test(a.state.text), a.state.text.slice(-240))
  check('造帧失败记了日志', logs.some((line) => line.includes('造帧失败')), logs.join(' | '))
  check('造帧失败不会把已经连上的页面弄断', harness.events.clients === 1, String(harness.events.clients))

  const errorsSoFar = (a.state.text.match(/event: error/g) ?? []).length
  host.tick = 2
  host.notify()
  await sleep(150)
  check(
    '同一个原因只报一次（不刷屏）',
    (a.state.text.match(/event: error/g) ?? []).length === errorsSoFar,
    `${String(errorsSoFar)} → ${String((a.state.text.match(/event: error/g) ?? []).length)}`,
  )

  snapshotOk = true
  host.tick = 3
  host.notify()
  await sleep(150)
  check('快照恢复正常后继续推帧', readFrames(a.state.text).some((frame) => JSON.stringify(frame).includes('第 3 帧')), a.state.text.slice(-240))

  const b = await open({ cookie: harness.cookie })
  const c = await open({ cookie: harness.cookie })
  check('上限之内还能连（第 2、3 条）', harness.events.clients === 3, String(harness.events.clients))
  const denied = await http('GET', harness.port, '/api/events', { cookie: harness.cookie })
  check('超上限回 503', denied.status === 503, String(denied.status))
  check('超限记了日志', logs.some((line) => line.includes('上限')), logs.join(' | '))
  check('被拒绝的连接没有占住名额', harness.events.clients === 3, String(harness.events.clients))

  a.close()
  b.close()
  c.close()
  await harness.close()
}

// ── 5. 慢客户端被断开（写背压） ────────────────────────────────────────────────
console.log('\n[5] 慢客户端不把帧堆在宿主内存里（背压）')
{
  const host = makeHost((tick) => `第 ${tick} 帧 ${'x'.repeat(2 * 1024 * 1024)}`)
  const harness = await startServer({ host, throttleMs: 5, heartbeatMs: 60_000 })
  const open = sseOpener(harness.port)

  const watcher = await open({ cookie: harness.cookie })
  check('正常客户端已经登记', harness.events.clients === 1, String(harness.events.clients))

  // 一条只发请求、从不读响应的连接：它的写缓冲一定会满
  const slow = connect(harness.port, '127.0.0.1')
  await new Promise((resolve) => slow.once('connect', resolve))
  slow.on('error', () => {})
  slow.pause()
  slow.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${String(harness.port)}\r\nCookie: ${harness.cookie}\r\n\r\n`)
  await sleep(150)
  check('慢客户端也被登记了', harness.events.clients === 2, String(harness.events.clients))

  for (let i = 0; i < 6; i += 1) {
    host.tick = i + 1
    host.notify()
    // 间隔给足：正常客户端能排空写缓冲（所以它不该被误伤），慢客户端永远排不空
    await sleep(120)
  }
  check(
    '连续多帧写不进就断开它（不再无限堆帧）',
    await waitFor(() => harness.events.clients === 1, 3000),
    `clients=${String(harness.events.clients)}`,
  )
  check('正常客户端没被误伤', harness.events.clients === 1, String(harness.events.clients))

  slow.destroy()
  watcher.close()
  await harness.close()
}

rmSync(work, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
const total = passed + failures
console.log(failures === 0 ? `\n${String(total)} 条断言全部通过` : `\n${String(failures)}/${String(total)} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
