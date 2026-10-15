/**
 * host-stdio 插件：把 `ui` 服务（DscRuntime）暴露为宿主协议（headless UI 桥）。
 * 桌面端 Electron 壳 spawn/拉起本插件所在的 headless 进程并双向通信。
 * stdout 只承载协议消息；非 JSON 行容错忽略。
 *
 * 双传输（自动探测，无需配置）：
 *   - **stdio**：每行一个 JSON。适用于 node lib/headless.js 直接跑（管道手测、
 *     远程壳等任意宿主）。
 *   - **parentPort**：Electron utilityProcess 拉起时进程带 `process.parentPort`，
 *     消息经结构化克隆直传（无序列化）。
 *
 * 消息（runtime→host）：hello（握手）、result（应答）、snapshot（80ms 节流全量），
 *   以及 dock 浏览器链路那四条请求 browser-call / browser-open / browser-close / browser-views。
 * 消息（host→runtime）：invoke（调用 DscRuntime 方法）、exit（收尾并退进程），
 *   以及那四条请求的应答 browser-result 与 CDP 事件推送 browser-event。
 *
 * dock 浏览器链路（协议 3）：本文件既是那四条请求的**发送方**，也是
 * {@link HostBrowserLink} 的实现方（经 `ctx.provide(HOST_BROWSER_SERVICE, link)` 给工具面用）。
 * 与上面的 invoke/result 是**反方向**（runtime 请求、host 应答），所以用独立的自增号与
 * 自己的 pending 表记账，两个方向的 id 互不干扰。
 *
 * @module dsc/plugins/host-stdio
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { errText } from '../adapter/transcript.js'
import type { CdpCommandTarget } from '../core/cdp/transport.js'
import type { DockBrowserReply } from '../core/dock-browser.js'
import {
  DOCK_CALL_TIMEOUT_MS,
  DOCK_OPEN_TIMEOUT_MS,
  HOST_PROTOCOL_VERSION,
} from '../core/dock-browser.js'
import type { DockBrowserEventPush, DockBrowserRequest, DockViewInfo } from '../core/dock-browser.js'
import { createDockSession } from '../core/dock-session.js'
import { DockBrowserUnavailableError, HOST_BROWSER_SERVICE } from '../core/host-browser-link.js'
import type { DockOpenResult, HostBrowserLink } from '../core/host-browser-link.js'
import { isInvokableMethod } from '../core/host-methods.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import type { RuntimeSnapshot } from '../contract.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'host-stdio'

/** 快照推送节流间隔的缺省值（配置没给时用；界面靠它决定最多多久刷一帧）。 */
const DEFAULT_SNAPSHOT_THROTTLE_MS = 80

/**
 * 取快照推送节流间隔：夹在 16 毫秒到 1 秒之间。
 * 再小就是一帧一帧追着渲染器跑（白烧 CPU），再大就是点完按钮半天没反应。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readThrottle(passed: unknown): number {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const num = Number(raw.snapshotThrottleMs)
  if (!Number.isFinite(num)) return DEFAULT_SNAPSHOT_THROTTLE_MS
  return Math.min(Math.max(Math.round(num), 16), 1_000)
}

/**
 * 协议版本（破坏性变更时递增，宿主据此拒绝）。
 *
 * 权威定义在 `src/core/dock-browser.ts`（本文件与桌面壳两侧 import 同一份，值 3 起）。
 * 这里**保留同名导出**：别处（握手、测试）一直从本模块 import 它，改成从 core 取值的
 * 同时不能把旧入口弄断。
 */
export { HOST_PROTOCOL_VERSION }

// ── 消息类型 ──────────────────────────────────────────────────────────────────

export type HostToRuntimeMessage =
  | { type: 'invoke'; id: number; method: string; args?: unknown[] }
  | { type: 'exit' }
  /** dock 浏览器链路那四条请求的应答（形态见契约 `DockBrowserReply`）。 */
  | DockBrowserReply
  /** dock 浏览器的 CDP 事件推送（形态见契约 `DockBrowserEventPush`）。 */
  | DockBrowserEventPush

export type RuntimeToHostMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'snapshot'; snapshot: RuntimeSnapshot }
  /** 宿主 UI 动作请求（命令 handler 里的 openPicker / openModels 等）。 */
  | { type: 'ui'; action: 'open-picker' | 'open-models' }
  /** dock 终端输出流（desktop-dock 服务 → 桌面端面板）。 */
  | { type: 'dock-data'; id: string; data: string }
  /**
   * 本机界面地址（webserver 插件起来之后发一次）：桌面壳拿它加载窗口。
   * `url` 带一次性令牌（换 Cookie 用一次就作废），`origin` 是换完 Cookie 之后的根地址。
   */
  | { type: 'ui-url'; url: string; origin: string }
  /** dock 浏览器链路那四条请求（形态见契约 `DockBrowserRequest`，一字不差复用）。 */
  | DockBrowserRequest

