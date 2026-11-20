/**
 * dock-browser 插件装配面（`packages/dock-browser/index.ts`）。
 *
 * 假链路（`ctx.get('hostBrowser')`）包一层假 CDP target：`Accessibility.getFullAXTree`
 * 给一棵只有一个按钮的树，动作层需要的 `DOM.getBoxModel` / `DOM.describeNode` 都给
 * 合法应答。事件从 `link.onEvent` 的 handler 手工灌进去。审批、模式、transcript 都是桩。
 *
 * 覆盖：快照与 ref 代际、控制台/网络环形缓冲、JS 对话框、click/hover/type/press/scroll/
 * evaluate 的命令序列、navigate/open/screenshot/views、地址与敏感原语闸门、设置分区
 * （免审批开关会重挂工具）、confirmLook 四条失败方向、close 与 dispose 收尾。
 *
 * `DSC_HOME` 在任何 import 之前指进临时目录（`plugin-registry` 的路径是模块加载时算的）。
 *
 * @module dsc/packages/dock-browser/tests/wiring.spec
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { DOCK_CALL_TIMEOUT_MS } from '@pneuma/runtime/core/dock-browser.js'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-dock-browser-wiring-'))
process.env['DSC_HOME'] = HOME

let idx: typeof import('../index.js')
let HOST_BROWSER_SERVICE: string

beforeAll(async () => {
  idx = await import('../index.js')
  HOST_BROWSER_SERVICE = (await import('@pneuma/runtime/core/host-browser-link.js')).HOST_BROWSER_SERVICE
})

beforeEach(() => {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 临时目录留给系统清
  }
})

// ── 假链路 / 假 CDP target ───────────────────────────────────────────────────

type Responder = (method: string, params: Record<string, unknown> | undefined) => unknown

interface CdpCall {
  viewId: string
  method: string
  params?: Record<string, unknown>
}

/** 默认应答：一棵「button 存」的树 + 可点的框 + 文档状态。 */
function defaultResponder(documentUrl: string): Responder {
  return (method, params) => {
    switch (method) {
      case 'Accessibility.getFullAXTree':
        return { nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: '存' }, backendDOMNodeId: 42 }] }
      case 'Accessibility.getPartialAXTree':
        return { nodes: [{ backendDOMNodeId: 42, role: { value: 'button' }, name: { value: '存' } }] }
      case 'DOM.describeNode':
        return { node: { backendNodeId: 42 } }
      case 'DOM.getBoxModel':
        return { model: { content: [100, 100, 140, 100, 140, 120, 100, 120] } }
      case 'Page.getLayoutMetrics':
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }
      case 'Page.captureScreenshot':
        return { data: 'BASE64PNG' }
      case 'Runtime.evaluate': {
        const expression = String(params?.['expression'] ?? '')
        if (expression.startsWith('!!')) return { result: { value: true } }
        if (expression.includes('1+1')) return { result: { value: 2 } }
        return { result: { value: { url: documentUrl, title: '示例', readyState: 'complete' } } }
      }
      default:
        return {}
    }
  }
}

interface FakeLink {
  link: Record<string, unknown>
  listeners: Set<(event: Record<string, unknown>) => void>
  calls: CdpCall[]
  closed: string[]
  opened: Array<{ url: string; viewId?: string }>
  emit(event: { viewId: string; method: string; params?: Record<string, unknown> }): void
}

function makeLink(options: {
  views?: Array<{ id: string; url: string; title?: string; loading?: boolean; visible?: boolean }>
  responder?: Responder
  documentUrl?: string
  openResult?: { viewId: string; attached: boolean; url: string }
} = {}): FakeLink {
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const calls: CdpCall[] = []
  const closed: string[] = []
  const opened: Array<{ url: string; viewId?: string }> = []
  const responder = options.responder ?? defaultResponder(options.documentUrl ?? 'https://example.com/')
  const link = {
    available: () => true,
    views: async () => options.views ?? [],
    open: async (url: string, viewId?: string) => {
      opened.push({ url, ...(viewId === undefined ? {} : { viewId }) })
      return options.openResult ?? { viewId: viewId ?? 'agent-9', attached: true, url }
    },
    close: async (viewId: string) => {
      closed.push(viewId)
    },
    call: async () => ({}),
    onEvent: (handler: (event: Record<string, unknown>) => void) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    session: (viewId: string) => ({
      sessionId: viewId,
      send: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ viewId, method, ...(params === undefined ? {} : { params }) })
        return responder(method, params)
      },
      on: () => () => undefined,
    }),
  }
  return {
    link,
    listeners,
    calls,
    closed,
    opened,
    emit(event) {
      for (const listener of listeners) listener(event)
    },
  }
}

