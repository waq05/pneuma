/**
 * 被中断那一轮里「没有结果的工具」不再永远显示「进行中」（迁自
 * `scripts/transcript-abort-tool-test.mjs`）。
 *
 * ## 报障现场
 *
 * 被中断的 bash 永远显示「进行中」。根因在 `./transcript.ts`：`tool/call` 一律写
 * `status: 'running'`，只有 `tool/result` 才把它改成终态；一轮以 aborted / error 收尾时
 * 那些没收到结果的调用就永远停在 running。`turn/end` 以前只清「准备中」队列，一条工具行
 * 都没碰；恢复旧会话时重放同一条日志，自然也是同一副样子。
 *
 * 修后的口径：同一条判据（`settleUnfinishedTools`）在两处落定——
 * 实时在 `turn/end` reason 不是 completed 时落定；恢复在 `replayHistory` 结尾按
 * 「日志里有发起、没有结果 = 没跑完」落定，再由宿主经 `seedTurnState` 送进来的真值对一次
 * （日志里没有「这一轮为什么结束」这条记录，光看重放分不出「被中断」与「还在跑」）。
 *
 * ## 为什么落成 `aborted` 而不是 `failed`
 *
 * 用户按停止、这一轮被放弃，与「工具真的跑挂了」是两件事：后者要排查日志，前者不用管。
 * 契约的 ToolStatus 为此单列了 aborted，界面上那个词是「已中断 / Stopped」，配色中性。
 *
 * ## 迁移时砍掉的东西（原探针第 [6] 节，7 条里砍 4 条）
 *
 * 砍的是三条**源码文本断言**：`tool-summary.ts` 里 `aborted` 接到哪条词条、
 * `contract/transcript.ts` 的 `ToolStatus` 字面量、两条 CSS 规则（`.tool-card.status-aborted
 * .tool-dot` 与 `.status` 的颜色）。它们是「读 .ts / .css 再匹配字符串」，没有行为接缝，
 * 按本批规矩不搬；配色与字面量由界面层用例或人眼校对负责。
 *
 * 留下的是三条**数据表**断言（`ui.zh.json` / `ui.en.json` 的键值）：词表是数据不是源码，
 * 而且「进行中之外还有没有一个中性的中止词」正是这次报障的用户可见面——它不该只剩人肉看。
 *
 * @module dsc/adapter/transcript-abort-tool.int.spec
 */
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import type { ChatMessage } from '../core/llm.js'
import type { TranscriptEntry } from '../contract.js'
import { Transcript } from './transcript.js'

/** 词表文件：数据表，不是源码；路径从本文件定位，不依赖进程 cwd。 */
function locale(name: 'zh' | 'en'): Record<string, string> {
  const url = new URL(`../packages/ui-primitives/locale/ui.${name}.json`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, string>
}

/** 工具条目按 callId 取（一个转录里可能有多次调用）。 */
function toolEntry(transcript: Transcript, callId: string): Extract<TranscriptEntry, { kind: 'tool' }> | undefined {
  return transcript.entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool' && entry.call.callId === callId,
  )
}

/** 造一轮：用户说话 → 模型调一次工具（bash）→ 轮到给定原因收尾，工具始终没有结果。 */
function turnWithRunningTool(reason: 'aborted' | 'error' | 'completed'): Transcript {
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: '跑一下构建' })
  transcript.reduce({ type: 'turn/start' })
  transcript.reduce({ type: 'message', text: '先跑一轮构建。', reasoning: '先想一下。' })
  transcript.reduce({ type: 'tool/call', callId: 'call_bash', name: 'bash', args: '{"command":"pnpm build"}' })
  transcript.reduce({ type: 'turn/end', reason })
  return transcript
}

