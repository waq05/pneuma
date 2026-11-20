/**
 * settings 插件的 W14 补缺口测试：模型配置服务与偏好初值。
 *
 * 既有 `wiring.spec.ts` 已经盖住分区注册、读写与大部分失败分支；这里补它没走到的成功路径：
 *
 *   - `reloadLive()` 换配置后当前模型不可用 → 自动切到新默认端点（成功 / `setModel` 抛错）；
 *   - `mutate()` 的「成功且回执是字符串」分支；
 *   - 通用分区在有 permissionPresets 服务时读预选项；
 *   - `discoverModels()` / `testConnection()` 的成功路径（fetch 与 llm 都用桩）；
 *   - `setProviderKey()` 写凭据成功后刷新运行期配置；
 *   - 首次启动 `marketSources` 为空时补默认市场源。
 *
 * 所有落盘都写在临时 `DSC_HOME`；`DSC_HOME` 必须在 import 内核之前设好，所以走动态 import。
 *
 * @module dsc/packages/settings/tests/w14-service-paths
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DscCoreConfig } from '@pneuma/runtime/core/config.js'
import type { SettingsService } from '@pneuma/runtime/services/types.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-settings-w14-'))
process.env['DSC_HOME'] = HOME

type SettingsIndex = typeof import('../index.js')

let settingsPlugin: SettingsIndex['settingsPlugin']
let invalidateActiveConfigFile: (typeof import('@pneuma/runtime/core/config-store.js'))['invalidateActiveConfigFile']
let defaultMarketSources: (typeof import('@pneuma/runtime/core/prefs.js'))['DEFAULT_MARKET_SOURCES']

beforeAll(async () => {
  ;({ invalidateActiveConfigFile } = await import('@pneuma/runtime/core/config-store.js'))
  ;({ DEFAULT_MARKET_SOURCES: defaultMarketSources } = await import('@pneuma/runtime/core/prefs.js'))
  ;({ settingsPlugin } = await import('../index.js'))
})

afterAll(() => {
  delete process.env['DSC_HOME']
  delete process.env['DEMO_API_KEY']
  try {
    rmSync(HOME, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  } catch {
    // 临时目录留给系统清，不让收尾拖红。
  }
})

beforeEach(() => {
  invalidateActiveConfigFile()
  for (const name of ['settings.json', 'config.yaml', 'config.yaml.bak', 'credentials.yaml']) {
    rmSync(join(HOME, name), { force: true })
  }
  writeFileSync(join(HOME, 'config.yaml'), 'providers: {}\n', 'utf8')
  delete process.env['DEMO_API_KEY']
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['DEMO_API_KEY']
})

/** 假 llm：`provider/model` 故意与临时配置里的端点对不上，用来触发「当前模型不可用」。 */
function fakeLlm(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    provider: 'deepseek',
    model: 'chat',
    effort: 'default',
    setEffort: vi.fn(),
    setModel: vi.fn(),
    routeTo: vi.fn(() => ({
      api: 'openai',
      baseUrl: 'https://example.invalid',
      apiKey: 'k',
      model: 'm1',
    })),
    stream: vi.fn(async () => ({ text: 'ok' })),
    ...overrides,
  }
}

interface Harness {
  service: SettingsService
  llm: ReturnType<typeof fakeLlm>
  systems: string[]
  config: DscCoreConfig & { providers: Record<string, unknown> }
}

/** 假 ctx 跑真 apply。 */
function runSettings(
  options: {
    presets?: unknown
    llm?: ReturnType<typeof fakeLlm>
    config?: Record<string, unknown>
  } = {},
): Harness {
  const llm = options.llm ?? fakeLlm()
  const config = (options.config ?? {
    providers: {},
    defaultProvider: '',
    defaultModel: '',
    temperature: undefined,
    language: 'zh',
  }) as unknown as Harness['config']
  const systems: string[] = []
  const services = new Map<string, unknown>()
  if (options.presets !== undefined) services.set('permissionPresets', options.presets)
  let service: SettingsService | undefined
  const ctx = {
    get: (name: string) => services.get(name),
    transcript: {
      system(text: string) {
        systems.push(text)
      },
      touch() {},
    },
    llm,
    approval: {
      reviewer: 'user',
      setPolicy: vi.fn(),
      setReviewer: vi.fn(),
      decide: vi.fn(async () => 'allow-once'),
    },
    provide(name: string, value: SettingsService) {
      if (name === 'settings') service = value
    },
  }
  ;(settingsPlugin.apply as (ctx: unknown, config: DscCoreConfig) => void)(ctx, config)
  expect(service, 'settings 服务应当在 apply 里 provide').toBeDefined()
  return { service: service!, llm, systems, config }
}

