/**
 * CI 覆盖核对：每条门禁都有明确执行位置，且「登记了但没跑」能变红。
 *
 * 四条判定规则（设计 `docs/research/harness-engineering/numa/design/02-quality-cicd.md` §Q3）：
 *   ① `package.json` 每个 `check:*` 必须出现在某条 gate 的 `cmd` 里，或在
 *      `scripts/gate-manual.json` 登记；`check:all` 与 `check:all:legacy` 是入口，豁免。
 *   ② `stage` 含 `push`/`nightly` 的 gate，`cmd` 必须能在 `.github/workflows/*.yml|*.yaml`
 *      里找到（按行拆，不把整份 YAML 当一个字符串）。
 *   ③ 台账条目必须有非空 `reason` 与非空 `ref`（`ref` 形如 `文件:行号`）。
 *   ④ 台账有而 `package.json` 已删的条目报「台账过期」。
 *
 * `cmd` 比较口径：两侧都归一化成「npm 脚本名 + 参数」。`pnpm [run] <名> [-- 参数]` → `<名>`
 * 加参数；`node scripts/<x>.mjs` → 反查 `package.json` 里值相等的脚本名（脚本名与参数都相
 * 等才算命中）；反查不到退 2 报「未知命令形态」。归一化后按整串脚本名比较，所以
 * `check:ui` 不会命中 `check:ui:e2e`（子串相等不算命中）。
 *
 * 产物/退出码：0 通过；1 有门禁没归属、登记了没跑或台账过期；2 配置错（`gate.json` 缺失或
 * 坏 JSON、台账坏 JSON、未知命令形态）。`--remind` 按设计在核对完成后打一行 P0 提醒，
 * 条数从 `scripts/check-p0.mjs` 的 `PROBES` 实读，不写死。推门入口由 `package.json` 的
 * `ci-coverage` 脚本承载（值带 `--remind`），`verify.yml` core job 跑 `pnpm run ci-coverage`，
 * 所以提醒由推门打出；`--json` 时 stdout 只留一份 JSON（提醒条数进 `remind` 字段，不打人读行）。
 *
 * 回退开关：门禁名 `ci-coverage`，设 `NUMA_GATE_DISABLE=ci-coverage`（可逗号分隔多个）时
 * 打印一行「已按 NUMA_GATE_DISABLE 跳过 ci-coverage」并退 0（05-acceptance.md §6，不许静默）。
 * `--json` 时同样守「stdout 只有一份 JSON」：stdout 打
 * `{ok:true,skipped:true,gate,reason:"NUMA_GATE_DISABLE",message}`，人读跳过行改走 stderr。
 *
 * 用法：
 *   node scripts/ci-coverage-check.mjs            # 人读报告
 *   node scripts/ci-coverage-check.mjs --json     # 机器读报告（stdout 只有一份 JSON）
 *   node scripts/ci-coverage-check.mjs --remind   # 附带 P0 清单提醒（推门入口默认带）
 *   node scripts/ci-coverage-check.mjs --root <目录>  # 核对另一份根（自测用）
 *
 * @module dsc/scripts/ci-coverage-check
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 门禁名：`NUMA_GATE_DISABLE` 里出现它就整条跳过。 */
const GATE = 'ci-coverage'
const STAGES = new Set(['push', 'nightly', 'manual'])
const GATE_FIELDS = new Set(['cmd', 'timeoutMs', 'stage', 'needs', 'informational', 'platforms'])
const CHECK_SCRIPT_EXEMPT = new Set(['check:all', 'check:all:legacy'])
const LEDGER_KINDS = new Set(['manual', 'local-only'])

function configError(message) {
  console.error(`配置错误：${message}`)
  process.exit(2)
}

// 统一回退开关（05-acceptance.md §6）：跳过时必须打一行，不许静默。
// 与 --json 的边界约定：--json 时 stdout 只留一份可 parse 的 JSON（跳过也走同一形状），
// 「已按 NUMA_GATE_DISABLE 跳过 …」这行人读提示改走 stderr；人读模式提示留在 stdout。
const jsonRequested = process.argv.slice(2).includes('--json')
const disabledGates = (process.env.NUMA_GATE_DISABLE ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '')
if (disabledGates.includes(GATE)) {
  const message = `已按 NUMA_GATE_DISABLE 跳过 ${GATE}`
  if (jsonRequested) {
    process.stderr.write(message + '\n')
    process.stdout.write(JSON.stringify({ version: 1, ok: true, skipped: true, gate: GATE, reason: 'NUMA_GATE_DISABLE', message }, null, 2) + '\n')
  } else {
    process.stdout.write(message + '\n')
  }
  process.exit(0)
}

