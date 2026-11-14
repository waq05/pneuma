/**
 * 旁问（side ask）的行为半边（迁自 `scripts/ui-side-ask-test.mjs` 第 [1]、[2]、[3] 段）。
 *
 * 旁问的硬保证是「只读」：不带 tools、输出预算封顶、取消回「已停止」而不是炸。
 * 这三段全部有真接缝：
 *   ① 选区整理与浮钮定位（`ui-ask/ui/select.ts` 的纯函数真值表）；
 *   ② 宿主消息组装与只读调用（`core/side-ask.ts`：引用围栏、截断、假派发口上看
 *      请求体、增量拼接只认正文、取消/半截/真错误三种收尾）；
 *   ③ 界面通道白名单与实参规格（`UI_METHODS` / `validateUiArgs` 是真实导出，
 *      按手册 §2 方案 A/C 改写——空票据、超长问题、超长引用都在规格上拦）。
 *
 * 没迁的（原探针第 [4]、[5] 段）：runtime / 插件 / dock / webserver / 产物的接线
 * 文本钉——按手册 §2 属必删项；产物段（`lib/ui/plugins/ask/client.js`）要
 * `pnpm run build:ui` 的构建产物（vitest 只解析 src）。见交付报告缺口清单。
 *
 * 为什么归 ui project：`select.ts` 在本目录（ui project 收 `src/packages/<pkg>/ui/**`），
 * `side-ask.ts` 经 `@pneuma/runtime` 别名解析到 src——两半都是纯模块，jsdom 无副作用。
 *
 * @module dsc-ui-ask/ui/side-ask.spec
 */
import { describe, expect, test } from 'vitest'
import type { LlmRoute, LlmStream, StreamResult } from '@pneuma/runtime/core/llm.js'
import { INVOKABLE_METHODS } from '@pneuma/runtime/core/host-methods.js'
import { SIDE_ASK_MAX_QUOTE, SIDE_ASK_MAX_TOKENS, SIDE_ASK_SYSTEM, buildSideAskMessages, sideAskOnce } from '@pneuma/runtime/core/side-ask.js'
import { UI_METHODS, validateUiArgs } from '@pneuma/runtime/core/ui-methods.js'
import { ANCHOR_GAP, BUBBLE_H, BUBBLE_W, MAX_SELECTION_CHARS, MIN_SELECTION_CHARS, anchorOf, normalizeSelection } from './select.js'

