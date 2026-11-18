/**
 * 探针孤儿台账：`scripts/` 下每个 `.mjs` 必须落进六类之一，否则点名并失败。
 *
 * 六类判据（先到先得 A→B→C→D→E→F，设计见 design/01-test-bench.md §3）：
 *   - A 总闸自动发现：`-test.mjs` 全部 + `ui-*-e2e.mjs`
 *     （`check-core.mjs:46` 收非 `ui-` 的 `-test.mjs`；`check-ui.mjs:40` 收 `ui-` 开头的
 *      `-test.mjs` 与 `-e2e.mjs`，两者并起来正好是这条判据）；非 `ui-` 的 `-e2e.mjs` 不算；
 *   - B 在 `check-p0.mjs` 的 `PROBES` 清单里（`check-p0.mjs:47-75`，它是 JS 源码不是 JSON，
 *     所以按源码抽 `file:`；抽不到一律退 2 并打印抓到的行，绝不猜）；
 *   - C `_` 开头的共用件；
 *   - D 出现在 `package.json` 任一 script 的命令串里（只看 `scripts`，不看别的字段）；
 *   - E 被别的 `.mjs` 在**执行/加载位置**以字面量引用：`import … from 'x.mjs'`、`export … from
 *     'x.mjs'`、`import('x.mjs')`、`new Worker('x.mjs')`、以及 `spawn`/`spawnSync`/`execFile`/
 *     `exec` 系列调用参数里的真实文件名。注释、报错文案、help 文本里的「跑 node scripts/x.mjs」
 *     不算——那只是提了一句，没人真的执行它（R1 F1：sync-versions.mjs 就曾被
 *     `plugin-standard-check.mjs:285` 的报错文案误算成 E 类）；
 *   - F `scripts/probe-manual.json` 里有登记条目（人读过文件头、确认过用途的例外）。
 *
 * **这不是覆盖率指标**：它只回答「有没有一条脚本没人跑、也没人认领」。不判断探针质量，
 * 也不要求各类数字好看；「孤儿」要处置，处置方式只有两种——挂进某道门，或登记进
 * `probe-manual.json` 并写清理由。删脚本、改文件名都要人拍板，本脚本只点名。
 *
 * `--root` **只换扫描目录**：B 类清单（`check-p0.mjs`）、D 类 `package.json`、以及 B/F 的
 * 存在性校验一律按仓库根。否则自测拿临时目录当根时会因为找不到 `PROBES` 而误退 2。
 * 登记表路径由 `--manual` 单独注入，缺省 `<repo>/scripts/probe-manual.json`。
 *
 * 门禁名 `probe-inventory`，命中 `NUMA_GATE_DISABLE` 时打印一行后跳过（退出 0）。
 *
 * 用法：
 *   node scripts/probe-inventory-check.mjs              # 人类可读
 *   node scripts/probe-inventory-check.mjs --json       # stdout 只有 JSON，摘要走 stderr
 *   node scripts/probe-inventory-check.mjs --matrix     # 额外打印 24 格能力矩阵（T4 占位）
 *   node scripts/probe-inventory-check.mjs --root=scripts
 *   node scripts/probe-inventory-check.mjs --manual=scripts/probe-manual.json
 *
 * @module dsc/scripts/probe-inventory-check
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 门禁名：`NUMA_GATE_DISABLE` 里出现它就整条跳过。 */
const GATE = 'probe-inventory'

/** 仓库根：`scripts/` 的上一层。`--root` 换的是扫描目录，不换它。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 参数只认 `--flag` 与 `--flag=value` 两种写法；裸的 `--root dir` 会落到「不认识的参数」退 2。 */
const options = { json: false, matrix: false, root: null, manual: null }

/** 工具/环境错误（README §2.7 的退出码 2）：报一句就退，不猜着往下跑。 */
function toolError(message) {
  process.stderr.write(`probe-inventory: ${message}\n`)
  process.exit(2)
}

const disabled = (process.env.NUMA_GATE_DISABLE ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '')
if (disabled.includes(GATE)) {
  process.stdout.write(`已按 NUMA_GATE_DISABLE 跳过 ${GATE}\n`)
  process.exit(0)
}

