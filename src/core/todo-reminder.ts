/**
 * todo 节流提醒的纯逻辑（投影本体注册在 `plugins/todo.ts`，这里是可被探针直读的那层）。
 *
 * 为什么要有这条提醒：dsc 把「做完一步就改状态」写死在 todo_write 的工具说明里，
 * 长会话里模型还是会忘（ZCode 的做法是每 N 个用户回合往历史尾巴补一条节流的提醒，
 * 比静态叮嘱更能拉回注意力）。代价是每个被注入的回合多一条 user 消息的 token，
 * 所以**默认关**：只有用户自己开了才注入。
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
  /** 总开关（默认 false：不能给所有会话凭空加 token）。 */
  enabled: boolean
  /** 距上次写清单过了几个用户回合才提醒（默认 10）。 */
  everyTurns: number
  /** 当前清单里还有 pending / in_progress 的条目——没有未完成项就没什么可提醒的。 */
  hasOpenTodos: boolean
}

/**
 * 数「距最近一次 `todo_write` 调用过了几个用户回合」。
 *
 * 「一个用户回合」= 一条**被模型应答过**的 user 消息。请求尾部那条程序自动附的环境快照
 * （env-facts 投影，order 600，跑在本投影之前）与当前这轮还没被回答的用户话都没有后随的
 * assistant，不算回合——否则环境快照每轮都会把计数多推一格，提醒就会提前一拍发出来。
 *
 * 历史里没有 todo_write 时从第 0 条起数（会话恢复的场景：清单从状态条目回来，工具调用可能
 * 已被压缩掉）。
 */
export function countUserTurnsSinceLastTodoWrite(messages: readonly ChatMessage[]): number {
  let lastWrite = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    if (message.tool_calls.some((call) => call.function?.name === 'todo_write')) {
      lastWrite = index
      break
    }
  }
  let lastAssistant = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'assistant') {
      lastAssistant = index
      break
    }
  }
  let turns = 0
  // user 消息后面有 assistant ⟺ 它的下标小于最靠后的那条 assistant 的下标
  for (let index = lastWrite + 1; index < lastAssistant; index += 1) {
    if (messages[index]!.role === 'user') turns += 1
  }
  return turns
}

/**
 * 该不该注入提醒、注入后是什么样——纯函数，返回新数组（不就地改输入）。
 *
 * 幂等：已经有这条提醒就不再追加（同一份历史重复投影——校验重算、流中断后的整轮重试
 * 会重新组装——必须逐字节同结果）。`everyTurns` 夹到至少 1，免得配成 0 变成每轮都发。
 */
export function appendTodoReminder(
  messages: ChatMessage[],
  options: TodoReminderOptions,
): ChatMessage[] {
  if (!options.enabled || !options.hasOpenTodos) return messages
  const everyTurns = Math.max(1, Math.floor(options.everyTurns))
  if (countUserTurnsSinceLastTodoWrite(messages) < everyTurns) return messages
  if (messages.some((message) => message.role === 'user' && message.content === TODO_REMINDER_TEXT)) {
    return messages
  }
  return [...messages, { role: 'user', content: TODO_REMINDER_TEXT }]
}
