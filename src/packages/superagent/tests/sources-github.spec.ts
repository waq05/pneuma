/**
 * GitHub 来源（`sources/github.ts`）的轮询与 kind 行为测试：通知、仓库级事件流、工单 PR 的 CI、
 * 订阅线程的补读、默认分支 CI，以及启动/停止入口。
 *
 * 为什么值得钉：这一层判错不抛异常的地方最多——通知游标挪早一秒就丢消息，挪晚一秒就重复收；
 * CI 第一次读不当基线会把整个仓库的历史失败灌成工单；停止信号没检查就会在插件停用后继续调 gh。
 * 所以每条用例都用「假 ctx 记下了什么」断言，而不是「有没有抛错」。
 *
 * 假的只有 `Commands`（按路径喂 HTTP 文本 / JSON）与 `SourceContext`（内存 state、记录 receive /
 * report / patch / describe）；`pollRound`、`pollTicketPulls`、`pollThreads`、`pollNotifications`
 * 等被测函数与 zod schema 全是源码。不联网、不跑 gh、不碰 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/sources-github
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Commands } from '../infra/commands.js'
import { CliError } from '../infra/commands.js'
import type { Ticket, Thread, Trigger } from '../core/index.js'
import { KV } from '../kv.js'
import type { SourceContext, SourceHost } from '../sources/host.js'
import {
  githubKind,
  pollFailure,
  pollRound,
  pollThreads,
  pollTicketPulls,
  startGithub,
} from '../sources/github.js'

// ── 假件 ────────────────────────────────────────────────────────────────────

const nowIso = (): string => new Date().toISOString()
const user = (login = 'carol', type = 'User') => ({ login, type, id: 5 })

/** 拼一条带响应头的 GitHub `--include` 原始输出。 */
const include = (body: string, headers = 'HTTP/2 200'): string => `${headers}\n\n${body}`

const issue = (over: Record<string, unknown> = {}) => ({
  id: 1, number: 12, title: 'A bug', state: 'open', body: 'steps', user: user(),
  html_url: 'https://github.com/acme/widgets/issues/12', created_at: nowIso(), updated_at: nowIso(),
  ...over,
})
const pullRecord = (over: Record<string, unknown> = {}) => ({
  title: 'A PR', state: 'open', html_url: 'https://github.com/acme/widgets/pull/13', user: user(),
  body: 'why', created_at: nowIso(), merged: false, merged_at: null, closed_at: null, auto_merge: null,
  head: { sha: 'abcdef1', ref: 'agent/ticket-1', repo: { full_name: 'acme/widgets' } },
  ...over,
})
const comment = (over: Record<string, unknown> = {}) => ({
  id: 2, body: 'me too', user: user(), html_url: 'https://github.com/acme/widgets/issues/12#issuecomment-2',
  created_at: nowIso(), updated_at: nowIso(),
  ...over,
})
const notification = (url: string | null, repository = 'acme/widgets') => ({ repository: { full_name: repository }, subject: { url } })
const configOf = (over: Record<string, unknown> = {}) => githubKind.schema.parse({ repository: 'acme/widgets', cli: 'gh', ...over })

interface ApiHandler {
  (path: string, flags: string[]): unknown
}

/** 造一个 GitHub 用的 `Commands` 假件：按路径分派，未覆盖的路径当场抛错（不静默返回 undefined）。 */
function fakeGithub(api: ApiHandler, pages: (path: string) => unknown[] = () => { throw new Error('测试假件没有 pages 数据') }) {
  const calls = { api: [] as { path: string; flags: string[] }[], pages: [] as string[] }
  const commands = {
    calls,
    deployment: { repository: 'acme/widgets', github: { cli: 'gh', login: 'agent', noreply: '1+agent@users.noreply.github.com' } },
    withSignal: () => commands,
    async api(schemaOrPath: unknown, ...rest: unknown[]): Promise<unknown> {
      const raw = typeof schemaOrPath === 'string'
      const path = raw ? (schemaOrPath as string) : ((rest[0] as string | undefined) ?? '')
      const flags = (raw ? rest : rest.slice(1)) as string[]
      calls.api.push({ path, flags })
      const value = await api(path, flags)
      if (raw) return value
      return (schemaOrPath as { parse(value: unknown): unknown }).parse(value)
    },
    async pages(item: { safeParse(value: unknown): { success: boolean; data?: unknown } }, path: string, tally?: { skipped: number }) {
      calls.pages.push(path)
      const rows = pages(path)
      const parsed = rows.flatMap(row => {
        const result = item.safeParse(row)
        return result.success ? [result.data] : []
      })
      if (tally) tally.skipped += rows.length - parsed.length
      return parsed
    },
    async gh(): Promise<never> { throw new Error('测试假件不执行 gh') },
    async run(): Promise<never> { throw new Error('测试假件不执行子进程') },
    async lark(): Promise<never> { throw new Error('测试假件不执行 lark') },
  }
  return commands as unknown as Commands & { calls: typeof calls }
}

