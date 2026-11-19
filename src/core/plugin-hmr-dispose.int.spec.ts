/**
 * 内置插件行的热停用/热启用：停一行，它注册的工具与设置分区必须跟着走（迁自 `scripts/hmr-dispose-test.mjs`）。
 *
 * ## 被测的是什么
 *
 * 插件销毁时 cordis 只回收「挂在 fiber 上的 effect」，服务自己的 Map 不会自动清——注册点
 * 不包 `ctx.effect` 就会留下幽灵工具/幽灵分区（设置页 `sections()` 甚至因为读到已卸载
 * 插件的 ctx 而整表抛错）。按「停用 → 断言 → 启用 → 断言」的次序把两个方向都跑一遍。
 *
 * ## 与 `plugin-loader.int.spec.ts` 的热启停两段不重复
 *
 * 那边验的是**夹具包**：行状态、登记表、apply/dispose 记号。这边起的是**真内核 + 内置行**，
 * 断言的是下游两个服务的事实——`tools.visible()` 里没有幽灵工具、`settings.sections()`
 * 卸载后不抛错。幽灵注册物的 motivating bug 只有内置插件的注册写法才验得到。
 *
 * ## 平面与隔离
 *
 * - 探针直接 import `lib/` 并全程屏蔽 stdout；spec 走 harness 的 `bootKernel`
 *   （D25 的混合平面：内核与 loader 从 src 解析，插件挂载走 `lib/node_modules`），
 *   默认 surface 在 vitest fork 里本来就安静，不需要屏蔽。
 * - 删 `DSC_PROFILE`：开发机环境若带 profile，内核会改读开发机的组合包；这里只认
 *   「第一次启动」的样子。
 * - harness 默认关 memory / sandbox / session-title（D16），这三行不在断言集里，
 *   不影响「内置行热启停」这层事实。
 * - **surface 必须传 'headless'**：bootKernel 默认 surface 是 'none'，
 *   `plugin-loader.ts` 的 `SURFACE_ROW_SKIPS.none` 会把 remote 行整个跳过——基线与
 *   g 段直接失去意义。这八成就是这条探针第一轮迁移（R1）没做成的原因。
 *
 * @module dsc/core/plugin-hmr-dispose.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/**
 * 临时主目录；必须在任何内核模块被加载之前换好。
 *
 * `core/path-policy.ts` 的 `DSC_HOME` 是模块顶层常量，先被静态 import 就按老 HOME 算死。
 * 内核侧模块一律走 `bootKernel` 内部的动态 import，静态 import 只留 harness 与类型。
 */
const home = tempHome('dsc-hmr-dispose-')

// 探针同款：环境里带的 profile 会把「第一次启动」的插件面改掉，断言基线就没意义了。
delete process.env['DSC_PROFILE']

/** 内核里这一层用到的服务面：只声明用到的，不把整个 Context 类型拖进来。 */
interface HmrSurface {
  tools: { visible(): Array<{ name: string }> }
  settings: { sections(): Array<{ id: string }> }
}

let llm: FakeLLM
let kernel: BootedKernel
let surface: HmrSurface
/** beforeAll 的异常放进用例里报，别让 hook 一行栈看不懂。 */
let bootError: unknown

/** 热挂载是异步的：轮询等到条件成立再断言（探针同款 25ms 一拍）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
  }
  return predicate()
}

/** 当前注册表里模型能看到的工具名。 */
function toolNames(): string[] {
  return surface.tools.visible().map((entry) => entry.name)
}

/** 设置分区 id 列表；sections() 抛错时返回 null 并把原因记进断言。 */
function sectionIds(): string[] | null {
  try {
    return surface.settings.sections().map((section) => section.id)
  } catch {
    return null
  }
}

