/**
 * 「最近使用 = 会话最后一步的时间」的集成用例（迁自 `scripts/session-activity-time-test.mjs`）。
 *
 * 2026-11-03 的报障是「点一下会话，时间就变刚刚」。这条规则有六个面，每个面都单列一条用例：
 *   ① 侧栏那列时间取最后一条带 `ts` 的对话记录，不取文件 mtime——文件被写过不代表
 *      用户做了什么；
 *   ② 打开老会话补权限默认值（`permissionOf`）不再追加日志、不再刷新 mtime；
 *   ③ 补钉值在同一进程里立刻可读（不能为了不写盘就把值丢掉）；
 *   ④ 下一次真正写日志时，补钉值跟着落盘，重放之后还是同一份；
 *   ⑤ 老日志（没有 `ts` 字段）回落到 mtime，至少排序不乱；
 *   ⑥ 只有 meta 与记账、没有对话的文件仍然不进列表。
 *
 * ## 为什么这里要真起内核
 *
 * `listSessions()` 的口径是「读一个真 jsonl」。离线拼字符串也能测，但那样测不到
 * 「真内核写出来的记录长什么样」——ts 是谁盖的、state 记在哪一行、落盘是不是异步的，
 * 全都由内核决定。最后一条用例跑一个真回合，拿它自己的日志验同一套口径。
 *
 * ## 隔离
 *
 * `tempHome()` 在模块顶层调用：`core/path-policy.ts` 的 `DSC_HOME` 是模块级常量，
 * 一旦先被 import 就算定了。所以内核模块一律用 `await import()`，等 HOME 换完再加载。
 *
 * @module dsc/core/session/activity-time.int.spec
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, readSessionJsonl, tempHome, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好。 */
const home = tempHome()
/** 本文件的工作目录：会话的 `meta.cwd` 指着它，日志排在 `sessions/<slug>/` 下。 */
const WORK = join(home.home, 'ws-activity')

let kernel: BootedKernel
let fake: FakeLLM
let core: typeof import('@pneuma/runtime/core/session.js')
let scope: typeof import('@pneuma/runtime/packages/permission-core/permission-scope.js')

