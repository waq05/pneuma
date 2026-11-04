/**
 * 服务表的 React 订阅面（A1）：壳把装载出来的服务表经 context 交给条目组件，
 * 插件用 `useService(name)` 读一个服务，并跟着它出现/消失重渲染。
 *
 * 为什么要有它：`ui.consume` 只在 `apply` 那一刻读得到，而「提供者后装上/中途停用」
 * 是常态（team 与 status 的关系就是例子）——界面要能自动换数据源，而不是刷新页面。
 *
 * 为什么走 context 而不是模块级单例：探针会在同一进程里装载多轮（每轮一张新表），
 * 单例会让上一轮的服务泄漏进下一轮；context 由壳在装载处提供给自己的 React 树。
 *
 * @module dsc/ui/services-react
 */
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { ServiceRegistry } from './services.js'

const ServicesContext = createContext<ServiceRegistry | null>(null)

/** 把一棵 React 树接到某张服务表上（壳在装载结束后包在界面外层）。 */
export function ServicesProvider({ services, children }: { services: ServiceRegistry; children: ReactNode }): ReactNode {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
}

/**
 * 读一个服务；缺席给 undefined。
 *
 * 订阅按值判等（`consume` 返回的就是表里存的那份引用），所以「同一份 handle 被重新
 * provide」不会抖，真换了才重渲染。
 * @param name - 服务名
 */
export function useService<T>(name: string): T | undefined {
  const services = useContext(ServicesContext)
  const subscribe = useCallback(
    (onChange: () => void) => (services === null ? () => undefined : services.subscribe(onChange)),
    [services],
  )
  const snapshot = useCallback(
    () => (services === null ? undefined : services.consume<T>(name)),
    [services, name],
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
