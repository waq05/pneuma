/**
 * 「编辑并重发 = 在当前会话里截断重来」的宿主侧验收（integration 层，原
 * `scripts/session-rewind-test.mjs`）。
 *
 * 钉的口径（2026-11-03 用户报障「重新编辑不要切新会话，还在当前会话」）：
 *   ① 作废第 keep 条用户消息及其之后的回答，保留它之前的内容；
 *   ② 日志仍是 append-only：原文一条不少，只多一条 `rewind` 记录；
 *   ③ 重新从磁盘读回来（重放）得到与内存一致的截断结果——这是「重启之后还是这个样子」的保证；
 *   ④ 序号越界时如实返回失败，一个字节都不动（绝不静默截错地方）；
 *   ⑤ 截断之后写进去的新消息落在正确位置（= 第 keep 条的位置上）；
 *   ⑥ 不是当前会话时拒绝：别的会话没有常驻 agent 承接截断后的历史。
 *
 * ## 与探针的两处差别（都是「把赌时间改成等事件」）
 *
 * - 探针每次 `await sleep(80)` 等落盘。这里改成轮询「日志里出现 rewind 记录」，
 *   等不到也返回，让断言给出可读差异，而不是靠机器快慢。
 * - 探针手工写死三轮对话（含一条机器通知）。这里前两轮直接写进会话日志、第三轮由
 *   **真内核 + 假模型**跑一遍：`bootKernel` + `fakeLLM` 才算真的验了「宿主承接截断后的历史」；
 *   机器通知/队友汇报这两条口径改用真实 `Session` 直接验（它们与内核无关）。
 *
 * ## 为什么测试之间有顺序依赖
 *
 * ②～⑥ 是同一条会话上的一串动作（截断 → 读日志 → 重放 → 追加 → 越界）。它们的**顺序
 * 就是语义**：append-only 只有在「先截断、后读日志」时才成立。文件内用例串行执行
 * （`vitest.config.ts` 的 integration project 设了 `sequence.concurrent: false`）。
 *
 * @module dsc/tests/integration/session-rewind.int.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import {
  forkSession,
  readUserMessages,
  Session,
  sessionsRoot,
  slugCwd,
} from '@pneuma/runtime/core/session.js'
import { UI_ARG_SPECS, UI_METHODS, validateUiArgs } from '@pneuma/runtime/core/ui-methods.js'
import { Transcript } from '@pneuma/runtime/adapter/transcript.js'
import { bootKernel, fakeLLM, readSessionJsonl, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 会话服务里本文件用到的那一面（截断入口 + 当前会话）。 */
interface SessionSurface {
  current(): SessionLike
  rewind(path: string, keep: number, text?: string): { ok: boolean; error?: string }
}

/** 当前会话的最小面：本文件只读消息、追加一条用户消息、拿文件路径。 */
interface SessionLike {
  messages: ChatMessage[]
  filePath: string
  appendUser(text: string): void
}

let work: string
/** 会话文件所在的规范目录：sessions/<slugCwd(cwd)>/。会话层按 meta.cwd 重算路径，
 * 所以夹具必须落在这一层，否则 open() 之后 current().filePath 会指向另一处。 */
