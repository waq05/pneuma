/**
 * 客户端服务表的补盲（`packages/ui-core/services.ts`）：
 * 非法服务名的两种形状、同名冲突，以及「一个订阅者抛异常不拖垮其它订阅者、但不静默」。
 *
 * @module dsc/packages/ui-core/ui/w12-services.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ServiceConflictError, ServiceRegistry, UndeclaredServiceError } from '../services.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('provide 的入口校验', () => {
  test('空串与非字符串名字都抛 UndeclaredServiceError', () => {
    const registry = new ServiceRegistry()
    expect(() => registry.provide('', 1, 'p1')).toThrow(UndeclaredServiceError)
    expect(() => registry.provide(123 as unknown as string, 1, 'p1')).toThrow(UndeclaredServiceError)
    expect(registry.names()).toEqual([])
  })

  test('同名第二个提供者抛冲突，且把两边插件 id 都写进消息', () => {
    const registry = new ServiceRegistry()
    registry.provide('svc', 1, 'p1')
    expect(() => registry.provide('svc', 2, 'p2')).toThrow(ServiceConflictError)
    try {
      registry.provide('svc', 2, 'p2')
    } catch (error) {
      expect((error as Error).message).toContain('p1')
      expect((error as Error).message).toContain('p2')
    }
  })
})

describe('订阅者隔离', () => {
  test('一个订阅者抛异常：其它订阅者照常收到，异常打到 console.error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = new ServiceRegistry()
    const seen: string[] = []
    registry.subscribe(() => {
      throw new Error('订阅者炸了')
    })
    registry.subscribe(() => {
      seen.push('ok')
    })
    registry.provide('svc', 1, 'p1')
    expect(seen).toEqual(['ok'])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('订阅者'), expect.any(Error))
  })

  test('退订之后不再收到通知', () => {
    const registry = new ServiceRegistry()
    const seen: string[] = []
    const off = registry.subscribe(() => {
      seen.push('hit')
    })
    registry.provide('a', 1, 'p1')
    off()
    registry.provide('b', 2, 'p1')
    expect(seen).toEqual(['hit'])
  })
})
