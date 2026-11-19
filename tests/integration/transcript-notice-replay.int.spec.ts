/**
 * 模型重试提示「刷新之后还在」：落盘、读回、重放插回原位（迁自
 * `scripts/transcript-notice-replay-test.mjs`）。
 *
 * ## 报障与前因
 *
 * 2026-11-07 报障「这个报错在刷新后就看不到了，需要留着」。根因不是界面没画，是**日志里
 * 没有这条记录**：重试提示只活在宿主内存里，重启就没了。修法照 dsh 的「先持久、后等待」——
 * 退避开始**之前**就写一条 `notice` 记录，并带一个**归位锚点** `after`（写它时日志里有几条
 * 消息），重放时按锚点插回消息之间，而不是堆到末尾。
 *
 * ## 这条性质的五个面
 *
 *   ① 写：`notice` 记录真的落盘，字段一个不少，且排在它促成的答案之前；
 *   ② 读：`Session.notices()` 原样交还，时间戳排得出先后；
 *   ③ 重放：按 `after` 插回「问 → 重试 → 答案」的原位，失败原因（turn-error）重放成一条
 *      system 条目；
 *   ④ 老日志：没有 `notice` 记录时不多出一条空提示；
 *   ⑤ 连续重试：同一条行原地更新，不叠成一摞；中间隔了正文就另起一行。
 *
 * ## 为什么不起真内核
 *
 * 重试提示由模型请求失败触发，而 harness 的 `fakeLLM` 只会回「正常应答」——它没有任何
 * 让请求 429 的接缝（能返回错误的只有 `replayLLM` 的指纹校验，那是另一件事）。硬造一个
 * 会 429 的端点是本批明令禁止的「手写假 SSE」。这里改用宿主自己写这条记录时走的**同一个
 * 公开方法** `Session.appendNotice`：写盘与归位的逻辑是它，观察的也是它，中间没有测试
 * 自己搭的旁路。
 *
 * ## 隔离
 *
 * `tempHome()` 必须在任何内核模块被加载之前调用（`core/path-policy.ts` 的 `DSC_HOME` 是
 * 模块级常量），所以内核模块一律 `await import()`。
 *
 * @module dsc/tests/integration/transcript-notice-replay.int.spec
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readSessionJsonl, tempHome } from '../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好。 */
const home = tempHome('dsc-notice-')
/** 会话工作目录（会话文件落在 `~/.dsc/sessions/<slug>/` 下，这里只关心路径本身）。 */
const WORKSPACE = join(home.home, 'ws')

type SessionModule = typeof import('@pneuma/runtime/core/session.js')
type TranscriptModule = typeof import('@pneuma/runtime/adapter/transcript.js')
/** 会话实例的类型：`Session` 的构造器是私有的，只能经 `create` / `load` 拿实例。 */
type SessionInstance = ReturnType<SessionModule['Session']['create']>

let sessionModule: SessionModule
let transcriptModule: TranscriptModule
/** 写盘阶段跑完之后的会话文件路径。 */
let file: string
/** 最后一笔（turn-error）有没有真的落到盘上。 */
let logged: boolean
/** 第一笔的日志记录（`notice` 与消息的顺序断言都读它）。 */
let records: Array<Record<string, unknown>>
/** 从盘上重新打开的那份会话（读回与重放都基于它）。 */
let restored: SessionInstance
/** 重放出来的转录（五个面里的第③面）。 */
let replayed: InstanceType<TranscriptModule['Transcript']>

/**
 * 等写流把特征串刷到盘上。
 *
 * 写流是异步的：不等就跑，会跟 fs 抢跑，表现为「日志里少最后一条」这类假失败。
 */
async function waitForLog(path: string, needle: string): Promise<boolean> {
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      if (readFileSync(path, 'utf8').includes(needle)) return true
    } catch {
      // 文件还没建出来：继续等。
    }
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

beforeAll(async () => {
  mkdirSync(WORKSPACE, { recursive: true })
  sessionModule = await import('@pneuma/runtime/core/session.js')
  transcriptModule = await import('@pneuma/runtime/adapter/transcript.js')

  // ── 写：重试提示先落盘，再往后才是那条答案 ────────────────────────────────
  const session = sessionModule.Session.create(WORKSPACE)
  session.appendUser('为什么报 429')
  session.appendNotice({
    kind: 'model-retry',
    attempt: 3,
    maxRetries: 5,
    delayMs: 1_847,
    text: 'HTTP 429：[prefill_cap_refused] the cell is at capacity',
  })
  session.appendAssistant('这次成功了', '', [])
  session.appendNotice({ kind: 'turn-error', text: 'HTTP 429：配额不够' })
  file = session.filePath
  session.close()

  // 不在这里 expect：落盘失败要让「日志落盘」那条用例红，而不是把整个 beforeAll 炸掉
  // （那样 14 条用例会全变成「hook 失败」，看不出是哪一条性质没成立）。
  logged = await waitForLog(file, '"kind":"turn-error"')
  records = readSessionJsonl(file)

  // ── 读：重开这一轮，提示原样回来 ──────────────────────────────────────────
  restored = sessionModule.Session.load(file)

  // ── 重放：提示插回原位，不是堆到末尾 ─────────────────────────────────────
  const transcript = new transcriptModule.Transcript()
  transcript.replayHistory(
    restored.messages,
    restored.toolErrors,
    restored.fileChanges,
    restored.presentations,
    restored.notices(),
  )
  replayed = transcript
})

