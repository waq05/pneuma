/**
 * waiting 收尾缺口（`packages/waiting/index.ts:65`）：按会话口径的 `anyFor(owner)`。
 *
 * 全进程口径的 `any` 已有测试；这里补的是「把归属透传给每张登记的判定」这条路径：
 * 登记方收 owner 后自己决定算不算，`anyFor` 只负责原样转发并短路。
 * 假 ctx 与既有 `waiting.spec.ts` 同形，只收 `provide`。
 *
 * @module @pneuma/waiting/tests/w14-any-for.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WaitingService } from '@pneuma/runtime/services/types.js'
import { beforeEach, expect, test } from 'vitest'
import { waitingPlugin } from '../index.js'

let service: WaitingService

beforeEach(() => {
  const ctx = {
    provide(id: string, value: unknown): void {
      expect(id).toBe('waiting')
      service = value as WaitingService
    },
  }
  waitingPlugin.apply(ctx as unknown as Context, undefined)
})

test('anyFor(owner) 把归属透传给登记方：只认那条会话的卡', () => {
  const seen: Array<string | undefined> = []
  const off = service.register('approval', (owner) => {
    seen.push(owner)
    return owner === 'session-a'
  })

  expect(service.anyFor('session-a')).toBe(true)
  expect(service.anyFor('session-b')).toBe(false)
  expect(seen).toEqual(['session-a', 'session-b'])

  off()
  expect(service.anyFor('session-a')).toBe(false)
})

test('不区分会话的老登记方（忽略 owner 一律 true）对所有会话都算在等', () => {
  const off = service.register('legacy', () => true)
  expect(service.anyFor('session-a')).toBe(true)
  // 全进程口径同样为真，两套口径不打架。
  expect(service.any).toBe(true)
  off()
  expect(service.anyFor('session-a')).toBe(false)
})
