/**
 * 右侧栏纯模型（`dock-model.ts`）的边界补测。
 *
 * 既有 `dock-model.spec.ts` 只压报名表的生命周期与「撤销后补门面」两条主干。这一份补它
 * 没走到的分支：单例/去重/替换门面、预览上限淘汰、关页签的邻位与收起、分栏与并回、
 * 跨格拖拽的落点夹取、宽比夹取、通知订阅，以及持久化解析对每一种坏形状的拒绝。
 *
 * 全是纯函数：不渲染、不碰 React，断言返回值与不变量（引用相等也当断言用——「没变化
 * 就原样返回」是这些 reducer 的约定）。
 *
 * @module dsc-ui-dockkit/ui/dock-model-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DockPane, DockSurface } from './dock-model.js'
import {
  activePane,
  canAddTab,
  closeTab,
  defaultSurface,
  dockGuideEntries,
  dockTabKinds,
  dockTabMeta,
  focusPane,
  focusTab,
  loadSurfaces,
  makeTab,
  openBrowserTab,
  openPatch,
  openPreview,
  openSubagent,
  openTab,
  openWorkOutput,
  paneOf,
  placeTab,
  registerDockTab,
  removeKindTabs,
  saveSurfaces,
  setExpanded,
  setFraction,
  setTabInfo,
  splitPane,
  subscribeDockKinds,
  toggleMode,
  unsplitPane,
} from './dock-model.js'

const STORAGE_KEY = 'dsc.dock.surfaces'

/** 手工铺一份布局：一个窗格、给定 kinds，第一张为激活。 */
function surfaceWith(kinds: string[], extra: Partial<DockSurface> = {}): DockSurface {
  const tabs = kinds.map((kind, index) => ({ id: `seed-${String(index)}-${kind}`, kind }))
  const pane: DockPane = { id: 'pane-a', tabs, activeTabId: tabs[0]?.id ?? '' }
  return { panes: [pane], activePaneId: 'pane-a', fraction: 0.5, expanded: false, mode: 'push', ...extra }
}

/** 两格布局（每格至少一张）。 */
function twoPanes(leftKinds: string[], rightKinds: string[], extra: Partial<DockSurface> = {}): DockSurface {
  const pane = (id: string, kinds: string[]): DockPane => {
    const tabs = kinds.map((kind, index) => ({ id: `${id}-${String(index)}-${kind}`, kind }))
    return { id, tabs, activeTabId: tabs[0]?.id ?? '' }
  }
  const left = pane('pane-a', leftKinds)
  const right = pane('pane-b', rightKinds)
  return { panes: [left, right], activePaneId: left.id, fraction: 0.5, expanded: true, mode: 'push', ...extra }
}

const kindsOf = (surface: DockSurface): string =>
  surface.panes.map((pane) => pane.tabs.map((tab) => tab.kind).join(',')).join(' | ')

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('makeTab / defaultSurface / 读面辅助', () => {
  test('makeTab：路径与指名 id 都照用，空 id 退回自造；defaultSurface 一张门面且不可再加', () => {
    const withPath = makeTab('preview', 'D:/a.ts')
    expect(withPath.kind).toBe('preview')
    expect(withPath.path).toBe('D:/a.ts')
    expect(withPath.id).not.toBe('')

    const named = makeTab('browser', 'https://a', 'agent-1')
    expect(named.id).toBe('agent-1')
    expect(makeTab('browser', undefined, '').id).not.toBe('')

    const surface = defaultSurface()
    expect(surface.panes).toHaveLength(1)
    expect(surface.panes[0]?.tabs.map((tab) => tab.kind)).toEqual(['guide'])
    expect(surface.activePaneId).toBe(surface.panes[0]?.id)
    expect(surface.panes[0]?.activeTabId).toBe(surface.panes[0]?.tabs[0]?.id)
    expect(surface.fraction).toBe(0.5)
    expect(surface.expanded).toBe(false)
    expect(surface.mode).toBe('push')
    expect(canAddTab(surface.panes[0]!)).toBe(false)
  })

  test('activePane：activePaneId 指向不存在的格时回落第一格；paneOf 查不到给 undefined', () => {
    const surface = twoPanes(['guide'], ['terminal'], { activePaneId: 'ghost' })
    expect(activePane(surface).id).toBe('pane-a')
    expect(paneOf(surface, 'ghost')).toBeUndefined()
    expect(canAddTab(surface.panes[1]!)).toBe(true)
  })
})

