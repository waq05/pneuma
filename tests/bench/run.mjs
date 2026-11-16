/**
 * 性能基准总入口：串起 B1-B4，每条跑 7 次取中位数，与 `baseline.json` 比。
 *
 * ## 为什么每条基准各起一个子进程
 *
 * 内核有大量模块级状态（`path-policy` 的 `DSC_HOME`、插件运行时的注册表、会话写租约），
 * 同一进程里连起两次内核不是支持路径。每条基准跑一次就退出，HOME 与模块实例都是干净的；
 * 代价是进程启动，但计时区间在子进程内部，启动开销不进测量值。
 *
 * ## 退化判据
 *
 * - 中位数 > 基线中位数 × 1.5 判退化（设计 §4.2 的四条线与 §13 风险 8 的「中位数抗抖」）；
 * - B4 额外看通知次数：合并失效时它会从 2 涨到 1000，比耗时更早暴露问题；
 * - 任一条跑不出结果（子进程非 0、没有结果行、值非正）也判失败，不拿半份数据写基线。
 *
 * ## 机器绑定
 *
 * 基线里记 `runner`（平台/核数/CPU 型号），与本次不一致时**只记录不判退化**
 * ——设计 §9.2 的「基线绑机器」。共享 CI runner 换代次后整体平移，硬比只会得到
 * 与代码无关的红。`--enforce` 可强制比较（自建固定 runner 的逃生门）。
 *
 * ## 首跑
 *
 * 基线不存在时：打印本次中位数、写入 `tests/bench/baseline.json`、退出 0，并提示
 * 「首跑建立基线，人审后提交」。这是刻意的——基线值必须经过人眼确认才进版本库，
 * 否则一次抖动就会被当成「正常」永久钉住。
 *
 * @module tests/bench/run
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { BENCH_DIR, REPO_ROOT, runBenchChild } from './helpers.mjs'

/** 每条基准的重复次数：7 次取中位数，单次抖动被中位数吃掉（odd 数量免插值）。 */
const RUNS = 7
/** 退化线：中位数超过基线的这个倍数就红。 */
const THRESHOLD = 1.5
/** 子进程上限：B1/B3 要起内核，给足 3 分钟；超时按失败处理，不静默挂住。 */
const CHILD_TIMEOUT_MS = 180_000
/** 基线文件名与 schema，改结构时一起升。 */
const BASELINE_FILE = join(BENCH_DIR, 'baseline.json')
const BASELINE_SCHEMA = 1

const BENCHES = [
  { id: 'b1-session-start', file: 'b1-session-start.mjs', label: 'B1 会话启动' },
  { id: 'b2-first-token', file: 'b2-first-token.mjs', label: 'B2 首 token 延迟' },
  { id: 'b3-compact', file: 'b3-compact.mjs', label: 'B3 压缩耗时' },
  { id: 'b4-stream-render', file: 'b4-stream-render.mjs', label: 'B4 流式渲染' },
]

/** 中位数；偶数个时取中间两个的均值（本仓只用奇数 7 次）。 */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** 把秒级小数统一到 3 位，避免基线里出现一长串浮点噪声。 */
function round(value) {
  return Math.round(value * 1000) / 1000
}

/** 跑一条基准 7 次；任何一次失败都抛，调用方决定是否继续跑别的条。 */
function measure(bench) {
  const samples = []
  for (let run = 1; run <= RUNS; run += 1) {
    process.stdout.write(`  ${bench.label}  第 ${run}/${RUNS} 次 … `)
    const result = runBenchChild(bench.file, REPO_ROOT, CHILD_TIMEOUT_MS)
    if (result.id !== bench.id) throw new Error(`结果 id 不匹配：期望 ${bench.id}，收到 ${String(result.id)}`)
    if (!Number.isFinite(result.value) || result.value <= 0) {
      throw new Error(`测量值不是正数（收到 ${String(result.value)}）`)
    }
    samples.push(result)
    console.log(`${result.value.toFixed(1)}ms`)
  }
  const values = samples.map((sample) => sample.value)
  return {
    samples,
    median: median(values),
    notifications:
      samples.every((sample) => sample.detail?.notifications === samples[0].detail?.notifications)
        ? samples[0].detail?.notifications
        : undefined,
  }
}

/** 当前机器的口径：基线只在固定 runner 上有意义，换机器要重录。 */
function environment() {
  const cpuList = cpus()
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: cpuList[0]?.model ?? 'unknown',
    cores: cpuList.length,
  }
}

/**
 * 机器身份（设计 §9.2「基线绑机器」的落地）：平台 + 核数 + CPU 型号。
 *
 * 为什么把 CPU 型号也带进来：同一台 CI runner 换代次后，纯耗时基线整体平移，
 * 拿旧基线判退化只会得到「每台共享 runner 都红」。型号一变就重录，是这套判据的前提。
 * 内存/磁盘不参与——它们只影响抖动幅度，不影响中位数的量级。
 */
function runnerId() {
  const env = environment()
  const model = env.cpu.replace(/\s+/g, ' ').trim()
  return `${env.platform}/${String(env.cores)}c/${model}`
}

