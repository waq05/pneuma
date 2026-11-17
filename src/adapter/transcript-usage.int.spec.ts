/**
 * transcript 的「本轮累计 token」记账（迁自 `scripts/transcript-usage-test.mjs`）。
 *
 * 钉的口径：从最近一条 user 条目算起，这一轮里每一次模型请求的 `prompt_tokens` +
 * `completion_tokens` 全部累加，界面每轮页脚显示的就是这个和。多步工具轮每请求一次
 * 都要重发整份上下文，所以「轮内累加」才是用户真实的计费量——把它错记成「最后一次请求」
 * 会让页脚在工具轮里少报一大半。
 *
 * ## 为什么这些用例不产业务内核
 *
 * 记账发生在 `Transcript.reduce()` 这条纯 reducer 里：喂 `usage` / `message` / `tool/call`
 * 事件，读条目上的 `usage` 字段。起真内核反而要等真流、还会被会话标题请求插队，
 * 断言只会更脆。原探针也是这么做的（直接 `new Transcript()`），迁移保持同一接缝。
 *
 * ## 迁移时砍掉的东西
 *
 * 没有。原探针 19 条断言全部有行为接缝，逐条搬成 19 个用例（一条行为一条 test）。
 * 原探针的文件头写过「这个仓库没有测试框架，所以跑 lib/」——那句话在这里已不成立：
 * vitest 直接 import 本目录的 `./transcript.js`（经 `jsToTsFallback` 落到 `transcript.ts`），
 * 改一行源码当场可见，不用先 build。
 *
 * @module dsc/adapter/transcript-usage.int.spec
 */
import { beforeAll, describe, expect, test } from 'vitest'
import type { ChangedFileView, TranscriptEntry } from '../contract.js'
import { Transcript } from './transcript.js'

/** 取条目表里某一类的最后一条；类型跟着 kind 收窄，省掉调用方每处的断言。 */
function lastOf<K extends TranscriptEntry['kind']>(
  transcript: Transcript,
  kind: K,
): Extract<TranscriptEntry, { kind: K }> | undefined {
  const entries = transcript.entries
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind === kind) return entry as Extract<TranscriptEntry, { kind: K }>
  }
  return undefined
}

/** 条目上挂的本轮用量；没有就是 undefined（契约里只有 text / tool 两种条目带这个字段）。 */
function usageOf(entry: TranscriptEntry | undefined): { inputTokens: number; outputTokens: number } | undefined {
  if (entry === undefined) return undefined
  if (entry.kind === 'text' || entry.kind === 'tool') return entry.usage
  return undefined
}

