/**
 * approval 插件长尾补盲（w14）：审批等待时限的两端夹取、判官保留历史里的坏参数兜底、
 * 项目规则读不到时的空串降级、判官输出协议的越界拒绝、子代理名册读坏、
 * 取不到当前会话时的路径基准兜底、「没人能答卡」的 stdin 判据，以及判官首字延迟记账。
 *
 * 假 ctx 只收挂载点与提供会话；裁决、策略引擎、规则文件、审计都是真的。`DSC_HOME`
 * 在任何 import 之前指进临时目录（模块级路径常量在求值时算定）。
 * `instructionsText` 用模块替身单独制造一次抛错（真实实现内部已吞掉读盘错误，
 * 不替身走不到那条 catch）。
 *
 * @module dsc/packages/approval/tests/w14-gaps.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-approval-w14-'))
process.env['DSC_HOME'] = HOME

const WORK = mkdtempSync(join(tmpdir(), 'dsc-approval-w14-work-'))
const SESSION_PATH = join(HOME, 'sessions', 's1.jsonl')
const AUDIT_FILE = join(HOME, 'audit.jsonl')
const RULES_FILE = join(HOME, 'policy.rules')
const USAGE_FILE = join(HOME, 'usage', 'usage.jsonl')

vi.mock('@pneuma/session-core/prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-core/prompt.js')>()
  return {
    ...actual,
    instructionsText: () => {
      throw new Error('AGENTS.md 读取链坏了')
    },
  }
})

let approvalPlugin: (typeof import('../index.js'))['approvalPlugin']

beforeAll(async () => {
  approvalPlugin = (await import('../index.js')).approvalPlugin
})

beforeEach(() => {
  rmSync(AUDIT_FILE, { force: true })
  rmSync(RULES_FILE, { force: true })
  mkdirSync(HOME, { recursive: true })
})

afterEach(() => {
  rmSync(RULES_FILE, { force: true })
  vi.restoreAllMocks()
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

type Decision = 'allow-once' | 'allow-session' | 'allow-always' | 'reject'

interface Options {
  policy?: 'readonly' | 'auto-edit' | 'full-access'
  reviewer?: 'user' | 'auto-review'
  passed?: Record<string, unknown>
  messages?: unknown[]
  subagent?: { list: () => Array<{ file: string }> }
  /** false = 不登记 interactive 服务（走 process.stdin.isTTY 那条兜底）。 */
  interactive?: boolean
  /** 判官流里主动回调一次 onDelta（首字延迟记账用）。 */
  streamDelta?: boolean
}

interface Harness {
  service: {
    decide: (request: Record<string, unknown>, signal: AbortSignal, options?: { forceAskReason?: string }) => Promise<Decision>
    pendingView: () => Record<string, unknown> | null
    answer: (answer: string, source?: 'app' | 'web') => void
  }
  events: Array<{ event: string; args: unknown[] }>
  session: Record<string, unknown>
  llmRequests: Array<Record<string, unknown>>
  llm: { stream: (...args: never[]) => Promise<unknown>; routeForSession: () => unknown; providerOf: () => string }
  ctx: Record<string, unknown>
  perms: { sandbox: string | null; policy: string | null; reviewer: string | null }
}