interface ContextOptions {
  config?: unknown
  api: ApiHandler
  pages?: (path: string) => unknown[]
  tickets?: Ticket[]
  threads?: Thread[]
  state?: Map<string, unknown>
  triggers?: Record<string, Trigger>
  deployment?: Record<string, unknown>
}

/** 造一个 `SourceContext` 假件：只实现被测代码用到的成员，记录收到的 Trigger / 体检 / 线程描述。 */
function fakeContext(options: ContextOptions) {
  const state = options.state ?? new Map<string, unknown>()
  const commands = fakeGithub(options.api, options.pages)
  const received: Trigger[] = []
  const reports: { entry: string; health: unknown }[] = []
  const patches: unknown[][] = []
  const described: unknown[][] = []
  const bound: unknown[][] = []
  const closed: unknown[][] = []
  const threads = options.threads ?? []
  const deployment = options.deployment ?? {
    repository: 'acme/widgets',
    github: { cli: 'gh', login: 'agent', noreply: '1+agent@users.noreply.github.com' },
    feishu: { cli: 'lark-cli', appId: 'cli_app', brand: 'feishu', botId: 'ou_bot', name: 'Bot' },
  }
  const context = {
    deployment,
    commands,
    ready: Promise.resolve(),
    configured: () => true,
    problem: undefined,
    config: () => options.config,
    receive: async (trigger: Trigger) => { received.push(trigger); return {} as never },
    atomic: <T>(work: () => T) => work(),
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => { value === undefined ? state.delete(key) : state.set(key, value) },
      keys: () => [...state.keys()],
    },
    threads: {
      get: (key: string) => threads.find(thread => thread.key === key),
      subscribed: () => threads,
      describe: (...args: unknown[]) => described.push(args),
      patch: (...args: unknown[]) => patches.push(args),
    },
    tickets: {
      get: (id: string) => (options.tickets ?? []).find(ticket => ticket.id === id),
      open: () => (options.tickets ?? []).filter(ticket => !ticket.ended),
      bindThread: (...args: unknown[]) => bound.push(args),
      threadClosed: (...args: unknown[]) => closed.push(args),
    },
    triggers: { get: (id: string) => options.triggers?.[id], latest: () => undefined },
    notify: () => {},
    report: (entry: string, value: unknown) => reports.push({ entry, health: value }),
    received, reports, patches, described, bound, closed,
  }
  return { context: context as unknown as SourceContext, received, reports, patches, described, bound, closed, state, commands }
}

const threadOf = (over: Partial<Thread> = {}): Thread => ({
  key: 'github:12', ref: { source: 'github', id: '12' }, createdAt: nowIso(), lastAt: nowIso(),
  subscriptions: [], correlated: [], pending: [], meta: { number: 12, isPr: false, title: 'A bug' }, ...over,
})

const ticketOf = (over: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'ticket', decisionId: 'd1', mandate: { actor: { source: 'github', id: 'carol' }, strength: 'explicit', basis: {} } as never,
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  origin: { triggerId: 'trig-1', triggerIds: [] }, ...over,
})

// ── 通知轮询 ────────────────────────────────────────────────────────────────