// ── 传输抽象 ──────────────────────────────────────────────────────────────────

interface Transport {
  /**
   * 传输形态。`parentPort` 才可能接到桌面主进程——这是 `HostBrowserLink.available()` 的
   * **唯一**判据：Electron utilityProcess 拉起时进程带 `process.parentPort`，另一头就是
   * 桌面壳；stdio 传输（`node lib/headless.js` 手测 / TUI / 远程壳）那头是管道或远端，
   * 永远不会有桌面主进程来答 browser-* 请求。不靠 window/electron 猜：宿主进程里没有那些东西。
   */
  readonly kind: 'parentPort' | 'stdio'
  /** 发送一条 runtime→host 消息。 */
  send(message: RuntimeToHostMessage): void
  /** 收到 host→runtime 消息。 */
  onMessage(handler: (message: HostToRuntimeMessage) => void): void
  /**
   * 宿主那头还有人在吗（审批插件据此决定弹卡还是立刻按拒）。
   * 两条传输各自的判据：stdio 看 stdin 关没关，parentPort 由 Electron 管生命周期，恒为 true。
   */
  reachable(): boolean
  /** 收尾（移除监听、暂停 stdin）。 */
  dispose(): void
}

/** Electron utilityProcess 的父端口（形状局部声明，避免依赖 electron 类型）。 */
interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

function pickTransport(): Transport {
  const port = (process as typeof process & { parentPort?: ParentPortLike }).parentPort
  if (port !== undefined) {
    return {
      kind: 'parentPort',
      send: (message) => port.postMessage(message),
      onMessage: (handler) => {
        port.on('message', (event) => {
          const message = event.data as HostToRuntimeMessage
          if (message !== null && typeof message === 'object' && 'type' in message) {
            handler(message)
          }
        })
      },
      // 父端口存不存在由 Electron 决定，这中间接不到「窗口关了」的信号，按连着处理。
      reachable: () => true,
      dispose: () => {
        /* MessagePort 由 Electron 生命周期管理 */
      },
    }
  }
  return stdioTransport()
}

function stdioTransport(): Transport {
  let buffer = ''
  const write = (message: RuntimeToHostMessage): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
  const writeRef = { write }
  let handler: ((message: HostToRuntimeMessage) => void) | null = null
  const onStdin = (chunk: string | Buffer): void => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const trimmed = line.trim()
      if (trimmed === '' || handler === null) continue
      let message: HostToRuntimeMessage
      try {
        message = JSON.parse(trimmed) as HostToRuntimeMessage
      } catch {
        continue // 非 JSON 行容错忽略
      }
      handler(message)
    }
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', onStdin)
  // stdin 关了就是宿主那头没人了：审批卡再挂着也等不到答案（`node lib/headless.js` 手测结束就是这种）。
  let ended = false
  const onEnd = (): void => {
    ended = true
  }
  process.stdin.on('end', onEnd)
  process.stdin.on('close', onEnd)
  return {
    kind: 'stdio',
    send: (message) => writeRef.write(message),
    onMessage: (next) => {
      handler = next
    },
    reachable: () => !ended,
    dispose: () => {
      process.stdin.removeListener('data', onStdin)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('close', onEnd)
      process.stdin.pause()
    },
  }
}

// ── 插件 ──────────────────────────────────────────────────────────────────────

