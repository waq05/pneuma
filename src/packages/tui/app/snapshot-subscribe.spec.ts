/**
 * TUI 快照合并存储（`snapshot-subscribe.ts`）的两层测试（整条迁自
 * `scripts/tui-snapshot-coalesce-test.mjs`）。
 *
 * ## 来源与分层
 *
 * 原探针两段都在这一个文件里：
 *
 * - [1] 纯模块语义：leading（静默期后第一个变更立刻放值）、trailing（窗口内的后续攒成
 *   一次）、**冻结**（两次放值之间 `getSnapshot()` 返回同一个引用）、退订即断（上游退订 +
 *   定时器清掉）、`ms ≤ 0` 直通；
 * - [2] App 真接线（同场对照）：起两个真 App，同一条流式节奏灌进去，数 **React 提交次数**。
 *   默认窗口（80ms）的那个提交次数应当被窗口夹住；`snapshotMs: 0`（直通）的那个几乎每次
 *   都提交。
 *
 * 被测对象是 `src/packages/tui/app/snapshot-subscribe.ts`，两段都在 tui 层（node + 假终端
 * + 直读 src），所以整条迁过来、探针可整删。没有留 `scripts/` 的残留：探针里唯一的 IO 是
 * `PassThrough` 假 stdout 与临时 HOME，这里照搬。
 *
 * ## 时序
 *
 * 纯模块段用真实定时器（20–80ms 窗口，与探针同量级）——`createCoalescedStore` 的语义就是
 * 「窗口内 vs 窗口外」，用假时钟会把定时器与 `now()` 两套时间源拆开，验不到真正的接线。
 * App 段的 30 次 2ms 节奏是**驱动输入**（模拟流式 delta），保留固定间隔。
 *
 * @module dsc/packages/tui/app/snapshot-subscribe.spec
 */
import { PassThrough } from 'node:stream'
import { Profiler, createElement } from 'react'
import { render } from 'ink'
import { afterEach, describe, expect, test } from 'vitest'
import type { DscRuntime, RuntimeSnapshot } from '@pneuma/runtime/contract.js'
import { createCoalescedStore, TUI_SNAPSHOT_MS } from './snapshot-subscribe.js'

/** 等一小段（真实定时器；窗口都是几十毫秒量级）。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 假上游：能主动通知，记录退订次数。 */
function makeUpstream(): {
  state: { notify: () => void; offCount: number }
  subscribe: (listener: () => void) => () => void
} {
  const state = { notify: (): void => {}, offCount: 0 }
  return {
    state,
    subscribe(listener: () => void) {
      state.notify = listener
      return () => {
        state.offCount += 1
      }
    },
  }
}

describe('① createCoalescedStore 语义：leading / trailing / 冻结 / 退订', () => {
  test('第一个变更走 leading；放值后引用冻结，冻结期间不再读上游', () => {
    const upstream = makeUpstream()
    let reads = 0
    let fired = 0
    const store = createCoalescedStore(() => `值${(reads += 1)}`, upstream.subscribe, { ms: 30 })
    const off = store.subscribe(() => {
      fired += 1
    })
    upstream.state.notify()
    expect(fired).toBe(1)
    const first = store.getSnapshot()
    expect(first).toBe('值1')
    expect(store.getSnapshot()).toBe(first)
    expect(reads).toBe(1)
    off()
  })

  test('窗口内的 20 次变更不当场放值，窗口末尾合并成一次 trailing', async () => {
    const upstream = makeUpstream()
    let reads = 0
    let fired = 0
    const store = createCoalescedStore(() => `值${(reads += 1)}`, upstream.subscribe, { ms: 30 })
    const off = store.subscribe(() => {
      fired += 1
    })
    upstream.state.notify()
    expect(fired).toBe(1)
    for (let i = 0; i < 20; i += 1) upstream.state.notify()
    expect(fired).toBe(1)
    expect(reads).toBe(1)
    expect(store.pending()).toBe(true)
    await sleep(80)
    expect(fired).toBe(2)
    expect(store.getSnapshot()).toBe('值2')
    expect(store.pending()).toBe(false)
    await sleep(80)
    expect(fired).toBe(2)
    // 静默期（30ms）已过：下一个变更又是 leading
    upstream.state.notify()
    expect(fired).toBe(3)
    off()
    upstream.state.notify()
    await sleep(50)
    expect(fired).toBe(3)
    expect(upstream.state.offCount).toBe(1)
  })

  test('ms=0 直通（不合并）：5 次通知放 5 次值', () => {
    const upstream = makeUpstream()
    let fired = 0
    const store = createCoalescedStore(() => 1, upstream.subscribe, { ms: 0 })
    store.subscribe(() => {
      fired += 1
    })
    for (let i = 0; i < 5; i += 1) upstream.state.notify()
    expect(fired).toBe(5)
  })

  test('退订把攒着的定时器也清掉（不往已卸载的 App 上 setState）', async () => {
    const upstream = makeUpstream()
    let fired = 0
    const store = createCoalescedStore(() => 1, upstream.subscribe, { ms: 40 })
    const off = store.subscribe(() => {
      fired += 1
    })
    upstream.state.notify()
    upstream.state.notify()
    off()
    await sleep(80)
    expect(fired).toBe(1)
  })
})

/** 会话条目底座：20 条正文，尾部增量可见。 */
const BASE_ENTRIES = Array.from({ length: 20 }, (_, i) => ({ kind: 'text', id: i + 1, text: `条目-${i + 1}` }))

