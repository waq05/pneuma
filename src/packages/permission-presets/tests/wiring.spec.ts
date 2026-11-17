/**
 * permission-presets 装配面（`packages/permission-presets/index.ts`）：服务投影、
 * 预设应用、默认值、按会话补钉与审计。
 *
 * 假 ctx 提供 settings / approval / mode / session / surfaces / sandbox 六个面，
 * `apply` 是真的。会话用最小假对象（`state` / `appendState` / `setState`），
 * 与 `permission-core/permission-scope` 的契约一致；审计真写 `DSC_HOME/audit.jsonl`。
 *
 * @module dsc/packages/permission-presets/tests/wiring.spec
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  BUILTIN_PERMISSION_PRESETS,
  CUSTOM_PERMISSION_PRESET,
  DEFAULT_PERMISSION_PRESET,
} from '@pneuma/permission-core/permission-presets.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-permission-presets-wiring-'))
process.env['DSC_HOME'] = HOME

type PermissionPresetsModule = typeof import('../index.js')
let permissionPresetsPlugin: PermissionPresetsModule['permissionPresetsPlugin']

/** 会话里权限三项的形状（与 permission-scope 的存储格式一致）。 */
interface PermissionState {
  sandbox: string | null
  policy: string | null
  reviewer: string | null
}

/** 最小假会话：真按 id 存取状态，并记录写入。 */
interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  state(id: 'permissions'): PermissionState | undefined
  appendState(id: 'permissions', payload: PermissionState): void
  setState(id: 'permissions', payload: PermissionState): void
}

/** 服务面里本文件用得到的部分。 */
interface PresetService {
  readonly name: string
  readonly defaultName: string
  surface(): {
    current: string
    defaultName: string
    options: Array<{ name: string; label: string; description: string; builtin: boolean }>
  }
  use(next: string): string
  setDefault(next: string): string
}

interface SandboxDouble {
  mode: string
  defaulted: string[]
  setMode(next: string): void
  setDefaultMode(next: string): void
}

interface Harness {
  service: PresetService
  session: FakeSession
  prefs: Record<string, unknown>
  approval: { policy: string; reviewer: string }
  sandbox: SandboxDouble | undefined
  notices: string[]
  events: string[]
  surfaces: Map<string, () => unknown>
  openSession(next: FakeSession): void
}

/** 一个会按 id 读写权限状态的假会话。 */
function fakeSession(id = 'sess-1', cwd = 'C:/work'): FakeSession {
  const states = new Map<string, unknown>()
  return {
    meta: { id, cwd },
    filePath: `C:/work/.dsc/sessions/${id}.jsonl`,
    state: (key) => states.get(key) as PermissionState | undefined,
    appendState: (key, payload) => {
      states.set(key, payload)
    },
    setState: (key, payload) => {
      states.set(key, payload)
    },
  }
}

/** 假沙箱：setMode 与真插件一样顺手把会话那一栏写掉。 */
function fakeSandbox(session: FakeSession, mode = 'workspace-write'): SandboxDouble {
  return {
    mode,
    defaulted: [],
    setMode(next) {
      this.mode = next
      const before = session.state('permissions') ?? { sandbox: null, policy: null, reviewer: null }
      session.appendState('permissions', { ...before, sandbox: next as never })
    },
    setDefaultMode(next) {
      this.defaulted.push(next)
    },
  }
}