afterAll(() => {
  restored?.close()
  home.restore()
})

describe('① 写：重试提示先落盘，再往后才是那条答案', () => {
  test('日志落盘（等得到 turn-error 那条）', () => {
    expect(logged).toBe(true)
  })

  test('日志里落了两条 notice 记录', () => {
    expect(records.filter((record) => record.type === 'notice')).toHaveLength(2)
  })

  test('重试记录带齐 attempt / maxRetries / delayMs / 原因', () => {
    const retry = records.find((record) => (record['notice'] as { kind?: string } | undefined)?.kind === 'model-retry')
    expect(retry).toBeDefined()
    expect(retry?.['notice']).toMatchObject({ attempt: 3, maxRetries: 5, delayMs: 1_847 })
    expect(String((retry?.['notice'] as { text?: string }).text)).toContain('prefill_cap_refused')
  })

  test('重试记录排在答案之前（先持久、后等待）', () => {
    // 这条顺序就是「刷新之后还看得到」的成因：提示先落盘，答案才有。
    const noticeAt = records.findIndex((record) => record.type === 'notice')
    const answerAt = records.findIndex((record) => record.type === 'assistant')
    expect(noticeAt).toBeGreaterThanOrEqual(0)
    expect(answerAt).toBeGreaterThan(noticeAt)
  })
})

describe('② 读：重开这一轮，提示原样回来', () => {
  test('读回两条提示', () => {
    expect(restored.notices()).toHaveLength(2)
  })

  test('读回的字段与原样一致', () => {
    const first = restored.notices()[0]
    expect(first?.kind).toBe('model-retry')
    expect(first?.kind === 'model-retry' ? first.delayMs : undefined).toBe(1_847)
    expect(first?.kind === 'model-retry' ? first.maxRetries : undefined).toBe(5)
  })

  test('第一条提示夹在问与答之间', () => {
    // 靠 `ts` 排得出先后：用户消息 ≤ 提示 ≤ 答案。排不出来就说明时间戳没落盘。
    const userTs = restored.messages[0]?.ts ?? 0
    const answerTs = restored.messages[1]?.ts ?? 0
    const noticeTs = restored.notices()[0]?.ts ?? 0
    expect(noticeTs).toBeGreaterThanOrEqual(userTs)
    expect(noticeTs).toBeLessThanOrEqual(answerTs)
  })
})

describe('③ 重放：提示插回原位，不是堆到末尾', () => {
  test('重放出「问 → 重试 → 答案 → 失败原因」的顺序', () => {
    expect(replayed.entries.map((entry) => entry.kind)).toEqual(['user', 'model-retry', 'text', 'system'])
  })

  test('重放出来的重试行带着界面要的全部读数', () => {
    const retry = replayed.entries.find((entry) => entry.kind === 'model-retry')
    expect(retry).toBeDefined()
    expect(retry?.kind === 'model-retry' ? retry.attempt : undefined).toBe(3)
    expect(retry?.kind === 'model-retry' ? retry.maxRetries : undefined).toBe(5)
    expect(retry?.kind === 'model-retry' ? retry.delayMs : undefined).toBe(1_847)
  })

  test('这一轮的失败原因也重放回来了', () => {
    expect(replayed.entries.some((entry) => entry.kind === 'system' && entry.text.includes('配额不够'))).toBe(true)
  })
})

describe('④ 老日志：没有 notice 记录时不多出一条空提示', () => {
  test('老日志不产出重试行', () => {
    const legacy = new transcriptModule.Transcript()
    legacy.replayHistory([
      { role: 'user', content: '老会话', ts: 10 },
      { role: 'assistant', content: '老答案', ts: 11 },
    ])
    expect(legacy.entries.every((entry) => entry.kind !== 'model-retry')).toBe(true)
  })
})

describe('⑤ 连着重试：同一条行原地更新，不叠成一摞', () => {
  /** 三次连续重试（中间没有正文）：界面上应该是同一行在跳数，不是三行。 */
  function threeRetries(): InstanceType<TranscriptModule['Transcript']> {
    const live = new transcriptModule.Transcript()
    for (const attempt of [1, 2, 3]) {
      live.reduce(
        { type: 'model/retry', attempt, maxRetries: 5, delayMs: 500 * attempt, reason: `HTTP 429 #${String(attempt)}` },
        1_000 + attempt * 10,
      )
    }
    return live
  }

  test('三次重试只留下一行', () => {
    expect(threeRetries().entries.filter((entry) => entry.kind === 'model-retry')).toHaveLength(1)
  })

  test('那一行是最新一次的数据（3/5、等了 1500 毫秒）', () => {
    const row = threeRetries().entries.find((entry) => entry.kind === 'model-retry')
    expect(row?.kind === 'model-retry' ? row.attempt : undefined).toBe(3)
    expect(row?.kind === 'model-retry' ? row.delayMs : undefined).toBe(1_500)
  })

  test('中间隔了正文就另起一行', () => {
    // 流中断后先落半截回复、或者下一轮请求又失败：那是新的一段，不该继续改上一行。
    const live = threeRetries()
    live.reduce({ type: 'message', text: '接着干', reasoning: '' }, 1_100)
    live.reduce({ type: 'model/retry', attempt: 1, maxRetries: 5, delayMs: 500, reason: 'HTTP 429' }, 1_200)
    expect(live.entries.filter((entry) => entry.kind === 'model-retry')).toHaveLength(2)
  })
})
