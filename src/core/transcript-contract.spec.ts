/**
 * transcript 契约：一串 core 事件 → `getSnapshot()` 的条目 / 直播尾 / 状态行形状。
 *
 * ## 钉的是什么
 *
 * `TranscriptEntry` 联合类型有十四种成员。本文件把每一种都喂真事件走一遍，用
 * `toStrictEqual` 钉**整对象**（键全集、值、顺序），并钉快照自身的键集与状态行的字段集。
 * 失去某个可选字段、改了一个字段名、把负 id 改成正 id，都会在这里红。
 *
 * ## 与既有 spec 的分工
 *
 * - `adapter/transcript.spec.ts`：只钉上下文注入卡的**合并算法**（同轮 A/A/A、跨轮不合并）。
 *   本文件只验「合并后条目上出现了 `count`」这一条形状事实，不重做合并语义。
 * - `adapter/transcript-replay.spec.ts`：只钉老日志里 null 工具名的修复。
 * - `packages/transcript/tests/replay-redundant.spec.ts`：只钉「重放判等是否冗余」。
 * - `tests/integration/transcript-*.int.spec.ts`：各自钉一条现场行为（归属隔离、usage、
 *   重试提示回放……）。本文件不装配内核、不碰磁盘，只锁投影层对外的形状。
 *
 * ## 改契约时应当红在哪
 *
 * 任何一条快照契约变更（新增/删除/改名条目字段、改 id 发号规则、改状态行字段）都应
 * 让这里对应的 `toStrictEqual` 红；只在内部实现变化而对外形状不变时，这里必须保持绿。
 * 反向验证：把 adapter 里 `tool/call` 的 `status: 'running'` 临时改成 `'done'`，本文件
 * 「事件流整序列」一条应当红。
 *
 * @module dsc/core/transcript-contract.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AsyncInboxItem, SessionNotice, SessionTranscriptMark } from './session.js'
import type { ChatMessage } from './llm.js'
import type { CoreEvent } from './events.js'
import type { FileChangeSummary } from './tools.js'
import type {
  ContextInjectionView,
  PlanView,
  RuntimeSnapshot,
  SubagentCardView,
  SystemPromptView,
  ToolPresentationView,
  TranscriptEntry,
} from '../contract.js'
import { SUMMARY_BANNER } from './compact-anchors.js'
import { transcriptPlugin } from '../packages/transcript/index.js'

/** 假会话：只实现 `getSnapshot()` 真正读到的那些成员。 */
interface FakeSession {
  messages: ChatMessage[]
  toolErrors: Map<string, string>
  fileChanges: Map<string, FileChangeSummary[]>
  presentations: Map<string, ToolPresentationView>
  asyncInbox(): AsyncInboxItem[]
  notices(): SessionNotice[]
  marks(): SessionTranscriptMark[]
  meta: { id: string; cwd: string }
  filePath: string
}

/** 转录服务面上本文件用到的成员。 */
interface TranscriptServiceLike {
  emit(event: CoreEvent, owner?: string): void
  system(text: string, level?: 'info' | 'error', command?: boolean, owner?: string): void
  plan(view: PlanView, owner?: string): void
  touch(): void
  getSnapshot(): RuntimeSnapshot
}

/** 快照里 `surfaces` 的假实现：只提供 transcript 会读的 `pendingApproval`。 */
interface FakeSurfaces {
  pendingApproval: unknown
}

/**
 * 用一个假 ctx 跑真插件，拿到 `getSnapshot()`。
 *
 * 为什么不直接 `new Transcript()`：快照的另一半（`entries = 定稿 + liveEntries`、状态行、
 * 收件箱分面）在插件里组装。契约要钉的是界面真正拿到的那份对象。
 */
