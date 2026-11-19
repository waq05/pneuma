/**
 * 回合基线聚合（迁自 `scripts/turn-changes-test.mjs`）。
 *
 * 用户看到的「文件已更改」卡是**整轮一份**，不是每次 write/edit 各一份。要做到这一点，
 * 循环在每刀落库时只记「这一轮第一次碰它之前的全文」当基线，收尾时拿基线与盘上终态重算。
 * 三处口径容易错，所以各钉一条：
 *
 *   ① 同文件两刀 → 聚合 diff = 「回合起点 vs 盘上终态」一份准确差异（不是两刀拼盘）；
 *   ② 改了又改回去（终态 = 基线）→ 不出条目；取完即清、重复记录幂等、close 清空；
 *   ③ 基线只活在内存（jsonl 与事件里都不许出现 `baseline`），整轮收尾只发一次 `turn/diff`。
 *
 * 为什么归 unit 层：被测对象是 `Session.recordTurnChange` / `takeTurnChanges` 与 `MiniAgent`
 * 的收尾段，两者都能直接构造，不需要起内核（真实内核那条路在 `ptc-changes` 里另有一张网）。
 *
 * 每条用例用**自己的文件**：`write` 对已存在的文件有「先读后写」守卫（T35），
 * 复用同一个文件名会让第二条用例红在守卫上，而不是红在被测的聚合逻辑上。
 *
 * 临时 HOME 必须在 import `Session` 之前换好：`DSC_HOME` 是模块级常量，晚一步就会把
 * 测试会话写进开发者真实的 `~/.dsc`（原探针文件头记着这条事故）。
 *
 * @module dsc/core/turn-changes.spec
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录：会话 jsonl 落在这里。 */
const home = tempHome('dsc-turn-changes-')
/** 被测文件的工作目录：一个普通临时目录就够。 */
const dir = mkdtempSync(join(tmpdir(), 'dsc-turn-changes-files-'))

type SessionModule = typeof import('@pneuma/runtime/core/session.js')
type FsToolsModule = typeof import('@pneuma/runtime/core/tools/fs-tools.js')
type LoopModule = typeof import('@pneuma/runtime/packages/session-core/loop.js')
type Session = import('@pneuma/runtime/core/session.js').Session
type CoreEvent = import('@pneuma/runtime/core/events.js').CoreEvent
type ToolContext = import('@pneuma/runtime/core/tools.js').ToolContext
type ToolOutput = import('@pneuma/runtime/core/tools.js').ToolOutput

let sessionModule: SessionModule
let fsTools: FsToolsModule
let loopModule: LoopModule

beforeAll(async () => {
  sessionModule = await import('@pneuma/runtime/core/session.js')
  fsTools = await import('@pneuma/runtime/core/tools/fs-tools.js')
  loopModule = await import('@pneuma/runtime/packages/session-core/loop.js')
})

afterAll(() => {
  home.restore()
  rmSync(dir, { recursive: true, force: true })
})

/** 这一次调用的工具上下文（真会话身份，工具的产物按它归属）。 */
function contextOf(session: Session): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, sessionId: session.meta.id, sessionPath: session.filePath }
}

/** 等一个条件成立；超时返回 false（由调用方的断言报出来）。条件里可以读还不存在的文件。 */
async function until(condition: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (condition()) return true
    } catch {
      // 文件还没建出来：继续等。
    }
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/**
 * 把一次工具输出交给会话落库。
 *
 * 为什么不直接 `appendTool(id, name, output)`：`ToolOutput.presentation` 是 `unknown` 形状的
 * 通用槽，而 `appendTool` 收的是渲染层那份窄类型（`ToolPresentationView`），两者在类型上
 * 不互通——工具自己也没在这一层填过卡片数据，所以这里只传「正文 + 改动」两样。
 */
function appendToolOutput(session: Session, callId: string, name: string, output: string | ToolOutput): void {
  if (typeof output === 'string') {
    session.appendTool(callId, name, output, undefined)
    return
  }
  session.appendTool(
    callId,
    name,
    { text: output.text, ...(output.changes === undefined ? {} : { changes: output.changes }) },
    undefined,
  )
}

