/**
 * CDP 消息层（`packages/cdp/transport.ts`）：建连、命令应答、事件分发、session 路由与断开。
 *
 * 用注入的假 socket（`socketFactory`）驱动：这里钉的是「id 配对、sessionId 核对、
 * 超时/取消/断线各自怎么结账、事件按 session 投递」，不依赖真浏览器。
 *
 * @module dsc/packages/cdp/tests/transport.spec
 */
import { describe, expect, test } from 'vitest'
import { CdpTransport, type CdpSocket } from '../transport.js'

/** 可手动驱动的假 WebSocket。 */
class FakeSocket implements CdpSocket {
  readyState = 0
  sent: string[] = []
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.({})
  }
  message(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }
  fail(message = 'boom'): void {
    this.onerror?.({ message })
  }
  drop(code?: number, reason?: string): void {
    this.onclose?.({ code, reason })
  }
}

/** 建一条用假 socket 的连接。 */
async function connect(options: { defaultTimeoutMs?: number; openTimeoutMs?: number } = {}): Promise<{
  transport: CdpTransport
  socket: FakeSocket
}> {
  const socket = new FakeSocket()
  const pending = CdpTransport.open(
    'ws://127.0.0.1:1/devtools/browser/x',
    {
      socketFactory: () => socket,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 5_000,
      openTimeoutMs: options.openTimeoutMs ?? 5_000,
      label: '测试连接',
    },
  )
  socket.open()
  return { transport: await pending, socket }
}

describe('建连', () => {
  test('onopen 后可用；超时 / onerror / onclose 各给一句人话；取消会关掉 socket', async () => {
    {
      const socket = new FakeSocket()
      const pending = CdpTransport.open('ws://x', { socketFactory: () => socket, openTimeoutMs: 50, label: '测试连接' })
      socket.fail()
      await expect(pending).rejects.toThrow(/测试连接 建连失败/)
    }
    {
      const socket = new FakeSocket()
      const pending = CdpTransport.open('ws://x', { socketFactory: () => socket, openTimeoutMs: 50, label: '测试连接' })
      socket.drop()
      await expect(pending).rejects.toThrow(/建连被关闭/)
    }
    {
      const socket = new FakeSocket()
      const pending = CdpTransport.open('ws://x', { socketFactory: () => socket, openTimeoutMs: 50, label: '测试连接' })
      await expect(pending).rejects.toThrow(/建连超时（50ms）/)
    }
    {
      const socket = new FakeSocket()
      const controller = new AbortController()
      const pending = CdpTransport.open('ws://x', { socketFactory: () => socket, label: '测试连接' }, controller.signal)
      controller.abort()
      await expect(pending).rejects.toThrow(/建连被取消/)
      expect(socket.closed).toBe(true)
    }
  })
})

describe('命令应答', () => {
  test('帧里带 id/method/params；sessionId 只在给了的时候出现；按 id 配对', async () => {
    const { transport, socket } = await connect()
    const pending = transport.send('Page.navigate', { url: 'https://e' })
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0]!)).toEqual({ id: 1, method: 'Page.navigate', params: { url: 'https://e' } })
    expect(transport.pendingCount).toBe(1)
    socket.message({ id: 1, result: { frameId: 'f1' } })
    await expect(pending).resolves.toEqual({ frameId: 'f1' })
    expect(transport.pendingCount).toBe(0)

    const session = transport.session('S1')
    const scoped = session.send('Runtime.evaluate', { expression: '1' })
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ id: 2, sessionId: 'S1' })
    socket.message({ id: 2, sessionId: 'S1', result: { value: 1 } })
    await expect(scoped).resolves.toEqual({ value: 1 })
  })

  test('error 帧带 data；sessionId 不匹配就拒；迟到的应答丢掉；没 result 给空对象', async () => {
    const { transport, socket } = await connect()
    const failed = transport.send('Page.x')
    socket.message({ id: 1, error: { message: '拒绝', data: '详情' } })
    await expect(failed).rejects.toThrow(/CDP Page.x 失败：拒绝（详情）/)

    const mismatch = transport.send('Runtime.y', {}, { sessionId: 'A' })
    socket.message({ id: 2, sessionId: 'B', result: {} })
    await expect(mismatch).rejects.toThrow(/会话.*不匹配/)

    const empty = transport.send('Page.z')
    socket.message({ id: 3 })
    await expect(empty).resolves.toEqual({})

    // 没人等的 id：不抛错、不影响后续
    expect(() => socket.message({ id: 999, result: 1 })).not.toThrow()
  })

  test('超时 / 取消 / socket 写失败 / 连接已关：各自拒绝', async () => {
    {
      const { transport } = await connect({ defaultTimeoutMs: 60 })
      await expect(transport.send('Page.slow')).rejects.toThrow(/CDP 命令超时（60ms）/)
    }
    {
      const { transport } = await connect()
      const controller = new AbortController()
      const pending = transport.send('Page.cancel', {}, { signal: controller.signal })
      controller.abort()
      await expect(pending).rejects.toThrow(/CDP 命令被取消：Page.cancel/)
    }
    {
      const { transport } = await connect()
      const controller = new AbortController()
      controller.abort()
      await expect(transport.send('Page.early', {}, { signal: controller.signal })).rejects.toThrow(/被取消/)
    }
    {
      const socket = new FakeSocket()
      socket.send = () => {
        throw new Error('管道断了')
      }
      const pending = CdpTransport.open('ws://x', { socketFactory: () => socket, label: '测试连接' })
      socket.open()
      const transport = await pending
      await expect(transport.send('Page.x')).rejects.toThrow(/发不出去.*管道断了/)
    }
    {
      const { transport } = await connect()
      transport.close()
      await expect(transport.send('Page.x')).rejects.toThrow(/连接不可用（主动关闭）/)
    }
  })
})

