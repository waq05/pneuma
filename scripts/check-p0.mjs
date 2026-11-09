/**
 * P0 修复的总闸：把 2026-11-09 那批 P0 各自配的探针一次跑完。
 *
 * 为什么不并进 `check:all`：这 16 条里有几条要真的起进程、写临时 HOME、按 PATH 找可执行
 * 文件（`teammate-guard-chain-check` 起真 sandbox、`session-cost-restore-check` 起真宿主、
 * `mcp-command-resolve-check` 靠 Windows 的 PATH / PATHEXT 语义），在 CI 或别人的机器上
 * 会因环境不同给出与代码无关的红。所以它是一条**手动门禁**：动过这批行为的人自己跑一遍。
 *
 * 命名约定（与 `check-core.mjs` 的 `<话题>-test.mjs` 并行，互不抢）：
 *   - `<话题>-check.mjs`：P0 修复期的定点探针，**手挂在这份清单里**，不按文件名自动发现
 *     ——这批探针的共同点是「各自依赖一种本机环境」，混进自动发现会让 `check:all` 变脆；
 *   - `<话题>-test.mjs`：常规回归，归 `check:ui` / `check:core` 自动发现。
 *
 * 判定只看**退出码**：探针各自打印的「N PASS / M FAIL」写法不统一，拿它当判据迟早误判
 * （与 `_check-runner.mjs` 同一条规矩）。
 *
 * 为什么不给子进程传 `--experimental-transform-types`：每条探针自己 re-exec 过——它要在
 * 类型擦除下 `import` 源码，参数是它自己职责内的东西。这里统一传参数反而会让不接受它的
 * 那条（纯文本断言的探针）多一个未知参数。
 *
 * 平台：`mcp-command-resolve-check.mjs` 只在 Windows 跑（它验的是 `where` / PATHEXT 那套
 * 命令解析顺序），其它平台跳过并记一行 SKIP，不算失败。
 *
 * 为什么子进程的输出落文件、不走管道：受限运行环境（无审批的沙箱）不允许子进程开命名
 * 管道，`stdio: 'pipe'` 会直接 `EPERM`；写临时文件在普通终端与沙箱里都能跑。
 *
 * 用法：
 *   node scripts/check-p0.mjs            # 全部
 *   node scripts/check-p0.mjs --list     # 只列会跑哪些
 *   node scripts/check-p0.mjs dock-browser-look-check.mjs   # 只跑点名的
 *
 * @module dsc/scripts/check-p0
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 这批 P0 的探针清单（顺序按修复批次，不按字母）。
 *
 * `platforms` 缺省 = 到处都跑；写了就只在列出的 `process.platform` 上跑。
 */
const PROBES = [
  { file: 'ui-boot-services-check.mjs' },
  { file: 'grep-read-denylist-check.mjs' },
  { file: 'waiting-session-scope-check.mjs' },
  { file: 'todo-session-scope-check.mjs' },
  // 计划僵尸卡：重启前留下的 pending 计划要能被批准/拒绝收掉（P0-6 复审问题 2）。
  { file: 'plan-zombie-card-check.mjs' },
  { file: 'plugin-config-enable-check.mjs' },
  { file: 'session-cost-restore-check.mjs' },
  { file: 'teammate-guard-chain-check.mjs' },
  // 队友会话归属：gate 入参按别名解析、嵌套固化、hooks ask 带会话（P0-8 复审问题 1/2/3）。
  { file: 'teammate-session-alias-check.mjs' },
  { file: 'command-intent-consistency-check.mjs' },
  // 会话口径的两条：定时任务的挂卡闸逐条判、压缩携带取自被压缩那条会话。
  { file: 'schedule-session-gate-check.mjs' },
  { file: 'compact-carry-session-check.mjs' },
  { file: 'dock-browser-look-check.mjs' },
  { file: 'dock-browser-dialog-check.mjs' },
  { file: 'dock-patch-invalidate-check.mjs' },
  // 靠 PATH / PATHEXT 找命令：Windows 才有那套语义，别的平台跳过。
  { file: 'mcp-command-resolve-check.mjs', platforms: ['win32'] },
]

const TIMEOUT_MS = 300_000

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const named = args.filter((arg) => !arg.startsWith('--')).map((name) => (name.endsWith('.mjs') ? name : `${name}.mjs`))