describe('pollRound 通知', () => {
  it('读通知 → 读 Issue → 灌触发器 → 线程描述 → 推进游标并报 ready', async () => {
    const context = fakeContext({
      config: configOf(),
      api: (path) => {
        if (path.startsWith('notifications?all=true')) {
          return include(JSON.stringify([notification('https://api.github.com/repos/acme/widgets/issues/12')]), 'HTTP/2 200\nx-poll-interval: 120')
        }
        if (path === 'issues/12') return issue({ body: 'steps to reproduce' })
        throw new Error(`意外的 api 路径：${path}`)
      },
      pages: (path) => {
        if (path.startsWith('issues/12/comments?')) return []
        throw new Error(`意外的 pages 路径：${path}`)
      },
    })
    const interval = await pollRound(context.context)
    expect(interval, 'x-poll-interval 是 120 秒').toBe(120)
    expect(context.received).toHaveLength(1)
    expect(context.received[0]).toMatchObject({
      source: 'github', threads: [{ source: 'github', id: '12' }], text: 'A bug\n\nsteps to reproduce',
      meta: { number: 12, isPr: false, kind: 'issue' },
    })
    expect(context.patches).toContainEqual(['github:12', { title: 'A bug' }])
    expect(context.described).toContainEqual(['github:12', { label: '#12 A bug', facts: { number: { value: '#12' } } }])
    expect(context.patches).toContainEqual(['github:12', { pollError: undefined }])
    expect(context.state.get(KV.github.since)).toBeTruthy()
    expect(context.state.get(KV.github.cursor(12))).toBeTruthy()
    expect(context.reports.at(-1)).toEqual({
      entry: 'github',
      health: expect.objectContaining({ state: 'ready', detail: expect.stringContaining('1 notifications; next poll ≥ 120s') }),
    })
  })

  it('分页通知（rel=next）走 pages，并跳过别的仓库、讨论链接、无链接、重复编号', async () => {
    const context = fakeContext({
      config: configOf(),
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include('', 'HTTP/2 200\nlink: <x>; rel="next"')
        if (path === 'issues/12') return issue()
        throw new Error(`意外的 api 路径：${path}`)
      },
      pages: (path) => {
        if (path.startsWith('notifications?all=true')) {
          return [
            notification('https://api.github.com/repos/acme/widgets/issues/12'),
            notification('https://api.github.com/repos/acme/widgets/issues/12'),
            notification('https://api.github.com/repos/other/repo/issues/9'),
            notification('https://api.github.com/repos/acme/widgets/issues/13#discussion_r5'),
            notification(null),
          ]
        }
        if (path.startsWith('issues/12/comments?')) return []
        throw new Error(`意外的 pages 路径：${path}`)
      },
    })
    await pollRound(context.context)
    expect(context.received, '只有 #12 收了一次').toHaveLength(1)
    expect(context.state.get(KV.github.cursor(12))).toBeTruthy()
  })

  it('某个 Issue 读失败时记到重试表与线程 pollError，整轮报错', async () => {
    const context = fakeContext({
      config: configOf(),
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include(JSON.stringify([notification('https://api.github.com/repos/acme/widgets/issues/12')]))
        if (path === 'issues/12') throw new CliError('Not Found (HTTP 404)', 404)
        throw new Error(`意外的 api 路径：${path}`)
      },
    })
    await expect(pollRound(context.context)).rejects.toThrow(/1 GitHub reads failed: #12:/)
    const retries = context.state.get(KV.github.retries) as Record<string, { attempts: number; pr: boolean }>
    expect(retries['12']).toMatchObject({ attempts: 1, pr: false })
    expect(context.patches).toContainEqual(['github:12', { pollError: 'Error: Not Found (HTTP 404)' }])
  })

  it('410 的 Issue 只记成「已删除」并推进游标，不算整轮失败', async () => {
    const state = new Map<string, unknown>()
    const context = fakeContext({
      config: configOf(),
      state,
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include(JSON.stringify([notification('https://api.github.com/repos/acme/widgets/issues/12')]))
        if (path === 'issues/12') throw new CliError('Gone (HTTP 410)', 410)
        throw new Error(`意外的 api 路径：${path}`)
      },
    })
    await expect(pollRound(context.context)).resolves.toBe(60)
    expect(context.state.get(KV.github.retries)).toEqual({})
    expect(context.reports.at(-1)!.health).toMatchObject({ state: 'ready', detail: expect.stringContaining('deleted on GitHub: #12') })
  })

  it('重试超过 24 小时的条目被放弃，并写进健康详情', async () => {
    const state = new Map<string, unknown>()
    state.set(KV.github.retries, {
      '12': { since: new Date(Date.now() - 48 * 3600_000).toISOString(), pr: false, failedAt: new Date(Date.now() - 25 * 3600_000).toISOString(), attempts: 8 },
    })
    const context = fakeContext({
      config: configOf(),
      state,
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include('[]')
        if (path === 'issues/12') throw new CliError('Not Found (HTTP 404)', 404)
        throw new Error(`意外的 api 路径：${path}`)
      },
    })
    await expect(pollRound(context.context)).resolves.toBe(60)
    expect(context.state.get(KV.github.retries)).toEqual({})
    expect(context.reports.at(-1)!.health).toMatchObject({ detail: expect.stringContaining('dropped after their reads kept failing: #12') })
  })

  it('通知里点名 PR 时读 PR 描述并补读评论', async () => {
    const context = fakeContext({
      config: configOf(),
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include(JSON.stringify([notification('https://api.github.com/repos/acme/widgets/pulls/13')]))
        if (path === 'pulls/13') return pullRecord({ created_at: nowIso() })
        throw new Error(`意外的 api 路径：${path}`)
      },
      pages: (path) => {
        if (path.startsWith('issues/13/comments?') || path.startsWith('pulls/13/comments?') || path.startsWith('pulls/13/reviews?')) return []
        throw new Error(`意外的 pages 路径：${path}`)
      },
    })
    await pollRound(context.context)
    expect(context.received.map(trigger => trigger.meta.kind)).toEqual(['pull'])
    expect(context.patches).toContainEqual(['github:13', { title: 'A PR' }])
  })

  it('信号已中止时只读通知、不推进、不报 ready', async () => {
    const controller = new AbortController()
    const context = fakeContext({
      config: configOf(),
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include('[]')
        throw new Error(`不该再读：${path}`)
      },
    })
    controller.abort()
    await expect(pollRound(context.context, controller.signal)).resolves.toBe(60)
    expect(context.reports, '中止时不写健康').toHaveLength(0)
    expect(context.received).toHaveLength(0)
  })
})