describe('① 两轮对话：轮内累加、跨轮清零、会话累计跨轮继续', () => {
  /** 第一轮里第一次请求定稿的那条 text（那时 usage 还没到）。 */
  let textFirst: Extract<TranscriptEntry, { kind: 'text' }> | undefined
  /** 第一轮结束后整表最后一条 text。 */
  let textLast: Extract<TranscriptEntry, { kind: 'text' }> | undefined
  /** 第一轮收尾那一刻，整表的最后一条（第二轮还没开始，用来钉「那一条就是表尾」）。 */
  let entryAtRoundOneEnd: TranscriptEntry | undefined
  /** 第一轮收尾那一刻的会话累计（第二轮还没把 7/3 加进来）。 */
  let usageAtRoundOneEnd: { inputTokens: number; outputTokens: number }
  let transcript: Transcript

  beforeAll(() => {
    transcript = new Transcript()
    // 第一轮：两次请求，中间夹一次工具调用。事件顺序照 `loop.ts`：message 先、usage 后。
    transcript.reduce({ type: 'user', text: '跑个测试' })
    transcript.reduce({ type: 'turn/start' })
    transcript.reduce({ type: 'message', text: '先看一眼', reasoning: '' })
    transcript.reduce({ type: 'usage', inputTokens: 100, outputTokens: 10 })
    transcript.reduce({ type: 'tool/call', callId: 'c1', name: 'bash', args: '{}' })
    transcript.reduce({ type: 'tool/result', callId: 'c1', text: 'ok' })
    transcript.reduce({ type: 'message', text: '好了', reasoning: '' })
    transcript.reduce({ type: 'usage', inputTokens: 200, outputTokens: 20 })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })
    textFirst = transcript.entries.find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'text' }> => entry.kind === 'text' && entry.text === '先看一眼',
    )
    textLast = lastOf(transcript, 'text')
    entryAtRoundOneEnd = transcript.entries[transcript.entries.length - 1]
    usageAtRoundOneEnd = { ...transcript.usage }

    // 第二轮：模型只请求了一次，用量比第一轮小得多。
    transcript.reduce({ type: 'user', text: '再来一轮' })
    transcript.reduce({ type: 'turn/start' })
    transcript.reduce({ type: 'message', text: '这轮更省', reasoning: '' })
    transcript.reduce({ type: 'usage', inputTokens: 7, outputTokens: 3 })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })
  })

  test('一轮两次 usage 全累加到轮内最后一条 text', () => {
    // 100+10 与 200+20 两笔都要在：只记最后一笔会少报第一段工具轮的花销。
    expect(usageOf(textLast)).toEqual({ inputTokens: 300, outputTokens: 30 })
  })

  test('轮内最后一条 text 就是整表最后一条', () => {
    // 取的是第一轮收尾那一刻的表尾：第二轮此刻还没发生，这一条才有意义。
    expect(entryAtRoundOneEnd).toBe(textLast)
  })

  test('第一次请求定稿时还没有 usage 事件，那条 text 就不带 usage', () => {
    // 「还没数」与「这一轮真的一分没花」是两件事，靠字段在不在区分：硬写 {0,0} 就分不开了。
    expect(textFirst).toBeDefined()
    expect(Object.hasOwn(textFirst!, 'usage')).toBe(false)
  })

  test('新用户消息后本轮累计清零，下一轮只带下一轮的数', () => {
    const textRound2 = lastOf(transcript, 'text')
    expect(textRound2?.text).toBe('这轮更省')
    expect(usageOf(textRound2)).toEqual({ inputTokens: 7, outputTokens: 3 })
  })

  test('上一轮的条目数字不动（不会被这一轮覆盖）', () => {
    expect(usageOf(transcript.entries.find((entry) => entry.kind === 'text' && entry.text === '好了'))).toEqual({
      inputTokens: 300,
      outputTokens: 30,
    })
  })

  test('会话累计同时照记（第一轮结束时 300+30）', () => {
    // 条目上的数是「给这一行看的」，会话累计是「给状态栏看的」，两者是两份账，都要对。
    expect(usageAtRoundOneEnd).toEqual({ inputTokens: 300, outputTokens: 30 })
  })

  test('会话累计跨轮继续累加', () => {
    expect(transcript.usage).toEqual({ inputTokens: 307, outputTokens: 33 })
  })
})

describe('② message 定稿那一刻就盖上当时的累计（界面轮中就能看到涨）', () => {
  test('一次 usage 事件都没来时，定稿的 text 不带 usage 字段', () => {
    const live = new Transcript()
    live.reduce({ type: 'user', text: '就一问' })
    live.reduce({ type: 'message', text: '答', reasoning: '' })
    expect(live.entries[1]).toBeDefined()
    expect(Object.hasOwn(live.entries[1]!, 'usage')).toBe(false)
  })

  test('同轮第二次定稿并进上一条 text，并盖上当时已累计的 usage', () => {
    const live = new Transcript()
    live.reduce({ type: 'user', text: '就一问' })
    live.reduce({ type: 'message', text: '答', reasoning: '' })
    live.reduce({ type: 'usage', inputTokens: 9, outputTokens: 1 })
    live.reduce({ type: 'message', text: '补充', reasoning: '' })
    // 同一轮的两段正文合成一条 text：中间那次请求的用量必须跟到合并后的那一行上。
    expect(live.entries).toHaveLength(2)
    expect(usageOf(live.entries[1])).toEqual({ inputTokens: 9, outputTokens: 1 })
  })
})

