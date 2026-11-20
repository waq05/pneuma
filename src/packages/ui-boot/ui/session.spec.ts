/**
 * 装载会话（`ui-boot/ui/boot.ts` 的 `createBootSession`）：批安装、安装器队列、失败与重试、
 * 同 rev 去重、取数日志、换装/卸载与状态发布。
 *
 * 为什么和 `boot.spec.ts` 分开：那一份钉「图怎么读、批怎么排、模块怎么跑」，这一份要
 * 真会话——它一建就会往 `<head>` 里插 `<script>`（`appendScript`）。测试用一条假通道
 * 做法：起一个 0ms 的泵，按测试给的策略在脚本节点上派发 `load`/`error`，同时把工厂
 * 注册进 `__DSC_UI_FACTORIES__`——这正是浏览器执行 bundle 时发生的事，只是没有网络。
 *
 * 覆盖路径：默认走 cordis 的装配只占一条（`via === 'cordis'`），其余把灰度开关拨到
 * `'none'` 走旧账本——两条路径的分叉只在「谁持生命周期」，批/队列/取数/报告都在分叉之前。
 *
 * @module dsc-ui-boot/ui/session.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SlotRegistry } from '@dsc/ui-core'
import type { UiHostInfo, UiRuntimeApi } from '@dsc/ui-core'
import type { UiBootGraph, UiPluginEntry } from '@pneuma/runtime/core/ui-manifest.js'
import {
  BOOT_STATE_GLOBAL,
  createBootSession,
  type UiBootSession,
  type UiBootSessionOptions,
} from './boot.js'

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

/**
 * 最小启动图。
 *
 * 不传 batches 时把全部条目放进一个 **early** 批：`createBootSession` 只 await early 批，
 * 这样「建完会话就等于装完」的用例不必每条都再推一次 `startApplication`。
 * 要测 application 行为的用例显式给 batches。
 */
function graph(entries: UiPluginEntry[], batches?: UiBootGraph['batches']): UiBootGraph {
  const resolved =
    batches ??
    (entries.length === 0 ? [] : [{ phase: 'early' as const, entries: entries.map((item) => item.id) }])
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
  /** 同一 (id, url) 第几次派发（从 1 起）。 */
  count: number
  /** 把这条的工厂注册进全局表（脚本执行完时 bundle 会做这件事）。 */
  register(id?: string): void
}

type Decision = 'load' | 'error' | 'ignore'

/**
 * 脚本泵：每 0ms 扫一遍 `<head>` 里还没处理的 `script[data-dsc-plugin]`，按策略派发事件。
 *
 * 工厂注册由测试在策略里调 `register()` 完成——「加载了却没注册」这种现实里的坏 bundle
 * 因此可以被精确模拟，而不是靠全局预注册把 `has()` 提前变成 true。
 */
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
      // 默认策略与浏览器顺序一致：先执行脚本（注册工厂），再触发 load。
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

/** 起一个会话并同时把脚本泵挂上；`finally` 里必须 `pump.stop()`。 */
function bootLive(
  input: UiBootGraph,
  factories: Record<string, Factory> = {},
  decide?: (context: ScriptContext) => Decision,
  slots: SlotRegistry = new SlotRegistry(),
): {
  pending: Promise<UiBootSession>
  table: Record<string, Factory>
  slots: SlotRegistry
  pump: { stop: () => void }
} {
  // 会话里的 factoryTable() 认的是全局上这一份对象——泵往里写，会话往里读。
  const table: Record<string, Factory> = {}
  scope[FACTORY_GLOBAL] = table
  const pump = startPump(table, factories, decide)
  const options = { slots: slots as unknown as UiBootSessionOptions['slots'], host, runtime }
  return { pending: createBootSession(input, options), table, slots, pump }
}

/** 只要 early 批（不测 application）的便捷入口：装完就停泵。 */
async function bootOnce(
  input: UiBootGraph,
  factories: Record<string, Factory> = {},
  decide?: (context: ScriptContext) => Decision,
): Promise<UiBootSession> {
  const live = bootLive(input, factories, decide)
  try {
    return await live.pending
  } finally {
    live.pump.stop()
  }
}

