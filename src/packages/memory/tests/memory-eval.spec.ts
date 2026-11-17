/**
 * 长期记忆评估的单元测试（迁自 `scripts/memory-eval-test.mjs` 的 A、B 两段）。
 *
 * ## 钉什么
 *
 * A. `memory-eval.ts` 是零依赖的纯模块：空库、全被引用、全死重、被预算挤掉、grade 三档
 *    边界、UTF-8 字节数、排序口径（count 优先再看时间）、报表增量行。这些数一旦漂，
 *    症状是「记忆评估一直说健康」——没有报错，只有一直不提醒。
 * B. 账本（`memory.ts` 的 usage/eval/prune）：每条引用 +1、`last` 更新、注入维独立于引用维、
 *    老 `.usage.json` 向后兼容、清理「只移不删」且没被引用的优先被移。
 *
 * ## C 段（真回合注入计数）为什么不在这里
 *
 * 那段要起真内核、跑真回合、看假端点收到几次请求，属于 `tests/integration/memory-eval.int.spec.ts`。
 * 本文件只碰纯函数与文件 I/O，unit 层 5 秒预算够用，也不需要 build。
 *
 * ## 隔离
 *
 * A 段不需要主目录；B 段的账本路径由 `dscPath` 在 import 期算定，所以先 `tempHome()`
 * 再动态 import `memory.ts`。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  evaluateMemory,
  formatMemoryReport,
  readingsOf,
  type MemoryEvalEntry,
  type MemoryEvalInput,
} from '../memory-eval.js'
import { tempHome } from '../../../../tests/harness.js'

/** 临时主目录：B 段的账本与归档都落在这里。 */
const home = tempHome('dsc-memory-eval-spec-')

type MemoryModule = typeof import('../memory.js')
let memory: MemoryModule

beforeAll(async () => {
  memory = await import('../memory.js')
})

afterAll(() => {
  home.restore()
})

/** 造一条评估条目（缺省「从没被引用过」）。 */
function entry(
  key: string,
  target: string,
  text: string,
  injectedTurns: number,
  citedCount: number,
  lastCitedAt: number | null = null,
): MemoryEvalEntry {
  return { key, target, text, injectedTurns, citedCount, lastCitedAt }
}

/** 造一份评估输入（缺省：零轮、零预算占用、100 字上限）。 */
function input(entries: readonly MemoryEvalEntry[], extra: Partial<MemoryEvalInput> = {}): MemoryEvalInput {
  return {
    entries,
    turns: 0,
    usedChars: 0,
    limitChars: 100,
    pruneAfterDays: 60,
    now: 1_700_000_000_000,
    ...extra,
  }
}

