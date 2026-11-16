/**
 * 技能页（`ui-skills/ui/ui.tsx`）的交互段（ui 层，真渲染）。
 *
 * 页条目经 `shell.page` 槽报名；这里照生产壳那条路把组件收下，放进 RuntimeProvider
 * 与假宿主通道里跑：列表分组/折叠、作用域与搜索筛选、启停、正文展开、市场浏览/安装、
 * 市场源编辑、读失败的常驻提示。真扫盘与真下载归宿主，这里钉界面自己的账。
 *
 * @module dsc-ui-skills/ui/ui.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setShellPage, type HostChannel } from '@dsc/ui-runtime'
import type { UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** SkillsPage 不直接导出：照壳装载插件那条路，收下 `shell.page` 的登记。 */
function skillsPage(): ComponentType {
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
  return found.component as ComponentType
}

const SkillsPage = skillsPage()

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
    whenToUse: '需要导出时',
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
    name: 'deploy',
    description: '部署流程',
    source: 'user-dsc',
    enabled: false,
    modelInvocable: false,
    userInvocable: true,
    toggleable: true,
    scope: 'global',
    root: 'C:/home/.dsc/skills',
  },
  {
    name: 'proj-skill',
    description: '项目内技能',
    source: 'project-dsc',
    enabled: true,
    modelInvocable: true,
    userInvocable: true,
    toggleable: false,
    scope: 'project',
    root: 'C:/repo/.dsc/skills',
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

/** 假宿主：listSkills/readSkill/setSkillEnabled/browseMarket 全记账。 */
function harnessOf(overrides: Record<string, unknown> = {}): Harness {
  const calls: Invoke[] = []
  const nativeCalls: Array<{ op: string; args: unknown[] }> = []
  const replies: Record<string, unknown> = {
    listSkills: ROWS,
    readSkill: { ok: true, skill: { name: 'pdf-tools', content: '# PDF 正文' } },
    setSkillEnabled: { ok: true, notice: '已启用' },
    setMarketSources: { ok: true },
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
      const reply = replies[method]
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
      if (op === 'installMarketSkill') return Promise.resolve({ ok: true, notice: '装好了' })
      if (op === 'setMarketSources') return Promise.resolve({ ok: true })
      if (op === 'installSkill') return Promise.resolve(['picked'])
      return Promise.resolve({ ok: true })
    },
    on: () => () => undefined,
  }
  return { channel, calls, nativeCalls, replies }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <SkillsPage />
    </RuntimeProvider>,
  )

/** 让挂载期的一串 promise 落地。 */
const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeEach(() => {
  setShellPage('skills')
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  delete (globalThis as { dscNative?: unknown }).dscNative
  vi.useRealTimers()
})

describe('列表、分组与筛选', () => {
  test('按发现根分组；禁用的行带 off、手动技能带标签；折叠组头收起该组', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    const groups = [...container.querySelectorAll('.skills-group')]
    expect(groups).toHaveLength(2)
    // 项目组排最前（项目技能压过全局同名技能）；组头写着发现根。
    expect(textOf(groups[0])).toContain('C:/repo/.dsc/skills')
    const homeGroup = groups.find((group) => textOf(group).includes('C:/home/.dsc/skills'))!
    expect(homeGroup).toBeDefined()
    const rows = [...container.querySelectorAll('.skill-row')]
    expect(rows).toHaveLength(3)
    const deploy = rows.find((row) => textOf(row).includes('deploy'))!
    expect(deploy.className).toContain('off')

    // 折叠全局组：它那两条消失，项目组那条还在。
    fireEvent.click(homeGroup.querySelector('.skills-group-head') as HTMLElement)
    expect(container.querySelectorAll('.skill-row')).toHaveLength(1)
    fireEvent.keyDown(homeGroup.querySelector('.skills-group-head') as HTMLElement, { key: 'Enter' })
    expect(container.querySelectorAll('.skill-row')).toHaveLength(3)
  })

  test('作用域页签与搜索：计数从宿主行算，筛不到给人话', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    const chips = [...container.querySelectorAll('.skills-scope button')] as HTMLElement[]
    expect(chips).toHaveLength(3)
    expect(textOf(chips[0])).toContain('3')
    expect(textOf(chips[1])).toContain('2')
    expect(textOf(chips[2])).toContain('1')

    fireEvent.click(chips[2]!)
    expect(container.querySelectorAll('.skill-row')).toHaveLength(1)
    expect(textOf(container.querySelector('.skill-row'))).toContain('proj-skill')
    fireEvent.click(chips[0]!)

    const input = container.querySelector('.skills-search input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'pdf' } })
    expect(container.querySelectorAll('.skill-row')).toHaveLength(1)
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(container.querySelectorAll('.skill-row')).toHaveLength(0)
    expect(container.querySelector('.plugins-empty')).not.toBeNull()
  })

  test('读技能失败：常驻错误条说清原因，不是一片空白', async () => {
    const harness = harnessOf({ listSkills: new Error('ECONNREFUSED host') })
    const { container } = mount(harness)
    await flush()
    const note = container.querySelector('.settings-note.error')
    expect(note).not.toBeNull()
    // 原文是 ECONNREFUSED，界面翻成人话 + 下一步。
    expect(textOf(note)).toContain('扫描失败')
  })
})