const argv = process.argv.slice(2)
let wantJson = false
let wantRemind = false
let repoRoot = DEFAULT_ROOT
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--json') wantJson = true
  else if (arg === '--remind') wantRemind = true
  else if (arg === '--root') {
    const value = argv[i + 1]
    if (!value) configError('--root 后面缺目录')
    repoRoot = resolve(value)
    i += 1
  } else if (arg.startsWith('--root=')) {
    repoRoot = resolve(arg.slice('--root='.length))
  } else {
    configError(`未知参数「${arg}」（只接受 --json / --remind / --root <目录>）`)
  }
}

/** 读 JSON：缺文件可选返回 null；坏 JSON 一律退 2（配置错不能看起来像检查没过）。 */
function readJson(file, label, { optional = false } = {}) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (optional) return null
    configError(`${label} 读不到：${file}（${error.code ?? error.message}）`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    configError(`${label} 不是合法 JSON：${error.message}`)
  }
}

const pkg = readJson(join(repoRoot, 'package.json'), 'package.json')
const scripts = pkg?.scripts
if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
  configError('package.json 里没有 scripts 对象')
}

/** 归一化出一条命令的「npm 脚本名 + 参数」；认不出的形态直接退 2。 */
function normalizeCommand(cmd) {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) configError('门禁 cmd 是空串')
  if (tokens.some((token) => ['&&', '||', ';', '|'].includes(token))) {
    configError(`未知命令形态（门禁 cmd 只许单条命令，多条请拆成多个门禁用 needs 串）：${cmd}`)
  }
  if (tokens[0] === 'pnpm') {
    const rest = tokens.slice(1)
    const hasRun = rest[0] === 'run'
    const name = hasRun ? rest[1] : rest[0]
    const args = hasRun ? rest.slice(2) : rest.slice(1)
    if (!name || name.startsWith('-')) configError(`未知命令形态（pnpm 后面没有脚本名）：${cmd}`)
    return { name, args }
  }
  if (tokens[0] === 'node') {
    const exact = Object.entries(scripts).find(([, value]) => value.trim() === cmd.trim())
    if (!exact) configError(`未知命令形态（node 命令在 package.json 里反查不到脚本）：${cmd}`)
    return { name: exact[0], args: [] }
  }
  configError(`未知命令形态：${cmd}`)
}

const gateDoc = readJson(join(repoRoot, 'scripts', 'gate.json'), 'scripts/gate.json')
if (gateDoc?.version !== 1) configError('scripts/gate.json 的 version 必须是 1')
const gates = gateDoc?.gates
if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
  configError('scripts/gate.json 缺 gates 对象')
}

const gateEntries = []
for (const [name, gate] of Object.entries(gates)) {
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) configError(`门禁 ${name} 不是对象`)
  for (const key of Object.keys(gate)) {
    if (!GATE_FIELDS.has(key)) configError(`门禁 ${name} 多了契约外字段「${key}」（§2.2 只许 cmd/timeoutMs/stage/needs/informational/platforms）`)
  }
  if (typeof gate.cmd !== 'string' || gate.cmd.trim() === '') configError(`门禁 ${name} 的 cmd 缺失或不是字符串`)
  if (typeof gate.timeoutMs !== 'number' || !Number.isFinite(gate.timeoutMs) || gate.timeoutMs <= 0) {
    configError(`门禁 ${name} 的 timeoutMs 必须是正数`)
  }
  if (!Array.isArray(gate.stage) || gate.stage.length === 0) configError(`门禁 ${name} 的 stage 必须是非空数组`)
  for (const stage of gate.stage) {
    if (!STAGES.has(stage)) configError(`门禁 ${name} 的 stage「${stage}」不在 push/nightly/manual 里`)
  }
  if (!Array.isArray(gate.needs)) configError(`门禁 ${name} 的 needs 必须是数组`)
  for (const need of gate.needs) if (typeof need !== 'string') configError(`门禁 ${name} 的 needs 里有非字符串`)
  if (gate.informational !== undefined && typeof gate.informational !== 'boolean') {
    configError(`门禁 ${name} 的 informational 必须是布尔`)
  }
  if (gate.platforms !== undefined) {
    if (!Array.isArray(gate.platforms) || gate.platforms.some((item) => typeof item !== 'string')) {
      configError(`门禁 ${name} 的 platforms 必须是字符串数组`)
    }
  }
  const normalized = normalizeCommand(gate.cmd)
  gateEntries.push({ key: name, name: normalized.name, args: normalized.args, gate })
}
const gateKeys = new Set(Object.keys(gates))
const gateScriptNames = new Set(gateEntries.map((entry) => entry.name))
for (const entry of gateEntries) {
  for (const need of entry.gate.needs) {
    if (!gateKeys.has(need)) configError(`门禁 ${entry.key} 的 needs 引用了不存在的门禁「${need}」`)
  }
}

