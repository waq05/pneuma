/**
 * 自检批跑的公共壳：发现 → 逐条跑 → 汇总。两条总闸（`check-ui.mjs`、`check-core.mjs`）
 * 共用这一份，免得「怎么算通过、失败怎么贴尾巴」写两遍、还写成两套。
 *
 * 判定的唯一依据是**退出码**：探针各自打印的「N PASS / M FAIL」只当注释（各条写法不统一，
 * 拿它当判据迟早会误判）。
 *
 * @module dsc/scripts/_check-runner
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（`scripts/` 的上一层）。 */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 扫 `scripts/` 下符合命名的探针。
 * @param patterns - 文件名后缀（如 `['-test.mjs']`）
 * @param exclude - 明确不跑的（例如要人肉看的走查）
 * @returns 文件名（升序）
 */
export function discover(patterns, exclude = []) {
  const skip = new Set(exclude)
  return readdirSync(join(root, 'scripts'))
    .filter((file) => patterns.some((pattern) => file.endsWith(pattern)) && !skip.has(file))
    .sort()
}

/** 一条探针的结论。 */
function runOne(file, timeoutMs) {
  return new Promise((done) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [join(root, 'scripts', file)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    const timer = setTimeout(() => {
      child.kill()
      out += `\n[runner] 超过 ${String(timeoutMs)}ms，被中止\n`
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      // 探针的汇总写法不统一（「N 项通过」「N PASS」「N/M 通过」），只取最后一行含关键字的当注释。
      const line = out
        .split('\n')
        .map((row) => row.trim())
        .filter((row) => /通过|\bPASS\b/.test(row))
        .pop()
      done({ file, code, ms: Date.now() - startedAt, text: out, summary: line ? line.slice(0, 46) : '' })
    })
  })
}

/**
 * 逐条跑并打印进度。
 * @param files - 探针文件名
 * @param options - `timeoutMs` 单条上限（默认 5 分钟）
 * @returns 失败条数
 */
export async function runSequential(files, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000
  const results = []
  for (const file of files) {
    process.stdout.write(`  ${file.padEnd(34)} `)
    const result = await runOne(file, timeoutMs)
    results.push(result)
    if (result.code === 0) console.log(`ok  ${String(result.ms).padStart(6)}ms  ${result.summary}`)
    else console.log(`FAIL (exit ${String(result.code)})  ${String(result.ms).padStart(6)}ms`)
  }
  const failed = results.filter((result) => result.code !== 0)
  console.log('')
  for (const result of failed) {
    console.log(`── ${result.file} ───────────────────────────────────`)
    console.log(result.text.trimEnd().split('\n').slice(-40).join('\n'))
    console.log('')
  }
  const totalMs = results.reduce((sum, result) => sum + result.ms, 0)
  console.log(
    `${String(results.length - failed.length)}/${String(results.length)} 通过` +
      `${failed.length === 0 ? '' : `，${String(failed.length)} 条失败`}（合计 ${(totalMs / 1000).toFixed(1)}s）`,
  )
  return failed.length
}