// ── 挂载 ─────────────────────────────────────────────────────────────────────

interface BrowserHarness {
  tools: Map<string, ToolEntry>
  section: SettingsSectionSpec
  approvals: Array<{ request: Record<string, unknown>; options?: Record<string, unknown> }>
  notes: string[]
  dispose(): void
}

const harnesses: BrowserHarness[] = []

function mount(options: {
  link?: Record<string, unknown>
  config?: Record<string, unknown>
  approval?: Record<string, unknown> | null
  mode?: string
} = {}): BrowserHarness {
  const tools = new Map<string, ToolEntry>()
  const sections: SettingsSectionSpec[] = []
  const approvals: BrowserHarness['approvals'] = []
  const notes: string[] = []

  const ctx = {
    tools: {
      register(entry: ToolEntry) {
        tools.set(entry.name, entry)
        return () => {
          tools.delete(entry.name)
        }
      },
    },
    settings: {
      registerSection(spec: SettingsSectionSpec) {
        sections.push(spec)
        return () => undefined
      },
    },
    get(name: string) {
      if (name === HOST_BROWSER_SERVICE) return options.link
      if (name === 'transcript') return { system: (line: string) => notes.push(line) }
      if (name === 'mode') return { modeFor: () => options.mode ?? 'execute' }
      if (name === 'approval') {
        if (options.approval === null) return undefined
        if (options.approval !== undefined) {
          const decide = options.approval['decide'] as
            | ((request: Record<string, unknown>, signal: unknown, extra?: Record<string, unknown>) => Promise<string>)
            | undefined
          return {
            decide: async (request: Record<string, unknown>, signal: unknown, extra?: Record<string, unknown>) => {
              approvals.push({ request, ...(extra === undefined ? {} : { options: extra }) })
              return decide === undefined ? 'allow-once' : await decide(request, signal, extra)
            },
          }
        }
        return {
          decide: async (request: Record<string, unknown>, _signal: unknown, extra?: Record<string, unknown>) => {
            approvals.push({ request, ...(extra === undefined ? {} : { options: extra }) })
            return 'allow-once'
          },
        }
      }
      return undefined
    },
    effect(execute: () => unknown) {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
    on() {
      return () => undefined
    },
  }

  const cleanup = idx.dockBrowserPlugin.apply?.(ctx as never, options.config ?? {})
  const harness: BrowserHarness = {
    tools,
    section: sections[0]!,
    approvals,
    notes,
    dispose: () => {
      if (typeof cleanup === 'function') cleanup()
    },
  }
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.dispose()
    } catch {
      // 已经收过了
    }
  }
})

const RUN_CTX = (): { cwd: string; signal: AbortSignal; sessionId: string; sessionPath: string } => ({
  cwd: HOME,
  signal: new AbortController().signal,
  sessionId: 'sess-1',
  sessionPath: join(HOME, 'sess.jsonl'),
})

function tool(harness: BrowserHarness, name: 'browser_dock' | 'browser_dock_look'): ToolEntry {
  const found = harness.tools.get(name)
  if (found === undefined) throw new Error(`没有注册 ${name}`)
  return found
}

/** 跑一次工具调用，把人话报错抓出来（成功返回 null）。 */
async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}

/** 先做一次快照，把 ref 表填上。 */
async function snapshotOnce(harness: BrowserHarness, viewId = 'agent-1'): Promise<void> {
  await tool(harness, 'browser_dock_look').run({ action: 'snapshot', viewId }, RUN_CTX())
}

/** 常用的一台可见视图。 */
const AGENT_VIEW = { id: 'agent-1', url: 'https://example.com/', title: '示例', loading: false, visible: true }

// ── 快照与事件 ───────────────────────────────────────────────────────────────

