/**
 * 把一台 dock 视图包成 {@link CdpCommandTarget}——`src/core/cdp/` 那套快照/动作在
 * **没有 WebSocket 后端**时的接入点。
 *
 * 为什么单独一个文件：dock 视图（侧栏那台 `WebContentsView`）不是一条
 * `--remote-debugging-port` 的 WebSocket 连接，命令要经宿主协议转给桌面主进程，
 * 由那边的 `webContents.debugger` 执行。抽成一个**纯工厂**（不 import electron、
 * 不 import 任何有副作用的东西，只依赖调用方传进来的 `source`）之后：
 *   1. `src/core/cdp/{actions,snapshot}` 那两层对后端无感地复用同一份逻辑；
 *   2. 探针能用类型擦除直读这个模块、喂一个假 `source` 就验证「命令有没有按视图路由、
 *      事件有没有按视图过滤」——不必起一个真桌面壳。
 *
 * 一句话：**逻辑在这里、传输在外面**。路由与过滤是纯计算，所以可直测，
 * 也不会因为宿主环境（真 Electron / 手测）不同而行为不同。
 *
 * @module dsc/core/dock-session
 */
import type { CdpCommandTarget } from './cdp/transport.js'
import type { DockBrowserEventPush } from './dock-browser.js'

/**
 * dock 会话的后端：宿主链路门面（`HostBrowserLink`）满足这个形状。
 *
 * 刻意只取 `call` 与 `onEvent` 两件事，而不是整份 `HostBrowserLink`——
 * 这条会话只关心「在哪台视图上发哪条命令、订哪条事件」，可用性判定与页签开户
 * 属于门面自己要管的事，不该渗进这一层。
 */
export interface DockSessionSource {
  /** 在某台视图上执行一条 CDP 命令，返回 CDP 原文的 `value`。 */
  call<T = unknown>(viewId: string, method: string, params?: Record<string, unknown>): Promise<T>
  /** 订全局的 CDP 事件推送（本侧订阅者集合，返回退订函数）。 */
  onEvent(handler: (event: DockBrowserEventPush) => void): () => void
}

/**
 * 把一台 dock 视图包成一条 CDP 会话。
 *
 * @param source - 真正把命令送出去的宿主链路（{@link DockSessionSource}）。
 * @param viewId - 桌面侧编的视图 id；`sessionId` 就是它，桌面按它路由到对应 webContents。
 */
export function createDockSession(source: DockSessionSource, viewId: string): CdpCommandTarget {
  return {
    // sessionId 用视图 id：桌面侧的 debugger 已经挂在这一台上，命令按它找目标。
    sessionId: viewId,
    send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      // 直接透传：视图 id 由本会话固定，action 层不必每次再写一遍。
      return source.call<T>(viewId, method, params)
    },
    on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
      // 一条 source 上挂着所有订阅者，事件推来时按 viewId + method **双重过滤**：
      // 只有属于这一台视图、且是订阅者关心的那一条，才投给它。
      // 不过滤的话，两台视图上同名的 `Runtime.consoleAPICalled` 会串台。
      return source.onEvent((event) => {
        if (event.viewId !== viewId) return
        if (event.method !== method) return
        handler(event.params)
      })
    },
  }
}
