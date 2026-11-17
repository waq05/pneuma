/**
 * todo 节流提醒的纯函数（unit 层）。
 *
 * 来源 `scripts/todo-reminder-test.mjs` 的第 [1][2] 段。那边用自造的 `check()` 逐条打印，
 * 迁过来换 Vitest 的 `test()`：一条用例钉一个行为，红了能直接念出是哪条行为破了。
 * 探针的端到端半段（真内核 + 假 SSE + 抓请求体）不在这里迁——它要起真内核、跑多轮请求，
 * 归 integration 层，另有目标文件。
 *
 * 为什么这组用例不用临时 HOME：`core/todo-reminder.ts` 不读盘、不读环境变量，是纯函数。
 * 探针里设 HOME 是为了端到端那半段（会话落盘），与这两个函数无关。
 *
 * @module dsc/core/todo-reminder.spec
 */
import { expect, test } from 'vitest'
import type { ChatMessage } from './llm.js'
import { TODO_REMINDER_TEXT, appendTodoReminder, countRoundsSinceLastTodoWrite } from './todo-reminder.js'

const userMsg = (text: string): ChatMessage => ({ role: 'user', content: text })
const assistantMsg = (text: string): ChatMessage => ({ role: 'assistant', content: text })

/**
 * 一条真正调用过 todo_write 的 assistant。
 *
 * 为什么要带 `tool_calls`：计数函数找的是「最近一次带 todo_write 调用的 assistant」，
 * 不带调用的 assistant 只是普通一轮。夹具照抄模型真实产出的形状（空正文 + 一个调用）。
 */
const todoWriteMsg = (): ChatMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'todo_write', arguments: '{}' } }],
})

/** todo_write 的工具结果。role 是 `tool`，与 assistant 不是一档，计数时不该算进轮里。 */
const toolResultMsg = (): ChatMessage => ({ role: 'tool', content: '清单已更新（1/1 完成）', tool_call_id: 'c1' })

/**
 * 请求尾部那条程序自动附的环境快照（env-facts 投影，跑在本投影之前）。
 *
 * 它是 `role: 'user'`，正文以「环境事实：」开头——正是「为什么不能用 user 消息数当轮数」
 * 的反例：这条不是用户发言，混进计数就会把「7 轮」数成「8 轮」。
 */
const envSnapshotMsg = (): ChatMessage => ({
  role: 'user',
  content: '环境事实：\n- 今天：2026-10-15\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）',
})

/** 历史：开场写了一次 todo_write，其后接 `rounds` 轮（每轮一条 assistant 消息）。 */
function historyWithRounds(rounds: number): ChatMessage[] {
  const messages: ChatMessage[] = [userMsg('第一步'), todoWriteMsg(), toolResultMsg()]
  for (let index = 0; index < rounds; index += 1) messages.push(assistantMsg(`第 ${index + 1} 轮`))
  return messages
}

/** 默认档位：开、8 轮一次、清单里还有未完成项——`plugins/todo.ts` 的 `REMINDER_DEFAULTS` 同值。 */
const openOptions = { enabled: true, everyRounds: 8, hasOpenTodos: true }

// ── 轮计数 ──────────────────────────────────────────────────────────────────

test('提醒原文就是注入的那句话，一个字都不差', () => {
  // 断言导出常量而不是源码字符串：这条文案同时是「注入判据」（幂等靠它比对），
  // 所以它变了就是行为变了，不是排版变了。
  expect(TODO_REMINDER_TEXT).toBe('（提醒：任务清单有未完成项，做完一步就把状态改掉）')
})

test('历史里没有 todo_write 时从第 0 条起数 assistant（会话恢复路径）', () => {
  // 恢复会话时工具调用可能已被压缩掉，只剩对话；此时不能返回 -1 或抛错，
  // 要从头数——否则提醒在长会话恢复后再也不触发，正是当初要修的那个症状。
  const history = [userMsg('a'), assistantMsg('ok'), userMsg('b'), assistantMsg('ok'), userMsg('c'), assistantMsg('ok')]
  expect(countRoundsSinceLastTodoWrite(history)).toBe(3)
})

test('上次 todo_write 之后只数它后面的 assistant', () => {
  // 写清单之前的 assistant 不该计入，否则「刚写完清单」就已经攒了 N 轮，提醒立刻复发。
  expect(countRoundsSinceLastTodoWrite(historyWithRounds(2))).toBe(2)
})

test('尾部的 env 快照与还没答的当前这轮都不算轮', () => {
  // 关键是 env 快照：它是 user，若按 user 计数就会把 2 轮数成 3 轮。
  // 末尾那条「当前这轮」是 user（模型还没回），自然也不该算。
  const withTail = [...historyWithRounds(2), userMsg('当前这轮'), envSnapshotMsg()]
  expect(countRoundsSinceLastTodoWrite(withTail)).toBe(2)
})