describe('快照与事件缓冲', () => {
  test('snapshot：AX 树转成带 ref 的文本，四个域只开一次', async () => {
    const fake = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })

    const text = String(await tool(harness, 'browser_dock_look').run({ action: 'snapshot', viewId: 'agent-1' }, RUN_CTX()))
    expect(text).toContain('- button "存" [ref=e1]')
    expect(text).toContain('可交互元素 1 个')
    expect(text).toContain('本次 ref 1 个')

    await tool(harness, 'browser_dock_look').run({ action: 'snapshot', viewId: 'agent-1' }, RUN_CTX())
    for (const domain of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Accessibility.enable']) {
      expect(fake.calls.filter((call) => call.method === domain)).toHaveLength(1)
    }
  })

  test('console / network：事件入环形缓冲，clear 清空，空缓冲给人话', async () => {
    const fake = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })
    // 事件订阅在第一次 requireLink（views）时建立；之前的输出按设计拿不到。
    await tool(harness, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())

    fake.emit({ viewId: 'agent-1', method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: 'hello' }] } })
    fake.emit({ viewId: 'agent-1', method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'boom' } } })

    const consoleText = String(
      await tool(harness, 'browser_dock_look').run({ action: 'console', viewId: 'agent-1', clear: true }, RUN_CTX()),
    )
    expect(consoleText).toContain('hello')
    expect(consoleText).toContain('exception: boom')
    expect(consoleText).toContain('已清空缓冲')
    expect(
      String(await tool(harness, 'browser_dock_look').run({ action: 'console', viewId: 'agent-1' }, RUN_CTX())),
    ).toContain('还没有输出')

    fake.emit({
      viewId: 'agent-1',
      method: 'Network.requestWillBeSent',
      params: { requestId: 'r1', request: { url: 'https://example.com/api', method: 'GET' } },
    })
    fake.emit({
      viewId: 'agent-1',
      method: 'Network.responseReceived',
      params: { requestId: 'r1', response: { status: 200, mimeType: 'application/json' } },
    })
    fake.emit({
      viewId: 'agent-1',
      method: 'Network.requestWillBeSent',
      params: { requestId: 'r2', request: { url: 'https://bad.example/x', method: 'POST' } },
    })
    fake.emit({ viewId: 'agent-1', method: 'Network.loadingFailed', params: { requestId: 'r2', errorText: 'ENOTFOUND' } })

    const networkText = String(
      await tool(harness, 'browser_dock_look').run({ action: 'network', viewId: 'agent-1', clear: true }, RUN_CTX()),
    )
    expect(networkText).toContain('https://example.com/api')
    expect(networkText).toContain('200')
    expect(networkText).toContain('失败：ENOTFOUND')
    expect(fake.calls.some((call) => call.method === 'Network.enable')).toBe(true)
    expect(
      String(await tool(harness, 'browser_dock_look').run({ action: 'network', viewId: 'agent-1' }, RUN_CTX())),
    ).toContain('还没有记录到网络请求')
  })

  test('JS 对话框：opening 记状态并提示，dialog=accept 处理掉，closed 事件清状态', async () => {
    const fake = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })
    await tool(harness, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())

    fake.emit({ viewId: 'agent-1', method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: '确定吗？' } })
    expect(harness.notes.join('\n')).toContain('弹出了 confirm 对话框')

    const snap = String(await tool(harness, 'browser_dock_look').run({ action: 'snapshot', viewId: 'agent-1' }, RUN_CTX()))
    expect(snap.startsWith('⚠ 视图 agent-1 上有一个 confirm 对话框')).toBe(true)

    const accepted = String(
      await tool(harness, 'browser_dock').run({ action: 'dialog', viewId: 'agent-1', dialogAction: 'accept' }, RUN_CTX()),
    )
    expect(accepted).toContain('已接受视图 agent-1 的 confirm 对话框')
    expect(fake.calls.some((call) => call.method === 'Page.handleJavaScriptDialog' && call.params?.['accept'] === true)).toBe(true)

    expect(
      await errorOf(() => tool(harness, 'browser_dock').run({ action: 'dialog', viewId: 'agent-1', dialogAction: 'dismiss' }, RUN_CTX())),
    ).toContain('没有待处理的对话框')

    fake.emit({ viewId: 'agent-1', method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'hi' } })
    fake.emit({ viewId: 'agent-1', method: 'Page.javascriptDialogClosed', params: {} })
    const afterClose = String(
      await tool(harness, 'browser_dock_look').run({ action: 'snapshot', viewId: 'agent-1' }, RUN_CTX()),
    )
    expect(afterClose).not.toContain('⚠ 视图 agent-1 上有一个')
  })
})

// ── 动作 ─────────────────────────────────────────────────────────────────────

