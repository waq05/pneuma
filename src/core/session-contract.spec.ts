/**
 * session 契约：会话事件写进 jsonl 的记录形状，以及「写下去 → 读回来」的对称性。
 *
 * ## 钉的是什么
 *
 * 1. 写入侧：`Session` 每个公开写入方法落盘的记录——`meta` / `user` / `assistant` /
 *    `tool` / `state` / `note` / `notice` / `summary` / `rewind`——的**键全集与值**；
 * 2. 读回侧：`Session.load()` 重放同一份日志后，协议消息、工具旁路（`toolErrors` /
 *    `fileChanges` / `presentations`）、状态表、备忘、提示、落位标记与写入侧逐字段一致；
 * 3. 恢复语义：`summary.keep` 的截断、`rewind.keep` 的作废、`state` 最后一条生效、
 *    第一条真实日志之前的状态记账按「meta → 攒下的 state → 这一条」落盘；
 * 4. 兼容面：老日志的 `mode` / `todo` / `plan` / `goal` 记录归位到 `state`；
 *    坏行与未知记录类型静默跳过（向前/向后兼容）。
 *
 * ## 与既有 spec 的分工
 *
 * - `core/session/session.int.spec.ts`：只钉「同一 callId 两条工具结果」的三层防护
 *   （重放去重、落库去重、请求侧清洗）。本文件不重做去重，只钉记录格式与读写对称。
 * - `tests/integration/session-replay.int.spec.ts`：走真内核的 `session.open()`，钉状态键
 *   与「重放不多写」；`session-rewind.int.spec.ts` 钉宿主侧截断链路。本文件直接用
 *   `Session` 类，不装内核，钉的是存储层对外的形状。
 * - `core/session/activity-time.int.spec.ts`：钉 `listSessions` 的时间口径与「打开不写盘」。
 * - `tests/integration/goal-persist` / `session-permission-scope` 等：各功能点的状态语义。
 *
 * ## 为什么留在 unit
 *
 * 所有用例都显式传入临时目录里的文件路径（`Session.create(cwd, file)` /
 * `Session.load(file, true)`），不经过 `sessionsRoot()`，因此不需要临时 HOME，也不起内核。
 *
 * ## 改契约时应当红在哪
 *
 * 改任一 jsonl 记录的字段名/键集 → 第 ① 组红；改读回映射 → 第 ② 组红；
 * 改 summary/rewind/state 的恢复口径 → 第 ③ 组红。反向验证：把 `appendNotice` 落盘的
 * `after` 临时删掉，第 ① 组「notice 记录」一条应当红。
 *
 * @module dsc/core/session-contract.spec
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from './llm.js'
import type { FileChangeSummary } from './tools.js'
import type { ContextInjectionView, SystemPromptView, TodoItemView, ToolPresentationView } from '../contract.js'
import { Session } from './session.js'
import { readSessionJsonl } from '../../tests/harness.js'

/** 本文件的工作目录；会话文件都显式落在这里，不碰真实 `~/.dsc`。 */
const work = mkdtempSync(join(tmpdir(), 'dsc-session-contract-'))
const WORKSPACE = join(work, 'ws')

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

/** 一份真实形状的文件改动摘要（与 `tool/changes` / `turn/diff` 事件同形）。 */
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

/** 一张 dsh 插件卡片数据（随 tool 记录落盘，恢复时经 `presentations` 还原）。 */
const PRESENTATION: ToolPresentationView = {
  call: { card: 'read' },
  result: { card: 'read' },
}

const TODOS: TodoItemView[] = [
  { id: 't1', content: '先看现场', status: 'completed' },
  { id: 't2', content: '再动手', status: 'pending' },
]

const PROMPT: SystemPromptView = {
  hash: 'h1',
  chars: 10,
  sections: [{ id: 'identity', order: 0, chars: 10, from: 'core' }],
  model: 'm',
}

const PARTS: ContextInjectionView[] = [
  { kind: 'mode', source: 'mode', where: 'system', chars: 3, preview: '模式' },
]