for (const arg of process.argv.slice(2)) {
  if (arg === '--json') options.json = true
  else if (arg === '--matrix') options.matrix = true
  else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length)
  else if (arg.startsWith('--manual=')) options.manual = arg.slice('--manual='.length)
  else toolError(`不认识的参数：${arg}（支持 --json / --matrix / --root=<dir> / --manual=<file>）`)
}
if (options.root === '' || options.manual === '') toolError('--root / --manual 的值不能为空')

/** 本次运行的标识：入口传了 `NUMA_RUN_ID` 就沿用，没有就按 README §2.1 现造（T2 才统一）。 */
function makeRunId() {
  const inherited = (process.env.NUMA_RUN_ID ?? '').trim()
  if (inherited !== '') return inherited
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const date = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${date}-${time}-${randomBytes(2).toString('hex')}`
}

/** 扫描目录：缺省是 `<repo>/scripts`，`--root` 只换它。 */
const scanRoot = options.root === null ? join(repoRoot, 'scripts') : resolve(options.root)
if (!existsSync(scanRoot) || !statSync(scanRoot).isDirectory()) {
  toolError(`根目录不对：${scanRoot} 不存在或不是目录`)
}

/** `package.json` 一律读仓库根那份，与扫描目录无关。 */
const packagePath = join(repoRoot, 'package.json')
let packageJson
try {
  packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
} catch (error) {
  toolError(`根目录不对：读不了 ${packagePath}（${error instanceof Error ? error.message : String(error)}）`)
}

/**
 * 从 `check-p0.mjs` 的 `PROBES` 数组抽 `file:` 清单。
 *
 * 清单是 JS 源码不是 JSON：只认 `PROBES = [` 到行首 `]` 之间、`file: 'x.mjs'` 这种写法。
 * 抽法一变就退 2 并打印抓到的行——报「清单来源变了」比静默少算 19 条 B 类安全得多。
 */
function loadP0Probes() {
  const path = join(repoRoot, 'scripts', 'check-p0.mjs')
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    toolError(`清单来源变了：读不了 ${path}（${error instanceof Error ? error.message : String(error)}）`)
  }
  const start = source.indexOf('const PROBES = [')
  const end = start === -1 ? -1 : source.indexOf('\n]', start)
  if (start === -1 || end === -1) {
    toolError('清单来源变了：check-p0.mjs 里找不到 `const PROBES = [` … `\n]` 这段数组')
  }
  const block = source.slice(start, end)
  const files = [...block.matchAll(/file:\s*'([^']+\.mjs)'/gu)].map((match) => match[1])
  if (files.length === 0) {
    process.stderr.write(`抓到的 PROBES 段（前 20 行）：\n${block.split('\n').slice(0, 20).join('\n')}\n`)
    toolError('清单来源变了：PROBES 里一个 `file: \'x.mjs\'` 都抽不到')
  }
  return files
}

