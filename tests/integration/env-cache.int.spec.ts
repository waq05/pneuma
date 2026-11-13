/**
 * 上下文新鲜度与缓存自检（integration 层，原 `scripts/env-cache-test.mjs`）。
 *
 * 三件事各自的证据：
 *   (a) env-facts 投影：**缺省每轮都发**（`envRefreshMs` 缺省 0）——「平台：Windows
 *       （bash 工具跑的是 PowerShell）」只有这一个载体，跳过一轮就等于那一轮模型没有
 *       平台事实。闸门本身（设一个非 0 毫秒数 = 「变了才发」，照 dsh time-context 的
 *       刷新下限）单独用显式 `envRefreshMs=600000` 测：首次必发、文本变了必发、没变
 *       又没到下限就不发。落盘状态条目（noteEnvFacts 的 hash 去重）行为不变。
 *   (b) 显式前缀缓存：能力位缺省 false——当前唯一的 DeepSeek 系路由**请求体逐字节不变**；
 *       只有端点声明 `cacheControl: true` 时才打 `cache_control` 断点（头部 system + 末尾各一）。
 *   (c) 指令预算口径是**字符**不是字节：恰好 20000 字符不截断、20001 截断；20000 个
 *       中文字符（60000 字节）也不截断——若口径是字节它必被砍。
 *
 * ## 与探针的差别（都在断言更硬的地方）
 *
 * - 探针自己手写 SSE 端点；这里用 `tests/harness.ts` 的 `fakeLLM`，请求体经它的
 *   `onRequest` 拿完整解析结果（探针靠的是自己拼的 `raw`）。「请求体里没有
 *   cache_control」「顶层字段顺序」都直接读这份真实请求体，不是源码文本。
 * - 探针等 `agent.isRunning` 的写法是 `until(() => !ctx.agent.isRunning)`——那是个函数
 *   对象，永远为真值，实际每轮白等 10 秒。这里用 `bootKernel.runTurn`，它等
 *   `dsc/turn-end` + 空闲 + 落盘。
 * - `plugins.json` 显式关掉 session-title / memory / self-improve / sandbox：前两个会在
 *   回合里多发模型请求，把「一轮两步」的请求序号搅乱；sandbox 在 Windows 上启动会
 *   spawn PowerShell 体检，可能把 worker 挂住（harness 的同一个注意事项）。
 *
 * ## 没有搬的断言（恒真，防不住回归）
 *
 * 探针的「能力位为 false / undefined / 不传：三种情形逐字节相同」比较的是同一个
 * `serializeMessages` 表达式，永远成立；迁移时换成「未声明能力的请求体里没有
 * cache_control」，由两步真实请求体与纯函数两处覆盖。
 *
 * @module dsc/tests/integration/env-cache.int.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { applyExplicitCache, serializeMessages } from '@pneuma/runtime/core/llm.js'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { buildSystemPrompt, DEFAULT_INSTRUCTION_BUDGET } from '@pneuma/runtime/packages/session-core/prompt.js'
import { bootKernel, fakeLLM, readSessionJsonl, type BootedKernel, type FakeLLM } from '../harness.js'

/**
 * 基础插件清单：关掉会在回合里多发请求 / 起子进程的四条。
 *
 * 只在文件不存在时写会失效，所以这里显式整份写；`envRefreshMs` 的投影级用例会在这份
 * 基础上追加 `prompt` 条目（插件每次用值都现读 `plugins.json`）。
 */
const BASE_ENTRIES = [
  { file: 'session-title', disabled: true },
  { file: 'memory', disabled: true },
  { file: 'self-improve', disabled: true },
  { file: 'sandbox', disabled: true },
]

/** 写一份插件清单；`extra` 追加在基础条目之后。 */
function writePlugins(extra: Array<Record<string, unknown>> = []): void {
  mkdirSync(DSC_HOME, { recursive: true })
  writeFileSync(
    join(DSC_HOME, 'plugins.json'),
    JSON.stringify({ version: 1, entries: [...BASE_ENTRIES, ...extra] }, null, 2),
    'utf8',
  )
}

