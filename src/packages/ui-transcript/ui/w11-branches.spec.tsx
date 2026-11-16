/**
 * ui 覆盖率补口（w11）：ui.tsx 的等人卡 / 回合收尾通知、tool-row 的槽装配、阶段组头
 * 实时标题防抖、组体滚动的手势与落定、工具卡若干纯函数与读图卡交互。
 *
 * 每一条都对着一处**行为**，不是对着行号：
 *  - `ui.tsx` 的 `readWaitingCard` 三类卡的优先级与标题回退，以及后台才提示、同会话不重复；
 *  - `BuiltinToolView` 交给 Factory 的定义与四个局部槽，偏好 / cwd 从 context 取；
 *  - `useProcessScroll` 的贴底 / 渐隐边 / 手势落定 / 内容变长跟随；
 *  - `useStableLiveTitle` 的 150ms 最短保留与「跳过中间态、取最新」；
 *  - 工具卡路径换算、参数拆字段、结果尾巴 / 首行 / 余下原文、读图徽章与 onLoad / onError。
 *
 * 这只是测试补充，不改产品；所有断言都落在 DOM / 调用记录 / 返回值上。
 *
 * @module dsc-ui-transcript/ui/w11-branches.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRef, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { HostSnapshot, SlotRenderApi, ToolCallView, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { DockFsRead } from './tool-card/read-image-model.js'
import { FOLD_PREFS, FoldPrefsContext, ShellCwdContext, TOOLVIEW_SLOT, type ToolEntry, type TranscriptChildSlot } from './shared.js'
import { BuiltinToolView } from './rows/tool-row.js'
import { StepGroupRow } from './step-group-row.js'
import { useProcessScroll } from './fold-seats.js'
import type { StepGroup } from './process-groups.js'
import { TOOLCARD_FACTORY } from './tool-card/factory.js'
import { absPathOf } from './tool-card/file-path.js'
import { PathButton } from './tool-card/path-button.js'
import { firstLineOf, flatValueOf, toolDetailArgs } from './tool-card/tool-detail.js'
import { resultHead, resultRest, resultTail } from './tool-card/result-tail.js'
import { ReadImageBadge, ReadImageBody } from './tool-card/read-image-view.js'
import plugin from './ui.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// ── ui.tsx：TranscriptFlow 的等人卡 / 回合收尾通知 ─────────────────────────────

/** 生产壳装载插件时同样走 `apply`：在测试替身上重放，收下 shell.main 的流组件。 */
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

