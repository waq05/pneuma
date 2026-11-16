/**
 * superagent 适配层的补盲：`adapters/executor.ts`、`adapters/feishu/read.ts`、
 * `adapters/github/source.ts`、`service.ts`、`adapters/assessor.ts`、`adapters/notify.ts`。
 *
 * 重点同样是**分支**：坏输入、缺省值、降级、失败回滚与「什么也不做」的守卫。
 * 全部离线：假宿主 / 假工作树 / 假会话 / 假 CLI / 假 GitHub API / 内存 kv，
 * 不 spawn 子进程、不发网络请求、不读开发者真实的 `~/.dsc`。
 *
 * @module dsc/packages/superagent/tests/adapters-extra
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CoreEvent } from '@pneuma/runtime/core/events.js'
import type { ToolGuardInput } from '@pneuma/runtime/core/tool-guards.js'
import type { Session } from '@pneuma/runtime/core/session.js'
import type { ThreadRef, Ticket, Trigger } from '../core/model.js'
import type { Assignment, Decision } from '../core/model.js'
import type { EngineForExecutor } from '../core/index.js'
import type { Candidate } from '../core/ports.js'
import type { DscStore } from '../adapters/store.js'
import type { GithubApi, GithubPageOptions } from '../adapters/github/api.js'
import type { GithubKvHandle } from '../adapters/github/state.js'
import type { CliRun } from '../adapters/feishu/cli.js'

const HOME = mkdtempSync(join(tmpdir(), 'superagent-adapters-extra-'))
process.env['DSC_HOME'] = HOME

const { WorkerExecutor, buildWorkerPrompt, turnEndReport, errorReport, worktreeNameOf } =
  await import('../adapters/executor.js')
const { feishuReferences, feishuResource, feishuView, readFeishu, readFeishuLink, feishuRead } =
  await import('../adapters/feishu/read.js')
const { createGithubSource, githubEngine } = await import('../adapters/github/source.js')
const { GithubError } = await import('../adapters/github/api.js')
const { GITHUB_KEYS } = await import('../adapters/github/state.js')
const { SuperagentService } = await import('../service.js')
const { ManualAssessor } = await import('../adapters/assessor.js')
const { noticeText, StoreNotifier, RECENT_CAP } = await import('../adapters/notify.js')

const roots = [HOME]
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  delete process.env['DSC_HOME']
})

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-01T00:01:00.000Z'
const id32 = (seed: string): string => seed.repeat(32).slice(0, 32)
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// ── 执行器：假宿主 / 假会话 / 假 agent ──────────────────────────────────────

interface FakeSession {
  filePath: string
  closed: boolean
  state(id: string): undefined
  appendState(id: string, payload: unknown): void
  close(): void
}

function fakeSession(label = 's'): FakeSession {
  return {
    filePath: join(HOME, 'sessions', `${label}.jsonl`),
    closed: false,
    state: () => undefined,
    appendState: () => {},
    close() {
      this.closed = true
    },
  }
}

interface FakeAgent {
  deps: {
    emit(event: CoreEvent): void
    guards: { gate(input: ToolGuardInput): Promise<unknown>; observe(name: string, text: string): string }
    route(): unknown
    systemPrompt(): { text: string; sections: unknown[] }
    tools(): unknown[]
    beforeRequest(): Promise<void>
    onContextOverflow(): Promise<boolean>
    onIdle(): void
    stream(api: string): Promise<unknown>
  }
  session: FakeSession
  followups: string[]
  cancels: number
  isRunning: boolean
  throwOnFollowup: boolean
  followup(text: string): void
  cancel(): void
}

interface ExecutorEvents {
  started: Array<{ ticketId: string; assignmentId: string }>
  reports: Array<{ ticketId: string; report: { state: string; summary: string } }>
  turnEnded: Array<{ ticketId: string; assignmentId: string }>
  delivered: Array<{ ticketId: string; assignmentId: string; ids: string[] }>
  failed: Array<{ ticketId: string; assignmentId: string; error: string }>
  throwOnReport: boolean
  throwOnTurnEnded: boolean
  throwOnDeliveryFailed: boolean
}

interface ExecutorFixture {
  executor: InstanceType<typeof WorkerExecutor>
  events: ExecutorEvents
  agents: FakeAgent[]
  sessions: FakeSession[]
  ensured: Array<{ repo: string; name: string }>
  logs: string[]
  cleanup(): void
}

interface HostOptions {
  sandbox?: { check(...args: unknown[]): unknown }
  compact?: { check(...args: unknown[]): unknown; forceCompact(...args: unknown[]): unknown }
  tools?: Array<{ name: string } | string>
  gate?: (input: ToolGuardInput) => Promise<unknown>
}

function fakeHost(options: HostOptions = {}): unknown {
  const names = (options.tools ?? ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search'])
    .map((tool) => typeof tool === 'string' ? tool : tool.name)
  return {
    llm: {
      route: () => ({ provider: 'pick', model: 'default', api: 'x' }),
      routeTo: (provider: string, model: string, effort: string) => ({ provider, model, effort, api: 'x' }),
      stream: async () => {
        throw new Error('测试不调用模型')
      },
    },
    tools: { list: () => names.map((name) => ({ name, description: name, inputSchema: {}, risk: 'read', run: async () => '' })) },
    guards: {
      gate: options.gate ?? (async () => ({ action: 'defer' })),
      observe: (_name: string, text: string) => `observed:${text}`,
    },
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.compact === undefined ? {} : { compact: options.compact }),
  }
}

function makeTicket(seed: string, title = '改登录页'): { ticket: Ticket; assignment: Assignment } {
  const id = id32(seed)
  const assignment = { id: `a-${id.slice(0, 6)}`, state: 'pending', createdAt: NOW }
  const ticket = {
    id,
    title,
    decisionId: `d-${id.slice(0, 6)}`,
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      basis: { via: 'addressed', addressed: 'direct' },
      actor: { source: 'manual', id: 'operator' },
      scope: 'manual',
    },
    channels: [],
    assignments: [assignment],
    inputs: [],
    undelivered: [],
    createdAt: NOW,
    updatedAt: NOW,
    origin: { triggerId: `t-${id.slice(0, 6)}`, triggerIds: [`t-${id.slice(0, 6)}`] },
  }
  return { ticket: ticket as unknown as Ticket, assignment: assignment as unknown as Assignment }
}

function executorHarness(options: {
  host?: unknown
  repo?: string
  maxWorkers?: number
  engine?: boolean
  worktreeThrows?: string
  createAgentThrows?: string
  followupThrows?: boolean
  createSession?: (cwd: string, file: string) => Session
  readTriggerText?: (id: string) => string | undefined
  model?: { provider: string; model: string; reasoningEffort?: 'default' | 'off' | 'low' | 'high' | 'max' } | null
  unattended?: 'deny' | 'allow' | 'ask'
  blockedCommands?: readonly string[]
} = {}): ExecutorFixture {
  const root = mkdtempSync(join(tmpdir(), 'superagent-adapters-exec-'))
  roots.push(root)
  const previous = process.env['DSC_HOME']
  process.env['DSC_HOME'] = root

  const events: ExecutorEvents = {
    started: [], reports: [], turnEnded: [], delivered: [], failed: [],
    throwOnReport: false, throwOnTurnEnded: false, throwOnDeliveryFailed: false,
  }
  const agents: FakeAgent[] = []
  const sessions: FakeSession[] = []
  const ensured: Array<{ repo: string; name: string }> = []
  const logs: string[] = []

  const engine = {
    assignmentStarted(ticketId: string, assignmentId: string) {
      events.started.push({ ticketId, assignmentId })
    },
    report(ticketId: string, report: { state: string; summary: string }) {
      if (events.throwOnReport) throw new Error('工单已结束')
      events.reports.push({ ticketId, report })
    },
    turnEnded(ticketId: string, assignmentId: string) {
      if (events.throwOnTurnEnded) throw new Error('分配已结束')
      events.turnEnded.push({ ticketId, assignmentId })
    },
    inputsDelivered(ticketId: string, assignmentId: string, ids: string[]) {
      events.delivered.push({ ticketId, assignmentId, ids })
    },
    deliveryFailed(ticketId: string, assignmentId: string, error: string) {
      if (events.throwOnDeliveryFailed) throw new Error('也写不进去')
      events.failed.push({ ticketId, assignmentId, error })
    },
  }

  const executor = new WorkerExecutor(null, {
    host: (options.host ?? fakeHost()) as never,
    repo: options.repo ?? join(root, 'repo'),
    maxWorkers: options.maxWorkers ?? 2,
    worktree: {
      ensure(input: { repo: string; name: string }) {
        ensured.push({ repo: input.repo, name: input.name })
        if (options.worktreeThrows !== undefined) throw new Error(options.worktreeThrows)
        return { path: join(root, 'worktrees', input.name), branch: `agent/${input.name}`, created: true }
      },
    },
    createSession: (cwd, file) => {
      if (options.createSession !== undefined) return options.createSession(cwd, file)
      const session = fakeSession(String(sessions.length))
      sessions.push(session)
      return session as unknown as Session
    },
    createAgent: (deps) => {
      if (options.createAgentThrows !== undefined) throw new Error(options.createAgentThrows)
      const agent: FakeAgent = {
        deps: deps as never,
        session: sessions.at(-1)!,
        followups: [],
        cancels: 0,
        isRunning: false,
        throwOnFollowup: options.followupThrows ?? false,
        followup(text: string) {
          if (this.throwOnFollowup) throw new Error('投递失败：模型忙')
          this.followups.push(text)
        },
        cancel() {
          this.cancels += 1
        },
      }
      agents.push(agent)
      return agent as never
    },
    ...(options.engine === false ? {} : { engine: () => engine as unknown as EngineForExecutor }),
    ...(options.readTriggerText === undefined ? {} : { readTriggerText: options.readTriggerText }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
    ...(options.blockedCommands === undefined ? {} : { blockedCommands: options.blockedCommands }),
    log: (line: string) => logs.push(line),
  })

  return {
    executor, events, agents, sessions, ensured, logs,
    cleanup() {
      executor.dispose()
      if (previous === undefined) delete process.env['DSC_HOME']
      else process.env['DSC_HOME'] = previous
      rmSync(root, { recursive: true, force: true })
    },
  }
}

// ── 执行器：构造降级 / 路由 / 工具 / 提示词 ────────────────────────────────

test('执行器：没有上下文与可降级能力缺失都只记日志，不抛', () => {
  const lines: string[] = []
  const noCtx = new WorkerExecutor(null, { log: (line) => lines.push(line) })
  expect(lines.join('\n')).toContain('执行器未接宿主（缺 cordis Context）')
  expect(noCtx.tools()).toEqual([])
  expect(() => noCtx.route()).toThrow('执行器未接宿主，取不到模型路由')
  noCtx.dispose()

  const ctx = { get: () => undefined }
  const ctxLines: string[] = []
  const fromCtx = new WorkerExecutor(ctx as unknown as Context, { log: (line) => ctxLines.push(line) })
  expect(ctxLines.join('\n'), '缺 llm/tools/guards 要列全').toContain('缺 llm、tools、guards')
  fromCtx.dispose()

  const degraded: string[] = []
  const degradedExecutor = new WorkerExecutor(null, {
    host: fakeHost() as never,
    log: (line) => degraded.push(line),
  })
  expect(degraded.join('\n')).toContain('sandbox（worker 没有文件围栏')
  expect(degraded.join('\n')).toContain('compact（长会话不会自动压缩')
  degradedExecutor.dispose()
})

test('执行器：routeTo 带 reasoningEffort，工具只挑六件套且缺工具只提醒一次', () => {
  const calls: string[] = []
  const host = fakeHost({ tools: [{ name: 'bash' }, { name: 'read' }] }) as {
    llm: { routeTo(provider: string, model: string, effort: string): unknown }
  }
  host.llm.routeTo = (provider, model, effort) => {
    calls.push(`${provider}/${model}/${effort}`)
    return { provider, model }
  }
  const f = executorHarness({ host: host as never, model: { provider: 'vendor', model: 'deep' } })
  try {
    expect(f.executor.route()).toMatchObject({ provider: 'vendor', model: 'deep' })
    expect(calls).toEqual(['vendor/deep/default'])
    const picked = f.executor.tools()
    expect(picked.map((tool) => (tool as { name: string }).name)).toEqual(['bash', 'read'])
    f.executor.tools()
    expect(f.logs.filter((line) => line.includes('worker 缺工具'))).toHaveLength(1)
    expect(f.logs.join('\n')).toContain('write、edit、glob、grep')
  } finally {
    f.cleanup()
  }
})

test('提示词与工作树名：禁用命令清单与空 slug 的兜底', () => {
  const withBans = buildWorkerPrompt({ title: 't', body: 'b', branch: 'agent/x', repo: 'r', dir: 'd', blockedCommands: ['rm -rf', 'git push'] })
  expect(withBans.text).toContain('以下命令不允许使用：rm -rf、git push')
  expect(withBans.sections[0]).toMatchObject({ id: 'superagent-worker', from: 'plugin:superagent', chars: withBans.text.length })

  const without = buildWorkerPrompt({ title: 't', body: 'b', branch: 'agent/x', repo: 'r', dir: 'd' })
  expect(without.text).toContain('没有额外禁用的命令')

  // 全中文标题会被 slugOf 折成空（或 ticket）：必须补工单 id 后缀才不撞树。
  const empty = worktreeNameOf({ id: id32('a'), title: '改登录页' })
  expect(empty).toMatch(/^ticket-[0-9a-f]{8}$/)
  const named = worktreeNameOf({ id: id32('b'), title: 'x', execution: { name: 'fix-login', directory: 'd', assignment: 'a' } })
  expect(named).toBe(`fix-login-${id32('b').slice(0, 8)}`)
})

// ── 执行器：start / deliver ────────────────────────────────────────────────

test('start 幂等：同分配重复调用不重复建；换分配先停旧 worker', async () => {
  const f = executorHarness()
  try {
    const { ticket, assignment } = makeTicket('a1b2c3d4')
    f.executor.start(ticket, assignment)
    f.executor.start(ticket, assignment)
    await tick()
    expect(f.agents).toHaveLength(1)
    expect(f.events.started).toHaveLength(1)

    const next = { id: 'a-next', state: 'pending', createdAt: LATER } as unknown as Assignment
    f.executor.start(ticket, next)
    expect(f.agents[0]!.cancels).toBe(1)
    await tick()
    expect(f.agents).toHaveLength(2)
    expect(f.events.started.at(-1)).toEqual({ ticketId: ticket.id, assignmentId: next.id })
  } finally {
    f.cleanup()
  }
})

test('deliver：没有 worker / 分配不符 / 空队列都空操作；成功交给引擎，失败走 deliveryFailed', async () => {
  const f = executorHarness()
  try {
    const { ticket, assignment } = makeTicket('d1e2f3a4')
    expect(() => f.executor.deliver(ticket, assignment), 'worker 还没起').not.toThrow()
    f.executor.start(ticket, assignment)
    await tick()
    const initial = f.agents[0]!.followups.length
    expect(() => f.executor.deliver(ticket, assignment), '没有未送达输入').not.toThrow()

    ;(ticket as Ticket).undelivered = ['i1', 'i2', 'i3', 'gone']
    ;(ticket as Ticket).inputs = [
      { id: 'i1', kind: 'trigger', triggerId: 't1', at: NOW },
      { id: 'i2', kind: 'text', text: '一段文本', at: NOW },
      { id: 'i3', kind: 'policy-changed', from: 'v1', to: 'v2', at: NOW },
    ]
    f.executor.deliver(ticket, { ...assignment, id: 'other' } as Assignment)
    expect(f.agents[0]!.followups).toHaveLength(initial)

    f.executor.deliver(ticket, assignment)
    expect(f.events.delivered).toEqual([{ ticketId: ticket.id, assignmentId: assignment.id, ids: ['i1', 'i2', 'i3', 'gone'] }])
    const message = f.agents[0]!.followups.at(-1)!
    expect(message).toContain('（一条新消息，执行器取不到原文：trigger t1')
    expect(message).toContain('一段文本')
    expect(message).toContain('（策略变更：v1 → v2）')
    expect(message).toContain('（工单里找不到输入 gone）')

    f.agents[0]!.throwOnFollowup = true
    f.executor.deliver(ticket, assignment)
    expect(f.events.failed[0]).toMatchObject({ ticketId: ticket.id, error: '投递失败：模型忙' })
    expect(f.logs.join('\n')).toContain('输入投递失败')

    f.events.throwOnDeliveryFailed = true
    f.executor.deliver(ticket, assignment)
    expect(f.logs.join('\n')).toContain('投递失败也未能记进工单')
  } finally {
    f.cleanup()
  }
})

test('deliver：每种 Input 都有自己的取文方式', async () => {
  const f = executorHarness({ readTriggerText: (id) => id === 't1' ? '  trigger 原文  ' : undefined })
  try {
    const { ticket, assignment } = makeTicket('b1c2d3e4')
    f.executor.start(ticket, assignment)
    await tick()
    ;(ticket as Ticket).undelivered = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6']
    ;(ticket as Ticket).inputs = [
      { id: 'i1', kind: 'trigger', triggerId: 't1', at: NOW },
      { id: 'i2', kind: 'trigger', triggerId: 't2', at: NOW },
      { id: 'i3', kind: 'note', text: '一条事实', at: NOW },
      { id: 'i4', kind: 'resumed', triggerId: 't3', at: NOW },
      { id: 'i5', kind: 'reopen', decisionId: 'dec9', at: NOW },
      { id: 'i6', kind: 'text', text: '纯文本', at: NOW },
    ]
    f.executor.deliver(ticket, assignment)
    const message = f.agents[0]!.followups.at(-1)!
    expect(message).toContain('trigger 原文')
    expect(message).toContain('（一条新消息，执行器取不到原文：trigger t2')
    expect(message).toContain('一条事实')
    expect(message).toContain('（工单恢复：按原来的目标继续，trigger t3）')
    expect(message).toContain('（工单被重新打开：按原目标继续，decision dec9）')
    expect(message).toContain('纯文本')
  } finally {
    f.cleanup()
  }
})

// ── 执行器：派工失败的各条路 ───────────────────────────────────────────────

test('派工失败：缺仓库、缺引擎、建树失败、建 agent 失败、首次投递失败都落 failed 报告', async () => {
  const cases: Array<{ label: string; run: () => ExecutorFixture; expect: string }> = [
    { label: '缺仓库', run: () => executorHarness({ repo: '' }), expect: '没有配置仓库路径' },
    { label: '缺引擎', run: () => executorHarness({ engine: false }), expect: '执行器没有引擎回调' },
    { label: '建树失败', run: () => executorHarness({ worktreeThrows: 'git 挂了' }), expect: 'git 挂了' },
    { label: '建 agent 失败', run: () => executorHarness({ createAgentThrows: 'agent 炸了' }), expect: 'agent 炸了' },
    { label: '首次投递失败', run: () => executorHarness({ followupThrows: true }), expect: '投递失败：模型忙' },
  ]
  for (const item of cases) {
    const f = item.run()
    try {
      const { ticket, assignment } = makeTicket('f1a2b3c4')
      f.executor.start(ticket, assignment)
      await tick()
      const summary = f.events.reports.at(-1)?.report.summary ?? f.logs.join('\n')
      expect(f.events.reports.length > 0 ? f.events.reports.at(-1)!.report.state : 'failed', `${item.label}：应报 failed`).toBe('failed')
      expect(summary, `${item.label}：摘要要点名原因`).toContain(item.expect)
    } finally {
      f.cleanup()
    }
  }

  // 建出会话后 agent 失败：会话必须被关掉，不能漏租约。
  const session = fakeSession('orphan')
  const failing = executorHarness({ createAgentThrows: 'agent 炸了', createSession: () => session as unknown as Session })
  try {
    const { ticket, assignment } = makeTicket('c3d4e5f6')
    failing.executor.start(ticket, assignment)
    await tick()
    expect(session.closed, '没有 worker 的会话要还租约').toBe(true)
  } finally {
    failing.cleanup()
  }
})

// ── 执行器：守卫链 ─────────────────────────────────────────────────────────

test('守卫：停止、放宽沙箱、越界、沙箱抛错、降级 delegate 全部分支', async () => {
  const sandbox = {
    mode: 'deny' as 'deny' | 'allow' | 'throw',
    result: { allowed: false, requestable: true, rule: 'outside-workspace' } as Record<string, unknown>,
    check() {
      if (this.mode === 'throw') throw new Error('沙箱挂了')
      return this.result
    },
  }
  const f = executorHarness({ host: fakeHost({ sandbox }) as never, unattended: 'deny' })
  try {
    const { ticket, assignment } = makeTicket('e1f2a3b4')
    f.executor.start(ticket, assignment)
    await tick()
    const deps = f.agents[0]!.deps

    const escalate = { args: { sandbox_permissions: 'danger' }, risk: 'write', target: 'x', command: '' } as unknown as ToolGuardInput
    expect(await deps.guards.gate(escalate)).toMatchObject({ action: 'deny' })
    expect(String((await deps.guards.gate(escalate) as { reason: string }).reason)).toContain('拒绝放宽沙箱')

    const write = { args: {}, risk: 'write', target: 'x', command: '' } as unknown as ToolGuardInput
    const fenced = await deps.guards.gate(write) as { action: string; reason: string }
    expect(fenced.action).toBe('deny')
    expect(fenced.reason).toContain('沙箱规则：outside-workspace')
    expect(fenced.reason).toContain('需要人点一次审批')

    sandbox.result = { allowed: false, requestable: false, reason: 'absolute-path' }
    expect(String((await deps.guards.gate(write) as { reason: string }).reason)).toContain('不该被批准')

    sandbox.result = { allowed: true, requestable: false }
    expect(await deps.guards.gate(write)).toMatchObject({ action: 'defer' })
    expect(await deps.guards.gate({ args: {}, risk: 'read', target: 'x', command: '' } as unknown as ToolGuardInput))
      .toMatchObject({ action: 'defer' })

    sandbox.mode = 'throw'
    expect(await deps.guards.gate(write)).toMatchObject({ action: 'defer' })
    expect(f.logs.join('\n')).toContain('沙箱预判失败')

    expect(deps.guards.observe('bash', 'hi')).toBe('observed:hi')

    f.executor.stop(ticket, assignment, '人停')
    expect(await deps.guards.gate(write)).toMatchObject({ action: 'deny', reason: '工单已停止，worker 不再接受新的工具调用' })
  } finally {
    f.cleanup()
  }
})

test('守卫：allow 档把放宽沙箱交回全局链；没有沙箱服务时直接 delegate', async () => {
  const f = executorHarness({ unattended: 'allow' })
  try {
    const { ticket, assignment } = makeTicket('a2b3c4d5')
    f.executor.start(ticket, assignment)
    await tick()
    const deps = f.agents[0]!.deps
    expect(await deps.guards.gate({ args: { justification: '需要' }, risk: 'write', target: 'x', command: '' } as unknown as ToolGuardInput))
      .toMatchObject({ action: 'defer' })
    expect(await deps.guards.gate({ args: {}, risk: 'write', target: 'x', command: '' } as unknown as ToolGuardInput))
      .toMatchObject({ action: 'defer' })
  } finally {
    f.cleanup()
  }
})

// ── 执行器：报告映射 / 回调 / 收摊 ─────────────────────────────────────────

test('回合事件：start 清正文、空消息忽略、error 与 turn/end 只报一次、aborted 不报', async () => {
  const f = executorHarness()
  try {
    const { ticket, assignment } = makeTicket('b4c5d6e7')
    f.executor.start(ticket, assignment)
    await tick()
    const emit = f.agents[0]!.deps.emit

    emit({ type: 'message', text: '   ' } as never)
    emit({ type: 'message', text: '第一段' } as never)
    emit({ type: 'turn/end', reason: 'completed' } as never)
    expect(f.events.reports.at(-1)!.report).toEqual({ state: 'ready', summary: '第一段' })
    expect(f.events.turnEnded).toHaveLength(1)

    emit({ type: 'turn/start' } as never)
    emit({ type: 'turn/end', reason: 'completed' } as never)
    expect(f.events.reports.at(-1)!.report.summary).toContain('没有留下文字总结')

    emit({ type: 'turn/start' } as never)
    emit({ type: 'error', message: '模型超时' } as never)
    emit({ type: 'turn/end', reason: 'error' } as never)
    expect(f.events.reports.filter((item) => item.report.state === 'failed')).toHaveLength(1)

    emit({ type: 'turn/end', reason: 'aborted' } as never)
    expect(f.events.reports.filter((item) => item.report.state === 'failed')).toHaveLength(1)

    f.executor.stop(ticket, assignment, '人停')
    const before = f.events.reports.length
    emit({ type: 'message', text: '停止后' } as never)
    emit({ type: 'error', message: '停止后错误' } as never)
    emit({ type: 'turn/end', reason: 'error' } as never)
    expect(f.events.reports).toHaveLength(before)
  } finally {
    f.cleanup()
  }
})

test('报告写回失败只记日志；没有引擎时也只在日志里说清', async () => {
  const f = executorHarness()
  try {
    const { ticket, assignment } = makeTicket('c5d6e7f8')
    f.executor.start(ticket, assignment)
    await tick()
    f.events.throwOnReport = true
    f.events.throwOnTurnEnded = true
    expect(() => f.agents[0]!.deps.emit({ type: 'turn/end', reason: 'completed' } as never)).not.toThrow()
    expect(f.logs.join('\n')).toContain('报告未记入')
    expect(f.logs.join('\n')).toContain('回合结束未记入')
  } finally {
    f.cleanup()
  }
})

test('停止：isRunning 为真时先占着名额，onIdle 才关会话；dispose 清队列且幂等', async () => {
  const f = executorHarness({ maxWorkers: 1 })
  try {
    const first = makeTicket('d6e7f8a9')
    const second = makeTicket('e7f8a9b0')
    f.executor.start(first.ticket, first.assignment)
    await tick()
    f.executor.start(second.ticket, second.assignment)
    expect(f.executor.queuedCount).toBe(1)

    f.agents[0]!.isRunning = true
    f.executor.stop(first.ticket, first.assignment, '人停')
    expect(f.executor.activeCount).toBe(0)
    expect(f.executor.workingTicketIds(), '收尾中的 worker 仍算活着').toContain(first.ticket.id)
    expect(f.sessions[0]!.closed).toBe(false)

    f.agents[0]!.deps.onIdle()
    expect(f.sessions[0]!.closed).toBe(true)
    expect(f.executor.workingTicketIds()).toEqual([])
    await tick()
    expect(f.executor.queuedCount, '让位后第二个应开工').toBe(0)

    f.executor.dispose()
    expect(() => f.executor.dispose()).not.toThrow()
    const third = makeTicket('f8a9b0c1')
    f.executor.start(third.ticket, third.assignment)
    await tick()
    expect(f.executor.queuedCount).toBe(0)
  } finally {
    f.cleanup()
  }
})

test('纯函数：空摘要与空错误各有兜底，主动停止一律不报', () => {
  expect(turnEndReport('completed', '   ')).toMatchObject({ state: 'ready', summary: '（worker 这一回合没有留下文字总结，改动请看工作树）' })
  expect(errorReport('   ')).toEqual({ state: 'failed', summary: '回合失败（没有错误详情）' })
  expect(turnEndReport('error', '正文', '   ')).toMatchObject({ state: 'failed', summary: '回合失败（没有错误详情）' })
  expect(turnEndReport('completed', '收尾', undefined, true)).toBeNull()
})

// ── 飞书只读面 ─────────────────────────────────────────────────────────────

const FEISHU_REF = { triggerId: 'trig', chatId: 'oc_1', messageId: 'om_1', at: NOW }

/** 假 lark-cli：把参数交给用例，返回 `{ok:true,data}` 信封。 */
function fakeCli(handler: (args: string[]) => unknown): CliRun {
  return async (args) => ({ code: 0, stdout: JSON.stringify({ ok: true, data: handler([...args]) }), stderr: '' })
}

