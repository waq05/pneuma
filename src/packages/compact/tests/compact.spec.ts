/**
 * compact 包级测试：插件对象、九个可调值、`/compact` 命令与触发阈值。
 *
 * 迁移说明：原文件五条断言里六条正则读 `index.ts` 源码（`keepRecent: DEFAULT_KEEP_RECENT`、
 * `autoCompactPercent: 80`、`order: 35`、`id: 'compact'`、命令名与用法文案、两条阈值公式）。
 * 前四条描述的都是 apply() 之后才存在的对象，现在从真跑出来的设置分区 / 命令注册表上取；
 * 两条阈值公式改成**行为**：用假 llm 给一个窗口与输出预留，构造恰好落在阈值两侧的历史，
 * 看 `check()` 会不会发那条「上下文接近模型上限」的提示——
 *   - 窗口 500k、预留按「正好让阈值差 20000」反推：余量若写死 65536 而不是窗口的 6.4%，
 *     同一份历史就会被误判成超阈值；
 *   - 窗口 2M 时 6.4% 是 128000，若没被 65536 封顶，同一份历史同样会被误判；
 *   - 窗口 2000、预留 1572 时公式结果是负数，下限 1024 若被删掉，一份 500 token 的短历史
 *     就会被误判成超阈值。
 *
 * 判定走 `check()` 的真路径：阈值以上会进 `compactSession`，历史条数 ≤ keepRecent+2 时它
 * 返回 noop（不调模型），于是只留下那条「已自动压缩历史」的提示——这就是观察点。
 *
 * 环境隔离：`resolvePluginConfig` 读 `DSC_HOME` 下的 `plugins.json`，先指到临时目录再 import。
 *
 * @module @pneuma/compact/tests
 */
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import {
  DEFAULT_ANCHOR_BUDGET_CHARS,
  DEFAULT_READ_STATE_BUDGET_CHARS,
  DEFAULT_READ_STATE_FILES,
  DEFAULT_USER_QUOTE_BUDGET_CHARS,
} from '@pneuma/runtime/core/compact-anchors.js'
import type { CompactService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { DEFAULT_KEEP_RECENT, estimateTokens } from '@pneuma/session-core/compact.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-compact-spec-'))
process.env.DSC_HOME = home

const { compactPlugin } = await import('../index.js')

/** 场景要喂给 `check()` 的假 llm。 */
interface Scenario {
  /** 上下文窗口（token）。 */
  window: number
  /** 输出预留（token）。 */
  reserve: number
}

/** 一次 apply 捕获到的东西。 */
interface Harness {
  service: CompactService
  section: SettingsSectionSpec
  commands: Map<string, { spec: { name: string; args: string; description: string }; handler: (input: unknown) => unknown }>
  notices: string[]
  /** 按场景跑一次 `check()`，返回这次发出来的提示。 */
  check: (messages: ChatMessage[], scenario: Scenario) => Promise<string[]>
}

