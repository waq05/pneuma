/**
 * 压缩口径对齐（迁自 `scripts/compact-token-tail-test.mjs`）：按 token 留尾巴、摘要压不小就
 * 放弃、压完复量再压、阈值口径（窗口 − 输出预留 − 安全余量）、爆窗先看微压缩投影。
 *
 * ## 为什么这些事单开一份
 *
 * 五条都是「换一套口径」的改动，纯函数与接线两半都得验：
 *   - `selectCut` 是纯函数，但它的意义只在「一条工具结果就几十万字符」的会话里显出来，
 *     普通小消息的历史用条数口径和 token 口径结果一样，测不出区别；
 *   - 复量再压与阈值口径都在 `check()` 里，只有真内核（真配置、真模型路由、真事件）才验得到；
 *     摘要放弃与微压缩短路同理（一个要假会话，一个要真服务）。
 *
 * ## 一个内核跑完三套模型
 *
 * 三段（小窗口复量 / 128k 阈值 / 60k token 尾巴）要不同的模型窗口与压缩配置。父代理的
 * 要求是「一个文件一次 bootKernel」，所以这里只起一次内核：模型用 `llm.setModel` 切
 * （每段开一条新会话，旧会话的历史不串味），压缩配置用 `settings.save('compact', ...)` 改
 * ——插件的 `save` 会即时 `applyConfig`，与设置页点一下等价。
 *
 * @module dsc/packages/session-core/compact-token-tail.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-compact-token-')

/** 第一次压缩的配置先铺在插件清单里（三段都会用 settings.save 再改）。 */
mkdirSync(join(home.home, '.dsc'), { recursive: true })
writeFileSync(
  join(home.home, '.dsc', 'plugins.json'),
  `${JSON.stringify(
    {
      version: 1,
      entries: [
        { file: 'memory', config: { enabled: false } },
        { file: 'sandbox', disabled: true },
        { file: 'session-title', disabled: true },
        { file: 'compact', config: { keepRecent: 5, autoCompactPercent: 50, compactionRetries: 1 } },
      ],
    },
    null,
    2,
  )}\n`,
  'utf8',
)

type CompactModule = typeof import('./compact.js')

let compact: CompactModule
let llm: FakeLLM
let kernel: BootedKernel

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface SessionView {
  messages: Array<Record<string, unknown>>
  appendUser(text: string): void
  appendAssistant(text: string, reasoning: string, calls: Array<{ id: string; name: string; arguments: string }>): void
  appendTool(id: string, name: string, content: string): void
}

interface Services {
  session: { current(): SessionView; open(filePath?: string, cwd?: string): Promise<void> }
  llm: { setModel(provider: string, model: string): void; contextWindowOf(session: unknown): number }
  settings: { save(section: string, key: string, value: unknown): Promise<void> }
  compact: { check(signal?: AbortSignal): Promise<void>; forceCompact(signal?: AbortSignal): Promise<boolean> }
  get(name: string): { projectedTokens(messages: readonly unknown[]): number } | undefined
  on(event: string, listener: (...args: unknown[]) => void): () => void
}

/** 工作区：新会话开在这里（目录必须真实存在）。 */
const workspace = join(home.home, 'ws')

beforeAll(async () => {
  compact = await import('./compact.js')
  mkdirSync(workspace, { recursive: true })
  // 所有压缩请求都拿这一段短摘要：它比被折历史短，摘要得以成立。
  llm = await fakeLLM({ turns: ['【假摘要】这段历史已压缩', '收到'] })
  kernel = await bootKernel({
    providerBaseUrl: llm.baseUrl,
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl: llm.baseUrl,
          apiKey: 'k',
          models: [
            { id: 'm-small', name: 'm-small', contextWindow: 4_000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} },
            { id: 'm-big', name: 'm-big', contextWindow: 131_072, maxTokens: 8_192, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} },
            { id: 'm-tail', name: 'm-tail', contextWindow: 60_000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} },
          ],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm-small',
    },
  })
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

/** 切到指定模型并开一条新会话（旧会话的历史不串味）。 */
async function newSessionWith(model: string): Promise<SessionView> {
  const services = kernel.ctx as unknown as Services
  await services.session.open(undefined, workspace)
  services.llm.setModel('test', model)
  return services.session.current()
}

/** 压缩口径的上限（与探针同一份）。 */
const caps = { keepRecent: 20, anchorChars: 1000, userQuoteChars: 1000, readStateFiles: 0, readStateChars: 200 }
/** 一条巨型工具结果：约 66k tokens，一条就能把尾巴预算吃满。 */
const GIANT = 'G'.repeat(200_000)
/** 一条约 1320 token 的正文（给「按 token 留尾巴」用）。 */
const BIG = 'x'.repeat(4_000)

