/**
 * 上下文占用回填：切会话 / 重启宿主后，状态栏不该掉成 0%（迁自
 * `scripts/context-usage-restore-test.mjs`）。
 *
 * 为什么单开一份：这个 bug 只在「有历史、有 usage 日志、但当前进程没收到过 usage 事件」
 * 的现场出现。纯看代码能说得通，但得真起内核、真写一份 usage.jsonl、真开两次会话，才能
 * 确认快照里的 `status.contextUsed` 跟着回来、且没有样本的会话不被瞎填。
 *
 * 口径：usage 日志里同一 sid 的最后一条请求行（按 `t` 取最大）的 `i` 就是此刻的上下文占用；
 * 会话 jsonl 不存 token，回填只能来自这份日志。
 *
 * ## 迁移时砍掉的东西（原探针第 [5] 节 + 一条启动标志）
 *
 * 第 [5] 节是六条源码文本断言（`adapter 提供 seedContextUsage 回填入口`、
 * `session-open 在重放之后调用回填`、`界面：没有样本时上下文段整段不画`……）。它们钉的是
 * 「代码写在哪一行」，不是行为，按本批规矩不搬。
 *
 * 另有一条 `booted.session.resumedStartup === true` 没有搬：`bootKernel` 固定
 * `resumeSessionPath: null`（详设 §6.4），这个标志只能由「带恢复路径起内核」产生，而本层
 * 没有那个接缝。启动回填的**行为**（重启后第一眼就有值、没有样本时不瞎填）用
 * `emitStartupNotes` 原函数覆盖，见第 ⑤ 组。
 *
 * @module dsc/tests/integration/context-usage-restore.int.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DscCoreConfig } from '@pneuma/runtime/core/config.js'
import { emitStartupNotes } from '@pneuma/runtime/host/kernel.js'
import { readSessionUsage, usageLogFile } from '@pneuma/runtime/core/usage-log.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../harness.js'

/** 两个会话 id：一个在用量日志里有行，一个没有。 */
const SID_RESTORE = '11111111-1111-4111-8111-111111111111'
const SID_EMPTY = '22222222-2222-4222-8222-222222222222'

/** 内核里本文件用到的服务面。 */
interface SnapshotView {
  status: {
    contextUsed: number
    sessionId: string
    contextSegments: { system: number; prompt: number; assistant: number; thinking: number; tools: number; schema: number }
  }
  entries: Array<{ kind: string; text?: string }>
}

interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
}

interface Services {
  session: { current(): SessionView; open(filePath?: string, cwd?: string): Promise<void> }
  transcript: { getSnapshot(): SnapshotView }
}

/** 供应商配置：窗口给大一点，回填读数才不会被别的逻辑夹到别的数。 */
const CONFIG = {
  providers: {
    test: {
      name: 'test',
      displayName: 'Test',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'k',
      models: [
        {
          id: 'm',
          name: 'm',
          contextWindow: 512_000,
          maxTokens: 500,
          modalities: ['text'],
          thinkingLevels: [],
          thinkingParam: 'none',
          effortMap: {},
        },
      ],
    },
  },
  defaultProvider: 'test',
  defaultModel: 'm',
}

/** 手写一份最小会话日志（meta + 一问一答）：重放只要这三种记录。 */
function writeSession(file: string, id: string, cwd: string, text: string): void {
  const lines = [
    { type: 'meta', id, cwd, createdAt: Date.now() - 60_000 },
    { type: 'user', text, ts: Date.now() - 50_000 },
    { type: 'assistant', text: `收到：${text}`, reasoning: '', ts: Date.now() - 40_000 },
  ]
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
}

let kernel: BootedKernel
let fake: FakeLLM
let services: Services
/** 三条工作目录 + 两份会话文件。 */
let fileRestore: string
let fileEmpty: string
/** 各阶段快照：整段场景只跑一遍，用例只读。 */
let usage: ReturnType<typeof readSessionUsage>
let opened: SnapshotView
let openedEmpty: SnapshotView
let reopened: SnapshotView
let startedRestore: SnapshotView
let startedEmpty: SnapshotView
let restoreJsonl: string

