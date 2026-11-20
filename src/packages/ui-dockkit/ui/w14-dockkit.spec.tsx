/**
 * `ui-dockkit` 的补盲：布局动作面里几条只有「报名的种类齐全时」才会走到的分支，
 * 以及存档解析里两种带路径的页签。
 *
 * 缺口逐条：
 *   - `dock-state.ts:172-173`：补丁页签的打开动作（`patch` 有人报名时才走）；
 *   - `dock-state.ts:190`：聚焦另一格（`focusPane` 的落点）；
 *   - `dock-state.ts:356`：`setDockSubagent` 转给动作面（子智能体页签有人报名时）；
 *   - `dock-state.ts:344` / `455`：两个 hook 的**服务端快照**（`useSyncExternalStore` 第三参，
 *     用 `renderToStaticMarkup` 触发，jsdom 的客户端渲染永远不调它）；
 *   - `dock.tsx:298`：点没激活的那一格就聚焦它；`300`：格子上 `dragover` 阻止默认行为；
 *     `318`：格子里的「+」开一张新页签；`370`：页签的 kind 没人报名时画一句占位；
 *   - `dock-model.ts:706 / 719`：存档里 patch / work-output 页签的解析（路径必填）。
 *
 * 存档是在模块装载时读的（`dock-state.ts:65`），所以 `dsc.dock.surfaces` 要先写好再
 * 动态 import；静态 import 只能留在类型位置。
 *
 * @module dsc-ui-dockkit/ui/w14-dockkit
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentType, ReactNode } from 'react'
import type * as DockModelModule from './dock-model.js'
import type * as DockStateModule from './dock-state.js'

/** 存档键（`dock-model.ts` 的 STORAGE_KEY）。 */
const STORAGE_KEY = 'dsc.dock.surfaces'
/** 预置存档的会话 id：里面放一张没人报名的 kind，验占位。 */
const SEEDED = 'w14-dock-seeded'
/** 干净会话的前缀：每个用例一份，互不串布局。 */
let cleanSeq = 0

let dockModel: typeof DockModelModule
let dockState: typeof DockStateModule
let Dock: ComponentType<{ width: number; onResize: (width: number) => void }>
const unregister: Array<() => void> = []

beforeAll(async () => {
  localStorage.clear()
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      [SEEDED]: {
        panes: [{ id: 'pane-seeded', tabs: [{ id: 'tab-mystery', kind: 'mystery' }], activeTabId: 'tab-mystery' }],
        activePaneId: 'pane-seeded',
        fraction: 0.5,
        expanded: true,
        mode: 'push',
      },
    }),
  )
  dockModel = await import('./dock-model.js')
  dockState = await import('./dock-state.js')
  const dockModule = await import('./dock.js')
  Dock = dockModule.Dock as unknown as ComponentType<{ width: number; onResize: (width: number) => void }>
  // 与真壳一致：这几种页签由各自的插件报名；报名之后 openPatch / setDockSubagent / openTab 才有落点。
  for (const [kind, label] of [
    ['files', '文件'],
    ['patch', '补丁'],
    ['subagent', '子智能体'],
    ['preview', '预览'],
  ] as const) {
    unregister.push(
      dockModel.registerDockTab({
        kind,
        label,
        component: function Stub(): ReactNode {
          return null
        },
      }),
    )
  }
})

afterAll(() => {
  for (const off of unregister.splice(0)) off()
})

beforeEach(() => {
  localStorage.removeItem(`${STORAGE_KEY}.probe`)
})

afterEach(() => {
  cleanup()
})

const cleanSession = (): string => {
  cleanSeq += 1
  return `w14-dock-clean-${String(cleanSeq)}`
}

describe('布局动作面', () => {
  test('报名的种类都打得开：补丁页签、子智能体页签', () => {
    dockState.setDockSession(cleanSession())
    dockState.dockActions.openPatch('C:/repo/a.ts')
    const tabs = dockState.dockSurface().panes.flatMap((pane) => pane.tabs)
    expect(tabs.some((tab) => tab.kind === 'patch' && tab.path === 'C:/repo/a.ts')).toBe(true)

    dockState.setDockSubagent({ path: 'C:/sessions/mate.jsonl', label: '小队友' })
    const after = dockState.dockSurface().panes.flatMap((pane) => pane.tabs)
    expect(after.some((tab) => tab.kind === 'subagent' && tab.path === 'C:/sessions/mate.jsonl')).toBe(true)
    expect(after.find((tab) => tab.kind === 'subagent')?.label).toBe('小队友')
  })

  test('focusPane 换激活格；不存在的格是空操作', () => {
    dockState.setDockSession(cleanSession())
    dockState.dockActions.openTab('files')
    dockState.dockActions.splitPane(dockState.dockSurface().activePaneId)
    const two = dockState.dockSurface()
    expect(two.panes).toHaveLength(2)
    const [left, right] = two.panes
    dockState.dockActions.focusPane(left!.id)
    expect(dockState.dockSurface().activePaneId).toBe(left!.id)
    dockState.dockActions.focusPane('no-such-pane')
    expect(dockState.dockSurface().activePaneId).toBe(left!.id)
    expect(right).toBeDefined()
  })
})

