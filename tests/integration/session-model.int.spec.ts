/**
 * 模型 / 思考档位 / 协作模式「按会话」的内核集成用例（迁自
 * `scripts/session-model-kernel-test.mjs`）。
 *
 * 这一组故意跑**整套内核装配**而不是单个插件：2026-10-28 的报障是「在 A 会话换模型，
 * B 会话跟着变」。纯函数探针证明不了「插件读的是自己会话」——它只能证明算术对。这里用
 * 两个真会话文件、真落盘、真切换，钉住三件事：
 *
 *   1. 新会话拿配置默认值（m1 / default / 100k）；
 *   2. A 换模型之后，B 的模型、档位、上下文窗口都不受影响，切回 A 仍是 A 的那份；
 *   3. 协作模式与用量记账同样按会话读，不读进程级变量。
 *
 * ## 为什么每个用例都重新起一次内核
 *
 * 这组用例天然是「先改 A、再看 B」的顺序剧；共用一只内核时，前一条的残留状态会让后一条
 * 红得莫名其妙（尤其是 `lastSelected` 这类模块级记忆）。一只内核 ~1.5s，五条用例 8s 左右，
 * 换来的是每条都能单独重跑。
 *
 * ## 隔离
 *
 * `tempHome()` + `fakeLLM()` + `bootKernel()`：临时主目录在此之前换好，内核模块随后加载。
 *
 * @module dsc/tests/integration/session-model.int.spec
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../harness.js'

/** 内核里本文件用到的服务面。 */
interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  appendUser(text: string): void
}

interface Services {
  session: { current(): SessionView; open(filePath?: string, cwd?: string): Promise<void> }
  llm: {
    readonly model: string
    readonly effort: string
    readonly contextWindow: number
    modelOf(session: SessionView): string
    setModel(provider: string, model: string): void
    setEffort(effort: string): void
  }
  mode: { readonly mode: string; modeFor(sessionId?: string): string; setMode(next: string): void }
}

/** 两个模型的形状照抄原探针：m1 没有思考档位，m2 有 low/high。 */
function model(id: string, contextWindow: number, thinkingLevels: string[]): Record<string, unknown> {
  return {
    id,
    name: id,
    contextWindow,
    maxTokens: 500,
    modalities: ['text'],
    thinkingLevels,
    thinkingParam: 'thinking',
    effortMap: {},
  }
}

let home: ReturnType<typeof tempHome>
let kernel: BootedKernel
let fake: FakeLLM
let services: Services
/** 每条用例自己的两个工作目录：A 用 WORK_A，B 用 WORK_B。 */
let workA: string
let workB: string

beforeEach(async () => {
  home = tempHome()
  workA = join(home.home, 'ws-a')
  workB = join(home.home, 'ws-b')
  mkdirSync(workA, { recursive: true })
  mkdirSync(workB, { recursive: true })
  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({
    providerBaseUrl: fake.baseUrl,
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl: fake.baseUrl,
          apiKey: 'k',
          models: [model('m1', 100_000, []), model('m2', 200_000, ['low', 'high'])],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm1',
    },
  })
  services = kernel.ctx as unknown as Services
})

afterEach(async () => {
  await kernel.dispose()
  await fake.close()
  home.restore()
})

/** 等会话日志里出现某个特征串：状态条目是异步落盘的，切走之前必须等它写出来。 */
async function waitForText(file: string, needle: string): Promise<void> {
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      if (readFileSync(file, 'utf8').includes(needle)) return
    } catch {
      // 文件还没建出来：继续等。
    }
    if (Date.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** 让当前会话真落盘，返回它的路径：会话要有一条对话记录才建文件。 */
async function persistCurrent(services: Services, text: string): Promise<string> {
  const current = services.session.current()
  current.appendUser(text)
  await waitForText(current.filePath, '"type":"user"')
  return current.filePath
}

describe('① 新会话拿配置默认值', () => {
  test('模型是配置默认 m1、档位 default、窗口 100k', () => {
    expect(services.llm.model).toBe('m1')
    expect(services.llm.effort).toBe('default')
    expect(services.llm.contextWindow).toBe(100_000)
  })
})

describe('② 换模型：档位与窗口跟着变', () => {
  test('A 换成 m2 后窗口变 200k', () => {
    services.llm.setModel('test', 'm2')
    expect(services.llm.model).toBe('m2')
    expect(services.llm.contextWindow).toBe(200_000)
  })

  test('A 的档位能切到 high（m2 声明了这个档位）', () => {
    services.llm.setModel('test', 'm2')
    services.llm.setEffort('high')
    expect(services.llm.effort).toBe('high')
  })
})

describe('③ 按会话隔离', () => {
  test('A 改 m2/high 之后，先前建好的 B 仍是 m1/default/100k；切回 A 仍是 m2/high', async () => {
    // 顺序不能反：新建会话会沿用「上一次手动选的那一组」（`lastSelected`，见
    // `src/packages/llm/index.ts:79-92`）。所以 B 必须先出生、先拿到默认值，
    // 再去改 A——否则测的是「新会话沿用手感」，不是「老会话互不影响」。
    const a = services.session.current()
    const aPath = await persistCurrent(services, '让 A 落盘')
    await services.session.open(undefined, workB)
    const bPath = await persistCurrent(services, '让 B 落盘')
    expect(services.llm.model).toBe('m1')

    await services.session.open(aPath)
    services.llm.setModel('test', 'm2')
    services.llm.setEffort('high')
    // 状态条目异步落盘：切走之前等它写出来，否则切回来读到的是旧值。
    await waitForText(aPath, '"effort":"high"')

    await services.session.open(bPath)
    expect(services.llm.model).toBe('m1')
    expect(services.llm.effort).toBe('default')
    expect(services.llm.contextWindow).toBe(100_000)

    await services.session.open(aPath)
    expect(services.llm.model).toBe('m2')
    expect(services.llm.effort).toBe('high')
    expect(services.session.current().meta.id).toBe(a.meta.id)
  })

  test('协作模式按会话隔离：B 切计划模式，切回 A 仍是执行模式', async () => {
    const a = services.session.current()
    const aPath = await persistCurrent(services, '让 A 落盘')
    expect(services.mode.mode).toBe('build')

    await services.session.open(undefined, workB)
    const b = services.session.current()
    // 先让 B 落盘再切模式：还没说过话的会话把所有 state 攒在内存里（`Session.write` 的
    // pendingState），此时等磁盘永远等不到——等的顺序反了，这条用例就变成假绿。
    const bPath = await persistCurrent(services, '让 B 落盘')
    services.mode.setMode('plan')
    expect(services.mode.mode).toBe('plan')
    expect(services.mode.modeFor(b.meta.id)).toBe('plan')
    await waitForText(bPath, '"id":"mode"')

    await services.session.open(aPath)
    expect(services.mode.mode).toBe('build')
    expect(services.mode.modeFor(a.meta.id)).toBe('build')
  })

  test('用量记账取发起会话的模型：A 按 m2、B 按 m1', async () => {
    const aPath = await persistCurrent(services, '让 A 落盘')
    await services.session.open(undefined, workB)
    const bPath = await persistCurrent(services, '让 B 落盘')

    await services.session.open(aPath)
    services.llm.setModel('test', 'm2')
    await waitForText(aPath, '"model":"m2"')
    expect(services.llm.modelOf(services.session.current())).toBe('m2')

    await services.session.open(bPath)
    expect(services.llm.modelOf(services.session.current())).toBe('m1')

    await services.session.open(aPath)
    expect(services.llm.modelOf(services.session.current())).toBe('m2')
  })
})
