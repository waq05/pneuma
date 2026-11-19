/**
 * compact 插件装配面的补盲（`packages/compact/index.ts`）：九个可调值的夹取与保存、
 * `/compact` 运行守卫、`run()` 的 noop / 成功 / 失败三分支、`forceCompact()` 的
 * microcompact 短路与真压缩、`check()` 的补压循环，以及 registerCarry 的拼接与退订。
 *
 * `compact.spec.ts` 已覆盖缺省值、字段清单、命令用法与阈值公式；这一份补保存/失败路径。
 * 摘要模型用假 `llm.stream`，历史与 `replaceWithSummary` 都由假会话提供，不联网。
 *
 * @module dsc/packages/compact/tests/wiring-extra.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import type { CompactService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeEach, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-compact-wiring-'))
process.env['DSC_HOME'] = HOME
const PLUGINS_FILE = join(HOME, 'plugins.json')
const PROJECT = mkdtempSync(join(tmpdir(), 'dsc-compact-wiring-cwd-'))

type CompactModule = typeof import('../index.js')
let compactPlugin: CompactModule['compactPlugin']

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(PROJECT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const { compactPlugin: loadedPlugin } = await import('../index.js')
compactPlugin = loadedPlugin

interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  messages: ChatMessage[]
  summary?: string
  state: () => undefined
  appendState: () => void
  appendNote: () => void
  replaceWithSummary: (summary: string, kept: ChatMessage[]) => void
}

interface Emission {
  event: string
  args: unknown[]
}

interface Harness {
  service: CompactService
  section: SettingsSectionSpec
  session: FakeSession
  emissions: Emission[]
  handlers: Map<string, Array<(...args: unknown[]) => void>>
  streamCalls: Array<{ messages: ChatMessage[] }>
  summaryText: { value: string }
  streamError: { value: Error | undefined }
  setWindow: (window: number, reserve: number) => void
  micro: { value: { projectedTokens: () => number } | undefined }
}

function historyOf(count: number, charsPerMessage = 1_600): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let index = 0; index < count; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${index}:${'x'.repeat(charsPerMessage)}`,
    })
  }
  return messages
}

function mount(passed?: Record<string, unknown>): Harness {
  const session: FakeSession = {
    meta: { id: 'compact-wiring', cwd: PROJECT },
    filePath: join(PROJECT, '.dsc', 'sessions', 'compact.jsonl'),
    messages: [],
    state: () => undefined,
    appendState: () => undefined,
    appendNote: () => undefined,
    replaceWithSummary(summary, kept) {
      this.summary = summary
      this.messages = kept
    },
  }
  const emissions: Emission[] = []
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const streamCalls: Array<{ messages: ChatMessage[] }> = []
  const summaryText = { value: '摘要正文' }
  const streamError: { value: Error | undefined } = { value: undefined }
  const micro: Harness['micro'] = { value: undefined }
  let scenario = { window: 128_000, reserve: 8_192 }
  let service: CompactService | undefined
  let section: SettingsSectionSpec | undefined

  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      return typeof result === 'function' ? result : () => undefined
    },
    llm: {
      async stream(_api: string, request: { messages: ChatMessage[] }) {
        streamCalls.push({ messages: request.messages })
        if (streamError.value !== undefined) throw streamError.value
        return { text: summaryText.value }
      },
      contextWindowOf: () => scenario.window,
      routeForSession: () => ({
        api: 'openai',
        baseUrl: '',
        apiKey: '',
        model: 'probe',
        maxTokens: scenario.reserve,
        temperature: 0,
      }),
      inputModalities: [] as string[],
    },
    session: { current: () => session },
    prompt: { systemPrompt: () => '系统提示' },
    tools: { visible: () => [] },
    commands: { register: () => () => undefined },
    settings: {
      registerSection(spec: SettingsSectionSpec) {
        section = spec
        return () => undefined
      },
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => undefined
    },
    emit(event: string, ...args: unknown[]) {
      emissions.push({ event, args })
    },
    provide(_name: string, value: CompactService) {
      service = value
    },
    get(name: string) {
      return name === 'microcompact' ? micro.value : undefined
    },
  }
  compactPlugin.apply(ctx as never, passed as never)
  if (service === undefined || section === undefined) throw new Error('compact apply 没有注册服务/分区')
  return {
    service,
    section,
    session,
    emissions,
    handlers,
    streamCalls,
    summaryText,
    streamError,
    setWindow: (window, reserve) => {
      scenario = { window, reserve }
    },
    micro,
  }
}

function writePluginConfig(config: Record<string, unknown>): void {
  writeFileSync(
    PLUGINS_FILE,
    JSON.stringify({ version: 1, entries: [{ file: 'compact', config }] }),
    'utf8',
  )
}

function readPluginConfig(): Record<string, unknown> {
  const saved = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8')) as {
    entries?: Array<{ file?: string; config?: Record<string, unknown> }>
  }
  return saved.entries?.find((entry) => entry.file === 'compact')?.config ?? {}
}

const emitted = (harness: Harness, event: string): unknown[][] =>
  harness.emissions.filter((item) => item.event === event).map((item) => item.args)

test('配置夹取：磁盘上九个越界值全被夹回区间，非数字回默认', () => {
  writePluginConfig({
    keepRecent: 1,
    autoCompactPercent: 999,
    headroomTokens: 999_999,
    compactionRetries: 9,
    retainPercent: 1,
    anchorBudgetChars: 1,
    userQuoteBudgetChars: 1,
    readStateFiles: 999,
    readStateChars: 999_999,
  })
  const harness = mount()
  expect(harness.section.values()).toEqual({
    keepRecent: 5,
    autoCompactPercent: 95,
    headroomTokens: 131_072,
    compactionRetries: 3,
    retainPercent: 5,
    anchorBudgetChars: 1_000,
    userQuoteBudgetChars: 1_000,
    readStateFiles: 20,
    readStateChars: 10_000,
  })

  writePluginConfig({
    keepRecent: 'abc',
    autoCompactPercent: 'abc',
    headroomTokens: 'abc',
    compactionRetries: 'abc',
    retainPercent: 'abc',
    anchorBudgetChars: 'abc',
    userQuoteBudgetChars: 'abc',
    readStateFiles: 'abc',
    readStateChars: 'abc',
  })
  expect(harness.section.values()).toMatchObject({
    keepRecent: 20,
    autoCompactPercent: 80,
    headroomTokens: 0,
    compactionRetries: 1,
    retainPercent: 16,
    readStateFiles: 5,
  })
})

test('设置保存：九个键都落盘，非数字/未知键给失败文案', () => {
  const harness = mount()
  const save = harness.section.save as (key: string, value: unknown) => string | void
  expect(save('keepRecent', 'abc')).toBe('这里要填一个数字')
  expect(String(save('nope', 1))).toContain('这个分区没有这项：nope')

  const cases: Array<[string, number, number]> = [
    ['keepRecent', 1, 5],
    ['autoCompactPercent', 100, 95],
    ['headroomTokens', 999_999, 131_072],
    ['compactionRetries', 9, 3],
    ['retainPercent', 1, 5],
    ['anchorBudgetChars', 1, 1_000],
    ['userQuoteBudgetChars', 1, 1_000],
    ['readStateFiles', 99, 20],
    ['readStateChars', 1, 200],
  ]
  for (const [key, written, clamped] of cases) {
    expect(save(key, written)).toBeUndefined()
    expect(readPluginConfig()[key]).toBe(written)
    expect(harness.section.values()).toMatchObject({ [key]: clamped })
  }
})

test('/compact 运行时：历史太短给「无需压缩」，不调用摘要模型', async () => {
  const harness = mount()
  harness.session.messages = historyOf(3, 20)
  await harness.service.run()
  expect(harness.streamCalls).toHaveLength(0)
  expect(emitted(harness, 'dsc/notice').map((args) => args[0])).toContain('历史不长，无需压缩')
  expect(emitted(harness, 'dsc/compacted')).toHaveLength(0)
  expect(emitted(harness, 'dsc/changed')).toHaveLength(1)
})

test('run：真压缩成功后落摘要、带任务清单、发 compacted 与 context-used', async () => {
  writePluginConfig({ keepRecent: 5 })
  const harness = mount()
  harness.setWindow(2_000, 0)
  harness.session.messages = historyOf(30)
  harness.service.registerCarry(() => '任务清单原样保留')
  harness.service.registerCarry(() => '')
  await harness.service.run()
  expect(harness.streamCalls).toHaveLength(1)
  expect(harness.session.summary).toContain('摘要正文')
  expect(harness.session.summary).toContain('任务清单原样保留')
  const notices = emitted(harness, 'dsc/notice')
  expect(notices[0]?.[0]).toBe('上下文已压缩（任务清单与目标原样保留）')
  expect(notices[0]?.[1]).toBe('compaction')
  expect(emitted(harness, 'dsc/compacted')).toHaveLength(1)
  expect(emitted(harness, 'dsc/context-used')).toHaveLength(1)
})

test('run：摘要模型抛错与返回空串都折成「压缩失败」提示', async () => {
  writePluginConfig({ keepRecent: 5 })
  const harness = mount()
  harness.setWindow(2_000, 0)
  harness.session.messages = historyOf(30)
  harness.streamError.value = new Error('端点 500')
  await harness.service.run()
  expect(String(emitted(harness, 'dsc/notice')[0]?.[0])).toContain('压缩失败：端点 500')

  const empty = mount()
  empty.setWindow(2_000, 0)
  empty.session.messages = historyOf(30)
  empty.summaryText.value = '   '
  await empty.service.run()
  expect(String(emitted(empty, 'dsc/notice')[0]?.[0])).toContain('压缩失败：摘要模型返回为空')
})

test('run：回合运行中拒绝手动压缩；回合结束后放行', async () => {
  const harness = mount()
  for (const handler of harness.handlers.get('dsc/turn-start') ?? []) handler({ sessionId: 'compact-wiring' })
  await harness.service.run()
  expect(String(emitted(harness, 'dsc/notice')[0]?.[0])).toContain('回合还在跑')
  expect(harness.streamCalls).toHaveLength(0)

  for (const handler of harness.handlers.get('dsc/turn-end') ?? []) handler('done', { sessionId: 'compact-wiring' })
  harness.session.messages = historyOf(3, 20)
  await harness.service.run()
  expect(emitted(harness, 'dsc/notice').map((args) => args[0])).toContain('历史不长，无需压缩')
})

test('forceCompact：microcompact 已在窗口内就短路；否则真压成功返回 true', async () => {
  writePluginConfig({ keepRecent: 5 })
  const harness = mount()
  harness.setWindow(2_000, 0)
  harness.session.messages = historyOf(30)
  harness.micro.value = { projectedTokens: () => 1 }
  expect(await harness.service.forceCompact(undefined)).toBe(false)
  expect(harness.streamCalls).toHaveLength(0)
  expect(String(emitted(harness, 'dsc/notice')[0]?.[0])).toContain('清理后已在窗口内')

  harness.micro.value = undefined
  expect(await harness.service.forceCompact(undefined)).toBe(true)
  expect(harness.streamCalls).toHaveLength(1)
  const notices = emitted(harness, 'dsc/notice').map((args) => args[0])
  expect(notices).toContain('上下文超出模型窗口：已自动压缩历史并重试')
  expect(emitted(harness, 'dsc/compacted')).toHaveLength(1)
})

test('forceCompact：microcompact 预估仍超窗口时继续压；压不动返回 false', async () => {
  const harness = mount()
  harness.session.messages = historyOf(3, 20)
  harness.micro.value = { projectedTokens: () => 999_999 }
  harness.setWindow(128_000, 8_192)
  expect(await harness.service.forceCompact(undefined)).toBe(false)
  // 历史太短 → compactSession noop，不调模型。
  expect(harness.streamCalls).toHaveLength(0)
})

test('check：补压循环走满，仍在阈值上时报告压缩次数', async () => {
  const { estimateTokens } = await import('@pneuma/session-core/compact.js')
  writePluginConfig({ keepRecent: 5, autoCompactPercent: 50, headroomTokens: 1, compactionRetries: 1 })
  const harness = mount()
  harness.setWindow(2_000, 0)
  harness.session.messages = historyOf(10, 4_000)
  const used = estimateTokens(harness.session.messages)
  expect(used).toBeGreaterThan(1_024)
  await harness.service.check(undefined, harness.session as never)
  expect(harness.streamCalls.length).toBe(2)
  const notices = emitted(harness, 'dsc/notice').map((args) => args[0])
  expect(String(notices.at(-1))).toMatch(/已连续压缩 2 次/)
  expect(emitted(harness, 'dsc/compacted')).toHaveLength(1)
  expect(emitted(harness, 'dsc/context-used')).toHaveLength(1)
})

test('registerCarry 退订后不再参与拼接；空串被丢掉', async () => {
  writePluginConfig({ keepRecent: 5 })
  const harness = mount()
  harness.setWindow(2_000, 0)
  const keep = harness.service.registerCarry(() => '保留我')
  const drop = harness.service.registerCarry(() => '已退订')
  drop()
  harness.session.messages = historyOf(30)
  await harness.service.run()
  expect(harness.session.summary).toContain('保留我')
  expect(harness.session.summary).not.toContain('已退订')
  keep()
})