/** 出厂默认三项：补钉用例拿它当「当前生效的默认值」。 */
const DEFAULTS = { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user' } as const

beforeAll(async () => {
  mkdirSync(WORK, { recursive: true })
  // HOME 已换成临时目录，此时加载才会把 DSC_HOME 算在临时目录里。
  core = await import('@pneuma/runtime/core/session.js')
  scope = await import('@pneuma/runtime/packages/permission-core/permission-scope.js')
  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
  home.restore()
})

/** 会话文件的落点：`sessions/<slug(cwd)>/<id>.jsonl`。 */
function seedDir(): string {
  const dir = join(core.sessionsRoot(), core.slugCwd(WORK))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 按事故现场的形状铺一份会话日志；返回文件路径。 */
function seedSession(id: string, records: ReadonlyArray<Record<string, unknown>>): string {
  const file = join(seedDir(), `${id}.jsonl`)
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  return file
}

/** 列表里按 uuid 找一行；找不到返回 undefined（断言直接写出差异）。 */
function rowOf(id: string): { id: string; updatedAt: number; path: string } | undefined {
  return core.listSessions().find((item) => item.id === id)
}

/**
 * 等写流把特征串刷到盘上，再返回盘上全文。
 *
 * 不固定 sleep：`appendState`/`appendUser` 只往写流里塞，落盘在下一个 tick。
 * 固定等 300ms 在慢机器上就是赌博（原探针正是这么写的）。
 */
async function waitForText(file: string, needle: string): Promise<string> {
  const deadline = Date.now() + 3_000
  for (;;) {
    const text = readFileSync(file, 'utf8')
    if (text.includes(needle) || Date.now() > deadline) return text
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('① listSessions 的「最近使用」口径', () => {
  test('取最后一条带 ts 的对话记录，不取文件 mtime', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    const file = seedSession(id, [
      { type: 'meta', id, cwd: WORK, createdAt: 100 },
      { type: 'user', text: '第一问', ts: 200 },
      { type: 'assistant', text: '第一答', reasoning: '', ts: 300 },
      // 打开会话时补的三条权限默认值：一条 ts 都没有，不能把时间往后推。
      { type: 'state', id: 'permissions', payload: { sandbox: null, policy: null, reviewer: null } },
    ])
    expect(rowOf(id)?.updatedAt).toBe(300)
    // 文件刚被写过，mtime 是「现在」；这条钉住「不是拿 mtime 当最近使用」。
    expect(rowOf(id)?.updatedAt).not.toBe(statSync(file).mtimeMs)
  })

  test('老日志没有 ts：回落到文件 mtime', () => {
    const id = '66666666-7777-8888-9999-aaaaaaaaaaaa'
    const file = seedSession(id, [
      { type: 'meta', id, cwd: WORK, createdAt: 100 },
      { type: 'user', text: '老问题' },
      { type: 'assistant', text: '老回答', reasoning: '' },
    ])
    expect(rowOf(id)?.updatedAt).toBe(statSync(file).mtimeMs)
  })

  test('只有 meta 与记账、没有对话的文件不进列表', () => {
    const id = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    seedSession(id, [
      { type: 'meta', id, cwd: WORK, createdAt: 100 },
      { type: 'state', id: 'permissions', payload: { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user' } },
    ])
    expect(rowOf(id)).toBeUndefined()
  })
})

describe('② 打开会话补默认值：不写盘、不动 mtime', () => {
  test('补钉返回默认值，文件一个字节都没多、mtime 没被刷新', () => {
    const id = '77777777-2222-3333-4444-555555555555'
    const file = seedSession(id, [
      { type: 'meta', id, cwd: WORK, createdAt: 100 },
      { type: 'user', text: '打开我', ts: 200 },
      { type: 'assistant', text: '好', reasoning: '', ts: 300 },
      { type: 'state', id: 'permissions', payload: { sandbox: null, policy: null, reviewer: null } },
    ])
    const sizeBefore = statSync(file).size
    const mtimeBefore = statSync(file).mtimeMs
    const opened = core.Session.load(file)
    try {
      expect(scope.resolvePermissions(opened, DEFAULTS)).toEqual(DEFAULTS)
      expect(statSync(file).size).toBe(sizeBefore)
      expect(statSync(file).mtimeMs).toBe(mtimeBefore)
      // 打开过之后，列表里的时间仍然是最后一步。
      expect(rowOf(id)?.updatedAt).toBe(300)
    } finally {
      opened.close()
    }
  })

  test('补钉值在同一进程里立刻读得到，且不跟着后来的默认值漂', () => {
    const id = '88888888-2222-3333-4444-555555555555'
    const file = seedSession(id, [
      { type: 'meta', id, cwd: WORK, createdAt: 100 },
      { type: 'user', text: '打开我', ts: 200 },
      { type: 'state', id: 'permissions', payload: { sandbox: null, policy: null, reviewer: null } },
    ])
    const opened = core.Session.load(file)
    try {
      // 第一次读：缺项补默认值并钉进内存。
      expect(scope.resolvePermissions(opened, DEFAULTS).sandbox).toBe('workspace-write')
      expect(opened.state('permissions')?.sandbox).toBe('workspace-write')
      // 第二次读带着不同的默认值：已经钉住的那项不跟着变。
      expect(scope.resolvePermissions(opened, { ...DEFAULTS, sandbox: 'read-only' }).sandbox).toBe('workspace-write')
    } finally {
      opened.close()
    }
  })
})

describe('③ 补钉值等下一次真写日志时顺带落盘', () => {
  test('补钉行在用户那条之前落盘，重放之后还是同一份', async () => {
    const id = '99999999-2222-3333-4444-555555555555'
    const file = seedSession(id, [
      { type: 'meta', id, cwd: WORK, createdAt: 100 },
      { type: 'user', text: '打开我', ts: 200 },
    ])
    const opened = core.Session.load(file)
    const now = Date.now()
    scope.resolvePermissions(opened, DEFAULTS)
    opened.appendUser('第二问')
    opened.close()

    const written = await waitForText(file, '第二问')
    const lines = written.trimEnd().split(/\r?\n/)
    const pinnedAt = lines.findLastIndex((line) => line.includes('"id":"permissions"'))
    const userAt = lines.findIndex((line) => line.includes('"text":"第二问"'))
    expect(pinnedAt).toBeGreaterThanOrEqual(0)
    expect(pinnedAt).toBeLessThan(userAt)
    expect((JSON.parse(lines[pinnedAt] ?? '{}') as { payload?: unknown }).payload).toEqual(DEFAULTS)

    const replayed = core.Session.load(file)
    try {
      expect(replayed.state('permissions')?.reviewer).toBe('user')
    } finally {
      replayed.close()
    }
    // 说话之后时间前进了：新记录带 ts，列表读的是它。
    expect(rowOf(id)?.updatedAt).toBeGreaterThanOrEqual(now)
  })

  test('再点一次（重新加载）不把时间推到「现在」', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const file = seedSession(id, [
      { type: 'meta', id, cwd: WORK, createdAt: 100 },
      { type: 'user', text: '点我', ts: 200 },
      { type: 'assistant', text: '嗯', reasoning: '', ts: 300 },
      { type: 'state', id: 'permissions', payload: { sandbox: null, policy: null, reviewer: null } },
    ])
    const before = rowOf(id)?.updatedAt
    const mtimeBefore = statSync(file).mtimeMs
    const reopened = core.Session.load(file)
    try {
      scope.resolvePermissions(reopened, DEFAULTS)
    } finally {
      reopened.close()
    }
    expect(rowOf(id)?.updatedAt).toBe(before)
    expect(statSync(file).mtimeMs).toBe(mtimeBefore)
  })
})

describe('④ 真内核跑一个回合：同一套时间口径', () => {
  test('最近使用 = 真日志里最后一条带 ts 的记录', async () => {
    await kernel.runTurn('活动时间：真回合')
    const ctx = kernel.ctx as unknown as { session: { current(): { filePath: string } } }
    const path = ctx.session.current().filePath
    expect(existsSync(path)).toBe(true)

    const records = readSessionJsonl(path)
    const lastTs = records.reduce<number | undefined>(
      (found, record) => (typeof record.ts === 'number' ? record.ts : found),
      undefined,
    )
    expect(lastTs).toBeDefined()
    expect(core.listSessions().find((item) => item.path === path)?.updatedAt).toBe(lastTs)
  })
})
