/**
 * 持久 shell：给极简档用的「一条常驻 shell、状态跨调用保留」工具（对齐 dsh 的
 * persistent-pwsh / persistent-bash）。
 *
 * 与旁边两个东西的关系：
 *   - `bash`（bash.ts）：每条命令一个进程，干净但每条都要重新 cd；
 *   - `terminal`（bash.ts 的 T20）：持久会话，但它是五动作（open/send/read/close/list），
 *     模型要自己轮询，适合跑 REPL / 交互式程序；
 *   - 本文件：持久会话 + 单动作。调用一次 = 发一条命令 + 等它跑完 + 交回输出。
 *
 * 怎么判断「命令跑完了」：管道模式没有 PTY，拿不到真正的提示符事件，所以每条命令后面
 * 跟一行哨兵（PowerShell 侧 `Write-Output ('__DS'+'C_<tag>__<exit>')`，bash 侧 `echo`）。
 * 读到这行就收工——比「输出静默」可靠：命令中间停顿几秒不会被误判成结束。
 * 哨兵字面量必须拆开拼：shell 会把输入行回显到输出流里，写死的话会先命中回显（踩过）。
 *
 * 命令体走 base64 单行传输：多行脚本在管道 stdin 下会被逐行执行，`& {` 那种写法会当场报错。
 * 编码之后整段脚本是一个 `Invoke-Expression` 的入参，多行、引号、中文都不用转义。
 * 为什么是 Invoke-Expression 而不是 & ([scriptblock]::Create(...))：后者开子作用域，
 * `$x = 41` 留不下来，下一次调用就读不到（踩过）。
 *
 * 已知边界（与 dsh 的 PTY 版差距）：
 *   - 没有 tty：vim/htop 这类全屏程序跑不了（要看交互用 `terminal`）；
 *   - 前台等 stdin 的命令会一直挂到超时；超时收掉 shell 重建，下次从全新状态开始（dsh 同约定）；
 *   - 输出上限固定 16000 字符（超出保留前缀并说明裁剪）。
 *
 * @module dsc/core/tools/persistent-shell
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { isUtf8 } from 'node:buffer'
import type { ToolEntry } from '../../core/tools.js'
import { scrubChildEnv } from '../../core/secrets.js'
import { readShellChoice, resolveShellExecutable } from '../../core/terminal-env.js'
import { killTree, trackBackgroundChild, untrackBackgroundChild } from './bash.js'

/** 单条命令的墙钟上限（与 dsh 的 persistent-pwsh 默认值一致）。 */
export const PERSISTENT_TIMEOUT_MS = 300_000
/** 交回上下文的输出上限。 */
export const PERSISTENT_OUTPUT_MAX = 16_000
/** 轮询间隔：哨兵一般几十毫秒内到，40ms 足够跟手又不烧 CPU。 */
const POLL_MS = 40


/** 一个会话的常驻 shell。 */
export interface PersistentShell {
  child: ChildProcess
  /** 原始输出（含回显与哨兵）；读取侧按位置切片。 */
  output: string
  /** 会话被收掉或 shell 自己退出之后置 false，下次调用重建。 */
  alive: boolean
  /** 起进程时认下来的方言（哨兵与初始化各不一样）。 */
  kind: 'pwsh' | 'bash'
  /** 串行锁：同一会话的命令一条接一条跑。 */
  chain: Promise<unknown>
}

/**
 * 按块解码：中文 Windows 上 PowerShell 写 stdout 用 GBK（管道模式改不掉，实测
 * `[Console]::OutputEncoding` 无效），bash 用 UTF-8。ASCII 两者一致，所以先判整块
 * 是不是合法 UTF-8：是就按 UTF-8，不是就按 GBK——中文不会变成一串替换符。
 */
export function decodeChunk(chunk: Buffer): string {
  return isUtf8(chunk) ? chunk.toString('utf8') : new TextDecoder('gbk').decode(chunk)
}

