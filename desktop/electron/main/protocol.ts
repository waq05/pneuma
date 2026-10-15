/**
 * 宿主协议会话：与 dsc headless 宿主（utilityProcess，host-stdio 插件）经
 * Electron MessagePort 结构化克隆通信。消息形状与 dsc 的
 * src/plugins/host-stdio.ts 对应（协议版本见 `src/core/dock-browser.ts`）；
 * 进程退出后 pending 请求全部拒绝。
 *
 * 两个方向各有一套记账：
 *
 *   - `invoke`：**桌面调宿主**、宿主回 `result`，桌面按 `pending` 表等应答（下面那张表）；
 *   - `browser-*`：**宿主调桌面**、桌面回 `browser-result`，id 由宿主发号、桌面原样带回——
 *     桌面这一侧没有表要记（它只是应答方），两张账互不干扰。
 *
 * @module desktop/main/protocol
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import {
  HOST_PROTOCOL_VERSION,
  type DockBrowserEventPush,
  type DockBrowserReply,
  type DockBrowserRequest,
} from '@dsc/runtime/core/dock-browser.js'

/**
 * 协议版本：**值从契约模块取**（`@dsc/runtime/core/dock-browser.js`），这里只把同一个值
 * 再导出一次，别处 import 它的写法不用改。
 *
 * 为什么不再各写一份数字：宿主那侧（`src/plugins/host-stdio.ts`）拿它跟桌面握手，
 * 两个数字分头维护的话，「壳按 3 发、宿主只认 2」这种不匹配只能等运行时才发现；
 * 现在两棵编译树 import 同一个常量，版本号只有一处真源。
 */
export { HOST_PROTOCOL_VERSION }

export type RuntimeSnapshot = {
  entries: unknown[]
  status: {
    sessionId: string | null
    model: string
    effort: string | null
    turnState: 'idle' | 'thinking' | 'working' | 'awaiting-approval'
    usage: { inputTokens: number; outputTokens: number } | null
  }
  pendingApproval: { id: string; toolName: string; argsSummary: string } | null
  sessions: { id: string; cwd: string; createdAt: number; title?: string }[]
  sessionsLoading: boolean
}

type RuntimeToHostMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'snapshot'; snapshot: RuntimeSnapshot }
  | { type: 'ui'; action: 'open-picker' | 'open-models' }
  | { type: 'dock-data'; id: string; data: string }
  /**
   * 本机界面地址：宿主把界面服务开起来之后发一次。窗口加载它伺服的那份文档，
   * 本机文件加载只作为回落（宿主没起来 / 界面资产缺失）。
   */
  | { type: 'ui-url'; url: string; origin: string }
  /**
   * 宿主请桌面壳办的四条（`browser-call` / `browser-open` / `browser-close` /
   * `browser-views`）：形状从契约模块来，两侧一字不差。**方向与上面的 result 相反**——
   * 这几条是宿主发起的请求，桌面用 `browser-result` 按同一个 id 应答。
   */
  | DockBrowserRequest

type HostToRuntimeMessage =
  | { type: 'invoke'; id: number; method: string; args?: unknown[] }
  | { type: 'exit' }
  /** 上面那四条请求的应答（ok / error 两种）。 */
  | DockBrowserReply
  /** CDP 事件推送（只推契约白名单里的事件，且只来自挂过 debugger 的视图）。 */
  | DockBrowserEventPush

export class HostProtocol {
  private child: UtilityProcess
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private snapshotListeners = new Set<(snapshot: RuntimeSnapshot) => void>()
  private helloListeners = new Set<(protocolVersion: number) => void>()
  private closeListeners = new Set<(info: { code: number | null }) => void>()
  private uiListeners = new Set<(action: 'open-picker' | 'open-models') => void>()
  private dockDataListeners = new Set<(data: { id: string; data: string }) => void>()
  private uiUrlListeners = new Set<(info: { url: string; origin: string }) => void>()
  private browserRequestListeners = new Set<(request: DockBrowserRequest) => void>()
  private exitForwarded = false