// ── 仓库级事件流与默认分支 CI ───────────────────────────────────────────────

describe('pollRound 仓库事件流', () => {
  it('打开 Issues / PR 观察后，把两类新条目都灌成触发器并写游标与 ETag', async () => {
    const context = fakeContext({
      config: configOf({ observeIssues: true, observePulls: true }),
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include('[]')
        if (path.startsWith('issues?state=all')) {
          return include(JSON.stringify([
            issue({ number: 12, created_at: nowIso() }),
            issue({ id: 3, number: 13, title: 'A PR', pull_request: { url: 'x' }, created_at: nowIso() }),
            issue({ id: 4, number: 14, title: 'Mine', user: user('agent'), created_at: nowIso() }),
          ]), 'HTTP/2 200\netag: W/"abc"')
        }
        throw new Error(`意外的 api 路径：${path}`)
      },
    })
    await pollRound(context.context)
    expect(context.received.map(trigger => trigger.meta.kind)).toEqual(['issue', 'pull'])
    const stream = context.state.get(KV.github.stream('issues')) as { since: string; started: Record<string, string>; etag?: string }
    expect(stream.etag).toBe('W/"abc"')
    expect(Object.keys(stream.started).sort()).toEqual(['issues', 'pulls'])
    expect(Date.parse(stream.since), '游标不晚于本轮开始').toBeLessThanOrEqual(Date.now())
  })

  it('游标没动时带 If-None-Match，304 视为成功且不重复灌触发器', async () => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const state = new Map<string, unknown>()
    state.set(KV.github.stream('issues'), { since, started: { issues: since, pulls: since }, etag: 'W/"abc"' })
    const context = fakeContext({
      config: configOf({ observeIssues: true }),
      state,
      api: (path, flags) => {
        if (path.startsWith('notifications?all=true')) return include('[]')
        if (path.startsWith('issues?state=all')) {
          expect(flags).toContain('If-None-Match: W/"abc"')
          expect(path).toContain(`since=${encodeURIComponent(new Date(Date.parse(since)).toISOString())}`)
          throw new CliError('Not Modified (HTTP 304)', 304)
        }
        throw new Error(`意外的 api 路径：${path}`)
      },
    })
    await expect(pollRound(context.context)).resolves.toBe(60)
    expect(context.received).toHaveLength(0)
  })

  it('仓库级评论流：对话评论、行内评论各按自己的地址归一', async () => {
    const context = fakeContext({
      config: configOf({ observeComments: true }),
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include('[]')
        if (path.startsWith('issues/comments?')) {
          return include(JSON.stringify([
            { ...comment({ id: 1, body: 'on issue' }), issue_url: 'https://api.github.com/repos/acme/widgets/issues/12' },
            { ...comment({ id: 2, body: 'on pr' }), issue_url: 'https://api.github.com/repos/acme/widgets/issues/13', html_url: 'https://github.com/acme/widgets/pull/13#issuecomment-2' },
          ]))
        }
        if (path.startsWith('pulls/comments?')) {
          return include(JSON.stringify([
            { ...comment({ id: 3, body: 'inline', path: 'src/a.ts', line: 4 }), pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/13' },
          ]))
        }
        throw new Error(`意外的 api 路径：${path}`)
      },
    })
    await pollRound(context.context)
    expect(context.received.map(trigger => [trigger.meta.number, trigger.meta.kind])).toEqual([[12, 'conversation'], [13, 'conversation'], [13, 'inline']])
  })

  it('默认分支 CI：第一次只建基线，失败集合变了才灌 Trigger 并刷新线程事实', async () => {
    let failing = false
    const commands = {
      default_branch: 'main',
      commits: { sha: 'abcdef1' },
      checks: () => [{ check_runs: [{ name: 'build', status: 'completed', conclusion: failing ? 'failure' : 'success' }] }],
    }
    const context = fakeContext({
      config: configOf({ observeCi: true }),
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include('[]')
        if (path === '') return { default_branch: commands.default_branch }
        if (path === 'commits/main') return commands.commits
        if (path.startsWith('commits/abcdef1/check-runs')) return commands.checks()
        throw new Error(`意外的 api 路径：${path}`)
      },
      pages: (path) => {
        if (path.startsWith('commits/abcdef1/statuses')) return []
        throw new Error(`意外的 pages 路径：${path}`)
      },
    })
    await pollRound(context.context)
    expect(context.received, '第一次只是基线').toHaveLength(0)
    expect(context.state.get(KV.github.branchCi)).toMatchObject({ branch: 'main', failures: [], revision: 0 })

    failing = true
    await pollRound(context.context)
    expect(context.received).toHaveLength(1)
    expect(context.received[0]).toMatchObject({ threads: [{ source: 'github', id: 'ci:main' }], meta: { ci: true, branch: 'main', revision: 1 } })
    expect(context.described).toContainEqual(['github:ci:main', { label: 'CI on main', facts: { ci: expect.objectContaining({ problem: true }) } }])
  })

  it('关掉 CI 观察时保留 revision、清掉失败集合', async () => {
    const state = new Map<string, unknown>()
    state.set(KV.github.branchCi, { branch: 'main', failures: ['build'], revision: 4 })
    const context = fakeContext({
      config: configOf({ observeCi: false }),
      state,
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include('[]')
        throw new Error(`不该读仓库接口：${path}`)
      },
    })
    await pollRound(context.context)
    expect(context.state.get(KV.github.branchCi)).toEqual({ revision: 4 })
  })

  it('事件流读失败时把错误累进整轮失败，别的步骤照样跑完', async () => {
    const context = fakeContext({
      config: configOf({ observeIssues: true, observePulls: true }),
      api: (path) => {
        if (path.startsWith('notifications?all=true')) return include('[]')
        if (path.startsWith('issues?state=all')) throw new CliError('boom', 500)
        throw new Error(`意外的 api 路径：${path}`)
      },
      threads: [],
    })
    await expect(pollRound(context.context)).rejects.toThrow(/1 GitHub reads failed: issues: Error: boom/)
  })
})

