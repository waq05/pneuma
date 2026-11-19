/**
 * 右侧栏（`ui-dockkit/ui/dock.tsx`）的渲染与交互段（ui 层，真渲染）。
 *
 * 既有 spec 只压纯模型（页签报名生命周期、关页签收栏、补丁快照表）。这一份补的是
 * 「画出来之后」的分支：空态/收起、开始页入口卡按报名表过滤、chip 标题三档、中键与 ✕、
 * 右键菜单、跨窗格拖拽、左缘调宽与分栏拖拽的夹取、keepMounted 藏而不卸、chrome 两钮、
 * 窄视口自动全屏。假通道不需要：布局状态是模块级单例，动作直接经 `dockActions` 回传，
 * 断言既看 DOM 也看 `dockSurface()` 的真值。
 *
 * @module dsc-ui-dockkit/ui/dock-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Dock } from './dock.js'
import { dockActions, dockSurface, setDockSession } from './dock-state.js'
import { registerDockTab, type DockTabBodyProps, type DockTabKind, type DockTabKindMeta } from './dock-model.js'

/** 页签体：只写一个可断言的标记，不掺业务。 */
function Body(props: DockTabBodyProps): ReactNode {
  return (
    <div data-testid={`body-${props.tab.kind}`} data-active={String(props.active)}>
      {props.tab.kind}
    </div>
  )
}

/** 本文件报名的 kind：每条用例自己收尾，不给下一条留残留。 */
const offs: Array<() => void> = []

function register(kind: DockTabKind, patch: Partial<DockTabKindMeta> = {}): DockTabKindMeta {
  const meta: DockTabKindMeta = { kind, label: `标签-${kind}`, component: Body, ...patch }
  offs.push(registerDockTab(meta))
  return meta
}

/** 每条用例换一个新会话 id：`setDockSession` 拿不到存档时给一份全新默认布局。 */
let sessionSeq = 0
function freshSession(): void {
  sessionSeq += 1
  act(() => {
    setDockSession(`dock-extra-${String(sessionSeq)}`)
  })
}

const expandedSession = (): void => {
  freshSession()
  act(() => {
    dockActions.setExpanded(true)
  })
}

/** 把窗口宽度改成指定值（jsdom 默认 1024）。 */
function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}

const asideOf = (container: HTMLElement): HTMLElement => container.querySelector('aside.dock') as HTMLElement
const chipsOf = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll('.dock-chip')] as HTMLElement[]
const chipTexts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.dock-chip-label')].map((element) => element.textContent ?? '')
const paneIds = (): string[] => dockSurface().panes.map((pane) => pane.id)

beforeEach(() => {
  localStorage.clear()
  setViewport(1024)
  document.body.className = ''
})

afterEach(() => {
  cleanup()
  while (offs.length > 0) offs.pop()!()
  document.body.innerHTML = ''
  document.body.className = ''
  setViewport(1024)
  vi.restoreAllMocks()
})

describe('空态、收起与 chrome', () => {
  test('默认收起：整块滑出右缘（aria-hidden），resizer 与 caption 条在；展开后都不画加号', () => {
    freshSession()
    const resize = vi.fn()
    const { container } = render(<Dock width={420} onResize={resize} />)
    const aside = asideOf(container)
    expect(aside.className).toContain('collapsed')
    expect(aside.getAttribute('aria-hidden')).toBe('true')
    expect(aside.style.marginRight).toBe('-420px')
    expect(container.querySelector('.dock-resizer')).not.toBeNull()
    expect(container.querySelector('.caption-bar')).not.toBeNull()
    // 默认布局只有一张「开始」：chip 画门面标题，格内已有 guide，所以不画加号。
    expect(chipTexts(container)).toEqual(['开始'])
    expect(container.querySelector('.dock-add')).toBeNull()
    expect(container.querySelectorAll('.dock-chrome-btn')).toHaveLength(2)

    act(() => {
      dockActions.setExpanded(true)
    })
    expect(aside.className).not.toContain('collapsed')
    expect(aside.getAttribute('aria-hidden')).toBeNull()
    expect(aside.style.marginRight).toBe('')
  })

  test('chrome 全屏钮切换 mode-fullscreen（resizer/caption 消失），收起钮把 expanded 置 false', () => {
    expandedSession()
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    const aside = asideOf(container)
    const buttons = (): HTMLElement[] => [...container.querySelectorAll('.dock-chrome-btn')] as HTMLElement[]

    expect(buttons()[0]!.getAttribute('aria-label')).toBe('全屏')
    fireEvent.click(buttons()[0]!)
    expect(dockSurface().mode).toBe('fullscreen')
    expect(aside.className).toContain('mode-fullscreen')
    expect(container.querySelector('.dock-resizer')).toBeNull()
    expect(container.querySelector('.caption-bar')).toBeNull()
    expect(buttons()[0]!.getAttribute('aria-label')).toBe('退出全屏')

    fireEvent.click(buttons()[0]!)
    expect(dockSurface().mode).toBe('push')
    expect(container.querySelector('.dock-resizer')).not.toBeNull()

    fireEvent.click(buttons()[1]!)
    expect(dockSurface().expanded).toBe(false)
    expect(aside.className).toContain('collapsed')
  })

  test('窄视口自动全屏，回到宽视口又恢复贴边', () => {
    expandedSession()
    setViewport(600)
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    const aside = asideOf(container)
    expect(aside.className).toContain('mode-fullscreen')
    expect(container.querySelector('.dock-resizer')).toBeNull()

    setViewport(1024)
    fireEvent(window, new Event('resize'))
    expect(aside.className).not.toContain('mode-fullscreen')
    expect(container.querySelector('.dock-resizer')).not.toBeNull()

    setViewport(500)
    fireEvent(window, new Event('resize'))
    expect(aside.className).toContain('mode-fullscreen')
  })
})

