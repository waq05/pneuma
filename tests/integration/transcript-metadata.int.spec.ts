/**
 * 系统提示卡与上下文注入卡的落盘 / 重放（迁自 `scripts/transcript-metadata-test.mjs`）。
 *
 * ## 为什么这两类内容要单独一张网
 *
 * 它们**不在消息流里**：系统提示是请求头，上下文注入是投影往请求里塞的。要在重放时回到
 * 原位，三件事必须同时成立：
 *   ① 现场真的发出了事件（循环在请求组装完、流还没开的时候发）；
 *   ② 日志里记下了**落位锚点**（`after` = 写它时日志里有几条消息）。没有锚点，实时在轮中、
 *      重放只能放轮首，`sameEntries` 的全字段比对永远判不等 → 每次开会话整表重建；
 *   ③ 卡片上的字段都是确定性的（hash / 字符数 / 段清单 / 注入摘要），不塞时间戳与会变的
 *      顺序——不然重放出来的一比就不一样。
 *
 * ## 为什么这条必须起真内核
 *
 * 系统提示由真 prompt 投影链拼出来（内核三段 + 指令文件 + 插件段），注入清单由真投影
 * 按环境算出来。用假 transcript 喂事件只能验 adapter 的去重规则（本文件第 ① 节），验不出
 * 「请求发出去那一刻宿主到底发了什么、日志里落成了什么形状」。所以这里用 harness 的
 * `bootKernel` + `fakeLLM` 跑真回合，日志一律用 `readSessionJsonl` 读。
 *
 * ## 迁移时改了的两个数
 *
 * - 模型名用 harness 的 `m`（原探针自造 `m-test`）；
 * - 落盘等法从固定 200ms 改成「记录条数连续 300ms 不再变」（同 `session-replay.int.spec.ts`
 *   的 `waitForStableTypes`）。固定 sleep 在慢机器上会把「还在写」读成「没写」。
 *
 * ## 迁移时收窄了一条断言
 *
 * 原探针钉「注入种类含 env-facts / mode / sandbox」。harness 默认把 sandbox 插件关掉
 * （台账 D16：它在 Windows 上启动时要 spawn PowerShell 体检，实测会挂住测试 worker），
 * 所以这一趟根本不会产生沙箱注入。硬留着这条只能靠打开沙箱换来一个不退出进程，不值；
 * 这里收窄成 env-facts / mode，并保留「每条注入的字段形状」那条兜底。
 *
 * @module dsc/tests/integration/transcript-metadata.int.spec
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ContextInjectionView, SystemPromptView, TranscriptEntry } from '@pneuma/runtime/contract.js'
import {
  bootKernel,
  fakeLLM,
  readSessionJsonl,
  tempHome,
  type BootedKernel,
  type FakeLLM,
} from '../../tests/harness.js'

/** 临时主目录；必须在任何内核模块被加载之前换好（`DSC_HOME` 是模块级常量）。 */
const home = tempHome('dsc-transcript-meta-')

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface Services {
  session: { current(): { meta: { id: string; cwd: string }; filePath: string } }
  transcript: { getSnapshot(): { entries: readonly TranscriptEntry[] } }
}

type SessionModule = typeof import('@pneuma/runtime/core/session.js')
type TranscriptModule = typeof import('@pneuma/runtime/adapter/transcript.js')
type PromptModule = typeof import('@pneuma/runtime/packages/session-core/prompt.js')
type ContractModule = typeof import('@pneuma/runtime/contract.js')
/** 会话实例的类型：`Session` 的构造器是私有的，只能经 `create` / `load` 拿实例。 */
type SessionInstance = ReturnType<SessionModule['Session']['create']>

let llm: FakeLLM
let kernel: BootedKernel
let services: Services
let sessionModule: SessionModule
let transcriptModule: TranscriptModule
let promptModule: PromptModule
let contractModule: ContractModule
/** 这一条会话文件的路径（第 ②③④ 节都读它）。 */
let filePath: string

