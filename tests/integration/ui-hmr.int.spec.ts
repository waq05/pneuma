/**
 * 开发态热更：宿主轮询 → 换代 → `event: plugins` 帧（迁自 `scripts/ui-hmr-test.mjs`）。
 *
 * ## 被测的是什么
 *
 * 起真服务 + 真数据通道 + 真轮询器（`createUiHmr`），只把「看盘」的间隔压到 120ms：
 *
 * 1. 连接建立即收到一帧 `event: plugins`（当前图；`changed`/`removed` 为空，带 batches），
 *    且它与快照 `frame` 帧是两种事件、互不搅扰（帧号 / 补帧语义不被污染）。
 * 2. 改一个 bundle 的字节 → 等到 `{rev, changed:[id]}` 帧，图里该行 rev 同步变、
 *    帧里的 rev = 新整图 rev、只换受影响的行；旧单资源地址仍拿旧字节（上一代保留）、
 *    新地址拿新字节；旧 / 新批 combo 地址同理；未通告的组合仍 404。
 * 3. **字节没变的改写不推帧**（内容摘要 rev 的门槛：构建重写 / touch 不再把整批换装），
 *    rev 不动。
 * 4. 新增 / 删除插件（目录信号）：加一个目录 → `changed:[demo-c]`；删整个目录 →
 *    `removed:[demo-b]`。
 *
 * ## 落位与隔离
 *
 * 真服务（端口 0）+ 通道先建、轮询器后建（与 webserver 插件同一套接线，帧经 plugins 源
 * 广播）；夹具在临时目录（2.0：根清单只写壳契约版本，插件由各目录的 bundle.json 自述）；
 * 临时 HOME 由 setup 给；`DSC_UI_HMR` 显式删掉。
 *
 * @module dsc/tests/integration/ui-hmr
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { UI_PLUGIN_MANIFEST } from '@pneuma/runtime/core/ui-bundles.js'
import { createUiEvents } from '@pneuma/runtime/core/ui-events.js'
import { createUiHmr } from '@pneuma/runtime/core/ui-hmr.js'
import { createUiServer, type UiServerHandle } from '@pneuma/runtime/core/ui-server.js'

/** 夹具总目录；失败现场留着翻，成功时 afterAll 删。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-hmr-'))

// 探针同款：环境里带了这几个变量会把基线改掉。
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

/** 造一个临时目录树。 */
function makeTree(name: string, files: Record<string, string>): string {
  const dir = join(WORK, name)
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  return dir
}

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function http(method: string, port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

/** 轮询等待条件成立（探针同款 50ms 一拍）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

interface HmrFrame {
  rev: string
  changed: string[]
  removed: string[]
  graph?: { batches?: Array<{ phase?: string }>; entries?: Array<{ id: string; rev: string }> }
}

describe('开发态热更（真轮询器 → plugins 帧）', () => {
  const facts: Record<string, unknown> = {}
  let server: UiServerHandle
  let pluginsDir = ''
  let cookie = ''
  let sse: { state: { text: string }; close: () => void } | null = null
  let hmr: ReturnType<typeof createUiHmr> | null = null
  let events: ReturnType<typeof createUiEvents> | null = null
  let stopAll: (() => Promise<void>) | null = null

  /** 把 SSE 文本按事件名拆开（`plugins` 帧与快照 `frame` 帧分开看）。 */
  function readEvents(text: string, name: string): HmrFrame[] {
    const out: HmrFrame[] = []
    for (const block of text.split('\n\n')) {
      let event = ''
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (event === name && data !== '') out.push(JSON.parse(data) as HmrFrame)
    }
    return out
  }

  beforeAll(async () => {
    const assetsDir = makeTree('hmr-assets', { 'index.html': '<!doctype html><html><body>壳</body></html>' })
    pluginsDir = makeTree('hmr-plugins', {
      // 2.0：根清单只写壳契约版本，插件由各自目录的 bundle.json 自述。
      'manifest.json': JSON.stringify({ version: 1, apiVersion: '2.0.0' }),
      'demo-a/bundle.json': JSON.stringify({ apiVersion: '2.0.0', file: 'client.js', platforms: ['web'], phase: 'early' }),
      'demo-a/client.js': 'module.exports={apply(){return "A-old"}}\n',
      'demo-b/bundle.json': JSON.stringify({ apiVersion: '2.0.0', file: 'client.js', platforms: ['web'] }),
      'demo-b/client.js': 'module.exports={apply(){return "B-old"}}\n',
    })

    // 与 webserver 插件同一套接线：通道先建、轮询器后建，帧经 plugins 源广播。
    const pluginFrames: { current: HmrFrame | null; listeners: Set<(frame: HmrFrame) => void> } = {
      current: null,
      listeners: new Set(),
    }
    const push = (frame: HmrFrame): void => {
      pluginFrames.current = frame
      for (const listener of [...pluginFrames.listeners]) listener(frame)
    }
    let snapshotTick = 0
    const subscribers: Array<() => void> = []
    events = createUiEvents({
      snapshot: () => ({ sessionId: 's1', tick: snapshotTick, entries: [], liveEntries: [] }),
      invoke: async () => null,
      methods: [],
      hello: () => ({ protocolVersion: 1, methods: [], host: { name: 'Pneuma', version: 'test' } }),
      subscribe: (onChange) => {
        subscribers.push(onChange)
        return () => {
          const at = subscribers.indexOf(onChange)
          if (at >= 0) subscribers.splice(at, 1)
        }
      },
      plugins: {
        // 与 webserver 插件同一套口径：没有推过帧就给「现取一份当前图」。
        initial: () =>
          pluginFrames.current ??
          ((): HmrFrame => {
            const graph = server.boot() as unknown as { rev: string }
            return { rev: graph.rev, changed: [], removed: [], graph: server.boot() as never }
          })(),
        subscribe: (listener) => {
          pluginFrames.listeners.add(listener as (frame: HmrFrame) => void)
          return () => pluginFrames.listeners.delete(listener as (frame: HmrFrame) => void)
        },
      },
      log: () => {},
    })
    server = await createUiServer({
      host: { name: 'Pneuma', version: 'test' },
      assetsDir,
      pluginsDir,
      events,
      log: () => {},
    })
    hmr = createUiHmr({
      watches: () => [
        ...server.watchRows().map((row) => ({ id: row.id, path: row.path })),
        // 2.0：新增/删插件体现在产物目录上（根清单不再列插件）。
        { id: 'plugins-dir', path: pluginsDir },
        { id: 'manifest', path: join(pluginsDir, UI_PLUGIN_MANIFEST) },
      ],
      graph: () => server.boot() as never,
      refresh: () => {
        server.refresh()
      },
      onFrame: push,
      pollIntervalMs: 120,
      log: () => {},
    })

    const token = new URL(server.url).searchParams.get('token') ?? ''
    const handshake = await http('GET', server.port, `/?token=${token}`)
    cookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]

    /** 收一条 SSE 流（真连接）。 */
    const openSse = (): { state: { text: string }; close: () => void } => {
      const state = { text: '' }
      const req = request(
        { host: '127.0.0.1', port: server.port, method: 'GET', path: '/api/events', headers: { cookie }, agent: false },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            state.text += chunk
          })
        },
      )
      req.on('error', () => {})
      req.end()
      return { state, close: (): void => {
        req.destroy()
      } }
    }

    // ── 1. 连接即发当前图 ──
    sse = openSse()
    await sleep(200)
    const initial = readEvents(sse.state.text, 'plugins')
    const graph0 = server.boot() as unknown as { rev: string; entries: Array<{ id: string; rev: string }> }
    facts['initialCount'] = initial.length
    facts['initialIsCurrent'] =
      initial.length === 1 && initial[0]?.rev === graph0.rev && initial[0]?.changed.length === 0 && initial[0]?.removed.length === 0
    facts['initialHasBatches'] = initial.length === 1 && Array.isArray(initial[0]?.graph?.batches) && initial[0]?.graph?.batches?.length === 2
    facts['frameEventsExist'] = readEvents(sse.state.text, 'frame').length >= 1

    // 初始代的单资源 rev 与 early 批地址（换装段的「上一代保留」要用）。
    facts['oldRev'] = graph0.entries.find((entry) => entry.id === 'demo-a')?.rev ?? ''
    facts['oldEarlyCombo'] = (graph0 as unknown as { batches: Array<{ phase?: string; url?: string }> }).batches.find(
      (batch) => batch.phase === 'early',
    )?.url ?? ''

    const eventsHandle = events
    const serverHandle = server
    stopAll = async (): Promise<void> => {
      sse?.close()
      hmr?.stop()
      eventsHandle.stop()
      await serverHandle.close()
    }
  })

  afterAll(async () => {
    await (stopAll?.() ?? Promise.resolve())
  })

  test('连接建立即收到一帧 plugins', () => {
    expect(facts['initialCount']).toBe(1)
  })
  test('初始帧是当前整图（changed/removed 为空）', () => {
    expect(facts['initialIsCurrent']).toBe(true)
  })
  test('初始帧带 batches（首屏/应用两批）', () => {
    expect(facts['initialHasBatches']).toBe(true)
  })
  test('快照 frame 帧与 plugins 帧是两种事件', () => {
    expect(facts['frameEventsExist']).toBe(true)
  })

  // ── 2. 改字节 → 一帧换装 ──
  test('改字节 → 等到一帧 changed:[demo-a]，图带新 rev、只换受影响的行', async () => {
    const newText = 'module.exports={apply(){return "A-new!"}}\n'
    writeFileSync(join(pluginsDir, 'demo-a', 'client.js'), newText)
    hmr?.pollNow()
    const got = await waitFor(() => readEvents(sse?.state.text ?? '', 'plugins').some((frame) => frame.changed.includes('demo-a')))
    expect(got, '等到 changed 含 demo-a 的帧').toBe(true)
    const frame1 = readEvents(sse?.state.text ?? '', 'plugins').find((frame) => frame.changed.includes('demo-a'))
    const graph1 = server.boot() as unknown as { rev: string; entries: Array<{ id: string; rev: string }> }
    const demoA1 = graph1.entries.find((entry) => entry.id === 'demo-a')
    expect(demoA1).toBeDefined()
    facts['frameRev'] = frame1?.rev
    facts['graphRev'] = graph1.rev
    facts['demoBNotChanged'] = frame1 !== undefined && !frame1.changed.includes('demo-b')
    facts['newRev'] = demoA1?.rev
    facts['newText'] = newText
  })

  test('帧里的图带新 rev、帧 rev = 新整图 rev', () => {
    expect(facts['frameRev'], String(facts['frameRev'])).toBe(facts['graphRev'])
  })

  test('demo-b 不在 changed 里（只换受影响的）', () => {
    expect(facts['demoBNotChanged']).toBe(true)
  })

  test('新单资源地址拿新字节；旧单资源地址仍拿旧字节（上一代保留）', async () => {
    const newRev = facts['newRev'] as string
    const newBundle = await http('GET', server.port, `/plugins/demo-a/client.js?rev=${newRev}`, { cookie })
    expect(newBundle.status).toBe(200)
    expect(newBundle.body).toBe(facts['newText'] as string)
    // 旧 rev：从换代前的图取（保存在 facts['oldRev'] 由初始帧的图拿）
    const oldRev = facts['oldRev'] as string
    const oldBundle = await http('GET', server.port, `/plugins/demo-a/client.js?rev=${oldRev}`, { cookie })
    expect(oldBundle.status).toBe(200)
    expect(oldBundle.body).toContain('A-old')
  })

  test('新批地址 200 且体里有新字节；旧批地址仍 200 且体里是旧字节；未通告的组合仍 404', async () => {
    const graph1 = server.boot() as unknown as { batches: Array<{ phase?: string; url?: string }> }
    const newCombo = graph1.batches.find((batch) => batch.phase === 'early')?.url ?? ''
    const newComboResp = await http('GET', server.port, `/${newCombo}`, { cookie })
    expect(newComboResp.status).toBe(200)
    expect(newComboResp.body).toContain('A-new!')
    const oldComboResp = await http('GET', server.port, `/${facts['oldEarlyCombo'] as string}`, { cookie })
    expect(oldComboResp.status).toBe(200)
    expect(oldComboResp.body).toContain('A-old')
    expect(
      (await http('GET', server.port, `/plugins/??demo-b/client.js&rev=${'0'.repeat(12)}`, { cookie })).status,
    ).toBe(404)
  })

  // ── 3. 同字节改写不推帧 ──
  test('同字节改写不产生新帧（内容摘要门槛），rev 不动', async () => {
    const framesBefore = readEvents(sse?.state.text ?? '', 'plugins').length
    const sameText = facts['newText'] as string
    // 重写同样的字节（mtime 变了、内容没变）：摸它两次，等两轮轮询。
    writeFileSync(join(pluginsDir, 'demo-a', 'client.js'), sameText)
    hmr?.pollNow()
    await sleep(150)
    writeFileSync(join(pluginsDir, 'demo-a', 'client.js'), sameText)
    hmr?.pollNow()
    await sleep(300)
    const framesAfter = readEvents(sse?.state.text ?? '', 'plugins').length
    expect(framesAfter === framesBefore, `${String(framesBefore)} → ${String(framesAfter)}`).toBe(true)
    const graph = server.boot() as unknown as { entries: Array<{ id: string; rev: string }> }
    expect(graph.entries.find((entry) => entry.id === 'demo-a')?.rev).toBe(facts['newRev'])
  })

  // ── 4. 新增/删除插件（目录信号） ──
  test('新插件进图并推 changed:[demo-c]；删插件推 removed:[demo-b]', async () => {
    mkdirSync(join(pluginsDir, 'demo-c'), { recursive: true })
    writeFileSync(join(pluginsDir, 'demo-c', 'client.js'), 'module.exports={apply(){return "C"}}\n')
    writeFileSync(
      join(pluginsDir, 'demo-c', 'bundle.json'),
      JSON.stringify({ apiVersion: '2.0.0', file: 'client.js', platforms: ['web'] }),
    )
    hmr?.pollNow()
    const added = await waitFor(() => readEvents(sse?.state.text ?? '', 'plugins').some((frame) => frame.changed.includes('demo-c')))
    expect(added).toBe(true)
    // 删掉 demo-b：整个目录移除。
    rmSync(join(pluginsDir, 'demo-b'), { recursive: true, force: true })
    hmr?.pollNow()
    const removed = await waitFor(() => readEvents(sse?.state.text ?? '', 'plugins').some((frame) => frame.removed.includes('demo-b')))
    expect(removed).toBe(true)
  })
})
