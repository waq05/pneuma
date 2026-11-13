/**
 * 侧栏浏览器工具面（迁自 `scripts/dock-browser-test.mjs` 第 6 节与第 9 节③）。
 *
 * 钉住工具面这一层的四件事：
 *
 *   ① **注册与档位**：`browser_dock` 恒 `exec`（每次过审批）；`browser_dock_look` 恒 `read`，
 *      但默认声明 `waitsForHuman`（工具里自己弹一次卡，PTC 才不给它算脚本时间）。
 *   ② **枚举单一真源**：两个工具的动作枚举必须逐项等于契约常量，不许本地再抄一份。
 *   ③ **地址闸门**：`navigate`/`open` 拒云元数据地址与 `file://`——两条都在，进审批之前就挡掉。
 *   ④ **没有桌面壳**：两个工具都回同一句人话（不抛栈、也不静默不做事）。
 *
 * 另加一节回归：`open` 要等页面**真的落到目标地址**（不等的话紧接着的 snapshot 会读到空树）。
 *
 * ## 为什么这里必须换临时 HOME
 *
 * `apply()` 里的 `readConfig()` 走 `resolvePluginConfig`，它读的 `plugins.json` 路径来自
 * `path-policy` 的模块顶层常量 `DSC_HOME`。静态 import 会把它定死成真实主目录——本机
 * `~/.dsc/plugins.json` 就写着 `dock-browser.lookWithoutApproval`，于是「免审批关着」那一组
 * 会跟着环境飘。所以 `tempHome()` 要在 `index.js` 被加载之前跑，那个模块只能动态 import。
 *
 * ## 本文件不做什么
 *
 * 原探针第 7、9②、9④ 节扫的是 `ui.tsx` / `dock-state.ts` 的源码文本（事件名、锚点唯一性、
 * settle 帧数）。那验的是写法不是行为，按本批规矩不搬；缺口已写进交付报告。
 *
 * @module @pneuma/dock-browser/tests/dock-browser-toolface.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../../tests/harness.js'
import { DOCK_ACTIONS, DOCK_LOOK_ACTIONS } from '../../../core/dock-browser.js'
import { HOST_BROWSER_SERVICE } from '../../../core/host-browser-link.js'

/** 临时主目录（`tempHome` 一个文件只能调一次）。 */
const home = tempHome('dsc-dock-tool-')
/** 插件入口（动态 import：见文件头的理由）。 */
let idx: typeof import('../index.js')

beforeAll(async () => {
  idx = await import('../index.js')
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME.startsWith(home.home)).toBe(true)
})

afterAll(() => {
  home.restore()
})

/** JSON Schema 里测试要用到的字段。 */
interface Schema {
  type?: string
  enum?: string[]
  properties?: Record<string, Schema>
  required?: string[]
}

/** 捕获到的工具条目。 */
interface Tool {
  name: string
  description: string
  risk: string
  waitsForHuman?: boolean
  parameters: Schema
  run(args: Record<string, unknown>, ctx: unknown): Promise<unknown>
}

/** 捕获到的设置分区。 */
interface Section {
  id: string
  fields(): Array<{ type?: string; key?: string }>
}

/** 起一次插件（`link` 就是 `ctx.get(HOST_BROWSER_SERVICE)` 会拿到的东西）。 */
function mount(withLook: boolean, link?: unknown): { tools: Tool[]; sections: Section[] } {
  const tools: Tool[] = []
  const sections: Section[] = []
  const ctx = {
    tools: {
      register: (entry: Tool) => {
        tools.push(entry)
        return () => {}
      },
    },
    settings: {
      registerSection: (section: Section) => {
        sections.push(section)
        return () => {}
      },
    },
    get: (name: string) => (name === HOST_BROWSER_SERVICE ? link : undefined),
    on: () => () => {},
    // 2026-11-04：插件的注册改成 ctx.effect 了（停用即注销）。桩 ctx 跟着 cordis。
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  idx.dockBrowserPlugin.apply(ctx as unknown as Context, withLook ? { lookWithoutApproval: true } : {})
  return { tools, sections }
}

/** 按名字取工具（找不到时报出实际注册了哪些）。 */
function toolNamed(tools: Tool[], name: string): Tool {
  const found = tools.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`没有注册 ${name}，只有 ${tools.map((tool) => tool.name).join('、')}`)
  return found
}

