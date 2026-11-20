/**
 * dock-browser 收尾缺口（`packages/dock-browser/index.ts:962`）：switch 的 default 兜底。
 *
 * 正常路径走不到它——`DOCK_ACTIONS` 里的每个动作都有 case 分支，守卫在 switch 之前就把
 * 不认识的字符串拦掉了。所以这里把常量模块包一层：往 `DOCK_ACTIONS` 里塞一个 switch
 * 没实现的 `dance`，模拟「常量表与 switch 不同步」的漂移，钉住兜底报错本身。
 *
 * 假链路只实现这条路径用得到的部分（available / onEvent / session），命令只记账。
 * `DSC_HOME` 在动态 import 之前指进临时目录，收尾恢复。
 *
 * @module @pneuma/dock-browser/tests/w14-tail-gaps.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-dock-browser-w14-'))
const savedHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = HOME

/** 只多给一个 switch 没实现的动作，其余导出原样透传。 */
vi.mock('@pneuma/runtime/core/dock-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pneuma/runtime/core/dock-browser.js')>()
  return { ...actual, DOCK_ACTIONS: [...actual.DOCK_ACTIONS, 'dance'] }
})

let idx: typeof import('../index.js')
let HOST_BROWSER_SERVICE: string

beforeAll(async () => {
  idx = await import('../index.js')
  HOST_BROWSER_SERVICE = (await import('@pneuma/runtime/core/host-browser-link.js')).HOST_BROWSER_SERVICE
})

beforeEach(() => {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

const harnesses: Array<{ dispose: () => void }> = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.dispose()
    } catch {
      // 已经收过了
    }
  }
})

afterAll(() => {
  if (savedHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶发 EPERM：留给系统清
  }
})

/** 记账用的假链路：命令落到 calls 上，应答一律空对象。 */
function makeLink(): {
  link: Record<string, unknown>
  calls: Array<{ viewId: string; method: string }>
} {
  const calls: Array<{ viewId: string; method: string }> = []
  const link = {
    available: () => true,
    views: async () => [],
    open: async (url: string) => ({ viewId: 'agent-1', attached: true, url }),
    close: async () => undefined,
    call: async () => ({}),
    onEvent: () => () => undefined,
    session: (viewId: string) => ({
      sessionId: viewId,
      send: async (method: string) => {
        calls.push({ viewId, method })
        return {}
      },
      on: () => () => undefined,
    }),
  }
  return { link, calls }
}

/** 假 ctx：只收工具注册与几条服务查询。 */
function mount(link: Record<string, unknown>): { run: (args: Record<string, unknown>) => Promise<unknown>; dispose: () => void } {
  const tools = new Map<
    string,
    { name: string; run: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> }
  >()
  const ctx = {
    tools: {
      register(entry: { name: string; run: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> }) {
        tools.set(entry.name, entry)
        return () => {
          tools.delete(entry.name)
        }
      },
    },
    settings: { registerSection: () => () => undefined },
    get(name: string) {
      if (name === HOST_BROWSER_SERVICE) return link
      if (name === 'transcript') return { system: () => undefined }
      return undefined
    },
    effect(execute: () => unknown) {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
    on: () => () => undefined,
  }
  const cleanup = idx.dockBrowserPlugin.apply?.(ctx as never, {}) as unknown as (() => void) | undefined
  const harness = {
    run: (args: Record<string, unknown>) => {
      const tool = tools.get('browser_dock')
      if (tool === undefined) throw new Error('没有注册 browser_dock')
      return tool.run(args, {
        cwd: HOME,
        signal: new AbortController().signal,
        sessionId: 'sess-1',
        sessionPath: join(HOME, 'sess.jsonl'),
      })
    },
    dispose: () => {
      if (typeof cleanup === 'function') cleanup()
    },
  }
  harnesses.push(harness)
  return harness
}

describe('browser_dock 的 switch 兜底', () => {
  test('常量表里多出来的动作穿过守卫后，落到 default 并报未知动作', async () => {
    const fake = makeLink()
    const harness = mount(fake.link)
    await expect(harness.run({ action: 'dance', viewId: 'agent-1' })).rejects.toThrow(/未知 action：dance/)
    // 走到 switch 之前已经开过四个域：证明不是被前面的守卫拦掉的。
    expect(fake.calls.map((call) => call.method)).toEqual(['Page.enable', 'Runtime.enable', 'DOM.enable', 'Accessibility.enable'])
  })
})