export const hostStdioPlugin: Plugin.Object = {
  name: 'host-stdio',
  inject: ['ui'],
  apply(ctx, passed) {
    const runtime = ctx.ui
    const throttleMs = readThrottle(passed)
    const transport = pickTransport()

    // ---- 界面可达性 ----
    // 宿主那头还有人（stdio 的 stdin 没关 / parentPort 还在）就登记成「有人能回答审批卡」，
    // 审批插件据此决定是弹卡还是立刻按拒，不再白等一次审批超时。
    const offInteractive = ctx.provide('interactive', { kind: 'host' as const, reachable: () => transport.reachable() })

    // ---- 快照节流推送 ----
    let pendingSnapshot = false
    let timer: NodeJS.Timeout | null = null
    const scheduleSnapshot = (): void => {
      pendingSnapshot = true
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        if (!pendingSnapshot) return
        pendingSnapshot = false
        transport.send({ type: 'snapshot', snapshot: runtime.getSnapshot() })
      }, throttleMs)
    }
    const unsubscribe = runtime.subscribe(scheduleSnapshot)

    // ---- 请求处理 ----
    const invoke = async (id: number, method: string, args: unknown[]): Promise<void> => {
      if (!isInvokableMethod(method)) {
        transport.send({ type: 'result', id, ok: false, error: `协议不允许调用的方法：${method}` })
        return
      }
      try {
        // 方法名已经收窄成 DscRuntime 的键，参数是线上来的 unknown：
        // 通用调用只有这一处，靠 Reflect.apply 展开实参（渲染器那侧由 RuntimeProxy 的映射类型保证签名对得上）。
        const value = Reflect.apply(runtime[method], runtime, args)
        transport.send({ type: 'result', id, ok: true, value: (await value) ?? null })
      } catch (error) {
        transport.send({ type: 'result', id, ok: false, error: errText(error) })
      }
    }

    // ---- dock 浏览器链路（协议 3）----
    // 本侧是那四条请求的**发送方**：桌面壳在协议另一头，把每条命令交给侧栏视图上挂着的
    // `webContents.debugger` 执行。与上面的 invoke/result 反方向，所以这里另立一份待办表
    // （自己的自增号），两条 id 空间互不干扰——同一个 nextId 记两个方向，排查时说清哪条是谁的会很费劲。
    let nextBrowserId = 1
    interface BrowserPending {
      what: string
      timer: ReturnType<typeof setTimeout>
      /** 结账：从待办表摘掉、清掉超时，再兑现或拒绝。 */
      settle: (error: Error | null, value?: unknown) => void
    }
    const browserPending = new Map<number, BrowserPending>()

    // 本侧的事件订阅者（`HostBrowserLink.onEvent`）：桌面壳推来的 CDP 事件在这里分发给它们。
    const browserEventHandlers = new Set<(event: DockBrowserEventPush) => void>()

    /**
     * 发一条 browser-* 请求并等桌面壳的应答。
     *
     * **每条都带超时**：宿主不答（窗口关了、视图没了、桌面侧卡住）就 reject 一句人话，
     * 绝不静默挂着——挂着的 Promise 会把整次工具调用拖到用户看到「卡住了」。
     */
    const requestBrowser = <T>(build: (id: number) => RuntimeToHostMessage, what: string, timeoutMs: number): Promise<T> => {
      const id = nextBrowserId
      nextBrowserId += 1
      return new Promise<T>((resolve, reject) => {
        const settle = (error: Error | null, value?: unknown): void => {
          const entry = browserPending.get(id)
          if (entry === undefined) return // 已经结过账（超时后迟到的应答）：丢掉
          browserPending.delete(id)
          clearTimeout(entry.timer)
          if (error === null) resolve(value as T)
          else reject(error)
        }
        const timer = setTimeout(() => {
          settle(new Error(`${what} 超时（${timeoutMs}ms）：桌面壳没有应答。侧栏窗口可能已关闭，或这一台视图已经不在了。`))
        }, timeoutMs)
        browserPending.set(id, { what, timer, settle })
        try {
          transport.send(build(id))
        } catch (error) {
          settle(new Error(`${what} 发不出去：${errText(error)}`))
        }
      })
    }

    /**
     * 这条链现在通不通——判据只认传输形态（见 {@link Transport.kind}）。
     *
     * 无法从宿主进程知道窗口有没有被关；「没有桌面壳」与「桌面壳没响应」是两回事：
     * 前者立刻抛 {@link DockBrowserUnavailableError}，后者才走超时。
     */
    const dockAvailable = (): boolean => transport.kind === 'parentPort'

    /** 不可用时的统一拒绝：立刻抛，不等超时（等超时会把「没有桌面壳」报成「没响应」）。 */
    const requireHost = (): void => {
      if (!dockAvailable()) {
        throw new DockBrowserUnavailableError('宿主里没有桌面壳：当前进程不是桌面端拉起的 utilityProcess，浏览器控制链没有接上')
      }
    }

    const browserViews = async (): Promise<DockViewInfo[]> => {
      requireHost()
      return requestBrowser<DockViewInfo[]>((id) => ({ type: 'browser-views', id }), 'browser-views', DOCK_CALL_TIMEOUT_MS)
    }

    const browserOpen = async (url: string, viewId?: string): Promise<DockOpenResult> => {
      requireHost()
      // 开页签要等壳把页签建出来、把原生视图挂上，用契约里为它单列的超时（比通用预算短）。
      return requestBrowser<DockOpenResult>(
        (id) => ({ type: 'browser-open', id, url, ...(viewId === undefined ? {} : { viewId }) }),
        'browser-open',
        DOCK_OPEN_TIMEOUT_MS,
      )
    }

    const browserClose = async (viewId: string): Promise<void> => {
      requireHost()
      await requestBrowser<unknown>((id) => ({ type: 'browser-close', id, viewId }), 'browser-close', DOCK_CALL_TIMEOUT_MS)
    }

    const browserCall = async <T = unknown>(viewId: string, method: string, params?: Record<string, unknown>): Promise<T> => {
      requireHost()
      return requestBrowser<T>(
        (id) => ({ type: 'browser-call', id, viewId, method, ...(params === undefined ? {} : { params }) }),
        `browser-call（${method}）`,
        DOCK_CALL_TIMEOUT_MS,
      )
    }

    const onBrowserEvent = (handler: (event: DockBrowserEventPush) => void): (() => void) => {
      browserEventHandlers.add(handler)
      return () => {
        browserEventHandlers.delete(handler)
      }
    }

    // 门面：工具插件经 `ctx.get(HOST_BROWSER_SERVICE)` 取它。方法都写成闭包（不用 `this`），
    // 这样消费方解构出来单独调用也不会散架。
    const link: HostBrowserLink = {
      available: dockAvailable,
      views: browserViews,
      open: browserOpen,
      close: browserClose,
      call: browserCall,
      onEvent: onBrowserEvent,
      // 把视图包成 CDP 会话：纯工厂，让 `src/core/cdp/` 那套快照/动作直接吃 CdpCommandTarget。
      session: (viewId: string): CdpCommandTarget => createDockSession(link, viewId),
    }
    // 服务先挂上：晚一步工具面就可能读到 undefined。
    const offBrowser = ctx.provide(HOST_BROWSER_SERVICE, link)

    transport.onMessage((message) => {
      if (message.type === 'exit') {
        runtime.exit()
        return
      }
      if (message.type === 'invoke') {
        void invoke(message.id, message.method, message.args ?? [])
        return
      }
      if (message.type === 'browser-result') {
        // 按 id 兑现本侧挂着的请求；ok 为假时 error 是桌面侧给的一句人话。
        const pending = browserPending.get(message.id)
        if (pending === undefined) return // 超时后迟到的应答：丢掉
        if (message.ok) pending.settle(null, message.value)
        else pending.settle(new Error(message.error))
        return
      }
      if (message.type === 'browser-event') {
        // 转给本侧订阅者；单个订阅者出错不掀翻别的订阅者。
        for (const handler of [...browserEventHandlers]) {
          try {
            handler(message)
          } catch {
            // 订阅者自己炸了只丢这一条
          }
        }
      }
    })

    ctx.on('dsc/exit', () => {
      // 进程要退了：把还挂着等桌面壳应答的请求全部拒掉，别留下悬着的 Promise。
      // 桌面壳不会再有机会回这些 id（它那边也在收尾），照「正在退出」说明白。
      for (const pending of [...browserPending.values()]) {
        pending.settle(new Error(`宿主正在退出，${pending.what} 没有拿到应答`))
      }
      unsubscribe()
      offBrowser()
      offInteractive()
      if (timer !== null) clearTimeout(timer)
      transport.dispose()
    })

    // 命令 handler 请求打开 UI 面板（如 /resume）——转发给宿主壳
    ctx.on('dsc/open-picker', () => {
      transport.send({ type: 'ui', action: 'open-picker' })
    })

    // /model 无参数打开模型选择面板——同样转发（桌面端自行映射或忽略）
    ctx.on('dsc/open-models', () => {
      transport.send({ type: 'ui', action: 'open-models' })
    })

    // dock 终端输出流
    ctx.on('dsc/dock-data', (id, data) => {
      transport.send({ type: 'dock-data', id, data })
    })

    // ---- 握手 + 初始快照 ----
    transport.send({ type: 'hello', protocolVersion: HOST_PROTOCOL_VERSION })
    scheduleSnapshot()

    // ---- 本机界面地址 ----
    // 桌面壳的窗口加载的是宿主伺服的那份 web 文档（C-真）。地址里带一次性令牌，
    // 只在这条已被父进程接管的链路上走一次，不进日志、不落盘。
    // 起不来不算错误：桌面壳收不到这条就回落到本地文件加载（老行为）。
    const web = ctx.get('webServer')
    if (web !== undefined) {
      void web
        .ensure()
        .then(({ url, origin }) => {
          transport.send({ type: 'ui-url', url, origin })
        })
        .catch((error: unknown) => {
          ctx.logger.warn(`host-stdio: 本机界面服务起不来（${errText(error)}），桌面壳将回落到本地文件加载`)
        })
    }
  },
}
