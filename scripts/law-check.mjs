#!/usr/bin/env node
/**
 * 架构铁律检查器（numa 第 0 批 Q2）：把 docs/development.md 的三条铁律变成机器判据。
 *
 * 用法：
 *   node scripts/law-check.mjs [--json] [--rule core-ui|whitelist|loop-owner]
 *                              [--base <rev>] [--stats] [--root <dir>]
 *
 * 退出码（design/README.md §2.7）：0 通过 / 1 有违规 / 2 无 git、拿不到 base、
 * 读不到文件、参数错。
 *
 * base 取法（F1 + 收口 A）——显式与缺省分开，不许把「显式拼错」静默回退成缺省：
 *   - 显式给了 `--base` 或非空、非全零的 `NUMA_LAW_BASE`：只认它，解析不到就退 2 并提示
 *     「指定的 base 不存在：<值>」；`--base` 优先于环境变量；
 *   - 都没给：回退链 本地 `dev`（存在才用）> `origin/dev`（存在才用）> `origin/main`
 *     （存在才用）> 退 2，这条专为 CI 的 PR detached HEAD 与 tag 推送设计，不能动；
 *   - 空串、纯空白、全零 sha 一律视为未设（push 事件给新分支时 before 就是全零 sha）。
 *   被选中的 rev 原样进 `git diff <base>...HEAD`，所以 `NUMA_LAW_BASE` 既可以是分支名
 *   也可以是 CI 传的 sha。纪律：拿不到 base 就退 2，不许当「没改动」判 0。
 *
 * `--root <dir>` 是给自测（scripts/law-test.mjs 的临时 git 仓库）用的 test-only 参数；
 * 正常只在仓库根跑，不要拿它指别的目录。
 *
 * 规则按文件注册：启动时读 `scripts/law/rules/` 目录，动态 import 每个 `.mjs`，
 * 按导出对象里的 `id` 登记（规则文件各导出 `{ id, title, severity, check(ctx) }`）。
 * 所以扩展只加文件、不改本文件。输出顺序固定按规则 id 排序。
 *
 * 回退开关：`NUMA_GATE_DISABLE=law-check`（或规则 id）时跳过并打印一行，不静默。
 *
 * ── 本项不做（已知漏报面，别把这些当成已覆盖）────────────────────────────
 * 设计 §Q2 说「本项不做类型级检查（不建 ts.Program）」，下面这些写法只做文本判定，
 * 覆盖不到，其中前两条还会进 `--stats` 的「归不出类」清单（列出来，但不判红）：
 * 1. `(channel).invoke('x')`、`(channel as any).invoke('x')`：接收者以括号 / 类型断言
 *    收尾，回溯不出成员名 → 归不出类，只在 `--stats` 里列；
 * 2. `channel['invoke']('x')`：下标调用不识别（正则只认 `.invoke`）；
 * 3. 别名 `const ch = channel; ch.invoke('x')`：接收者记成 `ch`，不在 channel/protocol
 *    判定面内 → 不判红（`--stats` 能看到 `ch` 这一档）；
 * 4. 字符串拼接出的方法名、`.invoke.call(...)`、把 invoke 存进变量再调：都不识别；
 * 5. 动态调用只按 `文件:行号` 精确匹配登记表，行号漂移会判红（逼你更新登记表），
 *    这是刻意做严：宁可多一次手工确认，也不让「改了行号就静默放行」成立。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * @module scripts/law-check
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RULES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'law/rules')
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', '.git'])
const ZERO_SHA = /^0+$/

class UsageError extends Error {}

/** 读规则目录并动态 import；「扩展只加文件」这条承诺靠这里兑现。 */
async function loadRules() {
  let names
  try {
    names = fs
      .readdirSync(RULES_DIR)
      .filter((name) => name.endsWith('.mjs'))
      .sort()
  } catch (error) {
    throw new Error(`读不到规则目录 ${RULES_DIR}（${error?.code ?? error?.message ?? '未知原因'}）`)
  }
  if (names.length === 0) throw new Error(`规则目录里没有 .mjs：${RULES_DIR}`)
  const rules = []
  const seen = new Set()
  for (const name of names) {
    const mod = await import(pathToFileURL(path.join(RULES_DIR, name)).href)
    const rule = mod.default
    if (typeof rule?.id !== 'string' || rule.id === '') throw new Error(`规则 ${name} 没导出 id`)
    if (typeof rule.title !== 'string' || rule.title === '') throw new Error(`规则 ${name} 没导出 title`)
    if (rule.severity !== 'error' && rule.severity !== 'warn') throw new Error(`规则 ${name} 的 severity 只能是 error / warn`)
    if (typeof rule.check !== 'function') throw new Error(`规则 ${name} 没导出 check(ctx)`)
    if (seen.has(rule.id)) throw new Error(`规则 id 重复：${rule.id}（${name}）`)
    seen.add(rule.id)
    rules.push(rule)
  }
  return rules.sort((a, b) => a.id.localeCompare(b.id))
}