describe('① 实时：turn/end reason = aborted，没结果的工具不再「进行中」', () => {
  test('工具行还在（不是被删掉）', () => {
    expect(toolEntry(turnWithRunningTool('aborted'), 'call_bash')).toBeDefined()
  })

  test('状态不再是 running', () => {
    expect(toolEntry(turnWithRunningTool('aborted'), 'call_bash')?.call.status).not.toBe('running')
  })

  test('落成中止态 aborted（不是 failed：中断不是工具的错）', () => {
    expect(toolEntry(turnWithRunningTool('aborted'), 'call_bash')?.call.status).toBe('aborted')
  })

  test('工具名与参数原样保留', () => {
    const entry = toolEntry(turnWithRunningTool('aborted'), 'call_bash')
    expect(entry?.call.name).toBe('bash')
    expect(entry?.call.argsText).toBe('{"command":"pnpm build"}')
  })

  test('这一轮的中断标记照旧落成条目', () => {
    expect(turnWithRunningTool('aborted').entries.some((entry) => entry.kind === 'turn-end' && entry.reason === 'aborted')).toBe(true)
  })

  test('思考与正文不受影响', () => {
    const transcript = turnWithRunningTool('aborted')
    expect(transcript.entries.filter((entry) => entry.kind === 'thinking')).toHaveLength(1)
    expect(transcript.entries.filter((entry) => entry.kind === 'text')).toHaveLength(1)
  })
})

describe('② 实时：turn/end reason = error 同样落定（这一轮被放弃，不是工具的错）', () => {
  test('跑挂的轮里没结果的工具落成 aborted', () => {
    expect(toolEntry(turnWithRunningTool('error'), 'call_bash')?.call.status).toBe('aborted')
  })
})

describe('③ 真失败与真完成不受影响', () => {
  /** 工具自己抛错（tool-error）：这才是 failed——要排查的那一档。 */
  function brokenTurn(): Transcript {
    const broken = new Transcript()
    broken.reduce({ type: 'user', text: '跑一下构建' })
    broken.reduce({ type: 'tool/call', callId: 'call_x', name: 'bash', args: '{"command":"pnpm build"}' })
    broken.reduce({ type: 'tool/result', callId: 'call_x', text: '命令超时（30000ms）', error: 'tool-error' })
    broken.reduce({ type: 'turn/end', reason: 'aborted' })
    return broken
  }

  test('工具自己抛错仍是 failed（不会被收尾改成 aborted）', () => {
    expect(toolEntry(brokenTurn(), 'call_x')?.call.status).toBe('failed')
  })

  test('失败结果正文原样留着', () => {
    expect(toolEntry(brokenTurn(), 'call_x')?.call.resultText).toBe('命令超时（30000ms）')
  })

  test('正常结束（completed）的轮：有结果的工具仍是 done，结果正文原样留着', () => {
    const transcript = new Transcript()
    transcript.reduce({ type: 'user', text: '读一眼' })
    transcript.reduce({ type: 'turn/start' })
    transcript.reduce({ type: 'message', text: '读一下。', reasoning: '' })
    transcript.reduce({ type: 'tool/call', callId: 'call_read', name: 'read', args: '{"path":"a.ts"}' })
    transcript.reduce({ type: 'tool/result', callId: 'call_read', text: '内容' })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })
    // 一条工具行、两个读数：先说它还是 done，再说结果没被截掉。
    expect(toolEntry(transcript, 'call_read')?.call.status).toBe('done')
    expect(toolEntry(transcript, 'call_read')?.call.resultText).toBe('内容')
  })

  test('正常结束不多出 turn-end 条目', () => {
    const transcript = turnWithRunningTool('completed')
    expect(transcript.entries.some((entry) => entry.kind === 'turn-end')).toBe(false)
  })

  test('被用户拒绝审批的工具保持 rejected（不是「没跑完」）', () => {
    const rejected = new Transcript()
    rejected.reduce({ type: 'user', text: '删掉它' })
    rejected.reduce({ type: 'tool/call', callId: 'call_rm', name: 'bash', args: '{}' })
    rejected.reduce({ type: 'tool/result', callId: 'call_rm', text: '用户拒绝了这次工具调用。', error: 'rejected' })
    rejected.reduce({ type: 'turn/end', reason: 'completed' })
    expect(toolEntry(rejected, 'call_rm')?.call.status).toBe('rejected')
  })
})