let sessionDir: string
let llm: FakeLLM
let kernel: BootedKernel
/** 被截断的那条会话（内核当前会话）。 */
let seedFile: string
/** ② 之前抓的日志全文：③ 要断言「新文件以它开头」。 */
let beforeRewind = ''

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'dsc-rewind-work-'))
  sessionDir = join(sessionsRoot(), slugCwd(work))
  mkdirSync(sessionDir, { recursive: true })
  seedFile = join(sessionDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl')
  // 前两轮直接写进日志：要的是「恢复前就有历史」，用模型跑出来只会多两轮无关的假应答。
  const seed = [
    { type: 'meta', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: work, createdAt: 1 },
    { type: 'user', text: '第一问', ts: 10 },
    { type: 'assistant', text: '第一答', reasoning: '', ts: 11 },
    { type: 'user', text: '第二问', ts: 12 },
    { type: 'assistant', text: '第二答', reasoning: '', ts: 13 },
  ]
  writeFileSync(seedFile, `${seed.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')

  llm = await fakeLLM({ turns: ['第三答'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  await service().open(seedFile)
  // 第三轮由真内核跑：证明「当前会话被常驻 agent 承接」这条前提在测试里是真的。
  await kernel.runTurn('第三问')
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

/** 会话服务面（bootKernel 只声明了 `current()`，这里按用到的成员窄化）。 */
function service(): SessionSurface & { open(path?: string): Promise<void> } {
  return (kernel.ctx as unknown as { session: SessionSurface & { open(path?: string): Promise<void> } }).session
}

/** 取出每条消息的正文（工具消息也在这里，正文为空串）。 */
function textsOf(messages: readonly ChatMessage[]): string[] {
  return messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
}


/** 读会话日志（坏行跳过由 harness 的 eadSessionJsonl 负责）。 */
function recordsOf(file: string): Array<Record<string, unknown>> {
  return readSessionJsonl(file)
}


/** 等日志里出现某个特征串（appendUser 的写入也是异步的）。 */
async function waitForText(file: string, needle: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (readFileSync(file, 'utf8').includes(needle) || Date.now() > deadline) return
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/**
 * 等日志里出现一条 `rewind` 记录，返回追加出来的那些记录。
 *
 * 为什么不用固定 sleep：`Session.write` 走异步写流，落盘在后面的 tick。固定等 80ms
 * 在慢机器上会把「还没写」读成「没写」，让 append-only 这条断言变成赌运气。
 */
async function waitForRewind(file: string, timeoutMs = 3_000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const records = recordsOf(file)
    if (records.some((record) => record.type === 'rewind') || Date.now() > deadline) return records
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

describe('① 起点：三轮提问都在会话里', () => {
  test('消息 6 条，最后一条是第三答', () => {
    const texts = textsOf(service().current().messages)
    expect(texts).toHaveLength(6)
    expect(texts.at(-1)).toBe('第三答')
  })
})

describe('② 作废第 2 条及之后（keep = 1）', () => {
  test('返回成功，内存里只剩第一轮（问 + 答）', () => {
    beforeRewind = readFileSync(seedFile, 'utf8')
    const result = service().rewind(seedFile, 1)
    expect(result.ok).toBe(true)
    expect(service().current().messages).toHaveLength(2)
  })

  test('第一条仍是第一问', () => {
    expect(textsOf(service().current().messages)[0]).toBe('第一问')
  })

  test('第二问与第三答都不在了', () => {
    const texts = textsOf(service().current().messages)
    expect(texts).not.toContain('第二问')
    expect(texts).not.toContain('第三答')
  })

  test('机器投递的通知留在它所属的那一轮里（不算一轮）', () => {
    // 直接验 Session 层：只跳过 `origin: 'notice'` 的实现会把「通知」当成人打的第二问，
    // 于是编辑第二问时从通知那里截断，通知（模型还要看的上下文）被一起作废。
    const file = join(sessionDir, 'notice.jsonl')
    writeFileSync(
      file,
      [
        { type: 'meta', id: 'notice', cwd: work, createdAt: 2 },
        { type: 'user', text: '第一问', ts: 20 },
        { type: 'assistant', text: '第一答', reasoning: '', ts: 21 },
        { type: 'user', text: '机器通知', origin: 'notice', ts: 22 },
        { type: 'assistant', text: '通知后的答', reasoning: '', ts: 23 },
        { type: 'user', text: '第二问', ts: 24 },
        { type: 'assistant', text: '第二答', reasoning: '', ts: 25 },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
      'utf8',
    )
    const session = Session.load(file)
    try {
      expect(session.rewindToUser(1)).toBe(true)
      const texts = textsOf(session.messages)
      expect(texts).toHaveLength(4)
      expect(texts).toContain('机器通知')
      expect(texts).toContain('通知后的答')
      expect(texts).not.toContain('第二问')
    } finally {
      session.close()
    }
  })
})

describe('③ 日志 append-only：原文一条不少，只多一条 rewind', () => {
  test('原文件内容是新文件的前缀（没有删改历史）', async () => {
    const after = readFileSync(seedFile, 'utf8')
    expect(after.startsWith(beforeRewind)).toBe(true)
    expect(after.length).toBeGreaterThan(beforeRewind.length)
  })

  test('追加的最后一条是 rewind，且 keep = 1', async () => {
    // 追加的可能是几条记账（回合收尾补的 state），但**最后一条必须是 rewind**。
    const records = await waitForRewind(seedFile)
    const rewind = records.at(-1)
    expect(rewind?.type).toBe('rewind')
    expect(rewind?.keep).toBe(1)
  })
})

describe('④ 重新从磁盘读回来（重放）与内存一致', () => {
  test('重放后消息条数一致，且同样没有第二问', () => {
    const reloaded = Session.load(seedFile, true, { lease: false })
    try {
      expect(reloaded.messages).toHaveLength(2)
      const texts = textsOf(reloaded.messages)
      expect(texts).not.toContain('第二问')
      expect(texts).toContain('第一问')
    } finally {
      reloaded.close()
    }
  })
})

describe('⑤ 截断之后写进去的新消息落在原位置', () => {
  test('消息条数 3，新消息排在下标 2（截断点上）', async () => {
    service().current().appendUser('改过的第二问')
    await waitForText(seedFile, '改过的第二问')
    const reloaded = Session.load(seedFile, true, { lease: false })
    try {
      const texts = textsOf(reloaded.messages)
      expect(texts).toHaveLength(3)
      expect(texts[2]).toBe('改过的第二问')
    } finally {
      reloaded.close()
    }
    // 复位：把这条也作废，后面的「越界不写盘」「分叉菜单」才按 2 条算账。
    // 探针原来也是这么复位的（`scripts/session-rewind-test.mjs:124-126`）。
    expect(service().rewind(seedFile, 1).ok).toBe(true)
    await waitForRewind(seedFile)
  })
})

describe('⑥ 序号越界：如实失败，一个字节都不动', () => {
  test('返回失败并给出原因', () => {
    const result = service().rewind(seedFile, 9)
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).not.toBe('')
  })

  test('日志没有被写（逐字节相同）', () => {
    const before = readFileSync(seedFile, 'utf8')
    // 上一次越界调用如果真的动了文件，这里就会红；再调一次并比对前后。
    service().rewind(seedFile, 9)
    expect(readFileSync(seedFile, 'utf8')).toBe(before)
  })
})

describe('⑦ 不是当前会话：拒绝（别的会话没有常驻 agent 承接）', () => {
  test('返回失败，原因说清了是「当前会话」', () => {
    const other = join(sessionDir, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jsonl')
    writeFileSync(
      other,
      `${JSON.stringify({ type: 'meta', id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', cwd: work, createdAt: 3 })}\n` +
        `${JSON.stringify({ type: 'user', text: '别的会话' })}\n`,
      'utf8',
    )
    const result = service().rewind(other, 0)
    expect(result.ok).toBe(false)
    expect(String(result.error ?? '')).toContain('当前会话')
  })
})

