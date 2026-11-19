/**
 * 壳侧热更对账（`ui-boot/ui/hmr.ts`）：同 rev 忽略、增删/换装对账、失败留在壳侧与重试、
 * 订阅通知与退订、停止后不再对账。
 *
 * 假 `HostChannel` 只实现 `onPlugins`，帧由测试手动推；假 `UiBootSession` 的 `enqueue`
 * 同步执行任务并把 Promise 交给测试等——`reconcile` 是异步的，不等它就是在猜。
 *
 * @module dsc-ui-boot/ui/hmr.spec
 */
import { describe, expect, test, vi } from 'vitest'
import type { HostChannel, HostPluginsFrame } from '@dsc/ui-runtime'
import type { UiBootGraph, UiPluginEntry } from '@pneuma/runtime/core/ui-manifest.js'
import type { UiBootSession } from './boot'
import { startPluginHmr } from './hmr.js'

function entry(id: string, rev = '1'): UiPluginEntry {
  return { id, url: `plugins/${id}/client.js?rev=${rev}`, rev }
}

function graph(entries: UiPluginEntry[], rev = 'graph-1'): UiBootGraph {
  return { rev, entries, batches: [], host: { name: 'web', version: '1.0.0' } }
}

function frame(entries: UiPluginEntry[], rev = 'frame-1'): HostPluginsFrame {
  return { rev, changed: [], removed: [], graph: graph(entries, `graph-${rev}`) }
}

/** 壳侧装载会话的假身：只实现热更对账用到的那几项。 */
function fakeSession(options: {
  graph?: UiBootGraph
  /** id → 账本里的状态（默认 loaded）。 */
  plugins?: Record<string, 'pending' | 'loaded' | 'failed'>
  /** 已经装上的 rev。 */
  installed?: Record<string, string>
  /** 所属批还没轮到的 id。 */
  awaiting?: string[]
} = {}) {
  const plugins: Record<string, { state: string }> = {}
  for (const [id, state] of Object.entries(options.plugins ?? {})) plugins[id] = { state }
  const installed = new Map(Object.entries(options.installed ?? {}))
  const awaiting = new Set(options.awaiting ?? [])
  const reloads: string[] = []
  const uninstalls: string[] = []
  const pending: Array<Promise<unknown>> = []
  let reloadResult: (item: UiPluginEntry) => string | null = () => null

  const session = {
    graph: options.graph ?? graph([]),
    getState: () => ({ plugins }),
    installedRev: (id: string): string | undefined => installed.get(id),
    awaitingBatch: (id: string): boolean => awaiting.has(id),
    uninstall: (id: string): void => {
      uninstalls.push(id)
      delete plugins[id]
      installed.delete(id)
    },
    reload: async (item: UiPluginEntry): Promise<string | null> => {
      reloads.push(item.id)
      const reason = reloadResult(item)
      if (reason === null) installed.set(item.id, item.rev)
      return reason
    },
    // 与真会话同一条口径：任务立刻开跑，调用方拿到的 Promise 就是它。
    enqueue: <T,>(task: () => Promise<T>): Promise<T> => {
      const run = task()
      pending.push(run)
      return run
    },
  }

  return {
    session: session as unknown as UiBootSession,
    plugins,
    installed,
    reloads,
    uninstalls,
    pending,
    setReloadResult(next: (item: UiPluginEntry) => string | null): void {
      reloadResult = next
    },
  }
}