/** 没有桌面壳时的桩链路（`available()` 为假）。 */
const unavailableLink = {
  available: () => false,
  views: async () => [],
  open: async () => ({ viewId: 'agent-1', attached: true, url: 'about:blank' }),
  close: async () => {},
  call: async () => ({}),
  onEvent: () => () => {},
  session: (viewId: string) => ({ sessionId: viewId, send: async () => ({}), on: () => () => {} }),
}

/** 一条「可用但什么也不做」的桩链路；需要什么行为就 overrides 覆盖。 */
function stubLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: () => true,
    views: async () => [],
    open: async (url: string, viewId?: string) => ({ viewId: viewId ?? 'agent-7', attached: true, url }),
    close: async () => {},
    call: async () => ({}),
    onEvent: () => () => {},
    session: (viewId: string) => ({ sessionId: viewId, send: async () => ({}), on: () => () => {} }),
    ...overrides,
  }
}

/** 跑一次工具调用并把人话报错抓出来。 */
async function humanError(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}

/** 这次调用的运行身份（没有桌面壳时大多用不到，给一份最小形状）。 */
const runCtx = (): unknown => ({
  cwd: home.home,
  signal: new AbortController().signal,
  sessionId: 'spec-session',
  sessionPath: '',
})

describe('① 注册、风险档与「没有桌面壳」时的报错', () => {
  test('免审批关着时两个工具都注册（动手的 + 只读的）', () => {
    const plain = mount(false, undefined)
    // 只读工具必须恒注册：不注册它模型就拿不到 ref，click / hover / type 全成无源之水。
    expect(plain.tools.map((tool) => tool.name).sort()).toStrictEqual(['browser_dock', 'browser_dock_look'])
  })

  test('browser_dock 的风险等级是 exec（每次过审批）', () => {
    expect(toolNamed(mount(false, undefined).tools, 'browser_dock').risk).toBe('exec')
  })

  test('免审批关着时 browser_dock_look 是 read 档、但声明了会等人（默认每次过审批）', () => {
    const look = toolNamed(mount(false, undefined).tools, 'browser_dock_look')
    expect(look.risk).toBe('read')
    expect(look.waitsForHuman).toBe(true)
  })

  test('browser_dock 的 action 枚举逐项等于契约 DOCK_ACTIONS', () => {
    const act = toolNamed(mount(false, undefined).tools, 'browser_dock')
    expect(act.parameters.properties?.['action']?.enum).toStrictEqual([...DOCK_ACTIONS])
  })

  test('browser_dock 的 viewId 可选（required 只有 action）', () => {
    const act = toolNamed(mount(false, undefined).tools, 'browser_dock')
    expect(act.parameters.properties?.['viewId']?.type).toBe('string')
    expect(act.parameters.required).toStrictEqual(['action'])
  })

  test('lookWithoutApproval 打开后仍注册两个工具（开关只改档位，不改注册与否）', () => {
    expect(mount(true, undefined).tools.map((tool) => tool.name).sort()).toStrictEqual(['browser_dock', 'browser_dock_look'])
  })

  test('打开免审批后 browser_dock_look 仍是 read 档、但不再等人（直读）', () => {
    const look = toolNamed(mount(true, undefined).tools, 'browser_dock_look')
    expect(look.risk).toBe('read')
    expect(look.waitsForHuman).toBe(false)
  })

  test('browser_dock_look 的 action 枚举逐项等于契约 DOCK_LOOK_ACTIONS', () => {
    const look = toolNamed(mount(true, undefined).tools, 'browser_dock_look')
    expect(look.parameters.properties?.['action']?.enum).toStrictEqual([...DOCK_LOOK_ACTIONS])
  })

  test('设置分区声明了 lookWithoutApproval 开关（用户能自己关掉免审批）', () => {
    const section = mount(true, undefined).sections.find((item) => item.id === 'dock-browser')
    expect(section).toBeDefined()
    expect(section?.fields().some((field) => field.type === 'switch' && field.key === 'lookWithoutApproval')).toBe(true)
  })

  test('没有桌面壳时 browser_dock 回一句人话（不抛栈）', async () => {
    const act = toolNamed(mount(true, unavailableLink).tools, 'browser_dock')
    const message = await humanError(() => act.run({ action: 'open', url: 'https://example.com/' }, runCtx()))
    expect(message).toContain('宿主里没有桌面壳')
    expect(message).not.toContain('\n    at ')
  })

  test('没有桌面壳时 browser_dock_look 回同一句人话（两个工具同一口径）', async () => {
    const look = toolNamed(mount(true, undefined).tools, 'browser_dock_look')
    const message = await humanError(() => look.run({ action: 'views' }, runCtx()))
    expect(message).toContain('宿主里没有桌面壳')
    expect(message).not.toContain('\n    at ')
  })
})

