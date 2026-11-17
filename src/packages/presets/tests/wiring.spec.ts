/**
 * presets 插件装配面（`packages/presets/index.ts`）：模式状态、界面投影、提示段与
 * 骨架取舍、工具目录投影、切换命令、增删改与按会话恢复。
 *
 * 用假 ctx 跑真 `apply`；模式文件真的写在临时 `DSC_HOME/presets` 下（`ensureBuiltinPresets`
 * 在 apply 里执行），所以 `listPresets / findPreset / writePreset / removePreset` 全是真路径。
 * `DSC_HOME` 在任何 import 之前指向临时目录——路径常量在模块求值时算定。
 *
 * @module dsc/packages/presets/tests/wiring.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { PresetDraft } from '@pneuma/runtime/contract.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-presets-wiring-'))
process.env['DSC_HOME'] = HOME

type PresetsIndex = typeof import('../index.js')
let presetsPlugin: PresetsIndex['presetsPlugin']

beforeAll(async () => {
  presetsPlugin = (await import('../index.js')).presetsPlugin
})

beforeEach(() => {
  // 每个用例从「只有出厂四个模式」的干净目录出发。
  rmSync(join(HOME, 'presets'), { recursive: true, force: true })
  rmSync(join(HOME, 'audit.jsonl'), { force: true })
  mkdirSync(HOME, { recursive: true })
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 上偶发 EPERM：临时目录交给系统清。
  }
})

interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  states: Map<string, unknown>
  state(id: string): unknown
  appendState(id: string, payload: unknown): void
}

function newSession(id = 'sess-1', preset?: string): FakeSession {
  const states = new Map<string, unknown>()
  if (preset !== undefined) states.set('preset', preset)
  return {
    meta: { id, cwd: 'C:/repo' },
    filePath: `C:/repo/.dsc/sessions/${id}.jsonl`,
    states,
    state: (key) => states.get(key),
    appendState(key, payload) {
      states.set(key, payload)
    },
  }
}

interface PresetServiceLike {
  readonly name: string
  readonly defaultName: string
  surface(): {
    current: string
    defaultName: string
    options: Array<{ name: string; label: string; builtin: boolean }>
    droppable: Array<{ id: string; label: string }>
  }
  use(name: string): string
  read(name: string): string
  save(draft: PresetDraft): string
  remove(name: string): string
  setDefault(name: string): string
}

type Projector = (tools: Array<{ name: string; presets?: string[] }>, scope?: { sessionId?: string }) => Array<{ name: string }>
type SkeletonFilter = (ids: string[], scope?: { sessionId?: string }) => string[]

interface Harness {
  services: Map<string, unknown>
  commands: Array<{ spec: { name: string }; run: (payload: Record<string, unknown>) => void }>
  prompts: Array<{ id: string; render: (scope?: { sessionId?: string }) => string; order?: number }>
  skeletons: SkeletonFilter[]
  projectors: Projector[]
  surfaces: Map<string, () => unknown>
  events: Array<{ name: string; payload: unknown[] }>
  notices: string[]
  handlers: Map<string, (...args: never[]) => void>
  prefs: { defaultPreset: string }
  session: FakeSession
  setSession(session: FakeSession): void
  mode: string
  policy: string
}

function fakeCtx(options: { defaultPreset?: string } = {}): Harness {
  const services = new Map<string, unknown>()
  const commands: Harness['commands'] = []
  const prompts: Harness['prompts'] = []
  const skeletons: SkeletonFilter[] = []
  const projectors: Projector[] = []
  const surfaces = new Map<string, () => unknown>()
  const events: Harness['events'] = []
  const notices: string[] = []
  const handlers = new Map<string, (...args: never[]) => void>()
  const session = newSession()

  const harness = {
    prefs: { defaultPreset: options.defaultPreset ?? '' },
    session,
    mode: 'build',
    policy: 'auto-edit',
    setSession(next: FakeSession): void {
      harness.session = next
    },
  } as unknown as Harness

  const ctx = {
    session: { current: () => harness.session },
    commands: {
      register(spec: Harness['commands'][number]['spec'], run: Harness['commands'][number]['run']) {
        commands.push({ spec, run })
        return () => undefined
      },
    },
    prompt: {
      register(id: string, render: Harness['prompts'][number]['render'], opts?: { order?: number }) {
        prompts.push({ id, render, ...(opts?.order === undefined ? {} : { order: opts.order }) })
        return () => undefined
      },
      registerSkeletonFilter(_id: string, fn: SkeletonFilter) {
        skeletons.push(fn)
        return () => undefined
      },
    },
    tools: {
      project(_id: string, fn: Projector) {
        projectors.push(fn)
        return () => undefined
      },
    },
    surfaces: {
      register(id: string, read: () => unknown) {
        surfaces.set(id, read)
        return () => undefined
      },
    },
    settings: {
      prefs: () => ({ defaultPreset: harness.prefs.defaultPreset }),
      setPrefs(patch: { defaultPreset?: string }) {
        harness.prefs = { ...harness.prefs, ...patch }
        return harness.prefs
      },
    },
    approval: { policy: 'auto-edit' },
    mode: { mode: 'build' },
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    emit(name: string, ...payload: unknown[]) {
      events.push({ name, payload })
      const text = payload[0]
      if (name === 'dsc/notice' && typeof text === 'string') notices.push(text)
    },
    on(event: string, handler: (...args: never[]) => void) {
      handlers.set(event, handler)
      return () => undefined
    },
    provide(name: string, service: unknown) {
      services.set(name, service)
    },
  }

  presetsPlugin.apply?.(ctx as never, undefined)
  harness.services = services
  harness.commands = commands
  harness.prompts = prompts
  harness.skeletons = skeletons
  harness.projectors = projectors
  harness.surfaces = surfaces
  harness.events = events
  harness.notices = notices
  harness.handlers = handlers
  return harness
}

const serviceOf = (harness: Harness): PresetServiceLike => harness.services.get('presets') as PresetServiceLike

const draft = (overrides: Partial<PresetDraft> = {}): PresetDraft => ({
  oldName: null,
  name: 'mine',
  label: '我的模式',
  description: '自定义',
  tools: ['read'],
  drop: [],
  prompt: '按我的规矩来。',
  ...overrides,
})

describe('挂载与界面投影', () => {
  test('服务 / 提示段 / 骨架取舍 / 工具投影 / 命令 / 快照全挂上，出厂四个模式写进磁盘', () => {
    const harness = fakeCtx()
    expect(harness.services.get('presets')).toBeDefined()
    expect(harness.prompts[0]).toMatchObject({ id: 'preset:persona', order: 15 })
    expect(harness.skeletons).toHaveLength(1)
    expect(harness.projectors).toHaveLength(1)
    expect(harness.commands[0]!.spec.name).toBe('preset')
    expect(harness.surfaces.has('preset')).toBe(true)
    expect(harness.handlers.has('dsc/session-open')).toBe(true)

    const files = readdirSync(join(HOME, 'presets')).sort()
    expect(files).toEqual(['maker.md', 'minimal.md', 'ptc.md', 'standard.md'])
    expect(existsSync(join(HOME, 'presets', 'standard.md'))).toBe(true)

    const service = serviceOf(harness)
    expect(service.name).toBe('standard')
    expect(service.defaultName).toBe('standard')
    const surface = service.surface()
    expect(surface.current).toBe('standard')
    expect(surface.options.map((option) => option.name)).toEqual(['standard', 'ptc', 'minimal', 'maker'])
    expect(surface.options[0]).toMatchObject({ label: '标准模式', builtin: true })
    expect(surface.droppable.map((item) => item.id)).toEqual(['behavior', 'tool-rules', 'instructions', 'skills'])
    const read = harness.surfaces.get('preset')!() as Record<string, unknown>
    expect(read).toEqual(surface)
  })
})

describe('切换 / 审计 / 默认模式', () => {
  test('use 写会话状态、审计与广播；同档重复切换不再记审计；未知模式抛错', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)

    expect(service.use('minimal')).toContain('极简模式')
    expect(harness.session.state('preset')).toBe('minimal')
    expect(service.name).toBe('minimal')
    expect(harness.events.some((item) => item.name === 'dsc/preset-changed' && item.payload[0] === 'minimal')).toBe(true)
    expect(harness.notices.some((text) => text.includes('模式切换为'))).toBe(true)

    const auditFile = join(HOME, 'audit.jsonl')
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'mode-change', sessionId: 'sess-1', cwd: 'C:/repo', policy: 'auto-edit', mode: 'build' })
    expect(String(lines[0]!.reason)).toContain('极简模式')

    // 已经是这一档：状态照写、广播照发，但审计不重复记。
    service.use('minimal')
    expect(readFileSync(auditFile, 'utf8').trim().split('\n')).toHaveLength(1)

    expect(() => service.use('nope')).toThrow('没有名为「nope」的模式')
    expect(service.defaultName).toBe('standard')
  })
})

describe('工具目录投影', () => {
  const tools = [
    { name: 'read' },
    { name: 'shell' },
    { name: 'plugin_manager' },
    { name: 'run_code', presets: ['ptc'] },
    { name: 'runtime_api', presets: ['maker'] },
  ]

  test('标准档只做标签减法；PTC 档按黑名单关掉插件管理；极简档只留白名单', () => {
    const harness = fakeCtx()
    const project = harness.projectors[0]!
    const service = serviceOf(harness)

    expect(project(tools).map((tool) => tool.name)).toEqual(['read', 'shell', 'plugin_manager'])

    service.use('ptc')
    expect(project(tools).map((tool) => tool.name)).toEqual(['read', 'shell', 'run_code'])

    service.use('minimal')
    expect(project(tools).map((tool) => tool.name)).toEqual(['shell'])
  })

  test('显式写进白名单的标签工具照样露面；scope 认的是那个会话自己的档', () => {
    const harness = fakeCtx()
    const project = harness.projectors[0]!
    const service = serviceOf(harness)

    service.save(draft({ name: 'tagged', tools: ['run_code', 'read'], prompt: 'x' }))
    service.use('tagged')
    expect(project(tools).map((tool) => tool.name)).toEqual(['read', 'run_code'])

    // 另一个会话还在标准档：问它就按标准档算，不跟着当前查看的会话走。
    const other = newSession('sess-2', 'standard')
    expect(project(tools, { sessionId: 'sess-2' }).map((tool) => tool.name)).toEqual(['read', 'shell', 'plugin_manager'])
    expect(other.state('preset')).toBe('standard')
  })
})

describe('提示段与骨架取舍', () => {
  test('标准档原样、极简档替换后只剩 persona、自定义 drop 精确摘段', () => {
    const harness = fakeCtx()
    const filter = harness.skeletons[0]!
    const persona = harness.prompts[0]!
    const service = serviceOf(harness)
    const ids = ['preset:persona', 'behavior', 'tool-rules', 'instructions', 'skills']

    expect(filter(ids)).toEqual(ids)
    expect(persona.render()).toBe('')

    service.use('minimal')
    expect(filter(ids)).toEqual(['preset:persona'])
    expect(persona.render()).toContain('You are a helpful software engineer assistant.')

    service.save(draft({ name: 'lean', label: '精简', drop: ['behavior', 'not-a-section'], prompt: '简单点。' }))
    service.use('lean')
    expect(filter(ids)).toEqual(['preset:persona', 'tool-rules', 'instructions', 'skills'])
    expect(persona.render()).toBe('简单点。')
  })
})

describe('增删改 / 默认模式 / 会话恢复', () => {
  test('save / read / remove / setDefault 的正常路径与失败分支', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)

    expect(service.save(draft())).toContain('已创建模式「我的模式」')
    expect(service.read('mine')).toContain('按我的规矩来。')
    expect(existsSync(join(HOME, 'presets', 'mine.md'))).toBe(true)
    expect(() => service.save(draft({ name: 'Bad Name' }))).toThrow('模式名「Bad Name」不合法')
    expect(() => service.read('nope')).toThrow('没有名为「nope」的模式')

    expect(service.setDefault('mine')).toContain('新会话默认模式已设为「我的模式」')
    expect(service.defaultName).toBe('mine')
    expect(() => service.setDefault('nope')).toThrow('没有名为「nope」的模式')

    expect(service.remove('mine')).toContain('已删除模式「我的模式」')
    expect(existsSync(join(HOME, 'presets', 'mine.md'))).toBe(false)
    expect(() => service.remove('standard')).toThrow('出厂内置模式，删不掉')
  })

  test('删掉当前这一档：读模型回落标准档（会话记录仍留旧名，见 index.ts 的已知问题）', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    service.save(draft({ name: 'temp', label: '临时', prompt: '临时' }))
    service.use('temp')
    expect(service.name).toBe('temp')

    expect(service.remove('temp')).toContain('已删除模式「临时」')
    // 模式文件没了，presetIdOf() 的 resolve 已经把它折成 standard，所以读出来是标准档。
    expect(service.name).toBe('standard')
    // 已知问题：remove() 里 `presetIdOf() === target` 永远为假（resolve 先折成 standard），
    // 于是「请用 /goal 回落并写回会话记录」那条分支进不去，会话记录仍停在旧名上。
    // 这里如实钉住现状，等 index.ts:183 修掉再改断言。
    expect(harness.session.state('preset')).toBe('temp')
    expect(harness.notices.some((text) => text.includes('已删除，当前回落到'))).toBe(false)
  })

  test('session-open：会话记过的档跟着回来，没记过用默认档', () => {
    const harness = fakeCtx({ defaultPreset: 'minimal' })
    const open = harness.handlers.get('dsc/session-open')!
    const service = serviceOf(harness)

    const saved = newSession('sess-saved', 'maker')
    harness.setSession(saved)
    open({ session: saved } as never)
    expect(service.name).toBe('maker')

    const fresh = newSession('sess-fresh')
    harness.setSession(fresh)
    open({ session: fresh } as never)
    expect(service.name).toBe('minimal')
    expect(harness.events.some((item) => item.name === 'dsc/preset-changed' && item.payload[0] === 'minimal')).toBe(true)
  })
})

describe('/preset 命令', () => {
  test('空参数：有浮层就开浮层，没有就给清单；别名与未知词各走各的分支', () => {
    const harness = fakeCtx()
    const command = harness.commands[0]!
    const service = serviceOf(harness)
    const notices: string[] = []
    let opened = 0
    const ui = { notice: (text: string) => notices.push(text), openPresets: () => (opened += 1) }
    const run = (args: string[]): void => command.run({ args, ui } as never)

    run([])
    expect(opened).toBe(1)
    expect(notices).toHaveLength(0)

    // 没有 openPresets 的端：给当前模式与可选清单。
    const plain = { notice: (text: string) => notices.push(text) }
    command.run({ args: [], ui: plain } as never)
    expect(notices.at(-1)).toContain('当前模式：标准模式')
    expect(notices.at(-1)).toContain('/preset minimal')

    run(['极简'])
    expect(service.name).toBe('minimal')
    run(['ptc'])
    expect(service.name).toBe('ptc')
    run(['不存在的'])
    expect(notices.at(-1)).toContain('认不出模式「不存在的」')
    expect(harness.session.state('preset')).toBe('ptc')
  })
})
