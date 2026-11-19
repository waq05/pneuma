/**
 * 「开子代理就卡」的端到端验收（迁自 `scripts/tui-subagent-live-test.mjs`）：
 * **真内核 + 假端点 + 真队友 + 真 App**。
 *
 * 与 snapshot 合并器探针（假 runtime 灌通知）的区别：这里跑真链路——用户发言 → 主回合调
 * `subagent` 工具 → subagent 插件派真队友 → 队友流式输出（每口都走
 * `forwardSubagent → transcript.emit → invalidate`）→ App 真的在渲染。量的就是用户体感的
 * 那件事：**队友打字期间，界面每秒重排几次**。
 *
 * ## 时序断言的迁移口径
 *
 * 探针的固定 2.5s 量窗换成轮询：从「子代理卡出现」开始清零计数，每 100ms 一拍读帧并记录
 * peak，直到队友流写完（帧里出现「队友第 240 行」）或超时——窗口就是队友流的真实时长，
 * 慢机器上窗口自动变长，断言的「每秒」语义不变。其余等待（等卡片、等流结束）也全部轮询
 * 到条件成立，不留固定 sleep。
 *
 * ## 端点为什么不走 harness 的 fakeLLM
 *
 * fakeLLM 的应答是一次性写完的整段 SSE；这条探针的病根恰恰是**很多口小增量**（240 口、
 * 每口 1ms）把界面压卡的洪峰。量提交率必须有「一口一口写」的接缝，所以照探针自建
 * `node:http` 端点（端口 listen(0) 随机、只绑 127.0.0.1）。SSE 帧形状与 fakeLLM 同源
 * （正文增量 → finish_reason → usage → `[DONE]`）。
 *
 * ## 双平面（D25）
 *
 * `bootKernel` 起的是混合平面：宿主（含 tui 的 App）来自 `src`，插件来自 `lib`。改了
 * `src` 必须先 `pnpm run build` 才能跑本文件（内核跑旧 lib 会假绿）。本文件自己的渲染断言
 * 读的是 src 侧 App——反向验证改 App 文案不需要 build 就能看到红，但改完仍要 build，
 * 因为 lib 比 src 旧会让 `bootKernel` 的新鲜度守卫把别的用例拦下来。
 *
 * ## 隔离
 *
 * 临时 HOME + 假端点，真实 `~/.dsc` 一个字节都不动。`plugins.json` 由本文件先写
 * （bootKernel 只在文件不存在时写默认清单）：subagent 打开 `allowDelegation`
 * （不打开连 subagent 工具都不在场），memory 关（回合结束不发机器通知），session-title
 * 照探针保持打开——端点单独应答标题请求。
 *
 * 归 `tui` project（`src/packages/tui/**` + node + 假 stdin/stdout）。
 *
 * @module dsc/packages/tui/app/subagent-live.spec
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createElement, Profiler } from 'react'
import { render } from 'ink'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DscRuntime } from '@pneuma/runtime/contract.js'
import { bootKernel, tempHome, type BootedKernel } from '../../../../tests/harness.js'

/**
 * `runCommand` 只能动态 import（下面的 beforeAll 里），不能写成顶层静态 import。
 *
 * 原因：它会拉进 `@pneuma/runtime/core/plugin-registry.js`，而 `core/path-policy.ts:20`
 * 在**模块加载那一刻**就把 `DSC_HOME` 定死、`core/plugin-registry.ts:192` 跟着把
 * `PLUGINS_JSON` 定死。静态 import 在本文件顶层的 `process.env.DSC_HOME = <临时目录>`
 * 之前执行，内核于是去读真实的 `~/.dsc/plugins.json`：那里没有本文件写的那份清单，
 * `subagent`（`defaultDisabled`）就被当成关着，`subagent`/`team_message`/`team_task`
 * 一个都不挂——模型调用报「未知工具：subagent」，卡片永远不出现。
 * 同一条规矩 `composer.spec.ts` 文件头也写着：换 DSC_HOME 必须在模块被加载之前。
 */