describe('③ 一轮以工具结果收尾（没有最终正文）时，数字落到 tool 卡上', () => {
  test('本轮累计挂到 tool 卡，不因为最后一条不是 text 就丢掉', () => {
    const aborted = new Transcript()
    aborted.reduce({ type: 'user', text: '读文件' })
    aborted.reduce({ type: 'turn/start' })
    aborted.reduce({ type: 'message', text: '', reasoning: '' })
    aborted.reduce({ type: 'tool/call', callId: 'c2', name: 'read', args: '{}' })
    aborted.reduce({ type: 'usage', inputTokens: 50, outputTokens: 5 })
    aborted.reduce({ type: 'tool/result', callId: 'c2', text: '内容' })
    aborted.reduce({ type: 'turn/end', reason: 'aborted' })
    expect(usageOf(lastOf(aborted, 'tool'))).toEqual({ inputTokens: 50, outputTokens: 5 })
  })
})

describe('④ 老会话重放：日志里不存每次请求的用量，条目一律不带 usage', () => {
  /** 一条正常的四段历史：user → assistant(带工具调用) → tool → assistant。 */
  const HISTORY: Parameters<Transcript['replayHistory']>[0] = [
    { role: 'user', content: '老会话' },
    {
      role: 'assistant',
      content: '看下文件',
      tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c9', content: '文件内容' },
    { role: 'assistant', content: '收尾' },
  ]

  test('条目照旧产出（user/text/tool/text 四条）', () => {
    const old = new Transcript()
    old.replayHistory(HISTORY)
    expect(old.entries.map((entry) => entry.kind)).toEqual(['user', 'text', 'tool', 'text'])
  })

  test('没有任何条目带 usage 字段（编不出历史用量就不编）', () => {
    const old = new Transcript()
    old.replayHistory(HISTORY)
    // 编一个数出来会让页脚显示一份假账单，比不显示更坏。
    expect(old.entries.every((entry) => !Object.hasOwn(entry, 'usage'))).toBe(true)
  })
})

describe('⑤ clear()（开新会话 / 恢复会话）把本轮累计一起清掉', () => {
  test('clear() 之后新条目不带上一轮的 usage', () => {
    const aborted = new Transcript()
    aborted.reduce({ type: 'user', text: '读文件' })
    aborted.reduce({ type: 'tool/call', callId: 'c2', name: 'read', args: '{}' })
    aborted.reduce({ type: 'usage', inputTokens: 50, outputTokens: 5 })
    aborted.reduce({ type: 'tool/result', callId: 'c2', text: '内容' })
    aborted.clear()
    aborted.reduce({ type: 'user', text: '新会话' })
    aborted.reduce({ type: 'message', text: 'hi', reasoning: '' })
    aborted.reduce({ type: 'turn/end', reason: 'completed' })
    expect(aborted.entries.every((entry) => !Object.hasOwn(entry, 'usage'))).toBe(true)
  })
})

describe('⑥ 回合聚合与文件改动：实时折叠成条目，重放按日志还原', () => {
  /** 一次编辑的完整变更事实：路径 / 增删行数 / 一段 hunk。 */
  const CHANGE: ChangedFileView = {
    path: 'D:\\proj\\a.ts',
    added: 3,
    removed: 1,
    status: 'modified',
    hunks: [
      {
        oldStart: 1,
        oldCount: 4,
        newStart: 1,
        newCount: 6,
        lines: [
          { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
          { kind: 'remove', text: 'b', oldLine: 2, newLine: null },
          { kind: 'add', text: 'c', oldLine: null, newLine: 2 },
        ],
      },
    ],
  }

  /** 一轮里改一个文件的完整差异（`turn/diff` 事件的载荷形状）。 */
  const TURN_DIFF_FILES: ChangedFileView[] = [
    {
      path: 'D:/demo/a.ts',
      added: 2,
      removed: 1,
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 4,
          lines: [
            { kind: 'context', text: 'const a = 1', oldLine: 1, newLine: 1 },
            { kind: 'remove', text: 'const b = 2', oldLine: 2, newLine: null },
            { kind: 'add', text: 'const b = 20', oldLine: null, newLine: 2 },
            { kind: 'add', text: 'const c = 3', oldLine: null, newLine: 3 },
            { kind: 'context', text: 'export {}', oldLine: 3, newLine: 4 },
          ],
        },
      ],
    },
  ]

  test('turn/diff 折成 kind:turnDiff 条目，files 事实完整', () => {
    const aggregate = new Transcript()
    aggregate.reduce({ type: 'user', text: '改文件' })
    aggregate.reduce({ type: 'tool/call', callId: 'c1', name: 'edit', args: '{}' })
    aggregate.reduce({ type: 'tool/result', callId: 'c1', text: '已编辑' })
    aggregate.reduce({ type: 'turn/diff', files: TURN_DIFF_FILES })
    aggregate.reduce({ type: 'turn/end', reason: 'completed' })
    const entry = lastOf(aggregate, 'turnDiff')
    expect(entry?.files).toHaveLength(1)
    expect(entry?.files[0]).toMatchObject({ path: 'D:/demo/a.ts', added: 2, removed: 1, status: 'modified' })
    expect(entry?.files[0]?.hunks[0]?.lines).toHaveLength(5)
    // baseline（改前全文）不进条目：那是审查面板按需去取的东西，塞进每一条会把会话撑爆。
    expect(Object.hasOwn(entry!.files[0]!, 'baseline')).toBe(false)
  })

  test('重放历史不重建 turnDiff 条目（重启后回退逐刀合并）', () => {
    const replayed = new Transcript()
    replayed.replayHistory([
      { role: 'user', content: '改文件' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '已编辑' },
      { role: 'assistant', content: '完成' },
    ])
    expect(replayed.entries.every((entry) => entry.kind !== 'turnDiff')).toBe(true)
  })

  test('tool/changes 折成 kind:changes 条目，并带上完整的变更事实', () => {
    const changes = new Transcript()
    changes.reduce({ type: 'user', text: '改一下' })
    changes.reduce({ type: 'tool/call', callId: 'cw', name: 'edit', args: '{}' })
    changes.reduce({ type: 'tool/result', callId: 'cw', text: '已编辑' })
    changes.reduce({ type: 'tool/changes', callId: 'cw', change: CHANGE })
    const entry = changes.entries.find((item) => item.kind === 'changes')
    expect(entry).toBeDefined()
    expect(entry?.kind === 'changes' ? entry.file : undefined).toEqual(CHANGE)
  })

  test('重放经 fileChanges 还原出同样的 changes 条目', () => {
    const replay = new Transcript()
    replay.replayHistory(
      [
        { role: 'user', content: '改一下' },
        { role: 'assistant', content: '好的', tool_calls: [{ id: 'cw', type: 'function', function: { name: 'edit', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'cw', content: '已编辑' },
        { role: 'assistant', content: '改完了' },
      ],
      new Map(),
      // 一次调用可能改多个文件（PTC 的一段脚本），所以 fileChanges 的值是数组。
      new Map([['cw', [CHANGE]]]),
    )
    expect(replay.entries.some((entry) => entry.kind === 'changes')).toBe(true)
  })

  test('老会话日志没有变更数据就不出 changes 条目', () => {
    const noChanges = new Transcript()
    noChanges.replayHistory([{ role: 'user', content: '老会话' }])
    expect(noChanges.entries.some((entry) => entry.kind === 'changes')).toBe(false)
  })
})
