/**
 * 一个座位的渲染（`render.tsx` 的 SeatBody）：整轮折叠、过程区分段、轮尾卡的端到端行为
 * （ui 层，真渲染）。
 *
 * 来源（缺口清单 B33 / B34，此前留守在探针里的「渲染接线」段）：
 * - `scripts/ui-fold-combo-test.mjs` 第 [3]：渲染层确实按 `buildRoundFolds` / `turnDefaultOpen`
 *   的返回值走——藏不藏查集合（foldedReplies 只管正文）、collapseTiming 只管最新一轮的
 *   默认展开、verbose 档连总开关都不画。原探针钉的是 render.tsx / ui.tsx 的正则；
 *   这里渲染出来逐样验。
 * - `scripts/ui-transcript-render-test.mjs` 第 [5] 的行为面：过程区按「段」包层
 *   （`.turn-process`），收起整段缩回；第 [8b]：独立行（写前预览卡、留在屏幕上的正文）
 *   **原地摆**，不被兜底挪到一轮末尾；第 [9]：轮尾「文件已更改」卡只在一轮收口之后出现
 *   （running 时不画——半截清单不能先上屏）；第 [8] 的组头失败数（data-step-failures）。
 *
 * 纯逻辑半（16 格矩阵、藏哪些下标）已在 `round-fold.spec.ts` / `paging.spec.ts`；
 * 这份只管「同样的数据渲染出来长什么样」。
 *
 * @module dsc-ui-transcript/ui/seat-body.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ToolViewRender } from './shared.js'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { TranscriptEntry } from '@dsc/ui'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { FOLD_PREFS, FoldPrefsContext, keyOf, type FoldPrefs, type Seat, type TranscriptChildSlot } from './shared.js'
import { buildSeats } from './shared.js'
import { createSeatStore } from './seat-store.js'
import { buildRoundFolds, type RoundFold } from './round-fold.js'
import { groupSteps, type StepGrouping } from './process-groups.js'
import { EMPTY_STEP_GROUPING } from './shared.js'
import { useFoldMemory } from './round-fold.js'
import { turnFoldKey, hasFold, clearFold } from './fold-state.js'
import type { ChatViewport } from './viewport.js'
import { SeatBody } from './render.js'

/** 测试替身宿主通道（座位里的工具卡要拿通道；这层测试不发调用）。 */
const stubChannel = (): HostChannel => ({
  getSnapshot: () => null,
  getHello: () => null,
  getStatus: () => 'closed',
  getHostError: () => null,
  getPluginsFrame: () => null,
  onPlugins: () => () => undefined,
  onAsk: () => () => undefined,
  subscribe: () => () => undefined,
  invoke: () => Promise.reject(new Error('测试不触发宿主调用')),
  reconnect: () => undefined,
  close: () => undefined,
})

/** SeatBody 的折叠动画只在真布局下走批次；jsdom 无布局（量高恒 0），视口给个无害替身。 */
const stubViewport = (): ChatViewport =>
  ({
    scroller: null,
    column: null,
    spacer: null,
    attach: () => undefined,
    detach: () => undefined,
    scrollTop: () => 0,
    scrollHeight: () => 0,
    clientHeight: () => 0,
    clientWidth: () => 0,
    spacerHeight: () => 0,
    floor: () => 0,
    floorSlack: () => 0,
    atFloor: () => true,
    offsetOf: () => null,
    rect: () => null,
    scrollToOffset: () => 0,
    motionActive: () => false,
    cancelMotion: () => undefined,
    hidden: () => false,
    pin: () => 0,
    beginBatch: () => null,
  }) as unknown as ChatViewport

/** 座位里画得出的行不量高；挡 jsdom 缺 ResizeObserver 的意外。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

afterEach(() => {
  cleanup()
  clearFold('sbspec:turn0')
  clearFold('sbspec:turn1')
  clearFold('sbspec:next-input')
  clearFold('sbspec:step0')
})

let seq = 0
const entryOf = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry

const prefsOf = (over: Partial<FoldPrefs> = {}): FoldPrefs => ({ ...FOLD_PREFS, ...over })

/**
 * 造一轮的渲染环境：entries → buildSeats（真切分，行身份是真产品口径）→
 * buildRoundFolds（真预算）→ SeatBody。返回渲染出的容器与工具。
 */
