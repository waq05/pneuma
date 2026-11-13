/**
 * todo 节流提醒的端到端半段（迁自 `scripts/todo-reminder-test.mjs` 第 [3] 节）。
 *
 * 纯函数那半段（轮计数、注入判定、everyRounds 夹取、幂等）早在 `src/core/todo-reminder.spec.ts`
 * 里，这里只补「真内核 + 假模型端点」才验得到的三件事：
 *   ① 设置面的默认值真的是「开、8 轮」；
 *   ② 第一轮真的立起一张含未完成项的清单，且默认间隔下前几轮请求体里一条提醒都没有；
 *   ③ 把间隔调成 2 之后下一个请求就带一条提醒、落在**请求末尾**（环境快照之后）、角色是 user；
 *      清空清单后不再注入。
 *
 * 另外两条「不改日志」的断言也在这里：提醒只存在于**发给模型的那份请求体**，内存会话与
 * jsonl 里都不能出现它，只允许留一条 `context-injected` 标记给界面画「这里注入过」。
 *
 * 隔离走 harness 的 `tempHome` + `bootKernel`：临时主目录，真 `~/.dsc` 一个字节都不动。
 *
 * @module dsc/tests/integration/todo-reminder.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { TODO_REMINDER_TEXT } from '@pneuma/runtime/core/todo-reminder.js'
import {
  bootKernel,
  fakeLLM,
  readSessionJsonl,
  tempHome,
  type BootedKernel,
  type FakeLLM,
} from '../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-todo-reminder-')

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface TodoView {
  items: Array<{ content: string; status: string }>
}

interface Services {
  settings: {
    values(section: string): Promise<Record<string, unknown>>
    save(section: string, key: string, value: unknown): Promise<void>
  }
  todo: { todoView(): TodoView; clearTodos(): void }
  session: { current(): { filePath: string; messages: readonly ChatMessage[] } }
}

let llm: FakeLLM
let kernel: BootedKernel
let services: Services

/** 第一条用户消息就让模型立一张清单（含一条未完成项），其余轮只普通回话。 */
const TODO_ARGS = { todos: [{ content: '修掉登录 bug', status: 'in_progress' }] }

beforeAll(async () => {
  llm = await fakeLLM({ turns: [{ toolCall: { name: 'todo_write', args: TODO_ARGS } }, '收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  services = kernel.ctx as unknown as Services
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

/** 提醒在某一轮请求体里的位置（下标）；没有返回 -1。 */
function reminderAt(body: unknown): number {
  if (!Array.isArray(body)) return -1
  return (body as ChatMessage[]).findIndex(
    (message) => message.role === 'user' && message.content === TODO_REMINDER_TEXT,
  )
}

/** 等 jsonl 里出现「注入标记」那条记录（写流是异步的，立即读会读到缺最后一行的日志）。 */
async function waitForInjectionRecord(filePath: string): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const records = readSessionJsonl(filePath)
    const marker = records.some(
      (record) =>
        record.type === 'state' &&
        record.id === 'context-injected' &&
        JSON.stringify(record).includes(TODO_REMINDER_TEXT),
    )
    if (marker || Date.now() > deadline) return records
    await new Promise((resolveTick) => setTimeout(resolveTick, 40))
  }
}

describe('① 默认值：开着、8 轮一次', () => {
  test('todo 设置分区的默认值是 enabled=true / everyRounds=8', async () => {
    // 这条是「节流」这个功能的总开关口径：关着或 1 轮一次，下面的端到端都失去意义。
    const initial = await services.settings.values('todo')
    expect(initial['enabled']).toBe(true)
    expect(initial['everyRounds']).toBe(8)
  })
})

describe('② 真回合：立清单、默认间隔下不早发', () => {
  test('端到端立起了含未完成项的清单', async () => {
    await kernel.runTurn('第一步：先立清单再动手')
    const items = services.todo.todoView().items
    expect(items.some((item) => item.status === 'in_progress')).toBe(true)
  })

  test('第一轮请求体内没有提醒', () => {
    expect(reminderAt(llm.bodies[0])).toBe(-1)
  })

  test('第二轮（1 轮）不注入（默认 8）', () => {
    expect(reminderAt(llm.bodies[1])).toBe(-1)
  })

  test('又跑一轮，默认间隔下 2 轮仍不注入', async () => {
    await kernel.runTurn('第二步')
    expect(reminderAt(llm.bodies[2])).toBe(-1)
  })
})

describe('③ 调小间隔：到点注入一条，落在请求末尾', () => {
  /** 注入那一轮之后的 jsonl 记录。 */
  let records: Array<Record<string, unknown>>

  test('把间隔调成 2 轮后，下一次请求恰好注入一条', async () => {
    await services.settings.save('todo', 'everyRounds', 2)
    await kernel.runTurn('第三步')
    const body = llm.bodies[3] as ChatMessage[]
    expect(body.filter((message) => message.role === 'user' && message.content === TODO_REMINDER_TEXT)).toHaveLength(1)
  })

  test('注入的是 user 角色，正文就是提醒原文', () => {
    const body = llm.bodies[3] as ChatMessage[]
    expect(body.at(-1)?.role).toBe('user')
    expect(body.at(-1)?.content).toBe(TODO_REMINDER_TEXT)
  })

  test('提醒落在请求末尾（环境快照之后）', () => {
    const body = llm.bodies[3] as ChatMessage[]
    expect(reminderAt(body)).toBe(body.length - 1)
  })

  test('会话日志（内存）里没有这条提醒', () => {
    // 提醒是投影注入，只改「发给模型的副本」；写进会话历史会让它变成真对话、下一轮再被数一次。
    const messages = services.session.current().messages
    expect(messages.some((message) => message.content === TODO_REMINDER_TEXT)).toBe(false)
  })

  test('会话 jsonl 里没有把提醒当成消息落盘', async () => {
    records = await waitForInjectionRecord(services.session.current().filePath)
    const asMessage = records.some(
      (record) =>
        (record.type === 'user' || record.type === 'assistant') &&
        JSON.stringify(record).includes(TODO_REMINDER_TEXT),
    )
    expect(asMessage).toBe(false)
  })

  test('注入标记（context-injected）记下了这一条的预览', () => {
    // 这条标记是给界面画「这里注入过一条」的元数据，不是消息；有它才证明注入确实走了上报闸。
    const marker = records.some(
      (record) =>
        record.type === 'state' &&
        record.id === 'context-injected' &&
        JSON.stringify(record).includes(TODO_REMINDER_TEXT),
    )
    expect(marker).toBe(true)
  })

  test('清空清单后不再注入（没有未完成项）', async () => {
    services.todo.clearTodos()
    await kernel.runTurn('第五步')
    expect(reminderAt(llm.bodies[4])).toBe(-1)
  })
})
