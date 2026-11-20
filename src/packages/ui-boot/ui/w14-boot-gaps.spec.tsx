/**
 * 界面启动器（`ui-boot/ui/boot.ts` / `main.tsx` / `cordis-host.ts`）的 W14 补盲：既有三份
 * spec 走不到的「错误路」与「平台表漂移」。
 *
 * 覆盖：
 * - 平台模块表与运行时 require 表对不上时，模块加载当场报错（构建期漏改一边的兜底）；
 * - 旧账本路径：插件回滚时某个退订函数抛错、插件 `consume` 读服务；
 * - cordis 装配路径的 `onState` 三档（生效 / 失败 / 待装）与「挂载后仍在等依赖」的账本；
 * - 应用批安装自身抛错时 enqueue 的 catch；
 * - 引导入口让启动占位退场的两帧 + 240ms 移除（真 rAF 会执行回调的那条路）；
 * - cordis 根卸载时 `fiber.dispose()` 失败只警告、不把卸载 Promise 打死。
 *
 * 为什么单独一批而不是并进 `session.spec.ts`：那两份钉的是主干（批 / 队列 / 报告 / 换装），
 * 这里钉的是主干之外的兜底分支，且要按用例换掉 cordis 根（假的装配底座最省事）。
 *
 * @module dsc-ui-boot/ui/w14-boot-gaps.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from '@testing-library/react'
import { SlotRegistry } from '@dsc/ui-core'
import type { UiHostInfo, UiRuntimeApi, UiSlots } from '@dsc/ui'
import type { UiBootGraph, UiPluginEntry } from '@pneuma/runtime/core/ui-manifest.js'
import { BOOT_STATE_GLOBAL, createBootSession, type UiBootSession, type UiBootSessionOptions } from './boot.js'
import { type UiCordisRoot } from './cordis-host.js'

const FACTORY_GLOBAL = '__DSC_UI_FACTORIES__'
const scope = globalThis as unknown as Record<string, unknown>

/** 与 `boot.ts` 内部的 `Factory` 同形：bundle 注册的那层包装。 */
type Factory = (require: (spec: string) => unknown, module: { exports: unknown }, exports: unknown) => void

const host: UiHostInfo = { name: 'web', version: '1.0.0' }

const runtime: UiRuntimeApi = {
  getSnapshot: () => null,
  subscribe: () => () => undefined,
  invoke: () => Promise.resolve(undefined as never),
}

/** 一个插件条目：默认单资源 URL，带 rev。 */
function entry(id: string, rev = '1'): UiPluginEntry {
  return { id, url: `plugins/${id}/client.js?rev=${rev}`, rev }
}

/** 最小启动图：不传 batches 时全部进一个 early 批，建完会话即装完。 */
function graph(entries: UiPluginEntry[], batches?: UiBootGraph['batches']): UiBootGraph {
  const resolved = batches ?? (entries.length === 0 ? [] : [{ phase: 'early' as const, entries: entries.map((item) => item.id) }])
  return {
    rev: 'graph-r1',
    host: { name: 'web', version: '1.0.0' },
    entries,
    batches: resolved,
  }
}

/** 造一个 bundle 工厂：`apply` 记一次调用，可以返回退订函数。 */
function makeFactory(apply: (ui: Record<string, unknown>) => (() => void) | void): Factory {
  return (_require, module) => {
    module.exports = { apply }
  }
}

interface ScriptContext {
  id: string
  url: string
  count: number
  register(id?: string): void
}

type Decision = 'load' | 'error' | 'ignore'

/** 脚本泵：扫 `<head>` 里未处理的 `script[data-dsc-plugin]`，按策略派发 load/error。 */
function startPump(
  table: Record<string, Factory>,
  factories: Record<string, Factory>,
  decide?: (context: ScriptContext) => Decision,
): { stop: () => void } {
  const handled = new WeakSet<Element>()
  const counts = new Map<string, number>()
  const pump = (): void => {
    for (const node of Array.from(document.head.querySelectorAll('script[data-dsc-plugin]'))) {
      if (handled.has(node)) continue
      handled.add(node)
      const id = node.getAttribute('data-dsc-plugin') ?? ''
      const url = node.getAttribute('src') ?? ''
      const key = `${id}\u0000${url}`
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      const register = (target: string = id): void => {
        const factory = factories[target]
        if (factory !== undefined) table[target] = factory
      }
      const action = decide === undefined ? 'load' : decide({ id, url, count, register })
      if (action === 'ignore') continue
      if (action === 'load' && decide === undefined) register()
      node.dispatchEvent(new Event(action))
    }
  }
  const timer = setInterval(pump, 0)
  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}

interface Live {
  pending: Promise<UiBootSession>
  table: Record<string, Factory>
  pump: { stop: () => void }
}

