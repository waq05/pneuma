/**
 * `core/dsh-compat/session-events.ts`：事件映射过程中抛错时只写一行 stderr，不把回合带崩。
 *
 * 夹具直接造一座桥（假 ctx + 空会话），投喂一个「取 type 就抛」的内核事件：映射在 try 里
 * 读它，异常正好落进 catch。不碰磁盘、不碰 `~/.dsc`。
 *
 * @module dsc/core/dsh-compat/w14b-session-events-edges.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CoreEvent } from '../events.js'
import { createDshSessionEventBridge } from './session-events.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('publish：映射抛错', () => {
  test('写一行 stderr 后返回，不把异常抛给宿主', () => {
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const dispatched: unknown[] = []
    const bridge = createDshSessionEventBridge({
      ctx: { emit: (...args: unknown[]) => dispatched.push(args) },
      sessionId: 'sess-w14b',
      cwd: 'D:\\work\\w14b',
      route: () => ({ provider: 'p', model: 'm' }),
    })
    const broken = Object.defineProperty({}, 'type', {
      get() {
        throw new Error('事件形状坏了')
      },
    }) as CoreEvent
    expect(() => bridge.publish(broken)).not.toThrow()
    expect(writes.some((line) => line.includes('消息映射失败'))).toBe(true)
    expect(dispatched).toEqual([])
  })
})