beforeEach(() => {
  delete scope[FACTORY_GLOBAL]
  delete scope[BOOT_STATE_GLOBAL]
  // 默认走旧账本，退订函数是同步调用的：disposeAll / uninstall 的断言才不必等 fiber。
  // cordis 那条路单独一组用例显式拨回 `'*'`。
  scope['__DSC_CORDIS_PROBE__'] = 'none'
  // 应用批走 setTimeout 0 而不是 requestIdleCallback：测试里要能确定地推进。
  vi.stubGlobal('requestIdleCallback', undefined)
  document.head.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete scope[FACTORY_GLOBAL]
  delete scope[BOOT_STATE_GLOBAL]
  delete scope['__DSC_CORDIS_PROBE__']
  document.head.innerHTML = ''
})

describe('分批装载', () => {
  test('early 批装完才返回；application 批不装，报告只含已轮到的', async () => {
    const applied: string[] = []
    const factories = {
      e1: makeFactory(() => {
        applied.push('e1')
      }),
      a1: makeFactory(() => {
        applied.push('a1')
      }),
    }
    const session = await bootOnce(
      graph([entry('e1'), entry('a1')], [
        { phase: 'early', entries: ['e1'] },
        { phase: 'application', entries: ['a1'] },
      ]),
      factories,
    )

    expect(applied).toEqual(['e1'])
    expect(session.getReports().map((report) => report.id)).toEqual(['e1'])
    expect(session.getReports()[0]).toMatchObject({ ok: true, attempts: 1 })
    expect(session.getState().plugins['e1']).toMatchObject({ state: 'loaded', phase: 'early', via: 'ledger' })
    expect(session.getState().plugins['a1']).toMatchObject({ state: 'pending', phase: 'application' })
    expect(session.getState().batches).toMatchObject([
      { phase: 'early', state: 'done', failures: [] },
      { phase: 'application', state: 'pending' },
    ])
    expect(session.getState().firstFrameAt).toBeNull()
    expect(session.installedRev('e1')).toBe('1')
    expect(session.installedRev('a1')).toBeUndefined()
  })

  test('startApplication：空闲时刻装 application 批，幂等，批时刻有先后', async () => {
    const applied: string[] = []
    const factories = {
      e2: makeFactory(() => {
        applied.push('e2')
      }),
      a2: makeFactory(() => {
        applied.push('a2')
      }),
    }
    const live = bootLive(
      graph([entry('e2'), entry('a2')], [
        { phase: 'early', entries: ['e2'] },
        { phase: 'application', entries: ['a2'] },
      ]),
      factories,
    )
    try {
      const session = await live.pending
      session.startApplication()
      session.startApplication()
      await vi.waitFor(() => {
        expect(session.getState().plugins['a2']?.state).toBe('loaded')
      })

      expect(applied).toEqual(['e2', 'a2'])
      expect(session.getReports().map((report) => report.id)).toEqual(['e2', 'a2'])
      const batch = session.getState().batches[1]!
      expect(batch.state).toBe('done')
      expect(batch.scheduledAt).toBeTypeOf('number')
      expect(batch.startedAt).toBeTypeOf('number')
      expect(batch.doneAt).toBeTypeOf('number')
      expect(batch.scheduledAt!).toBeLessThanOrEqual(batch.startedAt!)
      expect(batch.startedAt!).toBeLessThanOrEqual(batch.doneAt!)
    } finally {
      live.pump.stop()
    }
  })

  test('awaitingBatch：未轮到的 application 批 true，early 装完 false，启动后转 false', async () => {
    const factories = {
      e3: makeFactory(() => undefined),
      a3: makeFactory(() => undefined),
    }
    const live = bootLive(
      graph([entry('e3'), entry('a3')], [
        { phase: 'early', entries: ['e3'] },
        { phase: 'application', entries: ['a3'] },
      ]),
      factories,
    )
    try {
      const session = await live.pending
      expect(session.awaitingBatch('e3')).toBe(false)
      expect(session.awaitingBatch('a3')).toBe(true)
      session.startApplication()
      await vi.waitFor(() => {
        expect(session.getState().batches[1]?.state).toBe('done')
      })
      expect(session.awaitingBatch('a3')).toBe(false)
    } finally {
      live.pump.stop()
    }
  })
})

