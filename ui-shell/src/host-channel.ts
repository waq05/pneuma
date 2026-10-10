/**
 * 界面壳与宿主之间的那条数据通道（浏览器侧）：SSE 收帧 + POST 调方法。
 *
 * 两个刻意的选择：
 *
 *   1. **用 EventSource 而不是 WebSocket**：浏览器自带重连，而且重连时会带上
 *      `Last-Event-ID`——正好是宿主帧 hub 的补帧入口（`resume(after)`）。
 *      自己写重连状态机是这条链路里最容易出错的一段，能不写就不写。
 *   2. **快照引用只在帧到达时更换**：`getSnapshot()` 要能直接喂给
 *      React 的 `useSyncExternalStore`（两次变化之间必须是同一个引用），
 *      所以状态不放在 React 里，放在这个与 React 无关的类里（遥控端同款做法）。
 *
 * 帧归并用共用核心 `src/ui/frames.ts`（严格版：壳与宿主同一次构建一起发，
 * 认不出的帧当场报错，而不是像遥控端那样容忍版本漂移）。它还会认帧号：帧号跳号
 * （中间缺了帧，增量永远补不回来）时这里**主动重开一条流**去换一帧全量——
 * 见 `connect()` 的注释，那是唯一能让 EventSource 丢掉旧游标的办法。
 *
 * @module dsc-ui-shell/host-channel
 */
import { applyHostFrame, HostFrameGapError, type HostSnapshot } from '@dsc/ui-core'

/**
 * 连接状态。
 *
 * - `connecting`：正在连，或者断了**正在自动重连**（EventSource 自己的行为，无需用户干预）；
 * - `open`：通着；
 * - `closed`：不会再自己连上了——凭据被判死（401），或 EventSource 进了 CLOSED 这个终态。
 *   这时界面要请用户用宿主新打印的地址重开，干等是没有意义的。
 *
 * 注意 `closed` 与 `connecting` 的区别是这次修复的重点：以前终态也报 `connecting`，
 * 页面会一直显示"连接中"，而 invoke 每次都回 401，用户看不到任何可操作的提示。
 */
export type ChannelStatus = 'connecting' | 'open' | 'closed'

/** 一次 invoke 的默认超时：宿主方法卡住时不能让页面永远等。 */
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000

/** 宿主握手帧的内容。 */
export interface HostHello {
  /** 数据通道协议版本。 */
  protocolVersion: number
  /** 宿主放行的方法名（壳据此决定按钮要不要画）。 */
  methods: string[]
  /** 宿主身份。 */
  host: { name: string; version: string }
}

/**
 * 调用没走完就被中断（超时，或调用方给的 signal 中止了）。
 *
 * 为什么单独成一个类型：与「宿主方法自己抛错」不是一回事——前者可能值得重试或提示用户，
 * 后者是业务结果。调用方按 `instanceof` 或 `reason` 就能分清，不必去猜错误消息。
 */
export class HostInvokeAbortedError extends Error {
  /** `timeout` = 超过默认超时；`aborted` = 调用方中止。 */
  readonly reason: 'timeout' | 'aborted'

  constructor(reason: 'timeout' | 'aborted', timeoutMs: number) {
    super(reason === 'timeout' ? `调用宿主方法超时（${String(timeoutMs)} 毫秒）` : '调用宿主方法已被中止')
    this.name = 'HostInvokeAbortedError'
    this.reason = reason
  }
}

/** 壳看到的宿主通道。 */
export interface HostChannel {
  getSnapshot(): HostSnapshot | null
  getHello(): HostHello | null
  getStatus(): ChannelStatus
  /** 宿主最近一次报错（造帧失败之类；界面显示"宿主状态异常"用）。没有就是 `null`。 */
  getHostError(): string | null
  /** 订阅（快照或握手或连接状态变化时叫一次）。 */
  subscribe(listener: () => void): () => void
  /**
   * 调一个宿主方法。
   * @param method - 宿主放行的方法名
   * @param args - 实参表
   * @param signal - 可选：调用方自己的取消信号（与默认超时一起起作用）
   */
  invoke<T = unknown>(method: string, args?: unknown[], signal?: AbortSignal): Promise<T>
  /** 主动断开（页面卸载时；正常不需要——EventSource 会自动重连）。 */
  close(): void
}

