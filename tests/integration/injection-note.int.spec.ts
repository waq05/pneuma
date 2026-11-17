/**
 * 投影注入留底：两条提醒（重复调用 / 待办节流）真的拼进请求时，必须同时 `appendNote`
 * 落一条 note（迁自 `scripts/injection-note-test.mjs`）。
 *
 * 规矩来自 `session-core/loop.ts:77`：往请求里注入日志上没有的内容，注入方自己留底。
 * 为什么必须用真内核：投影注册在插件的 `apply` 里，纯函数测不到「有没有调 appendNote」。
 * 这里在临时 HOME 上装完整内核，直接调 `prompt.rewrite` 跑真投影链，再看会话的 `notes()`
 * 与 jsonl——**把两处 appendNote 删掉，本文件必须红**。
 *
 * 另有一条容易被顺手改坏的语义：循环在请求发出前会拿**同一份历史**再跑一遍投影链做不变量
 * 校验（`loop.ts:452` 的 `checkRequestInvariant`）。那一遍没有发给模型，不许跟着多落一条
 * note。所以「二次派生」在每个场景里都是显式的一步，而不是顺带。
 *
 * ## 为什么两个场景各起一只内核
 *
 * 两条提醒各自会往同一个会话里落 note，共用一个内核时，「note 只有一条」这类断言会被另一
 * 个场景的账污染。每只内核 ~1.5s，换的是每条用例单独重跑也成立。
 *
 * ## 顺序仍然重要
 *
 * 一个场景内部是顺序剧（前两次调用不提醒、第三次才命中阈值）。所以每个场景把**整段过程**
 * 在 `beforeAll` 里跑完、把每一步的读数记下来，用例只读不写——单条用例重跑不会走样。
 *
 * @module dsc/tests/integration/injection-note.int.spec
 */
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { planRepeatReminder, type RepeatReminderPlan } from '@pneuma/runtime/core/repeat-reminder.js'
import { TODO_REMINDER_TEXT } from '@pneuma/runtime/core/todo-reminder.js'
import { bootKernel, fakeLLM, readSessionJsonl, type BootedKernel, type FakeLLM } from '../harness.js'

/** 内核里本文件用到的服务面。 */
interface SessionView {
  meta: { id: string }
  messages: ChatMessage[]
  filePath: string
  notes(): Array<{ id: string; text: string }>
  appendUser(text: string): void
  appendAssistant(text: string, reasoning: string, toolCalls: Array<{ id: string; name: string; arguments: string }>): void
  appendTool(callId: string, name: string, text: string): void
}

interface Services {
  session: { current(): SessionView }
  prompt: { rewrite(messages: ChatMessage[], session: SessionView): ChatMessage[] }
  settings: { save(sectionId: string, key: string, value: unknown): Promise<unknown> }
  todo: { writeTodos(list: readonly unknown[], merge: boolean): void; clearTodos(): void }
}

/** 一份请求里所有正文拼起来（只看文本）。 */
function textsOf(messages: ChatMessage[]): string[] {
  return messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
}

/** 会话里某一类 note。 */
function notesOf(session: SessionView, id: string): Array<{ id: string; text: string }> {
  return session.notes().filter((note) => note.id === id)
}

