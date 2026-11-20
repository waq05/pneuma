/**
 * superagent-webhook 的 vitest 覆盖：出站 POST、配置 schema、策略段、插件入口的体检轮询。
 *
 * 迁移自 `tests/webhook.test.mjs`（那份走 `lib/` 构建产物、由包级探针跑），这里 import 源码；
 * 发送那一段用**本地 `node:http` 服务器**真收一次请求，不做 mock。
 *
 * @module @pneuma/superagent-webhook/tests
 */
import type { Context } from '@deepseek-ai/cordis'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { apply, inject, name } from '../index.js'
import {
  WEBHOOK_HEALTH,
  WEBHOOK_SOURCE,
  WebhookConfigSchema,
  isHttpUrl,
  linkWebhook,
  sendWebhook,
  webhookKind,
} from '../webhook.js'

/** 策略段是可选成员（契约里每个 SourceKind 都写它），测试里按存在取。 */
const policy = webhookKind.policy!


/** 契约里 `channel.send` 的第二个参数形状（webhook 只读这几个字段）。 */
type OutboundMessage = Parameters<typeof sendWebhook>[1]

const COMMANDS = { deployment: { repository: 'owner/repo' } } as never

/** 造一条出站消息：地址、密钥、目标名都放在 channel.address（契约如此）。 */
function message(address: Record<string, string>, extra: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: 'msg-1',
    kind: 'notice',
    text: '工单 #1 已完成',
    ticketId: 'ticket-1',
    channel: { source: WEBHOOK_SOURCE, thread: 'webhook:ops', address },
    ...extra,
  } as unknown as OutboundMessage
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sendWebhook：真打本地 HTTP 服务', () => {
  test('2xx 算 sent：POST、JSON 头、密钥头与消息体都对', async () => {
    const received: Array<{ method?: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        received.push({ method: request.method, headers: request.headers, body: JSON.parse(body) as Record<string, unknown> })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(port)}`
    try {
      const result = await sendWebhook(COMMANDS, message({ url: `${base}/notify`, secret: 's3cret', target: 'ops' }))
      expect(result).toBe('sent')
      expect(received).toHaveLength(1)
      expect(received[0]?.method).toBe('POST')
      expect(received[0]?.headers['content-type']).toBe('application/json')
      expect(received[0]?.headers['x-webhook-secret']).toBe('s3cret')
      expect(received[0]?.body).toStrictEqual({
        source: WEBHOOK_SOURCE,
        id: 'msg-1',
        kind: 'notice',
        text: '工单 #1 已完成',
        ticketId: 'ticket-1',
        target: 'ops',
      })
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  test('404 / 410 返回 gone；其它非 2xx 抛可重试的错', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/gone') {
        response.writeHead(410)
        response.end('{}')
        return
      }
      if (request.url === '/fail') {
        response.writeHead(503)
        response.end('{}')
        return
      }
      response.writeHead(200)
      response.end('{}')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(port)}`
    try {
      expect(await sendWebhook(COMMANDS, message({ url: `${base}/gone` }))).toBe('gone')
      await expect(sendWebhook(COMMANDS, message({ url: `${base}/fail` }))).rejects.toThrow(/HTTP 503/)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  test('地址不是 http(s)：发请求之前就拒；可选字段不给时消息体不带它们', async () => {
    await expect(sendWebhook(COMMANDS, message({ url: 'ftp://nope' }))).rejects.toThrow(/not an http\(s\) URL/)
    await expect(sendWebhook(COMMANDS, message({}))).rejects.toThrow(/not an http\(s\) URL/)

    // 不带 secret / target / ticketId：请求头与消息体都不出现这三个键。
    const headers: Record<string, unknown> = {}
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      Object.assign(headers, init.headers)
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response('ok', { status: 200 })
    })
    expect(await sendWebhook(COMMANDS, message({ url: 'https://hook.example/x' }, { ticketId: undefined }))).toBe('sent')
    expect(headers['x-webhook-secret']).toBeUndefined()
    expect(body).toStrictEqual({ source: WEBHOOK_SOURCE, id: 'msg-1', kind: 'notice', text: '工单 #1 已完成' })
    vi.unstubAllGlobals()
  })
})

