/**
 * 图片按龄卸载（image-diet）的纯函数单元测试（迁自 `scripts/image-diet-test.mjs` 的 [1]–[5]）。
 *
 * ## 为什么这组口径值得一条条钉
 *
 * 图片是长会话里最贵的一块：一张 JPEG 截图 100~300KB 的 base64，留在历史里就是每轮请求
 * 重发一遍。卸载规则「留着但只留该留的那几张」一旦漂，两种事故都不报错：
 *
 * - 把**正在看的那张**卸载掉，模型下一步照着看不见的画面点错位置；
 * - 把消息删了，工具调用配不上对，端点直接 400。
 *
 * 所以这里钉的都是「哪几张留下、留下的位置对不对、输入有没有被改」。
 *
 * ## 与包级 spec 的分工
 *
 * `src/packages/image-diet/tests/image-diet.spec.ts` 已覆盖设置分区的身份、四个控件、
 * 区间常量，以及 `readImageDietConfig` 的**缺省值**与两条夹取（`keepRounds: 999`、
 * `userImageBudget: -3`）。这里不重复那几条，只补原探针 [5] 剩下没被覆盖的：
 * `enabled: false` 生效、`toolImageBudget` 负值夹到 0、`userImageBudget` 超上限夹到 20、
 * 非数字回落缺省。真投影链与真回合在 `tests/integration/image-diet.int.spec.ts`。
 *
 * ## 迁移差异
 *
 * 原探针第 [3] 节有两条几乎同义的断言（「消息条数与 role 序列逐条不变」与「role 序列与
 * 原文一致」）——前半句是集合相等、后半句是顺序相等，这里拆成两条独立的 `test` 保留语义，
 * 没有删断言。
 */
import { describe, expect, test } from 'vitest'
import { IMAGE_DIET_PLACEHOLDER, countImageParts, pruneImages, readImageDietConfig } from './image-diet.js'
import type { ChatMessage, ChatContentPart } from './llm.js'

/** 一个纯文本片段。 */
const text = (value: string): ChatContentPart => ({ type: 'text', text: value })
/** 一张图（data URL，够断言用，不解码）。 */
const image = (url: string): ChatContentPart => ({ type: 'image_url', image_url: { url } })
/** 夹具里的第 n 张图。 */
const url = (n: number): string => `data:image/png;base64,IMG${String(n)}`
/** 消息的内容片段（字符串正文没有片段）。 */
const parts = (message: ChatMessage | undefined): ChatContentPart[] =>
  Array.isArray(message?.content) ? message.content : []
/** 一条消息里还剩几张图。 */
const imageUrls = (message: ChatMessage | undefined): string[] =>
  parts(message)
    .filter((part): part is Extract<ChatContentPart, { type: 'image_url' }> => part.type === 'image_url')
    .map((part) => part.image_url.url)
/** 一条消息里有几个卸载占位。 */
const placeholders = (message: ChatMessage | undefined): number =>
  parts(message).filter((part) => part.type === 'text' && part.text === IMAGE_DIET_PLACEHOLDER).length
/** 电脑控制截图的形状：tool 消息，text 里带截图标记，后面跟一张图（照 computer-use 的落库）。 */
const shot = (marker: string, urlValue: string): ChatMessage => ({
  role: 'tool',
  tool_call_id: `call-${marker}`,
  content: [text(`屏幕截图 ${marker}`), image(urlValue)],
})

describe('① 用户图按预算：留最近几张，多的留占位', () => {
  /** 一条带 6 张图的消息；后面几条用例共用这一份成品（pruneImages 不改输入）。 */
  const messages: ChatMessage[] = [
    { role: 'user', content: [text('看这几张'), ...Array.from({ length: 6 }, (_, index) => image(url(index + 1)))] },
    { role: 'assistant', content: '收到' },
  ]

  test('6 张用户图只留最近 4 张', () => {
    expect(imageUrls(pruneImages(messages)[0])).toHaveLength(4)
  })

  test('被卸载的两张留了占位（不是删部件）', () => {
    expect(placeholders(pruneImages(messages)[0])).toBe(2)
  })

  test('保留的是最近的 4 张，顺序不动', () => {
    expect(imageUrls(pruneImages(messages)[0])).toEqual([3, 4, 5, 6].map(url))
  })

  test('不改输入（原对象逐字节不变）', () => {
    const before = JSON.stringify(messages)
    pruneImages(messages)
    expect(JSON.stringify(messages)).toBe(before)
  })

  test('没超预算时一张都不动，也不添占位', () => {
    const three: ChatMessage[] = [{ role: 'user', content: [text('三张'), image(url(1)), image(url(2)), image(url(3))] }]
    const kept = pruneImages(three)
    expect(countImageParts(kept)).toBe(3)
    expect(placeholders(kept[0])).toBe(0)
  })
})