/** 随机 nonce：只由字母数字组成，避免被 shell 当特殊字符。 */
function nonce(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** 命令体编码成单行 base64（UTF-8）。 */
export function encodeCommand(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64')
}

/** 按设置里的终端选择起一个「逐行读 stdin」的 shell（不是 -Command -，那个读满 EOF 才执行）。 */
function spawnPersistent(cwd: string): { child: ChildProcess; kind: 'pwsh' | 'bash' } {
  const { env } = scrubChildEnv(process.env)
  const choice = readShellChoice()
  const base: SpawnOptions = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env, ...(cwd === '' ? {} : { cwd }) }
  if (choice === 'gitbash') {
    return { child: spawn(resolveShellExecutable('gitbash'), ['--noprofile', '--norc'], base), kind: 'bash' }
  }
  if (choice === 'wsl') {
    return { child: spawn(resolveShellExecutable('wsl'), cwd === '' ? ['--', 'bash', '-l'] : ['--cd', cwd, '--', 'bash', '-l'], base), kind: 'bash' }
  }
  if (choice === 'sh') {
    return { child: spawn('bash', ['--noprofile', '--norc'], { ...base, detached: true }), kind: 'bash' }
  }
  if (choice === 'pwsh') {
    return { child: spawn(resolveShellExecutable('pwsh'), ['-NoLogo', '-NoProfile', '-NonInteractive'], base), kind: 'pwsh' }
  }
  if (process.platform === 'win32') {
    return { child: spawn(resolveShellExecutable('powershell'), ['-NoLogo', '-NoProfile', '-NonInteractive'], base), kind: 'pwsh' }
  }
  return { child: spawn('bash', ['--noprofile', '--norc'], { ...base, detached: true }), kind: 'bash' }
}

/** 一条命令的发送脚本：执行命令体，再打一行哨兵（带退出码）。 */
export function shellEnvelope(kind: 'pwsh' | 'bash', body: string, tag: string): string {
  // 哨兵的字面量必须拆开拼：shell 会把输入行回显到输出流里，整段写死的话
  // `__DSC_<tag>__` 会先出现在回显行里，读取侧当场「等到」一个假的完成标记（实测踩过）。
  // try/catch 也必须包住：throw 是终止错误，不兜的话整串命令中断、哨兵永远不出现。
  if (kind === 'pwsh') {
    return `$__dsc = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body}')); $__ec = 0; try { Invoke-Expression $__dsc; $__ec = $LASTEXITCODE } catch { Write-Output ('[错误] ' + $_.Exception.Message); $__ec = 1 }; Write-Output ('__DS' + 'C_${tag}__' + [string]$__ec)`
  }
  return `eval "$(printf '%s' '${body}' | base64 -d)"; __ec=$?; echo "__DS""C_${tag}__$__ec"`
}