/** 一条被假端点收到的请求：完整解析后的请求体（探针里的 `raw` 用 `JSON.stringify` 等价读出）。 */
interface CapturedRequest {
  body: Record<string, unknown>
}

/** 内核里本文件用到的服务面。 */
interface KernelSurface {
  session: { current(): { meta: { id: string; cwd: string }; filePath: string } }
  tools: { register(tool: Record<string, unknown>): void }
  prompt: { rewrite(messages: ChatMessage[], session: unknown): ChatMessage[] }
  llm: {
    routeTo(provider: string, model: string, effort: string): {
      api: string
      baseUrl: string
      apiKey: string
      model: string
      cacheControl?: boolean
    }
    stream(
      api: string,
      request: Record<string, unknown>,
      handlers: { onDelta(): void },
    ): Promise<unknown>
  }
}

/** 模型配置：与探针同一形状（不需要真模型，端点全指向假服务）。 */
const MODEL = {
  id: 'm',
  name: 'm',
  contextWindow: 100000,
  maxTokens: 500,
  modalities: ['text'],
  thinkingLevels: [],
  thinkingParam: 'none',
  effortMap: {},
}

let llm: FakeLLM
let kernel: BootedKernel
let surface: KernelSurface
/** 假端点收到的每个请求（标题请求被 fakeLLM 单独应答，不记在这里）。 */
let captured: CapturedRequest[]

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 快照判定：正文里带「环境事实」的那条 user 消息。 */
function isEnvSnapshot(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false
  const { role, content } = message as { role?: unknown; content?: unknown }
  return role === 'user' && typeof content === 'string' && content.includes('环境事实')
}

/** 一棵树里有几处 cache_control（深扫，用来钉「几处断点」）。 */
function countCacheControl(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, item) => sum + countCacheControl(item), 0)
  if (node !== null && typeof node === 'object') {
    let sum = 0
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'cache_control') sum += 1
      else sum += countCacheControl(value)
    }
    return sum
  }
  return 0
}

/** 请求体里的 messages 数组。 */
function messagesOf(request: CapturedRequest | undefined): unknown[] {
  const messages = request?.body.messages
  return Array.isArray(messages) ? messages : []
}

