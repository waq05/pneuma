/**
 * lsp 插件装配面（`packages/lsp/index.ts`）：工具、写前基线守卫、写后诊断观察者、
 * 提示词投影、设置分区与 lsp 服务。
 *
 * 管理器与语言服务器是真的：配置里覆盖一个认领 `.ts` 的服务器，命令指向
 * `lsp/tests/fixtures/fake-lsp-server.mjs`。假 ctx 只负责把挂载点收下并给出会话。
 *
 * @module dsc/packages/lsp/tests/wiring.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-lsp-wiring-'))
process.env['DSC_HOME'] = HOME

const fixture = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))

type LspIndex = typeof import('../index.js')
let lspPlugin: LspIndex['lspPlugin']

const projectDirs: string[] = []
const cleanups: Array<() => void> = []

beforeAll(async () => {
  lspPlugin = (await import('../index.js')).lspPlugin
})

afterEach(() => {
  // apply 返回的收尾会 dispose 管理器（杀掉语言服务器），不调它目录会被子进程占着。
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of projectDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // 子进程可能还没完全放开目录：临时目录留给系统清，不让收尾拖红测试。
    }
  }
})

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 一个带 package.json 标记的项目根 + 一个 .ts 文件。 */
function project(body = 'const a = 1\n'): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-lsp-wiring-proj-'))
  projectDirs.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"demo"}\n', 'utf8')
  const file = join(dir, 'src', 'a.ts')
  writeFileSync(file, body, 'utf8')
  return { dir, file }
}

/** 覆盖一个认领 .ts 的服务器：真 node 跑假 LSP。 */
function serverConfig(mode = 'ok'): string {
  return JSON.stringify([
    { id: 'fake', command: process.execPath, args: [fixture, mode], extensions: ['.ts'], markers: ['package.json'] },
  ])
}

interface Harness {
  tools: Array<{ name: string; risk: string; run: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }>
  guards: Array<{ id: string; order: number; decide: (input: unknown) => Promise<unknown> }>
  observers: Array<{ id: string; order: number; observe: (tool: string, text: string) => string }>
  projections: Array<(messages: unknown[], session?: unknown) => unknown[]>
  sections: Array<Record<string, unknown>>
  services: Map<string, unknown>
  notices: string[]
  notes: Array<{ kind: string; text: string }>
  session: { meta: { id: string; cwd: string }; filePath: string; appendNote: (kind: string, text: string) => void }
}

/** 假 ctx：默认启用诊断、会话目录指向 `cwd`。 */
function fakeCtx(cwd: string, config: Record<string, unknown> = {}): Harness {
  const tools: Harness['tools'] = []
  const guards: Harness['guards'] = []
  const observers: Harness['observers'] = []
  const projections: Harness['projections'] = []
  const sections: Array<Record<string, unknown>> = []
  const services = new Map<string, unknown>()
  const notices: string[] = []
  const notes: Array<{ kind: string; text: string }> = []
  const session = {
    meta: { id: 'sess-1', cwd },
    filePath: join(cwd, '.dsc', 'sessions', 'a.jsonl'),
    appendNote: (kind: string, text: string): void => {
      notes.push({ kind, text })
    },
  }
  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    on() {
      return () => undefined
    },
    tools: {
      register(tool: Harness['tools'][number]) {
        tools.push(tool)
        return () => undefined
      },
    },
    guards: {
      register(guard: Harness['guards'][number]) {
        guards.push(guard)
        return () => undefined
      },
      registerObserver(observer: Harness['observers'][number]) {
        observers.push(observer)
        return () => undefined
      },
    },
    prompt: {
      registerProjection(_id: string, fn: Harness['projections'][number]) {
        projections.push(fn)
        return () => undefined
      },
      register() {
        return () => undefined
      },
    },
    settings: {
      registerSection(section: Record<string, unknown>) {
        sections.push(section)
        return () => undefined
      },
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    session,
    transcript: { system: (text: string) => notices.push(text) },
  }
  const cleanup = lspPlugin.apply?.(ctx as never, {
    enabled: true,
    servers: serverConfig(),
    diagnostics: true,
    idleSeconds: 600,
    maxLocations: 100,
    ...config,
  })
  if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
  return { tools, guards, observers, projections, sections, services, notices, notes, session }
}