/** 假 ctx：apply 用到的面都实现，`effect` 真跑回调（否则注册不会发生）。 */
function mount(): Harness {
  const harness = {
    service: undefined as unknown as CompactService,
    section: undefined as unknown as SettingsSectionSpec,
    commands: new Map<
      string,
      { spec: { name: string; args: string; description: string }; handler: (input: unknown) => unknown }
    >(),
    notices: [] as string[],
  }
  let scenario: Scenario = { window: 128_000, reserve: 8_192 }
  const session = {
    meta: { id: 'compact-spec-session', cwd: home },
    filePath: join(home, 'session.jsonl'),
    messages: [] as ChatMessage[],
    state: () => undefined,
    appendState: () => {},
    appendNote: () => {},
    replaceWithSummary: () => {},
  }
  const ctx = {
    session: { current: () => session },
    get: () => undefined,
    provide: (_name: string, value: CompactService) => {
      harness.service = value
    },
    llm: {
      // 本用例的历史条数不足 keepRecent+2，压缩一定走 noop，不会真调到这条流式调用。
      stream: async () => {
        throw new Error('本用例不该真的调模型：历史条数不足 keepRecent+2，压缩会走 noop')
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
    prompt: { systemPrompt: () => '系统提示' },
    tools: { visible: () => [] },
    commands: {
      register: (
        spec: { name: string; args: string; description: string },
        handler: (input: unknown) => unknown,
      ) => {
        harness.commands.set(spec.name, { spec, handler })
        return () => {}
      },
    },
    settings: {
      registerSection: (spec: SettingsSectionSpec) => {
        harness.section = spec
        return () => {}
      },
    },
    on: () => () => {},
    emit: (event: string, ...args: unknown[]) => {
      if (event === 'dsc/notice' && typeof args[0] === 'string') harness.notices.push(args[0])
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  compactPlugin.apply(ctx as never)
  harness.check = async (messages, next) => {
    scenario = next
    session.messages = messages
    harness.notices = []
    await harness.service.check(undefined, session as never)
    return harness.notices
  }
  return harness
}

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

/** 造一份「只有 2 条消息、token 数约等于 want」的历史。 */
function historyOf(want: number): ChatMessage[] {
  // 先量一次「1000 字符值多少 token」，再按比例把正文补到想要的量。
  const perKilo = estimateTokens([{ role: 'user', content: 'x'.repeat(1000) }])
  const chars = Math.max(1, Math.round((want / perKilo) * 1000))
  return [
    { role: 'user', content: 'x'.repeat(chars) },
    { role: 'assistant', content: '好' },
  ]
}

const harness = mount()

test('插件对象：名字、提供服务、六个注入', () => {
  expect(compactPlugin.name).toBe('compact')
  expect(compactPlugin.provide).toBe('compact')
  expect([...(compactPlugin.inject ?? [])]).toEqual(['llm', 'session', 'commands', 'settings', 'prompt', 'tools'])
  expect(typeof compactPlugin.apply).toBe('function')
})

test('九个可调值的缺省口径，分区 order=35', () => {
  expect(harness.section.order).toBe(35)
  expect({ ...harness.section.values() }).toEqual({
    keepRecent: DEFAULT_KEEP_RECENT,
    autoCompactPercent: 80,
    headroomTokens: 0,
    compactionRetries: 1,
    retainPercent: 16,
    anchorBudgetChars: DEFAULT_ANCHOR_BUDGET_CHARS,
    userQuoteBudgetChars: DEFAULT_USER_QUOTE_BUDGET_CHARS,
    readStateFiles: DEFAULT_READ_STATE_FILES,
    readStateChars: DEFAULT_READ_STATE_BUDGET_CHARS,
  })
})

test('设置分区 id=compact，字段正好这九个', () => {
  expect(harness.section.id).toBe('compact')
  expect(harness.section.fields().map((field) => ('key' in field ? field.key : undefined))).toEqual([
    'keepRecent',
    'autoCompactPercent',
    'headroomTokens',
    'compactionRetries',
    'retainPercent',
    'anchorBudgetChars',
    'userQuoteBudgetChars',
    'readStateFiles',
    'readStateChars',
  ])
})

test('/compact 不带参数；多打的字只回一句用法', async () => {
  const entry = harness.commands.get('compact')
  expect(entry?.spec.name).toBe('compact')
  expect(entry?.spec.args).toBe('')
  expect(entry?.spec.description).toBe('压缩上下文')

  // 不带参数：转给 runtime.compact()，自己不说话
  let compacted = 0
  const notices: string[] = []
  await entry?.handler({
    args: [],
    runtime: { compact: () => (compacted += 1) },
    ui: { notice: (text: string) => notices.push(text) },
  })
  expect(compacted).toBe(1)
  expect(notices).toEqual([])

  // 多打了字：直说用法，不动历史
  await entry?.handler({
    args: ['多余'],
    runtime: { compact: () => (compacted += 1) },
    ui: { notice: (text: string) => notices.push(text) },
  })
  expect(compacted).toBe(1)
  expect(notices).toEqual(['用法：/compact（不带参数）'])
})

test('触发阈值：安全余量按窗口 6.4% 算，预留与余量都从窗口里扣', async () => {
  const messages = historyOf(150_000)
  const used = estimateTokens(messages)
  expect(used).toBeGreaterThan(100_000)

  // 窗口 500k → 余量 32000；预留反推成「阈值 = used + 20000」。
  const window = 500_000
  const headroom = Math.floor(window * 0.064)
  const reserve = window - headroom - used - 20_000
  expect(reserve).toBeGreaterThan(0)
  expect(await harness.check(messages, { window, reserve })).toEqual([])

  // 同一份历史，预留再多 50000：阈值低到 used 之下，必须真触发。
  const stricter = await harness.check(messages, { window, reserve: reserve + 50_000 })
  expect(stricter).toContain('上下文接近模型上限，已自动压缩历史')
})

test('触发阈值：余量按 6.4% 算但封顶 65536', async () => {
  // 窗口 2M 的 6.4% 是 128000，超过封顶线：正确实现只用 65536。
  const messages = historyOf(50_000)
  const used = estimateTokens(messages)
  const window = 2_000_000
  const reserve = window - 65_536 - used - 20_000
  expect(reserve).toBeGreaterThan(0)
  // 没封顶时阈值会低 62544，同一份历史就会被误判成超阈值。
  expect(await harness.check(messages, { window, reserve })).toEqual([])
})

test('触发阈值：下限 1024，窗口再小也不会被历史压到 0 以下', async () => {
  const messages = historyOf(500)
  const used = estimateTokens(messages)
  expect(used).toBeGreaterThan(28)
  expect(used).toBeLessThan(1024)
  // 窗口 2000 - 预留 1572 - 余量 128 = 300，再减去 used 之前就已是负数区间；
  // 正确实现取 max(1024, ...) = 1024，所以 500 token 的短历史不触发。
  expect(await harness.check(messages, { window: 2_000, reserve: 1_572 })).toEqual([])
})
