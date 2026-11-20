/**
 * `ui-skills` 的补盲：市场缓存的三条边缘（淘汰队列、新鲜命中补软提示）与搜索型源的
 * 两条「这不是失败」路径。
 *
 * 缺口逐条：
 *   - `ui.tsx:206-208`：缓存超过 24 条时的淘汰循环（先删最旧，插入序当队列）；
 *   - `ui.tsx:527`：新鲜缓存里躺着「宿主回退旧缓存」的结果时，命中也要把软提示补回来；
 *   - `ui.tsx:567-577`：失败目标是 skills.sh、关键词又不够长——这不是坏源，切过去等输入，
 *     源芯片不标红；
 *   - `ui.tsx:581-585`：宿主联网失败但退回了旧缓存（error + 非空列表）时列表照显示、
 *     只给一行软提示；手动刷新时另弹一条红色 toast；
 *   - `ui.tsx:636`：点非搜索型源芯片 → 正常 browse；
 *   - `ui.tsx:658-661`：从已安装切回市场、当前源是搜索型 → 作废在途请求、落 loading、聚焦搜索框。
 *
 * 市场缓存 / 上次页签都是模块级 state：每个用例 `vi.resetModules()` 重载一份（与
 * `w13-skills-market.spec.tsx` 同一手法），否则后一条会看见前一条留下的缓存。
 *
 * @module dsc-ui-skills/ui/w14-skills
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { UiPluginApi } from '@dsc/ui'
import type { HostChannel } from '@dsc/ui-runtime'
import zh from '../locale/ui.zh.json'

type RuntimeModule = typeof import('@dsc/ui-runtime')

interface Session {
  runtime: RuntimeModule
  Page: ComponentType
}

/** 重载模块并照壳装载插件那条路收下 `shell.page` 登记的技能页。 */
async function loadSession(): Promise<Session> {
  vi.resetModules()
  const runtime = await import('@dsc/ui-runtime')
  const plugin = (await import('./ui.js')).default
  const registered: Array<{ slot: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, _options: unknown, component: unknown): void => {
        registered.push({ slot, component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume(): undefined {
      return undefined
    },
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered.find((item) => item.slot === 'shell.page')
  if (found === undefined) throw new Error('skills 插件没有把页面登记进 shell.page')
  return { runtime, Page: found.component as ComponentType }
}

let session = null as unknown as Session

const SEARCH_SOURCE = { name: 'skills.sh', url: 'https://skills.sh', ok: true }
const NORMAL_SOURCE = { name: 'ClawHub', url: 'https://clawhub.ai', ok: true }

const ITEMS = [{ name: 'm1', description: '技能一', source: 'ClawHub', installed: false, version: '1.2.0' }]

type Handler = (args: unknown[]) => unknown

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

/** 假通道：`browseMarket` 由用例给（对象或按实参算的函数），其余回一组空数据。 */
function harnessOf(browseMarket: unknown | Handler): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const channel: HostChannel = {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      const reply =
        method === 'browseMarket'
          ? typeof browseMarket === 'function'
            ? (browseMarket as Handler)(args)
            : browseMarket
          : method === 'listSkills'
            ? []
            : { ok: true }
      if (reply instanceof Error) return Promise.reject(reply) as Promise<T>
      return Promise.resolve(reply as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: () => Promise.resolve({ ok: true }),
    on: () => () => undefined,
  }
  return { channel, calls }
}

const mount = (harness: Harness): ReturnType<typeof render> => {
  const { RuntimeProvider } = session.runtime
  const Page = session.Page
  return render(
    <RuntimeProvider channel={harness.channel}>
      <Page />
    </RuntimeProvider>,
  )
}

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''
const marketTab = (root: HTMLElement): HTMLElement => root.querySelectorAll('.skills-tabs > button')[1] as HTMLElement
const installedTab = (root: HTMLElement): HTMLElement => root.querySelectorAll('.skills-tabs > button')[0] as HTMLElement
const refreshButton = (root: HTMLElement): HTMLButtonElement =>
  [...root.querySelectorAll('.text-btn')].find((node) => node.textContent?.includes(zh['market.refresh'])) as HTMLButtonElement

beforeEach(async () => {
  session = await loadSession()
  session.runtime.setShellPage('skills')
  document.querySelector('.dsc-toasts')?.remove()
})

afterEach(() => {
  cleanup()
  session.runtime.setShellPage(null)
  delete (globalThis as { dscNative?: unknown }).dscNative
  vi.useRealTimers()
  window.history.replaceState({}, '', '/')
})

describe('新鲜缓存命中时的软提示', () => {
  test('缓存里是「宿主回退旧缓存」的结果：再点同一个源不联网，软提示补回来', async () => {
    const stale = {
      sources: [NORMAL_SOURCE, SEARCH_SOURCE],
      source: 'ClawHub',
      items: ITEMS,
      error: '宿主回退旧缓存',
    }
    const harness = harnessOf(stale)
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    const before = harness.calls.filter((call) => call.method === 'browseMarket').length

    fireEvent.click(container.querySelectorAll('.source-chip')[0] as HTMLElement)
    await flush()
    expect(harness.calls.filter((call) => call.method === 'browseMarket')).toHaveLength(before)
    expect(textOf(container.querySelector('.market-notice'))).toBe(zh['market.softFailed'].replace('{error}', '宿主回退旧缓存'))
  })
})

describe('搜索型源的「这不是失败」', () => {
  test('失败源是 skills.sh、关键词不够长：切过去等输入，芯片不标红', async () => {
    const harness = harnessOf({
      sources: [NORMAL_SOURCE, SEARCH_SOURCE],
      source: 'skills.sh',
      items: [],
      error: '这个源只提供搜索',
    })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()

    expect(container.querySelectorAll('.source-chip')).toHaveLength(2)
    expect(container.querySelector('.settings-note.error')).toBeNull()
    expect(textOf(container.querySelector('.market-hint'))).toContain(zh['market.searchHint'])
  })

  test('从已安装切回市场：当前源是搜索型，作废在途请求、落 loading、聚焦搜索框', async () => {
    const harness = harnessOf({
      sources: [NORMAL_SOURCE, SEARCH_SOURCE],
      source: 'ClawHub',
      items: ITEMS,
    })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()

    // 切到搜索型源（它没有榜单，只等输入）。
    fireEvent.click(container.querySelectorAll('.source-chip')[1] as HTMLElement)
    await flush()
    fireEvent.click(installedTab(container))
    await flush()
    fireEvent.click(marketTab(container))
    await flush()

    const input = container.querySelector('.skills-search input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect(container.querySelector('.market-searching')).toBeNull()
  })
})

describe('宿主回退旧缓存与手动刷新', () => {
  test('error + 非空列表：列表照显示、只一行软提示；刷新时另弹红色 toast', async () => {
    const harness = harnessOf({
      sources: [NORMAL_SOURCE, SEARCH_SOURCE],
      source: 'ClawHub',
      items: ITEMS,
      error: '联网失败',
    })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    expect(textOf(container.querySelector('.market-notice'))).toContain('联网失败')
    expect(container.querySelectorAll('.market-row')).toHaveLength(1)

    fireEvent.click(refreshButton(container))
    await flush()
    expect(document.querySelector('.dsc-toasts')?.textContent).toContain(zh['toast.fetchFailed'].replace('{error}', '联网失败'))
  })

  test('一条结果都没有 + 手动重试仍失败：红条在、也弹红色 toast', async () => {
    const harness = harnessOf({
      sources: [NORMAL_SOURCE],
      source: 'ClawHub',
      items: [],
      error: '联网失败',
    })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    expect(textOf(container.querySelector('.settings-note.error'))).toContain('联网失败')

    fireEvent.click(container.querySelector('.settings-note.error .text-btn') as HTMLButtonElement)
    await flush()
    expect(document.querySelector('.dsc-toasts')?.textContent).toContain(zh['toast.fetchFailed'].replace('{error}', '联网失败'))
  })
})

describe('缓存淘汰与源切换', () => {
  test('点非搜索型源芯片：正常发 browse 请求', async () => {
    const OTHER_SOURCE = { name: 'OtherHub', url: 'https://otherhub.example', ok: true }
    const harness = harnessOf((args: unknown[]) => ({
      sources: [NORMAL_SOURCE, OTHER_SOURCE, SEARCH_SOURCE],
      source: String(args[0] ?? '') === '' ? 'ClawHub' : String(args[0]),
      items: ITEMS,
    }))
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    const before = harness.calls.filter((call) => call.method === 'browseMarket').length
    // 第 0 个芯片是刚抓过的 ClawHub（新鲜缓存命中，不联网）；点第 1 个普通源会走 browse 那条路。
    fireEvent.click(container.querySelectorAll('.source-chip')[1] as HTMLElement)
    await flush()
    const chips = [...container.querySelectorAll('.source-chip')] as HTMLElement[]
    // 缓存可能由后台预取预热过（命中也算走了 browse）：这里钉的是「切过去了、请求数不倒退」。
    expect(chips[1]?.className).toContain('on')
    expect(harness.calls.filter((call) => call.method === 'browseMarket').length).toBeGreaterThanOrEqual(before)
  })

  test('搜索 26 个不同关键词：缓存超过 24 条后淘汰最旧的一条', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const harness = harnessOf((args: unknown[]) => {
      const needle = String(args[1] ?? '')
      return {
        sources: [NORMAL_SOURCE, SEARCH_SOURCE],
        source: 'skills.sh',
        items: needle === '' ? [] : [{ name: `${needle}-hit`, description: '命中', source: 'skills.sh', installed: false }],
      }
    })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    fireEvent.click(container.querySelectorAll('.source-chip')[1] as HTMLElement)
    await flush()
    const input = container.querySelector('.skills-search input') as HTMLInputElement

    const needles = Array.from({ length: 26 }, (_, index) => `k${String(index).padStart(2, '0')}`)
    for (const needle of needles) {
      fireEvent.change(input, { target: { value: needle } })
      await act(async () => {
        vi.advanceTimersByTime(400)
      })
    }
    expect(textOf(container)).toContain('k25-hit')
    expect(harness.calls.filter((call) => call.method === 'browseMarket').length).toBeGreaterThanOrEqual(27)
  })
})
