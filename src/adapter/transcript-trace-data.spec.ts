/**
 * 轨迹页的两块数据：工具起止时刻与压缩落点（迁自 `scripts/trace-data-test.mjs` 第 1–7 节）。
 *
 * ## 为什么要单开一条
 *
 * 轨迹页要画「这次工具调用花了多久」与「这一轮在哪儿被压缩过」，而这两块数据在转录层是
 * 后补的、口径容易被顺手改坏：
 *
 *   1. **工具耗时**：`tool/call` 时盖 `call.startedAt`，`tool/result` 时算
 *      `call.durationMs`；done / failed / rejected 都要有——跑挂了、被拒了同样占用了那段时间。
 *      条目上的 `ts` 语义不动（仍是「最后一次写入时刻」，轮次计时靠它）。
 *   2. **压缩落点**：实时路径是 compact 插件经 `dsc/notice(text, 'compaction')` 写下的
 *      system 条目；重放路径的摘要在内存里就是一条 `role: 'user'` 的消息，靠正文的
 *      `SUMMARY_BANNER` 前缀认出来。两种落点都挂 `compaction: { count }`，kind 都不变。
 *
 * 另外两条守既有行为不被破坏：老会话重放不冒出这些新字段；实时与重放除了 id / ts / usage
 * 之外差的正是 `startedAt` / `durationMs`（这正是 `replayIsRedundant` 必须剔掉它们的原因，
 * 插件那一侧的端到端断言在 `src/packages/transcript/tests/replay-redundant.spec.ts`）。
 *
 * 归 unit：纯 `Transcript` 折叠，不碰磁盘也不起内核。
 *
 * @module dsc/adapter/transcript-trace-data.spec
 */
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '../contract.js'
import { SUMMARY_BANNER } from '../core/compact-anchors.js'
import { Transcript } from './transcript.js'

/** 工具卡条目。 */
type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>
/** 用户条目。 */
type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>
/** 系统条目。 */
type SystemEntry = Extract<TranscriptEntry, { kind: 'system' }>

/** 条目表里最后一张工具卡（按写入顺序）。 */
function lastTool(transcript: Transcript): ToolEntry | undefined {
  return [...transcript.entries].reverse().find((entry): entry is ToolEntry => entry.kind === 'tool')
}

/**
 * 复刻 `src/packages/transcript/index.ts` 里那条监听（`dsc/notice` → system 条目）：
 * 第二个参数是通知类别，`'compaction'` 表示这条通知就是压缩落点。
 */
function notice(transcript: Transcript, text: string, kind?: string): void {
  transcript.system(text, kind === 'compaction')
}

/** 摘要消息的正文（照 `core/compact.ts` 拼：横幅 + 摘要正文）。 */
const SUMMARY_TEXT = `${SUMMARY_BANNER}\n## 用户要什么\n把轨迹页的数据补齐\n## 下一步做什么\n改 adapter`

describe('① 工具耗时（实时路径）：发起时只有 startedAt，结果回来才算得出 durationMs', () => {
  /** 一条从发起到定稿的工具调用。 */
  const live = new Transcript()
  live.reduce({ type: 'user', text: '读文件' }, 900)
  live.reduce({ type: 'turn/start' }, 900)
  live.reduce({ type: 'tool/call', callId: 'c1', name: 'read', args: '{"file":"a.ts"}' }, 1000)

  test('发起时盖了 startedAt（= 当时的 ts），还没有 durationMs', () => {
    const running = lastTool(live)
    expect(running?.call.startedAt).toBe(1000)
    expect(running === undefined ? null : Object.hasOwn(running.call, 'durationMs')).toBe(false)
  })

  test('running 阶段条目 ts 就是发起时刻', () => {
    expect(lastTool(live)?.ts).toBe(1000)
  })

  test('起止时刻挂在工具卡上，不在条目顶层', () => {
    const running = lastTool(live)
    expect(running === undefined ? null : Object.hasOwn(running, 'startedAt')).toBe(false)
    expect(running === undefined ? null : Object.hasOwn(running, 'durationMs')).toBe(false)
  })

  test('结果回来后 startedAt 保持 1000、durationMs = 250', () => {
    live.reduce({ type: 'tool/result', callId: 'c1', text: '文件内容' }, 1250)
    const done = lastTool(live)
    expect(done?.call.startedAt).toBe(1000)
    expect(done?.call.durationMs).toBe(250)
  })

  test('条目 ts 刷新成结果时刻（stamp 语义没动，轮次计时仍准）', () => {
    expect(lastTool(live)?.ts).toBe(1250)
  })

  test('status = done', () => {
    expect(lastTool(live)?.call.status).toBe('done')
  })
})

