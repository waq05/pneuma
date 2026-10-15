/**
 * 端点连接测试：拿这个端点**真发一次**最小的对话请求，看能不能通。
 *
 * 为什么不是「再查一次 /models」（那是隔壁的「拉取清单」）：那一步只证明地址可达，
 * 证不了 key 对不对、模型 id 在不在、协议适配器认不认、端点要的请求头带没带。
 * 这里走的是与正常对话**同一条**链路（同一个协议适配器、同一份归因头），所以它的
 * 结论就是「现在发一条消息会不会失败」的结论。
 *
 * 探针消息固定两条（system + user `hi`），不掺会话历史、不带工具、不带额外说明——
 * 同类客户端的连接测试也把它钉成固定契约：每个调用方各写一套的话，测的东西就不是
 * 用户要用的那条路了，测试本身也容易把会话内容漏出去。
 *
 * 判定口径：**流正常收尾即成功**（输出被 `max_tokens` 截断、正文为空都算通——通的
 * 意思是「这条路能走完」）。失败折成一句可直接展示的说明，**不重试**：测试要的是
 * 当下的真相，不是退避三轮之后的真相。
 *
 * @module dsc/core/connection-test
 */
import type { ChatMessage, LlmRoute, LlmStream, StreamRequest } from './llm.js'
import type { ConnectionTestOutcome } from '../contract.js'
import { errText } from './err-text.js'

/** 固定探针消息：两条、system 在最前、无历史无工具。 */
export const CONNECTION_PROBE_MESSAGES: readonly ChatMessage[] = [
  { role: 'system', content: '你是连接测试探针。收到消息后回一句简短的话即可。' },
  { role: 'user', content: 'hi' },
]

/**
 * 输出预算。测试只需要「流能收尾」，不需要模型真的写完一句话——给个很小的上限，
 * 免得一次点按烧掉一整天。参考实现的连接测试把这个预算压到 1 token（正文常常是空的，
 * 它们照样算通）。
 */
export const CONNECTION_PROBE_MAX_TOKENS = 16

/**
 * 测试自己的截止时间。正常请求的建连超时是 30 秒、流空闲超时 3 分钟——按钮不能让人
 * 盯着转那么久，所以这里另起一个更短的闸。
 */
export const CONNECTION_PROBE_TIMEOUT_MS = 20_000

/** 回话摘要的长度上限（界面上就那么一格，多出来的没处放）。 */
const REPLY_CLIP = 80

/**
 * 组一次测试请求：路由里**照原样**带这个模型平时会发的思考字段（测试的必须是与
 * 正常请求同形状的那条路），只把消息换成探针、预算压小。
 */
export function connectionProbeRequest(route: LlmRoute): StreamRequest {
  return {
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    messages: [...CONNECTION_PROBE_MESSAGES],
    maxTokens: CONNECTION_PROBE_MAX_TOKENS,
    ...(route.thinking === undefined ? {} : { thinking: route.thinking }),
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    // 端点声明了显式缓存就照原样带（测试的必须是与正常请求同形状的那条路）
    ...(route.cacheControl === true ? { cacheControl: true } : {}),
  }
}

/** 模型回话的单行摘要（换行压平、超长截断）；没回正文就是空串，不编一句。 */
export function clipReply(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > REPLY_CLIP ? `${flat.slice(0, REPLY_CLIP)}…` : flat
}

/**
 * 测哪个模型：显式点名的 > 这个端点**平时真会用到**的那个（它就是默认端点时，取默认
 * 模型——用户点这颗按钮十有八九在问「我现在这条路由能不能通」）> 清单里的第一个。
 * 返回空串 = 这个端点一个模型都没有，没法测。
 */
export function pickProbeModel(
  providerName: string,
  models: readonly { id: string }[],
  wanted: string | undefined,
  defaults: { provider: string; model: string },
): string {
  const named = wanted?.trim() ?? ''
  if (named !== '') return named
  if (defaults.provider === providerName && models.some((model) => model.id === defaults.model)) {
    return defaults.model
  }
  return models[0]?.id ?? ''
}

/**
 * 发一次测试请求。`stream` 是经 llm 服务派发的流式调用（与回合/压缩共用同一个口子，
 * 所以端点要的归因头、协议适配器都照走）。
 *
 * @param route - 被测端点的路由（由调用方按端点名/模型组好）。
 * @param stream - 派发用的流式调用。
 * @param timeoutMs - 截止时间；超了就不等了（结论按超时报，不按端点报错报）。
 */
export async function testConnection(
  route: LlmRoute,
  stream: LlmStream,
  timeoutMs: number = CONNECTION_PROBE_TIMEOUT_MS,
): Promise<ConnectionTestOutcome> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  try {
    const result = await stream(
      route.api,
      { ...connectionProbeRequest(route), signal: controller.signal },
      { onDelta() {} },
    )
    return { ok: true, ms: Date.now() - started, reply: clipReply(result.text) }
  } catch (error) {
    // 超时与「端点回了错」是两种毛病，得分开说：超时是我们自己按停的，不是它拒了谁
    const message = controller.signal.aborted
      ? `超时：${String(Math.round(timeoutMs / 1000))} 秒没等到结果`
      : `连接失败：${errText(error)}`
    return { ok: false, ms: Date.now() - started, reply: '', error: message }
  } finally {
    clearTimeout(timer)
  }
}