function usage(rules) {
  return `用法：node scripts/law-check.mjs [--json] [--rule <${rules.map((rule) => rule.id).join('|')}>]
                              [--base <rev>] [--stats] [--root <dir>]
  --root <dir>  test-only：给自测（scripts/law-test.mjs）的临时 git 仓库用；正常在仓库根跑，不要指别的目录
  base 取法：显式给的 --base / NUMA_LAW_BASE（空串、全零 sha 视为未设）只认它，解析不到退 2；
             都没给时回退 本地 dev > origin/dev > origin/main > 退 2
退出码：0 通过 / 1 有违规 / 2 无 git、拿不到 base、读不到文件、参数错`
}

function parseArgs(argv, rules) {
  const options = { json: false, stats: false, rule: null, base: null, root: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--stats') options.stats = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--rule' || arg === '--base' || arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} 缺参数`)
      if (arg === '--rule') options.rule = value
      else if (arg === '--base') options.base = value
      else options.root = value
      i++
    } else throw new UsageError(`不认识的参数：${arg}`)
  }
  if (options.rule !== null && !rules.some((rule) => rule.id === options.rule)) {
    throw new UsageError(`--rule 只支持：${rules.map((rule) => rule.id).join(' / ')}`)
  }
  return options
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? '').trim()
    throw new Error(`git ${args.join(' ')} 失败：${detail === '' ? '(无输出)' : detail}`)
  }
}

/** 空串、纯空白、全零 sha 都算「没给 base」（CI 的 push 事件给新分支时 before 就是全零）。 */
function isUnsetBase(value) {
  const text = String(value ?? '').trim()
  return text === '' || ZERO_SHA.test(text)
}

function revExists(root, rev) {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    return true
  } catch {
    return false
  }
}

/** 显式指定的 base：`--base` 优先于 `NUMA_LAW_BASE`；都算「未设」时返回 null。 */
function explicitBase(options) {
  if (!isUnsetBase(options.base)) return { value: String(options.base).trim(), source: '--base' }
  const fromEnv = process.env.NUMA_LAW_BASE ?? ''
  if (!isUnsetBase(fromEnv)) return { value: fromEnv.trim(), source: 'NUMA_LAW_BASE' }
  return null
}

/**
 * 显式与缺省分开（收口 A）：
 * - 显式给了 base：只认它，解析不到就抛错退 2，**不许**静默回退到 dev ——
 *   否则拼错的 base 会让门禁照样绿，把「没比到」伪装成「没改动」；
 * - 没给：回退链 `dev` > `origin/dev` > `origin/main` > 退 2（CI 的 PR detached HEAD
 *   与 tag 推送靠这条活）。
 */
function resolveBase(root, options) {
  const picked = explicitBase(options)
  if (picked !== null) {
    if (revExists(root, picked.value)) return picked.value
    throw new Error(
      `指定的 base 不存在：${picked.value}（来自 ${picked.source}）；` +
        '拼错、没 fetch 到、或当前目录不是 git 仓库都会这样，不许回退到别的基线',
    )
  }
  const fallback = ['dev', 'origin/dev', 'origin/main']
  for (const rev of fallback) if (revExists(root, rev)) return rev
  throw new Error(
    '拿不到基线（没给 --base / NUMA_LAW_BASE，本地 dev、origin/dev、origin/main 也都不存在）：' +
      '浅克隆没 fetch 到基线（请把 checkout 设成 fetch-depth: 0），或当前目录不是 git 仓库',
  )
}

/** 改动文件清单；git 不可用或 base 解析失败都抛错，由主入口退 2。 */
function computeChangedFiles(root, base) {
  try {
    git(root, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    throw new Error('当前目录不是 git 仓库：铁律 3 要用 git diff 判断改动')
  }
  return git(root, ['diff', '--name-only', '--diff-filter=ACMR', '-M', `${base}...HEAD`])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** 规则拿到的上下文：读文件 / 列文件都按仓库根相对路径（正斜杠），越界或缺失一律抛错。 */
function createCtx(root, base) {
  const readFile = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8')
    } catch (error) {
      throw new Error(`读不到文件 ${rel}（${error?.code ?? error?.message ?? '未知原因'}）`)
    }
  }
  const listFiles = (relDir, options = {}) => {
    const exts = options.exts ?? ['.ts']
    const result = []
    const walk = (absDir, rel) => {
      for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(path.join(absDir, entry.name), `${rel}/${entry.name}`)
        } else if (exts.includes(path.extname(entry.name))) result.push(`${rel}/${entry.name}`)
      }
    }
    try {
      if (!fs.statSync(path.join(root, relDir)).isDirectory()) throw new Error('不是目录')
    } catch {
      throw new Error(`扫描面不存在：${relDir}`)
    }
    walk(path.join(root, relDir), relDir)
    return result.sort()
  }
  let changedFiles
  return {
    root,
    base,
    readFile,
    listFiles,
    parseJson: (rel) => JSON.parse(readFile(rel)),
    get changedFiles() {
      if (changedFiles === undefined) changedFiles = computeChangedFiles(root, base)
      return changedFiles
    },
  }
}

function renderText(results, options, base) {
  const lines = [`架构铁律检查（law-check）：${results.map((result) => result.id).join(' / ')}`]
  for (const result of results) {
    lines.push('')
    if (result.status === 'skipped') {
      lines.push(`[SKIP] ${result.id}：已按 NUMA_GATE_DISABLE 跳过`)
      continue
    }
    lines.push(`[${result.status === 'fail' ? 'FAIL' : result.status === 'warn' ? 'WARN' : 'OK'}] ${result.id} — ${result.title}`)
    for (const violation of result.violations) {
      const where = violation.line === null ? violation.file : `${violation.file}:${violation.line}`
      lines.push(`  ${where}  ${violation.message}`)
    }
  }
  lines.push('')
  for (const result of results) {
    if (result.status === 'skipped') continue
    const stats = result.stats ?? {}
    const head = `${result.status.toUpperCase()} ${result.id}`
    if (result.id === 'core-ui') lines.push(`- ${head}（扫描 ${stats.files} 个文件，命中 ${stats.hits} 处）`)
    else if (result.id === 'whitelist') {
      lines.push(
        `- ${head}（扫描 ${stats.filesScanned} 个文件；${stats.total} 处 .invoke = ${stats.total - stats.dynamic - stats.unclassified} 处字面量 + ${stats.dynamic} 处动态 + ${stats.unclassified} 处归不出类；白名单 ${stats.whitelistMethods} 个方法）`,
      )
    } else if (result.id === 'loop-owner') {
      lines.push(`- ${head}（基准 ${stats.base ?? base ?? '?'}，${stats.changedFiles} 个改动文件，命中 loop.ts ${stats.protectedHit} 处）`)
    }
  }
  if (options.stats) {
    const rule = results.find((result) => result.id === 'whitelist' && result.stats !== null)
    if (rule) lines.push('', ...renderWhitelistStats(rule.stats))
  }
  const violations = results.reduce((sum, result) => sum + (result.status === 'fail' ? result.violations.length : 0), 0)
  const warnings = results.reduce((sum, result) => sum + (result.status === 'warn' ? result.violations.length : 0), 0)
  lines.push('', `结论：${violations === 0 ? '通过' : `有 ${violations} 条违规`}（${violations} 违规 / ${warnings} 警告）`)
  return lines.join('\n')
}

function renderWhitelistStats(stats) {
  const lines = ['--stats whitelist 计数明细（第 2 条）：']
  lines.push(`  扫描文件 ${stats.filesScanned}；白名单方法 ${stats.whitelistMethods} 个`)
  lines.push(`  接收者：${Object.entries(stats.byReceiver).map(([name, n]) => `${name} ${n}`).join(' / ')}`)
  lines.push(`  分项之和 ${stats.partitionSum} = 总数 ${stats.total}${stats.partitionSum === stats.total ? '（一致）' : '（不一致，脚本有 bug）'}`)
  const exempt = Object.entries(stats.exempt).map(([name, n]) => `${name} ${n}`).join(' / ')
  lines.push(`  豁免：${exempt === '' ? '无' : exempt}`)
  lines.push(`  动态调用 ${stats.dynamic} 处，已登记 ${stats.registry.matched} 处（登记表${stats.registry.present ? '' : '缺失，按空表算'}）：`)
  for (const call of stats.dynamicCalls) lines.push(`    ${call.file}:${call.line} ${call.receiver ?? '?'}.invoke`)
  lines.push(`  归不出类 ${stats.unclassified} 处${stats.unclassified === 0 ? '' : '：'}`)
  for (const call of stats.unclassifiedCalls) lines.push(`    ${call.file}:${call.line}`)
  return lines
}

async function main(argv) {
  let rules
  try {
    rules = await loadRules()
  } catch (error) {
    return reportError({ json: argv.includes('--json') }, process.cwd(), null, error, [])
  }
  let options
  try {
    options = parseArgs(argv, rules)
  } catch (error) {
    return reportError({ json: argv.includes('--json') }, process.cwd(), null, error, rules)
  }
  if (options.help) {
    process.stdout.write(`${usage(rules)}\n`)
    return 0
  }
  const disabled = (process.env.NUMA_GATE_DISABLE ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  const gateDisabled = disabled.includes('law-check') || disabled.includes('law')
  const skipped = (rule) => gateDisabled || disabled.includes(rule.id)
  const selected = options.rule === null ? rules : rules.filter((rule) => rule.id === options.rule)
  const root = path.resolve(options.root ?? process.cwd())
  let base = null
  let results
  try {
    const loopRule = selected.find((rule) => rule.id === 'loop-owner')
    if (loopRule !== undefined && !skipped(loopRule)) base = resolveBase(root, options)
    const ctx = createCtx(root, base)
    // 三条规则各自只读文件、互不依赖：并发跑；map 顺序 = 规则 id 顺序，输出稳定。
    results = await Promise.all(
      selected.map(async (rule) => {
        if (skipped(rule)) {
          return { id: rule.id, title: rule.title, severity: rule.severity, status: 'skipped', violations: [], stats: null }
        }
        const outcome = await rule.check(ctx)
        const violations = Array.isArray(outcome?.violations) ? outcome.violations : []
        const status = violations.length === 0 ? 'pass' : rule.severity === 'warn' ? 'warn' : 'fail'
        return { id: rule.id, title: rule.title, severity: rule.severity, status, violations, stats: outcome?.stats ?? null }
      }),
    )
  } catch (error) {
    return reportError(options, root, base, error, rules)
  }
  const violations = results.reduce((sum, result) => sum + (result.status === 'fail' ? result.violations.length : 0), 0)
  const warnings = results.reduce((sum, result) => sum + (result.status === 'warn' ? result.violations.length : 0), 0)
  const exitCode = violations > 0 ? 1 : 0
  if (options.json) {
    const payload = {
      version: 1,
      ok: exitCode === 0,
      exitCode,
      root,
      base: selected.some((rule) => rule.id === 'loop-owner') ? base : null,
      rules: results,
      summary: { violations, warnings },
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderText(results, options, base)}\n`)
  }
  return exitCode
}

function reportError(options, root, base, error, rules) {
  const message = error instanceof UsageError ? `${error.message}\n${usage(rules)}` : `错误：${error.message}`
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ version: 1, ok: false, exitCode: 2, root, base, error: { message } }, null, 2)}\n`)
  } else {
    process.stderr.write(`law-check: ${message}\n`)
  }
  return 2
}

process.exitCode = await main(process.argv.slice(2))
