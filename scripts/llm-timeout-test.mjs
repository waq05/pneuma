/**
 * LLM 超时可配（用户报「子代理很慢」查出来的那笔账）：
 *
 * 端点连不上时，默认要等**连接超时 30 秒 × 6 次尝试 ≈ 3 分钟**失败才浮到界面上——慢的不是
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

const { LlmError, readRetryAttempts, readTimeoutMs, retryDelayMs, streamChat } = await import('../lib/core/llm.js')

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
  // 这一节测的是「超时怎么掐断」，不是「重试怎么退避」：把预算压到 1 次，别让退避把
  // 断言里的 6 秒上限撑爆（退避本身在第 [4] 节单独测）。
  process.env.DSC_LLM_RETRY_ATTEMPTS = '1'
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
  delete process.env.DSC_LLM_RETRY_ATTEMPTS
  globalThis.fetch = realFetch
}

// ── [3] 真 wire：流空闲超时按覆盖值掐断 ─────────────────────────────────────
{
  const realFetch = globalThis.fetch
  /** 建连成功、SSE 头就绪，但一个字节都不吐（服务端挂起的形状）。 */
  globalThis.fetch = () =>
    Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  process.env.DSC_LLM_STREAM_IDLE_MS = '1200'
  process.env.DSC_LLM_RETRY_ATTEMPTS = '1'
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
  delete process.env.DSC_LLM_RETRY_ATTEMPTS
  globalThis.fetch = realFetch
}


// ── [4] 退避曲线与重试预算（2026-11-07：429 频繁报错的根因） ───────────────
//
// 报障现场：同一模型在 dsh 里正常，在 dsc 里频繁报「HTTP 429 … the cell is at capacity;
// retry shortly (after 30 s)」。差别全在预算上——dsh 的 normal 档给 5 次重试、退避 500ms→10s，
// 总窗口 15.5 秒；dsc 原来只给 2 次、加起来 1.5 秒，一次车队式限流就整轮报错。
{
  // 纯函数：倍数退避 + ±10% 抖动（random 传 0.5 就是中线，钉死期望值）
  check('第 1 次重试等 500 毫秒', retryDelayMs(1, () => 0.5) === 500, String(retryDelayMs(1, () => 0.5)))
  check('第 2 次重试等 1000 毫秒', retryDelayMs(2, () => 0.5) === 1000, String(retryDelayMs(2, () => 0.5)))
  check('第 5 次重试等 8000 毫秒', retryDelayMs(5, () => 0.5) === 8000, String(retryDelayMs(5, () => 0.5)))
  check('再往后封顶 10 秒（不许无限翻倍）', retryDelayMs(9, () => 0.5) === 10_000, String(retryDelayMs(9, () => 0.5)))
  check('抖动下限 −10%', retryDelayMs(1, () => 0) === 450, String(retryDelayMs(1, () => 0)))
  check('抖动上限 +10%', retryDelayMs(1, () => 1) === 550, String(retryDelayMs(1, () => 1)))
  // 预算：默认 6 次尝试（首试 + 5 次重试）；环境变量可覆盖，且夹在 1~20
  delete process.env.DSC_LLM_RETRY_ATTEMPTS
  check('缺省预算 = 6 次尝试', readRetryAttempts() === 6, String(readRetryAttempts()))
  process.env.DSC_LLM_RETRY_ATTEMPTS = '3'
  check('覆盖成 3 次尝试', readRetryAttempts() === 3, String(readRetryAttempts()))
  process.env.DSC_LLM_RETRY_ATTEMPTS = '0'
  check('0 回落默认（关不掉重试）', readRetryAttempts() === 6, String(readRetryAttempts()))
  process.env.DSC_LLM_RETRY_ATTEMPTS = '999'
  check('上界夹到 20', readRetryAttempts() === 20, String(readRetryAttempts()))
  delete process.env.DSC_LLM_RETRY_ATTEMPTS

  // 真 wire：连续两次 429 之后成功——每次重试都要报一次「第几次 / 允许几次 / 等多久」
  const realFetch = globalThis.fetch
  /** 一条最小的合法 SSE 响应（正文「收到」+ [DONE]）。 */
  const okStream = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          const chunk = JSON.stringify({ choices: [{ delta: { content: '收到' }, finish_reason: 'stop' }] })
          controller.enqueue(encoder.encode(`data: ${chunk}\n\ndata: [DONE]\n\n`))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls < 3) {
      return new Response(JSON.stringify({ error: { message: 'the cell is at capacity' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }
    return okStream()
  }
  process.env.DSC_LLM_RETRY_ATTEMPTS = '3'
  const retries = []
  const result = await streamChat(
    { apiKey: 'k', model: 'm', baseUrl: 'https://example.invalid/v1', messages: [{ role: 'user', content: 'hi' }] },
    { onDelta() {}, onRetry: (attempt, reason, info) => retries.push({ attempt, reason, ...info }) },
  )
  check('两次 429 之后真的重发了（三次物理请求）', calls === 3, String(calls))
  check('重试报了两条', retries.length === 2, JSON.stringify(retries.map((r) => r.attempt)))
  check(
    '报的是「第几次重试」（1、2，界面上的分子）',
    retries[0]?.attempt === 1 && retries[1]?.attempt === 2,
    JSON.stringify(retries.map((r) => r.attempt)),
  )
  check(
    '分母是允许的重试次数（预算 3 = 最多重试 2 次）',
    retries.every((r) => r.maxRetries === 2),
    JSON.stringify(retries.map((r) => r.maxRetries)),
  )
  check(
    '退避按 500 → 1000 走（含 ±10% 抖动）',
    retries[0]?.delayMs >= 450 && retries[0]?.delayMs <= 550 && retries[1]?.delayMs >= 900 && retries[1]?.delayMs <= 1100,
    JSON.stringify(retries.map((r) => r.delayMs)),
  )
  check('重试后这一轮照样收下', result.text === '收到', JSON.stringify(result.text))
  check('失败原因带着上游报文', String(retries[0]?.reason).includes('429'), String(retries[0]?.reason))

  // 预算用完就如实报错，不许假装还在重试
  let alwaysCalls = 0
  globalThis.fetch = async () => {
    alwaysCalls += 1
    return new Response(JSON.stringify({ error: { message: 'capacity' } }), { status: 429 })
  }
  process.env.DSC_LLM_RETRY_ATTEMPTS = '2'
  const exhaustedRetries = []
  let exhausted = null
  try {
    await streamChat(
      { apiKey: 'k', model: 'm', baseUrl: 'https://example.invalid/v1', messages: [{ role: 'user', content: 'hi' }] },
      { onDelta() {}, onRetry: (attempt, reason, info) => exhaustedRetries.push({ attempt, ...info }) },
    )
  } catch (caught) {
    exhausted = caught
  }
  check('预算 2 = 首试 + 1 次重试', alwaysCalls === 2, String(alwaysCalls))
  check('只报了一条重试', exhaustedRetries.length === 1, String(exhaustedRetries.length))
  check(
    '用完就报错，错误里带着状态码',
    exhausted instanceof LlmError && exhausted.message.includes('HTTP 429'),
    exhausted instanceof Error ? exhausted.message : String(exhausted),
  )
  delete process.env.DSC_LLM_RETRY_ATTEMPTS
  globalThis.fetch = realFetch
}
process.exit(failures === 0 ? 0 : 1)
