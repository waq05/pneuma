/**
 * todo 纯存储面的长尾补盲（w14）：模型不给 id 时自动补短 id、merge 模式对正文/父任务
 * 的增量修改、超长正文截断并记 note，以及设置分区 `fields()` 的字段清单。
 *
 * `todo.ts` 是零依赖的存储类，直接 new；只有设置分区那一条要挂插件（`DSC_HOME`
 * 先指进临时目录再动态 import）。不碰真实 `~/.dsc`。
 *
 * @module dsc/packages/todo/tests/w14-gaps.spec
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsSectionSpec, TodoService } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeAll, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-todo-w14-'))
process.env['DSC_HOME'] = HOME
mkdirSync(join(HOME, 'plugins'), { recursive: true })

let todo: typeof import('../todo.js')
let todoPlugin: (typeof import('../index.js'))['todoPlugin']

beforeAll(async () => {
  todo = await import('../todo.js')
  todoPlugin = (await import('../index.js')).todoPlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 句柄：留给系统清
  }
})

test('整表写入时模型不给 id：自动补一个短 id', () => {
  const store = new todo.TodoStore()
  const result = store.write([{ content: '先跑测试' }, { content: '再改文档', status: 'in_progress' }])
  expect(result.items).toHaveLength(2)
  for (const item of result.items) expect(item.id).toMatch(/^[a-z0-9]{6}$/)
  expect(result.items[1]?.status).toBe('in_progress')
  expect(store.rev).toBe(1)
})

test('merge 模式：正文按给出的改、parent 可设可清，未给的字段不动', () => {
  const store = new todo.TodoStore()
  store.write([
    { id: 'a', content: '父任务', status: 'pending' },
    { id: 'b', content: '子任务', status: 'pending' },
  ])
  const merged = store.write(
    [
      { id: 'a', content: '  改过的父任务  ', parent: '' },
      { id: 'b', parent: 'a' },
      { id: 'new', content: '新增的一条', parent: 'a' },
    ],
    true,
  )
  const byId = new Map(merged.items.map((item) => [item.id, item]))
  expect(byId.get('a')?.content).toBe('改过的父任务')
  expect(byId.get('a')?.parent).toBeUndefined()
  expect(byId.get('b')?.parent).toBe('a')
  expect(byId.get('b')?.content).toBe('子任务')
  expect(byId.get('new')).toMatchObject({ content: '新增的一条', parent: 'a' })
})

test('超过上限的正文截断并记一条 note', () => {
  const store = new todo.TodoStore()
  const result = store.write([{ content: 'x'.repeat(todo.MAX_TODO_CONTENT_CHARS + 20) }])
  const content = result.items[0]?.content ?? ''
  expect(content.length).toBe(todo.MAX_TODO_CONTENT_CHARS)
  expect(content.endsWith('…')).toBe(true)
  expect(result.notes.join('|')).toContain(`超过 ${String(todo.MAX_TODO_CONTENT_CHARS)} 字`)
})

test('设置分区的 fields() 返回两个可调项', () => {
  const sections: SettingsSectionSpec[] = []
  const ctx = {
    tools: { register: () => () => undefined },
    prompt: { registerProjection: () => () => undefined },
    settings: {
      registerSection(spec: SettingsSectionSpec) {
        sections.push(spec)
        return () => undefined
      },
    },
    surfaces: { register: () => () => undefined },
    waiting: { register: () => () => undefined },
    compact: { registerCarry: () => () => undefined },
    commands: { register: () => () => undefined },
    on: () => () => undefined,
    emit: () => undefined,
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
    get: () => undefined,
    session: { current: () => ({ meta: { id: 'todo-w14', cwd: HOME }, state: () => undefined, appendState: () => undefined }) },
    llm: { model: 'm', provider: 'p' },
    provide() {},
  }
  todoPlugin.apply?.(ctx as never, {} as never)
  const section = sections[0]!
  const service = section.fields() as Array<Record<string, unknown>>
  expect(service.map((field) => field['key'])).toEqual(['enabled', 'everyRounds'])
})
