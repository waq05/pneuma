/**
 * @pneuma/cdp 的包级测试：RingBuffer 的行为 + 库包的清单形状。
 *
 * 为什么只钉这些：这个包是 CDP 底层库，真正的价值在把 Chrome 的消息按环形缓冲留下、
 * 并且按 id 找回去；清单形状决定它作为库包能不能被正确发布与引用。
 *
 * 迁移说明：原测试读 `lib/` 产物并自己打印 PASS/FAIL，现改为直接 import 源码，
 * 断言换成 Vitest；用例拆成「丢弃最旧」与「容量收缩」两条，行为粒度更清楚。
 *
 * @module @pneuma/cdp/tests
 */
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { RingBuffer } from '../ring-buffer.js'

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  exports: Record<string, string | { default?: string }>
  pneuma: { library?: boolean; bundle?: unknown; order?: number }
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson

// 第 1 条：环形缓冲满了以后丢最旧的，留下的顺序与入队顺序一致，并且能按条件找回。
test('环形缓冲满了丢最旧的，find 按条件取回条目', () => {
  const buffer = new RingBuffer<{ requestId: string }>(2)
  for (const n of [1, 2, 3]) buffer.push({ requestId: `r${n}` })
  expect(buffer.size).toBe(2)
  expect(buffer.toArray()).toStrictEqual([{ requestId: 'r2' }, { requestId: 'r3' }])
  expect(buffer.find((item) => item.requestId === 'r3')).toStrictEqual({ requestId: 'r3' })
  // 被挤掉的那条真的没了：按 id 找回去必须是 undefined，而不是还回一份旧对象。
  expect(buffer.find((item) => item.requestId === 'r1')).toBeUndefined()
})

// 第 2 条：改容量只截最旧的（保留最近的那几条），clear 之后 size 归零。
test('resize 只截最旧的，clear 清空', () => {
  const buffer = new RingBuffer<{ requestId: string }>(3)
  for (const n of [1, 2, 3]) buffer.push({ requestId: `r${n}` })
  buffer.resize(1)
  expect(buffer.toArray()).toStrictEqual([{ requestId: 'r3' }])
  buffer.clear()
  expect(buffer.size).toBe(0)
  expect(buffer.toArray()).toStrictEqual([])
})

// 第 3 条：库包清单——没有 cordis.patch.yml、没有 bundle、没有 order。
test('库包清单：library 为真，没有 cordis.patch.yml / bundle / order', () => {
  expect(manifest.pneuma.library).toBe(true)
  expect(existsSync(new URL('../cordis.patch.yml', import.meta.url))).toBe(false)
  expect(manifest.pneuma.bundle).toBeUndefined()
  expect(manifest.pneuma.order).toBeUndefined()
})

// 第 4 条：模块子路径的导出键与目标一字不差，且都指向包内真实存在的那份模块。
test('模块子路径导出键与目标一字不差，且指向包内真实模块', () => {
  const modules = Object.entries(manifest.exports).filter(
    ([key]) => key.startsWith('./') && key !== './package.json' && !key.includes('*'),
  )
  expect(modules.map(([key]) => key)).toContain('./ring-buffer.js')
  for (const [key, target] of modules) {
    expect(target, `${key} 的目标应当同名`).toBe(key)
  }
})
