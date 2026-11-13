/**
 * 「桥接工具一次调用只问一遍守卫链」的内核级用例（integration 层，原
 * `scripts/tool-search-single-approval-test.mjs`）。
 *
 * 背景：模型调 `tool_call` 转调撤下的工具时，以前会弹**两张**审批卡——第一张写的是
 * 「调用 tool_call」（用户看不出要动什么），点过之后桥自己再按真名判一遍，第二张才写
 * 真实工具。现在的做法是桥在循环里交出目标身份（`ToolEntry.gateAs`），只问一遍。
 *
 * 这一节用真内核 + 假端点跑三个回合，钉住五件事：
 *   [1] 撤下的 exec 工具（bash）：守卫链**只被问一次**，看到的是 `bash` 而不是 `tool_call`；
 *       只弹一张卡，卡上写的是 bash；点「拒绝」之后工具没执行；
 *   [1b] 点「这次允许」时仍然只有一张卡，放行后 bash 真的跑了；
 *   [2] 台面上的只读工具经 `tool_call` 转调时按 `read` 判定（只读免卡，结果原样回来）；
 *   [3] `tool_call` 这个名字一次都没出现在守卫链上（旧实现会在第一张卡上出现）。
 *
 * ## 与探针的差别
 *
 * 探针手写 SSE 端点并按「提问原文」分派应答；这里用 harness 的 `fakeLLM`，按请求序号
 * 给剧本：每轮两步（工具调用 → 收尾）。标题请求由 fakeLLM 单独应答，不占轮次。
 *
 * 探针在仓库根建 `dsc-single-approval-probe` 再删；这里改成在系统临时目录下建，
 * 测试失败也不会在仓库里留脏目录。命令用绝对路径，断言的是同一条命令原文。
 *
 * ## 隔离
 *
 * 临时 HOME；`plugins.json` 显式关掉沙箱（Windows 上它启动会 spawn PowerShell 体检，
 * 可能挂住 worker），并让 `bash` 命中延后规则。真相是：不打开 tool-search，桥接工具
 * 根本不存在，这一节也就无从谈起。
 *
 * @module @pneuma/tool-search/single-approval.int.spec
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'

/** 内核里本文件用到的服务面。 */
interface SessionView {
  meta: { id: string }
  messages: Array<{ role: string; content: unknown }>
}

interface ApprovalCard {
  id: string
  /** 卡上写的工具名：旧实现第一张卡写的是 `tool_call`。 */
  tool: string
  argsSummary?: string
}

/** 审批服务返回的挂起卡（界面上那张）。 */
interface PendingCard {
  id: string
  toolName: string
  argsSummary?: string
}

interface KernelSurface {
  on(event: 'dsc/turn-end', listener: (reason: string) => void): () => void
  provide(name: string, value: unknown): void
  session: { current(): SessionView }
  tools: { list(): Array<{ name: string }> }
  guards: {
    register(guard: {
      id: string
      order: number
      decide(input: GuardSeen): { action: 'defer' }
    }): void
  }
  approval: {
    pendingView(): PendingCard | null | undefined
    answer(answer: 'reject' | 'allow-once'): void
  }
}

/** 守卫链上被问到的每一次（只记账、不表态）。 */
interface GuardSeen {
  toolName: string
  risk: string
  args: Record<string, unknown>
}

/** 「跑一下命令」那条用例要建的目录（临时目录下，跑完删）。 */
const workRoot = mkdtempSync(join(tmpdir(), 'dsc-single-approval-int-spec-'))
const probeDir = join(workRoot, 'dsc-single-approval-probe')
/** 两次工具调用用的是同一条命令原文：守卫看到的参数必须与它逐字相同。 */
const MKDIR_COMMAND = `mkdir "${probeDir}"`

let llm: FakeLLM
let kernel: BootedKernel
let surface: KernelSurface
let seen: GuardSeen[] = []
let cards: ApprovalCard[] = []
let rejectExtras = false
let watcher: NodeJS.Timeout | undefined

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** 轮询到条件成立；超时返回 false，由断言决定红在哪。 */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

/** 这一轮新增的会话工具结果文本（按出现顺序；不含之前回合留下的记录）。 */
function toolTexts(messages: SessionView['messages']): string[] {
  return messages.filter((message) => message.role === 'tool').map((message) => String(message.content))
}

/**
 * 跑一个回合，返回这一轮新增的会话消息与看到的卡。
 *
 * 只看「这一轮新增的」：会话是跨用例累积的，按全量读会把上一轮的工具结果当成这一轮的
 * 证据（探针每个用例都只看最后一个 tool 文本，同一个坑）。
 *
 * `answer` 为 null 表示这一轮不该弹卡；给了就等卡出现后替用户点一次，之后冒出来的
 * 多余卡一律按拒收掉——多出来的那张恰恰是回归本身，不能让它把整批挂到审批超时。
 */
async function turn(text: string, answer: 'reject' | 'allow-once' | null): Promise<{ added: SessionView['messages'] }> {
  seen = []
  cards = []
  rejectExtras = answer === null
  const before = surface.session.current().messages.length
  const running = kernel.runTurn(text)
  if (answer !== null) {
    await until(() => cards.length > 0)
    await sleep(150)
    surface.approval.answer(answer)
    rejectExtras = true
  }
  await running
  return { added: surface.session.current().messages.slice(before) }
}