/** 假 ctx 真 apply。 */
function fakeCtx(options: {
  sandbox?: boolean
  sandboxMode?: string
  prefs?: Record<string, unknown>
  session?: FakeSession
} = {}): Harness {
  const session = options.session ?? fakeSession()
  const prefs: Record<string, unknown> = {
    defaultPolicy: 'auto-edit',
    defaultReviewer: 'user',
    defaultPermissionPreset: '',
    ...options.prefs,
  }
  const approval = { policy: 'auto-edit', reviewer: 'user' }
  if (typeof prefs['defaultPolicy'] === 'string') approval.policy = prefs['defaultPolicy']
  if (typeof prefs['defaultReviewer'] === 'string') approval.reviewer = prefs['defaultReviewer']
  const sandbox = options.sandbox === false ? undefined : fakeSandbox(session, options.sandboxMode)
  const notices: string[] = []
  const events: string[] = []
  const surfaces = new Map<string, () => unknown>()
  const services = new Map<string, unknown>()
  const handlers = new Map<string, (payload: { session: FakeSession }) => void>()

  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    on(event: string, handler: (payload: { session: FakeSession }) => void) {
      handlers.set(event, handler)
      return () => undefined
    },
    emit(event: string, payload?: unknown) {
      events.push(event)
      if (event === 'dsc/notice') notices.push(String(payload))
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    get(name: string) {
      return name === 'sandbox' ? sandbox : undefined
    },
    settings: {
      prefs: () => ({ ...prefs }),
      setPrefs(patch: Record<string, unknown>) {
        Object.assign(prefs, patch)
      },
    },
    approval: {
      get policy() {
        return approval.policy
      },
      get reviewer() {
        return approval.reviewer
      },
      setPolicy(next: string) {
        approval.policy = next
        const before = session.state('permissions') ?? { sandbox: null, policy: null, reviewer: null }
        session.appendState('permissions', { ...before, policy: next as never })
      },
      setReviewer(next: string) {
        approval.reviewer = next
        const before = session.state('permissions') ?? { sandbox: null, policy: null, reviewer: null }
        session.appendState('permissions', { ...before, reviewer: next as never })
      },
    },
    mode: { mode: 'code' },
    session: { current: () => session },
    surfaces: {
      register(id: string, fn: () => unknown) {
        surfaces.set(id, fn)
        return () => undefined
      },
    },
  }
  permissionPresetsPlugin.apply(ctx as never, undefined as never)
  return {
    service: services.get('permissionPresets') as PresetService,
    session,
    prefs,
    approval,
    sandbox,
    notices,
    events,
    surfaces,
    openSession(next) {
      const handler = handlers.get('dsc/session-open')
      if (handler === undefined) throw new Error('没有登记 dsc/session-open')
      handler({ session: next })
    },
  }
}