describe('A 纯模块：evaluateMemory', () => {
  test('空库：健康、覆盖率与引用率都记 1、体量与预算都是 0', () => {
    const empty = evaluateMemory(input([]))
    expect(empty.grade).toBe('healthy')
    expect(empty.coverage).toBe(1)
    expect(empty.citationRate).toBe(1)
    expect(empty.storageBytes).toBe(0)
    expect(empty.budgetRatio).toBe(0)
    expect(empty.deadWeight).toEqual([])
    expect(empty.uninjected).toEqual([])
  })

  test('全部被引用：健康、无死重', () => {
    const allCited = evaluateMemory(
      input([entry('a', 'global', '事实甲', 2, 3, 100), entry('b', 'user', '偏好乙', 1, 1, 200)]),
    )
    expect(allCited.grade).toBe('healthy')
    expect(allCited.coverage).toBe(1)
    expect(allCited.citationRate).toBe(1)
    expect(allCited.deadWeight).toEqual([])
  })

  test('全部死重（注入够多但一次没被引用）：poor，都进 deadWeight', () => {
    const allDead = evaluateMemory(input([entry('d1', 'global', '死重一', 3, 0), entry('d2', 'global', '死重二', 9, 0)]))
    expect(allDead.grade).toBe('poor')
    expect(allDead.citationRate).toBe(0)
    expect(allDead.deadWeight).toEqual(['d1', 'd2'])
  })

  test('被预算挤掉（turns>0 却从没进过提示词）：进 uninjected，coverage 打折', () => {
    const squeezed = evaluateMemory(
      input([entry('in1', 'global', '进过提示词', 1, 0), entry('out1', 'global', '被挤掉', 0, 0)], { turns: 1 }),
    )
    expect(squeezed.uninjected).toEqual(['out1'])
    expect(squeezed.coverage).toBe(0.5)
  })

  test('turns=0 时 uninjected 为空（负向锚点：轮还没发生就不判「未注入」）', () => {
    const noTurns = evaluateMemory(
      input([entry('in1', 'global', '进过提示词', 1, 0), entry('out1', 'global', '被挤掉', 0, 0)], { turns: 0 }),
    )
    expect(noTurns.uninjected).toEqual([])
  })

  test('grade 边界：coverage 0.5 → watch，0.8 → healthy', () => {
    const covHalf = evaluateMemory(input([entry('x1', 'global', '甲', 1, 1, 1), entry('x2', 'global', '乙', 0, 0)]))
    expect(covHalf.coverage).toBe(0.5)
    expect(covHalf.grade).toBe('watch')
    const covFull = evaluateMemory(
      input([
        entry('y1', 'global', '甲', 1, 1, 1),
        entry('y2', 'global', '乙', 1, 1, 1),
        entry('y3', 'global', '丙', 1, 1, 1),
        entry('y4', 'global', '丁', 1, 1, 1),
        entry('y5', 'global', '戊', 0, 0),
      ]),
    )
    expect(covFull.coverage).toBe(0.8)
    expect(covFull.grade).toBe('healthy')
  })

  test('grade 边界：citationRate 0.2 → watch，0.5 → healthy', () => {
    const citeFifth = evaluateMemory(
      input(['a', 'b', 'c', 'd', 'e'].map((key, index) => entry(key, 'global', `条目${key}`, 1, index === 0 ? 1 : 0, index === 0 ? 9 : null))),
    )
    expect(citeFifth.citationRate).toBeCloseTo(0.2, 10)
    expect(citeFifth.grade).toBe('watch')
    const citeHalf = evaluateMemory(
      input(['a', 'b', 'c', 'd'].map((key, index) => entry(key, 'global', `条目${key}`, 1, index < 2 ? 1 : 0, index < 2 ? 9 : null))),
    )
    expect(citeHalf.citationRate).toBe(0.5)
    expect(citeHalf.grade).toBe('healthy')
  })

  test('grade 边界：budgetRatio 0.9 → watch，0.89 → 仍 healthy（负向锚点）', () => {
    const budgetLow = evaluateMemory(input([entry('b1', 'global', '甲', 1, 1, 1)], { usedChars: 89, limitChars: 100 }))
    const budgetEdge = evaluateMemory(input([entry('b1', 'global', '甲', 1, 1, 1)], { usedChars: 90, limitChars: 100 }))
    expect(budgetEdge.budgetRatio).toBe(0.9)
    expect(budgetEdge.grade).toBe('watch')
    expect(budgetLow.grade).toBe('healthy')
  })

  test('死重边界：注入满 3 轮没引用才算，2 轮不算', () => {
    const deadEdge = evaluateMemory(input([entry('e3', 'global', '三次', 3, 0), entry('e2', 'global', '两次', 2, 0)]))
    expect(deadEdge.deadWeight).toEqual(['e3'])
  })

  test('体量按 UTF-8 字节算（两个中文 + 三个 ASCII = 9 字节）', () => {
    const utf = evaluateMemory(input([entry('u1', 'global', '中文abc', 1, 1, 1)]))
    expect(utf.storageBytes).toBe(9)
    expect(utf.storageBytes).toBe(Buffer.byteLength('中文abc', 'utf8'))
  })

  test('排序：count 优先，同 count 时 lastCitedAt 新的排前（含负向锚点）', () => {
    const ranked = evaluateMemory(
      input([entry('lo', 'global', '低', 1, 1, 999), entry('hiOld', 'global', '高旧', 1, 5, 100), entry('hiNew', 'global', '高新', 1, 5, 500)]),
    )
    expect(ranked.ranking).toEqual(['hiNew', 'hiOld', 'lo'])
    // 把 hiNew 的时间改小，顺序必须翻转——否则上面那条比的是 insertion 顺序而不是时间。
    const flipped = evaluateMemory(
      input([entry('lo', 'global', '低', 1, 1, 999), entry('hiOld', 'global', '高旧', 1, 5, 500), entry('hiNew', 'global', '高新', 1, 5, 100)]),
    )
    expect(flipped.ranking.slice(0, 2)).toEqual(['hiOld', 'hiNew'])
  })

  test('byTarget 分格读数（条目 / 注入 / 引用 / 死重）', () => {
    const perTarget = evaluateMemory(
      input([entry('g1', 'global', '甲', 1, 1, 1), entry('g2', 'global', '乙', 3, 0), entry('u1', 'user', '丙', 1, 1, 1)]),
    )
    const global = perTarget.byTarget.find((cell) => cell.target === 'global')
    const user = perTarget.byTarget.find((cell) => cell.target === 'user')
    expect(perTarget.byTarget).toHaveLength(2)
    expect(global).toMatchObject({ entries: 2, injectedEntries: 2, citedEntries: 1, deadWeight: ['g2'] })
    expect(user).toMatchObject({ entries: 1, citedEntries: 1 })
  })

  test('lines 是人话：等级与覆盖率都用中文读数', () => {
    const { lines } = evaluateMemory(input([]))
    expect(lines).toContain('等级 健康')
    expect(lines).toContain('覆盖率 100%')
  })
})