describe('openTab：门面替换 / 单例 / 未报名', () => {
  test('没报名的 kind 不开、原样返回；报名后追加并激活', () => {
    const before = surfaceWith(['guide'])
    expect(openTab(before, 'extra-kind')).toBe(before)

    const off = registerDockTab({ kind: 'extra-kind', label: '额外', component: (() => null) as never })
    try {
      const after = openTab(before, 'extra-kind')
      expect(kindsOf(after)).toBe('guide,extra-kind')
      expect(after.panes[0]?.activeTabId).toBe(after.panes[0]?.tabs[1]?.id)
    } finally {
      off()
    }
  })

  test('replaceGuide：就地换掉门面；没有门面时原样返回', () => {
    const off = registerDockTab({ kind: 'extra-replace', label: '替换', component: (() => null) as never })
    try {
      const withGuide = surfaceWith(['guide', 'terminal'])
      const replaced = openTab(withGuide, 'extra-replace', { replaceGuide: true })
      expect(kindsOf(replaced)).toBe('extra-replace,terminal')
      expect(replaced.panes[0]?.activeTabId).toBe(replaced.panes[0]?.tabs[0]?.id)

      const noGuide = surfaceWith(['terminal'])
      expect(openTab(noGuide, 'extra-replace', { replaceGuide: true })).toBe(noGuide)
    } finally {
      off()
    }
  })

  test('再开 guide = 聚焦现成的那张，不追加第二张；paneId 可指到另一格', () => {
    const surface = twoPanes(['guide'], ['terminal'])
    const focused = openTab(surface, 'guide')
    expect(kindsOf(focused)).toBe('guide | terminal')
    expect(focused.panes[0]?.activeTabId).toBe(surface.panes[0]?.tabs[0]?.id)

    const off = registerDockTab({ kind: 'extra-pane', label: '格', component: (() => null) as never })
    try {
      const intoRight = openTab(surface, 'extra-pane', { paneId: 'pane-b' })
      expect(kindsOf(intoRight)).toBe('guide | terminal,extra-pane')
      expect(intoRight.activePaneId).toBe('pane-a')
    } finally {
      off()
    }
  })

  test('单例页签（files）已开时只聚焦，不再开第二张', () => {
    const off = registerDockTab({ kind: 'files', label: '文件', component: (() => null) as never })
    try {
      const first = openTab(defaultSurface(), 'files')
      const second = openTab(first, 'files')
      expect(kindsOf(second)).toBe('guide,files')
      expect(second.panes[0]?.activeTabId).toBe(first.panes[0]?.tabs[1]?.id)
      expect(second.panes[0]?.tabs.filter((tab) => tab.kind === 'files')).toHaveLength(1)
    } finally {
      off()
    }
  })
})