/** 登记表：`{version, entries:[{file, reason, owner, addedAt, runBy}]}`，`reason` 必填且不能是空串。 */
function loadManual(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    toolError(`读不了登记表 ${path}（${error instanceof Error ? error.message : String(error)}）；` +
      '先建一个 {version:1, entries:[]} 的空登记表')
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    toolError(`登记表不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (data?.version !== 1) toolError(`登记表 version 必须是 1（${path}）`)
  if (!Array.isArray(data.entries)) toolError(`登记表格式错：缺 entries 数组（${path}）`)
  for (const [index, entry] of data.entries.entries()) {
    if (typeof entry?.file !== 'string' || entry.file === '' || entry.file.includes('/') || entry.file.includes('\\')) {
      toolError(`登记表第 ${String(index + 1)} 条的 file 必须是纯文件名（${path}）`)
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      toolError(`登记表第 ${String(index + 1)} 条（${entry.file}）缺 reason；理由必须具体到用途出处`)
    }
  }
  return data.entries
}

/** 递归看一个子目录里有没有 `.mjs`：发现器只读一层，子目录里的探针永远跑不到，只提示不判红。 */
function containsMjs(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (containsMjs(join(dir, entry.name))) return true
    } else if (entry.name.endsWith('.mjs')) {
      return true
    }
  }
  return false
}

/** 去掉注释、保留字符串字面量：E 类要「注释里提到不算」，字符串里的引用才算。 */
function stripComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      out += char
      index += 1
      while (index < source.length) {
        const current = source[index]
        out += current
        index += 1
        if (current === '\\') {
          if (index < source.length) {
            out += source[index]
            index += 1
          }
          continue
        }
        if (current === quote) break
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** 从 `openParen`（左括号后一位）起找配对的右括号，返回括号内的参数文本；引号里的括号不算嵌套。 */
function readCallArguments(code, openParen) {
  let depth = 1
  let index = openParen
  while (index < code.length) {
    const char = code[index]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      index += 1
      while (index < code.length) {
        if (code[index] === '\\') {
          index += 2
          continue
        }
        if (code[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return code.slice(openParen, index)
    }
    index += 1
  }
  return code.slice(openParen)
}

/**
 * E 类判据：只从「执行/加载位置」抽真实文件名，报错文案与注释不算。
 *
 * 认五种位置：静态 `import … from`（可跨行）、`export … from`、动态 `import()`、
 * `new Worker()`、spawn 家族调用的参数（`spawn(process.execPath, [join(root,'scripts','x.mjs')])`
 * 这种也算，抓参数里的路径片段）。`spawn(..., () => console.error('跑 x.mjs'))` 这种回调里的
 * 文案仍可能被误收，属于已知边界，靠「文案一般带空格/整句」的过滤压低概率。
 */
function executedFileBasenames(source) {
  const code = stripComments(source)
  const names = []
  const add = (literal) => {
    if (literal === undefined) return
    const trimmed = literal.trim()
    // 只认「一整个就是文件名/路径」的字面量；'请手动跑 node scripts/x.mjs' 是文案不是路径。
    if (!/^[^\s'"]+\.mjs$/u.test(trimmed)) return
    const name = trimmed.split(/[\\/]/u).pop()
    if (name !== undefined && name.endsWith('.mjs')) names.push(name)
  }
  // 静态 import 与 export-from 可以跨行（import {\n  a,\n} from './x.mjs'）。
  for (const match of code.matchAll(/\bimport\s+(?:[^;]*?\bfrom\s*)?(['"])([^'"\n]+)\1/gu)) add(match[2])
  for (const match of code.matchAll(/\bexport\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/gu)) {
    add(match[2])
  }
  for (const match of code.matchAll(/\bimport\s*\(\s*(['"])([^'"\n]+)\1/gu)) add(match[2])
  for (const match of code.matchAll(/\bnew\s+Worker\s*\(\s*(['"])([^'"\n]+)\1/gu)) add(match[2])
  // spawn / spawnSync / execFile / execFileSync / exec / execSync：只收调用参数里的文件名。
  for (const match of code.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/gu)) {
    const args = readCallArguments(code, match.index + match[0].length)
    for (const quoted of args.matchAll(/(['"])([^'"\n]*)\1/gu)) add(quoted[2])
  }
  return names
}

/** 文件名是否作为独立命令串片段出现在某段文本里（防 `plugin-inventory.mjs` 命中 `plugin-inventory-check.mjs`）。 */
function commandMentions(text, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`, 'u').test(text)
}

/** 路径统一成 posix 分隔符，报告里贴出来才不至于一半反斜杠。 */
function toPosix(path) {
  return path.split('\\').join('/')
}

/** 24 格能力矩阵：语义归 T4（design/01-test-bench.md §6），第 0 批只留键与 `gap:` 占位。 */
const MATRIX_TOOLS = ['bash', 'read', 'write', 'edit', 'glob', 'grep']
const MATRIX_PATHS = ['normal', 'denied', 'timeout', 'interrupt']
const CAPABILITY_MATRIX = Object.fromEntries(
  MATRIX_TOOLS.flatMap((tool) => MATRIX_PATHS.map((path) => [`${tool}/${path}`, 'gap:第 0 批未核定（T4 填）'])),
)

