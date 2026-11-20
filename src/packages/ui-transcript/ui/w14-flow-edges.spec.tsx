/**
 * 会话流主组件（`ui.tsx` 的 TranscriptFlow）第四批补测：W14 剩余的分支出口。
 *
 * 已有三份 spec 各管一段：`flow.spec` 钉分页与设置下发链、`edit-resend.spec` 钉编辑重发的
 * 成功链、`w11-branches.spec` 钉回合通知与等人卡的正常路径、`w13-fork.spec` 钉分叉。
 * 这一份只补它们没走到的那几处：
 *
 * - 工具卡槽的判据（`apply` 里 `select` 的 matchTool 调用）；
 * - `getUiPrefs` 拒绝（老宿主没实现这个方法）与三个通知出口的 `.catch`；
 * - 「加载更早」真放页时的锚点记录与补偿（视口挂在真 `.chat` 上才走得到）；
 * - next-input 档：新一轮进来时抹掉上一轮的整轮折叠存档；
 * - 编辑重发的三条失败出口（条目已经不在、会话没落盘、宿主抛错）；
 * - 动作表服务在的时候：首屏卡片改读动作表、登记的动作 run 往输入框写字；动作表空时回落
 *   内置清单；开场 error 条目弹一次 Toast；「接着上次」的过滤与点击；
 * - 等人的卡表是空对象时选择器收手。
 *
 * 渲染口径同 `w11-branches.spec`：经插件 `apply` 收组件、假 HostChannel 喂快照、
 * `renderSlot` 里挂一枚探针读 `FlowActionsContext`（编辑重发的失败出口不经过 UI 也能触发）。
 *
 * @module dsc-ui-transcript/ui/w14-flow-edges.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useContext, type ComponentType, type ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { ServiceRegistry, ServicesProvider } from '@dsc/ui-core'
import {
  ACTIONS_SERVICE,
  type ActionsHandle,
  type HostSnapshot,
  type SlotRenderApi,
  type TranscriptEntry,
  type UiAction,
  type UiPluginApi,
} from '@dsc/ui'
import { FlowActionsContext, TRANSCRIPT_NODE_SLOT, TOOLVIEW_SLOT, type FlowActions, type TranscriptChildSlot } from './shared.js'
import { clearFoldPrefix, readFold, writeFold } from './fold-state.js'
import plugin from './ui.js'
import zh from '../locale/ui.zh.json'

// ── 插件装载：收下 shell.main 的流组件与 toolview 的判据 ───────────────────────

interface FlowProps {
  renderSlot: SlotRenderApi<TranscriptChildSlot>['renderSlot']
}

interface Registered {
  slot: string
  options: { select?: (owner: unknown) => unknown } | undefined
  component: unknown
}

/** 照生产壳装载插件那条路重放 `apply`，收下登记过的槽与组件。 */
function applyPlugin(): Registered[] {
  const registered: Registered[] = []
  const fakeUi = {
    slots: {
      register: (slot: string, options: unknown, component: unknown): void => {
        registered.push({
          slot,
          options: options as Registered['options'],
          component,
        })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  return registered
}

const REGISTERED = applyPlugin()
const TranscriptFlow = (() => {
  const found = REGISTERED.find((item) => item.slot === 'shell.main')
  if (found === undefined) throw new Error('transcript 插件没有把流组件注册进 shell.main')
  return found.component as ComponentType<FlowProps>
})()

const toolViewSelect = REGISTERED.find((item) => item.slot === TOOLVIEW_SLOT)?.options?.select

// ── 渲染替身 ─────────────────────────────────────────────────────────────────

/** 探针：读 `FlowActionsContext` 现拿一份动作表（编辑重发的失败出口必须从上下文拿）。 */
let flowActions: FlowActions | null = null

function ActionsProbe(): null {
  flowActions = useContext(FlowActionsContext)
  return null
}

/** 全体弃权 + 在节点槽里挂探针：chain 槽没人认领时兜底画内置行体。 */
const renderSlot = ((slot: TranscriptChildSlot, _owner: unknown, fallback?: ReactNode): ReactNode => (
  <>
    {fallback}
    {slot === TRANSCRIPT_NODE_SLOT ? <ActionsProbe /> : null}
  </>
)) as unknown as SlotRenderApi<TranscriptChildSlot>['renderSlot']

interface Call {
  method: string
  args: readonly unknown[]
}

interface ChannelOptions {
  /** getUiPrefs 的回执；不给就答空对象。 */
  prefs?: () => Promise<unknown>
  /** rewindSession 的回执；不给就当成功。 */
  rewind?: () => Promise<unknown>
}

interface ChannelHarness extends HostChannel {
  calls: Call[]
  set(next: HostSnapshot): void
}

/** 假宿主通道：快照可替换、invoke 按方法名换回答，其余方法名落空。 */
function makeChannel(initial: HostSnapshot, options: ChannelOptions = {}): ChannelHarness {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const calls: Call[] = []
  const invoke = ((method: string, args: readonly unknown[] = []): Promise<unknown> => {
    calls.push({ method, args })
    if (method === 'getUiPrefs') return options.prefs === undefined ? Promise.resolve({}) : options.prefs()
    if (method === 'rewindSession') return options.rewind === undefined ? Promise.resolve({ ok: true }) : options.rewind()
    if (method === 'submit' || method === 'refreshSessions' || method === 'openSession') return Promise.resolve(null)
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
    set(next: HostSnapshot) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

let seq = 0
const userOf = (text: string, internal = false): TranscriptEntry =>
  ({
    kind: 'user',
    id: (seq += 1),
    text,
    ts: seq,
    ...(internal ? { internal: true } : {}),
  }) as TranscriptEntry
const textOf = (text: string): TranscriptEntry => ({ kind: 'text', id: (seq += 1), text, ts: seq }) as TranscriptEntry

/** 一轮问答（题面 + 一句正文）。 */
const roundOf = (question: string, answer: string): TranscriptEntry[] => [userOf(question), textOf(answer)]

interface SnapshotOver {
  turnState?: string
  /** 传 null = 会话还没落盘（status 里没有 sessionPath）。 */
  sessionPath?: string | null
  surfaces?: unknown
  sessions?: unknown
}

function snapshotOf(entries: TranscriptEntry[], over: SnapshotOver = {}): HostSnapshot {
  const sessionPath = over.sessionPath === null ? undefined : (over.sessionPath ?? 'D:/demo/demo-session.jsonl')
  return {
    entries,
    liveEntries: [],
    status: {
      cwd: 'D:/demo',
      ...(sessionPath === undefined ? {} : { sessionPath }),
      sessionId: 'uuid-1',
      turnState: over.turnState ?? 'idle',
    },
    ...(over.surfaces === undefined ? {} : { surfaces: over.surfaces }),
    ...(over.sessions === undefined ? {} : { sessions: over.sessions }),
  } as unknown as HostSnapshot
}

/** 把窗口放到后台并装一个可用的原生桥：通知路径才会走到 `invoke('notify')`。 */
function backgroundWithNative(invoke: () => Promise<unknown>): ReturnType<typeof vi.fn> {
  const call = vi.fn(invoke)
  vi.stubGlobal('dscNative', { version: 1, call, on: () => () => undefined })
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  return call
}

const toastText = (): string => document.querySelector('.dsc-toasts')?.textContent ?? ''

/** 推进微任务：等挂载期的 getUiPrefs / 异步链落地。 */
async function flush(times = 3): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  flowActions = null
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  clearFoldPrefix(['uuid-1:turn:'])
})

// ── apply：工具卡槽的判据 ────────────────────────────────────────────────────

describe('工具卡槽的判据', () => {
  test('名字经 matchTool 归一：认识的工具带 known，前缀族与未知工具各有兜底', () => {
    if (toolViewSelect === undefined) throw new Error('toolview 槽没有登记 select 判据')
    const known = toolViewSelect({
      entry: {
        kind: 'tool',
        id: 1,
        call: { callId: 'c1', name: 'bash', argsText: '{}' },
      },
    })
    expect((known as { known?: boolean }).known).toBe(true)
    const prefixed = toolViewSelect({
      entry: {
        kind: 'tool',
        id: 2,
        call: { callId: 'c2', name: 'mcp__server__tool', argsText: '{}' },
      },
    })
    expect((prefixed as { known?: boolean }).known).toBe(false)
    const unknown = toolViewSelect({
      entry: {
        kind: 'tool',
        id: 3,
        call: { callId: 'c3', name: 'no-such-tool', argsText: '{}' },
      },
    })
    expect((unknown as { base?: string }).base).toBeTypeOf('string')
  })
})

// ── 设置读取失败 / 两个通知出口的 catch ──────────────────────────────────────

describe('设置读取失败与通知出口', () => {
  test('getUiPrefs 拒绝（老宿主没有这个方法）：壳照画，不抛', async () => {
    const channel = makeChannel(snapshotOf([], {}), {
      prefs: () => Promise.reject(new Error('老宿主没有偏好')),
    })
    const { container } = render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    await flush()
    expect(container.querySelector('.welcome')).not.toBeNull()
  })

  test('回合收尾通知发不出去（原生桥拒绝）：异常被咽掉，不影响后续渲染', async () => {
    const call = backgroundWithNative(() => Promise.reject(new Error('通知被系统拒绝')))
    const channel = makeChannel(
      snapshotOf(roundOf('问题', '这是最后一句回答。'), {
        turnState: 'running',
      }),
    )
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    await flush()
    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '这是最后一句回答。'), {
          turnState: 'idle',
        }),
      ),
    )
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[0]).toBe('notify')
  })

  test('等人卡通知发不出去：同样咽掉，界面继续可用', async () => {
    const call = backgroundWithNative(() => Promise.reject(new Error('通知被系统拒绝')))
    const channel = makeChannel(snapshotOf(roundOf('问题', '回答')))
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    await flush()
    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '回答'), {
          surfaces: {
            pendingApproval: {
              id: 'a1',
              toolName: 'bash',
              argsSummary: 'rm -rf build',
            },
          },
        }),
      ),
    )
    await flush()
    expect(call.mock.calls.some((entry) => entry[0] === 'notify')).toBe(true)
  })

  test('等人的卡表是空对象：三类卡都没有，选择器收手、不弹通知', async () => {
    const call = backgroundWithNative(() => Promise.resolve(undefined))
    const channel = makeChannel(snapshotOf(roundOf('问题', '回答'), { surfaces: {} }))
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    await flush()
    expect(call).not.toHaveBeenCalled()
  })
})