describe('事件分发', () => {
  test('带/不带 sessionId 都投；订阅者抛错不掀翻别人；可退订', async () => {
    const { transport, socket } = await connect()
    const browserLevel: Array<[Record<string, unknown>, string | undefined]> = []
    const pageLevel: Record<string, unknown>[] = []
    const any: string[] = []
    const off = transport.on('Page.frameNavigated', (params, sessionId) => {
      browserLevel.push([params, sessionId])
      throw new Error('订阅者自己炸了')
    })
    transport.on('Page.frameNavigated', (params) => pageLevel.push(params))
    transport.onAny((event) => any.push(`${event.method}@${event.sessionId ?? 'browser'}`))

    socket.message({ method: 'Page.frameNavigated', params: { url: 'a' } })
    socket.message({ method: 'Page.frameNavigated', params: { url: 'b' }, sessionId: 'S9' })
    expect(browserLevel).toEqual([
      [{ url: 'a' }, undefined],
      [{ url: 'b' }, 'S9'],
    ])
    expect(pageLevel).toHaveLength(2)
    expect(any).toEqual(['Page.frameNavigated@browser', 'Page.frameNavigated@S9'])

    off()
    socket.message({ method: 'Page.frameNavigated', params: { url: 'c' } })
    expect(browserLevel).toHaveLength(2)
    expect(pageLevel).toHaveLength(3)

    // 非 JSON / 非字符串帧直接忽略
    expect(() => socket.message('not json')).not.toThrow()
    expect(() => socket.onmessage?.({ data: 42 })).not.toThrow()
  })

  test('session 视图只收自己那条 session 的事件', async () => {
    const { transport, socket } = await connect()
    const view = transport.session('S1')
    const got: Record<string, unknown>[] = []
    view.on('Runtime.consoleAPICalled', (params) => got.push(params))
    expect(view.connection).toBe(transport)
    socket.message({ method: 'Runtime.consoleAPICalled', params: { n: 1 }, sessionId: 'S2' })
    socket.message({ method: 'Runtime.consoleAPICalled', params: { n: 2 }, sessionId: 'S1' })
    socket.message({ method: 'Runtime.consoleAPICalled', params: { n: 3 } })
    expect(got).toEqual([{ n: 2 }])
  })
})

describe('断开', () => {
  test('挂着的命令立刻被拒；onClose 收到原因；重复关闭幂等', async () => {
    const { transport, socket } = await connect()
    const reasons: string[] = []
    const off = transport.onClose((reason) => reasons.push(reason))
    const pending = transport.send('Page.x')
    socket.drop(1006, '浏览器没了')
    await expect(pending).rejects.toThrow(/连接已断开/)
    expect(transport.closed).toBe(true)
    expect(reasons[0]).toContain('1006')
    expect(transport.reason).toContain('1006')

    off()
    transport.close()
    socket.drop()
    expect(reasons).toHaveLength(1)
  })

  test('主动 close：原因写「主动关闭」，socket 只关一次', async () => {
    const { transport, socket } = await connect()
    let closes = 0
    const original = socket.close.bind(socket)
    socket.close = () => {
      closes += 1
      original()
    }
    transport.close()
    expect(transport.reason).toBe('主动关闭')
    transport.close()
    expect(closes).toBe(1)
  })
})