describe('安装器队列', () => {
  test('enqueue 串行：前一件跑完才开下一件，返回值各归各的 Promise', async () => {
    const session = await bootOnce(graph([]))
    const order: string[] = []
    const first = session.enqueue(async () => {
      order.push('a:start')
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('a:end')
      return 'A'
    })
    const second = session.enqueue(async () => {
      order.push('b:start')
      order.push('b:end')
      return 'B'
    })

    await expect(first).resolves.toBe('A')
    await expect(second).resolves.toBe('B')
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  test('enqueue 一件失败不拖累后一件：调用方收到 reject，队列继续', async () => {
    const session = await bootOnce(graph([]))
    const order: string[] = []
    const bad = session.enqueue(async () => {
      order.push('bad')
      throw new Error('安装器炸了')
    })
    const good = session.enqueue(async () => {
      order.push('good')
      return 'ok'
    })

    await expect(bad).rejects.toThrow('安装器炸了')
    await expect(good).resolves.toBe('ok')
    expect(order).toEqual(['bad', 'good'])
  })
})

describe('失败、重试与报告', () => {
  test('第一次 apply 抛错、重试轮成功：报告翻绿，attempts=2，批 done', async () => {
    let runs = 0
    const session = await bootOnce(graph([entry('flaky')]), {
      flaky: makeFactory(() => {
        runs += 1
        if (runs === 1) throw new Error('第一轮槽还没声明')
      }),
    })

    expect(runs).toBe(2)
    expect(session.getReports()).toMatchObject([{ id: 'flaky', ok: true, attempts: 2 }])
    expect(session.getState().plugins['flaky']).toMatchObject({ state: 'loaded', attempts: 2 })
    expect(session.getState().batches[0]).toMatchObject({ state: 'done', failures: [] })
  })

  test('两轮都失败：原因与失败状态保留；reload 换装成功后翻绿并更新 rev', async () => {
    let broken = true
    const live = bootLive(graph([entry('bad')]), {
      bad: makeFactory(() => {
        if (broken) throw new Error('bundle 里 apply 抛错')
      }),
    })
    try {
      const session = await live.pending

      expect(session.getReports()).toMatchObject([
        { id: 'bad', ok: false, error: 'bundle 里 apply 抛错', attempts: 2 },
      ])
      expect(session.getState().plugins['bad']).toMatchObject({ state: 'failed', error: 'bundle 里 apply 抛错' })
      expect(session.getState().batches[0]).toMatchObject({ state: 'failed', failures: ['bad'] })
      expect(session.installedRev('bad')).toBeUndefined()

      // 修复后按 HMR 那条路重试：只取单资源、新 rev，成功后账本与报告一起翻绿。
      broken = false
      const retried = await session.reload(entry('bad', '2'))
      expect(retried).toBeNull()
      expect(session.getReports()).toMatchObject([{ id: 'bad', ok: true, attempts: 1 }])
      expect(session.getState().plugins['bad']).toMatchObject({ state: 'loaded', rev: '2' })
      expect(session.installedRev('bad')).toBe('2')
      expect(session.getState().requests.at(-1)).toMatchObject({
        url: 'plugins/bad/client.js?rev=2',
        kind: 'single',
        ok: true,
      })
    } finally {
      live.pump.stop()
    }
  })

  test('插件没有导出 apply：报告给一句明确的失败原因', async () => {
    const session = await bootOnce(graph([entry('shapeless')]), {
      shapeless: (_require, module) => {
        module.exports = { name: '只是数据' }
      },
    })

    expect(session.getReports()).toMatchObject([
      { id: 'shapeless', ok: false, error: '插件没有导出 apply(ui)', attempts: 2 },
    ])
    expect(session.getState().plugins['shapeless']?.state).toBe('failed')
  })

  test('unknown external：不取字节就失败，原因把两条出路写全', async () => {
    const unknown = entry('ext')
    unknown.external = ['left-pad']
    const session = await bootOnce(graph([unknown]), {
      ext: makeFactory(() => undefined),
    })

    const report = session.getReports()[0]!
    expect(report.ok).toBe(false)
    expect(report.error).toContain('left-pad')
    expect(report.error).toContain('既不是平台种子')
    expect(report.error).toContain('内联')
    // 依赖声明这一关在取字节之前，请求日志必须是空的。
    expect(session.getState().requests).toEqual([])
  })

  test('依赖未满足的三种说法：不在清单、被停用、服务没有提供者', async () => {
    const missing = entry('needs-missing')
    missing.inject = ['ghost']
    const first = await bootOnce(graph([missing]), {})
    expect(first.getReports()[0]!.error).toContain('插件 ghost 不在清单里')

    const disabled = entry('needs-disabled')
    disabled.inject = ['ghost']
    const second = await bootOnce({ ...graph([disabled]), disabled: ['ghost'] }, {})
    expect(second.getReports()[0]!.error).toContain('被停用')

    const needsService = entry('needs-service')
    needsService.services = ['missing-service']
    const third = await bootOnce(graph([needsService]), {})
    expect(third.getReports()[0]!.error).toContain('服务 missing-service 还没有提供者')
  })

  test('apply 抛错时回滚已登记的槽与服务：重试不撞「同一个格子已经有人了」', async () => {
    let runs = 0
    const slots = new SlotRegistry()
    const live = bootLive(
      graph([entry('partial')]),
      {
        partial: makeFactory((ui) => {
          runs += 1
          const api = ui['slots'] as {
            declare(slot: string, kind: string): void
            register(slot: string, options: unknown, component: unknown): void
          }
          api.declare('demo.slot', 'single')
          api.register('demo.slot', { id: 'only' }, () => null)
          ;(ui['provide'] as (name: string, value: unknown) => void)('demo.service', 'value')
          if (runs === 1) throw new Error('登记到一半就炸了')
        }),
      },
      undefined,
      slots,
    )
    try {
      const session = await live.pending
      expect(runs).toBe(2)
      expect(session.getReports()).toMatchObject([{ id: 'partial', ok: true, attempts: 2 }])
      expect(session.services.has('demo.service')).toBe(true)
      // 槽位只留一条：第一轮的登记已被回滚，第二轮重新登记没有撞上「已经有人了」。
      expect(slots.entriesOf('demo.slot')).toHaveLength(1)
    } finally {
      live.pump.stop()
    }
  })

  test('同 rev 去重：同一条同时出现在 early 与 application 批，只 apply 一次、只取一次', async () => {
    let applied = 0
    const live = bootLive(
      graph([entry('dup')], [
        { phase: 'early', entries: ['dup'] },
        { phase: 'application', entries: ['dup'] },
      ]),
      {
        dup: makeFactory(() => {
          applied += 1
        }),
      },
    )
    try {
      const session = await live.pending
      expect(applied).toBe(1)
      session.startApplication()
      await vi.waitFor(() => {
        expect(session.getState().batches[1]?.state).toBe('done')
      })
      expect(applied).toBe(1)
      expect(session.getState().requests).toHaveLength(1)
      expect(session.getState().batches[1]).toMatchObject({ state: 'done', failures: [] })
    } finally {
      live.pump.stop()
    }
  })
})

describe('取数日志', () => {
  test('同批 combo 只取一条：批 URL 一条请求覆盖多条 entry，日志 kind=batch', async () => {
    const applied: string[] = []
    const session = await bootOnce(
      graph([entry('a'), entry('b')], [
        { phase: 'early', entries: ['a', 'b'], url: 'plugins/??a,b&rev=batch-1', rev: 'batch-1' },
      ]),
      {
        a: makeFactory(() => {
          applied.push('a')
        }),
        b: makeFactory(() => {
          applied.push('b')
        }),
      },
      ({ id, register }) => {
        // 一条批脚本执行时把整批工厂都注册上。
        register('a')
        register('b')
        expect(id).toBe('a')
        return 'load'
      },
    )

    expect(applied).toEqual(['a', 'b'])
    expect(session.getState().requests).toHaveLength(1)
    expect(session.getState().requests[0]).toMatchObject({
      url: 'plugins/??a,b&rev=batch-1',
      kind: 'batch',
      id: 'a',
      phase: 'early',
      ok: true,
    })
  })

  test('批传输失败：同 URL 重试一次再回退单资源，日志逐条记 ok/kind', async () => {
    const session = await bootOnce(
      graph([entry('crashy')], [
        { phase: 'early', entries: ['crashy'], url: 'plugins/??crashy&rev=batch-2', rev: 'batch-2' },
      ]),
      { crashy: makeFactory(() => undefined) },
      ({ url, register }) => {
        if (url.includes('??')) return 'error'
        register()
        return 'load'
      },
    )

    expect(session.getReports()).toMatchObject([{ id: 'crashy', ok: true, attempts: 1 }])
    expect(session.getState().requests.map((log) => [log.kind, log.ok])).toEqual([
      ['batch', false],
      ['batch', false],
      ['single', true],
    ])
    expect(session.getState().requests.map((log) => log.url)).toEqual([
      'plugins/??crashy&rev=batch-2',
      'plugins/??crashy&rev=batch-2',
      'plugins/crashy/client.js?rev=1',
    ])
  })

  test('批执行了却没注册工厂：不重放批，直接回退单资源', async () => {
    const session = await bootOnce(
      graph([entry('late')], [
        { phase: 'early', entries: ['late'], url: 'plugins/??late&rev=batch-3', rev: 'batch-3' },
      ]),
      { late: makeFactory(() => undefined) },
      ({ url, register }) => {
        if (url.includes('??')) return 'load'
        register()
        return 'load'
      },
    )

    expect(session.getReports()).toMatchObject([{ id: 'late', ok: true }])
    expect(session.getState().requests.map((log) => [log.kind, log.ok])).toEqual([
      ['batch', true],
      ['single', true],
    ])
  })

  test('immediately 预取成功：批安装不再重复取数，日志只记预取那一条', async () => {
    const prefetched = entry('pre')
    prefetched.immediately = true
    const session = await bootOnce(graph([prefetched], [{ phase: 'early', entries: ['pre'] }]), {
      pre: makeFactory(() => undefined),
    })

    expect(session.getState().requests).toHaveLength(1)
    expect(session.getState().requests[0]).toMatchObject({
      url: 'plugins/pre/client.js?rev=1',
      kind: 'single',
      id: 'pre',
      phase: 'early',
      ok: true,
    })
    expect(session.getReports()).toMatchObject([{ id: 'pre', ok: true }])
  })
})

describe('换装与卸载', () => {
  test('reload：先卸旧实例（退订函数被调用）再按新 rev 单资源装新实例', async () => {
    const events: string[] = []
    /** 工厂执行时读它，把「这一代」钉进闭包——换装换的是一份新模块实例。 */
    let generation = 'first'
    const factories: Record<string, Factory> = {
      live: (_require, module) => {
        const at = generation
        module.exports = {
          apply: () => {
            events.push(`apply:${at}`)
            return () => {
              events.push(`dispose:${at}`)
            }
          },
        }
      },
    }
    const live = bootLive(graph([entry('live')], [{ phase: 'early', entries: ['live'] }]), factories)
    try {
      const session = await live.pending
      expect(events).toEqual(['apply:first'])

      generation = 'second'
      const result = await session.reload(entry('live', '2'))
      expect(result).toBeNull()
      expect(events).toEqual(['apply:first', 'dispose:first', 'apply:second'])
      expect(session.installedRev('live')).toBe('2')
      expect(session.getState().requests.at(-1)).toMatchObject({
        url: 'plugins/live/client.js?rev=2',
        kind: 'single',
      })
    } finally {
      live.pump.stop()
    }
  })

  test('reload 一条不在原图里的插件：账本补行、报告顺序追到末尾', async () => {
    const applied: string[] = []
    const factories: Record<string, Factory> = {
      base: makeFactory(() => {
        applied.push('base')
      }),
    }
    const live = bootLive(graph([entry('base')], [{ phase: 'early', entries: ['base'] }]), factories)
    try {
      const session = await live.pending
      factories['fresh'] = makeFactory(() => {
        applied.push('fresh')
      })
      const fresh = entry('fresh')
      expect(session.getState().plugins['fresh']).toBeUndefined()
      expect(session.getReports().map((report) => report.id)).toEqual(['base'])

      await expect(session.reload(fresh)).resolves.toBeNull()
      expect(applied).toEqual(['base', 'fresh'])
      expect(session.getState().plugins['fresh']).toMatchObject({
        id: 'fresh',
        phase: 'application',
        state: 'loaded',
      })
      expect(session.getReports().map((report) => report.id)).toEqual(['base', 'fresh'])
      expect(session.installedRev('fresh')).toBe('1')
    } finally {
      live.pump.stop()
    }
  })

  test('uninstall：退订函数执行、报告清空、状态 removed；reload 再装会重新执行工厂', async () => {
    const disposed: string[] = []
    let runs = 0
    const styles = (): Element[] => Array.from(document.head.querySelectorAll('style[data-dsc-plugin="styled"]'))
    const factories: Record<string, Factory> = {
      styled: (_require, module) => {
        runs += 1
        const style = document.createElement('style')
        style.textContent = `.rev-${String(runs)}{}`
        document.head.append(style)
        module.exports = {
          apply: () => {
            return () => {
              disposed.push('styled')
            }
          },
        }
      },
    }
    const live = bootLive(graph([entry('styled')], [{ phase: 'early', entries: ['styled'] }]), factories)
    try {
      const session = await live.pending
      expect(runs).toBe(1)
      expect(styles()).toHaveLength(1)

      session.uninstall('styled')
      expect(disposed).toEqual(['styled'])
      expect(session.getState().plugins['styled']?.state).toBe('removed')
      expect(session.getReports()).toEqual([])
      expect(session.installedRev('styled')).toBeUndefined()
      expect(styles()).toEqual([])

      await expect(session.reload(entry('styled', '2'))).resolves.toBeNull()
      expect(runs).toBe(2)
      expect(session.getState().plugins['styled']).toMatchObject({ state: 'loaded', rev: '2' })
      expect(styles()).toHaveLength(1)
      expect(styles()[0]!.getAttribute('data-dsc-plugin')).toBe('styled')
    } finally {
      live.pump.stop()
    }
  })

  test('disposeAll：所有插件按安装倒序卸载，退订函数都调用，已装 rev 清空', async () => {
    const disposed: string[] = []
    const live = bootLive(
      graph([entry('one'), entry('two')], [{ phase: 'early', entries: ['one', 'two'] }]),
      {
        one: makeFactory(() => () => {
          disposed.push('one')
        }),
        two: makeFactory(() => () => {
          disposed.push('two')
        }),
      },
    )
    try {
      const session = await live.pending
      expect(session.installedRev('one')).toBe('1')
      expect(session.installedRev('two')).toBe('1')
      session.disposeAll()
      expect(disposed).toEqual(['two', 'one'])
      expect(session.installedRev('one')).toBeUndefined()
      expect(session.installedRev('two')).toBeUndefined()
    } finally {
      live.pump.stop()
    }
  })

  test('服务表：provide 后能读到，卸载后释放', async () => {
    const live = bootLive(graph([entry('provider')], [{ phase: 'early', entries: ['provider'] }]), {
      provider: makeFactory((ui) => {
        ;(ui['provide'] as (name: string, value: unknown) => void)('demo.value', 42)
      }),
    })
    try {
      const session = await live.pending
      expect(session.services.has('demo.value')).toBe(true)
      expect(session.services.consume('demo.value')).toBe(42)
      session.uninstall('provider')
      expect(session.services.has('demo.value')).toBe(false)
    } finally {
      live.pump.stop()
    }
  })
})

describe('状态发布', () => {
  test('markFirstFrame 只打一次；订阅者每轮收到、抛错不拖累、退订后不再收', async () => {
    const session = await bootOnce(graph([entry('pub')]))
    const state = session.getState()
    let counted = 0
    const offThrower = session.subscribe(() => {
      throw new Error('订阅者炸了')
    })
    const offCounter = session.subscribe(() => {
      counted += 1
    })

    session.markFirstFrame()
    expect(state.firstFrameAt).toBeTypeOf('number')
    expect(counted).toBe(1)

    // 第二次打点不改时刻也不发通知。
    const at = state.firstFrameAt
    session.markFirstFrame()
    expect(state.firstFrameAt).toBe(at)
    expect(counted).toBe(1)

    // 退订后即使有状态变化也收不到。
    offCounter()
    session.uninstall('pub')
    expect(counted).toBe(1)
    offThrower()
  })

  test('账本挂在全局：建会话后 bootState 同一份引用', async () => {
    const session = await bootOnce(graph([entry('global')]))
    expect(scope[BOOT_STATE_GLOBAL]).toBe(session.getState())
  })
})

describe('cordis 装配路径', () => {
  test('默认走 cordis：apply 收到六项，卸载时 fiber 回收退订函数', async () => {
    scope['__DSC_CORDIS_PROBE__'] = '*'
    const seen: Array<Record<string, unknown>> = []
    const disposed: string[] = []
    const live = bootLive(graph([entry('wire')], [{ phase: 'early', entries: ['wire'] }]), {
      wire: makeFactory((ui) => {
        seen.push(ui)
        return () => {
          disposed.push('wire')
        }
      }),
    })
    try {
      const session = await live.pending
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ id: 'wire', host })
      // cordis 路径交出去的是转发壳（建根时通道可能还没回填），方法委托到同一个 runtime。
      const forwarded = seen[0]!['runtime'] as UiRuntimeApi
      expect(forwarded.getSnapshot()).toBeNull()
      expect(typeof forwarded.invoke).toBe('function')
      expect(session.getState().plugins['wire']).toMatchObject({
        state: 'loaded',
        via: 'cordis',
        fiber: 2,
      })
      expect(session.getReports()).toMatchObject([{ id: 'wire', ok: true }])

      session.uninstall('wire')
      await vi.waitFor(() => {
        expect(disposed).toEqual(['wire'])
      })
      expect(session.getState().plugins['wire']?.state).toBe('removed')
    } finally {
      live.pump.stop()
    }
  })
})