// ── 工单的 PR 与 CI ─────────────────────────────────────────────────────────

describe('pollTicketPulls', () => {
  it('跳过已合并/已关闭的 PR，CI 首次只建指纹、第二次变化才灌 Trigger', async () => {
    let conclusion = 'success'
    const context = fakeContext({
      config: configOf(),
      tickets: [ticketOf({ follows: [{ thread: 'github:13', own: true }, { thread: 'github:14', own: true }] })],
      api: (path) => {
        if (path === 'pulls/13') return pullRecord()
        if (path === 'pulls/14') return pullRecord({ state: 'closed', merged: true })
        if (path.startsWith('commits/abcdef1/check-runs')) return [{ check_runs: [{ name: 'build', status: 'completed', conclusion }] }]
        throw new Error(`意外的 api 路径：${path}`)
      },
      pages: (path) => {
        if (path.startsWith('commits/abcdef1/statuses')) return []
        throw new Error(`意外的 pages 路径：${path}`)
      },
    })
    await pollTicketPulls(context.context, undefined)
    expect(context.received, '首轮建立 CI 基线').toHaveLength(0)
    expect(context.state.get(KV.github.ci(13))).toMatchObject({ revision: 0 })
    expect(context.closed, '已合并的 PR 结束对应跟单').toHaveLength(1)

    conclusion = 'failure'
    await pollTicketPulls(context.context, undefined)
    expect(context.received).toHaveLength(1)
    expect(context.received[0]).toMatchObject({ threads: [{ source: 'github', id: '13' }], meta: { ci: true, revision: 1 } })
    expect(context.described).toContainEqual(['github:13', { facts: { ci: expect.objectContaining({ problem: true }) } }])
  })

  it('读 PR 失败记到线程与整轮失败里', async () => {
    const context = fakeContext({
      config: configOf(),
      tickets: [ticketOf({ follows: [{ thread: 'github:13', own: true }] })],
      api: (path) => {
        if (path === 'pulls/13') throw new CliError('Not Found (HTTP 404)', 404)
        throw new Error(`意外的 api 路径：${path}`)
      },
    })
    await pollTicketPulls(context.context, undefined)
    expect(context.patches).toContainEqual(['github:13', { pollError: 'Error: Not Found (HTTP 404)' }])
  })

  it('中止信号下不读任何 PR', async () => {
    const controller = new AbortController()
    controller.abort()
    const context = fakeContext({
      config: configOf(),
      tickets: [ticketOf({ follows: [{ thread: 'github:13', own: true }] })],
      api: () => { throw new Error('不该发请求') },
    })
    await pollTicketPulls(context.context, controller.signal)
    expect(context.commands.calls.api).toHaveLength(0)
  })
})