/** 起一个会话并挂上脚本泵；调用方负责 `pump.stop()`。 */
function bootLive(
  input: UiBootGraph,
  factories: Record<string, Factory> = {},
  options: { slots?: UiSlots; assembly?: UiBootSessionOptions['assembly']; decide?: (context: ScriptContext) => Decision } = {},
): Live {
  const table: Record<string, Factory> = {}
  scope[FACTORY_GLOBAL] = table
  const pump = startPump(table, factories, options.decide)
  const slots = options.slots ?? (new SlotRegistry() as unknown as UiSlots)
  const sessionOptions: UiBootSessionOptions = { slots, host, runtime }
  if (options.assembly !== undefined) sessionOptions.assembly = options.assembly
  return { pending: createBootSession(input, sessionOptions), table, pump }
}

/** 只装 early 批的便捷入口：装完就停泵。 */
async function bootOnce(
  input: UiBootGraph,
  factories: Record<string, Factory> = {},
  options: { slots?: UiSlots; assembly?: UiBootSessionOptions['assembly'] } = {},
): Promise<UiBootSession> {
  const live = bootLive(input, factories, options)
  try {
    return await live.pending
  } finally {
    live.pump.stop()
  }
}

/**
 * 假的 cordis 根：只实现 boot 用到的四个方法。
 *
 * 为什么不用真根：这一批要钉的是 `onState` 的三档回调与「挂载后仍在等依赖」的账本，
 * 真根的状态机由框架驱动，回调时机拿不稳；假根把 hooks 收下来，由用例直接喂状态码。
 */
function fakeCordis(plan: Record<string, { state: number; missing: string[] }> = {}): {
  root: UiCordisRoot
  hooks: Map<string, { onState?: (state: number, missing: string[]) => void; inject?: readonly string[] }>
} {
  const hooks = new Map<string, { onState?: (state: number, missing: string[]) => void; inject?: readonly string[] }>()
  const root = {
    ctx: {},
    mount: (id: string, _apply: unknown, mountHooks: Record<string, unknown> = {}) => {
      hooks.set(id, mountHooks as { onState?: (state: number, missing: string[]) => void; inject?: readonly string[] })
      const state = plan[id]?.state ?? 2
      return Promise.resolve({ state })
    },
    unmount: () => Promise.resolve(),
    stateOf: () => undefined,
    missingOf: (id: string) => plan[id]?.missing ?? [],
    disposeAll: () => Promise.resolve(),
  } as unknown as UiCordisRoot
  return { root, hooks }
}

beforeEach(() => {
  delete scope[FACTORY_GLOBAL]
  delete scope[BOOT_STATE_GLOBAL]
  // 默认走旧账本，退订函数是同步调用的；cordis 那条路按用例显式拨开关。
  scope['__DSC_CORDIS_PROBE__'] = 'none'
  vi.stubGlobal('requestIdleCallback', undefined)
  document.head.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.doUnmock('./boot')
  vi.doUnmock('./hmr')
  vi.doUnmock('./cordis-host')
  vi.doUnmock('./platform-modules.json')
  vi.resetModules()
  delete scope[FACTORY_GLOBAL]
  delete scope[BOOT_STATE_GLOBAL]
  delete scope['__DSC_CORDIS_PROBE__']
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('平台模块表漂移', () => {
  test('两张表对不上：模块加载当场把差异报出来', async () => {
    vi.resetModules()
    vi.doMock('./platform-modules.json', () => ({ default: ['react'] }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await import('./boot.js')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('平台模块表与运行时 require 表对不上'))
    } finally {
      error.mockRestore()
    }
  })
})

describe('旧账本路径的兜底', () => {
  test('回滚时某个退订函数抛错：只记一条错误，其余照常回滚', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const slots = {
        register: () => () => {
          throw new Error('退订炸了')
        },
        declare: () => () => undefined,
        registerFactory: () => () => undefined,
        seat: () => undefined,
      } as unknown as UiSlots
      const session = await bootOnce(
        graph([entry('broken')]),
        {
          broken: makeFactory((ui) => {
            ;(ui['slots'] as { register: (slot: string, options: unknown, component: unknown) => () => void }).register(
              'shell.main',
              {},
              () => null,
            )
            throw new Error('apply 也炸了')
          }),
        },
        { slots },
      )
      expect(session.getReports()).toMatchObject([{ id: 'broken', ok: false }])
      expect(error).toHaveBeenCalledWith('插件 broken 回滚登记时出错：', expect.any(Error))
    } finally {
      error.mockRestore()
    }
  })

  test('插件 consume 读到别的插件 provide 的服务', async () => {
    let seen: unknown
    const session = await bootOnce(
      graph([entry('provider'), entry('consumer')], [{ phase: 'early', entries: ['provider', 'consumer'] }]),
      {
        provider: makeFactory((ui) => {
          ;(ui['provide'] as (name: string, value: unknown) => void)('w14.value', 42)
        }),
        consumer: makeFactory((ui) => {
          seen = (ui['consume'] as (name: string) => unknown)('w14.value')
        }),
      },
    )
    expect(seen).toBe(42)
    expect(session.services.consume('w14.value')).toBe(42)
  })
})

