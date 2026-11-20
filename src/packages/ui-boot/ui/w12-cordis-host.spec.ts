/**
 * cordis 根的补盲（`packages/ui-boot/ui/cordis-host.ts`）：状态码译文、装 / 卸 / 查缺服务、
 * 六项 API 的转发（slot 登记、服务 provide / consume、运行时通道现取现转）、装失败回滚与
 * `disposeAll`。
 *
 * 用真 cordis 根（不是 mock）：被测的就是「壳给插件的那层壳」到底怎么转。
 *
 * @module dsc/packages/ui-boot/ui/w12-cordis-host.spec
 */
import { describe, expect, test, vi } from 'vitest'
import type { UiPluginApi } from '@dsc/ui'
import { ServiceRegistry } from '@dsc/ui-core'
import { createCordisRoot, fiberStateText } from './cordis-host.js'

/** 假的槽位注册表：`register` 返回一个退订函数（与真表同形）。 */
function fakeSlots(): {
  register: ReturnType<typeof vi.fn>
  declare: ReturnType<typeof vi.fn>
  registerFactory: ReturnType<typeof vi.fn>
} {
  return { register: vi.fn(() => () => undefined), declare: vi.fn(), registerFactory: vi.fn() }
}

/** 造一个根；slots / runtime / services 都可注入。 */
function makeRoot(overrides: {
  runtime?: unknown
  services?: ServiceRegistry
  slots?: ReturnType<typeof fakeSlots>
} = {}): ReturnType<typeof createCordisRoot> & { slots: ReturnType<typeof fakeSlots> } {
  const slots = overrides.slots ?? fakeSlots()
  const root = createCordisRoot({
    slots: slots as never,
    host: { platform: 'web', language: 'zh' } as never,
    runtime: (overrides.runtime ?? (() => ({ getSnapshot: () => ({ seq: 1 }), subscribe: () => () => undefined, invoke: async () => 'ok' }))) as never,
    services: overrides.services ?? new ServiceRegistry(),
  })
  return { ...root, slots }
}

describe('fiberStateText：状态码译文', () => {
  test('0–5 六个状态都有话说，未知数字走兜底', () => {
    const texts = [0, 1, 2, 3, 4, 5].map((state) => fiberStateText(state))
    for (const text of texts) expect(typeof text).toBe('string')
    expect(new Set(texts).size).toBeGreaterThan(1)
    expect(fiberStateText(9)).toContain('9')
    expect(fiberStateText(undefined)).toBeUndefined()
  })
})

describe('mount / unmount / stateOf', () => {
  test('装上一条：状态变生效；卸掉后查不到', async () => {
    const root = makeRoot()
    const cleanup = vi.fn()
    await root.mount('demo', () => cleanup)
    expect(root.stateOf('demo')).toBe(2)
    await root.unmount('demo')
    expect(root.stateOf('demo')).toBeUndefined()
    expect(cleanup).toHaveBeenCalled()
  })

  test('没装过的 id 卸载是空操作', async () => {
    const root = makeRoot()
    await expect(root.unmount('never-mounted')).resolves.toBeUndefined()
    expect(root.stateOf('never-mounted')).toBeUndefined()
  })

  test('同一 id 重装：先撤旧的那条', async () => {
    const root = makeRoot()
    const first = vi.fn()
    const second = vi.fn()
    await root.mount('demo', () => first)
    await root.mount('demo', () => second)
    expect(first).toHaveBeenCalled()
    expect(root.stateOf('demo')).toBe(2)
    await root.unmount('demo')
    expect(second).toHaveBeenCalled()
  })

  test('apply 抛错：mount 原样抛，且不留残骸', async () => {
    const root = makeRoot()
    await expect(
      root.mount('broken', () => {
        throw new Error('插件炸了')
      }),
    ).rejects.toThrow('插件炸了')
    expect(root.stateOf('broken')).toBeUndefined()
  })

  test('disposeAll：全部卸掉', async () => {
    const root = makeRoot()
    const a = vi.fn()
    const b = vi.fn()
    await root.mount('a', () => a)
    await root.mount('b', () => b)
    await root.disposeAll()
    expect(a).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
    expect(root.stateOf('a')).toBeUndefined()
    expect(root.stateOf('b')).toBeUndefined()
  })
})