const message = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  message_id: 'om_1',
  chat_id: 'oc_1',
  content: '正文',
  msg_type: 'text',
  sender: { id: 'ou_a', name: 'Alice', sender_type: 'user' },
  create_time: '1767225600000',
  ...overrides,
})

test('飞书资源名：合法 section 与游标、非法组合都拒绝', () => {
  const refs = feishuReferences(FEISHU_REF)
  expect(refs.message).toBe('feishu/trig/message')
  expect(refs.thread).toBe('feishu/trig/thread')
  expect(feishuResource('feishu/trig/thread/tok%2Fen')).toEqual({ triggerId: 'trig', section: 'thread', cursor: 'tok/en' })
  expect(feishuResource('feishu/trig/root')).toEqual({ triggerId: 'trig', section: 'root', cursor: undefined })

  for (const bad of ['feishu/trig/nope', 'feishu/trig/message/token', 'feishu/trig/root/x', 'nope']) {
    expect(() => feishuResource(bad), bad).toThrow()
  }
})

test('readFeishuLink：只认同群、未删、带链接的那条', async () => {
  const ok = fakeCli(() => ({ messages: [{ message_id: 'om_1', chat_id: 'oc_1', message_app_link: 'https://x.y/z' }] }))
  expect(await readFeishuLink(ok, FEISHU_REF)).toBe('https://x.y/z')

  const cases: Array<[string, unknown]> = [
    ['找不到', { messages: [] }],
    ['已删除', { messages: [{ message_id: 'om_1', chat_id: 'oc_1', message_app_link: 'https://x.y/z', deleted: true }] }],
    ['群不符', { messages: [{ message_id: 'om_1', chat_id: 'oc_2', message_app_link: 'https://x.y/z' }] }],
    ['没链接', { messages: [{ message_id: 'om_1', chat_id: 'oc_1' }] }],
  ]
  for (const [label, data] of cases) {
    await expect(readFeishuLink(fakeCli(() => data), FEISHU_REF), label).rejects.toThrow('Source message link unavailable')
  }
  await expect(readFeishuLink(fakeCli(() => ({})), { ...FEISHU_REF, messageId: 'bad id' })).rejects.toThrow()
})