/* ------------------------------------------------------------------ */
/* W13 补盲：灰度开关的名单形态与默认值、cordis 路径的 onProvide。      */
/* ------------------------------------------------------------------ */

describe('cordis 灰度开关的名单形态（W13）', () => {
  test('名单形态：只有点名的走 cordis，其余仍走旧账本', async () => {
    scope['__DSC_CORDIS_PROBE__'] = ['picked']
    const applied: string[] = []
    const session = await bootOnce(
      graph([entry('picked'), entry('other')], [{ phase: 'early', entries: ['picked', 'other'] }]),
      {
        picked: makeFactory(() => {
          applied.push('picked')
        }),
        other: makeFactory(() => {
          applied.push('other')
        }),
      },
    )
    expect(applied).toEqual(['picked', 'other'])
    expect(session.getState().plugins['picked']).toMatchObject({ via: 'cordis', fiber: 2 })
    expect(session.getState().plugins['other']).toMatchObject({ via: 'ledger' })
  })

  test('开关不设（缺省）：全部走 cordis', async () => {
    delete scope['__DSC_CORDIS_PROBE__']
    const session = await bootOnce(graph([entry('defaulted')]), {
      defaulted: makeFactory(() => undefined),
    })
    expect(session.getState().plugins['defaulted']).toMatchObject({ via: 'cordis', fiber: 2 })
  })

  test('cordis 路径里插件 provide 的服务进报告（onProvide 回调）', async () => {
    scope['__DSC_CORDIS_PROBE__'] = '*'
    const session = await bootOnce(graph([entry('provider')]), {
      provider: makeFactory((ui) => {
        ;(ui['provide'] as (name: string, value: unknown) => void)('w13.service', 7)
      }),
    })
    expect(session.services.consume('w13.service')).toBe(7)
    expect(session.getReports()).toMatchObject([{ id: 'provider', ok: true, provides: ['w13.service'] }])
  })
})