describe('缺服务：missingOf 与 onState 回报', () => {
  test('声明的服务没就绪：missingOf 列出来；就绪后纤维自动生效并回报状态', async () => {
    const root = makeRoot()
    const onState = vi.fn()
    const apply = vi.fn()
    const fiber = await root.mount('waiter', apply, { inject: ['demoService'], onState })
    expect(fiber.state).toBe(0)
    expect(root.missingOf('waiter')).toEqual(['demoService'])
    // 没装过的 id 给空数组（而不是 undefined）。
    expect(root.missingOf('nothing')).toEqual([])

    await root.mount('provider', (ui: UiPluginApi) => {
      ui.provide('demoService', '好')
    })
    await vi.waitFor(() => {
      expect(onState).toHaveBeenCalled()
    })
    expect(root.stateOf('waiter')).toBe(2)
    expect(root.missingOf('waiter')).toEqual([])
    expect(apply).toHaveBeenCalled()
    await root.unmount('provider')
  })
})

describe('插件 API：槽位、服务、运行时通道', () => {
  test('slots.register 走壳的注册表，退订函数由 cordis 回收', async () => {
    const slots = fakeSlots()
    const root = makeRoot({ slots })
    let release: (() => void) | undefined
    await root.mount('demo', (ui: UiPluginApi) => {
      release = ui.slots.register('shell.main' as never, undefined as never, (() => null) as never) as unknown as () => void
    })
    expect(slots.register).toHaveBeenCalledTimes(1)
    expect(typeof release).toBe('function')
    await root.unmount('demo')
  })

  test('provide / consume：界面侧服务表可用，另一条插件读得到', async () => {
    const services = new ServiceRegistry()
    const root = makeRoot({ services })
    await root.mount('provider', (ui: UiPluginApi) => {
      ui.provide('greeting', '你好')
    })
    let seen: unknown
    await root.mount('consumer', (ui: UiPluginApi) => {
      seen = ui.consume('greeting')
    })
    expect(seen).toBe('你好')
    expect(services.names()).toContain('greeting')
    await root.unmount('provider')
    expect(services.consume('greeting')).toBeUndefined()
    // 卸载 consumer 不该受影响。
    await root.unmount('consumer')
  })

  test('服务名与壳自己的重名：镜像进 cordis 失败只警告，界面侧照旧可用', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const services = new ServiceRegistry()
    const root = makeRoot({ services })
    await root.mount('clash', (ui: UiPluginApi) => {
      ui.provide('slots', '冒名')
    })
    expect(warn).toHaveBeenCalled()
    expect(services.consume('slots')).toBe('冒名')
    warn.mockRestore()
    await root.unmount('clash')
  })

  test('runtime 是现取现转的壳：通道后回填也能用', async () => {
    const runtime = { getSnapshot: () => ({ seq: 7 }), subscribe: vi.fn(() => () => undefined), invoke: vi.fn(async () => 'invoked') }
    const root = makeRoot({ runtime })
    let snapshot: unknown
    let invoked: unknown
    let unsubscribed = false
    await root.mount('demo', (ui: UiPluginApi) => {
      snapshot = ui.runtime.getSnapshot()
      unsubscribed = typeof ui.runtime.subscribe(() => undefined) === 'function'
      void ui.runtime.invoke('ping').then((value) => {
        invoked = value
      })
    })
    expect(snapshot).toEqual({ seq: 7 })
    expect(unsubscribed).toBe(true)
    expect(invoked).toBe('invoked')
    expect(runtime.invoke).toHaveBeenCalledWith('ping', undefined)
    await root.unmount('demo')
  })
})
