/**
 * git 包级测试：插件对象、三档轮询节奏、空读数、服务/快照面接线、改动口径与两处催拍。
 *
 * ## 迁移说明（F 批）
 *
 * 旧文件是自造 `check()`，6 条里 5 条共 13 处 `assert.match(source, /.../)` 在读 `index.ts`
 * 的源码文本（三档常量、`EMPTY_GIT` 字面量、service 形状与两条注册、去重口径、两处催拍）。
 * 现在一条源码正则都不留，全部换成「假 ctx 真跑 apply + 真仓库真跑 git」：
 *   - 三档节奏：分别建「有改动 / 干净 / 不是仓库」三个临时仓库，真读一拍，再看下一次
 *     `setTimeout` 的延时是不是 12_000 / 30_000 / 60_000；
 *   - 空读数：在不是仓库的空目录里读一拍，`snapshot()` 必须正好是
 *     `{ repo: false, branch: '', detached: false, dirtyFileCount: 0 }`；
 *   - 服务与快照面：从 `ctx.provide` / `ctx.surfaces.register` 捕获得来的真实对象上取，
 *     `snapshot` / `refresh` 两个键多一个少一个都会红；
 *   - 改动口径：仓库根放一个改动、工作目录内放一个改动，读数只数后者（1 而不是 2）；
 *     空仓库（没有提交）的分支兜底是「(无提交)」，`checkout --detach` 之后
 *     `detached=true` 且分支是短哈希；
 *   - 两处催拍：`dsc/turn-end` 一定催拍；`dsc/session-open` 只有工作目录真的变了才催拍
 *     （同一个工作区里换会话不重拉三个 git 子进程）。
 *
 * 改引号、改缩进、把常量挪个位置都不会再假红；把 12s 改成别的、把去重口径去掉、
 * 把 `dsc/turn-end` 的监听摘掉都会真红。
 *
 * 计时观察：插件的 `schedule()` 最终都落成一次 `setTimeout`。这里给 `setTimeout` 挂一个
 * 只记录延时的 spy（仍然委托给真正的定时器），读一拍结束后看记录里有没有那一档的延时；
 * 用例结束统一清掉还没触发的定时器，避免跨用例互相催拍。
 *
 * @module @pneuma/git/tests
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitSurface } from '@pneuma/runtime/contract.js'
import type { GitService } from '@pneuma/runtime/services/types.js'
import { afterAll, afterEach, expect, test, vi } from 'vitest'
import { gitPlugin } from '../index.js'

/** spy 建立之前抓到的真定时器：轮询等待与「真的等」都走它，绕开自己的 spy。 */
const realSetTimeout = globalThis.setTimeout

/** 每个用例建的临时仓库根，收尾统一删。 */
const roots: string[] = []
/** 本用例里插件排下的定时器：用例结束统一清掉。 */
let liveTimers = new Set<ReturnType<typeof setTimeout>>()
/** 本用例里记录到的全部 `setTimeout` 延时（毫秒）。 */
let delays: number[] = []

/** 主机上必须真有 git：这套用例的存在前提。 */
function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 建一个临时目录并登记收尾。 */
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** 建一个已 init 的空仓库。 */
function emptyRepo(prefix: string): string {
  const root = tempRoot(prefix)
  gitIn(root, ['init', '-q'])
  return root
}