describe('开始页入口卡', () => {
  test('只画已报名 kind 的默认卡；点卡就地替换 guide 并展开，未报名的 kind 开不出来', () => {
    expandedSession()
    register('terminal')
    register('files')
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)

    const cards = (): string[] =>
      [...container.querySelectorAll('.dock-guide-entry')].map((element) => element.textContent ?? '')
    expect(cards().some((text) => text.includes('新建终端'))).toBe(true)
    expect(cards().some((text) => text.includes('工作区文件'))).toBe(true)
    // 浏览器 / Git 没报名：那两张卡不画。
    expect(cards().some((text) => text.includes('浏览网页'))).toBe(false)
    expect(cards().some((text) => text.includes('Git 管理'))).toBe(false)

    // 未报名的 kind 连动作层都被挡掉（Ctrl+T 打到停用插件上的那条路）。
    const before = dockSurface()
    act(() => {
      dockActions.openTab('browser')
    })
    expect(dockSurface()).toBe(before)

    // 默认卡顺序是 files / terminal / browser / git，按文本挑终端那张。
    const terminalCard = [...container.querySelectorAll('.dock-guide-entry')].find((element) =>
      element.textContent?.includes('新建终端'),
    ) as HTMLElement
    fireEvent.click(terminalCard)
    const tabs = dockSurface().panes[0]!.tabs
    expect(tabs.map((tab) => tab.kind)).toEqual(['terminal'])
    expect(dockSurface().expanded).toBe(true)
    expect(container.querySelector('.dock-add')).not.toBeNull()
    expect(container.querySelector('[data-testid="body-terminal"]')).not.toBeNull()
  })

  test('插件报名的入口卡随撤销消失（停用旁问后卡不再留在开始页）', () => {
    expandedSession()
    const off = registerDockTab({
      kind: 'ask',
      label: '旁问',
      component: Body,
      guide: { title: '旁问入口', description: '只读问答', tone: 'tone-ask', shortcut: 'Ctrl + Shift + K' },
    })
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    expect(container.textContent).toContain('旁问入口')
    expect(container.textContent).toContain('Ctrl + Shift + K')

    act(() => {
      off()
    })
    expect(container.textContent).not.toContain('旁问入口')
  })
})

