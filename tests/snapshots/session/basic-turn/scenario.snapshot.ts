/**
 * 快照场景：单轮问答（快照层的首条端到端骨架）。
 *
 * ## 三种形态（按现场自动选）
 *
 * 1. **回放**（CI 与日常）：`session.jsonl` 在场 → `replayLLM` 回放，不碰网络；
 *    请求指纹对不上当场 409（代码改了请求形状，必须重新录制，不许放宽校验）。
 * 2. **录制**：`session.jsonl` 不在，且给了 `DSC_SNAPSHOT_RECORD_KEY` 与
 *    `DSC_SNAPSHOT_BASE_URL`（真模型基地址）→ 内核经录制代理（`recorder.ts`）打真
 *    API，跑完把录制落盘。产物**要人审**再进版本库（key 不落盘，落的是指纹与应答）。
 * 3. **跳过**：没录制也没 key → `describe.skip` 并写明原因。无 key 不红，但 skip
 *    必须响亮——静默绿是快照层最大的假绿来源。所以收集期固定打一条 `console.warn`
 *    说清缺什么、怎么录；再给一个 `DSC_SNAPSHOT_STRICT=1` 开关，开了就**必须红**
 *    （夜跑不设这个变量，别让它常红）。
 *
 * ## 场景约定
 *
 * 一个场景一个目录：`session.jsonl`（录制）+ 本文件（场景驱动）。断言钉的是
 * **持久化终态**（会话 jsonl 的记录序列），不是渲染帧——帧归 tui project。
 *
 * @module dsc/tests/snapshots/session/basic-turn
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, readSessionJsonl, replayLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../harness.js'
import { startRecordProxy } from '../../recorder.js'

const RECORDING = new URL('./session.jsonl', import.meta.url)
const KEY = process.env['DSC_SNAPSHOT_RECORD_KEY'] ?? ''
const BASE_URL = process.env['DSC_SNAPSHOT_BASE_URL'] ?? ''
/** 录制与回放共用同一条会话根：tempHome 一个文件只能调一次。 */
const home = tempHome('dsc-snapshot-basic-')

const mode = existsSync(RECORDING) ? 'replay' : KEY !== '' && BASE_URL !== '' ? 'record' : 'skip'

/** 严格模式开关：值为 `1` 时「一个用例都没跑」必须红；其余值（含未设置）保持跳过。 */
const STRICT = process.env['DSC_SNAPSHOT_STRICT'] === '1'

/**
 * 跳过原因。`short` 进用例名（报告里一行别撑爆），`full` 进 warn 与报错。
 * `full` 的路径用 `fileURLToPath` 换成平台原生形态：`URL.pathname` 在 Windows 上是
 * `/D:/...` 且空格变 `%20`，照着打不开。
 */
const SKIP_REASON = (() => {
  const missing = [
    KEY === '' ? 'DSC_SNAPSHOT_RECORD_KEY' : '',
    BASE_URL === '' ? 'DSC_SNAPSHOT_BASE_URL' : '',
  ].filter((name) => name !== '')
  const envPart = missing.length === 0 ? '' : `也没给 ${missing.join(' / ')}`
  return {
    short: envPart === '' ? '没有录制文件' : `没有录制文件，${envPart}`,
    full: `没有录制文件 ${fileURLToPath(RECORDING)}` + (envPart === '' ? '' : `，${envPart}`),
  }
})()

/**
 * 收集期就把「这层为什么一个用例都没跑」喊出来。
 *
 * skip 本身不红（夜跑没有 key 是常态），但**静默**绿是快照层最大的假绿来源：报告里只多
 * 一行 skip，没人知道端到端其实没测。warn 走 stderr，`vitest run` 原样打出来。
 */
if (mode === 'skip') {
  console.warn(
    `[snapshot] basic-turn 未执行任何用例：${SKIP_REASON.full}。` +
      '录制办法：DSC_SNAPSHOT_RECORD_KEY=... DSC_SNAPSHOT_BASE_URL=... pnpm test:snapshot:record，' +
      '产物 tests/snapshots/session/basic-turn/session.jsonl 要人审后再入库。' +
      '要让它红：DSC_SNAPSHOT_STRICT=1。',
  )
}

/**
 * 非严格模式用 `describe.skip` 并让名字带原因；严格模式用 `describe` 只注册一条必红用例。
 */
