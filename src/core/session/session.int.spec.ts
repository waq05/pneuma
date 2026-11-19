/**
 * 同一 callId 两条工具结果的三层防护（integration 层）。
 *
 * 事故形状（本文件逐条复刻 `scripts/session-dedupe-test.mjs` 的夹具）：assistant 发起
 * ask_user → 会话被重开，加载时的中断修复先补了一条「结果未知」合成结果 → 紧接着被打断的
 * 那一轮把真实结果也写了进来。日志里同一 callId 于是有两条 tool 记录；DeepSeek 网关按
 * 「tool 消息必须是对某个尚未被应答的前置 tool_calls 的回应」判 400，这条会话之后每次
 * 请求都被拒，卡死。
 *
 * ## 为什么必须用裸说明符 import
 *
 * `@pneuma/runtime/*` 是构建期生成的适配包名，`tsconfig.json` 的 `paths` 把它映射回 `src/*`。
 * 测试走通它，才证明「同一份源码既可以被内核自己按发布形态 import，也可以被测试 import」。
 * 换成相对路径，这条用例就退化成「同目录相对导入能不能解析」，与发布形态无关——
 * 而这正是整套测试解析层要证明的第一件事。
 *
 * ## 为什么三条防护要分三层测
 *
 * 它们是三个不同的失败面：重放（读历史）、落库（写历史）、请求组装（发出去那一份）。
 * 只在请求侧测，写坏日志的那条路径仍然会绿；只在落库测，已经写坏的旧会话仍然发不出去。
 *
 * @module dsc/core/session/session.int.spec
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { sanitizeToolOrphans } from '@pneuma/runtime/core/llm.js'
import { Session } from '@pneuma/runtime/core/session.js'

/**
 * 夹具的落盘记录，逐条照抄事故现场。
 *
 * 为什么 `call_a` 的两条顺序不能换：防护的裁定是「保留首条」。首条是合成件时，模型会先去
 * 核查副作用；后到的「用户取消」之类措辞更乐观。顺序一反，测的就不是同一条规则了。
 */
const RECORDS: readonly Record<string, unknown>[] = [
  { type: 'meta', id: 'dedupe-test', cwd: '.', createdAt: 1 },
  { type: 'user', text: '帮我更新dsh源码' },
  { type: 'assistant', text: '', reasoning: '', toolCalls: [{ id: 'call_a', name: 'ask_user', arguments: '{}' }] },
  { type: 'tool', callId: 'call_a', name: 'ask_user', text: '合成：结果未知' },
  { type: 'tool', callId: 'call_a', name: 'ask_user', text: '真实：这个问题作废' },
  { type: 'user', text: '继续' },
  {
    type: 'assistant',
    text: '',
    reasoning: '',
    toolCalls: [
      { id: 'call_b', name: 'read', arguments: '{}' },
      { id: 'call_c', name: 'read', arguments: '{}' },
    ],
  },
  { type: 'tool', callId: 'call_b', name: 'read', text: 'ok-b' },
  { type: 'tool', callId: 'call_c', name: 'read', text: 'ok-c' },
]

/** 夹具原文：断言「append-only，修复只进内存」时要逐字节比对它。 */
const FIXTURE = `${RECORDS.map((record) => JSON.stringify(record)).join('\n')}\n`

/** 本文件的工作目录（放夹具与 `.lock`）。临时 HOME 由 `tests/setup/temp-home.ts` 提供。 */
let work: string

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'dsc-session-dedupe-work-'))
})

afterAll(() => {
  // 自建的夹具目录可以删：HOME 里那份才是排查要留的现场。
  rmSync(work, { recursive: true, force: true })
})

/** 每个用例各写一份同内容的新夹具：互不影响，单跑某一条也不会因为上一条的追加而错位。 */
function openFixture(name: string): { session: Session; file: string } {
  const file = join(work, name)
  writeFileSync(file, FIXTURE, 'utf8')
  // keepPath = true：后续追加仍写回这份文件（默认会按会话根目录重算路径）。
  return { session: Session.load(file, true), file }
}

/** 从夹具里读出 tool 记录（按 callId 筛），把磁盘断言从字符串匹配变成结构断言。 */
function toolRecords(file: string, callId: string): Array<{ text?: string }> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { type?: string; callId?: string; text?: string })
    .filter((record) => record.type === 'tool' && record.callId === callId)
}

