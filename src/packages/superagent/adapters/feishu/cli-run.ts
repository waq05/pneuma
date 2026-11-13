/**
 * lark-cli 的两个注入端口的真实现：跑一次（`execFile`）与起常驻（`spawn` + 按行读）。
 *
 * 为什么单拉一个文件：`cli.ts` 只描述「要什么、怎么理解结果」，`loops.ts` 只写循环；
 * 真正碰子进程的只有这里。这样适配器其余部分在测试里传假函数就能离线跑，而真实现
 * 只有这一处需要关心 Windows 的 `.cmd`、超时、缓冲与进程树。
 *
 * **为什么超时是 90 秒**：一次 `lark` 调用要么是历史补收的一页（50 条消息，含富文本），
 * 要么是回一条消息。正常网络下都在几秒内回来，会拖到几十秒的只有代理抽风与飞书侧限流。
 * 取 90 秒的判据不是「等它慢慢好」，而是「再等也没有意义了」：补收一轮里每个群最多
 * 两次翻页，一次调用超过 90 秒，这一轮的历史窗口已经过期，继续等只会把泵上的下一拍
 * 一起拖住。超时后照样返回非零结果，由 `lark()` 翻成异常。
 *
 * **为什么非零退出是返回而不是抛**：适配器要靠退出码与飞书错误码分辨「这条消息永久
 * 回不了」（撤回 230011、2300xx 段带 not found、非群成员 232011）与「这次失败可以重试」
 * （限流、断网）。一旦把非零退出抛成异常，写消息那一层就只能从错误文本里猜，判据会
 * 退化成正则匹配（`channel.ts` 的 `gone()` 就是按数字码判的）。所以本文件只负责如实
 * 带回 `{ code, stdout, stderr }`，翻译成 `CliError` 是 `cli.ts` 里 `lark()` 的事。
 *
 * **为什么缓冲是 16 MiB**：`execFile` 缺省 1 MiB，而一页 50 条含长文/表格的消息很容易
 * 过 1 MiB；撞上以后 Node 直接杀子进程，症状是「历史读到一半整页消失」。16 MiB 是给
 * 一页历史留的上限：真超过这个数，说明这一页本身就不该整个塞进内存。
 *
 * **为什么 Windows 上不挂 `cmd.exe` 起 `.cmd`**：Node 不能直接 spawn `.cmd`（EINVAL），
 * 常规做法是 `shell: true` 再给参数逐个加引号。但 cmd 不认 `\"` 这种转义：回消息的正文
 * 里只要有一个双引号，后面的 `& echo ...` 就会被当成命令执行（本地实测复现），而回复
 * 正文来自聊天/模型，是外部输入。所以这里改成读 `.cmd` 里指向的 Node 脚本，直接
 * `node <script>` 起，参数经 CreateProcess 原样传递，不经过任何 shell。读不出入口就
 * 报一句人话、不启动——宁可这个来源不工作，也不把聊天内容拼进命令行。
 *
 * 机器人身份也放在这里：`auth status` 的输出是 CLI 的原文，解析它的形状属于「理解 CLI
 * 输出」这一层，不该让装配文件（`index.ts`）去碰。上游同一条路（`deployment.ts:108-130`）。
 *
 * @module dsc/packages/superagent/adapters/feishu/cli-run
 */
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { missingCommandReason, resolveExecutable } from '@pneuma/runtime/core/executable.js'
import type { CliConsume, CliHandlers, CliResult, CliRun, CliStream } from './cli.js'

/** 一次调用的上限（毫秒）；判据见文件头。 */
const RUN_TIMEOUT_MS = 90_000

/** 一次调用的 stdout 上限（字节）；判据见文件头。 */
const RUN_MAX_BUFFER = 16 * 1024 * 1024

/** 设置里留空时找 PATH 上的这个名字。 */
export const DEFAULT_FEISHU_CLI = 'lark-cli'

/** Windows 上需要解包成 `node <script>` 的包装脚本后缀。 */
const WINDOWS_SHIM = /\.(cmd|bat)$/i

/**
 * 一次启动的固定形状。
 *
 * `prefix` 是放在调用参数前面的固定参数：原生 CLI 为空；npm 包装脚本解包后是
 * `[<script>]`，`file` 换成 node。这样 `run` / `consume` 两处都只拼一次参数，
 * 不必各自判断「这次是不是 node 脚本」。
 */