describe('② failed / rejected 同样有耗时：跑挂了、被拒了也占用了这段时间', () => {
  test('failed 路径也有 startedAt / durationMs', () => {
    const broken = new Transcript()
    broken.reduce({ type: 'tool/call', callId: 'f1', name: 'bash', args: '{}' }, 2000)
    broken.reduce({ type: 'tool/result', callId: 'f1', text: 'ENOENT: 文件没找到', error: 'tool-error' }, 2500)
    const failed = lastTool(broken)
    expect(failed?.call.status).toBe('failed')
    expect(failed?.call.startedAt).toBe(2000)
    expect(failed?.call.durationMs).toBe(500)
  })

  test('rejected 路径也有耗时（400 → 100ms）', () => {
    const denied = new Transcript()
    denied.reduce({ type: 'tool/call', callId: 'r1', name: 'bash', args: '{}' }, 3000)
    denied.reduce({ type: 'tool/result', callId: 'r1', text: '用户拒绝了这次调用', error: 'rejected' }, 3100)
    const rejected = lastTool(denied)
    expect(rejected?.call.status).toBe('rejected')
    expect(rejected?.call.startedAt).toBe(3000)
    expect(rejected?.call.durationMs).toBe(100)
  })
})

describe('③ 重放带时间的日志：起止时刻从消息时间复算', () => {
  /** 一份带 ts 的三条消息（调用消息 1100、结果消息 1400）。 */
  const replayNew = new Transcript()
  replayNew.replayHistory([
    { role: 'user', content: '读文件', ts: 900 },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{}' } }],
      ts: 1100,
    },
    { role: 'tool', tool_call_id: 'c9', content: '文件内容', ts: 1400 },
  ])

  test('startedAt = 调用消息的时刻、durationMs = 结果时刻 − 发起时刻', () => {
    const replayed = lastTool(replayNew)
    expect(replayed?.call.startedAt).toBe(1100)
    expect(replayed?.call.durationMs).toBe(300)
  })

  test('重放出来的耗时不会等于「现在」（不拿现场时钟冒充历史）', () => {
    expect(lastTool(replayNew)?.call.durationMs).toBe(300)
  })
})

describe('④ 压缩落点（实时）：带 compaction 类别的通知落成带标记的 system 条目', () => {
  /** 四条通知：首尾普通、中间两条压缩。 */
  const liveCompact = new Transcript()
  notice(liveCompact, '会话 aaaaaaaa（模型 test/test）')
  notice(liveCompact, '上下文已压缩（任务清单与目标原样保留）', 'compaction')
  notice(liveCompact, '上下文超出模型窗口：已自动压缩历史并重试', 'compaction')
  notice(liveCompact, '历史不长，无需压缩')

  test('普通通知不带压缩标记', () => {
    const [first, , , last] = liveCompact.entries
    expect(first === undefined ? null : Object.hasOwn(first, 'compaction')).toBe(false)
    expect(last === undefined ? null : Object.hasOwn(last, 'compaction')).toBe(false)
  })

  test('压缩通知带 compaction.count = 1，kind 仍是 system、正文原样', () => {
    const entry = liveCompact.entries[1]
    expect(entry?.kind).toBe('system')
    expect((entry as SystemEntry | undefined)?.compaction?.count).toBe(1)
    expect((entry as SystemEntry | undefined)?.text).toBe('上下文已压缩（任务清单与目标原样保留）')
  })

  test('第二次压缩 count = 2', () => {
    expect((liveCompact.entries[2] as SystemEntry | undefined)?.compaction?.count).toBe(2)
  })
})

