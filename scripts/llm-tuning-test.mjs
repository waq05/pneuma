/**
 * 模型请求的时限与重试可配（2026-11-07 晚）：`config.yaml` 顶层的 `llm:` 段。
 *
 * 由来：PTC 真机实拍连挂五次「连接超时（30 秒无响应）」。30 秒是内置的建连+响应头时限，
 * 而 ptc 模式的系统提示比标准模式长得多，上游网关要等模型起完才吐响应头。当时唯一的旋钮
 * 是环境变量，用户手上没有可改的东西——端点是用户自己配的，prompt 多大也是他选的活，
 * 时限就该写进他自己那份配置里。
 *
 * 这份探针钉五件事：
 *   ① 没写 `llm:` 段 → 空对象，两条时限与重试次数回落到内置默认；
 *   ② 写了 → 读得出来；
 *   ③ 写得离谱 → 夹进区间，不照抄（0 / 负数当没写）；
 *   ④ 改了文件 → mtime 变了就重新读（缓存不许把新值吃掉）；
 *   ⑤ 环境变量仍排在配置文件前面（自检要能临时盖一次而不动用户配置）。
 *
 * 隔离：临时 HOME，真实 ~/.dsc 一个字节不动；不连任何端点。
 * 运行：pnpm build && node scripts/llm-tuning-test.mjs
 *
 * @module dsc/scripts/llm-tuning-test
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-llm-tuning-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })
const configPath = join(process.env.DSC_HOME, 'config.yaml')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

/** 写一份 config.yaml，并把 mtime 顶到指定秒，避开「同一毫秒内两次写、mtime 没变」的假缓存命中。 */
let stamp = 1_700_000_000
const writeConfig = (body) => {
  writeFileSync(configPath, body, 'utf8')
  stamp += 1
  utimesSync(configPath, stamp, stamp)
}

const { readLlmTuning } = await import('../lib/core/config.js')
const { readRetryAttempts, resolveTimeouts } = await import('../lib/core/llm.js')

console.log('\n[1] 没有 llm 段：一律回落内置默认')
{
  writeConfig('default:\n  provider: fake\n  model: fake-chat\nproviders:\n  fake:\n    baseURL: http://127.0.0.1:1/v1\n    models:\n      - id: fake-chat\n')
  const tuning = readLlmTuning()
  check('读数是个空对象', Object.keys(tuning).length === 0, JSON.stringify(tuning))
  const timeouts = resolveTimeouts()
  check('建连时限 = 30 秒', timeouts.connectMs === 30_000, String(timeouts.connectMs))
  check('流空闲时限 = 180 秒', timeouts.idleMs === 180_000, String(timeouts.idleMs))
  check('重试次数 = 6（首试 + 5）', readRetryAttempts() === 6, String(readRetryAttempts()))
}

console.log('\n[2] 写了 llm 段：三个数都读得出来')
{
  writeConfig('llm:\n  connectTimeoutMs: 120000\n  streamIdleMs: 300000\n  retryAttempts: 8\ndefault:\n  provider: fake\n  model: fake-chat\nproviders:\n  fake:\n    baseURL: http://127.0.0.1:1/v1\n    models:\n      - id: fake-chat\n')
  const tuning = readLlmTuning()
  check('connectTimeoutMs = 120000', tuning.connectTimeoutMs === 120_000, String(tuning.connectTimeoutMs))
  check('streamIdleMs = 300000', tuning.streamIdleMs === 300_000, String(tuning.streamIdleMs))
  check('retryAttempts = 8', tuning.retryAttempts === 8, String(tuning.retryAttempts))
  const timeouts = resolveTimeouts()
  check('建连时限用配置值', timeouts.connectMs === 120_000, String(timeouts.connectMs))
  check('流空闲用配置值', timeouts.idleMs === 300_000, String(timeouts.idleMs))
  check('重试次数用配置值', readRetryAttempts() === 8, String(readRetryAttempts()))
}

console.log('\n[3] 写得离谱：夹进区间，不照抄')
{
  writeConfig('llm:\n  connectTimeoutMs: 99999999\n  streamIdleMs: 1\n  retryAttempts: 999\ndefault:\n  provider: fake\n  model: fake-chat\nproviders: {}\n')
  const tuning = readLlmTuning()
  check('建连时限封顶 10 分钟', tuning.connectTimeoutMs === 600_000, String(tuning.connectTimeoutMs))
  check('流空闲低于下限也抬到 5 秒', tuning.streamIdleMs === 5_000, String(tuning.streamIdleMs))
  check('重试次数封顶 20', tuning.retryAttempts === 20, String(tuning.retryAttempts))
}

