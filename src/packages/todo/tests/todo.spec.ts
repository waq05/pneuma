/**
 * todo 包级测试：插件对象 + `todo_write` 工具的真实 schema 与行为。
 *
 * 迁移说明：原文件六条断言里五条读 `index.ts` 源码文本（`name: 'todo_write'`、
 * `required: ['todos']`、`risk: 'read'`、四态字符串、`parent: { type: 'string'`）。
 * 这些字符串描述的对象**只在 apply() 之后才存在**，所以现在用假 ctx 真跑一遍 apply，
 * 从 `tools.register` 抓注册出来的工具对象逐项断言；另外补两条行为用例：真调 run 写清单、
 * 非法状态回落 pending。改引号、改缩进不会红；把工具改名、把 risk 改成 write、把
 * `required` 写错、删掉四态之一，都会红。
 *
 * 环境隔离：`readReminderConfig` 读 `DSC_HOME` 下的 `plugins.json`，所以先把它指到
 * `mkdtempSync` 的临时目录再动态 import 插件；真实 `~/.dsc` 一个字节都不碰。
 *
 * @module @pneuma/todo/tests
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SettingsSectionSpec, TodoService } from '@pneuma/runtime/services/types.js'
import { afterAll, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-todo-spec-'))
process.env.DSC_HOME = home

const { todoPlugin } = await import('../index.js')
const { TODO_STATUSES } = await import('../todo.js')

/** 一条被捕获的清单条目。 */
interface TodoShape {
  id: string
  content: string
  status: string
  parent?: string
}

/** 工具参数的形状（只写测试用得到的部分）。 */
interface ToolParameters {
  type: string
  properties: Record<string, { type?: string; description?: string; items?: { type?: string; properties?: Record<string, { type?: string }>; required?: string[] } }>
  required?: string[]
}

/** 抓到的一次装配。 */
interface Harness {
  tool: ToolEntry
  parameters: ToolParameters
  service: TodoService
  section: SettingsSectionSpec
  surfaces: Map<string, () => unknown>
  /** 登记一条假会话，让工具的 `sessionId` 解析得到它（模拟 agent 名册）。 */
  addSession: (session: FakeSession) => void
}

/** 一份够用的假会话：状态存在 Map 里，清单工具只碰这几项。 */
interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  messages: unknown[]
  state: (name: string) => unknown
  appendState: (name: string, value: unknown) => void
}

function fakeSession(): FakeSession {
  const state = new Map<string, unknown>()
  return {
    meta: { id: 'todo-spec-session', cwd: home },
    filePath: join(home, 'session.jsonl'),
    messages: [],
    state: (name) => state.get(name),
    appendState: (name, value) => {
      state.set(name, value)
    },
  }
}

/** 假 ctx：apply 用到的面都实现，`effect` 真跑回调（否则注册不会发生）。 */
function mount(): Harness {
  const harness = {
    tool: undefined as unknown as ToolEntry,
    parameters: undefined as unknown as ToolParameters,
    service: undefined as unknown as TodoService,
    section: undefined as unknown as SettingsSectionSpec,
    surfaces: new Map<string, () => unknown>(),
    addSession: (session: FakeSession) => {
      sessions.set(session.meta.id, session)
    },
  }
  // 工具按 runCtx.sessionId 解析会话时会先问 agent 名册（见 index.ts 的 sessionOf）。
  const sessions = new Map<string, FakeSession>()
  const session = fakeSession()
  sessions.set(session.meta.id, session)
  const ctx = {
    session: { current: () => session },
    get: (name: string) =>
      name === 'agent' ? { sessionFor: () => undefined, sessionById: (id: string) => sessions.get(id) } : undefined,
    provide: (_name: string, value: TodoService) => {
      harness.service = value
    },
    tools: {
      register: (entry: ToolEntry) => {
        harness.tool = entry
        harness.parameters = entry.parameters as unknown as ToolParameters
        return () => {}
      },
    },
    surfaces: {
      register: (id: string, read: () => unknown) => {
        harness.surfaces.set(id, read)
        return () => {}
      },
    },
    compact: { registerCarry: () => () => {} },
    prompt: { registerProjection: () => () => {} },
    settings: {
      registerSection: (spec: SettingsSectionSpec) => {
        harness.section = spec
        return () => {}
      },
    },
    commands: { register: () => () => {} },
    on: () => () => {},
    emit: () => {},
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  todoPlugin.apply(ctx as never, {})
  return harness
}

/** 装配一次，返回抓到的工具与设置分区。 */
const harness = mount()

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

test('插件对象：名字、提供服务、可 apply', () => {
  expect(todoPlugin.name).toBe('todo')
  expect(todoPlugin.provide).toBe('todo')
  expect(typeof todoPlugin.apply).toBe('function')
})

test('inject 声明了它真正用到的七个服务', () => {
  expect([...(todoPlugin.inject ?? [])]).toEqual([
    'session',
    'tools',
    'commands',
    'surfaces',
    'compact',
    'prompt',
    'settings',
  ])
})

test('工具叫 todo_write，风险等级是只读', () => {
  expect(harness.tool.name).toBe('todo_write')
  expect(harness.tool.risk).toBe('read')
})

test('schema 必填只有 todos，merge 是布尔开关', () => {
  expect(harness.parameters.required).toEqual(['todos'])
  expect(harness.parameters.properties['merge']?.type).toBe('boolean')
  expect(harness.parameters.properties['todos']?.type).toBe('array')
})

test('子任务的父 id 是可选字段，条目里只有 content 必填', () => {
  const items = harness.parameters.properties['todos']?.items
  expect(items?.properties?.['parent']?.type).toBe('string')
  expect(items?.required).toEqual(['content'])
})

test('状态只有 pending / in_progress / completed / cancelled 四态', async () => {
  // 四态是运行时事实：四份都写得进去，认不出的状态回落 pending 并在回执里说一句。
  const session = fakeSession()
  harness.addSession(session)
  const run = (args: Record<string, unknown>) =>
    harness.tool.run(args as never, { sessionId: session.meta.id } as never)
  await run({
    todos: TODO_STATUSES.map((status, index) => ({ id: `i${index}`, content: `第 ${index} 条`, status })),
  })
  const written = session.state('todos') as TodoShape[]
  expect(written.map((item) => item.status)).toEqual(['pending', 'in_progress', 'completed', 'cancelled'])
  // 认不出的状态按 pending 处理，并在回执里点名
  const text = String(await run({ todos: [{ id: 'x', content: '认不出的状态', status: 'doing' }] }))
  expect(text).toContain('doing 不认识')
  const view = harness.service.todoView()
  expect(view.items.map((item) => item.status)).toEqual(['pending'])
})

test('工具真写进会话：整表替换、进度回显、surface 与设置分区都跟着变', async () => {
  const session = fakeSession()
  harness.addSession(session)
  const run = (args: Record<string, unknown>) =>
    harness.tool.run(args as never, { sessionId: session.meta.id } as never)
  const text = String(
    await run({
      todos: [
        { id: 'a', content: '写下第一行', status: 'completed' },
        { id: 'b', content: '写下第二行', status: 'pending' },
      ],
    }),
  )
  expect(text).toContain('清单已更新（1/2 完成）')
  expect(session.state('todos')).toEqual([
    { id: 'a', content: '写下第一行', status: 'completed' },
    { id: 'b', content: '写下第二行', status: 'pending' },
  ])
  // surface 出的是同一份运行时视图，装配时注册的名字得是 todos。
  expect(harness.surfaces.has('todos')).toBe(true)
  expect(harness.section.id).toBe('todo')
  expect(harness.section.order).toBe(45)
})
