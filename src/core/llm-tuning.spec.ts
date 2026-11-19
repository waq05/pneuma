/**
 * 模型请求的时限与重试可配（`config.yaml` 顶层的 `llm:` 段），迁自
 * `scripts/llm-tuning-test.mjs`。
 *
 * 由来：PTC 真机实拍连挂五次「连接超时（30 秒无响应）」。30 秒是内置的建连 + 响应头时限，
 * 而 ptc 模式的系统提示比标准模式长得多，上游网关要等模型起完才吐响应头。当时唯一的旋钮
 * 是环境变量，用户手上没有可改的东西——端点是用户自己配的、prompt 多大也是他选的活，
 * 时限就该写进他自己那份配置里。
 *
 * 钉五件事：
 *   ① 没写 `llm:` 段 → 空对象，两条时限与重试次数回落到内置默认；
 *   ② 写了 → 读得出来；
 *   ③ 写得离谱 → 夹进区间，不照抄（0 / 负数当没写）；
 *   ④ 改了文件 → mtime 变了就重新读（缓存不许把新值吃掉）；
 *   ⑤ 环境变量仍排在配置文件前面（自检要能临时盖一次而不动用户配置）；
 * 外加第 [8] 节：配置值真的掐在了线上（不借任何一个环境变量）。
 *
 * ## 隔离
 *
 * `DSC_HOME` 必须在**任何内核/配置模块被加载之前**指到临时目录：`core/path-policy.ts`
 * 的 `DSC_CONFIG_YAML` 是模块级常量。所以这里在模块顶层换环境，配置与 llm 两个模块一律
 * `await import()`。
 *
 * @module dsc/core/llm-tuning.spec
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { installFakeFetch, type FakeFetchHandle } from '../../tests/support/fake-fetch.js'

/** 临时主目录；写在模块顶层，保证先于下面的动态 import。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-llm-tuning-'))
const dscHome = join(home, '.dsc')
mkdirSync(dscHome, { recursive: true })
process.env.DSC_HOME = dscHome
const configPath = join(dscHome, 'config.yaml')

/** 本文件会改的环境变量：一律在 afterEach 还原。 */
const ENV_NAMES = ['DSC_LLM_CONNECT_TIMEOUT_MS', 'DSC_LLM_STREAM_IDLE_MS', 'DSC_LLM_RETRY_ATTEMPTS'] as const
const ORIGINAL_ENV = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))

let config: typeof import('./config.js')
let llm: typeof import('./llm.js')
let http: FakeFetchHandle | undefined
/** mtime 的假时钟：同秒内两次写不能因为 mtime 没变而命中旧缓存。 */
let stamp = 1_700_000_000

/** 写一份 config.yaml，并把 mtime 顶到下一格。 */
function writeConfig(body: string): void {
  writeFileSync(configPath, body, 'utf8')
  stamp += 1
  utimesSync(configPath, stamp, stamp)
}

/** 一份只有供应商、没有 `llm:` 段的配置：探针里反复用的底座。 */
const BASE = 'default:\n  provider: fake\n  model: fake-chat\nproviders:\n  fake:\n    baseURL: http://127.0.0.1:1/v1\n    models:\n      - id: fake-chat\n'

beforeAll(async () => {
  config = await import('./config.js')
  llm = await import('./llm.js')
})

