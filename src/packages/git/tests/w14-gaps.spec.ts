/**
 * git 插件轮询节奏的长尾补盲（w14）：`tick` 的三条早退分支——上一拍还没跑完
 * （记 pendingRefresh，收尾后立刻补拍）、最近没人读过这一片（只排便宜巡检）、
 * 以及取当前工作目录时会话上下文已经收摊（安静收尾）。
 *
 * `git` 子进程用模块替身控制时序：第一拍卡在一个可手动放行的 promise 上，
 * 这样才能稳定制造「一拍在跑时又有人催拍」。定时器用假时钟，`repoPrefix` 等
 * 其余导出原样交给真实实现。临时目录都是 mkdtemp，收尾清理。
 *
 * @module dsc/packages/git/tests/w14-gaps.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitSurface } from '@pneuma/runtime/contract.js'
import type { GitService } from '@pneuma/runtime/services/types.js'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: 0,
  deferNext: false,
  release: undefined as (() => void) | undefined,
}))

vi.mock('@pneuma/runtime/core/git-exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/git-exec.js')>()
  const git = async (cwd: string, args: string[], timeoutMs?: number): Promise<string> => {
    state.calls += 1
    if (state.deferNext) {
      state.deferNext = false
      await new Promise<void>((resolve) => {
        state.release = resolve
      })
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n'
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') return '.git'
    if (args[0] === 'status') return ''
    return actual.git(cwd, args, timeoutMs)
  }
  return { ...actual, git, repoPrefix: async () => '' }
})

let gitPlugin: (typeof import('../index.js'))['gitPlugin']

const roots: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

interface Harness {
  service: GitService
  ctx: Record<string, unknown>
  readers: Map<string, () => GitSurface>
}

/** 假 ctx 真跑 apply：只实现插件碰到的成员。 */
function mount(cwd: string): Harness {
  const provided = new Map<string, unknown>()
  const readers = new Map<string, () => GitSurface>()
  const handlers = new Map<string, (payload: never) => void>()
  const session = { current: () => ({ meta: { cwd } }) }
  const ctx: Record<string, unknown> = {
    session,
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      return () => undefined
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
    on: (name: string, handler: (payload: never) => void) => {
      handlers.set(name, handler)
      return () => undefined
    },
    emit: () => undefined,
    surfaces: {
      register: (name: string, reader: () => GitSurface) => {
        readers.set(name, reader)
        return () => undefined
      },
    },
  }
  gitPlugin.apply?.(ctx as never, undefined)
  return { service: provided.get('git') as GitService, ctx, readers }
}

afterEach(() => {
  vi.useRealTimers()
  state.calls = 0
  state.deferNext = false
  state.release = undefined
})

afterAll(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 句柄：留给系统清
    }
  }
})

beforeAll(async () => {
  gitPlugin = (await import('../index.js')).gitPlugin
})

test('上一拍还在跑时再催拍：记 pendingRefresh，收尾后立刻补一拍', async () => {
  vi.useFakeTimers()
  const harness = mount(tempDir('dsc-git-w14-busy-'))
  // 先读一次快照：lastReadAt 变成「刚刚」，tick 才不会被「没人看」那一档拦住。
  harness.readers.get('git')!()
  state.deferNext = true
  harness.service.refresh()
  await vi.advanceTimersByTimeAsync(0)
  expect(state.calls).toBe(1)

  // 第二拍落在第一拍还在跑的时候：只标记、不并发起读。
  harness.service.refresh()
  await vi.advanceTimersByTimeAsync(0)
  expect(state.calls).toBe(1)

  // 放行第一拍；收尾时看到 pendingRefresh 立刻补拍，于是 git 又被调用一轮（3 次）。
  const callsAfterFirst = state.calls
  state.release!()
  for (let index = 0; index < 6; index += 1) await vi.advanceTimersByTimeAsync(0)
  expect(state.calls).toBeGreaterThanOrEqual(callsAfterFirst + 3)
})

test('最近没人读过这一片：只排 5 秒巡检，不跑 git', async () => {
  vi.useFakeTimers()
  const harness = mount(tempDir('dsc-git-w14-idle-'))
  harness.service.refresh()
  await vi.advanceTimersByTimeAsync(0)
  expect(state.calls).toBe(0)
  // 排下的是下一次巡检（5s），不是一次读。
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(state.calls).toBe(0)
})

test('取工作目录时会话上下文已收摊：这一拍安静收尾，不读 git、不再排拍', async () => {
  vi.useFakeTimers()
  const harness = mount(tempDir('dsc-git-w14-gone-'))
  // 先让这一片「刚被读过」，否则 tick 会先走「没人看」那一档，到不了取 cwd 这一步。
  harness.readers.get('git')!()
  harness.ctx['session'] = {
    current: () => {
      throw new Error('cannot get required service "session" in inactive context')
    },
  }
  harness.service.refresh()
  await vi.advanceTimersByTimeAsync(1)
  expect(state.calls).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(harness.service.snapshot()).toEqual({ repo: false, branch: '', detached: false, dirtyFileCount: 0 })
})