function renderSeat(
  entries: TranscriptEntry[],
  over: {
    foldPrefs?: FoldPrefs
    foldedReplies?: 'all' | 'final'
    running?: boolean
    stepGrouping?: StepGrouping
    sessionId?: string | null
    foldTurns?: boolean
  } = {},
): ReturnType<typeof render> {
  const sessionId = over.sessionId ?? 'sbspec'
  const seats = buildSeats(entries, [])
  const seat: Seat = seats.rounds[0] as Seat
  const store = createSeatStore(keyOf)
  store.stage(sessionKey(sessionId), { leading: [], rounds: [seat] })
  const round = seats.infos[0]
  const roundFolds = new Map<number, RoundFold>(
    buildRoundFolds(entries, seats.infos, {
      foldTurns: over.foldTurns !== false,
      live: over.running === true,
      lastRoundIndex: seats.infos.length - 1,
      foldedReplies: over.foldedReplies ?? 'final',
    }).entries(),
  )
  const foldPrefs = over.foldPrefs ?? prefsOf({ ...(over.foldPrefs ?? {}) })
  return render(
    <RuntimeProvider channel={stubChannel()}>
      <FoldPrefsContext.Provider value={foldPrefs}>
        <SeatHarness
          seat={seat}
          round={round}
          running={over.running === true}
          sessionId={sessionId}
          sessionKey={sessionKey(sessionId)}
          cwd="D:/demo"
          roundFolds={roundFolds}
          stepGrouping={over.stepGrouping ?? EMPTY_STEP_GROUPING}
          store={store}
        />
      </FoldPrefsContext.Provider>
    </RuntimeProvider>,
  )
}

/** 渲染 harness：foldMemory 用真钩子（点击开合写存档 + 当场重画的完整链路）。 */
/**
 * 全体弃权的槽渲染：chain 槽没人认领时兜底画内置行体（这条测试不装插件，内置行是全部）。
 */
const renderSlot = ((slot: TranscriptChildSlot, owner: unknown, fallback?: ReactNode): ReactNode => (fallback ?? null)) as unknown as ToolViewRender

function SeatHarness(props: {
  seat: Seat
  round: ReturnType<typeof buildSeats>['infos'][number]
  running: boolean
  sessionId: string | null
  sessionKey: string
  cwd: string
  roundFolds: ReadonlyMap<number, RoundFold>
  stepGrouping: StepGrouping
  store: ReturnType<typeof createSeatStore>
}): ReactNode {
  const foldMemory = useFoldMemory()
  return (
    <SeatBody
      seat={props.seat}
      round={props.round}
      running={props.running}
      sessionId={props.sessionId}
      sessionKey={props.sessionKey}
      cwd={props.cwd}
      roundFolds={props.roundFolds}
      foldMemory={foldMemory}
      stepGrouping={props.stepGrouping}
      renderSlot={renderSlot}
      store={props.store}
      viewport={stubViewport()}
      onForkRound={undefined}
    />
  )
}

/** SeatBody 要的 sessionKey（行 key 的会话半）：与 keyOf 的口径一致。 */
const sessionKey = (sessionId: string | null): string => sessionId ?? ''



/** 两轮样张：每轮「题面 → 思考 → 回答」。 */
const roundOf2 = (): TranscriptEntry[] => [
  entryOf('user', { text: '第一问', ts: 1 }),
  entryOf('thinking', { text: '第一轮的思考。' }),
  entryOf('text', { text: '第一轮的回答。', ts: 2 }),
  entryOf('user', { text: '第二问', ts: 3 }),
  entryOf('thinking', { text: '第二轮的思考。' }),
  entryOf('text', { text: '第二轮的回答。', ts: 4 }),
]

/** 一轮「题面 → 中间正文 → 思考 → 工具 → 最终回答」的样张（两档 foldedReplies 的对比面）。 */
const sampleEntries = (): TranscriptEntry[] => [
  entryOf('user', { text: '第一问', ts: 1 }),
  entryOf('text', { text: '中间那句交代。', ts: 2 }),
  entryOf('thinking', { text: '想一想。' }),
  entryOf('tool', { call: { callId: 'c1', name: 'bash', argsText: '{"command":"ls"}', status: 'done' } }),
  entryOf('text', { text: '最终回答。', ts: 9 }),
]

const hiddenRows = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll('.entry-row[hidden]')] as HTMLElement[]