// ── 加载更早：真挂在 .chat 上才走得到的锚点分支 ──────────────────────────────

describe('加载更早的锚点记录与补偿', () => {
  test('点一下放页：记锚点、窗口往前扩、按锚点回补位置（降级计数不涨）', async () => {
    // 视口的容器由 `endRef.closest('.chat')` 找到：必须把整棵树渲进一个真 `.chat` 里。
    const chat = document.createElement('div')
    chat.className = 'chat'
    document.body.appendChild(chat)
    const entries = Array.from({ length: 60 }, (_, round) => roundOf(`第 ${String(round)} 问`, `第 ${String(round)} 答`)).flat()
    const channel = makeChannel(snapshotOf(entries))
    const view = render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
      { container: chat },
    )
    await flush()
    const seats = (): number => view.container.querySelectorAll('[data-round-seat]').length
    const before = seats()
    const earlier = view.container.querySelector('.chat-earlier') as HTMLElement | null
    if (earlier === null) throw new Error('长会话必须画「加载更早」按钮')
    fireEvent.click(earlier)
    await flush()
    expect(seats()).toBeGreaterThan(before)
    // 锚点元素还挂在文档里：走的是「按原位补」而不是降级计数。
    expect(chat.dataset['foldAnchorFallback']).toBeUndefined()
  })
})

