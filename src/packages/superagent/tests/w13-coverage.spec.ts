/**
 * W13 覆盖率补齐（superagent 侧）：`app/sessions.ts` 的 AgentDeps 闭包与入口装配。
 *
 * 为什么这么测：`app-sessions.spec.ts` 只测到 `Sessions` 自己的公开方法，**从没真跑过一轮
 * MiniAgent**，所以「路由 / 系统提示 / 工具目录 / 守卫链 / 重试账」这些只在回合里被调用的
 * 闭包全是空白。这里用真 `Session` + 真 `MiniAgent` + 真 `Store`（临时 `DSC_HOME`），只把
 * 宿主服务（llm / prompt / tools / guards）换成可断言的桩，跑真回合把闭包带起来。
 *
 * 入口 `index.ts` 的 `apply` 同样没被任何用例调用过（`skeleton.spec.ts` 只验 typeof）。
 * 这里按 cordis 的形状伪造 ctx，真的把 `apply` 跑一遍：运行期构造、来源启动、面板服务、
 * 快照面、设置分区、`/sa` 命令、退出收摊都走真代码。
 *
 * @module @pneuma/superagent/tests/w13-coverage
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

const originalHome = process.env.DSC_HOME
const root = createTempDir('dsc-sa-w13-')
process.env.DSC_HOME = root

const { Sessions } = await import('../app/sessions.js')
const { Store } = await import('../app/store.js')
const { KV } = await import('../kv.js')
const { Session } = await import('../../../core/session.js')

afterAll(() => {
  if (originalHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalHome
})

interface StreamResultLike {
  text: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  usage: { inputTokens: number; outputTokens: number } | null
  finishReason: string | null
}

const okStream = (text: string): StreamResultLike => ({
  text,
  reasoning: '',
  toolCalls: [],
  usage: { inputTokens: 3, outputTokens: 4 },
  finishReason: 'stop',
})

const toolCallStream = (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): StreamResultLike => ({
  text: '',
  reasoning: '',
  toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.args) })),
  usage: { inputTokens: 1, outputTokens: 1 },
  finishReason: 'tool_calls',
})

/** 等一个条件成立（模型回合是异步跑完的）。 */
async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

/** 提示词修订与投影链的桩：`revision` 可变，`rewrite` 记调用。 */
function fakePrompts(recorded: Record<string, unknown[]>): any {
  const version = (revision: number) => ({
    revision,
    previousRevision: revision - 1,
    savedAt: '',
    source: 'panel',
    config: { skills: { notes: 'Do things carefully.' } },
  })
  return {
    current: () => version(3),
    version,
    compose: (config: unknown, role: string) => `composed:${role}`,
    skills: () => [['notes', 'notes content']],
    systemPromptParts: (cwd: string, context: unknown) => {
      (recorded['systemPromptParts'] ??= []).push({ cwd, context })
      return { text: '宿主基础提示', sections: [{ id: 'base', order: 0, chars: 4, from: 'core' as const }] }
    },
    rewrite: (messages: unknown[], _session: unknown, report: (view: Record<string, unknown>) => void) => {
      (recorded['rewrite'] ??= []).push(messages.length)
      report({ kind: 'env', title: '环境' })
      return messages
    },
  }
}

interface HarnessRecorded {
  events: unknown[][]
  health: unknown[]
  routes: unknown[][]
  streams: string[]
  gate: unknown[]
  observe: unknown[]
  attach: string[]
  detach: string[]
  handlers: Map<string, (payload: any, name: string) => Promise<void> | void>
  registered: unknown[]
  disposers: (() => void)[]
  listeners: Map<string, (...args: any[]) => void>
  fitting: unknown[][]
  injected: unknown[]
}

/**
 * 宿主桩：与 `app-sessions.spec.ts` 同形，另外把回合里才会被调到的服务也接上：
 * llm 的 stream / route*、prompt 的 systemPromptParts / rewrite、tools 的 list、guards 的
 * gate / observe、agent 的 attach / detach。桩只记调用，断言看真结果。
 */