const toolContext = (cwd: string): { cwd: string; signal: AbortSignal } => ({ cwd, signal: new AbortController().signal })
const textOf = (value: unknown): string => String(value)

describe('注册与工具', () => {
  test('工具、守卫、观察者、投影、设置分区与服务都挂上了', () => {
    const { dir } = project()
    const harness = fakeCtx(dir)
    expect(harness.tools[0]).toMatchObject({ name: 'lsp', risk: 'read' })
    expect(harness.guards[0]).toMatchObject({ id: 'lsp-observe', order: 7 })
    expect(harness.observers[0]).toMatchObject({ id: 'lsp', order: 46 })
    expect(harness.projections).toHaveLength(1)
    expect(harness.sections[0]).toMatchObject({ id: 'lsp', order: 33 })
    expect(harness.services.get('lsp')).toBeDefined()
  })

  test('查询成功：定义与引用给路径，hover 给正文，implementation 空结果也给人话', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir)
    const tool = harness.tools[0]!
    const run = (args: Record<string, unknown>): Promise<string> => tool.run(args, toolContext(dir))

    const definition = await run({ operation: 'goToDefinition', file_path: file, line: 1, character: 1 })
    expect(definition).toContain('找到 1 处')
    expect(definition).toContain('a.ts')

    const references = await run({ operation: 'findReferences', file_path: file, line: 1, character: 1 })
    expect(references).toContain('找到 2 处')

    const hover = await run({ operation: 'hover', file_path: file, line: 1, character: 1 })
    expect(hover).toContain('悬停信息')
    expect(hover).toContain('## 标题')

    const implementation = await run({ operation: 'goToImplementation', file_path: file, line: 1, character: 1 })
    expect(implementation).toContain('没有结果')
  })

  test('参数与配置问题都返回「没有数据」而不是抛错', async () => {
    const { dir, file } = project()
    const disabled = fakeCtx(dir, { enabled: false })
    expect(await disabled.tools[0]!.run({ operation: 'hover', file_path: file, line: 1, character: 1 }, toolContext(dir))).toContain(
      '关着',
    )

    const harness = fakeCtx(dir)
    const run = (args: Record<string, unknown>): Promise<string> => harness.tools[0]!.run(args, toolContext(dir))
    expect(await run({ operation: 'dance', file_path: file, line: 1, character: 1 })).toContain('operation 只能是')
    expect(await run({ operation: 'hover', file_path: '  ', line: 1, character: 1 })).toContain('file_path')
    expect(await run({ operation: 'hover', file_path: file, line: 0, character: 1 })).toContain('没有数据')
    expect(await run({ operation: 'hover', file_path: join(dir, 'none.ts'), line: 1, character: 1 })).toContain('文件不存在')

    const other = join(dir, 'x.xyz')
    writeFileSync(other, 'x', 'utf8')
    expect(await run({ operation: 'hover', file_path: other, line: 1, character: 1 })).toContain('没有认领 .xyz')
  })

  test('服务器命令不存在：工具文案里说清 PATH 找不到', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir, {
      servers: JSON.stringify([
        { id: 'fake', command: 'no-such-lsp-bin-xyz', args: [], extensions: ['.ts'], markers: ['package.json'] },
      ]),
    })
    const outcome = await harness.tools[0]!.run(
      { operation: 'hover', file_path: file, line: 1, character: 1 },
      toolContext(dir),
    )
    expect(outcome).toContain('PATH 里找不到')
  })
})