describe('动手动作', () => {
  test('click / hover / type / press / scroll 都按 ref 落到 CDP 命令', async () => {
    const fake = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })
    await snapshotOnce(harness)

    const clicked = String(
      await tool(harness, 'browser_dock').run({ action: 'click', viewId: 'agent-1', ref: 'e1' }, RUN_CTX()),
    )
    expect(clicked).toContain('已点击视图 agent-1 的 ref「e1」')
    const pressed = fake.calls.find((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.['type'] === 'mousePressed')
    expect(pressed?.params).toMatchObject({ x: 120, y: 110, button: 'left' })

    const hovered = String(
      await tool(harness, 'browser_dock').run({ action: 'hover', viewId: 'agent-1', ref: 'e1' }, RUN_CTX()),
    )
    expect(hovered).toContain('已把鼠标移到')

    const typed = String(
      await tool(harness, 'browser_dock').run({ action: 'type', viewId: 'agent-1', ref: 'e1', text: 'abc' }, RUN_CTX()),
    )
    expect(typed).toContain('输入 3 个字符')
    expect(fake.calls.some((call) => call.method === 'Input.insertText' && call.params?.['text'] === 'abc')).toBe(true)

    const pressedKey = String(
      await tool(harness, 'browser_dock').run({ action: 'press', viewId: 'agent-1', key: 'Enter' }, RUN_CTX()),
    )
    expect(pressedKey).toContain('已按键 Enter')
    expect(fake.calls.some((call) => call.method === 'Input.dispatchKeyEvent' && call.params?.['key'] === 'Enter')).toBe(true)

    const scrolled = String(
      await tool(harness, 'browser_dock').run({ action: 'scroll', viewId: 'agent-1', direction: 'down' }, RUN_CTX()),
    )
    expect(scrolled).toContain('已向 down 滚动')
    expect(fake.calls.some((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.['type'] === 'mouseWheel')).toBe(true)

    expect(await errorOf(() => tool(harness, 'browser_dock').run({ action: 'click', viewId: 'agent-1' }, RUN_CTX()))).toContain(
      '要一个 ref',
    )
    expect(
      await errorOf(() => tool(harness, 'browser_dock').run({ action: 'scroll', viewId: 'agent-1', direction: 'diagonal' }, RUN_CTX())),
    ).toContain('只能是 up/down')

    // 凭据形状的文本不代模型敲进输入框。
    expect(
      await errorOf(() =>
        tool(harness, 'browser_dock').run(
          { action: 'type', viewId: 'agent-1', ref: 'e1', text: 'sk-abcdefghijklmnop' },
          RUN_CTX(),
        ),
      ),
    ).toContain('密钥形状')
  })

  test('navigate：成功返回简版快照；页面报 errorText 时抛错', async () => {
    const fake = makeLink({ views: [AGENT_VIEW], documentUrl: 'https://example.com/next' })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })
    const navigated = String(
      await tool(harness, 'browser_dock').run(
        { action: 'navigate', viewId: 'agent-1', url: 'https://example.com/next' },
        RUN_CTX(),
      ),
    )
    expect(navigated).toContain('已打开 https://example.com/next')
    expect(navigated).toContain('加载状态 complete')
    expect(fake.calls.some((call) => call.method === 'Page.navigate')).toBe(true)

    const failing = makeLink({
      views: [AGENT_VIEW],
      responder: (method) => (method === 'Page.navigate' ? { errorText: 'ERR_NAME_NOT_RESOLVED' } : defaultResponder('https://x/')(method, undefined)),
    })
    const failingHarness = mount({ link: failing.link, config: { lookWithoutApproval: true } })
    expect(
      await errorOf(() =>
        tool(failingHarness, 'browser_dock').run({ action: 'navigate', viewId: 'agent-1', url: 'https://nope/' }, RUN_CTX()),
      ),
    ).toContain('ERR_NAME_NOT_RESOLVED')
  })

  test('ref 代际：主框架跳转与文档被换都会作废旧 ref，错误里带原因', async () => {
    const fake = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })
    await snapshotOnce(harness)

    fake.emit({ viewId: 'agent-1', method: 'Page.frameNavigated', params: { frame: { url: 'https://other.example/' } } })
    const afterFrame = await errorOf(() =>
      tool(harness, 'browser_dock').run({ action: 'click', viewId: 'agent-1', ref: 'e1' }, RUN_CTX()),
    )
    expect(afterFrame).toContain('页面已经跳转到别的地址')

    await snapshotOnce(harness)
    fake.emit({ viewId: 'agent-1', method: 'Runtime.executionContextsCleared', params: {} })
    const afterContext = await errorOf(() =>
      tool(harness, 'browser_dock').run({ action: 'click', viewId: 'agent-1', ref: 'e1' }, RUN_CTX()),
    )
    expect(afterContext).toContain('页面的文档被换掉了')
  })

  test('evaluate：正常求值；敏感原语与云元数据地址在进页面之前被拒', async () => {
    const fake = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })

    const evaluated = String(
      await tool(harness, 'browser_dock').run({ action: 'evaluate', viewId: 'agent-1', expression: '1+1' }, RUN_CTX()),
    )
    expect(evaluated).toContain('求值结果（视图 agent-1）')
    expect(evaluated).toContain('2')

    expect(
      await errorOf(() =>
        tool(harness, 'browser_dock').run({ action: 'evaluate', viewId: 'agent-1', expression: 'require("fs")' }, RUN_CTX()),
      ),
    ).toContain('敏感原语')
    expect(
      await errorOf(() =>
        tool(harness, 'browser_dock').run(
          { action: 'evaluate', viewId: 'agent-1', expression: 'fetch("http://169.254.169.254/latest/meta-data")' },
          RUN_CTX(),
        ),
      ),
    ).toContain('云元数据地址')
  })
})

