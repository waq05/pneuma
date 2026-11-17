/**
 * 队友「叫停之后还能接着用」的端到端验收（迁自 `scripts/subagent-resume-test.mjs`）。
 *
 * 三条被钉住的旧行为：
 *   1. `stop` 把队友从在队名单里删掉 → 之后主会话传话只会写进信箱、没人读
 *      （「某一子代理中断后，主会话能否继续该子代理？」答案是「不能」）；
 *   2. 传话之后没有汇报回流 → 它又干完一遍，主会话什么也收不到；
 *   3. 被叫醒的队友状态还停在 stopped（界面一直显示停着）。
 *
 * ## 为什么派活走 `tool.run` 而不是「让模型喊工具」
 *
 * 被测对象是队友的**生命周期**（叫停 / 传话 / 移除），不是「模型会不会调工具」。
 * 直接调 `subagent` 工具的公开入口，主会话一个模型请求都不发，假端点的剧本就只剩
 * 队友的两轮——`fakeLLM` 是**按请求序号**发剧本的，少一个不相关请求就少一处错位。
 *
 * 隔离：临时 HOME + 假端点，真实 `~/.dsc` 一个字节都不动。
 *
 * @module dsc/tests/integration/subagent-resume.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录；`DSC_HOME` 是模块级常量，必须先换好再加载内核。 */
const home = tempHome('dsc-subagent-resume-')

/** 队友的一次请求（只留断言用到的两样：system 与请求的 model）。 */
interface CapturedRequest {
  system: string
  model: string
}

/** 名册一行（只声明本文件用到的字段）。 */
interface TeammateView {
  name: string
  state: string
  rounds: number
  file: string
  sessionId?: string
}

/** 内核里本文件用到的服务面。 */
interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  messages: Array<{ role: string; content: unknown }>
}
interface TeamSurface {
  list(): TeammateView[]
  stop(name: string): Promise<string>
  message(name: string, text: string): Promise<string>
  remove(name: string): Promise<string>
}
interface Services {
  session: { current(): SessionView }
  tools: { list(): Array<{ name: string; run(args: Record<string, unknown>, ctx: unknown): Promise<string> }> }
  get(name: string): unknown
}

let kernel: BootedKernel
let fake: FakeLLM
let services: Services
let team: TeamSurface
let parent: SessionView
/** 队友的名字（派活时自动生成，后面几条用例都按它找）。 */
let mate = ''
const captured: CapturedRequest[] = []

/** 等条件成立；超时返回 false，由断言报出可读错误。 */
async function until(condition: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** 名册里某一位的当前状态（不在名册里就是 undefined）。 */
function stateOf(name: string): string | undefined {
  return team.list().find((entry) => entry.name === name)?.state
}

/** 父会话里某个角色的正文清单。 */
function textsOf(role: string): string[] {
  return parent.messages
    .filter((message) => message.role === role)
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
}

beforeAll(async () => {
  mkdirSync(join(home.home, '.dsc'), { recursive: true })
  const dscHome = join(home.home, '.dsc')
  writeFileSync(join(dscHome, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
  // notify=quiet：汇报直接写进派出它的会话文件（不依赖常驻 agent），断言就看法这条通道。
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

  fake = await fakeLLM({
    turns: ['第一轮：查完了，包名叫 pneuma', '第二轮：又查了一遍，还是 pneuma'],
    onRequest: (body) => {
      const messages = (body as { messages?: unknown }).messages
      if (!Array.isArray(messages)) return
      const system = messages.find((message) => (message as { role?: string }).role === 'system') as
        | { content?: unknown }
        | undefined
      const text = typeof system?.content === 'string' ? system.content : ''
      // 队友的请求认「你在团队里的位置」；标题请求与父会话请求都不算。
      if (!text.includes('你在团队里的位置')) return
      captured.push({ system: text, model: String((body as { model?: unknown }).model ?? '') })
    },
  })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
  team = services.get('team') as TeamSurface
  parent = services.session.current()
})

afterAll(async () => {
  await kernel?.dispose()
  await fake?.close()
  home.restore()
})

test('① 派一个后台队友：名册里出现一位，且只派了一个', async () => {
  const tool = services.tools.list().find((entry) => entry.name === 'subagent')
  expect(tool).toBeDefined()
  const spawned = await tool!.run(
    {
      action: 'spawn',
      role: 'explorer',
      task: '查一下 package.json 里的包名，一句话交差',
      background: true,
    },
    { cwd: parent.meta.cwd, signal: new AbortController().signal, sessionId: parent.meta.id, sessionPath: parent.filePath },
  )
  expect(spawned).toContain('已派给')
  expect(await until(() => team.list().length === 1)).toBe(true)
  mate = team.list()[0]?.name ?? ''
  expect(mate).not.toBe('')
  // 派活不该顺手再多派一个（回环重派的老毛病）。
  expect(team.list()).toHaveLength(1)
})

test('② 队友干完一轮回到 idle，汇报写进派出它的会话', async () => {
  expect(await until(() => stateOf(mate) === 'idle')).toBe(true)
  expect(await until(() => textsOf('user').some((text) => text.includes('第一轮')))).toBe(true)
})

test('③ 叫停：人还在名册里，回复说清可以接着用', async () => {
  const stopText = await team.stop(mate)
  expect(stopText.includes('保留') || stopText.includes('传话')).toBe(true)
  // 它已经自己收工了：叫停没有在跑的回合可停，状态仍是 idle——关键是**人还在名册里**。
  expect(stateOf(mate)).toBe('idle')
})

test('④ 传话接着用：话没被「没有叫…的队友」挡下，它又被叫起来', async () => {
  const messageText = await team.message(mate, '再确认一次包名')
  expect(messageText).not.toContain('没有叫')
  // 假端点回得太快时第二轮可能已经跑完：观测到 working 或轮数已长到 2 都算「叫起来了」。
  const woke = await until(() => stateOf(mate) === 'working' || (team.list().find((entry) => entry.name === mate)?.rounds ?? 0) >= 2)
  expect(woke).toBe(true)
})

test('⑤ 第二轮确实跑了（队友的请求到了第二次），干完回到 idle', async () => {
  expect(await until(() => captured.length === 2)).toBe(true)
  expect(await until(() => stateOf(mate) === 'idle')).toBe(true)
})

test('⑥ 第二轮汇报也写回了主会话（以前这一条会永远缺席）', async () => {
  expect(await until(() => textsOf('user').some((text) => text.includes('第二轮')))).toBe(true)
})

test('⑦ 两次汇报都是 <teammate-report> 形状', () => {
  const reports = textsOf('user').filter((text) => text.includes('<teammate-report'))
  expect(reports.length).toBeGreaterThanOrEqual(2)
})

test('⑧ 移除：有明确回执，名册里没有它了', async () => {
  // 还在干活时移除会被挡下——先确保它已经收工。
  expect(await until(() => stateOf(mate) === 'idle')).toBe(true)
  const removeText = await team.remove(mate)
  expect(removeText).toContain('移除')
  expect(stateOf(mate)).toBeUndefined()
})