describe('藏不藏查集合：foldedReplies 只管正文（ui-fold-combo [3]）', () => {
  test('final 档（出厂）收起整轮：思考与工具藏、最终回答不藏', () => {
    const { container } = renderSeat(sampleEntries(), { sessionId: 'sbspec' })
    expect(container.querySelector('.turn-fold')).toBeTruthy()
    const rows = hiddenRows(container)
    const texts = rows.map((row) => row.textContent ?? '')
    expect(texts.some((text) => text.includes('想一想'))).toBe(true)
    expect(texts.some((text) => text.includes('最终回答'))).toBe(false)
    expect(texts.some((text) => text.includes('第一问'))).toBe(false)
  })

  test('all 档：中间那句交代留在屏幕上，且不进 .turn-process 段（收起时不能被一起缩掉）', () => {
    const { container } = renderSeat(sampleEntries(), { foldedReplies: 'all', sessionId: 'sbspec' })
    const middle = [...container.querySelectorAll('.entry-row')].find((row) => row.textContent?.includes('中间那句交代'))
    expect(middle).toBeTruthy()
    expect((middle as HTMLElement).hasAttribute('hidden')).toBe(false)
    // 留在外面的正文不是任何一段过程区的子孙。
    const segments = [...container.querySelectorAll('.turn-process')]
    expect(segments.every((segment) => !segment.contains(middle as Node))).toBe(true)
    // 过程行仍被藏，且它们在段里。
    expect(segments.length).toBeGreaterThanOrEqual(1)
    expect(segments.some((segment) => segment.querySelector('.entry-row[hidden]'))).toBe(true)
  })

  test('verbose 档（foldTurns=false）：不画总开关、一个行都不藏', () => {
    const { container } = renderSeat(sampleEntries(), { foldTurns: false, sessionId: 'sbspec' })
    expect(container.querySelector('.turn-fold')).toBeNull()
    expect(hiddenRows(container).length).toBe(0)
  })
})

describe('collapseTiming 只管最新一轮的默认展开（ui-fold-combo [3]）', () => {
  test('next-input + 最新轮：默认摊着（总开关 data-open、行不藏）；存档优先于兜底', () => {
    const { container } = renderSeat(sampleEntries(), {
      sessionId: 'sbspec:next-input',
      foldPrefs: prefsOf({ collapseTiming: 'next-input' }),
    })
    expect((container.querySelector('.turn-fold') as HTMLElement).getAttribute('data-open')).toBe('1')
    expect(hiddenRows(container).length).toBe(0)
    // 用户亲手收起：写进存档，兜底不再翻它。
    fireEvent.click(container.querySelector('.turn-fold') as HTMLElement)
    expect(hasFold(turnFoldKey('sbspec:next-input', 0))).toBe(true)
    expect(hiddenRows(container).length).toBeGreaterThan(0)
  })

  test('completion（出厂）：跑完立刻收起', () => {
    const { container } = renderSeat(sampleEntries(), { sessionId: 'sbspec' })
    expect((container.querySelector('.turn-fold') as HTMLElement).hasAttribute('data-open')).toBe(false)
    expect(hiddenRows(container).length).toBeGreaterThan(0)
  })
})

describe('过程区按段包层、独立行原地摆（B33 [5] 行为面 + [8b]）', () => {
  test('藏、留、藏的形状：连续藏行各成一段，留在屏幕上的正文夹在中间原位', () => {
    const entries = [
      entryOf('user', { text: '题面', ts: 1 }),
      entryOf('thinking', { text: '第一段思考。' }),
      entryOf('text', { text: '第一句交代。' }),
      entryOf('thinking', { text: '第二段思考。' }),
      entryOf('text', { text: '最终回答。', ts: 9 }),
    ]
    const { container } = renderSeat(entries, { foldedReplies: 'all', sessionId: 'sbspec' })
    const segments = [...container.querySelectorAll('.turn-process')]
    expect(segments.length).toBe(2)
    // DOM 顺序就是条目顺序（总开关行除外）：没有 afterBlocks 那条「挪到队尾」的兜底路。
    const all = (container as HTMLElement).textContent ?? ''
    const stops = ['题面', '第一段思考', '第一句交代', '第二段思考', '最终回答'].map((needle) => all.indexOf(needle))
    expect(stops.every((at) => at >= 0)).toBe(true)
    expect([...stops].sort((a, b) => a - b).join(',')).toBe(stops.join(','))
  })

  test('写前预览卡（system 条目）同样原地摆，收起整轮不把它一起藏掉（TURN_INDEPENDENT）', () => {
    const entries = [
      entryOf('user', { text: '题面', ts: 1 }),
      entryOf('thinking', { text: '想一想。' }),
      entryOf('system', { text: '【将做的改动】--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-x\n+y' }),
      entryOf('text', { text: '最终回答。', ts: 9 }),
    ]
    const { container } = renderSeat(entries, { sessionId: 'sbspec' })
    const independent = [...container.querySelectorAll('.entry-row')].find(
      (row) => (row.textContent ?? '').includes('将做的改动'),
    )
    expect(independent).toBeTruthy()
    expect((independent as HTMLElement).hasAttribute('hidden')).toBe(false)
  })

  test('不上屏的条目（changes / turnDiff）连段都不参与（B33 [7]⑨ 渲染面）', () => {
    const entries = [
      entryOf('user', { text: '题面', ts: 1 }),
      entryOf('thinking', { text: '想一想。' }),
      entryOf('changes', { file: { path: 'a.ts', added: 1, removed: 0, hunks: [] } }),
      entryOf('text', { text: '最终回答。', ts: 9 }),
    ]
    const { container } = renderSeat(entries, { sessionId: 'sbspec' })
    // 座位行里没有它（空盒子不占高度、也不占段缝）；同一轮的改动聚合成轮尾卡才出现。
    const rows = [...container.querySelectorAll('.entry-row')]
    expect(rows.some((row) => (row.textContent ?? '').includes('a.ts'))).toBe(false)
    expect(container.querySelector('.changes-card')?.textContent).toContain('a.ts')
  })
})

