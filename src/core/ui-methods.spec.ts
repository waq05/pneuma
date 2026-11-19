/**
 * 界面方法白名单与手机 remote 面的通道可用性（迁自 `scripts/ui-sidebar-footer-test.mjs`
 * 第 [3] 段）。
 *
 * 背景：侧栏页脚的「今日总用量」走宿主 `usageStats` 通道取数，这条通道有两个消费面——
 * 桌面界面白名单（`core/ui-methods.ts` 的 `UI_METHODS`）与手机 remote 面
 * （`packages/remote/types.ts` 的 `REMOTE_METHODS`）。哪一边摘了它，哪一边的页脚断量，
 * 而且只表现为「那一块永远空着」，没有任何报错——所以钉在公开数据面上。
 *
 * 为什么是行为测试而不是文本钉：两个白名单都是导出的常量表（`UI_METHODS` 是带类型收窄
 * 的元组，`isUiMethod` 是运行时判定函数；`REMOTE_METHODS` 同），对导出对象断言成员就是
 * 方案 A——原探针的「includes('usageStats')」文本查找与「脏副本必须红」在这里退化成
 * `toContain` / `toBe(true)`，判据强度不变。
 *
 * @module dsc/core/ui-methods.spec
 */
import { describe, expect, test } from 'vitest'
import { UI_METHOD_SET, UI_METHODS, isUiMethod } from './ui-methods.js'
import { REMOTE_METHODS, REMOTE_SET } from '../packages/remote/types.js'

describe('桌面界面白名单放行 usageStats（页脚今日总用量的取数通道）', () => {
  test("UI_METHODS 里有 'usageStats'", () => {
    expect(UI_METHODS).toContain('usageStats')
  })

  test('isUiMethod 认它（host-stdio 白名单的运行时判定走的就是这个）', () => {
    expect(isUiMethod('usageStats')).toBe(true)
    expect(UI_METHOD_SET.has('usageStats')).toBe(true)
  })
})

describe('手机 remote 面放行 usageStats（遥控页的今日用量）', () => {
  test("REMOTE_METHODS 里有 'usageStats'，REMOTE_SET 认它", () => {
    expect(REMOTE_METHODS).toContain('usageStats')
    expect(REMOTE_SET.has('usageStats')).toBe(true)
  })
})