/** 等写流把至少 `expected` 条记录刷到盘上；等不到也返回，让断言给出可读差异。 */
async function readRecords(file: string, expected: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 3_000
  for (;;) {
    // 写流建文件是异步的：第一轮可能还没落盘（ENOENT），按空日志继续等。
    let records: Array<Record<string, unknown>>
    try {
      records = readSessionJsonl(file)
    } catch {
      records = []
    }
    if (records.length >= expected || Date.now() > deadline) return records
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** 临时会话文件路径（每个用例一份，互不影响）。 */
function fileFor(name: string): string {
  return join(work, name)
}

describe('① 写入侧：方法 → jsonl 记录的键全集与值', () => {
  test('user / assistant / tool / state / note / notice / system-prompt / context-injected 的记录形状', async () => {
    const file = fileFor('shape.jsonl')
    const session = Session.create(WORKSPACE, file)

    session.appendUser('你好')
    session.appendAssistant('收到', '想想', [{ id: 'c1', name: 'read', arguments: '{}' }])
    session.appendTool(
      'c1',
      'read',
      { text: '内容', images: ['data:image/png;base64,AA'], changes: CHANGE, presentation: PRESENTATION },
      'tool-error',
    )
    session.appendState('todos', TODOS)
    session.appendNote('lsp', '诊断')
    session.appendNotice({ kind: 'turn-error', text: '失败' })
    session.appendSystemPrompt(PROMPT, '系统提示正文')
    session.appendContextInjections(PARTS)

    const meta = session.meta
    const [userMessage, assistantMessage, toolMessage] = session.messages as [
      ChatMessage,
      ChatMessage,
      ChatMessage,
    ]
    session.close()

    const records = await readRecords(file, 9)
    expect(records.map((record) => record.type)).toEqual([
      'meta',
      'user',
      'assistant',
      'tool',
      'state',
      'note',
      'notice',
      'state',
      'state',
    ])

    // meta：首行身份（id / cwd / createdAt）。
    expect(records[0]).toStrictEqual({
      type: 'meta',
      id: meta.id,
      cwd: WORKSPACE,
      createdAt: meta.createdAt,
    })

    // user：正文 + 写入时刻（本轮计时的起点）。
    expect(records[1]).toStrictEqual({ type: 'user', text: '你好', ts: userMessage.ts })

    // assistant：正文、思考、工具调用（协议形状的 ToolCall）。
    expect(records[2]).toStrictEqual({
      type: 'assistant',
      text: '收到',
      reasoning: '想想',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
      ts: assistantMessage.ts,
    })

    // tool：结果、图片、改动、卡片数据、错误标记。
    expect(records[3]).toStrictEqual({
      type: 'tool',
      callId: 'c1',
      name: 'read',
      text: '内容',
      images: ['data:image/png;base64,AA'],
      changes: CHANGE,
      presentation: PRESENTATION,
      error: 'tool-error',
      ts: toolMessage.ts,
    })

    // state：id + 功能点自己的负载。
    expect(records[4]).toStrictEqual({ type: 'state', id: 'todos', payload: TODOS })

    // note：给模型侧留底的注入原文。
    expect(records[5]).toStrictEqual({
      type: 'note',
      id: 'lsp',
      text: '诊断',
      ts: session.notes()[0]?.ts,
    })

    // notice：提示本体 + 时刻 + 归位锚点（此刻日志里有几条消息）。
    expect(records[6]).toStrictEqual({
      type: 'notice',
      notice: { kind: 'turn-error', text: '失败' },
      ts: session.notices()[0]?.ts,
      after: 3,
    })

    // system-prompt：正文与卡片视图写在同一条 state 里，带落位锚点。
    expect(records[7]).toStrictEqual({
      type: 'state',
      id: 'system-prompt',
      payload: {
        hash: 'h1',
        text: '系统提示正文',
        after: 3,
        view: PROMPT,
        ts: session.marks()[0]?.ts,
      },
    })

    // context-injected：只记摘要清单 + 落位锚点。
    expect(records[8]).toStrictEqual({
      type: 'state',
      id: 'context-injected',
      payload: { parts: PARTS, after: 3, ts: session.marks()[1]?.ts },
    })
  })

  test('user 的可选字段：images / files / origin 一并落盘', async () => {
    const file = fileFor('user-optional.jsonl')
    const session = Session.create(WORKSPACE, file)
    const files = [
      {
        sha: 'abc',
        kind: 'video' as const,
        name: 'v.mp4',
        mime: 'video/mp4',
        bytes: 12,
        path: 'D:\\ws\\v.mp4',
      },
    ]
    session.appendUser('带附件', ['/api/attachments/x'], files, 'notice')
    const ts = session.messages[0]?.ts
    session.close()

    const records = await readRecords(file, 2)
    expect(records[1]).toStrictEqual({
      type: 'user',
      text: '带附件',
      images: ['/api/attachments/x'],
      files,
      origin: 'notice',
      ts,
    })
  })
})

describe('② 读回侧：重放与写入逐字段对称', () => {
  test('消息、工具旁路、状态、备忘、提示、落位标记全部还原', async () => {
    const file = fileFor('round-trip.jsonl')
    const session = Session.create(WORKSPACE, file)

    session.appendUser('你好')
    session.appendAssistant('收到', '想想', [{ id: 'c1', name: 'read', arguments: '{}' }])
    session.appendTool(
      'c1',
      'read',
      { text: '内容', images: ['data:image/png;base64,AA'], changes: CHANGE, presentation: PRESENTATION },
      'tool-error',
    )
    session.appendState('todos', TODOS)
    session.appendNote('lsp', '诊断')
    session.appendNotice({ kind: 'turn-error', text: '失败' })
    session.appendSystemPrompt(PROMPT, '系统提示正文')
    session.appendContextInjections(PARTS)

    const writtenMessages = structuredClone(session.messages)
    const writtenNotes = structuredClone(session.notes())
    const writtenNotices = structuredClone(session.notices())
    const writtenMarks = structuredClone(session.marks())
    session.close()

    await readRecords(file, 9)
    const restored = Session.load(file, true)
    try {
      // 协议消息：正文、思考、tool_calls、图片数组、ts 全部一致。
      expect(restored.messages).toStrictEqual(writtenMessages)

      // 工具旁路：错误标记、改动清单、卡片数据。
      expect(restored.toolErrors.get('c1')).toBe('tool-error')
      expect(restored.fileChanges.get('c1')).toStrictEqual([CHANGE])
      expect(restored.presentations.get('c1')).toStrictEqual(PRESENTATION)

      // 状态表 / 备忘 / 提示 / 落位标记。
      expect(restored.state('todos')).toStrictEqual(TODOS)
      expect(restored.state('system-prompt')).toStrictEqual(session.state('system-prompt'))
      expect(restored.state('context-injected')).toStrictEqual(session.state('context-injected'))
      expect(restored.notes()).toStrictEqual(writtenNotes)
      expect(restored.notices()).toStrictEqual(writtenNotices)
      expect(restored.marks()).toStrictEqual(writtenMarks)

      // 恢复出来的文件路径就是写进去的那一份（keepPath = true）。
      expect(restored.filePath).toBe(file)
      expect(restored.persisted).toBe(true)
    } finally {
      restored.close()
    }
  })
})

describe('③ 恢复语义', () => {
  test('第一条真实日志之前的状态记账：先攒着，meta → 攒下的 state → 这条记录', async () => {
    const file = fileFor('pending-state.jsonl')
    const session = Session.create(WORKSPACE, file)

    // 只补默认值不建文件（否则「点了新会话、一个字没发」也会在磁盘上留一条空会话）。
    session.appendState('mode', 'plan')
    expect(session.persisted).toBe(false)
    expect(existsSync(file)).toBe(false)

    // 同一条状态在第一条消息前写两次：按产生顺序落盘，最后一条生效。
    session.appendState('mode', 'build')
    session.appendUser('你好')
    session.close()

    const records = await readRecords(file, 4)
    expect(records.map((record) => record.type)).toEqual(['meta', 'state', 'state', 'user'])
    expect(records[1]).toStrictEqual({ type: 'state', id: 'mode', payload: 'plan' })
    expect(records[2]).toStrictEqual({ type: 'state', id: 'mode', payload: 'build' })

    const restored = Session.load(file, true)
    try {
      expect(restored.state('mode')).toBe('build')
      expect(restored.messages).toHaveLength(1)
    } finally {
      restored.close()
    }
  })

  test('summary.keep：重放后是「摘要 + 末尾 keep 条」，压缩前的原文不再进消息流', async () => {
    const file = fileFor('summary.jsonl')
    const session = Session.create(WORKSPACE, file)
    session.appendUser('第一问')
    session.appendAssistant('第一答', '', [])
    session.appendUser('第二问')
    session.appendAssistant('第二答', '', [])

    // 压缩后内存里是「摘要 + 保留的尾部」；第一条是摘要本身，keep 记尾部条数。
    session.replaceWithSummary('摘要正文', [
      { role: 'user', content: '摘要正文', ts: 900 },
      { role: 'assistant', content: '第二答', ts: 800 },
    ])
    session.appendUser('第三问')
    session.close()

    const records = await readRecords(file, 7)
    const summary = records.find((record) => record.type === 'summary')
    expect(summary).toBeDefined()
    expect(Object.keys(summary!).sort()).toEqual(['keep', 'text', 'ts', 'type'])
    expect(summary).toStrictEqual({
      type: 'summary',
      text: '摘要正文',
      keep: 1,
      ts: summary?.ts,
    })

    const restored = Session.load(file, true)
    try {
      expect(restored.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
      expect(restored.messages.map((message) => message.content)).toEqual([
        '摘要正文',
        '第二答',
        '第三问',
      ])
    } finally {
      restored.close()
    }
  })

  test('rewind.keep：作废第 keep 条人打的用户消息及之后的一切，日志 append-only', async () => {
    const file = fileFor('rewind.jsonl')
    const session = Session.create(WORKSPACE, file)
    session.appendUser('问一')
    session.appendAssistant('答一', '', [])
    session.appendUser('问二')
    session.appendAssistant('答二', '', [])

    // 越界的序号如实失败，一个字节都不写。
    expect(session.rewindToUser(9)).toBe(false)
    // 保留第 1 条用户消息，从第 2 条起作废；随后按改过的文字重发。
    expect(session.rewindToUser(1)).toBe(true)
    session.appendUser('问二改')
    session.appendAssistant('答二改', '', [])
    session.close()

    const records = await readRecords(file, 8)
    expect(records.map((record) => record.type)).toEqual([
      'meta',
      'user',
      'assistant',
      'user',
      'assistant',
      'rewind',
      'user',
      'assistant',
    ])
    expect(records[5]).toStrictEqual({ type: 'rewind', keep: 1, ts: records[5]?.ts })

    const restored = Session.load(file, true)
    try {
      expect(restored.messages.map((message) => message.content)).toEqual([
        '问一',
        '答一',
        '问二改',
        '答二改',
      ])
    } finally {
      restored.close()
    }
  })
})

describe('④ 记录类型集合与兼容面', () => {
  test('当前写入方法能产出的记录类型集合（加一种/少一种都会红）', async () => {
    const file = fileFor('types.jsonl')
    const session = Session.create(WORKSPACE, file)
    session.appendUser('u')
    session.appendAssistant('a', '', [])
    session.appendTool('c1', 'read', 'ok')
    session.appendState('mode', 'plan')
    session.appendNote('n', 't')
    session.appendNotice({ kind: 'turn-error', text: 'e' })
    session.replaceWithSummary('摘要', [{ role: 'user', content: '摘要' }])
    session.rewindToUser(0)
    session.close()

    const records = await readRecords(file, 9)
    expect([...new Set(records.map((record) => String(record.type)))].sort()).toEqual([
      'assistant',
      'meta',
      'note',
      'notice',
      'rewind',
      'state',
      'summary',
      'tool',
      'user',
    ])
  })

  test('老日志的 mode / todo / plan / goal 记录归位到 state（最后一条生效）', async () => {
    const file = fileFor('legacy.jsonl')
    const records: Array<Record<string, unknown>> = [
      { type: 'meta', id: 'legacy', cwd: WORKSPACE, createdAt: 1 },
      { type: 'mode', mode: 'plan' },
      { type: 'todo', items: TODOS },
      { type: 'plan', plan: { file: 'p.md', title: '计划', text: '# 计划', decision: 'approved' } },
      { type: 'goal', goal: { objective: '交付' } },
      { type: 'user', text: '你好' },
    ]
    writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')

    const restored = Session.load(file, true)
    try {
      expect(restored.state('mode')).toBe('plan')
      expect(restored.state('todos')).toStrictEqual(TODOS)
      expect(restored.state('plan')).toStrictEqual({
        file: 'p.md',
        title: '计划',
        text: '# 计划',
        decision: 'approved',
      })
      expect(restored.state('goal')).toStrictEqual({ objective: '交付' })
      expect(restored.messages.map((message) => message.content)).toEqual(['你好'])
    } finally {
      restored.close()
    }
  })

  test('坏行与未知记录类型静默跳过（半截 JSON 不拖垮整份日志）', () => {
    const file = fileFor('tolerant.jsonl')
    const lines = [
      JSON.stringify({ type: 'meta', id: 'tolerant', cwd: WORKSPACE, createdAt: 1 }),
      '{"type":"user","text":"半截',
      JSON.stringify({ type: 'future-record', payload: 1 }),
      JSON.stringify({ type: 'user', text: '你好' }),
    ]
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')

    const restored = Session.load(file, true)
    try {
      expect(restored.messages.map((message) => message.content)).toEqual(['你好'])
      expect(restored.meta.id).toBe('tolerant')
    } finally {
      restored.close()
    }
  })
})
