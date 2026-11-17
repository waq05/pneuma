/**
 * 思考档位落到真内核上：换模型夹档、落会话、越界报错（迁自
 * `scripts/effort-per-model-test.mjs` 里那四条「宿主真的这么接了吗」）。
 *
 * 原探针用**源码文本**钉这四件事：
 *   `read('src/packages/llm/index.ts').includes('clampEffort(capsFor(provider, model), …)')`、
 *   `.includes("appendState('model', …)")`、`.includes('if (!hasEffortLevel(caps, effort))')`、
 *   `.includes('这个模型只支持：')`。
 * 这些是写法不是行为（改一行等价实现就红、把逻辑注释掉却可能绿）。这里换成同一批行为的
 * 可观察结果——真内核里换模型之后 `ctx.llm.effort` 是什么、会话状态里存了什么、
 * 越界档位会不会抛错并把可用档位说出来。这是**换成了真判定**，不是删掉。
 *
 * 为什么值得钉：滑杆有档但宿主悄悄夹回默认，用户会看到「界面上是 max、发出去的是默认」。
 *
 * 按 D25：这一层跑的是混合平面，改完 src 必须 `pnpm run build`。
 *
 * @module dsc/tests/integration/effort-per-model.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 内核里本文件用到的服务面。 */
interface ModelState {
  provider: string
  model: string
  effort: string
}

interface LlmSurface {
  readonly provider: string
  readonly model: string
  readonly effort: string
  setEffort(effort: string): void
  setModel(provider: string, model: string): void
}

interface ProbeContext {
  llm: LlmSurface
  session: { current(): { state(id: string): ModelState | undefined } }
}

let llm: FakeLLM
let kernel: BootedKernel
let probe: ProbeContext

/** 端点的模型清单：`wide` 四档、`narrow` 两档（都没有 max）。 */
function model(id: string, levels: string[]): Record<string, unknown> {
  return {
    id,
    name: id,
    contextWindow: 100_000,
    maxTokens: 500,
    modalities: ['text'],
    thinkingLevels: levels,
    thinkingParam: 'reasoning-effort',
    effortMap: {},
  }
}

beforeAll(async () => {
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({
    providerBaseUrl: llm.baseUrl,
    config: {
      providers: {
        wide: { name: 'wide', displayName: 'Wide', baseUrl: llm.baseUrl, apiKey: 'k', models: [model('w', ['off', 'low', 'high', 'max'])] },
        narrow: { name: 'narrow', displayName: 'Narrow', baseUrl: llm.baseUrl, apiKey: 'k', models: [model('n', ['low', 'high'])] },
        plain: { name: 'plain', displayName: 'Plain', baseUrl: llm.baseUrl, apiKey: 'k', models: [model('p', [])] },
      },
      defaultProvider: 'wide',
      defaultModel: 'w',
    },
  })
  probe = kernel.ctx as unknown as ProbeContext
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

describe('① 换模型：旧档位在新模型上不存在就夹回「默认」', () => {
  test('宽模型上选 max：生效并写进会话状态', () => {
    probe.llm.setEffort('max')
    expect(probe.llm.effort).toBe('max')
    // 档位跟着模型一起写进会话（不是只存内存）：重开会话要能读回来。
    expect(probe.session.current().state('model')).toEqual({ provider: 'wide', model: 'w', effort: 'max' })
  })

  test('换到两档模型：max 不在它的清单里，夹回默认', () => {
    probe.llm.setModel('narrow', 'n')
    expect(probe.llm.model).toBe('n')
    expect(probe.llm.effort).toBe('default')
  })

  test('夹回默认这件事也落进会话状态（界面上不会还显示 max）', () => {
    expect(probe.session.current().state('model')).toEqual({ provider: 'narrow', model: 'n', effort: 'default' })
  })
})

describe('② 越界档位：报错并列出可用档位，不静默吞', () => {
  test('两档模型上选 max：抛错', () => {
    expect(() => probe.llm.setEffort('max')).toThrow()
  })

  test('报错文案说清「这个模型只支持：」，并把可用档位列出来', () => {
    let message = ''
    try {
      probe.llm.setEffort('max')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('这个模型只支持：')
    // 档位名走宿主字典（低 / 高），用户据此知道该去勾哪一档。
    expect(message).toContain('低')
    expect(message).toContain('高')
  })

  test('没有思考能力的新模型：文案改成「没声明思考能力，只有默认可选」', () => {
    probe.llm.setModel('plain', 'p')
    // 没有档位可列时必须换个说法，否则会拼出一句「这个模型只支持：」后面什么都没有。
    expect(() => probe.llm.setEffort('low')).toThrow(/没声明思考能力/)
  })
})
