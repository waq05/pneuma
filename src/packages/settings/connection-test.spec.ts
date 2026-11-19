/**
 * 端点「测试连接」按钮的纯逻辑（迁自 `scripts/connection-test-test.mjs` 的前四段与接线值）。
 *
 * ## 这颗按钮回答什么问题
 *
 * 只有一个：**现在拿这个端点发一条消息会不会失败**。所以它不是「再查一次 /models」
 * （那是隔壁的「拉取清单」，只证明地址可达），而是走与正常对话同一条链路真发一次最小请求——
 * 探针消息固定两条（system + user `hi`）、无历史无工具、输出预算压到很小，端点要的请求头
 * 与协议适配器都照走。
 *
 * ## 为什么这一半在 unit
 *
 * 探针请求的形状、回话摘要、挑模型、成功/失败折句，全是纯函数；假 stream 传进去也不出网。
 * 真内核那一段（从设置服务一路走到线上请求）在 `connection-test.int.spec.ts`，那才需要
 * 起内核与本地假端点。
 *
 * ## 迁过来的接线断言只剩「运行时值」
 *
 * 原探针第五段读 `src/**.ts` 源码找字符串（界面按钮的 JSX、CSS 选择器、契约里的方法签名）。
 * 那种断言验的是写法不是行为，已按台账 D24 删除并在交付里逐条记账；这里只留下**真导出值**：
 * 界面白名单 `UI_METHODS`、实参规格 `UI_ARG_SPECS`、宿主可调用清单 `INVOKABLE_METHODS`。
 *
 * @module @pneuma/settings/connection-test.spec
 */
import { describe, expect, test } from 'vitest'
import { INVOKABLE_METHODS } from '../../core/host-methods.js'
import { UI_ARG_SPECS, UI_METHODS } from '../../core/ui-methods.js'
import type { LlmRoute, LlmStream, StreamHandlers, StreamRequest } from '../../core/llm.js'
import {
  clipReply,
  CONNECTION_PROBE_MAX_TOKENS,
  CONNECTION_PROBE_MESSAGES,
  CONNECTION_PROBE_TIMEOUT_MS,
  connectionProbeRequest,
  pickProbeModel,
  testConnection,
} from './connection-test.js'

/** 一份端到端可用的路由：测试要验的就是「这些字段照原样带下去」。 */
const route: LlmRoute = {
  api: 'openai-completions',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-secret',
  model: 'm-1',
}

/** 一次成功的流式应答（正文 `ok`）。 */
function streamResult(text = 'ok'): Awaited<ReturnType<LlmStream>> {
  return { text, reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
}

describe('① 探针请求：固定的两条消息，不掺会话', () => {
  test('messages 恰好两条，system 在前、user 是那句 hi', () => {
    const request = connectionProbeRequest(route)
    expect(request.messages).toHaveLength(2)
    expect(request.messages[0]?.role).toBe('system')
    expect(request.messages[1]?.role).toBe('user')
    expect(request.messages[1]?.content).toBe('hi')
  })

  test('system 非空且只出现在最前一条（中间冒 system 会被网关判 400）', () => {
    const request = connectionProbeRequest(route)
    expect(request.messages[0]?.content).not.toBe('')
    expect(request.messages.every((message, index) => message.role !== 'system' || index === 0)).toBe(true)
  })

  test('不带工具目录，也不自己挂 signal（signal 由 testConnection 接）', () => {
    const request = connectionProbeRequest(route)
    expect(request.tools).toBeUndefined()
    expect(request.signal).toBeUndefined()
  })

  test('输出预算压得很小（不超过 32）', () => {
    expect(connectionProbeRequest(route).maxTokens).toBe(CONNECTION_PROBE_MAX_TOKENS)
    expect(CONNECTION_PROBE_MAX_TOKENS).toBeLessThanOrEqual(32)
  })

  test('baseUrl / apiKey / model 照路由原样带（测的就是这个端点）', () => {
    const request = connectionProbeRequest(route)
    expect(request.baseUrl).toBe(route.baseUrl)
    expect(request.apiKey).toBe(route.apiKey)
    expect(request.model).toBe(route.model)
  })

  test('路由声明了思考字段就照带（测试走的必须是平时那条路）', () => {
    expect(connectionProbeRequest({ ...route, thinking: 'disabled' }).thinking).toBe('disabled')
    expect(connectionProbeRequest({ ...route, reasoningEffort: 'high' }).reasoningEffort).toBe('high')
  })

  test('路由声明了显式缓存也照带（缓存命中与否是端点的真实差别）', () => {
    expect(connectionProbeRequest({ ...route, cacheControl: true }).cacheControl).toBe(true)
  })

  test('路由没声明就一个多余字段都不发', () => {
    const request = connectionProbeRequest(route)
    expect(request.thinking).toBeUndefined()
    expect(request.reasoningEffort).toBeUndefined()
    expect(request.cacheControl).toBeUndefined()
  })

  test('messages 是副本：改返回值不会污染常量', () => {
    const one = connectionProbeRequest(route)
    one.messages.push({ role: 'user', content: 'x' })
    expect(connectionProbeRequest(route).messages).toHaveLength(2)
    expect(CONNECTION_PROBE_MESSAGES).toHaveLength(2)
  })

  test('截止时间是「按钮等得起」的值（不超过 30 秒）', () => {
    expect(CONNECTION_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })
})

describe('② 回话摘要：压平、截断、空就是空', () => {
  test('换行压平 + 去首尾空白', () => {
    expect(clipReply('  好\n的\n ')).toBe('好 的')
  })

  test('超长截断到 80 字并带省略号', () => {
    const clipped = clipReply('啊'.repeat(200))
    expect(clipped).toHaveLength(81)
    expect(clipped.endsWith('…')).toBe(true)
  })

  test('空回话就是空串（不编一句）', () => {
    expect(clipReply('')).toBe('')
    expect(clipReply('   ')).toBe('')
  })
})

describe('③ 成功路径：流正常收尾即通', () => {
  test('ok=true、带回话摘要与耗时，失败字段为空', async () => {
    const outcome = await testConnection(route, async () => streamResult())
    expect(outcome.ok).toBe(true)
    expect(outcome.reply).toBe('ok')
    expect(typeof outcome.ms).toBe('number')
    expect(outcome.ms).toBeGreaterThanOrEqual(0)
    expect(outcome.error).toBeUndefined()
  })

  test('按路由声明的协议派发，传下去的就是探针请求', async () => {
    let seen: { api: string; request: StreamRequest } | undefined
    await testConnection(route, async (api, request) => {
      seen = { api, request }
      return streamResult()
    })
    expect(seen?.api).toBe(route.api)
    expect(seen?.request.messages).toHaveLength(2)
    expect(seen?.request.model).toBe(route.model)
  })

  test('挂上了信号且此刻没被中止，也给适配器留了 onDelta', async () => {
    let signal: AbortSignal | undefined
    let handlers: StreamHandlers | undefined
    await testConnection(route, async (_api, request, given) => {
      signal = request.signal
      handlers = given
      return streamResult()
    })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
    expect(typeof handlers?.onDelta).toBe('function')
  })

  test('正文为空但流收尾 → 仍算通，reply 是空串', async () => {
    // 预算压得很小时模型常常来不及吐字，但「路能走完」已经证明了要证的事
    const outcome = await testConnection(route, async () => streamResult(''))
    expect(outcome.ok).toBe(true)
    expect(outcome.reply).toBe('')
  })
})

describe('④ 失败路径：折成一句话，不往外抛', () => {
  test('端点报错 → ok:false，原因带「连接失败：」前缀并保留端点原文', async () => {
    const outcome = await testConnection(route, async () => {
      throw new Error('HTTP 401：invalid api key')
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.startsWith('连接失败：')).toBe(true)
    expect(outcome.error).toContain('HTTP 401')
    expect(typeof outcome.ms).toBe('number')
    expect(outcome.reply).toBe('')
  })

  test('超时说的是「超时」而不是端点拒了（两种毛病分开说）', async () => {
    // 挂住的端点：不能把按钮永远转下去，超时按「我们自己按停的」说
    const hanging: LlmStream = (_api, request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'))
          },
          { once: true },
        )
      })
    const started = Date.now()
    const outcome = await testConnection(route, hanging, 300)
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.startsWith('超时：')).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(outcome.ms).toBeGreaterThanOrEqual(0)
  })
})

