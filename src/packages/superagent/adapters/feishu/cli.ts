/**
 * lark-cli 的两半：跑一次，和起一条常驻的长连接；外加把 CLI 的「退出码 + JSON 信封」翻成异常。
 *
 * 为什么端口是两个类型而不是一个：「补收历史」「回一条消息」都是一次调用、等输出、看退出码；
 * `event consume` 正好相反——它常驻，一行一行往外吐，停的时候要由调用方主动关。硬塞进一个签名，
 * 一次性调用就被迫关心流，流调用又得伪造退出码。两个类型共用同一支 CLI，靠 `--as bot --format json`
 * 这两个全局参数保持一致（上游 `infra/commands.ts:106`）。
 *
 * 错误码为什么单独留一个字段：回消息时「这条消息再也回不了」的判定只认飞书的数字码
 * （上游 `feishu-channel.ts:14-16`），把它压进 message 文本，判定就退化成字符串匹配——上游在
 * `CliError.code` 上做的事，这里一字不差地留着。
 *
 * 适配器不 spawn：`CliRun` / `CliConsume` 由接线层实现（真实现是 `execFile` 与 `readline`），
 * 本包只描述「要什么、怎么理解结果」。测试传假函数即可离线跑。
 *
 * @module dsc/packages/superagent/adapters/feishu/cli
 */
import type { z } from 'zod'

/** 一次 lark-cli 调用的结果。非零退出码不抛，由 `lark` 统一翻译。 */
export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 跑一次 lark-cli；`cwd` 只有下载资源这类要落文件的调用才用得上
 * （上游 `commands.lark(args, cwd)`，`feishu-image.ts:37-39`）。
 */
export type CliRun = (args: readonly string[], cwd?: string) => Promise<CliResult>

/** 一条常驻 CLI 的把手：停它，和等它结束。 */
export interface CliStream {
  /** 请求结束（上游是关 stdin 再发 SIGTERM，`feishu-loops.ts:76`）。之后不该再有新行。 */
  stop(): void
  /** 进程退出时带退出码收尾；被主动停掉也算一次结束。 */
  done: Promise<CliResult>
}

/** 长连接每读到一行就回调一次；两路分开，因为诊断与事件的处理方式不同。 */
export interface CliHandlers {
  stdout(line: string): void
  stderr(line: string): void
}

/**
 * 起一条常驻 lark-cli。
 *
 * 只有 `event consume` 走这条路：它的输出是「每行一个 JSON」，进程不会自己退出。
 */
export type CliConsume = (args: readonly string[], handlers: CliHandlers) => CliStream

/**
 * lark-cli 调用失败。
 *
 * `code` 是飞书错误信封里的数字码（`error.code`），`exitCode` 是进程退出码。两个都留：
 * 原生 CLI 的退出码恒为 1，真正能分辨「撤回 / 不是群成员 / 限流」的是飞书那个码。
 */
export class CliError extends Error {
  readonly code: number | undefined
  readonly exitCode: number | undefined

  constructor(message: string, code?: number, exitCode?: number) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
  }
}

/** 解析数组元素时统计被跳过的条数（照上游 `infra/commands.ts:42-48`，与 `adapters/github/api.ts:35-42` 同一实现）。 */
export interface Tally { skipped: number }

/**
 * 按单个 schema 解析数组，坏的跳过并计数。
 *
 * 跳过而不是整页报错：飞书历史里会混进读不懂的系统消息，一条不认识就把整页丢掉，症状是
 * 「那一页之后的聊天记录全没了」。
 */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap((value) => {
    const parsed = item.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
  if (tally) tally.skipped += list.length - items.length
  return items
}

/** 从一段文本里摸飞书信封的 `error`（CLI 失败时它写在 stderr 里，`infra/commands.ts:21-30`）。 */
function errorOf(text: string): { code?: number; message?: string } | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    const value: unknown = JSON.parse(text.slice(start))
    if (value === null || typeof value !== 'object') return undefined
    const error = (value as { error?: unknown }).error
    if (error === null || typeof error !== 'object') return undefined
    const record = error as { code?: unknown; message?: unknown }
    return {
      ...typeof record.code === 'number' ? { code: record.code } : {},
      ...typeof record.message === 'string' ? { message: record.message } : {},
    }
  } catch {
    // 诊断不是 JSON（代理页、CLI 直接打的人话）时交给下面的 HTTP 码与原文
    return undefined
  }
}

/** 群成员缺失（232011）换成一句能照做的话；其余错误原样往上抛（`infra/commands.ts:49-54`）。 */
function membership(error: CliError): CliError {
  if (error.code !== 232011) return error
  return new CliError('The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.',
    error.code, error.exitCode)
}

/** 非零退出码 → `CliError`。诊断只取前 2000 字，避免把整段日志塞进错误链（同 `infra/commands.ts:29`）。 */
function failure(result: CliResult): CliError {
  const stderr = result.stderr.trim()
  const envelope = errorOf(stderr)
  if (envelope?.message) {
    return membership(new CliError(`${envelope.message}${envelope.code ? ` (${envelope.code})` : ''}`, envelope.code, result.code))
  }
  const http = /\bHTTP (\d{3})\b/.exec(stderr)?.[1]
  const message = stderr.slice(0, 2000) || `lark-cli exited with code ${String(result.code)}`
  return membership(new CliError(message, http ? Number(http) : undefined, result.code))
}

/**
 * 跑一次 lark-cli 并交出信封里的 `data`。
 *
 * 两个判定照上游：退出码非零算失败；退出码为零但 `ok` 不是 `true` 也算失败
 * （`infra/commands.ts:108-111`）——飞书业务错误有时是「命令跑完了、结果是否定的」，
 * 只看退出码会把一次拒绝当成成功。
 *
 * @param run - 注入的 CLI 执行器
 * @param args - 不含 `--as bot --format json` 的参数；这两个由本函数统一补
 * @param cwd - 需要落文件的调用才传
 * @returns 信封里的 `data`（可能是 `undefined`）
 */
export async function lark(run: CliRun, args: readonly string[], cwd?: string): Promise<unknown> {
  const result = await run([...args, '--as', 'bot', '--format', 'json'], cwd)
  if (result.code !== 0) throw failure(result)
  const output = result.stdout.trim()
  if (output === '') throw new CliError('lark-cli printed no output', undefined, 0)
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new CliError(`lark-cli printed something other than JSON: ${output.slice(0, 300)}`, undefined, 0)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new CliError(`lark-cli printed something other than a result: ${output.slice(0, 300)}`, undefined, 0)
  }
  const envelope = parsed as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } }
  const code = typeof envelope.error?.code === 'number' ? envelope.error.code : undefined
  const message = typeof envelope.error?.message === 'string' ? envelope.error.message : undefined
  if (envelope.ok !== true) {
    throw membership(new CliError(`${message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code, 0))
  }
  return envelope.data
}
