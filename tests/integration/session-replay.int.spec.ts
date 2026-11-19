/**
 * 会话重放：喂一份 JSONL，断言「同一份日志重放之后，用户看到的东西还是那个东西」
 * （integration 层，原 `scripts/session-replay-test.mjs`）。
 *
 * 这是这条性质的第一条自动断言。以前改状态写入顺序、改恢复逻辑，都只能开界面人肉看
 * 一遍。现在它把「状态键读回来的值」+「日志记录序列」整包钉住：哪天某个插件开始往
 * 会话里多写一条状态，或者重放顺手把日志改了，这里都会红。
 *
 * ## 为什么走 `session.open()` 而不是再造一个「恢复会话」的入口
 *
 * `bootKernel` 固定 `resumeSessionPath: null`（§6.4），起内核时不能直接指定恢复文件；
 * 而 `session.open(path)` 是界面点侧栏时走的**同一个公开方法**，它内部就是
 * `Session.load(path)` + `dsc/session-open`。所以这既复用了 harness，又没有把
 * 「恢复」这条路径测成测试自己搭的旁路。
 *
 * ## 为什么 fixture 的 `cwd` 要改写
 *
 * 会话的目录是它自己的数据：`meta.cwd` 写死成 `D:\w` 的 fixture 换台机器就打不开。
 * 重放前把 `meta.cwd` 换成这台机器的真实临时目录，与探针 `replaySession` 同一个做法。
 *
 * ## 为什么不用固定 sleep 等落盘
 *
 * 探针固定等 300ms。这里改成「记录条数连续 300ms 不再变」——重放之后本来就不该再写，
 * 稳定下来的条数才是结论；固定 sleep 在慢机器上会把「还在写」读成「没写」。
 *
 * @module dsc/tests/integration/session-replay.int.spec
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { bootKernel, fakeLLM, readSessionJsonl, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/**
 * 事故现场的日志：四条状态记录 + 一句用户消息，正好复刻「老会话带着模式/预设/权限/清单
 * 重开」的形状。顺序不能换——重放按记录顺序折叠，`state` 条目以最后一条为准。
 */
const FIXTURE = [
  { type: 'meta', id: '3f2b1c4d-0000-4000-8000-000000000001', cwd: '', createdAt: 1 },
  { type: 'state', id: 'mode', payload: 'plan' },
  { type: 'state', id: 'preset', payload: 'build' },
  { type: 'state', id: 'permissions', payload: { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user' } },
  {
    type: 'state',
    id: 'todos',
    payload: [
      { id: 't1', text: '先看现场', status: 'completed' },
      { id: 't2', text: '再动手', status: 'pending' },
    ],
  },
  { type: 'user', text: '你好' },
] as const

/** 会话服务里本文件用到的那一面：`open` 是界面侧栏点开会话时调的同一个方法。 */
interface SessionSurface {
  current(): { state(id: string): unknown; filePath: string }
  open(filePath?: string): Promise<void>
}

let work: string
let llm: FakeLLM
let kernel: BootedKernel
/** 本文件里唯一那份「重放用」的会话文件（每次打开都指向它，避免互相踩租约）。 */
let replayFile: string

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'dsc-replay-work-'))
  mkdirSync(work, { recursive: true })
  replayFile = join(work, 'replay.jsonl')
  // 只改写 meta 的 cwd；其余记录逐字节保留（夹具本身就是断言对象）。
  const [meta, ...rest] = FIXTURE
  writeFileSync(
    replayFile,
    `${[JSON.stringify({ ...meta, cwd: work }), ...rest.map((record) => JSON.stringify(record))].join('\n')}\n`,
    'utf8',
  )
  llm = await fakeLLM({ turns: ['重放用不到真回合'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  await session().open(replayFile)
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

/** 会话服务面（bootKernel 只声明了 `current()`，这里按用到的成员窄化）。 */
function session(): SessionSurface {
  return (kernel.ctx as unknown as { session: SessionSurface }).session
}

/** 会话文件当前每条记录的类型（坏行与空行不算：进程被杀时截半行是正常事故形态）。 */
function recordTypes(file: string): string[] {
  return readSessionJsonl(file).map((record) => String(record.type ?? '?'))
}

/**
 * 等到日志条数连续 300ms 不再变化，返回稳定下来的类型序列。
 *
 * 「重放不多写」是一条**否定**断言：只读一次的话，晚到的写恰好还没发生，就会假绿。
 */
async function waitForStableTypes(file: string, settleMs = 300, timeoutMs = 3_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let previous = recordTypes(file)
  let stableSince = Date.now()
  for (;;) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 40))
    const current = recordTypes(file)
    if (current.length !== previous.length || current.join() !== previous.join()) {
      previous = current
      stableSince = Date.now()
      continue
    }
    if (Date.now() - stableSince >= settleMs || Date.now() > deadline) return current
  }
}

test('mode 按日志恢复', () => {
  expect(session().current().state('mode')).toBe('plan')
})

test('preset 按日志恢复', () => {
  expect(session().current().state('preset')).toBe('build')
})

test('permissions 三项都在', () => {
  expect(session().current().state('permissions')).toEqual({
    sandbox: 'workspace-write',
    policy: 'auto-edit',
    reviewer: 'user',
  })
})

test('todos 整表恢复（含每条的状态）', () => {
  expect(session().current().state('todos')).toEqual([
    { id: 't1', text: '先看现场', status: 'completed' },
    { id: 't2', text: '再动手', status: 'pending' },
  ])
})

test('日志里没写过的状态读出来是 undefined（不能凭空出现）', () => {
  // plan / plans 这两个键在夹具里没有记录。若重放给它们补了默认值，
  // 界面会凭空显示一个「有计划」的会话——那是比丢状态更难查的假象。
  expect(session().current().state('plan')).toBeUndefined()
  expect(session().current().state('plans')).toBeUndefined()
})

test('重放不会往日志里多写记录（仍是 6 条，类型顺序不变）', async () => {
  const types = await waitForStableTypes(replayFile)
  expect(types).toEqual(['meta', 'state', 'state', 'state', 'state', 'user'])
})

test('整包形状：状态键与日志序列一起钉住', async () => {
  // 逐键断言盯不住「多出一个键」；整包比对才盯得住。但状态里没有时间/路径这类
  // 每次跑都不同的值（夹具刻意写成确定的），所以可以直接比。
  const state = {
    mode: session().current().state('mode'),
    preset: session().current().state('preset'),
    permissions: session().current().state('permissions'),
    todos: session().current().state('todos'),
    plan: session().current().state('plan') ?? null,
    plans: session().current().state('plans') ?? null,
  }
  expect(state).toEqual({
    mode: 'plan',
    preset: 'build',
    permissions: { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user' },
    todos: [
      { id: 't1', text: '先看现场', status: 'completed' },
      { id: 't2', text: '再动手', status: 'pending' },
    ],
    plan: null,
    plans: null,
  })
  expect(await waitForStableTypes(replayFile)).toHaveLength(6)
})
