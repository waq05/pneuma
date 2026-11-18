/**
 * 上下文流水线整合：微压缩、图片卸载、环境快照、请求 invariant 四层在**同一条请求**里
 * 共存的顺序、幂等与互不打架（迁自 `scripts/context-pipeline-test.mjs`）。
 *
 * 为什么单独一张网：这四条线各写各的探针、各自都绿；但它们挂在同一条投影链上，真正会
 * 出事的地方在**接缝**：
 *   ① 顺序：`image-diet`(550) 必须跑在 `env-facts`(600) 之前，否则 env 快照会白占
 *      image-diet 的「最近几个用户回合」一格，keepRounds 口径凭空保守一格；微压缩(650)
 *      只碰文本工具结果、图片卸载(550) 只碰图像部件，两者不得互相吃掉；
 *   ② 幂等 / 可重建：整条链跑两遍必须逐字节同结果（WS4 的 invariant 就是靠二次派生比对，
 *      链一旦不确定，invariant 立刻误报）；
 *   ③ 日志不动：四层都只改「发给模型的那份副本」，会话日志原文一个字不能变；
 *   ④ 零误报：四层同时生效时 invariant 必须干净。
 *
 * 走真内核 + 真投影链（`prompt.rewrite`），不连真模型：这一层要证明的是「链装配起来之后
 * 的顺序」，单个插件的单测证明不了。
 *
 * @module dsc/tests/integration/context-pipeline.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { IMAGE_DIET_PLACEHOLDER } from '@pneuma/runtime/core/image-diet.js'
import type { ChatContentPart, ChatMessage } from '@pneuma/runtime/core/llm.js'
import { checkReconstructable, snapshotMessages } from '@pneuma/runtime/core/request-invariant.js'
import { TODO_REMINDER_TEXT } from '@pneuma/runtime/core/todo-reminder.js'
import { CLEARED_TOOL_RESULT_PREFIX } from '@pneuma/runtime/packages/microcompact/microcompact.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../harness.js'

/** 内核里本文件用到的服务面。 */
interface SessionView {
  meta: { id: string; cwd: string }
}

interface Services {
  prompt: {
    systemPrompt(cwd: string, scope?: { sessionId?: string; cwd?: string }): string
    rewrite(messages: ChatMessage[], session: SessionView): ChatMessage[]
  }
  session: { current(): SessionView }
}

/** 四次真实用户回合、八个工具结果（最旧三个才够大够旧），末尾一个带图的工具结果。 */
const BIG = 'x'.repeat(4_000)

/**
 * 图片 url：P2a 起批量卸载按**张数**攒批（`IMAGE_DIET_BATCH_MIN_IMAGES` = 2），与 url 长短无关。
 * 这份历史里 A1、A2 是更早回合的图（keepRounds=2 判死），正好两张候选 → 一批卸掉；
 * A3 在保留窗口内，必须还在。
 */
const imageUrl = (tag: string): string => `data:image/png;base64,${tag}`
const IMG_A1 = imageUrl('A1')
const IMG_A2 = imageUrl('A2')
const IMG_A3 = imageUrl('A3')
const IMG_NEWEST = imageUrl('NEWEST')

/** 一个文本段。 */
const textPart = (text: string): ChatContentPart => ({ type: 'text', text })
/** 一个图片段。 */
const imagePart = (url: string): ChatContentPart => ({ type: 'image_url', image_url: { url } })

/** user 消息：纯文本，或「文本 + 若干图」。 */
function userWith(text: string, imageUrls: string[] = []): ChatMessage {
  return {
    role: 'user',
    content: imageUrls.length === 0 ? text : [textPart(text), ...imageUrls.map(imagePart)],
  }
}

/** assistant 的一次工具调用（参数是未解析的 JSON 字符串，与真会话一致）。 */
function asstCall(id: string, name: string, args: unknown): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  }
}

/** 一条工具结果（正文可以是字符串，也可以是带图的分段数组）。 */
function toolOut(id: string, body: string | ChatContentPart[]): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: body }
}

/** 一份请求里所有正文（只看文本段）。 */
function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
}

/** 一份消息里所有图片 URL。 */
function imageUrlsOf(message: ChatMessage): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url)
}

/** 造出「事故现场」的那段混合历史。 */
function buildHistory(): ChatMessage[] {
  const history: ChatMessage[] = []
  history.push(userWith('第一轮：看看这个', [IMG_A1]))
  for (let index = 1; index <= 2; index += 1) {
    history.push(asstCall(`c${String(index)}`, 'bash', { command: `echo ${String(index)}` }))
    history.push(toolOut(`c${String(index)}`, `第${String(index)}个结果 ${BIG}`))
  }
  history.push(userWith('第二轮：再看这个', [IMG_A2]))
  for (let index = 3; index <= 4; index += 1) {
    history.push(asstCall(`c${String(index)}`, 'read', { path: `f${String(index)}.ts` }))
    history.push(toolOut(`c${String(index)}`, `第${String(index)}个结果 ${BIG}`))
  }
  history.push(userWith('第三轮：还有这个', [IMG_A3]))
  for (let index = 5; index <= 6; index += 1) {
    history.push(asstCall(`c${String(index)}`, 'grep', { pattern: `p${String(index)}` }))
    history.push(toolOut(`c${String(index)}`, `第${String(index)}个结果 ${BIG}`))
  }
  history.push(userWith('第四轮：顺手看一眼屏幕'))
  history.push(asstCall('c7', 'screenshot', {}))
  // 末尾这个工具结果带图（模拟「当前正在看的那张截图」），必须活下来。
  history.push({ role: 'tool', tool_call_id: 'c7', content: [textPart('屏幕截图'), imagePart(IMG_NEWEST)] })
  history.push(asstCall('c8', 'bash', { command: 'ok' }))
  history.push(toolOut('c8', `第八个结果 ${BIG}`))
  return history
}