function harness(options: Options = {}): Harness {
  const events: Array<{ event: string; args: unknown[] }> = []
  const services = new Map<string, unknown>()
  const llmRequests: Array<Record<string, unknown>> = []
  const perms = { sandbox: null as string | null, policy: options.policy ?? null, reviewer: options.reviewer ?? null }
  const session = {
    meta: { id: 's1', cwd: WORK },
    filePath: SESSION_PATH,
    messages: options.messages ?? [],
    state(id: string) {
      if (id === 'permissions') return perms
      return undefined
    },
    appendState(id: string, payload: Record<string, unknown>) {
      if (id === 'permissions') Object.assign(perms, payload)
    },
    setState(id: string, payload: Record<string, unknown>) {
      if (id === 'permissions') Object.assign(perms, payload)
    },
  }
  const roster = {
    sessionById: (id: string) => (id === 's1' ? session : undefined),
    sessionFor: (path: string) => (path === SESSION_PATH ? session : undefined),
  }
  const optional = new Map<string, unknown>()
  optional.set('agent', roster)
  if (options.interactive !== false) optional.set('interactive', { reachable: () => true })
  optional.set('tools', { list: () => [] })
  if (options.subagent !== undefined) optional.set('subagent', options.subagent)

  const llm = {
    routeForSession: () => ({ api: 'fake-api', baseUrl: 'https://fake', apiKey: 'k', model: 'judge-model', cacheControl: true }),
    providerOf: () => 'fake-provider',
    stream: async (_api: unknown, request: Record<string, unknown>, handlers: Record<string, unknown>) => {
      llmRequests.push(request)
      if (options.streamDelta === true && typeof handlers['onDelta'] === 'function') {
        ;(handlers['onDelta'] as (kind: string, text: string) => void)('text', '{"risk"')
      }
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
    effect(fn: () => unknown) {
      return fn()
    },
    on() {
      return () => undefined
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
    guards: { register: () => () => undefined, registerObserver: () => () => undefined },
    surfaces: { register: () => () => undefined },
    waiting: { register: () => () => undefined },
    session: { current: () => session },
    llm,
  }

  approvalPlugin.apply?.(ctx as never, options.passed ?? {})
  return {
    service: services.get('approval') as Harness['service'],
    events,
    session,
    llmRequests,
    llm,
    ctx,
    perms,
  }
}

/** 等审批卡挂上来（write 的 diff 推演是异步的）。 */
async function untilCard(harnessArg: Harness): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const view = harnessArg.service.pendingView()
    if (view !== null) return view
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('审批卡没有挂上来')
}

async function ask(
  harnessArg: Harness,
  request: Record<string, unknown>,
): Promise<{ promise: Promise<Decision>; card: Record<string, unknown> }> {
  const promise = harnessArg.service.decide(request, new AbortController().signal)
  const card = await untilCard(harnessArg)
  return { promise, card }
}

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

test('等待时限两端夹取：过大压到 1 小时、过小抬到 10 秒', async () => {
  const delays: number[] = []
  const realSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(Number(ms))
    return (realSetTimeout as unknown as (cb: () => void, delay?: number, ...args: unknown[]) => unknown)(fn, ms, ...rest)
  }) as never)
  try {
    const high = harness({ policy: 'auto-edit', passed: { approvalTimeoutMs: 99_999_999 } })
    const first = await ask(high, request())
    high.service.answer('reject')
    expect(await first.promise).toBe('reject')
    expect(delays).toContain(3_600_000)

    delays.length = 0
    const low = harness({ policy: 'auto-edit', passed: { approvalTimeoutMs: 1 } })
    const second = await ask(low, request())
    low.service.answer('reject')
    expect(await second.promise).toBe('reject')
    expect(delays).toContain(10_000)
  } finally {
    vi.restoreAllMocks()
  }
})

test('判官历史里待审调用参数不是合法 JSON：按工具名兜底认出它，不重复列进历史', async () => {
  const h = harness({
    policy: 'full-access',
    reviewer: 'auto-review',
    messages: [
      { role: 'user', content: '把依赖装上' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '这不是 JSON' } }],
      },
    ],
  })
  expect(await h.service.decide(request(), new AbortController().signal)).toBe('allow-once')
  expect(h.llmRequests).toHaveLength(1)
  const messages = h.llmRequests[0]!['messages'] as Array<{ content: string }>
  // 待审调用本身在最后一条 pending-call 里，历史里不该再出现同一个 bash 调用。
  const historyCalls = messages.filter((message) => message.content.includes('"kind": "tool-call"'))
  expect(historyCalls).toHaveLength(0)
})

