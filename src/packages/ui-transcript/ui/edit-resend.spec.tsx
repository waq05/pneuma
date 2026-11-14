/**
 * 「编辑并重发」的渲染段（`ui.tsx` 的 editAndResend，经整棵流真渲染触发）。
 *
 * 来源（缺口清单 B36）：
 * - `scripts/ui-edit-generation-test.mjs` 第 [1]–[4] 段的渲染半（清法纯逻辑半已迁
 *   `fold-clear.spec.ts`）：重答这一拍清掉这一轮的折叠存档——清在 rewindSession 之后、
 *   submit 之前（失败分支先 return，不动存档）；整轮用精确键不误伤 `turn:10`，
 *   行与阶段组按轮前缀扫。原探针钉的是函数体里「哪一句、在哪个位置、带什么键」的
 *   源码文本；这里把同一件事行为化：真点一次编辑并重发，看宿主通道收到了什么、
 *   存档里哪些键没了、哪些键还在。
 * - `scripts/ui-edit-in-place-test.mjs` 第 [3][5] 段：留在当前会话重发（走 rewindSession，
 *   不再 forkSession / openSession）；保留轮数按**人打的**用户消息数（internal 的
 *   队友汇报、后台通知不占刻度）；编辑提示说实话（不再写「分叉出新会话」）。
 *
 * 为什么这份能存在：TranscriptFlow 的宿主接缝全在 RuntimeProvider + 假 HostChannel
 * 后面（架子同 `flow.spec.tsx`）；折叠存档是 `fold-state.ts` 的模块级 Map，真键真读。
 *
 * @module dsc-ui-transcript/ui/edit-resend.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, SlotRenderApi, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import { type TranscriptChildSlot } from './shared.js'
import { clearFold, clearFoldPrefix, readFold, turnFoldKey, writeFold } from './fold-state.js'
import plugin from './ui.js'

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
const renderSlot = ((slot: TranscriptChildSlot, owner: unknown, fallback?: ReactNode): ReactNode => (fallback ?? null)) as unknown as SlotRenderApi<TranscriptChildSlot>['renderSlot']

interface Call {
  method: string
  args: readonly unknown[]
}

/** 假宿主通道：invoke 全记录；rewindSession 的回执在测试里换（成功 / 失败两条路）。 */
function makeChannel(entries: TranscriptEntry[]): HostChannel & { calls: Call[]; rewindOk(value: { ok: boolean; error?: string }): void } {
  const calls: Call[] = []
  let rewindAnswer: { ok: boolean; error?: string } = { ok: true }
  const listeners = new Set<() => void>()
  const snapshot: HostSnapshot = {
    entries,
    liveEntries: [],
    status: { cwd: 'D:/demo', sessionPath: 'D:/demo/demo-session.jsonl', sessionId: 'uuid-1', turnState: 'idle' },
  } as unknown as HostSnapshot
  const invoke = ((method: string, args: readonly unknown[] = []): Promise<unknown> => {
    calls.push({ method, args })
    if (method === 'getUiPrefs') return Promise.resolve({})
    if (method === 'rewindSession') return Promise.resolve(rewindAnswer)
    if (method === 'submit' || method === 'refreshSessions') return Promise.resolve(null)
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
    rewindOk(value: { ok: boolean; error?: string }) {
      rewindAnswer = value
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // 折叠存档是模块级状态：本文件用过的键统一抹掉。
  clearFoldPrefix(['uuid-1:turn:', 'uuid-1:r', 'uuid-1:step:'])
})

let seq = 0
/** 一条人打的用户消息 / 一条机器投递的通知。 */
const userOf = (text: string, internal = false): TranscriptEntry =>
  ({ kind: 'user', id: (seq += 1), text, ts: seq, ...(internal ? { internal: true } : {}) }) as TranscriptEntry

/** 造三条：人打的第 0 轮 → 机器投递的通知 → 人打的第 1 轮（编辑它）。 */
const entriesOf = (): TranscriptEntry[] => [
  userOf('第一问'),
  userOf('<teammate-report finished />', true),
  userOf('第二问，我要改这句话'),
]

/** 渲染整棵流并触发「编辑并重发」第三条（第二问）。 */
async function editSecondTurn(channel: ReturnType<typeof makeChannel>): Promise<ReturnType<typeof render>> {
  const rendered = render(
    <RuntimeProvider channel={channel}>
      <TranscriptFlow renderSlot={renderSlot} />
    </RuntimeProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  // 每条人打的用户行都有 hover 浮出的编辑钮（internal 那条画成唤醒卡，没有编辑钮）。
  const turns = rendered.container.querySelectorAll('.user-turn')
  expect(turns.length).toBe(2)
  const editButton = (turns[1] as HTMLElement).querySelector('.user-act') as HTMLElement
  fireEvent.click(editButton)
  const box = rendered.container.querySelector('.user-edit-box') as HTMLTextAreaElement
  if (box === null) throw new Error('编辑框没有出现')
  fireEvent.change(box, { target: { value: '改过的话' } })
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' })
    await Promise.resolve()
  })
  // 等异步链（rewindSession → 清存档 → submit → refreshSessions）落地。
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  return rendered
}

describe('编辑重发留在当前会话（ui-edit-in-place [3]）', () => {
  test('通道收到 rewindSession（带着改过的正文），没有 forkSession / openSession', async () => {
    const channel = makeChannel(entriesOf())
    await editSecondTurn(channel)
    const methods = channel.calls.map((call) => call.method)
    const rewind = channel.calls.find((call) => call.method === 'rewindSession')
    expect(rewind).toBeDefined()
    // 第二个参数 = 这条之前**人打的**用户消息数：第一问占 1，队友汇报不算。
    expect(rewind?.args[0]).toBe('D:/demo/demo-session.jsonl')
    expect(rewind?.args[1]).toBe(1)
    expect(rewind?.args[2]).toBe('改过的话')
    expect(methods).toContain('submit')
    expect(methods).not.toContain('forkSession')
    expect(methods).not.toContain('openSession')
  })

  test('保留轮数按人打的用户消息数（internal 条目不占刻度）', async () => {
    // 没有通知条目时，第二问前面是 1 条人打的；有通知条目时仍是 1——internal 不算。
    const withNotice = makeChannel(entriesOf())
    await editSecondTurn(withNotice)
    const withoutNotice = makeChannel([userOf('第一问'), userOf('第二问，我要改这句话')])
    await editSecondTurn(withoutNotice)
    const keep = (channel: ReturnType<typeof makeChannel>): unknown =>
      channel.calls.find((call) => call.method === 'rewindSession')?.args[1]
    expect(keep(withNotice)).toBe(keep(withoutNotice))
    expect(keep(withoutNotice)).toBe(1)
  })

  test('rewindSession 在 submit 之前：作废历史与重发是有先后的两步', async () => {
    const channel = makeChannel(entriesOf())
    await editSecondTurn(channel)
    const methods = channel.calls.map((call) => call.method)
    expect(methods.indexOf('rewindSession')).toBeGreaterThanOrEqual(0)
    expect(methods.indexOf('rewindSession')).toBeLessThan(methods.indexOf('submit'))
    // 重发完了顺手刷新侧栏（标题、排序跟最后一条消息走）。
    expect(methods.indexOf('submit')).toBeLessThan(methods.indexOf('refreshSessions'))
  })
})

describe('重答这一拍清掉这一轮的折叠存档（ui-edit-generation [1][2]）', () => {
  test('精确键清整轮（turn:1 不误伤 turn:10）、两条前缀只扫本轮（r1: 不碰 r10:）', async () => {
    const keys = [
      'uuid-1:turn:1', 'uuid-1:turn:10',
      'uuid-1:r1:think:0', 'uuid-1:r10:think:0',
      'uuid-1:step:r1:think:0', 'uuid-1:step:r10:think:0',
    ]
    for (const key of keys) writeFold(key, true)
    const channel = makeChannel(entriesOf())
    await editSecondTurn(channel)
    // keep=1：整轮格与第 1 轮的行/组存档全清。
    expect(readFold('uuid-1:turn:1', false)).toBe(false)
    expect(readFold('uuid-1:r1:think:0', false)).toBe(false)
    expect(readFold('uuid-1:step:r1:think:0', false)).toBe(false)
    // 第 10 轮的三个键一条不少（前缀的冒号挡住位数、整轮用的是精确键）。
    expect(readFold('uuid-1:turn:10', false)).toBe(true)
    expect(readFold('uuid-1:r10:think:0', false)).toBe(true)
    expect(readFold('uuid-1:step:r10:think:0', false)).toBe(true)
    // 清的是重答那一轮的键：turnFoldKey(sid, keep) 的形状（键与 fold-state 同源）。
    expect(turnFoldKey('uuid-1', 1)).toBe('uuid-1:turn:1')
  })
})

describe('失败不动存档（ui-edit-generation [4]）', () => {
  test('rewindSession 回 ok:false：当场收手，submit 不发、存档原封不动', async () => {
    const keys = ['uuid-1:turn:1', 'uuid-1:r1:think:0', 'uuid-1:step:r1:think:0']
    for (const key of keys) writeFold(key, true)
    const channel = makeChannel(entriesOf())
    channel.rewindOk({ ok: false, error: '截断失败' })
    await editSecondTurn(channel)
    const methods = channel.calls.map((call) => call.method)
    expect(methods).toContain('rewindSession')
    expect(methods).not.toContain('submit')
    for (const key of keys) {
      expect(readFold(key, false)).toBe(true)
    }
  })
})

describe('编辑提示说实话（ui-edit-in-place [5]）', () => {
  test('编辑钮的悬浮提示不再说「分叉」，说的是这条之后的回答会作废', async () => {
    const rendered = render(
      <RuntimeProvider channel={makeChannel(entriesOf())}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    const tip = (rendered.container.querySelectorAll('.user-turn')[1] as HTMLElement)
      .querySelector('.user-act')
      ?.getAttribute('title')
    expect(tip).toContain('作废')
    expect(tip).not.toContain('分叉出新会话')
    expect(tip).toContain('当前会话')
  })
})
