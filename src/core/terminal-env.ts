/**
 * 终端环境探测与「默认终端」选择：这台机器上有哪几个 shell 能当命令执行器。
 *
 * 为什么要有这一层（2026-10-30 需求）：bash 工具长期以来在 Windows 上写死
 * `powershell.exe`——也就是说不管机器上装了什么，模型跑命令永远走 Windows PowerShell 5.1。
 * 装了 PowerShell 7 的人要 UTF-8 默认编码与更快的启动；用 Git Bash 的人希望
 * `git`/`node` 的 POSIX 写法直接可用；WSL 里的人希望命令落在 Linux 里。
 * 这些都不是"猜"得出来的：必须真去探一次，探到了才把选项摆出来。
 *
 * 探什么、怎么探（全部是**只读**、有超时的子进程调用，不做任何写操作）：
 *   - PowerShell 5.1：`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
 *   - PowerShell 7+：`pwsh.exe`（PATH，其次 `%ProgramFiles%\PowerShell\7\pwsh.exe`）
 *   - Git Bash：`where bash` 的第一条（排除 System32 下那个 WSL 转发壳），
 *     其次三个常规安装路径
 *   - WSL：`wsl.exe --status`（`--version` 在旧版 Win10 上不存在，`-l -q` 可能弹安装提示）
 *
 * 探测结果缓存 {@link DETECT_TTL_MS}，设置页每次打开都会现取一份（过期就重探）；
 * 「重新检测」按钮走 {@link detectShells} 的 force 分支。
 *
 * @module dsc/core/terminal-env
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePluginConfig } from './plugin-registry.js'

/** 可选的命令执行终端。`auto` = 跟平台默认（Windows PowerShell 5.1 / POSIX sh）。 */
export type ShellChoice = 'auto' | 'powershell' | 'pwsh' | 'gitbash' | 'wsl' | 'sh'

/** 结构扫描认的两种语法家族（见 core/approval-floor.ts 的 inspectStructure）。 */
export type ShellFlavor = 'powershell' | 'posix'

/** 一台机器上一个可用的终端。 */
export interface ShellCandidate {
  /** 存进配置的值。 */
  value: ShellChoice
  /** 给人看的名字，带版本（例如 `PowerShell 7.4.6`）。 */
  label: string
  /** 这一项此刻能不能选。 */
  available: boolean
  /** 一句话说明：可执行文件路径或版本号；不可用时说为什么。 */
  detail: string
  /** 只有 `wsl` 带这一项：这条命令会落在哪个发行版里（`docker-desktop` 会被跳过）。 */
  distro?: string
}

/** 设置里认得的全部取值（写盘校验与探针共用一份）。 */
export const SHELL_CHOICES: readonly ShellChoice[] = ['auto', 'powershell', 'pwsh', 'gitbash', 'wsl', 'sh']

/**
 * 探测结果的缓存时长。
 *
 * 为什么给 5 分钟而不是几秒：设置页每次打开都会走一遍各分区的 `fields()`，而探测要起四个
 * 子进程（冷启动约 2.5 秒，`spawnSync` 会挡住事件循环）。装 shell 是低频事件，
 * 五分钟缓存 + 一个「重新检测」按钮就够；`tools-default` 挂载后还会后台预热一次。
 */
export const DETECT_TTL_MS = 5 * 60_000

/** 单个探测子进程的超时。装了 WSL 但没装发行版时 `wsl.exe` 会慢一些。 */
const PROBE_TIMEOUT_MS = 4_000

const isWin = process.platform === 'win32'

/** 认不出的值一律回落 auto（配置文件手改坏不至于起不来）。 */
export function parseShellChoice(value: unknown): ShellChoice {
  return typeof value === 'string' && (SHELL_CHOICES as readonly string[]).includes(value)
    ? (value as ShellChoice)
    : 'auto'
}

