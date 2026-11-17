/**
 * lsp 插件装配面的补盲（`packages/lsp/index.ts`）：配置夹取与磁盘覆盖、设置保存失败不落盘、
 * 服务器状态文案、系统提示开关、诊断注入的会话归属与边界、查询失败的渲染分支、退出收进程。
 *
 * `tests/wiring.spec.ts` 已覆盖注册、四个操作的主路径、写前基线 → 写后差集与基本设置；
 * 这一份只补那之外的边界。管理器与假语言服务器是真的，收尾统一 dispose。
 *
 * @module dsc/packages/lsp/tests/wiring-extra.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-lsp-extra-'))
process.env['DSC_HOME'] = HOME
const PLUGINS_FILE = join(HOME, 'plugins.json')

const fixture = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))

type LspIndex = typeof import('../index.js')
let lspPlugin: LspIndex['lspPlugin']

const projectDirs: string[] = []
const cleanups: Array<() => void> = []

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
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of projectDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // 子进程可能还没放开目录：留给系统清。
    }
  }
})

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 写磁盘上的插件配置（下次 readConfig 立刻生效）。 */
function writePluginConfig(config: Record<string, unknown>): void {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [{ file: 'lsp', config }] }), 'utf8')
}

function readPluginConfig(): Record<string, unknown> {
  const saved = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8')) as {
    entries?: Array<{ file?: string; config?: Record<string, unknown> }>
  }
  return saved.entries?.find((entry) => entry.file === 'lsp')?.config ?? {}
}

function project(body = 'const a = 1\n'): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-lsp-extra-proj-'))
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

interface SessionLike {
  meta: { id: string; cwd: string }
  filePath: string
  appendNote: (kind: string, text: string) => void
  notes: Array<{ kind: string; text: string }>
}

function makeSession(id: string, cwd: string): SessionLike {
  const notes: Array<{ kind: string; text: string }> = []
  return {
    meta: { id, cwd },
    filePath: join(cwd, '.dsc', 'sessions', `${id}.jsonl`),
    appendNote: (kind: string, text: string): void => {
      notes.push({ kind, text })
    },
    notes,
  }
}

interface Harness {
  tools: Array<{ name: string; run: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }>
  guards: Array<{ id: string; order: number; decide: (input: unknown) => Promise<unknown> }>
  observers: Array<{ id: string; order: number; observe: (tool: string, text: string) => string }>
  projections: Array<(messages: unknown[], session?: SessionLike) => unknown[]>
  sections: Array<Record<string, unknown>>
  services: Map<string, unknown>
  notices: string[]
  prompts: Array<{ id: string; fn: () => string }>
  exitHandlers: Array<() => void>
  session: SessionLike
}

