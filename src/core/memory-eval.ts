/**
 * 长期记忆的评估口径（对齐 codex 的「记忆使用账」，不做语义召回）。
 *
 * 本模块是**纯读数**：只吃一份已经算好的账（每条记忆被注入过几轮、被引用过几次），
 * 吐出一份人话报表与几个机器读数。它不读盘、不写盘、不认识文件系统——所以**零运行期
 * 依赖**（连 `import` 都没有），可以被探针按 Node 类型擦除直读。
 *
 * ## 与 codex 的对应关系
 *
 * codex 的记忆读路径是「注入 MEMORY.md + 在回话里引用」，它的账记在两处：
 *   - `codex-rs/state/src/runtime/memories.rs`：每条被引用（citation）的 thread
 *     让 `usage_count + 1`、`last_usage = now`；清理按
 *     `COALESCE(last_usage, source_updated_at) < max_unused_days`；选择排序按
 *     `usage_count DESC → COALESCE(last_usage, source_updated_at) DESC → source_updated_at DESC`。
 *   - `codex-rs/memories/read/src/citations.rs`：模型回话里 `<memory_citation>` 的
 *     `MEMORY.md:1-2|note=[x]` 是「这条记忆真被用上了」的唯一证据来源。
 *
 * dsc 的落点（一一对得上）：
 *   - codex 的 `usage_count` / `last_usage` → dsc `.usage.json` 里的 `count` / `last`
 *     （隐式引用计数，判据见 `plugins/memory.ts` 的 `recordTurnUsage`：条目前 12 字原文
 *     片段出现在最后一条 assistant 回话里）；
 *   - codex 的「读用遥测分类」`MemoriesUsageKind`（memory_md / memory_summary /
 *     raw_memories / rollout_summaries / skills）→ dsc 的三格 `target`
 *     （global / user / workspace），本模块的 `byTarget` 就是这层分类；
 *   - codex 的 `codex.memory.storage_bytes`（唯一在看的体量指标）→ `storageBytes`；
 *   - codex 的 phase-2 选择排序 → 本模块的 `ranking`（`citedCount DESC → lastCitedAt
 *     DESC → injectedTurns DESC → key`，把 codex 的 `source_updated_at` 这一档换成
 *     dsc 侧能观测的 `injectedTurns`）。
 *
 * `injectedTurns` 是 dsc 多出来的一维：条目**真的写进过提示词**的轮数（被行数/字符预算
 * 挤掉的不算）。codex 那边 MEMORY.md 是常量注入，没有这一维；dsc 有预算上限，需要它才能
 * 分清「模型见过但没引用」（死重）与「压根没进去过」（被预算挤掉）。
 *
 * ## 取舍：不做语义召回
 *
 * 对齐 codex：codex 没有语义召回，读路径就是「注入 + 回话引用」。所以本模块**不做**
 * embedding / 相似度召回——那是 ZCode 的 Selector，在 dsc 里未接线，本任务不搬。
 *
 * ## 显式阈值（文档化口径，改这里就是改口径）
 *
 *   - `deadWeight`（死重）：`injectedTurns >= 3` 且 `citedCount === 0`。这就是 codex
 *     `usage_count = 0` 那批，正是清理的首选。
 *   - `coverage`（覆盖率）：健康线 `0.80`，及格线 `0.50`。
 *   - `citationRate`（引用率）：健康线 `0.50`，及格线 `0.20`。
 *   - `budgetRatio`（预算占用）：健康线 `0.90`；到这条线就压到 `watch`，注入栏快挤满了。
 *   - `grade`：
 *       `poor`    —— 任一及格线没到（`coverage < 0.50` 或 `citationRate < 0.20`）；
 *       `watch`   —— 没到任一健康线（`coverage < 0.80` 或 `citationRate < 0.50`），
 *                    或存在死重条目，或 `budgetRatio >= 0.90`；
 *       `healthy` —— 其余。
 *     空库（`entries === 0`）时 `coverage` / `citationRate` 记 1、无死重、无预算占用，
 *     结果就是 `healthy`——没有东西可评，不该报偏差。
 *
 * @module dsc/core/memory-eval
 */

