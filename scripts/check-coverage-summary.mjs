#!/usr/bin/env node
/**
 * 覆盖率汇总自检（B54-①）：报告产出了，但一行都没测到，也要红。
 *
 * ## 为什么阈值拦不住
 *
 * `coverage.thresholds` 判的是「报告里出现的文件」。`coverage.include` 写错、`src/`
 * 改名、或者 glob 收窄到一个文件都匹配不到时，V8 收不到任何文件：
 * - 阈值一条都不下发——没有文件可比，Vitest 不认为失败；
 * - `coverage/coverage-summary.json` 照样写出来，total 全 0、pct 是 "Unknown"；
 * - 进程退出码 0，日志里连一行 `ERROR: Coverage for ...` 都没有。
 * 也就是说覆盖率门静默失效，CI 还挂着绿灯。2026-11-17 实测：
 * `vitest run --project unit --coverage --coverage.include='nope/**' tests/phone-commands.spec.ts`
 * 退出 0、零条阈值告警。
 *
 * ## 查什么
 *
 * 读 `coverage/coverage-summary.json` 的 `total`，lines / statements / functions / branches
 * 四个指标的 `covered` 必须都大于 0。文件不存在、不是合法 JSON、字段缺失或不合法，一律
 * 按红——「读不到报告」不能当成「覆盖率全绿」。只判 covered > 0，不判百分比：百分比门由
 * vitest 的 thresholds 负责，本脚本只补「一条阈值都没下发」这个盲区。
 *
 * ## 谁在跑
 *
 * `package.json` 的 `test:coverage` 在 vitest 之后用 `&&` 接这一段，所以本地也会拦；
 * CI 的覆盖率 job 另起一步（pnpm 会把追加参数拼到 script 串末尾，链式的 test:coverage
 * 接不住 `--reporter`，所以那边直接调 `test:coverage:run`，再单独跑本脚本）。
 *
 * 带参数跑覆盖率请用 `pnpm run test:coverage:run -- <参数>`：把参数跟在 test:coverage
 * 后面会被 pnpm 拼到本脚本上，vitest 拿不到。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 报告固定落在仓库根的 `coverage/`（vitest 的 coverage.reportsDirectory 默认值）。 */
const SUMMARY_FILE = fileURLToPath(new URL('../coverage/coverage-summary.json', import.meta.url))

/** 四个指标，顺序与 coverage-baseline.json 一致。 */
const METRICS = ['lines', 'statements', 'functions', 'branches']

/** 出错统一出口：逐条打印原因，置非 0 退出码。 */
function fail(reasons) {
  console.error('✗ 覆盖率自检：不通过')
  for (const reason of reasons) console.error(`  ${reason}`)
  process.exitCode = 1
}

/** 把任意值说成一小段人能读的字，报错用（与 vitest.config.ts 的 showValue 同一思路）。 */
function describe(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'object') return '对象'
  if (typeof value === 'string') return JSON.stringify(value)
  return `${typeof value} ${String(value)}`
}

/** 读并解析汇总文件；读不到 / 解析不了都直接判红，返回 null。 */
function readSummary() {
  let raw
  try {
    raw = readFileSync(SUMMARY_FILE, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (error instanceof Error && error.code === 'ENOENT') {
      fail([
        `没有覆盖率报告：找不到 ${SUMMARY_FILE}。`,
        '这说明这一轮根本没产出覆盖率（vitest 没带 --coverage、或者 coverage.reportsDirectory 被改了），',
        '不能当成「覆盖率全绿」，按红处理。',
      ])
    } else {
      fail([`读不了覆盖率报告：${SUMMARY_FILE}（${reason}）。`])
    }
    return null
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fail([`覆盖率报告不是合法 JSON：${SUMMARY_FILE}（${reason}）。`])
    return null
  }
}

function main() {
  const summary = readSummary()
  if (summary === null) return

  const total = summary.total
  if (typeof total !== 'object' || total === null || Array.isArray(total)) {
    fail([`字段非法：报告里的 total 应是对象，实际是 ${describe(total)}（${SUMMARY_FILE}）。`])
    return
  }

  /** 四个指标里 covered 为 0 的；只收 0，不判百分比。 */
  const empty = []
  /** 通过时打印的实况：每个指标 covered/total。 */
  const detail = []
  for (const metric of METRICS) {
    const row = total[metric]
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      fail([`字段非法：total.${metric} 应是对象，实际是 ${describe(row)}（${SUMMARY_FILE}）。`])
      return
    }
    const covered = row.covered
    if (typeof covered !== 'number' || !Number.isFinite(covered) || covered < 0) {
      fail([
        `字段非法：total.${metric}.covered 应是非负有限数字，实际是 ${describe(covered)}（${SUMMARY_FILE}）。`,
      ])
      return
    }
    const instrumented = typeof row.total === 'number' && Number.isFinite(row.total) ? row.total : null
    detail.push(`${metric} ${String(covered)}/${instrumented === null ? '?' : String(instrumented)}`)
    if (covered === 0) empty.push({ metric, instrumented })
  }

  if (empty.length > 0) {
    const reasons = ['覆盖率一行都没测到：']
    for (const { metric, instrumented } of empty) {
      reasons.push(
        instrumented === 0
          ? `total.${metric}：0 行进入统计（coverage.include 一个文件都没匹配到？）`
          : `total.${metric}：纳入 ${instrumented === null ? '?' : String(instrumented)} 行，执行 0 行`,
      )
    }
    reasons.push('这正是 B54-① 的盲区：没有文件可判时，vitest 的阈值一条都不会报错、退出码还是 0。')
    fail(reasons)
    return
  }

  console.log(`✓ 覆盖率自检：四个指标都有代码被执行（${detail.join('、')}）`)
}

main()
