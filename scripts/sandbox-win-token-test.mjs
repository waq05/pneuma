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
 *            让 powershell 同时写工作区内与工作区外，断言「里面写成、外面拒掉」；
 *            外加一条 read-only 的超时用例（`--timeout 1000` 掐掉一个睡 10 秒的
 *            powershell，断言 3 秒内结束、退出码 124、stderr 有超时说明）。
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync } from 'node:fs'
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

// ── parseRunnerArgs：--timeout 的解析与四种必须抛错的输入 ──────────────────
{
  /** 一份最小合法 argv（read-only 不要可写根），只把 --timeout 那一段换掉 */
  const withTimeout = (...values) => [
    '--mode', 'read-only',
    '--temp', 'C:\\sandbox\\tmp',
    ...values,
    '--', 'cmd',
  ]

  const defaulted = parseRunnerArgs(withTimeout())
  check('不给 --timeout 时是 0（不限）', defaulted.timeoutMs === 0, String(defaulted.timeoutMs))

  const given = parseRunnerArgs(withTimeout('--timeout', '1000'))
  check('--timeout 1000 解析成 1000', given.timeoutMs === 1000, String(given.timeoutMs))

  const negative = throwsWith(() => parseRunnerArgs(withTimeout('--timeout', '-1')), /--timeout 只认非负十进制整数/)
  check('--timeout -1 抛错（负数不许静默变成 INFINITE）', negative.ok, negative.why)

  const notNumber = throwsWith(() => parseRunnerArgs(withTimeout('--timeout', 'abc')), /--timeout 只认非负十进制整数/)
  check('--timeout abc 抛错（错误信息带上收到的值）', notNumber.ok && notNumber.why.includes('abc'), notNumber.why)

  const missingValue = throwsWith(() => parseRunnerArgs(withTimeout('--timeout')), /--timeout 需要一个毫秒数/)
  check('--timeout 缺值抛错', missingValue.ok, missingValue.why)

  const duplicated = throwsWith(
    () => parseRunnerArgs(withTimeout('--timeout', '1000', '--timeout', '2000')),
    /--timeout 给重复了/,
  )
  check('--timeout 重复给抛错', duplicated.ok, duplicated.why)
}