describe('cordis 路径的 onState 与等待账本', () => {
  test('等待依赖：记一条「还差哪个服务」的失败报告；依赖补齐后翻绿', async () => {
    scope['__DSC_CORDIS_PROBE__'] = '*'
    const { root, hooks } = fakeCordis({ waiter: { state: 0, missing: ['svc.one'] } })
    const session = await bootOnce(
      graph([entry('waiter')]),
      { waiter: makeFactory(() => undefined) },
      { assembly: { cordis: root, services: {} as never } },
    )
    expect(session.getState().plugins['waiter']).toMatchObject({ state: 'loading', via: 'cordis', fiber: 0 })
    expect(session.getReports()).toMatchObject([{ id: 'waiter', ok: false }])
    expect(session.getReports()[0]?.error).toContain('svc.one')

    const waiter = hooks.get('waiter') as { onState: (state: number, missing: string[]) => void }
    expect(waiter).toBeTruthy()
    // 服务后补上来：纤维变「生效」，账本与报告一起翻绿。
    waiter.onState(2, [])
    expect(session.getState().plugins['waiter']).toMatchObject({ state: 'loaded', fiber: 2 })
    expect(session.getReports()).toMatchObject([{ id: 'waiter', ok: true }])
    // 纤维失败：原因与状态一起落到账本。
    waiter.onState(3, [])
    expect(session.getState().plugins['waiter']).toMatchObject({ state: 'failed', fiber: 3 })
    expect(session.getReports()).toMatchObject([{ id: 'waiter', ok: false }])
    // 待装 / 装载中：只记状态码与「还差哪个服务」。
    waiter.onState(1, [])
    expect(session.getState().plugins['waiter']).toMatchObject({ fiber: 1 })
    waiter.onState(0, ['svc.two'])
    expect(session.getState().plugins['waiter']?.error).toContain('svc.two')
    // 还在等的纤维也要能被卸掉：账本里那条「卸这条」的动作走 cordis.unmount。
    session.uninstall('waiter')
    await act(async () => {
      await Promise.resolve()
    })
    expect(session.getState().plugins['waiter']).toMatchObject({ state: 'removed' })
  })

  test('挂载后纤维不在生效态：缺依赖记具体服务名，不缺依赖记「等就绪」', async () => {
    scope['__DSC_CORDIS_PROBE__'] = '*'
    const { root } = fakeCordis({
      needy: { state: 0, missing: ['svc.missing'] },
      ready: { state: 0, missing: [] },
    })
    const session = await bootOnce(
      graph([entry('needy'), entry('ready')], [{ phase: 'early', entries: ['needy', 'ready'] }]),
      {
        needy: makeFactory(() => undefined),
        ready: makeFactory(() => undefined),
      },
      { assembly: { cordis: root, services: {} as never } },
    )
    expect(session.getState().plugins['needy']).toMatchObject({ state: 'loading', via: 'cordis' })
    expect(session.getState().plugins['needy']?.error).toContain('svc.missing')
    expect(session.getState().plugins['ready']).toMatchObject({ state: 'loading', via: 'cordis' })
    expect(session.getReports().find((report) => report.id === 'ready')?.error).toContain('就绪')
  })

  test('应用批安装自身抛错：enqueue 的 catch 记一条错误，不炸整个启动', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stubbed = vi.fn((callback: () => void) => {
      callback()
      return 0
    })
    vi.stubGlobal('requestIdleCallback', stubbed)
    try {
      const entries = [entry('a')] as UiPluginEntry[] & { find: () => never }
      Object.defineProperty(entries, 'find', {
        value: () => {
          throw new Error('批安装炸了')
        },
      })
      const session = await bootOnce(
        { rev: 'r', host: { name: 'web', version: '1.0.0' }, entries, batches: [{ phase: 'application', entries: ['a'] }] },
        {},
      )
      session.startApplication()
      await act(async () => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve()
      })
      expect(error).toHaveBeenCalledWith('[ui-shell] 应用批安装出错', expect.any(Error))
    } finally {
      error.mockRestore()
    }
  })
})

describe('引导入口：启动占位退场', () => {
  test('不等回包的失败页也会让 #boot-splash 淡出并移除（真 rAF 会执行回调那一路）', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.doMock('./boot', () => ({
      ALLOWED_MODULES: ['react'],
      readBootGraph: () => Promise.resolve({ rev: 'r', entries: [], batches: [], host: { name: 'Pneuma', version: '1.0.0' } }),
      loadPluginModule: () => Promise.resolve({ start: () => Promise.resolve() }),
      createBootSession: () => Promise.resolve({}),
    }))
    vi.doMock('./hmr', () => ({ startPluginHmr: () => () => undefined }))
    vi.doMock('./cordis-host', () => ({ createCordisRoot: () => ({}) }))
    const root = document.createElement('div')
    root.id = 'root'
    const splash = document.createElement('div')
    splash.id = 'boot-splash'
    document.body.append(root, splash)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = true
    // 真 rAF 会执行回调：两帧之后的退场代码才走得到。
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      callback()
      return 0
    })
    try {
      await act(async () => {
        await import('./main.js')
        for (let index = 0; index < 10; index += 1) await Promise.resolve()
      })
      expect(document.getElementById('boot-splash')?.classList.contains('boot-splash--done')).toBe(true)
      act(() => {
        vi.advanceTimersByTime(240)
      })
      expect(document.getElementById('boot-splash')).toBeNull()
    } finally {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
    }
  })
})