type RunCommand = typeof import('../../commands/index.js').runCommand

/** 临时主目录：内核的会话、配置、插件清单全落这里（真实 `~/.dsc` 不动）。 */
const home = tempHome('dsc-subagent-live-')
const originalDscHome = process.env.DSC_HOME
process.env.DSC_HOME = join(home.home, '.dsc')

mkdirSync(join(home.home, '.dsc'), { recursive: true })
// 先写清单再 bootKernel（只在不存在的文件上写默认）：subagent 开派活、memory 关。
writeFileSync(
  join(home.home, '.dsc', 'plugins.json'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        { file: 'subagent', disabled: false, config: { allowDelegation: true, notify: 'quiet' } },
        { file: 'memory', config: { enabled: false } },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

const sleep = (ms: number): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

// ── 假端点 ──────────────────────────────────────────────────────────────────

const sseText = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
const sseToolCall = (id: string, name: string, args: unknown): string =>
  `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  })}\n\n`
const sseEnd = (): string =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n` +
  'data: [DONE]\n\n'

/** 队友那条流：很多口增量（模拟「打字」的洪峰）。 */
const TEAMMATE_CHUNKS = 240

const server: Server = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk: Buffer) => {
    body += String(chunk)
  })
  request.on('end', () => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const isTeammate = body.includes('你在团队里的位置')
    const isTitle = body.includes('给这段对话起一个短标题')
    if (isTitle) {
      response.end(sseText('子代理性能探针') + sseEnd())
      return
    }
    if (isTeammate) {
      // 每口一行，200+ 口：这就是让界面卡的那个洪峰
      let index = 0
      const push = (): void => {
        if (index >= TEAMMATE_CHUNKS) {
          response.end(sseEnd())
          return
        }
        index += 1
        response.write(sseText(`队友第 ${index} 行进来了。\n`))
        setTimeout(push, 1)
      }
      push()
      return
    }
    if (body.includes('"tool"') || body.includes('tool_result')) {
      response.end(sseText('收到结论了。') + sseEnd())
      return
    }
    // 主回合：派一个后台队友
    response.end(
      sseToolCall('call-1', 'subagent', {
        action: 'spawn',
        role: 'explorer',
        task: '把这一串输出逐行打出来，最后给一句结论。',
        background: true,
      }) + sseEnd(),
    )
  })
})

// ── 内核与 App ───────────────────────────────────────────────────────────────

let kernel: BootedKernel
let baseUrl = ''

const stdin = new PassThrough() as PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}
const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
stdout.columns = 110
stdout.rows = 40
stdout.isTTY = false
let output = ''
stdout.on('data', (chunk: Buffer) => {
  output += String(chunk)
})

/** React 提交计数（Profiler onRender）。 */
let commits = 0
let unmountApp: (() => void) | null = null

beforeAll(async () => {
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('假端点 listen 后拿不到端口')
  baseUrl = `http://127.0.0.1:${address.port}`

  kernel = await bootKernel({
    providerBaseUrl: baseUrl,
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl,
          apiKey: 'k',
          models: [
            {
              id: 'm',
              name: 'm',
              contextWindow: 100000,
              maxTokens: 500,
              modalities: ['text'],
              thinkingLevels: [],
              thinkingParam: 'none',
              effortMap: {},
            },
          ],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm',
    },
    resumeSessionPath: null,
  })

  const { App } = await import('./App.js')
  const { runCommand }: { runCommand: RunCommand } = await import('../../commands/index.js')
  const runtime = (kernel.ctx as { ui: DscRuntime }).ui
  const instance = render(
    createElement(
      // Profiler 量「队友打字期间界面每秒重排几次」——探针的同款计数器。
      Profiler,
      { id: 'app', onRender: () => {
          commits += 1
        } },
      createElement(App as React.ComponentType<Record<string, unknown>>, {
        runtime,
        dispatchCommand: (input: string, rt: DscRuntime, ui: unknown) => runCommand(input, rt, ui as Parameters<RunCommand>[2]),
      }),
    ),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  unmountApp = () => instance.unmount()
  // 等首帧稳定（欢迎页 + 状态栏画完），再开始量。
  await settleFrame()
})