// ── 订阅线程补读 ────────────────────────────────────────────────────────────

describe('pollThreads（订阅线程）', () => {
  it('Issue 线程按游标补读评论并推进游标', async () => {
    const context = fakeContext({
      config: configOf(),
      threads: [threadOf()],
      api: () => { throw new Error('Issue 线程不该读 api') },
      pages: (path) => {
        if (path.startsWith('issues/12/comments?')) return [comment({ updated_at: nowIso() })]
        throw new Error(`意外的 pages 路径：${path}`)
      },
    })
    await pollThreads(context.context, undefined)
    expect(context.received).toHaveLength(1)
    expect(context.received[0]).toMatchObject({ meta: { number: 12, isPr: false, kind: 'conversation' } })
    expect(context.state.get(KV.github.cursor(12))).toBeTruthy()
  })

  it('PR 线程补读三种评论，并把 threadId 与 CI 之外的评论都收进来', async () => {
    const context = fakeContext({
      config: configOf(),
      threads: [threadOf({ ref: { source: 'github', id: '13' }, meta: { number: 13, isPr: true, title: 'A PR' } })],
      api: (path) => {
        if (path === 'pulls/13') return pullRecord()
        throw new Error(`意外的 api 路径：${path}`)
      },
      pages: (path) => {
        if (path.startsWith('issues/13/comments?')) return [comment({ id: 21, updated_at: nowIso() })]
        if (path.startsWith('pulls/13/comments?')) return [comment({ id: 22, path: 'src/a.ts', line: 1, updated_at: nowIso() })]
        if (path.startsWith('pulls/13/reviews?')) return [comment({ id: 23, body: 'ok', state: 'APPROVED', updated_at: null, submitted_at: nowIso() })]
        throw new Error(`意外的 pages 路径：${path}`)
      },
    })
    await pollThreads(context.context, undefined)
    expect(context.received.map(trigger => trigger.meta.kind)).toEqual(['conversation', 'inline', 'review'])
  })

  it('线程元数据缺 isPr/title 时先读 Issue 补齐，再按 PR / Issue 补读', async () => {
    const threads: Thread[] = [threadOf({ key: 'github:13', ref: { source: 'github', id: '13' }, meta: {} })]
    const context = fakeContext({
      config: configOf(),
      threads,
      api: (path) => {
        if (path === 'issues/13') return issue({ number: 13, title: 'A PR', html_url: 'https://github.com/acme/widgets/issues/13', pull_request: { url: 'x' } })
        if (path === 'pulls/13') return pullRecord({ number: 13 })
        throw new Error(`意外的 api 路径：${path}`)
      },
      pages: (path) => {
        if (path.startsWith('issues/13/comments?') || path.startsWith('pulls/13/comments?') || path.startsWith('pulls/13/reviews?')) return []
        throw new Error(`意外的 pages 路径：${path}`)
      },
    })
    await pollThreads(context.context, undefined)
    expect(context.patches).toContainEqual(['github:13', { number: 13, isPr: true, url: 'https://github.com/acme/widgets/issues/13' }])
    expect(context.patches).toContainEqual(['github:13', { title: 'A PR' }])
  })

  it('默认分支 CI 线程不读 Issue/PR；没有编号的线程记成失败', async () => {
    const ciThread = threadOf({ key: 'github:ci:main', ref: { source: 'github', id: 'ci:main' }, meta: {} })
    const badThread = threadOf({ key: 'github:nope', ref: { source: 'github', id: 'nope' }, meta: {} })
    const context = fakeContext({ config: configOf(), threads: [ciThread, badThread], api: () => { throw new Error('不该读 api') } })
    // 坏线程的异常由 pollEach 记到 pollError；不会把整轮抛出来（pollThreads 自己吃掉）。
    await pollThreads(context.context, undefined)
    expect(context.patches).toContainEqual(['github:nope', { pollError: 'Error: Subscribed thread has no GitHub issue or PR number' }])
  })

  it('上报已删除的 Issue 线程只记 dropped，不算整轮失败', async () => {
    const context = fakeContext({
      config: configOf(),
      threads: [threadOf()],
      api: () => { throw new Error('不该读 api') },
      pages: () => { throw new CliError('Gone (HTTP 410)', 410) },
    })
    await pollThreads(context.context, undefined)
    expect(context.patches).toContainEqual(['github:12', { pollError: 'Error: Gone (HTTP 410)' }])
  })
})