/** 基线文档：只存中位数与结构性计数，不存每次样本，也不存任何临时路径。 */
function buildBaseline(measured) {
  const benchmarks = {}
  for (const bench of BENCHES) {
    const entry = measured.get(bench.id)
    benchmarks[bench.id] = {
      label: bench.label,
      metric: 'ms',
      median: round(entry.median),
      ...(entry.notifications === undefined ? {} : { notifications: entry.notifications }),
    }
  }
  return {
    schema: BASELINE_SCHEMA,
    note: '由 tests/bench/run.mjs 首跑写入；数值为本机 7 次中位数，人审后提交。',
    recordedAt: new Date().toISOString(),
    runner: runnerId(),
    environment: environment(),
    runs: RUNS,
    regressionRatio: THRESHOLD,
    benchmarks,
  }
}

function readBaseline() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  } catch (error) {
    throw new Error(`读不出基线 ${BASELINE_FILE}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed.schema !== BASELINE_SCHEMA) {
    throw new Error(`基线 schema 是 ${String(parsed.schema)}，期望 ${String(BASELINE_SCHEMA)}`)
  }
  if (parsed.benchmarks === null || typeof parsed.benchmarks !== 'object') {
    throw new Error('基线缺少 benchmarks 对象')
  }
  return parsed
}

/** 与基线逐条比；返回退化条数。 */
function compare(baseline, measured) {
  console.log('')
  console.log(`基线：${BASELINE_FILE}`)
  console.log(`录制：${String(baseline.recordedAt)}  node ${String(baseline.environment?.node)}  ${String(baseline.environment?.platform)}`)
  console.log('')
  let degraded = 0
  for (const bench of BENCHES) {
    const current = measured.get(bench.id)
    const saved = baseline.benchmarks[bench.id]
    if (saved === undefined || !Number.isFinite(saved.median) || saved.median <= 0) {
      console.error(`${bench.label}  基线缺少有效 median，判失败`)
      degraded += 1
      continue
    }
    const ratio = current.median / saved.median
    const slower = ratio > THRESHOLD
    const notes = []
    if (slower) notes.push('耗时退化')
    if (
      current.notifications !== undefined &&
      Number.isFinite(saved.notifications) &&
      current.notifications > saved.notifications
    ) {
      notes.push(`通知次数 ${current.notifications} > 基线 ${saved.notifications}`)
    }
    if (notes.length > 0) degraded += 1
    const status = notes.length === 0 ? 'OK' : `FAIL（${notes.join('；')}）`
    console.log(
      `${bench.label.padEnd(16, ' ')} 基线 ${saved.median.toFixed(1)}ms  中位数 ${current.median.toFixed(1)}ms  ${ratio.toFixed(2)}×  ${status}`,
    )
  }
  return degraded
}

async function main() {
  console.log(`性能基准：${BENCHES.length} 条 × ${RUNS} 次，退化线 ${THRESHOLD}×`)
  console.log(`工作树：${REPO_ROOT}`)
  console.log(`runner：${runnerId()}`)
  console.log('')

  const measured = new Map()
  let failed = false
  for (const bench of BENCHES) {
    try {
      measured.set(bench.id, measure(bench))
    } catch (error) {
      console.error(`${bench.label} 测量失败：${error instanceof Error ? error.message : String(error)}`)
      failed = true
    }
    console.log('')
  }

  if (failed || measured.size !== BENCHES.length) {
    console.error(`基准没有全部跑完（${measured.size}/${BENCHES.length} 条有结果），不写基线、不判退化。`)
    process.exitCode = 1
    return
  }

  if (!existsSync(BASELINE_FILE)) {
    console.log('测量结果（7 次中位数）：')
    for (const bench of BENCHES) console.log(`  ${bench.label}  ${round(measured.get(bench.id).median).toFixed(1)}ms`)
    const baseline = buildBaseline(measured)
    writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
    console.log('')
    console.log(`首跑建立基线，人审后提交：${BASELINE_FILE}`)
    process.exitCode = 0
    return
  }

  const baseline = readBaseline()
  // 设计 §9.2：基线绑机器。换机器时数值整体平移，硬比只会得到与代码无关的红；
  // 仍把本次中位数打出来（供人工看趋势），但不判退化。`--enforce` 是给自建固定
  // runner 的逃生门：机器换了但想用旧基线做同族比较时手动承担误报。
  const sameRunner = baseline.runner === runnerId()
  const enforce = process.argv.includes('--enforce')
  if (!sameRunner && !enforce) {
    console.log(`基线录在：${String(baseline.runner)}`)
    console.log('runner 不同：本次只记录，不判退化（设计 §9.2「基线绑机器」）。')
    console.log('')
    console.log('本次中位数（供人工比对）：')
    for (const bench of BENCHES) console.log(`  ${bench.label}  ${round(measured.get(bench.id).median).toFixed(1)}ms`)
    process.exitCode = 0
    return
  }

  const degraded = compare(baseline, measured)
  console.log('')
  if (degraded > 0) {
    console.error(`${degraded} 条基准退化（阈值 ${THRESHOLD}×）。先确认不是机器负载，再找对应的提交。`)
    process.exitCode = 1
  } else {
    console.log(`全部在 ${THRESHOLD}× 以内。`)
    process.exitCode = 0
  }
}

await main()
