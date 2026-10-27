/**
 * todo 节流提醒的纯逻辑（投影本体注册在 `plugins/todo.ts`，这里是可被探针直读的那层）。
 *
 * 为什么要有这条提醒：dsc 把「做完一步就改状态」写死在 todo_write 的工具说明里，
 * 长会话里模型还是会忘（ZCode 的做法是每 N 个回合往历史尾巴补一条节流的提醒，
 * 比静态叮嘱更能拉回注意力）。
 *
 * **2026-10-27 改口径：按「轮」数，不再按「用户回合」数，且默认开。**
 * 原来的口径是「距上次写清单过了几个用户回合」，但用户看到的问题是「跑了几十轮，
 * 清单还停在 0/4」——一轮里模型会发几十次请求，用户回合数根本不涨，提醒永远不触发。
 * 现在数的是「距上次 todo_write 之后又发了几次请求」（一条 assistant 消息 = 一轮），
 * 默认 8 轮提醒一次。代价是长清单任务里每轮多一条 user 文本（约 30 token），
 * 只在「清单里确实还有未完成项」时才发。
 *
 * 纯函数、不改日志：它只往「发给模型的那份消息」末尾追加一条 user 消息，不碰会话记录
 * （投影链的既有约定——日志存原文，模型看见的内容由这条链可复算）。提醒是提示不是事实，
 * 落成日志条目反而会污染历史、也会在下次被当作用户原话引用，所以刻意不落。
 *
 * @module dsc/core/todo-reminder
 */
import type { ChatMessage } from './llm.js'

/** 注入的那条提醒原文（user 角色；文案照 todo 工具说明的口径：2–4 字动词、无标点）。 */
export const TODO_REMINDER_TEXT = '（提醒：任务清单有未完成项，做完一步就把状态改掉）'

/** {@link appendTodoReminder} 的判断输入。 */
export interface TodoReminderOptions {
  /** 总开关（默认 true，见 `plugins/todo.ts` 的 REMINDER_DEFAULTS）。 */
  enabled: boolean
  /** 距上次写清单过了几轮才提醒（默认 8）。「一轮」= 一次模型请求 = 一条 assistant 消息。 */
  everyRounds: number
  /** 当前清单里还有 pending / in_progress 的条目——没有未完成项就没什么可提醒的。 */
  hasOpenTodos: boolean
}

/**
 * 数「距最近一次 `todo_write` 调用又发了几次请求」。
 *
 * 一条 assistant 消息就是一轮：工具调用的 assistant（含 todo_write 自己那条）与带正文的
 * assistant 都算。请求尾巴上那条环境快照（env-facts，order 600，跑在本投影之前）是 user，
 * 不参与计数——这也是**为什么不用 user 消息数**：那种口径在单轮长跑里永远不涨。
 *
 * 历史里没有 todo_write 时从第 0 条起数（会话恢复：清单从状态条目回来，工具调用可能已被压缩掉）。
 */
export function countRoundsSinceLastTodoWrite(messages: readonly ChatMessage[]): number {
  let lastWrite = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    if (message.tool_calls.some((call) => call.function?.name === 'todo_write')) {
      lastWrite = index
      break
    }
  }
  let rounds = 0
  for (let index = lastWrite + 1; index < messages.length; index += 1) {
    if (messages[index]!.role === 'assistant') rounds += 1
  }
  return rounds
}

/**
 * 该不该注入提醒、注入后是什么样——纯函数，返回新数组（不就地改输入）。
 *
 * 幂等：已经有这条提醒就不再追加（同一份历史重复投影——校验重算、流中断后的整轮重试
 * 会重新组装——必须逐字节同结果）。`everyRounds` 夹到至少 1，免得配成 0 变成每轮都发。
 */
export function appendTodoReminder(
  messages: ChatMessage[],
  options: TodoReminderOptions,
): ChatMessage[] {
  if (!options.enabled || !options.hasOpenTodos) return messages
  const everyRounds = Math.max(1, Math.floor(options.everyRounds))
  if (countRoundsSinceLastTodoWrite(messages) < everyRounds) return messages
  if (messages.some((message) => message.role === 'user' && message.content === TODO_REMINDER_TEXT)) {
    return messages
  }
  return [...messages, { role: 'user', content: TODO_REMINDER_TEXT }]
}
