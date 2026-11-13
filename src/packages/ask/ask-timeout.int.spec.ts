/**
 * 提问卡的等待时限（迁自 `scripts/ask-timeout-test.mjs`）。
 *
 * 2026-10-29 报障：`ask_user` 超时后用户再答，对话不动。钉两件事：
 *
 *   ① **等人的时间不算 PTC 脚本的时间**：脚本里 `await sdk.ask_user(...)` 挂起超过脚本时限，
 *      脚本仍然活着；用户答完后脚本拿到答案正常返回（以前 120 秒先把脚本掐死，答案回来
 *      没人接，正文里只留一句「脚本跑了超过 120 秒」）。
 *   ② **提问卡有自己的等待时限**（配置 `ask.waitMs`，默认 15 分钟、夹在 10 秒~1 小时）：
 *      等满了自己收尾——卡片撤掉、模型拿到「用户没有回答」的实话，接着往下走。
 *
 * ## 为什么① 必须真等 33 秒（这条慢）
 *
 * PTC 的脚本时限可调，但下界被 `PTC_DEADLINE_RANGE` 钉在 30 秒（低于它连装个依赖都不够）。
 * 要证明「等人不计时」，就必须让一次真实等待**跨过这个 30 秒**：把 `ptc.deadlineMs`
 * 压到下限 30 秒、提问卡的 `ask.waitMs` 给到 60 秒，挂起 33 秒后仍未见脚本收尾，再作答。
 * 这条没有更短的等价接缝（`createDeadline` 是 ptc 插件里的私有函数，单测够不着），
 * 所以它单独吃一条慢用例，按名字可以分片挑出去跑（P6）。
 *
 * ## 为什么用两只内核，而且是一前一后
 *
 * ①要知道 `ask.waitMs` > 时限（60 秒），②③要验下限夹取（配置写 1 秒 → 对外读数 10 秒）。
 * 两份配置不能同时存在：`readWaitMs` 每次挂卡都**现读磁盘**（这是它的设计：改配置不用
 * 重启宿主），两只内核并存时先起的那只会读到后写的那份，②的卡会按 60 秒等。
 * 所以先跑完①②③，收掉内核，再换配置起 ④ 那只。
 *
 * @module @pneuma/ask/ask-timeout.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 这一跑的 `~/.dsc`（integration 层已把 HOME 换到临时目录）。 */
const DSC_HOME = process.env['DSC_HOME'] ?? join(homedir(), '.dsc')
/** 工作目录：提问卡不需要真文件，但会话得有个落点。 */
const WORK = join(DSC_HOME, '..', 'ask-ws')

/** 提问卡的视图（只声明断言用到的字段）。 */
interface AskView {
  question: string
  questions?: AskQuestionItem[]
}

interface AskQuestionItem {
  question: string
  options: Array<{ label: string }>
  multiSelect: boolean
  allowFreeText: boolean
}

/** 工具条目里这一批用到的字段。 */
interface ToolView {
  name: string
  description: string
  waitsForHuman?: boolean
  run(args: Record<string, unknown>, ctx: RunCtx): Promise<unknown>
}

interface RunCtx {
  cwd: string
  signal: AbortSignal
  sessionId: string
  sessionPath: string
}

/** 内核里这一批用到的服务面。 */
interface Surface {
  ask: {
    pendingQuestion(): AskView | null
    askMany(input: readonly AskQuestionItem[], signal: AbortSignal): Promise<string[]>
    answerQuestion(answer: string): void
  }
  tools: { list(): ToolView[] }
  session: { current(): { meta: { id: string; cwd: string }; filePath: string } }
}

/** 一只起好的内核（连同它的假端点）。 */
interface Rig {
  kernel: BootedKernel
  ctx: Surface
  llm: FakeLLM
}

/** 两只内核统一收在 afterAll：一条失败也不把句柄留在进程里。 */
const rigs: Rig[] = []