// ── next-input 档：新一轮进来时抹掉上一轮的整轮存档 ─────────────────────────

describe('next-input 档的存档清理', () => {
  test('上一轮不再是最后一轮的那一拍，把它的整轮折叠存档抹掉', async () => {
    writeFold('uuid-1:turn:0', true)
    const channel = makeChannel(snapshotOf(roundOf('第一问', '第一答')), {
      prefs: () => Promise.resolve({ collapseTiming: 'next-input' }),
    })
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    await flush()
    expect(readFold('uuid-1:turn:0', false)).toBe(true)
    // 第二轮进来：liveRoundIndex 从 0 变 1，上一轮的存档按 next-input 档抹掉。
    act(() => channel.set(snapshotOf([...roundOf('第一问', '第一答'), ...roundOf('第二问', '第二答')])))
    await flush()
    expect(readFold('uuid-1:turn:0', false)).toBe(false)
  })
})

// ── 编辑并重发的三条失败出口 ─────────────────────────────────────────────────

describe('编辑并重发的失败出口', () => {
  /** 渲一棵流并等挂载期落地，返回容器。 */
  async function mount(channel: ChannelHarness): Promise<ReturnType<typeof render>> {
    const view = render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    await flush()
    if (flowActions === null) throw new Error('节点槽里没有挂到 FlowActionsContext')
    return view
  }

  test('条目已经不在会话里：Toast 说「刷新后再试」，不发 rewindSession', async () => {
    const channel = makeChannel(snapshotOf(roundOf('问题', '回答')))
    await mount(channel)
    const actions = flowActions as FlowActions | null
    if (actions === null) throw new Error('没拿到动作表')
    act(() =>
      actions.editAndResend({ kind: 'user', id: 8888, text: '不存在' } as Extract<TranscriptEntry, { kind: 'user' }>, '改过'),
    )
    await flush()
    expect(toastText()).toContain(zh['transcript.edit.gone'])
    expect(channel.calls.some((call) => call.method === 'rewindSession')).toBe(false)
  })

  test('会话还没落盘：Toast 说「先发一条消息再编辑」，同样不发请求', async () => {
    const entries = roundOf('问题', '回答')
    const channel = makeChannel(snapshotOf(entries, { sessionPath: null }))
    await mount(channel)
    const actions = flowActions as FlowActions | null
    if (actions === null) throw new Error('没拿到动作表')
    act(() => actions.editAndResend(entries[0] as Extract<TranscriptEntry, { kind: 'user' }>, '改过'))
    await flush()
    expect(toastText()).toContain(zh['transcript.edit.notSaved'])
    expect(channel.calls.some((call) => call.method === 'rewindSession')).toBe(false)
  })

  test('宿主抛错：Toast 写「重发失败：<原因>」', async () => {
    const entries = roundOf('问题', '回答')
    const channel = makeChannel(snapshotOf(entries), {
      rewind: () => Promise.reject(new Error('磁盘只读')),
    })
    await mount(channel)
    const actions = flowActions as FlowActions | null
    if (actions === null) throw new Error('没拿到动作表')
    act(() => actions.editAndResend(entries[0] as Extract<TranscriptEntry, { kind: 'user' }>, '改过'))
    await flush(5)
    expect(toastText()).toContain(zh['transcript.edit.resendFailed'].replace('{message}', '磁盘只读'))
    expect(channel.calls.some((call) => call.method === 'submit')).toBe(false)
  })
})