/** 源消息 mget 的返回。 */
const sourceData = (overrides: Record<string, unknown> = {}): unknown => ({
  items: [{ message_id: 'om_1', chat_id: 'oc_1', ...overrides }],
})

test('readFeishu：源消息不可用 / 串群 / 没话题 / 页外消息 / 游标不前进', async () => {
  const base = (source: unknown): CliRun => fakeCli((args) => args[0] === 'api' ? source : { messages: [], has_more: false, thread_id: 'omt_1' })

  await expect(readFeishu(base({ items: [] }), FEISHU_REF, 'feishu/trig/thread', 10))
    .rejects.toThrow('source Feishu message is unavailable')
  await expect(readFeishu(base(sourceData({ deleted: true })), FEISHU_REF, 'feishu/trig/thread', 10))
    .rejects.toThrow('unavailable or deleted')
  await expect(readFeishu(base(sourceData({ chat_id: 'oc_2' })), FEISHU_REF, 'feishu/trig/thread', 10))
    .rejects.toThrow('chat does not match')
  await expect(readFeishu(fakeCli(() => ({})), { ...FEISHU_REF, messageId: 'nope' }, 'feishu/trig/thread', 10))
    .rejects.toThrow()

  expect(await readFeishu(base(sourceData()), FEISHU_REF, 'feishu/trig/thread', 10))
    .toEqual({ status: 'no_thread', messages: [], next_resource: null })

  const outside = fakeCli((args) => {
    if (args[0] === 'api') return sourceData({ thread_id: 'omt_1' })
    return { messages: [message({ thread_id: 'omt_other' })], has_more: false, thread_id: 'omt_1' }
  })
  await expect(readFeishu(outside, FEISHU_REF, 'feishu/trig/thread', 10)).rejects.toThrow('outside the source thread')

  const wrongThread = fakeCli((args) => {
    if (args[0] === 'api') return sourceData({ thread_id: 'omt_1' })
    return { messages: [], has_more: false, thread_id: 'omt_2' }
  })
  await expect(readFeishu(wrongThread, FEISHU_REF, 'feishu/trig/thread', 10)).rejects.toThrow('outside the source thread')

  const stuck = fakeCli((args) => {
    if (args[0] === 'api') return sourceData({ thread_id: 'omt_1' })
    return { messages: [], has_more: true, thread_id: 'omt_1' }
  })
  await expect(readFeishu(stuck, FEISHU_REF, 'feishu/trig/thread', 10)).rejects.toThrow('pagination did not advance')

  await expect(readFeishu(base(sourceData()), { ...FEISHU_REF, triggerId: 'other' }, 'feishu/trig/thread', 10))
    .rejects.toThrow('source trigger is required')
  await expect(readFeishu(base(sourceData()), FEISHU_REF, 'feishu/trig/around', 10))
    .rejects.toThrow('read with feishuRead')
})

