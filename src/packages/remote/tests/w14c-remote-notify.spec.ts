/**
 * remote 插件的 W14-C 补测：推送两条腿的「部分失败 / 抛错 / 测试按钮」回执。
 *
 * 真 `RemotePush.send` 自己吞掉所有发送错误（只记账不抛），所以「send 抛错」这条 catch
 * 以及「一部分设备成功」的回执在真库上造不出来。这里把 `core/remote/push` 整个换成可编排
 * 的假实现（`vi.mock`），只测插件怎么把结果说给人听：不连网、不生成 VAPID 密钥。
 *
 * 触发点仍是插件真实的订阅与事件：`transcript.subscribe` 回调 + `runtime.getSnapshot()`。
 * 没有开远程开关，所以不起监听端口；收尾把设置分区、订阅与定时器全部退掉。
 *
 * @module dsc/packages/remote/tests/w14c-remote-notify
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-remote-w14c-notify-'))
process.env['DSC_HOME'] = HOME

/** 假推送库的状态：mode 决定 send 返回什么/抛不抛。 */
const pushState = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'partial' | 'throw' }))

vi.mock('@pneuma/runtime/core/remote/push.js', () => ({
  RemotePush: class {
    publicKey(): string {
      return 'fake-vapid-key'
    }
    count(): number {
      return 1
    }
    add(): { ok: true; added: boolean; total: number } {
      return { ok: true, added: true, total: 1 }
    }
    remove(): boolean {
      return true
    }
    async send(): Promise<{ attempted: number; sent: number; dropped: number; errors: string[] }> {
      if (pushState.mode === 'throw') throw new Error('推送库炸了')
      if (pushState.mode === 'partial') return { attempted: 2, sent: 1, dropped: 0, errors: ['HTTP 500'] }
      return { attempted: 1, sent: 1, dropped: 0, errors: [] }
    }
  },
}))

type RemoteIndex = typeof import('../index.js')
let remotePlugin: RemoteIndex['remotePlugin']

beforeAll(async () => {
  remotePlugin = (await import('../index.js')).remotePlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // 临时目录留给系统清
  }
})

interface Harness {
  notices: string[]
  sections: Array<{
    fields(): Array<{ key?: string; text?: string }>
    action(name: string): unknown
  }>
  fireTranscript(): void
  snapshot(value: Record<string, unknown>): void
  dispose(): void
}

/** 假 ctx 跑真 apply；推给快照与订阅都留在手里，方便按用例改。 */
function mount(push: boolean): Harness {
  const notices: string[] = []
  const sections: Harness['sections'] = []
  const listeners = new Set<() => void>()
  const cleanups: Array<() => void> = []
  const prefs = { enabled: false, port: 0, lan: false, push, notifyWebhook: '' }
  const snapshot = {
    value: {
      status: { sessionPath: join(HOME, 's.jsonl'), sessionId: 's' },
      entries: [],
      surfaces: { pendingApproval: null, pendingPlan: null, pendingQuestion: null },
    } as Record<string, unknown>,
  }
  const ctx = {
    ui: {
      getSnapshot: () => snapshot.value,
      subscribe: () => () => {},
      answerApproval: () => {},
    },
    session: {
      current: () => ({ meta: { id: 's', cwd: HOME }, filePath: join(HOME, 's.jsonl') }),
    },
    transcript: {
      system: (text: string) => notices.push(text),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      touch: () => {},
    },
    agent: { followup: () => {}, interrupt: () => {} },
    approval: { setPolicy: () => {}, setReviewer: () => {}, answer: () => {} },
    settings: {
      prefs: () => ({ remote: { ...prefs }, ui: {} }),
      setPrefs: () => {},
      registerSection: (section: Harness['sections'][number]) => {
        sections.push(section)
        return () => {}
      },
      watchPrefs: () => () => {},
    },
    emit: (event: string, ...args: unknown[]) => {
      notices.push(`${event}${args.length === 0 ? '' : `：${args.map((arg) => String(arg)).join(' ')}`}`)
    },
    on: () => () => {},
    effect: (execute: () => unknown) => {
      const result = execute()
      const off = typeof result === 'function' ? (result as () => void) : (): void => {}
      cleanups.push(off)
      return off
    },
    logger: { warn: () => {} },
  }
  remotePlugin.apply?.(ctx as never, {})
  const harness: Harness = {
    notices,
    sections,
    fireTranscript: () => {
      for (const listener of [...listeners]) listener()
    },
    snapshot: (value) => {
      snapshot.value = value
    },
    dispose: () => {
      for (const off of cleanups.splice(0).reverse()) off()
    },
  }
  open.push(harness)
  return harness
}

const open: Harness[] = []

afterEach(() => {
  pushState.mode = 'ok'
  for (const harness of open.splice(0)) {
    try {
      harness.dispose()
    } catch {
      // 已经收过了
    }
  }
})

/** 一张待审批卡的快照：`watchTransitions` 看到「从无到有」就会发通知。 */
function approvalSnapshot(): Record<string, unknown> {
  return {
    status: { sessionPath: join(HOME, 's.jsonl'), sessionId: 's' },
    entries: [],
    surfaces: {
      pendingApproval: { id: 'a1', toolName: 'bash', argsSummary: 'rm -rf build' },
      pendingPlan: null,
      pendingQuestion: null,
    },
  }
}

/** 等通知真的写出（notify 是异步的）。 */
async function waitNotice(harness: Harness, part: RegExp): Promise<string> {
  let found = ''
  await vi.waitFor(() => {
    found = harness.notices.find((line) => part.test(line)) ?? ''
    expect(found).not.toBe('')
  })
  return found
}

describe('通知的推送腿：部分失败与抛错', () => {
  test('一部分设备没发出去：写一条带原因的 notice', async () => {
    pushState.mode = 'partial'
    const harness = mount(true)
    harness.snapshot(approvalSnapshot())
    harness.fireTranscript()
    const notice = await waitNotice(harness, /浏览器推送：1\/2 台成功/)
    expect(notice).toContain('HTTP 500')
  })

  test('推送库抛错：只写一条 notice，不影响审批流本身', async () => {
    pushState.mode = 'throw'
    const harness = mount(true)
    harness.snapshot(approvalSnapshot())
    expect(() => harness.fireTranscript()).not.toThrow()
    const notice = await waitNotice(harness, /浏览器推送失败/)
    expect(notice).toContain('推送库炸了')
  })
})

describe('「发送测试推送」按钮的回执', () => {
  test('有订阅且发送成功：回执报 N/N 台成功', async () => {
    pushState.mode = 'ok'
    const harness = mount(true)
    const section = harness.sections[0]
    if (section === undefined) throw new Error('没有注册 remote 设置分区')
    const text = String(await section.action('test-push'))
    expect(text).toContain('浏览器推送：1/1 台成功')
  })

  test('推送库抛错：回执把失败原因带出来', async () => {
    pushState.mode = 'throw'
    const harness = mount(true)
    const section = harness.sections[0]
    if (section === undefined) throw new Error('没有注册 remote 设置分区')
    const text = String(await section.action('test-push'))
    expect(text).toContain('浏览器推送：失败')
    expect(text).toContain('推送库炸了')
  })
})
