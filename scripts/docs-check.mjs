/**
 * 文档漂移检查（S3 第一批：规则 1 `code-path`、规则 2 `link`）。
 *
 * 为什么要有它：`docs/**` 与根 `AGENTS.md` 里点名的仓库路径、相对链接没有别的闸门看着。
 * 文件改名、目录迁移、链接少一层 `../`，读者照着敲就是空跑或 404，而仓库自己不会红。
 * 根 `README.md` 归 `scripts/readme-test.mjs`，本脚本**不扫**，免得同一处报两次。
 *
 * 规则：
 *   1. `code-path`：反引号里形如 `<顶层目录>/...` 的值，剥掉 `#锚点` 与 `:行号` 后必须存在
 *      （按仓库根解析；反斜杠写法先归一）。围栏代码块（``` / ~~~）整段跳过。
 *   2. `link`：`[文字](目标)`，跳过 `http(s)://`、`#锚点`、`mailto:` 等协议链接，
 *      其余**以文档所在目录为基准** resolve 后必须存在（`docs/` 里的 `../src/x` 按文档目录算）。
 *
 * 豁免（写在 markdown 的 HTML 注释里）：
 *   `<!-- docs-check:ignore: 理由 -->`         行级，作用到本行或下一行
 *   `<!-- docs-check:ignore-file: 理由 -->`    文件级，必须在前 5 行；只给「整篇都是外来内容」的极少数文件
 *   `<!-- docs-check:external: <路径前缀> -->` 放在前 5 行 = 前缀级（此后只豁免该前缀开头的值）；
 *                                              放在其他行 = 只豁免该行（不带前缀参数则豁免整行）
 *
 * 基线：`scripts/docs-check-baseline.json` 冻结「现在对、但已迁移/计划中」的存量。
 * 命中基线计入 `stats.baselined` 不判红；基线里**已不再命中**的条目报「基线过期」并退 1。
 * 基线**只许缩减**：文件里显式写 `maxEntries`，`entries.length` 超过它即退 1——新增一条必须
 * 同时在 diff 里改上限，评审看得见。本脚本**永不自动写基线**。
 *
 * 退出码：0 通过 / 1 有违规（含基线过期）/ 2 读不到文档、参数或基线文件坏。
 *
 * 统一回退（README §6.4、05-acceptance.md:78-85）：门禁名 `docs-check` 出现在环境变量
 * `NUMA_GATE_DISABLE`（逗号分隔，命中任意一项即可）时整条跳过，退 0，不跑扫描。
 *   - 人类输出：stdout 打一行「已按 NUMA_GATE_DISABLE 跳过 docs-check」；
 *   - `--json`：stdout 只有可解析的 JSON，跳过提示走 stderr，形状为
 *     `{version, stats:{checked:0,baselined:0,violations:0}, skipped:"docs-check", violations:[]}`。
 *
 * 运行：node scripts/docs-check.mjs [--json] [--rule code-path|link] [--root <dir>]
 *   `--rule` 可叠加：重复传（`--rule code-path --rule link`）或逗号分隔（`--rule code-path,link`），
 *   按规则并集跑；不传 = 跑全部规则。`--root` 只给自测用（fixture 临时目录当仓库根）。
 *
 * @module dsc/scripts/docs-check
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = 1
/** 门禁名：`NUMA_GATE_DISABLE` 里出现它就整条跳过。 */
const GATE = 'docs-check'
/** 仓库根的顶层源码目录（检出后必然存在）。`lib/` 之类构建产物不在其中：干净检出里没有它们。 */
const TOP_LEVEL_DIRS = new Set(['.github', 'bin', 'desktop', 'docs', 'examples', 'remote-web', 'scripts', 'src', 'tests', 'ui-shell'])
/** 不扫的文档子树（目录名，相对 `docs/`）与文件。理由见 design/03-spec.md §3。 */
const EXCLUDED_DIRS = new Set(['archive', 'code-review', 'research'])
const EXCLUDED_FILES = new Set(['development-log.md'])
const RULES = ['code-path', 'link']

const scriptDir = dirname(fileURLToPath(import.meta.url))

