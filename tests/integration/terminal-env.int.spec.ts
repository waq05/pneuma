/**
 * 终端环境探测、执行计划与判定（integration 层，原 `scripts/terminal-env-test.mjs`）。
 *
 * 这一批的来由：bash 工具在 Windows 上长期写死 `powershell.exe`，机器上装了
 * PowerShell 7 / Git Bash / WSL 也一概用不上。改法分三层，本文件按三层逐条验：
 *
 *   1. **探测**（core/terminal-env.ts）：真去跑 `$PSVersionTable` / `bash --version` /
 *      `wsl.exe --status`，探到才把选项摆出来；探不到的不许出现在下拉里。
 *   2. **执行**（packages/tools-default/bash.ts 的 shellPlan）：四个选择折成四套 file+args，
 *      PowerShell 家族保留 UTF-8 前置与退出码补丁，WSL 用 `--cd` 落工作区。
 *   3. **判定**（packages/approval-floor/approval-floor.ts 的 options.shell）：结构扫描要按**实际执行的**
 *      shell 判——切到 Git Bash 之后仍按 PowerShell 的转义规则判，就会重复 2026-10-30
 *      那次「合法命令被判引号没闭合」的误伤，方向反过来。
 *
 * ## 平台相关的断言都显式分了支
 *
 * - 探测段：Windows 上会探四个候选（powershell / pwsh / gitbash / wsl）；POSIX 上只有
 *   `auto` 与 `sh`。这是**实现写的两条路**，不是同一个期望换种说法。
 * - 「缓存里已卸载的 shell 被标成不可用」只在 Windows 跑：它拿 `gitbash` 当样本，
 *   POSIX 的候选表里根本没有这一项。
 * - 环境快照里「bash 工具跑的是 PowerShell」只在 Windows 断言；POSIX 上那段写的是
 *   平台名，写死成 PowerShell 就是把这台机器的行为当成了跨平台事实。
 *
 * ## 为什么归 integration
 *
 * 探测要真起子进程、落盘缓存在 `<DSC_HOME>/cache/shells.json`，配置读写要动
 * `plugins.json`；integration 层的临时 HOME 保证真实 `~/.dsc` 一个字节都不动。
 *
 * 第 2 节「取值解析与语法家族」已由 `src/core/terminal-env.spec.ts`（unit 层）覆盖，
 * 这里不重复搬。
 *
 * @module dsc/tests/integration/terminal-env.int.spec
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import * as env from '@pneuma/runtime/core/terminal-env.js'
import { createApprovalFloor, DEFAULT_FLOOR_CONFIG } from '@pneuma/runtime/packages/approval-floor/approval-floor.js'
import { environmentText } from '@pneuma/runtime/packages/session-core/prompt.js'
import { createBashTool, createTerminalTool, shellPlan } from '@pneuma/runtime/packages/tools-default/bash.js'

const IS_WIN = process.platform === 'win32'
/** 落盘缓存的固定位置（`terminal-env.ts` 的 `shellCachePath()` 同一条路径）。 */
const CACHE_FILE = join(DSC_HOME, 'cache', 'shells.json')

beforeAll(() => {
  // plugins.json / cache 的父目录不一定存在；`writePluginConfig` 与探测落盘都假设它在。
  mkdirSync(join(DSC_HOME, 'cache'), { recursive: true })
  // 清一次内存缓存：同一个 worker 里别的用例可能已经探过，状态不该带进来。
  env.forgetShellDetection()
})

afterAll(() => {
  env.forgetShellDetection()
})