function fakeCtx(cwd: string, config: Record<string, unknown> = {}): Harness {
  const tools: Harness['tools'] = []
  const guards: Harness['guards'] = []
  const observers: Harness['observers'] = []
  const projections: Harness['projections'] = []
  const sections: Array<Record<string, unknown>> = []
  const services = new Map<string, unknown>()
  const notices: string[] = []
  const prompts: Harness['prompts'] = []
  const exitHandlers: Array<() => void> = []
  const session = makeSession('sess-1', cwd)
  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    on(event: string, handler: () => void) {
      if (event === 'dsc/exit') exitHandlers.push(handler)
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
      register(id: string, fn: () => string) {
        prompts.push({ id, fn })
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
    session: { current: () => session },
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
  return { tools, guards, observers, projections, sections, services, notices, prompts, exitHandlers, session }
}

const toolContext = (cwd: string): { cwd: string; signal: AbortSignal } => ({ cwd, signal: new AbortController().signal })
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('配置读取与夹取', () => {
  test('类型不对的项回缺省；数字夹进区间；磁盘配置逐键压过装配时那份', () => {
    const { dir } = project()
    const wrongTypes = fakeCtx(dir, {
      enabled: 'yes',
      servers: 42,
      idleSeconds: 1,
      diagnostics: 'no',
      maxLocations: -5,
    })
    const section = wrongTypes.sections[0] as unknown as { values(): Record<string, unknown> }
    expect(section.values()).toMatchObject({
      enabled: true,
      servers: '',
      idleSeconds: 30,
      diagnostics: true,
      maxLocations: 1,
    })

    writePluginConfig({ enabled: false, servers: '', idleSeconds: 999_999, diagnostics: false, maxLocations: 99_999 })
    const fromDisk = fakeCtx(dir)
    const diskSection = fromDisk.sections[0] as unknown as { values(): Record<string, unknown> }
    expect(diskSection.values()).toMatchObject({
      enabled: false,
      servers: '',
      idleSeconds: 86_400,
      diagnostics: false,
      maxLocations: 1_000,
    })
  })

  test('保存：开关键收字符串真值；合法清单立刻进服务表；失败时不落盘', () => {
    const { dir } = project()
    const harness = fakeCtx(dir)
    const section = harness.sections[0] as unknown as {
      values(): Record<string, unknown>
      save(key: string, value: unknown): void
    }
    const service = harness.services.get('lsp') as { servers(): Array<{ id: string }> }

    section.save('enabled', 'true')
    section.save('diagnostics', false)
    expect(readPluginConfig()).toMatchObject({ enabled: true, diagnostics: false })
    expect(section.values()).toMatchObject({ enabled: true, diagnostics: false })

    const custom = JSON.stringify([
      { id: 'custom-lsp', command: 'no-such-custom', extensions: ['.xyz'], markers: [] },
    ])
    section.save('servers', ` ${custom} `)
    expect(readPluginConfig()['servers']).toBe(custom)
    // 缓存按 JSON 原文失效：保存完服务表里马上能看到新条目。
    expect(service.servers().some((server) => server.id === 'custom-lsp')).toBe(true)

    expect(() => section.save('servers', '[{"id":1}]')).toThrow()
    expect(readPluginConfig()['servers']).toBe(custom)
    expect(() => section.save('idleSeconds', 'abc')).toThrow()
    expect(section.values()['idleSeconds']).toBe(600)
  })
})

describe('设置分区与服务状态', () => {
  test('服务器清单读不了：fields 带出 problem，status 直接说读不了，内置表照常可用', () => {
    const { dir } = project()
    writePluginConfig({ servers: '[{"id":1}]' })
    const harness = fakeCtx(dir)
    const section = harness.sections[0] as unknown as {
      fields(): Array<Record<string, unknown>>
      action(name: string): string
    }
    const serversField = section.fields().find((field) => field['key'] === 'servers')!
    expect(String(serversField['help'])).toContain('现在这份读不了')
    expect(section.action('status')).toContain('服务器清单读不了')

    const service = harness.services.get('lsp') as { servers(): Array<{ id: string }> }
    expect(service.servers().some((server) => server.id === 'typescript')).toBe(true)
  })

  test('status 文案分三档：可用未起进程 / 有实例 / 没装带安装提示', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir)
    const section = harness.sections[0] as unknown as { action(name: string): string }

    expect(section.action('status')).toContain('fake 可用，还没起进程')
    await harness.tools[0]!.run({ operation: 'hover', file_path: file, line: 1, character: 1 }, toolContext(dir))
    expect(section.action('status')).toContain('fake 有 1 个实例')

    const noBin = fakeCtx(dir, {
      servers: JSON.stringify([
        { id: 'pyright', command: 'no-such-pyright-xyz', extensions: ['.py'], markers: ['x'] },
      ]),
    })
    const noBinSection = noBin.sections[0] as unknown as { action(name: string): string }
    const text = noBinSection.action('status')
    expect(text).toContain('pyright 没装')
    expect(text).toContain('npm i -g pyright')
  })

  test('系统提示跟着总开关走；没有待补诊断时投影原样返回', () => {
    const { dir } = project()
    const enabled = fakeCtx(dir)
    expect(enabled.prompts[0]!.fn()).toContain('LSP 代码智能')

    const disabled = fakeCtx(dir, { enabled: false })
    expect(disabled.prompts[0]!.fn()).toBe('')

    const messages = [{ role: 'user', content: '继续' }]
    expect(enabled.projections[0]!(messages, enabled.session)).toEqual(messages)
    expect(enabled.projections[0]!(messages)).toEqual(messages)
  })
})

