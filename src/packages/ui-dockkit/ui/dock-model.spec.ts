/**
 * 页签报名表的生命周期（迁自 `scripts/ui-plugin-disable-test.mjs` 第 [1]、[2] 段）。
 *
 * 报障现场：在插件中心停用「旁问（界面）」之后，开始页的入口卡还在、已开的页签还在。
 * 根因是「页签报名没有生命周期」。这两段压的正是生命周期本身：
 *   ① 报名表决定「有没有这一种页签 / 这张入口卡」：没人报名时壳不认识 ask（开不出、
 *      查不到、入口卡没有）；报名（= 插件 apply）后两份都出现；停用（= cleanup）后
 *      两份都消失、再开被拦；热更换装的旧 cleanup 不能删掉新的一份；
 *   ② 撤销同时清页签：不能留一张渲染不出内容的空壳——整格只剩该 kind 时补一张
 *      开始页，分栏两格各一张时两格都补，侧栏不因停用被顺手收起。
 *
 * 为什么是行为测试而不是文本钉：`dock-model.ts` 是纯模块（只 import react 类型），
 * `registerDockTab` / `removeKindTabs` 的真跑结果就是被测行为。原探针 [3]–[6] 段
 * （真实产物 client.js 审计、dock/runtime 接线文本钉、宿主启停链路）不迁：
 * 产物审计要 `pnpm run build:ui` 的 `lib/ui/**`（vitest 只解析 src），文本钉按手册 §2
 * 属必删项——见交付报告的缺口清单。
 *
 * 报名表是模块级状态：本文件的用例按顺序共用它（先基线、再报名、再撤销、再竞态），
 * 每段自己收尾，不给别的 describe 留残留。
 *
 * @module dsc-ui-dockkit/ui/dock-model.spec
 */
import { describe, expect, test } from 'vitest'
import type { DockSurface } from './dock-model.js'
import {
  defaultSurface,
  dockGuideEntries,
  dockTabKinds,
  dockTabMeta,
  makeTab,
  openTab,
  registerDockTab,
  removeKindTabs,
} from './dock-model.js'

/** 一张「刚报名」的 ask 元数据（与 ui-ask 真正交的那份同形）。 */
function metaOf(patch: Partial<Parameters<typeof registerDockTab>[0]> = {}): Parameters<typeof registerDockTab>[0] {
  return {
    kind: 'ask',
    label: '旁问',
    component: () => null,
    keepMounted: true,
    guide: { title: '旁问', description: '只读问答，不写主会话', tone: 'tone-ask', shortcut: 'Ctrl + Shift + K' },
    ...patch,
  }
}

/** 往第一格里塞一张页签（与用户点开始页入口卡的结果同形）。 */
function withTab(surface: DockSurface, kind: Parameters<typeof makeTab>[0]): { surface: DockSurface; active: string } {
  const pane = surface.panes[0]!
  const tab = makeTab(kind)
  return {
    surface: {
      ...surface,
      panes: [{ ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id }],
    },
    active: tab.id,
  }
}

/** 每格页签 kind 的速记（断言输出用）。 */
const kindsOf = (surface: DockSurface): string =>
  surface.panes.map((pane) => pane.tabs.map((tab) => tab.kind).join(',')).join(' | ')

