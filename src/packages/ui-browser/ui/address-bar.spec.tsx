/**
 * 浏览器页签地址栏（`ui.tsx` 的 BrowserTab）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-browser-address-test.mjs` 第 [3] 段「插件只有这一个入口」（缺口清单
 * B36「ui-browser-address [3]」）。原探针钉的是源码文本（import 了 `normalizeAddress`、
 * 回车走它、插件里没有第二份协议判断、badScheme 提示、空态文案）；这里把同一件事行为化：
 * 真把页签画出来打字回车——
 *   - `javascript:` 进不去（闸门行为，等于「没有第二份 startsWith 判定」的直接证据：
 *     就地绕开 normalizeAddress 的写法会让伪协议顺着地址栏漏进原生视图）；
 *   - 裸域名补 https 后才发 `browserNav`（证明回车真的走了这个纯函数，不是自己判）；
 *   - 空串与坏协议各给人话提示、不发导航。
 *
 * 不迁的：[1][2] 两段纯函数已迁 `address.spec.ts`；原生桥的白名单登记由
 * `side-ask.spec.ts` 的通道白名单段兜着。
 *
 * @module dsc-ui-browser/ui/address-bar.spec
 */
import { beforeAll, beforeEach, afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { dockTabMeta, makeTab, type DockTab } from '@dsc/ui-dockkit'
import plugin from './ui.js'

const NO_TAB: DockTab = { id: '', kind: 'browser' }

/** BrowserTab 不直接导出：经 apply 报名进页签台账收下（生产壳的装配路）。 */
function browserTabComponent(): ComponentType<{ tab: DockTab; active: boolean; expanded: boolean }> {
  // apply 里还订阅两条原生全局事件——桥缺席时 on 返回空退订，apply 照常走完。
  // 本插件的 apply 不用 ui 参数（页签报名走 registerDockTab），替身给个空壳即可。
  const apply = plugin.apply as unknown as (ui?: never) => () => void
  const off = apply(undefined as never)
  const meta = dockTabMeta('browser')
  if (meta === undefined) throw new Error('browser 插件没有把页签体报名进台账')
  // 组件收下后立刻退订报名（本文件自管台账，不给别的测试留页签）。
  off()
  return meta.component as ComponentType<{ tab: DockTab; active: boolean; expanded: boolean }>
}

let BrowserTab: ComponentType<{ tab: DockTab; active: boolean; expanded: boolean }>

/** 原生桥替身：call 记录每次调用的操作与实参，on 给一条空退订。 */
function stubBridge(): { calls: Array<{ op: string; args: readonly unknown[] }> } {
  const calls: Array<{ op: string; args: readonly unknown[] }> = []
  vi.stubGlobal('dscNative', {
    version: 1,
    call: (op: string, args: unknown[]): Promise<unknown> => {
      calls.push({ op, args })
      // dockBrowser 的回执决定 bound（视图摆好了没有）：替身一律应答「接住了」。
      return Promise.resolve(op === 'dockBrowser' ? true : null)
    },
    on: (): () => void => () => undefined,
  })
  return { calls }
}

/** jsdom 没有 ResizeObserver：可见性上报的观察器给个空桩。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const renderTab = (): ReturnType<typeof render> =>
  render(<BrowserTab tab={makeTab('browser', undefined, 'spec-b1')} active={true} expanded={true} />)

/** 地址栏输入一串并回车。 */
const typeAndEnter = (input: HTMLElement, text: string): void => {
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

beforeAll(() => {
  BrowserTab = browserTabComponent()
})

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('空态与占位（ui-browser-address [3]）', () => {
  test('新页签不自动加载任何页面：空态说「输入 HTTP(S) 地址开始浏览」', () => {
    const { calls } = stubBridge()
    const { container } = renderTab()
    expect(container.querySelector('.browser-empty')?.textContent).toBe('输入 HTTP(S) 地址开始浏览')
    expect(calls.filter((entry) => entry.op === 'browserNav')).toEqual([])
  })

  test('桥不在（浏览器 / 远程壳）给一句人话，不画地址栏', () => {
    vi.stubGlobal('dscNative', undefined)
    const { container } = render(<BrowserTab tab={NO_TAB} active={true} expanded={true} />)
    expect(container.querySelector('.browser-url')).toBeNull()
    expect(container.textContent).toContain('浏览器里没有它')
  })
})

describe('回车的分流：整得出地址才发导航（ui-browser-address [3] 行为化）', () => {
  test('裸域名补 https 后发 browserNav——回车真的走了 normalizeAddress', async () => {
    const { calls } = stubBridge()
    const { container } = renderTab()
    // 视图「摆好」要等 holder 量出一个落进视口的矩形（jsdom 不布局，全 0 会被当成
    // 还在滑入过渡里）：给占位区一个可用矩形，dockBrowser 回执一到 bound 就成立。
    const holder = container.querySelector('.browser-holder') as HTMLElement
    vi.spyOn(holder, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 400))
    typeAndEnter(container.querySelector('.browser-url') as HTMLInputElement, 'github.com')
    await waitFor(() => {
      expect(calls.some((entry) => entry.op === 'browserNav')).toBe(true)
    })
    expect(calls).toContainEqual({ op: 'browserNav', args: ['https://github.com/', 'load', 'spec-b1'] })
    expect(container.querySelector('.browser-error')).toBeNull()
  })

  test('javascript: 进不去：给 badScheme 人话，不向原生视图发任何导航', () => {
    const { calls } = stubBridge()
    const { container } = renderTab()
    typeAndEnter(container.querySelector('.browser-url') as HTMLInputElement, 'javascript:alert(1)')
    expect(container.querySelector('.browser-error')?.textContent).toBe('只支持 http/https 地址')
    expect(calls.filter((entry) => entry.op === 'browserNav')).toEqual([])
  })

  test('空串给「先输一个地址」，file: 同样拦下', () => {
    const { calls } = stubBridge()
    const { container } = renderTab()
    typeAndEnter(container.querySelector('.browser-url') as HTMLInputElement, '   ')
    expect(container.querySelector('.browser-error')?.textContent).toBe('先输一个地址')
    typeAndEnter(container.querySelector('.browser-url') as HTMLInputElement, 'file:///etc/passwd')
    expect(container.querySelector('.browser-error')?.textContent).toBe('只支持 http/https 地址')
    expect(calls.filter((entry) => entry.op === 'browserNav')).toEqual([])
  })
})