describe('轮尾卡只在一轮收口之后出现（B33 [9]）', () => {
  test('running 时无「文件已更改」卡；停下后画出来', () => {
    const entries = [
      entryOf('user', { text: '改一下', ts: 1 }),
      entryOf('changes', { file: { path: 'a.ts', added: 3, removed: 1, hunks: [] } }),
      entryOf('text', { text: '改好了。', ts: 9 }),
    ]
    const running = renderSeat(entries, { running: true, sessionId: 'sbspec' })
    expect(running.container.querySelector('.changes-card')).toBeNull()
    cleanup()
    const settled = renderSeat(entries, { running: false, sessionId: 'sbspec' })
    expect(settled.container.querySelector('.changes-card')).toBeTruthy()
  })
})

describe('组头的失败数（B33 [8]）', () => {
  test('组里失败的工具在组头上报数（不点开也能读到坑）', () => {
    const entries = [
      entryOf('user', { text: '跑一下', ts: 1 }),
      entryOf('thinking', { text: '先想。' }),
      entryOf('tool', { call: { callId: 'a', name: 'bash', argsText: '{}', status: 'failed' } }),
      entryOf('tool', { call: { callId: 'b', name: 'read', argsText: '{}', status: 'done' } }),
      entryOf('text', { text: '答完', ts: 9 }),
    ]
    const grouping = groupSteps(entries, [{ index: 0, startIndex: 0, endIndex: 4, startTs: 1, endTs: 9, answered: true }], () => false)
    const { container } = renderSeat(entries, { sessionId: 'sbspec', stepGrouping: grouping })
    const fail = container.querySelector('[data-step-failures]')
    expect(fail).toBeTruthy()
    expect((fail as HTMLElement).getAttribute('data-step-failures')).toBe('1')
    expect((fail as HTMLElement).textContent).toMatch(/1/)
  })
})

describe('collapseTiming 的 latest 位：只有最新一轮默认摊开（ui-fold-combo [3] 渲染面）', () => {
  test('next-input 下两轮：历史轮收起、最新一轮摊开', () => {
    const entries = roundOf2()
    const sessionId = 'sbspec:two-rounds'
    const seats = buildSeats(entries, [])
    const store = createSeatStore(keyOf)
    store.stage(sessionKey(sessionId), { leading: [], rounds: seats.rounds })
    const roundFolds = buildRoundFolds(entries, seats.infos, {
      foldTurns: true,
      live: false,
      lastRoundIndex: seats.infos.length - 1,
      foldedReplies: 'final',
    })
    const harness = render(
      <RuntimeProvider channel={stubChannel()}>
        <FoldPrefsContext.Provider value={prefsOf({ collapseTiming: 'next-input' })}>
          {seats.rounds.map((seat) => (
            <div key={seat.round} data-two-round={seat.round}>
              <SeatHarness
                seat={seat}
                round={seats.infos[seat.round]}
                running={false}
                sessionId={sessionId}
                sessionKey={sessionKey(sessionId)}
                cwd=""
                roundFolds={roundFolds}
                stepGrouping={EMPTY_STEP_GROUPING}
                store={store}
              />
            </div>
          ))}
        </FoldPrefsContext.Provider>
      </RuntimeProvider>,
    )
    const seatOf = (round: number): HTMLElement =>
      harness.container.querySelector(`[data-two-round="${String(round)}"]`) as HTMLElement
    // 历史轮（0）按兜底收起；最新轮（1）摊着——漏掉 latest 位这里当场红。
    expect(hiddenRows(seatOf(0)).length).toBeGreaterThan(0)
    expect(hiddenRows(seatOf(1)).length).toBe(0)
    expect((seatOf(1).querySelector('.turn-fold') as HTMLElement).getAttribute('data-open')).toBe('1')
  })
})
