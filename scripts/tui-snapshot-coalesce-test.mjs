/**
 * TUI 快照合并存储（`src/app/snapshot-subscribe.ts`）的两层测试：
 *
 * [1] 纯模块语义：leading（静默期后第一个变更立刻放值）、trailing（窗口内的后续攒成一次）、
 *     **冻结**（两次放值之间 `getSnapshot()` 返回同一个引用——React 的复读不会再多提交一帧）、
 *     退订即断（上游退订 + 定时器清掉）、ms≤0 直通。
 * [2] App 真接线（同场对照）：起两个真 App，同一条流式节奏灌进去，数 **React 提交次数**。
 *     默认窗口（80ms）的那个提交次数应当被「窗口」夹住；`snapshotMs: 0`（直通）的那个
 *     几乎每次都提交。没有合并时就是后者——每个 delta 一次全树 reconcile，也就是
 *     「开子代理就卡」那张账单里最大的一笔。
 *
 * 全部跑在临时 HOME / DSC_HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm build && node scripts/tui-snapshot-coalesce-test.mjs
 *
 * @module dsc/scripts/tui-snapshot-coalesce-test
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

const home = mkdtempSync(join(tmpdir(), 'dsc-coalesce-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

const { createCoalescedStore, TUI_SNAPSHOT_MS } = await import('../lib/app/snapshot-subscribe.js')
const { App } = await import('../lib/app/App.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('TUI 快照合并测试（性能批）')

// ── [1] 纯模块语义 ──────────────────────────────────────────────────────────
console.log('\n[1] createCoalescedStore 语义')

const makeUpstream = () => {
  const state = { notify: () => {}, offCount: 0 }
  return {
    state,
    subscribe(listener) {
      state.notify = listener
      return () => {
        state.offCount += 1
      }
    },
  }
}

{
  const upstream = makeUpstream()
  let reads = 0
  let fired = 0
  const store = createCoalescedStore(() => `值${(reads += 1)}`, upstream.subscribe, { ms: 30 })
  const off = store.subscribe(() => {
    fired += 1
  })
  upstream.state.notify()
  check('第一个变更走 leading（不等窗口）', fired === 1, `fired=${fired}`)
  const first = store.getSnapshot()
  check('放值后读到的是新值', first === '值1', first)
  check('两次读之间引用冻结（React 复读不再提交）', store.getSnapshot() === first, `${first} vs ${store.getSnapshot()}`)
  check('冻结期间不再读上游', reads === 1, `reads=${reads}`)

  for (let i = 0; i < 20; i += 1) upstream.state.notify()
  check('窗口内的 20 次变更不当场放值', fired === 1 && reads === 1, `fired=${fired} reads=${reads}`)
  check('窗口内变更记在 pending', store.pending() === true)
  await sleep(45)
  check('窗口末尾合并成一次 trailing', fired === 2, `fired=${fired}`)
  check('trailing 后读到的是最后那次的值', store.getSnapshot() === '值2', store.getSnapshot())
  check('trailing 之后 pending 清掉', store.pending() === false)
  await sleep(45)
  check('没有新变更就不再多放值', fired === 2, `fired=${fired}`)
  // 静默期（30ms）已过：下一个变更又是 leading
  upstream.state.notify()
  check('静默期过后重新 leading', fired === 3, `fired=${fired}`)
  off()
  upstream.state.notify()
  await sleep(45)
  check('退订后上游断开（不再放值）', fired === 3, `fired=${fired}`)
  check('退订会退上游', upstream.state.offCount === 1, `off=${upstream.state.offCount}`)
}

{
  const upstream = makeUpstream()
  let fired = 0
  const store = createCoalescedStore(() => 1, upstream.subscribe, { ms: 0 })
  store.subscribe(() => {
    fired += 1
  })
  for (let i = 0; i < 5; i += 1) upstream.state.notify()
  check('ms=0 直通（不合并）', fired === 5, `fired=${fired}`)
}

{
  // 退订时攒着的尾巴不许漏出去（否则会往已卸载的 App 上 setState）
  const upstream = makeUpstream()
  let fired = 0
  const store = createCoalescedStore(() => 1, upstream.subscribe, { ms: 40 })
  const off = store.subscribe(() => {
    fired += 1
  })
  upstream.state.notify()
  upstream.state.notify()
  off()
  await sleep(60)
  check('退订把攒着的定时器也清掉', fired === 1, `fired=${fired}`)
}

// ── [2] App 真接线（同场对照：80ms 合并 vs 直通） ────────────────────────────
console.log('\n[2] App 接线（真渲染，同场对照）')

const BASE_ENTRIES = Array.from({ length: 20 }, (_, i) => ({ kind: 'text', id: i + 1, text: `条目-${i + 1}` }))

/**
 * 起一个 App：`snapshotMs` 省略 = 生产默认（80ms 合并），0 = 直通对照。
 * 返回量提交次数、灌变更、读帧尾的口。
 */
async function mountApp(snapshotMs) {
  const state = { snapshot: makeSnapshot(BASE_ENTRIES) }
  const counters = { notifies: 0, commits: 0 }
  const runtime = {
    subscribe(listener) {
      const wrapped = () => {
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
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  const stdout = new PassThrough()
  stdout.columns = 110
  stdout.rows = 40
  stdout.isTTY = false
  let output = ''
  stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  render(
    React.createElement(
      React.Profiler,
      {
        id: 'app',
        onRender: () => {
          counters.commits += 1
        },
      },
      React.createElement(App, { runtime, ...(snapshotMs === undefined ? {} : { snapshotMs }) }),
    ),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
  )
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
    notify: () => runtime.__notify(),
    tail: () => {
      const idx = output.lastIndexOf('\x1b[2K')
      return (idx >= 0 ? output.slice(idx) : output).replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
    },
  }
}

function makeSnapshot(entries) {
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
  }
}

const merged = await mountApp(undefined)
const raw = await mountApp(0)
await sleep(250)
check('两个 App 都起来了', merged.tail().includes('条目-20') && raw.tail().includes('条目-20'), merged.tail().slice(0, 60))
merged.reset()
raw.reset()

// 同一条节奏：每 ~15ms 一次（Node 在 Windows 上的计时器粒度就这个量级），共 30 次
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
check(
  `对照组（直通）几乎每次都提交：${rawCommits}/${raw.notifies()}`,
  rawCommits >= raw.notifies() - 2,
  `commits=${rawCommits} notifies=${raw.notifies()}`,
)
check(
  `合并组提交次数被窗口夹住：${mergedCommits} ≤ ${windowCap}（${elapsed}ms / ${TUI_SNAPSHOT_MS}ms）`,
  mergedCommits <= windowCap,
  `commits=${mergedCommits} cap=${windowCap} notifies=${merged.notifies()}`,
)
check(
  `合并比直通少一个数量级：${mergedCommits} vs ${rawCommits}`,
  mergedCommits * 3 < rawCommits,
  `${mergedCommits} vs ${rawCommits}`,
)
check('尾部合并没丢内容（最后一条增量可见）', merged.tail().includes('增量-29'), merged.tail().slice(-120))

process.exit(failures === 0 ? 0 : 1)