/** 建一个有提交（因此工作区干净）的仓库。 */
function cleanRepo(prefix: string): string {
  const root = tempRoot(prefix)
  gitIn(root, ['init', '-q'])
  gitIn(root, ['-c', 'user.name=git-spec', '-c', 'user.email=git-spec@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
  return root
}

/** 假 ctx 捕获得来的注册面。 */
interface Harness {
  ctx: Record<string, unknown>
  provided: Map<string, unknown>
  readers: Map<string, () => GitSurface>
  handlers: Map<string, (payload: never) => void>
  emitted: string[]
}

/**
 * 用假 ctx 真跑一遍 `apply()`。
 *
 * 假 ctx 只实现 git 插件碰到的那几个成员：`session.current()`、`provide`、`effect`、
 * `on`、`emit`、`surfaces.register`。`effect` 立即执行并返回注册给的清理函数——与 cordis
 * 的 effect 语义一致，插件里 `ctx.effect(() => ctx.surfaces.register(...))` 那一句才真的
 * 把 reader 登记进来。
 */
function createHarness(cwd: string): Harness {
  const provided = new Map<string, unknown>()
  const readers = new Map<string, () => GitSurface>()
  const handlers = new Map<string, (payload: never) => void>()
  const emitted: string[] = []
  const ctx: Record<string, unknown> = {
    session: { current: () => ({ meta: { cwd } }), refresh: () => Promise.resolve() },
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      return () => {}
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    on: (name: string, handler: (payload: never) => void) => {
      handlers.set(name, handler)
      return () => {}
    },
    emit: (name: string) => {
      emitted.push(name)
    },
    surfaces: {
      register: (name: string, reader: () => GitSurface) => {
        readers.set(name, reader)
        return () => {}
      },
    },
  }
  ;(gitPlugin.apply as unknown as (c: unknown) => void)(ctx)
  return { ctx, provided, readers, handlers, emitted }
}

/** 取一个确定存在的值；缺了直接抛，别让断言落在 undefined 上变成假绿。 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`没拿到${what}`)
  return value
}

/** 开始记录 `setTimeout`：仍然真的排定时器，只把延时抄一份。 */
function watchTimers(): void {
  delays = []
  liveTimers = new Set()
  const spy = vi.spyOn(globalThis, 'setTimeout')
  // 真定时器的签名是重载的，这里显式收窄成一个「回调 + 延时 + 任意参数」的形状，
  // 否则展开 `rest` 会触发 TS2556（实参必须是有元组类型的展开或落到 rest 形参上）。
  const schedule = realSetTimeout as unknown as (
    callback: () => void,
    ms?: number,
    ...args: unknown[]
  ) => ReturnType<typeof setTimeout>
  spy.mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(Number(ms ?? 0))
    const handle = schedule(fn, ms, ...rest)
    liveTimers.add(handle)
    return handle
  }) as never)
}

/** 停止记录并清掉本用例排下、还没触发的定时器。 */
function stopTimers(): void {
  vi.restoreAllMocks()
  for (const handle of liveTimers) clearTimeout(handle)
  liveTimers.clear()
}

/** 真等（走真定时器，绕开自己的 spy），直到条件成立。 */
async function until(done: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`等不到${what}`)
    await new Promise((resolve) => realSetTimeout(resolve, 20))
  }
}

/**
 * 让这一片被读一次：`surfaces.register` 的 reader 第一次被读时按需补一拍（`schedule(0)`），
 * 那一拍落成 0ms 定时器；这里等它真的读完（读完的标志是下一档定时器已经排上）。
 */
async function readOnce(harness: Harness, expectedDelay: number): Promise<void> {
  const reader = must(harness.readers.get('git'), '注册到 surfaces 的 git 快照面')
  watchTimers()
  reader()
  await until(() => delays.includes(expectedDelay), `下一次轮询排到 ${String(expectedDelay)}ms`)
}