interface Launch {
  /** 真正交给 `execFile` / `spawn` 的可执行文件。 */
  file: string
  /** 固定参数（`node <script>` 的 script 段）。 */
  prefix: string[]
  /** 只对这次启动追加的环境变量（Electron 跑 Node 脚本时要 `ELECTRON_RUN_AS_NODE`）。 */
  env: Record<string, string>
}

/** 两个注入端口的真实现。 */
export interface FeishuCli {
  run: CliRun
  consume: CliConsume
}

/**
 * CLI 的解析结果。
 *
 * 找不到（或包装脚本解不开）不是异常：来源是可选件，装配层拿到 `{ ok: false }` 只记一行
 * 日志就不启动（默认关的插件不该因为没装 CLI 往控制台刷栈）。
 */
export type FeishuCliResolution =
  | ({ ok: true } & FeishuCli)
  | { ok: false; reason: string }

/** 启动方案或一句不能启动的原因。 */
type LaunchResolution = { ok: true; launch: Launch } | { ok: false; problem: string }

/** 把未知异常压成一行。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 子进程的环境。
 *
 * 两个 `LARKSUITE_CLI_NO_*_NOTIFIER` 是必须的：CLI 的「有新版本」「有可用技能」提示会写进
 * stdout，`lark()` 解析 JSON 时会整条失败。上游在起 CLI 前也设了这两个（`deployment.ts:120`）。
 */
function childEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  }
}

/**
 * 从 npm 生成的 `.cmd` 包装脚本里找出它真正要跑的 Node 入口。
 *
 * 只认「带路径分隔符、以 .js / .cjs / .mjs 结尾」的片段：npm shim 里还有
 * `SET PATHEXT=%PATHEXT:;.JS;=;%` 这种不是路径的 `.JS`，不要求分隔符就会误命中。
 * 从后往前找：真正的入口在最后一行，前面的 `node.exe` 探测不是脚本。
 *
 * @param shim - `.cmd` / `.bat` 的绝对路径
 * @returns 能直接交给 node 的脚本路径；读不出来给 `null`
 */
function nodeScriptOf(shim: string): string | null {
  let body: string
  try {
    body = readFileSync(shim, 'utf8')
  } catch {
    return null
  }
  const dir = dirname(shim)
  // `%~dp0` / `%dp0%` 是「本文件所在目录」；换成真实目录后才能判断文件在不在。
  const expanded = body.replace(/%~dp0%?|%dp0%/gi, dir)
  // 先认带引号的路径：npm 的 shim 一定会给入口加引号，而 `C:\Program Files\...` 这种
  // 带空格的路径只有按整段引号取才不会被空格截断。再去认不带引号的写法兜底。
  const candidates: string[] = []
  for (const match of expanded.matchAll(/"([^"\r\n]+\.(?:c?js|mjs))"/gi)) candidates.push(match[1]!)
  for (const match of expanded.matchAll(/[^\s"'()=<>|&^]*[\\/][^\s"'()=<>|&^]*\.(?:c?js|mjs)\b/gi)) {
    candidates.push(match[0])
  }
  for (const candidate of candidates.reverse()) {
    const path = isAbsolute(candidate) ? candidate : resolve(dir, candidate)
    if (existsSync(path)) return path
  }
  return null
}

/** 用 node 跑一个脚本；PATH 上没有 node 时退回当前进程（桌面端宿主是 Electron 时要置标志）。 */
function nodeLaunch(script: string): Launch {
  const node = resolveExecutable('node', childEnv(), process.cwd())
  if (node.found && !WINDOWS_SHIM.test(node.file)) return { file: node.file, prefix: [script], env: {} }
  // 退回当前进程时可能是 Electron（桌面端宿主的 execPath 就是 electron.exe）：
  // 不显式置 ELECTRON_RUN_AS_NODE 它会当图形程序启动，脚本一行都跑不到（同 `core/plugin-npm.ts:230-239`）。
  const env: Record<string, string> = process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }
  return { file: process.execPath, prefix: [script], env }
}

/**
 * 把设置里那条命令解析成「能安全传参的启动方案」。
 *
 * 三种情况：
 *   - 原生可执行文件（Windows 的 `.exe`、POSIX 带 shebang 的脚本）：直接起；
 *   - Windows 的 `.cmd` / `.bat`：解包成 `node <script>`，理由见文件头；
 *   - 找不到，或包装脚本里读不出 Node 入口：给一句能照做的原因，不启动。
 */
function launchOf(name: string, env: Record<string, string | undefined>): LaunchResolution {
  const target = resolveExecutable(name, env, process.cwd())
  if (!target.found) return { ok: false, problem: missingCommandReason(name, env) }
  if (process.platform === 'win32' && WINDOWS_SHIM.test(target.file)) {
    const script = nodeScriptOf(target.file)
    if (script === null) {
      return {
        ok: false,
        problem: `lark-cli 是 .cmd 包装脚本（${target.file}），里面找不到 Node 入口；`
          + 'Windows 上请把「lark-cli 路径」指向原生可执行文件，或重装成带 Node 入口的版本',
      }
    }
    return { ok: true, launch: nodeLaunch(script) }
  }
  return { ok: true, launch: { file: target.file, prefix: [], env: {} } }
}

/** 一次调用的结局：非零退出原样带回，超时与缓冲超限各补一句人能读的原因。 */
function resultOf(error: Error | null, stdout: string, stderr: string): CliResult {
  if (error === null) return { code: 0, stdout, stderr }
  const record = error as Error & { code?: unknown; killed?: boolean }
  const raw = record.code
  if (raw === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return {
      code: 1,
      stdout: '',
      stderr: `${stderr}\nlark-cli 的输出超过 ${String(RUN_MAX_BUFFER / 1024 / 1024)} MiB，已中止`,
    }
  }
  const code = typeof raw === 'number' ? raw : 1
  const note = record.killed === true ? `\nlark-cli 超过 ${String(RUN_TIMEOUT_MS / 1000)} 秒没结束，已中止` : ''
  return { code, stdout, stderr: `${stderr}${note}` }
}

/** 跑一次 CLI：等它结束，把退出码与两路输出原样交回。 */
function execOnce(launch: Launch, args: readonly string[], cwd?: string): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const done = (error: Error | null, stdout: string, stderr: string): void => {
      resolvePromise(resultOf(error, stdout, stderr))
    }
    try {
      execFile(launch.file, [...launch.prefix, ...args], {
        ...cwd === undefined ? {} : { cwd },
        env: { ...childEnv(), ...launch.env },
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: RUN_MAX_BUFFER,
        windowsHide: true,
      }, done)
    } catch (error) {
      // 起不来时 execFile 会同步抛：按一次失败返回，别让调用方收到未处理的异常。
      resolvePromise({ code: 1, stdout: '', stderr: errorText(error) })
    }
  })
}

