/**
 * approval 插件装配面（`packages/approval/index.ts`）：守卫 / 观察者 / 投影 / 等人登记的挂载，
 * 六层裁决的自动档与人工卡，AI 复核的调用与失败回落，以及审批服务的设置读写与应答。
 *
 * 假 ctx 只负责收挂载点与提供会话；裁决、策略引擎、规则文件、审计都是真的，
 * `DSC_HOME` 在任何 import 之前指进临时目录（模块级路径常量在求值时算定）。
 *
 * @module dsc/packages/approval/tests/wiring.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-approval-wiring-'))
process.env['DSC_HOME'] = HOME

const WORK = mkdtempSync(join(tmpdir(), 'dsc-approval-work-'))
const SESSION_PATH = join(HOME, 'sessions', 's1.jsonl')
const AUDIT_FILE = join(HOME, 'audit.jsonl')
const RULES_FILE = join(HOME, 'policy.rules')

type ApprovalIndex = typeof import('../index.js')
let approvalPlugin: ApprovalIndex['approvalPlugin']

beforeAll(async () => {
  approvalPlugin = (await import('../index.js')).approvalPlugin
})

beforeEach(() => {
  rmSync(AUDIT_FILE, { force: true })
  rmSync(RULES_FILE, { force: true })
  mkdirSync(HOME, { recursive: true })
})

afterEach(() => {
  // 每个用例都应答或触发 exit；这里只兜底清掉可能残留的文件。
  rmSync(RULES_FILE, { force: true })
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of [HOME, WORK]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 上偶发 EPERM：临时目录交给系统清。
    }
  }
})

interface Options {
  policy?: 'readonly' | 'auto-edit' | 'full-access' | null
  reviewer?: 'user' | 'auto-review' | null
  cwd?: string
  canAnswer?: boolean
  agent?: boolean
  prefs?: { defaultPolicy?: 'readonly' | 'auto-edit' | 'full-access'; defaultReviewer?: 'user' | 'auto-review' }
  passed?: Record<string, unknown>
  sandbox?: { check: (...args: unknown[]) => { allowed: boolean; reason?: string }; grantSession: (...args: unknown[]) => void }
  floor?: { whitelist: (command: string) => string[] | null }
  tools?: Array<{ name: string; description: string; parameters: unknown }>
  subagent?: { list: () => Array<{ file: string }> }
  mode?: string
  /** false = 不提供 mode 服务，让卡面落回 modeForCard（dsc/mode-changed 那条路）。 */
  modeService?: boolean
  messages?: unknown[]
  goal?: unknown
  todos?: unknown[]
}

interface Harness {
  service: {
    policy: string
    reviewer: string
    decide: (request: Record<string, unknown>, signal: AbortSignal, options?: { forceAskReason?: string }) => Promise<string>
    surface: () => Record<string, unknown>
    setPolicy: (policy: string) => void
    setReviewer: (reviewer: string) => void
    pendingView: () => Record<string, unknown> | null
    pendingFor: (path: string) => boolean
    answer: (answer: string, source?: 'app' | 'web') => void
  }
  guards: Array<{ id: string; order: number; decide: (input: never) => Promise<unknown> }>
  observers: Array<{ id: string; order: number; observe: (tool: string, text: string) => string }>
  surfaces: Map<string, () => unknown>
  waiting: Map<string, (owner?: string) => boolean>
  events: Array<{ event: string; args: unknown[] }>
  handlers: Map<string, (...args: never[]) => unknown>
  services: Map<string, unknown>
  session: Record<string, unknown>
  perms: { sandbox: string | null; policy: string | null; reviewer: string | null }
  llmRequests: Array<Record<string, unknown>>
  llm: { stream: (...args: never[]) => Promise<unknown>; routeForSession: () => unknown; providerOf: () => string }
}