describe('启停与正文', () => {
  test('点开关先改本地、再叫宿主，成功后重读清单', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    const row = [...container.querySelectorAll('.skill-row')].find((item) => textOf(item).includes('pdf-tools'))!
    fireEvent.click(row.querySelector('.switch') as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setSkillEnabled', args: ['pdf-tools', false] })
    expect(harness.calls.filter((call) => call.method === 'listSkills')).toHaveLength(2)
  })

  test('锁定行点开关不发请求；展开正文按名字读一次、再点收起', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    const locked = [...container.querySelectorAll('.skill-row')].find((item) => textOf(item).includes('proj-skill'))!
    expect((locked.querySelector('.switch') as HTMLElement).className).toContain('locked')
    fireEvent.click(locked.querySelector('.switch') as HTMLElement)
    await flush()
    expect(harness.calls.some((call) => call.method === 'setSkillEnabled')).toBe(false)

    const row = [...container.querySelectorAll('.skill-row')].find((item) => textOf(item).includes('pdf-tools'))!
    fireEvent.click(row.querySelector('.text-btn') as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'readSkill', args: ['pdf-tools'] })
    expect(textOf(container.querySelector('.skill-body'))).toContain('# PDF 正文')

    fireEvent.click(row.querySelector('.text-btn') as HTMLElement)
    expect(container.querySelector('.skill-body')).toBeNull()
  })
})

describe('市场页', () => {
  const MARKET = {
    sources: [
      { name: 'ClawHub', url: 'https://clawhub.ai', ok: true },
      { name: 'skills.sh', url: 'https://skills.sh', ok: false, error: '超时' },
    ],
    source: 'ClawHub',
    items: [
      { name: 'm1', description: '技能一', source: 'ClawHub', installed: false },
      { name: 'm2', description: '技能二', source: 'ClawHub', installed: true },
    ],
  }

  test('切到市场拉一次；源芯片、条目、统计；已装的按钮禁用', async () => {
    const harness = harnessOf({
      browseMarket: {
        ...MARKET,
        items: [
          { ...MARKET.items[0], stats: { downloads: 1200, installs: 3, stars: 7 } },
          MARKET.items[1],
        ],
      },
    })
    const { container } = mount(harness)
    await flush()
    const tabs = container.querySelectorAll('.skills-tabs button')
    fireEvent.click(tabs[1] as HTMLElement)
    await flush()

    expect(harness.calls).toContainEqual({ method: 'browseMarket', args: ['', undefined] })
    expect(container.querySelectorAll('.source-chip')).toHaveLength(2)
    expect(container.querySelectorAll('.market-row')).toHaveLength(2)
    expect(textOf(container.querySelector('.skill-stats'))).toContain('1,200')

    const installed = [...container.querySelectorAll('.market-row')].find((row) => textOf(row).includes('m2'))!
    // 已装条目按钮不置灰，但样式是 done、点了也不发安装请求。
    expect((installed.querySelector('.market-install') as HTMLElement).className).toContain('done')
    const before = harness.nativeCalls.length
    fireEvent.click(installed.querySelector('.market-install') as HTMLElement)
    await flush()
    expect(harness.nativeCalls).toHaveLength(before)
  })

  test('安装走原生桥；成功后该行变已装并重读清单', async () => {
    const harness = harnessOf({ browseMarket: MARKET })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()

    const row = [...container.querySelectorAll('.market-row')].find((item) => textOf(item).includes('m1'))!
    fireEvent.click(row.querySelector('.market-install') as HTMLElement)
    await flush()
    expect(harness.nativeCalls).toContainEqual({ op: 'installMarketSkill', args: ['ClawHub', 'm1'] })
    expect(harness.calls.filter((call) => call.method === 'listSkills')).toHaveLength(2)
  })

  test('编辑市场源：草稿按「名字, 地址」填出，保存交给原生桥并重新拉第一个源', async () => {
    const harness = harnessOf({ browseMarket: MARKET })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.skills-tabs button')[1] as HTMLElement)
    await flush()

    const editButton = [...container.querySelectorAll('.market-sources .text-btn')][0] as HTMLElement
    fireEvent.click(editButton)
    const textarea = container.querySelector('.market-edit textarea') as HTMLTextAreaElement
    expect(textarea.value).toContain('ClawHub, https://clawhub.ai')
    expect(textarea.value).toContain('skills.sh, https://skills.sh')

    fireEvent.change(textarea, { target: { value: 'X, https://x.example\n坏行' } })
    fireEvent.click(container.querySelector('.market-edit .btn-primary') as HTMLElement)
    await flush()
    expect(harness.nativeCalls).toContainEqual({
      op: 'setMarketSources',
      args: [[{ name: 'X', url: 'https://x.example' }]],
    })
    expect(harness.calls.filter((call) => call.method === 'browseMarket').length).toBeGreaterThanOrEqual(2)
  })
})