beforeAll(async () => {
  writePlugins()
  captured = []
  llm = await fakeLLM({
    // 第 1 步：一次工具调用；第 2 步：收尾正文。turn 按请求序号走，标题请求不计。
    turns: [{ toolCall: { name: 'noop', args: {} } }, '收到'],
    onRequest(body) {
      captured.push({ body: body as Record<string, unknown> })
    },
  })
  kernel = await bootKernel({
    providerBaseUrl: llm.baseUrl,
    config: {
      providers: {
        // 默认路由：不声明显式缓存（当前唯一的 DeepSeek 形状）
        test: { name: 'test', displayName: 'Test', baseUrl: llm.baseUrl, apiKey: 'k', models: [MODEL] },
        // 声明支持显式缓存的端点（Anthropic 形状），用来验证「只有声明了才打点」
        cached: {
          name: 'cached',
          displayName: 'Cached',
          baseUrl: llm.baseUrl,
          apiKey: 'k',
          cacheControl: true,
          models: [MODEL],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm',
    },
  })
  surface = kernel.ctx as unknown as KernelSurface
  // 探针空工具：让第一步真的产生 tool 消息，第二步请求才带 tool 角色。
  surface.tools.register({
    name: 'noop',
    description: '探针空工具',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => 'ok',
  })
  await kernel.runTurn('开跑')
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  Date.now = realNow
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** 真回合的第一步 / 第二步请求（按有没有 tool 角色分）。 */
const step1 = (): CapturedRequest | undefined =>
  captured.find((request) => !messagesOf(request).some((message) => (message as { role?: unknown }).role === 'tool'))
const step2 = (): CapturedRequest | undefined =>
  captured.find((request) => messagesOf(request).some((message) => (message as { role?: unknown }).role === 'tool'))

/** 真实时钟：假时钟只在「刷新下限」那一段用，用完立刻还原。 */
const realNow = Date.now.bind(Date)
let skew = 0

/** 在偏移后的时钟里跑一段同步逻辑。 */
function withClock<T>(offsetMs: number, fn: () => T): T {
  skew = offsetMs
  try {
    return fn()
  } finally {
    skew = 0
  }
}

describe('① 真回合（一步工具调用 + 一步收尾）里 env 快照缺省每轮都发', () => {
  test('真回合共抓到两步请求', () => {
    expect(step1()).toBeDefined()
    expect(step2()).toBeDefined()
  })

  test('第一步请求带当前环境快照（首次必发）', () => {
    expect(messagesOf(step1()).filter(isEnvSnapshot)).toHaveLength(1)
  })

  test('默认配置下第二步请求仍带一条环境快照（缺省 = 每轮都发）', () => {
    // 「变没变才发」闸门缺省是关的：平台事实只有快照一个载体，跳过一轮就是没有平台事实。
    expect(messagesOf(step2()).filter(isEnvSnapshot)).toHaveLength(1)
  })

  test('env-facts 落盘状态条目只有一条（hash 去重行为不变）', () => {
    const records = readSessionJsonl(surface.session.current().filePath).filter(
      (record) => record.type === 'state' && record.id === 'env-facts',
    )
    expect(records).toHaveLength(1)
  })

  test('落盘的快照文本 = 第一步发给模型的那条（Model-visible ⟺ logged）', () => {
    const record = readSessionJsonl(surface.session.current().filePath).find(
      (item) => item.type === 'state' && item.id === 'env-facts',
    )
    const payload = (record?.payload ?? {}) as { text?: unknown }
    const sent = messagesOf(step1()).find(isEnvSnapshot) as { content?: unknown } | undefined
    expect(payload.text).toBe(sent?.content)
  })
})

describe('② DeepSeek 系路由（未声明能力）：请求体逐字节不变', () => {
  test('两步请求体都没有 cache_control', () => {
    const raw = JSON.stringify([step1()?.body, step2()?.body])
    expect(raw.includes('cache_control')).toBe(false)
  })

  test('顶层字段名与顺序未变（model,messages,stream,stream_options,tools,max_tokens）', () => {
    // 顶层顺序是「逐字节不变」的一部分：网关按字节算前缀缓存，字段挪位等于换了一份请求。
    expect(Object.keys(step1()?.body ?? {})).toEqual([
      'model',
      'messages',
      'stream',
      'stream_options',
      'tools',
      'max_tokens',
    ])
  })

  test('线上 message 逐条只含协议字段（ts 已剥掉）', () => {
    const allowed = ['role', 'content', 'reasoning_content', 'tool_calls', 'tool_call_id']
    for (const message of messagesOf(step1())) {
      expect(Object.keys(message as Record<string, unknown>).every((key) => allowed.includes(key))).toBe(true)
    }
  })
})

describe('② serializeMessages / applyExplicitCache 的纯行为', () => {
  /** 带内部字段（ts）与空 reasoning_content 的会话消息：序列化时该剥的剥、该留的留。 */
  const driftMessages = [
    { role: 'system', content: 'SYS', ts: 111 },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'think',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
      ts: 222,
    },
    { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    { role: 'user', content: [{ type: 'text', text: 'look' }] },
    { role: 'assistant', content: 'done', reasoning_content: '', ts: 333 },
  ] as unknown as ChatMessage[]
  const serialized = serializeMessages(driftMessages)
  const golden = JSON.stringify(serialized)

  test('serializeMessages 输出不含 cache_control、不含 ts', () => {
    expect(golden.includes('cache_control')).toBe(false)
    expect(golden.includes('"ts"')).toBe(false)
  })

  test('assistant 的字段挑选未变（tool_calls 留、空 reasoning_content 丢）', () => {
    expect(golden.includes('"tool_calls"')).toBe(true)
    expect(golden.match(/reasoning_content/g)).toHaveLength(1)
  })

  test('能力位只由路由声明决定：未声明的请求体里没有 cache_control', () => {
    // 探针这里写的是「false / undefined / 不传三种情形逐字节相同」，但三种都走同一个
    // `serializeMessages`，比较的是同一个表达式——恒真，防不住任何回归。真正有信息量的
    // 是「没声明能力的路由请求体里没有断点」：由上面两步真实请求体覆盖；这里只钉
    // 纯函数不会凭空加断点。
    expect(golden.includes('cache_control')).toBe(false)
  })

  test('端点声明支持时：恰好两处 ephemeral 断点（头部 system + 对话末尾）', () => {
    const marked = applyExplicitCache(serialized) as Array<{ content?: Array<{ cache_control?: { type?: string } }> }>
    expect(countCacheControl(marked)).toBe(2)
    expect(marked[0]?.content?.[0]?.cache_control?.type).toBe('ephemeral')
    expect(marked[5]?.content?.[0]?.cache_control?.type).toBe('ephemeral')
  })

  test('不打点的消息与打点前逐条逐字节相同', () => {
    const marked = applyExplicitCache(serialized)
    expect(marked.slice(1, 5).map((message) => JSON.stringify(message))).toEqual(serialized.slice(1, 5).map((message) => JSON.stringify(message)))
  })

  test('空数组安全（原样返回）', () => {
    expect(applyExplicitCache([])).toHaveLength(0)
  })
})

describe('② 路由能力位与真请求上的断点', () => {
  test('默认端点不带、声明端点带', () => {
    expect(surface.llm.routeTo('test', 'm', 'default').cacheControl).toBeUndefined()
    expect(surface.llm.routeTo('cached', 'm', 'default').cacheControl).toBe(true)
  })

  test('带能力位的真请求线上有 2 处断点，且落点正确', async () => {
    const route = surface.llm.routeTo('cached', 'm', 'default')
    await surface.llm.stream(
      route.api,
      {
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        model: route.model,
        messages: [
          { role: 'system', content: 'SYS-DIRECT' },
          { role: 'user', content: 'hi' },
        ],
        cacheControl: true,
      },
      { onDelta() {} },
    )
    const direct = captured.find((request) => JSON.stringify(request.body).includes('SYS-DIRECT'))
    expect(direct).toBeDefined()
    expect(countCacheControl(direct?.body)).toBe(2)
    const messages = messagesOf(direct) as Array<{ content?: Array<{ cache_control?: { type?: string } }> }>
    expect(messages[0]?.content?.[0]?.cache_control?.type).toBe('ephemeral')
    expect(messages[1]?.content?.[0]?.cache_control?.type).toBe('ephemeral')
  })
})

describe('① 投影级：显式 envRefreshMs=600000 打开的闸门', () => {
  /** 假会话：投影只读 meta.cwd / meta.id，落状态只调 appendState。 */
  interface FakeSession {
    meta: { id: string; cwd: string }
    state(): unknown
    appendState(): void
  }

  let envStateCalls = 0
  const fakeSession = (id: string, cwd: string): FakeSession => ({
    meta: { id, cwd },
    state: () => undefined,
    appendState: () => {
      envStateCalls += 1
    },
  })
  const seed: ChatMessage[] = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '你好' },
  ]
  const rewrite = (messages: ChatMessage[], session: FakeSession): ChatMessage[] =>
    surface.prompt.rewrite(messages, session)

  const dirA = makeTemp('dsc-env-cache-wa-')
  const dirB = makeTemp('dsc-env-cache-wb-')
  const sessionA = fakeSession('probe-a', dirA)
  const sessionB = fakeSession('probe-b', dirB)

  beforeAll(() => {
    // 显式打开闸门：缺省 0 = 每轮都发，这里单独测「变了才发」的机制。
    writePlugins([{ file: 'prompt', config: { envRefreshMs: 600_000 } }])
    // 假时钟：只推「刷新下限」这一条，用完还原（afterAll 里统一还原）。
    Date.now = () => realNow() + skew
  })

  test('新会话第一次：尾部追加一条环境快照，正文含本会话的 cwd', () => {
    const firstA = rewrite(seed, sessionA)
    expect(firstA.filter(isEnvSnapshot)).toHaveLength(1)
    const last = firstA[firstA.length - 1] as { role?: string; content?: unknown }
    expect(String(last.content)).toContain(dirA)
    expect(last.role).toBe('user')
  })

  test('同一会话再来一次（文本没变、未到下限）：不追加', () => {
    expect(rewrite(seed, sessionA).filter(isEnvSnapshot)).toHaveLength(0)
  })

  test('另一个会话（不同 cwd）：各自首次必发，快照含自己的 cwd', () => {
    const firstB = rewrite(seed, sessionB)
    expect(firstB.filter(isEnvSnapshot)).toHaveLength(1)
    expect(String((firstB[firstB.length - 1] as { content?: unknown }).content)).toContain(dirB)
  })

  test('文本变了必发（换目录后同一会话再发一条）', () => {
    sessionA.meta.cwd = dirB
    expect(rewrite(seed, sessionA).filter(isEnvSnapshot)).toHaveLength(1)
  })

  test('没到刷新下限（+100 秒）：文本没变就不发', () => {
    const within = withClock(100_000, () => rewrite(seed, sessionA))
    expect(within.filter(isEnvSnapshot)).toHaveLength(0)
  })

  test('到了刷新下限（+700 秒）：文本没变也重注一条', () => {
    const after = withClock(700_000, () => rewrite(seed, sessionA))
    expect(after.filter(isEnvSnapshot)).toHaveLength(1)
  })

  test('落盘状态条目每次发出都调用（去重交给 noteEnvFacts）', () => {
    // 这一层不判断「要不要写盘」：写不写由 noteEnvFacts 的 hash 判；这里只保证
    // 闸门放行的每一次都交到它手里，否则重放会话会缺最后一份环境。
    expect(envStateCalls).toBeGreaterThanOrEqual(4)
  })
})

describe('① 缺省（不配 envRefreshMs）= 0 = 每轮都发', () => {
  test('文本没变的第二轮仍带环境快照', () => {
    writePlugins()
    const session = { meta: { id: 'probe-default', cwd: tempDirs[0] ?? tmpdir() }, state: () => undefined, appendState: () => {} }
    const seed: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '你好' },
    ]
    const first = surface.prompt.rewrite(seed, session)
    const second = surface.prompt.rewrite(seed, session)
    expect(first.filter(isEnvSnapshot)).toHaveLength(1)
    expect(second.filter(isEnvSnapshot)).toHaveLength(1)
  })
})