/** 造一份最小 StreamResult（假派发口的返回值）。 */
function streamResult(text: string): StreamResult {
  return { text, reasoning: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' }
}

/** 路由照探针：只要形状对，从不真的连出去。 */
const route: LlmRoute = {
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'k',
  model: 'm',
  maxTokens: 8000,
  temperature: 0.3,
}

describe('① 选区整理（normalizeSelection）', () => {
  test('太短的返回 null；刚好到阈值就收', () => {
    expect(normalizeSelection('abc')).toBeNull()
    expect(normalizeSelection('abcd')).toBe('abcd')
    expect(MIN_SELECTION_CHARS).toBe(4)
  })

  test('保留换行、只压每行内的空格；连续空行压成一个', () => {
    expect(normalizeSelection('  ab\n  cd  ')).toBe('ab\ncd')
    expect(normalizeSelection('a\n\n\n\nb')).toBe('a\n\nb')
  })

  test('代码缩进被抹平但结构还在', () => {
    expect(normalizeSelection('    const a = 1\n      const b = 2')).toBe('const a = 1\nconst b = 2')
  })

  test('超长截断并加省略号；全空白返回 null', () => {
    const clipped = normalizeSelection('x'.repeat(MAX_SELECTION_CHARS + 50))
    expect(clipped).not.toBeNull()
    expect(clipped).toHaveLength(MAX_SELECTION_CHARS + 1)
    expect(clipped?.endsWith('…')).toBe(true)
    expect(normalizeSelection('   \n  ')).toBeNull()
  })
})

describe('① 浮钮定位（anchorOf：右下、越界回收、底部翻页）', () => {
  const view = { width: 1280, height: 800 }

  test('默认贴选区右下角', () => {
    const mid = anchorOf({ left: 200, top: 100, right: 300, bottom: 120 }, view)
    expect(mid.left).toBe(300 - BUBBLE_W)
    expect(mid.top).toBe(120 + ANCHOR_GAP)
  })

  test('贴右缘时往回收（不出视口）', () => {
    const rightEdge = anchorOf({ left: 1200, top: 100, right: 1279, bottom: 120 }, view)
    expect(rightEdge.left).toBe(view.width - BUBBLE_W - ANCHOR_GAP)
  })

  test('贴底边时翻到选区上方；上下都放不下时夹在顶部安全区', () => {
    const bottom = anchorOf({ left: 10, top: 760, right: 100, bottom: 790 }, view)
    expect(bottom.top).toBe(760 - BUBBLE_H - ANCHOR_GAP)
    const topEdge = anchorOf({ left: 10, top: 0, right: 100, bottom: 795 }, view)
    expect(topEdge.top).toBeGreaterThanOrEqual(ANCHOR_GAP)
  })
})

describe('② 宿主：消息组装（buildSideAskMessages）', () => {
  test('两条消息：system 在最前，引用块在问题前面（带围栏）', () => {
    const messages = buildSideAskMessages('这是什么？', 'const a = 1')
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    const question = messages[1]?.content ?? ''
    expect(question).toContain('````')
    expect(question.indexOf('const a = 1')).toBeLessThan(question.indexOf('这是什么？'))
  })

  test('没有引用时只有问题；引用超长按上限截断；提示词写明不执行工具', () => {
    expect(buildSideAskMessages('只问一句').at(1)?.content).toBe('只问一句')
    expect(buildSideAskMessages('q', 'y'.repeat(SIDE_ASK_MAX_QUOTE + 100)).at(1)?.content).toContain('引用过长')
    expect(SIDE_ASK_SYSTEM).toContain('不执行工具')
  })
})

describe('② 宿主：sideAskOnce 的只读保证与三种收尾', () => {
  test('只拼正文增量（reasoning 不混进答案）、回包带模型名', async () => {
    const seen: Array<{ api: string; request: Record<string, unknown> }> = []
    const stream: LlmStream = async (api, request, handlers) => {
      seen.push({ api, request: request as unknown as Record<string, unknown> })
      handlers.onDelta('text', '你')
      handlers.onDelta('reasoning', '思考中')
      handlers.onDelta('text', '好')
      return streamResult('你好')
    }
    const outcome = await sideAskOnce({ route, stream, question: '问', quote: '引', signal: new AbortController().signal })
    expect(outcome.text).toBe('你好')
    expect(outcome.model).toBe('m')
    expect(outcome.stopped).toBe(false)
  })

  test('请求不带 tools（只读的硬保证）、输出预算封顶、思考档与温度照路由带', async () => {
    let sent: Record<string, unknown> | null = null
    const stream: LlmStream = async (_api, request) => {
      sent = request as unknown as Record<string, unknown>
      return streamResult('好')
    }
    await sideAskOnce({ route, stream, question: '问', quote: '引', signal: new AbortController().signal })
    expect(sent).not.toBeNull()
    expect(sent?.tools).toBeUndefined()
    expect(sent?.maxTokens).toBe(SIDE_ASK_MAX_TOKENS)
    expect(sent?.temperature).toBe(0.3)
  })

  test('取消：signal 先 aborted，派发口抛错 → 回「已停止」而不是炸', async () => {
    const controller = new AbortController()
    controller.abort()
    const failing: LlmStream = async () => {
      throw new Error('aborted')
    }
    const stopped = await sideAskOnce({ route, stream: failing, question: '问', signal: controller.signal })
    expect(stopped.stopped).toBe(true)
    expect(stopped.text).toBe('')
  })

  test('适配器 abort 时正常收尾：信号已中止就该报 stopped，而不是 done', async () => {
    const halfController = new AbortController()
    const halfStream: LlmStream = async (_api, _request, handlers) => {
      handlers.onDelta('text', '半截')
      halfController.abort()
      return streamResult('半截')
    }
    const half = await sideAskOnce({ route, stream: halfStream, question: '问', signal: halfController.signal })
    expect(half.stopped).toBe(true)
    expect(half.text).toBe('半截')
  })

  test('真错误照旧抛：不能把「网络挂了」也说成「已停止」', async () => {
    const failing: LlmStream = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(
      sideAskOnce({ route, stream: failing, question: '问', signal: new AbortController().signal }),
    ).rejects.toThrow('ECONNREFUSED')
  })
})

describe('③ 界面通道：白名单与实参规格（真实导出面）', () => {
  test('sideAsk / sideAskCancel 在界面白名单，sideAsk 在协议白名单', () => {
    expect(UI_METHODS).toContain('sideAsk')
    expect(UI_METHODS).toContain('sideAskCancel')
    expect(INVOKABLE_METHODS).toContain('sideAsk')
  })

  test('正常实参放行；空引用传空串放行（界面永远传字符串）', () => {
    expect(validateUiArgs('sideAsk', ['问一句', '引一段', 'ticket-1', 'local', 'm-1']).ok).toBe(true)
    expect(validateUiArgs('sideAsk', ['q', '', 't-1', '', '']).ok).toBe(true)
  })

  test('缺票据、缺模型两参、中间的 undefined 都被拒（省略只能从尾部）', () => {
    expect(validateUiArgs('sideAsk', ['问一句']).ok).toBe(false)
    expect(validateUiArgs('sideAsk', ['q', '', 't-1']).ok).toBe(false)
    expect(validateUiArgs('sideAsk', ['q', undefined, 't-1', '', '']).ok).toBe(false)
  })

  test('超长问题 / 超长引用 / 超长取消票据都被拒', () => {
    expect(validateUiArgs('sideAsk', ['x'.repeat(5000), '', 't-1', '', '']).ok).toBe(false)
    expect(validateUiArgs('sideAsk', ['q', 'x'.repeat(9000), 't-1', '', '']).ok).toBe(false)
    expect(validateUiArgs('sideAskCancel', ['x'.repeat(65)]).ok).toBe(false)
  })
})