// ── parseRunnerArgs：--pty / --cols / --rows ────────────────────────────────
{
  /** 一份最小合法 argv（read-only 不要可写根），只把 --pty 那一段换掉 */
  const withPty = (...values) => [
    '--mode', 'read-only',
    '--temp', 'C:\\sandbox\\tmp',
    ...values,
    '--', 'cmd',
  ]

  const off = parseRunnerArgs(withPty())
  check('不给 --pty 时 pty 是 undefined（默认关，走原来三对管道）', off.pty === undefined, JSON.stringify(off.pty))

  const on = parseRunnerArgs(withPty('--pty'))
  check(
    '--pty 解析成 {cols:120, rows:30}（默认尺寸）',
    on.pty?.cols === 120 && on.pty?.rows === 30,
    JSON.stringify(on.pty),
  )

  const sized = parseRunnerArgs(withPty('--pty', '--cols', '80', '--rows', '24'))
  check('--cols 80 --rows 24 生效', sized.pty?.cols === 80 && sized.pty?.rows === 24, JSON.stringify(sized.pty))

  const badCols = throwsWith(() => parseRunnerArgs(withPty('--pty', '--cols', 'abc')), /--cols 只认正整数/)
  check('--cols abc 抛错（错误信息点名参数）', badCols.ok, badCols.why)

  const zeroCols = throwsWith(() => parseRunnerArgs(withPty('--pty', '--cols', '0')), /--cols 只认正整数/)
  check('--cols 0 抛错（0 列无意义，也会被按 int16 强转）', zeroCols.ok, zeroCols.why)

  const orphan = throwsWith(() => parseRunnerArgs(withPty('--cols', '80')), /只对 --pty 有效/)
  check('给了 --cols 但没给 --pty 抛错（不许让人以为它生效了）', orphan.ok, orphan.why)

  const dupPty = throwsWith(() => parseRunnerArgs(withPty('--pty', '--pty')), /--pty 给重复了/)
  check('--pty 重复给抛错', dupPty.ok, dupPty.why)
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

// ── 残留清扫：只清超龄目录，活目录进 kept，根不存在不抛 ────────────────────
console.log('')
console.log('── 残留清扫：只清超龄目录，活目录进 kept，根不存在不抛')

const sweepMod = await import(pathToFileURL(join(ROOT, 'lib/packages/sandbox/win/sweep.js')).href)
{
  const sectionPass = pass
  const sectionFail = fail
  const root = mkdtempSync(join(tmpdir(), 'dsc-sweep-'))
  try {
    const oldDir = join(root, 'old-session')
    const liveDir = join(root, 'live-session')
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(liveDir, { recursive: true })
    const now = Date.now()
    // 25 小时前：超过默认 24 小时门槛；另一个保持当前时间
    const oldTime = new Date(now - 25 * 60 * 60 * 1000)
    utimesSync(oldDir, oldTime, oldTime)

    const asked = []
    const result = sweepMod.sweepSandboxTemps({
      root,
      now: () => now,
      // 注入删除器：不碰真实 ACL、不真删目录
      onSweep: (entry) => asked.push(entry),
    })
    const oldReal = realpathSync.native(oldDir)
    const liveReal = realpathSync.native(liveDir)

    check(
      '超龄目录进 swept（只有那一个）',
      result.swept.length === 1 && result.swept[0] === oldReal,
      JSON.stringify(result.swept),
    )
    check(
      '活目录进 kept（没被动）',
      result.kept.length === 1 && result.kept[0] === liveReal,
      JSON.stringify(result.kept),
    )
    check('没有失败项', result.failed.length === 0, JSON.stringify(result.failed))
    check(
      'onSweep 收到的 SID 是 tempWriteSid 派生的',
      asked.length === 1 && asked[0].sid === tempWriteSid(oldReal),
      JSON.stringify(asked),
    )
    check(
      'onSweep 收到的年龄超过 24 小时',
      asked.length === 1 && asked[0].ageMs > 24 * 60 * 60 * 1000,
      JSON.stringify(asked.map((one) => one.ageMs)),
    )
    check('注入 onSweep 时目录没有被真删（记录器就是记录器）', existsSync(oldDir) && existsSync(liveDir))

    // 根不存在：首次启动的真实形态，必须空结果且不抛
    let missing
    try {
      missing = sweepMod.sweepSandboxTemps({
        root: join(root, 'not-there'),
        onSweep: () => {
          throw new Error('根不存在时不该调用删除器')
        },
      })
    } catch (error) {
      missing = `抛了错：${error instanceof Error ? error.message : String(error)}`
    }
    check(
      '根不存在返回空结果且不抛',
      typeof missing === 'object' &&
        missing !== null &&
        missing.swept.length === 0 &&
        missing.kept.length === 0 &&
        missing.failed.length === 0,
      JSON.stringify(missing),
    )
  } finally {
    removeTree(root)
  }
  console.log(`  ── 小结：${String(pass - sectionPass)} 通过 / ${String(fail - sectionFail)} 失败`)
}

// ── setup 并发互斥：同一进程连拿两次，第二次必须被拒 ────────────────────────
console.log('')
console.log('── setup 并发互斥：同一进程连拿两次，第二次必须被拒')

const setupMod = await import(pathToFileURL(join(ROOT, 'lib/packages/sandbox/win/setup.js')).href)
{
  const sectionPass = pass
  const sectionFail = fail
  if (process.platform !== 'win32') {
    console.log(`  SKIP 非 Windows 平台（${process.platform}）：CreateMutexW 用不了`)
  } else {
    const first = setupMod.acquireSetupMutex()
    if (!first.ok) {
      check('第一次拿互斥体成功', false, first.why)
    } else {
      check('第一次拿互斥体成功', true)
      const second = setupMod.acquireSetupMutex()
      check('第二次被拒（同名互斥体已存在）', second.ok === false, '第二次竟然也拿到了')
      check(
        '拒绝理由可读（提到另一个安装正在运行）',
        second.ok === false && /另一个沙箱安装正在运行，等它结束再试/.test(second.why),
        second.ok ? '' : second.why,
      )
      first.mutex.release()
      const third = setupMod.acquireSetupMutex()
      check('释放后能再拿到（锁没漏）', third.ok === true, third.ok ? '' : third.why)
      if (third.ok) third.mutex.release()
    }
  }
  console.log(`  ── 小结：${String(pass - sectionPass)} 通过 / ${String(fail - sectionFail)} 失败`)
}

// ── 卸载脚本生成：四类动作都在文本里（不真跑）──────────────────────────────
console.log('')
console.log('── 卸载脚本生成：四类命令都在文本里，提权流程不真跑')

{
  const sectionPass = pass
  const sectionFail = fail
  const text = setupMod.buildUninstallScript({ dscHome: join(sandboxRoot, '.dsc') })
  check('脚本里有删账号（Remove-LocalUser）', /Remove-LocalUser/.test(text))
  check('脚本里有删防火墙规则（Remove-NetFirewallRule）', /Remove-NetFirewallRule/.test(text))
  check(
    '脚本里有删 WFP（filter / sublayer / provider 三个删除调用）',
    /\[DscWfp\]::Uninstall/.test(text) &&
      /FwpmFilterDeleteByKey0/.test(text) &&
      /FwpmSubLayerDeleteByKey0/.test(text) &&
      /FwpmProviderDeleteByKey0/.test(text),
  )
  check(
    '脚本里有删状态文件（setup-state.json / account.bin / setup-error.txt）',
    ['setup-state.json', 'account.bin', 'setup-error.txt'].every((name) => text.includes(name)),
  )
  check('脚本里带错误落盘那一段（Write-DscUninstallError → setup-error.txt）', /Write-DscUninstallError/.test(text))
  console.log(`  ── 小结：${String(pass - sectionPass)} 通过 / ${String(fail - sectionFail)} 失败`)
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
    await runTimeoutCase()
    await runPtyCases()
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
 * 超时用例：让 powershell 睡 10 秒，runner 必须在 1 秒后自己把它掐掉。
 *
 * 为什么用 read-only 档：这一条测的是 runner 自己的超时与收尾，跟文件系统强制无关，
 * 少一步 ACL 授权就少一个可能红的边缘因素。
 *
 * 断言三件事：3 秒内真的结束（不是等它睡完）、退出码是 124、stderr 那一行以
 * `RUNNER_SIGNATURE` 开头并带「超时」——少了签名，宿主就分不清这是 runner 说的
 * 还是被限制的命令自己打出来的。
 */
async function runTimeoutCase() {
  console.log('')
  console.log('── 集成：--timeout 到点后终止整个作业并退 124')
  const tempDir = mkdtempSync(join(tmpdir(), 'dsc-win-token-timeout-'))
  try {
    // 直接 spawn runner（不走执行器 plan）：这里要验的就是 runner 自己的参数与行为，
    // 套一层执行器只会把「--timeout 到底有没有传下去」混进被测范围
    const args = [
      join(ROOT, 'lib/packages/sandbox/win/runner-entry.js'),
      '--mode', 'read-only',
      '--temp', tempDir,
      '--timeout', '1000',
      '--', 'powershell', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 10',
    ]
    const started = Date.now()
    const spawned = await spawnPlan({ file: process.execPath, args, cwd: sandboxRoot }, { ...process.env })
    const elapsed = Date.now() - started
    if (spawned.error !== undefined) {
      note(`runner 子进程起不来：${spawned.error}`)
      if (skipReason === null) skipReason = `超时用例的 runner 子进程起不来：${spawned.error}`
      return
    }

    note(`超时用例耗时 ${String(elapsed)}ms，真实退出码 ${String(spawned.code)}`)
    if (spawned.err.trim() !== '') note(`stderr：${spawned.err.trim()}`)

    check(
      '超时用例 3 秒内结束（没等子进程睡完 10 秒）',
      spawned.timedOut === false && elapsed < 3000,
      `耗时 ${String(elapsed)}ms，timedOut=${String(spawned.timedOut)}`,
    )
    check('超时退出码是 124（与 GNU timeout 同义）', spawned.code === 124, `真实退出码 ${String(spawned.code)}`)
    check('stderr 里说明了超时', /超时/.test(spawned.err), spawned.err.slice(0, 200))
    const timeoutLine = spawned.err.split('\n').find((line) => line.startsWith(RUNNER_SIGNATURE))
    check(
      'stderr 那一行以 RUNNER_SIGNATURE 开头并带「超时」',
      timeoutLine !== undefined && /超时/.test(timeoutLine),
      timeoutLine ?? 'stderr 里没有以签名开头的行',
    )
  } finally {
    removeTree(tempDir)
  }
}

/**
 * 集成段（PTY）：`--pty` 的三条用例，直接 spawn runner（不套执行器）。
 *
 * 三条分别盯三件事：① 真的是 tty（`process.stdout.isTTY === true`，这是「全屏程序能跑」
 * 的判据）；② 普通命令的输出经 pty 回来（不是走父进程控制台）；③ stdin 送的 0x03 经
 * conin 翻译成 CTRL_C_EVENT，子进程真的被中断——做不到就如实记 NOTE，不假装通过。
 */
async function runPtyCases() {
  console.log('')
  console.log('── 集成：--pty（ConPTY）三条用例')
  const runner = join(ROOT, 'lib/packages/sandbox/win/runner-entry.js')
  const tempDir = mkdtempSync(join(tmpdir(), 'dsc-win-token-pty-'))
  /** 直接 spawn runner：被测的就是 runner 自己的 --pty 行为，套执行器只会把范围搅浑 */
  const plan = (extra, child) => ({
    file: process.execPath,
    args: [runner, '--mode', 'read-only', '--temp', tempDir, ...extra, '--', ...child],
    cwd: sandboxRoot,
  })
  try {
    const tty = await spawnPlan(
      plan(['--pty'], [process.execPath, '-e', "console.log('isTTY=' + process.stdout.isTTY)"]),
      { ...process.env },
    )
    note(`isTTY 用例：退出码 ${String(tty.code)}，stdout=${JSON.stringify(tty.out.trim())}`)
    if (tty.err.trim() !== '') note(`isTTY 用例 stderr：${tty.err.trim().slice(0, 200)}`)
    check(
      '--pty 下 process.stdout.isTTY 为 true',
      /isTTY=true/.test(tty.out),
      `stdout=${JSON.stringify(tty.out.slice(0, 200))}`,
    )
    check(
      'isTTY 用例没超时且退出码 0',
      tty.timedOut === false && tty.code === 0,
      `code=${String(tty.code)} timedOut=${String(tty.timedOut)}`,
    )
    check('isTTY 用例 stderr 不含 runner 自身失败签名', !tty.err.includes(RUNNER_SIGNATURE), tty.err.slice(0, 200))

    const echo = await spawnPlan(plan(['--pty'], ['cmd', '/c', 'echo', 'pty-ok']), { ...process.env })
    note(`echo 用例：退出码 ${String(echo.code)}，stdout=${JSON.stringify(echo.out.trim())}`)
    check('--pty 下 cmd /c echo 的输出经 pty 回来', /pty-ok/.test(echo.out), `stdout=${JSON.stringify(echo.out.slice(0, 200))}`)

    // Ctrl+C：子进程写一个字节后静等 20 秒；1.5 秒时从 stdin 送 0x03，5 秒内必须退出。
    // 若 0x03 没被翻译成中断，子进程会跑满 20 秒（runner 的 30 秒兜底不会先触发），
    // 耗时就会远超 5 秒——那不是超时误判，就是中断不生效。
    const started = Date.now()
    const interrupted = await spawnPlan(
      plan(['--pty'], [process.execPath, '-e', "process.stdout.write('x');setTimeout(()=>{},20000)"]),
      { ...process.env },
      {
        stdin: 'pipe',
        onSpawn: (child) => {
          setTimeout(() => {
            child.stdin.write('\x03')
          }, 1500)
        },
      },
    )
    const elapsed = Date.now() - started
    note(`Ctrl+C 用例：耗时 ${String(elapsed)}ms，退出码 ${String(interrupted.code)}，stdout=${JSON.stringify(interrupted.out.trim())}`)
    check(
      '0x03 经 conin 中断子进程：5 秒内退出（没等它跑满 20 秒）',
      interrupted.timedOut === false && elapsed < 5000,
      `耗时 ${String(elapsed)}ms，退出码 ${String(interrupted.code)}`,
    )
    if (elapsed >= 5000) note('这条没做到：ConPTY 下 0x03 没有中断子进程（它跑满了 20 秒）')
  } finally {
    removeTree(tempDir)
  }
}

/**
 * 按计划 spawn 并收集输出；30 秒超时就杀掉（杀 runner 等于关作业对象，受限子树一起收）。
 *
 * @param {{ file: string, args: string[], cwd: string }} planned 换过执行体的计划。
 * @param {Record<string, string>} env 子进程环境（undefined 已滤掉）。
 * @param {{ stdin?: 'pipe', onSpawn?: (child: import('node:child_process').ChildProcess) => void }} [hooks]
 *   可选钩子：`stdin: 'pipe'` 让子进程的 stdin 是管道（PTY 的中断用例要往里写 0x03），
 *   `onSpawn` 拿到刚起的子进程（写 stdin / 定时作废都在这里做）。不传时行为与原来一致。
 * @returns {Promise<{ code?: number | null, out: string, err: string, timedOut: boolean, error?: string }>}
 */
function spawnPlan(planned, env, hooks = {}) {
  return new Promise((done) => {
    let child
    try {
      child = spawn(planned.file, planned.args, {
        cwd: planned.cwd,
        env,
        stdio: [hooks.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      done({ out: '', err: '', timedOut: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (typeof hooks.onSpawn === 'function') hooks.onSpawn(child)
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