test('项目规则读不到：判官照跑，历史里没有 project-rules 段', async () => {
  const h = harness({ policy: 'full-access', reviewer: 'auto-review' })
  expect(await h.service.decide(request(), new AbortController().signal)).toBe('allow-once')
  const messages = h.llmRequests[0]!['messages'] as Array<{ content: string }>
  const kinds = messages
    .map((message) => {
      try {
        return (JSON.parse(message.content) as { kind?: string }).kind
      } catch {
        return undefined
      }
    })
    .filter((kind): kind is string => typeof kind === 'string')
  expect(kinds).not.toContain('project-rules')
})

test('判官否决结论里带多余字段：协议拒绝，落人工卡而不是当放行', async () => {
  const h = harness({ policy: 'full-access', reviewer: 'auto-review' })
  h.llm.stream = async () => ({
    text: '{"risk":"high","decision":"deny","reason":"太危险","extra":1}',
    reasoning: '',
    toolCalls: [],
    usage: null,
    finishReason: 'stop',
  })
  const { promise, card } = await ask(h, request())
  expect(String(card.reason)).toContain('AI 复核输出不合协议')
  h.service.answer('reject')
  expect(await promise).toBe('reject')
})

test('子代理名册读坏：当成不是子代理会话，复核照常进行', async () => {
  const h = harness({
    policy: 'full-access',
    reviewer: 'auto-review',
    subagent: {
      list: () => {
        throw new Error('名册文件坏了')
      },
    },
  })
  expect(await h.service.decide(request(), new AbortController().signal)).toBe('allow-once')
  expect(h.llmRequests).toHaveLength(1)
})

test('请求没带 cwd 且当前会话取不到：路径基准退回空串，复核不炸', async () => {
  const h = harness({ policy: 'full-access', reviewer: 'auto-review' })
  ;(h.ctx['session'] as { current: () => unknown }).current = () => {
    throw new Error('inactive context')
  }
  expect(await h.service.decide(request({ cwd: '' }), new AbortController().signal)).toBe('allow-once')
  const messages = h.llmRequests[0]!['messages'] as Array<{ content: string }>
  expect(messages.some((message) => message.content.includes('ENVIRONMENT'))).toBe(true)
})

test('没有 interactive 服务且 stdin 不是终端：不弹卡、直接按拒并记账', async () => {
  const h = harness({ policy: 'auto-edit', interactive: false })
  expect(await h.service.decide(request(), new AbortController().signal)).toBe('reject')
  expect(h.service.pendingView()).toBeNull()
  expect(auditLines().some((line) => String(line.reason).includes('没有界面能回答'))).toBe(true)
})

test('判官流有首字增量：用量行记下首字延迟与解码时长', async () => {
  const h = harness({ policy: 'full-access', reviewer: 'auto-review', streamDelta: true })
  expect(await h.service.decide(request(), new AbortController().signal)).toBe('allow-once')
  expect(existsSync(USAGE_FILE)).toBe(true)
  const judgeLines = readFileSync(USAGE_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('"k":"judge"'))
  expect(judgeLines.length).toBeGreaterThan(0)
  const row = JSON.parse(judgeLines.at(-1)!) as Record<string, unknown>
  expect(typeof row['ft']).toBe('number')
  expect(typeof row['d']).toBe('number')
})

test('等待时限配置缺省 / 非数字：用 300 秒兜底（不夹取）', async () => {
  const delays: number[] = []
  const realSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(Number(ms))
    return (realSetTimeout as unknown as (cb: () => void, delay?: number, ...args: unknown[]) => unknown)(fn, ms, ...rest)
  }) as never)
  try {
    const h = harness({ policy: 'auto-edit', passed: { approvalTimeoutMs: 'abc' } })
    const { promise } = await ask(h, request())
    h.service.answer('reject')
    expect(await promise).toBe('reject')
    expect(delays).toContain(300_000)
  } finally {
    vi.restoreAllMocks()
  }
})