describe('⑤ 压缩落点（重放）：摘要消息靠正文横幅前缀认出来，kind 与正文都不动', () => {
  /** 摘要消息 + 回答 + 真用户消息。 */
  const replayCompact = new Transcript()
  replayCompact.replayHistory([
    { role: 'user', content: SUMMARY_TEXT, ts: 5000 },
    { role: 'assistant', content: '接着干', ts: 5100 },
    { role: 'user', content: '继续', ts: 5200 },
  ])

  test('重放摘要消息被认成压缩落点，count = 1', () => {
    const entry = replayCompact.entries[0]
    expect(entry?.kind).toBe('user')
    expect((entry as UserEntry | undefined)?.compaction?.count).toBe(1)
  })

  test('摘要正文一字不动（「对话」页的气泡内容不会丢）', () => {
    expect((replayCompact.entries[0] as UserEntry | undefined)?.text).toBe(SUMMARY_TEXT)
  })

  test('真用户消息不会被误标成压缩', () => {
    const entry = replayCompact.entries[2]
    expect(entry === undefined ? null : Object.hasOwn(entry, 'compaction')).toBe(false)
  })
})

describe('⑥ 老会话（2026-09 之前的日志：没有时间、没有压缩标记）重放', () => {
  /** 四条消息、没有 ts。 */
  const legacy = new Transcript()
  legacy.replayHistory([
    { role: 'user', content: '老会话' },
    {
      role: 'assistant',
      content: '看下文件',
      tool_calls: [{ id: 'c0', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c0', content: '文件内容' },
    { role: 'assistant', content: '收尾' },
  ])

  test('条目照旧产出四条', () => {
    expect(legacy.entries).toHaveLength(4)
  })

  test('工具卡不带 startedAt / durationMs（算不出耗时就不编）', () => {
    const tools = legacy.entries.filter((entry): entry is ToolEntry => entry.kind === 'tool')
    expect(tools).toHaveLength(1)
    for (const tool of tools) {
      expect(Object.hasOwn(tool.call, 'startedAt')).toBe(false)
      expect(Object.hasOwn(tool.call, 'durationMs')).toBe(false)
    }
  })

  test('没有任何条目带压缩标记', () => {
    for (const entry of legacy.entries) expect(Object.hasOwn(entry, 'compaction')).toBe(false)
  })
})

describe('⑦ 反证：两条路径差的正是 startedAt / durationMs', () => {
  /** 实时路径：现场时钟。 */
  const fieldLive = new Transcript()
  fieldLive.reduce({ type: 'message', text: '看下文件', reasoning: '' })
  fieldLive.reduce({ type: 'tool/call', callId: 'c9', name: 'read', args: '{}' })
  fieldLive.reduce({ type: 'tool/result', callId: 'c9', text: '文件内容' })

  /** 重放路径：日志时刻。 */
  const fieldProbe = new Transcript()
  fieldProbe.replayHistory([
    {
      role: 'assistant',
      content: '看下文件',
      tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{}' } }],
      ts: 1100,
    },
    { role: 'tool', tool_call_id: 'c9', content: '文件内容', ts: 1400 },
  ])

  /** 照 `shape()` 剔掉 id / ts / usage，但故意不剔 startedAt / durationMs。 */
  function stripApart(entries: readonly TranscriptEntry[]): string {
    return JSON.stringify(
      entries.map((entry) => {
        const rest = { ...entry } as Record<string, unknown>
        delete rest['id']
        delete rest['ts']
        delete rest['usage']
        return rest
      }),
    )
  }

  test('两条路径都产出了 startedAt / durationMs', () => {
    const liveTool = fieldLive.entries[1]
    const probeTool = fieldProbe.entries[1]
    expect(liveTool?.kind === 'tool' ? typeof liveTool.call.startedAt : null).toBe('number')
    expect(liveTool?.kind === 'tool' ? typeof liveTool.call.durationMs : null).toBe('number')
    expect(probeTool?.kind === 'tool' ? probeTool.call.startedAt : null).toBe(1100)
    expect(probeTool?.kind === 'tool' ? probeTool.call.durationMs : null).toBe(300)
  })

  test('不剔这两项时两边形状不同（实时记到达时刻、重放记落盘时刻）', () => {
    expect(stripApart(fieldLive.entries)).not.toBe(stripApart(fieldProbe.entries))
  })
})
