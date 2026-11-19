/**
 * 子代理上下文：子代理的 system prompt 里带环境 / 模型事实（迁自
 * `scripts/subagent-context-test.mjs`）。
 *
 * 背景：子代理的 MiniAgent deps 里没有 `rewrite`，主会话那条 env-facts 投影对它不生效；
 * 它又不该拿主会话的环境快照——子代理有自己的会话目录与冻结的工牌模型。瞎猜路径的根因
 * 就是系统提示词里既没有 cwd、也没有模型名。修法是给子代理单独补一段纯函数
 * `subagentEnvironmentText`，并用**派它的那个会话**的 cwd（不是进程 cwd）。
 *
 * ## 两段各走哪条缝
 *
 * ① 纯函数：直接调 `subagentEnvironmentText`，传入一个假 cwd——它能照抄就说明「事实
 *    来自参数」，而不是来自进程状态；
 * ② 端到端：真内核 + 假端点，把父会话的 cwd 换成临时目录，直接调 `subagent` 工具派
 *    一个队友，抓**队友那次请求**的 system。这里不经过父会话的模型回合：`tool.run` 是
 *    这个工具的公开入口，少一次「模型要不要喊这个工具」的随机性。
 *
 * 隔离：`tempHome()` + `bootKernel`，真实 `~/.dsc` 一个字节都不动。
 *
 * @module dsc/tests/integration/subagent-context.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录；`DSC_HOME` 是 `path-policy.ts` 的模块级常量，必须先换好再加载内核。 */
const home = tempHome('dsc-subagent-ctx-')
/** 父会话的 cwd：一个与进程 cwd 不同的临时目录，用来钉住「用的是父会话的 cwd」。 */
const PARENT_CWD = join(home.home, 'work', 'proj-alpha')

/** 平台文案与源码同款（这里独立算一遍，避免直接抄被测实现）。 */
const expectedPlatform = process.platform === 'win32' ? 'Windows' : process.platform
/** 今天（本地时区），与 `subagentEnvironmentText` 的拼法一致。 */
const today = (() => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
})()

/** 子代理那次请求的原样记录（只留断言用到的两样）。 */
interface CapturedRequest {
  system: string
  model: string
}

/** 内核里本文件用到的服务面：只声明用到的。 */
interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
}
interface ToolView {
  name: string
  run(args: Record<string, unknown>, ctx: unknown): Promise<string>
}
interface Services {
  session: { current(): SessionView; open(filePath?: string, cwd?: string): Promise<void> }
  tools: { list(): ToolView[] }
  llm: { model: string }
  agent: { isRunning(filePath: string): boolean }
}

let kernel: BootedKernel
let fake: FakeLLM
let services: Services
let prompt: typeof import('../../src/packages/session-core/prompt.js')
/** 派活那一刻的父会话（`team` 名册与汇报都按它归属）。 */
let parent: SessionView
const captured: CapturedRequest[] = []

