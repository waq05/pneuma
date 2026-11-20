/**
 * `ui-team` 的补盲：队友运行记录简版视图（`PeekView`）的行种类。
 *
 * 缺口是 350-372：运行记录里 `tool` / `thinking` / `system` 与「不认识的 kind」四条分支。
 * 既有 `team-extra.spec.tsx` 只喂过 `text` 一种条目，其余四支没人走到。
 *
 * 这里沿用它的装载方式：照壳装载插件那条路登记（真注册表 + 席位），再挂 `subagent`
 * 页签本体；`peekTranscript` 由假通道逐条喂。
 *
 * @module dsc-ui-team/ui/w14-team
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { SlotRegistry, type HostSnapshot, type SlotEntry, type TeammateView, type TranscriptEntry } from '@dsc/ui-core'
import type { UiPluginApi } from '@dsc/ui'
import { dockTabMeta } from '@dsc/ui-dockkit'
import teamPlugin from './ui.js'

interface Loaded {
  registry: SlotRegistry
  entry: SlotEntry<unknown>
}

/** 照壳装载插件那条路走：先声明槽位，再把 `ui.slots` 代理到真注册表。 */
function loadTeam(): Loaded {
  const registry = new SlotRegistry()
  registry.declare('shell.header.lead', 'list')
  const registerErased = registry.register.bind(registry) as (
    slot: string,
    options: Record<string, unknown>,
    component: unknown,
  ) => () => void
  const slots = {
    get slots(): string[] {
      return registry.slots
    },
    spec: (slot: string): string | undefined => registry.spec(slot),
    declare: (slot: string, kind: 'single' | 'list' | 'keyed' | 'chain'): (() => void) => registry.declare(slot, kind),
    register: registerErased,
    registerFactory: (() => () => undefined) as unknown as UiPluginApi['slots']['registerFactory'],
    seat: registry.seat.bind(registry) as unknown as UiPluginApi['slots']['seat'],
    injectSlot: (slot: string, contribute: () => void | (() => void)): (() => void) => registry.injectSlot(slot, contribute),
    entriesOf: (slot: string): readonly SlotEntry<unknown>[] => registry.entriesOf(slot),
    winners: (slot: string): readonly SlotEntry<unknown>[] => registry.winners(slot),
  }
  const ui = {
    slots,
    provide: (): void => undefined,
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  teamPlugin.apply(ui)
  const entry = registry.winners('shell.header.lead').find((row) => row.id === 'team.entry')
  if (entry === undefined) throw new Error('team 插件没有登记 team.entry')
  return { registry, entry }
}

const loaded = loadTeam()

/** 假宿主：`peekTranscript` 按用例给的条目回。 */
function makeChannel(peek: () => Promise<TranscriptEntry[]>): HostChannel {
  const snapshot = {
    sessions: [],
    status: { cwd: 'C:/repo', sessionPath: 'C:/sessions/current.jsonl', turnState: 'idle' },
    surfaces: {},
  } as unknown as HostSnapshot
  return {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string): Promise<T> => {
      if (method === 'peekTranscript') return peek() as Promise<T>
      return Promise.resolve(undefined as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

/** 页签本体（插件通过 registerDockTab 报名的那个组件）。 */
function mountTab(channel: HostChannel): ReturnType<typeof render> {
  const meta = dockTabMeta('subagent')
  if (meta === undefined) throw new Error('team 插件没有报名 subagent 页签')
  const Body = meta.component as unknown as ComponentType<Record<string, unknown>>
  return render(
    <RuntimeProvider channel={channel}>
      <Body tab={{ id: 'tab-1', kind: 'subagent', path: 'C:/sessions/mate.jsonl' }} active expanded />
    </RuntimeProvider>,
  )
}

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  document.body.innerHTML = ''
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('PeekView 的行种类', () => {
  test('tool / thinking / system 三种条目各有自己的行；不认识的 kind 不出行', async () => {
    const entries: TranscriptEntry[] = [
      { kind: 'text', id: 1, text: '正文一句' } as TranscriptEntry,
      {
        kind: 'tool',
        id: 2,
        call: { callId: 'c1', name: 'bash', argsText: 'pnpm build', status: 'failed' },
      } as unknown as TranscriptEntry,
      { kind: 'thinking', id: 3, text: '第一行思考\n第二行不该露' } as TranscriptEntry,
      { kind: 'system', id: 4, text: '系统提示一句' } as TranscriptEntry,
      // 简版视图只认上面四种：用户气泡 / 子代理卡这类条目直接跳过，不画空行。
      { kind: 'user', id: 5, text: '这条不该出现' } as TranscriptEntry,
    ]
    const { container } = mountTab(makeChannel(() => Promise.resolve(entries)))
    await flush()

    expect(textOf(container.querySelector('.peek-text'))).toBe('正文一句')

    const tool = container.querySelector('.peek-tool') as HTMLElement
    expect(textOf(tool.querySelector('code'))).toBe('bash')
    expect(textOf(tool)).toContain('pnpm build')
    expect(textOf(tool)).toContain('失败')

    const think = textOf(container.querySelector('.peek-think'))
    expect(think).toContain('第一行思考')
    expect(think).not.toContain('第二行不该露')

    expect(textOf(container.querySelector('.peek-system'))).toBe('系统提示一句')
    expect(container.querySelectorAll('.peek-flow > *')).toHaveLength(4)
    expect(container.textContent).not.toContain('这条不该出现')
  })

  test('工具成功时不写「失败」', async () => {
    const entries: TranscriptEntry[] = [
      {
        kind: 'tool',
        id: 1,
        call: { callId: 'c1', name: 'read', argsText: 'a.ts', status: 'done' },
      } as unknown as TranscriptEntry,
    ]
    const { container } = mountTab(makeChannel(() => Promise.resolve(entries)))
    await flush()
    const tool = textOf(container.querySelector('.peek-tool'))
    expect(tool).toContain('read')
    expect(tool).toContain('a.ts')
    expect(tool).not.toContain('失败')
  })
})

describe('名册席位与页签', () => {
  test('名册空也不挡：标题回落文件名，运行记录照画', async () => {
    const channel = makeChannel(() => Promise.resolve([{ kind: 'text', id: 1, text: '照画' } as TranscriptEntry]))
    const view = mountTab(channel)
    await flush()
    expect(textOf(view.container.querySelector('.sub-tab-name'))).toBe('mate')
    expect(view.container.textContent).toContain('照画')
    const roster: TeammateView[] = []
    expect(roster).toEqual([])
  })
})
