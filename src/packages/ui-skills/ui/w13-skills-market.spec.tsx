/**
 * 技能页第三批补测（`ui-skills/ui/ui.tsx`）：市场缓存复用、搜索型源的三种「不发请求」、
 * 保存市场源的三条失败路径，以及列表区的键盘与空态入口。
 *
 * 已有两份 spec 的分工：`ui.spec` 钉住列表分组/筛选/启停/正文/市场主流程，`w11-branches`
 * 钉住自检钩子、刷新失败、防抖查询与缓存还原。这一份只补它们没碰到的分支：
 *
 * - 新鲜缓存里带着「宿主回退旧缓存」的结果时，命中也要把软提示补回来；
 * - 首个源就是搜索型源：切回市场不发请求、切过去等输入；
 * - 保存市场源后按新首源浏览：首源是搜索型源时同样不发请求；
 * - 搜索型源换关键词时保留上一次结果（不清空）；
 * - 保存市场源的「宿主拒绝」与「桥抛错」两条回执；
 * - 页签切回已安装、空列表的「去市场」入口、组头的键盘折叠。
 *
 * 每条用例都重载一份 ui 模块：市场缓存 / 上次页签 / 预取标记都是模块级 state，
 * 共用一份会让后一条用例看见前一条留下的缓存（理由见 w11-branches.spec 文件头）。
 *
 * @module dsc-ui-skills/ui/w13-skills-market.spec
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
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered.find((item) => item.slot === 'shell.page')
  if (found === undefined) throw new Error('skills 插件没有把页面登记进 shell.page')
  return { runtime, Page: found.component as ComponentType }
}

let session = null as unknown as Session

interface SkillRow {
  name: string
  description: string
  source: string
  enabled: boolean
  modelInvocable: boolean
  userInvocable: boolean
  toggleable: boolean
  scope?: 'project' | 'global'
}

const ROWS: SkillRow[] = [
  {
    name: 'pdf-tools',
    description: '处理 PDF',
    source: 'user-dsc',
    enabled: true,
    modelInvocable: true,
    userInvocable: true,
    toggleable: true,
    scope: 'global',
  },
  {
    name: 'proj-helper',
    description: '项目技能',
    source: 'project-dsc',
    enabled: true,
    modelInvocable: true,
    userInvocable: true,
    toggleable: true,
    scope: 'project',
  },
]

const SEARCH_SOURCE = { name: 'skills.sh', url: 'https://skills.sh', ok: true }
const NORMAL_SOURCE = { name: 'ClawHub', url: 'https://clawhub.ai', ok: true }

const MARKET = {
  sources: [NORMAL_SOURCE, SEARCH_SOURCE],
  source: 'ClawHub',
  items: [
    { name: 'm1', description: '技能一', source: 'ClawHub', installed: false, version: '1.2.0' },
    { name: 'm2', description: '技能二', source: 'ClawHub', installed: true },
  ],
}

type Handler = (args: unknown[]) => unknown

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
  nativeCalls: Array<{ op: string; args: unknown[] }>
}

function harnessOf(
  overrides: Record<string, unknown | Handler> = {},
  nativeReply: unknown = { ok: true },
): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const nativeCalls: Array<{ op: string; args: unknown[] }> = []
  const replies: Record<string, unknown | Handler> = {
    listSkills: ROWS,
    setSkillEnabled: { ok: true },
    ...overrides,
  }
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
        replies[method] ??
        (method === 'browseMarket'
          ? { ...MARKET, source: typeof args[0] === 'string' && args[0] !== '' ? args[0] : MARKET.source }
          : undefined)
      try {
        const value = typeof reply === 'function' ? (reply as Handler)(args) : reply
        if (value instanceof Error) return Promise.reject(value) as Promise<T>
        return Promise.resolve(value ?? { ok: true }) as Promise<T>
      } catch (error: unknown) {
        return Promise.reject(error) as Promise<T>
      }
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []): Promise<unknown> => {
      nativeCalls.push({ op, args })
      if (op === 'setMarketSources') {
        return nativeReply instanceof Error ? Promise.reject(nativeReply) : Promise.resolve(nativeReply)
      }
      return Promise.resolve({ ok: true })
    },
    on: () => () => undefined,
  }
  return { channel, calls, nativeCalls }
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
const query = (root: HTMLElement, selector: string): HTMLElement | null =>
  root.querySelector(selector) as HTMLElement | null

const browseCalls = (harness: Harness): Array<{ args: unknown[] }> =>
  harness.calls.filter((call) => call.method === 'browseMarket')

const marketTab = (root: HTMLElement): HTMLElement =>
  root.querySelectorAll('.skills-tabs > button')[1] as HTMLElement
const installedTab = (root: HTMLElement): HTMLElement =>
  root.querySelectorAll('.skills-tabs > button')[0] as HTMLElement

/** 打开市场源编辑框并写入一段文本，返回「保存」按钮。 */
function openSourcesEditor(container: HTMLElement, text: string): HTMLButtonElement {
  const edit = [...container.querySelectorAll('.market-sources .text-btn')].find((node) =>
    node.textContent?.includes('编辑源'),
  )
  if (edit === undefined) throw new Error('找不到「编辑市场源」按钮')
  fireEvent.click(edit)
  const textarea = query(container, '.market-edit textarea') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: text } })
  return query(container, '.market-edit .btn-primary') as HTMLButtonElement
}

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