describe('① 探测：把机器上真有的 shell 列出来', () => {
  const first = env.detectShells(true)

  test('第一项永远是 auto，且可用', () => {
    expect(first[0]?.value).toBe('auto')
    expect(first[0]?.available).toBe(true)
  })

  test('每项都带名字与说明', () => {
    // 空 label 在设置页里就是一个没有文字的下拉项。
    expect(first.every((item) => item.label !== '' && item.detail !== '')).toBe(true)
  })

  test('Windows 上会探 powershell / pwsh / gitbash / wsl 四项', () => {
    if (!IS_WIN) return
    const kinds = first.map((item) => item.value)
    for (const kind of ['powershell', 'pwsh', 'gitbash', 'wsl']) expect(kinds).toContain(kind)
  })

  test('Windows 自带 PowerShell 5.1 一定探得到', () => {
    if (!IS_WIN) return
    // 探不到就说明探测本身坏了，不是「这台机器没装」。
    expect(first.find((item) => item.value === 'powershell')?.available).toBe(true)
  })

  test('POSIX 上只给 auto 与 sh', () => {
    if (IS_WIN) return
    expect(first).toHaveLength(2)
    expect(first[1]?.value).toBe('sh')
  })

  test('第二次走内存缓存（不再起子进程）', () => {
    const started = Date.now()
    env.detectShells()
    // 真探测一次在 Windows 上约 1.6 秒；500ms 足够把「读内存」和「重新起进程」分开，
    // 又不会因为慢机器把一次正常的缓存命中判成失败。
    expect(Date.now() - started).toBeLessThan(500)
    expect(env.detectShells()).toHaveLength(first.length)
  })

  test('清缓存后重新探测结果一致', () => {
    env.forgetShellDetection()
    const again = env.detectShells()
    expect(again).toHaveLength(first.length)
    expect(again[0]?.value).toBe('auto')
  })
})

describe('①b 探测结果落盘：下次启动不再起子进程', () => {
  test('落盘带版本与平台，条目与探测一致，并记了探测时刻', () => {
    // 前一段已经探过一次，磁盘上应该已经有这份缓存。
    env.detectShells()
    expect(existsSync(CACHE_FILE)).toBe(true)
    const doc = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as {
      version?: number
      platform?: string
      list?: Array<{ value: string }>
      at?: number
    }
    expect(doc.version).toBe(1)
    expect(doc.platform).toBe(process.platform)
    expect(Array.isArray(doc.list)).toBe(true)
    expect((doc.list ?? []).length).toBeGreaterThanOrEqual(2)
    expect(doc.list?.[0]?.value).toBe('auto')
    expect(typeof doc.at).toBe('number')
    expect(Math.abs(Date.now() - (doc.at ?? 0))).toBeLessThan(60_000)
  })

  test('清掉内存后从落盘读回（不再起子进程）', () => {
    const doc = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as { list: unknown[] }
    env.forgetShellDetection()
    const started = Date.now()
    const fromDisk = env.detectShells()
    // 真探一次约 1.6 秒；读一份 JSON 远低于 500ms。口径同上面的内存缓存判定。
    expect(Date.now() - started).toBeLessThan(500)
    expect(fromDisk).toHaveLength(doc.list.length)
    expect(fromDisk[0]?.value).toBe('auto')
  })

  test('版本不符的缓存被丢掉并重探，重探后版本写回当前值', () => {
    const doc = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, unknown>
    writeFileSync(CACHE_FILE, JSON.stringify({ ...doc, version: 99 }), 'utf8')
    env.forgetShellDetection()
    const after = env.detectShells()
    expect(after.length).toBeGreaterThanOrEqual(2)
    expect((JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as { version?: number }).version).toBe(1)
  })

  test('过期（> 7 天）的缓存被丢掉并重探', () => {
    const stale = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, unknown>
    writeFileSync(CACHE_FILE, JSON.stringify({ ...stale, at: Date.now() - 8 * 24 * 60 * 60 * 1000 }), 'utf8')
    env.forgetShellDetection()
    env.detectShells()
    const refreshedAt = (JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as { at?: number }).at ?? 0
    expect(Date.now() - refreshedAt).toBeLessThan(60_000)
  })

  test('形状坏掉的缓存不许抛错，也不许当缓存用', () => {
    writeFileSync(
      CACHE_FILE,
      `{"version":1,"at":${String(Date.now())},"platform":"${process.platform}","list":[{"value":"pwsh"}]}`,
      'utf8',
    )
    env.forgetShellDetection()
    const after = env.detectShells()
    // 缺字段的条目会让设置页渲染出一个没有 label 的选项；正确行为是整份丢掉重探。
    expect(after[0]?.value).toBe('auto')
    expect(after.every((item) => typeof item.label === 'string' && item.label !== '')).toBe(true)
  })

  test.skipIf(!IS_WIN)('缓存里已卸载的 shell 被标成不可用，同缓存里其它 shell 不受影响', () => {
    // 只在 Windows 跑：样本用 gitbash，POSIX 的候选表里没有这一项。
    env.detectShells()
    const present = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as {
      list: Array<{ value: string; detail: string; available?: boolean }>
    }
    const ghost = present.list.map((item) =>
      item.value === 'gitbash' ? { ...item, detail: join(DSC_HOME, 'does-not-exist-bash.exe') } : item,
    )
    writeFileSync(CACHE_FILE, JSON.stringify({ ...present, list: ghost }), 'utf8')
    env.forgetShellDetection()
    const fromGhost = env.detectShells()
    // 「记录了但文件不在了」必须标成不可用，否则命令会指向空气。
    expect(fromGhost.find((item) => item.value === 'gitbash')?.available).toBe(false)
    expect(fromGhost.find((item) => item.value === 'powershell')?.available).toBe(true)
  })
})

