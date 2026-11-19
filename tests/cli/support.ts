/**
 * 真入口 e2e（cli 层）的公共设施：spawn `bin/dsc.js`、临时主目录、进程树收尾。
 *
 * ## 为什么不复用 harness 的 `runCli`
 *
 * 能复用的地方都复用了（C1/C2/C4/C5/C6 直接用它）。它有两个做不到的事：
 *   1. **让进程活着**：它在 `stdin.end()` 后等退出，而 C7/C8 要在 TUI 已经起来、
 *      会话文件已经落盘之后才动手；
 *   2. **收整棵进程树**：`bin/dsc.js` 会 spawn `lib/boot.js`，只杀父进程会留下孤儿子进程
 *      （Windows 上尤其明显）。这里用 `taskkill /T /F`（win32）或直接 SIGKILL 子进程。
 *
 * ## 为什么不再另建一套 HOME 规则
 *
 * `runCli` 的隔离口径（临时 HOME + 删掉继承的 DSC_HOME）是对的，本文件的 spawn 照抄：
 * HOME / USERPROFILE 指临时目录、删 DSC_HOME、`NO_COLOR=1`。抄错一处就会出现「测试
 * 绿了、用户 ~/.dsc 脏了」——那是只能在事故后才发现的问题。
 *
 * @module dsc/tests/cli/support
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTempDir } from '../support/tmp-dir.js'

/** 仓库根（`tests/cli/support.ts` 往上两级）。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 真入口：`bin/dsc.js`（设计 §11.1「命令 = node bin/dsc.js」）。 */
export const CLI_ENTRY = join(ROOT, 'bin', 'dsc.js')

/** 一份隔离主目录。`dscHome` 已建好，可预置 config.yaml / plugins.json。 */
export interface CliHome {
  home: string
  dscHome: string
}

/** 建临时主目录（收尾按成败处理：全绿删、有红留，见 `tests/support/tmp-dir.ts`）。 */
export function makeHome(): CliHome {
  const home = createTempDir('dsc-cli-e2e-')
  const dscHome = join(home, '.dsc')
  mkdirSync(dscHome, { recursive: true })
  return { home, dscHome }
}

/** spawn 时用的环境：隔离口径与 `runCli` 同一份（见文件头）。 */
export function envFor(target: CliHome): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.DSC_HOME
  return {
    ...env,
    HOME: target.home,
    USERPROFILE: target.home,
    DSC_HOME: target.dscHome,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
}

/** 一个活着的 CLI 进程。 */
export interface LiveCli {
  readonly pid: number
  readonly stdout: () => string
  readonly stderr: () => string
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** 杀掉整棵进程树（父 + boot 子进程），等两边都收场。 */
  kill(): Promise<void>
}

/**
 * 起一个 CLI 并让它活着（stdin 保持打开，不触发 C6 的 EOF 收场）。
 *
 * @param args - 传给 `bin/dsc.js` 的参数
 * @param target - 隔离主目录
 */
export function spawnCli(args: string[], target: CliHome): LiveCli {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: target.home,
    env: envFor(target),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  // 子进程提前退出时写 stdin 会 EPIPE；不是被测行为。
  child.stdin.on('error', () => undefined)

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.on('close', (code, signal) => resolveExit({ code, signal }))
  })

  return {
    pid: child.pid ?? -1,
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    async kill() {
      if (process.platform === 'win32') {
        // /T 连同 boot 子进程一起收掉，/F 不给它挂起的机会（测试收尾要确定）。
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
      await exited
    },
  }
}

/** 轮询等一个文件出现（TUI 起来后才会建会话文件），超时抛错。 */
export async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() < startedAt + timeoutMs) {
    try {
      if (statSync(path).isFile()) return
    } catch {
      // 还没落盘，继续等。
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 100))
  }
  throw new Error(`等不到文件：${path}（超时 ${String(timeoutMs)}ms）`)
}

/** 主目录里所有会话 jsonl（递归；`~/.dsc/sessions/<cwd slug>/` 才是那一层）。 */
export function sessionFiles(target: CliHome): string[] {
  return listInSessions(target, (name) => name.endsWith('.jsonl'))
}

/**
 * 会话写租约文件（`.jsonl.lock`）。
 *
 * 为什么单独读它：新会话的 jsonl 是**惰性**的——启动时只建锁与 `.last-session` 指针，
 * 第一条消息落下才写 jsonl。C7/C8 要验的是「实例起来了、各占一份会话」，锁文件是
 * 那一刻唯一可靠的存在证据。
 */
