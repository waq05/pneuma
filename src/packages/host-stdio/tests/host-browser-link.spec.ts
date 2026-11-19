/**
 * 没有桌面壳时的那条链（迁自 `scripts/dock-browser-test.mjs` 第 5 节）。
 *
 * ## 钉什么
 *
 * `host-stdio` 插件是「宿主 → 桌面壳」那条链的实现方。它有两种传输：
 * 父端口（Electron utilityProcess，`process.parentPort` 存在）与 stdio（TUI / 无头 /
 * 远程壳）。**只有前者后面才可能有桌面壳**，所以 stdio 形态下：
 *
 *   ① `available()` 必须为假（判据只认传输形态，不能凭「有没有服务」猜）；
 *   ② 五个方法（views / open / close / call / session().send）必须**立刻**抛
 *      `DockBrowserUnavailableError`，并把话说成「宿主里没有桌面壳」——等 25 秒超时
 *      会把「没有桌面壳」报成「桌面壳没响应」，是两回事；
 *   ③ 不可用时一条 `browser-*` 请求都不该被 `transport.send` 发出去（闸门在发送之前）；
 *   ④ 线上握手 `hello` 带的是契约版本（不是本地另抄的一个数字）；
 *   ⑤ `dsc/exit` 之后服务摘掉（热卸载不残留）。
 *
 * ## 为什么截 `process.stdout`
 *
 * stdio 传输的协议面就是「把 JSON 行写进 stdout」；测试进程的 stdout 还兼着跑分器的
 * 输出，所以只在 `apply()` 那一刻截住，拿到线上真的发了什么之后立刻还原。快照节流的
 * 定时器交给 `dsc/exit` 收（本文件最后一条就是它）。
 *
 * @module @pneuma/host-stdio/tests/host-browser-link.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { HOST_PROTOCOL_VERSION } from '../../../core/dock-browser.js'
import { DockBrowserUnavailableError, HOST_BROWSER_SERVICE, type HostBrowserLink } from '../../../core/host-browser-link.js'
import { hostStdioPlugin } from '../index.js'

/** 宿主插件挂上去之后拿到的服务与事件钩子。 */
interface Mounted {
  link: HostBrowserLink
  /** 线上写出去的行（`apply` 期间截到的）。 */
  wire: string[]
  /** 服务还在不在（`ctx.get(HOST_BROWSER_SERVICE)` 的判据）。 */
  hasService(): boolean
  /** 摘服务（dsc/exit 的两个 handler 由测试手动触发）。 */
  exit(): void
}

let mounted: Mounted

beforeAll(() => {
  const provided = new Map<string, unknown>()
  const listeners = new Map<string, Array<() => void>>()
  /** 截到的协议行。 */
  const wire: string[] = []
  const realWrite = process.stdout.write.bind(process.stdout)
  // `transport.send` 在调用时读 process.stdout.write，所以还原之后新写的会回到真 stdout；
  // 只在 apply 这一小段截住，够拿 hello 与「有没有 browser-*」。
  process.stdout.write = ((chunk: unknown): boolean => {
    wire.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  const ctx = {
    ui: {
      subscribe: () => () => {},
      getSnapshot: () => ({}),
      exit: () => {},
    },
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      return () => {
        if (provided.get(name) === value) provided.delete(name)
      }
    },
    get: (name: string) => provided.get(name),
    on: (event: string, handler: () => void) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    // 2026-11-04：插件的注册改成 ctx.effect 了（停用即注销）。桩 ctx 跟着 cordis。
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  try {
    hostStdioPlugin.apply(ctx as unknown as Context, { snapshotThrottleMs: 1_000 })
  } finally {
    process.stdout.write = realWrite
  }
  const link = provided.get(HOST_BROWSER_SERVICE) as HostBrowserLink | undefined
  if (link === undefined) throw new Error('host-stdio 没有 provide hostBrowser 服务')
  mounted = {
    link,
    wire,
    hasService: () => provided.has(HOST_BROWSER_SERVICE),
    exit() {
      for (const handler of [...(listeners.get('dsc/exit') ?? [])]) handler()
    },
  }
})

afterAll(() => {
  // 幂等：最后一条用例已经走过一遍，这里只是兜底（定时器与 stdin 监听都要收掉）。
  mounted?.exit()
})

/** 断言某个方法「立刻」抛（不是等 DOCK_CALL_TIMEOUT_MS），且报错是人话。 */
async function expectImmediateUnavailable(run: () => Promise<unknown>): Promise<void> {
  const startedAt = Date.now()
  let error: unknown
  try {
    await run()
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - startedAt
  expect(error).toBeInstanceOf(DockBrowserUnavailableError)
  expect(elapsed).toBeLessThan(100)
  const message = error instanceof Error ? error.message : String(error)
  expect(message).toContain('宿主里没有桌面壳')
  // 抛栈会让模型看到一堆内部帧、也读不出「该去桌面端用」。
  expect(message).not.toContain('\n    at ')
}

describe('① stdio 形态：链路判不可用', () => {
  test('hostBrowser 服务挂上了（工具面取得到，不会读到 undefined）', () => {
    expect(mounted.link).toBeDefined()
  })

  test('stdio 形态下 available() 为假（判据只认传输形态）', () => {
    expect(mounted.link.available()).toBe(false)
  })
})

describe('② 不可用时每个方法立刻抛人话（不等到超时）', () => {
  test('views()', async () => {
    await expectImmediateUnavailable(() => mounted.link.views())
  })

  test('open()', async () => {
    await expectImmediateUnavailable(() => mounted.link.open('https://example.com/'))
  })

  test('close()', async () => {
    await expectImmediateUnavailable(() => mounted.link.close('agent-1'))
  })

  test('call()', async () => {
    await expectImmediateUnavailable(() => mounted.link.call('agent-1', 'Page.enable'))
  })

  test('session().send()', async () => {
    await expectImmediateUnavailable(() => mounted.link.session('agent-1').send('Page.enable'))
  })
})

describe('③ 线上协议面', () => {
  test('不可用时一条 browser-* 请求都没发出去（闸门在发送之前）', () => {
    const leaked = mounted.wire.filter((line) => line.includes('"browser-'))
    expect(leaked).toStrictEqual([])
  })

  test('握手 hello 带的就是契约版本（不是本地另一个数字）', () => {
    const hello = mounted.wire
      .map((line) => {
        try {
          return JSON.parse(line.trim()) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .find((message) => message !== null && message['type'] === 'hello')
    expect(hello).toBeDefined()
    expect(hello?.['protocolVersion']).toBe(HOST_PROTOCOL_VERSION)
  })
})

describe('④ 收尾', () => {
  test('宿主退出后服务摘掉了（offBrowser 真的生效）', () => {
    expect(mounted.hasService()).toBe(true)
    mounted.exit()
    // 摘服务之后 `ctx.get(HOST_BROWSER_SERVICE)` 读不到它——工具面据此退回「没有桌面壳」的人话。
    expect(mounted.hasService()).toBe(false)
  })
})
