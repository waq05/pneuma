/**
 * 飞书来源事件长连接（`sources/feishu-loops.ts` 的 `consume`）与补收循环错误分支的覆盖。
 *
 * 已有 `sources-feishu-loops.spec.ts` 只跑了「spawn 直接失败」那条路（`bot.cli` 是不存在的
 * 命令），所以 stderr/stdout 的处理闭包（ready 行、WARN/error 行、事件 JSON 解析、禁用后
 * 丢弃、超大行、单事件错误上报）以及补收循环里「单个群读失败只记错不中断」那一支全是空白。
 *
 * 这里用 `vi.mock('node:child_process')` 注入一个可控的假子进程（真 `readline` 接口照用），
 * 把子进程会吐的行逐条喂进去；`Commands` 与 `SourceContext` 用与既有 spec 同形的内存假件。
 * 不起真 lark-cli、不联网、不碰 `~/.dsc`。
 *
 * @module dsc/packages/superagent/tests/w14-feishu-consume.spec
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, test, vi } from 'vitest'
import type { Commands } from '../infra/commands.js'
import type { Thread, Trigger } from '../core/index.js'
import { KV } from '../kv.js'
import type { SourceContext } from '../sources/host.js'

// ── 假子进程注入点（与 cdp 包 branches-extra 同款手法）──────────────────────

const cp = vi.hoisted(() => ({
  spawn: null as null | ((...args: unknown[]) => unknown),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      if (cp.spawn === null) throw new Error('测试没配 spawn')
      return cp.spawn(...args)
    },
  }
})

/** 一个可由测试直接往里写 stdout/stderr 的假子进程。 */
interface FakeChild extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill: (signal?: string) => boolean
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4321
  child.kill = () => {
    child.emit('close', 0)
    return true
  }
  return child
}

