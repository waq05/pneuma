/**
 * remote 的分支补充测试：设置保存的拒绝分支、设置动作的未命中的分支、通知的降级路径。
 *
 * 不真起监听：所有用例都在 `enabled: false` 下挂插件，只驱动设置分区与事件回调。
 * Webhook 用本机临时 HTTP 服务收，验证「计划评审 → 模型提问 → 卡片消失」三态与
 * 失败轮次的原文；`DSC_HOME` 在 import 前指进临时目录。
 *
 * @module dsc/packages/remote/tests/branches-extra
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import type { RemotePrefs } from '@pneuma/runtime/core/prefs.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-remote-branches-'))
process.env['DSC_HOME'] = HOME
const WORK = join(HOME, 'work')

const { remotePlugin } = await import('../index.js')

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

interface Harness {
  notices: string[]
  prefs: { remote: RemotePrefs & Record<string, unknown> }
  section(): SettingsSectionSpec
  fire(name: string, ...args: unknown[]): void
  fireTranscript(): void
  setSnapshot(value: Record<string, unknown>): void
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
  const handlers = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const effects: Array<() => void> = []
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
  const ctx = {
    ui: {
      getSnapshot: () => snapshot.value,
      submit: async () => 'ok',
      answerApproval: async () => ({ ok: true }),
    },
    settings: {
      prefs: () => prefs,
      setPrefs: (patch: { remote: RemotePrefs }) => {
        prefs.remote = { ...prefs.remote, ...patch.remote }
        return prefs
      },
      watchPrefs: () => () => undefined,
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
  return {
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
    setSnapshot: (value) => {
      snapshot.value = value
    },
    dispose: () => {
      for (const handler of handlers.get('dsc/exit') ?? []) handler()
      for (const off of effects.splice(0)) off()
    },
  }
}

const receivers: Server[] = []
afterEach(async () => {
  for (const server of receivers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()))
  }
})

/** 起一个本机 Webhook 接收器，返回 URL 与收到的正文。 */
async function receiver(): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = []
  const server = createServer((req, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  receivers.push(server)
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { url: `http://127.0.0.1:${port}/hook`, bodies }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

// ── 设置保存 ─────────────────────────────────────────────────────────────────

test('save：端口非数字/越界、Webhook 非 http、未知键都拒绝；合法值写回偏好', () => {
  const harness = mount()
  const section = harness.section()
  const save = section.save!.bind(section)

  expect(() => save('port', 'abc')).toThrow(/port|端口/i)
  expect(() => save('port', 1)).toThrow(/port|端口/i)
  expect(() => save('port', 70_000)).toThrow(/port|端口/i)
  expect(() => save('notifyWebhook', 'ftp://x')).toThrow(/http/i)
  expect(() => save('unknown', 1)).toThrow(/unknown|未知/i)

  save('enabled', false)
  save('port', '18080')
  save('lan', true)
  save('push', true)
  save('notifyWebhook', '   ')
  expect(harness.prefs.remote).toMatchObject({ enabled: false, port: 18_080, lan: true, push: true, notifyWebhook: '' })
  expect(section.values()).toMatchObject({ port: 18_080, lan: true, push: true })
})

// ── 设置动作 ─────────────────────────────────────────────────────────────────

test('action：未命中的动作、吊销不存在的设备、test-push 两条腿都关着', async () => {
  const harness = mount()
  const section = harness.section()

  await expect(section.action?.('no-such-action')).rejects.toThrow(/no-such-action/)
  // revoke-all 没有设备：返回一句「没有可撤销的」而不是报错。
  await expect(section.action?.('revoke-all')).resolves.toEqual(expect.any(String))
  await expect(section.action?.('revoke-device:ghost')).resolves.toEqual(expect.any(String))

  const off = await section.action?.('test-push')
  expect(typeof off).toBe('string')
  // push 关着 + Webhook 没配：两段「没开」都要说。
  expect(String(off).split(/[；;]/).length).toBeGreaterThanOrEqual(2)

  // release-owner 之后状态文字是 yielded；重新打开开关会解除让位（这里只验证动作本身）。
  await expect(section.action?.('release-owner')).resolves.toEqual(expect.any(String))
})

test('通知：计划评审 → 模型提问 → 卡片消失；Webhook 失败只写 notice 不抛', async () => {
  const hook = await receiver()
  const harness = mount({ notifyWebhook: hook.url })
  harness.setSnapshot(
    baseSnapshot({
      surfaces: {
        pendingApproval: null,
        pendingPlan: { file: 'plan.md', title: '计划标题' },
        pendingQuestion: null,
      },
    }),
  )
  harness.fireTranscript()
  await waitFor(() => hook.bodies.length === 1)
  expect(hook.bodies[0]).toContain('计划标题')

  // 换一张卡（模型提问）：键变了，不该被同一把节流吞掉。
  harness.setSnapshot(
    baseSnapshot({
      surfaces: {
        pendingApproval: null,
        pendingPlan: null,
        pendingQuestion: { id: 'q1', question: '要继续吗' },
      },
    }),
  )
  harness.fireTranscript()
  await waitFor(() => hook.bodies.length === 2)
  expect(hook.bodies[1]).toContain('要继续吗')

  // 卡片消失：清掉升级计时器，不报错。
  harness.setSnapshot(baseSnapshot())
  harness.fireTranscript()

  // Webhook 打不通：通知失败只往对话流写一条，不抛。
  harness.setSnapshot(
    baseSnapshot({
      surfaces: {
        pendingApproval: { id: 'a1', argsSummary: '', toolName: 'bash' },
        pendingPlan: null,
        pendingQuestion: null,
      },
    }),
  )
  harness.prefs.remote.notifyWebhook = 'http://127.0.0.1:1/hook'
  harness.fireTranscript()
  await waitFor(() => harness.notices.some((text) => text.includes('Webhook 没发出去')))
  harness.dispose()
})

test('轮结束：失败带原文并截断；中断不推；短完成且有等人卡才推', async () => {
  const hook = await receiver()
  const harness = mount({ notifyWebhook: hook.url })
  const sessionPath = join(WORK, 'sess.jsonl')
  const detail = `错误：${'很长的失败原因'.repeat(30)}`

  harness.setSnapshot(
    baseSnapshot({
      entries: [
        { id: 1, kind: 'system', level: 'error', text: detail },
        { id: 2, kind: 'system', level: 'error', text: '错误：' },
      ],
      status: { turnState: 'running', sessionPath },
      surfaces: {
        pendingApproval: null,
        pendingPlan: { file: 'p.md', title: '卡' },
        pendingQuestion: null,
      },
    }),
  )
  harness.fireTranscript()
  // 计划卡推送一条；同时这一轮被记成「有过等人卡」。
  await waitFor(() => hook.bodies.length === 1)

  harness.fire('dsc/turn-end', 'error', { sessionPath })
  await waitFor(() => hook.bodies.length === 2)
  expect(hook.bodies[1]).toContain('很长的失败原因')
  expect(hook.bodies[1]).toContain('…')

  harness.fire('dsc/turn-end', 'aborted', { sessionPath })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(hook.bodies).toHaveLength(2)

  // 短完成：没有等人卡就不推。
  harness.fire('dsc/turn-end', 'completed', { sessionPath })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(hook.bodies).toHaveLength(2)
  harness.dispose()
})

test('失败轮次没有错误原文：用兜底文案推一条', async () => {
  const hook = await receiver()
  const harness = mount({ notifyWebhook: hook.url })
  const sessionPath = join(WORK, 'sess.jsonl')
  harness.setSnapshot(
    baseSnapshot({
      entries: [{ id: 1, kind: 'system', level: 'info', text: '普通日志' }],
      status: { turnState: 'running', sessionPath },
    }),
  )
  harness.fireTranscript()
  harness.fire('dsc/turn-end', 'error', { sessionPath })
  await waitFor(() => hook.bodies.length === 1)
  expect(hook.bodies[0]).not.toContain('普通日志')
  harness.dispose()
})