/** 读审计文件（真落盘）。 */
function auditRecords(): Array<{ kind?: string; reason?: string; sessionId?: string }> {
  const file = join(HOME, 'audit.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { kind?: string; reason?: string; sessionId?: string })
}

beforeAll(async () => {
  permissionPresetsPlugin = (await import('../index.js')).permissionPresetsPlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(() => {
  rmSync(join(HOME, 'audit.jsonl'), { force: true })
})

describe('服务投影与按会话补钉', () => {
  test('surface 给出当前/默认/四档选项；注册的 surfaces 与启动补钉都生效', () => {
    const h = fakeCtx()
    expect(h.service.surface().current).toBe('workspace')
    expect(h.service.surface().defaultName).toBe('workspace')
    expect(h.service.surface().options.map((option) => option.name)).toEqual(
      BUILTIN_PERMISSION_PRESETS.map((preset) => preset.name),
    )
    for (const option of h.service.surface().options) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.description.length).toBeGreaterThan(0)
    }
    expect(h.surfaces.get('permissionPresets')?.()).toMatchObject({ current: 'workspace' })
    // 启动只补钉 policy / reviewer；沙箱那一栏由第一次读取（surface/use）补上默认值。
    expect(h.session.state('permissions')).toMatchObject({
      policy: 'auto-edit',
      reviewer: 'user',
      sandbox: 'workspace-write',
    })
  })

  test('换会话补钉缺项、不覆盖已有值；蹲不到沙箱时也拼得出预设名', () => {
    const h = fakeCtx({ sandbox: false })
    const next = fakeSession('sess-2')
    next.setState('permissions', { sandbox: null, policy: 'full-access', reviewer: null })
    h.openSession(next)
    expect(next.state('permissions')).toMatchObject({ policy: 'full-access', reviewer: 'user' })
    expect(h.service.name).toBe('workspace')
  })
})

describe('use：应用预设', () => {
  test('只写实际不同的旋钮，回执、广播与审计都落地；偏好默认值不被顺手改', () => {
    const h = fakeCtx()
    expect(h.service.use('read-only')).toBe('权限预设切到「只读」（沙箱→read-only）')
    expect(h.sandbox?.mode).toBe('read-only')
    expect(h.approval).toMatchObject({ policy: 'auto-edit', reviewer: 'user' })
    expect(h.notices).toEqual(['权限预设切到「只读」（沙箱→read-only）'])
    expect(h.events).toContain('dsc/changed')
    expect(h.prefs).toMatchObject({ defaultPolicy: 'auto-edit', defaultReviewer: 'user', defaultPermissionPreset: '' })

    const record = auditRecords().at(-1)
    expect(record).toMatchObject({ kind: 'mode-change', sessionId: 'sess-1' })
    expect(record?.reason).toContain('权限预设 → 只读（read-only）')
  })

  test('三根都不同时逐项写；三项都没变时只留一句「已是」', () => {
    const h = fakeCtx()
    expect(h.service.use('full-access')).toBe('权限预设切到「完全访问」（沙箱→danger-full-access、权限→full-access）')
    expect(h.approval).toMatchObject({ policy: 'full-access', reviewer: 'user' })

    const again = h.service.use('full-access')
    expect(again).toBe('权限预设已是「完全访问」，三项取值没变')
    expect(auditRecords()).toHaveLength(2)
  })

  test('沙箱插件缺席：回执明说这一半没落地，权限模式那半照旧生效', () => {
    const h = fakeCtx({ sandbox: false, prefs: { defaultPolicy: 'full-access' } })
    const notice = h.service.use('read-only')
    expect(notice).toContain('权限预设切到「只读」')
    expect(notice).toContain('权限→auto-edit')
    expect(notice).toContain('沙箱插件没开，read-only 这一半没落地')
    // 沙箱那一半没落地：会话里读到的仍是缺省档，不会被改成 read-only。
    expect(h.session.state('permissions')?.sandbox).toBe('workspace-write')
  })

  test('custom 与未知名字都拒绝，并给能照做的提示', () => {
    const h = fakeCtx()
    expect(() => h.service.use(CUSTOM_PERMISSION_PRESET)).toThrow('是拼出来的状态，不是可选预设')
    expect(() => h.service.use('dance')).toThrow('没有名为「dance」的权限预设')

    h.session.setState('permissions', { sandbox: 'read-only', policy: 'full-access', reviewer: 'user' })
    expect(h.service.name).toBe('custom')
  })
})

describe('setDefault 与 defaultName', () => {
  test('设默认：三根一起落，新会话沙箱默认也改；空串清掉；非法名拒绝', () => {
    const h = fakeCtx()
    expect(h.service.setDefault('read-only')).toContain('新会话默认权限预设已设为「只读」')
    expect(h.prefs).toMatchObject({
      defaultPermissionPreset: 'read-only',
      defaultPolicy: 'auto-edit',
      defaultReviewer: 'user',
    })
    expect(h.sandbox?.defaulted).toEqual(['read-only'])

    expect(h.service.setDefault('')).toContain('已清掉默认权限预设')
    expect(h.prefs['defaultPermissionPreset']).toBe('')
    expect(() => h.service.setDefault('dance')).toThrow('没有名为「dance」的权限预设')
  })

  test('defaultName：偏好里未知名字回落出厂档；空偏好按三项推', () => {
    const saved = fakeCtx({ prefs: { defaultPermissionPreset: 'full-access' } })
    expect(saved.service.defaultName).toBe('full-access')

    const unknown = fakeCtx({ prefs: { defaultPermissionPreset: 'dance' } })
    expect(unknown.service.defaultName).toBe(DEFAULT_PERMISSION_PRESET)

    const empty = fakeCtx({
      sandboxMode: 'danger-full-access',
      prefs: { defaultPolicy: 'full-access', defaultReviewer: 'auto-review' },
    })
    expect(empty.service.defaultName).toBe('auto-review')
  })
})