test('readFeishu：话题页跳过坏消息、带出翻页资源；根 / 父 / 本条各有 no_* 与 deleted', async () => {
  const cli = fakeCli((args) => {
    if (args[0] === 'api') return sourceData({ thread_id: 'omt_1', root_id: 'om_root', parent_id: 'om_parent' })
    return {
      messages: [message(), { message_id: 'bad', chat_id: 'oc_1' }],
      has_more: true,
      page_token: 'p 2',
      thread_id: 'omt_1',
    }
  })
  const page = await readFeishu(cli, FEISHU_REF, 'feishu/trig/thread', 10)
  expect(page).toMatchObject({ status: 'available', skipped: 1, next_resource: 'feishu/trig/thread/p%202' })
  expect('messages' in page && page.messages).toHaveLength(1)

  const rootCli = fakeCli((args) => {
    if (args[0] === 'api') return sourceData({ root_id: 'om_root' })
    return { messages: [message({ message_id: 'om_root', deleted: true })] }
  })
  expect(await readFeishu(rootCli, FEISHU_REF, 'feishu/trig/root', 10)).toMatchObject({ status: 'deleted' })

  const noRoot = fakeCli(() => sourceData())
  expect(await readFeishu(noRoot, FEISHU_REF, 'feishu/trig/root', 10)).toEqual({ status: 'no_root', message: null })
  expect(await readFeishu(noRoot, FEISHU_REF, 'feishu/trig/parent', 10)).toEqual({ status: 'no_parent', message: null })

  const missing = fakeCli((args) => {
    if (args[0] === 'api') return sourceData()
    return { messages: [message({ message_id: 'om_other' })] }
  })
  await expect(readFeishu(missing, FEISHU_REF, 'feishu/trig/message', 10))
    .rejects.toThrow('requested Feishu message is unavailable')

  const otherChat = fakeCli((args) => {
    if (args[0] === 'api') return sourceData()
    return { messages: [message({ chat_id: 'oc_other' })] }
  })
  await expect(readFeishu(otherChat, FEISHU_REF, 'feishu/trig/message', 10))
    .rejects.toThrow('outside the source chat')
})

test('feishuView：人名替换、bot / deleted / reply_to / url，坏时间原样交出', async () => {
  const view = feishuView(message({
    content: '@_user_1 你好',
    mentions: [{ id: 'ou_a', key: '@_user_1', name: '小明' }],
    sender: { id: 'ou_bot', sender_type: 'bot' },
    parent_id: 'om_parent',
    message_app_link: 'https://x.y/z',
  }) as never)
  expect(view).toMatchObject({
    from: 'ou_bot', text: '@小明 你好', bot: true, reply_to: 'om_parent', url: 'https://x.y/z',
  })

  const deleted = feishuView(message({ deleted: true, create_time: 'not-a-time' }) as never)
  expect(deleted).toMatchObject({ text: '', deleted: true, at: 'not-a-time' })

  // feishuRead 的非 around 分支：读一条消息再转成同一份视图。
  const cli = fakeCli((args) => args[0] === 'api' ? sourceData() : { messages: [message()] })
  const read = await feishuRead(cli, FEISHU_REF, 'feishu/trig/message', 10)
  expect('message' in read && read.message).toMatchObject({ id: 'om_1', from: 'Alice', text: '正文' })
})

