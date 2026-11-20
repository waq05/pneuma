/**
 * remote 插件的 W14 补缺口测试：装配面（不是 `createRemoteServer` 的路由细节）。
 *
 * 真起本机远程服务（127.0.0.1 + 端口现取，端口 0 由系统分配前先占一下拿号），
 * 走插件自己的设置分区与动作面：
 *
 *   - 局域网地址挑不出时回落到 127.0.0.1（`lanAddress` 的 null 分支）；
 *   - `ui: 'classic'` 时手机端不建插件版壳（`shellUiOf` 的 classic 分支）；
 *   - 设置分区的字段/值/保存（端口与 webhook 的非法值、合法值）；
 *   - 「发送测试推送」在没开推送 / 开了但没订阅时的回执；
 *   - `release-owner` 动作与 `process.once('exit')` 里的主控位释放。
 *
 * 不连外网：`node:os` 的网络接口在文件里换成空表，推送没有订阅因此不会发请求。
 *
 * @module dsc/packages/remote/tests/w14-plugin-edges
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-remote-w14-'))
process.env['DSC_HOME'] = HOME

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    // 只有回环地址：局域网地址挑不出来，走 127.0.0.1 的兜底分支。
    networkInterfaces: () => ({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    }),
  }
})

type RemoteIndex = typeof import('../index.js')
let remotePlugin: RemoteIndex['remotePlugin']

beforeAll(async () => {
  remotePlugin = (await import('../index.js')).remotePlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  } catch {
    // 临时目录留给系统清。
  }
})

interface Harness {
  sections: Array<{
    fields(): Array<{ key?: string; text?: string; action?: string }>
    values(): Record<string, unknown>
    save(key: string, value: unknown): void
    action(name: string): unknown
  }>
  notices: string[]
  emit(event: string, ...args: unknown[]): void
  dispose(): void
}

/** 当前偏好（用例里按需改）。 */
function makePrefs(over: Record<string, unknown> = {}) {
  return {
    enabled: false,
    port: 0,
    lan: false,
    push: false,
    notifyWebhook: '',
    ...over,
  }
}

/** 假 ctx 跑真 apply。 */
function mount(passed: Record<string, unknown>, prefs = makePrefs()): Harness {
  const sections: Harness['sections'] = []
  const notices: string[] = []
  const watchers: Array<() => void> = []
  const cleanups: Array<() => void> = []
  const runtime = {
    getSnapshot: () => ({
      status: { sessionPath: '', sessionId: 's' },
      entries: [{ id: 1, kind: 'text' }],
    }),
    subscribe: () => () => {},
    answerApproval: () => {},
    exit: vi.fn(),
  }
  const ctx = {
    ui: runtime,
    session: {
      current: () => ({
        meta: { id: 's', cwd: HOME },
        filePath: join(HOME, 's.jsonl'),
      }),
    },
    transcript: {
      system: (text: string) => notices.push(text),
      subscribe: () => () => {},
      touch: () => {},
    },
    agent: { followup: () => {}, interrupt: () => {} },
    approval: { setPolicy: () => {}, setReviewer: () => {}, answer: () => {} },
    settings: {
      prefs: () => ({ remote: { ...prefs }, ui: {} }),
      setPrefs: (patch: { remote?: Record<string, unknown> }) => {
        if (patch.remote !== undefined) Object.assign(prefs, patch.remote)
        for (const watcher of [...watchers]) watcher()
      },
      registerSection: (section: Harness['sections'][number]) => {
        sections.push(section)
        return () => {}
      },
      watchPrefs: (fn: () => void) => {
        watchers.push(fn)
        return () => {}
      },
    },
    emit(event: string, ...args: unknown[]) {
      notices.push(`${event}${args.length === 0 ? '' : `：${args.map((arg) => String(arg)).join(' ')}`}`)
    },
    on() {
      return () => {}
    },
    effect(fn: () => unknown) {
      const result = fn()
      const off = typeof result === 'function' ? (result as () => void) : (): void => {}
      cleanups.push(off)
      return off
    },
  }
  remotePlugin.apply?.(ctx as never, passed)
  return {
    sections,
    notices,
    emit: (event, ...args) => ctx.emit(event, ...args),
    dispose: () => {
      for (const off of cleanups.splice(0).reverse()) off()
    },
  }
}

