/**
 * 界面引导入口（`ui-boot/ui/main.tsx`）的诊断页与交棒段（ui 层，真渲染）。
 *
 * `main.tsx` 是**入口副作用**：模块顶层直接 `void bootstrap()`，没有导出。这里按生产
 * 那条路走——先建 `#root`、stub 掉 rAF，再用动态 `import('./main.js')` 让入口跑一遍；
 * 启动图、渲染器物化、装载会话与 cordis 根都换成记录用的假件，只钉入口自己的判断：
 *
 * - 启动清单里没有渲染器 / 渲染器被停用 / 产物加载失败（含形状不对）→ 诊断页把三种来路
 *   分开说，并保留错误原文；
 * - 正常启动 → 把 `UiRendererApi` 交给渲染器的 `start(api)`，入口不再画任何东西；
 * - 入口交给渲染器的装配面：`bindRuntime` 回填的通道能被 cordis 根的取值函数读到，
 *   `createBootSession` 把 slots / host / runtime / assembly 原样转给装载会话。
 *
 * @module dsc-ui-boot/ui/main.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from '@testing-library/react'

interface BootState {
  graph: unknown
  graphError: Error | null
  loader: (() => Promise<unknown>) | null
  loadedEntries: unknown[]
  capturedApi: Record<string, unknown> | null
  starts: number
  sessionError: Error | null
  sessionCalls: Array<[unknown, unknown]>
  hmrCalls: unknown[]
  cordisOptions: Record<string, unknown> | null
  graphReads: number
}

const mocks = vi.hoisted<{ boot: BootState }>(() => ({
  boot: {
    graph: null,
    graphError: null,
    loader: null,
    loadedEntries: [],
    capturedApi: null,
    starts: 0,
    sessionError: null,
    sessionCalls: [],
    hmrCalls: [],
    cordisOptions: null,
    graphReads: 0,
  },
}))

vi.mock('./boot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./boot')>()
  return {
    ...actual,
    readBootGraph: (): Promise<unknown> => {
      mocks.boot.graphReads += 1
      return mocks.boot.graphError === null
        ? Promise.resolve(mocks.boot.graph)
        : Promise.reject(mocks.boot.graphError)
    },
    loadPluginModule: (entry: unknown): Promise<unknown> => {
      mocks.boot.loadedEntries.push(entry)
      return mocks.boot.loader === null ? Promise.resolve({ start: async () => undefined }) : mocks.boot.loader()
    },
    createBootSession: (graph: unknown, options: unknown): Promise<unknown> => {
      if (mocks.boot.sessionError !== null) return Promise.reject(mocks.boot.sessionError)
      mocks.boot.sessionCalls.push([graph, options])
      return Promise.resolve({ tag: 'boot-session' })
    },
  }
})

vi.mock('./hmr', () => ({
  startPluginHmr: (...args: unknown[]): (() => void) => {
    mocks.boot.hmrCalls.push(args)
    return () => undefined
  },
}))

vi.mock('./cordis-host', () => ({
  createCordisRoot: (options: Record<string, unknown>): unknown => {
    mocks.boot.cordisOptions = options
    return { tag: 'cordis-root' }
  },
}))

/** 一张最小启动图（`entries` 是入口用来找 `renderer` 的那一列）。 */
function graphOf(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rev: 'r1',
    entries: [],
    batches: [],
    host: { name: 'Pneuma', version: '1.0.0' },
    ...patch,
  }
}

const rootOf = (): HTMLElement => {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  return root
}