/** 建立通道。返回后连接是异步建的，状态经 subscribe 观察。 */
export function createHostChannel(): HostChannel {
  let snapshot: HostSnapshot | null = null
  let hello: HostHello | null = null
  let status: ChannelStatus = 'connecting'
  let hostError: string | null = null
  let source: EventSource | null = null
  /** 已经主动关掉这条通道（页面卸载）：不再重连。 */
  let stopped = false
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 一个订阅者炸了不该拖垮其它的（回调里通常就是 setState）
      }
    }
  }

  /** 只改状态并通知（快照没变时用；状态本来就是这个值就不通知）。 */
  const setStatus = (next: ChannelStatus): void => {
    if (status === next) return
    status = next
    notify()
  }

  /**
   * 建（或重建）SSE 连接。
   *
   * 为什么要能重建：帧号跳号（中间缺帧）是增量补不回来的——只能整条流重开。
   * 新开的 EventSource 身上没有 Last-Event-ID，宿主因此会走「接不上缓冲」那条路
   * 广播一帧全量，游标就重新对齐了。
   *
   * 注意不能只靠 `source.close()`：规范里 close() 是**永久关闭**，关掉就不会再有重连。
   * 所以这里换一个实例。
   */
  const connect = (): void => {
    if (stopped) return
    const es = new EventSource('/api/events')
    source = es

    es.addEventListener('hello', (event: Event) => {
      if (es !== source) return // 这条已经被换掉了，别回写状态
      try {
        hello = JSON.parse((event as MessageEvent<string>).data) as HostHello
        status = 'open'
        notify()
      } catch (error) {
        console.error('[ui-shell] 握手帧认不出', error)
      }
    })

    es.addEventListener('frame', (event: Event) => {
      if (es !== source) return
      try {
        const raw: unknown = JSON.parse((event as MessageEvent<string>).data)
        snapshot = applyHostFrame(snapshot, raw)
        status = 'open'
        notify()
      } catch (error) {
        if (error instanceof HostFrameGapError) {
          // 帧号中间缺了几帧：增量永远补不回来，只能重开一条流换回全量。
          console.warn('[ui-shell] 帧号跳号，重开数据通道换一帧全量：', error.message)
          source = null
          es.close()
          setStatus('connecting')
          connect()
          return
        }
        // 认不出的帧不进状态：宁可少一帧，也不要画出一份半对不对的界面。
        console.error('[ui-shell] 帧认不出', error)
      }
    })

    es.onopen = () => {
      if (es !== source) return
      setStatus('open')
    }

    es.onerror = (event: Event) => {
      if (es !== source) return
      // 宿主也能发 `event: error`（造帧失败之类），而浏览器把服务端发来的同名事件
      // 也送进 onerror：那是带 data 的 MessageEvent，与「连接出错」共用同一个入口。
      // 把它当断线处理会让状态谎报成 connecting，所以先按 data 区分开。
      const data = (event as MessageEvent<string>).data
      if (typeof data === 'string' && data !== '') {
        try {
          const parsed = JSON.parse(data) as { error?: unknown }
          hostError = typeof parsed.error === 'string' ? parsed.error : data
        } catch {
          hostError = data
        }
        console.error('[ui-shell] 宿主报错', hostError)
        notify()
        return
      }
      // 规范：401 这类响应会让浏览器「fail the connection」，之后再也不会自动重连。
      // 这时还报 connecting 就是谎报——界面需要一个「用新地址重开」的入口。
      setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting')
    }
  }

  connect()

  return {
    getSnapshot: () => snapshot,
    getHello: () => hello,
    getStatus: () => status,
    getHostError: () => hostError,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async invoke<T = unknown>(method: string, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
      // 默认超时与调用方的取消信号合成一个：两件事都要能中断这次 fetch。
      const timeout = AbortSignal.timeout(DEFAULT_INVOKE_TIMEOUT_MS)
      const gate = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      let response: Response
      try {
        response = await fetch('/api/invoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, args }),
          signal: gate,
        })
      } catch (error) {
        // fetch 被中断时抛的是 AbortError/TimeoutError：换成可识别的类型，调用方不必猜名字。
        if (gate.aborted) {
          throw new HostInvokeAbortedError(timeout.aborted ? 'timeout' : 'aborted', DEFAULT_INVOKE_TIMEOUT_MS)
        }
        throw error
      }
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; value?: unknown; error?: string }
        | null
      if (response.status === 401) {
        // 凭据已经过期：SSE 那边同样会走到 closed（重连也是 401），这里同步把状态说出来。
        hostError = payload?.error ?? '界面凭据已失效，请用宿主新打印的地址重开'
        setStatus('closed')
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
      if (payload?.ok !== true) throw new Error(payload?.error ?? '调用失败')
      return payload.value as T
    },
    close() {
      stopped = true
      status = 'closed'
      source?.close()
      source = null
      notify()
    },
  }
}
