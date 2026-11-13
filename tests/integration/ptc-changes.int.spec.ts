/**
 * PTC 里写文件的改动必须留痕（迁自 `scripts/ptc-changes-test.mjs`）。
 *
 * ## 报障回顾
 *
 * 用户报「会话底部不出『文件已更改』卡」。根因是 `run_code` 内部调 `sdk.write` 时，工具
 * 返回的 changes（改了哪个文件、增删几行、改前全文）被 PTC 丢了，只剩文本。于是三件事
 * 一起坏：没有 `tool/changes` 事件 → 轮尾卡不出现；没有回合基线 → 聚合 diff 也没有；
 * 非 git 工作区连兜底都没有。
 *
 * ## 钉什么
 *
 *   ① `run_code` 的返回值带上 `changesList`，元素里带 `baseline`（回合基线要用）；
 *   ② 落盘时 changes 写数组，重开会话读回来还是数组（老日志的单值形状也认）；
 *   ③ 一次脚本改两个文件 → 两条都在；同文件两刀 → 聚合只有一条；
 *   ④ 落盘记录里没有 baseline（内存字段不外泄）。
 *
 * ## 为什么这条要起真内核
 *
 * `run_code` 是 PTC 模式里真实注册的那条工具，它的返回值形状、`sdk.write` 的 changes
 * 产出、会话 `appendTool` 的落盘剥字段，是三处真实代码连起来才成立的。用假 tools 造
 * 一个 changesList 只能验本测试自己的夹具。
 *
 * ## 迁移差异
 *
 * - 落盘等待从固定 300ms 换成「等到文件里出现这条记录」（慢机器上固定 sleep 会把
 *   「还在写」读成「没写」，正是本文件要盯的那类假失败）；
 * - 工作目录用 `tempRepo()`：内核对 git 工作区的读走进程 cwd，跑在仓库本体里会把别人
 *   未提交的改动算进来。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { FileChangeSummary } from '@pneuma/runtime/core/tools.js'
import { bootKernel, fakeLLM, tempHome, tempRepo, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录：会话文件与锁都在里面。 */
const home = tempHome('dsc-ptc-changes-')
/** 临时 git 工作区：脚本写文件、会话记 cwd 都用它。 */
const repo = tempRepo('dsc-ptc-changes-repo-')
/** 脚本写文件的目录（真盘，`sdk.write` 要真的落）。 */
const work = join(repo.dir, 'ws')

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface PtcOutput {
  text: string
  changesList?: FileChangeSummary[]
}

interface ToolEntry {
  name: string
  run(args: Record<string, unknown>, ctx: unknown): Promise<unknown>
}

interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  fileChanges: Map<string, FileChangeSummary[]>
  appendTool(callId: string, name: string, output: { text: string; changes?: FileChangeSummary | FileChangeSummary[] }, error?: string): void
  recordTurnChange(path: string, baseline: string): void
  takeTurnChanges(): Promise<FileChangeSummary[]>
}

interface Services {
  session: { current(): SessionView }
  tools: { list(): ToolEntry[] }
}

type SessionModule = typeof import('@pneuma/runtime/core/session.js')

let llm: FakeLLM
let kernel: BootedKernel
let services: Services
let sessionModule: SessionModule
/** `run_code` 工具（PTC 模式那条）。 */
let runCode: ToolEntry

/** 一次工具调用的上下文（会话身份与工作目录）。 */
function runCtx(): { cwd: string; signal: AbortSignal; sessionId: string; sessionPath: string } {
  return {
    cwd: work,
    signal: new AbortController().signal,
    sessionId: services.session.current().meta.id,
    sessionPath: services.session.current().filePath,
  }
}

/** 跑一段 PTC 脚本，返回结构化结果。 */
async function runScript(code: string): Promise<PtcOutput> {
  return (await runCode.run({ code }, runCtx())) as PtcOutput
}

/** 等文件里出现某个标记（写流是异步的，固定 sleep 在慢机器上会读早）。 */
async function untilFileHas(filePath: string, needle: string): Promise<void> {
  const deadline = Date.now() + 8_000
  for (;;) {
    const text = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
    if (text.includes(needle)) return
    if (Date.now() > deadline) throw new Error(`等到 ${deadline} 也没在 ${filePath} 里看到 ${needle}`)
    await new Promise((resolveTick) => setTimeout(resolveTick, 40))
  }
}

beforeAll(async () => {
  mkdirSync(work, { recursive: true })
  sessionModule = await import('@pneuma/runtime/core/session.js')
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  services = kernel.ctx as unknown as Services
  runCode = services.tools.list().find((entry) => entry.name === 'run_code') as ToolEntry
})

