/**
 * 命令意图一致性探针（P0-10）：三个判定面读的是不是同一份「这条命令在干什么」。
 *
 * 为什么单独建一条：`git push --force` / `powershell -Command "..."` / `bash -c "..."`
 * 这三类命令在审批面、沙箱围栏、灾难地板各判一次。以前三处各写一套解析，
 * 同一段命令的程序名都能不一样（`sudo ls` 在审批面是 `sudo`、在围栏面是 `ls`），
 * 「谁更严」于是变成偶然。这里钉住三件事：
 *   1. 每条命令的意图（程序名、子命令、内联脚本、联网、写目标）都对着**写死的期望**比，
 *      不拿两个名字比同一个函数（2026-11-09 复审：那样永远为真，30 条断言等于没写）；
 *   2. 最终结论符合写下来的优先级：地板 deny > 沙箱 forbidden > 审批面 allow/ask；
 *   3. 修内联误拒的同时没有放宽任何一条 deny：内层写目标判不清的形状（`find -delete`、
 *      `for` 循环、管道末端 `Remove-Item`、`Start-Process` 二层壳）仍按「判不出」硬拒，
 *      并且按「仅查看」与「完全访问」两个权限档各算一遍最终结论——后者会把 ask 自动放行。
 *
 * 直接读 `src/*.ts`（Node 类型擦除），**不需要先 `pnpm run build`**；
 * 自检跑临时 DSC_HOME，不碰真实 `~/.dsc`。
 *
 * 跑法：node scripts/command-intent-consistency-check.mjs
 *
 * @module dsc/scripts/command-intent-consistency-check
 */
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

// 审计与配置都落在 DSC_HOME 下：先把它指到临时目录，再 import 任何内核模块。
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsc-command-intent-'))
process.env.DSC_HOME = sandboxHome
process.env.HOME = sandboxHome
process.env.USERPROFILE = sandboxHome