describe('④ 恢复旧会话：重放只复原，由宿主的回合状态落定', () => {
  /** 一条「模型调了 bash、还没等到结果」的历史（被中断那一轮的形状）。 */
  const MESSAGES: ChatMessage[] = [
    { role: 'user', content: '跑一下构建' },
    {
      role: 'assistant',
      content: '先跑一轮构建。',
      reasoning_content: '先想一下。',
      tool_calls: [{ id: 'call_bash', type: 'function', function: { name: 'bash', arguments: '{"command":"pnpm build"}' } }],
    },
  ]

  test('重放里没有结果的工具不再停在 running', () => {
    const live = new Transcript()
    live.replayHistory(MESSAGES)
    expect(toolEntry(live, 'call_bash')?.call.status).not.toBe('running')
  })

  test('宿主说这一轮还在跑 ⇒ 放回 running（切回正在跑工具的会话不会被误杀）', () => {
    const live = new Transcript()
    live.replayHistory(MESSAGES)
    live.seedTurnState(true)
    expect(toolEntry(live, 'call_bash')?.call.status).toBe('running')
  })

  test('被中断后重开：宿主说不在跑 ⇒ 重开后不再是「进行中」，落成 aborted', () => {
    const restored = new Transcript()
    restored.replayHistory(MESSAGES)
    restored.seedTurnState(false)
    expect(toolEntry(restored, 'call_bash')?.call.status).toBe('aborted')
  })

  test('重放出来的工具名与参数还在', () => {
    const restored = new Transcript()
    restored.replayHistory(MESSAGES)
    restored.seedTurnState(false)
    const entry = toolEntry(restored, 'call_bash')
    expect(entry?.call.name).toBe('bash')
    expect(entry?.call.argsText).toBe('{"command":"pnpm build"}')
  })

  test('正常结束的旧会话：工具是 done，seedTurnState(false) 之后仍是 done', () => {
    const normal = new Transcript()
    normal.replayHistory([...MESSAGES, { role: 'tool', content: 'build ok', tool_call_id: 'call_bash' }])
    expect(toolEntry(normal, 'call_bash')?.call.status).toBe('done')
    normal.seedTurnState(false)
    // 恢复后把「有结果的那条」当成中止，会让每次重开旧会话都把跑完的工具改写成「已中断」。
    expect(toolEntry(normal, 'call_bash')?.call.status).toBe('done')
  })
})

describe('⑤ 一次收尾把「同一会话里所有挂着的」都落定，不受条数影响', () => {
  /** 并行两个工具：a 有结果、b 没有，然后这一轮被中断。 */
  function parallelTurn(): Transcript {
    const transcript = new Transcript()
    transcript.reduce({ type: 'user', text: '并行跑两个' })
    transcript.reduce({ type: 'tool/call', callId: 'a', name: 'bash', args: '{}' })
    transcript.reduce({ type: 'tool/call', callId: 'b', name: 'read', args: '{}' })
    transcript.reduce({ type: 'tool/result', callId: 'a', text: 'ok' })
    transcript.reduce({ type: 'turn/end', reason: 'aborted' })
    return transcript
  }

  test('有结果的那条保持 done', () => {
    expect(toolEntry(parallelTurn(), 'a')?.call.status).toBe('done')
  })

  test('没结果的那条落成 aborted', () => {
    expect(toolEntry(parallelTurn(), 'b')?.call.status).toBe('aborted')
  })
})

describe('⑥ 状态词：中断与失败是两个词条（数据表，不是源码文本）', () => {
  test('中文词条：aborted = 已中断', () => {
    expect(locale('zh')['primitives.tool.status.aborted']).toBe('已中断')
  })

  test('英文词条：aborted = Stopped', () => {
    expect(locale('en')['primitives.tool.status.aborted']).toBe('Stopped')
  })

  test('中断与失败仍是两个词条（失败 = 失败 / Failed）', () => {
    expect(locale('zh')['primitives.tool.status.failed']).toBe('失败')
    expect(locale('en')['primitives.tool.status.failed']).toBe('Failed')
  })
})
