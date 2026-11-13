/**
 * 会话消息取文本的单位测试。
 *
 * 为什么这组用例值得钉：三个函数都从「从末尾往回找」开始，而末尾是什么，取决于调用
 * 时机——技能写入看最后一条 user，记忆复盘看上一轮 user，界面回放看最后一条 assistant。
 * 数错一条的后果不是崩溃，是「记忆记下了错误的一轮」「技能把用户这句当成了上一句」。
 * 所以每条用例都安排一个**容易数错**的夹具：工具消息、内容块数组、老日志里的 null 正文。
 *
 * @module dsc/core/transcript-text.spec
 */
import { expect, test } from 'vitest'
import type { ChatMessage } from './llm.js'
import { lastAssistantText, lastUserText, previousUserText } from './transcript-text.js'

const user = (text: string): ChatMessage => ({ role: 'user', content: text })
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: text })
const tool = (text: string): ChatMessage => ({ role: 'tool', content: text, tool_call_id: 'c1' })

// ── lastUserText ────────────────────────────────────────────────────────────

test('最后一条用户消息的正文被取出', () => {
  expect(lastUserText([user('第一句'), assistant('好的'), user('第二句')])).toBe('第二句')
})

test('中间夹着 assistant 与 tool 消息时仍取最后那条 user', () => {
  // 工具往返会让末尾连着好几条非 user 消息；这条钉住「按 role 找，不按位置取」。
  const history = [user('改一下'), assistant('我来'), tool('写入成功'), assistant('改好了')]
  expect(lastUserText(history)).toBe('改一下')
})

test('首尾空白与换行被去掉', () => {
  // 正文进技能模板、进记忆摘要之前要 trim，否则拼出来的是带空行的一坨。
  expect(lastUserText([user('  \n 做完了吗 \n '), assistant('嗯')])).toBe('做完了吗')
})

test('content 为内容块数组时拼出 text 片段', () => {
  // 带图的消息 content 是数组；取文本只能拼 text 片段，不能把 image_url 的 JSON 带进来。
  const message: ChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'text', text: ' 是什么' },
    ],
  }
  expect(lastUserText([message])).toBe('看这张图 是什么')
})

test('content 为 null 的老日志退成空串，不抛错', () => {
  // 从盘上读回一条没有正文的旧记录时，这里不能炸——炸了就是「打开会话一片空白」。
  const broken = [{ role: 'user', content: null } as ChatMessage]
  expect(lastUserText(broken)).toBe('')
})

test('没有任何用户消息时返回空串', () => {
  expect(lastUserText([assistant('只有我'), tool('结果')])).toBe('')
})

test('空历史返回空串', () => {
  // 新会话第一轮之前会拿空数组问一次；这里必须是空串而不是抛错或 undefined。
  expect(lastUserText([])).toBe('')
})

// ── previousUserText ────────────────────────────────────────────────────────

test('取倒数第二条用户消息，而不是最后一条', () => {
  // 「上一轮用户说了什么」是记忆复盘的输入；取成最后一条就等于把当前这句喂回去。
  expect(previousUserText([user('上一轮'), assistant('好'), user('这一轮')])).toBe('上一轮')
})

test('只有一条用户消息时返回空串', () => {
  expect(previousUserText([user('唯一一条'), assistant('好')])).toBe('')
})

test('数用户消息时跳过 assistant 与 tool', () => {
  // 按位置倒数第二会数到 assistant；按 role 数才是「第二条 user」。
  const history = [user('更早'), user('上一轮'), assistant('答'), tool('结果'), assistant('再答')]
  expect(previousUserText(history)).toBe('更早')
})

test('倒数第二条用户消息也做 trim', () => {
  expect(previousUserText([user(' 上一轮 \n'), user('这一轮')])).toBe('上一轮')
})

test('空历史没有上一条，返回空串', () => {
  expect(previousUserText([])).toBe('')
})

// ── lastAssistantText ───────────────────────────────────────────────────────

test('最后一条 assistant 的正文被取出', () => {
  expect(lastAssistantText([assistant('旧回复'), user('继续'), assistant('新回复')])).toBe('新回复')
})

test('user 与 tool 消息不会被当成 assistant', () => {
  // 末尾常常是用户新发的一句；把它当 assistant 会把用户的话回显进「上次回答」。
  const history = [assistant('回答'), user('追问'), tool('工具结果')]
  expect(lastAssistantText(history)).toBe('回答')
})

test('没有 assistant 消息时返回空串', () => {
  expect(lastAssistantText([user('问题'), tool('结果')])).toBe('')
})

test('assistant 的内容块数组同样拼 text 片段', () => {
  const message: ChatMessage = { role: 'assistant', content: [{ type: 'text', text: '分段 ' }, { type: 'text', text: '回答' }] }
  expect(lastAssistantText([message])).toBe('分段 回答')
})
