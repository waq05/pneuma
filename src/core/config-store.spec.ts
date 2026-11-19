/**
 * 「换一份配置文件用」的落盘行为（迁自 `scripts/config-file-switch-test.mjs` 的 [1][2]）。
 *
 * 用户要求：设置里那一行只显示路径 + 复制/打开，得能**换一份文件**来用。做法：路径记在
 * `settings.json` 的 `configFile`（空串 = 出厂那份 `~/.dsc/config.yaml`），配置读取全部改走
 * `activeConfigFile()`。
 *
 * 两段：
 *   [1] `activeConfigFile`：默认 / 换过 / 那份文件不见了（回落出厂，不是崩）；
 *   [2] 读写都落在活动那份上（含 .bak 备份），端点清单跟着换，出厂那份不被动。
 *
 * 宿主方法 `setConfigFile` 的四种拒绝与一次成功要真内核，放在
 * `tests/integration/config-file-switch.int.spec.ts`。
 *
 * 隔离：临时 HOME + 临时配置文件，真实 `~/.dsc` 一个字节都不动。
 * 归 unit 层：全是文件读写，不需要起内核。
 *
 * @module dsc/core/config-store.spec
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录：`config.yaml`、`settings.json`、`credentials.yaml` 都从这里推导。 */
const home = tempHome('dsc-config-file-')
/** `.dsc` 目录。 */
const dscHome = process.env.DSC_HOME ?? join(home.home, '.dsc')
mkdirSync(dscHome, { recursive: true })

type StoreModule = typeof import('./config-store.js')
type ConfigStore = StoreModule
/** 设置文件：`configFile` 偏好就记在这里。 */
const settingsPath = join(dscHome, 'settings.json')

let store: ConfigStore

beforeAll(async () => {
  store = await import('./config-store.js')
})

afterAll(() => {
  home.restore()
})

/** 写一份最小可用的模型配置。 */
function writeYaml(path: string, providerName: string): void {
  writeFileSync(
    path,
    `default:\n  provider: ${providerName}\n  model: m\nproviders:\n  ${providerName}:\n` +
      '    baseURL: http://127.0.0.1:1/v1\n    apiKeyEnv: K\n    models:\n      - id: m\n' +
      '        name: m\n        contextWindow: 1000\n        maxTokens: 100\n',
    'utf8',
  )
}

/** 改「用哪份配置文件」这条偏好，并清掉进程内缓存（真实调用方是 setConfigFile）。 */
function setPref(configFile: string): void {
  const doc = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>) : {}
  writeFileSync(settingsPath, `${JSON.stringify({ ...doc, configFile }, null, 2)}\n`, 'utf8')
  store.invalidateActiveConfigFile()
}

describe('① activeConfigFile：默认 / 换过 / 文件不见了', () => {
  test('没换过就是出厂那份，且在 ~/.dsc 下', () => {
    store.invalidateActiveConfigFile()
    expect(store.activeConfigFile()).toBe(store.DEFAULT_CONFIG_FILE)
    expect(store.DEFAULT_CONFIG_FILE.endsWith(join('.dsc', 'config.yaml'))).toBe(true)
  })

  test('换过之后读的是那一份', () => {
    const custom = join(home.home, 'my-config.yaml')
    writeYaml(custom, 'custom')
    setPref(custom)
    expect(store.activeConfigFile()).toBe(custom)
  })

  test('那一份不见了就回落出厂那份（不崩、也不让端点空掉）', () => {
    setPref(join(home.home, 'gone.yaml'))
    expect(store.activeConfigFile()).toBe(store.DEFAULT_CONFIG_FILE)
  })

  test('空串 = 出厂那份', () => {
    setPref('')
    expect(store.activeConfigFile()).toBe(store.DEFAULT_CONFIG_FILE)
  })

  test('凭据库不跟着换（key 仍从 ~/.dsc 取）', () => {
    expect(store.CREDENTIALS_FILE.endsWith(join('.dsc', 'credentials.yaml'))).toBe(true)
  })
})

describe('② 读写都落在活动那份上', () => {
  test('读出来的是活动那份的端点，端点清单跟着换', () => {
    const custom = join(home.home, 'work-config.yaml')
    writeYaml(custom, 'work')
    setPref(custom)

    const doc = store.readConfigDoc()
    expect(Object.keys(doc.providers ?? {}).join(',')).toBe('work')
    const view = store.readModelConfig()
    expect(view.configFile).toBe(custom)
    expect(view.providers.map((entry) => entry.name).join(',')).toBe('work')
  })

  test('写回也写在活动那份上（覆盖前备份 .bak，出厂那份没被创建/改写）', () => {
    const custom = join(home.home, 'work-config.yaml')
    const doc = store.readConfigDoc()
    store.writeConfigDoc({ ...doc, temperature: 0.5 })
    expect(readFileSync(custom, 'utf8')).toContain('temperature: 0.5')
    expect(existsSync(`${custom}.bak`)).toBe(true)
    expect(existsSync(store.DEFAULT_CONFIG_FILE)).toBe(false)
    setPref('')
  })
})

