/**
 * 把宿主通道接进 React：一个 context + 三个 hook。
 *
 * 为什么 hook 要在壳这一侧（而不是让插件自己订阅）：插件 bundle 只能 require
 * 白名单里的模块（react / react-dom / jsx-runtime / @dsc/ui），拿不到壳的内部模块；
 * 所以壳把「订阅宿主」这件事包成 hook 从 `@dsc/ui` 交给插件——插件写的是
 * `const snapshot = useHostSnapshot()`，不必知道底下是 SSE、WebSocket 还是 IPC。
 *
 * @module dsc-ui-shell/runtime-context
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { HostSnapshot } from '@dsc/ui-core'
import type { ChannelStatus, HostChannel, HostHello } from './host-channel'

const RuntimeContext = createContext<HostChannel | null>(null)

/** 把通道挂到 React 树上（壳的根节点用一次）。 */
export function RuntimeProvider({ channel, children }: { channel: HostChannel; children: ReactNode }): ReactNode {
  return <RuntimeContext.Provider value={channel}>{children}</RuntimeContext.Provider>
}

/** 取通道本体（插件通常不需要它，用下面两个 hook 就够）。 */
export function useHostChannel(): HostChannel {
  const channel = useContext(RuntimeContext)
  if (channel === null) throw new Error('useHostChannel 必须在 RuntimeProvider 里用')
  return channel
}

/** 订阅宿主快照：`null` = 还没收到第一帧。 */
export function useHostSnapshot(): HostSnapshot | null {
  const channel = useHostChannel()
  return useSyncExternalStore(
    (onChange) => channel.subscribe(onChange),
    () => channel.getSnapshot(),
    () => channel.getSnapshot(),
  )
}

/** 订阅连接状态（顶栏显示「连接中 / 已连接」用）。 */
export function useChannelStatus(): ChannelStatus {
  const channel = useHostChannel()
  return useSyncExternalStore(
    (onChange) => channel.subscribe(onChange),
    () => channel.getStatus(),
    () => channel.getStatus(),
  )
}

/** 握手里的宿主身份与放行方法（`null` = 还没握手）。 */
export function useHostHello(): HostHello | null {
  const channel = useHostChannel()
  return useSyncExternalStore(
    (onChange) => channel.subscribe(onChange),
    () => channel.getHello(),
    () => channel.getHello(),
  )
}