// ── 健康判定与启停 ──────────────────────────────────────────────────────────

describe('pollFailure', () => {
  it('连续失败达到阈值才报 error，并在文案里带上次数与最后一次错误', () => {
    expect(pollFailure(1, 3, new Error('x'))).toBeUndefined()
    expect(pollFailure(3, 3, new Error('boom'))).toEqual({
      state: 'error', detail: '3 consecutive failed polls; last: Error: boom', code: 'pollFailures', values: { count: '3', error: 'Error: boom' },
    })
  })
})

describe('startGithub', () => {
  const hostOf = () => {
    const unregister = vi.fn()
    const reports: unknown[] = []
    const context = {
      deployment: { repository: 'acme/widgets', github: { cli: 'gh', login: 'agent', noreply: 'x' } },
      commands: {},
      ready: Promise.resolve(),
      configured: () => false,
      problem: undefined,
      config: () => undefined,
      receive: async () => ({}),
      atomic: <T>(work: () => T) => work(),
      state: { get: () => undefined, set: () => {}, keys: () => [] },
      threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
      tickets: { get: () => undefined, open: () => [], bindThread: () => {}, threadClosed: () => {} },
      triggers: { get: () => undefined, latest: () => undefined },
      notify: () => {},
      report: (_entry: string, value: unknown) => reports.push(value),
    }
    const host = { sources: { register: () => unregister }, context: () => context }
    return { host: host as unknown as SourceHost, reports, unregister }
  }

  it('注册 kind、等就绪后报 setupPending，停止后注销；重复停止无害', async () => {
    const { host, reports, unregister } = hostOf()
    const controller = new AbortController()
    const stop = startGithub(host, controller.signal)
    controller.abort()
    stop()
    stop()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(reports[0]).toMatchObject({ state: 'paused', code: 'setupPending' })
  })
})

// ── githubKind 的声明面 ─────────────────────────────────────────────────────

