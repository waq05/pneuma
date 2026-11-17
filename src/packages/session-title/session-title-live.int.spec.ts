/**
 * 「任务进行中动态刷新会话标题」示例插件的回合时序（整条迁自
 * `scripts/session-title-live-test.mjs`，缺口清单 B2）。
 *
 * ## 来源与分层
 *
 * 原探针用桩 ctx 跑 `examples/plugins/session-title-live.js` 的真实代码：临时 DSC_HOME
 * （插件读写的 meta.json 落在临时目录）+ 假 LLM，验证「什么时候该请求、什么时候不许动、
 * 收摊之后还跑不跑」这三件事。被测对象是插件 + `core/session-meta` 的落盘语义，要真起
 * 插件 apply/dispose 生命周期与定时器——这是 integration 层（node + 真模块 + 真文件），
 * 不是 ui 渲染层，也不是纯函数层。整条迁过来、探针可整删。
 *
 * ## 为什么可以不用「慢响应 fakeLLM」
 *
 * 探针自己就带桩：`ctx.llm.stream` 是即时返回的假实现，插件按 `intervalMs` 巡检会话
 * `messages` 的增长。所以这里不需要 harness 的 fakeLLM 慢响应接缝——被测的「回合进行中」
 * 由 `dsc/turn-start` 事件 + 定时巡检表达，不是靠 LLM 请求挂起。
 *
 * ## 隔离
 *
 * integration 的 `tests/setup/temp-home.ts` 已经把 HOME/USERPROFILE 换成临时目录；这里
 * 再显式把 `DSC_HOME` 指到它下面，并**在动态 import 之前**设好——`path-policy` 的
 * `DSC_HOME` 是模块顶层常量，晚一步就落到真实 `~/.dsc`。
 *
 * @module dsc/packages/session-title/session-title-live.int.spec
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/** 临时 dsc 主目录：必须在任何 `@pneuma/runtime/core/**` 动态 import 之前设好。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-title-live-'))
process.env.DSC_HOME = home

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询到条件成立（最多等 timeout）；超时返回 false，让断言报出真实状态。 */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await sleep(10)
  }
  return condition()
}

describe('session-title-live：回合中按进展刷新标题', () => {
  test('只有用户消息不请求；有进展请求一次并写 autoTitle；不重复；用户改名即收摊；回合结束/停用后不再请求', async () => {
    // 动态 import 全放在设好 DSC_HOME 之后（模块顶层常量只求值一次）。
    const meta = await import('@pneuma/runtime/core/session-meta.js')
    // 示例插件是纯 JS（没有 .d.ts），tsc 解析不到相对模块；运行期由 Vite 正常转换。
    // @ts-expect-error 纯 JS 示例插件无类型声明
    const mod = (await import('../../../../examples/plugins/session-title-live.js')) as {
      apply: (ctx: unknown, config: { intervalMs: number; maxUpdates: number }) => () => void
      cleanTitle: (raw: string) => string | undefined
    }

    // ── 桩：一个会话、一个假 LLM、一张事件表 ─────────────────────────────────
    const session = {
      meta: { id: 's1' },
      messages: [{ role: 'user', content: '帮我把登录页的样式修一下' }],
    }
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const streamCalls: unknown[] = []
    let refreshCount = 0
    const routes: string[] = []

    const ctx = {
      get: (name: string) => (name === 'agent' ? { sessionFor: () => session } : undefined),
      on: (name: string, fn: (...args: unknown[]) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn])
        return () => {
          listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== fn))
        }
      },
      emit: () => {},
      session: {
        current: () => session,
        refresh: async () => {
          refreshCount += 1
        },
      },
      llm: {
        routeForSession: (target: { meta: { id: string } }) => {
          routes.push(target.meta.id)
          return { api: 'fake', baseUrl: 'http://fake', apiKey: 'sk-not-real', model: 'fake-model' }
        },
        stream: async (_api: string, request: unknown) => {
          streamCalls.push(request)
          return { text: '「修登录页样式」' }
        },
      },
    }

    const emit = (name: string, ...args: unknown[]): void => {
      for (const fn of listeners.get(name) ?? []) fn(...args)
    }
    const readMeta = (): Record<string, { autoTitle?: string; title?: string }> =>
      JSON.parse(readFileSync(join(home, 'sessions', 'meta.json'), 'utf8')).sessions

    const dispose = mod.apply(ctx, { intervalMs: 20, maxUpdates: 3 })
    emit('dsc/turn-start', { sessionId: 's1', sessionPath: 'p1' })

    // 1) 只有用户一句话：不起名（否则就是把第一句话抄一遍）
    await sleep(120)
    expect(streamCalls).toHaveLength(0)

    // 2) 助手产出内容：请求一次，标题清洗后写 autoTitle
    session.messages.push({ role: 'assistant', content: '先看样式文件，再改按钮颜色' })
    expect(await waitFor(() => streamCalls.length === 1)).toBe(true)
    expect(mod.cleanTitle('「修登录页样式」')).toBe('修登录页样式')
    expect(readMeta().s1?.autoTitle).toBe('修登录页样式')
    expect(routes).toEqual(['s1'])
    expect(refreshCount).toBeGreaterThanOrEqual(1)

    // 3) 同一份消息不重复请求
    await sleep(120)
    expect(streamCalls).toHaveLength(1)

    // 4) 用户改名：立刻收摊，之后不再请求
    meta.patchSessionMeta('s1', { title: '我自己的名字' })
    session.messages.push({ role: 'assistant', content: '按钮颜色改好了' })
    await sleep(140)
    expect(streamCalls).toHaveLength(1)
    expect(readMeta().s1?.title).toBe('我自己的名字')

    // 5) 回合结束：收摊
    session.meta = { id: 's2' }
    session.messages = [{ role: 'user', content: '第二个会话' }]
    emit('dsc/turn-start', { sessionId: 's2', sessionPath: 'p2' })
    session.messages.push({ role: 'assistant', content: '处理中' })
    expect(await waitFor(() => streamCalls.length === 2)).toBe(true)
    const before = streamCalls.length
    emit('dsc/turn-end', 'completed', { sessionId: 's2', sessionPath: 'p2' })
    session.messages.push({ role: 'assistant', content: '又有进展' })
    await sleep(120)
    expect(streamCalls).toHaveLength(before)

    // 6) 停用：disposer 之后事件不再触发，定时器清掉
    dispose()
    const afterDispose = streamCalls.length
    emit('dsc/turn-start', { sessionId: 's1', sessionPath: 'p1' })
    await sleep(120)
    expect(streamCalls).toHaveLength(afterDispose)
    expect(listeners.get('dsc/turn-start') ?? []).toHaveLength(0)
  })
})