/** 假宿主通道：快照可替换，`invoke('getUiPrefs')` 答空对象，其余方法名落空。 */
function makeChannel(initial: HostSnapshot | null): HostChannel & { set(snapshot: HostSnapshot | null): void } {
  let snapshot = initial
  const listeners = new Set<() => void>()
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
    invoke: ((method: string) =>
      method === 'getUiPrefs' ? Promise.resolve({}) : Promise.resolve({ ok: true })) as unknown as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
    set(next: HostSnapshot | null) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const renderSlot = ((_slot: TranscriptChildSlot, _owner: unknown, fallback?: ReactNode): ReactNode => fallback ?? null) as unknown as SlotRenderApi<TranscriptChildSlot>['renderSlot']

/** 一轮问答 + 可选 surfaces（等人的卡）与状态。 */
function snapshotOf(
  entries: TranscriptEntry[],
  over: { turnState?: string; sessionPath?: string; surfaces?: unknown } = {},
): HostSnapshot {
  return {
    entries,
    liveEntries: [],
    status: {
      cwd: 'D:/demo',
      sessionPath: over.sessionPath ?? 'D:/demo/demo-session.jsonl',
      sessionId: 'uuid-1',
      turnState: over.turnState ?? 'idle',
    },
    ...(over.surfaces === undefined ? {} : { surfaces: over.surfaces }),
  } as unknown as HostSnapshot
}

let nextId = 100
const roundOf = (question: string, answer: string): TranscriptEntry[] => [
  { kind: 'user', id: (nextId += 1), text: question, ts: 10 } as TranscriptEntry,
  { kind: 'text', id: (nextId += 1), text: answer, ts: 11 } as TranscriptEntry,
]

/** 把窗口放到后台，并装一个可用的原生桥：通知路径才会走到 `invoke('notify')`。 */
function backgroundWithNative(): ReturnType<typeof vi.fn> {
  const call = vi.fn(() => Promise.resolve())
  vi.stubGlobal('dscNative', { version: 1, call, on: () => () => undefined })
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  return call
}

describe('ui.tsx：回合收尾与等人卡通知', () => {
  test('同一会话从跑动变空闲：后台弹一条完成通知，正文是这一轮最后一句正文', () => {
    const call = backgroundWithNative()
    const channel = makeChannel(snapshotOf(roundOf('问题', '这是最后一句回答。'), { turnState: 'running' }))
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )

    act(() => channel.set(snapshotOf(roundOf('问题', '这是最后一句回答。'), { turnState: 'idle' })))

    expect(call).toHaveBeenCalledTimes(1)
    const [op, args] = call.mock.calls[0] as unknown as [string, Array<{ title: string; body: string }>]
    expect(op).toBe('notify')
    expect(args[0].body).toContain('这是最后一句回答。')
  })

  test('审批卡：有参数摘要用摘要；摘要为空退回工具名（通知里总得有一行字）', () => {
    const call = backgroundWithNative()
    const channel = makeChannel(snapshotOf(roundOf('问题', '回答')))
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )

    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '回答'), {
          surfaces: { pendingApproval: { id: 'a1', toolName: 'bash', argsSummary: '  rm -rf build  ' } },
        }),
      ),
    )
    let payload = (call.mock.calls[0] as unknown as [string, Array<{ body: string }>])[1][0]
    expect(payload.body).toBe('rm -rf build')

    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '回答'), {
          surfaces: { pendingApproval: { id: 'a2', toolName: 'edit', argsSummary: '   ' } },
        }),
      ),
    )
    payload = (call.mock.calls[1] as unknown as [string, Array<{ body: string }>])[1][0]
    expect(payload.body).toBe('edit')
  })

  test('计划卡与提问卡：计划用标题，提问优先 header、没有就用 question 原文', () => {
    const call = backgroundWithNative()
    const channel = makeChannel(snapshotOf(roundOf('问题', '回答')))
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )

    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '回答'), { surfaces: { pendingPlan: { file: 'p.md', title: '改三处' } } }),
      ),
    )
    expect((call.mock.calls[0] as unknown as [string, Array<{ body: string }>])[1][0].body).toBe('改三处')

    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '回答'), {
          surfaces: { pendingQuestion: { id: 'q1', header: '  ', question: '你选哪个？' } },
        }),
      ),
    )
    expect((call.mock.calls[1] as unknown as [string, Array<{ body: string }>])[1][0].body).toBe('你选哪个？')
  })

  test('同一张卡内容变了不重复喊；切会话先记下当前卡，不把旧会话的卡再提示一次', () => {
    const call = backgroundWithNative()
    const channel = makeChannel(snapshotOf(roundOf('问题', '回答')))
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )

    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '回答'), {
          surfaces: { pendingApproval: { id: 'a1', toolName: 'bash', argsSummary: '第一版摘要' } },
        }),
      ),
    )
    expect(call).toHaveBeenCalledTimes(1)

    // 同一张卡（同 id）：摘要变了也不算新卡。
    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '回答'), {
          surfaces: { pendingApproval: { id: 'a1', toolName: 'bash', argsSummary: '第二版摘要' } },
        }),
      ),
    )
    expect(call).toHaveBeenCalledTimes(1)

    // 切会话：当前卡被记进新会话，不提示。
    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '回答'), {
          sessionPath: 'D:/demo/other.jsonl',
          surfaces: { pendingApproval: { id: 'a1', toolName: 'bash', argsSummary: '第二版摘要' } },
        }),
      ),
    )
    expect(call).toHaveBeenCalledTimes(1)

    // 新会话里换一张新卡：照常提示。
    act(() =>
      channel.set(
        snapshotOf(roundOf('问题', '回答'), {
          sessionPath: 'D:/demo/other.jsonl',
          surfaces: { pendingApproval: { id: 'a9', toolName: 'read', argsSummary: '读文件' } },
        }),
      ),
    )
    expect(call).toHaveBeenCalledTimes(2)
    expect((call.mock.calls[1] as unknown as [string, Array<{ body: string }>])[1][0].body).toBe('读文件')
  })

  test('surfaces 不是对象（老宿主 / 半截帧）时不抛、也不提示', () => {
    const call = backgroundWithNative()
    const channel = makeChannel(snapshotOf(roundOf('问题', '回答')))
    render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    expect(() => act(() => channel.set(snapshotOf(roundOf('问题', '回答'), { surfaces: 'nope' })))).not.toThrow()
    expect(call).not.toHaveBeenCalled()
  })
})

// ── tool-row：BuiltinToolView 的装配 ──────────────────────────────────────────