/** 等写流把某条 note 刷到盘上（写盘是流式的，文件也可能还没建出来）。 */
async function waitForNoteRecord(file: string, id: string): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 3_000
  for (;;) {
    // `readSessionJsonl` 在文件不存在时是抛错（那是它的设计：路径错不该被读成「空日志」），
    // 所以等文件先出现再读。
    const records = existsSync(file)
      ? readSessionJsonl(file).filter((record) => record.type === 'note')
      : []
    if (records.some((record) => record.id === id) || Date.now() > deadline) return records
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** 造一次同参工具调用（消息形态与真会话一致：assistant 带 tool_calls + 一条 tool 结果）。 */
function appendCall(session: SessionView, n: number): void {
  const id = `call_${String(n)}`
  session.appendAssistant('', '', [{ id, name: 'read', arguments: '{"path":"README.md"}' }])
  session.appendTool(id, 'read', `第 ${String(n)} 次结果`)
}

describe('① 重复调用提醒：真注入了才落 note', () => {
  let kernel: BootedKernel
  let fake: FakeLLM
  let services: Services
  /** 前两次同参调用之后的局面（还没到阈值）。 */
  let belowPlan: RepeatReminderPlan
  let quietSent: ChatMessage[]
  let quietNotes: Array<{ id: string; text: string }>
  /** 第三次命中阈值之后的局面。 */
  let plan: RepeatReminderPlan
  let sent: ChatMessage[]
  let noted: Array<{ id: string; text: string }>
  let derivedRepeat: ChatMessage[]
  let notesAfterDerive: number
  let jsonlNotes: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    fake = await fakeLLM({ turns: ['收到'] })
    kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
    services = kernel.ctx as unknown as Services
    const session = services.session.current()
    const base: ChatMessage[] = [{ role: 'system', content: '系统提示（探针）' }]

    session.appendUser('把这件事办完。')
    appendCall(session, 1)
    appendCall(session, 2)
    belowPlan = planRepeatReminder(session.messages)
    quietSent = services.prompt.rewrite(base, session)
    quietNotes = notesOf(session, 'repeat-reminder')

    appendCall(session, 3)
    plan = planRepeatReminder(session.messages)
    sent = services.prompt.rewrite(base, session)
    noted = notesOf(session, 'repeat-reminder')

    // 同一份历史再跑一遍（循环在请求发出前拿它做 invariant 校验）：那一遍并没有发给模型，
    // 不该多记一条 note。先确认它真的又算出了一份注入，否则「只有一条 note」可能只是因为
    // 这一遍压根没注入（那样这条断言就白测了）。
    derivedRepeat = services.prompt.rewrite(base, session)
    notesAfterDerive = notesOf(session, 'repeat-reminder').length
    jsonlNotes = await waitForNoteRecord(session.filePath, 'repeat-reminder')
  })

  afterAll(async () => {
    await kernel?.dispose()
    await fake?.close()
  })

  test('前两次同参调用不算重复（count = 2，不提醒）', () => {
    expect(belowPlan.remind).toBe(false)
    expect(belowPlan.count).toBe(2)
  })

  test('没到阈值时不注入提醒、也不落 note', () => {
    expect(textsOf(quietSent)).not.toContain(belowPlan.text)
    expect(quietNotes).toHaveLength(0)
  })

  test('第三次命中的是第 1 档（准备条件）', () => {
    expect(plan.remind).toBe(true)
    expect(plan.tier).toBe(1)
    expect(plan.text).not.toBe('')
  })

  test('第三次请求末尾真的多了提醒原文', () => {
    expect(sent.length).toBeGreaterThan(1)
    expect(sent[sent.length - 1]!.role).toBe('user')
    expect(textsOf(sent)[sent.length - 1]).toBe(plan.text)
  })

  test('同时落了一条 repeat-reminder note，正文就是注入原文', () => {
    expect(noted).toHaveLength(1)
    expect(noted[0]!.text).toBe(plan.text)
    // 用自己的名字，没复用 lsp / hooks 的 id。
    expect(noted[0]!.id).toBe('repeat-reminder')
  })

  test('二次派生那一遍照样注入了提醒（幂等不是靠省掉注入凑出来的）', () => {
    expect(textsOf(derivedRepeat)).toContain(plan.text)
  })

  test('同一份历史真跑两遍，repeat-reminder note 仍只有 1 条', () => {
    expect(notesAfterDerive).toBe(1)
  })

  test('note 落进了会话 jsonl，且没借用别人的 id', () => {
    expect(jsonlNotes.some((record) => record.id === 'repeat-reminder')).toBe(true)
    expect(jsonlNotes.some((record) => record.id === 'lsp-write-diagnostics' || record.id === 'lifecycle-hooks')).toBe(false)
  })
})