function mount(): {
  session: FakeSession
  surfaces: FakeSurfaces
  handlers: Map<string, (...args: unknown[]) => void>
  service: TranscriptServiceLike
} {
  const session: FakeSession = {
    messages: [],
    toolErrors: new Map(),
    fileChanges: new Map(),
    presentations: new Map(),
    asyncInbox: () => [],
    notices: () => [],
    marks: () => [],
    meta: { id: 'sess-1', cwd: 'D:\\ws' },
    filePath: 'D:\\ws\\s.jsonl',
  }
  const surfaces: FakeSurfaces = { pendingApproval: null }
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const provided = new Map<string, unknown>()
  const ctx = {
    on(name: string, handler: (...args: unknown[]) => void) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    provide(name: string, value: unknown) {
      provided.set(name, value)
    },
    // team / agent 是可选服务：本文件不装，按「整个没挂」返回 undefined。
    get: () => undefined,
    session: { current: () => session, sessions: [], loading: false },
    llm: { provider: 'test', model: 'm', effort: 'medium', contextWindow: 100_000 },
    surfaces: { build: () => surfaces },
  }
  transcriptPlugin.apply(ctx as unknown as Context, {})
  return {
    session,
    surfaces,
    handlers,
    service: provided.get('transcript') as TranscriptServiceLike,
  }
}

/** 一段真实的 `FileChangeSummary`：与 `tool/changes` / `turn/diff` 事件同形。 */
const CHANGE: FileChangeSummary = {
  path: 'D:\\ws\\a.ts',
  added: 1,
  removed: 1,
  hunks: [
    {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [
        { kind: 'remove', text: 'a', oldLine: 1, newLine: null },
        { kind: 'add', text: 'b', oldLine: null, newLine: 1 },
      ],
    },
  ],
  status: 'modified',
}