// ── 动作表服务：首屏卡片改读动作表 / 空表回落内置清单 ───────────────────────

interface ActionServiceFacts {
  registry: ServiceRegistry
  registered: Array<{ owner: string; list: readonly UiAction[] }>
}

/**
 * 装一张动作表服务。
 *
 * `list()` 必须返回**同一个数组引用**：`useActions` 是 `useSyncExternalStore` 的订阅面，
 * 每次给新数组等于每帧都有变化，React 会一路重渲染到「Maximum update depth exceeded」。
 */
function actionsService(list: readonly UiAction[]): ActionServiceFacts {
  const registered: Array<{ owner: string; list: readonly UiAction[] }> = []
  const handle = {
    register: (owner: string, entries: readonly UiAction[]): (() => void) => {
      registered.push({ owner, list: entries })
      return () => undefined
    },
    list: (): readonly UiAction[] => list,
    subscribe: (): (() => void) => () => undefined,
  } as unknown as ActionsHandle
  const registry = new ServiceRegistry()
  registry.provide(ACTIONS_SERVICE, handle, 'test')
  return { registry, registered }
}

describe('动作表服务在的时候', () => {
  test('登记四条首屏动作；动作表有「提示词」分组时首屏卡片改读动作表', async () => {
    const action: UiAction = {
      id: 'welcome.read',
      label: '看懂这份代码',
      hint: '先读一遍',
      group: zh['transcript.action.group'],
      run: () => undefined,
    }
    const facts = actionsService([action])
    const channel = makeChannel(snapshotOf([]))
    const { container } = render(
      <ServicesProvider services={facts.registry}>
        <RuntimeProvider channel={channel}>
          <TranscriptFlow renderSlot={renderSlot} />
        </RuntimeProvider>
      </ServicesProvider>,
    )
    await flush()
    // 登记：owner 是 transcript，四条内置能力卡各一条。
    expect(facts.registered.map((item) => item.owner)).toEqual(['transcript'])
    expect(facts.registered[0]?.list.map((item) => item.id)).toEqual([
      'welcome.read',
      'welcome.build',
      'welcome.review',
      'welcome.fix',
    ])
    // 首屏卡片改读动作表（不是内置清单）：标题用的是动作表里的 label。
    expect(container.querySelector('.welcome-card-title')?.textContent).toBe('看懂这份代码')
  })

  test('登记的动作 run：composerDraft 缺席时静默收手，不抛', async () => {
    const facts = actionsService([])
    const channel = makeChannel(snapshotOf([]))
    render(
      <ServicesProvider services={facts.registry}>
        <RuntimeProvider channel={channel}>
          <TranscriptFlow renderSlot={renderSlot} />
        </RuntimeProvider>
      </ServicesProvider>,
    )
    await flush()
    const first = facts.registered[0]?.list[0]
    if (first === undefined) throw new Error('动作没有登记上')
    expect(() => act(() => first.run())).not.toThrow()
  })

  test('动作表空：首屏回落到内置四张卡；composer 在时点卡往输入框写字', async () => {
    const facts = actionsService([])
    const inserted: string[] = []
    facts.registry.provide('composerDraft', { insert: (text: string): void => void inserted.push(text) }, 'test')
    const channel = makeChannel(snapshotOf([]))
    const { container } = render(
      <ServicesProvider services={facts.registry}>
        <RuntimeProvider channel={channel}>
          <TranscriptFlow renderSlot={renderSlot} />
        </RuntimeProvider>
      </ServicesProvider>,
    )
    await flush()
    const card = container.querySelector('.welcome-card') as HTMLButtonElement | null
    if (card === null) throw new Error('首屏没有画卡片')
    expect(card.disabled).toBe(false)
    fireEvent.click(card)
    expect(inserted.length).toBe(1)
  })
})

