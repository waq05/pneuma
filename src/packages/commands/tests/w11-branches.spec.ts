/**
 * commands 派发与内置 handler 的分支补测（w11）：派发闸的四个收口、外部命令注册/注销、
 * /usage 与 /diff 的失败回执、/export 的默认文件名、/copy 的空与非空、/update 的失败，
 * 以及 /review 范围卡的四条分支与自由文本、跳过、未知答案。
 *
 * 全部走假 ctx + 真 `apply`；cwd 指到非 git 的临时目录，collectReviewScope 快速失败。
 *
 * @module @pneuma/commands/tests/w11-branches
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { CommandService } from '@pneuma/runtime/services/types.js'

const home = mkdtempSync(join(tmpdir(), 'dsc-commands-w11-'))
const cwd = mkdtempSync(join(tmpdir(), 'dsc-commands-w11-cwd-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const { commandsPlugin, runCommand, statusReport, usageReport } = await import('../index.js')

afterAll(() => {
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // Windows 句柄：留给系统清
  }
  try {
    rmSync(cwd, { recursive: true, force: true })
  } catch {
    // 同上
  }
})

interface Snapshot {
  status: { turnState: string; sessionPath?: string }
  entries: Array<{ kind: string; text: string }>
  surfaces: { policy: unknown }
}

interface Harness {
  runtime: Record<string, unknown>
  notices: string[]
  state: Snapshot
  session: { messages: Array<{ role: string; content: string }>; meta: { cwd: string; id: string; createdAt: number } }
  service: CommandService
  setAsk: (ask: unknown) => void
  setDock: (dock: (name: string, args: unknown) => Promise<unknown>) => void
}

function snapshot(): Snapshot {
  return {
    status: { turnState: 'idle' },
    entries: [],
    surfaces: {
      policy: {
        current: 'readonly',
        options: [],
        reviewer: 'user',
        reviewerOptions: [],
      },
    },
  }
}

function mount(): Harness {
  const notices: string[] = []
  const state = snapshot()
  const services = new Map<string, unknown>()
  const session = {
    messages: [] as Array<{ role: string; content: string }>,
    meta: { cwd, id: 'abcdef12-3456-7890', createdAt: Date.UTC(2026, 10, 16) },
  }
  const runtime: Record<string, unknown> = {
    getSnapshot: () => state,
    submit: () => undefined,
    setModel: async () => undefined,
    openSession: () => undefined,
    openPicker: () => undefined,
    openModels: () => undefined,
    openSettings: () => undefined,
    openAgents: () => undefined,
    exit: () => undefined,
    usageStats: async () => ({
      sinceTs: null,
      totalTurns: 0,
      activeDays: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheHitTokens: 0,
      totalCacheMissTokens: 0,
      peakDay: null,
      currentStreakDays: 0,
      longestStreakDays: 0,
      days: [],
      models: [],
    }),
    dock: async () => ({ diff: '' }),
  }
  const ctx = {
    session: { current: () => session },
    llm: { provider: 'fake', model: 'fake/model', contextWindow: 100 },
    get: (name: string) => services.get(name),
    provide: (name: string, value: unknown) => {
      services.set(name, value)
    },
    emit: () => undefined,
  }
  const apply = commandsPlugin.apply as unknown as (context: unknown, passed?: unknown) => (() => void) | void
  apply(ctx)
  return {
    runtime,
    notices,
    state,
    session,
    service: services.get('commands') as CommandService,
    setAsk: (ask: unknown) => services.set('ask', ask),
    setDock: (dock: (name: string, args: unknown) => Promise<unknown>) => {
      runtime.dock = dock
    },
  }
}

const ui = (notices: string[]): never => ({ notice: (text: string) => notices.push(text) }) as never

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitNotice(notices: string[], needle: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = notices.find((text) => text.includes(needle))
    if (found !== undefined) return found
    await sleep(10)
  }
  throw new Error(`没等到含「${needle}」的通知：${notices.join(' | ')}`)
}

// ── 派发闸 ───────────────────────────────────────────────────────────────────

test('派发：非斜杠返回 false，裸斜杠给帮助，未知命令与 duringTask 各有一句', () => {
  const harness = mount()
  expect(runCommand('hello', harness.runtime as never, ui(harness.notices))).toBe(false)

  expect(runCommand('/', harness.runtime as never, ui(harness.notices))).toBe(true)
  expect(harness.notices.at(-1)).toContain('/')

  runCommand('/definitely-unknown', harness.runtime as never, ui(harness.notices))
  expect(harness.notices.at(-1)).toContain('未知命令')

  harness.state.status.turnState = 'running'
  runCommand('/new', harness.runtime as never, ui(harness.notices))
  expect(harness.notices.at(-1)).toContain('要等当前回合结束')
})

test('外部命令注册后能用，注销后回到未知命令', () => {
  const harness = mount()
  let hits = 0
  const off = harness.service.register(
    { name: 'w11-ext', args: '', description: '外部命令' },
    () => {
      hits += 1
    },
  )
  runCommand('/w11-ext', harness.runtime as never, ui(harness.notices))
  expect(hits).toBe(1)
  expect(harness.service.specs().some((spec) => spec.name === 'w11-ext')).toBe(true)

  off()
  runCommand('/w11-ext', harness.runtime as never, ui(harness.notices))
  expect(hits).toBe(1)
  expect(harness.notices.at(-1)).toContain('未知命令')
  expect(harness.service.specs().some((spec) => spec.name === 'w11-ext')).toBe(false)
})

// ── 异步回执 ─────────────────────────────────────────────────────────────────

test('/usage 与 /diff 的失败都只写一条通知', async () => {
  const harness = mount()
  harness.runtime.usageStats = async () => {
    throw new Error('usage boom')
  }
  harness.setDock(async () => {
    throw new Error('dock boom')
  })
  runCommand('/usage', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '/usage 失败')
  expect(harness.notices.join('\n')).toContain('usage boom')

  runCommand('/diff', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '/diff 失败')
  expect(harness.notices.join('\n')).toContain('dock boom')
})

test('/export 不传路径时按工作目录与会话号生成默认文件名', async () => {
  const harness = mount()
  harness.session.messages.push({ role: 'user', content: '你好' })
  runCommand('/export', harness.runtime as never, ui(harness.notices))
  const notice = await waitNotice(harness.notices, '已导出')
  expect(notice).toContain('pneuma-export-')
  expect(readdirSync(cwd).some((name) => name.startsWith('pneuma-export-'))).toBe(true)
})

test('/export 空会话直说没东西可导', () => {
  const harness = mount()
  runCommand('/export', harness.runtime as never, ui(harness.notices))
  expect(harness.notices.at(-1)).toContain('还没有消息')
})

test('/copy：没有可复制回复与有回复两种情况', () => {
  const harness = mount()
  runCommand('/copy', harness.runtime as never, ui(harness.notices))
  expect(harness.notices.at(-1)).toContain('还没有可复制的回复')

  harness.state.entries = [{ kind: 'tool', text: 'ignore' }, { kind: 'text', text: '最终回复' }]
  runCommand('/copy', harness.runtime as never, ui(harness.notices))
  expect(harness.notices.at(-1)).toContain('已复制上一条回复')
})

test('/update：检查失败时把原因原样写进通知', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('no network')
  }))
  const harness = mount()
  runCommand('/update', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '检查失败')
  expect(harness.notices.join('\n')).toContain('no network')
})

// ── /review 范围卡 ───────────────────────────────────────────────────────────

function asks(answers: string[]): { ask: (question: unknown) => Promise<string> } {
  return {
    ask: async () => answers.shift() ?? '',
  }
}

test('/review：跳过、未提交、自定义、基准分支、某次提交、自由文本六条分支都收口', async () => {
  const harness = mount()

  harness.setAsk(asks(['（用户跳过了这一题）']))
  runCommand('/review', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '审查已取消')

  harness.setAsk(asks(['审查未提交的更改']))
  runCommand('/review', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '不是 git 仓库')

  harness.setAsk(asks(['自定义审查要求', '只看安全']))
  runCommand('/review', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '不是 git 仓库')

  harness.setAsk(asks(['自定义审查要求', '']))
  runCommand('/review', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '审查已取消')

  harness.setAsk(asks(['对比基准分支', 'main']))
  runCommand('/review', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '不是 git 仓库')

  harness.setAsk(asks(['审查某次提交', 'abc1234']))
  runCommand('/review', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '不是 git 仓库')

  harness.setAsk(asks(['直接写一句要求']))
  runCommand('/review', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '不是 git 仓库')
})

test('/review 带参数不弹卡；没有提问通道时按未提交改动审', async () => {
  const harness = mount()
  runCommand('/review 只看并发', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '不是 git 仓库')

  // setAsk 没设 = ctx.get('ask') 为 undefined：走「没有提问卡通道」分支。
  runCommand('/review', harness.runtime as never, ui(harness.notices))
  await waitNotice(harness.notices, '没有提问卡通道')
  await waitNotice(harness.notices, '不是 git 仓库')
})

test('/review-status 与 /review-cancel 在没有 review 服务时各说一句', () => {
  const harness = mount()
  runCommand('/review-status', harness.runtime as never, ui(harness.notices))
  expect(typeof harness.notices.at(-1)).toBe('string')
  runCommand('/review-cancel', harness.runtime as never, ui(harness.notices))
  expect(harness.notices.at(-1)).toContain('没有在跑的审查')
})

// ── 纯函数 ───────────────────────────────────────────────────────────────────

test('usageReport：没有记录、带峰值与 Top 5 模型', () => {
  expect(usageReport({
    sinceTs: null,
    totalTurns: 0,
    activeDays: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    peakDay: null,
    currentStreakDays: 0,
    longestStreakDays: 0,
    days: [],
    models: [],
  })).toContain('还没有用量记录')

  const rows = Array.from({ length: 6 }, (_item, index) => ({
    key: `m${String(index)}`,
    inputTokens: 1_500,
    outputTokens: 500,
    turns: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  }))
  const text = usageReport({
    sinceTs: Date.UTC(2026, 10, 1),
    totalTurns: 10,
    activeDays: 3,
    totalInputTokens: 2_000_000,
    totalOutputTokens: 500,
    totalCacheHitTokens: 50,
    totalCacheMissTokens: 50,
    peakDay: { date: '2026-11-02', inputTokens: 1000, outputTokens: 200, turns: 1, byModel: {} },
    currentStreakDays: 2,
    longestStreakDays: 4,
    days: [],
    models: rows,
  })
  expect(text).toContain('2.0M')
  expect(text).toContain('峰值')
  expect(text).toContain('Top 5')
  expect(text).toContain('m4')
  expect(text).not.toContain('m5')
})

test('statusReport：窗口为 0 时占用按 0 算，不出现 NaN', () => {
  const text = statusReport({
    provider: 'fake',
    model: 'fake/model',
    window: 0,
    tokens: 0,
    messageCount: 0,
    toolCount: 0,
    autoCompactPercent: 80,
  })
  expect(text).not.toContain('NaN')
})