describe('Dock 的窗格交互', () => {
  test('点没激活的格子就聚焦它；dragover 被拦下（不触发浏览器默认行为）', () => {
    const session = cleanSession()
    dockState.setDockSession(session)
    dockState.dockActions.openTab('files')
    dockState.dockActions.splitPane(dockState.dockSurface().activePaneId)
    const surface = dockState.dockSurface()
    const inactive = surface.panes.find((pane) => pane.id !== surface.activePaneId)
    expect(inactive).toBeDefined()

    const onResize = vi.fn()
    const { container } = render(<Dock width={420} onResize={onResize} />)
    const panes = [...container.querySelectorAll('.dock-pane')] as HTMLElement[]
    expect(panes).toHaveLength(2)
    const target = panes.find((node) => node.querySelector('.dock-add') !== null) as HTMLElement
    // 「+」只在没有开始页的格子里出现：那一格就是右格（搬过去的 files）。
    const right = surface.panes[1]!
    const rightNode = panes[1] as HTMLElement
    expect(fireEvent.dragOver(rightNode, {})).toBe(false)

    const leftNode = panes[0] as HTMLElement
    fireEvent.mouseDown(leftNode)
    expect(dockState.dockSurface().activePaneId).toBe(surface.panes[0]!.id)
    expect(inactive!.id).toBe(surface.panes[0]!.id)
    void right
    void target
  })

  test('格子里的「+」开一张新页签（开始页）', () => {
    dockState.setDockSession(cleanSession())
    dockState.dockActions.openTab('files')
    dockState.dockActions.splitPane(dockState.dockSurface().activePaneId)
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    const add = container.querySelector('.dock-add') as HTMLButtonElement
    expect(add).not.toBeNull()
    fireEvent.click(add)
    // 「+」开的是开始页：开在「+」所在那一格（分栏两格各能有一张 guide）。
    const withGuide = dockState.dockSurface().panes.filter((pane) => pane.tabs.some((tab) => tab.kind === 'guide'))
    expect(withGuide).toHaveLength(2)
    expect(dockState.dockSurface().activePaneId).toBe(withGuide[1]!.id)
  })

  test('页签 kind 没人报名：画一句带 kind 的占位，不给白板', () => {
    dockState.setDockSession(SEEDED)
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    const placeholder = container.querySelector('.trace-empty') as HTMLElement
    expect(placeholder).not.toBeNull()
    expect(placeholder.textContent).toContain('mystery')
    expect(placeholder.textContent).toContain('没有装上')
  })
})

describe('存档解析', () => {
  test('patch / work-output 页签带路径才能读回来（路径是它们的全部内容）', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'archive-1': {
          panes: [
            {
              id: 'pane-1',
              tabs: [
                { id: 'tab-patch', kind: 'patch', path: 'C:/repo/a.ts' },
                { id: 'tab-work', kind: 'work-output', path: 'job-3', label: '构建' },
              ],
              activeTabId: 'tab-patch',
            },
          ],
          activePaneId: 'pane-1',
          fraction: 0.5,
          expanded: true,
          mode: 'push',
        },
      }),
    )
    const surfaces = dockModel.loadSurfaces()
    const tabs = surfaces['archive-1']?.panes[0]?.tabs ?? []
    expect(tabs.find((tab) => tab.kind === 'patch')?.path).toBe('C:/repo/a.ts')
    const work = tabs.find((tab) => tab.kind === 'work-output')
    expect(work?.path).toBe('job-3')
    expect(work?.label).toBe('构建')
  })

  test('路径丢了整份存档作废（回空表），不给半张读不出内容的页签', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'archive-2': {
          panes: [{ id: 'pane-1', tabs: [{ id: 'tab-patch', kind: 'patch' }], activeTabId: 'tab-patch' }],
          activePaneId: 'pane-1',
          fraction: 0.5,
          expanded: true,
          mode: 'push',
        },
      }),
    )
    expect(dockModel.loadSurfaces()).toEqual({})
  })
})

describe('hook 的服务端快照', () => {
  test('useDockPatchSource / useActivePreviewPath 在服务端渲染里给 null', () => {
    function PatchProbe(): ReactNode {
      const patch = dockState.useDockPatchSource('tab-none')
      return <span data-probe="patch">{patch === null ? 'null' : 'hit'}</span>
    }
    function ActiveProbe(): ReactNode {
      const path = dockState.useActivePreviewPath()
      return <span data-probe="active">{path === null ? 'null' : path}</span>
    }
    expect(renderToStaticMarkup(<PatchProbe />)).toContain('null')
    expect(renderToStaticMarkup(<ActiveProbe />)).toContain('null')
  })
})