/**
 * 起一条常驻 CLI。
 *
 * 与一次调用的差别只有三处：不设超时（它本来就该一直跑）、输出按行喂 handlers、`stop()`
 * 由调用方主动收。stdout 与 stderr 分开读，因为事件与诊断的处理方式不同（`loops.ts` 靠
 * stderr 里的 `[event] ready` 判连上）。
 */
function streamOnce(launch: Launch, args: readonly string[], handlers: CliHandlers): CliStream {
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(launch.file, [...launch.prefix, ...args], {
      env: { ...childEnv(), ...launch.env },
      windowsHide: true,
      stdio: 'pipe',
    })
  } catch (error) {
    // 与 execOnce 同理：起不来就当场报，调用方（`loops.ts` 的 consumeOnce）会按一次失败收尾。
    throw new Error(`lark-cli 起不来：${errorText(error)}`)
  }
  const out = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
  const err = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY })
  out.on('line', (line) => { handlers.stdout(line) })
  err.on('line', (line) => { handlers.stderr(line) })

  let settled = false
  let stopped = false
  let finish!: (value: CliResult) => void
  const done = new Promise<CliResult>((resolvePromise) => {
    finish = resolvePromise
  })

  /** 只收一次尾：`error` 与 `close` 哪个先到都算结束。 */
  const settle = (code: number): void => {
    if (settled) return
    settled = true
    out.close()
    err.close()
    // 常驻进程的两路输出已经逐行喂给调用方了，这里不再复制一份；`CliResult` 的形状要求
    // 两个字符串字段，给空串即可（`loops.ts` 只看 code）。
    finish({ code, stdout: '', stderr: '' })
  }

  child.on('error', (error) => {
    // 起不来（ENOENT / EACCES）：把原因当一行 stderr 交出去，`loops.ts` 的 45 秒 ready
    // 超时之外还能留下具体一句话。
    handlers.stderr(`[lark-cli] ${error.message}`)
    settle(1)
  })
  child.on('close', (code) => {
    settle(code ?? 1)
  })

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      // 先关 stdin：这是 `event consume` 认的「请你收工」。
      child.stdin.end()
      // Windows 上 node 可能不是直接子进程（桌面端宿主 / 包了一层 node.exe 时），
      // `child.kill()` 只收直接子进程，脚本会留下继续收消息——正是设计文档 §1.1 禁止的。
      // 按进程树收一次，且必须在直接子进程还活着时收（父进程一死，taskkill /T 就找不到树）。
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
      try {
        child.kill('SIGTERM')
      } catch {
        // 已经退出的进程再 kill 会抛，无害。
      }
    },
    done,
  }
}

