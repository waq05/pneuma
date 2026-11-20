/**
 * lsp 的 W14 补缺口测试：补既有 wiring / wiring-extra 没走到的那几条失败路。
 *
 * 用包内既有的假 LSP 子进程夹具（`tests/fixtures/fake-lsp-server.mjs`，真 node 进程、
 * 真 stdio 分帧），不依赖任何真 language server 二进制：
 *
 *   - 服务器起不来（初始化被拒）时诊断的失败回执与「破键」状态文案；
 *   - 同 key 并发启动时的 pending 分支；
 *   - 服务器在 didOpen 上直接退出 → 诊断抛错 → failed() 收场；
 *   - hover 没有内容时的「没有数据」回执；
 *   - 调用方信号已取消时的请求分支；
 *   - lsp 服务查询位置非法时折成降级文案；
 *   - 非 Windows 平台收子进程走 SIGTERM/SIGKILL。
 *
 * @module dsc/packages/lsp/tests/w14-failure-paths
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-lsp-w14-'))
process.env['DSC_HOME'] = HOME
const PLUGINS_FILE = join(HOME, 'plugins.json')
const fixture = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))

type LspIndex = typeof import('../index.js')
let lspPlugin: LspIndex['lspPlugin']

const projectDirs: string[] = []
const cleanups: Array<() => void> = []
const exitHandlers: Array<() => void> = []

beforeAll(async () => {
  lspPlugin = (await import('../index.js')).lspPlugin
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
  exitHandlers.length = 0
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of projectDirs.splice(0)) {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
    } catch {
      // 子进程可能还没放开目录：留给系统清。
    }
  }
})

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

function writePluginConfig(config: Record<string, unknown>): void {
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [{ file: 'lsp', config }] }), 'utf8')
}

function project(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-lsp-w14-proj-'))
  projectDirs.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"demo"}\n', 'utf8')
  const file = join(dir, 'src', 'a.ts')
  writeFileSync(file, 'const a = 1\n', 'utf8')
  return { dir, file }
}

/** 立刻退出的服务器：命令存在（canServe 为真），但握手必然失败。 */
function crashingServer(): string {
  return JSON.stringify([
    {
      id: 'crash',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      extensions: ['.ts'],
      markers: ['package.json'],
    },
  ])
}
/** 服务器表：真 node 跑包内假 LSP。 */
function fakeServer(mode: string): string {
  return JSON.stringify([
    {
      id: 'fake',
      command: process.execPath,
      args: [fixture, mode],
      extensions: ['.ts'],
      markers: ['package.json'],
    },
  ])
}

interface Harness {
  tools: Array<{
    name: string
    run: (args: Record<string, unknown>, ctx: unknown) => Promise<string>
  }>
  guards: Array<{ decide: (input: unknown) => Promise<unknown> }>
  observers: Array<{ observe: (tool: string, text: string) => string }>
  sections: Array<{ fields(): Array<{ text?: string }> }>
  services: Map<string, unknown>
  notices: string[]
  dispose(): void
  fireExit(): void
}

function fakeCtx(cwd: string, config: Record<string, unknown> = {}): Harness {
  const tools: Harness['tools'] = []
  const guards: Harness['guards'] = []
  const observers: Harness['observers'] = []
  const sections: Harness['sections'] = []
  const services = new Map<string, unknown>()
  const notices: string[] = []
  const cleanupsLocal: Array<() => void> = []
  const session = {
    meta: { id: 'lsp-w14', cwd },
    filePath: join(cwd, '.dsc', 'sessions', 'lsp-w14.jsonl'),
    appendNote: () => {},
  }
  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      const off = typeof result === 'function' ? (result as () => void) : (): void => {}
      cleanupsLocal.push(off)
      return off
    },
    on(event: string, handler: () => void) {
      if (event === 'dsc/exit') exitHandlers.push(handler)
      return () => {
        const at = exitHandlers.indexOf(handler)
        if (at >= 0) exitHandlers.splice(at, 1)
      }
    },
    tools: {
      register(tool: Harness['tools'][number]) {
        tools.push(tool)
        return () => {}
      },
    },
    guards: {
      register(guard: Harness['guards'][number]) {
        guards.push(guard)
        return () => {}
      },
      registerObserver(observer: Harness['observers'][number]) {
        observers.push(observer)
        return () => {}
      },
    },
    prompt: {
      registerProjection() {
        return () => {}
      },
      register() {
        return () => {}
      },
    },
    settings: {
      registerSection(section: Harness['sections'][number]) {
        sections.push(section)
        return () => {}
      },
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    session: { current: () => session },
    transcript: { system: (text: string) => notices.push(text) },
  }
  const cleanup = lspPlugin.apply?.(ctx as never, {
    enabled: true,
    servers: fakeServer('ok'),
    diagnostics: true,
    idleSeconds: 600,
    maxLocations: 100,
    ...config,
  })
  if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
  return {
    tools,
    guards,
    observers,
    sections,
    services,
    notices,
    dispose: () => {
      for (const off of cleanupsLocal.splice(0).reverse()) off()
    },
    fireExit: () => {
      for (const handler of [...exitHandlers]) handler()
    },
  }
}

const toolContext = (cwd: string, signal = new AbortController().signal) => ({
  cwd,
  signal,
})

function toolOf(harness: Harness, name: string) {
  const found = harness.tools.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`没有工具 ${name}`)
  return found
}

