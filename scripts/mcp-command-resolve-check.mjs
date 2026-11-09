/**
 * MCP 启动命令解析探针（P0-14）。
 *
 * 为什么单独建一条：设置页给的官方示例是 `"command": "npx"`。Windows 上 Node 只执行 PE 文件，
 * 而 PATH 里那个无后缀的 `npx` 是 npm 安装器留的 bash 包装脚本（本机 2073 字节，开头
 * `#!/usr/bin/env bash`）：`existsSync` 认得出它，`spawn(..., {shell:false})` 却起不来
 * （实测 ENOENT）。老实现把无后缀候选排在前面，于是「示例照抄就起不来」，而 LSP 那边
 * 的顺序是相反的（后缀优先）。这条探针钉住四件事：
 *
 *   [1] 真机上 `resolveCommand('npx')` 解析到带后缀的那份，`needsShell` 与后缀一致；
 *   [2] 候选顺序：同一目录里无后缀包装脚本与 `.cmd` 并存时，必须选 `.cmd`；
 *   [3] 只有 `.cmd` / `.bat` 才走 shell，`.exe` 与 POSIX 命令一律 shell:false（不能永远 shell:true）；
 *      经 shell 时文件路径含空格要加引号——cmd 会把 `D:\New Folder\npx.cmd` 拆成两段（实测 exit 1）；
 *   [4] 找不到命令时给可读错误：用户要能分出「没装」与「解析失败（环境里没有 PATH）」。
 *
 * 直接读 `src/**\/*.ts`（Node 类型擦除），**不需要先 `pnpm run build`**；不连任何 server、不写盘。
 *
 * 跑法：node scripts/mcp-command-resolve-check.mjs
 *
 * @module dsc/scripts/mcp-command-resolve-check
 */
import { register } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// mcp.ts 用了构造器参数属性（`private readonly child: ChildProcess`），Node 的类型擦除
// 搬不动这种语法，要 --experimental-transform-types 才能直读源码；本文件被直接 node 起来时
// 自己补上这个开关再跑一遍（少了它只会得到一条 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。
if (!process.execArgv.includes('--experimental-transform-types')) {
  const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-transform-types', import.meta.filename], {
    stdio: 'inherit',
  })
  if (child.status === 9) {
    console.log('  FAIL 这个 Node 不认 --experimental-transform-types，读不了 mcp.ts（升级 Node，或先在 Node 24 上跑）')
  }
  process.exit(child.status ?? 1)
}

// 源码盘上是 .ts、import 写的是编译口径的 .js：把相对路径的 .js 回落到 .ts。
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

const WIN = process.platform === 'win32'
let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

console.log('MCP 启动命令解析（Windows 上 `command: "npx"`）')