/** 这个选择该按哪种语法做结构扫描：PowerShell 家族与 POSIX 家族。 */
export function shellFlavor(choice: ShellChoice): ShellFlavor {
  if (choice === 'powershell' || choice === 'pwsh') return 'powershell'
  if (choice === 'auto') return isWin ? 'powershell' : 'posix'
  return 'posix'
}

/** 一次探测的原始结果。 */
interface ProbeResult {
  ok: boolean
  /** 标准输出与标准错误合起来的头几行（版本号在这里）。 */
  text: string
}

/**
 * 起一个探测子进程并收输出。
 *
 * 为什么按字节收再自己解：`wsl.exe` 在旧版 Windows 上按 UTF-16LE 写 stdout，
 * 直接按 utf8 解就是一堆 `U\0b\0u\0n\0t\0u\0`。见到成片的 NUL 就换 UTF-16LE 再解一次。
 */
function probe(file: string, args: readonly string[]): ProbeResult {
  try {
    const done = spawnSync(file, [...args], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (done.error !== undefined) return { ok: false, text: '' }
    const raw = Buffer.concat([done.stdout ?? Buffer.alloc(0), done.stderr ?? Buffer.alloc(0)])
    if (raw.length === 0) return { ok: done.status === 0, text: '' }
    const nul = raw.subarray(0, Math.min(raw.length, 64)).filter((byte) => byte === 0).length
    const text =
      nul > 8
        ? raw.toString('utf16le')
        : new TextDecoder('utf-8').decode(raw)
    return { ok: done.status === 0, text: text.replace(/\0/g, '').trim() }
  } catch {
    return { ok: false, text: '' }
  }
}

/** 取一段文本的第一行非空内容。 */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** `where` / `which` 找可执行文件的第一条结果。 */
function which(name: string): string | undefined {
  const result = isWin ? probe('where.exe', [name]) : probe('which', [name])
  const line = firstLine(result.ok ? result.text : '')
  if (line === '' || !existsSync(line)) return undefined
  return line
}

/** 从 `X.Y.Z` 形式的版本串里取前两段（`5.1` / `7.4`），取不到就用原串。 */
function shortVersion(text: string): string {
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(text)
  return match === null ? text.slice(0, 40) : match[1]!
}

/** PowerShell 5.1：路径是固定的，探版本只为把版本号写进标签。 */
function detectWindowsPowerShell(): ShellCandidate {
  const file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!existsSync(file)) {
    return { value: 'powershell', label: 'PowerShell 5.1', available: false, detail: '没找到 powershell.exe' }
  }
  const result = probe(file, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])
  const version = result.ok ? shortVersion(firstLine(result.text)) : ''
  return {
    value: 'powershell',
    label: version === '' ? 'PowerShell 5.1' : `PowerShell ${version}`,
    available: true,
    detail: file,
  }
}

/** PowerShell 7+：先 PATH，再常见安装路径。 */
function detectPwsh(): ShellCandidate {
  const candidates: string[] = []
  const found = which('pwsh.exe')
  if (found !== undefined) candidates.push(found)
  if (process.env.ProgramFiles !== undefined) {
    candidates.push(join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'))
  }
  if (process.env.LOCALAPPDATA !== undefined) {
    candidates.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const result = probe(file, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])
    if (!result.ok) continue
    return {
      value: 'pwsh',
      label: `PowerShell ${shortVersion(firstLine(result.text))}`,
      available: true,
      detail: file,
    }
  }
  return { value: 'pwsh', label: 'PowerShell 7', available: false, detail: '没装 pwsh.exe' }
}

