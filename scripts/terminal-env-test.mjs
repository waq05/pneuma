/**
 * 终端环境探测与「默认终端」设置的探针（2026-10-30）。
 *
 * 这一批的来由：bash 工具在 Windows 上长期写死 `powershell.exe`，机器上装了
 * PowerShell 7 / Git Bash / WSL 也一概用不上。改法分三层，探针按三层逐条验：
 *
 *   1. **探测**（core/terminal-env.ts）：真去跑 `$PSVersionTable` / `bash --version` /
 *      `wsl.exe --status`，探到才把选项摆出来；探不到的不许出现在下拉里。
 *   2. **执行**（packages/tools-default/bash.ts 的 shellPlan）：四个选择折成四套 file+args，
 *      PowerShell 家族保留 UTF-8 前置与退出码补丁，WSL 用 `--cd` 落工作区。
 *   3. **判定**（packages/approval-floor/approval-floor.ts 的 options.shell）：结构扫描要按**实际执行的**
 *      shell 判——切到 Git Bash 之后仍按 PowerShell 的转义规则判，就会重复 2026-10-30
 *      那次「合法命令被判引号没闭合」的误伤，方向反过来。
 *
 * 跑法：`pnpm run build && node scripts/terminal-env-test.mjs`
 * 隔离：临时 HOME + 临时 DSC_HOME，真实 `~/.dsc` 一个字节不动。
 *
 * @module dsc/scripts/terminal-env-test
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsc-terminal-env-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })
writeFileSync(join(process.env.DSC_HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')

const env = await import('../lib/core/terminal-env.js')
const bash = await import('../lib/packages/tools-default/bash.js')
const floorModule = await import('../lib/packages/approval-floor/approval-floor.js')
const prompt = await import('../lib/packages/session-core/prompt.js')
const registry = await import('../lib/core/plugin-registry.js')

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const isWin = process.platform === 'win32'

// ---------------------------------------------------------------- 1. 探测
console.log('[1] 探测：把机器上真有的 shell 列出来')
{
  const list = env.detectShells(true)
  check('第一项永远是 auto', list[0]?.value === 'auto' && list[0]?.available === true)
  check('每项都带名字与说明', list.every((item) => item.label !== '' && item.detail !== ''))
  if (isWin) {
    const kinds = list.map((item) => item.value)
    for (const kind of ['powershell', 'pwsh', 'gitbash', 'wsl']) {
      check(`Windows 上会探 ${kind}`, kinds.includes(kind))
    }
    // Windows 自带 PowerShell 5.1，这台机器一定有；探不到就说明探测本身坏了。
    check('PowerShell 5.1 一定探得到', list.find((item) => item.value === 'powershell')?.available === true)
  } else {
    check('POSIX 上只给 auto 与 sh', list.length === 2 && list[1].value === 'sh')
  }

  const cachedAt = Date.now()
  env.detectShells()
  const cachedMs = Date.now() - cachedAt
  check('第二次走缓存（< 100ms）', cachedMs < 100, `${cachedMs}ms`)
  check('缓存内容与首次一致', env.detectShells().length === list.length)

  env.forgetShellDetection()
  const again = env.detectShells()
  check('清缓存后重新探测结果一致', again.length === list.length && again[0].value === 'auto')
}

// ------------------------------------------------- 1b. 落盘缓存（跨启动复用）
// 2026-11-07：宿主每次启动都是新进程，只有内存缓存时每次开机都要重新起七个子进程
// （实测 1.6 秒、全堵在事件循环上）。这一批验落盘的读写、作废与强刷。
console.log('[1b] 探测结果落盘：下次启动不再起子进程')
{
  const cacheFile = join(process.env.DSC_HOME, 'cache', 'shells.json')
  check('探测后落了盘', existsSync(cacheFile), cacheFile)
  const doc = JSON.parse(readFileSync(cacheFile, 'utf8'))
  check('落盘带版本与平台', doc.version === 1 && doc.platform === process.platform)
  check('落盘条目与探测一致', Array.isArray(doc.list) && doc.list.length >= 2 && doc.list[0].value === 'auto')
  check('落盘记了探测时刻', typeof doc.at === 'number' && Math.abs(Date.now() - doc.at) < 60_000)

  // 清掉内存那份：这次调用只该读文件，不该起子进程（真探一次约 1.6 秒）
  env.forgetShellDetection()
  const started = Date.now()
  const fromDisk = env.detectShells()
  const diskMs = Date.now() - started
  check('清内存后从落盘读回（< 100ms）', diskMs < 100, `${diskMs}ms`)
  check('读回来的内容与文件一致', fromDisk.length === doc.list.length && fromDisk[0].value === 'auto')

  // 版本不符：当没有缓存，重探并重写
  writeFileSync(cacheFile, JSON.stringify({ ...doc, version: 99 }), 'utf8')
  env.forgetShellDetection()
  const afterBadVersion = env.detectShells()
  check('版本不符的缓存被丢掉并重探', afterBadVersion.length === doc.list.length)
  check('重探后把版本写回当前值', JSON.parse(readFileSync(cacheFile, 'utf8')).version === 1)

  // 过期（> 7 天）：同样当没有缓存
  const stale = JSON.parse(readFileSync(cacheFile, 'utf8'))
  writeFileSync(cacheFile, JSON.stringify({ ...stale, at: Date.now() - 8 * 24 * 60 * 60 * 1000 }), 'utf8')
  env.forgetShellDetection()
  env.detectShells()
  const refreshedAt = JSON.parse(readFileSync(cacheFile, 'utf8')).at
  check('过期的缓存被丢掉并重探', Date.now() - refreshedAt < 60_000)

  // 形状坏掉（缺字段）：不许抛错，也不许把坏数据当缓存用
  writeFileSync(cacheFile, '{"version":1,"at":' + String(Date.now()) + ',"platform":"' + process.platform + '","list":[{"value":"pwsh"}]}', 'utf8')
  env.forgetShellDetection()
  const afterBroken = env.detectShells()
  check('形状坏掉的缓存被丢掉并重探', afterBroken.length === doc.list.length && afterBroken[0].value === 'auto')

  // 缓存里记的可执行文件被卸载：读回来时标成不可用，而不是让命令指向空气
  const present = JSON.parse(readFileSync(cacheFile, 'utf8'))
  const ghost = present.list.map((item) =>
    item.value === 'gitbash' ? { ...item, detail: join(process.env.DSC_HOME ?? tmpdir(), 'does-not-exist-bash.exe') } : item,
  )
  writeFileSync(cacheFile, JSON.stringify({ ...present, list: ghost }), 'utf8')
  env.forgetShellDetection()
  const fromGhost = env.detectShells()
  const ghostItem = fromGhost.find((item) => item.value === 'gitbash')
  check('缓存里已卸载的 shell 被标成不可用', ghostItem !== undefined && ghostItem.available === false)
  check('同一份缓存里其它 shell 不受影响', fromGhost.find((item) => item.value === 'powershell')?.available === true)
}

// ---------------------------------------------------------------- 2. 取值与语法家族
console.log('[2] 取值解析与语法家族')
{
  check('认得 pwsh', env.parseShellChoice('pwsh') === 'pwsh')
  check('认不得的值回落 auto', env.parseShellChoice('fish') === 'auto')
  check('null 回落 auto', env.parseShellChoice(null) === 'auto')
  check('powerShell / pwsh 归 PowerShell 家族', env.shellFlavor('powershell') === 'powershell' && env.shellFlavor('pwsh') === 'powershell')
  check('gitbash / wsl / sh 归 POSIX 家族', env.shellFlavor('gitbash') === 'posix' && env.shellFlavor('wsl') === 'posix' && env.shellFlavor('sh') === 'posix')
  check('auto 按平台判', env.shellFlavor('auto') === (isWin ? 'powershell' : 'posix'))
}

// ---------------------------------------------------------------- 3. 执行计划
console.log('[3] 四个选择折成四套保真参数')
{
  const cwd = process.cwd()
  const envVars = { PATH: process.env.PATH ?? '' }
  const planOf = (choice) => bash.shellPlan(choice, 'echo hi', cwd, envVars)

  const ps = planOf('powershell')
  check('powershell：file 落在 powershell.exe', /powershell\.exe$/i.test(ps.file), ps.file)
  check('powershell：-NoProfile -Command 两个参数不变', ps.args[0] === '-NoProfile' && ps.args[1] === '-Command')
  check('powershell：退出码补丁还在', String(ps.args[2]).includes('$LASTEXITCODE'))
  check('powershell：UTF-8 前置还在', String(ps.args[2]).includes('[Console]::OutputEncoding'))

  const seven = planOf('pwsh')
  check('pwsh：file 落在 pwsh.exe', /pwsh\.exe$/i.test(seven.file), seven.file)
  check('pwsh：参数与 powershell 同形', seven.args[1] === '-Command' && String(seven.args[2]).includes('$LASTEXITCODE'))

  const git = planOf('gitbash')
  check('gitbash：不读 profile', git.args[0] === '--noprofile' && git.args[1] === '--norc')
  check('gitbash：命令从 -c 进', git.args[2] === '-c' && git.args[3] === 'echo hi')

  const wsl = planOf('wsl')
  const distro = env.wslDistroName()
  if (distro === '') {
    check('wsl：不知道发行版时直接 --cd', wsl.args[0] === '--cd' && wsl.args[1] === cwd, wsl.args.join(' '))
  } else {
    check('wsl：用 -d 钉住能跑命令的发行版', wsl.args[0] === '-d' && wsl.args[1] === distro, wsl.args.join(' '))
    check('wsl：--cd 落在工作区', wsl.args.includes('--cd') && wsl.args[wsl.args.indexOf('--cd') + 1] === cwd)
  }
  check('wsl：-e 交给发行版里的 bash -lc', wsl.args.includes('-e') && wsl.args.includes('bash') && wsl.args.includes('-lc'))
  check('wsl：命令原样是最后一个参数', wsl.args[wsl.args.length - 1] === 'echo hi')
  const wslItem = env.detectShells().find((item) => item.value === 'wsl')
  if (wslItem !== undefined && wslItem.available) {
    check('不把 docker-desktop 这类管理发行版当默认目标', !/docker-desktop/i.test(wslItem.label), wslItem.label)
  }

  const sh = planOf('sh')
  check('sh：就是 sh -c', sh.file === 'sh' && sh.args[0] === '-c')

  const auto = planOf('auto')
  check('auto 与平台默认一致', isWin ? /powershell\.exe$/i.test(auto.file) : auto.file === 'sh')
  check('四套计划都带上了 cwd 与环境', [ps, seven, git, wsl].every((plan) => plan.cwd === cwd && plan.env === envVars))
}

// ---------------------------------------------------------------- 4. 配置读写
console.log('[4] 设置落盘与生效')
{
  check('没配过 = auto', env.readShellChoice() === 'auto')

  registry.writePluginConfig('tools-default', { bashShell: 'gitbash' })
  env.forgetShellDetection()
  check('写进 plugins.json 后读得到 gitbash', env.readShellChoice() === 'gitbash')

  registry.writePluginConfig('tools-default', { bashShell: '不认识的' })
  env.forgetShellDetection()
  check('手改坏档回落 auto', env.readShellChoice() === 'auto')

  registry.writePluginConfig('tools-default', { bashShell: null })
  env.forgetShellDetection()
  check('删掉键回到 auto', env.readShellChoice() === 'auto')
  check('标签不是空串', env.shellChoiceLabel('auto') !== '' && env.shellLabel('pwsh') !== '')
}

// ---------------------------------------------------------------- 5. 模型看到的东西跟着变
console.log('[5] 工具说明与环境快照跟着选中的终端改口')
{
  registry.writePluginConfig('tools-default', { bashShell: 'gitbash' })
  env.forgetShellDetection()
  const tool = bash.createBashTool()
  check('bash 工具说明写 Git Bash', tool.description.includes('Git Bash'), tool.description.slice(0, 40))
  check('不再写着执行 PowerShell', !tool.description.startsWith('执行 PowerShell'))

  registry.writePluginConfig('tools-default', { bashShell: 'powershell' })
  env.forgetShellDetection()
  const psTool = bash.createBashTool()
  check('切回 PowerShell 说明跟着改', psTool.description.startsWith('执行 PowerShell'))
  const terminalTool = bash.createTerminalTool({ open: () => 'x', read: () => ({}), close: () => '', list: () => [] })
  check('终端工具说明也改口', terminalTool.description.includes('PowerShell'))

  const text = prompt.environmentText(process.cwd())
  check('环境快照写出实际终端', text.includes('bash 工具跑的是 PowerShell'), text.split('\n')[2])
}

// ---------------------------------------------------------------- 6. 结构扫描跟着走
console.log('[6] 审批地板的引号规则跟着实际 shell 走')
{
  const signal = new AbortController().signal
  const decideWith = (shell) => {
    const floor = floorModule.createApprovalFloor({
      readConfig: () => ({ config: floorModule.DEFAULT_FLOOR_CONFIG, problems: [] }),
      rules: () => [],
      shell,
    })
    return (command) =>
      floor.guard.decide({
        toolName: 'bash',
        risk: 'exec',
        cwd: process.cwd(),
        args: {},
        command,
        signal,
        sessionId: 'terminal-env-test',
        sessionPath: 'terminal-env-test.jsonl',
      })
  }
  const posixDecide = decideWith(() => 'posix')
  const psDecide = decideWith(() => 'powershell')

  // `\"` 在 POSIX 里是转义引号（配对完整），在 PowerShell 里不是转义符（引号就此闭合）。
  const escaped = 'echo "a\\"b"'
  const posix = posixDecide(escaped)
  check('POSIX 下 \\" 不算引号没闭合', !(posix.reason ?? '').includes('引号没闭合'), posix.reason ?? '')
  const ps = psDecide(escaped)
  check('PowerShell 下同一句按自己的规则判', ps.action === 'deny' && (ps.reason ?? '').includes('引号没闭合'), ps.reason ?? '')

  // 反引号：POSIX 是命令替换（拒），PowerShell 是转义（不因替换拒）。
  const tick = 'echo `date`'
  const tickPosix = posixDecide(tick)
  check('POSIX 下反引号按命令替换拒', tickPosix.action === 'deny' && (tickPosix.reason ?? '').includes('替换'), tickPosix.reason ?? '')
  const tickPs = psDecide(tick)
  check('PowerShell 下同一句不按替换拒', !(tickPs.reason ?? '').includes('替换'), tickPs.reason ?? '')

  // 灾难命令与语法无关：两种口径都得拒。
  check('rm -rf / 两种口径都拒', posixDecide('rm -rf /').action === 'deny' && psDecide('rm -rf /').action === 'deny')
}

console.log('')
if (failures === 0) console.log(`全部通过：${String(passed)} 条`)
else console.log(`失败 ${String(failures)} 条，通过 ${String(passed)} 条`)
process.exit(failures === 0 ? 0 : 1)
