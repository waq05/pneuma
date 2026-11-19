/**
 * ask 装配面（`packages/ask/index.ts`）：`ask_user` 工具、提问卡服务、收尾的四种出口
 * （答完 / 中断 / 超时 / 退出 / 被新一批顶掉）与配置夹取。
 *
 * 假 ctx 提供 session / tools / surfaces / waiting 四个面，`apply` 是真的。
 * 时间相关的用例用假计时器，真等 10 秒下限会把 unit 层 5 秒超时跑红。
 *
 * @module dsc/packages/ask/tests/wiring.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-ask-wiring-'))
process.env['DSC_HOME'] = HOME

type AskModule = typeof import('../index.js')
const askModule = await import('../index.js')
const askPlugin: AskModule['askPlugin'] = askModule.askPlugin

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
}

interface Question {
  question: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
  allowFreeText: boolean
}

interface AskService {
  pendingQuestion(): { id: string; question: string; questions?: Question[] } | null
  ask(question: Omit<Question, 'question'> & { question: string; header?: string }, signal: AbortSignal, sessionPath?: string): Promise<string>
  askMany(input: readonly Question[], signal: AbortSignal, sessionPath?: string): Promise<string[]>
  answerQuestion(answer: string): void
}

interface CapturedTool {
  name: string
  description: string
  risk: string
  waitsForHuman?: boolean
  parameters: { properties: Record<string, { description?: string }>; required?: string[] }
  run(args: Record<string, unknown>, ctx: unknown): Promise<string>
}

interface Harness {
  tool: CapturedTool
  service: AskService
  surfaces: Map<string, () => unknown>
  waiting: Map<string, (owner?: string) => boolean>
  events: Array<{ name: string; payload: unknown }>
  handlers: Map<string, () => void>
  setCurrent(session: FakeSession): void
}

/** 一条会话。 */
function session(id: string, cwd = 'C:/work'): FakeSession {
  return { meta: { id, cwd }, filePath: `C:/work/.dsc/sessions/${id}.jsonl` }
}

/** 假 ctx 真 apply。 */
function fakeCtx(options: { passed?: Record<string, unknown>; current?: FakeSession; agent?: (path: string) => FakeSession | undefined } = {}): Harness {
  let current = options.current ?? session('sess-1')
  const tools: CapturedTool[] = []
  const surfaces = new Map<string, () => unknown>()
  const waiting = new Map<string, (owner?: string) => boolean>()
  const events: Array<{ name: string; payload: unknown }> = []
  const handlers = new Map<string, () => void>()
  const services = new Map<string, unknown>()
  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    on(event: string, handler: () => void) {
      handlers.set(event, handler)
      return () => undefined
    },
    emit(name: string, payload?: unknown) {
      events.push({ name, payload })
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    get(name: string) {
      if (name !== 'agent' || options.agent === undefined) return undefined
      return { sessionFor: options.agent }
    },
    session: { current: () => current },
    tools: {
      register(tool: CapturedTool) {
        tools.push(tool)
        return () => undefined
      },
    },
    surfaces: {
      register(id: string, fn: () => unknown) {
        surfaces.set(id, fn)
        return () => undefined
      },
    },
    waiting: {
      register(id: string, fn: (owner?: string) => boolean) {
        waiting.set(id, fn)
        return () => undefined
      },
    },
  }
  askPlugin.apply(ctx as never, options.passed as never)
  const tool = tools[0]
  if (tool === undefined) throw new Error('ask_user 工具没注册出来')
  return {
    tool,
    service: services.get('ask') as AskService,
    surfaces,
    waiting,
    events,
    handlers,
    setCurrent(next) {
      current = next
    },
  }
}

/** 一道题。 */
function question(text = '选哪个？', labels = ['甲', '乙']): Question {
  return {
    question: text,
    options: labels.map((label) => ({ label })),
    multiSelect: false,
    allowFreeText: true,
  }
}

describe('注册与配置', () => {
  test('工具/卡片/等人登记都挂上，描述里的上限跟着配置走', () => {
    const h = fakeCtx({ passed: { maxQuestions: 99, maxOptions: 99 } })
    expect(h.tool).toMatchObject({ name: 'ask_user', risk: 'read' })
    expect(h.tool.waitsForHuman).toBe(true)
    expect(h.tool.description).toContain('最多 8 个问题')
    expect(h.tool.description).toContain('每个最多 8 个互斥选项')
    expect(h.tool.description).toContain('这张卡最多等 15 分钟')
    expect(h.surfaces.get('pendingQuestion')?.()).toBeNull()
    expect(h.waiting.get('ask')?.()).toBe(false)
    expect(h.tool.parameters.required).toEqual(['questions'])
  })

  test('waitMs 夹在 10 秒 ~ 1 小时之间', () => {
    expect(fakeCtx({ passed: { waitMs: 1 } }).tool.description).toContain('最多等 10 秒')
    expect(fakeCtx({ passed: { waitMs: 99_999_999 } }).tool.description).toContain('最多等 60 分钟')
  })
})