/** Git Bash：先试常规安装路径，再退回 `where bash`（排除 System32 里那个 WSL 转发壳）。 */
function detectGitBash(): ShellCandidate {
  const candidates: string[] = []
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (root === undefined) continue
    candidates.push(join(root, 'Git', 'bin', 'bash.exe'))
    candidates.push(join(root, 'Programs', 'Git', 'bin', 'bash.exe'))
  }
  // `where bash` 排在最后：应用自带的 MSYS bash 也可能在 PATH 里（dsh 就自带一份），
  // 用户自己装的 Git 才该排前面——两者的行为一致，但版本与 profile 未必一样。
  const found = which('bash.exe')
  if (found !== undefined && !/\\Windows\\System32\\/i.test(found)) candidates.push(found)
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const result = probe(file, ['--version'])
    if (!result.ok) continue
    // 输出形如 `GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)`
    return {
      value: 'gitbash',
      label: `Git Bash ${shortVersion(firstLine(result.text))}`,
      available: true,
      detail: file,
    }
  }
  return { value: 'gitbash', label: 'Git Bash', available: false, detail: '没找到 Git 自带的 bash.exe' }
}

/** WSL：`--status` 最轻量（不会触发「要不要装发行版」的提示，也不会启动虚拟机）。 */
function detectWsl(): ShellCandidate {
  const file = which('wsl.exe') ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
  if (!existsSync(file)) {
    return { value: 'wsl', label: 'WSL', available: false, detail: '没装 WSL' }
  }
  const status = probe(file, ['--status'])
  if (!status.ok) return { value: 'wsl', label: 'WSL', available: false, detail: 'wsl.exe 不可用（没装发行版或没启用来宾机服务）' }
  const distro = chooseWslDistro(file)
  if (distro.kind === 'none') {
    return { value: 'wsl', label: 'WSL', available: false, detail: '没有能跑命令的 Linux 发行版' }
  }
  return {
    value: 'wsl',
    label: `WSL（${distro.name}）`,
    available: true,
    detail: file,
    distro: distro.name,
  }
}

/**
 * 挑一个能跑用户命令的发行版。
 *
 * 为什么不能直接用 `wsl --list` 的第一行、也不是无脑用默认发行版（2026-10-30 实测）：
 * 装了 Docker Desktop 的机器上，默认发行版常常是 `docker-desktop`（一只只跑 Docker 的
 * 微型发行版，里面没有 bash）。拿它跑 `bash -lc` 会报
 * `/bin/sh: bash: Permission denied`——用户看到的是「选了 WSL，命令全挂」。
 *
 * 挑选顺序：默认发行版 → 其余非 Docker 管理的发行版 → 没有就判不可用。
 * 只读 `wsl -l -v` 的输出，不启动任何发行版。
 */
function chooseWslDistro(file: string): { kind: 'distro'; name: string } | { kind: 'none' } {
  const verbose = probe(file, ['-l', '-v'])
  if (!verbose.ok) return { kind: 'none' }
  const rows = verbose.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(NAME|名称)\b/i.test(line))
  const parsed = rows
    .map((line) => ({
      isDefault: line.startsWith('*'),
      name: line.replace(/^\*\s*/, '').split(/\s{2,}|\t/)[0]?.trim() ?? '',
    }))
    .filter((row) => row.name !== '')
  // Docker Desktop 的两个管理发行版：能起容器，但不是给人跑命令的环境。
  const managed = /^docker-desktop/i
  const fallback = parsed.find((row) => !managed.test(row.name))
  const picked = parsed.find((row) => row.isDefault && !managed.test(row.name)) ?? fallback
  return picked === undefined ? { kind: 'none' } : { kind: 'distro', name: picked.name }
}

/** POSIX 平台上的 `sh`：不是选项，是 auto 的落地。 */
function detectPosixShell(): ShellCandidate {
  const file = which('bash') ?? which('sh') ?? '/bin/sh'
  const result = probe(file, ['--version'])
  return {
    value: 'sh',
    label: result.ok ? `sh（${shortVersion(firstLine(result.text))}）` : 'sh',
    available: true,
    detail: file,
  }
}

/** 缓存：探测要起几次子进程，设置页反复打开不该重复付这份钱。 */
let cache: { at: number; list: ShellCandidate[] } | undefined