describe('③ 四个选择折成四套保真参数', () => {
  const cwd = process.cwd()
  const envVars: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' }
  const planOf = (choice: Parameters<typeof shellPlan>[0]) => shellPlan(choice, 'echo hi', cwd, envVars)

  // 只在 Windows 跑：POSIX 上没有 powershell，`shellPlan('powershell')` 会回落到 sh
  // （这正是 auto 的语义），断言 powershell.exe 只在 Windows 成立。
  test.skipIf(!IS_WIN)('powershell：file 落在 powershell.exe，参数与退出码/UTF-8 补丁都在', () => {
    const plan = planOf('powershell')
    expect(plan.file).toMatch(/powershell\.exe$/i)
    expect(plan.args[0]).toBe('-NoProfile')
    expect(plan.args[1]).toBe('-Command')
    expect(String(plan.args[2])).toContain('$LASTEXITCODE')
    expect(String(plan.args[2])).toContain('[Console]::OutputEncoding')
  })

  test('pwsh：file 落在 pwsh.exe，参数与 powershell 同形', () => {
    const plan = planOf('pwsh')
    expect(plan.file).toMatch(/pwsh\.exe$/i)
    expect(plan.args[1]).toBe('-Command')
    expect(String(plan.args[2])).toContain('$LASTEXITCODE')
  })

  test('gitbash：不读 profile，命令从 -c 进', () => {
    const plan = planOf('gitbash')
    expect(plan.args[0]).toBe('--noprofile')
    expect(plan.args[1]).toBe('--norc')
    expect(plan.args[2]).toBe('-c')
    expect(plan.args[3]).toBe('echo hi')
  })

  test('wsl：钉住发行版（有的话）、--cd 落工作区、-e 交给 bash -lc', () => {
    const plan = planOf('wsl')
    const distro = env.wslDistroName()
    if (distro === '') {
      // 不知道发行版时直接 --cd；乱猜一个 `-d` 会让命令在别的发行版里跑。
      expect(plan.args[0]).toBe('--cd')
      expect(plan.args[1]).toBe(cwd)
    } else {
      expect(plan.args[0]).toBe('-d')
      expect(plan.args[1]).toBe(distro)
      expect(plan.args.includes('--cd')).toBe(true)
      expect(plan.args[plan.args.indexOf('--cd') + 1]).toBe(cwd)
    }
    expect(plan.args.includes('-e')).toBe(true)
    expect(plan.args.includes('bash')).toBe(true)
    expect(plan.args.includes('-lc')).toBe(true)
    expect(plan.args[plan.args.length - 1]).toBe('echo hi')
  })

  test('sh：就是 sh -c', () => {
    const plan = planOf('sh')
    expect(plan.file).toBe('sh')
    expect(plan.args[0]).toBe('-c')
  })

  test('auto 与平台默认一致', () => {
    const plan = planOf('auto')
    // auto 的语义就是「和平台默认一致」：写死一边会让另一半平台的命令全跑错解释器。
    if (IS_WIN) expect(plan.file).toMatch(/powershell\.exe$/i)
    else expect(plan.file).toBe('sh')
  })

  test('四套计划都带上了 cwd 与环境', () => {
    for (const plan of [planOf('powershell'), planOf('pwsh'), planOf('gitbash'), planOf('wsl')]) {
      expect(plan.cwd).toBe(cwd)
      expect(plan.env).toBe(envVars)
    }
  })
})