describe('⑧ 界面通道认这条方法（白名单 + 参数校验都通）', () => {
  test('rewindSession 在界面通道白名单里', () => {
    expect(UI_METHODS).toContain('rewindSession')
  })

  test('两个参数都合法时放行', () => {
    expect(validateUiArgs('rewindSession', [seedFile, 1]).ok).toBe(true)
  })

  test('keep 不是数字时拒掉', () => {
    expect(validateUiArgs('rewindSession', [seedFile, 'x']).ok).toBe(false)
  })

  test('少了参数时拒掉', () => {
    expect(validateUiArgs('rewindSession', [seedFile]).ok).toBe(false)
    // 参数规格表本身就是公开导出：直接钉住「这项有规则」，避免哪天被删成空数组。
    expect(Array.isArray(UI_ARG_SPECS['rewindSession'])).toBe(true)
  })
})

describe('⑨ 队友汇报不算「人打的一轮」', () => {
  // 判据要与界面同一个口径：`internal` 那三类（机器通知 / 队友汇报 / 审查结论）都不开一轮。
  // 老写法只跳过 origin: notice，会把 <teammate-report> 当成人打的第二问——编辑第二问时
  // 就从汇报那里截断，汇报（模型还要看的上下文）会被一起作废。
  const file = (): string => join(sessionDir, 'cccccccc-dddd-eeee-ffff-000000000000.jsonl')

  test('内存里作废第二问成功，汇报留下来了', () => {
    writeFileSync(
      file(),
      [
        { type: 'meta', id: 'cccccccc-dddd-eeee-ffff-000000000000', cwd: work, createdAt: 4 },
        { type: 'user', text: '第一问', ts: 30 },
        { type: 'assistant', text: '第一答', reasoning: '', ts: 31 },
        { type: 'user', text: '<teammate-report name="小明">做完了</teammate-report>', ts: 32 },
        { type: 'assistant', text: '收到汇报', reasoning: '', ts: 33 },
        { type: 'user', text: '第二问', ts: 34 },
        { type: 'assistant', text: '第二答', reasoning: '', ts: 35 },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
      'utf8',
    )
    const session = Session.load(file())
    try {
      expect(session.rewindToUser(1)).toBe(true)
      const texts = textsOf(session.messages)
      expect(texts.some((text) => text.startsWith('<teammate-report'))).toBe(true)
      expect(texts).not.toContain('第二问')
    } finally {
      session.close()
    }
  })

  test('重放同样保留汇报、没有第二问', async () => {
    // 上一条 close() 只 end() 写流，rewind 记录落盘在后面某个 tick：等它到了再重放。
    await waitForRewind(file())
    const reloaded = Session.load(file(), true, { lease: false })
    try {
      const texts = textsOf(reloaded.messages)
      expect(texts.some((text) => text.startsWith('<teammate-report'))).toBe(true)
      expect(texts).not.toContain('第二问')
    } finally {
      reloaded.close()
    }
  })
})

describe('⑩ 作废之后，分叉菜单与分叉结果都认这条 rewind', () => {
  // 审查抓到：rewind 只改了内存与重放，`readUserMessages` / `forkSession` 仍是逐行扫原文，
  // 于是分叉菜单里还列着被作废的消息，从那儿分叉出来的新会话还会把 rewind 记录一起带过去、
  // 重放时把自己截空。
  test('分叉菜单里没有第二问，第一问还在', () => {
    const listed = readUserMessages(seedFile)
    expect(listed.some((text) => text.includes('第二问'))).toBe(false)
    expect(listed.some((text) => text.includes('第一问'))).toBe(true)
  })

  test('分叉结果里没有 rewind 记录', () => {
    const forked = forkSession(seedFile, 1)
    expect(readFileSync(forked, 'utf8')).not.toContain('"type":"rewind"')
  })

  test('分叉出来的会话不是空的，也没有第二问', () => {
    const forked = forkSession(seedFile, 1)
    const session = Session.load(forked, true, { lease: false })
    try {
      const texts = textsOf(session.messages)
      expect(texts.length).toBeGreaterThan(0)
      expect(texts).not.toContain('第二问')
    } finally {
      session.close()
    }
  })
})

describe('⑪ 压缩过的会话：界面数的轮数与宿主截的位置对得上', () => {
  // 压缩之后宿主的内存消息是「摘要 + 尾巴」，而摘要在日志里就是一条 role:'user' 的记录；
  // 界面重放同样把它画成一条 user 条目。两边都把它当「人打的第一条」，截断位置才对得上。
  test('界面在 Q4 之前数到 2 条（摘要 + Q3），宿主按同一个数截断成功', () => {
    const file = join(sessionDir, 'dddddddd-eeee-ffff-0000-111111111111.jsonl')
    writeFileSync(
      file,
      [
        { type: 'meta', id: 'dddddddd-eeee-ffff-0000-111111111111', cwd: work, createdAt: 5 },
        { type: 'user', text: 'Q1', ts: 40 },
        { type: 'assistant', text: 'A1', reasoning: '', ts: 41 },
        { type: 'summary', text: '【历史已压缩】前面聊过 Q1', keep: 0, ts: 42 },
        { type: 'user', text: 'Q3', ts: 43 },
        { type: 'assistant', text: 'A3', reasoning: '', ts: 44 },
        { type: 'user', text: 'Q4', ts: 45 },
        { type: 'assistant', text: 'A4', reasoning: '', ts: 46 },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
      'utf8',
    )
    const session = Session.load(file)
    try {
      const transcript = new Transcript()
      transcript.replayHistory(session.messages, session.toolErrors, session.fileChanges, session.presentations)
      const target = transcript.entries.findIndex((entry) => entry.kind === 'user' && entry.text === 'Q4')
      expect(target).toBeGreaterThanOrEqual(0)
      const uiKeep = transcript.entries
        .slice(0, target)
        .filter((entry) => entry.kind === 'user' && entry.internal !== true).length
      expect(uiKeep).toBe(2)
      expect(session.rewindToUser(uiKeep)).toBe(true)
      const kept = textsOf(session.messages)
      expect(kept).toContain('Q3')
      expect(kept).not.toContain('Q4')
      // 摘要不能顺手被删：它是压缩后模型唯一的早期上下文。
      expect(kept.some((text) => text.startsWith('【历史已压缩】'))).toBe(true)
    } finally {
      session.close()
    }
  })
})

test('会话根落在本机临时目录（隔离前提）', () => {
  // `DSC_HOME` 是 `core/path-policy.ts` 的模块顶层常量：本文件静默 import 了会话模块，
  // 所以真正生效的是 setup 文件设的临时 HOME。这条兜住「有人改了 setup 或 DSC_HOME」。
  const root = sessionsRoot().replaceAll('\\', '/')
  const temp = tmpdir().replaceAll('\\', '/')
  expect(root.startsWith(temp)).toBe(true)
  expect(root.endsWith('.dsc/sessions')).toBe(true)
})