/** App 读到的最小快照（只填渲染必须的字段）。 */
function makeSnapshot(entries: Array<{ kind: string; id: number; text: string }>): RuntimeSnapshot {
  return {
    entries,
    sessions: [],
    sessionsLoading: false,
    sessionStates: {},
    subagents: [],
    queued: [],
    notices: [],
    status: {
      turnState: 'idle',
      model: 'test-model',
      effort: 'medium',
      usage: null,
      contextWindow: 1_000_000,
      sessionId: '/w/s.jsonl',
      cwd: '/w',
    },
    surfaces: {
      pendingApproval: null,
      pendingQuestion: null,
      pendingPlan: null,
      goal: null,
      todos: { total: 0, done: 0, active: null },
      mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
      policy: { options: [{ id: 'default', label: '标准' }], current: 'default' },
    },
  } as unknown as RuntimeSnapshot
}

interface CoalesceHandle {
  commits: () => number
  notifies: () => number
  reset: () => void
  setEntries: (entries: Array<{ kind: string; id: number; text: string }>) => void
  notify: () => void
  tail: () => string
  unmount: () => void
}

/**
 * 起一个真 App（外面套 `React.Profiler` 数提交）：`snapshotMs` 省略 = 生产默认（80ms
 * 合并），0 = 直通对照。返回量提交次数、灌变更、读帧尾的口。
 */
async function mountApp(snapshotMs?: number): Promise<CoalesceHandle> {
  const { App } = await import('./App.js')
  const state = { snapshot: makeSnapshot(BASE_ENTRIES) }
  const counters = { notifies: 0, commits: 0 }
  const runtime: Record<string, unknown> & { __notify?: (() => void) | null } = {
    subscribe(listener: () => void) {
      const wrapped = (): void => {
        counters.notifies += 1
        listener()
      }
      runtime.__notify = wrapped
      return () => {
        if (runtime.__notify === wrapped) runtime.__notify = null
      }
    },
    getSnapshot: () => state.snapshot,
    listModels: () => [],
    listPresets: () => [],
    listSkills: () => [],
    listTeammates: () => [],
    getSettingsSections: () => [],
    getUiPrefs: () => ({ statusBar: undefined }),
    dock: () => Promise.resolve({ entries: [] }),
    submit() {},
    openSession() {},
    refreshSessions: () => Promise.resolve(),
    archiveSessions: () => Promise.resolve({ ok: true }),
    restoreSessions: () => Promise.resolve({ ok: true }),
    purgeSessions: () => Promise.resolve({ ok: true }),
    renameSession: () => Promise.resolve({ ok: true }),
    setSessionPinned: () => Promise.resolve({ ok: true }),
    forkSession: () => Promise.resolve({ ok: true }),
    usePreset: () => Promise.resolve({ ok: true }),
    setModel() {},
    interrupt() {},
    exit() {},
    answerApproval() {},
    answerQuestion() {},
    answerPlan() {},
  }
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = 110
  stdout.rows = 40
  stdout.isTTY = false
  let output = ''
  stdout.on('data', (chunk: Buffer) => {
    output += String(chunk)
  })
  const instance = render(
    createElement(
      Profiler,
      {
        id: 'app',
        onRender: () => {
          counters.commits += 1
        },
      },
      createElement(App as React.ComponentType<Record<string, unknown>>, {
        runtime: runtime as unknown as DscRuntime,
        ...(snapshotMs === undefined ? {} : { snapshotMs }),
      }),
    ),
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
  )
  // 首帧 + 值表异步装填都会提交；量提交次数之前先让它们落定。
  await sleep(250)
  return {
    commits: () => counters.commits,
    notifies: () => counters.notifies,
    reset: () => {
      counters.commits = 0
      counters.notifies = 0
    },
    setEntries: (entries) => {
      state.snapshot = makeSnapshot(entries)
    },
    notify: () => runtime.__notify?.(),
    tail: () => {
      const idx = output.lastIndexOf('\x1b[2K')
      return (idx >= 0 ? output.slice(idx) : output).replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
    },
    unmount: () => instance.unmount(),
  }
}

describe('② App 真接线：合并组被窗口夹住，直通组几乎每次都提交', () => {
  const mounted: CoalesceHandle[] = []
  afterEach(() => {
    for (const handle of mounted.splice(0)) handle.unmount()
  })

  test('同一条流式节奏下，合并组提交次数比直通组少一个数量级，尾巴不丢内容', async () => {
    const merged = await mountApp(undefined)
    const raw = await mountApp(0)
    mounted.push(merged, raw)
    expect(merged.tail()).toContain('条目-20')
    expect(raw.tail()).toContain('条目-20')
    merged.reset()
    raw.reset()

    // 同一条节奏：每 ~2ms 一次（Node 在 Windows 上的计时器粒度就这个量级），共 30 次。
    const BURST = 30
    const started = Date.now()
    for (let i = 0; i < BURST; i += 1) {
      const entries = [...BASE_ENTRIES, { kind: 'text', id: 100 + i, text: `增量-${i}` }]
      merged.setEntries(entries)
      raw.setEntries(entries)
      merged.notify()
      raw.notify()
      await sleep(2)
    }
    const elapsed = Date.now() - started
    await sleep(200)

    const mergedCommits = merged.commits()
    const rawCommits = raw.commits()
    const windowCap = Math.ceil(elapsed / TUI_SNAPSHOT_MS) + 1
    expect(rawCommits).toBeGreaterThanOrEqual(raw.notifies() - 2)
    expect(mergedCommits).toBeLessThanOrEqual(windowCap)
    expect(mergedCommits * 3).toBeLessThan(rawCommits)
    expect(merged.tail()).toContain('增量-29')
  })
})