beforeAll(async () => {
  // 插件清单：打开 tool-search 并让 bash（exec）命中延后规则；沙箱保持关闭。
  mkdirSync(DSC_HOME, { recursive: true })
  writeFileSync(
    join(DSC_HOME, 'plugins.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          { file: 'sandbox', disabled: true },
          { file: 'memory', config: { enabled: false } },
          { file: 'self-improve', disabled: true },
          // 标题插件会在回合之间多发一次模型请求；fakeLLM 按请求序号发剧本，
          // 多出来这一次会吃掉下一轮的 tool_call，后面整段错位。
          { file: 'session-title', disabled: true },
          { file: 'tool-search', disabled: false, config: { deferRules: ['bash'] } },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
  llm = await fakeLLM({
    // 每轮两步：先给一次 tool_call，工具结果回来之后收尾。请求序号与回合一一对应。
    turns: [
      { toolCall: { name: 'tool_call', args: { name: 'bash', arguments: { command: MKDIR_COMMAND } } } },
      '工具回来了',
      { toolCall: { name: 'tool_call', args: { name: 'bash', arguments: { command: MKDIR_COMMAND } } } },
      '工具回来了',
      { toolCall: { name: 'tool_call', args: { name: 'read', arguments: { path: 'package.json' } } } },
      '工具回来了',
    ],
  })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  surface = kernel.ctx as unknown as KernelSurface
  // 装一个「有人在看」的界面信号：没有它，审批插件判定「没人能答」，卡根本不弹（直接按拒）。
  surface.provide('interactive', { kind: 'tui', reachable: () => true })
  // 守卫链上按 order 20 插一条只记账、不表态的守卫（审批是 order 30，所以在它之前看到）。
  surface.guards.register({
    id: 'probe-count',
    order: 20,
    decide(input) {
      seen.push({ toolName: input.toolName, risk: input.risk, args: input.args })
      return { action: 'defer' }
    },
  })
  watcher = setInterval(() => {
    const view = surface.approval.pendingView()
    if (view !== null && view !== undefined && !cards.some((card) => card.id === view.id)) {
      cards.push({ id: view.id, tool: view.toolName, ...(view.argsSummary === undefined ? {} : { argsSummary: view.argsSummary }) })
      if (rejectExtras) surface.approval.answer('reject')
    }
  }, 10)
  watcher.unref?.()
})

afterAll(async () => {
  if (watcher !== undefined) clearInterval(watcher)
  // 探针中途失败也要把临时目录收掉；它建在系统临时目录下，留着只是垃圾。
  rmSync(workRoot, { recursive: true, force: true })
  await kernel?.dispose()
  await llm?.close()
})

test('前提：bash 已被 tool-search 撤下，tool_call 在台面上', () => {
  const names = surface.tools.list().map((tool) => tool.name)
  expect(names).not.toContain('bash')
  expect(names).toContain('tool_call')
})

test('[1] 撤下的 exec 工具：守卫链只问一次，问的是真名；拒绝后工具没执行', async () => {
  const { added } = await turn('跑一下命令', 'reject')
  // 只弹一张审批卡：两张卡就是「tool_call + bash」的旧实现。
  expect(cards).toHaveLength(1)
  expect(cards[0]?.tool).toBe('bash')
  expect(seen).toHaveLength(1)
  expect(seen[0]?.toolName).toBe('bash')
  expect(seen[0]?.risk).toBe('exec')
  expect(seen[0]?.args.command).toBe(MKDIR_COMMAND)
  expect(seen.some((item) => item.toolName === 'tool_call')).toBe(false)
  expect(toolTexts(added).some((text) => text.includes('用户拒绝了这次工具调用'))).toBe(true)
  expect(existsSync(probeDir)).toBe(false)
})

test('[1b] 点「这次允许」：仍然只有一张卡，放行后工具真的跑了', async () => {
  const { added } = await turn('跑一下命令再来一次', 'allow-once')
  expect(cards).toHaveLength(1)
  expect(cards[0]?.tool).toBe('bash')
  expect(existsSync(probeDir)).toBe(true)
  // 拒绝文案不该出现：这张卡是被允许的。
  expect(toolTexts(added).some((text) => text.includes('用户拒绝了这次工具调用'))).toBe(false)
  rmSync(probeDir, { recursive: true, force: true })
})

test('[2] 台面上的只读工具经桥转调仍按 read 判定（免卡、结果原样回来）', async () => {
  const { added } = await turn('读一个文件', null)
  expect(cards).toHaveLength(0)
  expect(seen).toHaveLength(1)
  expect(seen[0]?.toolName).toBe('read')
  expect(seen[0]?.risk).toBe('read')
  const texts = toolTexts(added)
  // read 真的执行了：拿到了 package.json 的正文（里面有 "name" 字段）。
  expect(texts.some((text) => text.includes('"name"'))).toBe(true)
  // 也没有被「没人能回答审批卡」挡掉。
  expect(texts.some((text) => text.includes('没有界面能回答审批卡'))).toBe(false)
})
