/**
 * B2 首 token 延迟：请求发出 → 首个 SSE chunk 落地。
 *
 * ## 口径（与设计 §4.2 的差异，必须写清）
 *
 * 设计原文是「从内核回合里量：起真内核走一轮，取请求发出 → 首 chunk 落地的时间差」。
 * 内核回合里没有一个稳定的「首 chunk」观测点：`onDelta` 只在内核内部（`loop` →
 * transcript 投影）可见，从外面订阅到的是帧合并后的 `dsc/changed`，量到的是「首 token +
 * 回合装配 + 落库」的混合值，与这条基准想钉的「传输 + 解析」不是一回事。
 *
 * 所以这里量的是 **llm 客户端流解析通道的等价指标**：
 *
 * - 起点 = 调用 `streamChat()` 前一刻（HTTP 请求由它发出）；
 * - 终点 = 首个 SSE `data:` 帧完成 JSON 解析、内容增量回调到 `onDelta` 的时刻；
 * - 包含：建连、等响应头、首帧网络传输、SSE 分帧、JSON 解析；
 * - 不包含：内核回合装配、prompt 拼装、transcript 投影、React/ink 渲染、落库。
 *
 * 这条口径比「内核回合」更窄，但更稳定：它只随 `core/llm.ts` 的传输/解析路径变化。
 * 把它与 B1 的启动耗时、B4 的渲染耗时分开钉，退化时能直接指到是哪一段慢了。
 *
 * 端点只回一帧正文；帧序与 harness 的 `sseBody` 一致（正文 → finish_reason → usage →
 * `[DONE]`），少 `[DONE]` 会挂到空闲超时而不是报错。
 *
 * ## 输出
 *
 * 一行 `BENCH_RESULT {id,label,metric,value,detail}`。value 单位毫秒，是首帧耗时；
 * `detail.totalMs` 是整条流读完的耗时（含剩余帧），只作参照，不参与退化判定。
 *
 * @module tests/bench/b2-first-token
 */
import { createTempHome, emitResult, fail, libUrl, startSSEServer } from './helpers.mjs'

const ID = 'b2-first-token'
const LABEL = 'B2 首 token 延迟'
const CONTENT = '首 token 基准'

createTempHome('dsc-bench-b2-')

const server = await startSSEServer({ content: CONTENT })
try {
  const { streamChat } = await import(libUrl('core/llm.js'))
  let firstDeltaAt = null
  let firstDeltaKind = null

  const startedAt = performance.now()
  const result = await streamChat(
    {
      baseUrl: server.baseUrl,
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: '基准请求' }],
    },
    {
      onDelta(kind) {
        if (firstDeltaAt !== null) return
        firstDeltaAt = performance.now() - startedAt
        firstDeltaKind = kind
      },
    },
  )
  const totalMs = performance.now() - startedAt

  if (firstDeltaAt === null) throw new Error('整条流读完都没收到 onDelta：首 chunk 观测点没被触发')
  if (firstDeltaKind !== 'text') throw new Error(`首个增量不是正文（收到 ${String(firstDeltaKind)}）`)
  if (result.text !== CONTENT) throw new Error(`首帧正文不对：期望 ${JSON.stringify(CONTENT)}，收到 ${JSON.stringify(result.text)}`)
  if (result.finishReason !== 'stop') throw new Error(`finish_reason 不是 stop（收到 ${String(result.finishReason)}）`)

  emitResult({
    id: ID,
    label: LABEL,
    metric: 'ms',
    value: Math.round(firstDeltaAt * 1000) / 1000,
    detail: { totalMs: Math.round(totalMs * 1000) / 1000, chunk: 'delta.content' },
  })
} catch (error) {
  fail(`${LABEL}：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server.close()
}