/** 去掉 shell 回显的输入行、哨兵行与结尾的提示符。 */
export function cleanShellOutput(text: string, kind: 'pwsh' | 'bash'): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const kept: string[] = []
  for (const line of lines) {
    // 回显行有两种样子：PowerShell 的 `PS <cwd>> <input>`、bash 的裸输入行。
    if (/^PS .*> /.test(line) && /base64/i.test(line)) continue
    if (/base64/i.test(line) && /(__DSC_|FromBase64String|eval )/.test(line)) continue
    // 哨兵行本身（含前面命令残留的）不进结果。
    if (/__DS["']?C_[a-z0-9]+__/.test(line)) continue
    kept.push(line)
  }
  while (kept.length > 0 && /^\s*$/.test(kept[kept.length - 1] ?? '')) kept.pop()
  const last = kept[kept.length - 1]
  if (last !== undefined && (/^PS .*>\s*$/.test(last) || /^\S*[$#]\s*$/.test(last))) kept.pop()
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 等待哨兵出现；超时返回 null。 */
async function waitFor(shell: PersistentShell, from: number, marker: string, timeoutMs: number): Promise<{ text: string; exit: number | null } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!shell.alive) return null
    const at = shell.output.indexOf(marker, from)
    if (at >= 0) {
      const after = shell.output.slice(at + marker.length, at + marker.length + 12)
      const exitText = after.split(/\r?\n/)[0] ?? ''
      const exit = exitText.trim() === '' ? null : Number.parseInt(exitText.trim(), 10)
      return { text: shell.output.slice(from, at), exit: Number.isFinite(exit) ? exit : null }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return null
}

/** 一个会话一份的常驻 shell 表。 */
export class PersistentShellTable {
  private readonly shells = new Map<string, PersistentShell>()

  /** 收掉一个会话的 shell（会话结束、内核卸载、测试清理都走它）。 */
  close(sessionId: string): boolean {
    const shell = this.shells.get(sessionId)
    if (shell === undefined) return false
    this.shells.delete(sessionId)
    shell.alive = false
    killTree(shell.child)
    untrackBackgroundChild('shell:' + sessionId)
    return true
  }

  /** 收掉全部（工具卸载钩子）。 */
  closeAll(): void {
    for (const id of [...this.shells.keys()]) this.close(id)
  }

  /** 取（或建）一个会话的 shell。 */
  private ensure(sessionId: string, cwd: string): PersistentShell {
    const existing = this.shells.get(sessionId)
    if (existing !== undefined && existing.alive) return existing
    if (existing !== undefined) this.close(sessionId)
    const { child, kind } = spawnPersistent(cwd)
    const shell: PersistentShell = { child, output: '', alive: true, kind, chain: Promise.resolve() }
    trackBackgroundChild('shell:' + sessionId, child)
    child.stdout?.on('data', (chunk: Buffer) => {
      shell.output += decodeChunk(chunk)
      // 缓冲留四倍余量：哨兵必须留着，否则永远等不到。
      if (shell.output.length > PERSISTENT_OUTPUT_MAX * 4) shell.output = shell.output.slice(-PERSISTENT_OUTPUT_MAX * 3)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      shell.output += decodeChunk(chunk)
    })
    child.on('exit', () => {
      shell.alive = false
    })
    child.on('error', () => {
      shell.alive = false
    })
    this.shells.set(sessionId, shell)
    return shell
  }

  /** 发送一条命令并等哨兵（内部用：编码初始化与用户命令走同一条路）。 */
  private async exec(shell: PersistentShell, command: string, timeoutMs: number): Promise<{ text: string; exit: number | null; partial: string } | null> {
    const tag = nonce()
    const marker = '__DSC_' + tag + '__'
    const from = shell.output.length
    shell.child.stdin?.write(shellEnvelope(shell.kind, encodeCommand(command), tag) + '\n')
    const done = await waitFor(shell, from, marker, timeoutMs)
    if (done === null) return null
    return { text: cleanShellOutput(done.text, shell.kind), exit: done.exit, partial: cleanShellOutput(shell.output.slice(from), shell.kind) }
  }

  /**
   * 在一个会话的常驻 shell 里跑一条命令。
   * @returns 输出文本；退出码非 0 时在末尾补 [exit code: N]
   */
  run(sessionId: string, cwd: string, command: string, timeoutMs = PERSISTENT_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    const shell = this.ensure(sessionId, cwd)
    // 同一会话串行：两条命令挤进同一个 stdin，输出会交错。
    const next = shell.chain.then(async () => {
      if (!shell.alive) throw new Error('这个会话的 shell 已经退出，下一次调用会重新起一个（状态不保留）')
      if (signal?.aborted === true) throw new Error('调用已取消')
      const done = await this.exec(shell, command, timeoutMs)
      if (done === null) {
        // 超时：收掉壳，下次全新（与 dsh 的约定一致）。已收输出交回一部分，让模型知道跑到了哪。
        const partial = shell.output.slice(-PERSISTENT_OUTPUT_MAX)
        this.close(sessionId)
        throw new Error(
          '命令超过 ' + String(Math.round(timeoutMs / 1000)) + ' 秒还没结束，已收掉这个 shell（下次调用从全新状态开始）\n' + partial,
        )
      }
      const body =
        done.text.length > PERSISTENT_OUTPUT_MAX
          ? done.text.slice(0, PERSISTENT_OUTPUT_MAX) + '\n\n[输出超过 ' + String(PERSISTENT_OUTPUT_MAX) + ' 字符，只保留前缀]'
          : done.text
      return done.exit !== null && done.exit !== 0 ? body + '\n[exit code: ' + String(done.exit) + ']' : body
    })
    shell.chain = next.catch(() => undefined)
    return next
  }
}

export interface PersistentShellBudgets {
  timeoutMs: number
}

/** 造 `shell` 工具（极简档专用：标准档有 bash，不必多一段常驻 shell 的 schema）。 */
export function createPersistentShellTool(table: PersistentShellTable, budgets: PersistentShellBudgets, noun: string): ToolEntry {
  const seconds = Math.round(budgets.timeoutMs / 1000)
  const description = [
    '在一条常驻的 ' + noun + ' 里执行命令：当前目录、环境变量、函数与后台任务都跨调用保留。',
    '',
    '与 bash 的区别：bash 每条命令一个干净进程；这条 shell 的状态会留到下一次调用。',
    '',
    '规矩：',
    '- 一次只发一条命令；多行脚本也可以（会整段执行）。',
    '- 前台等输入的命令（Read-Host、交互式安装器）会挂到超时，别用。看交互用 terminal 工具。',
    '- 单条命令最多跑 ' + String(seconds) + ' 秒；超时收掉 shell，下次调用从全新状态开始。',
    '- 输出超过 ' + String(PERSISTENT_OUTPUT_MAX) + ' 字符只保留前缀。',
    '- 退出码非 0 时结果末尾会给 [exit code: N]。',
  ].join('\n')
  return {
    name: 'shell',
    description,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令；多行脚本整段执行' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    risk: 'exec',
    presets: ['minimal'],
    async run(args, ctx) {
      const command = String(args.command ?? '')
      if (command.trim() === '') throw new Error('command 不能为空')
      return table.run(ctx.sessionId, ctx.cwd, command, budgets.timeoutMs, ctx.signal)
    },
  }
}