test('feishuRead：around 用时间窗读前后消息、去重、按需翻页；坏时间拒绝', async () => {
  const cli = fakeCli((args) => {
    if (args[0] === 'api' && (args[2] as string).includes('messages/mget')) return sourceData()
    const params = JSON.parse(args[args.indexOf('--params') + 1] as string) as { end_time?: string; start_time?: string; page_token?: string }
    if (params.end_time !== undefined) {
      return {
        items: [
          { message_id: 'om_b', chat_id: 'oc_1', create_time: '1767225602000', sender: { id: 'ou_a', sender_type: 'user' }, body: { content: 'b' } },
          { message_id: 'om_a', chat_id: 'oc_1', create_time: '1767225600000', sender: { id: 'ou_b', sender_type: 'bot' }, body: { content: '{"text":"a"}' } },
        ],
        has_more: true,
        page_token: 'next',
      }
    }
    return {
      items: [
        { message_id: 'om_a', chat_id: 'oc_1', create_time: '1767225600000', sender: { id: 'ou_b', sender_type: 'bot' }, body: { content: 'a' } },
        { message_id: 'om_c', chat_id: 'oc_1', create_time: '1767225603000', sender: { id: 'ou_a', sender_type: 'user' }, body: { content: 'c' }, parent_id: 'om_b' },
      ],
      has_more: false,
    }
  })

  const page = await feishuRead(cli, FEISHU_REF, 'feishu/trig/around', 10)
  expect('messages' in page && page.messages.map((item) => item.id)).toEqual(['om_a', 'om_b', 'om_c'])
  expect(page).toMatchObject({ next_resource: 'feishu/trig/around/next' })

  const onlyEarlier = await feishuRead(cli, FEISHU_REF, 'feishu/trig/around/next', 10)
  expect('messages' in onlyEarlier && onlyEarlier.messages.every((item) => item.id !== 'om_c'), '翻页不再读新消息').toBe(true)

  await expect(feishuRead(cli, { ...FEISHU_REF, at: 'nope' }, 'feishu/trig/around', 10))
    .rejects.toThrow('has no time to read the chat around')
  await expect(feishuRead(cli, { ...FEISHU_REF, triggerId: 'other' }, 'feishu/trig/around', 10))
    .rejects.toThrow('source trigger is required')
})

// ── GitHub 来源 ────────────────────────────────────────────────────────────

/** 内存 kv 表：只实现 `GithubState` 用到的四条 SQL。 */
function kv(): { handle: GithubKvHandle; map: Map<string, string> } {
  const map = new Map<string, string>()
  const handle = {
    prepare(sql: string) {
      const text = sql.trim()
      if (text.startsWith('SELECT value')) {
        return { get: (key: string) => map.has(key) ? { value: map.get(key) } : undefined, run: () => {}, all: () => [] }
      }
      if (text.startsWith('DELETE')) {
        return { get: () => undefined, run: (key: string) => { map.delete(key) }, all: () => [] }
      }
      if (text.startsWith('INSERT')) {
        return { get: () => undefined, run: (key: string, value: string) => { map.set(key, value) }, all: () => [] }
      }
      return { get: () => undefined, run: () => {}, all: () => [] }
    },
  }
  return { handle: handle as unknown as GithubKvHandle, map }
}

interface ApiCall { kind: 'getPage' | 'get' | 'slurp' | 'post'; path: string; options?: GithubPageOptions }

/** 假 GitHub API：按路径返回用例给的数据，并记下每次调用。 */
function fakeApi(route: (path: string) => { body?: unknown; headers?: Record<string, string> }): { api: GithubApi; calls: ApiCall[] } {
  const calls: ApiCall[] = []
  const page = (path: string, options?: GithubPageOptions) => {
    calls.push({ kind: 'getPage', path, ...(options === undefined ? {} : { options }) })
    const result = route(path)
    return { status: 200, headers: result.headers ?? {}, body: result.body }
  }
  return {
    calls,
    api: {
      repository: 'acme/widgets',
      getPage: async (path, options) => page(path, options),
      get: async (path, options) => {
        calls.push({ kind: 'get', path, ...(options === undefined ? {} : { options }) })
        return route(path).body
      },
      slurp: async (path, options) => {
        calls.push({ kind: 'slurp', path, ...(options === undefined ? {} : { options }) })
        return route(path).body as unknown[]
      },
      post: async (path) => {
        calls.push({ kind: 'post', path })
        return route(path).body
      },
    } as GithubApi,
  }
}

interface SourceFixture {
  received: Trigger[]
  closed: Array<{ thread: ThreadRef; reason: string | undefined; at: string | undefined }>
  source: ReturnType<typeof createGithubSource>
  logs: string[]
  store: ReturnType<typeof kv>
  calls: ApiCall[]
}

function sourceHarness(route: (path: string) => { body?: unknown; headers?: Record<string, string> }, options: {
  observe?: { issues?: boolean; pulls?: boolean; comments?: boolean; ci?: boolean }
} = {}): SourceFixture {
  const store = kv()
  const received: Trigger[] = []
  const closed: Array<{ thread: ThreadRef; reason: string | undefined; at: string | undefined }> = []
  const logs: string[] = []
  const { api, calls } = fakeApi(route)
  const source = createGithubSource({
    api,
    repository: 'acme/widgets',
    login: 'agent-bot',
    engine: {
      receive(trigger) {
        received.push(trigger)
        return 'stored'
      },
      bindThread() {},
      threadClosed(thread, reason, at) {
        closed.push({ thread, reason, at })
        return undefined
      },
    },
    store: { handle: store.handle },
    now: () => NOW,
    log: (line) => logs.push(line),
    observe: options.observe,
  })
  return { received, closed, source, logs, store, calls }
}

function seedKv(store: ReturnType<typeof kv>, key: string, value: unknown): void {
  store.map.set(key, JSON.stringify(value))
}

test('github tick：观察全关时清掉三条流、保留 CI revision，只读通知', async () => {
  const seeded = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    throw new Error(`不该读 ${path}`)
  }, { observe: { issues: false, pulls: false, comments: false, ci: false } })
  seedKv(seeded.store, GITHUB_KEYS.stream('issues'), { since: NOW, started: {} })
  seedKv(seeded.store, GITHUB_KEYS.branchCi, { branch: 'main', failures: ['build'], revision: 3 })

  await seeded.source.tick()
  expect(seeded.calls.filter((call) => call.kind === 'getPage').map((call) => call.path.split('?')[0]))
    .toEqual(['notifications'])
  expect(seeded.store.map.has(GITHUB_KEYS.stream('issues')), '关掉的流清游标').toBe(false)
  expect(JSON.parse(seeded.store.map.get(GITHUB_KEYS.branchCi)!)).toEqual({ revision: 3 })
  expect(seeded.logs.join('\n')).toContain('github: poll done at')
  expect(seeded.source.status()).toEqual({ lastPollAt: NOW, lastError: null })
})

test('github tick：通知读失败仍跑完事件流与默认分支 CI，最后把原始错误抛出来', async () => {
  const h = sourceHarness((path) => {
    if (path.startsWith('notifications')) throw new Error('notifications down')
    if (path === '') return { body: { default_branch: 'main' } }
    if (path === 'commits/main') return { body: { sha: 'abc1234' } }
    if (path.startsWith('commits/abc1234/')) return { body: [] }
    return { body: [] }
  })
  await expect(h.source.tick()).rejects.toThrow('notifications down')
  expect(h.calls.some((call) => call.path === ''), '默认分支 CI 照跑').toBe(true)
  expect(h.calls.some((call) => call.path.startsWith('issues?')), '事件流照跑').toBe(true)
  expect(h.source.status().lastError).toBe('Error: notifications down')
})

test('github 通知：410 丢、超过 24 小时丢、普通失败进重试表；都不算本拍失败', async () => {
  const h = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    if (path === 'issues/9') throw new GithubError('gone', 410)
    if (path === 'issues/11') throw new Error('boom')
    if (path === 'issues/10') throw new Error('old failure')
    return { body: [] }
  }, { observe: { issues: false, pulls: false, comments: false, ci: false } })
  seedKv(h.store, GITHUB_KEYS.retries, {
    9: { since: NOW, pr: false, failedAt: NOW, attempts: 1 },
    10: { since: NOW, pr: false, failedAt: '2026-01-01T00:00:00.000Z', attempts: 1 },
    // 11 没有 failedAt：这一拍才第一次失败，必须留下重试。
    11: { since: NOW, pr: false, attempts: 1 },
  })
  // 10 的 failedAt 比这一拍早 24 小时：把时钟拨后一天来触发「放弃」。
  const later = '2026-01-02T00:00:00.000Z'
  const source = createGithubSource({
    api: fakeApi((path) => {
      if (path.startsWith('notifications')) return { body: [] }
      if (path === 'issues/9') throw new GithubError('gone', 410)
      if (path === 'issues/10') throw new Error('old failure')
      if (path === 'issues/11') throw new Error('boom')
      return { body: [] }
    }).api,
    repository: 'acme/widgets',
    login: 'agent-bot',
    engine: { receive() {}, bindThread() {}, threadClosed() {} },
    store: { handle: h.store.handle },
    now: () => later,
    log: () => {},
    observe: { issues: false, pulls: false, comments: false, ci: false },
  })
  await expect(source.tick()).rejects.toThrow('1 GitHub reads failed')
  const retries = JSON.parse(h.store.map.get(GITHUB_KEYS.retries)!) as Record<string, unknown>
  expect(Object.keys(retries), '只有可重试的那条留下').toEqual(['11'])
})

