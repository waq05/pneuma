/**
 * session-title 的自动起标题链路补盲（w14）：`generate()` 里从未被走到的 15 行——
 * 从日志取用户提示（含空消息过滤）、调标题模型（提示拼装带序号）、清洗/空标题兜底、
 * 写盘前二次查重（等待期间用户自己改名）、以及刷新侧栏的两条退路（refresh / emit）。
 *
 * 会话是**真 Session**（临时 `DSC_HOME` + 临时工作区，jsonl 真落盘），模型流是假的。
 * `DSC_HOME` 在任何产品 import 之前指进临时目录，不碰真实 `~/.dsc`。
 *
 * @module dsc/packages/session-title/tests/w14-gaps.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { ChatMessage, StreamHandlers, StreamRequest, StreamResult } from '@pneuma/runtime/core/llm.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-session-title-w14-'))
process.env['DSC_HOME'] = HOME
const WORK = mkdtempSync(join(tmpdir(), 'dsc-session-title-w14-cwd-'))
mkdirSync(join(HOME, 'sessions'), { recursive: true })

let mod: typeof import('../index.js')
let SessionClass: (typeof import('../../../core/session.js'))['Session']
let sessionMeta: typeof import('../../../core/session-meta.js')

beforeAll(async () => {
  SessionClass = (await import('../../../core/session.js')).Session
  sessionMeta = await import('../../../core/session-meta.js')
  mod = await import('../index.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of [HOME, WORK]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 句柄：留给系统清
    }
  }
})

const okStream = (text: string): StreamResult => ({
  text,
  reasoning: '',
  toolCalls: [],
  usage: null,
  finishReason: 'stop',
})

interface TurnSignal {
  sessionPath: string
}

interface Harness {
  handler: (reason: string, signal?: TurnSignal) => void
  streamCalls: Array<{ messages: ChatMessage[] }>
  changed: number
  refreshes: number
  reply: { value: string }
  beforeReply?: (id: string) => void
}

/** 等几轮事件循环（纯内存的异步尾巴没有可轮询的外部标志时用）。 */
async function flushTurns(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function mount(options: { withRefresh?: boolean } = {}): Harness {
  const streamCalls: Harness['streamCalls'] = []
  const harness = {
    streamCalls,
    changed: 0,
    refreshes: 0,
    reply: { value: '修复登录' },
    handler: (_reason: string, _signal?: TurnSignal) => undefined,
  } as Harness
  let handler: Harness['handler'] = () => undefined
  const current = {
    filePath: join(HOME, 'current.jsonl'),
    meta: { id: 'current', cwd: WORK },
    messages: [],
  }
  const ctx = {
    on(name: string, fn: Harness['handler']) {
      expect(name).toBe('dsc/turn-end')
      handler = fn
      return () => undefined
    },
    get() {
      return undefined
    },
    emit() {
      harness.changed += 1
    },
    session: {
      current: () => current,
      ...(options.withRefresh === false
        ? {}
        : {
            refresh: async () => {
              harness.refreshes += 1
            },
          }),
    },
    llm: {
      routeForSession: () => ({ api: 'fake', baseUrl: 'http://fake', apiKey: 'k', model: 'fake/model' }),
      stream: async (_api: string, request: StreamRequest, _handlers: StreamHandlers) => {
        streamCalls.push({ messages: request.messages })
        const id = String(request.sessionId ?? '')
        harness.beforeReply?.(id)
        return okStream(harness.reply.value)
      },
    },
  }
  ;(mod.sessionTitlePlugin.apply as unknown as (ctx: unknown) => void)(ctx)
  harness.handler = (reason, signal) => handler(reason, signal)
  return harness
}

/** 建一条真会话（jsonl 真落盘），返回路径与 id。 */
async function seedSession(
  id: string,
  texts: string[],
  role: 'user' | 'assistant' = 'user',
): Promise<{ path: string; id: string }> {
  const path = join(HOME, 'sessions', `${id}.jsonl`)
  const session = SessionClass.create(WORK, path, { id })
  for (const text of texts) {
    if (role === 'user') session.appendUser(text)
    else session.appendAssistant(text, '', [])
  }
  session.close()
  // 写流是异步的：等日志里真能看到这些正文再交给插件读。
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      if (texts.every((text) => readFileSync(path, 'utf8').includes(text))) break
    } catch {
      // 还没落盘
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { path, id }
}

test('正常路径：从日志取用户提示、调标题模型、写 autoTitle 并刷新侧栏', async () => {
  const seeded = await seedSession('title-w14-ok', ['第一条：修一下登录页', '第二条：(空)', '  ', '第三条：再看日志'])
  const harness = mount()
  harness.reply.value = '「修复登录」'

  harness.handler('completed', { sessionPath: seeded.path })
  await flushTurns()

  expect(harness.streamCalls).toHaveLength(1)
  const prompt = harness.streamCalls[0]!.messages[1]!
  const lines = String(prompt.content).split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[0]).toBe('[第 1 条] 第一条：修一下登录页')
  // 纯空白的用户消息被过滤掉，后面的序号往前补。
  expect(lines[1]).toBe('[第 2 条] 第二条：(空)')
  expect(lines[2]).toBe('[第 3 条] 第三条：再看日志')
  expect(harness.refreshes).toBe(1)
  expect(sessionMeta.readSessionMeta()[seeded.id]).toMatchObject({ autoTitle: '修复登录' })
})

test('日志里没有用户消息：不调模型，也不写标题', async () => {
  const seeded = await seedSession('title-w14-none', ['只有助手说过话'], 'assistant')
  const harness = mount()
  harness.handler('completed', { sessionPath: seeded.path })
  expect(harness.streamCalls).toHaveLength(0)
  expect(sessionMeta.readSessionMeta()[seeded.id]).toBeUndefined()
})

test('模型只回了空白：清洗后为空，不写 autoTitle', async () => {
  const seeded = await seedSession('title-w14-blank', ['随便问问'])
  const harness = mount()
  harness.reply.value = '   '
  harness.handler('completed', { sessionPath: seeded.path })
  await flushTurns()
  expect(harness.streamCalls).toHaveLength(1)
  expect(sessionMeta.readSessionMeta()[seeded.id]).toBeUndefined()
})

test('等待模型期间用户自己改了名：不再写 autoTitle，用户标题保留', async () => {
  const seeded = await seedSession('title-w14-renamed', ['随便问问'])
  const harness = mount()
  harness.beforeReply = (id) => {
    sessionMeta.patchSessionMeta(id, { title: '用户改的名字' })
  }
  harness.handler('completed', { sessionPath: seeded.path })
  await flushTurns()
  const record = sessionMeta.readSessionMeta()[seeded.id]
  expect(record?.title).toBe('用户改的名字')
  expect(record?.autoTitle).toBeUndefined()
})

test('没有 session.refresh：退回直接广播 dsc/changed', async () => {
  const seeded = await seedSession('title-w14-norefresh', ['来起个标题'])
  const harness = mount({ withRefresh: false })
  harness.handler('completed', { sessionPath: seeded.path })
  await flushTurns()
  expect(harness.refreshes).toBe(0)
  expect(harness.changed).toBe(1)
  expect(sessionMeta.readSessionMeta()[seeded.id]).toMatchObject({ autoTitle: '修复登录' })
})