// ── open / views / screenshot / wait_for ─────────────────────────────────────

describe('页签与只看动作', () => {
  test('views：agent / 用户页签与 visible 标记；空列表给人话', async () => {
    const fake = makeLink({
      views: [
        { id: 'agent-1', url: 'https://a.example/', title: 'A', loading: false, visible: true },
        { id: 'user-2', url: 'https://b.example/', title: 'B', loading: true, visible: false },
      ],
    })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })
    const text = String(await tool(harness, 'browser_dock_look').run({ action: 'views' }, RUN_CTX()))
    expect(text).toContain('agent-1（agent 开的）')
    expect(text).toContain('user-2（用户自己的）')
    expect(text).toContain('加载中')

    const empty = mount({ link: makeLink({ views: [] }).link, config: { lookWithoutApproval: true } })
    expect(String(await tool(empty, 'browser_dock_look').run({ action: 'views' }, RUN_CTX()))).toContain('一台 dock 视图都没有')
  })

  test('open：同址 agent 页签复用、带 viewId 只聚焦、新地址开新页签', async () => {
    const fake = makeLink({
      views: [{ id: 'agent-1', url: 'https://same.example/', title: '同址', loading: false, visible: true }],
      documentUrl: 'https://fresh.example/',
    })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })

    const reused = String(
      await tool(harness, 'browser_dock').run({ action: 'open', url: 'https://same.example/' }, RUN_CTX()),
    )
    expect(reused).toContain('复用了已有的 agent 页签 agent-1')
    expect(fake.opened).toHaveLength(0)

    const focused = String(
      await tool(harness, 'browser_dock').run({ action: 'open', url: 'https://other.example/', viewId: 'user-2' }, RUN_CTX()),
    )
    expect(focused).toContain('已聚焦指名的视图 user-2')
    expect(fake.opened[0]).toEqual({ url: 'https://other.example/', viewId: 'user-2' })

    const fresh = String(
      await tool(harness, 'browser_dock').run({ action: 'open', url: 'https://fresh.example/' }, RUN_CTX()),
    )
    expect(fresh).toContain('已让桌面壳开出一张页签')
    expect(fresh).toContain('页面落在 https://fresh.example/')
    expect(fake.opened.at(-1)).toEqual({ url: 'https://fresh.example/' })
  })

  test('screenshot：可见才截；没露出来与视图不存在都给人话', async () => {
    const visible = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: visible.link, config: { lookWithoutApproval: true } })
    const shot = (await tool(harness, 'browser_dock_look').run({ action: 'screenshot', viewId: 'agent-1' }, RUN_CTX())) as {
      text: string
      images: string[]
    }
    expect(shot.text).toContain('已截图')
    expect(shot.images[0]).toContain('data:image/png;base64,BASE64PNG')

    const hidden = makeLink({ views: [{ ...AGENT_VIEW, visible: false }] })
    const hiddenHarness = mount({ link: hidden.link, config: { lookWithoutApproval: true } })
    expect(
      await errorOf(() => tool(hiddenHarness, 'browser_dock_look').run({ action: 'screenshot', viewId: 'agent-1' }, RUN_CTX())),
    ).toContain('没露出来')

    const missingHarness = mount({ link: makeLink({ views: [] }).link, config: { lookWithoutApproval: true } })
    expect(
      await errorOf(() => tool(missingHarness, 'browser_dock_look').run({ action: 'screenshot', viewId: 'ghost' }, RUN_CTX())),
    ).toContain('没有 id 为 ghost 的 dock 视图')
  })

  test('wait_for：命中返回用时；超时与缺参数都报人话', async () => {
    const hit = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: hit.link, config: { lookWithoutApproval: true } })
    const text = String(
      await tool(harness, 'browser_dock_look').run({ action: 'wait_for', viewId: 'agent-1', text: '完成' }, RUN_CTX()),
    )
    expect(text).toContain('等到了 文本「完成」')

    const miss = mount({
      link: makeLink({
        views: [AGENT_VIEW],
        responder: (method, params) => {
          if (method === 'Runtime.evaluate' && String(params?.['expression'] ?? '').startsWith('!!')) {
            return { result: { value: false } }
          }
          return defaultResponder('https://example.com/')(method, params)
        },
      }).link,
      config: { lookWithoutApproval: true },
    })
    expect(
      await errorOf(() =>
        tool(miss, 'browser_dock_look').run({ action: 'wait_for', viewId: 'agent-1', selector: '#nope', timeoutMs: 100 }, RUN_CTX()),
      ),
    ).toContain('也没等到')
    expect(
      await errorOf(() => tool(miss, 'browser_dock_look').run({ action: 'wait_for', viewId: 'agent-1' }, RUN_CTX())),
    ).toContain('需要 text 或 selector')
  })

  test('没有 viewId 的动作报「先 open 或 views」', async () => {
    const harness = mount({ link: makeLink({ views: [AGENT_VIEW] }).link, config: { lookWithoutApproval: true } })
    expect(
      await errorOf(() => tool(harness, 'browser_dock').run({ action: 'click', ref: 'e1' }, RUN_CTX())),
    ).toContain('这一步要一个 viewId')
  })
})

