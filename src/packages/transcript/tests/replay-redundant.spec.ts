/**
 * 正文开了「重复打开同一条会话不整表重建」的端到端回归（迁自
 * `scripts/trace-data-test.mjs` 第 8 节）。
 *
 * ## 这条守的是什么
 *
 * 壳每次「打开会话」都会走一遍 `dsc/session-open`：若实时条目与「把日志重放一遍得到的内容」
 * 完全一致，就复用当前快照与条目 id（`replayIsRedundant`），否则整表重建。而工具卡的
 * `startedAt` / `durationMs` 在两条路径上必然不同——实时记「事件到达那一刻」，重放记
 * 「消息落盘那一刻」——所以插件的 `shape()` 必须剔掉这两项。不剔，判定永远 false：
 * 每次重开同一会话都重建、条目 id 从头重发，渲染层按 key 对账就会把折叠态与直播尾一起抹掉。
 *
 * 本文件用假 ctx 跑**真插件**，钉三件事：
 *
 *   ① 实时条目的 startedAt 来自现场时钟（与日志时刻不同，所以两边形状本来就不一样）；
 *   ② 内容一致 → 判冗余、不重建（快照对象引用不变、id 不重发）；
 *   ③ 反向对照：内容真变了照样重建——否则第 ② 条测的是「恒判冗余」。
 *
 * 假 ctx 只实现插件真正用到的那几样（`on` / `provide` / `get` / `session` / `llm` /
 * `surfaces`），不装配任何别的插件：这条要验的正是「两个字段剔没剔」，不是整套内核。
 *
 * @module @pneuma/transcript/tests/replay-redundant.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import type { CoreEvent } from '@pneuma/runtime/core/events.js'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import type { TranscriptEntry } from '@pneuma/runtime/contract.js'
import { transcriptPlugin } from '../index.js'

/** 转录服务面上本文件要用的两样。 */
interface TranscriptServiceLike {
  emit(event: CoreEvent): void
  getSnapshot(): { entries: readonly TranscriptEntry[] }
}

/** 插件 `dsc/session-open` 处理函数收到的载荷（只用到 filePath）。 */
interface SessionOpenPayload {
  filePath?: string
}

/** 起一次插件，交回假会话、事件处理器表与服务。 */
function mount(): {
  session: { messages: ChatMessage[] }
  handlers: Map<string, (payload: SessionOpenPayload) => void>
  service: TranscriptServiceLike
} {
  const session = {
    messages: [
      {
        role: 'assistant',
        content: '看下文件',
        tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{}' } }],
        ts: 1100,
      },
      { role: 'tool', tool_call_id: 'c9', content: '文件内容', ts: 1400 },
    ] as ChatMessage[],
    toolErrors: new Map<string, string>(),
    // 快照组装会读收件箱（0.6.67 的排队消息条）：这个假会话按「没有排队输入」给。
    asyncInbox: () => [],
    // 重放要读回合提示（notice 记录）来重建重试行：这个假会话没有提示。
    notices: () => [],
    // 系统提示卡 / 上下文注入卡的落位记录（2026-11）：这个假会话同样没有。
    marks: () => [],
    meta: { id: 'aaaaaaaabbbbcccc' },
  }
  const handlers = new Map<string, (payload: SessionOpenPayload) => void>()
  const provided = new Map<string, unknown>()
  const ctx = {
    on: (name: string, handler: (payload: SessionOpenPayload) => void) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    provide: (name: string, value: unknown) => provided.set(name, value),
    // T21 起转录快照会 ctx.get('team')/('agent')（队友名册、常驻 agent 状态）：
    // 本文件不装这两个服务，按「可选服务整个没挂」返回 undefined。
    get: () => undefined,
    session: { current: () => session, sessions: [], loading: false },
    llm: { provider: 'test', model: 'test', effort: 'medium' },
    surfaces: { build: () => ({ pendingApproval: null }) },
  }
  transcriptPlugin.apply(ctx as unknown as Context, {})
  return { session, handlers, service: provided.get('transcript') as TranscriptServiceLike }
}

describe('⑧ 端到端：假 ctx 跑真插件，replayIsRedundant 不被新字段破坏', () => {
  test('实时条目的 startedAt 来自现场时钟（与日志时刻不同）', () => {
    const harness = mount()
    // 先按实时路径喂事件：时间取真实时钟，与日志里的 1100 / 1400 必然不同。
    harness.service.emit({ type: 'message', text: '看下文件', reasoning: '' })
    harness.service.emit({ type: 'tool/call', callId: 'c9', name: 'read', args: '{}' })
    harness.service.emit({ type: 'tool/result', callId: 'c9', text: '文件内容' })
    const tool = harness.service.getSnapshot().entries.find((entry) => entry.kind === 'tool')
    expect(tool?.kind === 'tool' ? tool.call.startedAt : undefined).not.toBe(1100)
  })

  test('实时条目与重放日志内容一致 → 判为冗余、不重建（快照引用不变、id 不重发）', () => {
    const harness = mount()
    harness.service.emit({ type: 'message', text: '看下文件', reasoning: '' })
    harness.service.emit({ type: 'tool/call', callId: 'c9', name: 'read', args: '{}' })
    harness.service.emit({ type: 'tool/result', callId: 'c9', text: '文件内容' })
    const before = harness.service.getSnapshot()
    harness.handlers.get('dsc/session-open')?.({ filePath: 'D:\\x\\s.jsonl' })
    const after = harness.service.getSnapshot()
    expect(after).toBe(before)
    // 条目 id 没有重新发号：渲染层 key 不换，折叠态与直播尾不会丢。
    expect(after.entries.map((entry) => entry.id).join(',')).toBe(before.entries.map((entry) => entry.id).join(','))
  })

  test('内容真变了照样重建（说明上一条不是恒真）', () => {
    const harness = mount()
    harness.service.emit({ type: 'message', text: '看下文件', reasoning: '' })
    harness.service.emit({ type: 'tool/call', callId: 'c9', name: 'read', args: '{}' })
    harness.service.emit({ type: 'tool/result', callId: 'c9', text: '文件内容' })
    harness.handlers.get('dsc/session-open')?.({ filePath: 'D:\\x\\s.jsonl' })
    const after = harness.service.getSnapshot()
    // 反向对照：内容真变了就必须重建。
    harness.session.messages.push({ role: 'user', content: '又一句', ts: 2000 })
    harness.handlers.get('dsc/session-open')?.({ filePath: 'D:\\x\\s.jsonl' })
    expect(harness.service.getSnapshot()).not.toBe(after)
  })
})
