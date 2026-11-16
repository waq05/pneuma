/**
 * settings 插件装配面（`packages/settings/index.ts`）：内置分区、插件分区注册表、
 * 分区读写、偏好广播、模型配置服务与「关于」分区的检查更新。
 *
 * 用假 ctx 跑真 `apply`：内置分区从 `sections()` 读、`values/save/action` 直接调；
 * 偏好与模型配置写的是临时 `DSC_HOME` 下的真文件，所以「保存 → 文件变化 → 读回」
 * 验的是同一套落盘路径。
 *
 * `DSC_HOME` 在任何 import 之前指到临时目录；`config.yaml` 每条用例重建，避免
 * `activeConfigFile()` 的进程内缓存与上一份内容串味。
 *
 * @module dsc/packages/settings/tests/wiring.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DscCoreConfig } from '@pneuma/runtime/core/config.js'
import type { SettingsService } from '@pneuma/runtime/services/types.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-settings-wiring-'))
process.env['DSC_HOME'] = HOME

type SettingsIndex = typeof import('../index.js')

let settingsPlugin: SettingsIndex['settingsPlugin']
let invalidateActiveConfigFile: typeof import('@pneuma/runtime/core/config-store.js')['invalidateActiveConfigFile']
let coreHome: typeof import('@pneuma/runtime/core/path-policy.js')['DSC_HOME']
let kernelApiVersion: typeof import('@pneuma/runtime/core/plugin-registry.js')['KERNEL_API_VERSION']

beforeAll(async () => {
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME).toBe(HOME)
  coreHome = policy.DSC_HOME
  ;({ invalidateActiveConfigFile } = await import('@pneuma/runtime/core/config-store.js'))
  ;({ KERNEL_API_VERSION: kernelApiVersion } = await import('@pneuma/runtime/core/plugin-registry.js'))
  ;({ settingsPlugin } = await import('../index.js'))
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 假 llm：记录当前模型与两个会被设置面调用的写入口。 */
function fakeLlm() {
  return {
    provider: 'deepseek',
    model: 'chat',
    effort: 'default',
    setEffort: vi.fn(),
    setModel: vi.fn(),
    routeTo: vi.fn(() => ({ api: 'openai', baseUrl: 'https://example.invalid', apiKey: 'k', model: 'm' })),
    stream: vi.fn(async () => ({ text: 'ok' })),
  }
}

/** 假审批：reviewer 是「通用」分区 values 的输入。 */
function fakeApproval() {
  return {
    reviewer: 'user',
    setPolicy: vi.fn(),
    setReviewer: vi.fn(),
    decide: vi.fn(async () => 'allow-once' as const),
  }
}

/** 一次 apply 捕获到的东西。 */
interface Harness {
  service: SettingsService
  llm: ReturnType<typeof fakeLlm>
  approval: ReturnType<typeof fakeApproval>
  config: DscCoreConfig & { providers: Record<string, any> }
  systems: string[]
  touches: number
  presets?: Record<string, unknown>
}

/** 假 ctx 跑真 apply；`service` 从 provide 里接。 */
function runSettings(options: {
  presets?: Record<string, unknown>
  llm?: ReturnType<typeof fakeLlm>
  approval?: ReturnType<typeof fakeApproval>
  config?: Record<string, unknown>
} = {}): Harness {
  const llm = options.llm ?? fakeLlm()
  const approval = options.approval ?? fakeApproval()
  const config = (options.config ?? {
    providers: {},
    defaultProvider: '',
    defaultModel: '',
    temperature: undefined,
    language: 'zh',
  }) as Harness['config']
  const systems: string[] = []
  let service: SettingsService | undefined
  let touches = 0
  const services = new Map<string, unknown>()
  if (options.presets !== undefined) services.set('permissionPresets', options.presets)
  const ctx = {
    get(name: string) {
      return services.get(name)
    },
    transcript: {
      system(text: string) {
        systems.push(text)
      },
      touch() {
        touches += 1
      },
    },
    llm,
    approval,
    provide(name: string, value: SettingsService) {
      if (name === 'settings') service = value
    },
  }
  ;(settingsPlugin.apply as (ctx: unknown, config: DscCoreConfig) => void)(ctx, config)
  expect(service, 'settings 服务应当在 apply 里 provide').toBeDefined()
  return { service: service!, llm, approval, config, systems, touches, presets: options.presets }
}

