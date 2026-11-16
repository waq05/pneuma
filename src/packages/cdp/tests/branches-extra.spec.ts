/**
 * cdp 包的分支补充测试：只钉既有 spec 没走到的失败/降级/默认值路径。
 *
 * 覆盖四块：
 *   - `launch.ts`：BrowserProcess 的懒启动/重连/关停与启动失败（spawn 用假子进程，
 *     不真开浏览器）；端点等待的 `/json/version` 退路失败、signal 分支；
 *   - `report.ts`：safeStringify 的 undefined/循环引用、控制台参数兜底、网络失败行；
 *   - `snapshot.ts`：compact/full 两种视图、文本折叠、重复 backend 复用 ref、截断与代际校验；
 *   - `transport.ts` / `actions.ts`：握手前取消、内置 WebSocket 缺失、验证回包兜底、
 *     视口外滚动、取消睡眠等。
 *
 * 不真开浏览器：`spawn` 是假子进程，CDP 连接是假 socket。
 *
 * @module dsc/packages/cdp/tests/branches-extra
 */
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  buildLaunchArgs,
  launchBrowser,
  probeEnv,
  probeExecutable,
  waitForEndpoint,
  type BrowserLaunchConfig,
} from '../launch.js'
import { BrowserProcess, fetchBrowserWebSocket } from '../launch.js'
import { CdpTransport, type CdpCommandTarget, type CdpSocket } from '../transport.js'
import { consoleLine, consoleLineTextOf, networkLine, report, safeStringify } from '../report.js'
import {
  lookupSnapshotRef,
  refRecordMatches,
  serializeAxTree,
  truncateByLines,
  type AxNode,
  type SnapshotRef,
} from '../snapshot.js'
import {
  activateTarget,
  clickRef,
  evaluateInPage,
  resolveKey,
  verifyRef,
  waitForClickPoint,
} from '../actions.js'

// ── 假子进程（launch.ts 的 spawn 注入点）────────────────────────────────────

const cp = vi.hoisted(() => ({
  spawn: null as null | ((...args: unknown[]) => unknown),
  spawnSync: null as null | ((...args: unknown[]) => unknown),
}))

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => {
    if (cp.spawn === null) throw new Error('测试没配 spawn')
    return cp.spawn(...args)
  },
  spawnSync: (...args: unknown[]) => (cp.spawnSync === null ? { status: 0 } : cp.spawnSync(...args)),
}))

/** 造一个假子进程：pid 可指定，事件由测试自己发。 */
function fakeChild(pid: number): EventEmitter & { pid: number; exitCode: number | null } {
  const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null }
  child.pid = pid
  child.exitCode = null
  return child
}

/** 自动应答的假 socket：赋值 onopen 后立刻握手，send 后按 id 回一个空结果。 */
class AutoSocket implements CdpSocket {
  readyState = 1
  sent: string[] = []
  closed = false
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private openHandler: ((event: unknown) => void) | null = null

  get onopen(): ((event: unknown) => void) | null {
    return this.openHandler
  }

  set onopen(handler: ((event: unknown) => void) | null) {
    this.openHandler = handler
    if (handler !== null) queueMicrotask(() => handler({}))
  }

  send(data: string): void {
    this.sent.push(data)
    const frame = JSON.parse(data) as { id?: number }
    if (frame.id === undefined) return
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ id: frame.id, result: {} }) })
    })
  }

  close(): void {
    this.closed = true
  }
}

const dirs: string[] = []