/** `system-prompt` / `context-injected` 状态记录的载荷。 */
interface PromptPayload {
  text?: string
  after?: number
  view?: SystemPromptView
}
interface InjectionPayload {
  parts?: ContextInjectionView[]
  after?: number
}

/** 实时的可见条目（去掉重放造不出来的 system / subagent，与生产代码的比对口径一致）。 */
function realtimeEntries(): readonly TranscriptEntry[] {
  return services.transcript.getSnapshot().entries.filter((entry) => entry.kind !== 'system' && entry.kind !== 'subagent')
}

/** 某类状态记录的载荷（按写入顺序）。 */
function payloads(records: Array<Record<string, unknown>>, id: string): Array<Record<string, unknown>> {
  return records
    .filter((record) => record.type === 'state' && record.id === id)
    .map((record) => (record.payload ?? {}) as Record<string, unknown>)
}

/**
 * 等日志条数连续 300ms 不再变化，返回稳定下来的记录。
 *
 * 写流是异步的：固定 sleep 在慢机器上会把「还在写」读成「没写」，而这里的每条断言都是
 * 「日志里有几条」，读早了就是假失败。
 */
async function stableRecords(settleMs = 300, timeoutMs = 8_000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs
  let previous = readSessionJsonl(filePath)
  let stableSince = Date.now()
  for (;;) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 40))
    const current = readSessionJsonl(filePath)
    if (current.length !== previous.length) {
      previous = current
      stableSince = Date.now()
      continue
    }
    if (Date.now() - stableSince >= settleMs || Date.now() > deadline) return current
  }
}

/**
 * 条目内容的比较形状：剔除每次重建都会变、或重放造不出来的字段。
 *
 * 口径与 `packages/transcript/index.ts` 的 `shape()` 一致（那边是生产代码里的判据）：
 * id 每次重建从 1 重发；ts 是「最后写入时刻」；usage / durationMs / startedAt 是现场
 * 测出来的量，日志里没有。
 */
function shape(entries: readonly TranscriptEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => {
      const rest = { ...entry } as Record<string, unknown>
      delete rest['id']
      delete rest['ts']
      delete rest['usage']
      delete rest['durationMs']
      if (entry.kind === 'tool') {
        const call = { ...entry.call } as Record<string, unknown>
        delete call['startedAt']
        delete call['durationMs']
        rest['call'] = call
      }
      return rest
    }),
  )
}

/** 两份形状串第一处不同在哪（失败时给一眼看得懂的现场）。 */
function firstDiff(left: string, right: string): string {
  if (left === right) return ''
  let at = 0
  while (at < left.length && at < right.length && left[at] === right[at]) at += 1
  return `第 ${String(at)} 个字符起：实时「${left.slice(at, at + 120)}」／重放「${right.slice(at, at + 120)}」`
}