const ledgerDoc = readJson(join(repoRoot, 'scripts', 'gate-manual.json'), 'scripts/gate-manual.json', { optional: true })
if (ledgerDoc !== null && ledgerDoc.version !== 1) configError('scripts/gate-manual.json 的 version 必须是 1')
const ledger = ledgerDoc?.entries ?? {}
if (typeof ledger !== 'object' || Array.isArray(ledger)) configError('scripts/gate-manual.json 的 entries 必须是对象')
const ledgerNames = new Set(Object.keys(ledger))

/** 扫全部 workflow，把每行里出现的 `pnpm [run] <脚本名>` 抽成 {name, args}。 */
function collectWorkflowCommands() {
  const dir = join(repoRoot, '.github', 'workflows')
  let files = []
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .sort()
  } catch {
    return []
  }
  const commands = []
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      // 先剥 YAML 注释：注释掉的步骤不算「跑过」，否则规则②会被注释骗绿。
      const line = rawLine.replace(/(^|\s+)#.*$/, '')
      const tokens = line.trim().split(/\s+/).filter(Boolean)
      for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i] !== 'pnpm') continue
        const rest = tokens.slice(i + 1)
        const hasRun = rest[0] === 'run'
        const name = hasRun ? rest[1] : rest[0]
        if (!name || name.startsWith('-')) continue
        const args = []
        for (let j = hasRun ? 2 : 1; j < rest.length; j += 1) {
          if (['&&', '||', ';', '|'].includes(rest[j])) break
          args.push(rest[j])
        }
        commands.push({ name, args })
      }
    }
  }
  return commands
}

/** 门禁参数必须是 workflow 行里那条命令参数的前缀（空参数 = 只要脚本名对上）。 */
function argsStartWith(workflowArgs, gateArgs) {
  if (gateArgs.length > workflowArgs.length) return false
  return gateArgs.every((arg, index) => workflowArgs[index] === arg)
}

const errors = []
const warnings = []
const workflowCommands = collectWorkflowCommands()

// 门禁 cmd 指向的脚本必须还在 package.json（登记了但脚本被删也是「没跑」）。
for (const entry of gateEntries) {
  if (!Object.hasOwn(scripts, entry.name)) {
    errors.push({
      code: 'gate-script-missing',
      message: `门禁「${entry.key}」的 cmd「${entry.gate.cmd}」指向的脚本在 package.json 里不存在（登记了没跑）`,
    })
  }
}

// 规则②：push / nightly 门禁必须真的被某条 workflow 调用。
for (const entry of gateEntries) {
  const wantsCi = entry.gate.stage.some((stage) => stage === 'push' || stage === 'nightly')
  if (!wantsCi) continue
  const found = workflowCommands.some((command) => command.name === entry.name && argsStartWith(command.args, entry.args))
  if (!found) {
    errors.push({
      code: 'gate-not-in-ci',
      message: `门禁「${entry.key}」的 stage 含 ${entry.gate.stage.join('/')}，但 cmd「${entry.gate.cmd}」在 .github/workflows/*.yml|*.yaml 里找不到（登记了没跑）`,
    })
  }
}

// 规则①：每个 check:* 都要有归属。
const checkScripts = Object.keys(scripts).filter((name) => name.startsWith('check:'))
const orphanChecks = []
for (const name of checkScripts) {
  if (CHECK_SCRIPT_EXEMPT.has(name)) continue
  if (gateScriptNames.has(name) || ledgerNames.has(name)) continue
  orphanChecks.push(name)
  errors.push({
    code: 'check-not-registered',
    message: `package.json 的「${name}」既不在任何门禁 cmd 里，也没登记进 scripts/gate-manual.json（有门禁没归属）`,
  })
}

// 规则③：台账条目要写清为什么、证据在哪。
for (const [name, entry] of Object.entries(ledger)) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) configError(`台账「${name}」不是对象`)
  if (!LEDGER_KINDS.has(entry.kind)) configError(`台账「${name}」的 kind 必须是 manual 或 local-only`)
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    errors.push({ code: 'ledger-missing-reason', message: `台账「${name}」的 reason 为空（登记了没理由）` })
  }
  const ref = typeof entry.ref === 'string' ? entry.ref.trim() : ''
  if (ref === '') {
    errors.push({ code: 'ledger-missing-ref', message: `台账「${name}」的 ref 为空（登记了没有 文件:行号）` })
  } else if (!/^.+:\d+(?:-\d+)?$/.test(ref)) {
    errors.push({ code: 'ledger-bad-ref', message: `台账「${name}」的 ref「${ref}」不是 文件:行号 形态` })
  }
}

