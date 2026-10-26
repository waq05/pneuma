/**
 * LLM 超时可配（用户报「子代理很慢」查出来的那笔账）：
 *
 * 端点连不上时，默认要等**连接超时 30 秒 × 3 次重试 ≈ 90 秒**失败才浮到界面上——慢的不是
 * 界面，是这个等待。这一批把两个超时做成环境变量可覆盖：
 *
 *   - `DSC_LLM_CONNECT_TIMEOUT_MS`：建连 + 响应头（默认 30s）；
 *   - `DSC_LLM_STREAM_IDLE_MS`：流空闲（默认 180s，SSE 心跳也算字节会重置计时）。
 *
 * 断言三层：① 读数纯函数（缺省 / 覆盖 / 上下夹住 / 垃圾值回落）；② 真 wire——桩一个
 * 「永不回应」的 fetch，看连接超时是不是按覆盖值提前掐断、报的秒数是不是覆盖值；
 * ③ 流空闲同理（桩一个开了永不吐字节的 SSE 流）。
 *
 * 用法：pnpm build && node scripts/llm-timeout-test.mjs
 *
 * @module dsc/scripts/llm-timeout-test
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-timeout-home-'))
process.env.HOME = home
process.env.USERPROFILE = home

const { LlmError, readTimeoutMs, streamChat } = await import('../lib/core/llm.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('LLM 超时可配测试')

// ── [1] 读数纯函数 ─────────────────────────────────────────────────────────
{
  const NAME = 'DSC_TEST_TIMEOUT_MS'
  delete process.env[NAME]
  check('缺省：用回默认值', readTimeoutMs(NAME, 30_000) === 30_000)
  process.env[NAME] = '8000'
  check('覆盖：给几就是几', readTimeoutMs(NAME, 30_000) === 8000)
  process.env[NAME] = '10'
  check('下界夹住（最小 1 秒）：写 10 毫秒不会让请求全秒失败', readTimeoutMs(NAME, 30_000) === 1_000)
  process.env[NAME] = '99999999'
  check('上界夹住（最大 10 分钟）：写一天也不会把端点等死', readTimeoutMs(NAME, 30_000) === 600_000)
  process.env[NAME] = 'abc'
  check('垃圾值回落默认', readTimeoutMs(NAME, 30_000) === 30_000)
  process.env[NAME] = '0'
  check('0 也回落（0 会被读成「立刻超时」）', readTimeoutMs(NAME, 30_000) === 30_000)
  process.env[NAME] = '1234.6'
  check('小数取整', readTimeoutMs(NAME, 30_000) === 1235, String(readTimeoutMs(NAME, 30_000)))
  delete process.env[NAME]
}

// ── [2] 真 wire：连接超时按覆盖值掐断 ───────────────────────────────────────
{
  const realFetch = globalThis.fetch
  /** 「永不回应」的端点：只在被 abort 时把 abort 的 reason 抛回去（undici 同形）。 */
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  process.env.DSC_LLM_CONNECT_TIMEOUT_MS = '1200'
  const started = Date.now()
  let error = null
  try {
    await streamChat({ apiKey: 'k', model: 'm', baseUrl: 'https://example.invalid/v1', messages: [{ role: 'user', content: 'hi' }] }, { onDelta() {} })
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - started
  check('连接超时按覆盖值提前掐断（≈1.2 秒，不是默认 30 秒）', elapsed >= 1000 && elapsed < 6000, `${elapsed}ms`)
  check(
    `报的秒数就是覆盖值（读到「${error instanceof Error ? error.message : String(error)}」）`,
    error instanceof LlmError && error.message.includes('连接超时（1 秒无响应）'),
    error instanceof Error ? error.message : String(error),
  )
  check(
    '连接超时标成可重试（进重试环，而不是当致命错）',
    error instanceof LlmError && error.retryable === true,
    JSON.stringify(error instanceof LlmError ? { retryable: error.retryable } : error),
  )
  delete process.env.DSC_LLM_CONNECT_TIMEOUT_MS
  globalThis.fetch = realFetch
}

// ── [3] 真 wire：流空闲超时按覆盖值掐断 ─────────────────────────────────────
{
  const realFetch = globalThis.fetch
  /** 建连成功、SSE 头就绪，但一个字节都不吐（服务端挂起的形状）。 */
  globalThis.fetch = () =>
    Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  process.env.DSC_LLM_STREAM_IDLE_MS = '1200'
  const started = Date.now()
  let error = null
  try {
    await streamChat({ apiKey: 'k', model: 'm', baseUrl: 'https://example.invalid/v1', messages: [{ role: 'user', content: 'hi' }] }, { onDelta() {} })
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - started
  check('流空闲按覆盖值判定挂起（≈1.2 秒）', elapsed >= 1000 && elapsed < 6000, `${elapsed}ms`)
  check(
    `报的秒数就是覆盖值（读到「${error instanceof Error ? error.message : String(error)}」）`,
    error instanceof LlmError && error.message.includes('流空闲超过 1 秒'),
    error instanceof Error ? error.message : String(error),
  )
  // T33 的既定口径：**一个字节都没收到**的流中断按「连接失败」处理（可重试）——
  // 服务端挂起有时是网络瞬断，重试环值得再试一次；文案仍是「流空闲…」原样带出去。
  check(
    '流空闲在「零字节」时按连接失败处理（可重试，T33 既定口径）',
    error instanceof LlmError && error.retryable === true,
    JSON.stringify(error instanceof LlmError ? { retryable: error.retryable } : error),
  )
  delete process.env.DSC_LLM_STREAM_IDLE_MS
  globalThis.fetch = realFetch
}

process.exit(failures === 0 ? 0 : 1)
