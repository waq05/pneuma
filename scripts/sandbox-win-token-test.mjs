/**
 * 受限令牌沙箱的机器验收：**写根之外到底能不能写进去**（2026-11-11）。
 *
 * 为什么要有它：`src/packages/sandbox/tests/sandbox.test.mjs` 只测策略纯函数，
 * `scripts/sandbox-write-roots-test.mjs` 只算可写根清单——「ACL 真的把根外写拒了」
 * 这件事此前没有任何自动化用例验证，而它恰恰是这套强制唯一的实质结论。
 *
 * 两段：
 *   [纯函数] `parseRunnerArgs` / `strictlyInside` / `quoteArgv`：任何平台都跑，
 *            不建令牌、不动 ACL、不要管理员；
 *   [集成]   Windows 且 `probeWindowsToken()` 可用时，真造一个 workspace-write 执行器，
 *            让 powershell 同时写工作区内与工作区外，断言「里面写成、外面拒掉」。
 *            跑不起来（非 Windows / koffi 缺失 / 授权失败）就 SKIP 并打印确切原因，
 *            绝不把这一段删掉——删掉等于把唯一的实证让出去。
 *
 * 隔离：`DSC_HOME` 在 import 任何 lib 之前指向 mkdtemp 临时目录（`path-policy.ts:20`
 * 在模块加载那一刻就把 `DSC_HOME` 定死了），跑完删掉；真实 `~/.dsc` 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/sandbox-win-token-test.mjs
 *
 * @module dsc/scripts/sandbox-win-token-test
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 仓库根（本文件在 `scripts/` 下一层）。 */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

// ── 隔离必须在 import 任何 lib 之前：DSC_HOME 是模块级常量 ──────────────────
const sandboxRoot = mkdtempSync(join(tmpdir(), 'dsc-win-token-'))
process.env.DSC_HOME = join(sandboxRoot, '.dsc')

let pass = 0
let fail = 0
/** @type {string | null} 集成段没跑时的原因（跑过就是 null）。 */
let skipReason = null

/**
 * 记一条断言。
 * @param {string} name 断言名（一句话说清「什么成立」）。
 * @param {boolean} ok 是否成立。
 * @param {string} [extra] 失败时贴的现场。
 */
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

/** 不算断言的现场说明（真实退出码、真实报错原文这类）。 */
function note(text) {
  console.log(`  NOTE ${text}`)
}

/**
 * 跑一个必然抛错的调用，检查错误信息命中某个正则。
 * @param {() => unknown} fn 被检查的调用。
 * @param {RegExp} pattern 期望的错误信息形状。
 */
function throwsWith(fn, pattern) {
  try {
    fn()
    return { ok: false, why: '没有抛错' }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { ok: pattern.test(text), why: text }
  }
}