/** 假 ctx：默认能弹卡、能解析会话；断言点在返回值里。 */
function harness(options: Options = {}): Harness {
  const cwd = options.cwd ?? WORK
  const events: Array<{ event: string; args: unknown[] }> = []
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const services = new Map<string, unknown>()
  const guards: Harness['guards'] = []
  const observers: Harness['observers'] = []
  const surfaces = new Map<string, () => unknown>()
  const waiting = new Map<string, (owner?: string) => boolean>()
  const llmRequests: Array<Record<string, unknown>> = []
  const perms = { sandbox: null as string | null, policy: options.policy ?? null, reviewer: options.reviewer ?? null }
  const session = {
    meta: { id: 's1', cwd },
    filePath: SESSION_PATH,
    messages: options.messages ?? [],
    state(id: string) {
      if (id === 'permissions') return perms
      if (id === 'goal') return options.goal
      if (id === 'todos') return options.todos
      return undefined
    },
    appendState(id: string, payload: Record<string, unknown>) {
      if (id === 'permissions') Object.assign(perms, payload)
    },
    setState(id: string, payload: Record<string, unknown>) {
      if (id === 'permissions') Object.assign(perms, payload)
    },
  }
  const roster =
    options.agent === false
      ? undefined
      : {
          sessionById: (id: string) => (id === 's1' ? session : undefined),
          sessionFor: (path: string) => (path === SESSION_PATH ? session : undefined),
        }
  const optional = new Map<string, unknown>()
  if (roster !== undefined) optional.set('agent', roster)
  if (options.prefs !== undefined) optional.set('settings', { prefs: () => options.prefs })
  optional.set('interactive', { reachable: () => options.canAnswer ?? true })
  if (options.modeService !== false) optional.set('mode', { modeFor: () => options.mode ?? 'build' })
  optional.set('tools', { list: () => options.tools ?? [] })
  if (options.sandbox !== undefined) optional.set('sandbox', options.sandbox)
  if (options.floor !== undefined) optional.set('approvalFloor', options.floor)
  if (options.subagent !== undefined) optional.set('subagent', options.subagent)

  const llm = {
    routeForSession: () => ({ api: 'fake-api', baseUrl: 'https://fake', apiKey: 'k', model: 'judge-model', cacheControl: true }),
    providerOf: () => 'fake-provider',
    stream: async (_api: unknown, request: Record<string, unknown>) => {
      llmRequests.push(request)
      return {
        text: '{"risk":"low","decision":"allow"}',
        reasoning: '',
        toolCalls: [],
        usage: { inputTokens: 12, outputTokens: 3 },
        finishReason: 'stop',
      }
    },
  }

  const ctx = {
    effect(fn: () => unknown, _label?: string) {
      return fn()
    },
    on(event: string, handler: (...args: never[]) => unknown) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    emit(event: string, ...args: unknown[]) {
      events.push({ event, args })
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    get(name: string) {
      return optional.get(name)
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
    surfaces: {
      register(id: string, fn: () => unknown) {
        surfaces.set(id, fn)
        return () => surfaces.delete(id)
      },
    },
    waiting: {
      register(id: string, fn: (owner?: string) => boolean) {
        waiting.set(id, fn)
        return () => waiting.delete(id)
      },
    },
    session: { current: () => session },
    llm,
  }

  approvalPlugin.apply?.(ctx as never, options.passed ?? {})
  return {
    service: services.get('approval') as Harness['service'],
    guards,
    observers,
    surfaces,
    waiting,
    events,
    handlers,
    services,
    session,
    perms,
    llmRequests,
    llm,
  }
}

/** 等审批卡挂上来（write 的 diff 推演是异步的）。 */
async function untilCard(h: Harness): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const view = h.service.pendingView()
    if (view !== null) return view
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('审批卡没有挂上来')
}

/** 发一个会弹卡的请求，返回卡与尚未落定的决定。 */
async function ask(
  h: Harness,
  request: Record<string, unknown>,
  options?: { forceAskReason?: string },
): Promise<{ promise: Promise<string>; card: Record<string, unknown> }> {
  const promise = h.service.decide(request, new AbortController().signal, options)
  const card = await untilCard(h)
  return { promise, card }
}

const signalOf = (): AbortSignal => new AbortController().signal

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    toolName: 'bash',
    argsSummary: '{"command":"npm install"}',
    args: { command: 'npm install' },
    cwd: WORK,
    sessionId: 's1',
    sessionPath: SESSION_PATH,
    ...overrides,
  }
}