/** 动态 import 入口并把它排下的微任务跑完（入口自己 `void bootstrap()`，没有可 await 的 Promise）。 */
async function loadMain(): Promise<void> {
  await act(async () => {
    await import('./main.js')
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

const textOfRoot = (): string => document.getElementById('root')?.textContent ?? ''

beforeEach(() => {
  mocks.boot.graph = graphOf()
  mocks.boot.graphError = null
  mocks.boot.loader = null
  mocks.boot.loadedEntries.length = 0
  mocks.boot.capturedApi = null
  mocks.boot.starts = 0
  mocks.boot.sessionError = null
  mocks.boot.sessionCalls.length = 0
  mocks.boot.hmrCalls.length = 0
  mocks.boot.cordisOptions = null
  mocks.boot.graphReads = 0
  document.body.innerHTML = ''
  // jsdom 默认没有 rAF：入口的启动占位退场只需要「能排上」。
  ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (): number => 0
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = true
  vi.resetModules()
})

afterEach(() => {
  document.body.innerHTML = ''
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
})

describe('渲染器缺席：不白屏，画诊断页', () => {
  test('启动清单里没有 renderer：说清哪种来路，并点名缺的是 renderer', async () => {
    const root = rootOf()
    mocks.boot.graph = graphOf()

    await loadMain()

    expect(mocks.boot.graphReads).toBe(1)
    const text = textOfRoot()
    expect(text).toContain('没有进启动清单')
    expect(text).toContain('启动图里没有 renderer 这一条')
    // 诊断页画在 #root 上。
    expect(root.querySelector('h1')?.textContent).toContain('没有进启动清单')
  })

  test('renderer 被停用：标题写「已停用」，且不把停用说成缺产物（没有错误详情块）', async () => {
    rootOf()
    mocks.boot.graph = graphOf({ disabled: ['renderer'] })

    await loadMain()

    const text = textOfRoot()
    expect(text).toContain('已停用')
    expect(text).not.toContain('没有进启动清单')
    expect(document.querySelector('pre')).toBeNull()
    // 诊断页统一给出开关位置，用户能照着做。
    expect(text).toContain('~/.dsc/plugins.json')
  })

  test('渲染器产物加载失败：标题写「加载失败」并保留错误原文', async () => {
    rootOf()
    mocks.boot.graph = graphOf({ entries: [{ id: 'renderer', url: 'plugins/renderer/client.js', rev: '1' }] })
    mocks.boot.loader = () => Promise.reject(new Error('chunk 404'))

    await loadMain()

    const text = textOfRoot()
    expect(text).toContain('加载失败')
    expect(text).toContain('chunk 404')
    expect(mocks.boot.starts).toBe(0)
  })

  test('产物形状不对（没有 start）：按加载失败处理，并点明期望导出 start(api)', async () => {
    rootOf()
    mocks.boot.graph = graphOf({ entries: [{ id: 'renderer', url: 'plugins/renderer/client.js', rev: '1' }] })
    mocks.boot.loader = () => Promise.resolve({ App: () => null })

    await loadMain()

    const text = textOfRoot()
    expect(text).toContain('加载失败')
    expect(text).toContain('产物里没有 start')
    expect(mocks.boot.starts).toBe(0)
  })

  test('启动清单取不到：按「没进清单」处理，但详情用引导留下的错误原文', async () => {
    rootOf()
    mocks.boot.graphError = new Error('读取启动图失败：HTTP 503')

    await loadMain()

    const text = textOfRoot()
    expect(text).toContain('没有进启动清单')
    expect(text).toContain('读取启动图失败：HTTP 503')
  })
})

describe('渲染器就位：把入口面交给 start(api)', () => {
  test('start 收到 #root、启动图与装配面；bindRuntime 回填前取值函数报错，回填后交回通道', async () => {
    const root = rootOf()
    const graph = graphOf({ entries: [{ id: 'renderer', url: 'plugins/renderer/client.js', rev: '1' }] })
    mocks.boot.graph = graph
    mocks.boot.loader = () =>
      Promise.resolve({
        start: async (api: Record<string, unknown>): Promise<void> => {
          mocks.boot.starts += 1
          mocks.boot.capturedApi = api
        },
      })

    await loadMain()

    expect(mocks.boot.starts).toBe(1)
    expect(mocks.boot.loadedEntries).toEqual([{ id: 'renderer', url: 'plugins/renderer/client.js', rev: '1' }])
    // 正常交棒时入口自己不画任何界面。
    expect(root.textContent).toBe('')
    expect(document.querySelector('h1')).toBeNull()

    const api = mocks.boot.capturedApi as {
      container: HTMLElement
      boot: unknown
      slots: unknown
      services: unknown
      allowedModules: unknown[]
      bindRuntime: (runtime: unknown) => void
      createBootSession: (graph: unknown, options: Record<string, unknown>) => Promise<unknown>
      startPluginHmr: (...args: unknown[]) => unknown
      loadPluginModule: unknown
      servicesProvider: unknown
    }
    expect(api.container).toBe(root)
    expect(api.boot).toBe(graph)
    expect(api.allowedModules.length).toBeGreaterThan(0)
    expect(typeof api.servicesProvider).toBe('function')
    expect(api.loadPluginModule).toBeTypeOf('function')

    const options = mocks.boot.cordisOptions as { runtime: () => unknown }
    expect(() => options.runtime()).toThrow('运行时通道还没交进来')
    const runtime = { tag: 'host-channel' }
    api.bindRuntime(runtime)
    expect(options.runtime()).toBe(runtime)

    const result = await api.createBootSession(graph, { host: (graph as { host: unknown }).host, runtime })
    expect(result).toEqual({ tag: 'boot-session' })
    expect(mocks.boot.sessionCalls.at(-1)).toEqual([
      graph,
      {
        slots: api.slots,
        host: (graph as { host: unknown }).host,
        runtime,
        assembly: { cordis: { tag: 'cordis-root' }, services: api.services },
      },
    ])
  })
})
