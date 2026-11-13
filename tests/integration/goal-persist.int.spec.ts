/**
 * 会话目标的落盘口径（迁自 `scripts/goal-persist-test.mjs`）。
 *
 * 报障「目标点 ✕ 清空后，重启又回来」：清空走 `goals.clearByUser()` 之后快照是 null，
 * 旧版 `persist()` 见 null 就跳过写日志——jsonl 里最后一条 goal 记录仍是清空前那份，
 * 重放又把它读回来。修法：**空目标也要追加一条 `goal = null`** 盖掉上一条。
 *
 * ## 为什么原探针前两段没有搬
 *
 * 原探针第 [1]、[2] 段是源码文本断言：`persist()` 的函数体里要出现
 * `appendState('goal', goals.snapshot)`、`SessionStateMap.goal` 的类型写成
 * `GoalSnapshot | null`、注释里要有某句话。本批规矩不搬源码文本。它们的**行为**没有丢：
 *   - 「清空也写一条」→ 用例 ③④（真内核跑 `goal` 工具 + `/goal clear` 的服务通道，
 *     读 jsonl 的最后一条 goal 记录，再 `Session.load` 重放）；
 *   - 「存储层允许 null」→ 用例 ②（手写一份 `payload: null` 的日志，`Session.load`
 *     读出来必须是 null 而不是旧目标；类型不允许 null 时这份夹具连编译都过不去）。
 *
 * ## 为什么起真内核、而不是直接 new 一个 GoalStore
 *
 * 「谁在什么时候把快照写进日志」是插件的事，不在 store 里。`goal` 工具与
 * `goalAction('clear')` 是两条真实入口（模型一条、`/goal` 命令一条），本条钉的正是
 * 它们都经过同一次 `persist`。
 *
 * @module dsc/tests/integration/goal-persist.int.spec
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { bootKernel, fakeLLM, readSessionJsonl, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-goal-persist-')
/** 内核模块一律动态 import（同上）。 */
let Session: typeof import('../../src/core/session.js').Session

/** 内核里本文件用到的服务面：只声明用到的。 */
interface GoalSurface {
  goalAction(action: 'pause' | 'resume' | 'clear' | 'edit'): { ok: boolean; error?: string }
}
interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  state(id: string): unknown
  appendUser(text: string): void
}
interface Services {
  session: { current(): SessionView }
  tools: {
    list(): Array<{ name: string; run(args: Record<string, unknown>, ctx: ToolRunContext): Promise<string> }>
  }
  get(name: string): unknown
}
interface ToolRunContext {
  cwd: string
  signal: AbortSignal
  sessionId: string
  sessionPath: string
}

let kernel: BootedKernel
let fake: FakeLLM
let services: Services
let session: SessionView
/** 目标工具的调用上下文：归属当前这条会话（工具按 `sessionPath` 找回会话）。 */
let toolCtx: ToolRunContext

/**
 * 等到会话文件里出现至少 `count` 条 `type: "state"` 且 `id: "goal"` 的记录。
 *
 * 写流是异步 flush 的，只读一次会把「还没刷出来」读成「没写」——所以等的是**条数**，
 * 不是固定时长。
 */