// ── 开场 error 条目 / 「接着上次」/ 欢迎态 ───────────────────────────────────

describe('开场区与「接着上次」', () => {
  test('开场有 level:error 的 system 条目：只弹第一行 Toast', async () => {
    const entries = [
      {
        kind: 'system',
        id: 1,
        level: 'error',
        text: '没有可用的模型端点\n请到设置里配置',
      } as TranscriptEntry,
    ]
    const channel = makeChannel(snapshotOf(entries))
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    await flush()
    expect(toastText()).toContain('没有可用的模型端点')
    expect(toastText()).not.toContain('请到设置里配置')
  })

  test('「接着上次」只认七天内有标题、未归档、不是当前会话的那条；点一下开它', async () => {
    const now = Date.now()
    const sessions = [
      {
        id: 'archived',
        title: '归档的',
        updatedAt: now - 60_000,
        archivedAt: now - 30_000,
      },
      { id: 'D:/demo/current.jsonl', title: '当前的', updatedAt: now - 10_000 },
      { id: 'no-title', title: '', updatedAt: now - 20_000 },
      {
        id: 'stale',
        title: '很久以前',
        updatedAt: now - 8 * 24 * 60 * 60 * 1000,
      },
      { id: 'fresh', title: '接着做的事', updatedAt: now - 30_000 },
      { id: 'older', title: '更早的', updatedAt: now - 120_000 },
    ]
    const channel = makeChannel(snapshotOf([], { sessions, sessionPath: 'D:/demo/current.jsonl' }))
    const { container } = render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    await flush()
    const resume = container.querySelector('.welcome-resume') as HTMLElement | null
    if (resume === null) throw new Error('首屏没有画「接着上次」')
    expect(resume.textContent).toContain('接着做的事')
    expect(resume.textContent).not.toContain('更早的')
    fireEvent.click(resume)
    await flush()
    expect(channel.calls).toContainEqual({
      method: 'openSession',
      args: ['fresh'],
    })
    expect(channel.calls.some((call) => call.method === 'refreshSessions')).toBe(true)
  })
})