/** 评估等级。三档，语义见文件头阈值表。 */
export type MemoryEvalGrade = 'healthy' | 'watch' | 'poor'

/** 一条记忆在本模块眼里的一行账。 */
export interface MemoryEvalEntry {
  /** 条目标识（dsc 里是 `.usage.json` 用的那枚指纹）。 */
  key: string
  /** 哪一格（对齐 codex 的 `MemoriesUsageKind` 分类）。 */
  target: string
  /** 条目正文（去类型前缀后的文本，UTF-8 字节数按它算）。 */
  text: string
  /** 被真的写进提示词的轮数（预算挤掉的不算）。 */
  injectedTurns: number
  /** 被引用的次数（对齐 codex 的 `usage_count`）。 */
  citedCount: number
  /** 最后一次被引用的时刻（毫秒；从没被引用过为 null，对齐 `last_usage`）。 */
  lastCitedAt: number | null
}

/** 一次评估吃进去的全部输入。 */
export interface MemoryEvalInput {
  /** 当前所有参与的记忆条目。 */
  entries: readonly MemoryEvalEntry[]
  /** 已经发生过的轮数（`uninjected` 只在它 > 0 时才有意义）。 */
  turns: number
  /** 注入栏已用字数（各格之和）。 */
  usedChars: number
  /** 注入栏字数上限（各格之和）。 */
  limitChars: number
  /** 多久没被引用算陈旧（天）——报表里只作为口径提示，不参与分档。 */
  pruneAfterDays: number
  /** 现在时刻（毫秒）。 */
  now: number
}

/** 单格（target）的读数。 */
export interface MemoryEvalPerTarget {
  target: string
  entries: number
  injectedEntries: number
  citedEntries: number
  /** 这一格里的死重条目 key（按 key 排序，便于比对）。 */
  deadWeight: string[]
  /** 这一格从没进过提示词的条目 key（`turns > 0` 时才有意义）。 */
  uninjected: string[]
  storageBytes: number
}

/** 一份完整的评估报表。 */
export interface MemoryEvalReport {
  /** 条目总数。 */
  entries: number
  /** 被注入过的条目数（`injectedTurns > 0`）。 */
  injectedEntries: number
  /** 被引用过的条目数（`citedCount > 0`）。 */
  citedEntries: number
  /** `injectedEntries / entries`；没有条目时按 1 记。 */
  coverage: number
  /** `citedEntries / injectedEntries`；注入数为 0（含空库）时按 1 记。 */
  citationRate: number
  /** 注入过 >= 3 轮、一次也没被引用的条目 key（清理首选）。 */
  deadWeight: string[]
  /** `turns > 0` 但从没进过提示词的条目 key（被预算挤掉）。 */
  uninjected: string[]
  /** `usedChars / limitChars`（夹在 0..1）。 */
  budgetRatio: number
  /** 条目正文 UTF-8 字节数合计（对齐 codex 的 `storage_bytes`）。 */
  storageBytes: number
  /** 分档结果。 */
  grade: MemoryEvalGrade
  /** 本次评估看到的轮数。 */
  turns: number
  /** 本次评估的时刻（毫秒）。 */
  now: number
  /** 该留 / 该先注入的排序（对齐 codex phase-2 选择的 ORDER BY）。 */
  ranking: string[]
  /** 每格读数（对齐 `MemoriesUsageKind` 的分类）。 */
  byTarget: MemoryEvalPerTarget[]
  /** 中文人话报表，每行一个读数。 */
  lines: string[]
}

/** 报表去掉 `lines` 之后的裸读数——落 `.eval.json` 用，下次算增量。 */
export type MemoryEvalReadings = Omit<MemoryEvalReport, 'lines'>

/** 文档化的阈值（与文件头注释同源）。 */
export const MEMORY_EVAL_THRESHOLDS = {
  deadWeightMinTurns: 3,
  coverageHealthy: 0.8,
  coveragePoor: 0.5,
  citationHealthy: 0.5,
  citationPoor: 0.2,
  budgetWatch: 0.9,
} as const