async function goalRecords(count: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 3_000
  for (;;) {
    if (existsSync(session.filePath)) {
      const state = readSessionJsonl(session.filePath).filter(
        (record) => record.type === 'state' && record.id === 'goal',
      )
      if (state.length >= count) return state
    }
    if (Date.now() > deadline) return []
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeAll(async () => {
  mkdirSync(join(home.home, '.dsc'), { recursive: true })
  Session = (await import('../../src/core/session.js')).Session
  fake = await fakeLLM({ turns: ['目标落盘用不到真回合'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
  session = services.session.current()
  toolCtx = {
    cwd: session.meta.cwd,
    signal: new AbortController().signal,
    sessionId: session.meta.id,
    sessionPath: session.filePath,
  }
  // 先让会话「说过话」：新会话的 state 记账只攒在内存里，第一条真正的对话日志落地时
  // 才连同 meta 一起写出去（`session.ts:1327` 的 `pendingState`）。真实用户也是先发话
  // 才可能设目标，这不是绕路。
  session.appendUser('先发一句，让会话落盘')
  const goalTool = services.tools.list().find((entry) => entry.name === 'goal')
  expect(goalTool).toBeDefined()
  // 建一个目标：这一步本身也顺带钉了「建目标写一条日志」。
  const created = await goalTool!.run({ action: 'create', objective: '把目标清空这件事记住', maxRounds: 8 }, toolCtx)
  expect(created).toContain('目标已建立')
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
  home.restore()
})

test('① 建目标：日志里落下一条带 objective 的 goal 记录', async () => {
  const records = await goalRecords(1)
  expect(records).toHaveLength(1)
  expect((records[0]?.payload as { objective?: string } | null)?.objective).toBe('把目标清空这件事记住')
})

test('② 清空：日志末尾追加一条 payload = null（不是「什么都不写」）', async () => {
  const result = (services.get('goal') as GoalSurface).goalAction('clear')
  expect(result.ok).toBe(true)
  const records = await goalRecords(2)
  // 两条：建目标一条、清空一条。旧实现这里仍是一条，「清空」被悄悄吞掉。
  expect(records).toHaveLength(2)
  expect(records[1]?.payload).toBeNull()
})

test('③ 重启重放：清空之后读到 null（重启不会把目标带回来）', async () => {
  // lease: false —— 内核还活着并持有这条会话的写租约，模拟「重启后再打开」只需只读重放。
  const reopened = Session.load(session.filePath, true, { lease: false })
  expect(reopened.state('goal')).toBeNull()
  reopened.close()
})

test('④ 清空后新建的目标照常生效（日志只追加、最后一条赢）', async () => {
  const goalTool = services.tools.list().find((entry) => entry.name === 'goal')!
  await goalTool.run({ action: 'create', objective: '新目标', maxRounds: 8 }, toolCtx)
  const records = await goalRecords(3)
  expect(records).toHaveLength(3)
  expect((records[2]?.payload as { objective?: string } | null)?.objective).toBe('新目标')
  const reopened = Session.load(session.filePath, true, { lease: false })
  expect((reopened.state('goal') as { objective?: string } | null)?.objective).toBe('新目标')
  reopened.close()
})

test('对照组：日志里只有目标、没有清空记录时，重放读得回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-goal-fixture-'))
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const snapshot = { id: 'goal-test', revision: 1, objective: '把目标清空这件事记住', phase: 'active', maxRounds: 8, rounds: 0 }
  const file = join(dir, 'kept.jsonl')
  writeFileSync(
    file,
    `${[
      { type: 'meta', id: 'kept', cwd, createdAt: Date.now() },
      { type: 'state', id: 'goal', payload: snapshot },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  )
  const kept = Session.load(file, true)
  expect((kept.state('goal') as { objective?: string } | null)?.objective).toBe(snapshot.objective)
  kept.close()
})

test('存量会话：清空记录后面还有新目标时，最后一条生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-goal-fixture-'))
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const snapshot = { id: 'goal-test', revision: 1, objective: '把目标清空这件事记住', phase: 'active', maxRounds: 8, rounds: 0 }
  const file = join(dir, 'again.jsonl')
  writeFileSync(
    file,
    `${[
      { type: 'meta', id: 'again', cwd, createdAt: Date.now() },
      { type: 'state', id: 'goal', payload: snapshot },
      { type: 'state', id: 'goal', payload: null },
      { type: 'state', id: 'goal', payload: { ...snapshot, id: 'goal-second', objective: '新目标' } },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  )
  const again = Session.load(file, true)
  expect((again.state('goal') as { objective?: string } | null)?.objective).toBe('新目标')
  again.close()
})