afterEach(() => {
  stopTimers()
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('插件对象：名字、提供服务、两个注入', () => {
  expect(gitPlugin.name).toBe('git')
  expect(gitPlugin.provide).toBe('git')
  // 不展开再比：`inject` 的类型是 cordis 的 `Inject<Dict>`，声明上没有 iterator，
  // `[...x]` 过不了类型检查。运行时它就是数组，直接整体比对即可。
  expect(gitPlugin.inject).toEqual(['session', 'surfaces'])
  expect(typeof gitPlugin.apply).toBe('function')
})

test('有改动的仓库：读完一拍，下一次轮询排在 12s 后', async () => {
  const root = emptyRepo('dsc-git-spec-dirty-')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  const harness = createHarness(root)
  await readOnce(harness, 12_000)
  const service = must(harness.provided.get('git') as GitService | undefined, 'ctx.provide 的 git 服务')
  expect(service.snapshot()).toEqual({ repo: true, branch: '(无提交)', detached: false, dirtyFileCount: 1 })
}, 60_000)

test('干净的仓库：读完一拍，下一次轮询排在 30s 后', async () => {
  const root = cleanRepo('dsc-git-spec-clean-')
  const harness = createHarness(root)
  await readOnce(harness, 30_000)
  const service = must(harness.provided.get('git') as GitService | undefined, 'ctx.provide 的 git 服务')
  expect(service.snapshot()).toEqual({ repo: true, branch: expect.any(String), detached: false, dirtyFileCount: 0 })
}, 60_000)

test('不是仓库：读完一拍，下一次轮询排在 60s 后', async () => {
  const dir = tempRoot('dsc-git-spec-norepo-')
  const harness = createHarness(dir)
  await readOnce(harness, 60_000)
  const service = must(harness.provided.get('git') as GitService | undefined, 'ctx.provide 的 git 服务')
  expect(service.snapshot().repo).toBe(false)
}, 60_000)

test('空读数形状：repo=false、分支空、非 detached、0 个改动', async () => {
  const dir = tempRoot('dsc-git-spec-empty-')
  const harness = createHarness(dir)
  await readOnce(harness, 60_000)
  const service = must(harness.provided.get('git') as GitService | undefined, 'ctx.provide 的 git 服务')
  expect(service.snapshot()).toEqual({ repo: false, branch: '', detached: false, dirtyFileCount: 0 })
  // 读数与初值相同：不该白推一帧 dsc/changed。
  expect(harness.emitted).toEqual([])
}, 60_000)

test('服务只有 snapshot / refresh，并注册 git 这一片快照', () => {
  const harness = createHarness(tempRoot('dsc-git-spec-service-'))
  const service = must(harness.provided.get('git') as GitService | undefined, 'ctx.provide 的 git 服务')
  expect(Object.keys(service).sort()).toEqual(['refresh', 'snapshot'])
  expect(typeof service.snapshot).toBe('function')
  expect(typeof service.refresh).toBe('function')
  // 还没读过任何一拍：快照面给的是空读数。
  expect(service.snapshot()).toEqual({ repo: false, branch: '', detached: false, dirtyFileCount: 0 })
  const reader = must(harness.readers.get('git'), '注册到 surfaces 的 git 快照面')
  expect(reader()).toBe(service.snapshot())
})

test('读数只数工作目录内的改动，空仓库的分支兜底是「(无提交)」', async () => {
  const root = emptyRepo('dsc-git-spec-scope-')
  const workdir = join(root, 'work')
  mkdirSync(workdir)
  writeFileSync(join(root, 'outside.txt'), 'x\n')
  writeFileSync(join(workdir, 'inside.txt'), 'y\n')
  const harness = createHarness(workdir)
  await readOnce(harness, 12_000)
  const service = must(harness.provided.get('git') as GitService | undefined, 'ctx.provide 的 git 服务')
  const surface = service.snapshot()
  expect(surface.repo, 'work 子目录在仓库里，应当认成仓库').toBe(true)
  // 仓库根那个改动不数：界面上的「变更」只列工作目录内的条目。
  expect(surface.dirtyFileCount).toBe(1)
  expect(surface.detached).toBe(false)
  expect(surface.branch).toBe('(无提交)')
  // 读数变了（空 → 有仓库）：推一帧。
  expect(harness.emitted).toContain('dsc/changed')
}, 60_000)

test('detached HEAD：detached=true，分支兜底成短哈希', async () => {
  const root = cleanRepo('dsc-git-spec-detached-')
  gitIn(root, ['checkout', '-q', '--detach'])
  const shortHash = gitIn(root, ['rev-parse', '--short', 'HEAD']).trim()
  const harness = createHarness(root)
  const reader = must(harness.readers.get('git'), '注册到 surfaces 的 git 快照面')
  watchTimers()
  reader()
  await until(() => harness.emitted.includes('dsc/changed'), '第一拍读完并推帧')
  const service = must(harness.provided.get('git') as GitService | undefined, 'ctx.provide 的 git 服务')
  const surface = service.snapshot()
  expect(surface.repo).toBe(true)
  expect(surface.detached).toBe(true)
  expect(surface.branch).toMatch(/^[0-9a-f]{7,40}$/)
  expect(surface.branch).toBe(shortHash)
}, 60_000)

test('回合收工一定催拍：dsc/turn-end 立刻排一拍', async () => {
  const root = cleanRepo('dsc-git-spec-turn-end-')
  const harness = createHarness(root)
  await readOnce(harness, 30_000)
  const handler = must(harness.handlers.get('dsc/turn-end'), "dsc/turn-end 监听")
  const before = delays.length
  ;(handler as unknown as (reason: string) => void)('completed')
  expect(delays.slice(before), '回合收工应当立刻补一拍').toContain(0)
}, 60_000)

test('换会话只在工作目录真的变了才催拍：同目录不重拉，换目录补一拍', async () => {
  const root = cleanRepo('dsc-git-spec-session-')
  const other = cleanRepo('dsc-git-spec-session-other-')
  const harness = createHarness(root)
  await readOnce(harness, 30_000)
  const handler = must(harness.handlers.get('dsc/session-open'), 'dsc/session-open 监听')

  const beforeSame = delays.length
  ;(handler as unknown as (payload: { session: { meta: { cwd: string } } }) => void)({ session: { meta: { cwd: root } } })
  expect(delays.slice(beforeSame), '同一个工作区里换会话不该重拍').toEqual([])

  const beforeOther = delays.length
  ;(handler as unknown as (payload: { session: { meta: { cwd: string } } }) => void)({ session: { meta: { cwd: other } } })
  expect(delays.slice(beforeOther), '换到别的工作区应当立刻补一拍').toContain(0)
}, 60_000)
