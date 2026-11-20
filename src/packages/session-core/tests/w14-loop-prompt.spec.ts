/**
 * session-core 运行面长尾补盲（w14）：
 *
 *   - loop：回合跑动中再投递一条（pendingTurn 合并）、llm 内部重试的落盘+广播、
 *     请求 invariant 失配只报一条 notice；
 *   - prompt：非 Windows 平台的平台行（`${process.platform}（bash 工具跑的是 …）`）。
 *
 * 隔离：`HOME/USERPROFILE/DSC_HOME` 在任何内核模块被加载之前指向临时目录（import 全是动态的），
 * 不碰真实 `~/.dsc`；重试用例不真等待，只让假 stream 主动调 `onRetry`。
 *
 * @module dsc/packages/session-core/tests/w14-loop-prompt.spec
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { ChatMessage, StreamHandlers, StreamRequest, StreamResult } from '@pneuma/runtime/core/llm.js'

const HOME = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-session-core-w14-')))
const DSC = join(HOME, '.dsc')
mkdirSync(DSC, { recursive: true })
const savedEnv = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  DSC_HOME: process.env['DSC_HOME'],
  DSC_PROFILE: process.env['DSC_PROFILE'],
  DSC_HOT: process.env['DSC_HOT'],
}
process.env['HOME'] = HOME
process.env['USERPROFILE'] = HOME
process.env['DSC_HOME'] = DSC
process.env['DSC_HOT'] = '0'
delete process.env['DSC_PROFILE']

let loop: typeof import('../loop.js')
let prompt: typeof import('../prompt.js')
let Session: (typeof import('../../../core/session.js'))['Session']

beforeAll(async () => {
  loop = await import('../loop.js')
  prompt = await import('../prompt.js')
  Session = (await import('../../../core/session.js')).Session
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 上目录可能还被句柄占着：留给系统清。
  }
})

/** 建一个临时工作目录。 */
function workDir(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-w14-work-')))
}

const okResult = (text: string): StreamResult => ({
  text,
  reasoning: '',
  toolCalls: [],
  usage: null,
  finishReason: 'stop',
})

interface Harness {
  agent: InstanceType<typeof loop.MiniAgent>
  session: ReturnType<typeof Session.create>
  events: Array<{ type: string; [key: string]: unknown }>
  notices: string[]
}

interface HarnessOptions {
  stream: (api: string, request: StreamRequest, handlers: StreamHandlers) => Promise<StreamResult>
  rewrite?: (messages: ChatMessage[]) => ChatMessage[]
  /** 每次 emit 时回调一次：用来模拟「用户事件监听里同步再投一条」的重入。 */
  onEvent?: (event: { type: string; [key: string]: unknown }) => void
}

function makeHarness(options: HarnessOptions): Harness {
  const work = workDir()
  const session = Session.create(work)
  const events: Harness['events'] = []
  const notices: string[] = []
  const agent = new loop.MiniAgent(
    {
      route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
      systemPrompt: () => ({ text: 'sys', sections: [] }),
      tools: () => [],
      guards: {
        gate: async () => ({ action: 'pass' }),
        observe: (_name: string, text: string) => text,
      },
      emit: (event) => {
        const view = event as unknown as Harness['events'][number]
        events.push(view)
        options.onEvent?.(view)
      },
      stream: options.stream,
      notice: (text) => notices.push(text),
      ...(options.rewrite === undefined ? {} : { rewrite: (messages) => options.rewrite!(messages) }),
    },
    session,
  )
  return { agent, session, events, notices }
}

/** 轮询到条件成立（回合收尾是异步的；不写固定 sleep）。 */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

async function settle(agent: InstanceType<typeof loop.MiniAgent>): Promise<void> {
  await until(() => !agent.isRunning)
}

test('用户事件监听里同步再投递：running 已置真，标 pendingTurn，收尾后补跑一轮', async () => {
  let nested = false
  let calls = 0
  let harness: Harness | undefined
  harness = makeHarness({
    stream: async () => {
      calls += 1
      return okResult(`第 ${calls} 轮答完`)
    },
    onEvent: (event) => {
      if (event.type !== 'user' || nested) return
      nested = true
      harness?.agent.followup('嵌套投递')
    },
  })
  harness.agent.followup('第一条')
  await settle(harness.agent)

  expect(calls).toBe(2)
  const users = harness.session.messages.filter((message) => message.role === 'user').map((message) => message.content)
  expect(users).toEqual(['第一条', '嵌套投递'])
  harness.agent.dispose()
})

test('llm 内部重试：notice 先落盘再广播 model/retry', async () => {
  const harness = makeHarness({
    stream: async (_api, _request, handlers) => {
      handlers.onRetry?.(1, '端点 429 限流', { maxRetries: 2, delayMs: 250 })
      return okResult('重试后答完')
    },
  })
  harness.agent.followup('hi')
  await settle(harness.agent)

  const retryNotice = harness.session.notices().find((notice) => notice.kind === 'model-retry')
  expect(retryNotice).toMatchObject({ kind: 'model-retry', attempt: 1, maxRetries: 2, delayMs: 250, text: '端点 429 限流' })
  const event = harness.events.find((item) => item.type === 'model/retry')
  expect(event).toMatchObject({ type: 'model/retry', attempt: 1, maxRetries: 2, delayMs: 250, reason: '端点 429 限流' })
  harness.agent.dispose()
})

test('请求 invariant 失配：只报一条 notice，请求照常完成', async () => {
  let rewrites = 0
  const harness = makeHarness({
    rewrite: (messages) => {
      rewrites += 1
      return rewrites === 1
        ? messages
        : messages.map((message, index) => (index === 1 ? { ...message, content: '投影改过' } : message))
    },
    stream: async () => okResult('照常回答'),
  })
  harness.agent.followup('hi')
  await settle(harness.agent)

  expect(harness.notices.join(' | ')).toContain('请求 invariant：模型这次看到的消息与日志可重建的对不上')
  expect(harness.events.some((event) => event.type === 'message')).toBe(true)
  expect(harness.events.some((event) => event.type === 'error')).toBe(false)
  harness.agent.dispose()
})

test('prompt：非 Windows 平台的平台行带上 process.platform 与终端名', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const cwd = workDir()
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const text = prompt.environmentText(cwd)
    expect(text).toContain('- 平台：linux（bash 工具跑的是 ')
    expect(text).not.toContain('- 平台：Windows')
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
  }
})
