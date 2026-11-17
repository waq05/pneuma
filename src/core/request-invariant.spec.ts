/**
 * 运行时请求 invariant：纯函数那一半（迁自 `scripts/request-invariant-test.mjs` 的 [1]）。
 *
 * 被测：`checkReconstructable`（请求 messages 能不能从「按同一路径重新派生」的那份重建）。
 * 对应 dsh 的 agent-loop invariant（逐字节相等，不符即 fail）；dsc 的取舍是**只报不杀**，
 * 所以校验本身必须做到三件事：认得出真失配、把位置指准、对天生易变的尾部注入段放宽到零误报。
 *
 * 本文件只钉判定口径；「真内核里会不会报、报几次、报完请求还发不发」在
 * `tests/integration/request-invariant.int.spec.ts`（那一层要起内核，按 D25 先 build）。
 *
 * 纯函数、零依赖，归 unit 层。
 *
 * @module dsc/core/request-invariant.spec
 */
import { describe, expect, test } from 'vitest'
import type { ChatMessage } from './llm.js'
import { checkReconstructable, firstMutatedIndex, snapshotMessages } from './request-invariant.js'

/** 造一条消息（字段与 OpenAI 协议同形）。 */
function msg(role: ChatMessage['role'], content: ChatMessage['content'], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra }
}

describe('① 健康：一致就给 ok，且不带诊断字段', () => {
  test('逐字节相同的两份 → ok:true，没有 reason / digest', () => {
    const sent = [msg('system', 'S'), msg('user', 'hi'), msg('assistant', 'yo')]
    const derived = sent.map((message) => ({ ...message }))
    const report = checkReconstructable(sent, derived)
    expect(report.ok).toBe(true)
    expect(report.reason).toBeUndefined()
    expect(report.digest).toBeUndefined()
  })

  test('ts 是记账字段：两次派生之间不同不算内容差异', () => {
    const sent = [msg('system', 'S', { ts: 1 }), msg('user', 'hi', { ts: 2 })]
    const derived = [msg('system', 'S', { ts: 9 }), msg('user', 'hi', { ts: 8 })]
    expect(checkReconstructable(sent, derived).ok).toBe(true)
  })

  test('奇怪 content（null / 数组 / 空串）不抛异常', () => {
    const weird = [
      msg('user', null),
      msg('user', [
        { type: 'text', text: 't' },
        { type: 'image_url', image_url: { url: 'data:x' } },
      ]),
      msg('assistant', ''),
    ]
    const report = checkReconstructable(weird, JSON.parse(JSON.stringify(weird)) as ChatMessage[])
    expect(report.ok).toBe(true)
  })
})

describe('② 真失配：认出内容 / 长度 / role 三种差，位置指准', () => {
  test('中段内容不一致：firstDiffIndex=2，reason 带「第 3 条」与 role', () => {
    const sent = [msg('system', 'S'), msg('user', 'a'), msg('user', 'b')]
    const derived = [msg('system', 'S'), msg('user', 'a'), msg('user', 'B')]
    const report = checkReconstructable(sent, derived)
    expect(report.ok).toBe(false)
    expect(report.firstDiffIndex).toBe(2)
    expect(report.reason).toContain('第 3 条')
    expect(report.reason).toContain('user')
  })

  test('长度差：firstDiffIndex=2，reason 带「差 +1」', () => {
    const sent = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'b')]
    const derived = [msg('system', 'S'), msg('user', 'a')]
    const report = checkReconstructable(sent, derived)
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('差 +1')
    expect(report.firstDiffIndex).toBe(2)
  })

  test('role 不一致被认出（两侧 role 都进 reason）', () => {
    const sent = [msg('system', 'S'), msg('assistant', 'x')]
    const derived = [msg('system', 'S'), msg('tool', 'x', { tool_call_id: 't' })]
    const report = checkReconstructable(sent, derived)
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('assistant')
    expect(report.reason).toContain('tool')
  })

  test('图像按逐段比：URL 变了要认出来（不 stringify，data URL 很大）', () => {
    const build = (url: string): ChatMessage[] => [
      msg('user', [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url } },
      ]),
    ]
    expect(checkReconstructable(build('data:image/png;base64,AAAA'), build('data:image/png;base64,BBBB')).ok).toBe(false)
  })
})