describe('⑤ 挑模型：显式 > 平时用的那个 > 清单第一个', () => {
  const models = [{ id: 'm-a' }, { id: 'm-b' }]
  const defaults = { provider: 'go', model: 'm-b' }

  test('显式点名优先，且名字去空白', () => {
    expect(pickProbeModel('go', models, 'm-a', defaults)).toBe('m-a')
    expect(pickProbeModel('go', models, '  m-a  ', defaults)).toBe('m-a')
  })

  test('没点名时：这个端点就是默认端点，取它配的默认模型', () => {
    expect(pickProbeModel('go', models, undefined, defaults)).toBe('m-b')
  })

  test('默认端点是别人 → 取清单第一个', () => {
    expect(pickProbeModel('other', models, undefined, defaults)).toBe('m-a')
  })

  test('默认模型不在这个端点里 → 取清单第一个', () => {
    expect(pickProbeModel('go', models, undefined, { provider: 'go', model: 'm-zzz' })).toBe('m-a')
  })

  test('空清单 → 空串（调用方据此报「还没有模型」）', () => {
    expect(pickProbeModel('go', [], undefined, defaults)).toBe('')
  })

  test('点名了一个清单里没有的 → 照原名返回（让 routeTo 去报那个更准的错）', () => {
    expect(pickProbeModel('go', models, 'm-nope', defaults)).toBe('m-nope')
  })

  test('空串点名按没点名算', () => {
    expect(pickProbeModel('go', models, '   ', defaults)).toBe('m-b')
  })
})

describe('⑥ 接线值：三份清单都放行了这颗按钮', () => {
  test('界面白名单放了它', () => {
    expect(UI_METHODS).toContain('testConnection')
  })

  test('实参规格：端点名（字符串）+ 可选的模型名', () => {
    const spec = UI_ARG_SPECS.testConnection
    expect(spec).toHaveLength(2)
    expect(spec[0]?.shape.kind).toBe('string')
    expect(spec[1]?.optional).toBe(true)
  })

  test('宿主可调用清单也放了它（漏一个桌面 tsc / 远程路由就红）', () => {
    expect(INVOKABLE_METHODS).toContain('testConnection')
  })

  test('远程白名单不放它（凭据相关操作不上手机）', async () => {
    // 远程侧那条名单在 remote/types.ts；这一条是「别顺手放宽」的兜底。
    const { REMOTE_METHODS } = await import('@pneuma/remote/types.js')
    expect(REMOTE_METHODS).not.toContain('testConnection')
  })
})
