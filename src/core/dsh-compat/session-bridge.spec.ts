/**
 * 只读会话桥（`core/dsh-compat/session-bridge.ts`）：dsh 插件看到的 sessions / sessionPersistence。
 *
 * 夹具是临时 DSC_HOME 下的真实 jsonl：会话行 → dsh 事件翻译、用量按时间并进助手消息、
 * 挂不上时落 `llm/usage`、游标语义、写口一律拒绝。不碰 `~/.dsc`，不调模型。
 *
 * @module dsc/core/dsh-compat/session-bridge.spec
 */
import { appendFileSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-session-bridge-'))
process.env['DSC_HOME'] = HOME

let sessionBridge: typeof import('./session-bridge.js')
let core: typeof import('../session.js')

/** 一行的 JSON + 换行。 */
function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`
}

const WORK = 'D:\\work\\proj'

beforeAll(async () => {
  core = await import('../session.js')
  const dir = join(core.sessionsRoot(), core.slugCwd(WORK))
  mkdirSync(join(HOME, 'usage'), { recursive: true })
  mkdirSync(dir, { recursive: true })

  writeFileSync(
    join(dir, 's-1.jsonl'),
    line({ type: 'meta', id: 's-1', cwd: WORK, createdAt: 1_000 }) +
      line({ type: 'user', text: '问一句', ts: 1_000 }) +
      line({
        type: 'assistant',
        text: '答一句',
        reasoning: '想一下',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"p":1}' }],
        ts: 2_000,
      }) +
      line({ type: 'tool', callId: 'c1', text: '结果', ts: 3_000 }) +
      line({ type: 'state', payload: { model: 'm' }, ts: 4_000 }) +
      '{bad json\n' +
      '\n',
    'utf8',
  )
  writeFileSync(
    join(dir, 's-2.jsonl'),
    line({ type: 'meta', id: 's-2', cwd: WORK, createdAt: 500 }) + line({ type: 'user', text: '只问', ts: 600 }),
    'utf8',
  )

  writeFileSync(
    join(HOME, 'usage', 'usage.jsonl'),
    `${JSON.stringify({ sid: 's-1', i: 100, o: 20, ch: 30, cm: 70, t: 2_500, provider: 'p', model: 'm' })}\n` +
      `${JSON.stringify({ sid: 's-2', i: 10, o: 2, t: 500, provider: 'p2', model: 'm2' })}\n` +
      `${JSON.stringify({ k: 'tool', name: 'read', t: 2_600 })}\n` +
      `${JSON.stringify({ sid: 's-1', i: 5, t: 2_700 })}\n` +
      '{bad\n',
    'utf8',
  )

  sessionBridge = await import('./session-bridge.js')
})

describe('sessionPersistence.list / stat', () => {
  test('list：header.id、事件数、字节数与 revision 同口径', () => {
    const rows = sessionBridge.createSessionPersistenceBridge().list()
    const one = rows.find((row) => row.header.id === 's-1')!
    const two = rows.find((row) => row.header.id === 's-2')!
    expect(one).toMatchObject({ formatStatus: 'current', header: { cwd: WORK, createdAt: 1_000 } })
    // s-1：user + assistant + tool + state 四条；用量并进助手消息，不单独计数。
    expect(one.eventCount).toBe(4)
    expect(two.eventCount).toBe(2)
    expect(one.revision).toBe(`${String(one.eventCount)}:${String(one.sizeBytes)}`)
    const file = join(core.sessionsRoot(), core.slugCwd(WORK), 's-1.jsonl')
    expect(one.sizeBytes).toBe(statSync(file).size)
  })

  test('list 有 2 秒缓存：连问两次拿同一份数组', () => {
    const bridge = sessionBridge.createSessionPersistenceBridge()
    expect(bridge.list()).toBe(bridge.list())
  })

  test('stat：有就给快照，没有给 undefined', () => {
    const bridge = sessionBridge.createSessionPersistenceBridge()
    expect(bridge.stat('s-2')).toMatchObject({ eventCount: 2 })
    expect(bridge.stat('nope')).toBeUndefined()
  })

  test('用量追加后，stat 现读：挂不上的那条落成 llm/usage 事件', () => {
    const bridge = sessionBridge.createSessionPersistenceBridge()
    const file = join(HOME, 'usage', 'usage.jsonl')
    appendFileSync(
      file,
      `${JSON.stringify({ sid: 's-1', i: 7, o: 1, t: 3_500, provider: 'p', model: 'm' })}\n`,
      'utf8',
    )
    const later = new Date(Date.now() + 5_000)
    utimesSync(file, later, later)
    expect(bridge.stat('s-1')!.eventCount).toBe(5)
  })
})

describe('open(…, "read")：事件翻译', () => {
  test('会话行翻成 dsh 事件：内容块、工具结果、state 标 ignorable、坏行与 meta 丢掉', () => {
    const handle = sessionBridge.createSessionPersistenceBridge().open('s-1')
    const page = handle.read()
    // 追加的那条 llm/usage 在 3500ms，排在 state 之前。
    expect(page.events.map((event) => event.type)).toEqual([
      'user/message',
      'assistant/message',
      'tool/result',
      'llm/usage',
      'state',
    ])
    expect(page.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    expect(page.events.map((event) => event.time)).toEqual([1_000, 2_000, 3_000, 3_500, 4_000])

    const user = page.events[0]!
    expect(user.data).toMatchObject({ role: 'user', content: [{ type: 'text', text: '问一句' }], source: { kind: 'user' } })
    const assistant = page.events[1]!.data['message'] as { content: Array<{ type: string; name?: string }>; source: Record<string, unknown> }
    expect(assistant.content.map((block) => block.type)).toEqual(['text', 'reasoning', 'tool-call'])
    expect(assistant.content[2]!.name).toBe('read')
    const tool = page.events[2]!.data['message'] as { source: Record<string, unknown>; toolCallId: string }
    expect(tool.toolCallId).toBe('c1')
    expect(tool.source).toMatchObject({ kind: 'tool', callId: 'c1' })
    expect(page.events[3]).toMatchObject({ ignorable: true })
    expect(page.events[4]).toMatchObject({ type: 'state', ignorable: true })
  })

  test('用量并进它前面最近的助手消息：message.usage 与 source 的 provider/model 一起补上', () => {
    const events = sessionBridge.createSessionPersistenceBridge().open('s-1').read().events
    const assistant = events.find((event) => event.type === 'assistant/message')!
    const message = assistant.data['message'] as { source: Record<string, unknown> }
    expect(message.source).toMatchObject({ kind: 'model', provider: 'p', model: 'm' })
    expect(assistant.data['usage']).toMatchObject({
      inputTokens: 70,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      totalTokens: 120,
    })
  })

  test('前面没有助手消息：用量落成 llm/usage 扩展事件，数字按 dsh 口径', () => {
    const events = sessionBridge.createSessionPersistenceBridge().open('s-2').read().events
    const usage = events.find((event) => event.type === 'llm/usage')!
    expect(usage.ignorable).toBe(true)
    expect(usage.seq).toBe(1)
    expect(usage.time).toBe(500)
    expect(usage.data).toMatchObject({
      provider: 'p2',
      model: 'm2',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      totalTokens: 12,
      at: 500,
    })
  })

  test('数字偏移 = 从这一号 seq 起取；对象游标支持 through/before/max', () => {
    const handle = sessionBridge.createSessionPersistenceBridge().open('s-1')
    expect(handle.read(0).events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    expect(handle.read(4).events.map((event) => event.seq)).toEqual([4, 5])
    expect(handle.read({ throughSeq: 2 }).events.map((event) => event.seq)).toEqual([1, 2])
    expect(handle.read({ beforeSeq: 3 }).events.map((event) => event.seq)).toEqual([1, 2])
    const limited = handle.read({ maxMessages: 2 })
    expect(limited.events.map((event) => event.seq)).toEqual([1, 2])
    expect(limited.hasMore).toBe(true)
  })

  test('handle 的头部与继承计数；close 是空操作；未知会话抛清楚', () => {
    const bridge = sessionBridge.createSessionPersistenceBridge()
    const handle = bridge.open('s-1')
    expect(handle).toMatchObject({ sessionId: 's-1', inheritedEventCount: 0 })
    expect(handle.header).toEqual({ id: 's-1', cwd: WORK, createdAt: 1_000 })
    expect(() => handle.close()).not.toThrow()
    expect(() => bridge.open('nope')).toThrow(/没有这个会话/)
  })
})

describe('写侧一律拒绝', () => {
  test('open(…, "write") / create / append 都抛同一句原因', () => {
    const bridge = sessionBridge.createSessionPersistenceBridge()
    const writeRefusal = /独占写入/
    expect(() => bridge.open('s-1', 'write')).toThrow(writeRefusal)
    expect(() => bridge.create()).toThrow(writeRefusal)
    expect(() => bridge.append()).toThrow(writeRefusal)
  })
})

describe('sessions 视图与按名取桥', () => {
  test('list / get / has：同一份清单，live 不假装', () => {
    const sessions = sessionBridge.createSessionsBridge()
    const rows = sessions.list()
    expect(rows.map((row) => row.sessionId).sort()).toEqual(['s-1', 's-2'])
    expect(rows.every((row) => row.live === false && row.persisted === true)).toBe(true)
    expect(sessions.get('s-1')).toMatchObject({ cwd: WORK, createdAt: 1_000 })
    expect(sessions.get('nope')).toBeUndefined()
    expect(sessions.has('s-2')).toBe(true)
    expect(sessions.has('nope')).toBe(false)
  })

  test('compatServiceOf：两个服务给出桥，其余给 undefined', () => {
    expect(typeof (sessionBridge.compatServiceOf('sessions') as { list?: unknown }).list).toBe('function')
    expect(typeof (sessionBridge.compatServiceOf('sessionPersistence') as { stat?: unknown }).stat).toBe('function')
    expect(sessionBridge.compatServiceOf('presets')).toBeUndefined()
  })
})