/**
 * 解析设置里那条 CLI。
 *
 * 留空 = PATH 上的 `lark-cli`；填了路径就按路径找。解析用内核那一份（`core/executable.ts`）：
 * Windows 上「带后缀的排前面、无后缀兜底」的候选顺序，全仓库只有它一份，各写各的迟早
 * 出现「设置页说装了、实际起不来」。
 *
 * @param command - 设置里的 `feishuCli`；空串表示走 PATH
 */
export function resolveFeishuCli(command: string): FeishuCliResolution {
  const name = command.trim() === '' ? DEFAULT_FEISHU_CLI : command.trim()
  const plan = launchOf(name, childEnv())
  if (!plan.ok) return { ok: false, reason: plan.problem }
  const launch = plan.launch
  return {
    ok: true,
    run: (args, cwd) => execOnce(launch, args, cwd),
    consume: (args, handlers) => streamOnce(launch, args, handlers),
  }
}

/** `auth status` 里本适配器要的两样：应用 id，以及机器人身份就绪没有。 */
const AuthStatus = z.object({
  appId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
  identities: z.object({ bot: z.object({ status: z.string() }) }),
})

/** `bot/v3/info` 顶层的 `bot`：机器人的 open_id（跳过自己发的消息要用）。 */
const BotInfo = z.object({
  bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }),
})

/** 从一段可能带人话前缀的输出里抠出 JSON，再按 schema 收形状。 */
function parsed<T>(schema: z.ZodType<T>, text: string): T {
  const start = text.indexOf('{')
  if (start < 0) throw new Error(`lark-cli 没打出 JSON：${text.trim().slice(0, 200) || '没有输出'}`)
  let value: unknown
  try {
    value = JSON.parse(text.slice(start))
  } catch {
    throw new Error(`lark-cli 打出的不是合法 JSON：${text.slice(start, start + 200)}`)
  }
  const result = schema.safeParse(value)
  if (!result.success) throw new Error(`lark-cli 的输出形状不认识：${result.error.message.slice(0, 300)}`)
  return result.data
}

/**
 * 问 CLI「你是谁」。
 *
 * 两次调用各有各的理由：`auth status` 给 `appId` 与机器人身份状态，`bot/v3/info` 给
 * 机器人的 `open_id`——后者用来跳过它自己发的消息（`feishuTrigger` 的两种 id 之一）。
 * `bot/v3/info` 用 `ndjson` 而不是 `json`：`--format json` 只拆信封里的 `data`，这个接口
 * 把 `bot` 放在顶层，拆完就什么都不剩（上游 `deployment.ts:127-128` 记过这个坑）。
 *
 * 上游还查一次 `config strict-mode`（只允许 `bot` 身份）。本适配器的每一条命令都由
 * `lark()` 统一补 `--as bot`，不以用户身份动作，所以没搬这一步；这是刻意取舍，不是漏。
 *
 * @param run - 已经绑定好 CLI 路径的执行器
 * @returns 机器人自己的两种 id
 */
export async function readFeishuBot(run: CliRun): Promise<{ id: string; appId: string }> {
  const status = await run(['auth', 'status'])
  if (status.code !== 0) {
    throw new Error(`lark-cli auth status 退出码 ${String(status.code)}：${status.stderr.trim().slice(0, 300) || '没有输出'}`)
  }
  const auth = parsed(AuthStatus, status.stdout)
  if (auth.identities.bot.status !== 'ready') {
    throw new Error(`飞书机器人身份没就绪（${auth.identities.bot.status}）；在终端里跑一次 lark-cli auth login`)
  }
  const info = await run(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'])
  if (info.code !== 0) {
    throw new Error(`读机器人信息失败（退出码 ${String(info.code)}）：${info.stderr.trim().slice(0, 300) || '没有输出'}`)
  }
  const line = info.stdout.split('\n').map((row) => row.trim()).find((row) => row.startsWith('{'))
  if (line === undefined) throw new Error('lark-cli bot/v3/info 没有打出 JSON')
  const bot = parsed(BotInfo, line)
  return { id: bot.bot.open_id, appId: auth.appId }
}
