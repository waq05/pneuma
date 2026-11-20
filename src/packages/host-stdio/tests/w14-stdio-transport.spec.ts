/**
 * host-stdio 的 stdio 传输补测（W14）。
 *
 * 既有 wiring-extra 只走 `process.parentPort`（桌面壳那条路），stdio 分支
 * （`node lib/headless.js` 手测 / 远程壳）一直没人碰。这里把 `process.parentPort`
 * 摘掉，直接往 `process.stdin` 灌分块数据，钉住：
 *
 *   - 握手 hello 先写 stdout；按行切分，半行要缓冲到下一块；
 *   - 空行、非 JSON 行容错忽略，不炸也不回写；
 *   - invoke 走白名单并回写 result；exit 转给 runtime；
 *   - stdin `end` 之后 `interactive.reachable()` 变假（审批不再白等）；
 *   - `dsc/exit` 收尾把 stdin 监听摘干净，再灌数据也不会被处理。
 *
 * 收尾统一触发 `dsc/exit` + effect dispose，避免节流定时器与 stdin 监听漏出来。
 *
 * @module @pneuma/host-stdio/tests/w14-stdio-transport
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { hostStdioPlugin } from '../index.js'

/** 没有 `parentPort` 时 process 上的属性键。 */
const processWithPort = process as typeof process & { parentPort?: unknown }
const originalPort = processWithPort.parentPort
const originalWrite = process.stdout.write

afterEach(() => {
  if (originalPort === undefined) delete processWithPort.parentPort
  else processWithPort.parentPort = originalPort
  process.stdout.write = originalWrite
  vi.restoreAllMocks()
})

interface Mounted {
  written: string[]
  runtime: { exit: ReturnType<typeof vi.fn> }
  interactiveReachable: () => boolean
  fire(event: string, ...args: unknown[]): void
  dispose(): void
}

/** 摘掉 parentPort 后装一次插件，返回测试把手。 */
function mount(): Mounted {
  delete processWithPort.parentPort

  const written: string[] = []
  const write = ((chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  process.stdout.write = write

  const provided = new Map<string, unknown>()
  const events = new Map<string, Array<(...args: unknown[]) => void>>()
  let effectDispose: (() => void) | undefined
  const runtime = {
    getSnapshot: () => ({
      seq: 2,
      entries: [],
      liveEntries: [],
      status: { turnState: 'idle' },
    }),
    subscribe: () => () => {},
    listPlugins: () => [{ name: 'base' }],
    exit: vi.fn(),
  }
  const ctx = {
    ui: runtime,
    provide(name: string, value: unknown) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    get: () => undefined,
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
      return () => {
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    effect(execute: () => unknown) {
      const result = execute()
      effectDispose = typeof result === 'function' ? (result as () => void) : undefined
      return effectDispose ?? (() => {})
    },
  }

  hostStdioPlugin.apply(ctx as never, { snapshotThrottleMs: 1 })

  const interactive = provided.get('interactive') as { reachable(): boolean }
  return {
    written,
    runtime,
    interactiveReachable: () => interactive.reachable(),
    fire(event, ...args) {
      for (const handler of [...(events.get(event) ?? [])]) handler(...args)
    },
    dispose: () => effectDispose?.(),
  }
}

/** 把 stdout 的整行 JSON 解析出来（快照等非目标消息一起过滤掉）。 */
function messages(mounted: Mounted): Array<Record<string, unknown>> {
  return mounted.written
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

describe('stdio 传输：分块解析、白名单与 stdin 关闭', () => {
  test('hello 先写 stdout；半行缓冲、空行与非 JSON 丢弃；invoke 回写 result', async () => {
    const mounted = mount()
    try {
      // 握手是 apply 里同步发的，必须排在任何输入之前。
      expect(messages(mounted).at(0)).toEqual({
        type: 'hello',
        protocolVersion: expect.any(Number),
      })

      // 第一块只有半个 JSON（没有换行）——应留在缓冲区里，不触发任何解析。
      process.stdin.emit('data', '{"type":"invoke","id":1,')
      expect(messages(mounted).some((message) => message['type'] === 'result')).toBe(false)

      // 第二块补完那一行，并带一个空行、一个非 JSON 行、一条白名单外的 invoke。
      process.stdin.emit('data', '"method":"listPlugins"}\n\nnot-json\n{"type":"invoke","id":2,"method":"noSuchMethod"}\n')

      await vi.waitFor(() => {
        expect(messages(mounted).some((message) => message['type'] === 'result' && message['id'] === 1)).toBe(true)
      })
      const ok = messages(mounted).find((message) => message['type'] === 'result' && message['id'] === 1)
      expect(ok).toMatchObject({ ok: true, value: [{ name: 'base' }] })

      await vi.waitFor(() => {
        expect(messages(mounted).some((message) => message['type'] === 'result' && message['id'] === 2)).toBe(true)
      })
      const denied = messages(mounted).find((message) => message['type'] === 'result' && message['id'] === 2)
      expect(denied).toMatchObject({ ok: false })
      expect(String(denied?.['error'])).toContain('协议不允许调用')

      // 非 JSON 行没有变成 result，也没有把整个传输弄挂。
      expect(messages(mounted).filter((message) => message['type'] === 'result')).toHaveLength(2)
    } finally {
      mounted.fire('dsc/exit')
    }
  })

  test('stdin 关闭后 interactive 判不可达；exit 消息转给 runtime', async () => {
    const mounted = mount()
    try {
      expect(mounted.interactiveReachable()).toBe(true)
      // end 与 close 都算宿主那头没人了（Windows 上关管道先给 close）。
      process.stdin.emit('end')
      expect(mounted.interactiveReachable()).toBe(false)

      process.stdin.emit('data', '{"type":"exit"}\n')
      await vi.waitFor(() => expect(mounted.runtime.exit).toHaveBeenCalledTimes(1))
    } finally {
      mounted.fire('dsc/exit')
    }
  })

  test('dsc/exit 后不再解析 stdin（监听已摘掉）', async () => {
    const mounted = mount()
    process.stdin.emit('data', '{"type":"invoke","id":1,"method":"listPlugins"}\n')
    await vi.waitFor(() => {
      expect(messages(mounted).filter((message) => message['type'] === 'result')).toHaveLength(1)
    })

    mounted.fire('dsc/exit')
    process.stdin.emit('data', '{"type":"invoke","id":2,"method":"listPlugins"}\n')
    // 收尾之后灌的数据不应再被处理——给微任务一个机会，仍然只有第一条。
    await Promise.resolve()
    await Promise.resolve()
    expect(messages(mounted).filter((message) => message['type'] === 'result')).toHaveLength(1)
  })
})