describe('市场缓存与搜索型源的「不发请求」', () => {
  test('新鲜缓存里是「宿主回退旧缓存」的结果：命中时把软提示也补回来', async () => {
    const stale = { ...MARKET, error: '宿主回退旧缓存' }
    const harness = harnessOf({ browseMarket: stale })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    // 首次请求的缓存里带着 error + 非空列表；别名键（ClawHub|）也被写了一份。
    const before = browseCalls(harness).length
    fireEvent.click(container.querySelectorAll('.source-chip')[0] as HTMLElement)
    await flush()
    expect(browseCalls(harness).length).toBe(before)
    expect(textOf(query(container, '.market-notice'))).toBe(
      zh['market.softFailed'].replace('{error}', '宿主回退旧缓存'),
    )
  })

  test('首个源就是搜索型源：切回市场不发请求，直接切过去等输入', async () => {
    const searchFirst = {
      sources: [SEARCH_SOURCE, NORMAL_SOURCE],
      source: '',
      items: [],
      error: '这个源只提供搜索',
    }
    const harness = harnessOf({ browseMarket: searchFirst })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    const firstLoads = browseCalls(harness).length
    expect(firstLoads).toBeGreaterThanOrEqual(1)

    fireEvent.click(installedTab(container))
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    // 第二个源是普通源但首个源是 skills.sh：browse('') 直接早退，不联网
    expect(browseCalls(harness).length).toBe(firstLoads)
    expect(textOf(query(container, '.market-hint'))).toContain(zh['market.searchHint'])
  })

  test('保存市场源后按新首源浏览：首源是搜索型源时不发请求', async () => {
    const harness = harnessOf({ browseMarket: MARKET })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()

    const save = openSourcesEditor(container, 'skills.sh, https://skills.sh')
    const before = browseCalls(harness).length
    fireEvent.click(save)
    await flush()
    expect(harness.nativeCalls).toContainEqual({
      op: 'setMarketSources',
      args: [[{ name: 'skills.sh', url: 'https://skills.sh' }]],
    })
    // 新首源是搜索型源：browse('skills.sh') 不发请求，只是切过去等输入
    expect(browseCalls(harness).length).toBe(before)
    // 此刻源清单已被保存流程清空、又没有新请求把它拿回来，所以源芯片是空的
    //（产品问题，记在产出里：ui.tsx:928 + 496-504，见报告）
    expect(container.querySelectorAll('.source-chip')).toHaveLength(0)
  })

  test('搜索型源换关键词：上一次的结果先留着，不清空', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const harness = harnessOf({
      browseMarket: (args: unknown[]) => {
        const needle = typeof args[1] === 'string' ? args[1] : ''
        // 第二次查询挂着不回来：验证「新结果回来之前旧结果不消失」
        if (needle === 'cd') return new Promise(() => undefined)
        return {
          sources: [NORMAL_SOURCE, SEARCH_SOURCE],
          source: 'skills.sh',
          items:
            needle === ''
              ? []
              : [{ name: `${needle}-hit`, description: '命中', source: 'skills.sh', installed: false }],
        }
      },
    })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    fireEvent.click(container.querySelectorAll('.source-chip')[1] as HTMLElement)
    await flush()

    const input = container.querySelector('.skills-search input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ab' } })
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(textOf(container)).toContain('ab-hit')

    const before = browseCalls(harness).length
    fireEvent.change(input, { target: { value: 'cd' } })
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(browseCalls(harness).length).toBe(before + 1)
    // 新结果还挂着没回来：上一次的结果仍在屏幕上（换关键词不清空）
    expect(textOf(container)).toContain('ab-hit')
    expect(browseCalls(harness).at(-1)).toMatchObject({ method: 'browseMarket', args: ['skills.sh', 'cd'] })
  })
})