describe('A 纯模块：formatMemoryReport / readingsOf', () => {
  test('没有上次读数时不出现对比段', () => {
    expect(formatMemoryReport(evaluateMemory(input([])))).not.toContain('与上次相比')
  })

  test('有上次读数时逐项给增量（条目 / 引用 / 覆盖率）', () => {
    const previous = readingsOf(evaluateMemory(input([entry('a', 'global', '甲', 0, 0)], { turns: 1 })))
    const current = evaluateMemory(input([entry('a', 'global', '甲', 1, 1, 1), entry('b', 'global', '乙', 1, 1, 1)]))
    const report = formatMemoryReport(current, previous)
    expect(report).toContain('与上次相比')
    expect(report).toContain('条目 2（+1）')
    expect(report).toContain('引用 2（+2）')
    expect(report).toContain('覆盖率 100%（+100%）')
  })

  test('等级变化行给出上次档位', () => {
    const current = evaluateMemory(input([entry('a', 'global', '甲', 1, 1, 1), entry('b', 'global', '乙', 1, 1, 1)]))
    const previousWatch = { ...readingsOf(current), grade: 'watch' as const }
    expect(formatMemoryReport(current, previousWatch)).toContain('等级 健康（上次 留意）')
  })

  test('readingsOf 去掉 lines，只留读数', () => {
    const readings = readingsOf(evaluateMemory(input([entry('a', 'global', '甲', 0, 0)], { turns: 1 })))
    expect('lines' in readings).toBe(false)
    expect(readings.entries).toBe(1)
  })
})

describe('B 账本：引用与注入两维独立', () => {
  /** 这一组用例共用的锚点 key。 */
  const KEY = 'ledger-anchor-key'

  test('每条引用 +1，再引用一次 count=2 且 last 更新', () => {
    memory.bumpUsage([KEY], 1000)
    expect(memory.readUsage()[KEY]?.count).toBe(1)
    memory.bumpUsage([KEY], 2000)
    expect(memory.readUsage()[KEY]).toMatchObject({ count: 2, last: 2000 })
  })

  test('注入累加 injected 且记 lastInjected，但不动引用维（负向锚点）', () => {
    memory.bumpInjected([KEY], 3000)
    const record = memory.readUsage()[KEY]
    expect(record).toMatchObject({ injected: 1, lastInjected: 3000 })
    // 注入不是引用：动了 count/last，清理就会把「只是被注入」的当成被引用过而留下。
    expect(record?.count).toBe(2)
    expect(record?.last).toBe(2000)
  })

  test('老账文件（缺 injected）读成 0，且下一次记账不抹掉 count/last', () => {
    writeFileSync(memory.usageFile(), JSON.stringify({ legacy: { count: 2, last: 5 } }), 'utf8')
    expect(memory.readUsage()['legacy']?.injected).toBe(0)
    memory.bumpInjected(['legacy'], 7)
    expect(memory.readUsage()['legacy']).toMatchObject({ injected: 1, count: 2, last: 5 })
  })
})

describe('B 账本：评估读数文件与清理', () => {
  test('evalFile 落在 memory 目录下的 .eval.json，缺文件回 null，写读往返一致', () => {
    expect(memory.evalFile().endsWith(join('memory', '.eval.json'))).toBe(true)
    rmSync(memory.evalFile(), { force: true })
    expect(memory.readEval()).toBeNull()
    memory.writeEval({ entries: 5, grade: 'watch' })
    expect(memory.readEval()).toMatchObject({ entries: 5, grade: 'watch' })
  })

  test('清理：被引用过的留下、没被引用的移走、且只移不删（归档里找得到）', () => {
    const workspace = join(home.home, 'wsprune')
    mkdirSync(workspace, { recursive: true })
    const KEEP = '被引用过的条目'
    const DROP = '从没被引用的条目'
    const cellFile = memory.memoryFileOf('workspace', workspace)
    mkdirSync(dirname(cellFile), { recursive: true })
    writeFileSync(cellFile, `${KEEP}\n§\n${DROP}\n`, 'utf8')
    const usage = { [memory.entryUsageKey('workspace', KEEP)]: { count: 3, last: Date.now() - 100_000 } }
    // now 取在文件 mtime 之后一点：afterDays=0 下没被引用过的必被判陈旧，避免毫秒级赛跑。
    const pruned = memory.pruneCells(
      workspace,
      memory.MEMORY_LIMIT_DEFAULTS,
      { global: false, user: false, workspace: true },
      { afterDays: 0, now: Date.now() + 1000, usage },
    )
    const after = memory.splitEntries(readFileSync(cellFile, 'utf8'))
    expect(after).toContain(KEEP)
    expect(after).not.toContain(DROP)
    expect(pruned.moved.workspace).toContain(DROP)
    const archive = memory.archiveFileOf('workspace', workspace)
    const archived = existsSync(archive) ? memory.splitEntries(readFileSync(archive, 'utf8')) : []
    expect(archived).toContain(DROP)
    expect(archived).not.toContain(KEEP)
  })
})