describe('① 报名表决定「有没有这一种页签 / 这张入口卡」', () => {
  test('基线：没人报名时，壳不认识 ask', () => {
    expect(dockTabKinds().some((meta) => meta.kind === 'ask')).toBe(false)
    expect(dockGuideEntries().some((card) => card.tone === 'tone-ask')).toBe(false)
    const before = defaultSurface()
    expect(openTab(before, 'ask')).toBe(before)
  })

  test('报名后：页签类型、入口卡、chip 元数据都出现，openTab 开得出', () => {
    const off = registerDockTab(metaOf())
    try {
      expect(dockTabKinds().some((meta) => meta.kind === 'ask')).toBe(true)
      const guide = dockGuideEntries().find((card) => card.tone === 'tone-ask')
      expect(guide?.title).toBe('旁问')
      expect(guide?.shortcut).toBe('Ctrl + Shift + K')
      expect(dockTabMeta('ask')?.label).toBe('旁问')
      expect(dockTabMeta('ask')?.keepMounted).toBe(true)
      const before = defaultSurface()
      const opened = openTab(before, 'ask')
      expect(opened).not.toBe(before)
      expect(opened.panes[0]?.tabs.some((tab) => tab.kind === 'ask')).toBe(true)

      // 停用（= 插件卸载时调 cleanup）→ 两份都没了，再开就被拦。
      off()
      expect(dockTabKinds().some((meta) => meta.kind === 'ask')).toBe(false)
      expect(dockGuideEntries().some((card) => card.tone === 'tone-ask')).toBe(false)
      expect(openTab(opened, 'ask')).toBe(opened)
      expect(dockTabMeta('ask')).toBeUndefined()
    } finally {
      // 双保险：断言失败也不能把 ask 留在报名表里污染后面的用例。
      if (dockTabMeta('ask') !== undefined) off()
    }
  })

  test('热更换装：旧的一份 cleanup 跑在新一份报名之后，不能把新的删掉', () => {
    const first = registerDockTab(metaOf({ label: '旧' }))
    const second = registerDockTab(metaOf({ label: '新' }))
    first()
    expect(dockTabMeta('ask')?.label).toBe('新')
    second()
    expect(dockTabMeta('ask')).toBeUndefined()
  })
})

describe('② 撤销同时清页签：不能留一张渲染不出内容的空壳', () => {
  test('现场形态：开始页 + 旁问两张，撤掉后只剩开始页、激活回到它、侧栏不收', () => {
    const off = registerDockTab(metaOf())
    try {
      const { surface, active } = withTab(defaultSurface(), 'ask')
      const pruned = removeKindTabs(surface, 'ask')
      expect(kindsOf(pruned)).toBe('guide')
      expect(pruned.panes[0]?.tabs.some((tab) => tab.id === pruned.panes[0]?.activeTabId)).toBe(true)
      expect(pruned.panes[0]?.activeTabId).not.toBe(active)
      expect(pruned.expanded).toBe(surface.expanded)
    } finally {
      off()
    }
  })

  test('整格只有旁问：撤掉后补一张开始页，且栏不收起', () => {
    const off = registerDockTab(metaOf())
    try {
      const { surface, active } = withTab(defaultSurface(), 'ask')
      const only: DockSurface = {
        ...surface,
        panes: [
          {
            ...surface.panes[0]!,
            tabs: surface.panes[0]!.tabs.filter((tab) => tab.kind === 'ask'),
            activeTabId: active,
          },
        ],
        expanded: true,
      }
      const emptied = removeKindTabs(only, 'ask')
      expect(kindsOf(emptied)).toBe('guide')
      expect(emptied.expanded).toBe(true)
    } finally {
      off()
    }
  })

  test('分栏两格各一张旁问：两格都补开始页，不能把另一格留空', () => {
    const off = registerDockTab(metaOf())
    try {
      const split: DockSurface = {
        ...defaultSurface(),
        panes: [
          { id: 'p1', tabs: [makeTab('guide'), makeTab('ask')], activeTabId: '' },
          { id: 'p2', tabs: [makeTab('ask'), makeTab('terminal')], activeTabId: '' },
        ],
        activePaneId: 'p1',
        expanded: true,
      }
      const fixed: DockSurface = {
        ...split,
        panes: split.panes.map((pane) => ({ ...pane, activeTabId: pane.tabs[pane.tabs.length - 1]!.id })),
      }
      const afterSplit = removeKindTabs(fixed, 'ask')
      expect(afterSplit.panes.every((pane) => pane.tabs.length > 0)).toBe(true)
      expect(kindsOf(afterSplit)).toBe('guide | terminal')
    } finally {
      off()
    }
  })
})