describe('预览 / 补丁 / 子智能体 / 后台活 / 浏览器', () => {
  test('openPreview：新开带路径与行号；同路径去重=聚焦，再来一次带行号只更新行号', () => {
    const opened = openPreview(defaultSurface(), 'D:/a.ts', 12)
    const preview = opened.panes[0]?.tabs.find((tab) => tab.kind === 'preview')
    expect(preview?.path).toBe('D:/a.ts')
    expect(preview?.line).toBe(12)

    const again = openPreview(opened, 'D:/a.ts')
    expect(again.panes[0]?.tabs.filter((tab) => tab.kind === 'preview')).toHaveLength(1)
    expect(again.panes[0]?.activeTabId).toBe(preview?.id)

    const moved = openPreview(again, 'D:/a.ts', 30)
    expect(moved.panes[0]?.tabs.find((tab) => tab.kind === 'preview')?.line).toBe(30)
  })

  test('openPreview 每格上限 10 张：第 11 张挤掉最旧的一张', () => {
    let surface = defaultSurface()
    for (let index = 0; index < 10; index += 1) surface = openPreview(surface, `D:/p${String(index)}.ts`)
    const paths = (): (string | undefined)[] =>
      surface.panes[0]!.tabs.filter((tab) => tab.kind === 'preview').map((tab) => tab.path)
    expect(paths()).toHaveLength(10)

    surface = openPreview(surface, 'D:/p10.ts')
    const after = paths()
    expect(after).toHaveLength(10)
    expect(after).not.toContain('D:/p0.ts')
    expect(after).toContain('D:/p10.ts')
  })

  test('openPatch / openSubagent / openWorkOutput：同路径或同 id 去重，带新标题时只更新标题', () => {
    const patched = openPatch(defaultSurface(), 'D:/a.ts')
    expect(patched.panes[0]?.tabs.filter((tab) => tab.kind === 'patch')).toHaveLength(1)
    expect(openPatch(patched, 'D:/a.ts').panes[0]?.tabs.filter((tab) => tab.kind === 'patch')).toHaveLength(1)

    const sub = openSubagent(defaultSurface(), 'D:/team/a.jsonl', 'reader-1')
    expect(sub.panes[0]?.tabs.find((tab) => tab.kind === 'subagent')?.label).toBe('reader-1')
    const subAgain = openSubagent(sub, 'D:/team/a.jsonl')
    expect(subAgain.panes[0]?.tabs.filter((tab) => tab.kind === 'subagent')).toHaveLength(1)
    const subRelabeled = openSubagent(subAgain, 'D:/team/a.jsonl', 'reader-2')
    expect(subRelabeled.panes[0]?.tabs.find((tab) => tab.kind === 'subagent')?.label).toBe('reader-2')

    const work = openWorkOutput(defaultSurface(), 'job-1')
    expect(work.panes[0]?.tabs.find((tab) => tab.kind === 'work-output')?.label).toBeUndefined()
    const workAgain = openWorkOutput(work, 'job-1', '构建')
    expect(workAgain.panes[0]?.tabs.filter((tab) => tab.kind === 'work-output')).toHaveLength(1)
    expect(workAgain.panes[0]?.tabs.find((tab) => tab.kind === 'work-output')?.label).toBe('构建')
  })

  test('openBrowserTab：空态不写 path/label；指名 id 复用同一张；空 id 自造', () => {
    const empty = openBrowserTab(defaultSurface())
    const tab = empty.panes[0]?.tabs.find((item) => item.kind === 'browser')
    expect(tab?.path).toBeUndefined()
    expect(tab?.label).toBeUndefined()

    const named = openBrowserTab(empty, 'https://a', '页面', 'agent-1')
    expect(named.panes[0]?.tabs.find((item) => item.id === 'agent-1')?.path).toBe('https://a')
    const again = openBrowserTab(named, 'https://b', '另一页', 'agent-1')
    expect(again.panes[0]?.tabs.filter((item) => item.kind === 'browser')).toHaveLength(2)
    expect(again.panes[0]?.tabs.find((item) => item.id === 'agent-1')?.path).toBe('https://a')

    const fresh = openBrowserTab(again, '', '', '')
    const newest = fresh.panes[0]?.tabs.at(-1)
    expect(newest?.kind).toBe('browser')
    expect(newest?.id).not.toBe('')
    expect(newest?.path).toBeUndefined()
    expect(newest?.label).toBeUndefined()
  })

  test('setTabInfo：找不到页签原样返回；空串不覆盖；同值不产生新对象；只给 label 时路径不变', () => {
    const surface = surfaceWith(['browser'])
    const tab = surface.panes[0]!.tabs[0]!
    expect(setTabInfo(surface, 'ghost', { label: 'x' })).toBe(surface)

    const labeled = setTabInfo(surface, tab.id, { label: '标题', path: 'https://a' })
    expect(labeled.panes[0]?.tabs[0]?.label).toBe('标题')
    expect(labeled.panes[0]?.tabs[0]?.path).toBe('https://a')
    expect(setTabInfo(labeled, tab.id, { label: '', path: '' })).toBe(labeled)

    const onlyLabel = setTabInfo(labeled, tab.id, { label: '新标题' })
    expect(onlyLabel.panes[0]?.tabs[0]?.label).toBe('新标题')
    expect(onlyLabel.panes[0]?.tabs[0]?.path).toBe('https://a')
  })
})

