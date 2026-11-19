/**
 * 右侧栏「收不收栏」的模型行为（迁自 `scripts/ui-dock-close-test.mjs` 全部五段）。
 *
 * 两个报障现场：10-27 只开「开始」一张页签时点 ✕ 没反应（closeTab 当时只补一张新
 * guide、栏也不收）；10-28 「旁问」与「开始」都开着时关掉「旁问」，整块栏跟着收起
 * ——根因是把口径定成「整块栏只剩 guide 就收起」，把旁边还开着的「开始」一起算了
 * 「没有真内容」。`closeTab` / `setExpanded` / `splitPane` 是零 React 零 DOM 的纯
 * 模块出口，真跑结果就是被测行为。
 *
 * 为什么与 `dock-model.spec.ts` 分文件：那边迁的是页签报名表的生命周期
 * （`ui-plugin-disable-test`），这边迁的是关页签与收栏口径（`ui-dock-close-test`），
 * 一条探针一个来源，谁红了能直接对回探针段号。
 *
 * @module dsc-ui-dockkit/ui/dock-close.spec
 */
import { describe, expect, test } from 'vitest'
import type { DockSurface, DockTab } from './dock-model.js'
import { closeTab, defaultSurface, makeTab, setExpanded, splitPane } from './dock-model.js'

/** 往某一格里塞一张指定 kind 的页签并激活它（与用户点开一个入口同形）。 */
function addTab(
  surface: DockSurface,
  paneId: string,
  kind: Parameters<typeof makeTab>[0],
  patch: Partial<DockTab> = {},
): { surface: DockSurface; tab: DockTab } {
  const tab = { ...makeTab(kind), ...patch }
  return {
    surface: {
      ...surface,
      panes: surface.panes.map((entry) =>
        entry.id === paneId ? { ...entry, tabs: [...entry.tabs, tab], activeTabId: tab.id } : entry,
      ),
    },
    tab,
  }
}

/** 每格页签 kind 的速记（断言输出用）。 */
const kindsOf = (surface: DockSurface, paneIndex = 0): string =>
  surface.panes[paneIndex]!.tabs.map((tab) => tab.kind).join(',')

describe('① 单格只剩「开始」：关掉 = 收起侧栏', () => {
  test('关掉唯一的 guide 后侧栏收起，栏架子还在、补的是新的「开始」门面', () => {
    const surface = setExpanded(defaultSurface(), true)
    const guide = surface.panes[0]!.tabs[0]!
    const closed = closeTab(surface, guide.id)
    expect(closed.expanded).toBe(false)
    expect(closed.panes).toHaveLength(1)
    expect(closed.panes[0]!.tabs).toHaveLength(1)
    expect(closed.panes[0]!.tabs[0]!.kind).toBe('guide')
    // 旧 guide 的 id 已经不在（补的是新门面，不是同一张复用）。
    expect(closed.panes[0]!.tabs[0]!.id).not.toBe(guide.id)
  })
})

describe('② 单格还有真内容：关一张不收栏', () => {
  test('还有终端在，侧栏照旧展开；终端被激活；没有多塞一张 guide', () => {
    let surface = setExpanded(defaultSurface(), true)
    const paneId = surface.panes[0]!.id
    const terminalAdded = addTab(surface, paneId, 'terminal')
    surface = terminalAdded.surface
    const browserAdded = addTab(surface, paneId, 'browser')
    surface = browserAdded.surface
    const terminal = terminalAdded.tab
    const browser = browserAdded.tab
    const closed = closeTab(surface, browser.id)
    expect(closed.expanded).toBe(true)
    expect(closed.panes[0]!.tabs.some((tab) => tab.id === terminal.id)).toBe(true)
    expect(closed.panes[0]!.activeTabId).toBe(terminal.id)
    expect(closed.panes[0]!.tabs.filter((tab) => tab.kind === 'guide')).toHaveLength(1)
  })
})

describe('③ 「开始」+「旁问」：关掉「旁问」，栏留着、开始页还在（10-28 报障本体）', () => {
  test('关掉旁问后侧栏仍展开，「开始」还在且被激活', () => {
    let surface = setExpanded(defaultSurface(), true)
    const guide = surface.panes[0]!.tabs[0]!
    const askAdded = addTab(surface, surface.panes[0]!.id, 'ask')
    surface = askAdded.surface
    expect(kindsOf(surface)).toBe('guide,ask')
    const closed = closeTab(surface, askAdded.tab.id)
    expect(closed.expanded).toBe(true)
    expect(closed.panes[0]!.tabs).toHaveLength(1)
    expect(closed.panes[0]!.tabs[0]!.id).toBe(guide.id)
    expect(closed.panes[0]!.activeTabId).toBe(guide.id)
  })
})

describe('④ 分栏：清空一格、另一格只剩门面 → 只补门面、不收栏', () => {
  test('关掉右格的终端：两格都还在，清空的那格补 guide，栏不收', () => {
    let surface = setExpanded(defaultSurface(), true)
    const left = surface.panes[0]!.id
    const termAdded = addTab(surface, left, 'terminal')
    surface = termAdded.surface
    const term = termAdded.tab
    surface = splitPane(surface, left) // 终端搬去右格，左格补 guide
    const right = surface.panes[1]!.id
    expect(surface.panes).toHaveLength(2)
    const closed = closeTab(surface, term.id)
    expect(closed.expanded).toBe(true)
    expect(closed.panes).toHaveLength(2)
    const emptied = closed.panes.find((pane) => pane.id === right)
    expect(emptied?.tabs).toHaveLength(1)
    expect(emptied?.tabs[0]!.kind).toBe('guide')
  })
})

describe('⑤ 负向自证：展开态没被误改成收起（真内容在）', () => {
  test('关掉两张里的第一张：侧栏仍展开，剩的那张还在且被激活', () => {
    let surface = setExpanded(defaultSurface(), true)
    const left = surface.panes[0]!.id
    const aAdded = addTab(surface, left, 'terminal')
    surface = aAdded.surface
    const bAdded = addTab(surface, left, 'files')
    surface = bAdded.surface
    const a = aAdded.tab
    const b = bAdded.tab
    const closed = closeTab(surface, a.id)
    expect(closed.expanded).toBe(true)
    expect(closed.panes[0]!.tabs.some((tab) => tab.id === b.id)).toBe(true)
    expect(closed.panes[0]!.activeTabId).toBe(b.id)
  })
})
