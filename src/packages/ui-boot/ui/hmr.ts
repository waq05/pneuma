/**
 * 开发态热更的壳侧半边：把宿主推来的「哪几个插件变了」帧对账成「卸载旧的、装新的」。
 *
 * 三条口径与参考实现逐字对齐（也是这个模块存在的主要理由）：
 *
 *   1. **按 revision 换装，不刷整页**：一条插件的 rev 变了只重取这一条的单资源 URL
 *      （`entry.url` 本来就带新 rev），批结构是页面加载级的，不因为图变了去重跑批。
 *   2. **同 rev 忽略**：帧可能重复到达（重连、重试），rev 相同就不动——不然每次都会
 *      重建 React 状态（插件内的状态会白丢）。
 *   3. **失败不回滚、可直接重试**：旧条目卸掉之后失败就是失败，留在壳侧一份
 *      `{id, message, at}[]` 给诊断区画出来；重试 = 用最新图再对账一遍，对同 rev 也重试。
 *      不动宿主启停状态（那是用户的开关，不是页面的故障）。
 *
 * 样式归属的剔除在 `boot.ts` 的物化边界上记（`data-dsc-plugin`），`uninstall` 里连坐清理；
 * 共享模块不需要去重（工厂表是壳的模块表、插件的 require 表只有一份 React 等）。
 *
 * 所有对账走**会话的安装器队列**（`session.enqueue`，不是本模块自己的队列）：批安装与
 * 对账共用一条，两条并行的安装器才不会有「同刻 apply 同一条插件」的窗口（参考实现的
 * `enqueue` 同款）。队列里总是拿**最新**那一帧做目标，中间被更新帧作废的旧目标自动跳过。
 *
 * @module dsc-ui-shell/ui-renderer/hmr
 */
// 宿主通道类型住 `@dsc/ui-layout`（通道的 React 面同址）；装载会话同包，相对取。
import type { HostChannel, HostPluginsFrame } from '@dsc/ui-layout'
import type { UiBootSession } from './boot'

/** 一条「页内同步失败」（只影响这个页面，不改宿主的启用状态）。 */
export interface PluginSyncFailure {
  id: string
  message: string
  at: number
}

/** 壳侧热更句柄（诊断区读失败清单、点重试）。 */
export interface UiPluginHmr {
  getFailures(): PluginSyncFailure[]
  /** 用最新图再对账一遍（对同 rev 也重试）。 */
  retry(): void
  subscribe(listener: () => void): () => void
  stop(): void
}

/** 起壳侧热更。返回后连接上来的 `plugins` 帧都会被对账。 */
export function startPluginHmr(options: { channel: HostChannel; session: UiBootSession }): UiPluginHmr {
  const failures = new Map<string, PluginSyncFailure>()
  const listeners = new Set<() => void>()
  let stopped = false
  /** 队列里要追的目标：总是最新一帧。 */
  let latest: HostPluginsFrame | null = null

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 订阅者炸了不该拖垮对账（回调里通常就是 setState）
      }
    }
  }

  const reconcile = async (frame: HostPluginsFrame): Promise<void> => {
    const targetIds = new Set(frame.graph.entries.map((entry) => entry.id))
    // 先卸载消失的（宿主图里没有了；停用/卸载第三方时走这条路）。
    for (const [id, plugin] of Object.entries(options.session.getState().plugins)) {
      if (plugin.state !== 'loaded' || targetIds.has(id)) continue
      options.session.uninstall(id)
      failures.delete(id)
    }
    // 再按图顺序装新增/换代的：同 rev 直接跳过；批还没轮到的留给批装。
    for (const entry of frame.graph.entries) {
      if (options.session.installedRev(entry.id) === entry.rev) {
        failures.delete(entry.id)
        continue
      }
      // application 批在首帧的空闲时刻才装，初始 `plugins` 帧往往比它先到：这时按单资源抢装
      // 会把一条 combo 拆成 N 条单资源请求（A3 的取数口径），也会和批安装撞着 apply 同一条。
      // 批没轮到的交给批装；批之外的新条目（重建新加进来的）照旧在这里按单资源装上。
      if (options.session.awaitingBatch(entry.id)) continue
      const reason = await options.session.reload(entry)
      if (reason === null) {
        failures.delete(entry.id)
      } else {
        failures.set(entry.id, { id: entry.id, message: reason, at: Date.now() })
      }
    }
    notify()
  }

  const enqueue = (frame: HostPluginsFrame): void => {
    latest = frame
    void options.session
      .enqueue(async () => {
        if (stopped) return
        const target = latest
        if (target === null) return
        await reconcile(target)
      })
      .catch((error: unknown) => {
        // 对账里没接住的异常不该打死队列：记一行，下一帧继续。
        console.error('[ui-shell] 插件热更对账出错', error)
      })
  }

  const unsubscribeFrame = options.channel.onPlugins((frame) => {
    enqueue(frame)
  })

  return {
    getFailures: () => [...failures.values()],
    retry: () => {
      // 还没收到过帧（比如纯静态宿主）：用壳里这一份图当目标重跑一遍。
      enqueue(latest ?? { rev: options.session.graph.rev, changed: [], removed: [], graph: options.session.graph })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    stop: () => {
      stopped = true
      unsubscribeFrame()
      listeners.clear()
    },
  }
}