export function sessionLeases(target: CliHome): string[] {
  return listInSessions(target, (name) => name.endsWith('.jsonl.lock'))
}

function listInSessions(target: CliHome, pick: (name: string) => boolean): string[] {
  const dir = join(target.dscHome, 'sessions')
  let names: string[]
  try {
    names = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  } catch {
    return []
  }
  return names
    .filter(pick)
    .sort()
    .map((name) => join(dir, name))
}

/** 轮询等至少 `count` 份会话文件出现，返回它们。 */
export async function waitForSessions(target: CliHome, count: number, timeoutMs = 25_000): Promise<string[]> {
  return waitFor(() => sessionFiles(target), count, `会话 jsonl`, timeoutMs)
}

/** 轮询等至少 `count` 份会话租约出现（TUI 刚起来时 jsonl 还没写，见 sessionLeases）。 */
export async function waitForLeases(target: CliHome, count: number, timeoutMs = 25_000): Promise<string[]> {
  return waitFor(() => sessionLeases(target), count, '会话租约', timeoutMs)
}

/** 轮询等一个条件成立（返回的数组长度达标），超时抛错并报当前数量。 */
async function waitFor(read: () => string[], count: number, label: string, timeoutMs: number): Promise<string[]> {
  const startedAt = Date.now()
  while (Date.now() < startedAt + timeoutMs) {
    const found = read()
    if (found.length >= count) return found
    await new Promise((resolveTick) => setTimeout(resolveTick, 100))
  }
  throw new Error(`等不到 ${String(count)} 份${label}（当前 ${String(read().length)} 份）`)
}

/** `.last-session` 指针的内容（启动过就会写；读不到给 null）。 */
export function lastSessionPointer(target: CliHome): string | null {
  try {
    return readFileSync(join(target.dscHome, '.last-session'), 'utf8').trim()
  } catch {
    return null
  }
}

/** 读一次文件行数（给「两个实例没有互相写坏」这类断言用）。 */
export function countLines(path: string): number {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').length
}

/** C3 的 PTY 驱动：POSIX 标准库实现，Windows 上由调用方显式 skip。 */
export const PTY_DRIVER = join(ROOT, 'tests', 'cli', 'pty-driver.py')

/** PTY 脚本的一步：等 `after` 出现、再等 `delayMs`，然后送 `send`。 */
export interface PtyStep {
  send: string
  /** 输出里出现该子串后才发送（例如等模型回复落地）。 */
  after?: string
  /** 发送前至少等待的毫秒数。 */
  delayMs?: number
}

/** PTY 驱动的结果：退出码、是否超时、去掉不了 ANSI 的整段输出。 */
export interface PtyResult {
  code: number | null
  timedOut: boolean
  output: string
}

/**
 * 在真 PTY 里跑 `bin/dsc.js`：C3 需要「往 TUI 里敲字」，管道 stdin 做不到。
 *
 * @param args - 传给 `bin/dsc.js` 的参数
 * @param target - 隔离主目录
 * @param steps - 按键脚本（见 `PtyStep`）
 * @param opts - 超时与额外环境变量（例如假模型的 key）
 */
export async function runInPty(
  args: string[],
  target: CliHome,
  steps: PtyStep[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<PtyResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const python = process.env['DSC_PYTHON'] ?? 'python3'
  const child = spawn(python, [PTY_DRIVER, String(timeoutMs), process.execPath, CLI_ENTRY, ...args], {
    cwd: target.home,
    env: {
      ...envFor(target),
      ...(opts.env ?? {}),
      DSC_PTY_STEPS: JSON.stringify(steps),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const closed = new Promise<number | null>((resolveClose, rejectClose) => {
    child.on('error', (error) => rejectClose(new Error(`PTY 驱动起不来（${python}）：${error.message}`)))
    child.on('close', (code) => resolveClose(code))
  })
  // 驱动自己有超时；这层是防「驱动本身卡死」的兜底，比它多给 10 秒。
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 10_000)
  let code: number | null
  try {
    code = await closed
  } finally {
    clearTimeout(timer)
  }
  const lastLine = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .at(-1)
  if (lastLine === undefined) {
    throw new Error(`PTY 驱动没有输出（exit ${String(code)}）：${stderr.slice(-500)}`)
  }
  try {
    return JSON.parse(lastLine) as PtyResult
  } catch {
    throw new Error(`PTY 驱动输出不是 JSON（exit ${String(code)}）：${lastLine.slice(0, 500)}`)
  }
}
