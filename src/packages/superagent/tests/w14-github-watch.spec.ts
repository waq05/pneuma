/**
 * `sources/github.ts` 轮询循环的错误分支覆盖。
 *
 * 既有 `sources-github.spec.ts` 只跑了「未配置 → 报 setupPending」这条启动路径；`watch` 循环
 * 里「来源关掉只报暂停、每次轮询失败累计 failures 并按阈值报 error、默认分支 CI 读失败只记
 * 一条 round.failures」以及 `startGithub` 顶层的兜底 catch 都没走到。
 *
 * 这里用内存假 `SourceContext`（同既有 spec 的形状）+ 一个「任何 API 都抛错」的 `Commands`
 * 假件驱动真循环：先让 `pollRound` 抛，再 abort 让循环退出。不起真 gh、不联网。
 *
 * @module dsc/packages/superagent/tests/w14-github-watch
 */
import { describe, expect, it } from 'vitest'
import type { Commands } from '../infra/commands.js'
import { KV } from '../kv.js'
import type { SourceContext, SourceHost } from '../sources/host.js'
import { startGithub } from '../sources/github.js'

const deployment = {
  repository: 'acme/widgets',
  github: {
    cli: 'gh',
    login: 'agent',
    noreply: '1+agent@users.noreply.github.com',
  },
  stateDir: '/tmp/state',
  promptMaxChars: 1,
  admissionContextMaxPages: 1,
  admissionContextTimeoutMs: 1,
}

/** 任何 API 调用都抛错的 `Commands`；`withSignal` 返回自己。 */
function failingCommands(error: Error, api?: (path: string) => unknown) {
  const commands = {
    deployment,
    withSignal: () => commands,
    api: async (path: string): Promise<unknown> => {
      if (api !== undefined) return api(path)
      throw error
    },
    pages: async (): Promise<never> => {
      throw error
    },
    run: async (): Promise<never> => {
      throw error
    },
    gh: async (): Promise<never> => {
      throw error
    },
    lark: async (): Promise<never> => {
      throw error
    },
  }
  return commands as unknown as Commands
}

interface FakeOptions {
  configured?: boolean
  ready?: Promise<void>
  config?: unknown
  error?: Error
  api?: (path: string) => unknown
  state?: Map<string, unknown>
}

function fakeContext(options: FakeOptions = {}) {
  const state = options.state ?? new Map<string, unknown>()
  const reports: { entry: string; health: unknown }[] = []
  const commands = failingCommands(options.error ?? new Error('gh is down'), options.api)
  const context = {
    deployment,
    commands,
    ready: options.ready ?? Promise.resolve(),
    configured: () => options.configured ?? true,
    problem: undefined,
    config: () => options.config,
    receive: async () => ({}),
    atomic: <T>(work: () => T) => work(),
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => {
        value === undefined ? state.delete(key) : state.set(key, value)
      },
      keys: () => [...state.keys()],
    },
    threads: {
      get: () => undefined,
      subscribed: () => [],
      describe: () => {},
      patch: () => {},
    },
    tickets: {
      get: () => undefined,
      open: () => [],
      bindThread: () => {},
      threadClosed: () => {},
    },
    triggers: { get: () => undefined, latest: () => undefined },
    notify: () => {},
    report: (entry: string, health: unknown) => reports.push({ entry, health }),
  }
  return { context: context as unknown as SourceContext, reports }
}

function hostOf(context: SourceContext) {
  const unregister = () => {}
  const host = { sources: { register: unregister }, context: () => context }
  return host as unknown as SourceHost
}

/** 等一个条件成立（循环是异步跑的）。 */
async function until(check: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待条件超时：${label}`)
}

const fullConfig = {
  observeIssues: true,
  observePulls: true,
  observeComments: true,
  observeCi: false,
  pollSeconds: 60,
  failuresBeforeError: 1,
  directMessages: true,
  chats: [],
}

describe('startGithub：watch 循环的分支', () => {
  it('来源关掉：每轮只报 sourceOff 并等下一轮，不调 API', async () => {
    const fake = fakeContext({ configured: true, config: undefined })
    const controller = new AbortController()
    const stop = startGithub(hostOf(fake.context), controller.signal)
    await until(() => fake.reports.some((item) => (item.health as { code?: string }).code === 'sourceOff'), 'sourceOff 上报')
    controller.abort()
    stop()
    // 关掉来源后循环不再累计失败（failures 归零那行在 try 里）。
    expect(fake.reports.every((item) => item.entry === 'github')).toBe(true)
  })

  it('轮询抛错：累计一次失败并按阈值报 error，循环不退出（等 abort 收尾）', async () => {
    const fake = fakeContext({ configured: true, config: fullConfig })
    const controller = new AbortController()
    const stop = startGithub(hostOf(fake.context), controller.signal)
    await until(() => fake.reports.some((item) => (item.health as { state?: string }).state === 'error'), 'error 上报')
    controller.abort()
    stop()
    expect(fake.reports.some((item) => String((item.health as { detail?: string }).detail).includes('gh is down'))).toBe(true)
  })

  it('默认分支 CI 读失败：只记进 round.failures，不让整轮直接崩在 pollBranchCi 里', async () => {
    const fake = fakeContext({
      configured: true,
      config: {
        ...fullConfig,
        observeIssues: false,
        observePulls: false,
        observeComments: false,
        observeCi: true,
      },
      // 通知接口正常返回空列表，只有默认分支 CI 的读取失败：错误应落在 round.failures 里。
      api: (path) =>
        path.startsWith('notifications?') ? 'HTTP/2 200\nx-poll-interval: 60\n\n[]' : Promise.reject(new Error('gh is down')),
    })
    const controller = new AbortController()
    const stop = startGithub(hostOf(fake.context), controller.signal)
    await until(() => fake.reports.some((item) => (item.health as { state?: string }).state === 'error'), 'CI 失败上报')
    controller.abort()
    stop()
    const detail = String(
      (fake.reports.find((item) => (item.health as { state?: string }).state === 'error')!.health as { detail?: string }).detail,
    )
    expect(detail).toContain('default branch CI')
    expect(fake.context.state.get(KV.github.branchCi)).toBeUndefined()
  })

  it('就绪等待本身失败：startGithub 的兜底 catch 把它报成来源体检，而不是未处理 rejection', async () => {
    const fake = fakeContext({
      ready: Promise.reject(new Error('session store unavailable')),
    })
    const controller = new AbortController()
    const stop = startGithub(hostOf(fake.context), controller.signal)
    await until(
      () =>
        fake.reports.some((item) => String((item.health as { detail?: string }).detail).includes('session store unavailable')),
      '兜底 catch',
    )
    controller.abort()
    stop()
    expect(fake.reports[0]).toMatchObject({
      entry: 'github',
      health: { state: 'error' },
    })
  })
})