/** 跑一次「新建 + 定点改」，把两刀的基线都记进会话。 */
async function cutTwice(session: Session, name: string, content = 'line1\nline2\nline3\n'): Promise<void> {
  const first = await fsTools.writeTool.run({ path: name, content }, contextOf(session))
  appendToolOutput(session, `c-w-${name}`, 'write', first)
  if (typeof first !== 'string' && first.changes !== undefined) {
    session.recordTurnChange(first.changes.path, first.changes.baseline ?? '')
  }
  const second = await fsTools.editTool.run({ path: name, old: 'line2', new: 'line-two\nline2.5' }, contextOf(session))
  appendToolOutput(session, `c-e-${name}`, 'edit', second)
  if (typeof second !== 'string' && second.changes !== undefined) {
    session.recordTurnChange(second.changes.path, second.changes.baseline ?? '')
  }
}

describe('① 同文件两刀：聚合 = 回合起点 vs 盘上终态', () => {
  let session: Session

  beforeAll(() => {
    session = sessionModule.Session.create(dir)
  })

  test('write 新建 + edit 再改，聚合只出一条且呈全加', async () => {
    await cutTwice(session, 'a1.ts')
    const files = await session.takeTurnChanges()
    expect(files).toHaveLength(1)
    // 基线 = 文件不存在（空串），终态 = line1/line-two/line2.5/line3：聚合 diff 是整篇新增。
    expect(files[0]?.added).toBe(4)
    expect(files[0]?.removed).toBe(0)
  })

  test('新建文件 status=added，hunks 含着第二刀的内容', async () => {
    await cutTwice(session, 'a2.ts')
    const files = await session.takeTurnChanges()
    expect(files[0]?.status).toBe('added')
    expect(files[0]?.hunks.some((hunk) => hunk.lines.some((line) => line.text === 'line2.5'))).toBe(true)
  })

  test('产物不带 baseline 内存字段', async () => {
    await cutTwice(session, 'a3.ts')
    const files = await session.takeTurnChanges()
    expect(files).toHaveLength(1)
    expect(Object.hasOwn(files[0]!, 'baseline')).toBe(false)
  })

  test('takeTurnChanges 取完基线即清，再取为空', async () => {
    expect(await session.takeTurnChanges()).toHaveLength(0)
  })
})

describe('② 改了又改回去 / 重复记录 / close', () => {
  test('终态等于基线时聚合为空（不报一条「0 增 0 删」的假改动）', async () => {
    const session = sessionModule.Session.create(dir)
    // 基线记下的是「动之前」的全文：先用工具建出原文，改一刀（记下基线），再把盘上改回同一份。
    const original = 'line1\nline-two\nline2.5\nline3\n'
    await fsTools.writeTool.run({ path: 'b1.ts', content: original }, contextOf(session))
    const touched = await fsTools.editTool.run({ path: 'b1.ts', old: 'line1', new: 'x' }, contextOf(session))
    if (typeof touched !== 'string' && touched.changes !== undefined) {
      session.recordTurnChange(touched.changes.path, touched.changes.baseline ?? '')
    }
    writeFileSync(join(dir, 'b1.ts'), original, 'utf8')
    expect(await session.takeTurnChanges()).toHaveLength(0)
    session.close()
  })

  test('两刀幂等记基线：聚合 = 最初基线 vs 终态', async () => {
    const session = sessionModule.Session.create(dir)
    writeFileSync(join(dir, 'c1.ts'), 'x\n', 'utf8')
    // 裸写（writeFileSync）动了盘上文件，「先读后写」守卫要求先用 read 工具登记台账。
    await fsTools.readTool.run({ path: 'c1.ts' }, contextOf(session))
    const first = await fsTools.editTool.run({ path: 'c1.ts', old: 'x', new: 'xx' }, contextOf(session))
    if (typeof first !== 'string' && first.changes !== undefined) {
      session.recordTurnChange(first.changes.path, first.changes.baseline ?? '')
    }
    const second = await fsTools.editTool.run({ path: 'c1.ts', old: 'xx', new: 'xxx' }, contextOf(session))
    if (typeof second !== 'string' && second.changes !== undefined) {
      // 第二次记录的基线必须被忽略：要的是回合起点，不是这一刀的起点。
      session.recordTurnChange(second.changes.path, second.changes.baseline ?? '')
    }
    const merged = await session.takeTurnChanges()
    expect(merged).toHaveLength(1)
    expect(merged[0]?.added).toBe(1)
    expect(merged[0]?.removed).toBe(1)
    session.close()
  })

  test('close() 清空回合基线', async () => {
    const session = sessionModule.Session.create(dir)
    const w = await fsTools.writeTool.run({ path: 'd1.ts', content: 'z\n' }, contextOf(session))
    if (typeof w !== 'string' && w.changes !== undefined) {
      session.recordTurnChange(w.changes.path, w.changes.baseline ?? '')
    }
    session.close()
    expect(await session.takeTurnChanges()).toHaveLength(0)
  })

  test('jsonl 的 tool 记录不带 baseline（改前全文不许进日志）', async () => {
    const session = sessionModule.Session.create(dir)
    const w = await fsTools.writeTool.run({ path: 'e1.ts', content: 'hi\n' }, contextOf(session))
    appendToolOutput(session, 'c9', 'write', w)
    session.close()
    // 写流是异步的：等盘上真的出现这条 tool 记录再读，而不是固定睡一觉。
    expect(await until(() => readFileSync(session.filePath, 'utf8').includes('"type":"tool"'))).toBe(true)
    expect(readFileSync(session.filePath, 'utf8')).not.toContain('baseline')
  })
})