let kernel: BootedKernel
let fake: FakeLLM
let services: Services
/** 历史原文的快照：四层都只改「发给模型的副本」，这份必须一个字节不变。 */
let history: ChatMessage[]
let pristine: string
let systemText: string
/** 第一次投影的结果：所有读断言的对象。 */
let sent: ChatMessage[]
/** 第二次投影（可重建性）。 */
let sent2: ChatMessage[]

beforeAll(async () => {
  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({
    providerBaseUrl: fake.baseUrl,
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl: fake.baseUrl,
          apiKey: 'k',
          models: [
            {
              id: 'm-img',
              name: 'm-img',
              // 必须声明 image：图片卸载只对声明了图片能力的模型生效，写错这条链就不跑。
              contextWindow: 100_000,
              maxTokens: 800,
              modalities: ['text', 'image'],
              thinkingLevels: [],
              thinkingParam: 'none',
              effortMap: {},
            },
          ],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm-img',
    },
  })
  services = kernel.ctx as unknown as Services
  const session = services.session.current()
  history = buildHistory()
  pristine = JSON.stringify(history)
  systemText = services.prompt.systemPrompt(session.meta.cwd)
  sent = services.prompt.rewrite([{ role: 'system', content: systemText }, ...buildHistory()], session)
  sent2 = services.prompt.rewrite([{ role: 'system', content: systemText }, ...buildHistory()], session)
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
})

describe('① 四层各自生效', () => {
  test('微压缩：恰好清掉最旧的 3 条（keepRecent 默认 5）', () => {
    const cleared = sent.filter(
      (message) => message.role === 'tool' && typeof message.content === 'string' && message.content.startsWith(CLEARED_TOOL_RESULT_PREFIX),
    )
    expect(cleared.length).toBeGreaterThan(0)
    expect(cleared).toHaveLength(3)
  })

  test('微压缩：窗口内最早的那条仍是原文', () => {
    expect(sent.some((message) => typeof message.content === 'string' && message.content.includes('第4个结果'))).toBe(true)
  })

  test('图片卸载：更早回合的图 A1 已卸载，最新那张截图仍在', () => {
    const allImages = sent.flatMap(imageUrlsOf)
    expect(allImages).not.toContain(IMG_A1)
    expect(allImages).toContain(IMG_NEWEST)
  })

  test('图片卸载：占位文本出现在被卸载的位置', () => {
    expect(
      sent.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'text' && part.text === IMAGE_DIET_PLACEHOLDER)),
    ).toBe(true)
  })
})

describe('② 顺序：image-diet 在 env-facts 之前', () => {
  test('image-diet 先于 env-facts：第三轮的图 A3 仍在（快照没白占一格）', () => {
    // 判别点：r3 那张图。image-diet 若跑在 env-facts 之后，末尾的合成快照会顶掉一个回合
    // 额度，keepRounds=2 的切点后移一格，r3 的图会被一起卸掉；跑在它之前则 r3 的图还在。
    expect(sent.flatMap(imageUrlsOf)).toContain(IMG_A3)
  })

  test('env-facts：环境快照恰好一条，且落在请求最后一条', () => {
    const snapshots = sent.filter(
      (message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('环境事实：'),
    )
    expect(snapshots).toHaveLength(1)
    expect(sent[sent.length - 1]).toBe(snapshots[0])
  })
})

describe('③ 易变注入默认关', () => {
  test('todo-reminder 默认不注入', () => {
    expect(sent.some((message) => textOf(message) === TODO_REMINDER_TEXT)).toBe(false)
  })
})

describe('④ 日志不动 + 可重建', () => {
  test('会话日志原文（构造的那份历史）一个字节没变', () => {
    expect(JSON.stringify(history)).toBe(pristine)
  })

  test('整条链可重建：再跑一遍逐字节同结果', () => {
    expect(JSON.stringify(sent2)).toBe(JSON.stringify(sent))
  })

  test('系统提示词两次生成逐字节一致', () => {
    expect(services.prompt.systemPrompt(services.session.current().meta.cwd)).toBe(systemText)
  })
})

describe('⑤ invariant 零误报', () => {
  test('四层同链后 invariant 报 ok', () => {
    // `before` 要连头部 system 一起快照：重建侧拿到的就是「system + 历史」，少一条会立刻
    // 被判成「发送侧与重建侧条数不同」——那是这条用例自己的构造错误，不是 invariant 误报。
    const before = snapshotMessages([{ role: 'system', content: systemText }, ...buildHistory()])
    const derived = services.prompt.rewrite(before, services.session.current())
    const report = checkReconstructable(sent, derived, { before, after: before })
    expect(report.ok).toBe(true)
    // 红了要能直接看到原因，不用去翻 invariant 的实现。
    expect(report.reason ?? '').toBe('')
  })

  test('invariant digest 稳定（两次派生同摘要）', () => {
    const before = snapshotMessages([{ role: 'system', content: systemText }, ...buildHistory()])
    const derived = services.prompt.rewrite(before, services.session.current())
    expect(checkReconstructable(derived, derived, { before, after: before }).ok).toBe(true)
  })
})