test('github 事件流：304 静默、ETag 只在游标没动时复用、自己的消息跳过', async () => {
  const silent = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    throw new GithubError('not modified', 304)
  }, { observe: { issues: true, pulls: false, comments: false, ci: false } })
  seedKv(silent.store, GITHUB_KEYS.stream('issues'), { since: NOW, started: { issues: NOW } })
  await silent.source.tick()
  expect(silent.source.status().lastError, '304 不是失败').toBeNull()

  const fresh = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    if (path.startsWith('issues?')) {
      return {
        body: [
          issue(1, 'agent-bot', NOW),
          issue(2, 'alice', '2025-01-01T00:00:00.000Z'),
          issue(3, 'alice', NOW, true),
        ],
        headers: { etag: 'new-etag' },
      }
    }
    return { body: [] }
  }, { observe: { issues: true, pulls: true, comments: false, ci: false } })
  seedKv(fresh.store, GITHUB_KEYS.stream('issues'), { since: NOW, started: { issues: NOW, pulls: NOW }, etag: 'old-etag' })
  await fresh.source.tick()
  const page = fresh.calls.find((call) => call.path.startsWith('issues?'))!
  expect(page.options?.etag, '游标没动就带 If-None-Match').toBe('old-etag')
  expect(fresh.received.map((trigger) => trigger.meta.number), '自己的与视野外的都跳过').toEqual([3])
  expect(JSON.parse(fresh.store.map.get(GITHUB_KEYS.stream('issues'))!).etag).toBe('new-etag')

  const invalid = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    return { body: { not: 'a list' } }
  }, { observe: { issues: true, pulls: false, comments: false, ci: false } })
  await expect(invalid.source.tick()).rejects.toThrow('non-list response')
})

test('github 评论流：只收视野内、指得出编号、非自己的评论；review 流按 PR 处理', async () => {
  const h = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    if (path.startsWith('issues/comments')) {
      return {
        body: [
          comment(10, 'alice', NOW, 'https://api.github.com/repos/acme/widgets/issues/12'),
          comment(11, 'alice', NOW, 'not-an-issue-url'),
          comment(12, 'agent-bot', NOW, 'https://api.github.com/repos/acme/widgets/issues/12'),
          comment(13, 'alice', '2025-01-01T00:00:00.000Z', 'https://api.github.com/repos/acme/widgets/issues/12'),
        ],
        headers: {},
      }
    }
    if (path.startsWith('pulls/comments')) {
      return {
        body: [comment(20, 'bob', NOW, 'https://api.github.com/repos/acme/widgets/pulls/12', 'https://github.com/acme/widgets/pull/12#discussion_r20')],
        headers: {},
      }
    }
    return { body: [] }
  }, { observe: { issues: false, pulls: false, comments: true, ci: false } })

  await h.source.tick()
  expect(h.received.map((trigger) => trigger.meta.number)).toEqual([12, 12])
  expect(h.received.map((trigger) => trigger.meta.commentId)).toEqual([10, 20])
})

test('github 默认分支 CI：首拍只建基线，失败集合变化才上报，进行中沿用旧集合', async () => {
  const baseline = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    if (path === '') return { body: { default_branch: 'main' } }
    if (path === 'commits/main') return { body: { sha: 'abc1234' } }
    if (path.includes('check-runs')) return { body: [] }
    if (path.includes('statuses')) return { body: [] }
    return { body: [] }
  }, { observe: { issues: false, pulls: false, comments: false, ci: true } })
  await baseline.source.tick()
  expect(baseline.received, '第一次只看基线').toEqual([])
  expect(JSON.parse(baseline.store.map.get(GITHUB_KEYS.branchCi)!)).toMatchObject({ branch: 'main', revision: 0 })

  const changed = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    if (path === '') return { body: { default_branch: 'main' } }
    if (path === 'commits/main') return { body: { sha: 'abc1234' } }
    if (path.includes('check-runs')) return { body: [{ check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }] }
    if (path.includes('statuses')) return { body: [] }
    return { body: [] }
  }, { observe: { issues: false, pulls: false, comments: false, ci: true } })
  seedKv(changed.store, GITHUB_KEYS.branchCi, { branch: 'main', failures: ['build'], revision: 2 })
  await changed.source.tick()
  expect(changed.received).toHaveLength(1)
  expect(changed.received[0]!.text).toContain('CI failed')
  expect(JSON.parse(changed.store.map.get(GITHUB_KEYS.branchCi)!)).toMatchObject({ failures: ['test'], revision: 3 })

  const running = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    if (path === '') return { body: { default_branch: 'main' } }
    if (path === 'commits/main') return { body: { sha: 'abc1234' } }
    if (path.includes('check-runs')) return { body: [{ check_runs: [{ name: 'lint', status: 'in_progress', conclusion: null }] }] }
    if (path.includes('statuses')) return { body: [] }
    return { body: [] }
  }, { observe: { issues: false, pulls: false, comments: false, ci: true } })
  seedKv(running.store, GITHUB_KEYS.branchCi, { branch: 'main', failures: ['build'], revision: 4 })
  await running.source.tick()
  expect(running.received, '还在跑就沿用上一次失败集合').toEqual([])
  expect(JSON.parse(running.store.map.get(GITHUB_KEYS.branchCi)!)).toMatchObject({ failures: ['build'], revision: 4 })

  const renamed = sourceHarness((path) => {
    if (path.startsWith('notifications')) return { body: [] }
    if (path === '') return { body: { default_branch: 'main' } }
    if (path === 'commits/main') return { body: { sha: 'abc1234' } }
    return { body: [] }
  }, { observe: { issues: false, pulls: false, comments: false, ci: true } })
  seedKv(renamed.store, GITHUB_KEYS.branchCi, { branch: 'develop', failures: ['old'], revision: 9 })
  await renamed.source.tick()
  expect(renamed.received, '换默认分支不拿旧分支的失败集合比较').toEqual([])
  expect(JSON.parse(renamed.store.map.get(GITHUB_KEYS.branchCi)!).revision).toBe(9)
})

test('githubEngine：缺省关闭时刻用注入的时钟，merged 之外都算 closed', () => {
  const closed: Array<{ outcome: string; at: string }> = []
  const engine = githubEngine({
    receive() {},
    bindThread() {},
    threadClosed(_thread, outcome, at) {
      closed.push({ outcome, at })
    },
  }, () => LATER)
  engine.threadClosed({ source: 'github', id: '1' }, 'merged')
  engine.threadClosed({ source: 'github', id: '2' }, 'closed', NOW)
  engine.threadClosed({ source: 'github', id: '3' }, undefined)
  expect(closed).toEqual([
    { outcome: 'merged', at: LATER },
    { outcome: 'closed', at: NOW },
    { outcome: 'closed', at: LATER },
  ])
})

/** 事件流里的一条 Issue；`pr` 决定它带不带 `pull_request`。 */
function issue(number: number, login: string, createdAt: string, pr = false): Record<string, unknown> {
  return {
    id: number * 10,
    number,
    title: `#${String(number)}`,
    state: 'open',
    created_at: createdAt,
    html_url: `https://github.com/acme/widgets/issues/${String(number)}`,
    user: { login, type: 'User' },
    ...(pr ? { pull_request: { url: `https://api.github.com/repos/acme/widgets/pulls/${String(number)}` } } : {}),
  }
}

function comment(id: number, login: string, updatedAt: string, issueUrl: string, htmlUrl = `https://github.com/acme/widgets/issues/12#issuecomment-${String(id)}`):
  Record<string, unknown> {
  return {
    id,
    body: `comment ${String(id)}`,
    user: { login, type: 'User' },
    html_url: htmlUrl,
    created_at: updatedAt,
    updated_at: updatedAt,
    issue_url: issueUrl,
    pull_request_url: issueUrl,
  }
}

// ── 插件服务 ───────────────────────────────────────────────────────────────

interface FakeRuntime {
  list(): Array<Record<string, unknown>>
  recent(): Array<{ at: string; text: string }>
  publish(input: Record<string, unknown>): string
  stop(id: string): void
  retry(id: string): void
  clean(id: string): void
  pump(): void
  closed?: boolean
}