describe('① token 预算选尾 vs 固定条数', () => {
  /**
   * 一条巨型工具结果 + 26 条小消息的历史。
   *
   * 前 4 条：user / assistant / assistant(调用 bash) / tool(巨型结果)；后面 26 条一问一答。
   */
  function mixedHistory(): Array<Record<string, unknown>> {
    const mixed: Array<Record<string, unknown>> = [
      { role: 'user', content: '开始' },
      { role: 'assistant', content: '好' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: GIANT },
    ]
    for (let index = 0; index < 26; index += 1) {
      mixed.push(
        index % 2 === 0 ? { role: 'user', content: `补充 ${String(index)}` } : { role: 'assistant', content: `收到 ${String(index)}` },
      )
    }
    return mixed
  }

  test('纯条数口径切在倒数第 20 条（索引 10）', () => {
    const mixed = mixedHistory()
    const byCount = compact.safeCut(mixed as never, mixed.length - caps.keepRecent)
    expect(byCount).toBe(10)
  })

  test('token 口径把巨型工具结果一起留下（索引 2）', () => {
    // 一条工具结果就吃掉大半尾巴预算：按条数切会把它折掉，等于「压了但没省多少」。
    const mixed = mixedHistory()
    const byTokens = compact.selectCut(mixed as never, { ...caps, retainTokens: 60_000 })
    expect(byTokens).toBe(2)
    expect(mixed.slice(byTokens).some((message) => message['content'] === GIANT)).toBe(true)
    expect(mixed.slice(10).some((message) => message['content'] === GIANT)).toBe(false)
  })

  test('预算比整段小很多时，条数下限仍然生效', () => {
    const mixed = mixedHistory()
    expect(compact.selectCut(mixed as never, { ...caps, retainTokens: 1 })).toBe(10)
  })
})

describe('② 切点落在 tool 消息上时退到配对边界', () => {
  /** 同 ① 的历史（巨型结果那条也在）。 */
  function mixedHistory(): Array<Record<string, unknown>> {
    const mixed: Array<Record<string, unknown>> = [
      { role: 'user', content: '开始' },
      { role: 'assistant', content: '好' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: GIANT },
    ]
    for (let index = 0; index < 26; index += 1) {
      mixed.push(
        index % 2 === 0 ? { role: 'user', content: `补充 ${String(index)}` } : { role: 'assistant', content: `收到 ${String(index)}` },
      )
    }
    return mixed
  }

  test('切点退到索引 2（assistant），尾部不以孤儿 tool 消息开头', () => {
    // 孤儿 tool 消息（有结果没调用）会被协议适配器拒绝或误读，是最典型的「压完请求发不出去」。
    const mixed = mixedHistory()
    const cut = compact.selectCut(mixed as never, { ...caps, retainTokens: 1_000 })
    expect(cut).toBe(2)
    expect(mixed[cut]?.['role']).not.toBe('tool')
  })

  test('尾部第一条的 tool_call 与紧跟的结果配对', () => {
    const mixed = mixedHistory()
    const cut = compact.selectCut(mixed as never, { ...caps, retainTokens: 1_000 })
    const call = (mixed[cut] as { tool_calls?: Array<{ id: string }> }).tool_calls?.[0]
    expect((mixed[cut + 1] as { tool_call_id?: string }).tool_call_id).toBe(call?.id)
  })

  test('整段都是工具结果时切点是 0（调用方按无法压缩处理）', () => {
    const allTools = [
      { role: 'tool', tool_call_id: 'a', content: '结果 A' },
      { role: 'tool', tool_call_id: 'b', content: '结果 B' },
      { role: 'tool', tool_call_id: 'c', content: '结果 C' },
    ]
    expect(compact.selectCut(allTools as never, { ...caps, keepRecent: 2 })).toBe(0)
  })
})