beforeAll(async () => {
  // 工作目录与会话文件都建在本次的文件级临时 HOME 下（integration 的 setup 已经换过 HOME）。
  const home = mkdtempSync(join(process.env.HOME ?? process.cwd(), 'usage-restore-'))
  const dirRestore = join(home, 'ws-restore')
  const dirEmpty = join(home, 'ws-empty')
  const dirFresh = join(home, 'ws-fresh')
  for (const dir of [dirRestore, dirEmpty, dirFresh]) mkdirSync(dir, { recursive: true })

  fileRestore = join(home, 'session-restore.jsonl')
  fileEmpty = join(home, 'session-empty.jsonl')
  writeSession(fileRestore, SID_RESTORE, dirRestore, '恢复这条会话')
  writeSession(fileEmpty, SID_EMPTY, dirEmpty, '没有用量行的会话')

  // 同一 sid 两行：最后一行（t 更大）才是「此刻占用」；即使它先出现也不能被前一行盖掉。
  mkdirSync(join(process.env.HOME ?? process.cwd(), '.dsc', 'usage'), { recursive: true })
  const usageRows = [
    { t: 1_000, provider: 'test', model: 'm', i: 999, o: 10, sid: SID_RESTORE },
    { t: 2_000, provider: 'test', model: 'm', i: 5_000, o: 20, sid: SID_RESTORE },
    // 别的会话的行不参与本会话的折叠。
    { t: 3_000, provider: 'test', model: 'm', i: 88_888, o: 30, sid: `${SID_EMPTY}-other` },
  ]
  writeFileSync(usageLogFile(), `${usageRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl, config: CONFIG })
  services = kernel.ctx as unknown as Services

  // ⓪ 折叠口径先自检：最后一行获胜、没有行返回 null。
  usage = readSessionUsage(SID_RESTORE)
  expect(readSessionUsage(SID_EMPTY)).toBeNull()

  // ① 打开有用量行的会话：clear + replay 之后回填总数。
  await services.session.open(fileRestore)
  opened = services.transcript.getSnapshot()

  // ② 没有用量行的会话：0，不能拿上一条会话的数凑。
  await services.session.open(fileEmpty)
  openedEmpty = services.transcript.getSnapshot()

  // ③ 再切回有量会话：重新 clear + replay，值不丢。
  await services.session.open(fileRestore)
  reopened = services.transcript.getSnapshot()
  restoreJsonl = readFileSync(fileRestore, 'utf8')

  // ④ 启动回填：重启后第一眼就有值（用真启动收尾函数，只是不经过「带恢复路径起内核」）。
  emitStartupNotes(kernel.ctx as Parameters<typeof emitStartupNotes>[0], null, CONFIG as unknown as DscCoreConfig)
  startedRestore = services.transcript.getSnapshot()

  // ⑤ 没有用量行的会话重启：仍是 0，不瞎填。
  await services.session.open(fileEmpty)
  emitStartupNotes(kernel.ctx as Parameters<typeof emitStartupNotes>[0], null, CONFIG as unknown as DscCoreConfig)
  startedEmpty = services.transcript.getSnapshot()
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
})

describe('① 折叠口径：最后一行获胜，没行返回 null', () => {
  test('usage 日志折叠取最后一行的 input tokens', () => {
    expect(usage?.lastInputTokens).toBe(5_000)
  })

  test('读取入口不会把别的会话的行算进来（999 + 5000 = 5999）', () => {
    expect(usage?.inputTokens).toBe(5_999)
  })
})

describe('② 打开有用量行的会话：回填总数', () => {
  test('status.contextUsed = 5000，sessionId 是这条会话', () => {
    expect(opened.status.contextUsed).toBe(5_000)
    expect(opened.status.sessionId).toBe(SID_RESTORE)
  })

  test('回填只给总数：分段仍全为 0（等下一次 context 事件）', () => {
    expect(opened.status.contextSegments).toEqual({ system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0, schema: 0 })
  })
})

describe('③ 没有用量行的会话：0，不能凑', () => {
  test('contextUsed 仍是 0，快照换成这条会话', () => {
    expect(openedEmpty.status.contextUsed).toBe(0)
    expect(openedEmpty.status.sessionId).toBe(SID_EMPTY)
  })
})

describe('④ 再切回有量会话：值不丢，日志不被塞 token', () => {
  test('重新 open 一次（clear + replay）后 contextUsed 仍是 5000', () => {
    expect(reopened.status.contextUsed).toBe(5_000)
  })

  test('会话条目确实重放出来了', () => {
    expect(reopened.entries.some((entry) => entry.kind === 'user' && entry.text === '恢复这条会话')).toBe(true)
  })

  test('会话 jsonl 没有被塞进 usage / token 字段', () => {
    expect(restoreJsonl).not.toMatch(/inputTokens|lastInputTokens|contextUsed|"usage"/)
  })
})

describe('⑤ 启动回填：重启后第一眼就有值，没样本时不瞎填', () => {
  test('启动恢复后快照 status.contextUsed = 5000', () => {
    expect(startedRestore.status.contextUsed).toBe(5_000)
  })

  test('启动恢复也重放了历史条目', () => {
    expect(startedRestore.entries.some((entry) => entry.kind === 'user' && entry.text === '恢复这条会话')).toBe(true)
  })

  test('没有用量行的会话重启：contextUsed 仍是 0', () => {
    expect(startedEmpty.status.contextUsed).toBe(0)
  })
})
