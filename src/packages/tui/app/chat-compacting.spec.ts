/**
 * 压缩活动行（迁自 `scripts/tui-compacting-test.mjs`）：`compact` 跑着的时候终端里要看得见。
 *
 * 为什么单开一份：桌面/网页壳那条活动行有快照字段与源码钉，终端这边是另一套渲染
 * （ink 的行几何），只能真渲染一帧再断言文字在不在——顺带钉住「不在压缩时这一行不出现」，
 * 免得它变成常驻噪音。
 *
 * ## 旧探针第三条（源码钉）的去向
 *
 * 旧探针读 `App.tsx` 源码断言 `compactingSince={snapshot.status.compactingSince}`——按迁移
 * 手册第 2 节属必删项（改一行等价写法就假红，把传递链真改坏却可能照样绿）。这里换成
 * **行为断言**：真 App + 假 runtime，快照里设上 `status.compactingSince` 看帧里出现压缩行，
 * 清掉再看它消失——传递链真的断了（App 不再把字段递给 ChatView）这两条必红。
 *
 * ## 帧的等待方式
 *
 * 探针固定 sleep 160ms；这里改成 composer.spec 同款「最少等 150ms，且输出长度连续几拍
 * 不再变」：慢机器上不会读到半帧，快机器上不比原来慢。压缩行带盲文 spinner（每帧轮转），
 * 遇上「永远等不到稳定」就等满上限——spinner 字形与文案在前几百毫秒早已写出。
 *
 * ## 隔离
 *
 * App 链路那组会经 `history-store` 读 `~/.dsc/.tui-history`，所以 `tempHome()` + `DSC_HOME`
 * 必须在 App 被加载之前换好，App 一律动态 import（`ChatView` 不碰盘，静态 import）。
 * 真实 `~/.dsc` 一个字节都不动。
 *
 * 归 `tui` project（`src/packages/tui/**` + node + 假 stdin/stdout，直读 src，不走 lib）。
 *
 * @module dsc/packages/tui/app/chat-compacting.spec
 */
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { createElement } from 'react'
import { render } from 'ink'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { StatusView, TranscriptEntry } from '@pneuma/runtime/contract.js'
import { tempHome } from '../../../../tests/harness.js'
import { ChatView } from './ChatView.js'

/** 临时主目录：App 链路那组的 `.tui-history` 落在它下面（真实 `~/.dsc` 不动）。 */
const home = tempHome('dsc-chat-compacting-')
const originalDscHome = process.env.DSC_HOME
process.env.DSC_HOME = join(home.home, '.dsc')

/** 会话条目底座：一条用户消息 + 一条正文，让 ChatView 有东西可画。 */
const ENTRIES: TranscriptEntry[] = [
  { id: 1, kind: 'user', text: '帮我压缩一下' },
  { id: 2, kind: 'text', text: '好' },
]

/** ChatView 的直渲底座（旧探针的 props 原样）。 */
const CHAT_PROPS = {
  entries: ENTRIES,
  turnState: 'idle' as const,
  expandThinking: false,
  empty: false,
  maxWidth: 80,
  columns: 100,
}

/**
 * 渲一帧（每次一个全新的假终端，渲完即卸）：返回这期间写进 stdout 的全部文本。
 * 探针同款——ink 的 lastFrame 在 v6 里没有了，只能从流里收。
 */
async function frame(extra: Record<string, unknown> = {}, columns = 100): Promise<string> {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = columns
  stdout.rows = 40
  stdout.isTTY = false
  let out = ''
  stdout.on('data', (chunk: Buffer) => {
    out += String(chunk)
  })
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
  const view = render(
    createElement(ChatView, { ...CHAT_PROPS, ...extra } as React.ComponentProps<typeof ChatView>),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await settle(() => out)
  view.unmount()
  return out
}

/** 等这一帧写完：最少 150ms，且输出长度连续几拍不再变（composer.spec 同款）。 */
async function settle(read: () => string, floorMs = 150, deadlineMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  let previous = -1
  let stable = 0
  while (Date.now() < startedAt + deadlineMs) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
    const length = read().length
    if (length === previous) stable += 1
    else {
      stable = 0
      previous = length
    }
    if (Date.now() - startedAt >= floorMs && stable >= 2) return
  }
}

// ── [1] 压缩中 ───────────────────────────────────────────────────────────────