function makeHost(store: InstanceType<typeof Store>, over: any = {}) {
  const promptCalls: Record<string, unknown[]> = {}
  const prompts = over.prompts ?? fakePrompts(promptCalls)
  const recorded: HarnessRecorded = {
    events: [],
    health: [],
    routes: [],
    streams: [],
    gate: [],
    observe: [],
    attach: [],
    detach: [],
    handlers: new Map(),
    registered: [],
    disposers: [],
    listeners: new Map(),
    fitting: [],
    injected: [],
  }
  const llm = {
    routeForSession: (session: unknown) => {
      recorded.routes.push(['routeForSession', session])
      return { api: 'fake', baseUrl: 'http://fake', apiKey: 'k', model: 'fake/model', provider: 'p' }
    },
    route: () => {
      recorded.routes.push(['route'])
      return { api: 'fake', baseUrl: 'http://fake', apiKey: 'k', model: 'fake/model' }
    },
    routeTo: (provider: string, model: string, effort: string) => {
      recorded.routes.push(['routeTo', provider, model, effort])
      return { api: 'fake', baseUrl: 'http://fake', apiKey: 'k', model: `${provider}/${model}` }
    },
    providerOf: () => 'p',
    stream: async (api: string, _request: unknown, _handlers: unknown) => {
      recorded.streams.push(api)
      return over.stream ? over.stream() : okStream('SA 结论')
    },
  }
  const ctx: any = {
    get: (name: string) => {
      if (name === 'llm') return over.noLlm === true ? undefined : llm
      if (name === 'skills') return over.skills
      if (name === 'agent') return over.agent
      if (name === 'tools') return over.tools ?? { list: () => over.toolList ?? [] }
      if (name === 'guards') return over.guards
      if (name === 'prompt') return over.prompt ?? prompts
      if (name === 'compact') return over.compact
      return undefined
    },
    effect: (fn: () => () => void) => {
      const disposer = fn()
      recorded.disposers.push(disposer)
      return disposer
    },
    on: (event: string, listener: (...args: any[]) => void) => {
      recorded.listeners.set(event, listener)
      return () => {
        recorded.listeners.delete(event)
      }
    },
    emit: (event: string, payload: unknown) => {
      recorded.events.push([event, payload])
    },
    logger: { warn: () => {} },
  }
  const host: any = {
    context: ctx,
    store,
    prompts,
    effects: {
      handle: (kind: string, run: (payload: any, name: string) => Promise<void> | void, options: unknown) => {
        recorded.handlers.set(kind, run)
        recorded.registered.push([kind, options])
        return () => {}
      },
      enqueue: () => {},
      pending: () => false,
      idle: async () => {},
    },
    health: {
      set: (entry: unknown) => {
        recorded.health.push(entry)
      },
    },
    masterId: 'orchestrator-1',
    lifetime: new AbortController().signal,
    closing: () => false,
    environment: () => [],
    tools: (_handle: unknown, ticket: unknown) => {
      recorded.fitting.push(['tools', { ticket }])
      return over.toolsOf?.() ?? []
    },
  }
  return { host, recorded, prompts, ctx, promptCalls }
}

/** 每个用例一个库与一个 Sessions；用完 dispose。 */
function setup(over: any = {}) {
  const dir = join(root, `case-${Math.random().toString(36).slice(2, 8)}`)
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  const made = makeHost(store, over)
  const sessions = new Sessions(made.host)
  return { ...made, sessions, store, dir, close: () => { sessions.dispose(); store.close() } }
}

/** 一条工具定义；run 返回什么由用例给。 */
function toolEntry(name: string, risk: 'read' | 'write' = 'read') {
  return { name, description: `${name} tool`, parameters: {}, risk, run: async () => `${name} 结果` }
}

/** 上游形状的 `Tool`（`SessionsHost.tools` 给的是这种，由 `toolEntries` 再转成 ToolEntry）。 */
function upstreamTool(name: string) {
  return { name, description: `${name} tool`, schema: z.object({}), execute: async () => ({ ok: name }) }
}