/** 等这一帧写完：最少 150ms，且输出长度连续几拍不再变（composer.spec 同款）。 */
async function settleFrame(): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + 2_000
  let previous = -1
  let stable = 0
  while (Date.now() < deadline) {
    await sleep(25)
    if (output.length === previous) stable += 1
    else {
      stable = 0
      previous = output.length
    }
    if (Date.now() - startedAt >= 150 && stable >= 2) return
  }
}

/** 最近一帧（剥 ANSI）。 */
const frame = (): string => {
  const idx = output.lastIndexOf('\x1b[2K')
  return (idx < 0 ? output : output.slice(idx)).replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}
const flat = (): string => frame().replace(/\n/g, ' ⏎ ')

/** 量测结果（驱动在一条 test 里发生一次，断言逐条对 facts）。 */
interface Facts {
  sawCard: boolean
  commits: number
  elapsed: number
  perSecond: number
  peak: string
}
let facts: Facts | null = null

describe('子代理 + TUI 端到端性能验收', () => {
  beforeAll(async () => {
    // 发言 → 主回合派活；轮询到队友卡出现（探针同款 15s 上限）
    ;(kernel.ctx as { ui: DscRuntime }).ui.submit('开跑')
    let sawCard = false
    const cardDeadline = Date.now() + 15_000
    while (Date.now() < cardDeadline) {
      if (frame().includes('子代理：')) {
        sawCard = true
        break
      }
      await sleep(120)
    }

    // 队友流式期间的提交率：窗口从卡片出现（清零）开始。探针固定量 2.5s；这里改成
    // 「至少量 2.5s，且队友输出停止更新 2.5s 才收窗」——打字期间才算数，流停了不多等。
    // 「最新一口」的可见帧只存在一拍，判停用帧里的最大行号。
    commits = 0
    const started = Date.now()
    let peak = ''
    let lastLineNumber = 0
    let lastUpdateAt = Date.now()
    const streamDeadline = Date.now() + 15_000
    while (Date.now() < streamDeadline) {
      const current = frame()
      const seen = Number(/队友第 (\d+) 行/.exec(current)?.[1] ?? 0)
      if (seen > lastLineNumber) {
        lastLineNumber = seen
        lastUpdateAt = Date.now()
      }
      if (current.includes('队友第') && current.length > peak.length) peak = current
      if (Date.now() - started >= 2_500 && Date.now() - lastUpdateAt >= 2_500) break
      await sleep(100)
    }
    const elapsed = Date.now() - started
    facts = { sawCard, commits, elapsed, perSecond: (commits / elapsed) * 1000, peak }
  }, 40_000)

  afterAll(async () => {
    unmountApp?.()
    stdin.end()
    await kernel?.dispose()
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose())
    })
  })

  test('[1] 真队友被派出去、卡片进了会话流', () => {
    expect(facts?.sawCard, flat().slice(-300)).toBe(true)
  })

  test('[2] 队友打字期间提交率被夹住（≤ 25 次/秒）', () => {
    const current = facts!
    expect(
      current.perSecond <= 25,
      `${current.commits} 次 / ${current.elapsed}ms = ${current.perSecond.toFixed(1)} 次/秒`,
    ).toBe(true)
  })

  test('[2b] 界面确实在跟着更新（提交没有掉到 0）', () => {
    expect(facts?.commits, String(facts?.commits)).toBeGreaterThanOrEqual(3)
  })

  test('[3] 队友瀑布的最新内容看得见（合并没有丢内容）', () => {
    expect(facts?.peak.includes('队友第'), (facts?.peak ?? '').slice(-200)).toBe(true)
  })
})

afterAll(() => {
  if (originalDscHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalDscHome
  home.restore()
})