describe('③ 尾部运行时注入段：放宽到零误报，但只放宽这几类', () => {
  test('易变的环境快照文本（日期变了）不误报', () => {
    const env = (date: string): string =>
      `环境快照：${date} 分支 main\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）`
    const sent = [msg('system', 'S'), msg('user', 'hi'), msg('assistant', 'yo'), msg('user', env('2026-10-15'))]
    const derived = [msg('system', 'S'), msg('user', 'hi'), msg('assistant', 'yo'), msg('user', env('2026-10-16'))]
    expect(checkReconstructable(sent, derived).ok).toBe(true)
  })

  test('重建侧多出两条尾部注入段 → ok', () => {
    const env = '环境快照\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）'
    const hook = '<external_content source="hook:UserPromptSubmit">钩子说了一句</external_content>'
    const sent = [msg('system', 'S'), msg('user', 'hi')]
    const derived = [msg('system', 'S'), msg('user', 'hi'), msg('user', env), msg('user', hook)]
    expect(checkReconstructable(sent, derived).ok).toBe(true)
  })

  test('尾部多出「没有注入标记」的 user 仍然被抓', () => {
    const sent = [msg('system', 'S'), msg('user', 'hi')]
    const derived = [msg('system', 'S'), msg('user', 'hi'), msg('user', '随便多出来的一条')]
    const report = checkReconstructable(sent, derived)
    expect(report.ok).toBe(false)
    expect(report.firstDiffIndex).toBe(2)
  })
})

describe('④ 就地改输入：结果可能碰巧对，日志已经被写花了', () => {
  test('内容被就地改写被抓（firstDiffIndex=1，reason 点明「就地」）', () => {
    const before = snapshotMessages([msg('system', 'S'), msg('user', 'hi')])
    const after = [msg('system', 'S'), msg('user', 'hi 被就地改了')]
    const report = checkReconstructable(after, after, { before, after })
    expect(report.ok).toBe(false)
    expect(report.firstDiffIndex).toBe(1)
    expect(report.reason).toContain('就地')
  })

  test('输入数组被塞一条也被抓（长度差）', () => {
    const before = snapshotMessages([msg('system', 'S')])
    const after = [msg('system', 'S'), msg('user', '塞进来的')]
    const report = checkReconstructable(after, after, { before, after })
    expect(report.ok).toBe(false)
    expect(report.firstDiffIndex).toBe(1)
  })

  test('tool_calls 数组被就地追加也被抓', () => {
    const before = snapshotMessages([
      msg('system', 'S'),
      msg('assistant', '', { tool_calls: [{ id: 't', type: 'function', function: { name: 'n', arguments: '{}' } }] }),
    ])
    const after = JSON.parse(JSON.stringify(before)) as ChatMessage[]
    after[1]!.tool_calls!.push({ id: 't2', type: 'function', function: { name: 'n2', arguments: '{}' } })
    const report = checkReconstructable(after, after, { before, after })
    expect(report.ok).toBe(false)
    expect(report.firstDiffIndex).toBe(1)
  })

  test('firstMutatedIndex：没改返回 null', () => {
    const before = snapshotMessages([msg('system', 'S'), msg('user', 'hi')])
    const after = before.map((message) => ({ ...message }))
    expect(firstMutatedIndex(before, after)).toBeNull()
  })
})

describe('⑤ 校验自身的两条硬约束', () => {
  test('不改动入参（校验不能顺手把请求修好）', () => {
    const sent = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'b')]
    const derived = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'B')]
    const sentCopy = JSON.stringify(sent)
    const derivedCopy = JSON.stringify(derived)
    checkReconstructable(sent, derived)
    expect(JSON.stringify(sent)).toBe(sentCopy)
    expect(JSON.stringify(derived)).toBe(derivedCopy)
  })

  test('同一形状 digest 稳定（可做「按会话去重」的键）', () => {
    const sent = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'b')]
    const derived = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'B')]
    const first = checkReconstructable(sent, derived)
    const second = checkReconstructable(sent, derived)
    expect(first.digest).toBeDefined()
    expect(first.digest).toBe(second.digest)
  })
})