beforeAll(async () => {
  sessionModule = await import('@pneuma/runtime/core/session.js')
  transcriptModule = await import('@pneuma/runtime/adapter/transcript.js')
  promptModule = await import('@pneuma/runtime/packages/session-core/prompt.js')
  contractModule = await import('@pneuma/runtime/contract.js')
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  services = kernel.ctx as unknown as Services
  filePath = services.session.current().filePath
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

describe('① 条目层：同 hash 原地刷时刻 / 换 hash 才新增（纯 adapter，不产内核）', () => {
  /** 两轮同 hash、再一轮换 hash 的转录。 */
  let transcript: InstanceType<TranscriptModule['Transcript']>
  /** 一版系统提示的卡片视图；正文不在这里，只有摘要与体量。 */
  const view = (hash: string): SystemPromptView => ({ hash, chars: 10, sections: [], model: 'm-test' })
  /** 一份注入清单（一条环境快照）。 */
  const parts: ContextInjectionView[] = [
    { kind: 'env-facts', source: 'env-facts', where: 'user-tail', chars: 5, preview: '环境' },
  ]

  beforeAll(() => {
    transcript = new transcriptModule.Transcript()
    transcript.reduce({ type: 'prompt/used', prompt: view('aaaaaaaaaaaaaaaa') }, 1_000)
    transcript.reduce({ type: 'context/injected', parts }, 1_000)
    transcript.reduce({ type: 'prompt/used', prompt: view('aaaaaaaaaaaaaaaa') }, 2_000)
    transcript.reduce({ type: 'context/injected', parts: parts.map((part) => ({ ...part })) }, 2_000)
  })

  test('同 hash 两轮只留一条系统提示条目', () => {
    expect(transcript.entries.filter((entry) => entry.kind === 'system-prompt')).toHaveLength(1)
  })

  test('同 hash 的第二轮把时刻刷成最后一次', () => {
    const prompt = transcript.entries.find((entry) => entry.kind === 'system-prompt')
    expect(prompt?.ts).toBe(2_000)
  })

  test('同一份注入清单只留一条注入条目', () => {
    expect(transcript.entries.filter((entry) => entry.kind === 'context-injection')).toHaveLength(1)
  })

  test('注入条目也把时刻刷成最后一次', () => {
    const injection = transcript.entries.find((entry) => entry.kind === 'context-injection')
    expect(injection?.ts).toBe(2_000)
  })

  test('换了 hash 才新增第二条系统提示', () => {
    transcript.reduce({ type: 'prompt/used', prompt: view('bbbbbbbbbbbbbbbb') }, 3_000)
    expect(transcript.entries.filter((entry) => entry.kind === 'system-prompt')).toHaveLength(2)
  })

  test('换了注入清单才新增第二条注入', () => {
    transcript.reduce(
      {
        type: 'context/injected',
        parts: [
          {
            kind: contractModule.CONTEXT_INJECTION_KINDS.todoReminder,
            source: 'todo-reminder',
            where: 'user-tail' as const,
            chars: 3,
            preview: '提醒',
          },
        ],
      },
      3_000,
    )
    expect(transcript.entries.filter((entry) => entry.kind === 'context-injection')).toHaveLength(2)
  })

  test('新条目的 id 是稳定正整数（不借别的条目的号）', () => {
    expect(transcript.entries.every((entry) => typeof entry.id === 'number' && entry.id > 0)).toBe(true)
  })

  test('新条目的 id 互不重复', () => {
    const ids = transcript.entries.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('② 真回合：请求发出去那一刻，两类事件都发了、也落盘了', () => {
  /** 第一轮跑完时的实时条目（剔除重放造不出来的那两类）。 */
  let live: readonly TranscriptEntry[]
  /** 第一轮跑完时盘上的全部记录。 */
  let records: Array<Record<string, unknown>>
  /** 第一轮若失败，原因记在这里，由「第一轮正常收尾」这条用例报出来。 */
  let turnError: unknown

  beforeAll(async () => {
    try {
      await kernel.runTurn('第一轮：看看这一轮发了什么')
    } catch (error) {
      turnError = error
    }
    records = await stableRecords()
    live = realtimeEntries()
  })

  test('第一轮正常收尾', () => {
    expect(turnError).toBeUndefined()
  })

  test('日志里出现一条 system-prompt 状态记录', () => {
    expect(payloads(records, 'system-prompt')).toHaveLength(1)
  })

  test('系统提示记录带 after 落位锚点（写它时日志里有几条消息）', () => {
    // 没有这个锚点，重放只能把它放到轮首，和实时位置差一格 → 每次开会话整表重建。
    expect(payloads(records, 'system-prompt')[0]?.['after']).toBe(1)
  })

  test('系统提示记录带卡片视图（hash 与正文字符数与正文同口径）', () => {
    const payload = payloads(records, 'system-prompt')[0] as PromptPayload | undefined
    expect(payload?.view?.hash).toBe(promptModule.promptHash(payload?.text ?? ''))
    expect(payload?.view?.chars).toBe((payload?.text ?? '').length)
  })

  test('段清单按拼装顺序含内核三段', () => {
    const payload = payloads(records, 'system-prompt')[0] as PromptPayload | undefined
    const ids = (payload?.view?.sections ?? []).map((section) => section.id)
    for (const id of ['identity', 'behavior', 'tool-rules']) expect(ids).toContain(id)
  })

  test('指令文件段的来源标成 file（当前目录没有 AGENTS.md 时那一趟不出现 instructions 段）', () => {
    const payload = payloads(records, 'system-prompt')[0] as PromptPayload | undefined
    const section = (payload?.view?.sections ?? []).find((item) => item.id === 'instructions')
    // 指令文件段只在这个工作目录真有 AGENTS.md 时才出现——别把「跑的地方」当成断言前提。
    if (existsSync(join(process.cwd(), 'AGENTS.md'))) expect(section?.from).toBe('file')
    else expect(section).toBeUndefined()
  })

  test('内核段的来源标成 core', () => {
    const payload = payloads(records, 'system-prompt')[0] as PromptPayload | undefined
    const identity = (payload?.view?.sections ?? []).find((item) => item.id === 'identity')
    expect(identity?.from).toBe('core')
  })

  test('卡片记下了这一轮用的模型名', () => {
    const payload = payloads(records, 'system-prompt')[0] as PromptPayload | undefined
    expect(payload?.view?.model).toBe('m')
  })

  test('段清单里的段都是 {id, order, chars, from} 四件齐', () => {
    const payload = payloads(records, 'system-prompt')[0] as PromptPayload | undefined
    const sections = payload?.view?.sections ?? []
    expect(sections.length).toBeGreaterThan(0)
    for (const section of sections) {
      expect(typeof section.id).toBe('string')
      expect(typeof section.order).toBe('number')
      expect(typeof section.chars).toBe('number')
      expect(typeof section.from).toBe('string')
    }
  })

  test('日志里至少一条 context-injected 状态记录', () => {
    expect(payloads(records, 'context-injected').length).toBeGreaterThanOrEqual(1)
  })

  test('注入种类含 env-facts / mode（sandbox 那类在 harness 下观察不到，见文件头）', () => {
    const payload = payloads(records, 'context-injected')[0] as InjectionPayload | undefined
    const kinds = (payload?.parts ?? []).map((part) => part.kind)
    for (const kind of ['env-facts', 'mode']) expect(kinds).toContain(kind)
    expect(kinds.every((kind) => typeof kind === 'string')).toBe(true)
  })

  test('每条注入都带 source / where / chars / preview', () => {
    const payload = payloads(records, 'context-injected')[0] as InjectionPayload | undefined
    const parts = payload?.parts ?? []
    expect(parts.length).toBeGreaterThan(0)
    for (const part of parts) {
      expect(part.where === 'system' || part.where === 'user-tail').toBe(true)
      expect(typeof part.chars).toBe('number')
      expect(part.chars).toBeGreaterThanOrEqual(0)
      expect(typeof part.source).toBe('string')
      expect(typeof part.preview).toBe('string')
    }
  })

  test('注入记录也带 after 落位锚点', () => {
    const payload = payloads(records, 'context-injected')[0] as InjectionPayload | undefined
    expect(typeof payload?.after).toBe('number')
  })

  test('注入卡片的列表里不出现正文（预览最多 200 字）', () => {
    const payload = payloads(records, 'context-injected')[0] as InjectionPayload | undefined
    for (const part of payload?.parts ?? []) expect((part.preview ?? '').length).toBeLessThanOrEqual(200)
  })

  test('实时条目里恰好一条系统提示卡', () => {
    expect(live.filter((entry) => entry.kind === 'system-prompt')).toHaveLength(1)
  })

  test('实时条目里至少一条上下文注入卡', () => {
    expect(live.filter((entry) => entry.kind === 'context-injection').length).toBeGreaterThanOrEqual(1)
  })

  test('系统提示卡排在第一句用户消息之后（实时位置就是请求发出那一刻）', () => {
    expect(live.findIndex((entry) => entry.kind === 'system-prompt')).toBe(1)
  })
})

describe('③ 第二轮（同一版提示词）：不新增条目、不重复落盘', () => {
  let secondLive: readonly TranscriptEntry[]
  let records2: Array<Record<string, unknown>>
  /** 第一轮那条系统提示卡的时刻（第二轮之后必须只增不减）。 */
  let tsBefore: number | undefined
  let turnError: unknown

  beforeAll(async () => {
    // 第一轮的实时条目在上一节已经取过；这里重新取一次作为「第二轮之前」的基线。
    tsBefore = realtimeEntries().find((entry) => entry.kind === 'system-prompt')?.ts
    try {
      await kernel.runTurn('第二轮：提示词没变，应该不新增卡片')
    } catch (error) {
      turnError = error
    }
    records2 = await stableRecords()
    secondLive = realtimeEntries()
  })

  test('第二轮正常收尾', () => {
    expect(turnError).toBeUndefined()
  })

  test('同 hash 的第二轮没有新增系统提示卡', () => {
    expect(secondLive.filter((entry) => entry.kind === 'system-prompt')).toHaveLength(1)
  })

  test('时刻被刷新（只刷 ts，不换条目）', () => {
    const after = secondLive.find((entry) => entry.kind === 'system-prompt')?.ts ?? 0
    expect(after).toBeGreaterThanOrEqual(tsBefore ?? 0)
  })

  test('同 hash 的第二轮也没有重复写 system-prompt 记录', () => {
    expect(payloads(records2, 'system-prompt')).toHaveLength(1)
  })

  test('注入卡片数与落盘记录数一致（同一份清单不重复记）', () => {
    const entries = secondLive.filter((entry) => entry.kind === 'context-injection').length
    expect(entries).toBe(payloads(records2, 'context-injected').length)
  })
})

describe('④ 重放：条目数、顺序、锚点必须与实时一模一样', () => {
  /** 第二轮之后的实时条目（关内核之前取的那一份）。 */
  let liveFinal: readonly TranscriptEntry[]
  /** 从盘上重放出来的条目。 */
  let replayed: readonly TranscriptEntry[]
  let restored: SessionInstance
  /** 实时那一份里的系统提示卡（段清单比对用）。 */
  let firstPrompt: Extract<TranscriptEntry, { kind: 'system-prompt' }> | undefined
  /** 第二轮之后盘上的记录。 */
  let records: Array<Record<string, unknown>>

  beforeAll(async () => {
    liveFinal = realtimeEntries()
    records = await stableRecords(200)
    firstPrompt = liveFinal.find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'system-prompt' }> => entry.kind === 'system-prompt',
    )
    // 先放掉写租约（关内核 = 关会话文件），再只读重放——跟编辑器里关掉文件再用别的程序读一个道理。
    await kernel.dispose()
    restored = sessionModule.Session.load(filePath, true, { lease: false })
    const probe = new transcriptModule.Transcript()
    probe.replayHistory(
      restored.messages,
      restored.toolErrors,
      restored.fileChanges,
      restored.presentations,
      restored.notices(),
      restored.marks(),
    )
    replayed = probe.entries.filter((entry) => entry.kind !== 'system' && entry.kind !== 'subagent')
  })

  test('重放读到了落位记录（条数 = 两类状态记录之和）', () => {
    expect(restored.marks()).toHaveLength(
      payloads(records, 'system-prompt').length + payloads(records, 'context-injected').length,
    )
  })

  test('系统提示的 after 锚点从日志里读回来了', () => {
    expect(restored.marks().find((mark) => mark.kind === 'system-prompt')?.after).toBe(1)
  })

  test('重放条目数与实时一致', () => {
    expect(replayed).toHaveLength(liveFinal.length)
  })

  test('重放条目顺序与内容逐条一致（全字段比对，剔除 id/ts/usage/耗时）', () => {
    // 逐字段挑着比盯不住「多出一个字段」；整包比对才盯得住。
    const expected = shape(liveFinal)
    const actual = shape(replayed)
    expect(actual, firstDiff(expected, actual)).toBe(expected)
  })

  test('系统提示卡在重放里也排在第一句用户消息之后（锚点没丢）', () => {
    expect(replayed.findIndex((entry) => entry.kind === 'system-prompt')).toBe(
      liveFinal.findIndex((entry) => entry.kind === 'system-prompt'),
    )
  })

  test('重放出来的系统提示卡不标 bodyMissing（视图与正文都在日志里）', () => {
    const prompt = replayed.find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'system-prompt' }> => entry.kind === 'system-prompt',
    )
    expect(prompt?.prompt.bodyMissing).toBeUndefined()
  })

  test('重放出来的段清单与实时逐段一致', () => {
    const prompt = replayed.find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'system-prompt' }> => entry.kind === 'system-prompt',
    )
    expect(JSON.stringify(prompt?.prompt.sections ?? [])).toBe(JSON.stringify(firstPrompt?.prompt.sections ?? []))
  })

  test('重放时消息流本身没有多出东西（系统提示不进消息历史）', () => {
    expect(restored.messages.every((message) => message.role !== 'system')).toBe(true)
  })
})

