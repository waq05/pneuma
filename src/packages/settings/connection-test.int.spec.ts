/**
 * 「测试连接」的真端到端：真内核 + 本地假端点（迁自 `scripts/connection-test-test.mjs` 第六段）。
 *
 * ## 为什么这一半必须起内核
 *
 * 纯逻辑那一半（探针请求长什么样、失败怎么折句）在 `connection-test.spec.ts` 里用假 stream
 * 就验完了。这里要回答的是另一个问题：**设置服务把这条请求真正发出去的时候，线上到底是
 * 什么形状**——打哪个路径、带哪个 key、模型选的是不是「这个端点平时会用到的那个」。
 * 这几件事分别由设置插件的实现、llm 服务的协议适配器、以及 config.yaml 的路由组装决定，
 * 单看任何一个函数都推不出来。
 *
 * ## 假端点自己起，不用 harness 的 fakeLLM
 *
 * 要看的**请求头**（`authorization`）不在 fakeLLM 的 `onRequest` 里，而「带的是宿主自己
 * 那份 key」正是这里要钉的一条（页面指不了别处）。所以照原探针的做法起一个最小 HTTP
 * 服务，把 url / authorization / body 三样都记下来。
 *
 * ## 与纯逻辑那份的分工
 *
 * 原探针第五段那批「读源码找字符串」的接线钉已按台账 D24 删除；其中三条**能用行为验的**
 * 挪到这里：端点不存在就抛、没配 key 先说清、没模型也先说清。界面按钮与 CSS 那批
 * （按钮位置、忙碌态、结论点、令牌颜色）属于界面层，缺口记在交付里，等 P3 在 ui project
 * 补渲染断言。
 *
 * @module @pneuma/settings/connection-test.int.spec
 */
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, type BootedKernel } from '../../../tests/harness.js'
import type { ConnectionTestView } from '../../contract.js'
import { CONNECTION_PROBE_MAX_TOKENS } from './connection-test.js'

/** 设置服务里本文件用到的那一面。 */
interface Services {
  settings: { testConnection(provider: string, model?: string): Promise<ConnectionTestView> }
}

/** 假端点收到的一条请求。 */
interface Wire {
  url: string
  authorization: string
  body: Record<string, unknown>
}

/** 一次成功应答的 SSE 正文：与真适配器认的四段同形（正文 → finish → usage → [DONE]）。 */
function sse(text: string): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n` +
    'data: [DONE]\n\n'
  )
}

/** 一个模型条目：形状照 `defaultKernelConfig` 的可用户组合。 */
function modelOf(id: string) {
  return {
    id,
    name: id,
    contextWindow: 100_000,
    maxTokens: 500,
    modalities: ['text'],
    thinkingLevels: [],
    thinkingParam: 'none',
    effortMap: {},
  }
}

let kernel: BootedKernel
let services: Services
let site: Server
/** 假端点的地址与收到的请求。 */
let baseUrl = ''
const wire: Wire[] = []

beforeAll(async () => {
  site = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      wire.push({
        url: request.url ?? '',
        authorization: request.headers.authorization ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
      })
      // 钥匙不对就照真端点那样回 401：验「端点回了错」这条路的端到端
      if ((request.headers.authorization ?? '') === 'Bearer bad-key') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"invalid api key"}}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sse('ok'))
    })
  })
  await new Promise<void>((resolveListen) => {
    site.listen(0, '127.0.0.1', resolveListen)
  })
  const address = site.address()
  if (address === null || typeof address === 'string') throw new Error('假端点没拿到端口')
  baseUrl = `http://127.0.0.1:${String(address.port)}`

  /** 一个端点配置；`apiKey` 传空串就是「还没配 key」。 */
  const providerOf = (name: string, apiKey: string) => ({
    name,
    displayName: name,
    baseUrl,
    apiKey,
    models: [modelOf('m-1'), modelOf('m-2')],
  })

  kernel = await bootKernel({
    providerBaseUrl: baseUrl,
    config: {
      providers: {
        local: providerOf('local', 'good-key'),
        bad: providerOf('bad', 'bad-key'),
        nokey: providerOf('nokey', ''),
        empty: { ...providerOf('empty', 'good-key'), models: [] },
      },
      defaultProvider: 'local',
      defaultModel: 'm-2',
    },
  })
  services = kernel.ctx as unknown as Services
})

afterAll(async () => {
  await kernel?.dispose()
  // 先掐掉还挂着的 keep-alive 连接（fetch/undici 会留池子；不掐的话 close 会等很久，
  // 进程带着未关闭的句柄不退出）。原探针同一处置。
  site?.closeAllConnections()
  await new Promise<void>((resolveClose) => {
    if (site === undefined) resolveClose()
    else site.close(() => resolveClose())
  })
})

describe('真端到端：从设置服务走到线上请求', () => {
  test('真发一次：通了，带回话摘要、正数耗时与选中的模型', async () => {
    const outcome = await services.settings.testConnection('local')
    expect(outcome.ok).toBe(true)
    expect(outcome.reply).toBe('ok')
    expect(outcome.ms).toBeGreaterThan(0)
    // 测的是这个端点平时用的那个模型（默认模型 m-2）
    expect(outcome.model).toBe('m-2')
  })

  test('请求打到 /chat/completions，并带上这个端点的 key（页面指不了别处）', () => {
    const sent = wire.at(-1)
    expect(sent?.url).toBe('/chat/completions')
    expect(sent?.authorization).toBe('Bearer good-key')
  })

  test('线上就两条消息（system + hi），不带工具目录，预算压到探针值', () => {
    const body = wire.at(-1)?.body as { messages?: Array<{ role: string; content: string }>; tools?: unknown; max_tokens?: number }
    expect(body.messages).toHaveLength(2)
    expect(body.messages?.[0]?.role).toBe('system')
    expect(body.messages?.[1]?.content).toBe('hi')
    expect(body.tools).toBeUndefined()
    expect(body.max_tokens).toBe(CONNECTION_PROBE_MAX_TOKENS)
  })

  test('点名指定模型就测指定的那个', async () => {
    await expect(services.settings.testConnection('local', 'm-1')).resolves.toMatchObject({ model: 'm-1' })
  })

  test('端点回 401 → ok:false，并把端点原文带出来', async () => {
    const refused = await services.settings.testConnection('bad')
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('401')
    expect(refused.reply).toBe('')
  })

  test('不存在的端点 → 抛错（页面因此拿它当不了「任意地址」）', async () => {
    await expect(services.settings.testConnection('nope')).rejects.toThrow(/没有这个端点/)
  })

  test('端点没有 key → 先说清是「还没配 key」，不等 401', async () => {
    await expect(services.settings.testConnection('nokey')).rejects.toThrow(/还没有可用的 API key/)
  })

  test('端点没有模型 → 抛错并说清先拉清单 / 加模型', async () => {
    await expect(services.settings.testConnection('empty')).rejects.toThrow(/还没有模型/)
  })
})