/** 铺一份 plugins.json：沙箱/记忆/标题一律关掉，只留这一组要验的配置。 */
function writePlugins(extra: Array<Record<string, unknown>>): void {
  mkdirSync(DSC_HOME, { recursive: true })
  const entries = [
    // 沙箱关：它在 Windows 启动时要 spawn PowerShell 体检，会让测试 worker 挂住（台账 D16）。
    { file: 'sandbox', disabled: true },
    { file: 'memory', config: { enabled: false } },
    // 标题插件会在回合之间多发一次模型请求，把剧本与等待时序搅乱。
    { file: 'session-title', disabled: true },
    ...extra,
  ]
  writeFileSync(join(DSC_HOME, 'plugins.json'), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
}

/** 起一只内核（假端点只做占位：这一批不跑真回合）。 */
async function boot(extra: Array<Record<string, unknown>>): Promise<Rig> {
  writePlugins(extra)
  const llm = await fakeLLM({ turns: ['收到'] })
  const kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  const rig: Rig = { kernel, ctx: kernel.ctx as unknown as Surface, llm }
  rigs.push(rig)
  return rig
}

/** 等条件成立；超时返回 false（不抛，由断言给出现场）。 */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/** 按工具名取条目（找不到时把已有的名字报出来）。 */
function toolOf(rig: Rig, name: string): ToolView {
  const found = rig.ctx.tools.list().find((entry) => entry.name === name)
  if (found === undefined) {
    throw new Error(`工具目录里没有 ${name}，只有 ${rig.ctx.tools.list().map((entry) => entry.name).join('、')}`)
  }
  return found
}

/** 这次工具调用的运行身份（cwd 与会话都从当前会话取）。 */
function runCtx(rig: Rig): RunCtx {
  const current = rig.ctx.session.current()
  return {
    cwd: current.meta.cwd,
    signal: new AbortController().signal,
    sessionId: current.meta.id,
    sessionPath: current.filePath,
  }
}

/** `run_code` 的回包可能是字符串，也可能是 `{ text }` 对象：统一取正文。 */
function asText(result: unknown): string {
  return typeof result === 'string' ? result : String((result as { text?: unknown } | null)?.text ?? '')
}

/** 一批只有一题的提问（题干随意，断言只看答案与卡的状态）。 */
const ONE_QUESTION: AskQuestionItem[] = [
  { question: '选哪个', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowFreeText: true },
]

let fast: Rig
let slow: Rig

beforeAll(async () => {
  mkdirSync(WORK, { recursive: true })
  // ① 下限夹取那一侧：配置写 1 秒，对外读数应是 10 秒（同时也是②③的现场）。
  fast = await boot([{ file: 'ask', config: { waitMs: 1_000 } }])
})

afterAll(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.kernel.dispose()
    await rig.llm.close()
  }
})

/** 收掉一只内核并从待收清单里摘掉（④要在它之前换成慢配置）。 */
async function disposeRig(rig: Rig): Promise<void> {
  rigs.splice(rigs.indexOf(rig), 1)
  await rig.kernel.dispose()
  await rig.llm.close()
}

describe('① 等待时限来自 ask.waitMs，且夹在 10 秒~1 小时', () => {
  test('工具描述里写的是夹过之后的读数（配置 1 秒 → 10 秒）', () => {
    expect(toolOf(fast, 'ask_user').description).toContain('10 秒')
  })

  test('描述里点明了「没回答」不是用户说的话（模型不该把它当答案）', () => {
    expect(toolOf(fast, 'ask_user').description).toContain('不是用户说的话')
  })

  test('ask_user 声明了自己是在等人（PTC 靠这一位停表）', () => {
    expect(toolOf(fast, 'ask_user').waitsForHuman).toBe(true)
  })
})

describe('② 等满时限：卡片撤掉，模型拿到「没回答」的实话', () => {
  test('等满 10 秒才收尾，答案写清等了多久，卡片不留幽灵', async () => {
    const startedAt = Date.now()
    const pending = fast.ctx.ask.askMany(ONE_QUESTION, new AbortController().signal)
    expect(await until(() => fast.ctx.ask.pendingQuestion() !== null)).toBe(true)
    const answers = await pending
    const waited = Date.now() - startedAt
    // 下限 10 秒生效：配置写 1 秒，实际等的是夹过之后的 10 秒。
    expect(waited).toBeGreaterThanOrEqual(9_500)
    expect(waited).toBeLessThan(15_000)
    expect(answers[0]).toContain('用户没有回答')
    expect(answers[0]).toContain('10 秒')
    expect(fast.ctx.ask.pendingQuestion()).toBeNull()
  }, 30_000)
})

