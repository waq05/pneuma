/**
 * `app/runtime.ts` 的组合根回调与初始化成功路径覆盖（W14）。
 *
 * 既有 `app-runtime.spec.ts` 只跑「未配置 → 启动即暂停」：构造期注册的那些回调
 * （会话管理器的 closing/environment/tools、设置分区的 requestPass、执行器的
 * paused/sourceLink/repliedTo、判定器的 deliver/threadContext、引擎的 policy/emit、
 * 工具宿主的 github/quietly）与 `initialize()` 的成功分支一次都没执行过。
 *
 * 这里把 `Sessions` / `DshExecutor` / `MasterAssessor` / `Settings` / `Passes` / `Setup` /
 * `Engine` 换成**捕获 options 的桩**，构造完运行期后逐个回调真调一遍；其余（Store、Effects、
 * Outbox、Prompts、SourceRegistry、HealthBoard）都是真实现。既不起真会话，也不发模型请求。
 *
 * @module dsc/packages/superagent/tests/w14-runtime-callbacks
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import type { Ticket, Trigger } from '../core/index.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14-runtime-'))
process.env['DSC_HOME'] = HOME

// ── 捕获 options 的桩（只替换装配对象，判定/文案都是真代码）────────────────

interface Captured {
  sessions?: Record<string, any>
  executor?: Record<string, any>
  assessor?: Record<string, any>
  settings?: Record<string, any>
  passes?: Record<string, any>
  setup?: Record<string, any>
  engine?: Record<string, any>
}

const fake = vi.hoisted(() => ({
  configured: false,
  captured: {} as Captured,
})) as unknown as {
  configured: boolean
  captured: Captured
}

vi.mock('../app/sessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/sessions.js')>()
  return {
    ...actual,
    Sessions: class {
      constructor(options: Record<string, any>) {
        fake.captured.sessions = options
      }
      install(): void {}
      async ensure(): Promise<Record<string, unknown>> {
        return {}
      }
      agent(): undefined {
        return undefined
      }
      dispose(): void {}
      async prompt(): Promise<Record<string, unknown>> {
        return {}
      }
      promptVersion(): string {
        return 'v1'
      }
      mayRead(): boolean {
        return true
      }
      relay(): void {}
      notify(): void {}
      async delivery(): Promise<Record<string, unknown>> {
        return {}
      }
    },
  }
})

vi.mock('../executor/dsh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../executor/dsh.js')>()
  return {
    ...actual,
    DshExecutor: class {
      constructor(options: Record<string, any>) {
        fake.captured.executor = options
      }
      install(): void {}
      resume(): void {}
      async shutdown(): Promise<void> {}
      dispose(): void {}
      prepare(ticket: Ticket): Ticket {
        return ticket
      }
    },
  }
})

vi.mock('../app/assessment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/assessment.js')>()
  return {
    ...actual,
    MasterAssessor: class {
      constructor(options: Record<string, any>) {
        fake.captured.assessor = options
      }
      stop(): void {}
    },
  }
})

vi.mock('../app/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/settings.js')>()
  return {
    ...actual,
    Settings: class {
      constructor(options: Record<string, any>) {
        fake.captured.settings = options
      }
      syncable(): string[] {
        return []
      }
      async sync(): Promise<void> {}
    },
  }
})

vi.mock('../app/passes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/passes.js')>()
  return {
    ...actual,
    Passes: class {
      constructor(options: Record<string, any>) {
        fake.captured.passes = options
      }
      start(): void {}
      request(): void {}
      stop(): Promise<void> {
        return Promise.resolve()
      }
      async idle(): Promise<void> {}
      async pump(): Promise<void> {}
    },
  }
})

vi.mock('../app/setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/setup.js')>()
  return {
    ...actual,
    Setup: class {
      problem = undefined
      feishuProblem = undefined
      constructor(host: Record<string, any>) {
        fake.captured.setup = host
      }
      get commandEnvironment(): Record<string, string> {
        return {}
      }
      get deployment(): Record<string, unknown> {
        return {
          repository: 'acme/widgets',
          github: {
            cli: 'gh',
            login: 'agent',
            noreply: '1+agent@users.noreply.github.com',
          },
        }
      }
      configured(): boolean {
        return fake.configured
      }
      async run(): Promise<boolean> {
        return true
      }
      restore(): void {}
    },
  }
})

vi.mock('../core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/index.js')>()
  return {
    ...actual,
    Engine: class {
      constructor(options: Record<string, any>) {
        fake.captured.engine = options
      }
      policyChanged(): void {}
      evaluateDue(): void {}
      receive(): Record<string, unknown> {
        return {}
      }
      report(ticket: Ticket): Ticket {
        return ticket
      }
      assignmentStarted(): void {}
      turnEnded(): void {}
      retryTicket(id: string): Ticket {
        return { id } as Ticket
      }
    },
  }
})

const { Runtime } = await import('../app/runtime.js')

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const machineOf = (stateDir: string) => ({
  stateDir,
  promptMaxChars: 100_000,
  admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15_000,
})

const triggerOf = (): Trigger => ({
  id: 'trig-1',
  source: 'feishu',
  threads: [{ source: 'feishu', id: 'oc_1:om_1' }],
  actor: { source: 'feishu', id: 'ou_1' },
  human: true,
  at: '2026-01-01T00:00:00.000Z',
  text: 'hi',
  meta: {},
})

const ticketOf = (): Ticket => ({
  id: 'tk1',
  title: 't',
  decisionId: 'd1',
  mandate: {
    strength: 'explicit',
    policyVersion: 'v1',
    basis: { via: 'addressed', addressed: 'mention' },
    actor: { source: 'feishu', id: 'ou_1' },
    scope: 'chat',
  },
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
})

/** 起一个「配置已通过、初始化成功」的运行期。 */
async function startConfigured() {
  fake.configured = true
  const stateDir = join(HOME, `state-${Math.random().toString(36).slice(2, 8)}`)
  const provided = new Map<string, unknown>()
  const ctx = {
    get: (name: string) => (name === 'orchestrator' ? provided.get('orchestrator') : undefined),
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
    },
    on: () => () => {},
    effect: () => () => {},
    emit: () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  const runtime = new Runtime(ctx as never, machineOf(stateDir), () => {})
  await runtime.ready
  return { runtime, ctx, provided, stateDir }
}

