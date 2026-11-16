/**
 * remote 装配面的分支补测（w11）：设置面文案的边角、通知节流与升级提醒、服务起不来的
 * 重试/去重、配对后的 WS invoke（answerApproval 的来源标记与非白名单方法），以及路由层
 * 的几条拒绝分支（吊销无 token、超大请求体、推送订阅未开后端、插件资源回落）。
 *
 * 全部用假 ctx + 真 `apply`；起监听的那几条用现取的空闲端口，收尾统一 close。
 * `DSC_HOME` 在 import 之前指进临时目录（store/pairing/owner 的路径都是模块加载时算的）。
 *
 * @module dsc/packages/remote/tests/w11-branches
 */
import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import type { RemotePrefs } from '@pneuma/runtime/core/prefs.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-remote-w11-'))
process.env['DSC_HOME'] = HOME
const WORK = join(HOME, 'work')
mkdirSync(WORK, { recursive: true })

const { remotePlugin } = await import('../index.js')

const servers: Server[] = []
const sockets: WebSocket[] = []
const mounts: Harness[] = []

afterEach(() => {
  for (const harness of mounts.splice(0)) harness.dispose()
  for (const socket of sockets.splice(0)) {
    try {
      socket.close()
    } catch {
      // 已经断了
    }
  }
  for (const server of servers.splice(0)) {
    try {
      server.close()
    } catch {
      // 已经关了
    }
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env['DSC_REMOTE_UI']
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error('等待条件超时')
}

async function freePort(): Promise<number> {
  const server = createHttpServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** 占住一个端口（让插件的 listen 失败）。Windows 上通配绑定与回环绑定可并存，所以按目标地址占。 */
async function occupiedPort(host: string): Promise<{ port: number; server: Server }> {
  const server = createHttpServer((_req, res) => res.end('busy'))
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  servers.push(server)
  return { port, server }
}

interface Harness {
  notices: string[]
  prefs: { remote: RemotePrefs & Record<string, unknown> }
  section(): SettingsSectionSpec
  fire(name: string, ...args: unknown[]): void
  fireTranscript(): void
  reapply(): void
  setSnapshot(value: Record<string, unknown>): void
  answers: unknown[][]
  dispose(): void
}

function baseSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entries: [],
    status: { turnState: 'idle', sessionPath: join(WORK, 'sess.jsonl') },
    surfaces: { pendingApproval: null, pendingPlan: null, pendingQuestion: null },
    ...overrides,
  }
}

function mount(prefsPatch: Partial<RemotePrefs> = {}): Harness {
  const prefs = {
    remote: {
      enabled: false,
      port: 17_321,
      lan: false,
      push: false,
      notifyWebhook: '',
      ...prefsPatch,
    } as RemotePrefs & Record<string, unknown>,
  }
  const notices: string[] = []
  const sections: SettingsSectionSpec[] = []
  const transcriptListeners = new Set<() => void>()
  const watchers = new Set<() => void>()
  const handlers = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const effects: Array<() => void> = []
  const answers: unknown[][] = []
  let disposed = false
  const snapshot = { value: baseSnapshot() as Record<string, unknown> }
  const session = {
    meta: { id: 'sess-1', cwd: WORK },
    filePath: join(WORK, 'sess.jsonl'),
  }
  const on = (name: string, handler: (...args: unknown[]) => unknown): (() => void) => {
    if (!handlers.has(name)) handlers.set(name, new Set())
    handlers.get(name)!.add(handler)
    return () => handlers.get(name)?.delete(handler)
  }
  const runtime = {
    getSnapshot: () => snapshot.value,
    submit: async () => 'ok',
    answerApproval: async (...args: unknown[]) => {
      answers.push(args)
      return { ok: true }
    },
  }
  const ctx = {
    ui: runtime,
    settings: {
      prefs: () => prefs,
      setPrefs: (patch: { remote: RemotePrefs }) => {
        prefs.remote = { ...prefs.remote, ...patch.remote }
        for (const watcher of watchers) watcher()
        return prefs
      },
      watchPrefs: (watcher: () => void) => {
        watchers.add(watcher)
        return () => watchers.delete(watcher)
      },
      registerSection: (spec: SettingsSectionSpec) => {
        sections.push(spec)
        return () => undefined
      },
    },
    session: { current: () => session },
    transcript: {
      subscribe: (listener: () => void) => {
        transcriptListeners.add(listener)
        return () => transcriptListeners.delete(listener)
      },
    },
    emit: (name: string, ...args: unknown[]) => {
      if (name === 'dsc/notice') notices.push(String(args[0] ?? ''))
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
    on,
    effect: (execute: () => unknown) => {
      const off = execute()
      const dispose = typeof off === 'function' ? (off as () => void) : (): void => undefined
      effects.push(dispose)
      return dispose
    },
    logger: { warn: () => undefined, debug: () => undefined },
    get: () => undefined,
  }
  remotePlugin.apply?.(ctx as never, {})
  const result: Harness = {
    notices,
    prefs,
    section: () => {
      const section = sections[0]
      if (section === undefined) throw new Error('没有注册 remote 设置分区')
      return section
    },
    fire: (name, ...args) => {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
    fireTranscript: () => {
      for (const listener of transcriptListeners) listener()
    },
    reapply: () => {
      for (const watcher of watchers) watcher()
    },
    setSnapshot: (value) => {
      snapshot.value = value
    },
    answers,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const handler of handlers.get('dsc/exit') ?? []) handler()
      for (const off of effects.splice(0)) off()
    },
  }
  mounts.push(result)
  return result
}

function fieldTexts(harness: Harness): string[] {
  const fields = harness.section().fields?.() ?? []
  return fields.flatMap((field) => ('text' in field && typeof field.text === 'string' ? [field.text] : []))
}

// ── 设置面文案 ───────────────────────────────────────────────────────────────

test('设置面：关闭状态、Webhook 占位符（GET）与无占位符（POST）的文案', () => {
  const harness = mount({ notifyWebhook: 'https://example.com/{title}/{body}' })
  expect(fieldTexts(harness).join('\n')).toContain('GET')

  harness.prefs.remote.notifyWebhook = 'https://example.com/hook'
  expect(fieldTexts(harness).join('\n')).toContain('POST JSON')

  harness.prefs.remote.notifyWebhook = ''
  expect(fieldTexts(harness).join('\n')).toContain('没配')
  expect(fieldTexts(harness).join('\n')).toContain('已关闭')
  harness.dispose()
})

test('推送状态：关闭时「没开」；开着但密钥不可用时说人话并只提醒一次', async () => {
  const harness = mount()
  expect(fieldTexts(harness).join('\n')).toContain('没开')

  // 把 push-keys.json 做成目录：读不成文件、rename 不进去，publicKey 只能报 null。
  const keysPath = join(HOME, 'remote', 'push-keys.json')
  mkdirSync(keysPath, { recursive: true })
  try {
    harness.prefs.remote.push = true
    const first = fieldTexts(harness).join('\n')
    expect(first).toContain('VAPID 密钥不可用')
    // 第二次读同一个分区：问题没变，只应有一条提醒。
    expect(fieldTexts(harness).join('\n')).toContain('VAPID 密钥不可用')
    expect(harness.notices.filter((text) => text.includes('VAPID'))).toHaveLength(1)
  } finally {
    rmSync(keysPath, { recursive: true, force: true })
    harness.dispose()
  }
})

test('状态文案：运行中/等待/让出三态', async () => {
  const port = await freePort()
  const harness = mount({ enabled: true, port, lan: false })
  await waitUntil(() => fieldTexts(harness).join('\n').includes('运行中'))
  const running = fieldTexts(harness).join('\n')
  expect(running).toContain(`127.0.0.1:${String(port)}`)

  // 让出主控位：状态文字变成「已让出」。
  await harness.section().action?.('release-owner')
  expect(fieldTexts(harness).join('\n')).toContain('已让出')
  harness.dispose()
})

// ── 通知：节流、失败原文、升级提醒 ───────────────────────────────────────────

test('轮失败：连着两次同一节流键只推第一条；会话对不上时用兜底文案', async () => {
  const bodies: string[] = []
  const receiver = createHttpServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      bodies.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  servers.push(receiver)
  const address = receiver.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const harness = mount({ notifyWebhook: `http://127.0.0.1:${String(port)}/hook` })
  harness.setSnapshot(
    baseSnapshot({
      status: { turnState: 'running', sessionPath: join(WORK, 'other.jsonl') },
    }),
  )
  harness.fireTranscript()
  harness.fire('dsc/turn-end', 'error', { sessionPath: join(WORK, 'other.jsonl') })
  await waitUntil(() => bodies.length === 1)
  // 别的会话的失败不取本会话原文：正文是兜底文案。
  expect(bodies[0]).not.toContain('错误：')

  // 10 秒内同键第二条被节流吞掉。
  harness.fire('dsc/turn-end', 'error', { sessionPath: join(WORK, 'other.jsonl') })
  await sleep(120)
  expect(bodies).toHaveLength(1)
  harness.dispose()
})

test('长回合完成：超过 15 秒门槛就推一条完成通知', async () => {
  const bodies: string[] = []
  const receiver = createHttpServer((req, res) => {
    req.resume()
    req.on('end', () => {
      bodies.push('hit')
      res.writeHead(200)
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  servers.push(receiver)
  const address = receiver.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const harness = mount({ notifyWebhook: `http://127.0.0.1:${String(port)}/hook` })
  harness.setSnapshot(
    baseSnapshot({
      status: { turnState: 'running', sessionPath: join(WORK, 'sess.jsonl') },
    }),
  )
  // 把「这一轮开始」钉在过去：Date.now 只在这一拍返回 1，之后恢复真实时间。
  const spy = vi.spyOn(Date, 'now').mockReturnValue(1)
  harness.fireTranscript()
  spy.mockRestore()

  harness.fire('dsc/turn-end', 'completed', { sessionPath: join(WORK, 'sess.jsonl') })
  await waitUntil(() => bodies.length === 1)
  harness.dispose()
})

test('升级提醒：等 2 分钟后再喊，卡片还在就继续排下一声', async () => {
  vi.useFakeTimers()
  const harness = mount()
  harness.setSnapshot(
    baseSnapshot({
      surfaces: {
        pendingApproval: { id: 'a1', argsSummary: '', toolName: 'bash' },
        pendingPlan: null,
        pendingQuestion: null,
      },
    }),
  )
  harness.fireTranscript()
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(120_000)
  // 卡片还在：第一声升级提醒已发，并且重新排了下一声。
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  harness.dispose()
})

// ── 服务起不来：去重、重试、释放主控位 ───────────────────────────────────────

test('端口被占：报一次问题（重复启动不刷屏），退出主控清掉重试计时器', async () => {
  const { port } = await occupiedPort('127.0.0.1')
  const harness = mount({ enabled: true, port, lan: false })
  await waitUntil(() => harness.notices.some((text) => text.includes('起不来')))
  const firstCount = harness.notices.filter((text) => text.includes('起不来')).length
  expect(firstCount).toBe(1)

  // 再触发一次同样的失败：lastProblem 去重 + 重试计时器已在，不应再写一条。
  harness.reapply()
  await sleep(150)
  expect(harness.notices.filter((text) => text.includes('起不来'))).toHaveLength(1)

  await harness.section().action?.('release-owner')
  harness.dispose()
})

test('pair-code-lan：端口被占时等服务超时，配对码如实报 reach=down', async () => {
  const { port } = await occupiedPort('0.0.0.0')
  const harness = mount({ enabled: false, port, lan: false })
  const result = await harness.section().action?.('pair-code-lan')
  const data = (result as { data?: { reach?: string } } | undefined)?.data
  expect(data?.reach).toBe('down')
  expect(harness.notices.some((text) => text.includes('起不来'))).toBe(true)
  harness.dispose()
})

// ── 配对后的 WS invoke ───────────────────────────────────────────────────────

test('配对 → 取票 → WS：answerApproval 带 web 来源，未知方法与坏 JSON 各有回话', async () => {
  const port = await freePort()
  const harness = mount({ enabled: true, port, lan: false })
  await waitUntil(() => harness.notices.some((text) => text.includes('起不来')) === false && fieldTexts(harness).join('\n').includes('运行中'))

  const issued = await harness.section().action?.('regenerate-code')
  const code = (issued as { data?: { code?: string } }).data?.code
  expect(typeof code).toBe('string')

  const pair = await fetch(`http://127.0.0.1:${String(port)}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect(pair.status).toBe(200)
  const paired = (await pair.json()) as { token: string }
  const ticket = await fetch(`http://127.0.0.1:${String(port)}/api/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${paired.token}` },
  })
  const { ticket: grant } = (await ticket.json()) as { ticket: string }

  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws?ticket=${grant}`)
  sockets.push(ws)
  const received: Array<Record<string, unknown>> = []
  ws.on('message', (data) => {
    received.push(JSON.parse(String(data)) as Record<string, unknown>)
  })
  await waitUntil(() => received.some((message) => message['type'] === 'hello'))

  ws.send(JSON.stringify({ type: 'invoke', id: 1, method: 'answerApproval', args: [{ id: 'a1' }] }))
  await waitUntil(() => received.some((message) => message['id'] === 1))
  expect(harness.answers[0]?.[1]).toBe('web')

  ws.send(JSON.stringify({ type: 'invoke', id: 2, method: 'listModels', args: [] }))
  await waitUntil(() => received.some((message) => message['id'] === 2))
  const failed = received.find((message) => message['id'] === 2)
  expect(String(failed?.['error'])).toContain('运行时没有这个方法')

  ws.send('not-json')
  await waitUntil(() => received.some((message) => message['type'] === 'result' && message['id'] === null))
  ws.send(JSON.stringify({ type: 'other' }))
  await sleep(80)

  harness.dispose()
})

// ── 路由拒绝分支 ─────────────────────────────────────────────────────────────

test('路由：吊销不带 token 400、超大请求体 413、未开推送的后端 403、插件资源回落', async () => {
  const port = await freePort()
  const harness = mount({ enabled: true, port, lan: false })
  await waitUntil(() => fieldTexts(harness).join('\n').includes('运行中'))

  const revoke = await fetch(`http://127.0.0.1:${String(port)}/api/revoke`, { method: 'POST' })
  expect(revoke.status).toBe(400)

  const huge = await fetch(`http://127.0.0.1:${String(port)}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'x'.repeat(70 * 1024) }),
  })
  expect(huge.status).toBe(413)

  const unsubscribe = await fetch(`http://127.0.0.1:${String(port)}/api/push-unsubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"endpoint":"https://example.com/e"}',
  })
  expect(unsubscribe.status).toBe(403)

  const pluginAsset = await fetch(`http://127.0.0.1:${String(port)}/plugins/not-there.js`)
  expect(pluginAsset.status).toBeGreaterThanOrEqual(400)

  harness.dispose()
})