/**
 * 等写流把这个特征串刷到盘上，然后返回盘上全文。
 *
 * 为什么不用固定 sleep：`Session.close()` 只 `end()` 写流，落盘发生在下一个 tick。
 * 固定等 200ms 在慢机器上就是赌博（探针原来正是这么写的）。这里轮询到出现为止；
 * 等不到也返回，让上面的断言给出「期望 1 条、实际 0 条」这种能直接看的差异。
 */
async function readDiskOnceFlushed(file: string, needle: string): Promise<string> {
  const deadline = Date.now() + 3_000
  for (;;) {
    const text = readFileSync(file, 'utf8')
    if (text.includes(needle) || Date.now() > deadline) return text
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** 取某 callId 在协议消息里的工具结果。 */
function answersOf(messages: readonly ChatMessage[], callId: string): ChatMessage[] {
  return messages.filter((message) => message.role === 'tool' && message.tool_call_id === callId)
}

describe('① Session.load 重放：同一 callId 只留首条，且不改日志', () => {
  test('同一 callId 的两条结果只留首条', () => {
    const { session } = openFixture('replay-count.jsonl')
    try {
      expect(answersOf(session.messages, 'call_a')).toHaveLength(1)
    } finally {
      session.close()
    }
  })

  test('保留的是首条（合成件），不是后到的真实结果', () => {
    // 这条钉的是「保留哪一条」：数量对了但留成末条，模型会把「用户取消」当既成事实。
    const { session } = openFixture('replay-first.jsonl')
    try {
      expect(answersOf(session.messages, 'call_a')[0]?.content).toBe('合成：结果未知')
    } finally {
      session.close()
    }
  })

  test('别的 callId 不受影响（去重不误伤）', () => {
    // 去重的实现最容易犯的错是「按 callId 集合粗暴过滤」；相邻的两个正常结果必须都在。
    const { session } = openFixture('replay-neighbors.jsonl')
    try {
      expect(answersOf(session.messages, 'call_b')).toHaveLength(1)
      expect(answersOf(session.messages, 'call_c')).toHaveLength(1)
    } finally {
      session.close()
    }
  })

  test('重放出来的消息条数 = 日志条数 − meta − 重复的那条', () => {
    // 用一个总数把「少留了别的」也兜住：只数 call_a 会漏掉「顺手多删一条」这种事故。
    const { session } = openFixture('replay-total.jsonl')
    try {
      expect(session.messages).toHaveLength(RECORDS.length - 2)
    } finally {
      session.close()
    }
  })

  test('日志文件逐字节没变（append-only，修复只进内存）', () => {
    // 重放时顺手「修好」磁盘看似更彻底，实际会让日志不再是只追加的账：
    // 出问题时没法回看原始事故现场，也没法再判断是谁写坏的。
    const { session, file } = openFixture('replay-untouched.jsonl')
    try {
      expect(session.messages).toHaveLength(RECORDS.length - 2)
    } finally {
      session.close()
    }
    expect(readFileSync(file, 'utf8')).toBe(FIXTURE)
  })
})

describe('② Session.appendTool：已有结果的 callId 不再落库', () => {
  test('已有结果的 callId 第二次不进内存', () => {
    const { session } = openFixture('append-memory.jsonl')
    try {
      session.appendTool('call_a', 'ask_user', '迟到的真实结果')
      expect(answersOf(session.messages, 'call_a')).toHaveLength(1)
    } finally {
      session.close()
    }
  })

  test('新 callId 照常进内存（查重不误伤）', () => {
    // 查重的实现若是「有 tool 消息就不再追加」，第二次工具后就全哑了。
    const { session } = openFixture('append-memory-new.jsonl')
    try {
      session.appendTool('call_new', 'read', 'ok-new')
      expect(answersOf(session.messages, 'call_new')).toHaveLength(1)
    } finally {
      session.close()
    }
  })

  test('已有结果的 callId 第二次不上盘（盘上仍是夹具那两条）', async () => {
    // 内存里挡住了、磁盘上照写，是最隐蔽的一半失败：本次会话看着正常，重开就复发。
    const { session, file } = openFixture('append-disk-dup.jsonl')
    session.appendTool('call_a', 'ask_user', '迟到的真实结果')
    // 哨兵：紧接着追加一个必然落盘的新 callId，等它在盘上出现再读。
    // 不能固定 sleep——`close()` 只 `end()` 写流，落盘在后面某个 tick；一旦去重被改坏，
    // 重复记录会真的排一次写，慢机器上 50ms 内读不到就变成假绿，正好放过这条要抓的回归。
    session.appendTool('call_probe', 'read', 'probe-sentinel')
    session.close()
    const disk = await readDiskOnceFlushed(file, 'probe-sentinel')
    expect(disk).toContain('probe-sentinel')
    const records = toolRecords(file, 'call_a')
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.text)).not.toContain('迟到的真实结果')
  })

  test('新 callId 落盘一条', async () => {
    const { session, file } = openFixture('append-disk-new.jsonl')
    session.appendTool('call_new', 'read', 'ok-new')
    session.close()
    const disk = await readDiskOnceFlushed(file, 'call_new')
    expect(disk).toContain('call_new')
    expect(toolRecords(file, 'call_new')).toHaveLength(1)
  })
})