const GRADE_LABELS: Record<MemoryEvalGrade, string> = {
  healthy: '健康',
  watch: '留意',
  poor: '偏差',
}

/** target 的中文名（本模块零依赖，不 import core/memory 的 TARGET_LABELS，自带一份）。 */
const TARGET_LABELS: Record<string, string> = {
  global: '全局事实',
  user: '用户偏好',
  workspace: '本工作区',
}

/** 正文的 UTF-8 字节数。 */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 小数折成整数百分比。 */
function pct(value: number): string {
  return `${String(Math.round(value * 100))}%`
}

/** 分档：先判及格线（poor），再判健康线（watch），否则 healthy。 */
function gradeOf(coverage: number, citationRate: number, deadWeightCount: number, budgetRatio: number): MemoryEvalGrade {
  if (coverage < MEMORY_EVAL_THRESHOLDS.coveragePoor || citationRate < MEMORY_EVAL_THRESHOLDS.citationPoor) return 'poor'
  if (
    coverage < MEMORY_EVAL_THRESHOLDS.coverageHealthy ||
    citationRate < MEMORY_EVAL_THRESHOLDS.citationHealthy ||
    deadWeightCount > 0 ||
    budgetRatio >= MEMORY_EVAL_THRESHOLDS.budgetWatch
  ) {
    return 'watch'
  }
  return 'healthy'
}

/** 排序：对齐 codex phase-2 选择（count 优先，再看时间）。 */
function rankOf(entries: readonly MemoryEvalEntry[]): string[] {
  return [...entries]
    .sort(
      (a, b) =>
        b.citedCount - a.citedCount ||
        (b.lastCitedAt ?? 0) - (a.lastCitedAt ?? 0) ||
        b.injectedTurns - a.injectedTurns ||
        a.key.localeCompare(b.key),
    )
    .map((entry) => entry.key)
}

/** 一条条目算不算死重。 */
function isDeadWeight(entry: MemoryEvalEntry): boolean {
  return entry.injectedTurns >= MEMORY_EVAL_THRESHOLDS.deadWeightMinTurns && entry.citedCount === 0
}

/**
 * 评一次长期记忆。
 *
 * @param input - 账与额度现状（见 {@link MemoryEvalInput}）。
 */
export function evaluateMemory(input: MemoryEvalInput): MemoryEvalReport {
  const entries = [...input.entries]
  const total = entries.length
  const injected = entries.filter((entry) => entry.injectedTurns > 0)
  const cited = entries.filter((entry) => entry.citedCount > 0)
  const coverage = total === 0 ? 1 : injected.length / total
  const citationRate = injected.length === 0 ? 1 : cited.length / injected.length
  const deadWeight = entries.filter(isDeadWeight).map((entry) => entry.key).sort()
  const uninjected = input.turns > 0 ? entries.filter((entry) => entry.injectedTurns === 0).map((entry) => entry.key).sort() : []
  const budgetRatio = input.limitChars <= 0 ? 0 : Math.min(1, Math.max(0, input.usedChars / input.limitChars))
  const storageBytes = entries.reduce((sum, entry) => sum + utf8Bytes(entry.text), 0)
  const grade = gradeOf(coverage, citationRate, deadWeight.length, budgetRatio)

  const targets: string[] = []
  for (const entry of entries) if (!targets.includes(entry.target)) targets.push(entry.target)
  const byTarget: MemoryEvalPerTarget[] = targets.map((target) => {
    const subset = entries.filter((entry) => entry.target === target)
    return {
      target,
      entries: subset.length,
      injectedEntries: subset.filter((entry) => entry.injectedTurns > 0).length,
      citedEntries: subset.filter((entry) => entry.citedCount > 0).length,
      deadWeight: subset.filter(isDeadWeight).map((entry) => entry.key).sort(),
      uninjected: input.turns > 0 ? subset.filter((entry) => entry.injectedTurns === 0).map((entry) => entry.key).sort() : [],
      storageBytes: subset.reduce((sum, entry) => sum + utf8Bytes(entry.text), 0),
    }
  })

  const lines: string[] = [
    `条目 ${String(total)} 条`,
    `注入 ${String(injected.length)} 条`,
    `引用 ${String(cited.length)} 条`,
    `覆盖率 ${pct(coverage)}`,
    `引用率 ${pct(citationRate)}`,
    `死重 ${String(deadWeight.length)} 条${deadWeight.length === 0 ? '' : `：${deadWeight.join(' ')}`}`,
    `未注入 ${String(uninjected.length)} 条${uninjected.length === 0 ? '' : `：${uninjected.join(' ')}`}`,
    `预算占用 ${pct(budgetRatio)}`,
    `体量 ${String(storageBytes)} 字节`,
    `等级 ${GRADE_LABELS[grade]}`,
  ]
  for (const cell of byTarget) {
    lines.push(`${TARGET_LABELS[cell.target] ?? cell.target}：${String(cell.entries)} 条 / 注入 ${String(cell.injectedEntries)} / 引用 ${String(cell.citedEntries)}`)
  }

  return {
    entries: total,
    injectedEntries: injected.length,
    citedEntries: cited.length,
    coverage,
    citationRate,
    deadWeight,
    uninjected,
    budgetRatio,
    storageBytes,
    grade,
    turns: input.turns,
    now: input.now,
    ranking: rankOf(entries),
    byTarget,
    lines,
  }
}