afterAll(async () => {
  repo.restore()
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

describe('① 脚本里写两个文件：改动随结果交回，带 baseline', () => {
  /** 本段脚本的返回值（后面几节都要读它）。 */
  let two: PtcOutput

  beforeAll(async () => {
    two = await runScript(
      [
        "const a = await sdk.write({ path: 'a.txt', content: 'one\\ntwo\\n' })",
        "const b = await sdk.write({ path: 'b.txt', content: 'hello\\n' })",
        'return a + b',
      ].join('\n'),
    )
  })

  test('PTC 模式里拿得到 run_code', () => {
    expect(runCode).toBeDefined()
  })

  test('返回里带 changesList（不再是纯字符串）', () => {
    expect(Array.isArray(two.changesList)).toBe(true)
  })

  test('两个文件都在清单里', () => {
    expect(two.changesList).toHaveLength(2)
  })

  test('路径是绝对路径', () => {
    expect((two.changesList ?? []).every((change) => typeof change.path === 'string' && change.path.startsWith(work))).toBe(true)
  })

  test('新建文件 status=added，且带了改前全文（新建时是空串）', () => {
    expect((two.changesList ?? []).every((change) => change.status === 'added')).toBe(true)
    expect((two.changesList ?? []).every((change) => change.baseline === '')).toBe(true)
  })

  test('a.txt 的增行数是 2', () => {
    expect((two.changesList ?? []).some((change) => change.path.endsWith('a.txt') && change.added === 2)).toBe(true)
  })

  describe('② 交给会话：落盘写数组，重开读回来还是数组', () => {
    /** 第一次 `appendTool` 用的 callId。 */
    const CALL = 'call-ptc-1'

    beforeAll(async () => {
      const current = services.session.current()
      // 模拟循环那一侧：先记回合基线，再把剥过 baseline 的清单塞进 tool 记录。
      for (const change of two.changesList ?? []) current.recordTurnChange(change.path, change.baseline ?? '')
      const clean = (two.changesList ?? []).map(({ baseline: _baseline, ...rest }) => rest as FileChangeSummary)
      current.appendTool(CALL, 'run_code', { text: two.text, changes: clean })
      await untilFileHas(current.filePath, CALL)
    })

    test('落盘的 tool 记录里 changes 是数组（老读者按数组解析）', () => {
      const raw = readFileSync(services.session.current().filePath, 'utf8')
      const line = raw.split('\n').find((item) => item.includes(`"callId":"${CALL}"`))
      expect(line).toBeDefined()
      const record = JSON.parse(line ?? '{}') as { changes?: unknown }
      expect(Array.isArray(record.changes)).toBe(true)
    })

    test('落盘记录里没有 baseline（内存字段不外泄）', () => {
      expect(readFileSync(services.session.current().filePath, 'utf8')).not.toContain('"baseline"')
    })

    test('重开会话后 changes 仍是两条', () => {
      const reopened = sessionModule.Session.load(services.session.current().filePath, true, { lease: false })
      const back = reopened.fileChanges.get(CALL) ?? []
      expect(back).toHaveLength(2)
      reopened.close()
    })

    test('读回来的元素不带 baseline', () => {
      const reopened = sessionModule.Session.load(services.session.current().filePath, true, { lease: false })
      const back = reopened.fileChanges.get(CALL) ?? []
      expect(back.every((change) => !Object.hasOwn(change, 'baseline'))).toBe(true)
      reopened.close()
    })

    test('聚合后两个文件两条，且聚合产物也不带 baseline', async () => {
      const files = await services.session.current().takeTurnChanges()
      expect(files).toHaveLength(2)
      expect(files.every((change) => !Object.hasOwn(change, 'baseline'))).toBe(true)
    })
  })

  describe('③ 同一文件两刀：聚合只出一条，diff 是「起点 vs 终态」', () => {
    /** 聚合之后的改动清单。 */
    let files: FileChangeSummary[]

    beforeAll(async () => {
      const current = services.session.current()
      const one = await runScript("await sdk.write({ path: 'c.txt', content: 'x\\n' }); return 'ok'")
      for (const change of one.changesList ?? []) current.recordTurnChange(change.path, change.baseline ?? '')
      const again = await runScript("await sdk.edit({ path: 'c.txt', old: 'x', new: 'y\\nz' }); return 'ok'")
      for (const change of again.changesList ?? []) current.recordTurnChange(change.path, change.baseline ?? '')
      files = await current.takeTurnChanges()
    })

    test('同文件两刀只出一条', () => {
      expect(files).toHaveLength(1)
    })

    test('终态两行（y 与 z）、无删除', () => {
      const target = files.find((change) => change.path.endsWith('c.txt'))
      expect(target?.added).toBe(2)
      expect(target?.removed).toBe(0)
    })
  })
})

describe('④ 老日志的单值形状照旧读得懂', () => {
  test('手写的单值 changes 被归一成一条清单', async () => {
    const dir = join(home.home, 'legacy-ws')
    mkdirSync(dir, { recursive: true })
    const legacy = sessionModule.Session.create(dir)
    const summary: FileChangeSummary = { path: join(dir, 'old.txt'), added: 1, removed: 0, hunks: [], status: 'added' }
    // 老版本写的是单值：这里直接调 appendTool 的「传一个对象」分支，看读回来会不会被当成
    // 「不是数组」丢掉。
    legacy.appendTool('call-old', 'write', { text: 'ok', changes: summary })
    await untilFileHas(legacy.filePath, 'call-old')
    legacy.close()

    const reopened = sessionModule.Session.load(legacy.filePath, true, { lease: false })
    const back = reopened.fileChanges.get('call-old') ?? []
    expect(back).toHaveLength(1)
    expect(back[0]?.path).toBe(summary.path)
    reopened.close()
  })
})