describe('③ sanitizeToolOrphans：请求侧去重与既有孤儿剔除', () => {
  test('同 callId 的两条结果只放行首条', () => {
    // 这段**手工构造**，不从重放后的 messages 取：重放已经去过重，从那里取会让
    // 「请求侧也去重」这条断言恒真——探针原来那么写，等于没测到清洗本身。
    const duplicated: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'ask_user', arguments: '{}' } }],
      },
      { role: 'tool', content: '合成：结果未知', tool_call_id: 'call_a' },
      { role: 'tool', content: '真实：这个问题作废', tool_call_id: 'call_a' },
    ]
    const clean = sanitizeToolOrphans(duplicated)
    expect(answersOf(clean, 'call_a')).toHaveLength(1)
    expect(answersOf(clean, 'call_a')[0]?.content).toBe('合成：结果未知')
  })

  test('重放出来的完整请求里，每条 tool 消息都能配上前置 tool_calls', () => {
    // 这条是网关判 400 的直接条件，换一种说法把「整套请求自洽」钉住。
    const { session } = openFixture('request-pairing.jsonl')
    try {
      const request: ChatMessage[] = [{ role: 'system', content: 'sys' }, ...session.messages]
      const clean = sanitizeToolOrphans(request)
      const called = new Set<string>()
      for (const message of clean) for (const call of message.tool_calls ?? []) called.add(call.id)
      const tools = clean.filter((message) => message.role === 'tool')
      // 先钉住条数再判配对：`[].every()` 恒为真，只写 every 的话，
      // 「去重写成把所有 tool 都删掉」这种过头实现照样绿——而它正是本条要防的。
      // 夹具里 call_a 两条去重后留 1 条，加 call_b、call_c，共 3 条。
      expect(tools).toHaveLength(3)
      expect(tools.every((message) => called.has(message.tool_call_id!))).toBe(true)
    } finally {
      session.close()
    }
  })

  test('孤儿结果（没有前置调用）仍被剔除', () => {
    // 既有行为，不能因为加了去重就回归。
    const out = sanitizeToolOrphans([
      { role: 'user', content: 'x' },
      { role: 'tool', tool_call_id: 'ghost', content: 'orphan' },
    ])
    expect(out.some((message) => message.tool_call_id === 'ghost')).toBe(false)
  })

  test('未应答的 tool_calls 被剔掉（既有行为不回归）', () => {
    const out = sanitizeToolOrphans([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 't', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]?.tool_calls).toHaveLength(1)
    expect(out[0]?.tool_calls?.[0]?.id).toBe('c1')
    expect(out[1]?.tool_call_id).toBe('c1')
  })

  test('调用全无应答且正文为空时，整条 assistant 删掉（既有行为不回归）', () => {
    const out = sanitizeToolOrphans([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'user', content: 'next' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe('user')
  })

  test('不改动传入的原数组', () => {
    // 请求侧清洗只改「发出去的那一份」；就地改会让同一份 messages 被下一次请求继承。
    const { session } = openFixture('request-immutable.jsonl')
    try {
      const request: ChatMessage[] = [{ role: 'system', content: 'sys' }, ...session.messages]
      const before = structuredClone(request)
      const clean = sanitizeToolOrphans(request)
      expect(request).toEqual(before)
      expect(clean).not.toBe(request)
    } finally {
      session.close()
    }
  })
})