let mcp = null
let core = null
try {
  mcp = await import('../src/packages/mcp/mcp.ts')
  core = await import('../src/core/executable.ts')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.log(`  FAIL 读不到解析实现（mcp.ts 的 resolveCommand / core/executable.ts 的 resolveExecutable）：${message}`)
  console.log('PASS 0 / FAIL 1')
  process.exitCode = 1
  process.exit()
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const env = { PATH: process.env.PATH ?? '', PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD' }

// ── [1] 真机：npx 必须解析到带后缀的那份 ──────────────────────────────────────
// 这台机器的 PATH 里根本没有 npx 时跳过（照「若 PATH 里确实有」），
// 但「有候选却没解析出来」仍然是 FAIL——那正是本探针要抓的形状。
{
  const dirs = String(env.PATH ?? '')
    .split(WIN ? ';' : ':')
    .filter((dir) => dir !== '')
  const present = dirs.some((dir) => (WIN ? ['npx', 'npx.cmd', 'npx.exe'] : ['npx']).some((name) => existsSync(join(dir, name))))
  const plan = mcp.resolveCommand('npx', env, repoRoot)
  const name = basename(plan.file).toLowerCase()
  if (!present) {
    console.log('  SKIP 真机 npx（这台机器的 PATH 里没有 npx）')
  } else if (WIN) {
    // 本机实测：D:\New Folder\npx（2073 字节的 bash 脚本）与 npx.cmd 并存，无后缀那份起不来。
    check(
      'npx 解析到带后缀的文件，不是无后缀的 sh 包装脚本',
      plan.found === true && name !== 'npx' && /\.(com|exe|bat|cmd)$/.test(name),
      `file=${plan.file}`,
    )
    const declared = String(env.PATHEXT ?? '')
      .split(';')
      .filter((suffix) => suffix !== '')
      .map((suffix) => suffix.toLowerCase())
    check('解析结果的后缀在 PATHEXT 里（不是瞎猜的扩展名）', declared.some((suffix) => name.endsWith(suffix)), `file=${plan.file}`)
  } else {
    check('POSIX 上解析到绝对路径，且不经 shell', plan.found === true && plan.file.startsWith('/') && plan.shell === false, `file=${plan.file}`)
  }
  if (present) {
    check(
      'needsShell 与后缀一致（只有 .cmd / .bat 才是 true）',
      plan.shell === /\.(cmd|bat)$/.test(name),
      `shell=${plan.shell} file=${plan.file}`,
    )
    const needsQuote = plan.shell && /[\s"&|<>^()]/.test(plan.file)
    check(
      '交给 spawn 的 file 在需要时加了引号（含空格的路径不加会被 cmd 拆开：实测 exit 1）',
      plan.spawnFile === (needsQuote ? `"${plan.file}"` : plan.file),
      `spawnFile=${plan.spawnFile}`,
    )
  }
}

// ── [2][3] 造一个临时目录：无后缀包装脚本与 .cmd 并存，目录名带空格 ───────────
// PATHEXT 是 Windows 的概念，这三条在 POSIX 上没有意义（那边无后缀就是正解），跳过。
if (WIN) {
  const sandbox = mkdtempSync(join(tmpdir(), 'dsc-mcp-resolve-'))
  try {
    const spaced = join(sandbox, 'has space')
    mkdirSync(spaced)
    writeFileSync(join(spaced, 'mytool'), '#!/usr/bin/env bash\n') // 照本机 npx 的样子：无后缀 sh 脚本
    writeFileSync(join(spaced, 'mytool.cmd'), '@ECHO OFF\r\n')
    const synthetic = { PATH: spaced, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    const pick = mcp.resolveCommand('mytool', synthetic, sandbox)
    check('同一目录里无后缀包装脚本与 .cmd 并存时，选 .cmd 那份', pick.found === true && pick.file.toLowerCase().endsWith('mytool.cmd'), `file=${pick.file}`)
    check('选中的 .cmd 标了 needsShell', pick.shell === true, `shell=${pick.shell}`)
    check('路径含空格时 spawnFile 已加引号', pick.spawnFile === `"${pick.file}"`, `spawnFile=${pick.spawnFile}`)

    writeFileSync(join(sandbox, 'only.exe'), 'MZ')
    const exePlan = mcp.resolveCommand('only', { PATH: sandbox, PATHEXT: '.EXE;.CMD' }, sandbox)
    check(
      '.exe 不经 shell（不引入「永远 shell:true」）',
      exePlan.found === true && exePlan.file.toLowerCase().endsWith('only.exe') && exePlan.shell === false && exePlan.spawnFile === exePlan.file,
      JSON.stringify(exePlan),
    )
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
} else {
  console.log('  SKIP 候选顺序 / 引号（POSIX 没有 PATHEXT，无后缀就是正解）')
}

// ── [4] 找不到命令：可读错误，且不再盲交给 shell ─────────────────────────────
{
  const missing = mcp.resolveCommand('definitely-not-installed-xyz', env, repoRoot)
  check('找不到的命令标 found:false、shell:false（不把原文盲交给 cmd）', missing.found === false && missing.shell === false, JSON.stringify(missing))
  const reason = core.missingCommandReason('definitely-not-installed-xyz', env)
  check('错误消息里点名了那条命令', reason.includes('definitely-not-installed-xyz'), reason)
  check('错误消息指向「没装或写错」，并提到是按 PATH 找的', reason.includes('PATH') && /没装|写错/.test(reason), reason)
  const noPath = core.missingCommandReason('some-command', {})
  check('环境里没有 PATH 时给的是「解析失败」而不是「没装」', noPath.includes('PATH') && /解析|没带|没有/.test(noPath), noPath)
}

// ── 漂移钉：mcp.ts 不许再自带一套候选顺序 ────────────────────────────────────
{
  const source = readFileSync(new URL('../src/packages/mcp/mcp.ts', import.meta.url), 'utf8')
  check('mcp.ts 的候选顺序已交出去（找不到 `[root, ...suffixes` 这种无后缀优先的写法）', !/\[root, \.\.\.suffixes/.test(source))
  check('mcp.ts 从 core/executable.js 取解析实现', source.includes("from '../../core/executable.js'"))
  check('mcp.ts 找不到命令时抛的是可读错误（不是 shell 兜底）', /missingCommandReason\(/.test(source))
}

console.log(`PASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
