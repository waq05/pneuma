/**
 * 压缩后 read-state 回插（迁自 `scripts/compact-readstate-test.mjs`）。
 *
 * ## 为什么要做这件事
 *
 * 对标 ZCode 的 post-compact read-state：压缩掉一段历史后，接手的模型看不出「这些文件我刚
 * 读到哪」，只能重读一遍。这里从被折区间机械抽出「压前最后读过哪些文件、读到哪一段」，
 * 作为一条紧凑的 read-state 段并进摘要。它只带路径与行范围、不带文件内容，且文案自带
 * 「可能已过时，需要时重读」（read-state 是提示，不是真相）。
 *
 * ## 断言三层
 *
 *   ① 纯函数 `buildReadState`：路径 + 行范围、同文件只留最后一次、超上限只留最近 N、
 *      超预算截断带省略标记、没读过给空串、非 read 调用 / 坏参数不算、幂等、maxFiles=0 关闭；
 *   ② 摘要拼接顺序：锚点索引 → **read-state** → 细节找回；
 *   ③ 真内核 + 假端点端到端：压一段带 read 的历史，断言压缩后 `messages[0]` 含 read-state、
 *      含最后读过的路径与行范围、不含被折原文。
 *
 * @module dsc/core/compact-readstate.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from './llm.js'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-readstate-')

/**
 * 插件配置：关掉长期记忆（它在回合收尾会投一次复盘、多发请求），压缩保留条数压到 5，
 * 这样一小段历史就能触发压缩。harness 只在文件不存在时铺默认清单，所以这里先写先得。
 */
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
        { file: 'compact', config: { keepRecent: 5 } },
      ],
    },
    null,
    2,
  )}\n`,
  'utf8',
)

type AnchorsModule = typeof import('./compact-anchors.js')
type CompactModule = typeof import('../packages/session-core/compact.js')

let anchors: AnchorsModule
let compact: CompactModule

beforeAll(async () => {
  // 动态 import：`compact.ts` 会连带加载内核模块，而 `DSC_HOME` 是模块级常量。
  anchors = await import('./compact-anchors.js')
  compact = await import('../packages/session-core/compact.js')
})

/** 造一条带 read 调用的 assistant 消息。 */
function readAssistant(id: string, path: string, offset?: number, limit?: number): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id,
        type: 'function',
        function: {
          name: 'read',
          arguments: JSON.stringify({
            path,
            ...(offset === undefined ? {} : { offset }),
            ...(limit === undefined ? {} : { limit }),
          }),
        },
      },
    ],
  }
}

/** 造一条带任意工具调用的 assistant 消息（用来验非 read 调用不算）。 */
function anyAssistant(id: string, name: string, args: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  }
}

describe('① buildReadState 纯函数', () => {
  test('单次 read：产出含路径、行范围与「可能已过时」标题', () => {
    const one = anchors.buildReadState([readAssistant('c1', 'D:\\proj\\src\\a.ts', 1, 100)], 1500)
    expect(one.includes('D:\\proj\\src\\a.ts')).toBe(true)
    expect(one.includes('第 1–100 行')).toBe(true)
    expect(one.includes('## 读过的文件（可能已过时，需要时重读）')).toBe(true)
  })

  test('同文件多次读只出现一次，且取最后一次的行范围', () => {
    // 读同一文件两段时，模型关心的是「最后停在哪」，不是把每段都列一遍。
    const twice = anchors.buildReadState(
      [readAssistant('c1', 'D:\\a\\x.ts', 1, 50), readAssistant('c2', 'D:\\a\\x.ts', 100, 25)],
      1500,
    )
    expect(twice.split('D:\\a\\x.ts')).toHaveLength(2)
    expect(twice.includes('第 100–124 行')).toBe(true)
    expect(twice.includes('第 1–50 行')).toBe(false)
  })

  test('默认上限是 5 / 超上限只留最近 5 个 / 丢的是最老的', () => {
    expect(anchors.DEFAULT_READ_STATE_FILES).toBe(5)
    const six = Array.from({ length: 6 }, (_, index) => readAssistant(`c${String(index)}`, `D:\\p\\f${String(index + 1)}.ts`, 1, 10))
    const capped = anchors.buildReadState(six, 4000, 5)
    expect(capped.split('\n- ')).toHaveLength(6)
    expect(capped.includes('f1.ts')).toBe(false)
    expect(capped.includes('f6.ts')).toBe(true)
  })

  test('最近的在最前（f6 在 f5 之前）', () => {
    const six = Array.from({ length: 6 }, (_, index) => readAssistant(`c${String(index)}`, `D:\\p\\f${String(index + 1)}.ts`, 1, 10))
    const capped = anchors.buildReadState(six, 4000, 5)
    expect(capped.indexOf('f6.ts')).toBeLessThan(capped.indexOf('f5.ts'))
  })

  test('超预算：带省略标记，且结果不超过预算', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      readAssistant(`c${String(index)}`, `D:\\verylongpath\\dir${String(index)}\\file${String(index)}.ts`, 1, 10),
    )
    const clipped = anchors.buildReadState(many, 500, 20)
    expect(clipped.includes('……（后文省略）')).toBe(true)
    expect(clipped.length).toBeLessThanOrEqual(500)
  })

  test('没读过任何文件 / 空输入 → 空串', () => {
    expect(anchors.buildReadState([{ role: 'user', content: '你好' }], 1500)).toBe('')
    expect(anchors.buildReadState([], 1500)).toBe('')
  })

  test('非 read 工具调用不算', () => {
    // bash 的 args 里也可能出现 path；只认工具名，别把写盘/执行当成「读过」。
    expect(anchors.buildReadState([anyAssistant('c1', 'bash', '{"path":"D:\\\\a\\\\b.ts"}')], 1500)).toBe('')
  })

  test('参数坏 JSON / 没有 path → 跳过（不抛）', () => {
    expect(anchors.buildReadState([anyAssistant('c1', 'read', '{不是合法 JSON')], 1500)).toBe('')
    expect(anchors.buildReadState([anyAssistant('c1', 'read', '{"offset":3}')], 1500)).toBe('')
  })

  test('行范围变体：只给 offset → 「第 N 行起」；什么都不给 → 「第 1 行起」', () => {
    // read 的语义是「从 offset 起读 limit 行」，缺 limit 时不编造结束行。
    expect(anchors.buildReadState([readAssistant('c1', 'D:\\a\\y.ts', 40)], 1500).includes('第 40 行起')).toBe(true)
    expect(anchors.buildReadState([readAssistant('c1', 'D:\\a\\z.ts')], 1500).includes('第 1 行起')).toBe(true)
  })

  test('maxFiles=0 → 关闭（空串）', () => {
    // 用户可配的开关；0 必须是「关掉」，不是「不限」。
    expect(anchors.buildReadState([readAssistant('c1', 'D:\\a\\a.ts', 1, 10)], 1500, 0)).toBe('')
  })

  test('预算太小装不下标题 → 空串（不产出半截标题）', () => {
    expect(anchors.buildReadState([readAssistant('c1', 'D:\\a\\a.ts', 1, 10)], 10)).toBe('')
  })

  test('幂等：同输入同输出', () => {
    // 投影链会在同一轮里跑两遍（invariant 二次派生），结果必须逐字节一致。
    const messages = [readAssistant('c1', 'D:\\a\\a.ts', 1, 10), readAssistant('c2', 'D:\\a\\b.ts', 5, 20)]
    expect(anchors.buildReadState(messages, 1500)).toBe(anchors.buildReadState(messages, 1500))
  })
})

describe('② compactSession：read-state 在锚点索引之后、细节找回之前', () => {
  /** 压缩时各项上限（沿用探针那份）。 */
  const limits = { keepRecent: 3, anchorChars: 6000, userQuoteChars: 8000, readStateFiles: 5, readStateChars: 1500 }
  /** 一个假会话：只需要 `compactSession` 读写的那些字段。 */
  interface FakeSession {
    messages: ChatMessage[]
    meta: { id: string }
    filePath: string
    summary: string
    kept: ChatMessage[] | null
    replaceWithSummary(summary: string, kept: ChatMessage[]): void
  }
  /** 上一次压缩写下的摘要。 */
  let summary = ''

  test('压缩成功，摘要里三段顺序是 锚点 < read-state < 细节找回', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '帮我看看这两个文件' },
      readAssistant('c1', 'D:\\proj\\a.ts', 1, 30),
      { role: 'tool', content: `a.ts 的内容 ${'x'.repeat(4000)}`, tool_call_id: 'c1' },
      readAssistant('c2', 'D:\\proj\\b.ts', 10, 20),
      { role: 'tool', content: `b.ts 的内容 ${'x'.repeat(4000)}`, tool_call_id: 'c2' },
      ...Array.from({ length: 6 }, (_, index) => ({ role: 'user', content: `填充 ${String(index)}` }) as ChatMessage),
    ]
    const session: FakeSession = {
      messages,
      meta: { id: 'unit-order' },
      filePath: 'D:\\tmp\\unit-order.jsonl',
      summary: '',
      kept: null,
      replaceWithSummary(text, kept) {
        this.summary = text
        this.kept = kept
      },
    }
    const route = { api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k', model: 'm' }
    const stream = async () => ({ text: '【假摘要】顺序检查' })
    const outcome = await compact.compactSession(
      session as unknown as Parameters<CompactModule['compactSession']>[0],
      route as unknown as Parameters<CompactModule['compactSession']>[1],
      stream as unknown as Parameters<CompactModule['compactSession']>[2],
      new AbortController().signal,
      undefined,
      limits,
      undefined,
      { imageBudget: 4, toolResultChars: 2000 },
      { system: 'SYS', tools: [] },
    )
    summary = session.summary
    expect(outcome.outcome).toBe('compacted')
  })

  test('摘要含 read-state 段，且落在锚点索引与细节找回中间', () => {
    expect(summary.includes('## 读过的文件')).toBe(true)
    const atAnchor = summary.indexOf('## 锚点索引')
    const atRead = summary.indexOf('## 读过的文件')
    const atRecovery = summary.indexOf('## 细节找回')
    expect(atAnchor >= 0 && atRead > atAnchor).toBe(true)
    expect(atRead >= 0 && atRecovery > atRead).toBe(true)
  })
})

describe('③ 真内核 + 假端点：压完的摘要里带 read-state，且不带被折原文', () => {
  /** 被折掉的那条工具结果里的哨兵：压缩后不该出现在摘要里。 */
  const SENTINEL = '被折掉的工具结果原文哨兵-ZZZ-不该出现'
  let llm: FakeLLM
  let kernel: BootedKernel
  /** 压缩之后会话里的消息。 */
  let kept: ChatMessage[]

  beforeAll(async () => {
    // 压缩请求是这一趟的第一发请求，所以第 1 轮就是短摘要。
    llm = await fakeLLM({ turns: ['【假摘要】这段历史已压缩', '收到'] })
    kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
    const services = kernel.ctx as unknown as {
      session: {
        current(): {
          appendUser(text: string): void
          appendAssistant(text: string, reasoning: string, calls: Array<{ id: string; name: string; arguments: string }>): void
          appendTool(id: string, name: string, content: string): void
          messages: ChatMessage[]
        }
      }
      compact: { run(): Promise<void> }
    }
    const session = services.session.current()
    session.appendUser('开场：看这几个文件')
    for (let index = 1; index <= 6; index += 1) {
      const callId = `r${String(index)}`
      const path = `D:\\proj\\src\\f${String(index)}.ts`
      session.appendAssistant('', '', [{ id: callId, name: 'read', arguments: JSON.stringify({ path, offset: 1, limit: 200 }) }])
      session.appendTool(callId, 'read', index === 1 ? `${SENTINEL} ${'x'.repeat(4000)}` : `f${index}.ts 的内容 ${'x'.repeat(4000)}`)
    }
    session.appendUser('继续')
    session.appendAssistant('收到', '', [])
    session.appendUser('还有别的吗')
    session.appendAssistant('没有了', '', [])
    session.appendUser('好')
    await services.compact.run()
    kept = session.messages
  })

  afterAll(async () => {
    await kernel?.dispose()
    await llm?.close()
  })

  test('压缩后首条是摘要（带 banner）', () => {
    const head = typeof kept[0]?.content === 'string' ? kept[0].content : ''
    expect(head.startsWith(anchors.SUMMARY_BANNER)).toBe(true)
  })

  test('kept[0] 含 read-state 段与最后读过的文件路径', () => {
    const head = typeof kept[0]?.content === 'string' ? kept[0].content : ''
    expect(head.includes('## 读过的文件')).toBe(true)
    expect(head.includes('D:\\proj\\src\\f6.ts')).toBe(true)
  })

  test('kept[0] 含行范围「第 1–200 行」', () => {
    const head = typeof kept[0]?.content === 'string' ? kept[0].content : ''
    expect(head.includes('第 1–200 行')).toBe(true)
  })

  test('kept[0] 不含被折掉的原文哨兵（read-state 只带路径不带内容）', () => {
    const head = typeof kept[0]?.content === 'string' ? kept[0].content : ''
    expect(head.includes(SENTINEL)).toBe(false)
  })

  test('端到端顺序：锚点 < read-state < 细节找回', () => {
    const head = typeof kept[0]?.content === 'string' ? kept[0].content : ''
    const atAnchor = head.indexOf('## 锚点索引')
    const atRead = head.indexOf('## 读过的文件')
    const atRecovery = head.indexOf('## 细节找回')
    expect(atAnchor >= 0 && atRead > atAnchor).toBe(true)
    expect(atRead >= 0 && atRecovery > atRead).toBe(true)
  })
})
