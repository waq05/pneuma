/**
 * 选中文字浮层的动作槽（`ask.selection.action`，差距清单 S9）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-ask-selection-slot-test.mjs` 第 [2]、[3] 段（缺口清单 B36「[1]–[5]」里
 * 有运行期接缝的两段）：
 *   - [2] 登记：内置「问 AI」也登记到槽链上（`apply` 真跑一遍，收下它交出去的登记——
 *     生产壳装载插件走的就是这一步）；槽名与形态（`kind: 'list'`、owner 交 `text`/`close`）
 *     的声明半是 `declare module` 编译期合并，运行期没有对应物，不迁；
 *   - [3] 浮层渲染：`renderSlot('ask.selection.action', { text, close })` 真画进浮层、
 *     owner 两样都交到了；`renderSlot === undefined` 的兜底分支真渲染——插件没装好时
 *     至少留住内置那一颗（反向钉：不许只剩一句 renderSlot 调用）。
 *
 * 不迁的（原探针第 [4][5] 段）：`.ask-sel-actions` 的定位样式是 CSS 文本钉（jsdom 不
 * 应用样式表）；注释留档没有运行期行为。第 [1][6] 段已由 `node-slots.spec.ts` 常量与
 * `select-anchor.spec.ts` 的实测尺寸分支收走。
 *
 * @module dsc-ui-ask/ui/selection-slot.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'
import { AskSelectionAction } from './ui.js'
import { takePendingQuote } from './store.js'

/** apply 真跑一遍，收下它交出去的槽登记（与生产壳装载同一入口）。 */
interface Registration {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

function registrations(): Registration[] {
  const collected: Registration[] = []
  const fakeUi = {
    slots: {
      register: (slot: string, options: unknown, component: unknown): void => {
        collected.push({ slot, options: options as Record<string, unknown>, component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  return collected
}

/** AskTriggers 不直接导出：经 apply 收下 shell.header 那条的组件（生产壳的装配路）。 */
function triggerComponent(): (props: { renderSlot?: unknown }) => ReactNode {
  const found = registrations().find((item) => item.slot === 'shell.header')
  if (found === undefined) throw new Error('ask 插件没有把触发器登记进 shell.header')
  return found.component as (props: { renderSlot?: unknown }) => ReactNode
}

const Triggers = triggerComponent()

/** 造一段 jsdom 里不存在的选区：文本落在 .chat 宿主内，框在视口中部。 */
function stubSelection(host: Element | null): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({
      commonAncestorContainer: host,
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 300, bottom: 130 }),
    }),
    toString: () => '这是一段足够长的选区',
  } as unknown as Selection)
}

/** 撤掉选区（模拟浏览器在 mousedown 后清空选区）。 */
function clearSelection(): void {
  vi.spyOn(window, 'getSelection').mockReturnValue(null as unknown as Selection)
}

beforeEach(() => {
  vi.useFakeTimers()
  takePendingQuote() // 清掉上一用例残留的引用（读走即清）
})

afterEach(() => {
  cleanup()
  clearSelection()
  vi.useRealTimers()
})

/** 渲染触发器并模拟一次「在正文里选完松开鼠标」：浮层 portal 在 body 下。 */
function renderTriggersAndPick(renderSlot?: unknown): HTMLElement {
  const { container } = render(
    <div className="chat">
      <div>正文宿主</div>
      <Triggers {...(renderSlot === undefined ? {} : { renderSlot })} />
    </div>,
  )
  stubSelection(container.querySelector('.chat'))
  fireEvent.mouseUp(document)
  act(() => {
    vi.advanceTimersByTime(1)
  })
  const bubble = document.body.querySelector('.ask-sel-actions')
  if (bubble === null) throw new Error('选区浮层没有浮出来')
  return bubble as HTMLElement
}

describe('登记：内置那一颗也走链（ui-ask-selection-slot [2] 行为化）', () => {
  test('shell.header 那条是 ask.triggers / order 80，children 开出选区动作子槽', () => {
    const header = registrations().find((item) => item.slot === 'shell.header')
    expect(header).toBeDefined()
    expect(header?.options['id']).toBe('ask.triggers')
    expect(header?.options['order']).toBe(80)
    expect(header?.options['children']).toEqual({ 'ask.selection.action': 'list' })
  })

  test('内置动作以 ask.selection.builtin / order 0 / priority 100 登记，交出去的组件就是 AskSelectionAction', () => {
    const builtin = registrations().find((item) => item.slot === 'ask.selection.action')
    expect(builtin).toBeDefined()
    expect(builtin?.options['id']).toBe('ask.selection.builtin')
    expect(builtin?.options['order']).toBe(0)
    expect(builtin?.options['priority']).toBe(100)
    expect(builtin?.component).toBe(AskSelectionAction)
  })
})

describe('浮层渲染：链与兜底（ui-ask-selection-slot [3] 行为化）', () => {
  test('链在位时浮层只画 renderSlot 的结果，owner 交了选区原文与关浮层的回调', () => {
    const captured: Array<{ slot: string; owner: { text: string; close: () => void } }> = []
    const bubble = renderTriggersAndPick(
      (slot: string, owner: { text: string; close: () => void }): ReactNode => {
        captured.push({ slot, owner })
        return <button type="button" className="stub-action">{owner.text}</button>
      },
    )
    // 浮层随量宽重渲染，renderSlot 每帧都会再调——取最后一帧的调用为准。
    expect(captured.length).toBeGreaterThan(0)
    const call = captured[captured.length - 1]
    expect(call?.slot).toBe('ask.selection.action')
    expect(call?.owner.text).toBe('这是一段足够长的选区')
    expect(typeof call?.owner.close).toBe('function')
    // 内置那一颗不直画（它挂在链上，画不画由 renderSlot 决定）。
    expect(bubble.querySelector('.ask-sel-btn')).toBeNull()
    expect(bubble.querySelector('.stub-action')).toBeTruthy()
    // close 生效：浮层关掉自己。
    act(() => {
      call?.owner.close()
    })
    expect(document.body.querySelector('.ask-sel-actions')).toBeNull()
  })

  test('槽上下文缺席时兜底画内置那一颗（插件没装好时问 AI 还在）', () => {
    const bubble = renderTriggersAndPick()
    const btn = bubble.querySelector('.ask-sel-btn')
    expect(btn).toBeTruthy()
    expect(btn?.textContent).toContain('问 AI')
    // 兜底那一颗也是全功能的：点它开旁问（带上选区原文）并关浮层。
    fireEvent.click(btn as HTMLElement)
    expect(takePendingQuote()).toBe('这是一段足够长的选区')
    expect(document.body.querySelector('.ask-sel-actions')).toBeNull()
  })

  test('点浮层里任一颗动作都不触发「重新读选区」（判容器不判某颗按钮）', () => {
    const bubble = renderTriggersAndPick()
    const btn = bubble.querySelector('.ask-sel-btn') as HTMLElement
    // 浏览器在 mousedown 时会撤选区：此后任何「重新读」都会把浮层收掉。
    clearSelection()
    fireEvent.mouseDown(btn)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    // 判到容器上就不会重新读——浮层还挂着，动作来得及等到 click。
    expect(document.body.querySelector('.ask-sel-actions')).toBeTruthy()
  })
})

describe('内置动作组件（AskSelectionAction）', () => {
  test('按下拦掉浏览器撤选区（preventDefault），点下开旁问带上原文并关浮层', () => {
    const closed = vi.fn()
    const { container } = render(<AskSelectionAction text="选中的话" close={closed} />)
    const btn = container.querySelector('.ask-sel-btn') as HTMLElement
    expect(btn.textContent).toContain('问 AI')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    btn.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    fireEvent.click(btn)
    expect(takePendingQuote()).toBe('选中的话')
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