describe('Runtime：构造期回调全部可调', () => {
  test('会话 / 设置 / 执行器 / 判定器 / 引擎的 options 回调都能执行', async () => {
    const { runtime } = await startConfigured()
    try {
      const sessions = fake.captured.sessions!
      const ticket = ticketOf()
      // 会话管理器：closing / environment / tools 三个闭包。
      expect(sessions['closing']()).toBe(false)
      expect(Array.isArray(sessions['environment'](ticket))).toBe(true)
      expect(Array.isArray(sessions['tools']({ id: 'agent-1' }, ticket))).toBe(true)
      // 工具宿主的资源口：promptVersion / mayRead 转给会话管理器。
      const toolHost = (runtime as unknown as { toolHost: Record<string, any> }).toolHost
      expect(toolHost['resources'].promptVersion('s1')).toBe('v1')
      expect(toolHost['resources'].mayRead('s1', 2)).toBe(true)
      // 资源宿主的另外两个闭包：飞书分页大小与来源链接。
      expect(typeof toolHost['resources'].feishuPageSize()).toBe('number')
      const linkHost = {
        store: runtime.store,
        links: new Map<string, string>(),
        commands: undefined,
        sources: runtime.sources,
        lifetime: runtime.lifetime,
      }
      void linkHost
      expect(toolHost['resources'].sourceLink(triggerOf())).toBeDefined()
      // 设置分区的 requestPass。
      fake.captured.settings!['requestPass']()
      // 执行器：closing / paused / environment / sourceLink / repliedTo。
      const executor = fake.captured.executor!
      expect(executor['closing']()).toBe(false)
      expect(typeof executor['paused']()).toBe('boolean')
      expect(Array.isArray(executor['environment'](ticket))).toBe(true)
      await expect(Promise.resolve(executor['sourceLink'](triggerOf()))).resolves.toBeDefined()
      expect(executor['repliedTo'](triggerOf())).toBeUndefined()
      // 判定器：settings / paused / threadContext / deliver。
      const assessor = fake.captured.assessor!
      expect(assessor['settings']()).toBeTypeOf('object')
      expect(typeof assessor['paused']()).toBe('boolean')
      // 没有注册任何来源时，线程上下文读取器是 undefined（闭包照样执行）。
      expect(assessor['threadContext'](triggerOf())).toBeUndefined()
      await expect(Promise.resolve(assessor['deliver']('s1', 'text'))).resolves.toBeDefined()
      // 引擎：policy / now / emit（ticket.ended 走 outbox 通知那条）。
      const engine = fake.captured.engine!
      expect(engine['policy']()).toBeTypeOf('object')
      expect(engine['now']()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      runtime.store.tickets.save(ticket)
      expect(() => engine['emit']({ type: 'ticket.ended', data: { ticketId: 'tk1' } })).not.toThrow()
      // 工具宿主：github getter、requestPass、quietly。
      expect(toolHost['github']).toBeTypeOf('object')
      toolHost['requestPass']()
      expect(toolHost['quietly'](() => 42)).toBe(42)
    } finally {
      await runtime.stop()
    }
  }, 30_000)

  test('初始化成功：会话与执行器装上、健康项 ready，stop 幂等', async () => {
    const { runtime, provided } = await startConfigured()
    try {
      expect(runtime.health['runtime']?.state).toBe('ready')
      expect(provided.get('orchestrator')).toBe(runtime)
      expect(runtime.configured()).toBe(true)
      // 私有 paused()：配置通过且设置未暂停 → false。
      expect((runtime as unknown as { paused: () => boolean }).paused()).toBe(false)
      await runtime.stop()
      await runtime.stop()
      expect(runtime.lifetime.aborted).toBe(true)
    } finally {
      await runtime.stop()
    }
  }, 30_000)
})