/** 等条件成立；超时返回 false，由断言报出可读错误。 */
async function until(condition: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeAll(async () => {
  mkdirSync(PARENT_CWD, { recursive: true })
  mkdirSync(join(home.home, '.dsc'), { recursive: true })
  const dscHome = join(home.home, '.dsc')
  writeFileSync(join(dscHome, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
  // 打开子智能体（官方插件默认关），并让收工汇报走 quiet（不额外唤起主会话的一轮，
  // 免得那些请求混进本文件要观察的子代理请求里）；关掉长期记忆（回合结束会投机器通知）。
  writeFileSync(
    join(dscHome, 'plugins.json'),
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
  prompt = await import('../../src/packages/session-core/prompt.js')

  fake = await fakeLLM({
    turns: ['收到，已看过项目结构'],
    // 队友的请求认系统提示里的「你在团队里的位置」标志（子代理独有的那一段）。
    onRequest: (body) => {
      const messages = (body as { messages?: unknown }).messages
      if (!Array.isArray(messages)) return
      const system = messages.find(
        (message) => (message as { role?: string }).role === 'system',
      ) as { content?: unknown } | undefined
      const text = typeof system?.content === 'string' ? system.content : ''
      if (!text.includes('# 你在团队里的位置')) return
      captured.push({ system: text, model: String((body as { model?: unknown }).model ?? '') })
    },
  })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
  home.restore()
})

test('① 纯函数：以「环境事实：」开头，四行事实齐全', () => {
  const text = prompt.subagentEnvironmentText('/definitely/not/this/process/dir', 'deepseek-v9')
  expect(text.startsWith('环境事实：')).toBe(true)
  expect(text).toContain('- 工作目录：/definitely/not/this/process/dir')
  expect(text).toContain(`- 平台：${expectedPlatform}`)
  expect(text).toContain(`- 今天：${today}`)
  expect(text).toContain('- 你用的模型：deepseek-v9')
})

test('① 纯函数：cwd 用传进来的那个，不是进程 cwd', () => {
  const fakeCwd = '/definitely/not/this/process/dir'
  const text = prompt.subagentEnvironmentText(fakeCwd, 'deepseek-v9')
  expect(text).not.toContain(process.cwd())
  expect(text).toContain(fakeCwd)
})

test('① 纯函数：不查 git 分支（子代理每轮现算，跑 git 子进程不值当）', () => {
  expect(prompt.subagentEnvironmentText('/w', 'm')).not.toContain('git 分支')
})

test('② 端到端：父会话 cwd 换成临时目录，队友的 system 里写着它', async () => {
  // 新会话、目录必须存在；这一步不改进程 cwd。
  await services.session.open(undefined, PARENT_CWD)
  parent = services.session.current()
  expect(parent.meta.cwd).toBe(PARENT_CWD)

  const tool = services.tools.list().find((entry) => entry.name === 'subagent')
  expect(tool).toBeDefined()
  const spawned = await tool!.run(
    {
      action: 'spawn',
      role: 'explorer',
      task: '读一下这个项目的 package.json，用一句话汇报项目名与版本，再说明主入口文件在哪',
      background: true,
    },
    { cwd: PARENT_CWD, signal: new AbortController().signal, sessionId: parent.meta.id, sessionPath: parent.filePath },
  )
  expect(spawned).toContain('已派给')

  const got = await until(() => captured.length > 0)
  expect(got).toBe(true)
})

test('② 队友的 system 里有「# 你在团队里的位置」与环境段', () => {
  const request = captured[0]
  expect(request?.system).toContain('# 你在团队里的位置')
  expect(request?.system).toContain('环境事实：')
})

test('② 工作目录 = 父会话的 cwd（不是进程 cwd）', () => {
  const system = captured[0]?.system ?? ''
  expect(system).toContain(`- 工作目录：${PARENT_CWD}`)
  expect(system).not.toContain(process.cwd())
})

test('② 平台与今天写在里面', () => {
  const system = captured[0]?.system ?? ''
  expect(system).toContain(`- 平台：${expectedPlatform}`)
  expect(system).toContain(`- 今天：${today}`)
})

test('② 模型名回填 = 当前模型，请求的 model 字段也是它', () => {
  const request = captured[0]
  expect(request?.system).toContain(`- 你用的模型：${services.llm.model}`)
  expect(request?.model).toBe('m')
})

test('② 不限轮次时提示写「轮次不设上限」，不再写「最多 N 次模型请求」', async () => {
  // explorer 的出厂定义不再写 max-turns（轮次预算默认不限）。
  const system = captured[0]?.system ?? ''
  expect(system).toContain('轮次不设上限，但每轮都要往结论推进，别在同一个问题上打转')
  expect(system).not.toContain('次模型请求')
  // 收尾：等队友自己收工，避免 afterAll 时还有回合在跑。
  await until(() => !services.agent.isRunning(parent.filePath))
})

test('② 环境段落在角色提示之后、「# 你在团队里的位置」之前', () => {
  const system = captured[0]?.system ?? ''
  const env = system.indexOf('环境事实：')
  const pos = system.indexOf('# 你在团队里的位置')
  expect(env).toBeGreaterThanOrEqual(0)
  expect(pos).toBeGreaterThan(env)
})
