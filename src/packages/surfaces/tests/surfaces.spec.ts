/**
 * surfaces 包级测试：注册 / 读取 / 退订这条服务形状。
 *
 * 迁移说明：原文件自写 `check()` 计数与打印，整份换成 Vitest 的 `test()`；
 * 每条用例前重新 apply 一次，注册表不跨用例泄漏。
 */
import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, expect, test } from 'vitest'
import { surfacesPlugin } from '../index.js'

/**
 * 测试用的宽松服务形状。
 *
 * 真实 `SurfaceService.register` 把投影 id 收窄成 `keyof RuntimeSurfaces`，而这条测试
 * 验的是注册表本身（任意 id 都该能注册 / 退订），所以按运行时契约声明形状。
 */
interface LooseSurfaceService {
  register(id: string, read: () => unknown): () => void
  build(): Record<string, unknown>
  readonly ids: string[]
}

let service: LooseSurfaceService

beforeEach(() => {
  const ctx = {
    provide(id: string, value: unknown): void {
      expect(id).toBe('surfaces')
      service = value as LooseSurfaceService
    },
  }
  surfacesPlugin.apply(ctx as unknown as Context, undefined)
})

test('注册一片投影，build 里就有它；ids 按注册顺序，退订后两处都没了', () => {
  const first = service.register('session', () => ({ id: 's1' }))
  const second = service.register('todos', () => [])
  expect(service.build()).toStrictEqual({ session: { id: 's1' }, todos: [] })
  expect(service.ids).toStrictEqual(['session', 'todos'])
  first()
  second()
  expect(service.build()).toStrictEqual({})
  expect(service.ids).toStrictEqual([])
})

test('生产函数抛错时沿用上一次的值，不把整帧快照弄没', () => {
  let alive = true
  service.register('waiting', () => {
    if (!alive) throw new Error('boom')
    return 'ok'
  })
  expect(service.build().waiting).toBe('ok')
  alive = false
  expect(service.build().waiting).toBe('ok')
})