const picked = named.length === 0 ? PROBES : PROBES.filter((probe) => named.includes(probe.file))
if (picked.length === 0) {
  console.error(`没找到点名的探针：${named.join('、')}（清单里有：${PROBES.map((probe) => probe.file).join('、')}）`)
  process.exit(2)
}
if (listOnly) {
  for (const probe of picked) console.log(probe.file)
  process.exit(0)
}

/**
 * 跑一条探针，收 stdout/stderr 与退出码。
 *
 * 输出写临时文件（见抬头：受限环境里管道会 EPERM），父进程 close 之后再把整份读回来。
 * 超时按「杀掉 + 记失败」处理：卡住的探针也是红的——它没给出结论，不能当绿。
 */
function runOne(file) {
  return new Promise((done) => {
    const startedAt = Date.now()
    const logFile = join(logDir, `${file}.log`)
    const fd = openSync(logFile, 'w')
    let child
    try {
      child = spawn(process.execPath, [join(root, 'scripts', file)], {
        cwd: root,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      })
    } catch (error) {
      closeSync(fd)
      done({ file, code: 1, ms: 0, text: `[check-p0] 起不了子进程：${String(error)}`, summary: '' })
      return
    }
    closeSync(fd)
    const timer = setTimeout(() => {
      child.kill()
    }, TIMEOUT_MS)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      let out = readFileSync(logFile, 'utf8')
      if (signal !== null) out += `\n[check-p0] 超过 ${String(TIMEOUT_MS)}ms 被中止（signal ${String(signal)}）\n`
      // 探针的汇总写法不统一（「N PASS」「N 项通过」「ok ...」），只取最后一行含关键字的当注释。
      const summary = out
        .split('\n')
        .map((row) => row.trim())
        .filter((row) => /通过|\bPASS\b/.test(row) && !row.startsWith('FAIL'))
        .pop()
      done({ file, code: code ?? 1, ms: Date.now() - startedAt, text: out, summary: summary === undefined ? '' : summary.slice(0, 40) })
    })
  })
}

const logDir = mkdtempSync(join(tmpdir(), 'dsc-check-p0-'))

const results = []
for (const probe of picked) {
  const skip = probe.platforms !== undefined && !probe.platforms.includes(process.platform)
  if (skip) {
    console.log(`  ${probe.file.padEnd(38)} SKIP（只在 ${probe.platforms.join('/')} 上跑，当前 ${process.platform}）`)
    results.push({ file: probe.file, skipped: true, reason: `只在 ${probe.platforms.join('/')} 上跑`, ms: 0 })
    continue
  }
  process.stdout.write(`  ${probe.file.padEnd(38)} `)
  const result = await runOne(probe.file)
  results.push(result)
  if (result.code === 0) console.log(`PASS  ${String(result.ms).padStart(6)}ms  ${result.summary}`)
  else console.log(`FAIL (exit ${String(result.code)})  ${String(result.ms).padStart(6)}ms`)
}

// 失败的那几条把尾巴贴出来（只看结论不看栈，栈各自在自己的输出里）。
for (const result of results) {
  if (result.skipped === true || result.code === 0) continue
  console.log('')
  console.log(`── ${result.file} ───────────────────────────────────`)
  console.log(result.text.trimEnd().split('\n').slice(-40).join('\n'))
}

const ran = results.filter((result) => result.skipped !== true)
const skipped = results.filter((result) => result.skipped === true)
const failed = ran.filter((result) => result.code !== 0)

console.log('')
console.log('总表')
console.log(`  ${'探针'.padEnd(44)} 结果`)
for (const result of results) {
  const verdict = result.skipped === true ? `SKIP（${result.reason}）` : result.code === 0 ? 'PASS' : `FAIL（exit ${String(result.code)}）`
  console.log(`  ${result.file.padEnd(44)} ${verdict}`)
}
const totalMs = ran.reduce((sum, result) => sum + result.ms, 0)
console.log('')
console.log(
  `${String(ran.length - failed.length)}/${String(ran.length)} 通过` +
    `${skipped.length === 0 ? '' : `，${String(skipped.length)} 条跳过`}` +
    `${failed.length === 0 ? '' : `，${String(failed.length)} 条失败`}（合计 ${(totalMs / 1000).toFixed(1)}s）`,
)

rmSync(logDir, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