// 规则④：台账有、package.json 已删 = 台账过期。
for (const name of ledgerNames) {
  if (!Object.hasOwn(scripts, name)) {
    errors.push({ code: 'ledger-stale', message: `台账「${name}」在 package.json 里已删（台账过期）` })
  }
}

// 规则③的松档：manual 门禁没登记理由只提醒，下一批再收紧成红。
for (const entry of gateEntries) {
  if (!entry.gate.stage.includes('manual') || ledgerNames.has(entry.name)) continue
  warnings.push({
    code: 'manual-unregistered',
    message: `门禁「${entry.key}」是 manual，但 scripts/gate-manual.json 里没写理由（本条暂只提醒）`,
  })
}

/** 从 scripts/check-p0.mjs 的 PROBES 数组实读探针条数，读不到返回 null。 */
function readP0ProbeCount() {
  try {
    const text = readFileSync(join(repoRoot, 'scripts', 'check-p0.mjs'), 'utf8')
    const start = text.indexOf('const PROBES')
    if (start === -1) return null
    const open = text.indexOf('[', start)
    const close = text.indexOf('\n]', open)
    if (open === -1 || close === -1) return null
    return (text.slice(open, close).match(/\{\s*file:/g) ?? []).length
  } catch {
    return null
  }
}

const ok = errors.length === 0
const countByStage = (stage) => gateEntries.filter((entry) => entry.gate.stage.includes(stage)).length
const result = {
  version: 1,
  ok,
  root: repoRoot,
  gates: {
    total: gateEntries.length,
    push: countByStage('push'),
    nightly: countByStage('nightly'),
    manual: countByStage('manual'),
    names: gateEntries.map((entry) => entry.key),
  },
  ledger: {
    total: ledgerNames.size,
    manual: Object.values(ledger).filter((entry) => entry?.kind === 'manual').length,
    localOnly: Object.values(ledger).filter((entry) => entry?.kind === 'local-only').length,
  },
  checkScripts: {
    total: checkScripts.length,
    exempt: checkScripts.filter((name) => CHECK_SCRIPT_EXEMPT.has(name)).length,
    owned: checkScripts.filter((name) => !CHECK_SCRIPT_EXEMPT.has(name) && (gateScriptNames.has(name) || ledgerNames.has(name))).length,
    orphans: orphanChecks,
  },
  errors,
  warnings,
}
if (wantRemind) result.remind = { p0Probes: readP0ProbeCount() }

if (wantJson) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(ok ? 0 : 1)
}

console.log(`CI 覆盖核对：${repoRoot}`)
console.log(
  `门禁 ${result.gates.total} 条：push ${result.gates.push} / nightly ${result.gates.nightly} / manual ${result.gates.manual}；` +
    `台账 ${result.ledger.total} 条：manual ${result.ledger.manual} / local-only ${result.ledger.localOnly}`,
)
console.log(
  `check:* 脚本 ${result.checkScripts.total} 条：豁免 ${result.checkScripts.exempt} 条（入口）、` +
    `已归属 ${result.checkScripts.owned} 条、孤儿 ${orphanChecks.length} 条`,
)
for (const warning of warnings) console.log(`提醒：${warning.message}`)
for (const error of errors) console.error(`错误：${error.message}`)
if (wantRemind) {
  // 人读行只在非 --json 模式打：--json 的 stdout 必须是可 JSON.parse 的单份报告，
  // 提醒条数走 result.remind。推门（package.json 的 ci-coverage 脚本）带 --remind。
  const count = result.remind?.p0Probes
  if (count === null || count === undefined) {
    console.log('本次改动可能影响 P0 清单（scripts/check-p0.mjs 读不到 PROBES，跳过计数），请手动跑 `pnpm run check:p0`')
  } else {
    console.log(`本次改动可能影响 P0 清单中的 ${count} 条，请手动跑 \`pnpm run check:p0\``)
  }
}
if (ok) {
  console.log('通过：所有 check:* 都有归属，push/nightly 门禁都能在 workflow 里找到，台账无过期条目。')
  process.exit(0)
}
console.log(`未通过：${errors.length} 条问题。`)
process.exit(1)