function runtimeOf(overrides: Partial<FakeRuntime> = {}): { runtime: FakeRuntime; calls: string[] } {
  const calls: string[] = []
  const runtime: FakeRuntime = {
    list: () => [],
    recent: () => [],
    publish: (input) => {
      calls.push(`publish:${JSON.stringify(input)}`)
      return 'tk1'
    },
    stop: (id) => { calls.push(`stop:${id}`) },
    retry: (id) => { calls.push(`retry:${id}`) },
    clean: (id) => { calls.push(`clean:${id}`) },
    pump: () => { calls.push('pump') },
    ...overrides,
  }
  return { runtime, calls }
}

interface ServiceDeps {
  current(): object | null
  ensure(): object | null
  problem(): { code: string; detail: string } | null
  changed(): void
}

function serviceOf(deps: Partial<ServiceDeps> & { runtime?: unknown }): {
  service: InstanceType<typeof SuperagentService>
  changed: () => number
} {
  let changes = 0
  const service = new SuperagentService({
    current: deps.current ?? (() => null),
    ensure: deps.ensure ?? (() => deps.runtime ?? null),
    problem: deps.problem ?? (() => null),
    changed: deps.changed ?? (() => { changes += 1 }),
  } as never)
  return { service, changed: () => changes }
}

test('服务快照：ensure 抛错、未启动、读库失败三档都降级成一句原因', () => {
  const thrown = serviceOf({ ensure: () => { throw new Error('锁被占') } })
  expect(thrown.service.surface()).toMatchObject({ ready: false, problem: { code: 'store_unavailable', detail: '锁被占' } })

  const started = serviceOf({ ensure: () => null, problem: () => ({ code: 'store_unavailable', detail: '库没打开' }) })
  expect(started.service.surface().problem).toEqual({ code: 'store_unavailable', detail: '库没打开' })
  expect(started.service.surface().counts).toEqual({ needsYou: 0, running: 0, done: 0 })

  const idle = serviceOf({ ensure: () => null })
  expect(idle.service.surface().problem).toMatchObject({ code: 'not_started' })

  const broken = serviceOf({ runtime: { list: () => { throw new Error('读坏了') }, recent: () => [] } })
  expect(broken.service.surface()).toMatchObject({ ready: false, problem: { code: 'read_failed', detail: '读坏了' } })
})

test('服务快照：三组计数按阶段分组，recent 原样带出', () => {
  const { runtime } = runtimeOf({
    list: () => [
      { id: 'a', title: 'A', stage: { stage: 'person', action: 'review' }, createdAt: NOW },
      { id: 'b', title: 'B', stage: { stage: 'working', action: 'queued' }, createdAt: NOW },
      { id: 'c', title: 'C', stage: { stage: 'idle' }, createdAt: NOW },
      { id: 'd', title: 'D', stage: { stage: 'ended' }, createdAt: NOW },
    ],
    recent: () => [{ at: NOW, text: '一条动态' }],
  })
  const result = serviceOf({ runtime }).service.surface()
  expect(result.counts).toEqual({ needsYou: 1, running: 2, done: 1 })
  expect(result.tickets).toHaveLength(4)
  expect(result.recent).toEqual([{ at: NOW, text: '一条动态' }])
})

test('服务 publish：标题必填、空正文回落到标题、没接单要报错', async () => {
  const missing = serviceOf({ runtime: runtimeOf().runtime })
  await expect(missing.service.publish({ title: '', body: '' })).rejects.toThrow('标题不能为空')
  await expect(missing.service.publish({ title: '   ', body: '正文' })).rejects.toThrow('标题不能为空')

  const accepted = runtimeOf({ list: () => [{ id: 'tk1' }] })
  const { service } = serviceOf({ runtime: accepted.runtime })
  await expect(service.publish({ title: ' 修登录 ', body: '  ', base: '  ' })).resolves.toBe('tk1')
  expect(accepted.calls).toContain('publish:{"title":"修登录","body":"修登录"}')
  expect(accepted.calls.join('|'), '空 base 不传').not.toContain('base')

  const rejected = runtimeOf({ publish: () => 'trigger-only', list: () => [] })
  await expect(serviceOf({ runtime: rejected.runtime }).service.publish({ title: '标题', body: '正文' }))
    .rejects.toThrow('没有接单成功')
})

test('服务 stop / retry / clean / peekSession：空 id 拒绝，成功走运行期并推快照', async () => {
  const { runtime, calls } = runtimeOf()
  const { service, changed } = serviceOf({ runtime })
  for (const method of ['stop', 'retry', 'clean'] as const) {
    await expect(service[method]('  ')).rejects.toThrow('要给一个工单 id')
  }
  await expect(service.peekSession('')).rejects.toThrow('要给一个工单 id')

  await service.stop(' tk1 ')
  await service.retry('tk1')
  await service.clean('tk1')
  expect(calls).toEqual(['stop:tk1', 'retry:tk1', 'clean:tk1'])
  expect(changed()).toBe(3)

  // changed 抛错不影响动作本身。
  const throwing = serviceOf({ runtime, changed: () => { throw new Error('界面通道坏了') } })
  await expect(throwing.service.stop('tk1')).resolves.toBeUndefined()

  // 已结束但没有会话目录：读转录给一句能操作的话。
  await expect(service.peekSession('tk1')).rejects.toThrow('还没有执行会话')
})

test('服务 beforeready：ensure 连续失败时 require 把 problem 原文抛出来', async () => {
  const { service } = serviceOf({
    ensure: () => null,
    problem: () => ({ code: 'store_unavailable', detail: '编排库没打开：权限不足' }),
  })
  await expect(service.stop('tk1')).rejects.toThrow('编排库没打开：权限不足')
  expect(service.surface().problem).toEqual({ code: 'store_unavailable', detail: '编排库没打开：权限不足' })
})

test('服务 tick：没运行期不动作；指纹变了才推快照；泵异常原样抛出', () => {
  let changes = 0
  const idle = serviceOf({ current: () => null, changed: () => { changes += 1 } })
  idle.service.tick()
  expect(changes).toBe(0)

  const runtime = runtimeOf({ list: () => [{ id: 'tk1', title: 't', stage: { stage: 'working' }, createdAt: NOW }] })
  const active = new SuperagentService({
    current: () => runtime.runtime,
    ensure: () => runtime.runtime,
    problem: () => null,
    changed: () => { changes += 1 },
  } as never)
  active.tick()
  expect(changes).toBe(1)
  active.tick()
  expect(changes, '指纹没变就不推').toBe(1)

  runtime.runtime.list = () => [{ id: 'tk1', title: 't', stage: { stage: 'ended' }, createdAt: NOW }]
  active.tick()
  expect(changes).toBe(2)

  const broken = new SuperagentService({
    current: () => ({ pump: () => { throw new Error('泵炸了') } }),
    ensure: () => null,
    problem: () => null,
    changed: () => {},
  } as never)
  expect(() => broken.tick()).toThrow('泵炸了')
})

// ── 判定器队列 ─────────────────────────────────────────────────────────────

function candidateOf(overrides: Partial<Candidate> = {}): Candidate {
  return {
    evalId: 'eval-1',
    thread: { key: 'feishu:x', ref: { source: 'feishu', id: 'x' }, createdAt: NOW, subscriptions: [], correlated: [], pending: [], meta: {} },
    triggers: [{ id: 'trig1', source: 'feishu', threads: [{ source: 'feishu', id: 'x' }], actor: { source: 'feishu', id: 'u' }, human: true, at: NOW, text: '改一下', meta: {} }],
    strength: 'explicit',
    policyVersion: 'v1',
    tickets: [],
    ...overrides,
  }
}

interface DecideCall { triggerId: string; outcome: Record<string, unknown> }

function assessorHarness(candidates: Record<string, Candidate | undefined>, decide: (triggerId: string, outcome: Record<string, unknown>) => Decision): {
  assessor: InstanceType<typeof ManualAssessor>
  calls: DecideCall[]
  errors: Array<{ evalId: string; message: string }>
  engine: never
} {
  const calls: DecideCall[] = []
  const errors: Array<{ evalId: string; message: string }> = []
  const assessor = new ManualAssessor((error, evalId) => {
    errors.push({ evalId, message: error instanceof Error ? error.message : String(error) })
  })
  const engine = {
    candidate: (triggerId: string) => candidates[triggerId],
    decide: (triggerId: string, outcome: Record<string, unknown>) => {
      calls.push({ triggerId, outcome })
      return decide(triggerId, outcome)
    },
  }
  return { assessor, calls, errors, engine: engine as never }
}

test('判定器：标题优先 meta.title，其次正文第一行；没有 trigger 时兜底', () => {
  const base = candidateOf()
  const candidates: Record<string, Candidate> = {
    meta: candidateOf({
      evalId: 'eval-meta',
      triggers: [{ ...base.triggers[0]!, id: 'meta', text: '正文', meta: { title: '  Meta 标题  ' } }],
    }),
    line: candidateOf({
      evalId: 'eval-line',
      triggers: [{ ...base.triggers[0]!, id: 'line', text: '\n  第一行\n第二行' }],
    }),
    weak: candidateOf({
      evalId: 'eval-weak',
      strength: 'inferred',
      triggers: [{ ...base.triggers[0]!, id: 'weak' }],
    }),
  }
  const h = assessorHarness(candidates, (triggerId) => (triggerId === 'weak'
    ? { kind: 'ignore' } as Decision
    : { ticketId: `tk-${triggerId}` } as Decision))
  for (const triggerId of ['meta', 'line', 'weak']) {
    h.assessor.request(candidates[triggerId]!)
  }
  const created = h.assessor.drain(h.engine)
  const outcomes = h.calls.map((call) => call.outcome)
  expect(outcomes[0]).toMatchObject({ kind: 'accept', title: 'Meta 标题' })
  expect(outcomes[1]).toMatchObject({ kind: 'accept', title: '第一行' })
  expect(outcomes[2]).toMatchObject({ kind: 'ignore', reason: 'Manual source admits only explicit requests in P0' })
  expect(created).toEqual(['tk-meta', 'tk-line'])
})

