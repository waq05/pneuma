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
import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react'
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

/**
 * 只订阅快照里的一小块：选出来的值没变（按 `isEqual` 比）就不重渲染。
 *
 * 为什么需要它：宿主每个回合都在推帧，快照整体换引用，只用 `useHostSnapshot()`
 * 的组件会被无差别刷新——一个只显示「回合状态」的徽标不该因为别的字段变了而重画。
 * @param select - 从快照里取值
 * @param isEqual - 相等判断；缺省按引用比（返回对象时建议自己给一个）
 */
export function useHostSelector<T>(
  select: (snapshot: HostSnapshot | null) => T,
  isEqual: (previous: T, next: T) => boolean = Object.is,
): T {
  const snapshot = useHostSnapshot()
  const held = useRef<{ value: T } | null>(null)
  const next = select(snapshot)
  if (held.current === null || !isEqual(held.current.value, next)) held.current = { value: next }
  return held.current.value
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

/**
 * 宿主那一侧的最近一次异常（造帧失败的原因、或凭据失效）。
 *
 * 为什么要有：帧流一旦因为宿主快照形状异常而停住，界面会「静静地冻在最后一帧」——
 * 只有把原因显示出来，用户才知道该刷新还是该重启宿主。正常时是 null。
 */
export function useHostError(): string | null {
  const channel = useHostChannel()
  return useSyncExternalStore(
    (onChange) => channel.subscribe(onChange),
    () => channel.getHostError(),
    () => channel.getHostError(),
  )
}
