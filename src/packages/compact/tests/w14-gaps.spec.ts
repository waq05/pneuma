/**
 * compact 装配面长尾补盲（w14）：`describe()` 口径、摘要请求带的工具目录、
 * 同一会话多个回合结束时的计数递减、`check()` 压一次就回到阈值内的成功分支。
 *
 * 复用 `wiring-extra.spec.ts` 的假 ctx：会话是假的、摘要模型是假的、`DSC_HOME`
 * 指向临时目录（`plugins.json` 每次现写），不联网、不碰真实 `~/.dsc`。
 *
 * @module dsc/packages/compact/tests/w14-gaps.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import type { CompactService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeEach, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-compact-w14-'))
process.env['DSC_HOME'] = HOME
const PLUGINS_FILE = join(HOME, 'plugins.json')
const PROJECT = mkdtempSync(join(tmpdir(), 'dsc-compact-w14-cwd-'))

let compactPlugin: (typeof import('../index.js'))['compactPlugin']

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(PROJECT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(async () => {
  compactPlugin = (await import('../index.js')).compactPlugin
})

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

interface ToolRow {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk: string
  run: () => Promise<string>
}

interface Harness {
  service: CompactService
  session: FakeSession
  emissions: Emission[]
  handlers: Map<string, Array<(...args: unknown[]) => void>>
  streamCalls: Array<{ messages: ChatMessage[]; tools?: ReadonlyArray<Record<string, unknown>> }>
  tools: ToolRow[]
  setWindow: (window: number, reserve: number) => void
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

function mount(): Harness {
  const session: FakeSession = {
    meta: { id: 'compact-w14', cwd: PROJECT },
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
  const streamCalls: Harness['streamCalls'] = []
  const tools: ToolRow[] = []
  let scenario = { window: 128_000, reserve: 8_192 }
  let service: CompactService | undefined

  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      return typeof result === 'function' ? result : () => undefined
    },
    llm: {
      async stream(_api: string, request: { messages: ChatMessage[]; tools?: ReadonlyArray<Record<string, unknown>> }) {
        streamCalls.push({ messages: request.messages, ...(request.tools === undefined ? {} : { tools: request.tools }) })
        return { text: '摘要正文' }
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
    tools: { visible: () => tools },
    commands: { register: () => () => undefined },
    settings: {
      registerSection(spec: SettingsSectionSpec) {
        void spec
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
    provide(name: string, value: unknown) {
      if (name === 'compact') service = value as CompactService
    },
    get() {
      return undefined
    },
  }
  compactPlugin.apply(ctx as never, undefined as never)
  if (service === undefined) throw new Error('compact apply 没有注册服务')
  return {
    service,
    session,
    emissions,
    handlers,
    streamCalls,
    tools,
    setWindow: (window, reserve) => {
      scenario = { window, reserve }
    },
  }
}

function writePluginConfig(config: Record<string, unknown>): void {
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [{ file: 'compact', config }] }), 'utf8')
}

const emitted = (harness: Harness, event: string): unknown[][] =>
  harness.emissions.filter((item) => item.event === event).map((item) => item.args)

test('describe() 报当前自动压缩比例与保留条数', () => {
  writePluginConfig({ autoCompactPercent: 66, keepRecent: 7 })
  expect(mount().service.describe()).toEqual({ autoCompactPercent: 66, keepRecent: 7 })
})

test('摘要请求带主对话那份工具目录：只留 name/description/parameters', async () => {
  const harness = mount()
  harness.setWindow(2_000, 0)
  harness.session.messages = historyOf(30)
  harness.tools.push({
    name: 'read',
    description: '读文件',
    parameters: { type: 'object' },
    risk: 'read',
    run: async () => 'ok',
  })
  await harness.service.run()
  expect(harness.streamCalls).toHaveLength(1)
  expect(harness.streamCalls[0]?.tools).toEqual([{ name: 'read', description: '读文件', parameters: { type: 'object' } }])
  // 投影用的工具目录同样带过去：模型看到的系统提示 + 工具定义与主对话一致。
  expect(emitted(harness, 'dsc/context-used')).toHaveLength(1)
})

test('同一会话重叠两个回合：turn-end 只减一，/compact 仍然拒绝', async () => {
  const harness = mount()
  for (const handler of harness.handlers.get('dsc/turn-start') ?? []) handler({ sessionId: 'compact-w14' })
  for (const handler of harness.handlers.get('dsc/turn-start') ?? []) handler({ sessionId: 'compact-w14' })
  for (const handler of harness.handlers.get('dsc/turn-end') ?? []) handler('done', { sessionId: 'compact-w14' })
  await harness.service.run()
  expect(String(emitted(harness, 'dsc/notice')[0]?.[0])).toContain('回合还在跑')
  expect(harness.streamCalls).toHaveLength(0)
})

test('check：压一次就回到阈值内，通知带 compaction 类别', async () => {
  writePluginConfig({ keepRecent: 2 })
  const harness = mount()
  harness.setWindow(6_000, 0)
  harness.session.messages = historyOf(30)
  await harness.service.check(undefined, harness.session as never)
  expect(harness.streamCalls.length).toBeGreaterThan(0)
  const notices = emitted(harness, 'dsc/notice')
  const compactedNotice = notices.find((args) => args[1] === 'compaction')
  expect(compactedNotice?.[0]).toBe('上下文接近模型上限，已自动压缩历史')
  expect(compactedNotice?.[2]).toBe(harness.session.filePath)
  expect(emitted(harness, 'dsc/compacted')).toHaveLength(1)
})