describe('② 待办提醒：真注入了才落 note，幂等与清空都不落', () => {
  let kernel: BootedKernel
  let fake: FakeLLM
  let services: Services
  /** 间隔调成 1 轮后第一次请求。 */
  let sent: ChatMessage[]
  let noted: Array<{ id: string; text: string }>
  /** 二次派生那一遍。 */
  let derived: ChatMessage[]
  let notesAfterDerive: number
  /** 请求里已经带着这句提醒时（幂等拒绝注入）。 */
  let notesAfterAlready: number
  /** 清单清空之后。 */
  let notesAfterClear: number
  let jsonlNotes: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    fake = await fakeLLM({ turns: ['收到'] })
    kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
    services = kernel.ctx as unknown as Services
    const session = services.session.current()
    const base: ChatMessage[] = [{ role: 'system', content: '系统提示（探针）' }]

    await services.settings.save('todo', 'everyRounds', 1)
    services.todo.writeTodos([{ content: '修掉登录 bug', status: 'pending' }], false)
    const messages: ChatMessage[] = [
      ...base,
      { role: 'user', content: '接着做。' },
      { role: 'assistant', content: '好。' },
    ]

    sent = services.prompt.rewrite(messages, session)
    noted = notesOf(session, 'todo-reminder')

    // 每次重新拼一遍 system 那条（跟循环里「每次 requestOnce 都新拼一份 assembled」一致），
    // 会话日志部分共用同一批消息对象（引用不变）——正是二次派生的情形。
    const rebuild = (): ChatMessage[] => [{ role: 'system', content: '系统提示（探针，二次派生）' }, ...messages.slice(1)]
    derived = services.prompt.rewrite(rebuild(), session)
    notesAfterDerive = notesOf(session, 'todo-reminder').length

    // 幂等：请求里已经带着这句提醒 → appendTodoReminder 原样返回，不注入也不再落 note。
    const already: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: '继续。' },
      { role: 'user', content: TODO_REMINDER_TEXT },
    ]
    services.prompt.rewrite(already, session)
    notesAfterAlready = notesOf(session, 'todo-reminder').length

    // 清单清空 → 没有未完成项，不注入也不落 note。
    services.todo.clearTodos()
    const afterClear: ChatMessage[] = [...already, { role: 'assistant', content: '收工。' }]
    services.prompt.rewrite(afterClear, session)
    notesAfterClear = notesOf(session, 'todo-reminder').length
    jsonlNotes = await waitForNoteRecord(session.filePath, 'todo-reminder')
  })

  afterAll(async () => {
    await kernel?.dispose()
    await fake?.close()
  })

  test('间隔调成 1 轮后第一轮请求里就有待办提醒', () => {
    expect(textsOf(sent)).toContain(TODO_REMINDER_TEXT)
  })

  test('同时落了一条 todo-reminder note，正文就是提醒原文，id 是自己的', () => {
    expect(noted).toHaveLength(1)
    expect(noted[0]!.text).toBe(TODO_REMINDER_TEXT)
    expect(noted[0]!.id).toBe('todo-reminder')
  })

  test('二次派生那一遍照样注入，但 note 仍只有 1 条', () => {
    expect(textsOf(derived)).toContain(TODO_REMINDER_TEXT)
    expect(notesAfterDerive).toBe(1)
  })

  test('请求里已经有提醒时不再重复落 note', () => {
    expect(notesAfterAlready).toBe(1)
  })

  test('清单清空后不再落 todo-reminder note', () => {
    expect(notesAfterClear).toBe(1)
  })

  test('note 落进了会话 jsonl，且没借用别人的 id', () => {
    expect(jsonlNotes.some((record) => record.id === 'todo-reminder')).toBe(true)
    expect(jsonlNotes.some((record) => record.id === 'lsp-write-diagnostics' || record.id === 'lifecycle-hooks')).toBe(false)
  })
})