/** 抽出报表里可落盘的裸读数（去掉 `lines`）。 */
export function readingsOf(report: MemoryEvalReport): MemoryEvalReadings {
  const { lines: _lines, ...rest } = report
  return rest
}

/** 带符号的整数增量。 */
function signed(value: number): string {
  return value >= 0 ? `+${String(value)}` : String(value)
}

/** 带符号的百分比点增量。 */
function signedPct(value: number): string {
  return `${value >= 0 ? '+' : '-'}${pct(Math.abs(value))}`
}

/**
 * 把报表折成给用户看的多行文本。
 *
 * @param report - 本次报表。
 * @param previous - 上一次的裸读数；给了就在末尾逐项列增量（这就是「A-B / 两次评估对比」的口径）。
 */
export function formatMemoryReport(report: MemoryEvalReport, previous?: MemoryEvalReadings): string {
  const head = `记忆评估：${GRADE_LABELS[report.grade]}（${report.grade}）`
  const body = [head, ...report.lines].join('\n')
  if (previous === undefined) return body
  const gradeLine =
    report.grade === previous.grade
      ? `等级 ${GRADE_LABELS[report.grade]}（不变）`
      : `等级 ${GRADE_LABELS[report.grade]}（上次 ${GRADE_LABELS[previous.grade]}）`
  const delta = [
    `条目 ${String(report.entries)}（${signed(report.entries - previous.entries)}）`,
    `注入 ${String(report.injectedEntries)}（${signed(report.injectedEntries - previous.injectedEntries)}）`,
    `引用 ${String(report.citedEntries)}（${signed(report.citedEntries - previous.citedEntries)}）`,
    `覆盖率 ${pct(report.coverage)}（${signedPct(report.coverage - previous.coverage)}）`,
    `引用率 ${pct(report.citationRate)}（${signedPct(report.citationRate - previous.citationRate)}）`,
    `死重 ${String(report.deadWeight.length)}（${signed(report.deadWeight.length - previous.deadWeight.length)}）`,
    `未注入 ${String(report.uninjected.length)}（${signed(report.uninjected.length - previous.uninjected.length)}）`,
    `预算占用 ${pct(report.budgetRatio)}（${signedPct(report.budgetRatio - previous.budgetRatio)}）`,
    `体量 ${String(report.storageBytes)} 字节（${signed(report.storageBytes - previous.storageBytes)}）`,
    gradeLine,
  ]
  return `${body}\n\n与上次相比：\n${delta.map((line) => `  ${line}`).join('\n')}`
}