describe('③ 指令预算口径：以字符计', () => {
  test('缺省值仍是 20000（字符），未因改口径砍半', () => {
    expect(DEFAULT_INSTRUCTION_BUDGET).toBe(20_000)
  })

  test('恰好 20000 字符不截断，20001 字符截断', () => {
    const exact = makeTemp('dsc-env-cache-budget-exact-')
    const over = makeTemp('dsc-env-cache-budget-over-')
    writeFileSync(join(exact, 'AGENTS.md'), 'a'.repeat(20_000), 'utf8')
    writeFileSync(join(over, 'AGENTS.md'), 'a'.repeat(20_001), 'utf8')
    expect(buildSystemPrompt(exact, { instructionBudget: 20_000, skills: '' })).not.toContain('过长，中间省略')
    expect(buildSystemPrompt(over, { instructionBudget: 20_000, skills: '' })).toContain('过长，中间省略')
  })

  test('20000 个中文字符（60000 字节）不截断——口径是字符不是字节', () => {
    const cjk = makeTemp('dsc-env-cache-budget-cjk-')
    const body = '中'.repeat(20_000)
    writeFileSync(join(cjk, 'AGENTS.md'), body, 'utf8')
    expect(Buffer.byteLength(body, 'utf8')).toBe(60_000)
    // 若按字节算，60000 字节必然超 20000 预算，这一条会红。
    expect(buildSystemPrompt(cjk, { instructionBudget: 20_000, skills: '' })).not.toContain('过长，中间省略')
  })
})
