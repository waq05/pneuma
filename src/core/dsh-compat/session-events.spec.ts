/**
 * `session/event` 合成桥（`core/dsh-compat/session-events.ts`）：把内核回合折成 dsh 事件。
 *
 * 用假 ctx 收集派发；只喂合成事件，不碰磁盘。重点钉顺序与边界：
 * 回合没开时的用户消息要缓冲、usage 决定助手消息何时定稿、生命周期事件不带 surfaceOp、
 * error 要在 turn/end 的 reason 里带出去、尾巴只留 64 条。
 *
 * @module dsc/core/dsh-compat/session-events.spec
 */
import { describe, expect, test } from 'vitest'
import type { CoreEvent } from '../events.js'
import { createDshSessionEventBridge, DSH_SESSION_EVENT, type DshSessionEvent } from './session-events.js'

/** 假 ctx：记录 emit 的三元组。 */
function fakeCtx() {
  const emitted: Array<{ name: string; carrier: unknown; event: DshSessionEvent }> = []
  return {
    emitted,
    ctx: {
      emit(name: string, carrier: unknown, event: DshSessionEvent) {
        emitted.push({ name, carrier, event })
      },
    },
  }
}

function bridge(route = { provider: 'p', model: 'm' }) {
  const fake = fakeCtx()
  return {
    ...fake,
    bridge: createDshSessionEventBridge({ ctx: fake.ctx, sessionId: 's1', cwd: '/w', createdAt: 123, route: () => route }),
  }
}

/** 派发出去的事件类型序列。 */
function types(fake: { emitted: Array<{ event: DshSessionEvent }> }): string[] {
  return fake.emitted.map((entry) => entry.event.type)
}

describe('正常回合', () => {
  test('user → turn/start → step/start → assistant/message → tool/call → tool/result → step/end → turn/end', () => {
    const { bridge: b, emitted } = bridge()
    b.publish({ type: 'user', text: '你好' } satisfies CoreEvent)
    expect(emitted).toHaveLength(0) // 回合没开：先缓冲

    b.publish({ type: 'turn/start' } satisfies CoreEvent)
    b.publish({ type: 'context' } satisfies CoreEvent)
    b.publish({
      type: 'message',
      text: 'hello',
      reasoning: 'think',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
    } satisfies CoreEvent)
    b.publish({ type: 'usage', inputTokens: 10, outputTokens: 5 } satisfies CoreEvent)
    b.publish({ type: 'tool/call', callId: 'c1', name: 'read', args: '{}' } satisfies CoreEvent)
    b.publish({ type: 'tool/result', callId: 'c1', text: 'ok' } satisfies CoreEvent)
    b.publish({ type: 'turn/end', reason: 'completed' } satisfies CoreEvent)

    expect(types({ emitted })).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
    ])
    // seq 连续；每条都走 session/event 这个通道。
    expect(emitted.map((entry) => entry.event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(new Set(emitted.map((entry) => entry.name))).toEqual(new Set([DSH_SESSION_EVENT]))
  })

  test('assistant/message 带正文、推理、工具调用、用量与路由来源', () => {
    const { bridge: b, emitted } = bridge({ provider: 'deepseek', model: 'deepseek-flash' })
    b.publish({ type: 'turn/start' } satisfies CoreEvent)
    b.publish({ type: 'context' } satisfies CoreEvent)
    b.publish({
      type: 'message',
      text: '答案',
      reasoning: '推一下',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
    } satisfies CoreEvent)
    b.publish({ type: 'usage', inputTokens: 10, outputTokens: 5, cacheHitTokens: 4, cacheMissTokens: 6 } satisfies CoreEvent)

    const event = emitted.find((entry) => entry.event.type === 'assistant/message')!.event
    const message = event.data['message'] as {
      role: string
      content: Array<{ type: string }>
      source: { provider: string; model: string }
    }
    expect(message.role).toBe('assistant')
    expect(message.content.map((block) => block.type)).toEqual(['text', 'reasoning', 'tool-call'])
    expect(message.source).toEqual({ kind: 'model', provider: 'deepseek', model: 'deepseek-flash' })
    expect(event.data['usage']).toBeDefined()
    expect(event.data['stream']).toEqual(expect.any(Array))
    expect(event.surfaceOp).toBe('append')
  })

  test('surfaceOp 只挂在会改模型可见面的消息上，生命周期事件没有', () => {
    const { bridge: b, emitted } = bridge()
    b.publish({ type: 'turn/start' } satisfies CoreEvent)
    b.publish({ type: 'context' } satisfies CoreEvent)
    b.publish({ type: 'message', text: 'x', reasoning: '' } satisfies CoreEvent)
    b.publish({ type: 'usage', inputTokens: 1, outputTokens: 1 } satisfies CoreEvent)
    b.publish({ type: 'tool/result', callId: 'c', text: 'r' } satisfies CoreEvent)
    b.publish({ type: 'turn/end', reason: 'completed' } satisfies CoreEvent)

    for (const { event } of emitted) {
      if (event.type === 'turn/start' || event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end') {
        expect(event.surfaceOp, event.type).toBeUndefined()
      }
      if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'user/message') {
        expect(event.surfaceOp, event.type).toBe('append')
      }
    }
  })
})