test('工具结果消息（role: tool）不算轮', () => {
  // 一次工具往返不是一轮；把 tool 结果算成轮会让提醒在工具密集的回合里提前喷。
  expect(countRoundsSinceLastTodoWrite([userMsg('x'), todoWriteMsg(), toolResultMsg()])).toBe(0)
})

// ── 注入判定 ────────────────────────────────────────────────────────────────

test('开关关掉时一条都不注入', () => {
  const history = historyWithRounds(20)
  const out = appendTodoReminder(history, { ...openOptions, enabled: false })
  expect(out).toHaveLength(history.length)
  expect(out.some((message) => message.content === TODO_REMINDER_TEXT)).toBe(false)
})

test('刚好到 N 轮时在末尾补一条', () => {
  const history = historyWithRounds(8)
  const out = appendTodoReminder(history, openOptions)
  expect(out).toHaveLength(history.length + 1)
})

test('补的那条是 user 角色', () => {
  // 协议上只有 user 消息能被当成「用户说的话」喂给模型；换成 system 或 assistant
  // 会改语义（要么被当成指令，要么被当成模型自己的历史发言）。
  const out = appendTodoReminder(historyWithRounds(8), openOptions)
  expect(out.at(-1)?.role).toBe('user')
})

test('补的正文就是提醒原文', () => {
  // 幂等判定与界面「注入过一条」的预览都按这段原文比对，正文必须是那一个常量。
  const out = appendTodoReminder(historyWithRounds(8), openOptions)
  expect(out.at(-1)?.content).toBe(TODO_REMINDER_TEXT)
})

test('差一轮（7 < 8）时不注入', () => {
  // 阈值下界：小于 N 一律不注入，否则默认 8 就形同虚设。
  const history = historyWithRounds(7)
  expect(appendTodoReminder(history, openOptions)).toHaveLength(history.length)
})

test('边界：7 轮再加一条 env 快照仍不注入（快照没被当成第 8 轮）', () => {
  // 这条是「按 assistant 计数」的直接推论，也是最容易回归的一条：
  // 一旦有人为了「少算一次工具往返」改成按 user 数，这里立刻红。
  const history = [...historyWithRounds(7), envSnapshotMsg()]
  expect(appendTodoReminder(history, openOptions)).toHaveLength(history.length)
})

test('清单里没有未完成项时不注入', () => {
  // 提醒的正文是「还有未完成项」；清单都清空了还注入就是自相矛盾的噪声。
  const history = historyWithRounds(20)
  expect(appendTodoReminder(history, { ...openOptions, hasOpenTodos: false })).toHaveLength(history.length)
})

test('同一份历史重复投影，长度不变（幂等）', () => {
  const once = appendTodoReminder(historyWithRounds(8), openOptions)
  const twice = appendTodoReminder(once, openOptions)
  expect(twice).toHaveLength(once.length)
})

test('同一份历史重复投影，逐字节相同（幂等）', () => {
  // 校验重算、流中断后的整轮重试都会重新组装同一份历史：结果必须完全一样，
  // 否则「重试一次」就多一条提醒，长会话会被自己的重试喂胖。
  const once = appendTodoReminder(historyWithRounds(8), openOptions)
  expect(appendTodoReminder(once, openOptions)).toEqual(once)
})

test('不改输入原数组', () => {
  // 投影链上别的投影还在读同一份数组；就地 push 会让它们的输入跟着变，
  // 这类串味在长投影链里极难查。
  const history = historyWithRounds(8)
  appendTodoReminder(history, openOptions)
  expect(history).toHaveLength(11)
  expect(history.some((message) => message.content === TODO_REMINDER_TEXT)).toBe(false)
})

test('注入时返回的是新数组，不是原数组', () => {
  const history = historyWithRounds(8)
  expect(appendTodoReminder(history, openOptions)).not.toBe(history)
})

test('everyRounds 配 0 被夹到 1：0 轮时不注入', () => {
  // 夹取的下界：0 轮还没到 1 轮，所以不注入。若不做夹取，`everyRounds=0` 会变成
  // 「每轮都发」，用户每轮多一条 30 token 的噪声。
  const history = historyWithRounds(0)
  expect(appendTodoReminder(history, { ...openOptions, everyRounds: 0 })).toHaveLength(history.length)
})

test('everyRounds 配 0 被夹到 1：1 轮就注入', () => {
  // 同一个夹取的正面：0 被当成 1，1 轮就满足阈值。
  const history = historyWithRounds(1)
  expect(appendTodoReminder(history, { ...openOptions, everyRounds: 0 })).toHaveLength(history.length + 1)
})

test('everyRounds 配负数同样夹到 1', () => {
  // 负数阈值没有语义，但配置面是用户可写的；夹到 1 而不是「永不超过所以永不发」。
  const history = historyWithRounds(1)
  expect(appendTodoReminder(history, { ...openOptions, everyRounds: -5 })).toHaveLength(history.length + 1)
})