describe('githubKind', () => {
  const deployment = {
    repository: 'acme/widgets', github: { cli: 'gh', login: 'Agent', noreply: '1+agent@users.noreply.github.com' },
    feishu: undefined, stateDir: '/tmp/state', promptMaxChars: 1, admissionContextMaxPages: 1, admissionContextTimeoutMs: 1,
  }

  it('scope：CI 线程看 observeCi，Issue/PR/评论分别看自己的开关，认不出的 meta 不观察', () => {
    const config = configOf({ observeCi: true, observeIssues: true })
    expect(githubKind.scope!({ meta: { ci: true, branch: 'main' } }, config)).toEqual({ listened: true, observed: true, row: 'ci' })
    expect(githubKind.scope!({ meta: { ci: true } }, config), '没有 branch 的 CI 认不出').toEqual({ listened: true, observed: false })
    expect(githubKind.scope!({ meta: { kind: 'issue' } }, config)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(githubKind.scope!({ meta: { kind: 'pull' } }, config)).toEqual({ listened: true, observed: false, row: 'pulls' })
    expect(githubKind.scope!({ meta: { kind: 'inline' } }, config)).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(githubKind.scope!({ meta: {} }, config)).toEqual({ listened: true, observed: false })
  })

  it('policy.rows 把四个观察开关翻成准入表行', () => {
    const rows = githubKind.policy!.rows!(configOf({ observeIssues: true, observeComments: true }))
    expect(rows.map(row => row.id)).toEqual(['issues', 'pulls', 'comments', 'ci'])
    expect(rows[0]).toMatchObject({ note: { zh: '全部' }, cells: { listedUnaddressed: true, unlistedUnaddressed: true } })
    expect(rows[1]).toMatchObject({ note: { zh: '仅 @' }, cells: { listedUnaddressed: false } })
    expect(rows[2]).toMatchObject({ note: { zh: '全部' } })
    expect(rows[3]).toMatchObject({ note: { zh: '不接收' }, cells: { listedUnaddressed: false, unlistedAddressed: false } })
    expect(githubKind.policy!.rows!(configOf({ observeCi: true }))[3]!.note).toEqual({ zh: '接收', en: 'Received' })
  })

  it('environment.values 按触发来源给编号与 PR head', () => {
    const trigger = { source: 'github', threads: [{ source: 'github', id: '12' }], meta: { number: 12, isPr: true } }
    expect(githubKind.environment!.values({ deployment, config: configOf(), trigger: trigger as never })).toEqual({
      DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets',
      DSH_SUPERAGENT_GITHUB_ACCOUNT: 'Agent',
      DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: '1+agent@users.noreply.github.com',
      DSH_SUPERAGENT_GITHUB_NUMBER: '12',
      DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/12/head',
    })
    expect(githubKind.environment!.values({ deployment, config: configOf(), trigger: { source: 'feishu', threads: [], meta: {} } as never }))
      .toMatchObject({ DSH_SUPERAGENT_GITHUB_NUMBER: '', DSH_SUPERAGENT_GITHUB_PR_HEAD: '' })
    expect(githubKind.environment!.values({ deployment, config: configOf(), trigger: { source: 'github', threads: [{ source: 'github', id: '12' }], meta: { number: 12, isPr: false } } as never }))
      .toMatchObject({ DSH_SUPERAGENT_GITHUB_NUMBER: '12', DSH_SUPERAGENT_GITHUB_PR_HEAD: '' })
  })

  it('facts / find / policy schema 声明', () => {
    expect(githubKind.facts!(deployment as never)).toEqual({ cli: { zh: '当前账号 @Agent', en: 'Current account @Agent' } })
    expect(githubKind.facts!(undefined)).toEqual({})
    expect(githubKind.find!('#12')).toEqual({ threads: ['github:12'], terms: [] })
    expect(githubKind.find!('https://github.com/acme/widgets/pull/9')).toEqual({ threads: ['github:9'], terms: [] })
    expect(githubKind.find!('nothing here')).toEqual({ threads: [], terms: [] })
    expect(githubKind.policy!.schema.parse({ allowed: [{ id: 'carol' }] })).toEqual({ allowed: [{ id: 'carol' }] })
    expect(() => githubKind.policy!.schema.parse({ allowed: [{ id: 'bad name!' }] })).toThrow()
    expect(githubKind.policy!.schema.parse({ allowed: [], bots: [{ id: 'dependabot[bot]' }] })).toEqual({ allowed: [], bots: [{ id: 'dependabot[bot]' }] })
  })

  it('threadContext 暴露 GitHub 上下文读取器，channel 暴露发送与链接', () => {
    expect(githubKind.threadContext).toBeDefined()
    expect(githubKind.channel!.send).toBeTypeOf('function')
    expect(githubKind.channel!.link!({ number: '12' }, {})).toEqual({ url: '', label: { zh: 'GitHub #12', en: 'GitHub #12' } })
    expect(githubKind.fields.map(field => field.key)).toContain('observeCi')
    expect(githubKind.health).toEqual(['github'])
  })
})
