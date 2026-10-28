/**
 * 从会话消息里取文本（全仓库唯一一份）。
 *
 * 为什么单独一个模块：「从末尾往回找最后一条 user / assistant 消息，取纯文本去首尾空白」
 * 这段逻辑此前在手写三份（`core/learnings/skill-write.ts` 两份、
 * `plugins/memory.ts` 两份同名本地函数），而它跟技能、记忆这两个业务域都没关系，
 * 只是会话流的读法。放 core 让两边都引，不必让记忆插件去 import 技能模块。
 *
 * 依赖只有 `contentText`（把 string / 内容块数组都压成纯文本）。
 *
 * @module dsc/core/transcript-text
 */
import { contentText, type ChatMessage } from './llm.js'

/** 最后一条用户消息的纯文本；没有用户消息返回空串。 */
export function lastUserText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'user') return contentText(message.content).trim()
  }
  return ''
}

/** 倒数第二条用户消息的纯文本（「上一轮用户说了什么」）；不足两条返回空串。 */
export function previousUserText(messages: readonly ChatMessage[]): string {
  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    seen += 1
    if (seen === 2) return contentText(message.content).trim()
  }
  return ''
}

/** 最后一条 assistant 消息的正文；没有 assistant 消息返回空串。 */
export function lastAssistantText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'assistant') return contentText(message.content).trim()
  }
  return ''
}