/** 收集扫描范围：`docs/**\/*.md`（去排除项）+ 根 `AGENTS.md`。 */
function collectFiles(root) {
  const docsDir = join(root, 'docs')
  if (!existsSync(docsDir) || !statSync(docsDir).isDirectory()) return null
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name)
      const rel = relative(root, abs).split('\\').join('/')
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(rel.split('/')[1])) continue
        walk(abs)
      } else if (entry.name.endsWith('.md') && !EXCLUDED_FILES.has(entry.name)) {
        files.push(abs)
      }
    }
  }
  walk(docsDir)
  const agents = join(root, 'AGENTS.md')
  if (existsSync(agents)) files.push(agents)
  return files.sort((a, b) => a.localeCompare(b))
}

/** 把围栏代码块的行替换成空行（保留行号）。 */
function withoutFences(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  let fence = null
  for (const line of lines) {
    const match = /^\s*(```+|~~~+)/.exec(line)
    if (fence === null) {
      if (match) {
        fence = match[1][0]
        out.push('')
        continue
      }
      out.push(line)
    } else {
      if (match && match[1][0] === fence) fence = null
      out.push('')
    }
  }
  return out
}

/** 解析一行的 HTML 注释豁免，返回 `{kind, arg}`；不是 docs-check 指令返回 null。 */
function exemptionOf(line) {
  const match = /<!--\s*docs-check:(ignore-file|ignore|external)\s*:\s*([^>]*?)\s*-->/.exec(line)
  if (!match) return null
  return { kind: match[1], arg: match[2].trim() }
}

/** 把反引号代码段从一行里抹掉（链接规则用），用空格占位。 */
function stripInlineCode(line) {
  return line.replace(/(`+)([^`]|[^`][\s\S]*?)\1/g, (whole) => ' '.repeat(whole.length))
}