describe('② 地址闸门：云元数据与 file:// 在进审批之前就挡掉', () => {
  /** 桩链路可用时的一对工具（正对照 + 下面三条「拒」）。 */
  function linkedPair(): { act: Tool; look: Tool } {
    const linked = mount(
      true,
      stubLink({
        views: async () => [{ id: 'agent-1', url: 'https://example.com/', title: '示例', loading: false, visible: true }],
      }),
    )
    return { act: toolNamed(linked.tools, 'browser_dock'), look: toolNamed(linked.tools, 'browser_dock_look') }
  }

  test('正对照：桩链路可用时 views 正常返回（拒地址不是「什么都拒」）', async () => {
    const text = await linkedPair().look.run({ action: 'views' }, runCtx())
    expect(String(text)).toContain('agent-1')
  })

  test('navigate 拒云元数据地址 169.254.169.254', async () => {
    const message = await humanError(() =>
      linkedPair().act.run(
        { action: 'navigate', viewId: 'agent-1', url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
        runCtx(),
      ),
    )
    expect(message).toContain('云元数据地址')
  })

  test('navigate 拒 metadata.google.internal（与 AWS 那个 IP 同档）', async () => {
    const message = await humanError(() =>
      linkedPair().act.run(
        { action: 'navigate', viewId: 'agent-1', url: 'http://metadata.google.internal/computeMetadata/v1/' },
        runCtx(),
      ),
    )
    expect(message).toContain('云元数据地址')
  })

  test('navigate 拒 file://（只允许 http/https）', async () => {
    const message = await humanError(() =>
      linkedPair().act.run({ action: 'navigate', viewId: 'agent-1', url: 'file:///C:/Windows/win.ini' }, runCtx()),
    )
    expect(message).toContain('http/https')
  })

  test('open 同样拒 file://（开页签那条路也过同一道闸）', async () => {
    const message = await humanError(() =>
      linkedPair().act.run({ action: 'open', url: 'file:///C:/Windows/win.ini' }, runCtx()),
    )
    expect(message).toContain('http/https')
  })
})

describe('③ open 要等页面真的落到目标地址（回归）', () => {
  /** 目标地址：桩前三次都报 about:blank。 */
  const TARGET = 'https://example.com/landed'
  /** `Runtime.evaluate` 被读了几次（证明是轮询，不是读一次就返回）。 */
  let docReads = 0

  test('open 输出里是落地地址（不是 about:blank），真的在轮询，且有界', async () => {
    const mounted = mount(
      true,
      stubLink({
        // open 返回时页面还没开始加载——正是「紧接着 snapshot 读到空树」的那一刻。
        open: async (url: string, viewId?: string) => ({ viewId: viewId ?? 'agent-7', attached: true, url: 'about:blank' }),
        session: (viewId: string) => ({
          sessionId: viewId,
          on: () => () => {},
          send: async (method: string) => {
            if (method !== 'Runtime.evaluate') return {}
            docReads += 1
            const url = docReads <= 3 ? 'about:blank' : TARGET
            return { result: { value: { url, title: '靶页', readyState: 'complete' } } }
          },
        }),
      }),
    )
    const act = toolNamed(mounted.tools, 'browser_dock')
    const startedAt = Date.now()
    const text = String(await act.run({ action: 'open', url: TARGET }, runCtx()))
    const elapsed = Date.now() - startedAt

    expect(text).toContain(TARGET)
    expect(text).toContain('页面落在')
    expect(text).not.toContain('（页面还没开始加载）')
    expect(docReads).toBeGreaterThan(1)
    // 150ms 一拍的轮询至少两拍；过大说明上限（OPEN_SETTLE_MS）没生效。
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(5_000)
  }, 20_000)
})