describe('③ 摘要不小于原文时抛错，且会话历史一条没动', () => {
  /** 一段 7 条的短历史（压完只剩 2 条尾巴）。 */
  function tinyHistory(): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = []
    for (const [index, text] of ['a', 'b', 'c', 'd', 'e', 'f', 'g'].entries()) {
      messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: text })
    }
    return messages
  }

  test('抛的错说明「压缩没有意义」，且没有写摘要、历史一条没动', async () => {
    const messages = tinyHistory()
    const snapshot = JSON.stringify(messages)
    let replaced = false
    const session = {
      messages,
      meta: { id: 'unit-tiny' },
      filePath: 'D:\\tmp\\unit-tiny.jsonl',
      summary: '',
      replaceWithSummary(text: string, kept: unknown[]) {
        replaced = true
        this.summary = text
        this.messages = kept
      },
    }
    const route = { api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k', model: 'm' }
    // 摘要模型回一段比整段历史长几百倍的正文：摘要估算必然 >= 被折内容的估算。
    const stream = async () => ({ text: 'z'.repeat(60_000) })
    let thrown: unknown
    try {
      await compact.compactSession(
        session as unknown as Parameters<CompactModule['compactSession']>[0],
        route as unknown as Parameters<CompactModule['compactSession']>[1],
        stream as unknown as Parameters<CompactModule['compactSession']>[2],
        new AbortController().signal,
        undefined,
        { keepRecent: 2, anchorChars: 1000, userQuoteChars: 1000, readStateFiles: 0, readStateChars: 200 },
        undefined,
        { imageBudget: 4, toolResultChars: 2000 },
        { system: 'SYS', tools: [] },
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof Error).toBe(true)
    expect(String((thrown as Error).message)).toContain('压缩没有意义')
    expect(replaced).toBe(false)
    expect(JSON.stringify(messages)).toBe(snapshot)
  })
})

describe('④ 小窗口：压完复量、还超就再压、到上限停', () => {
  /** 压缩请求次数（按「最后一条 user 含『交接摘要』」认）。 */
  let compactRequests = 0
  /** 这一段的通知正文。 */
  const notices: string[] = []
  let session: SessionView

  test('压前确实超过阈值 2000（窗口 4000、输出预留 500、余量 256）', async () => {
    const services = kernel.ctx as unknown as Services
    services.on('dsc/notice', (...args) => {
      notices.push(String(args[0]))
    })
    session = await newSessionWith('m-small')
    session.appendUser('开工')
    session.appendAssistant('收到', '', [])
    for (let index = 0; index < 3; index += 1) {
      session.appendUser(`第${String(index)}批 ${BIG}`)
      session.appendAssistant(`第${String(index)}批收到 ${BIG}`, '', [])
    }
    const calls = Array.from({ length: 6 }, (_, index) => ({ id: `t${String(index + 1)}`, name: 'bash', arguments: '{}' }))
    session.appendAssistant('', '', calls)
    for (let index = 0; index < 6; index += 1) session.appendTool(`t${String(index + 1)}`, 'bash', `输出 ${BIG}`)
    const before = compact.estimateTokens(session.messages as never)
    expect(before).toBeGreaterThan(2_000)
  })

  test('第一次压完仍超阈值 → 再压一次（共 2 次摘要调用）', async () => {
    const services = kernel.ctx as unknown as Services
    // 先数一发「这一趟之前有过几次压缩请求」：假端点只记请求体，压缩请求靠最后一条正文认。
    const seenBefore = llm.bodies.length
    await services.compact.check()
    const compactBodies = llm.bodies.slice(seenBefore).filter((body) => {
      const messages = body as Array<{ content?: unknown }>
      return String(messages.at(-1)?.content ?? '').includes('交接摘要')
    })
    compactRequests = compactBodies.length
    expect(compactRequests).toBe(2)
  })

  test('提示带次数与复量结果，压完仍超阈值（补压确实用完了）', () => {
    expect(notices.some((text) => text.includes('已连续压缩 2 次') && text.includes('阈值 2000'))).toBe(true)
    expect(compact.estimateTokens(session.messages as never)).toBeGreaterThan(2_000)
  })
})

describe('⑤ 微压缩投影估算明显小于原始估算', () => {
  /** 30 组「调用 + 长结果」：旧工具结果占绝对多数。 */
  function toolHeavy(): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = []
    for (let index = 0; index < 30; index += 1) {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `h${String(index)}`, type: 'function', function: { name: 'bash', arguments: `{"i":${String(index)}}` } }],
      })
      messages.push({ role: 'tool', tool_call_id: `h${String(index)}`, content: `第${String(index)}个结果 ${BIG}` })
    }
    return messages
  }

  test('投影估算明显小于原始估算（省掉七成以上），且是正数', () => {
    // 这条是爆窗短路的判据来源：投影不缩小，forceCompact 就会白压一次摘要。
    const services = kernel.ctx as unknown as Services
    const micro = services.get('microcompact')
    expect(micro).toBeDefined()
    const heavy = toolHeavy()
    const raw = compact.estimateTokens(heavy as never)
    const projected = micro?.projectedTokens(heavy) ?? 0
    expect(projected).toBeLessThan(raw * 0.3)
    expect(Number.isFinite(projected)).toBe(true)
    expect(projected).toBeGreaterThan(0)
  })
})