describe('保存市场源的失败回执', () => {
  test('宿主拒绝（ok:false）：Toast 写「保存失败」并保留原因', async () => {
    const harness = harnessOf({ browseMarket: MARKET }, { ok: false, error: '源格式被拒' })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()

    fireEvent.click(openSourcesEditor(container, 'ClawHub, https://clawhub.ai'))
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(
      zh['toast.saveFailed'].replace('{error}', '源格式被拒'),
    )
    // 保存失败不收起编辑框
    expect(query(container, '.market-edit')).not.toBeNull()
  })

  test('原生桥抛错：Toast 写「保存失败」并保留原文', async () => {
    const harness = harnessOf({ browseMarket: MARKET }, new Error('settings.json 只读'))
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()

    fireEvent.click(openSourcesEditor(container, 'ClawHub, https://clawhub.ai'))
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(
      zh['toast.saveFailed'].replace('{error}', 'settings.json 只读'),
    )
  })
})

describe('列表区的页签、空态与键盘折叠', () => {
  test('市场切回已安装：作用域条与技能列表回来', async () => {
    const harness = harnessOf({ browseMarket: MARKET })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(marketTab(container))
    await flush()
    expect(query(container, '.skills-scope')).toBeNull()

    fireEvent.click(installedTab(container))
    await flush()
    expect(query(container, '.skills-scope')).not.toBeNull()
    expect(textOf(container)).toContain('pdf-tools')
  })

  test('空技能列表：空态卡的「去市场」按钮切到市场页签', async () => {
    const harness = harnessOf({ listSkills: [], browseMarket: MARKET })
    const { container } = mount(harness)
    await flush()
    const emptyCard = query(container, '.empty-card') as HTMLElement
    expect(textOf(emptyCard)).toContain(zh['empty.title'])
    const toMarket = [...emptyCard.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(zh['empty.toMarket']),
    ) as HTMLButtonElement
    fireEvent.click(toMarket)
    await flush()
    expect(query(container, '.skills-scope')).toBeNull()
    expect(textOf(container)).toContain('m1')
  })

  test('组头键盘：Enter 与空格都能折叠 / 展开该组', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const head = query(container, '.skills-group-head') as HTMLElement
    expect(head.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(head, { key: 'Enter' })
    expect(query(container, '.skills-group-head')?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(query(container, '.skills-group-head') as HTMLElement, { key: ' ' })
    expect(query(container, '.skills-group-head')?.getAttribute('aria-expanded')).toBe('true')
    // 别的键不翻
    fireEvent.keyDown(query(container, '.skills-group-head') as HTMLElement, { key: 'a' })
    expect(query(container, '.skills-group-head')?.getAttribute('aria-expanded')).toBe('true')
  })
})