describe('关页签 / 聚焦 / 分栏', () => {
  test('closeTab：未知 id 原样返回；关非激活页签不动激活；关激活页签聚焦邻位；关末尾回落前一张', () => {
    const surface = surfaceWith(['terminal', 'browser', 'files'])
    const [first, second, third] = surface.panes[0]!.tabs
    surface.panes[0]!.activeTabId = second!.id

    expect(closeTab(surface, 'ghost')).toBe(surface)
    const keep = closeTab(surface, first!.id)
    expect(keep.panes[0]?.activeTabId).toBe(second!.id)
    expect(keep.panes[0]?.tabs).toHaveLength(2)

    const middle = closeTab(surface, second!.id)
    expect(middle.panes[0]?.activeTabId).toBe(third!.id)

    const lastActive = surfaceWith(['terminal', 'browser', 'files'])
    const bottom = lastActive.panes[0]!.tabs[2]!
    lastActive.panes[0]!.activeTabId = bottom.id
    const fallback = closeTab(lastActive, bottom.id)
    expect(fallback.panes[0]?.activeTabId).toBe(lastActive.panes[0]?.tabs[1]?.id)
  })

  test('closeTab：整块最后一张才收起；某一格清空只补门面，另一格还有内容时不收起', () => {
    const solo = setExpanded(surfaceWith(['terminal']), true)
    const collapsed = closeTab(solo, solo.panes[0]!.tabs[0]!.id)
    expect(kindsOf(collapsed)).toBe('guide')
    expect(collapsed.expanded).toBe(false)

    const split = twoPanes(['terminal'], ['browser'])
    const emptied = closeTab(split, split.panes[0]!.tabs[0]!.id)
    expect(kindsOf(emptied)).toBe('guide | browser')
    expect(emptied.expanded).toBe(true)
  })

  test('focusTab / focusPane：未知目标原样返回；跨格聚焦顺带切激活格', () => {
    const surface = twoPanes(['guide'], ['terminal'])
    const rightTab = surface.panes[1]!.tabs[0]!
    expect(focusTab(surface, 'ghost')).toBe(surface)
    const focused = focusTab(surface, rightTab.id)
    expect(focused.activePaneId).toBe('pane-b')
    expect(focused.panes[1]?.activeTabId).toBe(rightTab.id)

    expect(focusPane(surface, 'ghost')).toBe(surface)
    expect(focusPane(surface, 'pane-b').activePaneId).toBe('pane-b')
  })

  test('splitPane：两格已满 / 只有一张门面时不动；多页签把激活页搬到右格；单张内容左格补门面', () => {
    const full = twoPanes(['guide'], ['terminal'])
    expect(splitPane(full)).toBe(full)
    const onlyGuide = surfaceWith(['guide'])
    expect(splitPane(onlyGuide)).toBe(onlyGuide)

    const multi = surfaceWith(['guide', 'terminal', 'browser'])
    multi.panes[0]!.activeTabId = multi.panes[0]!.tabs[1]!.id
    const split = splitPane(multi)
    expect(split.panes).toHaveLength(2)
    expect(kindsOf(split)).toBe('guide,browser | terminal')
    expect(split.activePaneId).toBe(split.panes[1]?.id)
    expect(split.panes[1]?.activeTabId).toBe(multi.panes[0]?.tabs[1]?.id)

    const single = surfaceWith(['terminal'])
    const fromSingle = splitPane(single)
    expect(kindsOf(fromSingle)).toBe('guide | terminal')
  })

  test('unsplitPane：单格原样返回；并回时左格已有门面就丢掉右格门面；激活值失效时按右格/首张兜底', () => {
    const single = surfaceWith(['guide'])
    expect(unsplitPane(single)).toBe(single)

    const split = twoPanes(['guide', 'terminal'], ['guide', 'browser'])
    const merged = unsplitPane(split)
    expect(kindsOf(merged)).toBe('guide,terminal,browser')
    expect(merged.fraction).toBe(0.5)

    const stale = twoPanes(['guide'], ['browser'], { activePaneId: 'pane-b' })
    stale.panes[0]!.activeTabId = 'ghost-left'
    stale.panes[1]!.activeTabId = stale.panes[1]!.tabs[0]!.id
    expect(unsplitPane(stale).panes[0]?.activeTabId).toBe(stale.panes[1]?.tabs[0]?.id)

    const allStale = twoPanes(['guide'], ['browser'])
    allStale.panes[0]!.activeTabId = 'ghost-1'
    allStale.panes[1]!.activeTabId = 'ghost-2'
    expect(unsplitPane(allStale).panes[0]?.activeTabId).toBe(allStale.panes[0]?.tabs[0]?.id)
  })
})

