/**
 * 核心配置（`core/config.ts`）的边界补齐：凭据注入与按名取 key、config.json 覆盖、
 * 默认路由回退、`api` 字段写错的报错、llm 调参读取（含坏文件兜底）、
 * 工作区根去重。
 *
 * 所有路径常量都在 import 期由 `DSC_HOME`/`HOME` 定死，所以先建临时目录、把环境
 * 指过去，再动态 import 被测模块；每个改配置的用例都自己还原，不依赖执行顺序。
 *
 * @module dsc/core/w12-config-extra.spec
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'

const home = createTempDir('dsc-w12-config-home-')
const previous = {
  DSC_HOME: process.env['DSC_HOME'],
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
}
process.env['DSC_HOME'] = home
process.env['HOME'] = home
process.env['USERPROFILE'] = home

/** config.yaml 主内容：alpha 有 key、beta 没 key（应被过滤）、默认路由合法。 */
const MAIN_YAML = `default:
  provider: alpha
  model: m1
temperature: 0.2
language: en
llm:
  connectTimeoutMs: 500000
  streamIdleMs: 1
  retryAttempts: 3
providers:
  alpha:
    displayName: Alpha
    baseURL: https://api.example.com/
    apiKeyEnv: ALPHA_KEY
    models:
      - id: m1
        name: Model One
  beta:
    baseURL: https://beta.example.com
    apiKeyEnv: BETA_KEY
    models:
      - id: b1
`

const CONFIG_YAML = join(home, 'config.yaml')
const CONFIG_JSON = join(home, 'config.json')
const CREDENTIALS = join(home, 'credentials.yaml')

/** mtime 递增计数：tuning 缓存按「文件 + mtime」命中，同一毫秒内重写会读回旧值。 */
let clock = Math.floor(Date.now() / 1000) - 10_000

function writeConfig(text: string): void {
  writeFileSync(CONFIG_YAML, text, 'utf8')
  clock += 2
  utimesSync(CONFIG_YAML, clock, clock)
}

type ConfigModule = typeof import('./config.js')
let config: ConfigModule

beforeAll(async () => {
  writeFileSync(CREDENTIALS, 'refs:\n  ALPHA_KEY: sk-alpha-from-file\n', 'utf8')
  writeConfig(MAIN_YAML)
  config = await import('./config.js')
})

afterAll(() => {
  for (const key of ['DSC_HOME', 'HOME', 'USERPROFILE'] as const) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
})

describe('readConfig', () => {
  test('读端点/默认路由/采样温度/语言；无 key 的端点被过滤', () => {
    const parsed = config.readConfig()
    expect(Object.keys(parsed.providers)).toEqual(['alpha'])
    const alpha = parsed.providers['alpha']!
    expect(alpha.displayName).toBe('Alpha')
    expect(alpha.baseUrl).toBe('https://api.example.com')
    expect(alpha.apiKey).toBe('sk-alpha-from-file')
    expect(alpha.models.map((model) => model.id)).toEqual(['m1'])
    expect(parsed.defaultProvider).toBe('alpha')
    expect(parsed.defaultModel).toBe('m1')
    expect(parsed.temperature).toBe(0.2)
    expect(parsed.language).toBe('en')
  })

  test('凭据库的 refs 注入 process.env（只补缺失项）', () => {
    // readConfig 已调用过 loadCredentials
    expect(process.env['ALPHA_KEY']).toBe('sk-alpha-from-file')
    config.readConfig()
    // 已存在时不覆盖
    process.env['ALPHA_KEY'] = 'sk-manual'
    config.readConfig()
    expect(process.env['ALPHA_KEY']).toBe('sk-manual')
    process.env['ALPHA_KEY'] = 'sk-alpha-from-file'
  })

  test('config.json 覆盖默认端点/模型/温度', () => {
    writeFileSync(CONFIG_JSON, JSON.stringify({ provider: 'alpha', model: 'm1', temperature: 0.9 }), 'utf8')
    try {
      const parsed = config.readConfig()
      expect(parsed.temperature).toBe(0.9)
      expect(parsed.defaultProvider).toBe('alpha')
      expect(parsed.defaultModel).toBe('m1')
    } finally {
      rmSync(CONFIG_JSON, { force: true })
    }
  })

  test('默认模型不在端点里：回退到该端点的第一个模型', () => {
    writeFileSync(CONFIG_JSON, JSON.stringify({ provider: 'alpha', model: 'no-such-model' }), 'utf8')
    try {
      expect(config.readConfig().defaultModel).toBe('m1')
    } finally {
      rmSync(CONFIG_JSON, { force: true })
    }
  })

  test('默认端点不存在：回退到第一个可用端点与其第一个模型', () => {
    writeFileSync(CONFIG_JSON, JSON.stringify({ provider: 'ghost' }), 'utf8')
    try {
      const parsed = config.readConfig()
      expect(parsed.defaultProvider).toBe('alpha')
      expect(parsed.defaultModel).toBe('m1')
    } finally {
      rmSync(CONFIG_JSON, { force: true })
    }
  })

  test('端点 api 字段写成空串：当场报错，不留到发请求', () => {
    writeConfig(MAIN_YAML.replace('    apiKeyEnv: ALPHA_KEY', "    apiKeyEnv: ALPHA_KEY\n    api: '   '"))
    try {
      expect(() => config.readConfig()).toThrow(/api 字段写法不对/)
    } finally {
      writeConfig(MAIN_YAML)
    }
  })
})

describe('readLlmTuning', () => {
  test('三个数各自夹进区间（500000 保留、1 抬到下限、3 保留）', () => {
    expect(config.readLlmTuning()).toEqual({
      connectTimeoutMs: 500_000,
      streamIdleMs: 5_000,
      retryAttempts: 3,
    })
  })

  test('配置文件读不出来（这里把路径换成目录）：返回空对象，不抛', () => {
    rmSync(CONFIG_YAML, { force: true })
    mkdirSync(CONFIG_YAML)
    clock += 2
    utimesSync(CONFIG_YAML, clock, clock)
    try {
      expect(config.readLlmTuning()).toEqual({})
    } finally {
      rmSync(CONFIG_YAML, { recursive: true, force: true })
      writeConfig(MAIN_YAML)
    }
  })
})

describe('resolveCredentialRef', () => {
  test('环境变量优先于凭据文件；都没有返回空串', () => {
    process.env['W12_REF'] = '  from-env  '
    try {
      expect(config.resolveCredentialRef('W12_REF')).toBe('from-env')
      expect(config.resolveCredentialRef('ALPHA_KEY')).toBe('sk-alpha-from-file')
      expect(config.resolveCredentialRef('W12_NOT_CONFIGURED')).toBe('')
    } finally {
      delete process.env['W12_REF']
    }
  })
})

describe('工作区根去重', () => {
  test('同一个目录写两遍只留一条；被外层包含的根被丢掉', () => {
    const parent = join(home, 'ws-parent')
    const child = join(parent, 'ws-child')
    mkdirSync(child, { recursive: true })
    expect(config.dedupeContainedWorkspaceRoots([parent, parent])).toEqual([parent])
    expect(config.dedupeContainedWorkspaceRoots([parent, child])).toEqual([parent])
    // 主根（下标 0）永远保留，哪怕它被后面的根包住
    expect(config.dedupeContainedWorkspaceRoots([child, parent])).toEqual([child, parent])
  })
})