describe('页签 chip', () => {
  test('标题三档：meta.label / 页签自带 label / titleFromPath 的路径尾段', () => {
    expandedSession()
    register('terminal', { label: '终端' })
    register('subagent', { label: '子智能体', titleFromPath: true })
    register('preview', { label: '预览', titleFromPath: true })
    act(() => {
      dockActions.openTab('terminal')
      dockActions.openSubagent('D:/work/run-1.jsonl')
      dockActions.openSubagent('D:/work/run-2.jsonl', '读者一号')
      dockActions.openPreview('D:/work/src/a.ts')
    })
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    expect(chipTexts(container)).toEqual(['开始', '终端', 'run-1.jsonl', '读者一号', 'a.ts'])
  })

  test('点 chip 聚焦并切体内；中键关闭；✕ 关掉最后一张时整栏收起', () => {
    expandedSession()
    register('terminal', { label: '终端' })
    act(() => {
      dockActions.openTab('terminal')
      dockActions.openTab('terminal')
    })
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    expect(chipsOf(container)).toHaveLength(3)

    // 点第一张终端 chip：激活页签换成它，只有它的体在 DOM 里（非 keepMounted）。
    const terminalChips = chipsOf(container).filter((chip) => chip.textContent?.includes('终端'))
    fireEvent.click(terminalChips[0]!)
    expect(container.querySelector('[data-testid="body-terminal"]')).not.toBeNull()

    // 中键关闭：少一张 terminal chip。
    fireEvent(terminalChips[1]!, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(chipsOf(container).filter((chip) => chip.textContent?.includes('终端'))).toHaveLength(1)

    // ✕ 关掉剩下那张终端：指南还在，栏不收。
    const close = chipsOf(container)
      .find((chip) => chip.textContent?.includes('终端'))!
      .querySelector('.dock-chip-close') as HTMLElement
    fireEvent.click(close)
    expect(dockSurface().panes[0]!.tabs.map((tab) => tab.kind)).toEqual(['guide'])
    expect(dockSurface().expanded).toBe(true)

    // 再关掉唯一的 guide：补一张新门面并收起整栏。
    const guideClose = container.querySelector('.dock-chip-close') as HTMLElement
    fireEvent.click(guideClose)
    expect(dockSurface().panes[0]!.tabs.map((tab) => tab.kind)).toEqual(['guide'])
    expect(dockSurface().expanded).toBe(false)
    expect(asideOf(container).className).toContain('collapsed')
  })
})

describe('右键菜单', () => {
  test('向右分栏 / 收回分栏 / 关闭页签；点遮罩只关菜单', () => {
    expandedSession()
    register('terminal', { label: '终端' })
    act(() => {
      dockActions.openTab('terminal')
    })
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    const terminalChip = (): HTMLElement =>
      chipsOf(container).find((chip) => chip.textContent?.includes('终端')) as HTMLElement
    const menuButtons = (): HTMLElement[] =>
      [...container.querySelectorAll('.dock-tab-menu .menu-item')] as HTMLElement[]

    fireEvent.contextMenu(terminalChip(), { clientX: 12, clientY: 18 })
    expect(container.querySelector('.dock-tab-menu')).not.toBeNull()
    expect(menuButtons()).toHaveLength(3)

    fireEvent.click(menuButtons()[0]!)
    expect(paneIds()).toHaveLength(2)
    expect(container.querySelector('.dock-split')).not.toBeNull()

    fireEvent.contextMenu(terminalChip(), { clientX: 12, clientY: 18 })
    fireEvent.click(menuButtons()[1]!)
    expect(paneIds()).toHaveLength(1)

    fireEvent.contextMenu(terminalChip(), { clientX: 12, clientY: 18 })
    fireEvent.click(container.querySelector('.menu-backdrop') as HTMLElement)
    expect(container.querySelector('.dock-tab-menu')).toBeNull()
    // 只关了菜单，页签还在。
    expect(chipsOf(container)).toHaveLength(2)

    fireEvent.contextMenu(terminalChip(), { clientX: 12, clientY: 18 })
    fireEvent.click(menuButtons()[2]!)
    expect(dockSurface().panes[0]!.tabs.map((tab) => tab.kind)).toEqual(['guide'])
  })
})

describe('拖拽与尺寸', () => {
  test('跨窗格拖 chip：落到目标格末尾，源格清空后补 guide', () => {
    expandedSession()
    register('terminal', { label: '终端' })
    act(() => {
      dockActions.openTab('terminal')
      dockActions.openTab('terminal')
      dockActions.splitPane(dockSurface().activePaneId)
    })
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    expect(paneIds()).toHaveLength(2)
    const panes = [...container.querySelectorAll('.dock-pane')] as HTMLElement[]
    const rightChip = panes[1]!.querySelector('.dock-chip') as HTMLElement
    const setData = vi.fn()
    fireEvent.dragStart(rightChip, { dataTransfer: { setData, getData: vi.fn() } as unknown as DataTransfer })
    const tabId = setData.mock.calls[0]![1] as string

    fireEvent.drop(panes[0]!, { dataTransfer: { getData: () => tabId } as unknown as DataTransfer })
    const [left, right] = dockSurface().panes
    expect(left!.tabs.some((tab) => tab.id === tabId)).toBe(true)
    expect(left!.tabs.map((tab) => tab.kind)).toEqual(['guide', 'terminal', 'terminal'])
    expect(right!.tabs.map((tab) => tab.kind)).toEqual(['guide'])
    expect(right!.tabs[0]!.id).not.toBe(tabId)
  })

  test('左缘拖拽按 300–窗口上限夹取宽度，松手清 resizing，双击复位 420', () => {
    expandedSession()
    const onResize = vi.fn()
    const { container } = render(<Dock width={420} onResize={onResize} />)
    const resizer = container.querySelector('.dock-resizer') as HTMLElement

    fireEvent.mouseDown(resizer, { clientX: 500 })
    expect(document.body.classList.contains('resizing')).toBe(true)
    // 1024 宽、无侧栏、正文保底 480 → 上限 544。
    fireEvent.mouseMove(window, { clientX: 100 })
    expect(onResize).toHaveBeenLastCalledWith(544)
    // 拖过头：不小于 300。
    fireEvent.mouseMove(window, { clientX: 900 })
    expect(onResize).toHaveBeenLastCalledWith(300)
    fireEvent.mouseUp(window)
    expect(document.body.classList.contains('resizing')).toBe(false)

    fireEvent.doubleClick(resizer)
    expect(onResize).toHaveBeenLastCalledWith(420)
  })

  test('分栏拖拽条按指针比例改 fraction（夹到 0.2–0.8），双击收回分栏', () => {
    expandedSession()
    register('terminal', { label: '终端' })
    act(() => {
      dockActions.openTab('terminal')
      dockActions.openTab('terminal')
      dockActions.splitPane(dockSurface().activePaneId)
    })
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    const panes = container.querySelector('.dock-panes') as HTMLElement
    vi.spyOn(panes, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 1000,
      top: 0,
      height: 400,
      right: 1000,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    const split = container.querySelector('.dock-split') as HTMLElement

    fireEvent.mouseDown(split, { clientX: 250 })
    fireEvent.mouseMove(window, { clientX: 250 })
    expect(dockSurface().fraction).toBeCloseTo(0.25, 5)
    fireEvent.mouseMove(window, { clientX: 50 })
    expect(dockSurface().fraction).toBeCloseTo(0.2, 5)
    fireEvent.mouseUp(window)

    fireEvent.doubleClick(split)
    expect(paneIds()).toHaveLength(1)
    expect(dockSurface().fraction).toBe(0.5)
  })
})

describe('页面体挂载', () => {
  test('keepMounted 切走只藏不卸；普通页签只在激活且展开时挂载', () => {
    expandedSession()
    register('terminal', { label: '终端', keepMounted: true })
    register('files', { label: '文件' })
    act(() => {
      dockActions.openTab('terminal')
      dockActions.openTab('files')
    })
    const { container } = render(<Dock width={420} onResize={vi.fn()} />)
    // files 后开、是激活页签：两个体都在（terminal 藏而不卸）。
    expect(container.querySelector('[data-testid="body-files"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="body-terminal"]')).not.toBeNull()

    // 切回 terminal：普通页签 files 卸载；keepMounted 的 terminal 还在。
    const terminalChip = chipsOf(container).find((chip) => chip.textContent?.includes('终端'))!
    fireEvent.click(terminalChip)
    expect(container.querySelector('[data-testid="body-files"]')).toBeNull()
    const keepBody = container.querySelector('[data-testid="body-terminal"]') as HTMLElement
    expect(keepBody).not.toBeNull()
    expect(keepBody.closest('.dock-tab-body')?.getAttribute('style') ?? '').toBe('')

    // 切回 files：terminal 的体还在，但外层 display:none。
    const filesChip = chipsOf(container).find((chip) => chip.textContent?.includes('文件'))!
    fireEvent.click(filesChip)
    const hiddenKeep = container.querySelector('[data-testid="body-terminal"]') as HTMLElement
    expect(hiddenKeep).not.toBeNull()
    expect((hiddenKeep.closest('.dock-tab-body') as HTMLElement).style.display).toBe('none')

    // 整栏收起：keepMounted 仍活着，普通页签不挂。
    act(() => {
      dockActions.setExpanded(false)
    })
    expect(container.querySelector('[data-testid="body-terminal"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="body-files"]')).toBeNull()
  })
})
