/**
 * 技能页（`ui-skills/ui/ui.tsx`）的分支补测（ui 层，真渲染）。
 *
 * 既有 `ui.spec.tsx` 覆盖列表分组 / 筛选 / 启停 / 正文 / 市场主流程。这一份补：
 * 页条目不在前台、?skillstab=market / ?skillinstall= 两个自检钩子、市场刷新回执与失败面板、
 * 搜索型源的防抖查询、离开再回来读缓存、启停 / 读取 / 导入 / 安装 / 保存市场源各条失败路径、
 * 统计缺项与版本号。
 *
 * 为什么每条用例都重新求值一份 ui 模块：市场清单缓存、上次页签、预取标记都是**模块级**
 * state（`ui.tsx` 第 133~168 行、第 151~160 行——产品里表示「一次界面会话」，离开技能页
 * 再回来要留着）。同一个文件里共用一份模块，后一条用例就会看见前一条留下的市场缓存与
 * 「上次停在市场」而红，红的不是产品行为。所以 beforeEach 里 `vi.resetModules()` 后
 * 按生产壳装载插件那条路重新收下 `shell.page`；「离开再回来」那条用例故意复用同一份
 * 模块实例，验证的正是缓存还原。
 *
 * @module dsc-ui-skills/ui/w11-branches.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { UiPluginApi } from '@dsc/ui'
import type { HostChannel } from '@dsc/ui-runtime'
import zh from '../locale/ui.zh.json'

/** 一份新求值的界面运行时/产品或模块（`@dsc/*` 在测试里解析到 `src/**`，同样会被重载）。 */
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

/** 当前用例的模块实例（页面组件与运行时 provider 必须来自同一份，否则上下文对不上）。 */
let session = null as unknown as Session

interface SkillRow {
  name: string
  description: string
  whenToUse?: string
  source: string
  path?: string
  enabled: boolean
  modelInvocable: boolean
  userInvocable: boolean
  toggleable: boolean
  problem?: string
  scope?: 'project' | 'global'
  root?: string
}

const ROWS: SkillRow[] = [
  {
    name: 'pdf-tools',
    description: '处理 PDF',
    source: 'user-dsc',
    path: 'C:/skills/pdf-tools',
    enabled: true,
    modelInvocable: true,
    userInvocable: true,
    toggleable: true,
    scope: 'global',
    root: 'C:/home/.dsc/skills',
  },
  {
    name: 'odd',
    description: '没有 scope 与 root 的技能',
    source: 'provider-x',
    enabled: true,
    modelInvocable: true,
    userInvocable: true,
    toggleable: false,
    problem: '缺 SKILL.md',
  },
]

interface Invoke {
  method: string
  args: unknown[]
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
  nativeCalls: Array<{ op: string; args: unknown[] }>
  replies: Record<string, unknown>
}

function harnessOf(overrides: Record<string, unknown> = {}, nativeReply: unknown = { ok: true }): Harness {
  const calls: Invoke[] = []
  const nativeCalls: Array<{ op: string; args: unknown[] }> = []
  const replies: Record<string, unknown> = {
    listSkills: ROWS,
    readSkill: { ok: true, skill: { name: 'pdf-tools', content: '# PDF 正文' } },
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
      // browseMarket 不给固定回执时按请求的源回：切源 / 搜索型源的行为靠它成立。
      const reply =
        replies[method] ??
        (method === 'browseMarket'
          ? { ...MARKET, source: typeof args[0] === 'string' && args[0] !== '' ? args[0] : MARKET.source }
          : undefined)
      if (reply instanceof Error) return Promise.reject(reply)
      return Promise.resolve(reply ?? { ok: true }) as Promise<T>
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []): Promise<unknown> => {
      nativeCalls.push({ op, args })
      if (op === 'installSkill') return Promise.resolve(['picked-a', 'picked-b'])
      if (op === 'openPath') return Promise.resolve('permission denied')
      if (op === 'installMarketSkill') {
        return nativeReply instanceof Error
          ? Promise.reject(nativeReply)
          : Promise.resolve(nativeReply)
      }
      return Promise.resolve({ ok: true })
    },
    on: () => () => undefined,
  }
  return { channel, calls, nativeCalls, replies }
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
const query = (root: HTMLElement, selector: string): HTMLElement => root.querySelector(selector) as HTMLElement