describe('⑤ 老数据（没有 after）：落到轮首 + bodyMissing', () => {
  /** 2026-11 之前写下的系统提示记录：只有 hash + text，没有锚点、没有段清单。 */
  const LEGACY_TEXT = '老一版系统提示正文（2026-11 之前没有段清单与锚点）'
  let legacy: SessionInstance
  let legacyTranscript: InstanceType<TranscriptModule['Transcript']>

  beforeAll(() => {
    const legacyDir = join(home.home, '.dsc', 'sessions', 'legacy')
    mkdirSync(legacyDir, { recursive: true })
    const legacyFile = join(legacyDir, 'legacy-0001.jsonl')
    const lines = [
      { type: 'meta', id: 'legacy-0001', cwd: join(home.home, 'work'), createdAt: 1_700_000_000_000 },
      { type: 'user', text: '老会话第一句', ts: 1_700_000_000_100 },
      { type: 'assistant', text: '老会话的回答', reasoning: '', ts: 1_700_000_000_200 },
      { type: 'state', id: 'system-prompt', payload: { hash: 'deadbeefdeadbeef', text: LEGACY_TEXT } },
    ]
    writeFileSync(legacyFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')

    legacy = sessionModule.Session.load(legacyFile, true, { lease: false })
    legacyTranscript = new transcriptModule.Transcript()
    legacyTranscript.replayHistory(
      legacy.messages,
      legacy.toolErrors,
      legacy.fileChanges,
      legacy.presentations,
      legacy.notices(),
      legacy.marks(),
    )
  })

  afterAll(() => {
    legacy?.close()
  })

  test('老记录也读成一条落位记录', () => {
    expect(legacy.marks().find((mark) => mark.kind === 'system-prompt')).toBeDefined()
  })

  test('老记录没有 after 锚点', () => {
    expect(legacy.marks().find((mark) => mark.kind === 'system-prompt')?.after).toBeUndefined()
  })

  test('老记录标了 bodyMissing（段清单当年没记）', () => {
    expect(legacy.marks().find((mark) => mark.kind === 'system-prompt')?.prompt?.bodyMissing).toBe(true)
  })

  test('老记录仍能拿到摘要与字符数', () => {
    const mark = legacy.marks().find((item) => item.kind === 'system-prompt')
    expect(mark?.prompt?.hash).toBe('deadbeefdeadbeef')
    expect(mark?.prompt?.chars).toBe(LEGACY_TEXT.length)
  })

  test('老记录的段清单是空的（编不出来就不编）', () => {
    expect(legacy.marks().find((mark) => mark.kind === 'system-prompt')?.prompt?.sections ?? []).toHaveLength(0)
  })

  test('老记录重放后落在轮首（第 0 条）', () => {
    expect(legacyTranscript.entries[0]?.kind).toBe('system-prompt')
  })

  test('老记录重放仍标着 bodyMissing', () => {
    const first = legacyTranscript.entries[0]
    expect(first?.kind === 'system-prompt' ? first.prompt.bodyMissing : undefined).toBe(true)
  })

  test('老会话的消息照常重放出来（两张卡不挤掉历史）', () => {
    expect(legacyTranscript.entries).toHaveLength(3)
  })
})