describe('⑥ 阈值口径：128k 窗口下安全余量按窗口 6.4% 算，不是定值 65536', () => {
  const window = 131_072
  const reserve = 8_192
  const expectedThreshold = Math.max(1024, Math.min(Math.floor(window * 0.8), window - reserve - Math.floor(window * 0.064)))
  const oldThreshold = Math.max(1024, Math.min(Math.floor(window * 0.8), window - reserve - 65_536))

  test('新阈值约等于窗口的 80%（而不是 44%）', () => {
    // 旧口径拿 dsh 的定值 65536 当余量，128k 窗口下阈值只剩 57344（44%）。
    expect(expectedThreshold).toBe(Math.floor(window * 0.8))
  })

  test('历史落在新旧阈值之间：新口径不触发压缩', async () => {
    const services = kernel.ctx as unknown as Services
    await services.settings.save('compact', 'autoCompactPercent', 80)
    await services.settings.save('compact', 'compactionRetries', 0)
    const session = await newSessionWith('m-big')
    const chunk = 'x'.repeat(26_000) // 约 8580 tokens
    for (let index = 0; index < 4; index += 1) {
      session.appendUser(`第${String(index)}段 ${chunk}`)
      session.appendAssistant(`收到第${String(index)}段 ${chunk}`, '', [])
    }
    const used = compact.estimateTokens(session.messages as never)
    expect(used).toBeGreaterThan(oldThreshold)
    expect(used).toBeLessThanOrEqual(expectedThreshold)
    const seenBefore = llm.bodies.length
    await services.compact.check()
    // 没有摘要请求 = 没触发压缩。
    const compactBodies = llm.bodies.slice(seenBefore).filter((body) => {
      const messages = body as Array<{ content?: unknown }>
      return String(messages.at(-1)?.content ?? '').includes('交接摘要')
    })
    expect(compactBodies).toHaveLength(0)
  })
})

describe('⑦ 爆窗强压先看投影：清理后装得下就直接重试，不牺牲历史', () => {
  test('forceCompact 返回 false、没发摘要请求、发了「直接重试」的提示', async () => {
    const services = kernel.ctx as unknown as Services
    const notices: string[] = []
    services.on('dsc/notice', (...args) => {
      notices.push(String(args[0]))
    })
    const session = await newSessionWith('m-big')
    // 与 ⑤ 同一份「工具结果占绝对多数」的历史：旧结果会被投影换成占位符。
    for (let index = 0; index < 30; index += 1) {
      session.appendAssistant('', '', [
        { id: `h${String(index)}`, name: 'bash', arguments: `{"i":${String(index)}}` },
      ])
      session.appendTool(`h${String(index)}`, 'bash', `第${String(index)}个结果 ${BIG}`)
    }
    const micro = services.get('microcompact')
    const window = services.llm.contextWindowOf(session)
    const projected = micro?.projectedTokens(session.messages) ?? Number.POSITIVE_INFINITY
    // 前提：投影确实把它压进窗口了（否则短路分支不该走）。
    expect(projected).toBeLessThan(window)
    expect(projected).toBeLessThan(compact.estimateTokens(session.messages as never))

    const seenBefore = llm.bodies.length
    const compacted = await services.compact.forceCompact()
    expect(compacted).toBe(false)
    expect(notices.some((text) => text.includes('旧工具结果清理后已在窗口内'))).toBe(true)
    const sentSummary = llm.bodies.slice(seenBefore).some((body) => {
      const messages = body as Array<{ content?: unknown }>
      return String(messages.at(-1)?.content ?? '').includes('交接摘要')
    })
    expect(sentSummary).toBe(false)
  })
})

describe('⑧ 真内核：尾巴按窗口 16% 的 token 预算留，而不是只按条数', () => {
  test('40 条历史压完留下 8 条左右（纯条数口径只会留 5 条）', async () => {
    const services = kernel.ctx as unknown as Services
    await services.settings.save('compact', 'autoCompactPercent', 50)
    await services.settings.save('compact', 'compactionRetries', 0)
    const session = await newSessionWith('m-tail')
    for (let index = 0; index < 20; index += 1) {
      session.appendUser(`第${String(index)}问 ${BIG}`)
      session.appendAssistant(`第${String(index)}答 ${BIG}`, '', [])
    }
    const beforeTokens = compact.estimateTokens(session.messages as never)
    expect(beforeTokens).toBeGreaterThan(30_000)
    expect(session.messages).toHaveLength(40)
    const seenBefore = llm.bodies.length
    await services.compact.check()
    const compacted = llm.bodies.slice(seenBefore).some((body) => {
      const messages = body as Array<{ content?: unknown }>
      return String(messages.at(-1)?.content ?? '').includes('交接摘要')
    })
    expect(compacted).toBe(true)
    // 9600 token 预算 ÷ 每条约 1300 token ≈ 8 条，加摘要本身 = 9；纯条数口径会是 1+5=6。
    const kept = session.messages.length
    expect(kept).toBeGreaterThanOrEqual(8)
    expect(kept).toBeLessThan(16)
  })
})
