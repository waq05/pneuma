/**
 * 模型发现（`settings/model-discovery.ts`）的单元测试：三种应答形状的解析 + HTTP 失败口径。
 *
 * 纯函数与一个 `fetch` 包装，全部用替身，不联网。
 *
 * @module @pneuma/settings/tests/model-discovery
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { discoverModels, parseModelsResponse } from '../model-discovery.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseModelsResponse：认三种形状并去重排序', () => {
  test('OpenAI 的 data[] 取 id', () => {
    expect(parseModelsResponse({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }] })).toStrictEqual([
      'a-model',
      'b-model',
    ])
  })

  test('ollama 的 models[] 取 name', () => {
    expect(parseModelsResponse({ models: [{ name: 'llama3' }, { name: 'qwen' }] })).toStrictEqual(['llama3', 'qwen'])
  })

  test('纯字符串数组原样收，空串丢掉', () => {
    expect(parseModelsResponse(['m2', '', 'm1', 'm2'])).toStrictEqual(['m1', 'm2'])
  })

  test('混排：对象优先 id、其次 name；空 id 落到 name；认不出的行跳过', () => {
    expect(
      parseModelsResponse({
        data: [
          { id: '', name: 'only-name' },
          { name: 42 },
          null,
          'string-row',
          7,
          { id: 'ok' },
        ],
      }),
    ).toStrictEqual(['ok', 'only-name', 'string-row'].sort((a, b) => a.localeCompare(b)))
  })

  test('认不得的形状返回空数组（让调用方报「没解析出」，不猜）', () => {
    expect(parseModelsResponse(null)).toStrictEqual([])
    expect(parseModelsResponse('text')).toStrictEqual([])
    expect(parseModelsResponse(42)).toStrictEqual([])
    expect(parseModelsResponse({})).toStrictEqual([])
    expect(parseModelsResponse({ data: 'nope', models: {} })).toStrictEqual([])
  })
})

describe('discoverModels：请求组装与四种失败', () => {
  test('baseUrl 末尾斜杠先削掉；有 key 带 Bearer，没 key 不带 Authorization', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> })
      return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { headers: { 'content-type': 'application/json' } })
    })

    expect(await discoverModels('https://api.example/v1/', 'sk-key')).toStrictEqual(['m1'])
    expect(calls[0]?.url).toBe('https://api.example/v1/models')
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-key')

    expect(await discoverModels('https://api.example/v1', '')).toStrictEqual(['m1'])
    expect(calls[1]?.url).toBe('https://api.example/v1/models')
    expect(calls[1]?.headers['Authorization']).toBeUndefined()
  })

  test('非 2xx：报错带状态码与响应体摘要', async () => {
    vi.stubGlobal('fetch', async () => new Response('unauthorized token', { status: 401 }))
    await expect(discoverModels('https://api.example/v1', 'bad')).rejects.toThrow(/HTTP 401：unauthorized token/)
  })

  test('连不上：报错带地址与底层原因', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(discoverModels('https://api.example/v1', 'k')).rejects.toThrow(/连不上 https:\/\/api\.example\/v1\/models：ECONNREFUSED/)
  })

  test('应答不是 JSON、或解析不出模型清单：各给一句能照做的错', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>not json</html>', { status: 200 }))
    await expect(discoverModels('https://api.example/v1', 'k')).rejects.toThrow(/不是 JSON/)

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ nope: true }), { status: 200 }))
    await expect(discoverModels('https://api.example/v1', 'k')).rejects.toThrow(/没解析出模型清单/)
  })

  test('成功时返回排序后的清单', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ models: [{ name: 'z' }, { name: 'a' }, { name: 'm' }] }), { status: 200 }),
    )
    expect(await discoverModels('https://ollama.example:11434/v1', '')).toStrictEqual(['a', 'm', 'z'])
  })
})