test('判定器：同 eval 去重、没有 trigger 不入队、release / clear 丢掉待办', () => {
  const candidate = candidateOf()
  const h = assessorHarness({ trig1: candidate }, () => ({ } as Decision))
  h.assessor.request(candidate)
  h.assessor.request(candidate)
  h.assessor.drain(h.engine)
  expect(h.calls).toHaveLength(1)

  h.assessor.request(candidateOf({ triggers: [], evalId: 'none' }))
  h.assessor.request(candidateOf({ evalId: 'released' }))
  h.assessor.release('released')
  h.assessor.request(candidateOf({ evalId: 'cleared' }))
  h.assessor.clear()
  h.assessor.drain(h.engine)
  expect(h.calls).toHaveLength(1)
})

test('判定器：候选过期 / evalId 不符就丢，decide 抛错走 onError 且不影响其余', () => {
  const candidates: Record<string, Candidate | undefined> = {
    gone: undefined,
    stale: candidateOf({ evalId: 'other' }),
    ok: candidateOf({ evalId: 'eval-ok' }),
    boom: candidateOf({ evalId: 'eval-boom' }),
  }
  const h = assessorHarness(candidates, (triggerId) => {
    if (triggerId === 'boom') throw new Error('Eval 已结束')
    return { ticketId: triggerId === 'ok' ? 'tk-ok' : undefined } as Decision
  })
  h.assessor.request(candidateOf({ evalId: 'eval-gone', triggers: [{ ...candidateOf().triggers[0]!, id: 'gone' }] }))
  h.assessor.request(candidateOf({ evalId: 'eval-stale', triggers: [{ ...candidateOf().triggers[0]!, id: 'stale' }] }))
  h.assessor.request(candidateOf({ evalId: 'eval-ok', triggers: [{ ...candidateOf().triggers[0]!, id: 'ok' }] }))
  h.assessor.request(candidateOf({ evalId: 'eval-boom', triggers: [{ ...candidateOf().triggers[0]!, id: 'boom' }] }))

  expect(h.assessor.drain(h.engine)).toEqual(['tk-ok'])
  expect(h.calls.map((call) => call.triggerId)).toEqual(['ok', 'boom'])
  expect(h.errors).toEqual([{ evalId: 'eval-boom', message: 'Eval 已结束' }])
  expect(h.assessor.drain(h.engine), '出队后不重复判定').toEqual([])
})

// ── 通知文案与内存窗口 ─────────────────────────────────────────────────────

function noticeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tk1', title: '修登录', decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed', addressed: 'mention' }, actor: { source: 'manual', id: 'u' }, scope: 'manual' },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: NOW, updatedAt: NOW,
    origin: { triggerId: 't1', triggerIds: ['t1'] },
    ...overrides,
  }
}

test('通知文案：五种结束态、失败停在派工还是回合、长摘要压成一行截断', () => {
  expect(noticeText(noticeTicket())).toBe('工单「修登录」已结束。')
  expect(noticeText(noticeTicket({ ended: { at: NOW, by: 'executor', outcome: 'completed' } })))
    .toBe('工单「修登录」已完成，但 worker 没留交付摘要。')
  expect(noticeText(noticeTicket({
    ended: { at: NOW, by: 'executor', outcome: 'completed' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: NOW, startedAt: NOW, report: { state: 'ready', summary: '改了 a.ts（+1/−0）', at: NOW } }],
  }))).toBe('工单「修登录」已完成：改了 a.ts（+1/−0）')

  expect(noticeText(noticeTicket({
    ended: { at: NOW, by: 'executor', outcome: 'merged' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: NOW, report: { state: 'ready', summary: '合了', at: NOW } }],
  }))).toBe('工单「修登录」已结束：它跟的 PR 已合并：合了')
  expect(noticeText(noticeTicket({ ended: { at: NOW, by: 'executor', outcome: 'closed' } })))
    .toBe('工单「修登录」已结束：它跟的 PR 被关闭，没有合并')
  expect(noticeText(noticeTicket({ ended: { at: NOW, by: 'executor', outcome: 'dropped' } })))
    .toBe('工单「修登录」已结束：worker 说没有剩下要做的事。')
  expect(noticeText(noticeTicket({
    ended: { at: NOW, by: 'executor', outcome: 'dropped' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: NOW, report: { state: 'dropped', summary: '没活了', at: NOW } }],
  }))).toBe('工单「修登录」已结束：worker 说没有剩下要做的事：没活了')

  expect(noticeText(noticeTicket({ ended: { at: NOW, by: 'human', outcome: 'stopped' } })))
    .toBe('工单「修登录」已停止（你要求停止）。')
  expect(noticeText(noticeTicket({
    ended: { at: NOW, by: 'human', outcome: 'stopped' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: NOW, report: { state: 'failed', summary: '卡住了', at: NOW } }],
  }))).toBe('工单「修登录」已停止。失败在派工（建工作树、起 worker）：卡住了')
  expect(noticeText(noticeTicket({
    ended: { at: NOW, by: 'human', outcome: 'stopped' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: NOW, startedAt: NOW, report: { state: 'failed', summary: '卡住了', at: NOW } }],
  }))).toBe('工单「修登录」已停止。失败在worker 的回合：卡住了')
  expect(noticeText(noticeTicket({
    ended: { at: NOW, by: 'human', outcome: 'stopped' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: NOW, report: { state: 'failed', summary: '   ', at: NOW } }],
  }))).toBe('工单「修登录」已停止。失败在派工（建工作树、起 worker）（没有错误详情）')

  const long = noticeText(noticeTicket({
    ended: { at: NOW, by: 'executor', outcome: 'completed' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: NOW, startedAt: NOW, report: { state: 'ready', summary: `  ${'改'.repeat(300)}  `, at: NOW } }],
  }))
  expect(long).toContain('…')
  expect(long.length).toBeLessThan(260)
})

/** 只有 outbox 两件事的假库：`enqueueOutbox` 与 `StoreOutbox.status` 读的那条 SELECT。 */
function outboxStore(): { store: DscStore; rows: Map<string, string> } {
  const rows = new Map<string, string>()
  const handle = {
    prepare(sql: string) {
      if (sql.trim().startsWith('SELECT value')) {
        return { get: (id: string) => rows.has(id) ? { value: rows.get(id) } : undefined, run: () => {}, all: () => [] }
      }
      return { get: () => undefined, run: () => {}, all: () => [] }
    },
  }
  const store = {
    handle,
    enqueueOutbox(row: { id: string; kind: string; payload: unknown }) {
      rows.set(row.id, JSON.stringify(row))
    },
  } as unknown as DscStore
  return { store, rows }
}

test('通知落点：没结束不入队、同一结束幂等、换结束时刻是新的一条', () => {
  const { store, rows } = outboxStore()
  const notifier = new StoreNotifier(store)
  notifier.ended(noticeTicket())
  expect(rows.size).toBe(0)

  const ended = noticeTicket({ ended: { at: NOW, by: 'executor', outcome: 'completed' } })
  notifier.ended(ended)
  notifier.ended(ended)
  expect(rows.size).toBe(1)
  const row = JSON.parse([...rows.values()][0]!) as { id: string; kind: string; payload: { message: { channel: { source: string }; kind: string; ticketId: string }; at: string } }
  expect(row.id).toBe(`notice:tk1:${NOW}`)
  expect(row.payload.message).toMatchObject({ channel: { source: 'manual' }, kind: 'notice', ticketId: 'tk1' })
  expect(row.payload.at).toBe(NOW)

  notifier.ended(noticeTicket({ ended: { at: LATER, by: 'executor', outcome: 'completed' } }))
  expect(rows.size).toBe(2)
})

test('最近动态：窗口上限丢最旧的，recent 给副本', () => {
  const { store } = outboxStore()
  const notifier = new StoreNotifier(store)
  notifier.remember(Array.from({ length: RECENT_CAP + 5 }, (_, index) => ({ at: String(index), text: String(index) })))
  const recent = notifier.recent()
  expect(recent).toHaveLength(RECENT_CAP)
  expect(recent[0]).toEqual({ at: '5', text: '5' })
  recent.push({ at: 'x', text: 'x' })
  expect(notifier.recent(), '外部改副本不影响窗口').toHaveLength(RECENT_CAP)
  notifier.remember([{ at: 'last', text: 'last' }])
  expect(notifier.recent().at(-1)).toEqual({ at: 'last', text: 'last' })
})