/** 写一份带默认端点、端点 key 可由环境变量取到的配置文件。 */
function writeConfigFileWithDefault(name: string): string {
  const path = join(HOME, name)
  writeFileSync(
    path,
    [
      'default:',
      '  provider: demo',
      '  model: demo-1',
      'providers:',
      '  demo:',
      '    baseURL: https://example.invalid',
      '    apiKeyEnv: DEMO_API_KEY',
      '    models:',
      '      - id: demo-1',
      '',
    ].join('\n'),
    'utf8',
  )
  return path
}

/** 装上插件并把 `/models` 应答换成桩。 */
function stubModelsResponse(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
}

describe('reloadLive：换配置后当前模型不可用时自动切默认端点', () => {
  test('成功切到新默认端点', () => {
    const harness = runSettings()
    process.env['DEMO_API_KEY'] = 'sk-demo'
    const path = writeConfigFileWithDefault('good.yaml')

    expect(harness.service.setConfigFile(path)).toMatchObject({
      ok: true,
      notice: `已换成 ${path}`,
    })
    expect(harness.llm.setModel).toHaveBeenCalledWith('demo', 'demo-1')
    expect(harness.systems).toEqual([])
  })

  test('setModel 抛错时只记一条 system，不把保存设置带红', () => {
    const llm = fakeLlm({
      setModel: vi.fn(() => {
        throw new Error('切不了')
      }),
    })
    const harness = runSettings({ llm })
    process.env['DEMO_API_KEY'] = 'sk-demo'
    const path = writeConfigFileWithDefault('good-throw.yaml')

    expect(harness.service.setConfigFile(path)).toMatchObject({ ok: true })
    expect(harness.systems.join('\n')).toContain('模型配置已更新，但当前模型不可用了：切不了')
  })
})

describe('mutate 与通用分区', () => {
  test('插件分区的 action 返回字符串时成为成功回执', async () => {
    const harness = runSettings()
    harness.service.registerSection({
      id: 'w14-action',
      title: '补测分区',
      order: 200,
      fields: () => [],
      values: () => ({}),
      action: () => '动作完成',
    })
    await expect(harness.service.action('w14-action', 'do')).resolves.toEqual({
      ok: true,
      notice: '动作完成',
    })
  })

  test('有 permissionPresets 服务时通用分区读它的 options', () => {
    const presets = {
      surface: () => ({ options: [{ name: 'safe', label: '安全档' }] }),
    }
    const harness = runSettings({ presets })
    const general = harness.service.sections().find((section) => section.id === 'general')!
    const field = general.fields.find((entry) => 'key' in entry && entry.key === 'permissionPreset')
    expect(field).toMatchObject({
      type: 'select',
      options: [{ value: 'safe', label: '安全档' }],
    })
  })
})

describe('模型配置服务的成功路径', () => {
  test('discoverModels：端点存在时拉 /models 并返回清单', async () => {
    const harness = runSettings({
      config: {
        providers: {
          p: { baseUrl: 'https://example.invalid', apiKey: 'k', models: [] },
        },
      },
    })
    stubModelsResponse({ data: [{ id: 'm2' }, { id: 'm1' }] })
    await expect(harness.service.discoverModels('p')).resolves.toEqual(['m1', 'm2'])
  })

  test('testConnection：拿到路由后经 llm.stream 发探针并回成功', async () => {
    const harness = runSettings({
      config: {
        providers: {
          p: {
            baseUrl: 'https://example.invalid',
            apiKey: 'k',
            models: [{ id: 'm1' }],
          },
        },
      },
    })
    const outcome = await harness.service.testConnection('p')
    expect(outcome).toMatchObject({ ok: true, reply: 'ok' })
    expect(harness.llm.routeTo).toHaveBeenCalledWith('p', 'm1', 'default')
    expect(harness.llm.stream).toHaveBeenCalledTimes(1)
  })

  test('setProviderKey：写入凭据后刷新运行期配置', () => {
    writeFileSync(
      join(HOME, 'config.yaml'),
      [
        'providers:',
        '  demo:',
        '    baseURL: https://example.invalid',
        '    apiKeyEnv: DEMO_API_KEY',
        '    models:',
        '      - id: demo-1',
        '',
      ].join('\n'),
      'utf8',
    )
    const harness = runSettings()
    const result = harness.service.setProviderKey('demo', 'sk-1')
    expect(result).toMatchObject({
      ok: true,
      notice: expect.stringContaining('已写入 DEMO_API_KEY'),
    })
    expect(process.env['DEMO_API_KEY']).toBe('sk-1')
  })
})

describe('偏好初值', () => {
  test('settings.json 里市场源为空时，启动补一份出厂默认', () => {
    writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ marketSources: [] }), 'utf8')
    runSettings()
    const saved = JSON.parse(readFileSync(join(HOME, 'settings.json'), 'utf8')) as {
      marketSources: Array<{ name: string }>
    }
    expect(saved.marketSources.map((source) => source.name)).toEqual(defaultMarketSources.map((source) => source.name))
  })
})
