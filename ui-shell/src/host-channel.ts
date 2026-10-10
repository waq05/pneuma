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
 * 认不出的帧当场报错，而不是像遥控端那样容忍版本漂移）。
 *
 * @module dsc-ui-shell/host-channel
 */
import { applyHostFrame, type HostSnapshot } from '@dsc/ui-core'

/** 连接状态：`connecting` 包含「断了正在自动重连」。 */
export type ChannelStatus = 'connecting' | 'open' | 'closed'

/** 宿主握手帧的内容。 */
export interface HostHello {
  /** 数据通道协议版本。 */
  protocolVersion: number
  /** 宿主放行的方法名（壳据此决定按钮要不要画）。 */
  methods: string[]
  /** 宿主身份。 */
  host: { name: string; version: string }
}

/** 壳看到的宿主通道。 */
export interface HostChannel {
  getSnapshot(): HostSnapshot | null
  getHello(): HostHello | null
  getStatus(): ChannelStatus
  /** 订阅（快照或握手或连接状态变化时叫一次）。 */
  subscribe(listener: () => void): () => void
  /** 调一个宿主方法。 */
  invoke<T = unknown>(method: string, args?: unknown[]): Promise<T>
  /** 主动断开（页面卸载时；正常不需要——EventSource 会自动重连）。 */
  close(): void
}

/** 建立通道。返回后连接是异步建的，状态经 subscribe 观察。 */
export function createHostChannel(): HostChannel {
  let snapshot: HostSnapshot | null = null
  let hello: HostHello | null = null
  let status: ChannelStatus = 'connecting'
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

  const source = new EventSource('/api/events')

  source.addEventListener('hello', (event) => {
    try {
      hello = JSON.parse((event as MessageEvent<string>).data) as HostHello
      status = 'open'
      notify()
    } catch (error) {
      console.error('[ui-shell] 握手帧认不出', error)
    }
  })

  source.addEventListener('frame', (event) => {
    try {
      const raw: unknown = JSON.parse((event as MessageEvent<string>).data)
      snapshot = applyHostFrame(snapshot, raw)
      status = 'open'
      notify()
    } catch (error) {
      // 认不出的帧不进状态：宁可少一帧，也不要画出一份半对不对的界面。
      console.error('[ui-shell] 帧认不出', error)
    }
  })

  source.onopen = () => {
    status = 'open'
    notify()
  }
  // EventSource 出错会自己重连（服务端那句 `retry:` 定的间隔）；这里只把状态报出去。
  source.onerror = () => {
    status = status === 'closed' ? 'closed' : 'connecting'
    notify()
  }

  return {
    getSnapshot: () => snapshot,
    getHello: () => hello,
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async invoke<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
      const response = await fetch('/api/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
      })
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; value?: unknown; error?: string }
        | null
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
      if (payload?.ok !== true) throw new Error(payload?.error ?? '调用失败')
      return payload.value as T
    },
    close() {
      status = 'closed'
      source.close()
      notify()
    },
  }
}