describe('设置分区与服务', () => {
  test('values 给当前配置；保存坏清单抛错、好清单落盘并用夹取后的数字', () => {
    const { dir } = project()
    const harness = fakeCtx(dir)
    const section = harness.sections[0] as unknown as {
      values(): Record<string, unknown>
      save(key: string, value: unknown): void
      action(name: string): string
    }
    expect(section.values()).toMatchObject({ enabled: true, diagnostics: true, idleSeconds: 600, maxLocations: 100 })
    expect(() => section.save('servers', '[{"id":1}]')).toThrow()
    expect(() => section.save('idleSeconds', 'abc')).toThrow()
    expect(() => section.save('nope', 1)).toThrow()

    section.save('idleSeconds', 5)
    section.save('maxLocations', 9999)
    section.save('servers', '[]')
    const saved = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
      entries?: Array<{ file?: string; config?: Record<string, unknown> }>
    }
    const entry = saved.entries?.find((item) => item.file === 'lsp')
    expect(entry?.config).toMatchObject({ idleSeconds: 30, maxLocations: 1000, servers: '[]' })
    expect(section.action('status')).toContain('服务器')
    expect(() => section.action('nope')).toThrow()
  })

  test('服务：query 拒绝非法操作名、status 给数组、servers 列出内置与覆盖', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir)
    const service = harness.services.get('lsp') as {
      query(op: string, file: string, line: number, character: number): Promise<string>
      status(): unknown[]
      servers(): Array<{ id: string }>
    }
    expect(await service.query('dance', file, 1, 1)).toContain('没有数据')
    expect(Array.isArray(service.status())).toBe(true)
    expect(service.servers().some((server) => server.id === 'fake')).toBe(true)
    expect(await service.query('hover', file, 1, 1)).toContain('悬停信息')
  })
})

describe('写前基线与写后诊断', () => {
  test('写类工具记底；写后新增的 ERROR 攒到该会话的下一次请求', async () => {
    const { dir, file } = project('const a = 1\n')
    const harness = fakeCtx(dir)
    const guard = harness.guards[0]!
    expect(await guard.decide({ toolName: 'read', target: file, cwd: dir, sessionId: 'sess-1' })).toEqual({ action: 'defer' })
    expect(await guard.decide({ toolName: 'edit', cwd: dir, sessionId: 'sess-1' })).toEqual({ action: 'defer' })

    // 动手：写前基线入队（真起一次假服务器），然后文件变长。
    expect(
      await guard.decide({ toolName: 'edit', target: file, cwd: dir, sessionId: 'sess-1' }),
    ).toEqual({ action: 'defer' })
    writeFileSync(file, 'const a = 1\nconst b = 2\n', 'utf8')
    expect(harness.observers[0]!.observe('edit', '已写入')).toBe('已写入')

    // 写后查询与差集是异步的：等那条会话通知出现。
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !harness.notices.some((text) => text.includes('新引入'))) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(harness.notices.some((text) => text.includes('新引入'))).toBe(true)

    const messages = [{ role: 'user', content: '继续' }]
    const next = harness.projections[0]!(messages, harness.session) as Array<{ role: string; content: string }>
    expect(next).toHaveLength(2)
    expect(next[1]!.content).toContain('【LSP 诊断】')
    expect(next[1]!.content).toContain('<diagnostics file=')
    expect(harness.notes.some((note) => note.kind === 'lsp-write-diagnostics')).toBe(true)
    // 交过一次就清掉：下一次请求不再重复。
    expect(harness.projections[0]!(messages, harness.session)).toEqual(messages)
  }, 40_000)

  test('诊断关掉时守卫不动手（不白起服务器）', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir, { diagnostics: false })
    expect(await harness.guards[0]!.decide({ toolName: 'edit', target: file, cwd: dir, sessionId: 'sess-1' })).toEqual({
      action: 'defer',
    })
    expect(await harness.guards[0]!.decide({ toolName: 'edit', target: file, cwd: dir })).toEqual({ action: 'defer' })
    expect(textOf(harness.notices.join('\n'))).toBe('')
  })
})