describe('配置与策略 schema', () => {
  test('默认值补齐；空 url 是「未配置」而不是「配错」；非法 url / 重复目标名 / 多余键被拒', () => {
    expect(WebhookConfigSchema.parse({})).toStrictEqual({ url: '', secret: '', pollSeconds: 60, targets: [] })
    expect(WebhookConfigSchema.parse({ url: '  https://a.example/x  ' }).url).toBe('https://a.example/x')
    expect(() => WebhookConfigSchema.parse({ url: 'ftp://a.example' })).toThrow()
    expect(() =>
      WebhookConfigSchema.parse({
        targets: [
          { name: 'a', address: 'https://a.example' },
          { name: 'a', address: 'https://b.example' },
        ],
      }),
    ).toThrow(/Duplicate target names/)
    expect(() => WebhookConfigSchema.parse({ unknown: 1 })).toThrow()
    expect(() => WebhookConfigSchema.parse({ pollSeconds: 4 })).toThrow()
  })

  test('策略段：allowed 默认空数组，条目必须带 id，多余键被拒', () => {
    const schema = policy.schema
    expect(schema.parse({})).toStrictEqual({ allowed: [] })
    expect(schema.parse({ allowed: [{ id: 'ops-bot', name: 'Ops' }] })).toStrictEqual({ allowed: [{ id: 'ops-bot', name: 'Ops' }] })
    expect(() => schema.parse({ allowed: [{ id: 'x', extra: 1 }] })).toThrow()
    expect(() => schema.parse({ allowed: [{ id: '   ' }] })).toThrow()
  })

  test('准入行：每个目标一行；没有目标时给一行兜底；配置坏掉也不抛', () => {
    const rows = policy.rows!({
      url: 'https://a.example',
      secret: '',
      pollSeconds: 60,
      targets: [{ name: 'ops', address: 'https://a.example/ops' }],
    })
    expect(rows.map((row) => row.id)).toStrictEqual(['ops'])
    expect(Object.keys(rows[0]!.cells)).toStrictEqual(['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed'])
    expect(rows[0]!.cells).toStrictEqual({ listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false })

    const fallback = policy.rows!(WebhookConfigSchema.parse({}))
    expect(fallback.map((row) => row.id)).toStrictEqual(['outbound'])
    expect(policy.rows!({ garbage: true } as never).map((row) => row.id)).toStrictEqual(['outbound'])
  })
})

describe('kind 的其余声明面', () => {
  test('kind 身份、字段、scope、facts 与通道判定', () => {
    expect(webhookKind.kind).toBe(WEBHOOK_SOURCE)
    expect(webhookKind.health).toStrictEqual([WEBHOOK_HEALTH])
    expect(webhookKind.scope!({ meta: {} }, WebhookConfigSchema.parse({}))).toStrictEqual({ listened: true, observed: false })
    expect(webhookKind.facts!(undefined)['delivery']).toBeDefined()
    expect(webhookKind.fields.map((field) => field.key)).toStrictEqual(['url', 'secret', 'targets', 'delivery', 'pollSeconds'])
    // 只发不收：策略段只有 allowed 一份声明。
    expect(policy.fields.map((field) => field.key)).toStrictEqual(['allowed'])
    expect(policy.explicit.zh).toContain('只出站')

    // 通道：来源配好 http(s) 且消息地址也是 http(s) 才允许回话。
    expect(webhookKind.channel!.allowed!({ url: 'https://a.example' }, { url: 'https://b.example', secret: '', pollSeconds: 60, targets: [] })).toBe(true)
    expect(webhookKind.channel!.allowed!({ url: 'ftp://x' }, { url: 'https://b.example', secret: '', pollSeconds: 60, targets: [] })).toBe(false)
    expect(webhookKind.channel!.allowed!({ url: 'https://a.example' }, { url: '', secret: '', pollSeconds: 60, targets: [] })).toBe(false)
  })

  test('isHttpUrl 与 linkWebhook：地址可点，非 http(s) 给空串', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:1/x')).toBe(true)
    expect(isHttpUrl('')).toBe(false)
    expect(isHttpUrl('file:///etc/passwd')).toBe(false)
    expect(linkWebhook({ url: 'https://example.com/a' })).toStrictEqual({
      url: 'https://example.com/a',
      label: { zh: 'Webhook 地址', en: 'Webhook address' },
    })
    expect(linkWebhook({ url: 'nope' }).url).toBe('')
    expect(linkWebhook({}).url).toBe('')
  })
})

