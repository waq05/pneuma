/**
 * waiting 包级测试：any() 的语义——有没有哪张卡片正挂着等用户。
 *
 * 迁移说明：原文件自写 `check()` 计数与打印，整份换成 Vitest 的 `test()`；
 * 每条用例前重新 apply 一次，服务状态不跨用例泄漏。
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

test('没人登记时 any() 为假；登记一张挂起的卡片后为真，ids 列出它', () => {
  expect(service.any).toBe(false)
  const off = service.register('approval', () => true)
  expect(service.any).toBe(true)
  expect(service.ids).toStrictEqual(['approval'])
  off()
  expect(service.any).toBe(false)
})

test('卡片自己算崩了、或者已经答完（false），都不算有人在等', () => {
  const boom = service.register('question', () => {
    throw new Error('boom')
  })
  const done = service.register('plan', () => false)
  expect(service.any).toBe(false)
  boom()
  done()
})

test('退订只撤自己那一份', () => {
  const off = service.register('approval', () => true)
  service.register('question', () => true)
  off()
  expect(service.ids).toStrictEqual(['question'])
  expect(service.any).toBe(true)
})
