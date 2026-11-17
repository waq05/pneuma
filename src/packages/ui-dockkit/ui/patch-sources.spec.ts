/**
 * 补丁快照表的语义（迁自 `scripts/ui-status-panel-test.mjs` 第 [8] 段里有接缝的那部分）。
 *
 * 原探针这一段钉的是「补丁源是独立纯模块 + 快照表按**页签 id** 存（P0-11）」。
 * 前者（导出五个口）由本文件的 import 本身证明：少导出一个，这里先编不过；
 * 后者换成真行为判定——同一份文件的两张页签各记各的快照、关一张不串另一张、
 * 清死页签以全量布局为存活凭据、通知只发给订阅者。
 *
 * 没迁的（原探针同段的源码文本钉，按手册 §2 属必删项）：`dock-state.ts` 里
 * `setDockPreview` / `setDockFileView` 的接线正则、`forgetDeadPatches` 调用次数、
 * preview 插件的页签报名文本——它们钉「文件里怎么写」；`liveTabIds()` 扫全部会话
 * 这一条的真实行为要在布局层（渲染批）验。见交付报告缺口清单。
 *
 * 表是模块级状态：每条用例自己铺、自己收（`forgetDeadPatches([])` 清场），
 * 不给同文件后面的用例留残留。
 *
 * @module dsc-ui-dockkit/ui/patch-sources.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ChangedFileView } from '@dsc/ui-core'
import { forgetDeadPatches, forgetPatch, patchOf, rememberPatch, subscribePatches } from './patch-sources.js'

/** 造一份差异快照；hunks 内容由调用方挑（判定「两份快照互不串台」靠它区分）。 */
function patchOf2(path: string, marker: string): ChangedFileView {
  return { path, added: 1, removed: 0, hunks: [], status: 'modified', truncated: false, note: marker } as ChangedFileView
}

afterEach(() => {
  forgetDeadPatches([])
  vi.restoreAllMocks()
})

describe('快照表按页签 id 存（P0-11：不是按路径的 Map）', () => {
  test('同一份文件的两张页签各记各的：关一张不串另一张', () => {
    rememberPatch('tab-1', patchOf2('D:\\w\\a.ts', '第一刀'))
    rememberPatch('tab-2', patchOf2('D:\\w\\a.ts', '第二刀'))
    // path 相同、页签不同：按路径记的实现会让两张页签读到同一份（后记的赢）。
    expect((patchOf('tab-1') as ChangedFileView & { note?: string }).note).toBe('第一刀')
    expect((patchOf('tab-2') as ChangedFileView & { note?: string }).note).toBe('第二刀')

    forgetPatch('tab-1')
    expect(patchOf('tab-1')).toBeNull()
    expect((patchOf('tab-2') as ChangedFileView & { note?: string }).note).toBe('第二刀')
  })

  test('没记过的页签给 null（重启后补丁页签显示「已过期」，不抛）', () => {
    expect(patchOf('tab-none')).toBeNull()
  })

  test('同一张页签再记 = 换成最新那一刀', () => {
    rememberPatch('tab-3', patchOf2('D:\\w\\b.ts', '旧'))
    rememberPatch('tab-3', patchOf2('D:\\w\\b.ts', '新'))
    expect((patchOf('tab-3') as ChangedFileView & { note?: string }).note).toBe('新')
  })

  test('空页签 id 不入表（没有页签的快照没有归属）', () => {
    rememberPatch('', patchOf2('D:\\w\\c.ts', '孤儿'))
    expect(patchOf('')).toBeNull()
  })
})

describe('清死页签以全量布局为存活凭据', () => {
  test('存活集合里的留下，集合外的清掉', () => {
    rememberPatch('live-1', patchOf2('D:\\w\\a.ts', '活'))
    rememberPatch('live-2', patchOf2('D:\\w\\b.ts', '也活'))
    rememberPatch('dead-1', patchOf2('D:\\w\\c.ts', '死'))
    forgetDeadPatches(['live-1', 'live-2'])
    expect(patchOf('live-1')).not.toBeNull()
    expect(patchOf('live-2')).not.toBeNull()
    expect(patchOf('dead-1')).toBeNull()
  })

  test('收 Iterable：另一个会话的页签 id 并进存活集合就保留（切会话不清别的会话）', () => {
    rememberPatch('session-a-tab', patchOf2('D:\\w\\a.ts', 'A 会话'))
    rememberPatch('current-tab', patchOf2('D:\\w\\b.ts', '当前'))
    // 只扫当前布局的话，A 会话那条会被误清（P-1）。
    forgetDeadPatches(['current-tab', 'session-a-tab'])
    expect(patchOf('session-a-tab')).not.toBeNull()
    expect(patchOf('current-tab')).not.toBeNull()
  })
})

describe('订阅：变化通知只发给订阅者', () => {
  test('remember / forget 都喊一嗓子；forget 没删到东西不喊', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePatches(listener)
    try {
      rememberPatch('sub-1', patchOf2('D:\\w\\a.ts', '记'))
      expect(listener).toHaveBeenCalledTimes(1)
      forgetPatch('sub-1')
      expect(listener).toHaveBeenCalledTimes(2)
      forgetPatch('sub-1')
      expect(listener).toHaveBeenCalledTimes(2)
      forgetDeadPatches([])
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
  })

  test('退订之后不再收通知', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePatches(listener)
    unsubscribe()
    rememberPatch('sub-2', patchOf2('D:\\w\\a.ts', '退订后'))
    expect(listener).not.toHaveBeenCalled()
  })
})