/**
 * 探测这台机器上能用的终端。
 *
 * @param force - true = 跳过缓存重探（设置页的「重新检测」按钮用）
 * @returns 第一项永远是 `auto`，后面按平台给出各项（不可用的也在里面，界面据此显示"未检测到"）
 */
export function detectShells(force = false): ShellCandidate[] {
  if (!force && cache !== undefined && Date.now() - cache.at < DETECT_TTL_MS) return cache.list
  const auto: ShellCandidate = {
    value: 'auto',
    label: isWin ? '跟随平台默认（Windows PowerShell 5.1）' : '跟随平台默认（sh）',
    available: true,
    detail: '出厂值：Windows 走 powershell.exe，其他平台走 sh',
  }
  const rest = isWin
    ? [detectWindowsPowerShell(), detectPwsh(), detectGitBash(), detectWsl()]
    : [detectPosixShell()]
  const list = [auto, ...rest]
  cache = { at: Date.now(), list }
  return list
}

/** 清掉探测缓存（配置改了、装完新 shell 之后调用）。 */
export function forgetShellDetection(): void {
  cache = undefined
  choiceCache = undefined
}

/** 当前选择缓存：每条命令都读一次 plugins.json 不值当，但改完要立刻生效。 */
let choiceCache: { at: number; choice: ShellChoice } | undefined
const CHOICE_TTL_MS = 2_000

/** 读 `plugins.json` 里 tools-default 的 `bashShell`；没配过 = auto。 */
export function readShellChoice(): ShellChoice {
  if (choiceCache !== undefined && Date.now() - choiceCache.at < CHOICE_TTL_MS) return choiceCache.choice
  const raw = resolvePluginConfig('tools-default')
  const choice = parseShellChoice(raw.bashShell)
  choiceCache = { at: Date.now(), choice }
  return choice
}

/**
 * 这条命令该交给哪个 WSL 发行版（探测时挑好的那个）。
 *
 * @returns 发行版名；没装 WSL、或 wsl 不可用时给空串（调用方退回「不指定 -d」）
 */
export function wslDistroName(): string {
  const hit = detectShells().find((item) => item.value === 'wsl')
  return hit?.distro ?? ''
}

/** 给提示词/工具描述用的一句话（例如 `Git Bash`、`PowerShell 7.4.6`）。 */
export function shellLabel(choice: ShellChoice): string {
  if (choice === 'auto') return isWin ? 'Windows PowerShell 5.1' : 'sh'
  const hit = detectShells().find((item) => item.value === choice)
  if (hit !== undefined && hit.available) return hit.label
  return choice
}

/**
 * 一个选择该用哪个可执行文件起进程。
 *
 * @param choice - 用户选的值
 * @returns 可执行文件绝对路径；`wsl` 给 wsl.exe，`auto` 按平台给默认 shell
 */
export function resolveShellExecutable(choice: ShellChoice): string {
  const pick = (value: ShellChoice): string | undefined => {
    const hit = detectShells().find((item) => item.value === value)
    return hit !== undefined && hit.available ? hit.detail : undefined
  }
  if (choice === 'powershell') return pick('powershell') ?? 'powershell.exe'
  if (choice === 'pwsh') return pick('pwsh') ?? 'pwsh.exe'
  if (choice === 'gitbash') return pick('gitbash') ?? 'bash.exe'
  if (choice === 'wsl') return pick('wsl') ?? 'wsl.exe'
  if (choice === 'sh') return pick('sh') ?? 'sh'
  return isWin ? (pick('powershell') ?? 'powershell.exe') : 'sh'
}

/**
 * 这个选择在界面上标成什么（设置项的回执文案用）。
 */
export function shellChoiceLabel(choice: ShellChoice): string {
  const hit = detectShells().find((item) => item.value === choice)
  return hit === undefined ? choice : hit.label
}