// ── 审批与设置 ───────────────────────────────────────────────────────────────

describe('审批与设置分区', () => {
  test('confirmLook：审批服务缺失、免打扰、用户拒绝三条都「不读」；放行与免审批照读', async () => {
    const noApproval = mount({ link: makeLink({ views: [AGENT_VIEW] }).link, approval: null })
    expect(
      await errorOf(() => tool(noApproval, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())),
    ).toContain('审批服务没起来')

    const quiet = mount({ link: makeLink({ views: [AGENT_VIEW] }).link, mode: 'quiet' })
    expect(
      await errorOf(() => tool(quiet, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())),
    ).toContain('免打扰模式')

    const rejected = mount({ link: makeLink({ views: [AGENT_VIEW] }).link, approval: { decide: async () => 'reject' } })
    expect(
      await errorOf(() => tool(rejected, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())),
    ).toContain('用户没有同意这次「看一眼」')
    expect(rejected.approvals[0]?.request).toMatchObject({ toolName: 'browser_dock_look', sessionId: 'sess-1' })
    expect(rejected.approvals[0]?.options?.['forceAskReason']).toContain('看一眼侧栏浏览器')

    const allowed = mount({ link: makeLink({ views: [AGENT_VIEW] }).link })
    expect(String(await tool(allowed, 'browser_dock_look').run({ action: 'views' }, RUN_CTX()))).toContain('agent-1')
    expect(allowed.approvals).toHaveLength(1)

    const free = mount({ link: makeLink({ views: [AGENT_VIEW] }).link, config: { lookWithoutApproval: true }, approval: null })
    expect(String(await tool(free, 'browser_dock_look').run({ action: 'views' }, RUN_CTX()))).toContain('agent-1')
    expect(free.approvals).toHaveLength(0)
  })

  test('设置分区：values 读配置；save 未知键报错，切换免审批会重挂工具并改写 waitsForHuman', () => {
    const harness = mount({ link: makeLink({ views: [AGENT_VIEW] }).link })
    expect(harness.section.id).toBe('dock-browser')
    expect(harness.section.order).toBe(35)
    expect(harness.section.values()).toEqual({ lookWithoutApproval: false })
    expect(tool(harness, 'browser_dock_look').waitsForHuman).toBe(true)

    expect(harness.section.save!('nope', true)).toContain('没有这项')
    expect(harness.section.save!('lookWithoutApproval', true)).toBeUndefined()
    expect(harness.section.values()).toEqual({ lookWithoutApproval: true })
    expect(tool(harness, 'browser_dock_look').waitsForHuman).toBe(false)

    const saved = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
      entries: Array<{ file: string; config: Record<string, unknown> }>
    }
    const entry = saved.entries.find((item) => item.file === 'dock-browser')
    expect(entry?.config['lookWithoutApproval']).toBe(true)
  })

  test('close：关掉视图后状态与缓冲一起清；dispose：退订事件并注销工具', async () => {
    const fake = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })
    await snapshotOnce(harness)
    fake.emit({ viewId: 'agent-1', method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: 'before-close' }] } })

    await tool(harness, 'browser_dock').run({ action: 'close', viewId: 'agent-1' }, RUN_CTX())
    expect(fake.closed).toEqual(['agent-1'])
    expect(
      String(await tool(harness, 'browser_dock_look').run({ action: 'console', viewId: 'agent-1' }, RUN_CTX())),
    ).toContain('还没有输出')

    expect(fake.listeners.size).toBe(1)
    expect(harness.tools.size).toBe(2)
    harness.dispose()
    expect(fake.listeners.size).toBe(0)
    expect(harness.tools.size).toBe(0)
  })

  test('未知 action 与非法 url 都给人话', async () => {
    const harness = mount({ link: makeLink({ views: [AGENT_VIEW] }).link, config: { lookWithoutApproval: true } })
    expect(await errorOf(() => tool(harness, 'browser_dock').run({ action: 'dance' }, RUN_CTX()))).toContain('未知 action')
    expect(await errorOf(() => tool(harness, 'browser_dock_look').run({ action: 'dance' }, RUN_CTX()))).toContain('未知 action')
    expect(
      await errorOf(() => tool(harness, 'browser_dock').run({ action: 'open', url: 'javascript:alert(1)' }, RUN_CTX())),
    ).toContain('只允许 http/https')
  })
})