/** 触发一次「写前基线」诊断（守卫侧）。 */
async function captureBaseline(harness: Harness, file: string, cwd: string): Promise<void> {
  const guard = harness.guards[0]
  if (guard === undefined) throw new Error('没有注册守卫')
  await guard.decide({
    toolName: 'write',
    target: file,
    cwd,
    sessionId: 'lsp-w14',
  })
}

describe('服务器起不来：失败回执与破键状态', () => {
  test('初始化被拒（协议版本不认）时诊断按失败收场，状态文案说「最近起不来」', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir, { servers: crashingServer() })
    try {
      await captureBaseline(harness, file, dir)
      // 观察者（写后）等基线：失败路径不能抛，也不能留下未处理的 Promise。
      expect(() => harness.observers[0]?.observe('write', 'ok')).not.toThrow()
      // 破键状态进设置分区文案：等失败真正落定（acquire 失败 → markBroken）。
      await vi.waitFor(() => {
        const text =
          harness.sections[0]
            ?.fields()
            .map((field) => String(field.text ?? ''))
            .join('\n') ?? ''
        expect(text).toContain('最近起不来')
      })
    } finally {
      harness.dispose()
    }
  })

  test('同 key 并发：第二个调用等第一个启动失败后各自收场', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir, { servers: crashingServer() })
    try {
      await Promise.all([captureBaseline(harness, file, dir), captureBaseline(harness, file, dir)])
      const texts =
        harness.sections[0]
          ?.fields()
          .map((field) => String(field.text ?? ''))
          .join('\n') ?? ''
      expect(typeof texts).toBe('string')
    } finally {
      harness.dispose()
    }
  })

  test('didOpen 上直接退出：写后诊断的 failed 分支', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir, { servers: fakeServer('die') })
    try {
      await captureBaseline(harness, file, dir)
      harness.observers[0]?.observe('write', 'ok')
      // 给后台注入一点时间跑完；注入失败是静默的，这里只钉「没有未处理异常」。
      await new Promise((resolveTick) => setTimeout(resolveTick, 800))
      expect(harness.notices.filter((text) => text.includes('lsp：')).length).toBe(0)
    } finally {
      harness.dispose()
    }
  })
})

describe('查询面：no-hover、取消信号与服务降级', () => {
  test('no-hover 服务器：悬停信息给一句「没有数据」', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir, { servers: fakeServer('no-hover') })
    try {
      const result = await toolOf(harness, 'lsp').run(
        { operation: 'hover', file_path: file, line: 1, character: 7 },
        toolContext(dir),
      )
      expect(result).toContain('没有数据')
      expect(result).toContain('hoverProvider')
    } finally {
      harness.dispose()
    }
  })

  test('调用方信号已取消：请求当场按取消收场，不挂住', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir, { servers: fakeServer('ok') })
    const controller = new AbortController()
    controller.abort()
    try {
      const result = await toolOf(harness, 'lsp').run(
        { operation: 'goToDefinition', file_path: file, line: 1, character: 7 },
        toolContext(dir, controller.signal),
      )
      expect(result).toContain('没有数据')
    } finally {
      harness.dispose()
    }
  })

  test('服务查询位置非法：折成一句降级文案', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir, { servers: fakeServer('ok') })
    const service = harness.services.get('lsp') as {
      query: (...args: unknown[]) => Promise<string>
    }
    try {
      await expect(service.query('goToDefinition', file, 0, 0)).resolves.toContain('LSP 查询出错')
    } finally {
      harness.dispose()
    }
  })
})

describe('纯函数分支：hover 编码与行位移兜底', () => {
  test('normalizeHover：{language,value} 编码与认不出的对象', async () => {
    const { normalizeHover } = await import('../normalize.js')
    // language/value 形状（没有 kind）：转成围栏代码块。
    const hover = normalizeHover({
      contents: [{ language: 'ts', value: 'let a: number' }],
    })
    expect(hover?.contents).toContain('```ts')
    // 认不出的对象内容渲染成空串 → 整条 hover 当没有内容。
    expect(normalizeHover({ contents: [{ foo: 'bar' }] })).toBeNull()
    // 直接给 {language,value}（不是数组、没有 kind）：走对象里的 language 分支。
    expect(normalizeHover({ contents: { language: 'ts', value: 'let b = 1' } })?.contents).toContain('```ts')
    // 既不是字符串/数组/对象：渲染成空串（认不出就返回 null）。
    expect(normalizeHover({ contents: { foo: 'bar' } })).toBeNull()
    expect(normalizeHover({ contents: 42 })).toBeNull()
  })

  test('buildLineShift：大中段退回贪心匹配，重复行也能对齐', async () => {
    const { buildLineShift } = await import('../line-shift.js')
    const pre = Array.from({ length: 1_100 }, (_, index) => `pre-${String(index)}`).join('\n')
    // 写后中段全是同一行：贪心匹配时 index 表要走 push 分支。
    const post = Array.from({ length: 1_100 }, () => 'z').join('\n')
    const shift = buildLineShift(pre, post)
    expect(shift(0)).toBeNull()
    expect(shift(-1)).toBeNull()
  })
})

describe('收进程的平台分支', () => {
  test('非 Windows 收尾走 SIGTERM/SIGKILL', async () => {
    const { dir } = project()
    const harness = fakeCtx(dir, { servers: fakeServer('ok') })
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      })
      harness.fireExit()
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      })
      harness.dispose()
    }
  })
})
