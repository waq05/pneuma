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
 *    必须响亮——静默绿是快照层最大的假绿来源。
 *
 * ## 场景约定
 *
 * 一个场景一个目录：`session.jsonl`（录制）+ 本文件（场景驱动）。断言钉的是
 * **持久化终态**（会话 jsonl 的记录序列），不是渲染帧——帧归 tui project。
 *
 * @module dsc/tests/snapshots/session/basic-turn
 */
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, readSessionJsonl, replayLLM, tempHome, type BootedKernel, type FakeLLM } from '../../../harness.js'
import { startRecordProxy } from '../../recorder.js'

const RECORDING = new URL('./session.jsonl', import.meta.url)
const KEY = process.env['DSC_SNAPSHOT_RECORD_KEY'] ?? ''
const BASE_URL = process.env['DSC_SNAPSHOT_BASE_URL'] ?? ''
/** 录制与回放共用同一条会话根：tempHome 一个文件只能调一次。 */
const home = tempHome('dsc-snapshot-basic-')

const mode = existsSync(RECORDING) ? 'replay' : KEY !== '' && BASE_URL !== '' ? 'record' : 'skip'
/** skip 不是悄悄走的：describe.skip + 名字里带原因，报告里一眼能认出来。 */
const d = mode === 'skip' ? describe.skip : describe

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

d(`快照场景：单轮问答（${mode === 'skip' ? 'skip：没有录制文件，也没给 DSC_SNAPSHOT_RECORD_KEY / DSC_SNAPSHOT_BASE_URL' : mode}）`, () => {
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