// ── 弹窗、地址比较与事件补盲（w13）──────────────────────────────────────────

describe('w13 补盲：弹窗兜底、等待落地、事件与快照细节', () => {
  test('地址根本解析不了：open 在进审批前就报「地址解析不了」', async () => {
    const harness = mount({ link: makeLink({ views: [AGENT_VIEW] }).link, config: { lookWithoutApproval: true } })
    expect(
      await errorOf(() => tool(harness, 'browser_dock').run({ action: 'open', url: '不是地址' }, RUN_CTX())),
    ).toContain('地址解析不了')
  })

  test('快照超出行/字符上限：说明还有多少行没显示', async () => {
    const bigTree: Responder = (method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: Array.from({ length: 40 }, (_unused, index) => ({
            nodeId: String(index + 1),
            role: { value: 'button' },
            name: { value: `按钮名称第 ${String(index)} 号很长很长很长` },
            backendDOMNodeId: 100 + index,
          })),
        }
      }
      return defaultResponder('https://example.com/')(method, params)
    }
    const harness = mount({ link: makeLink({ views: [AGENT_VIEW], responder: bigTree }).link, config: { lookWithoutApproval: true } })
    const text = String(
      await tool(harness, 'browser_dock_look').run({ action: 'snapshot', viewId: 'agent-1', maxChars: 500 }, RUN_CTX()),
    )
    expect(text).toContain('没显示')
    expect(text).toContain('后面截断了')
  })

  test('open 等落地：地址完全不像 / 只是前缀相像都算没到，再读一次对上才算', async () => {
    /** 前几次读到的地址按顺序给，用完之后固定给最后一个。 */
    const sequenceResponder = (urls: string[]): Responder => {
      let index = 0
      const base = defaultResponder(urls[urls.length - 1] as string)
      return (method, params) => {
        if (method === 'Runtime.evaluate' && String(params?.['expression'] ?? '').includes('location.href')) {
          const url = urls[Math.min(index, urls.length - 1)] as string
          index += 1
          return { result: { value: { url, title: '中间态', readyState: 'complete' } } }
        }
        return base(method, params)
      }
    }

    // 完全不沾边：走「前缀都不匹配」那条比较
    const unrelated = mount({
      link: makeLink({ responder: sequenceResponder(['https://wrong.example/', 'https://example.com/']) }).link,
      config: { lookWithoutApproval: true },
    })
    const first = String(
      await tool(unrelated, 'browser_dock').run({ action: 'open', url: 'https://example.com/' }, RUN_CTX()),
    )
    expect(first).toContain('页面落在 https://example.com/')

    // 只是前缀相像（example.com 与 example.com/pathology）：URL 边界不算到
    const lookalike = mount({
      link: makeLink({
        responder: sequenceResponder(['https://example.com/pathology', 'https://example.com/path']),
      }).link,
      config: { lookWithoutApproval: true },
    })
    const second = String(
      await tool(lookalike, 'browser_dock').run({ action: 'open', url: 'https://example.com/path' }, RUN_CTX()),
    )
    expect(second).toContain('页面落在 https://example.com/path')
  })

  test('白名单之外的事件静默忽略；换链路时旧订阅退不掉也照样订新的', async () => {
    const ignored = makeLink({ views: [AGENT_VIEW] })
    const ignoredHarness = mount({ link: ignored.link, config: { lookWithoutApproval: true } })
    await tool(ignoredHarness, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())
    ignored.emit({ viewId: 'agent-1', method: 'Runtime.somethingElse', params: {} })
    expect(
      String(await tool(ignoredHarness, 'browser_dock_look').run({ action: 'console', viewId: 'agent-1' }, RUN_CTX())),
    ).toContain('还没有输出')

    // 旧链路的退订函数抛错：吞掉，不挡新订阅
    const first = makeLink({ views: [AGENT_VIEW] })
    first.link.onEvent = () => () => {
      throw new Error('退订失败')
    }
    const options: { link?: Record<string, unknown> } = { link: first.link }
    const harness = mount(options as never)
    await tool(harness, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())
    const second = makeLink({ views: [AGENT_VIEW] })
    options.link = second.link
    await tool(harness, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())
    expect(second.listeners.size).toBe(1)
    second.emit({ viewId: 'agent-1', method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: '新链路' }] } })
    expect(
      String(await tool(harness, 'browser_dock_look').run({ action: 'console', viewId: 'agent-1' }, RUN_CTX())),
    ).toContain('新链路')
  })

  test('弹窗 25 秒没人处理：自动 dismiss，说明只随下一次结果带一次', async () => {
    const fake = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })
    vi.useFakeTimers()
    try {
      await tool(harness, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())
      fake.emit({
        viewId: 'agent-1',
        method: 'Page.javascriptDialogOpening',
        params: { type: 'confirm', message: '要保存吗' },
      })
      expect(harness.notes.join('\n')).toContain('弹出了 confirm 对话框')
      await vi.advanceTimersByTimeAsync(DOCK_CALL_TIMEOUT_MS + 10)
    } finally {
      vi.useRealTimers()
    }
    expect(harness.notes.join('\n')).toContain('已自动关掉')
    expect(fake.calls.some((call) => call.method === 'Page.handleJavaScriptDialog')).toBe(true)

    const first = String(await tool(harness, 'browser_dock_look').run({ action: 'snapshot', viewId: 'agent-1' }, RUN_CTX()))
    expect(first).toContain('已自动关掉')
    const second = String(await tool(harness, 'browser_dock_look').run({ action: 'snapshot', viewId: 'agent-1' }, RUN_CTX()))
    expect(second).not.toContain('已自动关掉')
  })

  test('dialog 动作：缺 dialogAction、要输入的文本像密钥、正常接受', async () => {
    const fake = makeLink({ views: [AGENT_VIEW] })
    const harness = mount({ link: fake.link, config: { lookWithoutApproval: true } })
    await tool(harness, 'browser_dock_look').run({ action: 'views' }, RUN_CTX())
    fake.emit({
      viewId: 'agent-1',
      method: 'Page.javascriptDialogOpening',
      params: { type: 'prompt', message: '名字', defaultPrompt: '默认名字' },
    })

    expect(
      await errorOf(() => tool(harness, 'browser_dock').run({ action: 'dialog', viewId: 'agent-1' }, RUN_CTX())),
    ).toContain('dialog 需要 dialogAction')

    expect(
      await errorOf(() =>
        tool(harness, 'browser_dock').run(
          { action: 'dialog', viewId: 'agent-1', dialogAction: 'accept', promptText: 'sk-abcdefghijklmnop' },
          RUN_CTX(),
        ),
      ),
    ).toContain('密钥形状')

    // 前两次失败没把弹窗处理掉：正常接受才真正关
    const accepted = String(
      await tool(harness, 'browser_dock').run(
        { action: 'dialog', viewId: 'agent-1', dialogAction: 'accept', promptText: '新名字' },
        RUN_CTX(),
      ),
    )
    expect(accepted).toContain('已接受视图 agent-1 的 prompt 对话框')
    expect(fake.calls.some((call) => call.method === 'Page.handleJavaScriptDialog')).toBe(true)
  })
})