describe('③ 端点校验与写入口', () => {
  const custom = join(home.home, 'crud-config.yaml')

  /** 一份最小合法草稿。 */
  function draft(overrides: Record<string, unknown> = {}) {
    return {
      oldName: null,
      name: 'demo',
      displayName: '演示',
      baseUrl: 'http://127.0.0.1:1234/v1/',
      models: [{ id: 'm', name: 'm', contextWindow: 1000, maxTokens: 100 }],
      ...overrides,
    } as Parameters<typeof store.upsertProvider>[1]
  }

  function reset(): void {
    // 空配置：CRUD 用例只关心自己写了什么，不让 base 端点混进默认端点回退。
    writeFileSync(custom, '', 'utf8')
    setPref(custom)
  }

  test('validateDraft：名字 / URL / 模型 / 上下文的硬校验', () => {
    expect(() => store.validateDraft(draft())).not.toThrow()
    expect(() => store.validateDraft(draft({ name: 'Bad Name' }))).toThrow(/非法/)
    expect(() => store.validateDraft(draft({ baseUrl: 'ftp://x' }))).toThrow(/http/)
    expect(() => store.validateDraft(draft({ models: [] }))).toThrow(/至少填一个模型/)
    expect(() => store.validateDraft(draft({ models: [{ id: ' ', contextWindow: 1, maxTokens: 1 }] }))).toThrow(/id 是空的/)
    expect(() =>
      store.validateDraft(draft({ models: [{ id: 'm', contextWindow: 0, maxTokens: 1 }] })),
    ).toThrow(/上下文窗口/)
    expect(() =>
      store.validateDraft(draft({ models: [{ id: 'm', contextWindow: 1, maxTokens: 1, thinkingParam: 'bogus' }] })),
    ).toThrow(/思考档位字段/)
  })

  test('upsertProvider：新增写进活动配置，key 名按端点派生，URL 去尾斜杠', () => {
    reset()
    expect(store.upsertProvider(null, draft())).toBe('demo')
    const doc = store.readConfigDoc()
    expect(doc.providers.demo).toMatchObject({
      displayName: '演示',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKeyEnv: 'DEMO_API_KEY',
    })
    expect(doc.providers.demo?.models?.[0]).toMatchObject({ id: 'm', contextWindow: 1000, maxTokens: 100 })
  })

  test('upsertProvider：改名保留 key 名并让默认端点跟着走；撞名报错', () => {
    reset()
    store.upsertProvider(null, draft({ name: 'first', displayName: '' }))
    store.writeDefaultModel('first', 'm')
    store.upsertProvider('first', draft({ oldName: 'first', name: 'second' }))
    const doc = store.readConfigDoc()
    expect(doc.providers.first).toBeUndefined()
    expect(doc.providers.second?.apiKeyEnv).toBe('FIRST_API_KEY')
    expect(doc.default).toEqual({ provider: 'second', model: 'm' })
    store.upsertProvider(null, draft({ name: 'third' }))
    expect(() => store.upsertProvider('third', draft({ oldName: 'third', name: 'second' }))).toThrow(/已存在/)
  })

  test('deleteProvider：不存在报错；删默认端点后改指第一个或清空', () => {
    reset()
    expect(() => store.deleteProvider('nope')).toThrow(/没有名为/)
    store.upsertProvider(null, draft({ name: 'a' }))
    store.upsertProvider(null, draft({ name: 'b' }))
    store.writeDefaultModel('a', 'm')
    store.deleteProvider('a')
    expect(store.readConfigDoc().default).toEqual({ provider: 'b', model: 'm' })
    store.deleteProvider('b')
    expect(store.readConfigDoc().default).toBeUndefined()
    expect(store.readConfigDoc().providers).toEqual({})
  })

  test('writeDefaultModel：端点/模型不在都报错', () => {
    reset()
    expect(() => store.writeDefaultModel('nope', 'm')).toThrow(/没有名为/)
    store.upsertProvider(null, draft())
    expect(() => store.writeDefaultModel('demo', 'nope')).toThrow(/没有模型/)
    store.writeDefaultModel('demo', 'm')
    expect(store.readConfigDoc().default).toEqual({ provider: 'demo', model: 'm' })
  })

  test('writeTemperature：写数值 / null 删字段', () => {
    reset()
    store.writeTemperature(0.7)
    expect(store.readConfigDoc().temperature).toBe(0.7)
    store.writeTemperature(null)
    expect(store.readConfigDoc().temperature).toBeUndefined()
  })

  test('writeProviderKey：空 ref / 空 key 报错；写入后 keyAvailable 为真，清除后看环境变量', () => {
    reset()
    expect(() => store.writeProviderKey('', 'k')).toThrow(/无法定位/)
    expect(() => store.writeProviderKey('DEMO_KEY', '   ')).toThrow(/是空的/)
    const message = store.writeProviderKey('DEMO_KEY', 'secret')
    expect(message).toContain('已写入')
    expect(store.keyAvailable('DEMO_KEY')).toBe(true)
    delete process.env['DEMO_KEY']
    const cleared = store.writeProviderKey('DEMO_KEY', null)
    expect(cleared).toContain('已清除')
    expect(store.keyAvailable('DEMO_KEY')).toBe(false)
  })

  test('readModelConfig：缺省 name/displayName/keyRef，缺 key 的端点也列出来', () => {
    writeYaml(custom, 'base')
    setPref(custom)
    const view = store.readModelConfig()
    const provider = view.providers[0]!
    expect(provider).toMatchObject({ name: 'base', displayName: 'base', keyRef: 'K', keyConfigured: false })
    expect(provider.models[0]).toMatchObject({ id: 'm', name: 'm', contextWindow: 1000, maxTokens: 100 })
  })
})