/** 假宿主通道：只收 `onPlugins`，帧由测试推。 */
function fakeChannel() {
  const listeners = new Set<(value: HostPluginsFrame) => void>()
  return {
    onPlugins(listener: (value: HostPluginsFrame) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(value: HostPluginsFrame): void {
      for (const listener of [...listeners]) listener(value)
    },
    get listenerCount(): number {
      return listeners.size
    },
  }
}

/** 等对账队列里那几件任务跑完（reject 也算跑完：`console.error` 那条路由插件自己接）。 */
async function flush(session: ReturnType<typeof fakeSession>): Promise<void> {
  await Promise.allSettled(session.pending.splice(0))
}

function start(session: ReturnType<typeof fakeSession>, channel: ReturnType<typeof fakeChannel>) {
  return startPluginHmr({
    channel: channel as unknown as HostChannel,
    session: session.session,
  })
}

describe('按 rev 对账', () => {
  test('同 rev 忽略：不重装，并把这一条旧的失败清掉', async () => {
    const session = fakeSession({ plugins: { alpha: 'loaded' } })
    session.setReloadResult(() => 'bundle 坏了')
    const channel = fakeChannel()
    const hmr = start(session, channel)

    channel.emit(frame([entry('alpha')]))
    await flush(session)
    expect(session.reloads).toEqual(['alpha'])
    expect(hmr.getFailures()).toMatchObject([{ id: 'alpha', message: 'bundle 坏了' }])
    expect(typeof hmr.getFailures()[0]!.at).toBe('number')

    // 宿主再推一帧，这一条已经是同一个 rev：不动，失败记录清掉。
    session.installed.set('alpha', '1')
    channel.emit(frame([entry('alpha')]))
    await flush(session)
    expect(session.reloads).toEqual(['alpha'])
    expect(hmr.getFailures()).toEqual([])
  })

  test('图里没有的 loaded 插件被卸载（失败记录连坐清掉），没装上的不碰', async () => {
    const session = fakeSession({ plugins: { keep: 'loaded', gone: 'loaded', failed: 'failed' } })
    session.setReloadResult((item) => (item.id === 'gone' ? '取字节失败' : null))
    const channel = fakeChannel()
    const hmr = start(session, channel)

    // 第一帧里两条都在：keep 装好，gone 失败（失败记录留在壳侧）。
    channel.emit(frame([entry('keep'), entry('gone')]))
    await flush(session)
    expect(hmr.getFailures()).toMatchObject([{ id: 'gone' }])

    channel.emit(frame([entry('keep')], 'frame-2'))
    await flush(session)
    expect(session.uninstalls).toEqual(['gone'])
    expect(hmr.getFailures()).toEqual([])
  })

  test('新增/换代按图顺序重装；同 rev 与还没轮到批的都跳过', async () => {
    const session = fakeSession({
      plugins: { updated: 'loaded', same: 'loaded', batched: 'pending' },
      installed: { updated: '1', same: '1' },
      awaiting: ['batched'],
    })
    const channel = fakeChannel()
    const hmr = start(session, channel)

    channel.emit(
      frame([entry('updated', '2'), entry('same', '1'), entry('batched', '1'), entry('fresh', '1')]),
    )
    await flush(session)

    expect(session.reloads).toEqual(['updated', 'fresh'])
    expect(hmr.getFailures()).toEqual([])
  })

  test('失败留在壳侧（不改宿主启停）：retry 用最新图重跑，同 rev 也重试', async () => {
    const session = fakeSession({ plugins: { alpha: 'loaded' } })
    let attempts = 0
    session.setReloadResult(() => {
      attempts += 1
      return attempts === 1 ? '取字节失败' : null
    })
    const channel = fakeChannel()
    const hmr = start(session, channel)

    channel.emit(frame([entry('alpha')]))
    await flush(session)
    expect(hmr.getFailures()).toMatchObject([{ id: 'alpha', message: '取字节失败' }])

    hmr.retry()
    await flush(session)
    expect(session.reloads).toEqual(['alpha', 'alpha'])
    expect(hmr.getFailures()).toEqual([])
  })

  test('还没收到过帧时 retry：拿壳里这一份图当目标', async () => {
    const bootEntry = entry('boot')
    const session = fakeSession({ graph: graph([bootEntry], 'graph-boot'), plugins: { boot: 'pending' } })
    const channel = fakeChannel()
    const hmr = start(session, channel)

    hmr.retry()
    await flush(session)
    expect(session.reloads).toEqual(['boot'])
  })
})

describe('通知与生命周期', () => {
  test('订阅者每轮收到一次；一个订阅者抛错不拖垮其余；退订后不再收到', async () => {
    const session = fakeSession({ plugins: { alpha: 'loaded' }, installed: { alpha: '1' } })
    const channel = fakeChannel()
    const hmr = start(session, channel)

    let counted = 0
    const offThrower = hmr.subscribe(() => {
      throw new Error('订阅者炸了')
    })
    const offCounter = hmr.subscribe(() => {
      counted += 1
    })

    channel.emit(frame([entry('alpha')]))
    await flush(session)
    expect(counted).toBe(1)

    offCounter()
    channel.emit(frame([entry('alpha')], 'frame-2'))
    await flush(session)
    expect(counted).toBe(1)
    offThrower()
  })

  test('stop：退订通道、清空监听；之后的帧与 retry 都不再对账，失败清单留着', async () => {
    const session = fakeSession({ plugins: { alpha: 'loaded' } })
    session.setReloadResult(() => '坏了')
    const channel = fakeChannel()
    const hmr = start(session, channel)

    channel.emit(frame([entry('alpha')]))
    await flush(session)
    expect(hmr.getFailures()).toHaveLength(1)

    let notified = 0
    const off = hmr.subscribe(() => {
      notified += 1
    })
    hmr.stop()
    expect(channel.listenerCount).toBe(0)

    channel.emit(frame([entry('beta')]))
    await flush(session)
    hmr.retry()
    await flush(session)
    expect(session.reloads).toEqual(['alpha'])
    expect(notified).toBe(0)
    expect(hmr.getFailures()).toHaveLength(1)
    off()
  })

  test('对账里没接住的异常不打死队列：记一行 console.error', async () => {
    const session = fakeSession({ plugins: { alpha: 'loaded' } })
    session.setReloadResult(() => {
      throw new Error('reload 炸了')
    })
    const channel = fakeChannel()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      start(session, channel)
      channel.emit(frame([entry('alpha')]))
      await flush(session)
      expect(errorSpy).toHaveBeenCalledWith('[ui-shell] 插件热更对账出错', expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })
})
