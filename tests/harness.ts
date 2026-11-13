/**
 * 测试公共设施：临时 HOME、假 LLM 端点、录制回放、真内核、会话日志读取、真入口 CLI、golden。
 *
 * ## 为什么集中在一个文件，而不是每个 spec 各写一份
 *
 * 这七件事每个都踩过一次坑，而且是同一种坑：**忘了做隔离或忘了等落盘**。
 * 临时 HOME 少改一个环境变量，测试就往开发者真实的 `~/.dsc` 里写会话；假端点少发
 * 一个 `[DONE]`，真内核的流读永远不结束；起完真内核不 dispose，vitest 进程不退出。
 * 这些坑分散复制到几十个 spec 里，修复一次要改几十处，漏一处就是一条只在 Windows 上红、
 * 或在 CI 上挂十分钟的用例。收在一处后，上面每一条都只有一份实现。
 *
 * ## 边界
 *
 * 这里只提供「怎么起、怎么抓、怎么收」的机械能力，不写任何断言口味：
 * 期望什么请求体、会话里该有什么，由各 spec 自己判断。唯一的例外是 `expectGolden`——
 * 它本身就是一条断言封装（比对 + 差异输出），调用方要的正是那个失败输出。
 *
 * ## 失败模式的总原则
 *
 * 参数错、环境不隔离、录制文件坏了，全部**当场抛可读的错**。这些函数服务于测试，
 * 「静默降级」在这里等价于「让一条本该红的用例变绿」，比直接红更贵。
 *
 * @module dsc/tests/harness
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DscCoreConfig } from '@pneuma/runtime/core/config.js'

/** `tests/harness.ts` 所在目录与仓库根：golden、CLI 入口都从仓库根定位。 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const GOLDEN_DIR = join(REPO_ROOT, 'tests', 'snapshots', 'golden')
const CLI_ENTRY = join(REPO_ROOT, 'bin', 'dsc.js')

/**
 * 会话标题请求的默认特征串。
 *
 * 抄自 `scripts/todo-reminder-test.mjs:183-185` 的真实抓包：会话标题插件把
 * `TITLE_PROMPT`（`src/packages/session-title/index.ts:30`）作为 system 消息发一次。
 * 这类请求不是对话轮次，必须单独应答，否则它会吃掉一轮假模型的剧本，
 * 后面所有轮次错位——断言看起来「随机」失败。
 */
const TITLE_PROMPT_NEEDLE = '会话标题生成器'
/** 标题请求的应答正文：只要非空，标题插件就会把它 trim 成标题。 */
const TITLE_REPLY = '测试会话标题'
/** `runTurn` 等一轮结束的上限；比 integration 单条 60s 预算短，保证先给出可读错误。 */
const RUN_TURN_TIMEOUT_MS = 30_000
/** 一轮结束后等写流落盘的兜底延时，与 `scripts/todo-reminder-test.mjs:249` 同口径。 */
const SETTLE_AFTER_TURN_MS = 80

/** 临时目录/主目录的路径判定：后者在前者里面才算隔离。 */
function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 把任意抛出物转成可读文本：日志里被 `[object Object]` 盖住是最常见的排障损失。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 循环等一个条件成立；超时返回 false，由调用方决定报什么错。 */
async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/** 路径里的正则元字符转义：Windows 临时目录带 `\`，直接塞进 RegExp 会变成转义序列。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 6.1 tempHome ─────────────────────────────────────────────────────────────

/**
 * 建一个临时主目录，并把 `HOME` / `USERPROFILE` 指过去。
 *
 * ## 为什么两个环境变量都改
 *
 * `os.homedir()` 在 POSIX 认 `HOME`、在 Windows 认 `USERPROFILE`。只改一个，另一半平台上
 * 隔离就是空的——而这种漏法在 Linux CI 上永远看不出来（CI 只有 Linux 时，Windows 那条
 * 路径根本没人跑）。两个都改，漏改一个就会在另一个平台上立刻暴露。
 *
 * ## 为什么 `restore` 还原成原值，而不是删掉目录或设成空串
 *
 * 设成空串等于换了一个「空主目录」，`homedir()` 会退到 `/` 或 `C:\Windows` 这类更糟的
 * 位置；删目录则会毁掉失败现场。还原成调用前的值，才是「我借用了一下，还给你」。
 * 临时目录本身**刻意不删**：红了要留着看会话日志与 `.lock`，那正是排查的入口。
 *
 * ## 失败模式
 *
 * `mkdtempSync` 建不出来就让它抛。吞掉的话，后续用例会落到真实主目录——这恰好是本函数
 * 要防的事故，而且事故现场在测试结果里看不出来（用例照样绿）。前缀带路径分隔符同样直接
 * 拒绝：`tempHome('../x')` 会把目录建到临时目录外面，把「隔离」这个前提悄悄毁掉。
 */
export function tempHome(prefix = 'dsc-test-'): { home: string; restore: () => void } {
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new TypeError('tempHome：prefix 必须是非空字符串')
  }
  if (prefix.includes('/') || prefix.includes('\\') || prefix.includes('..')) {
    throw new Error(`tempHome：prefix 不能包含路径分隔符或 ".."（收到 ${JSON.stringify(prefix)}）`)
  }
  // 先记住原值：restore 要还成「原来是什么」，包括「原来根本没设」。
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  // 不 try/catch：建不出来就让调用方看到原始错误，而不是带着未隔离的环境继续跑。
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.HOME = home
  process.env.USERPROFILE = home
  let restored = false
  const restore = (): void => {
    // 幂等：`afterEach(h.restore)` 与 `afterAll(h.restore)` 同时注册是常见写法，
    // 第二次调用不能再把环境改成「还原后的值」以外的东西。
    if (restored) return
    restored = true
    if (original.HOME === undefined) delete process.env.HOME
    else process.env.HOME = original.HOME
    if (original.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = original.USERPROFILE
  }
  return { home, restore }
}

// ── 6.5 readSessionJsonl ─────────────────────────────────────────────────────

/**
 * 读一份会话 jsonl 成对象数组。
 *
 * ## 为什么坏行丢掉、而文件读不到就抛
 *
 * 会话日志是**运行时产物**，不是夹具：进程被杀时最后一行只写了半截是正常事故形态，
 * 一条坏行不该让「读日志」这件事整体失败（现有探针 `scripts/todo-reminder-test.mjs:279-288`
 * 也是这么剥的）。但路径不存在是另一回事——那说明调用方拿错了路径，返回空数组会让
 * 「日志里没有 X」这类断言恒真，变成假绿。
 *
 * 空行跳过；解析出来不是对象的（数组、数字、null）同样跳过：调用方拿到的每一项都能
 * 直接按字段读，不必每处再判一次类型。
 */
export function readSessionJsonl(path: string): Array<Record<string, unknown>> {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError('readSessionJsonl：path 必须是非空字符串')
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`readSessionJsonl：读不到会话文件 ${path}（${errorText(error)}）`)
  }
  // BOM 会让第一行的 JSON.parse 必失败，然后被当成坏行丢掉——第一条记录静默消失。
  const text = raw.replace(/^\uFEFF/, '')
  const records: Array<Record<string, unknown>> = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    records.push(value as Record<string, unknown>)
  }
  return records
}