describe('单题与多题作答', () => {
  test('ask：挂一张卡、答完落地，状态点先等审批再翻回 working', async () => {
    const h = fakeCtx()
    const ac = new AbortController()
    const pending = h.service.ask({ ...question(), header: '选择' }, ac.signal)
    const view = h.service.pendingQuestion()
    expect(view).toMatchObject({ question: '选哪个？' })
    expect(h.events.some((event) => event.name === 'dsc/agent-status')).toBe(true)

    h.service.answerQuestion('甲')
    await expect(pending).resolves.toBe('甲')
    expect(h.service.pendingQuestion()).toBeNull()
    const statuses = h.events.filter((event) => event.name === 'dsc/agent-status').map((event) => event.payload)
    expect(statuses.at(-1)).toEqual({
      sessionId: 'sess-1',
      path: 'C:/work/.dsc/sessions/sess-1.jsonl',
      state: 'working',
    })
    // 没有卡时再答一次是 no-op。
    expect(() => h.service.answerQuestion('丙')).not.toThrow()
  })

  test('askMany：按题序收答案，没齐之前视图不动，齐了整批落地', async () => {
    const h = fakeCtx()
    const pending = h.service.askMany([question('第一题'), question('第二题')], new AbortController().signal)
    expect(h.service.pendingQuestion()?.questions).toHaveLength(2)

    h.service.answerQuestion('一')
    expect(h.service.pendingQuestion()?.questions).toHaveLength(2)
    h.service.answerQuestion('二')
    await expect(pending).resolves.toEqual(['一', '二'])
    expect(h.service.pendingQuestion()).toBeNull()
  })

  test('工具 run：丢掉空题、裁选项、过滤空标签，答案按题序回到正文', async () => {
    const h = fakeCtx()
    const ac = new AbortController()
    const pending = h.tool.run(
      {
        questions: [
          { question: '  要哪个？ ', header: '选', options: [{ label: '甲' }, { label: '' }, { label: 42 }, { label: '乙' }] },
          { question: '   ' },
          { question: '第二问', options: [], multiSelect: true },
        ],
      },
      { cwd: 'C:/work', signal: ac.signal, sessionPath: undefined },
    )
    const view = h.service.pendingQuestion()
    expect(view?.questions).toHaveLength(2)
    expect(view?.questions?.[0]).toMatchObject({
      question: '要哪个？',
      header: '选',
      options: [{ label: '甲' }, { label: '42' }, { label: '乙' }],
    })
    expect(view?.questions?.[1]).toMatchObject({ question: '第二问', multiSelect: true, options: [] })

    h.service.answerQuestion('甲')
    h.service.answerQuestion('不用')
    const text = await pending
    expect(text).toBe('要哪个？\n用户回答：甲\n\n第二问\n用户回答：不用')
  })

  test('参数不合法当场拒绝（空批 / 空正文 / 不是数组）', async () => {
    const h = fakeCtx()
    await expect(h.service.askMany([], new AbortController().signal)).rejects.toThrow('一批问题至少要有一个')
    await expect(
      h.tool.run({ questions: [] }, { cwd: 'C:/work', signal: new AbortController().signal }),
    ).rejects.toThrow('questions 至少要有一个问题')
    await expect(
      h.tool.run({ questions: [{ question: '  ' }] }, { cwd: 'C:/work', signal: new AbortController().signal }),
    ).rejects.toThrow('问题正文都是空的')
    await expect(
      h.tool.run({ questions: 'x' }, { cwd: 'C:/work', signal: new AbortController().signal }),
    ).rejects.toThrow('questions 至少要有一个问题')
  })
})

describe('收尾出口', () => {
  test('中断：答过一半的保留原话，没答的写「中断」；预中断也不挂死', async () => {
    const h = fakeCtx()
    const ac = new AbortController()
    const pending = h.service.askMany([question('一'), question('二')], ac.signal)
    h.service.answerQuestion('先答了')
    ac.abort()
    await expect(pending).resolves.toEqual(['先答了', '（用户没回答就中断了这一轮）'])

    const dead = new AbortController()
    dead.abort()
    await expect(h.service.askMany([question()], dead.signal)).resolves.toEqual(['（用户没回答就中断了这一轮）'])
  })

  test('超时：等满时限自己撤卡，模型拿到「用户没有回答」', async () => {
    vi.useFakeTimers()
    try {
      const h = fakeCtx({ passed: { waitMs: 1 } })
      const pending = h.service.askMany([question()], new AbortController().signal)
      expect(h.service.pendingQuestion()).not.toBeNull()
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toEqual(['（等了 10 秒，用户没有回答这一题）'])
      expect(h.service.pendingQuestion()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('退出：替没答的题写「用户退出了程序」', async () => {
    const h = fakeCtx()
    const pending = h.service.askMany([question()], new AbortController().signal)
    h.handlers.get('dsc/exit')?.()
    await expect(pending).resolves.toEqual(['（用户退出了程序，这个问题没回答）'])
    expect(h.service.pendingQuestion()).toBeNull()
  })

  test('同会话再挂一批：旧卡按「作废」收尾，新卡接班', async () => {
    const h = fakeCtx()
    const first = h.service.askMany([question('旧的一题')], new AbortController().signal)
    const second = h.service.askMany([question('新的一题')], new AbortController().signal)
    await expect(first).resolves.toEqual(['（又挂了一批新问题，这一题作废）'])
    expect(h.service.pendingQuestion()?.question).toBe('新的一题')
    h.service.answerQuestion('乙')
    await expect(second).resolves.toEqual(['乙'])
  })
})

describe('多会话归属', () => {
  test('后台会话提问：surface 只出当前查看会话的卡，waiting 按会话认', async () => {
    const current = session('sess-1')
    const background = session('sess-2', 'C:/other')
    const h = fakeCtx({ current, agent: (path) => (path === background.filePath ? background : undefined) })

    const pending = h.service.askMany([question('后台问题')], new AbortController().signal, background.filePath)
    expect(h.service.pendingQuestion()).toBeNull()
    expect(h.waiting.get('ask')?.()).toBe(true)
    expect(h.waiting.get('ask')?.('sess-2')).toBe(true)
    expect(h.waiting.get('ask')?.('sess-1')).toBe(false)

    h.setCurrent(background)
    expect(h.service.pendingQuestion()?.question).toBe('后台问题')
    h.service.answerQuestion('答了')
    await expect(pending).resolves.toEqual(['答了'])
  })
})
