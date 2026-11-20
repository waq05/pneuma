/**
 * `core/ui-events.ts`：旁问通道在「连接已经结束」时广播，要摘掉连接而不是往上写。
 *
 * 用假 `ServerResponse` 驱动真正的 `handleEvents` 入口（与 `w13-ui-events-extra.spec.ts`
 * 同一套夹具）：这条分支只在一个已经断开的响应对象上才走得到。
 *
 * @module dsc/core/w14b-ui-events-edges.spec
 */
import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createUiEvents, type UiEventsHandle } from './ui-events.js'
import type { FrameInput } from './remote/frames.js'

/** 一个够通道用的假响应。 */
class FakeRes extends EventEmitter {
  writableEnded = false
  destroyed = false
  body = ''

  writeHead(): this {
    return this
  }

  write(chunk: string): boolean {
    this.body += chunk
    return true
  }

  end(): this {
    this.writableEnded = true
    return this
  }
}

/** 一个够 `handleEvents` 用的假请求。 */
class FakeReq extends EventEmitter {
  url = '/api/events'
  headers: Record<string, string> = {}
  method = 'GET'
}

/** 把一条假连接登记进通道（走真正的入口）。 */
function registerFake(events: UiEventsHandle): FakeRes {
  const res = new FakeRes()
  events.handleEvents(new FakeReq() as unknown as IncomingMessage, res as unknown as ServerResponse)
  return res
}

/** 一份静态快照。 */
function snapshot(): FrameInput & Record<string, unknown> {
  return { sessionId: 'sess-w14b', entries: [], liveEntries: [] } as unknown as FrameInput & Record<string, unknown>
}

describe('旁问广播：连接已结束', () => {
  test('writableEnded / destroyed 的连接都摘掉，不写事件', () => {
    const askListeners: Array<(chunk: unknown) => void> = []
    const events = createUiEvents({
      snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: () => () => {},
      ask: {
        subscribe: (listener) => {
          askListeners.push(listener)
          return () => {}
        },
      },
      heartbeatMs: 60_000,
      log: () => {},
    })
    const ended = registerFake(events)
    ended.writableEnded = true
    askListeners[0]?.({ delta: 'x' })
    expect(events.clients).toBe(0)

    const destroyed = registerFake(events)
    destroyed.destroyed = true
    askListeners[0]?.({ delta: 'y' })
    expect(events.clients).toBe(0)
    expect(destroyed.body).not.toContain('event: ask')
    events.stop()
  })
})