describe('插件入口：注册 kind 与体检轮询', () => {
  /** 假 cordis 上下文：只实现 apply 会碰的 get / logger / effect。 */
  function fakeContext(configRef: { current: Record<string, unknown> | undefined }) {
    const effects: Array<{ label: string; dispose: () => void }> = []
    const registered: string[] = []
    const reports: Array<{ kind: string; entry: string; state: string; detail: string }> = []
    const warnings: string[] = []
    const host = {
      sources: {
        register: (kind: { kind: string }) => {
          registered.push(kind.kind)
          return () => {}
        },
      },
      context: (kind: { kind: string }) => ({
        config: () => configRef.current,
        report: (entry: string, health: { state: string; detail: string }) =>
          reports.push({ kind: kind.kind, entry, state: health.state, detail: health.detail }),
      }),
    }
    const ctx = {
      get: (service: string) => (service === 'orchestrator' ? host : undefined),
      logger: { warn: (line: string) => warnings.push(line) },
      effect: (run: () => unknown, label: string) => {
        const off = run()
        effects.push({ label, dispose: typeof off === 'function' ? (off as () => void) : () => {} })
      },
    }
    return { ctx, effects, registered, reports, warnings }
  }

  test('name 与 inject：只依赖 orchestrator', () => {
    expect(name).toBe('superagent-webhook')
    expect(inject).toStrictEqual(['orchestrator'])
  })

  test('缺 orchestrator 时只警告、不注册任何东西', () => {
    const warn = vi.fn()
    apply({ get: () => undefined, logger: { warn }, effect: () => {} } as unknown as Context)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('orchestrator service is missing')
  })

  test('轮询：配置缺省报 paused/Off；给了地址报 ready 并带目标数；配置变化后按新周期重排', () => {
    vi.useFakeTimers()
    const configRef: { current: Record<string, unknown> | undefined } = { current: undefined }
    const fake = fakeContext(configRef)
    apply(fake.ctx as unknown as Context)
    expect(fake.registered).toStrictEqual([WEBHOOK_SOURCE])
    expect(fake.effects.map((effect) => effect.label)).toStrictEqual([
      'superagent-webhook: sources.register',
      'superagent-webhook: health.poll',
    ])
    // 第一轮：配置还没解析出来 → Off；周期取默认 60 秒。
    expect(fake.reports.at(-1)).toMatchObject({ entry: WEBHOOK_HEALTH, state: 'paused', detail: 'Off' })
    vi.advanceTimersByTime(60_000)
    expect(fake.reports.at(-1)).toMatchObject({ state: 'paused', detail: 'Off' })

    // 地址为空 = 还没配置 → Waiting；pollSeconds=5 让下一轮按 5 秒重排。
    configRef.current = { url: '', secret: '', pollSeconds: 5, targets: [] }
    vi.advanceTimersByTime(60_000)
    expect(fake.reports.at(-1)).toMatchObject({ state: 'paused', detail: 'Waiting for a webhook URL' })

    // 配好地址与两个目标 → ready；周期已是 5 秒（TICK_FLOOR_MS）。
    configRef.current = {
      url: 'https://a.example/hook',
      secret: '',
      pollSeconds: 5,
      targets: [
        { name: 'a', address: 'https://a.example/1' },
        { name: 'b', address: 'https://b.example/2' },
      ],
    }
    vi.advanceTimersByTime(5_000)
    expect(fake.reports.at(-1)).toMatchObject({ state: 'ready', detail: 'Outbound only; 2 target(s)' })

    // 周期改成 60 秒：下一轮先清掉旧定时器再按新周期重建，之后 5 秒内不再触发。
    configRef.current = { url: 'https://a.example/hook', secret: '', pollSeconds: 60, targets: [] }
    vi.advanceTimersByTime(5_000)
    const reportsBefore = fake.reports.length
    expect(fake.reports.at(-1)).toMatchObject({ detail: 'Outbound only; 0 target(s)' })
    vi.advanceTimersByTime(5_000)
    expect(fake.reports.length).toBe(reportsBefore)
    vi.advanceTimersByTime(55_000)
    expect(fake.reports.length).toBe(reportsBefore + 1)

    // 卸载：再推进时间也不再有报告。
    for (const effect of [...fake.effects].reverse()) effect.dispose()
    const reportsAfterDispose = fake.reports.length
    vi.advanceTimersByTime(120_000)
    expect(fake.reports.length).toBe(reportsAfterDispose)
  })

  test('没拿到配置时按默认 60 秒轮询一次，不会几毫秒刷一次', () => {
    vi.useFakeTimers()
    const fake = fakeContext({ current: undefined })
    apply(fake.ctx as unknown as Context)
    const before = fake.reports.length
    vi.advanceTimersByTime(59_000)
    expect(fake.reports.length).toBe(before)
    vi.advanceTimersByTime(1_500)
    expect(fake.reports.length).toBe(before + 1)
    for (const effect of [...fake.effects].reverse()) effect.dispose()
  })
})