describe('tool-row：内置工具卡的 Factory 装配', () => {
  test('把 entry / 键 / 偏好 / cwd 与四个局部槽一起交给 Factory 定义', () => {
    const entry: ToolEntry = { kind: 'tool', id: 7, call: { callId: 'c7', name: 'grep', argsText: '{}', status: 'done' } }
    const renderFactorySlot = vi.fn(() => <span data-testid="factory" />)
    const props = {
      entry,
      storeKey: 's:7',
      matched: { icon: 'search', verb: '搜索' },
      renderFactorySlot,
    }
    const { getByTestId } = render(
      <FoldPrefsContext.Provider value={FOLD_PREFS}>
        <ShellCwdContext.Provider value="D:/work">
          <BuiltinToolView {...(props as unknown as Parameters<typeof BuiltinToolView>[0])} />
        </ShellCwdContext.Provider>
      </FoldPrefsContext.Provider>,
    )
    expect(getByTestId('factory')).not.toBeNull()
    expect(renderFactorySlot).toHaveBeenCalledWith(
      TOOLCARD_FACTORY,
      expect.objectContaining({
        entry,
        storeKey: 's:7',
        persistKey: 's:7',
        variant: 'chat',
        match: props.matched,
        foldPrefs: FOLD_PREFS,
        cwd: 'D:/work',
      }),
      expect.objectContaining({
        slots: expect.objectContaining({
          preview: expect.any(Function),
          statusDetail: expect.any(Function),
          bodyExtra: expect.any(Function),
          trailing: expect.any(Function),
        }),
        fallback: expect.anything(),
      }),
    )
    void TOOLVIEW_SLOT
  })
})

// ── fold-seats：useProcessScroll 的手势 / 落定 / 跟随 ─────────────────────────

let resizeCallback: (() => void) | null = null

function ScrollHarness({ open, live }: { open: boolean; live: boolean }): ReactNode {
  const bodyRef = createRef<HTMLDivElement>()
  const contentRef = createRef<HTMLDivElement>()
  const edges = useProcessScroll(bodyRef, contentRef, open, live)
  return (
    <div>
      <div className="process-body" ref={bodyRef}>
        <div ref={contentRef}>内容</div>
      </div>
      <span data-testid="edges" data-up={edges.up ? '1' : '0'} data-down={edges.down ? '1' : '0'} />
    </div>
  )
}

describe('fold-seats：useProcessScroll', () => {
  test('展开时贴底并跟随；内容变长补位置；手势松手、落定够近再恢复跟随', () => {
    resizeCallback = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        resizeCallback = callback
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    const view = render(<ScrollHarness open live />)
    const body = view.container.querySelector('.process-body') as HTMLDivElement
    const edges = (): HTMLElement => view.getByTestId('edges')
    const layout = { scrollHeight: 500, clientHeight: 100 }
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => layout.scrollHeight })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => layout.clientHeight })

    // 刚展开：live 组贴到底；之后内容变长，跟随开着就继续补到底。
    act(() => resizeCallback?.())
    expect(body.scrollTop).toBe(500)
    expect(edges().getAttribute('data-up')).toBe('1')
    expect(edges().getAttribute('data-down')).toBe('0')

    body.scrollTop = 0
    act(() => resizeCallback?.())
    expect(body.scrollTop).toBe(500)

    // 读者往回滚：立刻松手（不等越线），两条渐隐边都亮。
    body.scrollTop = 100
    fireEvent.scroll(body)
    expect(edges().getAttribute('data-up')).toBe('1')
    expect(edges().getAttribute('data-down')).toBe('1')

    // 往上滚 / 向上翻页是手势；往下滚、Ctrl+滚轮、普通按键都不是。
    fireEvent.wheel(body, { deltaY: -10 })
    fireEvent.wheel(body, { deltaY: 10 })
    fireEvent.wheel(body, { deltaY: -10, ctrlKey: true })
    fireEvent.keyDown(body, { key: 'ArrowUp' })
    fireEvent.keyDown(body, { key: 'PageUp' })
    fireEvent.keyDown(body, { key: 'Home' })
    fireEvent.keyDown(body, { key: 'x' })

    // 手势落定：离底还远 → 不恢复跟随。
    act(() => body.dispatchEvent(new Event('scrollend')))
    expect(edges().getAttribute('data-down')).toBe('1')

    // 落定在离底 2px 以内：恢复跟随并补齐最后几像素。
    body.scrollTop = 398
    act(() => body.dispatchEvent(new Event('scrollend')))
    expect(body.scrollTop).toBe(500)
    expect(edges().getAttribute('data-down')).toBe('0')
  })

  test('收起（open=false）不装监听、不做任何测量', () => {
    resizeCallback = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        resizeCallback = callback
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    const view = render(<ScrollHarness open={false} live={false} />)
    const body = view.container.querySelector('.process-body') as HTMLDivElement
    const layout = { scrollHeight: 500, clientHeight: 100 }
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => layout.scrollHeight })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => layout.clientHeight })

    fireEvent.scroll(body)
    fireEvent.wheel(body, { deltaY: -10 })
    act(() => resizeCallback?.())

    expect(body.scrollTop).toBe(0)
    expect(view.getByTestId('edges').getAttribute('data-up')).toBe('0')
  })
})