/** 一张子代理卡：可选字段全给，钉的是「这些键都在、类型都对」。 */
const SUBAGENT: SubagentCardView = {
  name: 'mate',
  role: 'reviewer',
  task: '看看这段',
  state: 'working',
  mode: 'continuable',
  model: 'm',
  rounds: 1,
  toolCalls: 2,
  startedAt: 3900,
  lastTool: { name: 'read', args: '{}', status: 'running' },
  outputLines: ['第一行'],
  tokens: 12,
  file: 'D:\\ws\\mate.jsonl',
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('① 事件流整序列：user → reasoning → assistant → tool → usage → turn/end', () => {
  test('条目顺序、正 id、字段全集与可选字段的缺席/在场都逐条钉住', () => {
    vi.setSystemTime(1000)
    const { service } = mount()

    service.emit({ type: 'user', text: '你好' })
    vi.setSystemTime(1100)
    service.emit({ type: 'delta', kind: 'reasoning', text: '想' })
    vi.setSystemTime(1300)
    // 只发定稿、不发 text delta：这样思考耗时从第一口 reasoning 算到定稿（1300-1100）。
    service.emit({ type: 'message', text: '答', reasoning: '想' })
    vi.setSystemTime(1400)
    service.emit({ type: 'tool/call', callId: 'c1', name: 'read', args: '{"p":1}' })
    vi.setSystemTime(1500)
    service.emit({ type: 'tool/result', callId: 'c1', text: 'ok' })
    vi.setSystemTime(1600)
    service.emit({ type: 'usage', inputTokens: 10, outputTokens: 4 })
    vi.setSystemTime(1700)
    service.emit({ type: 'turn/end', reason: 'aborted' })

    const expected: TranscriptEntry[] = [
      { kind: 'user', id: 1, text: '你好', ts: 1000 },
      { kind: 'thinking', id: 2, text: '想', ts: 1300, durationMs: 200 },
      // tool/call 当场把紧邻的正文标成「调工具前的前言」。
      { kind: 'text', id: 3, text: '答', ts: 1300, process: true },
      {
        kind: 'tool',
        id: 4,
        call: {
          callId: 'c1',
          name: 'read',
          argsText: '{"p":1}',
          status: 'done',
          startedAt: 1400,
          durationMs: 100,
          resultText: 'ok',
        },
        ts: 1500,
        // turn/end 把本轮累计补写在最后一条能挂 usage 的条目（工具卡）上。
        usage: { inputTokens: 10, outputTokens: 4 },
      },
      { kind: 'turn-end', id: 5, reason: 'aborted', ts: 1700 },
    ]
    expect(service.getSnapshot().entries).toStrictEqual(expected)
  })
})

describe('② 直播尾与「准备中」工具：负 id、顺序、定稿后的接力', () => {
  test('直播尾按到达顺序发负 id；准备中的工具接在最后，tool/call 到达时领正 id 并继承时刻', () => {
    vi.setSystemTime(2000)
    const { service } = mount()

    service.emit({ type: 'delta', kind: 'reasoning', text: '想' })
    vi.setSystemTime(2100)
    service.emit({ type: 'delta', kind: 'text', text: '答' })

    // 快照 = 定稿条目 + liveEntries；此刻还没有定稿条目。
    expect(service.getSnapshot().entries).toStrictEqual([
      // 思考段的 ts 是最后一口 delta 的时刻（2000），durationMs 是「已思考多久」。
      { kind: 'thinking', id: -1, text: '想', ts: 2000, durationMs: 100 },
      { kind: 'text', id: -2, text: '答', ts: 2100 },
    ])

    vi.setSystemTime(2200)
    service.emit({ type: 'tool/prepare', name: 'read' })
    expect(service.getSnapshot().entries).toStrictEqual([
      { kind: 'thinking', id: -1, text: '想', ts: 2000, durationMs: 200 },
      // tool/prepare 把正在流的正文标成过程行（小字灰行），标记跟着直播段走。
      { kind: 'text', id: -2, text: '答', ts: 2100, process: true },
      {
        kind: 'tool',
        id: -3,
        call: { callId: '', name: 'read', argsText: '', status: 'preparing' },
        ts: 2200,
      },
    ])

    vi.setSystemTime(2300)
    service.emit({ type: 'tool/call', callId: 'c1', name: 'read', args: '{}' })
    // 定稿：直播尾清空，工具卡领正 id；条目 ts 继承「准备中」那一刻，startedAt 是发起时刻。
    expect(service.getSnapshot().entries).toStrictEqual([
      {
        kind: 'tool',
        id: 1,
        call: {
          callId: 'c1',
          name: 'read',
          argsText: '{}',
          status: 'running',
          startedAt: 2300,
        },
        ts: 2200,
      },
    ])
  })
})

describe('③ 提示卡、注入卡、计划卡', () => {
  test('system-prompt / context-injection / plan 的字段全集', () => {
    vi.setSystemTime(3000)
    const { service } = mount()
    const prompt: SystemPromptView = {
      hash: 'h1',
      chars: 12,
      sections: [{ id: 'identity', order: 0, chars: 12, from: 'core' }],
      model: 'm',
    }
    const parts: ContextInjectionView[] = [
      { kind: 'mode', source: 'mode', where: 'system', chars: 3, preview: '模式' },
    ]
    const plan: PlanView = { file: 'D:\\ws\\p.md', title: '计划', text: '# 计划', decision: 'pending' }

    service.emit({ type: 'prompt/used', prompt })
    service.emit({ type: 'context/injected', parts })
    // 同一轮重复上报：原地把次数 +1，id 与 parts 不变。
    service.emit({ type: 'context/injected', parts })
    vi.setSystemTime(3100)
    service.plan(plan)

    expect(service.getSnapshot().entries).toStrictEqual([
      { kind: 'system-prompt', id: 1, prompt, ts: 3000 },
      { kind: 'context-injection', id: 2, parts, count: 2, ts: 3000 },
      { kind: 'plan', id: 3, plan, ts: 3100 },
    ])
  })
})

describe('④ 改动卡、聚合改动、子代理、系统行', () => {
  test('changes / turnDiff / subagent / system(command|error|compaction) 的字段全集', () => {
    vi.setSystemTime(4000)
    const { service, handlers } = mount()

    service.emit({ type: 'tool/call', callId: 'w1', name: 'write', args: '{}' })
    service.emit({ type: 'tool/changes', callId: 'w1', change: CHANGE })
    service.emit({ type: 'turn/diff', files: [CHANGE] })
    service.emit({ type: 'subagent', row: SUBAGENT })
    service.system('命令输出', 'info', true)
    service.emit({ type: 'error', message: 'boom' })
    // dsc/notice 的 'compaction' 类别 = 压缩落点（实时路径）。
    handlers.get('dsc/notice')?.('历史已压缩', 'compaction')

    expect(service.getSnapshot().entries).toStrictEqual([
      {
        kind: 'tool',
        id: 1,
        call: {
          callId: 'w1',
          name: 'write',
          argsText: '{}',
          status: 'running',
          startedAt: 4000,
          // tool/changes 按 callId 把实际改动缝回工具卡。
          change: CHANGE,
        },
        ts: 4000,
      },
      { kind: 'changes', id: 2, file: CHANGE, ts: 4000 },
      { kind: 'turnDiff', id: 3, files: [CHANGE], ts: 4000 },
      { kind: 'subagent', id: 4, sub: SUBAGENT, ts: 4000 },
      { kind: 'system', id: 5, text: '命令输出', ts: 4000, command: true },
      { kind: 'system', id: 6, text: '错误：boom', ts: 4000, level: 'error' },
      { kind: 'system', id: 7, text: '历史已压缩', ts: 4000, compaction: { count: 1 } },
    ])
  })
})

describe('⑤ 重试、长度截断、压缩摘要、轮尾', () => {
  test('model-retry 原地更新；turn-max-tokens / 压缩 user / turn-end 的字段全集', () => {
    vi.setSystemTime(5000)
    const { service } = mount()

    service.emit({ type: 'model/retry', attempt: 1, maxRetries: 5, delayMs: 1000, reason: '429' })
    // 连续重试原地更新同一条（不新长一行），id 不变。
    service.emit({ type: 'model/retry', attempt: 2, maxRetries: 5, delayMs: 2000, reason: '仍在 429' })
    service.emit({ type: 'message', text: '长', reasoning: '', finishReason: 'length' })
    service.emit({ type: 'user', text: `${SUMMARY_BANNER}摘要正文` })
    service.emit({ type: 'turn/end', reason: 'error' })

    expect(service.getSnapshot().entries).toStrictEqual([
      {
        kind: 'model-retry',
        id: 1,
        attempt: 2,
        maxRetries: 5,
        delayMs: 2000,
        text: '仍在 429',
        ts: 5000,
      },
      { kind: 'text', id: 2, text: '长', ts: 5000 },
      { kind: 'turn-max-tokens', id: 3, ts: 5000 },
      // 压缩摘要仍是一条 user 条目，只多一个 compaction 标记（第几次压缩）。
      { kind: 'user', id: 4, text: `${SUMMARY_BANNER}摘要正文`, ts: 5000, compaction: { count: 1 } },
      { kind: 'turn-end', id: 5, reason: 'error', ts: 5000 },
    ])
  })

  test('user 的四个可选标记：images / files / steering / internal', () => {
    vi.setSystemTime(5500)
    const { service } = mount()
    const files = [
      {
        sha: 'abc',
        kind: 'video' as const,
        name: 'v.mp4',
        mime: 'video/mp4',
        bytes: 10,
        path: 'D:\\ws\\v.mp4',
      },
    ]

    service.emit({ type: 'user', text: '带附件', images: ['/api/attachments/x'], files, steering: true })
    service.emit({ type: 'user', text: '机器通知', origin: 'notice' })

    expect(service.getSnapshot().entries).toStrictEqual([
      {
        kind: 'user',
        id: 1,
        text: '带附件',
        images: ['/api/attachments/x'],
        files,
        steering: true,
        ts: 5500,
      },
      { kind: 'user', id: 2, text: '机器通知', ts: 5500, internal: true },
    ])
  })
})

describe('⑥ 快照与状态行', () => {
  test('快照键集、状态行字段全集与 turnState 的四种取值', () => {
    vi.setSystemTime(6000)
    const { service, session, surfaces } = mount()

    const snapshot = service.getSnapshot()
    expect(Object.keys(snapshot).sort()).toEqual([
      'entries',
      'notices',
      'queued',
      'sessionStates',
      'sessions',
      'sessionsLoading',
      'status',
      'subagents',
      'surfaces',
    ])
    expect(snapshot.status).toStrictEqual({
      sessionId: 'sess-1',
      model: 'm',
      provider: 'test',
      effort: 'medium',
      turnState: 'idle',
      usage: { inputTokens: 0, outputTokens: 0 },
      contextWindow: 100_000,
      contextUsed: 0,
      contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0, schema: 0 },
      progress: { turns: 0, steps: 0 },
      cwd: 'D:\\ws',
      sessionPath: 'D:\\ws\\s.jsonl',
      sessionUnsaved: true,
    })
    expect(snapshot.sessions).toStrictEqual([])
    expect(snapshot.sessionsLoading).toBe(false)
    expect(snapshot.sessionStates).toStrictEqual({})
    expect(snapshot.subagents).toStrictEqual([])
    expect(snapshot.queued).toStrictEqual([])
    expect(snapshot.notices).toStrictEqual([])

    // 回合中：thinking → working；当前会话进 sessionStates。
    service.emit({ type: 'turn/start' })
    expect(service.getSnapshot().status.turnState).toBe('thinking')
    expect(service.getSnapshot().sessionStates).toStrictEqual({ 'D:\\ws\\s.jsonl': 'working' })
    service.emit({ type: 'tool/call', callId: 'c1', name: 'read', args: '{}' })
    expect(service.getSnapshot().status.turnState).toBe('working')

    // 用量、上下文占用与分段都进状态行。
    service.emit({ type: 'context', segments: { system: 1, prompt: 2, assistant: 3, thinking: 4, tools: 5, schema: 6 } })
    service.emit({ type: 'usage', inputTokens: 100, outputTokens: 50, cacheHitTokens: 10, cacheMissTokens: 20 })
    const used = service.getSnapshot().status
    expect(used.usage).toStrictEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheHitTokens: 10,
      cacheMissTokens: 20,
    })
    expect(used.contextUsed).toBe(100)
    expect(used.contextSegments).toStrictEqual({
      system: 1,
      prompt: 2,
      assistant: 3,
      thinking: 4,
      tools: 5,
      schema: 6,
    })

    // 进度按会话消息数出来（人打的 user 计轮、assistant 计步）。
    // 消息是假会话上的外部状态，改完要 touch 让快照缓存失效。
    session.messages.push({ role: 'user', content: '问' }, { role: 'assistant', content: '答' })
    service.touch()
    expect(service.getSnapshot().status.progress).toStrictEqual({ turns: 1, steps: 1 })
    expect(service.getSnapshot().status.sessionUnsaved).toBe(false)

    // 有审批挂着时优先报 awaiting-approval（surfaces 是外部服务，动完要 touch 失效缓存）。
    surfaces.pendingApproval = { id: 'a1' }
    service.touch()
    expect(service.getSnapshot().status.turnState).toBe('awaiting-approval')

    // 批掉之后回到回合的普通状态；turn/end 收尾后是 idle。
    surfaces.pendingApproval = null
    service.touch()
    service.emit({ type: 'turn/end', reason: 'completed' })
    expect(service.getSnapshot().status.turnState).toBe('idle')
  })
})