const probes = loadP0Probes()
const manualEntries = loadManual(options.manual === null ? join(repoRoot, 'scripts', 'probe-manual.json') : resolve(options.manual))

const dirents = readdirSync(scanRoot, { withFileTypes: true })
const files = dirents
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
  .map((entry) => entry.name)
  .sort()
const subdirWarn = []
for (const entry of dirents) {
  if (!entry.isDirectory()) continue
  const abs = join(scanRoot, entry.name)
  if (!containsMjs(abs)) continue
  // 跨盘符时 `path.relative` 会退回绝对路径，所以绝对路径也要再对扫描目录求一次相对。
  let shown = relative(repoRoot, abs)
  if (shown.startsWith('..') || isAbsolute(shown)) shown = relative(scanRoot, abs)
  subdirWarn.push(`${toPosix(shown)}/`)
}

/** A 类判据：两个总闸的发现规则并起来（见文件头）。 */
function isAutoDiscovered(file) {
  if (file.endsWith('-test.mjs')) return true
  return file.startsWith('ui-') && file.endsWith('-e2e.mjs')
}

const scriptTexts = Object.values(packageJson.scripts ?? {}).filter((text) => typeof text === 'string')

/** 每条扫描到的脚本的源码；读不了的记进 `unreadable`，按未归类算（退 1），不假装它没问题。 */
const sources = new Map()
const unreadable = new Set()
for (const file of files) {
  try {
    sources.set(file, readFileSync(join(scanRoot, file), 'utf8'))
  } catch {
    unreadable.add(file)
  }
}

const referenced = new Set()
for (const source of sources.values()) {
  for (const name of executedFileBasenames(source)) referenced.add(name)
}

/** B/F 存在性校验一律按仓库根：`--root` 换扫描目录，不换清单来源。 */
const staleEntries = []
const staleSeen = new Set()
const scriptPath = (file) => join(repoRoot, 'scripts', file)
for (const probe of probes) {
  if (existsSync(scriptPath(probe)) || staleSeen.has(probe)) continue
  staleSeen.add(probe)
  staleEntries.push({ entry: probe, reason: 'check-p0.mjs 的 PROBES 里列了它，但文件不存在' })
}
const manualFiles = manualEntries.map((entry) => entry.file)
for (const file of manualFiles) {
  if (existsSync(scriptPath(file)) || staleSeen.has(file)) continue
  staleSeen.add(file)
  staleEntries.push({ entry: file, reason: '登记的文件不存在' })
}

const classes = { A_auto: 0, B_p0: 0, C_shared: 0, D_gate: 0, E_tool: 0, F_manual: 0 }
const emptyClasses = { A_auto: 0, B_p0: 0, C_shared: 0, D_gate: 0, E_tool: 0, F_manual: 0 }
const classNames = Object.keys(emptyClasses)
const unclassified = []
const platforms = { win32: 0, all: 0, other: 0 }
let classifier = emptyClasses
for (const file of files) {
  const source = sources.get(file) ?? ''
  const header = source.split(/\r?\n/u).slice(0, 20).join('\n')
  const platform = /@platform\s+([^\r\n]*)/u.exec(header)
  if (platform === null) platforms.all += 1
  else if (platform[1].split(/[\s,]+/u).includes('win32')) platforms.win32 += 1
  else platforms.other += 1

  if (unreadable.has(file)) {
    unclassified.push({ file, reason: 'unreadable：文件读不了，无法归类' })
    continue
  }
  if (isAutoDiscovered(file)) classifier.A_auto += 1
  else if (probes.includes(file)) classifier.B_p0 += 1
  else if (file.startsWith('_')) classifier.C_shared += 1
  else if (scriptTexts.some((text) => commandMentions(text, file))) classifier.D_gate += 1
  else if (referenced.has(file)) classifier.E_tool += 1
  else if (manualFiles.includes(file)) classifier.F_manual += 1
  else unclassified.push({ file, reason: '不属于任何一类' })
}
for (const name of classNames) classes[name] = classifier[name] ?? 0

