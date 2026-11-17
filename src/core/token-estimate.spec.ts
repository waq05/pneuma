/**
 * token 粗估的纯函数（unit 层）。
 *
 * `token-estimate.ts` 零依赖、不读环境。三个导出里 `estimateTextTokens` 定的是「一个字符值
 * 多少 token」，`estimateRequestSegments` 定的是「一条消息归到哪一段」——宿主自动压缩的阈值
 * 与界面进度条都读同一份口径，两边漂了就会出现「界面说 3 万、宿主按 5 万判断压缩」。
 *
 * @module dsc/core/token-estimate.spec
 */
import { expect, test } from 'vitest'
import type { SegmentMessage } from './token-estimate.js'
import { emptySegments, estimateRequestSegments, estimateTextTokens } from './token-estimate.js'

const userMsg = (content: SegmentMessage['content']): SegmentMessage => ({ role: 'user', content })

test('空串估 0', () => {
  expect(estimateTextTokens('')).toBe(0)
})

test('纯 ASCII 按每字符 0.33 估', () => {
  expect(estimateTextTokens('abc')).toBeCloseTo(0.99, 10)
})

test('纯中文按每字符 0.65 估', () => {
  // 0.65 是「宁可高估」的那一侧：低估会让自动压缩晚触发，直接爆窗。
  expect(estimateTextTokens('中')).toBeCloseTo(0.65, 10)
})

test('中英混排按字符相加', () => {
  expect(estimateTextTokens('中a')).toBeCloseTo(0.98, 10)
})

test('全角标点算中文（全角区在 CJK 区间内）', () => {
  // 中文正文里的逗号、句号占的是全角宽度，按 0.33 算会把一段中文低估一截。
  expect(estimateTextTokens('，')).toBeCloseTo(0.65, 10)
  expect(estimateTextTokens('！')).toBeCloseTo(0.65, 10)
})

test('假名与韩文也算中文', () => {
  // 区间覆盖了日文假名与韩文音节；写窄了，日韩正文会被低估一半。
  expect(estimateTextTokens('あ')).toBeCloseTo(0.65, 10)
  expect(estimateTextTokens('한')).toBeCloseTo(0.65, 10)
})

test('emoji 按一个码点算 other，不按两个 UTF-16 单元', () => {
  // 用 `for…of` 遍历码点：若改成按 `.length` / 下标遍历，一个 emoji 会被数成 2 个字符，
  // 含表情的正文会被系统性高估。
  expect(estimateTextTokens('😀')).toBeCloseTo(0.33, 10)
})

test('换行与空格按 other 计', () => {
  expect(estimateTextTokens('\n')).toBeCloseTo(0.33, 10)
  expect(estimateTextTokens(' ')).toBeCloseTo(0.33, 10)
})

test('估算结果不取整', () => {
  // 取整是调用方按展示口径自己的事；这里先取整会放大误差，分段再 ceil 一次就更高了。
  expect(estimateTextTokens('a')).toBeCloseTo(0.33, 10)
})

test('emptySegments 返回全零六段', () => {
  expect(emptySegments()).toEqual({ system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0, schema: 0 })
})

test('emptySegments 每次返回新对象', () => {
  // 调用方会就地累加分段（`segments.prompt += …`）；返回同一份共享对象会让两次请求串账。
  expect(emptySegments()).not.toBe(emptySegments())
})

test('空消息列表与空 schema 给出全零分段', () => {
  expect(estimateRequestSegments([])).toEqual({ system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0, schema: 0 })
})

test('system 消息归 system 段', () => {
  const segments = estimateRequestSegments([{ role: 'system', content: 'abcd' }])
  expect(segments.system).toBe(2)
  expect(segments.prompt).toBe(0)
})

test('user 消息归 prompt 段', () => {
  // user 是用户真正说的话，进度条上「对话内容」那一段只该它进。
  const segments = estimateRequestSegments([userMsg('abc')])
  expect(segments.prompt).toBe(1)
})

test('assistant 正文归 assistant 段', () => {
  const segments = estimateRequestSegments([{ role: 'assistant', content: 'ab' }])
  expect(segments.assistant).toBe(1)
})

test('tool 结果归 tools 段（不是工具定义）', () => {
  // 段名容易误解：tools 是模型读到的工具返回原文，工具定义在 schema 段。
  // 归错段会让界面把 40K 的 run_code 返回显示成「工具定义太肥」。
  const segments = estimateRequestSegments([{ role: 'tool', content: 'a' }])
  expect(segments.tools).toBe(1)
  expect(segments.schema).toBe(0)
})

test('reasoning_content 归 thinking 段，不计入 assistant', () => {
  // 思考内容与正文分开显示；算进 assistant 会让「模型说了多少」偏大。
  const segments = estimateRequestSegments([{ role: 'assistant', content: '', reasoning_content: 'abcd' }])
  expect(segments.thinking).toBe(2)
  expect(segments.assistant).toBe(0)
})

test('工具调用的函数名与参数都算进 assistant 段', () => {
  // 参数是模型自己产出的文本，同样占输入 token；9 个字符 = 2.97 → ceil 3。
  // 若只算函数名（2 个字符 → 0.66 → 1）或完全不算（0），这条都会红。
  const segments = estimateRequestSegments([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'fn', arguments: '{"a":1}' } }],
    },
  ])
  expect(segments.assistant).toBe(3)
})

test('content 为 null 的消息不计数', () => {
  // 只带 tool_calls 的 assistant 就是 null 正文；null 当成字符串 "null" 会凭空多 4 个字符。
  const segments = estimateRequestSegments([
    { role: 'system', content: null },
    { role: 'user', content: null },
    { role: 'tool', content: null },
  ])
  expect(segments).toEqual({ system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0, schema: 0 })
})

test('content 是分段数组时只取 text 分段，其它类型忽略', () => {
  // 多模态消息里的图片段没有文本可估；把它当空串或不跳过都会让分段失真。
  const segments = estimateRequestSegments([
    userMsg([{ type: 'text', text: 'ab' }, { type: 'image' }, { type: 'text', text: 'cd' }]),
  ])
  expect(segments.prompt).toBe(2)
})

test('text 分段缺 text 字段时按空串处理', () => {
  // 协议允许 `{ type: 'text' }`；这里当 0，而不是字符串 "undefined" 的 9 个字符。
  const segments = estimateRequestSegments([userMsg([{ type: 'text' }])])
  expect(segments.prompt).toBe(0)
})

test('分段向上取整：0.33 进到 1，1.32 进到 2', () => {
  // 取整方向必须朝上：0.33 进 0 等于把「一条短消息」算成空气，长请求会整体低估。
  expect(estimateRequestSegments([userMsg('a')]).prompt).toBe(1)
  expect(estimateRequestSegments([userMsg('aaaa')]).prompt).toBe(2)
})

test('toolSchema 归 schema 段', () => {
  const segments = estimateRequestSegments([], 'abcd')
  expect(segments.schema).toBe(2)
})

test('不传 toolSchema 时 schema 段为 0', () => {
  // 压缩摘要那种「不发工具」的请求走这条默认值；漏了默认值会算出 NaN。
  expect(estimateRequestSegments([userMsg('a')]).schema).toBe(0)
})
