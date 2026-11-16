/**
 * todo 插件装配面的补盲（`packages/todo/index.ts`）：`todo_write` 的坏输入与 merge 分支、
 * 会话归属（sessionId / sessionPath / 当前会话）、按会话隔离与恢复、服务视图、节流提醒投影
 * （未到期 / 关闭 / 无未完成项 / 真注入 / 二次派生去重）、设置读写与 `/todo` 命令。
 *
 * `todo.spec.ts` 只验 schema 与一次整表写入；这一份补的是失败路径与按会话分流。
 * 所有插件配置都写临时 `DSC_HOME/plugins.json`，不碰真实 `~/.dsc`。
 *
 * @module dsc/packages/todo/tests/wiring-extra.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SettingsSectionSpec, TodoService } from '@pneuma/runtime/services/types.js'
import { TODO_REMINDER_TEXT } from '@pneuma/runtime/core/todo-reminder.js'
import { afterAll, beforeEach, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-todo-wiring-'))
process.env['DSC_HOME'] = HOME
const PLUGINS_FILE = join(HOME, 'plugins.json')
const WORK = mkdtempSync(join(tmpdir(), 'dsc-todo-wiring-cwd-'))

type TodoModule = typeof import('../index.js')
let todoPlugin: TodoModule['todoPlugin']

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const { todoPlugin: loadedPlugin } = await import('../index.js')
todoPlugin = loadedPlugin

interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  messages: ChatMessage[]
  state: (name: string) => unknown
  stateMap: Map<string, unknown>
  appendState: (name: string, value: unknown) => void
  appendNote: (kind: string, text: string) => void
  notes: Array<{ kind: string; text: string }>
}

function makeSession(id: string, initial?: Record<string, unknown>): FakeSession {
  const stateMap = new Map<string, unknown>(Object.entries(initial ?? {}))
  const notes: Array<{ kind: string; text: string }> = []
  return {
    meta: { id, cwd: WORK },
    filePath: join(WORK, '.dsc', 'sessions', `${id}.jsonl`),
    messages: [],
    state: (name) => stateMap.get(name),
    stateMap,
    appendState: (name, value) => {
      stateMap.set(name, value)
    },
    appendNote: (kind, text) => {
      notes.push({ kind, text })
    },
    notes,
  }
}

type Projection = (messages: ChatMessage[], session?: FakeSession, report?: (item: unknown) => void) => ChatMessage[]

type CommandHandler = (input: { args: string[]; ui: { notice: (text: string) => void } }) => unknown

interface Harness {
  tool: ToolEntry
  service: TodoService
  section: SettingsSectionSpec
  projections: Map<string, Projection>
  carries: Array<(session?: FakeSession) => string>
  commands: Map<string, CommandHandler>
  handlers: Map<string, Array<(payload?: unknown) => void>>
  surfaces: Map<string, () => unknown>
  notices: string[]
  emitted: string[]
  offCount: number
  cleanup: () => void
  current: FakeSession
  setCurrent: (session: FakeSession) => void
  sessionsById: Map<string, FakeSession>
  sessionsByPath: Map<string, FakeSession>
}

function mount(): Harness {
  const current = makeSession('sess-1')
  let currentRef = current
  const sessionsById = new Map<string, FakeSession>()
  const sessionsByPath = new Map<string, FakeSession>()
  const projections = new Map<string, Projection>()
  const carries: Array<(session?: FakeSession) => string> = []
  const commands = new Map<string, CommandHandler>()
  const handlers = new Map<string, Array<(payload?: unknown) => void>>()
  const surfaces = new Map<string, () => unknown>()
  const notices: string[] = []
  const emitted: string[] = []
  let offCount = 0
  let tool: ToolEntry | undefined
  let service: TodoService | undefined
  let section: SettingsSectionSpec | undefined
  const off = (): void => {
    offCount += 1
  }
  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      return typeof result === 'function' ? result : off
    },
    session: { current: () => currentRef },
    get(name: string) {
      if (name === 'agent') {
        return {
          sessionFor: (filePath: string) => sessionsByPath.get(filePath),
          sessionById: (id: string) => sessionsById.get(id),
        }
      }
      return undefined
    },
    provide(_name: string, value: TodoService) {
      service = value
    },
    tools: {
      register(entry: ToolEntry) {
        tool = entry
        return off
      },
    },
    surfaces: {
      register(id: string, read: () => unknown) {
        surfaces.set(id, read)
        return off
      },
    },
    compact: {
      registerCarry(contribute: (session?: FakeSession) => string) {
        carries.push(contribute)
        return () => {
          const at = carries.indexOf(contribute)
          if (at >= 0) carries.splice(at, 1)
        }
      },
    },
    prompt: {
      registerProjection(id: string, projection: Projection) {
        projections.set(id, projection)
        return off
      },
    },
    settings: {
      registerSection(spec: SettingsSectionSpec) {
        section = spec
        return off
      },
    },
    commands: {
      register(spec: { name: string }, handler: CommandHandler) {
        commands.set(spec.name, handler)
        return off
      },
    },
    on(event: string, handler: (payload?: unknown) => void) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return off
    },
    emit(event: string, ...args: unknown[]) {
      emitted.push(event)
      if (event === 'dsc/notice' && typeof args[0] === 'string') notices.push(args[0])
    },
  }
  const cleanup = todoPlugin.apply?.(ctx as never, {} as never)
  if (tool === undefined || service === undefined || section === undefined) {
    throw new Error('todo apply 没有注册工具/服务/设置分区')
  }
  return {
    tool,
    service,
    section,
    projections,
    carries,
    commands,
    handlers,
    surfaces,
    notices,
    emitted,
    get offCount() {
      return offCount
    },
    cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : () => undefined,
    current,
    setCurrent: (session) => {
      currentRef = session
    },
    sessionsById,
    sessionsByPath,
  }
}

const runCtx = (sessionId?: string, sessionPath?: string): { sessionId?: string; sessionPath?: string } => ({
  sessionId,
  sessionPath,
})

function writePluginConfig(config: Record<string, unknown>): void {
  writeFileSync(
    PLUGINS_FILE,
    JSON.stringify({ version: 1, entries: [{ file: 'todo', config }] }),
    'utf8',
  )
}

function readPluginConfig(): Record<string, unknown> {
  const saved = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8')) as {
    entries?: Array<{ file?: string; config?: Record<string, unknown> }>
  }
  return saved.entries?.find((entry) => entry.file === 'todo')?.config ?? {}
}

const todo = (id: string, content: string, status = 'pending', parent?: string): Record<string, unknown> => ({
  id,
  content,
  status,
  ...(parent === undefined ? {} : { parent }),
})

test('todo_write：todos 不是数组就抛，空表回「已清空」', async () => {
  const harness = mount()
  const run = (args: Record<string, unknown>): Promise<unknown> =>
    harness.tool.run(args as never, runCtx('sess-1') as never)
  await expect(run({})).rejects.toThrow('todos 必须是数组')
  await expect(run({ todos: 'not-array' })).rejects.toThrow('todos 必须是数组')
  expect(String(await run({ todos: [] }))).toBe('清单已清空。')
})

test('todo_write：整表 + merge 的增改、缺 id / 未知状态 / 空正文 / 重复 id / 孤儿 parent 都给注意', async () => {
  const harness = mount()
  const run = (args: Record<string, unknown>): Promise<unknown> =>
    harness.tool.run(args as never, runCtx('sess-1') as never)

  const first = String(await run({ todos: [todo('a', '第一件', 'completed'), todo('b', '第二件', 'in_progress')] }))
  expect(first).toContain('清单已更新（1/2 完成）')
  expect(first).toContain('[>] b 第二件')

  const merged = String(
    await run({
      merge: true,
      todos: [
        { id: 'b', status: 'completed' },
        { id: 'c', content: '第三件', parent: 'missing-parent' },
        { content: '缺 id 的补丁' },
        { id: 'a', status: 'doing' },
        { id: 'a', content: '   ' },
      ],
    }),
  )
  expect(merged).toContain('merge 模式必须给 id')
  expect(merged).toContain('doing 不认识，保持 completed')
  expect(merged).toContain('parent 找不到对应任务')
  expect(merged).toContain('清单已更新（2/3 完成）')

  const messy = String(
    await run({
      todos: [
        todo('dup', '先来的'),
        todo('dup', '后来的'),
        { content: '   ' },
        '不是对象',
        todo('orphan', '孤儿', 'pending', 'no-such-parent'),
      ],
    }),
  )
  expect(messy).toContain('id dup 出现两次')
  expect(messy).toContain('有一条任务正文是空的')
  expect(messy).toContain('有一条任务不是对象')
  expect(messy).toContain('parent 找不到对应任务')

  // 超过 64 条的截断分支。
  const many = String(await run({ todos: Array.from({ length: 70 }, (_, index) => todo(`m${index}`, `第 ${index} 件`)) }))
  expect(many).toContain('只保留前 64 条')
})

test('服务视图：cancelled 不计分母、in_progress 作为 active；清空与提示词', async () => {
  const harness = mount()
  const run = (args: Record<string, unknown>): Promise<unknown> =>
    harness.tool.run(args as never, runCtx('sess-1') as never)
  await run({
    todos: [
      todo('a', '做完了', 'completed'),
      todo('b', '正在做', 'in_progress'),
      todo('c', '不做了', 'cancelled'),
    ],
  })
  const view = harness.service.todoView()
  expect(view).toMatchObject({ done: 1, total: 2, active: '正在做' })
  expect(view.items).toHaveLength(3)
  expect(view.revision).toBeGreaterThan(0)

  expect(harness.service.todoPrompt()).toContain('本次任务清单（当前进度')
  harness.service.clearTodos()
  expect(harness.notices).toContain('任务清单已清空')
  expect(harness.current.state('todos')).toEqual([])
  expect(harness.service.todoPrompt()).toBe('')
})

test('会话归属：sessionId 名册、sessionPath 活会话、未知 id 回落当前；两条会话互不覆盖', async () => {
  const harness = mount()
  const other = makeSession('other')
  harness.sessionsById.set('other', other)
  const live = makeSession('live')
  harness.sessionsByPath.set(live.filePath, live)

  const run = (args: Record<string, unknown>, ctx: { sessionId?: string; sessionPath?: string }): Promise<unknown> =>
    harness.tool.run(args as never, ctx as never)

  await run({ todos: [todo('o', '别的会话')] }, runCtx('other'))
  await run({ todos: [todo('l', '按路径')] }, runCtx(undefined, live.filePath))
  await run({ todos: [todo('x', '未知 id 回落当前')] }, runCtx('not-in-roster', '/no/such/file.jsonl'))

  expect(other.state('todos')).toEqual([todo('o', '别的会话')])
  expect(live.state('todos')).toEqual([todo('l', '按路径')])
  expect(harness.current.state('todos')).toEqual([todo('x', '未知 id 回落当前')])
  // 界面服务只看当前会话，不会被别的会话的写入顶掉。
  expect(harness.service.todoView().items.map((item) => item.content)).toEqual(['未知 id 回落当前'])
})

test('sessionPath 指向真实日志：只读重放恢复清单并写回原路径', async () => {
  const { Session } = await import('@pneuma/runtime/core/session.js')
  const filePath = join(WORK, '.dsc', 'sessions', 'teammate.jsonl')
  mkdirSync(join(WORK, '.dsc', 'sessions'), { recursive: true })
  const real = Session.create(WORK, filePath)
  real.appendUser('先落一条真实消息，state 才会跟着写盘')
  real.appendState('todos', [todo('r', '重放回来的')] as never)
  real.close()
  // 写流是异步的：等它把 meta / state 落完，再让插件按路径只读重放。
  await new Promise((resolve) => setTimeout(resolve, 150))

  const harness = mount()
  const text = String(
    await harness.tool.run({ todos: [todo('r', '重放回来的'), todo('n', '新加一条')] } as never, runCtx(undefined, filePath) as never),
  )
  expect(text).toContain('清单已更新（0/2 完成）')
  // 第二次仍走 sessionPath：命中的是缓存的那份只读重放会话，状态在内存里接着用。
  const merged = String(
    await harness.tool.run(
      { merge: true, todos: [{ id: 'n', status: 'completed' }] } as never,
      runCtx(undefined, filePath) as never,
    ),
  )
  expect(merged).toContain('清单已更新（1/2 完成）')
  const written = readFileSync(filePath, 'utf8')
  expect(written).toContain('重放回来的')
})

test('提醒投影：未到期 / 开关关 / 没有未完成项都原样返回', async () => {
  writePluginConfig({ enabled: true, everyRounds: 5 })
  const harness = mount()
  const projection = harness.projections.get('todo-reminder')
  expect(projection).toBeDefined()
  await harness.tool.run({ todos: [todo('a', '还没做完')] } as never, runCtx() as never)
  const messages: ChatMessage[] = [{ role: 'user', content: '开始' }, { role: 'assistant', content: '好' }]
  expect(projection?.(messages, harness.current)).toBe(messages)

  writePluginConfig({ enabled: false, everyRounds: 1 })
  const off = mount()
  await off.tool.run({ todos: [todo('a', '还没做完')] } as never, runCtx() as never)
  const messages2: ChatMessage[] = [{ role: 'user', content: '开始' }, { role: 'assistant', content: '好' }]
  expect(off.projections.get('todo-reminder')?.(messages2, off.current)).toBe(messages2)

  writePluginConfig({ enabled: true, everyRounds: 1 })
  const done = mount()
  await done.tool.run({ todos: [todo('a', '做完了', 'completed')] } as never, runCtx() as never)
  const messages3: ChatMessage[] = [{ role: 'user', content: '开始' }, { role: 'assistant', content: '好' }]
  expect(done.projections.get('todo-reminder')?.(messages3, done.current)).toBe(messages3)
})

test('提醒投影：到期注入、落 note、上报一次；同轮二次派生不重复，下一轮再注一次', async () => {
  writePluginConfig({ enabled: true, everyRounds: 1 })
  const harness = mount()
  await harness.tool.run({ todos: [todo('a', '还没做完', 'in_progress')] } as never, runCtx() as never)
  const projection = harness.projections.get('todo-reminder')
  const reports: unknown[] = []
  const messages: ChatMessage[] = [{ role: 'user', content: '开始' }, { role: 'assistant', content: '好' }]
  harness.current.messages = messages

  const injected = projection?.(messages, harness.current, (item) => reports.push(item)) ?? messages
  expect(injected).toHaveLength(3)
  expect(injected.at(-1)).toEqual({ role: 'user', content: TODO_REMINDER_TEXT })
  expect(harness.current.notes).toHaveLength(1)
  expect(harness.current.notes[0]).toMatchObject({ kind: 'todo-reminder', text: TODO_REMINDER_TEXT })
  expect(reports).toHaveLength(1)

  // 同一份历史再跑一次（invariant 校验）：还是补这句，但 note/卡都不重复。
  const again = projection?.(messages, harness.current, (item) => reports.push(item)) ?? messages
  expect(again).toHaveLength(3)
  expect(harness.current.notes).toHaveLength(1)
  expect(reports).toHaveLength(1)

  // 下一轮（最后一条换成新对象）：再注一次、再落一条 note；同一句正文不再记卡。
  const next: ChatMessage[] = [...messages, { role: 'assistant', content: '继续' }]
  harness.current.messages = next
  const third = projection?.(next, harness.current, (item) => reports.push(item)) ?? next
  expect(third).toHaveLength(4)
  expect(harness.current.notes).toHaveLength(2)
  expect(reports).toHaveLength(1)
})

test('提醒配置：values 现读磁盘，everyTurns 回退、字符串 false、间隔夹到 1..100', () => {
  writePluginConfig({ enabled: 'false', everyTurns: 0 })
  const harness = mount()
  expect(harness.section.values()).toEqual({ enabled: false, everyRounds: 1 })

  writePluginConfig({ enabled: true, everyRounds: 999 })
  expect(harness.section.values()).toEqual({ enabled: true, everyRounds: 100 })

  writePluginConfig({ enabled: true, everyRounds: -5 })
  expect(harness.section.values()).toEqual({ enabled: true, everyRounds: 1 })

  writePluginConfig({ enabled: true, everyRounds: 'abc' })
  expect(harness.section.values()).toEqual({ enabled: true, everyRounds: 8 })
})

test('设置保存：开关收布尔与字符串真值，越界/非数字/未知键给文案', () => {
  const harness = mount()
  const save = harness.section.save as (key: string, value: unknown) => string | void
  expect(save('enabled', true)).toBeUndefined()
  expect(readPluginConfig().enabled).toBe(true)
  expect(save('enabled', 'false')).toBeUndefined()
  expect(readPluginConfig().enabled).toBe(false)

  expect(save('everyRounds', 'abc')).toBe('这里要填一个数字')
  expect(save('everyRounds', 0)).toBe('间隔要在 1 到 100 之间')
  expect(save('everyRounds', 101)).toBe('间隔要在 1 到 100 之间')
  expect(save('everyRounds', 3.6)).toBeUndefined()
  expect(readPluginConfig().everyRounds).toBe(4)

  expect(String(save('nope', 1))).toContain('这个分区没有这项：nope')
})

test('/todo：没有清单时说一句，有清单时回显；clear 清空并广播', async () => {
  const harness = mount()
  const command = harness.commands.get('todo')
  expect(command).toBeDefined()
  const notices: string[] = []
  command?.({ args: [], ui: { notice: (text) => notices.push(text) } })
  expect(notices[0]).toBe('当前没有任务清单。')

  await harness.tool.run({ todos: [todo('a', '一件事', 'pending')] } as never, runCtx() as never)
  command?.({ args: [], ui: { notice: (text) => notices.push(text) } })
  expect(notices[1]).toContain('[ ] a 一件事')

  command?.({ args: ['clear'], ui: { notice: (text) => notices.push(text) } })
  expect(harness.notices).toContain('任务清单已清空')
  expect(harness.current.state('todos')).toEqual([])
})

test('session-open：有状态就恢复，没有就清空；压缩携带按被压会话取清单', async () => {
  const harness = mount()
  const restored = makeSession('restored', { todos: [todo('r', '历史清单')] })
  const empty = makeSession('empty')
  for (const handler of harness.handlers.get('dsc/session-open') ?? []) handler({ session: restored })
  for (const handler of harness.handlers.get('dsc/session-open') ?? []) handler({ session: empty })

  const carry = harness.carries[0]
  expect(carry).toBeDefined()
  expect(carry?.(restored)).toContain('历史清单')
  expect(carry?.(empty)).toBe('')
  expect(harness.emitted).toContain('dsc/changed')
})

test('收尾：投影与设置分区都被撤掉，重复调用不抛', () => {
  const harness = mount()
  const before = harness.offCount
  harness.cleanup()
  expect(harness.offCount).toBeGreaterThan(before)
  expect(() => harness.cleanup()).not.toThrow()
})