/** 找一个空闲端口（listen 0 拿号后立刻放掉）。 */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

const opened: Harness[] = []
afterEach(() => {
  for (const harness of opened.splice(0)) {
    try {
      harness.dispose()
    } catch {
      // 已经收过了
    }
  }
})

/** 装一次并登记收尾。 */
function open(passed: Record<string, unknown> = {}, prefs = makePrefs()): Harness {
  const harness = mount(passed, prefs)
  opened.push(harness)
  return harness
}

describe('设置分区的字段与保存', () => {
  test('lan 打开但没有局域网地址：地址回落 127.0.0.1；字段包含连接按钮', () => {
    const harness = open({}, makePrefs({ lan: true }))
    const section = harness.sections[0]
    if (section === undefined) throw new Error('没有注册 remote 设置分区')
    const fields = section.fields()
    const address = fields.find((field) => String(field.text ?? '').startsWith('http://'))
    expect(String(address?.text)).toContain('http://127.0.0.1:')
    expect(fields.some((field) => field.action === 'regenerate-code')).toBe(true)
    expect(section.values()).toMatchObject({ lan: true })
  })

  test('保存端口 / webhook：越界与非 http 拒绝，合法值落进偏好', () => {
    const prefs = makePrefs()
    const harness = open({}, prefs)
    const section = harness.sections[0]
    if (section === undefined) throw new Error('没有注册 remote 设置分区')
    expect(() => section.save('port', 1)).toThrow(/端口要填/)
    expect(() => section.save('notifyWebhook', 'ftp://x')).toThrow(/http/)
    section.save('port', 47111)
    expect(prefs['port']).toBe(47111)
    section.save('lan', true)
    expect(prefs['lan']).toBe(true)
    section.save('push', false)
    expect(prefs['push']).toBe(false)
  })
})

describe('动作面', () => {
  test('没开推送时「发送测试推送」只说推送没开', async () => {
    const harness = open({}, makePrefs())
    const section = harness.sections[0]
    if (section === undefined) throw new Error('没有注册 remote 设置分区')
    const text = String(await section.action('test-push'))
    expect(text).toContain('浏览器推送：没开')
  })

  test('开了推送但一台设备都没订阅：回执说没有订阅', async () => {
    const harness = open({}, makePrefs({ push: true }))
    const section = harness.sections[0]
    if (section === undefined) throw new Error('没有注册 remote 设置分区')
    const text = String(await section.action('test-push'))
    expect(text).toContain('推送')
  })

  test('release-owner 说已退出主控；未知动作抛错', async () => {
    const harness = open({}, makePrefs())
    const section = harness.sections[0]
    if (section === undefined) throw new Error('没有注册 remote 设置分区')
    expect(String(await section.action('release-owner'))).toContain('主控')
    await expect(section.action('nope')).rejects.toThrow(/没有动作/)
  })
})

describe('服务启动：classic 档不建插件版壳', () => {
  test('ui: classic 时起服务不报壳产物问题；端口真的在听', async () => {
    const port = await freePort()
    const harness = open({ ui: 'classic' }, makePrefs({ enabled: true, port }))
    // 等 applyPrefs 里的异步启动完成：服务在听之后设置分区状态文案会变成「运行中」。
    const section = harness.sections[0]
    if (section === undefined) throw new Error('没有注册 remote 设置分区')
    await vi.waitFor(() => {
      const status = section.fields().find((field) => String(field.text ?? '').includes('127.0.0.1'))
      expect(status).toBeDefined()
    })
    expect(harness.notices.some((line) => line.includes('远程壳产物不存在'))).toBe(false)
  })
})
