/**
 * 会话流里「分叉这一轮」的补测（`ui-transcript/ui/ui.tsx` 的 forkRound）。
 *
 * 已有的 `foot.spec` 只钉住轮尾那颗按钮的显隐（`RoundFoot` 单测），`edit-resend.spec`
 * 钉住编辑重发链路并明确断言「不发 forkSession」。整条分叉链路（点下去 → 调宿主 →
 * 开新会话 → 重扫侧栏 → 三种回执）在流组件上一直是空的，这一份补上：
 *
 * - 成功且宿主给了路径：`openSession` 带新路径、随后 `refreshSessions`、Toast 说分叉成功；
 * - 成功但没给路径：`openSession` 不带参数（回落到新会话）；
 * - 宿主回 `ok:false`：Toast 写原因，不开新会话；
 * - 通道抛错：Toast 写「分叉失败：<原因>」。
 *
 * @module dsc-ui-transcript/ui/w13-fork.spec
 */
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, SlotRenderApi, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import { type TranscriptChildSlot } from './shared.js'
import plugin from './ui.js'
import zh from '../locale/ui.zh.json'

/** TranscriptFlow 不直接导出：经 apply 把注册动作在测试替身上重放一遍收下组件。 */
function flowComponent(): (props: { renderSlot: SlotRenderApi<TranscriptChildSlot>['renderSlot'] }) => ReactNode {
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
  const found = registered.find((item) => item.slot === 'shell.main')
  if (found === undefined) throw new Error('transcript 插件没有把流组件注册进 shell.main')
  return found.component as (props: { renderSlot: SlotRenderApi<TranscriptChildSlot>['renderSlot'] }) => ReactNode
}

const TranscriptFlow = flowComponent()

/** 全体弃权的槽渲染：chain 槽没人认领时兜底画出内置行体。 */
const renderSlot = ((slot: TranscriptChildSlot, owner: unknown, fallback?: ReactNode): ReactNode =>
  fallback ?? null) as unknown as SlotRenderApi<TranscriptChildSlot>['renderSlot']

interface Call {
  method: string
  args: readonly unknown[]
}

/** 假宿主通道：分叉的回执在测试里换（成功带/不带路径、失败、抛错四条路）。 */
function makeChannel(): HostChannel & {
  calls: Call[]
  forkAnswer(value: unknown): void
} {
  const calls: Call[] = []
  let forkAnswer: unknown = { ok: true, path: 'D:/demo/forked.jsonl' }
  const listeners = new Set<() => void>()
  const snapshot: HostSnapshot = {
    entries: entriesOf(),
    liveEntries: [],
    status: { cwd: 'D:/demo', sessionPath: 'D:/demo/demo-session.jsonl', sessionId: 'uuid-1', turnState: 'idle' },
  } as unknown as HostSnapshot
  const invoke = ((method: string, args: readonly unknown[] = []): Promise<unknown> => {
    calls.push({ method, args })
    if (method === 'getUiPrefs') return Promise.resolve({})
    if (method === 'forkSession') {
      return forkAnswer instanceof Error ? Promise.reject(forkAnswer) : Promise.resolve(forkAnswer)
    }
    if (method === 'openSession' || method === 'refreshSessions') return Promise.resolve(null)
    return Promise.reject(new Error(`测试不触发 ${method}`))
  }) as unknown as HostChannel['invoke']
  return {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    invoke,
    reconnect: () => undefined,
    close: () => undefined,
    calls,
    forkAnswer(value: unknown) {
      forkAnswer = value
    },
  }
}

let seq = 0
const userOf = (text: string, internal = false): TranscriptEntry =>
  ({ kind: 'user', id: (seq += 1), text, ts: seq, ...(internal ? { internal: true } : {}) }) as TranscriptEntry

/** 两条人打的用户消息 = 两轮；第 2 轮的轮尾才有「分叉这一轮」。 */
const entriesOf = (): TranscriptEntry[] => [userOf('第一问'), userOf('<teammate-report finished />', true), userOf('第二问')]

/** 渲染整棵流并点第 2 轮轮尾的分叉钮。 */
async function clickFork(channel: ReturnType<typeof makeChannel>): Promise<ReturnType<typeof render>> {
  const rendered = render(
    <RuntimeProvider channel={channel}>
      <TranscriptFlow renderSlot={renderSlot} />
    </RuntimeProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  const fork = rendered.container.querySelector(
    `button[aria-label="${zh['transcript.foot.fork']}"]`,
  ) as HTMLButtonElement | null
  if (fork === null) throw new Error('第 2 轮轮尾没有分叉钮')
  await act(async () => {
    fireEvent.click(fork)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  return rendered
}

const toastText = (): string => document.querySelector('.dsc-toasts')?.textContent ?? ''

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('分叉这一轮', () => {
  test('成功且宿主给了路径：开新会话带路径、重扫侧栏，Toast 说分叉成功', async () => {
    const channel = makeChannel()
    await clickFork(channel)
    const methods = channel.calls.map((call) => call.method)
    const fork = channel.calls.find((call) => call.method === 'forkSession')
    // 第二个参数是「轮号 + 1」：界面上的第 2 轮（下标 1）→ 2
    expect(fork?.args).toEqual(['D:/demo/demo-session.jsonl', 2])
    expect(channel.calls).toContainEqual({ method: 'openSession', args: ['D:/demo/forked.jsonl'] })
    expect(methods.indexOf('openSession')).toBeLessThan(methods.indexOf('refreshSessions'))
    expect(toastText()).toContain(zh['transcript.fork.ok'])
  })

  test('成功但没给路径：openSession 不带参数（回落到新会话），仍然重扫侧栏', async () => {
    const channel = makeChannel()
    channel.forkAnswer({ ok: true })
    await clickFork(channel)
    expect(channel.calls).toContainEqual({ method: 'openSession', args: [] })
    expect(channel.calls.some((call) => call.method === 'refreshSessions')).toBe(true)
    expect(toastText()).toContain(zh['transcript.fork.ok'])
  })

  test('宿主回 ok:false：Toast 写原因，不开新会话、不重扫', async () => {
    const channel = makeChannel()
    channel.forkAnswer({ ok: false, error: '会话文件只读' })
    await clickFork(channel)
    expect(channel.calls.some((call) => call.method === 'openSession')).toBe(false)
    expect(channel.calls.some((call) => call.method === 'refreshSessions')).toBe(false)
    expect(toastText()).toContain('会话文件只读')
  })

  test('通道抛错：Toast 写「分叉失败：<原因>」', async () => {
    const channel = makeChannel()
    channel.forkAnswer(new Error('宿主断了'))
    await clickFork(channel)
    expect(toastText()).toContain(
      zh['transcript.fork.failedDetail'].replace('{message}', '宿主断了'),
    )
  })
})