/** 代码路径值归一。返回 `{value, dirOnly}`，`null` 表示不是候选。 */
function normalizeCodePath(raw) {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (/\s/.test(trimmed)) return null
  if (/[<>*{}$"'`]/.test(trimmed)) return null
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('~') || trimmed.includes('://')) return null
  let value = trimmed.replace(/\\/g, '/')
  if (value.startsWith('./')) value = value.slice(2)
  value = value.replace(/#[^#]*$/, '')
  // 行号后缀：`:12` `:12-34` `:148+` `:36/89/139` `:15-16,130`
  value = value.replace(/:\d+(?:[-–~,、/]\d+)*\+?$/, '')
  value = value.replace(/[。，、；：）,.;\]]+$/, '')
  if (value === '' || !value.includes('/')) return null
  // 依赖目录不是仓库内容：干净检出里没有 node_modules，「引用它」不该判红（与跳过 lib/dist 同口径）。
  if (/(^|\/)node_modules(\/|$)/.test(value)) return null
  const dirOnly = /[\\/]$/.test(trimmed)
  if (!TOP_LEVEL_DIRS.has(value.split('/')[0].toLowerCase())) return null
  if (/%[0-9a-fA-F]{2}/.test(value)) {
    try {
      value = decodeURIComponent(value)
    } catch {
      return null
    }
  }
  return { value, dirOnly }
}

/** 解析一条 markdown 链接目标；不是相对链接返回 null。带 title 的写法按 path 解析（`[x](p "t")`）。 */
function normalizeLinkTarget(raw) {
  let target = raw.trim()
  if (target === '') return null
  if (target.startsWith('<')) {
    // `<path>` 可带空格；后面允许跟 title
    const close = target.indexOf('>')
    if (close < 0) return null
    const rest = target.slice(close + 1).trim()
    target = target.slice(1, close).trim()
    if (rest !== '' && !/^("[^"]*"|'[^']*'|\([^)]*\))$/.test(rest)) return null
  } else if (/\s/.test(target)) {
    // `[x](path "title")`：第一个空白前是 path，其余必须整段是 title 引号，否则不当链接
    const path = target.split(/\s+/)[0]
    const rest = target.slice(path.length).trim()
    if (!/^("[^"]*"|'[^']*'|\([^)]*\))$/.test(rest)) return null
    target = path
  }
  if (target.startsWith('#')) return null
  if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.test(target)) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return null
  if (target.startsWith('/')) return null
  target = target.replace(/[#?].*$/, '')
  if (target === '') return null
  target = target.replace(/\\/g, '/')
  if (/%[0-9a-fA-F]{2}/.test(target)) {
    try {
      target = decodeURIComponent(target)
    } catch {
      return null
    }
  }
  return target
}

/** 检查一篇文档：返回 `{violations, checked}`（不含基线）。`checked` 是候选值个数。 */
function checkFile(abs, root, rule) {
  const rel = relative(root, abs).split('\\').join('/')
  const lines = withoutFences(readFileSync(abs, 'utf8'))
  const rowIgnores = new Set()
  const rowExternals = new Map()
  const prefixExternals = []
  let fileIgnored = false
  for (let i = 0; i < lines.length; i += 1) {
    // 先抹掉行内代码：`<!-- docs-check:ignore: ... -->` 写在反引号里只是文档示例，不是真豁免
    const exemption = exemptionOf(stripInlineCode(lines[i]))
    if (!exemption) continue
    const lineNo = i + 1
    if (exemption.kind === 'ignore-file') {
      if (lineNo <= 5) fileIgnored = true
    } else if (exemption.kind === 'ignore') {
      rowIgnores.add(lineNo)
      rowIgnores.add(lineNo + 1)
    } else if (lineNo <= 5 && exemption.arg !== '') {
      prefixExternals.push(exemption.arg.replace(/\\/g, '/'))
    } else {
      rowExternals.set(lineNo, exemption.arg.replace(/\\/g, '/'))
    }
  }
  if (fileIgnored) return { violations: [], checked: 0 }

  const violations = []
  let checked = 0
  const exempt = (lineNo, value) => {
    if (rowIgnores.has(lineNo)) return true
    if (prefixExternals.some((prefix) => value.startsWith(prefix))) return true
    const rowPrefix = rowExternals.get(lineNo)
    return rowPrefix !== undefined && (rowPrefix === '' || value.startsWith(rowPrefix))
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineNo = i + 1
    if (rule === 'code-path') {
      for (const match of line.matchAll(/(`+)([^`]|[^`][\s\S]*?)\1/g)) {
        const candidate = normalizeCodePath(match[2])
        if (candidate === null) continue
        checked += 1
        if (exempt(lineNo, candidate.value)) continue
        const target = resolve(root, candidate.value)
        let reason = null
        if (!existsSync(target)) reason = candidate.dirOnly ? '目录不存在' : '文件不存在'
        else if (candidate.dirOnly && !statSync(target).isDirectory()) reason = '目录不存在'
        if (reason !== null) violations.push({ file: rel, line: lineNo, rule, value: match[2].trim(), reason })
      }
    } else {
      const prose = stripInlineCode(line.replace(/<!--[\s\S]*?-->/g, ''))
      for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]*)\)/g)) {
        const target = normalizeLinkTarget(match[1])
        if (target === null) continue
        checked += 1
        if (exempt(lineNo, target)) continue
        if (!existsSync(resolve(dirname(abs), target))) {
          violations.push({ file: rel, line: lineNo, rule, value: match[1].trim(), reason: '链接目标不存在（按文档所在目录解析）' })
        }
      }
    }
  }
  return { violations, checked }
}

/**
 * 读基线；文件不存在当空基线，坏了退 2。
 * `maxEntries` 是「只许缩减」的显式闸门：条目数超过它，说明有人没删旧条目就塞了新的。
 */
function loadBaseline(root) {
  const path = join(root, 'scripts', 'docs-check-baseline.json')
  if (!existsSync(path)) return { entries: [], maxEntries: 0, path }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`读不了基线 ${path}：${error.message}`)
  }
  if (!Array.isArray(parsed.entries)) throw new Error(`基线格式不对（缺 entries 数组）：${path}`)
  if (!Number.isInteger(parsed.maxEntries) || parsed.maxEntries < 0) {
    throw new Error(`基线格式不对（缺整数 maxEntries；基线只许缩减，必须显式写出条目上限）：${path}`)
  }
  return { entries: parsed.entries, maxEntries: parsed.maxEntries, path }
}

function parseArgs(argv) {
  const options = { json: false, rules: [], root: resolve(scriptDir, '..') }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--rule') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--rule 缺参数')
      // 可叠加：`--rule a,b` 或重复传 `--rule a --rule b`，按并集跑（S4 复用同一入口）
      const names = value
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '')
      if (names.length === 0) throw new Error('--rule 缺参数')
      for (const name of names) {
        if (!RULES.includes(name)) throw new Error(`规则名不认识：${name}（只认 ${RULES.join(' / ')}）`)
        if (!options.rules.includes(name)) options.rules.push(name)
      }
      i += 1
    } else if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--root 缺参数')
      options.root = resolve(value)
      i += 1
    } else {
      throw new Error(`不认识的参数：${arg}`)
    }
  }
  return options
}

function main() {
  // 统一回退：参数解析之前先看 NUMA_GATE_DISABLE（口径照 scripts/probe-inventory-check.mjs：
  // 逗号分隔、去空白、命中任意一项即跳过；不静默，打一行提示后退 0）。
  const disabled = (process.env.NUMA_GATE_DISABLE ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  if (disabled.includes(GATE)) {
    const skipLine = `已按 NUMA_GATE_DISABLE 跳过 ${GATE}`
    if (process.argv.slice(2).includes('--json')) {
      // stdout 只留可解析的 JSON；跳过提示走 stderr，免得下游 JSON.parse 失败。
      process.stderr.write(`${skipLine}\n`)
      console.log(
        JSON.stringify({ version: VERSION, stats: { checked: 0, baselined: 0, violations: 0 }, skipped: GATE, violations: [] }, null, 2),
      )
    } else {
      process.stdout.write(`${skipLine}\n`)
    }
    return 0
  }

  let options
  let files
  let baseline
  try {
    options = parseArgs(process.argv.slice(2))
    if (!existsSync(options.root) || !statSync(options.root).isDirectory()) throw new Error(`--root 不是目录：${options.root}`)
    files = collectFiles(options.root)
    if (files === null) throw new Error(`读不到文档目录：${join(options.root, 'docs')}`)
    baseline = loadBaseline(options.root)
  } catch (error) {
    console.error(`docs-check: ${error.message}`)
    return 2
  }

  const activeRules = options.rules.length > 0 ? options.rules : RULES
  if (baseline.entries.length > baseline.maxEntries) {
    const violation = {
      file: relative(options.root, baseline.path).split('\\').join('/'),
      line: 0,
      rule: 'baseline',
      value: `entries=${String(baseline.entries.length)} > maxEntries=${String(baseline.maxEntries)}`,
      reason: '基线只许缩减：删条目后先把 maxEntries 调小',
    }
    if (options.json) {
      console.log(JSON.stringify({ version: VERSION, stats: { checked: 0, baselined: 0, violations: 1 }, violations: [violation] }, null, 2))
    } else {
      console.log(`docs-check: 基线只许缩减：删条目后先把 maxEntries 调小（${violation.file}: ${violation.value}）`)
    }
    return 1
  }
  const collected = []
  let checked = 0
  try {
    for (const abs of files) {
      for (const rule of activeRules) {
        const result = checkFile(abs, options.root, rule)
        collected.push(...result.violations)
        checked += result.checked
      }
    }
  } catch (error) {
    console.error(`docs-check: ${error.message}`)
    return 2
  }

  const baselineEntries = baseline.entries
  const pending = baselineEntries.filter((entry) => activeRules.includes(entry.rule))
  const used = new Set()
  const violations = []
  const seen = new Set()
  let baselined = 0
  for (const violation of collected) {
    const key = `${violation.file}\u0000${violation.line}\u0000${violation.rule}\u0000${violation.value}`
    if (seen.has(key)) continue
    seen.add(key)
    const index = pending.findIndex(
      (entry) => entry.rule === violation.rule && entry.file === violation.file && entry.value === violation.value,
    )
    if (index >= 0) {
      used.add(index)
      baselined += 1
    } else {
      violations.push(violation)
    }
  }
  for (const [index, entry] of pending.entries()) {
    if (used.has(index)) continue
    violations.push({
      file: entry.file,
      line: 0,
      rule: entry.rule,
      value: entry.value,
      reason: `基线过期：${String(entry.reason ?? '')}`,
    })
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))
  const ok = violations.length === 0

  if (options.json) {
    const payload = { version: VERSION, stats: { checked, baselined, violations: violations.length }, violations }
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log(`docs-check（规则：${activeRules.join('、')}）扫描 ${String(files.length)} 篇文档`)
    for (const violation of violations) {
      const where = violation.line === 0 ? `${violation.file}:基线` : `${violation.file}:${String(violation.line)}`
      console.log(`  ${where}  [${violation.rule}] ${JSON.stringify(violation.value)} — ${violation.reason}`)
    }
    const expired = violations.filter((violation) => violation.line === 0).length
    console.log(`基线：冻结 ${String(baselined)} 条，过期 ${String(expired)} 条`)
    console.log(`结果：检查 ${String(checked)} 处、${String(violations.length)} 条违规 → ${ok ? 'PASS' : 'FAIL'}`)
  }
  return ok ? 0 : 1
}

process.exitCode = main()