/** B 与 F 同时命中：登记表该删这条，按 B 算（先到先得），并退 1 提醒。 */
const duplicates = manualFiles.filter((file) => probes.includes(file))

const matrixProblems = []
const matrixCells = []
if (options.matrix) {
  for (const tool of MATRIX_TOOLS) {
    for (const path of MATRIX_PATHS) {
      const value = CAPABILITY_MATRIX[`${tool}/${path}`]
      const isGap = value.startsWith('gap:')
      const reason = isGap ? value.slice('gap:'.length).trim() : ''
      if (isGap && reason === '') matrixProblems.push(`${tool}/${path} 的 gap 没写理由`)
      if (!isGap && (!existsSync(scriptPath(value)) || !files.includes(value))) {
        matrixProblems.push(`${tool}/${path} 指向的探针不存在或不在扫描范围：${value}`)
      }
      matrixCells.push({ tool, path, value, exists: isGap ? false : files.includes(value) })
    }
  }
  const missing = MATRIX_TOOLS.flatMap((tool) => MATRIX_PATHS.map((path) => `${tool}/${path}`)).filter(
    (key) => !(key in CAPABILITY_MATRIX),
  )
  for (const key of missing) matrixProblems.push(`能力矩阵缺格：${key}`)
}

const ok = unclassified.length === 0 && staleEntries.length === 0 && duplicates.length === 0 && matrixProblems.length === 0
const report = {
  version: 1,
  runId: makeRunId(),
  root: toPosix(scanRoot),
  total: files.length,
  classes,
  platforms,
  unclassified,
  staleEntries,
  subdirWarn,
}
if (options.matrix) report.matrix = { tools: MATRIX_TOOLS, paths: MATRIX_PATHS, cells: matrixCells }

/** 摘要行：人类输出与 `--json` 的 stderr 共用一份，口径就不会漂。 */
const summaryLines = []
summaryLines.push(`探针孤儿台账（${GATE}）runId=${report.runId}`)
summaryLines.push(`  扫描目录 ${report.root}，.mjs 共 ${String(report.total)} 条`)
for (const name of classNames) summaryLines.push(`  ${name.padEnd(9)} ${String(classes[name])}`)
summaryLines.push(`  platforms win32=${String(platforms.win32)} all=${String(platforms.all)} other=${String(platforms.other)}`)
if (unclassified.length > 0) {
  summaryLines.push(`  ✗ 未归类 ${String(unclassified.length)} 条：`)
  for (const item of unclassified) summaryLines.push(`    - ${item.file}：${item.reason}`)
}
if (staleEntries.length > 0) {
  summaryLines.push(`  ✗ 失效登记 ${String(staleEntries.length)} 条：`)
  for (const item of staleEntries) summaryLines.push(`    - ${item.entry}：${item.reason}`)
}
if (duplicates.length > 0) {
  summaryLines.push(`  ! 重复登记（B 与 F 同时命中，按 B 算，登记表请删这几条）：${duplicates.join('、')}`)
}
if (subdirWarn.length > 0) {
  summaryLines.push(`  ! 子目录（发现器只读一层，里面的 .mjs 永远不会自动跑）：${subdirWarn.join('、')}`)
}
if (options.matrix) {
  const gaps = matrixCells.filter((cell) => cell.value.startsWith('gap:')).length
  summaryLines.push(`  能力矩阵 24 格（${String(matrixCells.length)} 键），gap ${String(gaps)} 格；只做可见性，不是覆盖率指标`)
  for (const item of matrixProblems) summaryLines.push(`  ✗ ${item}`)
}
summaryLines.push(ok ? '  ✓ 全部归类' : '  ✗ 有需要处置的条目')

if (options.matrix && !options.json) {
  for (const cell of matrixCells) process.stdout.write(`  ${`${cell.tool}/${cell.path}`.padEnd(18)} ${cell.value}\n`)
}
if (options.json) {
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.stderr.write(`${summaryLines.join('\n')}\n`)
} else {
  process.stdout.write(`${summaryLines.join('\n')}\n`)
}
process.exit(ok ? 0 : 1)