describe('placeTab 拖拽落点', () => {
  test('未知来源或目标原样返回；同格重排会夹取 index 到 [0, 长度]', () => {
    const surface = surfaceWith(['terminal', 'browser', 'files'])
    expect(placeTab(surface, 'ghost', 'pane-a')).toBe(surface)
    expect(placeTab(surface, surface.panes[0]!.tabs[1]!.id, 'ghost')).toBe(surface)

    const [first, second, third] = surface.panes[0]!.tabs
    const toFront = placeTab(surface, third!.id, 'pane-a', -5)
    expect(toFront.panes[0]?.tabs.map((tab) => tab.id)).toEqual([third!.id, first!.id, second!.id])

    const toEnd = placeTab(surface, first!.id, 'pane-a', 99)
    expect(toEnd.panes[0]?.tabs.map((tab) => tab.id)).toEqual([second!.id, third!.id, first!.id])
  })

  test('跨格搬空来源格自动补门面；源格还有内容时激活值不动；搬走激活页签则聚焦前一张', () => {
    const split = twoPanes(['terminal'], ['browser'])
    const moved = placeTab(split, split.panes[0]!.tabs[0]!.id, 'pane-b')
    expect(kindsOf(moved)).toBe('guide | browser,terminal')

    const withExtra = twoPanes(['terminal', 'files'], ['browser'])
    withExtra.panes[0]!.activeTabId = withExtra.panes[0]!.tabs[0]!.id
    const nonActive = placeTab(withExtra, withExtra.panes[0]!.tabs[1]!.id, 'pane-b')
    expect(nonActive.panes[0]?.activeTabId).toBe(withExtra.panes[0]?.tabs[0]?.id)

    const activeMoved = placeTab(withExtra, withExtra.panes[0]!.tabs[0]!.id, 'pane-b')
    expect(activeMoved.panes[0]?.tabs.map((tab) => tab.kind)).toEqual(['files'])
    expect(activeMoved.panes[0]?.activeTabId).toBe(withExtra.panes[0]?.tabs[1]?.id)
  })
})

describe('展示档 / 宽比 / 撤销 / 订阅', () => {
  test('setExpanded 与 toggleMode 双向；setFraction 拒非有限数并把宽比夹到 0.2–0.8', () => {
    const surface = defaultSurface()
    expect(setExpanded(surface, true).expanded).toBe(true)
    expect(toggleMode(surface).mode).toBe('fullscreen')
    expect(toggleMode(toggleMode(surface)).mode).toBe('push')

    expect(setFraction(surface, Number.NaN)).toBe(surface)
    expect(setFraction(surface, Number.POSITIVE_INFINITY)).toBe(surface)
    expect(setFraction(surface, 0.05).fraction).toBe(0.2)
    expect(setFraction(surface, 0.95).fraction).toBe(0.8)
    expect(setFraction(surface, 0.6).fraction).toBe(0.6)
  })

  test('removeKindTabs：没有同类页签原样返回；激活页签还在就保持；清空格补门面且不收起', () => {
    const surface = twoPanes(['terminal', 'browser'], ['extra-kind'])
    expect(removeKindTabs(surface, 'git')).toBe(surface)

    const kept = removeKindTabs(surface, 'extra-kind')
    expect(kindsOf(kept)).toBe('terminal,browser | guide')
    expect(kept.expanded).toBe(true)

    const activeTerminal = twoPanes(['terminal', 'browser'], ['guide'])
    const pruned = removeKindTabs(activeTerminal, 'browser')
    expect(pruned.panes[0]?.activeTabId).toBe(activeTerminal.panes[0]?.tabs[0]?.id)
  })

  test('subscribeDockKinds：撤回时给出被删的 kind，退订后不再收到', () => {
    const seen: Array<string | undefined> = []
    const offSub = subscribeDockKinds((removed) => seen.push(removed))
    const off = registerDockTab({ kind: 'extra-sub', label: '订阅', component: (() => null) as never })
    expect(dockTabKinds().some((meta) => meta.kind === 'extra-sub')).toBe(true)
    expect(dockGuideEntries().some((card) => card.title === '订阅')).toBe(false)
    expect(dockTabMeta('extra-sub')?.label).toBe('订阅')
    off()
    expect(seen.at(-1)).toBe('extra-sub')
    const count = seen.length
    offSub()
    const offLate = registerDockTab({ kind: 'extra-sub-late', label: '迟', component: (() => null) as never })
    offLate()
    expect(seen).toHaveLength(count)
  })
})