beforeAll(async () => {
  try {
    llm = await fakeLLM({ turns: ['收到'] })
    // surface 必须显式给 'headless'：默认的 'none' 会把 remote 行整个跳过
    // （plugin-loader 的 SURFACE_ROW_SKIPS.none），探针传的也是这个值。
    kernel = await bootKernel({ providerBaseUrl: llm.baseUrl, resumeSessionPath: null, surface: 'headless' })
    surface = kernel.ctx as HmrSurface
  } catch (error) {
    bootError = error
  }
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

describe('内置行热停用/热启用（真内核）', () => {
  test('内核正常起来', () => {
    expect(bootError).toBeUndefined()
  })

  test('基线：todo_write / goal / exit_plan_mode / ask_user 都在场', () => {
    const names = toolNames()
    for (const name of ['todo_write', 'goal', 'exit_plan_mode', 'ask_user']) {
      expect(names, `基线缺工具 ${name}`).toContain(name)
    }
  })

  test('基线：sections() 可读，todo 与 remote 分区在场', () => {
    const ids = sectionIds()
    expect(ids, 'sections() 一开始就抛错').not.toBeNull()
    expect(ids).toContain('todo')
    expect(ids).toContain('remote')
  })

  test('a+e：停用 todo → 工具消失，sections() 不抛、不含 todo', async () => {
    const off = await import('@pneuma/runtime/core/plugin-loader.js').then((m) => m.setPluginEnabledHot('todo', false))
    expect(off).toEqual({ ok: true })
    expect(toolNames()).not.toContain('todo_write')
    const ids = sectionIds()
    expect(ids, '停用 todo 后 sections() 抛错（幽灵 ctx）').not.toBeNull()
    expect(ids).not.toContain('todo')
  })

  test('f：重新启用 todo → 工具与分区都回来', async () => {
    const on = await import('@pneuma/runtime/core/plugin-loader.js').then((m) => m.setPluginEnabledHot('todo', true))
    expect(on.ok).toBe(true)
    expect(await waitFor(() => toolNames().includes('todo_write')), 'todo_write 没回来').toBe(true)
    expect(
      await waitFor(() => {
        const ids = sectionIds()
        return ids !== null && ids.includes('todo')
      }),
      'todo 分区没回来',
    ).toBe(true)
  })

  test('b：停用 goal → 工具消失；启用 → 回来', async () => {
    const loader = await import('@pneuma/runtime/core/plugin-loader.js')
    const off = await loader.setPluginEnabledHot('goal', false)
    expect(off).toEqual({ ok: true })
    expect(toolNames()).not.toContain('goal')
    expect(sectionIds(), '停用 goal 后 sections() 抛错').not.toBeNull()
    const on = await loader.setPluginEnabledHot('goal', true)
    expect(on.ok).toBe(true)
    expect(await waitFor(() => toolNames().includes('goal')), 'goal 没回来').toBe(true)
  })

  test('c：停用 plan → exit_plan_mode 消失；启用 → 回来', async () => {
    const loader = await import('@pneuma/runtime/core/plugin-loader.js')
    const off = await loader.setPluginEnabledHot('plan', false)
    expect(off).toEqual({ ok: true })
    expect(toolNames()).not.toContain('exit_plan_mode')
    expect(sectionIds(), '停用 plan 后 sections() 抛错').not.toBeNull()
    const on = await loader.setPluginEnabledHot('plan', true)
    expect(on.ok).toBe(true)
    expect(await waitFor(() => toolNames().includes('exit_plan_mode')), 'exit_plan_mode 没回来').toBe(true)
  })

  test('d：停用 ask → ask_user 消失；启用 → 回来', async () => {
    const loader = await import('@pneuma/runtime/core/plugin-loader.js')
    const off = await loader.setPluginEnabledHot('ask', false)
    expect(off).toEqual({ ok: true })
    expect(toolNames()).not.toContain('ask_user')
    expect(sectionIds(), '停用 ask 后 sections() 抛错').not.toBeNull()
    const on = await loader.setPluginEnabledHot('ask', true)
    expect(on.ok).toBe(true)
    expect(await waitFor(() => toolNames().includes('ask_user')), 'ask_user 没回来').toBe(true)
  })

  test('g：停用 remote → 分区消失且 sections() 不抛；启用 → 分区回来', async () => {
    const loader = await import('@pneuma/runtime/core/plugin-loader.js')
    const off = await loader.setPluginEnabledHot('remote', false)
    expect(off).toEqual({ ok: true })
    let ids = sectionIds()
    expect(ids, '停用 remote 后 sections() 抛错').not.toBeNull()
    expect(ids).not.toContain('remote')
    const on = await loader.setPluginEnabledHot('remote', true)
    expect(on.ok).toBe(true)
    expect(
      await waitFor(() => {
        const current = sectionIds()
        return current !== null && current.includes('remote')
      }),
      'remote 分区没回来',
    ).toBe(true)
  })
})