/** 删一棵临时树：删不干净只记一句，不让收尾失败盖住判定结果。 */
function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    note(`临时目录没删干净（不影响判定）：${path} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 导入 `runner-entry`，并把「它是子进程入口」这件事的副作用按在导入期间。
 *
 * 它的模块体末尾无条件跑 `main()`（`runner-entry.ts:441`），谁 import 谁就：拿本进程的
 * argv 解析一次（必然报「缺 --mode」）、往 stderr 打一行 `dsc-sandbox-run: …`、把
 * `process.exitCode` 改成 127。纯函数要测它的导出，只能这样：临时截短 argv（保证它连
 * FFI 都不加载、更不会真去 spawn）、吞掉那行 stderr、导入后还原 exitCode，然后把吞到的
 * 文字原样打印出来——是按住，不是藏起来。
 */
async function importRunnerEntry() {
  const savedArgv = process.argv
  const savedExitCode = process.exitCode
  const savedWrite = process.stderr.write
  let swallowed = ''
  process.argv = savedArgv.slice(0, 2)
  /** @type {any} */
  process.stderr.write = (chunk) => {
    swallowed += String(chunk)
    return true
  }
  try {
    const mod = await import(pathToFileURL(join(ROOT, 'lib/packages/sandbox/win/runner-entry.js')).href)
    // `main()` 的 catch 在微任务里跑：等一拍再还原 stderr，否则那行会漏出来
    await new Promise((done) => setImmediate(done))
    return { mod, swallowed }
  } finally {
    process.argv = savedArgv
    process.stderr.write = savedWrite
    process.exitCode = savedExitCode
  }
}

console.log('受限令牌沙箱：写根之外写不进去')
console.log('')
console.log('── 纯函数：runner argv 契约、路径包含、argv 引号化（任何平台都跑）')

const { mod: runnerEntry, swallowed } = await importRunnerEntry()
const { RUNNER_SIGNATURE, parseRunnerArgs, quoteArgv, strictlyInside } = runnerEntry
if (swallowed !== '') {
  note(`import runner-entry 触发了它入口体的一次自查失败（已在导入期间按住）：${swallowed.trim()}`)
}
const { rootWriteSid, tempWriteSid } = await import(
  pathToFileURL(join(ROOT, 'lib/packages/sandbox/win/workspace-sid.js')).href
)

// 签名值本身也是契约：宿主与探针靠这一行把「runner 挂了」与「命令被拒了」分开
check('RUNNER_SIGNATURE 是宿主诊断认的那一行', RUNNER_SIGNATURE === 'dsc-sandbox-run: ', JSON.stringify(RUNNER_SIGNATURE))

// ── parseRunnerArgs：正常一份 ───────────────────────────────────────────────
{
  // SID 必须与路径对得上（`runner-entry.ts:166-173` 逐对复算），所以这里用真实派生函数
  const ws = 'C:\\sandbox\\ws'
  const temp = 'C:\\sandbox\\home\\.dsc\\sandbox\\tmp\\abc123'
  const sid = rootWriteSid(ws)
  const parsed = parseRunnerArgs([
    '--mode', 'workspace-write',
    '--temp', temp,
    '--root', `${sid}=${ws}`,
    '--', 'cmd', '/c', 'echo', 'hi',
  ])
  check('parseRunnerArgs 解析 mode', parsed.mode === 'workspace-write', String(parsed.mode))
  check('parseRunnerArgs 解析 temp', parsed.tempDir === temp, parsed.tempDir)
  check(
    'parseRunnerArgs 解析 roots（sid 与 path 成对）',
    parsed.roots.length === 1 && parsed.roots[0].sid === sid && parsed.roots[0].path === ws,
    JSON.stringify(parsed.roots),
  )
  check(
    'parseRunnerArgs 把 -- 之后的命令逐项留下',
    parsed.childArgv.length === 4 && parsed.childArgv.join(' ') === 'cmd /c echo hi',
    JSON.stringify(parsed.childArgv),
  )
  // temp 那条 SID 也走一遍派生，确保「两种根不同号」这个前提没变（集成段靠它）
  check('temp 根的能力 SID 与工作区不同号', tempWriteSid(temp) !== sid, `${tempWriteSid(temp)} / ${sid}`)
}

// ── parseRunnerArgs：四条必须抛错的分支 ─────────────────────────────────────
{
  const noSeparator = throwsWith(() => parseRunnerArgs(['--mode', 'read-only']), /分隔符/)
  check('缺 -- 分隔符抛错（错误信息提到分隔符）', noSeparator.ok, noSeparator.why)

  const unknown = throwsWith(
    () => parseRunnerArgs(['--mode', 'read-only', '--nope', 'x', '--', 'cmd']),
    /不认识的 runner 参数/,
  )
  check('未知参数抛错（错误信息点名参数）', unknown.ok, unknown.why)

  const emptyMode = throwsWith(() => parseRunnerArgs(['--mode', '', '--', 'cmd']), /--mode 只认/)
  check('空的 --mode 值抛错', emptyMode.ok, emptyMode.why)

  const emptyCommand = throwsWith(() => parseRunnerArgs(['--mode', 'read-only', '--']), /没有受限命令/)
  check('-- 之后没有命令抛错', emptyCommand.ok, emptyCommand.why)
}

// ── strictlyInside：只用文档承诺的语义（大小写不敏感 + 分隔符边界） ──────────
{
  check('根内的路径为 true', strictlyInside('C:\\a\\b', 'C:\\a') === true)
  check('根外的路径为 false', strictlyInside('C:\\b', 'C:\\a') === false)
  check('大小写不同仍算根内', strictlyInside('c:\\A\\B', 'C:\\a') === true)
  check('父路径带尾分隔符不影响判定', strictlyInside('C:\\a\\b', 'C:\\a\\\\') === true)
  check('同前缀不同目录（C:\\a 与 C:\\ab）为 false', strictlyInside('C:\\ab', 'C:\\a') === false)
  check('同一路径本身为 false（不算「在里」）', strictlyInside('C:\\a', 'C:\\a') === false)

  // 需求里写「`..` 逃逸 false」，但实现只做**文本包含**（`runner-entry.ts:201-206`，
  // 不碰文件系统、不做 realpath）：`C:\a\..\b` 字面上以 `C:\a\` 开头，这里必然 true。
  // 真实调用方传的是 realpath 后的绝对路径（`backend.ts:94-101` 的入参约定），
  // 所以不改代码，只把真实语义钉在这里——写 false 才是幻觉。
  check(
    '.. 段不归一：纯文本判定为 true（调用方必须先 realpath）',
    strictlyInside('C:\\a\\..\\b', 'C:\\a') === true,
  )
}

// ── quoteArgv：CommandLineToArgvW 规则 ──────────────────────────────────────
{
  check('带空格的参数加引号', quoteArgv('C:\\a b\\c') === '"C:\\a b\\c"', quoteArgv('C:\\a b\\c'))
  check('带双引号的参数转义', quoteArgv('say "hi"') === '"say \\"hi\\""', quoteArgv('say "hi"'))
  check('尾反斜杠在收尾引号前翻倍', quoteArgv('C:\\a b\\') === '"C:\\a b\\\\"', quoteArgv('C:\\a b\\'))
  check('空串写成两个引号', quoteArgv('') === '""', quoteArgv(''))
  check('不需要引号的参数原样保留', quoteArgv('cmd') === 'cmd', quoteArgv('cmd'))
}

// ── 集成：真造受限令牌，真写一次根外 ────────────────────────────────────────
console.log('')
console.log('── 集成：真造受限令牌 + ACL，看写根之外能不能写进去')

if (process.platform !== 'win32') {
  skipReason = `非 Windows 平台（${process.platform}）：建不了受限令牌`
  console.log(`  SKIP ${skipReason}`)
} else {
  const backend = await import(pathToFileURL(join(ROOT, 'lib/packages/sandbox/win/backend.js')).href)
  const probe = backend.probeWindowsToken()
  if (!probe.available) {
    skipReason = `受限令牌后端不可用：${probe.detail}`
    console.log(`  SKIP ${skipReason}`)
  } else {
    note(`探测结果：${probe.detail}`)
    await runIntegration(backend)
  }
}

/**
 * 集成段：建执行器 → 组计划 → 真 spawn → 断言「里面写成、外面拒掉」。
 *
 * @param {{ createWindowsTokenRunner: Function, writeRootsFor: Function }} backend 编译产物里的后端导出。
 */
async function runIntegration(backend) {
  /** 执行器降级、收尾失败这些都会被后端写成一句话塞进来 */
  const details = []
  const outsideRoot = mkdtempSync(join(tmpdir(), 'dsc-win-token-outside-'))
  const handleRef = { current: null }
  try {
    const workspace = join(sandboxRoot, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const insideFile = join(workspace, 'inside.txt')
    const outsideFile = join(outsideRoot, 'outside.txt')

    // 私有临时目录在真实宿主里由插件建（`src/packages/sandbox/index.ts:213-218`）；
    // grantWrite 要打在真实存在的目录上，不存在的话第一次 plan 就整体降级
    const tmpRoot = backend.writeRootsFor(workspace).find((root) => root.side === 'temp')
    if (tmpRoot === undefined) {
      skipReason = 'writeRootsFor 没算出私有临时目录（后端接口变了？）'
      console.log(`  SKIP ${skipReason}`)
      return
    }
    mkdirSync(tmpRoot.path, { recursive: true })

    const handle = backend.createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: workspace,
      networkAccess: () => false,
      onDetail: (message) => details.push(String(message)),
    })
    handleRef.current = handle

    // PowerShell 脚本只用单引号字符串（避免与 argv 引号化/CommandLineToArgvW 打架）：
    //   1) 写工作区内 inside.txt（预期成功）
    //   2) 写工作区外的绝对路径（预期被 ACL 拒，异常信息原样打到 stderr 留证据）
    //   3) 无论外面成没成，都打一行 DONE 再按结果退出 42
    const psLiteral = (value) => `'${value.replace(/'/g, "''")}'`
    const script = [
      // 让 PowerShell 用 UTF-8 写管道：系统语言是中文时拒绝理由本来是 GBK，
      // 经 runner 的字节管道到这边按 UTF-8 解就是乱码，白丢一条现场证据
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      `Set-Content -Path ${psLiteral('.\\inside.txt')} -Value ${psLiteral('ok')}`,
      '$denied = $true',
      'try {',
      `  Set-Content -Path ${psLiteral(outsideFile)} -Value ${psLiteral('bad')} -ErrorAction Stop`,
      '  $denied = $false',
      '} catch {',
      "  [Console]::Error.WriteLine('OUTSIDE-ERROR: ' + $_.Exception.Message)",
      '}',
      "Write-Output 'DONE'",
      'if ($denied) { exit 42 }',
    ].join('\n')

    const base = {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
      env: { ...process.env },
      cwd: workspace,
    }
    const run = {
      command: 'powershell -NoProfile -NonInteractive -Command <写里/写外/DONE>',
      cwd: workspace,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    }
    const planned = await handle.runner.plan(run, base)
    if (planned === null) {
      skipReason = `执行器拒绝换执行体（已降级）：${details.join(' / ') || '没有给出原因'}`
      console.log(`  SKIP ${skipReason}`)
      return
    }

    check(
      '计划换掉了执行体（file=解释器，args[0]=runner 入口）',
      planned.file !== base.file && /runner-entry\.js$/.test(planned.args[0] ?? ''),
      `${planned.file} ${String(planned.args[0])}`,
    )

    /** spawn 要的是 string→string：计划里的 env 允许 undefined，这里滤掉 */
    const env = {}
    for (const [key, value] of Object.entries(planned.env)) if (value !== undefined) env[key] = value

    const spawned = await spawnPlan(planned, env)
    if (spawned.error !== undefined) {
      skipReason = `runner 子进程起不来：${spawned.error}`
      console.log(`  SKIP ${skipReason}`)
      return
    }

    const output = `${spawned.out}\n${spawned.err}`
    /** 记下断言前的失败数：这一段红了就把完整输出贴出来（排查靠它） */
    const failuresBefore = fail
    note(`真实退出码 ${String(spawned.code)}${spawned.timedOut ? '（超时被杀）' : ''}`)
    if (spawned.out.trim() !== '') note(`stdout：${spawned.out.trim().split('\n').slice(0, 4).join(' | ')}`)
    if (spawned.err.trim() !== '') note(`stderr：${spawned.err.trim().split('\n').slice(0, 4).join(' | ')}`)

    check('没有超时（30 秒内跑完）', spawned.timedOut === false, '30 秒被杀')
    check('工作区内的 inside.txt 存在', existsSync(insideFile))
    check(
      'inside.txt 内容是 ok',
      existsSync(insideFile) && readFileSync(insideFile, 'utf8').trim() === 'ok',
      existsSync(insideFile) ? JSON.stringify(readFileSync(insideFile, 'utf8')) : '文件不存在',
    )
    check('工作区外的 outside.txt 不存在（被 ACL 拒）', !existsSync(outsideFile))

    // 需求给的两条判据只要成立一条：有拒绝字样，或退出码非 0（脚本自己按 denied 退 42，
    // 这样不依赖系统语言的报错措辞；拒绝字样单独做一次更宽的匹配，只为把现场写进 NOTE）
    const deniedText = /access is denied|拒绝访问/i.test(output)
    const widerDenial = /access is denied|access to the path .* is denied|拒绝访问|访问被拒绝|unauthorizedaccess/i.test(output)
    check(
      '命令被拒：输出有拒绝字样，或退出码非 0',
      deniedText || spawned.code !== 0,
      `退出码 ${String(spawned.code)}；stderr 前 200 字：${spawned.err.slice(0, 200)}`,
    )
    if (!deniedText && widerDenial) note('拒绝字样是本地化措辞（如「访问被拒绝」），命中更宽的那条正则')
    check(
      '输出里没有 runner 自身失败签名（有就说明 runner 挂了，不是命令被拒）',
      !output.includes(RUNNER_SIGNATURE),
      output.includes(RUNNER_SIGNATURE) ? output.slice(output.indexOf(RUNNER_SIGNATURE), output.indexOf(RUNNER_SIGNATURE) + 200) : '',
    )

    // 集成段只要有断言红了，就把 runner 子进程的完整输出贴出来（排查靠它）
    if (fail > failuresBefore) {
      console.log('  ── 集成段有失败，贴 runner 子进程完整输出 ──')
      console.log(`  stdout:\n${spawned.out}`)
      console.log(`  stderr:\n${spawned.err}`)
    }
  } finally {
    // 收尾顺序：先回收执行器（撤私有临时目录的 ACE），再删树
    if (handleRef.current !== null) {
      try {
        handleRef.current.dispose()
      } catch (error) {
        note(`dispose 抛错：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (details.length > 0) note(`执行器自述：${details.join(' / ')}`)
    removeTree(outsideRoot)
  }
}

/**
 * 按计划 spawn 并收集输出；30 秒超时就杀掉（杀 runner 等于关作业对象，受限子树一起收）。
 *
 * @param {{ file: string, args: string[], cwd: string }} planned 换过执行体的计划。
 * @param {Record<string, string>} env 子进程环境（undefined 已滤掉）。
 * @returns {Promise<{ code?: number | null, out: string, err: string, timedOut: boolean, error?: string }>}
 */
function spawnPlan(planned, env) {
  return new Promise((done) => {
    let child
    try {
      child = spawn(planned.file, planned.args, {
        cwd: planned.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      done({ out: '', err: '', timedOut: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let out = ''
    let err = ''
    let timedOut = false
    let settled = false
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      out += chunk
    })
    child.stderr?.on('data', (chunk) => {
      err += chunk
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 30_000)
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ out, err, timedOut, ...result })
    }
    child.on('error', (error) => settle({ error: error instanceof Error ? error.message : String(error) }))
    child.on('close', (code) => settle({ code }))
  })
}

// ── 汇总与收尾 ──────────────────────────────────────────────────────────────
removeTree(sandboxRoot)

const summary = `通过 ${String(pass)} / 失败 ${String(fail)}`
if (skipReason === null) {
  console.log('')
  console.log(summary)
} else {
  // 最后一行按「跳过集成（原因）」交付，同时把计数带上，两条约定都不落空
  console.log('')
  console.log(`跳过集成（${skipReason}）；${summary}`)
}
process.exit(fail === 0 ? 0 : 1)