describe('② 工具图只留最近 2 张', () => {
  test('最老那张截图被卸载成占位', () => {
    const out = pruneImages([
      { role: 'user', content: '开始' },
      shot('A', url(1)),
      shot('B', url(2)),
      shot('C', url(3)),
    ])
    expect(imageUrls(out[1])).toHaveLength(0)
    expect(placeholders(out[1])).toBe(1)
  })

  test('最近两张截图留着（当前正在看的那张一定在）', () => {
    const out = pruneImages([
      { role: 'user', content: '开始' },
      shot('A', url(1)),
      shot('B', url(2)),
      shot('C', url(3)),
    ])
    expect(imageUrls(out[2])).toHaveLength(1)
    expect(imageUrls(out[3])).toHaveLength(1)
  })

  test('同一轮里 5 张截图也只留最近 2 张', () => {
    const many: ChatMessage[] = [
      { role: 'user', content: '看' },
      ...Array.from({ length: 5 }, (_, index) => shot(`s${String(index)}`, url(index))),
    ]
    expect(countImageParts(pruneImages(many))).toBe(2)
  })
})

describe('③ 更早回合的图全卸载 + 不删消息', () => {
  /** 三轮、每轮一张用户图；keepRounds 缺省 2，所以第一轮整段算历史。 */
  const messages: ChatMessage[] = [
    { role: 'user', content: [text('第一轮'), image(url(1)), image(url(2))] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [text('第二轮'), image(url(3))] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [text('第三轮'), image(url(4))] },
    { role: 'assistant', content: 'ok' },
  ]

  test('第一轮（更早回合）的图全卸载，占位两个', () => {
    const out = pruneImages(messages)
    expect(imageUrls(out[0])).toHaveLength(0)
    expect(placeholders(out[0])).toBe(2)
  })

  test('第二轮仍在保留窗口内（keepRounds=2），第三轮也保留', () => {
    const out = pruneImages(messages)
    expect(imageUrls(out[2])).toHaveLength(1)
    expect(imageUrls(out[4])).toHaveLength(1)
  })

  test('消息条数不变（删消息会让工具调用配不上对）', () => {
    expect(pruneImages(messages)).toHaveLength(messages.length)
  })

  test('role 序列逐条与原文一致（无孤儿、无重排）', () => {
    const out = pruneImages(messages)
    expect(out.map((message) => message.role)).toEqual(messages.map((message) => message.role))
  })

  test('keepRounds=0 时全部卸载', () => {
    expect(countImageParts(pruneImages(messages, { userImageBudget: 4, toolImageBudget: 2, keepRounds: 0 }))).toBe(0)
  })
})

describe('④ 文本部件顺序保持 + 幂等 + 契约边界', () => {
  test('卸载只替换 image_url 那一片，文本顺序不变', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: [text('前'), image(url(1)), text('中'), image(url(2)), text('后')] }]
    const out = pruneImages(messages, { userImageBudget: 1, toolImageBudget: 2, keepRounds: 2 })
    const shape = parts(out[0]).map((part) => (part.type === 'image_url' ? part.image_url.url : part.text))
    expect(shape).toEqual(['前', IMAGE_DIET_PLACEHOLDER, '中', url(2), '后'])
  })

  test('幂等：连跑两遍逐字节相等', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: [text('前'), image(url(1)), text('中'), image(url(2)), text('后')] }]
    const once = pruneImages(messages, { userImageBudget: 1, toolImageBudget: 2, keepRounds: 2 })
    const twice = pruneImages(once, { userImageBudget: 1, toolImageBudget: 2, keepRounds: 2 })
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  test('assistant 的图不属于契约范围，原样留着', () => {
    const assistantOnly: ChatMessage[] = [{ role: 'assistant', content: [text('a'), image(url(9))] }]
    expect(countImageParts(pruneImages(assistantOnly))).toBe(1)
  })
})

describe('⑤ 配置读取：总开关与夹取（缺省值那几条已在包级 spec）', () => {
  test('显式 enabled:false 生效（只认字面 false）', () => {
    expect(readImageDietConfig({ enabled: false }).enabled).toBe(false)
  })

  test('toolImageBudget 负值夹到 0，userImageBudget 超上限夹到 20', () => {
    const clamped = readImageDietConfig({ userImageBudget: 999, toolImageBudget: -5 })
    expect(clamped.userImageBudget).toBe(20)
    expect(clamped.toolImageBudget).toBe(0)
  })

  test('非数字回落缺省（不把 undefined 当 0 用）', () => {
    expect(readImageDietConfig({ userImageBudget: 'abc' }).userImageBudget).toBe(4)
  })
})
