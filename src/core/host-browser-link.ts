/**
 * 宿主插件面向 agent 的那条**浏览器控制链**：接口 + 服务名在这里定死。
 *
 * 为什么接口与实现分开：`host-stdio` 插件是这条链的实现方（它持有宿主协议那条传输），
 * 而工具插件（`src/plugins/dock-browser.ts`）是消费方。两边分属两棵编译树上的两个
 * 分支/两次提交，接口先落在这里，消费方就能只依赖类型，不必等实现落地。
 *
 * 服务经 `ctx.get(HOST_BROWSER_SERVICE)` 取；没有桌面壳时（`node lib/headless.js`
 * 直跑、TUI、远程壳）取不到或 `available()` 为假——**工具要报一句人话，别静默不做事**。
 *
 * 传输不在这里：这一份只有形状，实现在 `host-stdio` 里，真正的消息走
 * `src/core/dock-browser.ts` 定义的 `browser-*` 那几条。
 *
 * @module dsc/core/host-browser-link
 */
import type { CdpCommandTarget } from './cdp/transport.js'
import type { DockBrowserEventPush, DockViewInfo } from './dock-browser.js'

/** `ctx.provide` / `ctx.get` 用的服务名。 */
export const HOST_BROWSER_SERVICE = 'hostBrowser'

/** 开一张页签的回执。 */
export interface DockOpenResult {
  /** 桌面侧发号（`agent-N`）或调用方给定的 id——后续命令都用这个 id 指名这一台。 */
  viewId: string
  /** 视图是不是已经挂到窗口上（没挂上要么侧栏收着、要么窗口隐藏着）。 */
  attached: boolean
  url: string
}

/**
 * 宿主到桌面壳那条链路的门面。
 *
 * 每一处都可能「宿主里根本没有桌面壳」：`available()` 是同步判定，
 * 其余方法在不可用时抛 {@link DockBrowserUnavailableError}（带人话原因），
 * 而不是挂到超时——超时会把「没有桌面壳」报成「桌面壳没响应」，是两回事。
 */
export interface HostBrowserLink {
  /** 这条链现在通不通（宿主是桌面壳拉起的 utilityProcess、且窗口还在）。 */
  available(): boolean
  /** 列出现在活着的视图（含用户自己开的页签）。 */
  views(): Promise<DockViewInfo[]>
  /** 开一张页签并聚焦；`viewId` 不给时由桌面侧发号。 */
  open(url: string, viewId?: string): Promise<DockOpenResult>
  /** 关掉一台（连带壳里那张页签）。 */
  close(viewId: string): Promise<void>
  /** 在某台视图上执行一条 CDP 命令（方法名过桌面侧白名单）。 */
  call<T = unknown>(viewId: string, method: string, params?: Record<string, unknown>): Promise<T>
  /** 订 CDP 事件推送（只推白名单里的方法）。返回退订函数。 */
  onEvent(handler: (event: DockBrowserEventPush) => void): () => void
  /**
   * 把某台视图包成一条 CDP 会话，供 `src/core/cdp/` 那套快照/动作直接使用。
   *
   * 与 `call` 分开是为了让动作层拿到 `CdpCommandTarget` 这个形状（`sessionId` 是
   * 桌面侧编的视图 id，命令按它路由）。
   */
  session(viewId: string): CdpCommandTarget
}

/** 这条链不可用（宿主里没有桌面壳 / 窗口已关 / 视图不在了）。 */
export class DockBrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DockBrowserUnavailableError'
  }
}