// ── step-group-row：实时标题的最短保留 ────────────────────────────────────────

const groupOf = (over: Partial<StepGroup> = {}): StepGroup =>
  ({
    roundIndex: 0,
    seq: 0,
    startIndex: 0,
    endIndex: 1,
    size: 2,
    members: [0, 1],
    counts: [{ kind: 'read', count: 2 }],
    failures: 0,
    closed: false,
    running: 'read',
    runningDetail: '第一版',
    preparing: false,
    ...over,
  }) as StepGroup

describe('step-group-row：实时标题防抖', () => {
  test('150ms 内换标题先保留旧的；到点换成最新（跳过中间态）', async () => {
    const view = render(<StepGroupRow group={groupOf()} open={false} showDetail onToggle={vi.fn()} />)
    // 标题说的是「正在读取文件」，具体任务在下一行的详情里；防抖的是整份实时标题。
    const detail = (): string => view.container.querySelector('.step-fold-detail')?.textContent ?? ''
    expect(view.container.querySelector('.step-fold-label')?.textContent).toContain('读取')
    expect(detail()).toBe('第一版')

    view.rerender(<StepGroupRow group={groupOf({ runningDetail: '第二版' })} open={false} showDetail onToggle={vi.fn()} />)
    expect(detail()).toBe('第一版')

    // 到点前又换了一次：只显示最新那个，中间态不排队。
    view.rerender(<StepGroupRow group={groupOf({ runningDetail: '第三版' })} open={false} showDetail onToggle={vi.fn()} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(detail()).toBe('第三版')

    // 又换一版、马上换回当前这版：定时器到点发现「已经一样」，不做无谓提交。
    view.rerender(<StepGroupRow group={groupOf({ runningDetail: '第四版' })} open={false} showDetail onToggle={vi.fn()} />)
    view.rerender(<StepGroupRow group={groupOf({ runningDetail: '第三版' })} open={false} showDetail onToggle={vi.fn()} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(detail()).toBe('第三版')

    // 定稿的组不参与防抖：没有实时详情，标题直接用聚合文案。
    view.rerender(<StepGroupRow group={groupOf({ closed: true, running: undefined })} open={false} showDetail onToggle={vi.fn()} />)
    expect(view.container.querySelector('.step-fold-detail')).toBeNull()
  })
})

// ── 工具卡纯函数 / 读图卡 ─────────────────────────────────────────────────────

describe('tool-card：路径、参数与结果尾巴的口径', () => {
  test('absPathOf：绝对路径 / 空基准原样返回，分隔符跟基准走', () => {
    expect(absPathOf('', 'D:/w')).toBe('')
    expect(absPathOf('/abs/a.ts', 'D:/w')).toBe('/abs/a.ts')
    expect(absPathOf('C:\\abs\\a.ts', 'D:/w')).toBe('C:\\abs\\a.ts')
    expect(absPathOf('a.ts', '')).toBe('a.ts')
    expect(absPathOf('a.ts', 'D:\\w\\')).toBe('D:\\w\\a.ts')
    // 以 `/` 开头的已经是绝对路径，原样返回。
    expect(absPathOf('/a.ts', 'C:/w/')).toBe('/a.ts')
    // 基准混写两种分隔符：按 `/`。
    expect(absPathOf('a.ts', 'C:/a\\b')).toBe('C:/a\\b/a.ts')
  })

  test('PathButton：patch 决定 data-tc-source 与提示，路径按 cwd 显示相对形态', () => {
    const noPatch = render(<PathButton absPath="D:/w/src/a.ts" cwd="D:/w" onClick={vi.fn()} />)
    const file = noPatch.container.querySelector('button') as HTMLButtonElement
    expect(file.getAttribute('data-tc-source')).toBe('file')
    expect(file.getAttribute('data-tc-open')).toBe('D:/w/src/a.ts')
    expect(file.textContent).toBe('src/a.ts')

    const withPatch = render(
      <PathButton absPath="D:/w/src/a.ts" cwd="D:/w" patch={{ path: 'D:/w/src/a.ts' } as never} onClick={vi.fn()} />,
    )
    expect(withPatch.container.querySelector('button')?.getAttribute('data-tc-source')).toBe('patch')
  })

  test('toolDetailArgs：解析不出 / 不是对象给空表；omit 剔除；多行值标记', () => {
    expect(toolDetailArgs('{')).toEqual({ fields: [] })
    expect(toolDetailArgs('null')).toEqual({ fields: [] })
    expect(toolDetailArgs('[]')).toEqual({ fields: [] })
    expect(toolDetailArgs('"text"')).toEqual({ fields: [] })

    const detail = toolDetailArgs(
      JSON.stringify({ path: 'a.ts', body: '第一行\n第二行', obj: { k: 1 }, skip: 'x' }),
      ['skip'],
    )
    expect(detail.fields.map((field) => field.key)).toEqual(['path', 'body', 'obj'])
    expect(detail.fields[1]).toEqual({ key: 'body', value: '第一行\n第二行', multiline: true })
    expect(detail.fields[2].value).toBe('{"k":1}')

    expect(firstLineOf('\r\n   \n 真首行 \n第二行')).toBe('真首行')
    expect(firstLineOf('   \n\t\n')).toBe('')
    expect(flatValueOf({ key: 'k', value: '\n 首行\n', multiline: true })).toBe('首行')
    expect(flatValueOf({ key: 'k', value: ' 单行 ', multiline: false })).toBe('单行')
  })

  test('resultTail / resultHead / resultRest：取尾巴、取头、余下原文的边界', () => {
    expect(resultTail(undefined)).toBeNull()
    expect(resultTail('   ')).toBeNull()
    expect(resultHead(undefined)).toBeNull()
    expect(resultTail('a\n\n b \n', 1)).toEqual({ lines: [' b'], hidden: 1 })
    expect(resultTail('a', 0)).toEqual({ lines: [], hidden: 1 })
    expect(resultHead('a\nb\nc', 1)).toEqual({ lines: ['a'], hidden: 2 })
    expect(resultHead('a\nb', 0)).toEqual({ lines: [], hidden: 2 })
    expect(resultRest(undefined)).toBe('')
    expect(resultRest('  \n ')).toBe('')
    expect(resultRest('a\nb\nc')).toBe('b\nc')
    expect(resultRest('\n\nb\nc')).toBe('c')
    const long = 'x'.repeat(301)
    const clipped = resultTail(`${long}\n`, 1)
    expect(clipped?.lines[0]).toHaveLength(300)
    expect(clipped?.lines[0].endsWith('…')).toBe(true)
  })

  test('读图徽章：没有事实不画；MIME 取斜杠后的短格式，认不出斜杠原样返回', () => {
    expect(ReadImageBadge({ facts: null })).toBeNull()
    const short = render(<ReadImageBadge facts={{ mime: 'image/svg+xml', bytes: 2048 }} />)
    expect(short.container.textContent).toContain('SVG+XML')
    short.unmount()
    const raw = render(<ReadImageBadge facts={{ mime: 'PNG', bytes: 2048 }} />)
    expect(raw.container.textContent).toContain('PNG')
  })

  test('读图卡：图自报尺寸才画读数；解不出来退回「读不到」；非激活键不拦', async () => {
    const channel: HostChannel = {
      getSnapshot: () => null,
      getHello: () => null,
      getStatus: () => 'open',
      getHostError: () => null,
      getPluginsFrame: () => null,
      onPlugins: () => () => undefined,
      onAsk: () => () => undefined,
      subscribe: () => () => undefined,
      invoke: <T,>() => Promise.resolve({ kind: 'image', mime: 'image/png', base64: 'AA' } as DockFsRead) as Promise<T>,
      reconnect: () => undefined,
      close: () => undefined,
    }
    const call: ToolCallView = { callId: 'c1', name: 'read_image', argsText: '{"path":"shot.png"}', status: 'done' }
    const view = render(
      <RuntimeProvider channel={channel}>
        <ReadImageBody call={call} image={{ path: 'shot.png' }} cwd="D:/w" />
      </RuntimeProvider>,
    )
    await waitFor(() => expect(view.container.querySelector('.tc-shot-img')).not.toBeNull())
    const img = view.container.querySelector('.tc-shot-img') as HTMLImageElement
    // 非激活键直接返回：不 preventDefault、不开预览。
    expect(() => fireEvent.keyDown(img, { key: 'a' })).not.toThrow()

    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 640 })
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 480 })
    fireEvent.load(img)
    expect(view.container.querySelector('.tc-shot-meta')?.textContent).toContain('640')

    fireEvent.error(img)
    expect(view.container.textContent).toContain('读不到')
    expect(view.container.querySelector('.tc-shot-img')).toBeNull()
  })
})