describe('持久化：坏形状一律作废，好形状往返不丢字段', () => {
  test('没有存档 / JSON 坏了 / 顶层不是对象：都回空表', () => {
    expect(loadSurfaces()).toEqual({})
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadSurfaces()).toEqual({})
    localStorage.setItem(STORAGE_KEY, 'null')
    expect(loadSurfaces()).toEqual({})
  })

  test('每一种坏形状都被拒绝：panes / tabs / id / kind / path / active 指向', () => {
    const goodTab = { id: 't1', kind: 'terminal' }
    const goodPane = { id: 'p1', tabs: [goodTab], activeTabId: 't1' }
    const base = { panes: [goodPane], activePaneId: 'p1' }
    const cases: unknown[] = [
      null,
      'text',
      { ...base, panes: [] },
      { ...base, panes: [goodPane, goodPane, goodPane] },
      { ...base, panes: [{ ...goodPane, tabs: [] }] },
      { ...base, panes: [{ ...goodPane, tabs: [{ id: 1, kind: 'terminal' }] }] },
      { ...base, panes: [{ ...goodPane, tabs: [{ id: 't1', kind: '' }] }] },
      { ...base, panes: [{ ...goodPane, tabs: [{ id: 't1', kind: 'preview' }] }] },
      { ...base, panes: [{ ...goodPane, tabs: [{ id: 't1', kind: 'patch', path: '' }] }] },
      { ...base, panes: [{ ...goodPane, tabs: [{ id: 't1', kind: 'subagent' }] }] },
      { ...base, panes: [{ ...goodPane, tabs: [{ id: 't1', kind: 'work-output' }] }] },
      { ...base, panes: [{ ...goodPane, activeTabId: 'ghost' }] },
      { ...base, activePaneId: 'ghost' },
    ]
    for (const [index, value] of cases.entries()) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ [`s${String(index)}`]: value }))
      expect(loadSurfaces()).toEqual({})
    }
  })

  test('好形状往返：preview 行号、subagent/浏览器标题、未知 kind 都保留；宽比夹取、mode/expanded 补默认', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ok: {
          panes: [
            {
              id: 'p1',
              tabs: [
                { id: 't1', kind: 'preview', path: 'D:/a.ts', line: 7 },
                { id: 't2', kind: 'subagent', path: 'D:/s.jsonl', label: 'reader' },
                { id: 't3', kind: 'browser', path: '', label: '页面' },
                { id: 't4', kind: 'plugin-kind' },
              ],
              activeTabId: 't2',
            },
          ],
          activePaneId: 'p1',
          fraction: 5,
        },
      }),
    )
    const loaded = loadSurfaces().ok!
    expect(loaded.panes[0]?.tabs).toEqual([
      { id: 't1', kind: 'preview', path: 'D:/a.ts', line: 7 },
      { id: 't2', kind: 'subagent', path: 'D:/s.jsonl', label: 'reader' },
      { id: 't3', kind: 'browser', label: '页面' },
      { id: 't4', kind: 'plugin-kind' },
    ])
    expect(loaded.fraction).toBe(0.8)
    expect(loaded.expanded).toBe(false)
    expect(loaded.mode).toBe('push')
  })

  test('saveSurfaces：超过 30 个会话丢掉最前面的键；写盘抛错不外抛', () => {
    const surfaces: Record<string, ReturnType<typeof defaultSurface>> = {}
    for (let index = 0; index < 31; index += 1) surfaces[`s${String(index)}`] = defaultSurface()
    saveSurfaces(surfaces)
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    expect(Object.keys(saved)).toHaveLength(30)
    expect(saved['s0']).toBeUndefined()
    expect(saved['s30']).toBeDefined()

    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('配额满')
    })
    try {
      expect(() => saveSurfaces({ one: defaultSurface() })).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('模块级报名表的基线（本文件不污染别的 spec）', () => {
  test('不存在本文件用过的临时 kind', () => {
    for (const kind of ['extra-kind', 'extra-replace', 'extra-pane', 'extra-sub']) {
      expect(dockTabMeta(kind)).toBeUndefined()
    }
  })
})
