/**
 * 指纹放宽口径的单元用例。
 *
 * 钉三件事：
 *   1. **该放宽的放宽**：运行时注入段（尾部环境快照 / LSP 诊断 / 钩子正文）正文变了，
 *      指纹不变——这是快照能跨机器、跨时间回放的前提。
 *   2. **该抓的照抓**：系统提示正文、用户原话、历史组装、工具 schema 相关消息任何一处变化，
 *      指纹必须变。放宽不许溢出成「整段不算」，否则回放会放过真实的请求形状回归。
 *   3. **标记不能悄悄漂**：测试侧那份标记是产品侧 `RUNTIME_INJECTION_MARKERS` 的复制品，
 *      这里直接读产品源文件核对字面量，漏同步当场红。
 *
 * @module dsc/tests/support/hash.spec
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { hashChatMessages } from './hash.js'

/** 一条普通用户消息。 */
const USER = { role: 'user', content: '用一句话介绍你自己' }
/** 一条系统提示。 */
const SYSTEM = { role: 'system', content: '你是 Pneuma，跑在用户桌面里的编程助手。' }

/** 与产品侧同形的运行时注入快照（正文每次都变）。 */
function envFacts(snapshot = '环境事实：\n- 今天：2026-11-17\n- 工作目录：D:\\dsc\\x'): Record<string, unknown> {
  return {
    role: 'user',
    content: `${snapshot}\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）`,
  }
}

/** 取一组「系统 + 用户 + 尾部环境快照」的典型请求。 */
function messagesWith(overrides: {
  system?: string
  user?: string
  env?: string
  history?: unknown[]
}): unknown[] {
  return [
    { role: 'system', content: overrides.system ?? SYSTEM.content },
    ...(overrides.history ?? []),
    { role: 'user', content: overrides.user ?? USER.content },
    envFacts(overrides.env),
  ]
}

describe('hashChatMessages：运行时注入段放宽', () => {
  test('环境快照正文变了（日期 / 工作目录 / git 脏标），指纹不变', () => {
    const before = messagesWith({})
    // 真实触发过的事故：录制完成后录像文件自己进了 git status，两分钟后回放 409。
    const after = messagesWith({
      env:
        '环境事实：\n- 今天：2026-11-16\n- 工作目录：/tmp/another-machine\n' +
        '- git 分支：main（工作区有未提交改动： M tests/snapshots/session/basic-turn/session.jsonl）',
    })
    expect(hashChatMessages(after)).toBe(hashChatMessages(before))
  })

  test('LSP 诊断段的正文变了，指纹不变', () => {
    const withDiag = (body: string): unknown[] => [
      SYSTEM,
      { role: 'user', content: `${body}\n【LSP 诊断】\n${body}` },
      USER,
    ]
    expect(hashChatMessages(withDiag('x.ts:1 未使用的变量'))).toBe(
      hashChatMessages(withDiag('y.ts:9 类型不匹配')),
    )
  })

  test('钩子注入段的正文变了，指纹不变', () => {
    const withHook = (body: string): unknown[] => [
      SYSTEM,
      USER,
      { role: 'user', content: `<external_content source="hook:user-prompt-submit">${body}</external_content>` },
    ]
    expect(hashChatMessages(withHook('第一次'))).toBe(hashChatMessages(withHook('第二次，内容完全不同')))
  })

  test('多模态 content 数组里的快照也能摘掉（与产品侧同口径）', () => {
    const withParts = (text: string): unknown[] => [
      SYSTEM,
      {
        role: 'user',
        content: [{ type: 'text', text: `${text}（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）` }],
      },
      USER,
    ]
    expect(hashChatMessages(withParts('今天：2026-11-17'))).toBe(hashChatMessages(withParts('今天：2026-11-16')))
  })

  test('同样的字串出现在 assistant 消息里不算注入段，照旧进指纹', () => {
    const asAssistant = (text: string): unknown[] => [
      SYSTEM,
      USER,
      { role: 'assistant', content: `${text}（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）` },
    ]
    expect(hashChatMessages(asAssistant('回复甲'))).not.toBe(hashChatMessages(asAssistant('回复乙')))
  })
})

describe('hashChatMessages：其余消息一处不许放过', () => {
  test('用户原话改一个字，指纹必须变', () => {
    expect(hashChatMessages(messagesWith({ user: '用一句话介绍你自己' }))).not.toBe(
      hashChatMessages(messagesWith({ user: '用两句话介绍你自己' })),
    )
  })

  test('系统提示正文改一个字，指纹必须变', () => {
    expect(hashChatMessages(messagesWith({ system: SYSTEM.content }))).not.toBe(
      hashChatMessages(messagesWith({ system: `${SYSTEM.content} 全程用中文回答。` })),
    )
  })

  test('历史组装变化（多一条历史消息）指纹必须变', () => {
    expect(hashChatMessages(messagesWith({}))).not.toBe(
      hashChatMessages(messagesWith({ history: [{ role: 'assistant', content: '上一轮的回答' }] })),
    )
  })

  test('工具结果正文变化指纹必须变（工具 schema 随请求走同一份序列化）', () => {
    const withTool = (result: string): unknown[] => [
      SYSTEM,
      { role: 'user', content: '读一下文件' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: result },
      envFacts(),
    ]
    expect(hashChatMessages(withTool('第一行'))).not.toBe(hashChatMessages(withTool('第二行')))
  })

  test('指纹形态是 sha256:<64 位小写十六进制>', () => {
    expect(hashChatMessages([SYSTEM])).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test('非法输入照旧抛错（不静默算成空数组的指纹）', () => {
    expect(() => hashChatMessages('not-an-array')).toThrow(TypeError)
    expect(() => hashChatMessages({ messages: [] })).toThrow(TypeError)
    expect(() => hashChatMessages([{ role: 'user', content: 1n }])).toThrow(TypeError)
  })
})

describe('hashChatMessages：标记与产品侧同步（漂移守卫）', () => {
  /** 产品侧唯一事实源的源文件与判定位置（改动产品侧必须同步这里）。 */
  const PRODUCT_SOURCE = fileURLToPath(new URL('../../src/core/request-invariant.ts', import.meta.url))

  test('三个标记字面量都还在 src/core/request-invariant.ts 的 RUNTIME_INJECTION_MARKERS 里', () => {
    const source = readFileSync(PRODUCT_SOURCE, 'utf8')
    const start = source.indexOf('const RUNTIME_INJECTION_MARKERS')
    expect(start, '产品侧找不到 RUNTIME_INJECTION_MARKERS（被改名了？同步 tests/support/hash.ts）').toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf(']', start))
    for (const marker of [
      '本条是程序在每次请求时自动附上的当前环境快照',
      '【LSP 诊断】',
      '<external_content source="hook:',
    ]) {
      expect(block, `产品侧标记删了或被改字：「${marker}」，同步 tests/support/hash.ts`).toContain(marker)
    }
  })
})