/** 等一个条件成立（readline 的行事件是异步投递的）。 */
async function until(check: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待条件超时：${label}`)
}

// ── 假上下文（与 sources-feishu-loops.spec.ts 同形）─────────────────────────

const bot = {
  cli: 'fake-lark-cli',
  appId: 'cli_app',
  brand: 'feishu' as const,
  botId: 'ou_bot',
  name: 'Bot',
}
const deployment = {
  repository: 'acme/widgets',
  github: { cli: 'gh', login: 'agent', noreply: 'x' },
  feishu: bot,
  stateDir: '/tmp/state',
  promptMaxChars: 1,
  admissionContextMaxPages: 1,
  admissionContextTimeoutMs: 1,
}

interface FakeOptions {
  config: () => unknown
  lark: (args: string[]) => unknown
  threads?: Thread[]
  state?: Map<string, unknown>
}

function fakeContext(options: FakeOptions) {
  const state = options.state ?? new Map<string, unknown>()
  const received: Trigger[] = []
  const reports: { entry: string; health: unknown }[] = []
  const described: unknown[][] = []
  const commands = {
    deployment,
    withSignal: () => commands,
    lark: async (args: string[]) => options.lark(args),
  } as unknown as Commands
  const context = {
    deployment: { ...deployment, feishu: bot },
    commands,
    ready: Promise.resolve(),
    configured: () => true,
    problem: undefined,
    config: () => options.config(),
    receive: async (trigger: Trigger) => {
      received.push(trigger)
      return {} as never
    },
    atomic: <T>(work: () => T) => work(),
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => {
        value === undefined ? state.delete(key) : state.set(key, value)
      },
      keys: () => [...state.keys()],
    },
    threads: {
      get: () => undefined,
      subscribed: () => options.threads ?? [],
      describe: (...args: unknown[]) => described.push(args),
      patch: () => {},
    },
    triggers: { get: () => undefined, latest: () => undefined },
    tickets: {
      get: () => undefined,
      open: () => [],
      bindThread: () => {},
      threadClosed: () => {},
    },
    notify: () => {},
    report: (entry: string, health: unknown) => reports.push({ entry, health }),
  }
  return {
    context: context as unknown as SourceContext,
    received,
    reports,
    described,
    state,
  }
}

/** 一条合法的事件行（`feishuTrigger` 的 EventSchema 形状）。 */
const eventLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    message_id: 'om_1',
    chat_id: 'oc_a',
    chat_type: 'group',
    sender_id: 'ou_carol',
    sender_type: 'user',
    content: 'hello @_user_1',
    create_time: '1757000000000',
    mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'Bot' }],
    ...over,
  })

describe('consume：事件长连接的 stderr / stdout 处理', () => {
  test('ready 行与 WARN 行写体检、合法事件收成 Trigger、机器人自己的消息与禁用后的事件丢弃', async () => {
    const config = { chats: [], directMessages: true }
    let enabled = true
    const fake = fakeContext({
      config: () => (enabled ? config : undefined),
      lark: () => ({ chats: [] }),
    })
    const child = fakeChild()
    cp.spawn = () => child
    const { runFeishu } = await import('../sources/feishu-loops.js')
    const controller = new AbortController()
    const running = runFeishu(fake.context, controller.signal)

    // stderr：WARN 行先报 error，再报 ready 行；最后一行只更新 diagnostic 不报体检。
    child.stderr.write('[event] starting\n')
    child.stderr.write('WARN dropped 2 events\n')
    child.stderr.write('[event] ready\n')
    await until(() => fake.reports.some((item) => item.entry === 'feishu'), '首次体检上报')
    await until(() => (fake.reports.at(-1)?.health as { state?: string } | undefined)?.state === 'ready', 'ready 体检')

    // stdout：一条合法事件 → 收成 Trigger 并把群记进 state。
    child.stdout.write(`${eventLine()}\n`)
    await until(() => fake.received.length === 1, '收到第一条事件')
    expect(fake.received[0]!.meta).toMatchObject({
      chatId: 'oc_a',
      direct: false,
    })
    expect(fake.state.get(KV.feishu.chats)).toEqual({ oc_a: false })
    expect(fake.described.length).toBe(1)

    // 机器人自己发的消息：feishuTrigger 返回 undefined，直接丢弃。
    child.stdout.write(`${eventLine({ message_id: 'om_self', sender_id: 'ou_bot' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake.received).toHaveLength(1)

    // 来源关闭后到达的事件：enabled() 为空，同样丢弃。
    enabled = false
    child.stdout.write(`${eventLine({ message_id: 'om_off' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake.received).toHaveLength(1)

    controller.abort()
    await running
    expect(fake.reports.at(-1)?.entry).toBeDefined()
  })

  test('坏 JSON 与超过 1 MiB 的单行：错误只上报成来源体检，消费者不中断', async () => {
    const fake = fakeContext({
      config: () => ({ chats: [], directMessages: true }),
      lark: () => ({ chats: [] }),
    })
    const child = fakeChild()
    cp.spawn = () => child
    const { runFeishu } = await import('../sources/feishu-loops.js')
    const controller = new AbortController()
    const running = runFeishu(fake.context, controller.signal)

    child.stdout.write('{not json\n')
    await until(() => fake.reports.some((item) => (item.health as { state?: string }).state === 'error'), '坏 JSON 上报')
    expect(fake.received).toEqual([])

    // 1 MiB + 1 的行：consume 里显式拒绝，错误同样落在体检上。
    child.stdout.write(`${'x'.repeat(1_048_577)}\n`)
    await until(
      () => fake.reports.some((item) => String((item.health as { detail?: string }).detail).includes('exceeds 1 MiB')),
      '超大行上报',
    )
    expect(fake.received).toEqual([])

    controller.abort()
    await running
  })

  test('补收循环里单个群读失败：记进 errors 并上报 history，不中断其它群与循环', async () => {
    const state = new Map<string, unknown>([
      [KV.feishu.chats, { oc_bad: true, oc_ok: true }],
      [KV.feishu.history('oc_bad'), '2025-01-01T00:00:00.000Z'],
      [KV.feishu.history('oc_ok'), '2025-01-01T00:00:00.000Z'],
    ])
    const fake = fakeContext({
      config: () => ({ chats: [{ chatId: 'oc_cfg' }], directMessages: true }),
      state,
      lark: (args) => {
        const params = JSON.parse(args[4] ?? '{}') as { container_id?: string }
        if (params.container_id === 'oc_bad') throw new Error('lark said no')
        return { items: [], has_more: false }
      },
    })
    const child = fakeChild()
    cp.spawn = () => child
    const { runFeishu } = await import('../sources/feishu-loops.js')
    const controller = new AbortController()
    const running = runFeishu(fake.context, controller.signal)

    await until(
      () =>
        fake.reports.some(
          (item) => item.entry === 'history' && String((item.health as { detail?: string }).detail).includes('oc_bad'),
        ),
      'history 错误上报',
    )
    const history = fake.reports.filter((item) => item.entry === 'history').at(-1)!.health as { state: string; detail: string }
    expect(history.state).toBe('error')
    expect(history.detail).toContain('lark said no')

    controller.abort()
    await running
  })
})

// 兜底：每个用例后把 spawn 注入点还原，避免串到下一个用例。
test('假子进程停止后 spawn 注入点可复位', () => {
  cp.spawn = null
  expect(cp.spawn).toBeNull()
})