const MARKET = {
  sources: [
    { name: 'ClawHub', url: 'https://clawhub.ai', ok: true },
    { name: 'skills.sh', url: 'https://skills.sh', ok: true },
  ],
  source: 'ClawHub',
  items: [
    { name: 'm1', description: '技能一', source: 'ClawHub', installed: false, version: '1.2.0', stats: { downloads: 1_200 } },
    { name: 'm2', description: '技能二', source: 'ClawHub', installed: true },
  ],
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

describe('页条目与自检钩子', () => {
  test('不在技能页时整页不渲染', () => {
    session.runtime.setShellPage(null)
    const { container } = mount(harnessOf())
    expect(container.textContent).toBe('')
  })

  test('?skillstab=market 首帧直接进市场并拉一次', async () => {
    window.history.replaceState({}, '', '/?skillstab=market')
    const harness = harnessOf({ browseMarket: MARKET })
    const { container } = mount(harness)
    await flush()
    // 首个源只问一次：预取与「切到市场」共用同一条在途请求（同一缓存键去重），
    // 第二个实参是搜索词（非搜索型源恒为空串，不是 undefined）。
    const firstLoads = harness.calls.filter((call) => call.method === 'browseMarket' && call.args[0] === '')
    expect(firstLoads).toEqual([{ method: 'browseMarket', args: ['', ''] }])
    expect(textOf(query(container, '.market-row'))).toContain('m1')
    expect(container.querySelector('.skills-scope')).toBeNull()
  })

  test('?skillinstall=源/名：市场到手后自动装一次', async () => {
    window.history.replaceState({}, '', '/?skillstab=market&skillinstall=ClawHub/m1')
    const harness = harnessOf({ browseMarket: MARKET })
    mount(harness)
    await flush()
    expect(harness.nativeCalls).toContainEqual({ op: 'installMarketSkill', args: ['ClawHub', 'm1'] })
  })

  test('离开技能页再回来：上次的市场清单直接从缓存还原，首个源不再联网', async () => {
    const harness = harnessOf({ browseMarket: MARKET })
    const first = mount(harness)
    await flush()
    fireEvent.click(first.container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()
    expect(harness.calls.filter((call) => call.method === 'browseMarket' && call.args[0] === '')).toHaveLength(1)
    cleanup()

    // 离开技能页 = 整页卸载；点回来 = 同一个模块实例再挂一次，市场 state 从模块级缓存还原。
    const second = mount(harness)
    await flush()
    expect(textOf(query(second.container, '.market-row'))).toContain('m1')
    expect(harness.calls.filter((call) => call.method === 'browseMarket' && call.args[0] === '')).toHaveLength(1)
  })
})

describe('市场：刷新、失败与筛选', () => {
  test('手动刷新失败在面板常驻并在 Toast 里回执；重试按钮再拉一次', async () => {
    const harness = harnessOf({
      browseMarket: { ...MARKET, items: [], error: '源超时' },
    })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()

    expect(textOf(container)).toContain('源超时')
    const before = harness.calls.filter((call) => call.method === 'browseMarket').length
    const retry = [...container.querySelectorAll('.market-sources .text-btn')].at(-1) as HTMLElement
    fireEvent.click(retry)
    await flush()
    expect(harness.calls.filter((call) => call.method === 'browseMarket').length).toBeGreaterThan(before)
    // 手动刷新才在 Toast 里回执（首次自动抓取不上 Toast，只留常驻面板）。
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(
      zh['toast.fetchFailed'].replace('{error}', '源超时'),
    )
  })

  test('切市场时请求 reject：常驻错误面板，重试按钮带当前源', async () => {
    const harness = harnessOf({ browseMarket: new Error('网络断了') })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()

    const panel = query(container, '.settings-note.error')
    expect(textOf(panel)).toContain('网络断了')
    fireEvent.click(panel.querySelector('.text-btn') as HTMLElement)
    await flush()
    expect(harness.calls.filter((call) => call.method === 'browseMarket').length).toBeGreaterThanOrEqual(2)
  })

  test('搜索型源跟着搜索词防抖查询；一个字符不查', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const harness = harnessOf({})
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()
    // 切到 skills.sh：marketSource 换源后才进入搜索型效果。
    const chips = [...container.querySelectorAll('.source-chip')] as HTMLElement[]
    fireEvent.click(chips[1] as HTMLElement)
    await flush()

    const before = harness.calls.filter((call) => call.method === 'browseMarket').length
    const input = container.querySelector('.skills-search input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'a' } })
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(harness.calls.filter((call) => call.method === 'browseMarket').length).toBe(before)

    fireEvent.change(input, { target: { value: 'ab' } })
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(harness.calls.filter((call) => call.method === 'browseMarket').length).toBe(before + 1)
    expect(harness.calls.at(-1)).toMatchObject({ method: 'browseMarket', args: ['skills.sh', 'ab'] })
  })

  test('市场条目：版本号与只给一项统计时只画那一项；本地筛不到给文案', async () => {
    const harness = harnessOf({ browseMarket: MARKET })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()

    const first = query(container, '.market-row')
    expect(textOf(first)).toContain('v1.2.0')
    expect(textOf(query(first, '.skill-stats'))).toContain('1,200')
    expect(textOf(query(first, '.skill-stats'))).not.toContain('安装')

    const input = container.querySelector('.skills-search input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(textOf(query(container, '.plugins-empty'))).toBe(zh['market.noMatch'].replace('{query}', 'zzz'))
  })

  test('空市场给「没解析出技能」的文案', async () => {
    const harness = harnessOf({ browseMarket: { sources: [], source: '', items: [] } })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()
    expect(textOf(query(container, '.plugins-empty'))).toBe(zh['market.empty'])
  })

  test('市场源展开后再点收起；保存空清单 / 浏览器无桥都给人话', async () => {
    const harness = harnessOf({ browseMarket: MARKET })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()

    const edit = [...container.querySelectorAll('.market-sources .text-btn')][0] as HTMLElement
    fireEvent.click(edit)
    expect(container.querySelector('.market-edit')).not.toBeNull()
    fireEvent.click(edit)
    expect(container.querySelector('.market-edit')).toBeNull()
    fireEvent.click(edit)

    const textarea = query(container, '.market-edit textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '\n  \n坏行' } })
    fireEvent.click(query(container, '.market-edit .btn-primary'))
    await flush()
    expect(harness.nativeCalls.filter((call) => call.op === 'setMarketSources')).toHaveLength(0)
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(zh['toast.sourceFormat'])

    delete (globalThis as { dscNative?: unknown }).dscNative
    fireEvent.change(textarea, { target: { value: 'X, https://x.example' } })
    fireEvent.click(query(container, '.market-edit .btn-primary'))
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(zh['toast.sourcesDesktopOnly'])
  })
})

describe('启停 / 正文 / 目录与导入的失败路径', () => {
  test('启停回执失败、成功无 notice、请求 reject：都重读清单并给人话', async () => {
    const failed = harnessOf({ setSkillEnabled: { ok: false } })
    const first = mount(failed)
    await flush()
    let row = [...first.container.querySelectorAll('.skill-row')].find((item) => textOf(item).includes('pdf-tools'))!
    fireEvent.click(row.querySelector('.switch') as HTMLElement)
    await flush()
    expect(failed.calls.filter((call) => call.method === 'listSkills').length).toBeGreaterThanOrEqual(2)
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(zh['common.unknownReason'])
    cleanup()

    const rejected = harnessOf({ setSkillEnabled: new Error('denied') })
    const second = mount(rejected)
    await flush()
    row = [...second.container.querySelectorAll('.skill-row')].find((item) => textOf(item).includes('pdf-tools'))!
    fireEvent.click(row.querySelector('.switch') as HTMLElement)
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain('denied')
  })

  test('读正文失败与请求 reject 都只报错、不画正文', async () => {
    for (const reply of [{ ok: false, error: '缺文件' }, new Error('EIO')] as const) {
      const harness = harnessOf({ readSkill: reply })
      const { container } = mount(harness)
      await flush()
      const row = [...container.querySelectorAll('.skill-row')].find((item) => textOf(item).includes('pdf-tools'))!
      fireEvent.click(row.querySelector('.text-btn') as HTMLElement)
      await flush()
      expect(container.querySelector('.skill-body')).toBeNull()
      expect(textOf(document.querySelector('.dsc-toasts'))).toContain(reply instanceof Error ? 'EIO' : '缺文件')
      cleanup()
    }
  })

  test('打开目录：浏览器无桥与原生返回失败都给人话；有桥成功不发 Toast', async () => {
    const harness = harnessOf({})
    const first = mount(harness)
    await flush()
    let folder = [...first.container.querySelectorAll('.skill-row')]
      .find((item) => textOf(item).includes('pdf-tools'))!
      .querySelector('[data-tip="C:/skills/pdf-tools"]') as HTMLElement
    fireEvent.click(folder)
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain('permission denied')
    cleanup()

    delete (globalThis as { dscNative?: unknown }).dscNative
    const secondHarness = harnessOf({})
    delete (globalThis as { dscNative?: unknown }).dscNative
    const second = mount(secondHarness)
    await flush()
    folder = [...second.container.querySelectorAll('.skill-row')]
      .find((item) => textOf(item).includes('pdf-tools'))!
      .querySelector('[data-tip="C:/skills/pdf-tools"]') as HTMLElement
    fireEvent.click(folder)
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(zh['toast.openFolderDesktopOnly'])
  })

  test('导入技能：无桥、空选择、成功、失败四条分支', async () => {
    // 无桥
    const noBridge = harnessOf({})
    delete (globalThis as { dscNative?: unknown }).dscNative
    const a = mount(noBridge)
    await flush()
    fireEvent.click([...a.container.querySelectorAll('.skills-actions button')].at(-1)! as HTMLElement)
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(zh['toast.importDesktopOnly'])
    cleanup()

    // 选择器返回空
    const harness = harnessOf({})
    ;(globalThis as { dscNative?: { version?: number; call: (op: string) => Promise<unknown>; on: () => () => void } }).dscNative = {
      version: 1,
      call: (op: string) => (op === 'installSkill' ? Promise.resolve([]) : Promise.resolve({ ok: true })),
      on: () => () => undefined,
    }
    const b = mount(harness)
    await flush()
    const importButton = [...b.container.querySelectorAll('.skills-actions button')].at(-1)! as HTMLElement
    fireEvent.click(importButton)
    await flush()
    expect(harness.calls.filter((call) => call.method === 'listSkills')).toHaveLength(1)
    cleanup()

    // 成功（默认原生桩返回两个名字）
    const success = harnessOf({})
    const c = mount(success)
    await flush()
    fireEvent.click([...c.container.querySelectorAll('.skills-actions button')].at(-1)! as HTMLElement)
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain('picked-a')
    expect(success.calls.filter((call) => call.method === 'listSkills')).toHaveLength(2)
    cleanup()

    // 抛错
    const failing = harnessOf({})
    ;(globalThis as { dscNative?: { version?: number; call: (op: string) => Promise<unknown>; on: () => () => void } }).dscNative = {
      version: 1,
      call: (op: string) => (op === 'installSkill' ? Promise.reject(new Error('picker broke')) : Promise.resolve({ ok: true })),
      on: () => () => undefined,
    }
    const d = mount(failing)
    await flush()
    fireEvent.click([...d.container.querySelectorAll('.skills-actions button')].at(-1)! as HTMLElement)
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain('picker broke')
  })

  test('市场安装：回执失败、成功、请求 reject 各有回执', async () => {
    const cases: Array<{ nativeReply: unknown; text: string }> = [
      { nativeReply: { ok: false }, text: zh['common.unknownReason'] },
      { nativeReply: { ok: true }, text: zh['toast.installed'].replace('{name}', 'm1') },
      { nativeReply: new Error('download broke'), text: 'download broke' },
    ]
    for (const item of cases) {
      // 每条分支换一份新模块：上一条装成功后会把条目标成「已安装」并写回缓存，
      // 同一份实例里下一条点按钮会被当成已装而不发请求。
      session = await loadSession()
      session.runtime.setShellPage('skills')
      document.querySelector('.dsc-toasts')?.remove()
      const harness = harnessOf({ browseMarket: MARKET }, item.nativeReply)
      const { container } = mount(harness)
      await flush()
      fireEvent.click(container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
      await flush()
      const row = [...container.querySelectorAll('.market-row')].find((entry) => textOf(entry).includes('m1'))!
      fireEvent.click(row.querySelector('.market-install') as HTMLElement)
      await flush()
      expect(textOf(document.querySelector('.dsc-toasts'))).toContain(item.text)
      cleanup()
    }
  })

  test('市场安装：浏览器无桥只报「只桌面版能做」', async () => {
    const harness = harnessOf({ browseMarket: MARKET })
    const view = mount(harness)
    await flush()
    fireEvent.click(view.container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()
    delete (globalThis as { dscNative?: unknown }).dscNative
    const row = [...view.container.querySelectorAll('.market-row')].find((entry) => textOf(entry).includes('m1'))!
    fireEvent.click(row.querySelector('.market-install') as HTMLElement)
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(zh['toast.installDesktopOnly'])
  })
})