describe('诊断注入的边界', () => {
  test('诊断挂到真正写文件的会话：父会话不拿队友的写后诊断', async () => {
    const { dir, file } = project('const a = 1\n')
    const harness = fakeCtx(dir)
    const parent = makeSession('parent', dir)
    const teammate = makeSession('teammate', dir)

    expect(
      await harness.guards[0]!.decide({
        toolName: 'edit',
        target: file,
        cwd: dir,
        sessionId: 'parent',
        teammateSessionId: 'teammate',
      }),
    ).toEqual({ action: 'defer' })
    writeFileSync(file, 'const a = 1\nconst b = 2\n', 'utf8')

    // 非写类观察者不消费写前留底：后面那次 edit 仍然能注入。
    expect(harness.observers[0]!.observe('bash', 'x')).toBe('x')
    expect(harness.observers[0]!.observe('edit', '已写入')).toBe('已写入')

    await waitFor(() => harness.notices.some((text) => text.includes('新引入')))
    expect(harness.notices.some((text) => text.includes('新引入'))).toBe(true)

    const messages = [{ role: 'user', content: '继续' }]
    expect(harness.projections[0]!(messages, parent)).toEqual(messages)
    const next = harness.projections[0]!(messages, teammate) as Array<{ role: string; content: string }>
    expect(next).toHaveLength(2)
    expect(next[1]!.content).toContain('【LSP 诊断】')
    expect(next[1]!.content).toContain('<diagnostics file=')
    expect(teammate.notes.some((note) => note.kind === 'lsp-write-diagnostics')).toBe(true)
    expect(parent.notes).toHaveLength(0)
  }, 40_000)

  test('没有写前留底、写后文件被删：观察者都只原样返回，不产生通知', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir)
    expect(harness.observers[0]!.observe('edit', '没有留底')).toBe('没有留底')
    await delay(200)
    expect(harness.notices).toHaveLength(0)

    await harness.guards[0]!.decide({ toolName: 'edit', target: file, cwd: dir, sessionId: 'sess-1' })
    rmSync(file, { force: true })
    expect(harness.observers[0]!.observe('edit', '文件没了')).toBe('文件没了')
    await delay(500)
    expect(harness.notices).toHaveLength(0)
  }, 40_000)
})

describe('查询失败的渲染与退出清理', () => {
  test('条数截断、坐标校验、服务器不支持与进程崩溃都变「没有数据」而不是抛错', async () => {
    const { dir, file } = project()
    const truncated = fakeCtx(dir, { maxLocations: 1 })
    const run = (harness: Harness, args: Record<string, unknown>): Promise<string> =>
      harness.tools[0]!.run(args, toolContext(dir))

    const references = await run(truncated, { operation: 'findReferences', file_path: file, line: 1, character: 1 })
    expect(references).toContain('找到 2 处')
    expect(references).toContain('还有 1 条未列出')

    expect(
      await run(truncated, { operation: 'hover', file_path: file, line: 1, character: 0 }),
    ).toContain('character 要是一基正整数')

    const noHover = fakeCtx(dir, { servers: serverConfig('no-hover') })
    const hover = await run(noHover, { operation: 'hover', file_path: file, line: 1, character: 1 })
    expect(hover).toContain('没有数据')
    expect(hover).toContain('没声明支持 hover')

    const dying = fakeCtx(dir, { servers: serverConfig('die') })
    const definition = await run(dying, { operation: 'goToDefinition', file_path: file, line: 1, character: 1 })
    expect(definition).toContain('没有数据')
    expect(definition).toContain('stderr 尾巴')
    expect(definition).toContain('boom')
  }, 40_000)

  test('dsc/exit 收掉语言服务器：状态清零，后续查询说管理器已收掉', async () => {
    const { dir, file } = project()
    const harness = fakeCtx(dir)
    const service = harness.services.get('lsp') as {
      query(op: string, file: string, line: number, character: number): Promise<string>
      status(): Array<{ id: string; instances: number }>
    }
    expect(await service.query('hover', file, 1, 1)).toContain('悬停信息')
    expect(service.status().find((entry) => entry.id === 'fake')?.instances).toBe(1)

    harness.exitHandlers[0]!()
    expect(service.status().find((entry) => entry.id === 'fake')?.instances).toBe(0)
    expect(await service.query('hover', file, 1, 1)).toContain('LSP 管理器已经收掉了')
  }, 40_000)
})
