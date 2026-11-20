/**
 * 输入区两组相等判断的补测（ui 层）：`sameQueued` 与 `sameNotices`。
 *
 * 既有 `git-branch.spec.ts` / 组件渲染批只走主路径（长度相同、逐字段相同 → true）。
 * 这里补上三条「没变之外」的分支，它们决定快照每帧换引用时要不要重画输入区：
 *
 *  - 长度不同立刻 false（不逐项比）；
 *  - 同长度但某一项内容不同 → false（队列比 index / text / images，通知比 index / text）；
 *  - 右侧是同长度的稀疏数组（该下标是洞）→ 拿到 undefined，给 false 而不是抛。
 *
 * 顺带钉住纯函数：同一引用（宿主把同一个数组递回来）直接 true。
 *
 * @module dsc-ui-composer/ui/w13-surfaces.spec
 */
import { describe, expect, test } from 'vitest'
import type { NoticeMessageView, QueuedMessageView } from '@dsc/ui'
import { sameNotices, sameQueued } from './surfaces.js'

const queued = (over: Partial<QueuedMessageView> = {}): QueuedMessageView =>
  ({ index: 0, text: '你好', ...over }) as QueuedMessageView

describe('sameQueued：内容没变才不重画', () => {
  test('同一引用直接 true（不逐项比）', () => {
    const list = [queued()]
    expect(sameQueued(list, list)).toBe(true)
  })

  test('长度不同立刻 false', () => {
    expect(sameQueued([queued()], [queued(), queued({ index: 1 })])).toBe(false)
    expect(sameQueued([], [queued()])).toBe(false)
  })

  test('同长度但下标 / 正文 / 图片任一项不同 → false；图片顺序算内容', () => {
    expect(sameQueued([queued({ index: 1 })], [queued({ index: 2 })])).toBe(false)
    expect(sameQueued([queued({ text: 'a' })], [queued({ text: 'b' })])).toBe(false)
    expect(
      sameQueued([queued({ images: ['a.png'] })], [queued({ images: ['b.png'] })]),
    ).toBe(false)
    expect(
      sameQueued([queued({ images: ['a.png', 'b.png'] })], [queued({ images: ['b.png', 'a.png'] })]),
    ).toBe(false)
    // 都没有图片 = 同一个空串，算相同。
    expect(sameQueued([queued()], [queued()])).toBe(true)
  })

  test('右侧同长度稀疏数组（该下标是洞）：拿到 undefined 给 false，不抛', () => {
    const sparse = new Array<QueuedMessageView>(1)
    expect(sameQueued([queued()], sparse)).toBe(false)
  })
})

describe('sameNotices：通知只比下标与正文', () => {
  const notice = (over: Partial<NoticeMessageView> = {}): NoticeMessageView =>
    ({ index: 0, text: '机器通知', ...over }) as NoticeMessageView

  test('同一引用直接 true；长度不同立刻 false', () => {
    const list = [notice()]
    expect(sameNotices(list, list)).toBe(true)
    expect(sameNotices([notice()], [notice(), notice({ index: 1 })])).toBe(false)
  })

  test('下标或正文不同 → false；完全一致 → true', () => {
    expect(sameNotices([notice({ index: 1 })], [notice({ index: 2 })])).toBe(false)
    expect(sameNotices([notice({ text: 'a' })], [notice({ text: 'b' })])).toBe(false)
    expect(sameNotices([notice()], [notice()])).toBe(true)
  })

  test('右侧同长度稀疏数组（该下标是洞）：拿到 undefined 给 false', () => {
    expect(sameNotices([notice()], new Array<NoticeMessageView>(1))).toBe(false)
  })
})