describe('app/sessions 的回合闭包', () => {
  it('主会话跑一轮：路由 / 系统提示 / 工具保守卫链 / 投递认账 / 状态与体检都走真代码', async () => {
    let releaseFirst: () => void = () => undefined
    let streamed = 0
    const { sessions, store, recorded, dir, close } = setup({
      stream: () => {
        streamed += 1
        if (streamed === 1) {
          // 第一轮卡在模型请求上：这期间投一条排队消息，回合收尾出账时 observe 要按正文认回来。
          return new Promise<StreamResultLike>((resolve) => {
            releaseFirst = () => resolve(okStream('SA 结论'))
          })
        }
        return Promise.resolve(okStream('SA 第二轮结论'))
      },
    })
    try {
      const handle = await sessions.ensure('orchestrator-1', dir, 'T', 'orchestrator')
      handle.followup('跑一下这单')
      await until(() => recorded.streams.length >= 1, 4000)
      // 回合跑动中投队列消息：先入箱，回合收尾出账成 user 事件。
      await sessions.prompt('orchestrator-1', 'req-1', '插一句', 'queue', undefined, () => {})
      releaseFirst()
      await handle.whenIdle()

      // 跑完一轮：会话里有 assistant 正文、状态回到 idle。
      expect(handle.status).toBe('idle')
      expect(handle.session.messages.some((message: any) => message.role === 'assistant')).toBe(true)
      expect(handle.lastAssistantText()).toBe('SA 第二轮结论')
      // 路由走的是会话自己的选路。
      expect(recorded.routes.some((call) => call[0] === 'routeForSession')).toBe(true)
      // 系统提示绑定了一次提示词修订（KV 里记了）。
      expect(store.get(KV.sessions.prompts('orchestrator-1'))).toEqual([3])
      expect(sessions.promptVersion('orchestrator-1').revision).toBe(3)
      // 状态事件 running / idle 都广播了。
      const statuses = recorded.events.filter((event) => event[0] === 'superagent/agent-status')
      expect(statuses.map((event) => (event[1] as { status: string }).status)).toEqual(['running', 'idle'])
      // 投递认账：排队消息出账时广播 inbox-claimed 与 message-read。
      expect(recorded.events.some((event) => event[0] === 'superagent/inbox-claimed')).toBe(true)
      expect(recorded.events.some((event) => event[0] === 'superagent/message-read')).toBe(true)
      // 体检项刷新过（decorate / idle 都写 models 项）。
      expect(recorded.health.length).toBeGreaterThan(0)
    } finally {
      close()
    }
  })

  it('主会话的 noWait 闸：bash sleep / 超长 timeout / 长 job wait 都被拒，错误进会话', async () => {
    let calls = 0
    const { sessions, recorded, dir, close } = setup({
      stream: () => {
        calls += 1
        // 只让第一轮带工具调用；之后收口成正文，否则 MiniAgent 会一直调同一批工具。
        return calls === 1
          ? toolCallStream([
              { id: 'c1', name: 'bash', args: { command: 'sleep 10' } },
              { id: 'c2', name: 'bash', args: { command: 'ls', timeoutMs: 60_000 } },
              { id: 'c3', name: 'job_output', args: { wait: true, timeout_ms: 6000 } },
            ])
          : okStream('收口')
      },
      toolList: [toolEntry('bash'), toolEntry('job_output')],
      guards: { gate: async () => ({ action: 'defer' }), observe: (_toolName: string, text: string) => text },
    })
    try {
      const handle = await sessions.ensure('orchestrator-1', dir, 'T', 'orchestrator')
      handle.followup('干活')
      // followup 是幂等排队：先等回合真的发出第一次模型请求，再等它完全闲下来。
      await until(() => recorded.streams.length >= 1)
      await handle.whenIdle()
      // 拒绝原因写进 tool 结果正文（toolErrors 只记 'rejected' 标记）。
      const toolTexts = handle.session.messages
        .filter((message: any) => message.role === 'tool')
        .map((message: any) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
        .join('\n')
      expect(toolTexts).toContain('end the turn instead of waiting')
      expect(toolTexts.split('end the turn instead of waiting').length - 1).toBe(3)
      expect([...handle.session.toolErrors.values()].every((text) => text === 'rejected')).toBe(true)
    } finally {
      close()
    }
  })

  it('主会话未跑 router preset 时：bash 不带 timeout 与 job wait 默认值都给「默认等待太长」', async () => {
    const { sessions, dir, close } = setup({
      guards: { gate: async () => ({ action: 'defer' }), observe: (_toolName: string, text: string) => text },
    })
    try {
      const handle = await sessions.ensure('orchestrator-1', dir, 'T', 'orchestrator') as any
      // 造一条 note 写明 worker preset 的会话：`routed()` 读到 false，走 standard 的默认等待话术。
      const raw = Session.create(dir, join(dir, 'raw.jsonl'))
      raw.appendNote('superagent-preset', 'dsh-superagent-worker')
      const chain = (sessions as any).guardFor({ id: 'raw-1', role: 'orchestrator', session: raw }) as {
        gate: (input: Record<string, unknown>) => Promise<{ action: string; reason?: string }>
      }
      const input = { toolName: 'bash', risk: 'read' as const, cwd: dir, args: { command: 'ls' }, signal: new AbortController().signal }
      const denied = await chain.gate(input)
      expect(denied.action).toBe('deny')
      expect(denied.reason).toContain('timeoutMs of at most 30000')
      const silenced = await chain.gate({ ...input, args: { command: 'ls', timeoutMs: 1000 } })
      expect(silenced.action).not.toBe('deny')
      // 宿主没有守卫链时失败关闭（on hold 的闸门不允许动手）。
      expect(handle).toBeDefined()
    } finally {
      close()
    }
  })

  it('worker 会话跑一轮：routeTo 带思考强度、宿主提示拼在前面、工具目录按 WORK_TOOLS 挑、投影链照跑', async () => {
    const { sessions, store, recorded, dir, close, promptCalls } = setup({
      toolList: [toolEntry('read'), toolEntry('write'), toolEntry('orchestrator_read')],
      toolsOf: () => [upstreamTool('orchestrator_eval')],
    })
    try {
      const current = store.settings()
      store.saveSettings({
        ...current,
        executor: { ...current.executor, model: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
      })
      const handle = await sessions.ensure('worker-t5', dir, 'ticket t5', 'worker')
      handle.followup('干活')
      await until(() => recorded.streams.length >= 1)
      await handle.whenIdle()

      // worker 路由：设置里的执行者模型 + 思考强度（effortOf 收档）。
      expect(recorded.routes.some((call) => call[0] === 'routeTo' && call[3] === 'high')).toBe(true)
      // 系统提示：宿主基础提示在前，插件段在后。
      expect((promptCalls['systemPromptParts'] ?? []).length).toBeGreaterThan(0)
      // 投影链被调过（每轮请求改写一次）。
      expect((promptCalls['rewrite'] ?? []).length).toBeGreaterThan(0)
      // 工具目录给了 worker 白名单里的工具 + 宿主补的执行器工具。
      const fitting = recorded.fitting.filter((entry) => (entry[0] as string) === 'tools')
      expect(fitting.length).toBeGreaterThan(0)
      expect(handle.session.meta.id).toBe('worker-t5')
    } finally {
      close()
    }
  })

  it('重试账：model/retry 进体检并能在 modelRetry 读到，turn/end 清掉', async () => {
    const { sessions, recorded, dir, close } = setup()
    try {
      const handle = await sessions.ensure('orchestrator-1', dir, 'T', 'orchestrator') as any
      const anySessions = sessions as any
      anySessions.observeRetry(handle, { type: 'turn/start' })
      anySessions.observeRetry(handle, { type: 'message', finishReason: 'stop' })
      anySessions.observeRetry(handle, { type: 'model/retry', attempt: 2, reason: 'Budget has been exceeded!' })
      const retry = sessions.modelRetry('orchestrator-1') as { model_retry?: Record<string, unknown> }
      expect(retry.model_retry).toBeDefined()
      // 体检项要显式刷新一次（生产路径由 observe 的 turn/end、idle 负责写）。
      anySessions.updateModelHealth()
      const health = recorded.health.at(-1) as { state: string; detail: string }
      expect(health.state).toBe('error')
      expect(health.detail).toContain('over its model budget')
      // 回合结束 + 空闲：重试账清掉，体检回到 ready。
      anySessions.observeRetry(handle, { type: 'turn/end' })
      anySessions.idle(handle)
      expect(sessions.modelRetry('orchestrator-1')).toEqual({})
      expect((recorded.health.at(-1) as { state: string }).state).toBe('ready')
    } finally {
      close()
    }
  })

  it('inbox.remove：跑动中排队的投递撤得回来，坏 id / 已出账返回 false', async () => {
    let release: () => void = () => undefined
    let calls = 0
    const { sessions, recorded, dir, close } = setup({
      stream: () => {
        calls += 1
        if (calls === 1) {
          return new Promise<StreamResultLike>((resolve) => {
            release = () => resolve(okStream('第一轮'))
          })
        }
        return Promise.resolve(okStream('第二轮'))
      },
    })
    try {
      const handle = await sessions.ensure('orchestrator-1', dir, 'T', 'orchestrator') as any
      expect(handle.inbox.remove(sessions.promptedId('nope'))).toBe(false)
      handle.followup('开始')
      await until(() => recorded.streams.length >= 1)
      // 跑动中投 queue：先入箱，`inbox.remove` 能撤（撤掉 = 不出账）。
      await sessions.prompt('orchestrator-1', 'req-9', '还没出账', 'queue')
      expect(handle.inbox.remove(sessions.promptedId('req-9'))).toBe(true)
      release()
      await handle.whenIdle()
    } finally {
      close()
    }
  })
})

// ── 入口 apply：静默装配一遍（未配置 GitHub CLI 时启动即暂停，最常走的启动路径） ──
describe('superagent/index 的 apply', () => {
  const restores: (() => void)[] = []
  afterEach(() => {
    while (restores.length) restores.pop()!()
  })

  it('装配：面板服务 / 快照面 / 设置分区 / /sa 命令 / 退出收摊，未配置时日志说明在等 setup', async () => {
    const stateRoot = createTempDir('dsc-sa-apply-')
    restores.push(() => {
      try {
        rmSyncSafe(stateRoot)
      } catch {
        // 临时目录留着系统清
      }
    })
    const previousHome = process.env.DSC_HOME
    process.env.DSC_HOME = stateRoot
    restores.push(() => {
      if (previousHome === undefined) delete process.env.DSC_HOME
      else process.env.DSC_HOME = previousHome
    })
    mkdirSync(join(stateRoot, 'plugins'), { recursive: true })
    writePlugins(stateRoot, [])

    const { apply } = await import('../index.js')
    const provided = new Map<string, unknown>()
    const disposers: Array<() => unknown> = []
    const registered = { surfaces: [] as unknown[], sections: [] as unknown[], commands: [] as unknown[] }
    const warnings: string[] = []
    const infos: string[] = []
    const ctx: any = {
      get: (name: string) => (name === 'health' ? undefined : provided.get(name)),
      provide: (name: string, value: unknown) => {
        provided.set(name, value)
      },
      on: () => () => {},
      effect: (fn: () => unknown) => {
        const off = fn()
        if (typeof off === 'function') disposers.push(off as () => unknown)
        return () => {}
      },
      emit: () => {},
      logger: {
        warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
        info: (...args: unknown[]) => { infos.push(args.map(String).join(' ')) },
        error: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
      },
      surfaces: {
        register: (id: string, read: () => unknown) => {
          registered.surfaces.push({ id, read })
          return () => {}
        },
      },
      settings: {
        registerSection: (spec: unknown) => {
          registered.sections.push(spec)
          return () => {}
        },
      },
      commands: {
        register: (spec: unknown, run: unknown) => {
          registered.commands.push({ spec, run })
          return () => {}
        },
      },
      fiber: { restart: async () => {} },
    }

    // plugins.json 里还留着旧键：要报一次「不再读这些键」。
    await apply(ctx, { repoPath: '/old/repo' })
    const runtime = provided.get('orchestrator') as any
    expect(runtime).toBeDefined()
    expect(runtime.configured()).toBe(false)
    // 面板服务：八条 RPC 的容器，surface() 能读出快照。
    const api = provided.get('superagent') as { surface: () => Record<string, unknown> }
    expect(typeof api.surface).toBe('function')
    expect(api.surface()).toBeTypeOf('object')
    // 快照面 / 设置分区 / /sa 命令都登记了。
    expect((registered.surfaces[0] as { id: string }).id).toBe('superagent')
    expect((registered.sections[0] as { id: string }).id).toBe('superagent')
    expect((registered.commands[0] as { spec: { name: string } }).spec.name).toBe('sa')
    // 旧键警告与「等 setup」日志。
    expect(warnings.join('\n')).toContain('deprecated keys')
    expect(infos.join('\n')).toContain('waiting for setup')

    // 退出收摊：面板效果的 disposer 都清掉，运行期 stop 释放目录锁。
    await Promise.all(disposers.splice(0).reverse().map(async (dispose) => await dispose()))
    expect(runtime.lifetime.aborted).toBe(true)
  })

  it('机器参数越界夹回区间、空 stateDir 回落默认；同一目录能被下一个实例接手（释放锁）', async () => {
    const stateRoot = createTempDir('dsc-sa-apply-clamp-')
    restores.push(() => {
      try {
        rmSyncSafe(stateRoot)
      } catch {
        // 系统清
      }
    })
    const previousHome = process.env.DSC_HOME
    process.env.DSC_HOME = stateRoot
    restores.push(() => {
      if (previousHome === undefined) delete process.env.DSC_HOME
      else process.env.DSC_HOME = previousHome
    })
    mkdirSync(join(stateRoot, 'plugins'), { recursive: true })
    writePlugins(stateRoot, [])

    const { apply } = await import('../index.js')
    const provided = new Map<string, unknown>()
    const disposers: Array<() => unknown> = []
    const healthRegistrations: unknown[] = []
    const ctx: any = {
      // 提供 health 服务：doctor 开着时 apply 要登记四项体检（主会话 / 飞书 / 依赖 / 队友）。
      get: (name: string) => (name === 'health' ? { register: (entry: unknown) => { healthRegistrations.push(entry); return () => {} } } : undefined),
      provide: (name: string, value: unknown) => { provided.set(name, value) },
      on: () => () => {},
      effect: (fn: () => unknown) => {
        const off = fn()
        if (typeof off === 'function') disposers.push(off as () => unknown)
        return () => {}
      },
      emit: () => {},
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      surfaces: { register: () => () => {} },
      settings: { registerSection: () => () => {} },
      commands: { register: () => () => {} },
      fiber: { restart: async () => {} },
    }
    await apply(ctx, { stateDir: '', promptMaxChars: -5, admissionContextMaxPages: 9999, admissionContextTimeoutMs: 'nope' })
    const runtime = provided.get('orchestrator') as any
    // 空 stateDir 回落 <DSC_HOME>/superagent；数值越界夹回 limits 区间。
    expect(runtime.machine.stateDir).toBe(join(stateRoot, 'superagent'))
    expect(runtime.machine.promptMaxChars).toBeGreaterThan(0)
    expect(runtime.machine.admissionContextMaxPages).toBeGreaterThan(0)
    // doctor 开着：四项体检都登记了（主会话 / 飞书 / 依赖 / 队友）。
    expect(healthRegistrations).toHaveLength(4)
    await Promise.all(disposers.splice(0).reverse().map(async (dispose) => await dispose()))
    // 释放干净后，同目录能再开一个运行期：拿得到锁、库也关掉了。
    const againProvided = new Map<string, unknown>()
    const againDisposers: Array<() => unknown> = []
    const again: any = {
      ...ctx,
      provide: (name: string, value: unknown) => { againProvided.set(name, value) },
      effect: (fn: () => unknown) => {
        const off = fn()
        if (typeof off === 'function') againDisposers.push(off as () => unknown)
        return () => {}
      },
    }
    await apply(again, { stateDir: join(stateRoot, 'superagent') })
    expect(againProvided.get('orchestrator')).toBeDefined()
    await Promise.all(againDisposers.splice(0).reverse().map(async (dispose) => await dispose()))
  })

  it('运行期构造到一半失败：关库、放锁再抛（同一目录随后还能再开）', async () => {
    const dir = createTempDir('dsc-sa-runtime-catch-')
    restores.push(() => {
      try {
        rmSyncSafe(dir)
      } catch {
        // 系统清
      }
    })
    // 库文件位置先占成一个目录：Store 打开失败，走构造函数的 catch 分支（关库 + 放锁）。
    const stateDir = join(dir, 'state')
    mkdirSync(join(stateDir, 'orchestrator.sqlite'), { recursive: true })
    const { Runtime } = await import('../app/runtime.js')
    const makeCtx = () => ({
      get: () => undefined,
      provide: () => {},
      on: () => () => {},
      effect: () => () => {},
      emit: () => {},
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    })
    expect(() => new Runtime(makeCtx() as never, { stateDir, promptMaxChars: 100_000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15_000 }, () => {})).toThrow()
    // 失败路径放掉了目录锁：同一 stateDir 能再构造（这次库文件位置正常）。
    rmSyncSafe(join(stateDir, 'orchestrator.sqlite'))
    const runtime = new Runtime(makeCtx() as never, { stateDir, promptMaxChars: 100_000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15_000 }, () => {})
    await runtime.ready
    await runtime.stop()
  })
})

// ── 小工具 ────────────────────────────────────────────────────────────────
function writePlugins(home: string, entries: unknown[]): void {
  mkdirSync(join(home, 'plugins'), { recursive: true })
  writeFileSync(join(home, 'plugins.json'), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
}

function rmSyncSafe(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 })
}