describe('③ 时限内作答：照旧一次交回，卡片撤掉', () => {
  test('拿到用户的答案，收尾之后没有二次收尾', async () => {
    const pending = fast.ctx.ask.askMany(ONE_QUESTION, new AbortController().signal)
    expect(await until(() => fast.ctx.ask.pendingQuestion() !== null)).toBe(true)
    fast.ctx.ask.answerQuestion('B')
    const answers = await pending
    expect(answers[0]).toBe('B')
    // 若计时器没撤掉，这半秒里会出现二次收尾（卡片已经没了却还被 settle 一次）。
    await new Promise((resolveTick) => setTimeout(resolveTick, 500))
    expect(fast.ctx.ask.pendingQuestion()).toBeNull()
  })
})

describe('④ 慢 ~33s：脚本里等提问卡，等人的时间不算脚本时限', () => {
  beforeAll(async () => {
    // 换配置：提问卡等 60 秒（> 脚本时限），脚本时限压到下限 30 秒。
    //
    // ## 为什么必须先收掉上一只内核再换 plugins.json
    //
    // `readWaitMs` 每次挂卡都现读磁盘（改配置不用重启宿主），所以两只内核并存时，
    // 先起的那只也会读到后写的那份配置——②那条卡会按 60 秒等，直接超时。串行切换
    // 才是这里唯一安全的做法。
    await disposeRig(fast)
    slow = await boot([
      { file: 'ask', config: { waitMs: 60_000 } },
      { file: 'ptc', config: { deadlineMs: 30_000 } },
    ])
  })

  test('挂起 33 秒（脚本时限 30 秒）脚本仍活着；作答后拿到答案、不被掐断', async () => {
    const runCode = toolOf(slow, 'run_code')
    const running = runCode.run(
      { code: "const a = await sdk.ask_user({ questions: [{ question: '选哪个' }] }); return a" },
      runCtx(slow),
    )
    // 收尾标记：一旦 run_code 落地（正常或超时），这里就翻成 done。
    let settled = false
    running.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    expect(await until(() => slow.ctx.ask.pendingQuestion() !== null), '提问卡应当挂起来').toBe(true)

    // 故意等过 30 秒的脚本时限：停表生效的话脚本仍在跑；没停表则这里会提前落地。
    const deadlineAt = Date.now() + 33_000
    while (Date.now() < deadlineAt && !settled) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 100))
    }
    expect(settled, '33 秒时 run_code 已经收尾：说明等人的时间被算进了脚本时限').toBe(false)
    // 作答前先确认卡还挂着：卡片没了还硬答，等的是「promise 永远不落地」，红得没有信息量。
    expect(slow.ctx.ask.pendingQuestion(), '33 秒后提问卡应当还挂着（它自己的时限是 60 秒）').not.toBeNull()

    slow.ctx.ask.answerQuestion('我选 B')
    const text = asText(await running)
    expect(text).toContain('我选 B')
    expect(text).not.toContain('被掐断')
    expect(slow.ctx.ask.pendingQuestion()).toBeNull()
  }, 60_000)
})

describe('⑤ 慢 ~30s：不等人时，脚本自己拖时间照样被掐断（④ 的反向对照）', () => {
  test('脚本里连睡跨过 30 秒时限 → 被掐断（停表不是把时限关了）', async () => {
    const runCode = toolOf(slow, 'run_code')
    // 沙箱里的 `sleep` 单次封顶 5 秒（`packages/ptc/index.ts` 的 sandbox），所以连睡 8 次
    // 才凑得够 40 秒——中途不该有任何人等，脚本时限应当照常走到 30 秒并掐断。
    const text = asText(
      await runCode.run({ code: 'for (let i = 0; i < 8; i += 1) { await sleep(5_000) }\nreturn "ok"' }, runCtx(slow)),
    )
    expect(text).toContain('被掐断')
    expect(text).not.toContain('返回值：\nok')
  }, 60_000)
})