function auditLines(): Array<Record<string, unknown>> {
  if (!existsSync(AUDIT_FILE)) return []
  return readFileSync(AUDIT_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('装配：守卫、观察者、投影与等人登记', () => {
  test('provide approval；守卫 order 30、观察者 order 10、两个投影与等待登记都挂上', () => {
    const h = harness()
    expect(h.services.get('approval')).toBe(h.service)
    expect(h.guards[0]).toMatchObject({ id: 'approval', order: 30 })
    expect(h.observers[0]).toMatchObject({ id: 'approval', order: 10 })
    expect([...h.surfaces.keys()]).toEqual(['policy', 'pendingApproval'])
    expect([...h.waiting.keys()]).toEqual(['approval'])
    expect(h.surfaces.get('pendingApproval')?.()).toBeNull()
    expect(h.waiting.get('approval')?.()).toBe(false)
  })

  test('规则文件读坏了：装配时发一条 dsc/notice 说清问题', () => {
    writeFileSync(RULES_FILE, '{bad json', 'utf8')
    const h = harness()
    expect(h.events.some((item) => item.event === 'dsc/notice' && String(item.args[0]).includes('规则文件'))).toBe(true)
  })

  test('surface 读偏好里的默认档位与审阅者；setPolicy / setReviewer 写会话并记审计', () => {
    const h = harness({ prefs: { defaultPolicy: 'readonly', defaultReviewer: 'auto-review' } })
    const surface = h.service.surface()
    expect(surface).toMatchObject({ current: 'readonly', reviewer: 'auto-review' })
    expect((surface.options as Array<{ id: string }>).map((item) => item.id)).toEqual([
      'readonly',
      'auto-edit',
      'full-access',
    ])
    expect((surface.reviewerOptions as Array<{ id: string }>).map((item) => item.id)).toEqual(['user', 'auto-review'])
    expect(h.service.policy).toBe('readonly')

    h.service.setPolicy('full-access')
    h.service.setReviewer('user')
    expect(h.perms).toMatchObject({ policy: 'full-access', reviewer: 'user' })
    expect(h.service.policy).toBe('full-access')
    expect(h.service.reviewer).toBe('user')
    const changes = auditLines().filter((line) => line.kind === 'mode-change')
    expect(changes.map((line) => line.reason)).toEqual(
      expect.arrayContaining(['权限模式 → full-access', '审批审阅者 → user']),
    )
  })
})

describe('守卫与观察者', () => {
  test('只读工具不问；auto-edit 工作区内写放行；readonly 下写被拒并回原话', async () => {
    const h = harness({ policy: 'auto-edit' })
    const guard = h.guards[0]!
    const input = (risk: string): never =>
      ({
        toolName: 'write',
        risk,
        args: { path: join(WORK, 'a.txt') },
        cwd: WORK,
        target: join(WORK, 'a.txt'),
        signal: signalOf(),
        sessionId: 's1',
        sessionPath: SESSION_PATH,
      }) as never

    expect(await guard.decide(input('read'))).toEqual({ action: 'defer' })
    expect(await guard.decide(input('write'))).toEqual({ action: 'pass' })

    h.perms.policy = 'readonly'
    expect(await guard.decide(input('write'))).toEqual({
      action: 'deny',
      reason: '用户拒绝了这次工具调用。',
    })
  })

  test('观察者把密钥形状的文本遮红', () => {
    const h = harness()
    const text = h.observers[0]!.observe('bash', 'token=sk-abcdefghijklmnopqrstuvwxyz')
    expect(text).toContain('«redacted:secret»')
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })
})

describe('自动裁决：地板、模式与授权', () => {
  test('归属会话解析不到：直接拒、发通知、审计记 auto-deny', async () => {
    const h = harness({ agent: false })
    const decision = await h.service.decide(
      request({ sessionId: 'ghost', sessionPath: join(HOME, 'no-such-session.jsonl') }),
      signalOf(),
    )
    expect(decision).toBe('reject')
    expect(h.service.pendingView()).toBeNull()
    expect(h.events.some((item) => item.event === 'dsc/notice' && String(item.args[0]).includes('已经结束'))).toBe(true)
    expect(auditLines().some((line) => line.kind === 'auto-deny' && line.sessionId === 'ghost')).toBe(true)
  })

  test('灾难命令：完全访问也直接拒', async () => {
    const h = harness({ policy: 'full-access' })
    expect(await h.service.decide(request({ args: { command: 'rm -rf /' } }), signalOf())).toBe('reject')
    expect(h.service.pendingView()).toBeNull()
    const denials = auditLines().filter((line) => line.kind === 'auto-deny')
    expect(denials.some((line) => String(line.reason).includes('删掉文件系统根目录'))).toBe(true)
  })

  // NT 设备命名空间（`\\?\` / `\\.\`）是 Windows 专属路径形态：硬地板先把路径 resolve()，
  // POSIX 上它会被当成 cwd 下的普通文件名，按实现语义不该判拒——所以只在 win32 上断言。
  test.skipIf(process.platform !== 'win32')('关键系统路径：Windows 设备命名空间写也直接拒', async () => {
    const h = harness({ policy: 'full-access' })
    const hardPath = await h.service.decide(
      request({ toolName: 'write', args: { path: '\\\\?\\C:\\temp\\x.txt', content: 'x' } }),
      signalOf(),
    )
    expect(hardPath).toBe('reject')
    expect(h.service.pendingView()).toBeNull()
    const denials = auditLines().filter((line) => line.kind === 'auto-deny')
    expect(denials.some((line) => String(line.reason).includes('设备命名空间'))).toBe(true)
  })

  test('readonly：只读命令放行，写类一律拒', async () => {
    const h = harness({ policy: 'readonly' })
    expect(await h.service.decide(request({ args: { command: 'ls -la' } }), signalOf())).toBe('allow-once')
    expect(
      await h.service.decide(request({ toolName: 'write', args: { path: join(WORK, 'x.txt'), content: 'x' } }), signalOf()),
    ).toBe('reject')
    expect(auditLines().some((line) => line.kind === 'auto-deny' && String(line.reason).includes('仅查看'))).toBe(true)
  })

  test('auto-edit：工作区内写自动放行，工作区外落人工卡', async () => {
    const h = harness({ policy: 'auto-edit' })
    expect(
      await h.service.decide(request({ toolName: 'write', args: { path: join(WORK, 'inside.txt'), content: 'x' } }), signalOf()),
    ).toBe('allow-once')

    const outside = join(tmpdir(), `dsc-approval-outside-${String(Date.now())}.txt`)
    const { promise, card } = await ask(
      h,
      request({ toolName: 'write', args: { path: outside, content: 'x' } }),
    )
    expect(card).toMatchObject({ risk: 'medium', hardline: false })
    expect(card.reason).toContain('工作区外的改动需要确认')
    expect(card.scopes).toEqual(['once', 'session'])
    h.service.answer('reject')
    expect(await promise).toBe('reject')
  })

  test('full-access：非读工具直接放行；说明书类文件仍然弹卡', async () => {
    const h = harness({ policy: 'full-access' })
    expect(await h.service.decide(request(), signalOf())).toBe('allow-once')

    const { promise, card } = await ask(
      h,
      request({ toolName: 'write', args: { path: join(WORK, 'AGENTS.md'), content: '# 规则' } }),
    )
    expect(card).toMatchObject({ risk: 'high', scopes: ['once'] })
    expect(String(card.reason)).toContain('说明书')
    expect(card.diff).toMatchObject({ path: join(WORK, 'AGENTS.md'), fellBack: true })
    h.service.answer('reject')
    expect(await promise).toBe('reject')
  })

  test('run_code 在非只读档免审；readonly 下照旧拒', async () => {
    const auto = harness({ policy: 'auto-edit' })
    expect(await auto.service.decide(request({ toolName: 'run_code', args: {} }), signalOf())).toBe('allow-once')

    const readonly = harness({ policy: 'readonly' })
    expect(await readonly.service.decide(request({ toolName: 'run_code', args: {} }), signalOf())).toBe('reject')
  })

  test('危险命令硬拦截白名单：命中后免审批卡', async () => {
    const h = harness({
      policy: 'auto-edit',
      floor: { whitelist: (command) => (command === 'rm -rf build' ? ['rm', '-rf', 'build'] : null) },
    })
    const decision = await h.service.decide(request({ args: { command: 'rm -rf build' } }), signalOf())
    expect(decision).toBe('allow-once')
    expect(auditLines().some((line) => String(line.reason).includes('硬拦截白名单'))).toBe(true)
  })

  test('forceAskReason 压过完全访问：弹卡、原因与风险按钩子要求', async () => {
    const h = harness({ policy: 'full-access' })
    const { promise, card } = await ask(h, request(), { forceAskReason: '安全钩子要求这次当面确认' })
    expect(card).toMatchObject({ risk: 'medium', policy: 'full-access' })
    expect(card.reason).toBe('安全钩子要求这次当面确认')
    h.service.answer('allow-once')
    expect(await promise).toBe('allow-once')
  })

  test('本会话已允许的同类操作：第二次不再问', async () => {
    const h = harness({ policy: 'auto-edit' })
    const first = await ask(h, request())
    expect(first.card.suggestedRule).toEqual(['npm', 'install'])
    h.service.answer('allow-session')
    expect(await first.promise).toBe('allow-session')

    expect(await h.service.decide(request(), signalOf())).toBe('allow-once')
    expect(auditLines().some((line) => line.scope === 'session' && line.kind === 'auto-allow')).toBe(true)
  })

  test('永久允许：写规则文件，下一次按规则放行', async () => {
    const h = harness({ policy: 'auto-edit' })
    const { promise } = await ask(h, request())
    h.service.answer('allow-always')
    expect(await promise).toBe('allow-always')

    const saved = JSON.parse(readFileSync(RULES_FILE, 'utf8')) as { rules: Array<{ pattern: string[]; decision: string }> }
    expect(saved.rules.some((rule) => rule.pattern.join(' ') === 'npm install' && rule.decision === 'allow')).toBe(true)

    expect(await h.service.decide(request(), signalOf())).toBe('allow-once')
    expect(auditLines().some((line) => line.kind === 'auto-allow' && String(line.reason).includes('规则允许'))).toBe(true)
  })
})

describe('人工审批卡与等待登记', () => {
  test('没人能回答：不弹卡、直接拒，并说明原因', async () => {
    const h = harness({ policy: 'auto-edit', canAnswer: false })
    expect(await h.service.decide(request(), signalOf())).toBe('reject')
    expect(h.service.pendingView()).toBeNull()
    expect(auditLines().some((line) => String(line.reason).includes('没有界面能回答'))).toBe(true)
  })

  test('卡片归属、pendingFor / pendingView / waiting 与应答', async () => {
    const h = harness({ policy: 'auto-edit' })
    const { promise, card } = await ask(h, request())
    expect(h.service.pendingFor(SESSION_PATH)).toBe(true)
    expect(h.service.pendingFor('C:/other.jsonl')).toBe(false)
    expect(h.waiting.get('approval')?.()).toBe(true)
    expect(h.waiting.get('approval')?.('s1')).toBe(true)
    expect(h.waiting.get('approval')?.('other')).toBe(false)
    expect(h.surfaces.get('pendingApproval')?.()).toBe(card)

    h.service.answer('allow-once')
    expect(await promise).toBe('allow-once')
    expect(h.service.pendingView()).toBeNull()
    // 没有挂起卡时应答是静默忽略。
    expect(() => h.service.answer('reject')).not.toThrow()
  })

  test('沙箱越界：跳过所有自动档，卡片按高风险只给「这一次」', async () => {
    const h = harness({
      policy: 'full-access',
      sandbox: { check: () => ({ allowed: false, reason: '目标不在可写根内。后面还有说明' }), grantSession: () => undefined },
    })
    const { promise, card } = await ask(
      h,
      request({ toolName: 'write', args: { path: join(WORK, 'fenced.txt'), content: 'x' } }),
    )
    expect(card).toMatchObject({ risk: 'high', scopes: ['once'] })
    expect(String(card.reason)).toContain('沙箱边界：目标不在可写根内')
    h.service.answer('allow-once')
    expect(await promise).toBe('allow-once')
  })

  test('模型请求放宽沙箱：卡上有 escalation；本会话允许会并进可写根', async () => {
    const granted: unknown[] = []
    const h = harness({
      policy: 'auto-edit',
      sandbox: { check: () => ({ allowed: true }), grantSession: (...args) => granted.push(args) },
    })
    const target = join(tmpdir(), `dsc-approval-esc-${String(Date.now())}.txt`)
    const { promise, card } = await ask(
      h,
      request({
        toolName: 'write',
        args: { path: target, content: 'x', sandbox_permissions: 'workspace-write', justification: '要写到项目外' },
      }),
    )
    expect(card.escalation).toMatchObject({ permission: 'workspace-write', scope: 'once' })
    expect(card.scopes).toEqual(['once', 'session'])
    expect(String(card.reason)).toContain('模型请求放宽沙箱')
    h.service.answer('allow-session')
    expect(await promise).toBe('allow-session')
    expect(granted[0]).toEqual([SESSION_PATH, [target]])
  })

  test('dsc/mode-changed 更新卡面模式；dsc/exit 取消挂起卡', async () => {
    const h = harness({ policy: 'auto-edit', modeService: false })
    h.handlers.get('dsc/mode-changed')?.('plan' as never)
    const { promise, card } = await ask(h, request())
    expect(card.mode).toBe('plan')

    h.handlers.get('dsc/exit')?.()
    expect(await promise).toBe('reject')
    expect(h.service.pendingView()).toBeNull()
    expect(auditLines().some((line) => line.phase === 'cancelled')).toBe(true)
  })
})

describe('AI 复核（auto-review）', () => {
  test('判官放行：带完整协议调用（温度 0、禁用思考、system + pending-call），记账 k=judge', async () => {
    const h = harness({ policy: 'full-access', reviewer: 'auto-review' })
    const decision = await h.service.decide(request(), signalOf())
    expect(decision).toBe('allow-once')
    expect(h.service.pendingView()).toBeNull()

    const sent = h.llmRequests[0]!
    expect(sent).toMatchObject({ temperature: 0, thinking: 'disabled', maxTokens: 400, model: 'judge-model' })
    const messages = sent.messages as Array<{ role: string; content: string }>
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('最终授权审查者')
    expect(messages.at(-1)!.content).toContain('pending-call')
    expect(messages.at(-1)!.content).toContain('npm install')

    const usageFile = join(HOME, 'usage', 'usage.jsonl')
    expect(existsSync(usageFile)).toBe(true)
    expect(readFileSync(usageFile, 'utf8')).toContain('"k":"judge"')
    expect(auditLines().some((line) => line.kind === 'auto-allow' && String(line.reason).includes('AI 复核放行'))).toBe(true)
  })

  test('判官否决：不自动放行，落人工卡并把判官理由带上', async () => {
    const h = harness({ policy: 'full-access', reviewer: 'auto-review' })
    h.llm.stream = async () => ({
      text: '{"risk":"medium","decision":"deny","reason":"用户没有授权安装依赖"}',
      reasoning: '',
      toolCalls: [],
      usage: null,
      finishReason: 'stop',
    })
    const { promise, card } = await ask(h, request())
    expect(card).toMatchObject({ risk: 'medium' })
    expect(String(card.reason)).toContain('AI 复核判不放行：用户没有授权安装依赖')
    h.service.answer('allow-once')
    expect(await promise).toBe('allow-once')
    expect(auditLines().some((line) => line.kind === 'auto-deny' && String(line.reason).includes('AI 复核判不放行'))).toBe(true)
  })

  test('判官输出不合协议：不按「没跑完」回落，直接落人工卡', async () => {
    const h = harness({ policy: 'full-access', reviewer: 'auto-review' })
    h.llm.stream = async () => ({ text: '我觉得可以', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' })
    const { promise, card } = await ask(h, request())
    expect(String(card.reason)).toContain('AI 复核输出不合协议')
    h.service.answer('reject')
    expect(await promise).toBe('reject')
  })

  test('判官网络失败 + failClosed=false：回到权限档放行并提示', async () => {
    const h = harness({ policy: 'full-access', reviewer: 'auto-review', passed: { failClosed: false } })
    h.llm.stream = async () => {
      throw new Error('网络断了')
    }
    expect(await h.service.decide(request(), signalOf())).toBe('allow-once')
    expect(h.service.pendingView()).toBeNull()
    const notices = h.events.filter((item) => item.event === 'dsc/notice').map((item) => String(item.args[0]))
    expect(notices.some((text) => text.includes('AI 复核没跑完') && text.includes('完全访问'))).toBe(true)
    expect(auditLines().some((line) => String(line.reason).includes('这次不按复核否决处理'))).toBe(true)
  })

  test('判官网络失败 + failClosed=true：落人工卡并说明「失败即拒绝」', async () => {
    const h = harness({ policy: 'full-access', reviewer: 'auto-review', passed: { failClosed: true } })
    h.llm.stream = async () => {
      throw new Error('超时')
    }
    const { promise, card } = await ask(h, request())
    expect(String(card.reason)).toContain('失败即拒绝')
    h.service.answer('reject')
    expect(await promise).toBe('reject')
  })

  test('本轮已中止：判官没给意见也不回落，直接按拒', async () => {
    const h = harness({ policy: 'full-access', reviewer: 'auto-review' })
    h.llm.stream = async () => {
      throw new Error('aborted')
    }
    const controller = new AbortController()
    controller.abort()
    expect(await h.service.decide(request(), controller.signal)).toBe('reject')
    expect(h.service.pendingView()).toBeNull()
    expect(auditLines().some((line) => String(line.reason).includes('中止'))).toBe(true)
  })
})