// 源码盘上是 .ts，import 写的是编译口径的 .js：这里把相对路径的 .js 回落到 .ts。
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    try { return await next(specifier.slice(0, -3) + '.ts', context) } catch { return next(specifier, context) }
  }
  return next(specifier, context)
}
`),
)

const cp = await import('../src/core/command-policy.ts')
const ci = await import('../src/core/command-intent.ts')
const ep = await import('../src/packages/sandbox/execpolicy.ts')
const af = await import('../src/packages/approval-floor/approval-floor.ts')

const WIN32 = process.platform === 'win32'
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsc-command-intent-ws-'))

/** 沙箱的写目标判定桩：可写根就是 WORKSPACE（与出厂策略同形：根外一律 forbidden）。 */
const checkWrite = (raw) => {
  const path = raw.replace(/^["']|["']$/g, '')
  const abs = isAbsolute(path) ? path : resolve(WORKSPACE, path)
  const inside = abs === WORKSPACE || abs.startsWith(WORKSPACE + sep)
  return inside
    ? { allowed: true, rule: 'inside-writable-root' }
    : { allowed: false, rule: 'outside-writable-roots', reason: `${path} 不在可写根里` }
}

// 每条命令新建一个地板实例：熔断（连续被拒 5 次就冷却 60 秒）会跨用例串味，
// 一旦某条用例被前一条的拒绝计数带崩，后面全是「熔断中」的假 FAIL。
const newFloor = () =>
  af.createApprovalFloor({
    readConfig: () => ({ config: af.DEFAULT_FLOOR_CONFIG, problems: [] }),
    rules: () => [],
  })

/** 一条命令的三面结论 + 按优先级落定的最终结果。 */
const inspect = async (command) => {
  const policy = cp.classifyCommand(command)
  const fence = ep.evaluateCommand(command, { networkAccess: false, checkWrite, win32: WIN32 })
  const floorVerdict = await newFloor().guard.decide({
    toolName: 'bash',
    risk: 'exec',
    cwd: WORKSPACE,
    args: { command },
    command,
    signal: new AbortController().signal,
    sessionId: 'command-intent-check',
    sessionPath: join(WORKSPACE, 'session.jsonl'),
  })
  // 优先级：地板先否决 → 沙箱围栏 → 审批面。
  const final =
    floorVerdict.action === 'deny'
      ? { by: 'floor', decision: 'deny', reason: floorVerdict.reason }
      : fence.decision === 'forbidden'
        ? { by: 'sandbox', decision: 'deny', reason: fence.reason }
        : { by: 'approval', decision: policy.decision, reason: policy.reason }
  return { policy, fence, floor: floorVerdict, final }
}

/**
 * 按权限档算最终结论（复审要求：只看三面优先级会漏掉「ask 在完全访问档等于放行」）。
 *
 * 档位口径取自 `packages/approval/index.ts` 与 `packages/sandbox/index.ts`：
 *   - 「完全访问」：沙箱整档交出去（`sandbox/index.ts:288` 直接 defer），审批层把非 deny 一律放行
 *     （`approval/index.ts:1332`）；
 *   - 「仅查看」：只放行只读命令，其余直接拒（`approval/index.ts:1318-1327`）；
 *   - 「工作区自动编辑」：只读命令放行，需要确认的命令仍弹卡。
 * 地板不看权限档，任何档位都排在它们前面（order 5）。
 */
const finalAt = (r, mode) => {
  if (r.floor.action === 'deny') return { by: 'floor', decision: 'deny', reason: r.floor.reason }
  if (mode !== 'full-access' && r.fence.decision === 'forbidden') return { by: 'sandbox', decision: 'deny', reason: r.fence.reason }
  if (r.policy.decision === 'deny') return { by: 'approval', decision: 'deny', reason: r.policy.reason }
  if (mode === 'full-access') return { by: 'approval', decision: 'allow', reason: '「完全访问」档自动放行' }
  if (r.policy.decision === 'allow') return { by: 'approval', decision: 'allow', reason: r.policy.reason }
  if (mode === 'readonly') return { by: 'approval', decision: 'deny', reason: '「仅查看」档不放行需要确认的命令' }
  return { by: 'approval', decision: 'ask', reason: r.policy.reason }
}

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

/** 取第一段的意图（这些用例都是一段命令；多段命令在 [1] 的用例里单独钉）。 */
const intentOf = (command) => ci.commandIntent(cp.splitSegments(command)[0], WIN32)

// ── [1] 意图一致：共享模块、围栏面、审批面看的是同一份事实 ──────────────────────
console.log('[1] 意图一致（verb / 子命令 / 内联 / 联网 / 写目标）')

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])

// 每条用例的期望都是写死的，**不拿共享模块的值去比围栏面的值**：`execpolicy.ts:34` 把这三个函数
// 原样 re-export，两个名字指向同一个函数，自比永远为真（2026-11-09 复审实测函数引用相等）。
// 列：命令、verb、effectiveVerb、子命令（'*' = 不钉）、内联脚本、联网、写目标。
const INTENT_CASES = [
  ['git push --force', 'git', 'git', 'push', null, true, []],
  ['git status', 'git', 'git', 'status', null, false, []],
  ['npm test', 'npm', 'npm', 'test', null, false, []],
  ['Get-Content a.txt', 'get-content', 'get-content', 'a.txt', null, false, []],
  ['rm -rf node_modules', 'rm', 'rm', 'node_modules', null, false, ['node_modules']],
  ['curl http://x', 'curl', 'curl', 'http://x', null, true, []],
  ['sudo ls', 'sudo', 'ls', undefined, null, false, []],
  ['powershell -Command "Get-Content .env"', 'powershell', 'powershell', 'Get-Content .env', 'Get-Content .env', false, []],
  ['cmd /c "del x"', 'cmd', 'cmd', '*', 'del x', false, []],
  ['bash -c "rm -rf /"', 'bash', 'bash', undefined, 'rm -rf /', false, []],
  // 写目标表：四张表各自的口径（`cp` 只算最后一个词元、`mv` 算全部、`>` 与 `-Path` 都要认）。
  ['cp a b', 'cp', 'cp', 'a', null, false, ['b']],
  ['mv a b', 'mv', 'mv', 'a', null, false, ['a', 'b']],
  ['echo x > out.txt', 'echo', 'echo', 'x', null, false, ['out.txt']],
  ['Set-Content -Path x.txt -Value hi', 'set-content', 'set-content', 'x.txt', null, false, ['x.txt']],
  ['Remove-Item -Recurse -Force C:\\Windows', 'remove-item', 'remove-item', 'C:\\Windows', null, false, ['C:\\Windows']],
  ['dd if=a of=b', 'dd', 'dd', 'if=a', null, false, ['b']],
]

for (const [command, verb, effectiveVerb, subcommand, inline, network, targets] of INTENT_CASES) {
  const segment = cp.splitSegments(command)[0]
  const intent = ci.commandIntent(segment, WIN32)
  check(
    `${command} → 意图 verb / effectiveVerb / 子命令 / 联网`,
    intent.verb === verb &&
      intent.effectiveVerb === effectiveVerb &&
      (subcommand === '*' || (intent.subcommand ?? null) === (subcommand ?? null)) &&
      intent.network === network,
    JSON.stringify({ verb: intent.verb, effectiveVerb: intent.effectiveVerb, subcommand: intent.subcommand, network: intent.network }),
  )
  check(
    `${command} → 内联脚本`,
    (intent.inline === null ? null : intent.inline.command) === inline &&
      (intent.inline === null ? null : intent.inline.parseable) === (inline === null ? null : true),
    JSON.stringify(intent.inline),
  )
  check(`${command} → 写目标`, sameList(intent.targets, targets), JSON.stringify(intent.targets))
  // 围栏面读的是同一份实现，这里断言的是「它给出的值等于写死的期望」，不是「等于它自己」。
  check(`${command} → 围栏面联网`, ep.isNetworkSegment(segment, WIN32) === network, String(ep.isNetworkSegment(segment, WIN32)))
  check(`${command} → 围栏面内层脚本`, ep.innerShellCommand(segment, WIN32) === inline, String(ep.innerShellCommand(segment, WIN32)))
  check(`${command} → 围栏面写目标`, sameList(ep.writeTargetsOf(segment, WIN32), targets), JSON.stringify(ep.writeTargetsOf(segment, WIN32)))
}

// 审批面按 `verb` 判只读：sudo 不能被剥掉，否则 `sudo ls` 会从「问人」变成「放行」。
check('审批面不剥 sudo（sudo ls 仍要问人）', cp.classifyCommand('sudo ls').decision === 'ask')
check('审批面不剥 sudo（sudo rm -rf / 仍是 deny）', cp.classifyCommand('sudo rm -rf /').decision === 'deny')
check('围栏面剥 sudo（sudo rm 的写目标看得见）', ep.writeTargetsOf(cp.splitSegments('sudo rm -rf /')[0], WIN32).includes('/'))
check('编码命令内联不可解析', intentOf('powershell -EncodedCommand ZgBvAG8A').inline?.parseable === false)
check('git 带值开关后仍认得出子命令', intentOf('git -c x=y reset --hard').subcommand === 'reset')

// ── [2] 三面结论表（报告里的 3×3）────────────────────────────────────────────
console.log('[2] 三面结论与最终结果')

const THREE_BY_THREE = [
  // 命令、审批面、围栏面、地板、最终由谁否决
  ['git push --force', 'ask', 'forbidden', 'defer', 'sandbox'],
  ['powershell -Command "Get-Content .env"', 'ask', 'prompt', 'deny', 'floor'],
  ['rm -rf /', 'deny', 'forbidden', 'deny', 'floor'],
]

for (const [command, policyWant, fenceWant, floorWant, by] of THREE_BY_THREE) {
  const r = await inspect(command)
  check(
    `${command} → 三面结论`,
    r.policy.decision === policyWant && r.fence.decision === fenceWant && r.floor.action === floorWant,
    JSON.stringify({ policy: r.policy.decision, fence: r.fence.decision, floor: r.floor.action }),
  )
  check(`${command} → 最终由 ${by} 否决`, r.final.by === by && r.final.decision === 'deny', JSON.stringify(r.final))
}

// ── [3] 最终结果符合优先级，且没有放宽任何现有 deny ─────────────────────────────
console.log('[3] 三面优先级（不套权限档；档位口径在 [4] 单独算）')

const FINAL_CASES = [
  // 命令、最终由谁定、结论、理由里必须出现的一段字
  ['git status', 'approval', 'allow', '只读'],
  ['npm test', 'approval', 'ask', '需要授权'],
  ['Get-Content a.txt', 'approval', 'allow', '只读'],
  ['rm -rf node_modules', 'approval', 'ask', '递归删除'],
  ['curl http://x', 'sandbox', 'deny', '网络'],
  ['bash -c "rm -rf /"', 'floor', 'deny', '根目录'],
  // 内联误拒的修复：干净的内层命令现在能走到审批卡，不再被地板一律拒掉。
  ['powershell -Command "Get-Content a.txt"', 'approval', 'ask', '需要授权'],
  ['cmd /c "del x"', 'approval', 'ask', '需要授权'],
  // 安全不回退：编码命令、灾难命令、越界写、强推的网络围栏仍然拒。
  ['powershell -EncodedCommand ZgBvAG8A', 'floor', 'deny', '编码'],
  ['rm -rf C:\\Windows', 'sandbox', 'deny', '写目标'],
  ['sudo rm -rf /', 'floor', 'deny', '根目录'],
  ['git -c x=y reset --hard', 'approval', 'ask', '需要授权'],
  ['time shutdown now', 'floor', 'deny', '停掉'],
  ['git push', 'sandbox', 'deny', '网络'],
  ['pnpm install', 'sandbox', 'deny', '网络'],
]

for (const [command, by, decision, hint] of FINAL_CASES) {
  const r = await inspect(command)
  check(
    `${command} → ${by}/${decision}（理由含「${hint}」）`,
    r.final.by === by && r.final.decision === decision && r.final.reason.includes(hint),
    JSON.stringify(r.final),
  )
}

// 围栏先拦下时，必须把审批面的结论写进理由（P0-10 的「卡不弹」至少要有解释）。
const push = await inspect('git push --force')
check('强推被沙箱拦下时，理由里说明审批面要人工确认', push.fence.reason.includes('需要人工确认'), push.fence.reason)
check('提示不说死「会弹卡」：弹不弹由权限档与已授权规则决定', !push.fence.reason.includes('会弹卡问人'), push.fence.reason)
const fetch = await inspect('git fetch')
check('只读网络命令被沙箱拦下时，理由里说明审批面本会放行', fetch.fence.reason.includes('判为只读'), fetch.fence.reason)
const outside = await inspect('rm -rf C:\\Windows')
check('写目标越界的拒绝理由也带审批面结论', outside.fence.reason.includes('审批面'), outside.fence.reason)

// ── [4] 复审列出的 4 条回归用例：内层写目标判不清必须硬拒 ────────────────────────
// 这 4 条在「地板递归判内层、内层看着干净就 defer」的版本里从硬拒变成审批卡，
// 而「完全访问」档的审批卡会自动放行（approval/index.ts:1332），等于任何权限模式都能跑。
console.log('[4] 回归：内层写目标判不清的形状仍按「判不出」硬拒（含两个权限档）')

const REGRESSION_CASES = [
  // 命令、认不清的是谁
  ['bash -c "find / -delete"', 'find'],
  ['cmd /c "for %f in (C:\\Windows\\*) do del %f"', 'for'],
  ['powershell -Command "Get-ChildItem C:\\Windows | Remove-Item -Recurse -Force"', '管道末端的 Remove-Item'],
  ['powershell -Command "Start-Process cmd -ArgumentList \'/c del C:\\Windows\\x\'"', 'Start-Process 二层壳'],
]

for (const [command, who] of REGRESSION_CASES) {
  const r = await inspect(command)
  check(`${command} → 地板硬拒（${who} 的写目标判不清）`, r.floor.action === 'deny' && r.floor.reason.includes('判不清写目标'), JSON.stringify(r.floor))
  const ro = finalAt(r, 'readonly')
  const fa = finalAt(r, 'full-access')
  check(`${command} → 「仅查看」档拒`, ro.decision === 'deny', JSON.stringify(ro))
  check(`${command} → 「完全访问」档也拒（不得被自动放行）`, fa.by === 'floor' && fa.decision === 'deny', JSON.stringify(fa))
}

// ── [5] 对照：干净的内联命令仍要放行，灾难与判不清的命令仍要拒 ──────────────────
console.log('[5] 对照：`bash -c "ls"` 放行、`bash -c "rm -rf /"` 拒')

const ls = await inspect('bash -c "ls"')
check('bash -c "ls" → 地板不拦（defer）', ls.floor.action === 'defer', JSON.stringify(ls.floor))
check('bash -c "ls" → 「完全访问」档放行', finalAt(ls, 'full-access').decision === 'allow', JSON.stringify(finalAt(ls, 'full-access')))

const rmRoot = await inspect('bash -c "rm -rf /"')
check('bash -c "rm -rf /" → 地板硬拒（删根目录）', rmRoot.floor.action === 'deny' && rmRoot.floor.reason.includes('根目录'), JSON.stringify(rmRoot.floor))
check('bash -c "rm -rf /" → 「完全访问」档也拒', finalAt(rmRoot, 'full-access').decision === 'deny', JSON.stringify(finalAt(rmRoot, 'full-access')))

// 明确写 + 字面量写目标：围栏看得见同一个目标，可以交给审批卡。
const rmNodeModules = await inspect('bash -c "rm -rf node_modules"')
check('bash -c "rm -rf node_modules" → 地板放行到审批卡（写目标认得出）', rmNodeModules.floor.action === 'defer', JSON.stringify(rmNodeModules.floor))
// 写目标不是字面量（变量 / 通配符）：判不出它到底写哪，仍然拒。
const rmVariable = await inspect('bash -c "rm -rf $DIR"')
check('bash -c "rm -rf $DIR" → 地板硬拒（写目标不是字面量）', rmVariable.floor.action === 'deny', JSON.stringify(rmVariable.floor))
// 既不是明确只读、也不在写命令白名单：判不出，拒。
const curlInline = await inspect('sh -c "curl http://x"')
check('sh -c "curl http://x" → 地板硬拒（不在写命令白名单）', curlInline.floor.action === 'deny', JSON.stringify(curlInline.floor))
// 开关后面没有脚本：基线上是硬拒，不能因为「跑不出东西」降成审批卡。
const bareShell = await inspect('bash -c')
check('bash -c（开关后没有脚本）→ 地板硬拒', bareShell.floor.action === 'deny', JSON.stringify(bareShell.floor))
const emptyScript = await inspect('cmd /c ""')
check('cmd /c ""（空脚本）→ 地板硬拒', emptyScript.floor.action === 'deny', JSON.stringify(emptyScript.floor))
// 内层写目标认得出，但命中硬地板：照旧按灾难拒，不是交给审批卡。
const psWindows = await inspect('powershell -Command "Remove-Item -Recurse -Force C:\\Windows"')
check('powershell -Command "Remove-Item … C:\\Windows" → 地板硬拒（内层命中硬地板）', psWindows.floor.action === 'deny', JSON.stringify(psWindows.floor))

console.log('')
console.log(`PASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