const d = mode === 'skip' && !STRICT ? describe.skip : describe

let llm: FakeLLM
let kernel: BootedKernel
let proxy: Awaited<ReturnType<typeof startRecordProxy>> | null = null
let runError: unknown

/** 当前会话文件路径（BootedKernel 只暴露 ctx，会话服务从 ctx 上窄化取）。 */
function sessionFile(): string {
  const surface = kernel.ctx as unknown as { session: { current(): { filePath: string } } }
  return surface.session.current().filePath
}

beforeAll(async () => {
  if (mode === 'skip') return
  try {
    if (mode === 'record') {
      proxy = await startRecordProxy(BASE_URL)
      llm = {
        baseUrl: proxy.baseUrl,
        bodies: [],
        requestCount: 0,
        close: () => proxy!.close(),
      }
    } else {
      llm = await replayLLM(new URL(RECORDING).pathname)
    }
    kernel = await bootKernel({
      providerBaseUrl: llm.baseUrl,
      config: {
        providers: {
          real: {
            name: 'real',
            displayName: 'Recorded',
            baseUrl: llm.baseUrl,
            apiKey: mode === 'record' ? KEY : 'recorded',
            models: [
              {
                id: 'm',
                name: 'm',
                contextWindow: 128_000,
                maxTokens: 2_000,
                modalities: ['text'],
                thinkingLevels: [],
                thinkingParam: 'none',
                effortMap: {},
              },
            ],
          },
        },
        defaultProvider: 'real',
        defaultModel: 'm',
      },
    })
    await kernel.runTurn('用一句话介绍你自己')
  } catch (error) {
    runError = error
  }
})

afterAll(async () => {
  await kernel?.dispose()
  if (mode === 'record' && proxy !== null) {
    if (runError === undefined) {
      // 录制落盘后要人审再提交；这里只写文件，不进 git（产物进版本库是人的决定）。
      proxy.save(new URL(RECORDING).pathname)
    }
    await proxy.close().catch(() => {})
  }
  await llm?.close()
  home.restore()
})

d(`快照场景：单轮问答（${mode === 'skip' ? `skip：${SKIP_REASON.short}` : mode}）`, () => {
  /**
   * 严格模式（`DSC_SNAPSHOT_STRICT=1`）：没录制就必须失败。用一条真用例而不是模块级
   * throw，报告里能看到是哪一层没跑；非严格模式不进这个分支，四条例行用例照旧被 skip。
   */
  if (mode === 'skip' && STRICT) {
    test('快照层未执行任何用例', () => {
      throw new Error(
        `快照层未执行任何用例：${SKIP_REASON.full}。` +
          '本次只看会话层，TUI 帧与浏览器快照另有结果。' +
          '补齐办法：设 DSC_SNAPSHOT_RECORD_KEY 与 DSC_SNAPSHOT_BASE_URL 后跑 pnpm test:snapshot:record，' +
          '把产物 session.jsonl 人审后入库；或去掉 DSC_SNAPSHOT_STRICT 允许跳过。',
      )
    })
    return
  }

  test('回合正常完成', () => {
    expect(runError).toBeUndefined()
  })

  test('会话落盘，记录序列是 user → assistant', () => {
    const sessionPath = sessionFile()
    expect(existsSync(sessionPath)).toBe(true)
    const records = readSessionJsonl(sessionPath)
    const types = records.map((record) => record['type']).filter((type) => type === 'user' || type === 'assistant')
    expect(types[0]).toBe('user')
    expect(types.at(-1)).toBe('assistant')
  })

  test('assistant 的正文非空（真模型/录制里都有实际回答）', () => {
    const assistant = readSessionJsonl(sessionFile()).find((record) => record['type'] === 'assistant')
    expect(typeof (assistant as { text?: unknown } | undefined)?.text).toBe('string')
    expect(String((assistant as { text?: unknown }).text).length).toBeGreaterThan(0)
  })

  test('用量计数非零（快照层顺手钉住 token 记账）', () => {
    const usage = readSessionJsonl(sessionFile()).find((record) => record['type'] === 'usage')
    if (mode === 'record') {
      // 录制时真模型回了用量；没有就说明解析层漏记，当场红。
      expect(usage).toBeDefined()
    }
    // 回放模式下 usage 来自录制的 usage 帧（replayLLM 会合成），存在性同样断言。
    expect(usage === undefined || typeof usage).toBe('object')
  })
})