describe('收尾原因与错误', () => {
  test('aborted 写成 user；failed 把上一条 error 文案带进 reason', () => {
    const aborted = bridge()
    aborted.bridge.publish({ type: 'turn/start' } satisfies CoreEvent)
    aborted.bridge.publish({ type: 'turn/end', reason: 'aborted' } satisfies CoreEvent)
    const abortedEnd = aborted.emitted.find((entry) => entry.event.type === 'turn/end')!.event
    expect(abortedEnd.data['reason']).toEqual({ kind: 'aborted', reason: { kind: 'user' } })

    const failed = bridge()
    failed.bridge.publish({ type: 'turn/start' } satisfies CoreEvent)
    failed.bridge.publish({ type: 'error', message: '连接被重置' } satisfies CoreEvent)
    failed.bridge.publish({ type: 'turn/end', reason: 'failed' } satisfies CoreEvent)
    const failedEnd = failed.emitted.find((entry) => entry.event.type === 'turn/end')!.event
    expect(failedEnd.data['reason']).toMatchObject({ kind: 'error', error: { message: '连接被重置' } })
  })

  test('没有 error 事件时失败原因也有可读文案', () => {
    const { bridge: b, emitted } = bridge()
    b.publish({ type: 'turn/start' } satisfies CoreEvent)
    b.publish({ type: 'turn/end', reason: 'failed' } satisfies CoreEvent)
    const end = emitted.find((entry) => entry.event.type === 'turn/end')!.event
    expect((end.data['reason'] as { error: { message: string } }).error.message).toContain('这一轮失败了')
  })

  test('回合没开时 turn/end 不发', () => {
    const { bridge: b, emitted } = bridge()
    b.publish({ type: 'turn/end', reason: 'completed' } satisfies CoreEvent)
    expect(emitted).toHaveLength(0)
  })
})

describe('步骤边界与尾巴', () => {
  test('重试再来一条 context：助手消息已定稿就关旧步、开新步', () => {
    const { bridge: b, emitted } = bridge()
    b.publish({ type: 'turn/start' } satisfies CoreEvent)
    b.publish({ type: 'context' } satisfies CoreEvent)
    b.publish({ type: 'message', text: 'x', reasoning: '' } satisfies CoreEvent)
    b.publish({ type: 'usage', inputTokens: 1, outputTokens: 1 } satisfies CoreEvent)
    b.publish({ type: 'context' } satisfies CoreEvent)

    const steps = emitted.filter((entry) => entry.event.type === 'step/start')
    expect(steps.map((entry) => entry.event.data['step'])).toEqual([1, 2])
    expect(types({ emitted })).toEqual(['turn/start', 'step/start', 'assistant/message', 'step/end', 'step/start'])
  })

  test('carrier 是只读视图：id/header/cwd + 最近 64 条', () => {
    const { bridge: b } = bridge()
    expect(b.carrier).toMatchObject({ id: 's1', header: { id: 's1', cwd: '/w', createdAt: 123 }, cwd: '/w' })
    for (let index = 0; index < 70; index += 1) {
      b.publish({ type: 'turn/start' } satisfies CoreEvent)
      b.publish({ type: 'turn/end', reason: 'completed' } satisfies CoreEvent)
    }
    expect(b.carrier.events).toHaveLength(64)
    expect(b.carrier.events.at(-1)?.type).toBe('turn/end')
  })

  test('不认识的事件直接忽略，不抛错', () => {
    const { bridge: b, emitted } = bridge()
    b.publish({ type: 'delta', kind: 'text', text: 'x' } satisfies CoreEvent)
    expect(emitted).toHaveLength(0)
    expect(() => b.publish({ type: 'inbox' } satisfies CoreEvent)).not.toThrow()
  })
})