afterEach(() => {
  http?.restore()
  http = undefined
  for (const name of ENV_NAMES) {
    const original = ORIGINAL_ENV.get(name)
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('① 没有 llm 段：一律回落内置默认', () => {
  test('读数是空对象，两条时限与重试次数都是内置值', () => {
    writeConfig(BASE)
    expect(config.readLlmTuning()).toEqual({})
    expect(llm.resolveTimeouts()).toEqual({ connectMs: 30_000, idleMs: 180_000 })
    expect(llm.readRetryAttempts()).toBe(6)
  })
})

describe('② 写了 llm 段：三个数都读得出来，且真的用上', () => {
  test('读数与 resolveTimeouts / readRetryAttempts 一致', () => {
    writeConfig(
      'llm:\n  connectTimeoutMs: 120000\n  streamIdleMs: 300000\n  retryAttempts: 8\n' + BASE,
    )
    const tuning = config.readLlmTuning()
    expect(tuning.connectTimeoutMs).toBe(120_000)
    expect(tuning.streamIdleMs).toBe(300_000)
    expect(tuning.retryAttempts).toBe(8)
    expect(llm.resolveTimeouts()).toEqual({ connectMs: 120_000, idleMs: 300_000 })
    expect(llm.readRetryAttempts()).toBe(8)
  })
})

describe('③ 写得离谱：夹进区间，不照抄', () => {
  test('建连封顶 10 分钟、流空闲抬到 5 秒、重试封顶 20', () => {
    writeConfig('llm:\n  connectTimeoutMs: 99999999\n  streamIdleMs: 1\n  retryAttempts: 999\nproviders: {}\n')
    const tuning = config.readLlmTuning()
    expect(tuning.connectTimeoutMs).toBe(600_000)
    expect(tuning.streamIdleMs).toBe(5_000)
    expect(tuning.retryAttempts).toBe(20)
  })
})

describe('④ 0 / 负数 / 非数字：当没写，回落默认', () => {
  test('三个数都被丢掉，时限回到 30 秒', () => {
    writeConfig('llm:\n  connectTimeoutMs: 0\n  streamIdleMs: -1\n  retryAttempts: abc\nproviders: {}\n')
    expect(config.readLlmTuning()).toEqual({})
    expect(llm.resolveTimeouts().connectMs).toBe(30_000)
  })
})

describe('⑤ 改完文件立刻生效（缓存按 mtime 失效）', () => {
  test('同一个进程里先读到 45 秒，改完读到 90 秒', () => {
    writeConfig('llm:\n  connectTimeoutMs: 45000\nproviders: {}\n')
    expect(llm.resolveTimeouts().connectMs).toBe(45_000)
    writeConfig('llm:\n  connectTimeoutMs: 90000\nproviders: {}\n')
    expect(llm.resolveTimeouts().connectMs).toBe(90_000)
  })
})

describe('⑥ 环境变量排在配置文件前面', () => {
  test('环境变量先赢，删掉之后回到配置值', () => {
    writeConfig('llm:\n  connectTimeoutMs: 90000\n  retryAttempts: 8\nproviders: {}\n')
    process.env['DSC_LLM_CONNECT_TIMEOUT_MS'] = '8000'
    process.env['DSC_LLM_RETRY_ATTEMPTS'] = '2'
    expect(llm.resolveTimeouts().connectMs).toBe(8_000)
    expect(llm.readRetryAttempts()).toBe(2)
    delete process.env['DSC_LLM_CONNECT_TIMEOUT_MS']
    delete process.env['DSC_LLM_RETRY_ATTEMPTS']
    expect(llm.resolveTimeouts().connectMs).toBe(90_000)
  })
})

describe('⑦ 配置文件写坏了：不抛，按默认走', () => {
  test('读坏了给空对象，两条时限仍是内置默认', () => {
    writeConfig(': : : 不是 yaml\n\t- [\n')
    expect(config.readLlmTuning()).toEqual({})
    expect(llm.resolveTimeouts()).toEqual({ connectMs: 30_000, idleMs: 180_000 })
  })
})

describe('⑧ 真 wire：配置值真的掐在了线上（没有一个环境变量）', () => {
  test('按配置的 1.2 秒掐断，报的秒数就是配置值', async () => {
    writeConfig('llm:\n  connectTimeoutMs: 1200\n  retryAttempts: 1\nproviders: {}\n')
    // 「永不回应」的端点：只在被 abort 时把 abort 的 reason 抛回去（与 undici 同形）。
    http = installFakeFetch({
      intercept: (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener(
            'abort',
            () => {
              reject(call.init.signal?.reason)
            },
            { once: true },
          )
        }),
    })

    const started = Date.now()
    let error: unknown
    try {
      await llm.streamChat(
        { apiKey: 'k', model: 'm', baseUrl: 'https://example.invalid/v1', messages: [{ role: 'user', content: 'hi' }] },
        { onDelta() {} },
      )
    } catch (caught) {
      error = caught
    }
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(6_000)
    expect(error).toBeInstanceOf(llm.LlmError)
    expect(String((error as Error).message)).toContain('连接超时（1 秒无响应）')
  })
})