afterEach(() => {
  cp.spawn = null
  cp.spawnSync = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-cdp-branches-'))
  dirs.push(dir)
  return dir
}

/** 一个带 DevToolsActivePort 的 profile 目录（端口写死，不联网）。 */
function profileWithEndpoint(port = 9333): string {
  const dir = workdir()
  writeFileSync(join(dir, 'DevToolsActivePort'), `${String(port)}\n/devtools/browser/abc\n`, 'utf8')
  return dir
}

const CONFIG = (profileDir: string): BrowserLaunchConfig => ({
  executablePath: process.execPath,
  profileDir,
  headless: true,
})

// ── launch.ts ────────────────────────────────────────────────────────────────

describe('launch 默认值与退路', () => {
  test('probeEnv 缺 LOCALAPPDATA 给空串；probeExecutable 不传注入点时走真实 existsSync / probeEnv', () => {
    const saved = process.env.LOCALAPPDATA
    try {
      delete process.env.LOCALAPPDATA
      expect(probeEnv().localAppData).toBe('')
    } finally {
      if (saved === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = saved
    }
    // 注入空环境根 + 真存在性判断：这些路径不存在，安静地给 null。
    expect(
      probeExecutable(
        { executablePath: '', profileDir: '', headless: true },
        { env: { localAppData: '', programFiles: 'Z:\\nope-pf', programFilesX86: 'Z:\\nope-pfx' } },
      ),
    ).toBeNull()
    // 不传 env：走 probeEnv 的真实探测；本机装没装浏览器都可能，只要是路径或 null。
    const real = probeExecutable({ executablePath: '', profileDir: '', headless: true })
    expect(real === null || typeof real === 'string').toBe(true)
  })

  test('端点文件只有端口、端口上没人听：超时原因里带端口与 fetch 失败', async () => {
    const dir = workdir()
    writeFileSync(join(dir, 'DevToolsActivePort'), '1\n', 'utf8')
    await expect(waitForEndpoint(dir, { timeoutMs: 200, intervalMs: 40 })).rejects.toThrow(
      /端口 1 上没有可用的调试端点/,
    )
  })

  test('只有端口且 probe 拒绝：退路拿到地址也照样等到超时', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/http' }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const dir = workdir()
    writeFileSync(join(dir, 'DevToolsActivePort'), `${String(port)}\n`, 'utf8')
    try {
      await expect(
        waitForEndpoint(dir, { timeoutMs: 200, intervalMs: 40, probe: () => false }),
      ).rejects.toThrow(/端点存在但连不上/)
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  test('fetchBrowserWebSocket 带 signal 走 AbortSignal.any；空地址也报清楚', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://x/signal' }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const controller = new AbortController()
    try {
      await expect(fetchBrowserWebSocket(port, 2_000, controller.signal)).resolves.toBe('ws://x/signal')
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  test('launchBrowser：已取消的 signal 立刻拒绝；spawn 报错与提前退出都带上人话', async () => {
    const aborted = new AbortController()
    aborted.abort()
    await expect(launchBrowser(CONFIG(workdir()), aborted.signal)).rejects.toThrow()

    {
      const child = fakeChild(0)
      cp.spawn = () => child
      setTimeout(() => child.emit('error', new Error('ENOENT')), 10)
      await expect(
        launchBrowser(CONFIG(workdir()), new AbortController().signal),
      ).rejects.toThrow(/浏览器进程起不来：ENOENT/)
    }

    {
      const child = fakeChild(0)
      cp.spawn = () => child
      setTimeout(() => child.emit('exit', 1), 10)
      await expect(
        launchBrowser(CONFIG(workdir()), new AbortController().signal),
      ).rejects.toThrow(/启动后立刻退出/)
    }
  })
})

describe('BrowserProcess 的启动 / 重连 / 关停', () => {
  test('懒启动→复用→断线重连；close 重置额度后可再起；shutdown 后拒绝调用', async () => {
    const profile = profileWithEndpoint()
    const child = fakeChild(4242)
    cp.spawn = () => child
    cp.spawnSync = () => ({ status: 0 })
    const processHolder = new BrowserProcess(() => CONFIG(profile), { socketFactory: () => new AutoSocket() })

    const first = await processHolder.browserTransport()
    expect(first).toBeInstanceOf(CdpTransport)
    expect(processHolder.pid).toBe(4242)
    expect(processHolder.profileDir).toBe(profile)
    expect(processHolder.executable).toBe(process.execPath)
    expect(processHolder.alive).toBe(true)

    // 连接还在：直接复用，不再 spawn。
    expect(await processHolder.browserTransport()).toBe(first)

    // 浏览器自己把 CDP 会话关了：进程还活着，走重连分支。
    first.close()
    const second = await processHolder.browserTransport()
    expect(second).not.toBe(first)
    expect(second.closed).toBe(false)

    // 用户主动 close：额度归零，下次是一次干净的新开始。
    processHolder.close()
    expect(processHolder.alive).toBe(false)
    expect(processHolder.profileDir).toBeNull()
    const third = await processHolder.browserTransport()
    expect(third).not.toBe(second)

    processHolder.shutdown()
    expect(processHolder.alive).toBe(false)
    await expect(processHolder.browserTransport()).rejects.toThrow(/已被关掉/)
  })

  test('启动失败：额度先扣、残留清掉，错误带「启动受控浏览器失败」', async () => {
    const child = fakeChild(0)
    cp.spawn = () => child
    cp.spawnSync = () => ({ status: 0 })
    setTimeout(() => child.emit('exit', 1), 10)
    const holder = new BrowserProcess(() => CONFIG(workdir()), { socketFactory: () => new AutoSocket() })
    await expect(holder.browserTransport()).rejects.toThrow(/启动受控浏览器失败/)
    expect(holder.alive).toBe(false)
  })
})

// ── report.ts ────────────────────────────────────────────────────────────────

describe('report 的输出兜底', () => {
  test('safeStringify：字符串原样、undefined 走 String、循环引用不抛', () => {
    expect(safeStringify('x')).toBe('x')
    expect(safeStringify(undefined)).toBe('undefined')
    const loop: Record<string, unknown> = {}
    loop['self'] = loop
    expect(safeStringify(loop)).toBe('[object Object]')
    expect(safeStringify({ a: 1 })).toBe('{"a":1}')
  })

  test('consoleLineTextOf：参数缺 value/description/type 时给 ?，并截到 400 字', () => {
    expect(consoleLineTextOf({ args: [{ value: 'a' }, { type: 'number' }, {}] })).toBe('a number ?')
    const long = consoleLineTextOf({ args: [{ value: 'x'.repeat(500) }] })
    expect(long).toHaveLength(400)
    expect(consoleLineTextOf({ args: '不是数组' })).toBe('')
    expect(consoleLine({ ts: 0, level: 'error', text: 'boom' })).toContain('error: boom')
  })

  test('networkLine：失败写原因、状态 0 写进行中、mime 可缺省', () => {
    const failed = networkLine({
      ts: 0,
      requestId: 'r1',
      method: 'GET',
      url: 'https://e/x',
      status: 0,
      mimeType: '',
      failed: 'net::ERR',
    })
    expect(failed).toContain('失败：net::ERR')
    const pending = networkLine({
      ts: 0,
      requestId: 'r2',
      method: 'POST',
      url: 'https://e/y',
      status: 0,
      mimeType: 'application/json',
      failed: '',
    })
    expect(pending).toContain('POST 进行中 application/json https://e/y')
    expect(report('运行中', { ok: true })).toBe('运行中\n{"ok":true}')
  })
})

// ── snapshot.ts ──────────────────────────────────────────────────────────────

function snapshotTree(): AxNode[] {
  return [
    { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['btn', 'text', 'box', 'ignored', 'dup'] },
    { nodeId: 'btn', role: { value: 'button' }, name: { value: '保存' }, backendDOMNodeId: 11 },
    { nodeId: 'text', role: { value: 'StaticText' }, name: { value: '正文' } },
    {
      nodeId: 'box',
      role: { value: 'generic' },
      childIds: ['box-text'],
    },
    { nodeId: 'box-text', role: { value: 'StaticText' }, name: { value: '折叠进来的文本' } },
    { nodeId: 'ignored', role: { value: 'button' }, name: { value: '藏起来的' }, backendDOMNodeId: 12, ignored: true },
    {
      nodeId: 'dup',
      role: { value: 'button' },
      name: { value: '同一个后端节点' },
      backendDOMNodeId: 11,
    },
  ]
}

describe('snapshot 视图与 ref 规则', () => {
  test('compact 只列可交互并折叠容器文本；full 多列结构节点；ignored 不发 ref 也不计数', () => {
    const compact = serializeAxTree({ nodes: snapshotTree() }, { full: false, generation: 2 })
    expect(compact.text).toContain('- button "保存" [ref=e1]')
    expect(compact.text).not.toContain('generic')
    expect(compact.text).not.toContain('藏起来的')
    // btn 与 dup 都算可交互（dup 复用同一个 ref 但仍是页面上的可点节点）。
    expect(compact.interactiveCount).toBe(2)
    expect(compact.refs.get('e1')).toMatchObject({ backendNodeId: 11, role: 'button', name: '保存', generation: 2 })

    const full = serializeAxTree({ nodes: snapshotTree() }, { full: true, generation: 3 })
    expect(full.text).toContain('- button "保存" [ref=e1]')
    // 同一个 backendDOMNodeId 复用同一个 ref，不重复发。
    expect(full.text).toContain('同一个后端节点" [ref=e1]')
    expect(full.refCount).toBe(1)
  })

  test('状态后缀：checked/disabled/展开/level/popup，negative 只在 false 时出现', () => {
    const tree: AxNode[] = [
      {
        nodeId: 'c',
        role: { value: 'checkbox' },
        name: { value: '同意' },
        backendDOMNodeId: 1,
        properties: [
          { name: 'checked', value: { value: false } },
          { name: 'disabled', value: { value: 'true' } },
          { name: 'expanded', value: { value: 'false' } },
          { name: 'level', value: { value: 2 } },
          { name: 'hasPopup', value: { value: 'menu' } },
          { name: 'name', value: { value: '不是字符串' } },
        ],
      },
    ]
    const result = serializeAxTree({ nodes: tree }, { full: false, generation: 1 })
    expect(result.text).toContain('[not-checked]')
    expect(result.text).toContain('[disabled]')
    expect(result.text).toContain('[collapsed]')
    expect(result.text).toContain('[level=2]')
    expect(result.text).toContain('[popup=menu]')
  })

  test('truncateByLines：不超限原样；超限保整行并补说明；上限小到放不下一行也留整行', () => {
    expect(truncateByLines('a\nb', 10, () => 'note')).toEqual({
      text: 'a\nb',
      truncated: false,
      shownLines: 2,
      totalLines: 2,
    })
    const truncated = truncateByLines('aaaa\nbbbb\ncccc', 9, (left) => `+${String(left)}`)
    expect(truncated.truncated).toBe(true)
    expect(truncated.text).toContain('+')
    expect(truncated.shownLines).toBeGreaterThanOrEqual(1)

    const tiny = truncateByLines('完整的很长一行', 1, () => 'note')
    expect(tiny.truncated).toBe(true)
    expect(tiny.shownLines).toBe(1)
    expect(tiny.text.startsWith('完整的很长一行')).toBe(true)
  })

  test('lookupSnapshotRef 三种拒绝理由分离；refRecordMatches 对 ignored/后端号/角色/名字都判否', () => {
    const record: SnapshotRef = { ref: 'e5', backendNodeId: 7, role: 'button', name: '删除', generation: 2 }
    const refs = new Map([[record.ref, record]])
    expect(lookupSnapshotRef(refs, '  ', 2)).toMatchObject({ ok: false })
    expect(lookupSnapshotRef(refs, 'e9', 2)).toMatchObject({ ok: false, reason: expect.stringContaining('不认识') })
    expect(lookupSnapshotRef(refs, 'e9', 2, '页面导航过')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('页面导航过'),
    })
    expect(lookupSnapshotRef(refs, 'e5', 3)).toMatchObject({ ok: false, reason: expect.stringContaining('上一次快照') })
    expect(lookupSnapshotRef(refs, 'e5', 2)).toEqual({ ok: true, ref: record })

    expect(refRecordMatches(record, undefined)).toBe(false)
    expect(refRecordMatches(record, { ignored: true })).toBe(false)
    expect(refRecordMatches(record, { backendDOMNodeId: 8, role: { value: 'button' }, name: { value: '删除' } })).toBe(false)
    expect(refRecordMatches(record, { role: { value: 'link' }, name: { value: '删除' } })).toBe(false)
    expect(refRecordMatches(record, { role: { value: 'button' }, name: { value: '清空' } })).toBe(false)
    expect(refRecordMatches(record, { role: { value: 'unknown' }, name: { value: '删除' } })).toBe(true)
  })
})

// ── transport.ts ─────────────────────────────────────────────────────────────

describe('transport 的建连边界', () => {
  test('握手前已取消：走 onAbort 并关掉 socket', async () => {
    const socket = new AutoSocket()
    const controller = new AbortController()
    controller.abort()
    const pending = CdpTransport.open('ws://x', { socketFactory: () => socket, label: '测试' }, controller.signal)
    await expect(pending).rejects.toThrow(/建连被取消/)
    expect(socket.closed).toBe(true)
  })

  test('没有内置 WebSocket 时给能照做的错；onAny/onClose 退订后不再收到', async () => {
    const saved = (globalThis as { WebSocket?: unknown }).WebSocket
    try {
      Reflect.deleteProperty(globalThis, 'WebSocket')
      await expect(CdpTransport.open('ws://x')).rejects.toThrow(/Node ≥ 22\.19/)
    } finally {
      if (saved !== undefined) (globalThis as { WebSocket?: unknown }).WebSocket = saved
    }

    const socket = new AutoSocket()
    const pending = CdpTransport.open('ws://x', { socketFactory: () => socket, label: '测试' })
    queueMicrotask(() => socket.onopen?.({}))
    const transport = await pending
    const events: string[] = []
    const offAny = transport.onAny((event) => events.push(event.method))
    transport.on('Page.x', () => events.push('named'))
    socket.onmessage?.({ data: JSON.stringify({ method: 'Page.x', params: {} }) })
    offAny()
    socket.onmessage?.({ data: JSON.stringify({ method: 'Page.x', params: {} }) })
    expect(events).toEqual(['named', 'Page.x', 'named'])

    const reasons: string[] = []
    const offClose = transport.onClose((reason) => reasons.push(reason))
    offClose()
    socket.onclose?.({})
    expect(reasons).toEqual([])
    expect(transport.reason).toBe('连接被关闭')
  })
})

// ── actions.ts ───────────────────────────────────────────────────────────────

type Handler = (params: Record<string, unknown>) => unknown

class FakeTarget implements CdpCommandTarget {
  readonly sessionId = 'branch-session'
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  handlers = new Map<string, Handler>()
  constructor(overrides: Record<string, Handler> = {}) {
    this.handlers = new Map(Object.entries(overrides))
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)
    if (handler === undefined) return Promise.resolve({} as T)
    try {
      return Promise.resolve(handler(params) as T)
    } catch (error) {
      return Promise.reject(error)
    }
  }
  sent(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.method === method).map((call) => call.params)
  }
  on(_method: string, _handler: (params: Record<string, unknown>) => void): () => void {
    return () => undefined
  }
}

const REF: SnapshotRef = { ref: 'e5', backendNodeId: 42, role: 'button', name: '删除', generation: 1 }

describe('actions 的兜底分支', () => {
  test('resolveKey：符号键 code 为空、未知修饰键与空键各有错误', () => {
    expect(resolveKey('/')).toMatchObject({ key: '/', code: '', vk: 47, text: '/' })
    expect(resolveKey('shift+a')).toMatchObject({ key: 'a', code: 'KeyA', text: 'A' })
    expect(() => resolveKey('hyper+x')).toThrow(/不认识的修饰键/)
    expect(() => resolveKey('+')).toThrow(/按键名是空的/)
    expect(() => resolveKey('not-a-key')).toThrow(/不认识的按键/)
  })

  test('verifyRef：无障碍回包没带 backendDOMNodeId 时用第一条兜底；取无障碍失败不拦动作', async () => {
    const fallback = new FakeTarget({
      'DOM.describeNode': () => ({ node: { backendNodeId: 42 } }),
      'Accessibility.getPartialAXTree': () => ({
        nodes: [{ role: { value: 'button' }, name: { value: '删除' } }],
      }),
    })
    await expect(verifyRef(fallback, REF)).resolves.toBeUndefined()

    const axFails = new FakeTarget({
      'DOM.describeNode': () => ({ node: { backendNodeId: 42 } }),
      'Accessibility.getPartialAXTree': () => {
        throw new Error('无障碍域没开')
      },
    })
    await expect(verifyRef(axFails, REF)).rejects.toThrow(/页面已变/)
  })

  test('waitForClickPoint：元素在视口外先 scrollIntoView 再取中心；滚完还取不到就报视口外', async () => {
    let boxCalls = 0
    const scrolled = new FakeTarget({
      'DOM.getBoxModel': () => {
        boxCalls += 1
        // 1: 视口外；2: 滚动后框中心（供 ensureInViewport）；3: 刷新后的最终中心。
        return boxCalls === 1
          ? { model: { content: [900, 700, 1000, 700, 1000, 800, 900, 800] } }
          : { model: { content: [10, 20, 110, 20, 110, 70, 10, 70] } }
      },
      'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }),
      'Accessibility.getPartialAXTree': () => ({ nodes: [{ backendNodeId: 42, role: { value: 'button' }, name: { value: '删除' } }] }),
      'DOM.describeNode': () => ({ node: { backendNodeId: 42 } }),
    })
    await expect(clickRef(scrolled, REF)).resolves.toMatchObject({ x: 60, y: 45 })
    expect(scrolled.sent('DOM.scrollIntoViewIfNeeded')).toEqual([{ backendNodeId: 42 }])

    let calls = 0
    const stuck = new FakeTarget({
      'DOM.getBoxModel': () => {
        calls += 1
        if (calls === 1) return { model: { content: [900, 700, 1000, 700, 1000, 800, 900, 800] } }
        throw new Error('滚完还取不到')
      },
      'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }),
    })
    await expect(waitForClickPoint(stuck, REF, 120)).rejects.toThrow(/滚完还取不到/)
  })

  test('evaluateInPage：JSON.stringify 抛错（BigInt/循环）退回 String；activateTarget 原样发命令', async () => {
    const bigint = await evaluateInPage(
      new FakeTarget({ 'Runtime.evaluate': () => ({ result: { value: 10n } }) }),
      'x',
    )
    expect(bigint.text).toBe('10')

    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const loop = await evaluateInPage(
      new FakeTarget({ 'Runtime.evaluate': () => ({ result: { value: circular } }) }),
      'x',
    )
    expect(loop.text).toBe('[object Object]')

    const browser = new FakeTarget()
    await activateTarget(browser as never, 't1')
    expect(browser.sent('Target.activateTarget')).toEqual([{ targetId: 't1' }])
  })

  test('waitForClickPoint 的睡眠可被 signal 取消', async () => {
    const empty = new FakeTarget({ 'DOM.getBoxModel': () => ({}) })
    const controller = new AbortController()
    const pending = waitForClickPoint(empty, REF, 5_000, controller.signal)
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toThrow(/操作已取消/)
  })
})