  constructor(entry: string, cwd: string, env?: Record<string, string | undefined>) {
    this.child = utilityProcess.fork(entry, [], {
      serviceName: 'dsc-host',
      cwd,
      ...(env === undefined ? {} : { env }),
    })
    this.child.on('message', (message: RuntimeToHostMessage) => {
      if (message === null || typeof message !== 'object' || !('type' in message)) return
      if (message.type === 'hello') {
        if (message.protocolVersion !== HOST_PROTOCOL_VERSION) return
        for (const listener of this.helloListeners) listener(message.protocolVersion)
        return
      }
      if (message.type === 'result') {
        const request = this.pending.get(message.id)
        if (request === undefined) return
        this.pending.delete(message.id)
        if (message.ok) request.resolve(message.value)
        else request.reject(new Error(message.error))
        return
      }
      if (message.type === 'snapshot') {
        for (const listener of this.snapshotListeners) listener(message.snapshot)
        return
      }
      if (message.type === 'ui') {
        for (const listener of this.uiListeners) listener(message.action)
        return
      }
      if (message.type === 'dock-data') {
        for (const listener of this.dockDataListeners) listener({ id: message.id, data: message.data })
        return
      }
      if (message.type === 'ui-url') {
        for (const listener of this.uiUrlListeners) listener({ url: message.url, origin: message.origin })
        return
      }
      // 宿主发起的四条浏览器请求（反方向：它请桌面办事）。桌面侧没有 pending 表——
      // id 由宿主发号，桌面把同一个 id 交给 browserResult 带回去就完了。
      if (
        message.type === 'browser-call' ||
        message.type === 'browser-open' ||
        message.type === 'browser-close' ||
        message.type === 'browser-views'
      ) {
        for (const listener of this.browserRequestListeners) listener(message)
      }
    })
    this.child.on('exit', (code) => {
      for (const [, request] of this.pending) request.reject(new Error('宿主进程已退出'))
      this.pending.clear()
      if (!this.exitForwarded) {
        for (const listener of this.closeListeners) listener({ code })
      }
    })
  }

  /** 调用 DscRuntime 方法（headless 侧白名单校验）。 */
  invoke(method: string, args: unknown[] = []): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const message: HostToRuntimeMessage = { type: 'invoke', id, method, args }
      this.child.postMessage(message)
    })
  }

  /** 优雅退出：请求宿主自行收尾；exit 事件将被抑制（正常退出不发 host-exit）。 */
  exitGracefully(onSettled?: () => void): void {
    const current = this.child
    current.once('exit', () => {
      this.exitForwarded = true
      onSettled?.()
    })
    try {
      current.postMessage({ type: 'exit' } satisfies HostToRuntimeMessage)
    } catch {
      onSettled?.()
    }
  }

  /** 强杀（优雅退出超时兜底）。 */
  kill(): void {
    this.child.kill()
  }

  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): void {
    this.snapshotListeners.add(listener)
  }
  onHello(listener: (protocolVersion: number) => void): void {
    this.helloListeners.add(listener)
  }
  onClose(listener: (info: { code: number | null }) => void): void {
    this.closeListeners.add(listener)
  }
  /** 宿主 UI 动作（命令 handler 里的 openPicker 等）。 */
  onUi(listener: (action: 'open-picker' | 'open-models') => void): void {
    this.uiListeners.add(listener)
  }
  /** dock 终端输出流（desktop-dock 服务）。 */
  onDockData(listener: (data: { id: string; data: string }) => void): void {
    this.dockDataListeners.add(listener)
  }
  /** 本机界面地址（宿主界面服务起来后一次）。 */
  onUiUrl(listener: (info: { url: string; origin: string }) => void): void {
    this.uiUrlListeners.add(listener)
  }

  /**
   * 宿主请桌面办的四条浏览器请求（`browser-call` / `browser-open` / `browser-close` /
   * `browser-views`）。
   *
   * 这是**反方向**的一条：`invoke` 是桌面调宿主，这四条是宿主调桌面。应答没有表要记——
   * 请求里的 id 由宿主发号，处理完把同一个 id 交给 {@link browserResult} 带回去。
   */
  onBrowserRequest(listener: (request: DockBrowserRequest) => void): void {
    this.browserRequestListeners.add(listener)
  }

  /**
   * 回一条 `browser-result`（上面那四条请求的应答；ok / error 两种形状二选一）。
   *
   * 参数形状刻意与 dock 那侧 `sendDockCommand` 的返回值一致：调用点拿到什么就递什么，
   * 中间不再翻译一次（少一处能写错的地方）。
   */
  browserResult(id: number, result: { ok: true; value: unknown } | { ok: false; error: string }): void {
    this.post(
      result.ok
        ? { type: 'browser-result', id, ok: true, value: result.value }
        : { type: 'browser-result', id, ok: false, error: result.error },
    )
  }

  /** 推一条 `browser-event`（视图上的 CDP 事件；只有挂过 debugger 的视图会推）。 */
  browserEvent(event: DockBrowserEventPush): void {
    this.post({ type: 'browser-event', viewId: event.viewId, method: event.method, params: event.params })
  }

  /**
   * 往宿主进程发一条消息。
   *
   * 为什么这两条新消息要包一层 try：宿主可能已经退了，往一个死了的 utilityProcess
   * `postMessage` 会抛，而应答是在一条 promise 链里发的——抛出去就是一个
   * unhandled rejection（在 Node 上会把主进程带走）。没人收的应答本来也只该安静丢掉。
   */
  private post(message: HostToRuntimeMessage): void {
    try {
      this.child.postMessage(message)
    } catch (error) {
      process.stderr.write(`[dsc-desktop] 宿主协议：${message.type} 发不出去（${String(error)}）\n`)
    }
  }
}