describe('压缩中：底部有 spinner 行与已用时', () => {
  let out = ''
  beforeAll(async () => {
    out = await frame({ compactingSince: Date.now() - 3_000 })
  })

  test('画了「压缩上下文中」', () => {
    expect(out.includes('压缩上下文中'), out.slice(-300)).toBe(true)
  })

  test('带了说明与已用时', () => {
    expect(out.includes('把更早的历史折成摘要') && /已用 \d+s/.test(out), out.slice(-300)).toBe(true)
  })

  test('有盲文 spinner 字形', () => {
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(out)).toBe(true)
  })
})

// ── [2] 没在压缩 ─────────────────────────────────────────────────────────────

describe('没在压缩：这一行不出现', () => {
  test('没有压缩行', async () => {
    expect(await frame({})).not.toContain('压缩上下文中')
  })
})

// ── [3] App 链路（替代旧探针的源码钉）─────────────────────────────────────────

describe('App 把 snapshot.status.compactingSince 递给会话视图（行为断言）', () => {
  /** App 的 runtime 最小集（与 `scripts/tui-features-test.mjs` 同款，收发全走假对象）。 */
  function makeRuntime(overrides: Record<string, unknown> = {}): Record<string, unknown> & {
    setSnapshot(next: Record<string, unknown>): void
    subscribe(cb: () => void): () => void
    getSnapshot(): Record<string, unknown>
  } {
    const listeners = new Set<() => void>()
    let snapshot: Record<string, unknown> = {}
    return {
      subscribe(cb: () => void) {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      getSnapshot: () => snapshot,
      setSnapshot(next: Record<string, unknown>) {
        snapshot = next
        for (const listener of [...listeners]) listener()
      },
      listModels: () => [],
      dock: () => Promise.resolve({ entries: [] }),
      submit() {},
      openSession() {},
      refreshSessions: () => Promise.resolve(),
      listArchivedSessions: () => Promise.resolve({ items: [] }),
      renameSession: () => Promise.resolve({ ok: true }),
      setSessionPinned: () => Promise.resolve({ ok: true }),
      archiveSessions: () => Promise.resolve({ ok: true }),
      restoreSessions: () => Promise.resolve({ ok: true }),
      purgeSessions: () => Promise.resolve({ ok: true }),
      forkSession: () => Promise.resolve({ ok: true }),
      listUserMessages: () => Promise.resolve([]),
      listTeammates: () => [],
      peekTranscript: () => Promise.resolve([]),
      setModel() {},
      interrupt() {},
      exit() {},
      answerApproval() {},
      answerQuestion() {},
      answerPlan() {},
      ...overrides,
    }
  }

  /** 带压缩时刻的最小快照（StatusView 只列 App/ChatView 要读的字段）。 */
  function makeStatus(compactingSince?: number): StatusView {
    return {
      turnState: 'idle',
      model: 'test-model',
      effort: 'medium',
      usage: null,
      contextWindow: 1_000_000,
      sessionId: '/w/s.jsonl',
      cwd: '/w',
      ...(compactingSince === undefined ? {} : { compactingSince }),
    } as unknown as StatusView
  }

  /** 假终端 + 已渲好的 App：与 features/scroll 探针同构，帧从流里收。 */
  async function mountApp(status: StatusView) {
    const { App } = await import('./App.js')
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
    const runtime = makeRuntime()
    runtime.setSnapshot({
      entries: ENTRIES,
      sessions: [],
      sessionsLoading: false,
      sessionStates: {},
      status,
      surfaces: {
        pendingApproval: null,
        pendingQuestion: null,
        pendingPlan: null,
        goal: null,
        todos: { total: 0, done: 0, active: null },
        mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
        policy: { options: [{ id: 'default', label: '标准' }], current: 'default' },
      },
    })
    const instance = render(createElement(App, { runtime } as never), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await settle(() => output)
    return {
      frame: () => {
        const at = output.lastIndexOf('\x1b[2K')
        return at < 0 ? output : output.slice(at)
      },
      unmount: () => instance.unmount(),
    }
  }

  test('快照带上压缩时刻：帧里出现压缩活动行', async () => {
    const app = await mountApp(makeStatus(Date.now() - 3_000))
    try {
      expect(app.frame().includes('压缩上下文中'), app.frame().slice(-300)).toBe(true)
    } finally {
      app.unmount()
    }
  })

  test('快照不带压缩时刻：帧里没有这一行（不是常驻噪音）', async () => {
    const app = await mountApp(makeStatus())
    try {
      expect(app.frame()).not.toContain('压缩上下文中')
    } finally {
      app.unmount()
    }
  })
})

afterAll(() => {
  if (originalDscHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalDscHome
  home.restore()
})
