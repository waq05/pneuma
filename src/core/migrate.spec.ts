/**
 * dsh 配置迁移的纯函数（`core/migrate.ts`）：容错 YAML 与 provider/模型能力搬运。
 *
 * 不调 `migrateFromDsh`（它读固定的 `~/.dsh/settings.yaml`，本文件不碰真实家目录）。
 *
 * @module dsc/core/migrate.spec
 */
import { describe, expect, test } from 'vitest'
import { extractDshProviders, parseTolerantYaml } from './migrate.js'

describe('parseTolerantYaml', () => {
  test('普通 YAML 直接解析；空内容当空对象', () => {
    expect(parseTolerantYaml('a: 1\nb: [x, y]')).toEqual({ a: 1, b: ['x', 'y'] })
    expect(parseTolerantYaml('')).toEqual({})
  })

  test('带 !!js 标签且整份解析失败的文档：剥掉那些行再解析', () => {
    // 这一行既带 !!js 又引用了不存在的别名：完整解析必抛，剥掉就能过。
    const text = 'a: 1\nbad: !!js *nope\nb: 2\n'
    expect(parseTolerantYaml(text)).toEqual({ a: 1, b: 2 })
  })

  test('剥完还坏：给空对象，不抛', () => {
    expect(parseTolerantYaml('a: [unclosed\n!!js\n')).toEqual({})
  })
})

describe('extractDshProviders', () => {
  test('只收 openai-completions 且有 baseURL 的端点；id 缺失的模型跳过；空模型端点跳过', () => {
    const providers = extractDshProviders({
      'llm-pi-ai': {
        providers: {
          good: {
            displayName: '好用',
            baseURL: 'https://api.example.com///',
            apiKeyEnv: 'GOOD_KEY',
            api: 'openai-completions',
            models: [{ id: 'm1' }, { name: '没 id' }],
          },
          wrongApi: { baseURL: 'https://x', api: 'anthropic' },
          noUrl: { api: 'openai-completions' },
          noModels: { baseURL: 'https://y', api: 'openai-completions', models: [] },
        },
      },
    })
    expect(Object.keys(providers)).toEqual(['good'])
    expect(providers['good']).toMatchObject({
      displayName: '好用',
      baseURL: 'https://api.example.com',
      apiKeyEnv: 'GOOD_KEY',
      models: [{ id: 'm1', name: 'm1', contextWindow: 128_000, maxTokens: 8_192 }],
    })
  })

  test('模型能力与档位一起搬：模态、thinkingLevels=false、effortMap', () => {
    const providers = extractDshProviders({
      'llm-pi-ai': {
        providers: {
          p: {
            api: 'openai-completions',
            baseURL: 'https://api',
            models: [
              { id: 'no-think', reasoningEfforts: false, inputModalities: ['text', 'image'] },
              { id: 'think', reasoningEfforts: { low: 'low', high: 'high' } },
            ],
          },
        },
      },
    })
    const models = providers['p']!.models
    expect(models[0]).toMatchObject({ modalities: ['text', 'image'], thinkingLevels: [] })
    expect(models[1]).toMatchObject({
      thinkingLevels: ['low', 'high'],
      effortMap: { low: 'low', high: 'high' },
      thinkingParam: 'reasoning-effort',
    })
  })

  test('没有 llm-pi-ai 段：空对象', () => {
    expect(extractDshProviders({})).toEqual({})
  })
})