console.log('\n[4] 0 / 负数 / 非数字：当没写，回落默认')
{
  writeConfig('llm:\n  connectTimeoutMs: 0\n  streamIdleMs: -1\n  retryAttempts: abc\ndefault:\n  provider: fake\n  model: fake-chat\nproviders: {}\n')
  const tuning = readLlmTuning()
  check('三个数都被丢掉', Object.keys(tuning).length === 0, JSON.stringify(tuning))
  check('建连时限回到 30 秒', resolveTimeouts().connectMs === 30_000, String(resolveTimeouts().connectMs))
}

console.log('\n[5] 改完文件立刻生效（缓存按 mtime 失效）')
{
  writeConfig('llm:\n  connectTimeoutMs: 45000\ndefault:\n  provider: fake\n  model: fake-chat\nproviders: {}\n')
  check('先读到 45 秒', resolveTimeouts().connectMs === 45_000, String(resolveTimeouts().connectMs))
  writeConfig('llm:\n  connectTimeoutMs: 90000\ndefault:\n  provider: fake\n  model: fake-chat\nproviders: {}\n')
  check('改完读到 90 秒（没有被缓存吃掉）', resolveTimeouts().connectMs === 90_000, String(resolveTimeouts().connectMs))
}

console.log('\n[6] 环境变量排在配置文件前面')
{
  writeConfig('llm:\n  connectTimeoutMs: 90000\n  retryAttempts: 8\ndefault:\n  provider: fake\n  model: fake-chat\nproviders: {}\n')
  process.env.DSC_LLM_CONNECT_TIMEOUT_MS = '8000'
  process.env.DSC_LLM_RETRY_ATTEMPTS = '2'
  check('建连时限用环境变量的 8 秒', resolveTimeouts().connectMs === 8_000, String(resolveTimeouts().connectMs))
  check('重试次数用环境变量的 2', readRetryAttempts() === 2, String(readRetryAttempts()))
  delete process.env.DSC_LLM_CONNECT_TIMEOUT_MS
  delete process.env.DSC_LLM_RETRY_ATTEMPTS
  check('去掉环境变量又回到配置值', resolveTimeouts().connectMs === 90_000, String(resolveTimeouts().connectMs))
}

console.log('\n[7] 配置文件不存在 / 写坏了：不抛，按默认走')
{
  writeConfig(': : : 不是 yaml\n\t- [\n')
  const tuning = readLlmTuning()
  check('读坏了给空对象，不抛', typeof tuning === 'object' && Object.keys(tuning).length === 0, JSON.stringify(tuning))
  check('两条时限仍是内置默认', resolveTimeouts().connectMs === 30_000 && resolveTimeouts().idleMs === 180_000)
}

console.log('\n[8] 真 wire：配置值真的掐在了线上（没有一个环境变量）')
{
  const { LlmError, streamChat } = await import('../lib/core/llm.js')
  writeConfig('llm:\n  connectTimeoutMs: 1200\n  retryAttempts: 1\ndefault:\n  provider: fake\n  model: fake-chat\nproviders: {}\n')
  const realFetch = globalThis.fetch
  /** 「永不回应」的端点：只在被 abort 时把 abort 的 reason 抛回去（与 undici 同形）。 */
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  const started = Date.now()
  let error = null
  try {
    await streamChat({ apiKey: 'k', model: 'm', baseUrl: 'https://example.invalid/v1', messages: [{ role: 'user', content: 'hi' }] }, { onDelta() {} })
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - started
  globalThis.fetch = realFetch
  const message = error instanceof Error ? error.message : String(error)
  check('按配置的 1.2 秒掐断（不是默认 30 秒）', elapsed >= 900 && elapsed < 6000, `${elapsed}ms`)
  check(`报的秒数就是配置值（读到「${message}」）`, error instanceof LlmError && message.includes('连接超时（1 秒无响应）'), message)
}
if (failures > 0) {
  console.log(`\n${failures} 条失败`)
  process.exit(1)
}
console.log('\n全部通过')
