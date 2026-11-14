/**
 * todo_write 待办工具卡的判据与清单解析（ui 层）。
 *
 * 来源：`scripts/ui-tool-views-test.mjs` 第 [3] 段（判据、四态、子任务层级、结果优先、清空）
 * 与第 [6] 段的本卡字典键。`todo-model.ts` 零 import，直接 import 跑的就是产品代码。
 * 原探针的装配 / 样式钉（factory 里的判据写法、views.css 的缩进变量）不迁——归组件渲染批。
 *
 * @module dsc-ui-transcript/ui/tool-card/todo-model.spec
 */
import { expect, test } from 'vitest'
import en from '../../locale/ui.en.json'
import zh from '../../locale/ui.zh.json'
import { todoCallOf, todoListOf } from './todo-model.js'

/** 三条待办：完成 / 进行中 / 挂在 b2 底下的子任务。 */
const ARGS = JSON.stringify({
  todos: [
    { id: 'a1', content: '写单测', status: 'completed' },
    { id: 'b2', content: '跑构建', status: 'in_progress' },
    { id: 'c3', content: '收尾', status: 'pending', parent: 'b2' },
  ],
})

// ── 判据：名字 + todos 数组 ──────────────────────────────────────────────────

test('todo_write + todos 数组 → 一张待办卡；默认不是 merge', () => {
  const call = todoCallOf('todo_write', ARGS)
  expect(call?.items).toHaveLength(3)
  expect(call?.merge).toBe(false)
})

test('merge: true 认出来；清空（todos: []）也是这张卡', () => {
  expect(todoCallOf('todo_write', '{"todos":[],"merge":true}')?.merge).toBe(true)
  expect(todoCallOf('todo_write', '{"todos":[]}')?.items).toHaveLength(0)
})

test('名字不是 todo_write、没有 todos、todos 不是数组 → 都不是这张卡', () => {
  expect(todoCallOf('todo', ARGS)).toBeNull()
  expect(todoCallOf('todo_write', '{"merge":true}')).toBeNull()
  expect(todoCallOf('todo_write', '{"todos":"x"}')).toBeNull()
})

test('半截 JSON → 不抛', () => {
  expect(todoCallOf('todo_write', '{"todos":[')).toBeNull()
})

test('不认识的 status 按 pending；没有正文的条目跳过（宿主也会丢）', () => {
  expect(todoCallOf('todo_write', '{"todos":[{"content":"x","status":"?"}]}')?.items[0]?.status).toBe('pending')
  expect(todoCallOf('todo_write', '{"todos":[{"status":"pending"},{"content":"y"}]}')?.items).toHaveLength(1)
})

test('子任务按 parent 链算层级；父 id 不在本次参数里时按顶层算（merge 常态）', () => {
  const call = todoCallOf('todo_write', ARGS)
  expect(call?.items[2]?.depth).toBe(1)
  expect(todoCallOf('todo_write', '{"todos":[{"content":"x","parent":"zzz"}]}')?.items[0]?.depth).toBe(0)
})

// ── 结果解析（merge 模式下结果优先：参数里只有一条，结果回显整表） ────────────

/** 宿主对 merge 写入的回执形状。 */
const MERGE_RESULT = [
  '清单已更新（1/3 完成）',
  '[x] a1 写单测',
  '[>] b2 跑构建',
  '  [ ] c3 收尾',
  '进度 1/3',
].join('\n')

const mergeCall = todoCallOf('todo_write', '{"todos":[{"id":"a1","content":"写单测","status":"completed"}],"merge":true}') as NonNullable<ReturnType<typeof todoCallOf>>

test('结果优先：merge 模式下也画得出整表（3 条）', () => {
  const merged = todoListOf(mergeCall, MERGE_RESULT)
  expect(merged.items).toHaveLength(3)
})

test('四态符号解析：[x] 完成 / [>] 进行中 / [ ] 未做 / [~] 取消', () => {
  const merged = todoListOf(mergeCall, MERGE_RESULT)
  expect(merged.items[0]?.status).toBe('completed')
  expect(merged.items[1]?.status).toBe('in_progress')
  expect(merged.items[2]?.status).toBe('pending')
  const cancelled = todoListOf(todoCallOf('todo_write', '{"todos":[]}') as NonNullable<ReturnType<typeof todoCallOf>>, '[~] z9 不做了\n进度 0/0')
  expect(cancelled.items[0]?.status).toBe('cancelled')
})

test('结果里的缩进算出子任务层级；id 与正文分开', () => {
  const merged = todoListOf(mergeCall, MERGE_RESULT)
  expect(merged.items[2]?.depth).toBe(1)
  expect(merged.items[1]?.id).toBe('b2')
  expect(merged.items[1]?.content).toBe('跑构建')
})

test('进度 1/3（完成数 / 有效总数）；取消的不进分母', () => {
  const merged = todoListOf(mergeCall, MERGE_RESULT)
  expect(merged.done).toBe(1)
  expect(merged.total).toBe(3)
  const list = todoListOf(todoCallOf('todo_write', '{"todos":[]}') as NonNullable<ReturnType<typeof todoCallOf>>, '[x] a 完成\n[~] b 取消\n进度 1/1')
  expect(list.total).toBe(1)
  expect(list.done).toBe(1)
})

test('宿主的「注意：」提示留着', () => {
  const notes = todoListOf(todoCallOf('todo_write', '{"todos":[]}') as NonNullable<ReturnType<typeof todoCallOf>>, '清单已更新（1/1 完成）\n[x] a 完成\n进度 1/1\n注意：只保留前 64 条')
  expect(notes.notes).toHaveLength(1)
  expect(notes.notes[0]).toContain('只保留前 64 条')
})

test('清空回执 → cleared 为真；还没落地时退回参数（不猜「已清空」）', () => {
  const emptyCall = todoCallOf('todo_write', '{"todos":[]}') as NonNullable<ReturnType<typeof todoCallOf>>
  const cleared = todoListOf(emptyCall, '清单已清空。')
  expect(cleared.cleared).toBe(true)
  expect(cleared.items).toHaveLength(0)
  const before = todoListOf(emptyCall, '')
  expect(before.cleared).toBe(false)
  expect(before.items).toHaveLength(0)
})

test('结果认不出（报错散文）→ 退回参数，不清空卡；没有结果时进度按参数算', () => {
  const call = todoCallOf('todo_write', ARGS) as NonNullable<ReturnType<typeof todoCallOf>>
  const failed = todoListOf(call, 'todos 必须是数组')
  expect(failed.items).toHaveLength(3)
  expect(failed.cleared).toBe(false)
  const draft = todoListOf(call, '')
  expect(draft.done).toBe(1)
  expect(draft.total).toBe(3)
})

// ── 本卡字典键（数据断言） ───────────────────────────────────────────────────

const TODO_KEYS = ['transcript.tool.todoProgress', 'transcript.tool.todoEmpty', 'transcript.tool.todoCleared'] as const

test('待办卡用到的三个键两份字典都在（非空字符串，英文真译过）', () => {
  for (const key of TODO_KEYS) {
    expect(typeof zh[key] === 'string' && (zh[key] as string).trim() !== '', `zh 有 ${key}`).toBe(true)
    expect(typeof en[key] === 'string' && (en[key] as string).trim() !== '', `en 有 ${key}`).toBe(true)
    expect(/[\u4e00-\u9fff]/.test(String(en[key] ?? '')), `${key} 的英文里没有汉字`).toBe(false)
  }
})