describe('③ 整轮：收尾只发一次 turn/diff，且逐刀事件照发', () => {
  /** 每一轮用一个新文件：`write` 对已存在文件有「先读后写」守卫，复用名字会让轮次红错地方。 */
  let round = 0

  /** 一个真 MiniAgent：假 stream 第一轮吐两个写调用（同文件两刀），第二轮收尾。 */
  async function runLoop(): Promise<{ events: CoreEvent[]; session: Session }> {
    round += 1
    const name = `loop-${String(round)}.txt`
    const session = sessionModule.Session.create(dir)
    const events: CoreEvent[] = []
    let modelCalls = 0
    const agent = new loopModule.MiniAgent(
      {
        route: () => ({ api: 'test', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm' }),
        systemPrompt: () => ({ text: '', sections: [] }),
        tools: () => [fsTools.writeTool, fsTools.editTool],
        guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
        emit: (event: CoreEvent) => events.push(event),
        stream: async () => {
          modelCalls += 1
          if (modelCalls === 1) {
            return {
              text: '',
              reasoning: '',
              toolCalls: [
                { id: 't1', name: 'write', arguments: JSON.stringify({ path: name, content: 'one\n' }) },
                { id: 't2', name: 'edit', arguments: JSON.stringify({ path: name, old: 'one', new: 'uno' }) },
              ],
              usage: null,
              finishReason: 'tool_calls',
            }
          }
          return { text: 'done', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
        },
      },
      session,
    )
    agent.followup('改文件')
    expect(await until(() => !agent.isRunning)).toBe(true)
    return { events, session }
  }

  test('整轮跑完发一次 turn/diff，内容两刀合一、全加、status=added、不带 baseline', async () => {
    const { events, session } = await runLoop()
    const turnDiff = events.filter((event) => event.type === 'turn/diff')
    expect(turnDiff).toHaveLength(1)
    const loopFile = turnDiff[0]?.files[0]
    expect(loopFile?.path.endsWith('.txt')).toBe(true)
    expect(loopFile?.added).toBe(1)
    expect(loopFile?.removed).toBe(0)
    expect(loopFile?.status).toBe('added')
    expect(Object.hasOwn(loopFile!, 'baseline')).toBe(false)
    session.close()
  })

  test('turn/diff 在 turn/end 之后到达（归轮口径依赖它）', async () => {
    const { events, session } = await runLoop()
    const types = events.map((event) => event.type)
    expect(types.indexOf('turn/end')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('turn/end')).toBeLessThan(types.indexOf('turn/diff'))
    session.close()
  })

  test('逐刀 tool/changes 事件照发（过程卡数据），且不带 baseline', async () => {
    const { events, session } = await runLoop()
    const perCut = events.filter((event) => event.type === 'tool/changes')
    expect(perCut.length).toBeGreaterThanOrEqual(1)
    for (const event of perCut) {
      if (event.type === 'tool/changes') expect(Object.hasOwn(event.change, 'baseline')).toBe(false)
    }
    session.close()
  })
})