/** 读偏好文件。 */
function savedPrefs(): Record<string, any> {
  const path = join(HOME, 'settings.json')
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

/** 读活动模型配置文件（测试里就是 HOME/config.yaml）。 */
function configYaml(): string {
  return readFileSync(join(HOME, 'config.yaml'), 'utf8')
}

describe('插件对象与内置分区', () => {
  test('服务身份、内核版本与八个内置分区的顺序', () => {
    const harness = runSettings()
    expect(settingsPlugin.name).toBe('settings')
    expect(settingsPlugin.provide).toBe('settings')
    expect(settingsPlugin.inject).toEqual(['llm', 'approval', 'transcript'])
    expect(harness.service.kernelApiVersion).toBe(kernelApiVersion)

    expect(harness.service.sections().map((section) => section.id)).toEqual([
      'general',
      'models',
      'presets',
      'skills',
      'usage',
      'archive',
      'tui',
      'about',
    ])
    expect(harness.service.about()).toMatchObject({
      version: expect.any(String),
      apiVersion: kernelApiVersion,
      home: coreHome,
    })
    expect(harness.service.about().home).toBe(coreHome)
  })

  test('插件分区注册：order、inSettings 的 builtin 标记、退订与内置覆盖被拒', () => {
    const harness = runSettings()
    const transcript = harness.systems

    const off = harness.service.registerSection({
      id: 'demo',
      title: '演示',
      order: 5,
      fields: () => [],
      values: () => ({ x: 1 }),
    })
    const demo = harness.service.sections().find((section) => section.id === 'demo')!
    expect(demo).toMatchObject({ id: 'demo', order: 5, builtin: false, custom: false })
    expect(harness.service.sections().map((section) => section.id).slice(0, 3)).toEqual([
      'general',
      'demo',
      'models',
    ])

    harness.service.registerSection(
      { id: 'demo-settings', title: '演示（进设置页）', fields: () => [], values: () => ({}) },
      { inSettings: true },
    )
    expect(harness.service.sections().find((section) => section.id === 'demo-settings')?.builtin).toBe(true)

    // 覆盖内置分区：拒绝，且不替换原来那一条。
    harness.service.registerSection({ id: 'general', title: '冒充通用', fields: () => [], values: () => ({}) })
    expect(transcript.join('\n')).toContain('插件试图覆盖内置设置分区 general')
    expect(harness.service.sections().find((section) => section.id === 'general')?.title).toBe('通用')

    off()
    expect(harness.service.sections().some((section) => section.id === 'demo')).toBe(false)
  })

  test('values：通用分区读预设/审批/模型服务，终端分区读偏好', async () => {
    const presets = {
      name: 'custom',
      surface: () => ({ options: [{ name: 'safe', label: '安全档' }] }),
    }
    const llm = fakeLlm()
    llm.effort = 'high'
    const approval = fakeApproval()
    approval.reviewer = 'auto-review'
    const config = { providers: {}, defaultProvider: '', defaultModel: '', temperature: 0.7 }
    const harness = runSettings({ presets, llm, approval, config })

    expect(await harness.service.values('general')).toMatchObject({
      permissionPreset: 'custom',
      permissionPresetName: 'AI 审查',
      effort: 'high',
      temperature: '0.7',
      closeToTray: true,
    })
    expect(await harness.service.values('tui')).toMatchObject({
      reasoningDefaultOpen: false,
      'statusBar.model': true,
      'statusBar.effort': false,
    })
    await expect(harness.service.values('nope')).rejects.toThrow('没有名为 nope 的设置分区')
  })
})

describe('通用分区写入', () => {
  test('预设/权限/审阅者/思考强度：非法值拒收，合法值落到服务并回执', async () => {
    const presets = {
      name: 'custom',
      surface: () => ({ options: [] }),
      use: vi.fn((name: string) => `已切到 ${name}`),
    }
    const harness = runSettings({ presets })

    const preset = await harness.service.save('general', 'permissionPreset', 'safe')
    expect(preset).toEqual({ ok: true, notice: '已切到 safe' })
    expect(presets.use).toHaveBeenCalledWith('safe')

    expect(await harness.service.save('general', 'policy', 'yolo')).toMatchObject({
      ok: false,
      error: expect.stringContaining('未知的权限模式'),
    })
    expect(await harness.service.save('general', 'policy', 'readonly')).toMatchObject({
      ok: true,
      notice: expect.stringContaining('只读'),
    })
    expect(harness.approval.setPolicy).toHaveBeenCalledWith('readonly')

    expect(await harness.service.save('general', 'reviewer', 'robot')).toMatchObject({ ok: false })
    expect(await harness.service.save('general', 'reviewer', 'auto-review')).toMatchObject({
      ok: true,
      notice: expect.stringContaining('AI 复核'),
    })
    expect(harness.approval.setReviewer).toHaveBeenCalledWith('auto-review')

    expect(await harness.service.save('general', 'effort', 'extreme')).toMatchObject({ ok: false })
    expect(await harness.service.save('general', 'effort', 'high')).toMatchObject({
      ok: true,
      notice: expect.stringContaining('高'),
    })
    expect(harness.llm.setEffort).toHaveBeenCalledWith('high')
    expect(savedPrefs()['defaultEffort']).toBe('high')

    expect(await harness.service.save('general', 'nope', 1)).toMatchObject({
      ok: false,
      error: expect.stringContaining('未知的设置项'),
    })
  })

  test('预设服务不在时给一句可操作的错误', async () => {
    const harness = runSettings()
    expect(await harness.service.save('general', 'permissionPreset', 'safe')).toMatchObject({
      ok: false,
      error: expect.stringContaining('permission-presets 插件没挂'),
    })
  })

  test('温度与托盘：写文件、回读、回执；follow 删掉温度字段', async () => {
    const harness = runSettings()
    expect(await harness.service.save('general', 'temperature', '0.7')).toMatchObject({
      ok: true,
      notice: '温度已设为 0.7',
    })
    expect(configYaml()).toContain('temperature: 0.7')
    expect(await harness.service.values('general')).toMatchObject({ temperature: '0.7' })

    expect(await harness.service.save('general', 'temperature', 'follow')).toMatchObject({
      ok: true,
      notice: '已改为跟随端点默认',
    })
    expect(configYaml()).not.toContain('temperature')
    expect(await harness.service.values('general')).toMatchObject({ temperature: 'follow' })

    expect(await harness.service.save('general', 'closeToTray', false)).toMatchObject({
      ok: true,
      notice: expect.stringContaining('直接退出'),
    })
    expect(savedPrefs()['closeToTray']).toBe(false)
    expect(await harness.service.values('general')).toMatchObject({ closeToTray: false })
  })
})

describe('终端分区与插件分区写入', () => {
  test('终端分区：思考块回执、状态栏静默成功、未知键拒收', async () => {
    const harness = runSettings()
    expect(await harness.service.save('tui', 'reasoningDefaultOpen', true)).toMatchObject({
      ok: true,
      notice: expect.stringContaining('默认展开'),
    })
    expect(savedPrefs()['ui']?.['reasoningDefaultOpen']).toBe(true)
    expect(await harness.service.values('tui')).toMatchObject({ reasoningDefaultOpen: true })

    expect(await harness.service.save('tui', 'statusBar.model', false)).toEqual({ ok: true })
    expect(savedPrefs()['ui']?.['statusBar']?.['model']).toBe(false)
    expect(await harness.service.values('tui')).toMatchObject({ 'statusBar.model': false })

    expect(await harness.service.save('tui', 'statusBar.nope', true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('未知的设置项'),
    })
    expect(await harness.service.save('tui', 'nope', true)).toMatchObject({ ok: false })
  })

  test('没有写入实现的分区、未知分区与插件分区返回字符串的三种口径', async () => {
    const harness = runSettings()
    expect(await harness.service.save('models', 'x', 1)).toMatchObject({
      ok: false,
      error: 'models 分区不接受写入',
    })
    expect(await harness.service.save('nope', 'x', 1)).toMatchObject({
      ok: false,
      error: '没有名为 nope 的设置分区',
    })

    harness.service.registerSection({ id: 'plain', title: '纯展示', fields: () => [], values: () => ({}) })
    expect(await harness.service.save('plain', 'x', 1)).toMatchObject({
      ok: false,
      error: '纯展示 分区没有实现写入',
    })

    harness.service.registerSection({
      id: 'failing',
      title: '会失败',
      fields: () => [],
      values: () => ({}),
      save: () => '这份值不合规',
    })
    expect(await harness.service.save('failing', 'x', 1)).toMatchObject({ ok: false, error: '这份值不合规' })

    harness.service.registerSection({
      id: 'notice',
      title: '有回执',
      fields: () => [],
      values: () => ({}),
      save: () => ({ notice: '已保存' }),
    })
    expect(await harness.service.save('notice', 'x', 1)).toEqual({ ok: true, notice: '已保存' })
    expect(harness.touches).toBeGreaterThan(0)
  })
})

describe('关于分区与检查更新', () => {
  test('自动检查时机：非法值拒收、合法值落偏好', async () => {
    const harness = runSettings()
    expect(await harness.service.save('about', 'updateCheck', 'hourly')).toMatchObject({
      ok: false,
      error: expect.stringContaining('未知的检查时机'),
    })
    expect(await harness.service.save('about', 'updateCheck', 'daily')).toMatchObject({
      ok: true,
      notice: '已设为每天一次检查',
    })
    expect(savedPrefs()['updateCheck']).toBe('daily')
    expect(await harness.service.values('about')).toMatchObject({ updateCheck: 'daily' })
    expect(await harness.service.save('about', 'nope', 1)).toMatchObject({ ok: false })

    expect(await harness.service.action('about', 'nope')).toMatchObject({
      ok: false,
      error: expect.stringContaining('没有动作'),
    })
    expect(await harness.service.action('nope', 'x')).toMatchObject({ ok: false })
    expect(await harness.service.action('models', 'x')).toMatchObject({ ok: false })
  })

  test('check-update：已是最新 / 有安装器给 update / 没安装器退回 url', async () => {
    const harness = runSettings()
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

    // 同版本：只回一句「已是最新」。
    vi.stubGlobal('fetch', vi.fn(async () => reply({ tag_name: 'v0.0.1' })))
    const same = await harness.service.action('about', 'check-update')
    expect(same).toMatchObject({ ok: true, notice: expect.stringContaining('已是最新') })

    // 新版 + 精确版本的 setup：界面拿 data.kind=update 走「立即更新」。
    vi.stubGlobal('fetch', vi.fn(async () => reply({
      tag_name: 'v999.0.0',
      html_url: 'https://example.invalid/releases/999',
      assets: [{ name: 'pneuma-setup-999.0.0.exe', browser_download_url: 'https://example.invalid/setup.exe', size: 1 }],
    })))
    const update = await harness.service.action('about', 'check-update')
    expect(update).toMatchObject({
      ok: true,
      notice: expect.stringContaining('发现新版 v999.0.0'),
      data: { kind: 'update', version: 'v999.0.0' },
    })

    // 自托管回包没有 assets：退回打开发布页。
    vi.stubGlobal('fetch', vi.fn(async () => reply({ version: '999.0.0', url: 'https://example.invalid/page' })))
    const page = await harness.service.action('about', 'check-update')
    expect(page).toMatchObject({
      ok: true,
      data: { kind: 'url', url: 'https://example.invalid/page' },
    })
  })
})

describe('模型配置服务', () => {
  test('未知端点的三类方法各自抛清；保存/删除端点的错误回执', async () => {
    const harness = runSettings()
    await expect(harness.service.discoverModels('nope')).rejects.toThrow('没有这个端点：nope')
    await expect(harness.service.testConnection('nope')).rejects.toThrow('没有这个端点：nope')

    const draft = {
      oldName: null,
      name: 'Bad Name',
      displayName: '',
      baseUrl: 'not-a-url',
      apiKey: '',
      models: [],
    }
    expect(harness.service.saveProvider(draft as never)).toMatchObject({
      ok: false,
      error: expect.stringContaining('端点名'),
    })
    expect(harness.service.removeProvider('nope')).toMatchObject({
      ok: false,
      error: '没有名为 nope 的端点',
    })
    expect(harness.service.setProviderKey('nope', 'key')).toMatchObject({
      ok: false,
      error: '没有名为 nope 的端点',
    })
    expect(harness.service.setDefaultModel('nope', 'm')).toMatchObject({ ok: false })

    const view = harness.service.modelConfig()
    expect(view.providers).toEqual([])
    expect(view.configFile).toBe(join(HOME, 'config.yaml'))
  })

  test('testConnection 的三道前置：key 为空 / 没有模型', async () => {
    const harness = runSettings({
      config: {
        providers: {
          empty: { baseUrl: 'https://example.invalid', apiKey: '', models: [] },
          noModels: { baseUrl: 'https://example.invalid', apiKey: 'k', models: [] },
        },
      },
    })
    await expect(harness.service.testConnection('empty')).rejects.toThrow('还没有可用的 API key')
    await expect(harness.service.testConnection('noModels')).rejects.toThrow('还没有模型')
  })

  test('setConfigFile：相对路径、不存在、空文件、没有 providers 都拒收', async () => {
    const harness = runSettings()
    expect(harness.service.setConfigFile('relative.yaml')).toMatchObject({
      ok: false,
      error: expect.stringContaining('绝对路径'),
    })
    expect(harness.service.setConfigFile(join(HOME, 'missing.yaml'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('读不了这个文件'),
    })

    const empty = join(HOME, 'empty.yaml')
    writeFileSync(empty, '', 'utf8')
    expect(harness.service.setConfigFile(empty)).toMatchObject({
      ok: false,
      error: expect.stringContaining('解析不出任何内容'),
    })

    const noProviders = join(HOME, 'no-providers.yaml')
    writeFileSync(noProviders, 'foo: 1\n', 'utf8')
    expect(harness.service.setConfigFile(noProviders)).toMatchObject({
      ok: false,
      error: expect.stringContaining('没有 providers 段'),
    })

    // 空串 = 回出厂那份。
    expect(harness.service.setConfigFile('')).toMatchObject({
      ok: true,
      notice: expect.stringContaining('已改回出厂配置'),
    })
    expect(savedPrefs()['configFile']).toBe('')

    const good = join(HOME, 'good.yaml')
    mkdirSync(join(HOME), { recursive: true })
    writeFileSync(
      good,
      'providers:\n  demo:\n    baseURL: https://example.invalid\n    apiKeyEnv: DEMO_KEY\n    models:\n      - id: demo-1\n',
      'utf8',
    )
    expect(harness.service.setConfigFile(good)).toMatchObject({
      ok: true,
      notice: `已换成 ${good}`,
    })
    expect(savedPrefs()['configFile']).toBe(good)
  })
})

describe('偏好广播', () => {
  test('setPrefs 通知监听者；一个监听者炸了不影响另一个；退订生效', async () => {
    const harness = runSettings()
    const seen: boolean[] = []
    let second = 0
    const offFirst = harness.service.watchPrefs(() => {
      throw new Error('监听者炸了')
    })
    harness.service.watchPrefs((prefs) => {
      seen.push(prefs.closeToTray)
      second += 1
    })

    const next = harness.service.setPrefs({ closeToTray: false })
    expect(next.closeToTray).toBe(false)
    expect(seen).toEqual([false])
    expect(second).toBe(1)
    expect(harness.systems.join('\n')).toContain('偏好变更处理失败：监听者炸了')

    offFirst()
    harness.service.setPrefs({ closeToTray: true })
    expect(second).toBe(2)
    expect(harness.service.prefs().closeToTray).toBe(true)

    // 改「新会话默认思考强度」要同步到当前服务，但不改偏好以外的会话状态。
    harness.service.setPrefs({ defaultEffort: 'max' })
    expect(harness.llm.setEffort).toHaveBeenCalledWith('max')
    expect(savedPrefs()['defaultEffort']).toBe('max')
  })
})