describe('④ 设置落盘与生效', () => {
  test('没配过 = auto', () => {
    expect(env.readShellChoice()).toBe('auto')
  })

  test('写进 plugins.json 后读得到 gitbash', () => {
    writePluginConfig('tools-default', { bashShell: 'gitbash' })
    env.forgetShellDetection()
    expect(env.readShellChoice()).toBe('gitbash')
  })

  test('手改坏档回落 auto', () => {
    // 配置文件是人会手改的：写坏了不该让宿主起不来。
    writePluginConfig('tools-default', { bashShell: '不认识的' })
    env.forgetShellDetection()
    expect(env.readShellChoice()).toBe('auto')
  })

  test('删掉键回到 auto', () => {
    writePluginConfig('tools-default', { bashShell: null })
    env.forgetShellDetection()
    expect(env.readShellChoice()).toBe('auto')
  })

  test('标签不是空串', () => {
    expect(env.shellChoiceLabel('auto')).not.toBe('')
    expect(env.shellLabel('pwsh')).not.toBe('')
  })
})

describe('⑤ 模型看到的东西跟着选中的终端改口', () => {
  test('bash 工具说明写 Git Bash，不再写着执行 PowerShell', () => {
    writePluginConfig('tools-default', { bashShell: 'gitbash' })
    env.forgetShellDetection()
    const tool = createBashTool()
    expect(tool.description).toContain('Git Bash')
    // 选了 Git Bash 还写「执行 PowerShell 命令」= 骗模型。
    expect(tool.description.startsWith('执行 PowerShell')).toBe(false)
  })

  test('切回 PowerShell 说明跟着改，终端工具说明也改口', () => {
    writePluginConfig('tools-default', { bashShell: 'powershell' })
    env.forgetShellDetection()
    expect(createBashTool().description.startsWith('执行 PowerShell')).toBe(true)
    // 终端表只需要「能构造出工具」这一面；description 才是被测对象，这里给最小桩。
    const stubTable = {
      open: () => 'x',
      read: () => ({}),
      close: () => '',
      list: () => [],
    } as unknown as Parameters<typeof createTerminalTool>[0]
    const terminalTool = createTerminalTool(stubTable)
    expect(terminalTool.description).toContain('PowerShell')
  })

  test('环境快照写出实际终端', () => {
    const text = environmentText(process.cwd())
    expect(text).toContain('bash 工具跑的是')
    if (IS_WIN) {
      // 只在 Windows 断言具体档位：POSIX 上这段写的是平台名，写死 PowerShell 就是
      // 把 Windows 行为当成跨平台事实。
      expect(text).toContain('bash 工具跑的是 PowerShell')
    }
  })
})

describe('⑥ 审批地板的引号规则跟着实际 shell 走', () => {
  /** 按指定 shell 家族建一份地板，返回判定函数。 */
  function decideWith(shell: () => 'posix' | 'powershell') {
    const floor = createApprovalFloor({
      readConfig: () => ({ config: DEFAULT_FLOOR_CONFIG, problems: [] }),
      rules: () => [],
      shell,
    })
    return (command: string) =>
      floor.guard.decide({
        toolName: 'bash',
        risk: 'exec',
        cwd: process.cwd(),
        args: {},
        command,
        signal: new AbortController().signal,
        sessionId: 'terminal-env-int-spec',
        sessionPath: 'terminal-env-int-spec.jsonl',
      }) as { action: string; reason?: string }
  }

  const posixDecide = decideWith(() => 'posix')
  const psDecide = decideWith(() => 'powershell')

  test('`\\"` 在 POSIX 下不算引号没闭合，在 PowerShell 下算', () => {
    // `\"` 在 POSIX 里是转义引号（配对完整），在 PowerShell 里不是转义符（引号就此闭合）。
    const command = 'echo "a\\"b"'
    const posix = posixDecide(command)
    expect(posix.reason ?? '').not.toContain('引号没闭合')
    const ps = psDecide(command)
    expect(ps.action).toBe('deny')
    expect(ps.reason ?? '').toContain('引号没闭合')
  })

  test('反引号：POSIX 按命令替换拒，PowerShell 不按替换拒', () => {
    const command = 'echo `date`'
    const posix = posixDecide(command)
    expect(posix.action).toBe('deny')
    expect(posix.reason ?? '').toContain('替换')
    expect(psDecide(command).reason ?? '').not.toContain('替换')
  })

  test('rm -rf / 两种口径都拒（灾难命令与语法无关）', () => {
    expect(posixDecide('rm -rf /').action).toBe('deny')
    expect(psDecide('rm -rf /').action).toBe('deny')
  })
})
