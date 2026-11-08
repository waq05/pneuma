/**
 * 核心配置：读 dsc 自己的 `~/.dsc/config.yaml`（providers + default），
 * 首次运行自动从 dsh 的 settings.yaml 迁移（见 migrate.ts）。
 *
 * key 来源顺序：`apiKeyEnv` 环境变量 → `~/.dsc/credentials.yaml`
 * → `~/.dsh/.credentials.yaml`（兼容回退）。任何情况下不打印 key。
 *
 * 兼容层：`~/.dsc/config.json` 仍可覆盖 default provider/model/temperature。
 *
 * @module dsc/core/config
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DSC_CONFIG_YAML,
  DSC_CREDENTIALS,
  DSH_CREDENTIALS,
  migrateFromDsh,
  parseTolerantYaml,
  type FileConfig,
  type FileProvider,
} from './migrate.js'
import { activeConfigFile } from './config-store.js'
import { readModelCaps, type ModelCaps } from './model-caps.js'
import { DEFAULT_LANGUAGE, languageOfConfig } from './plugin-locale.js'
import { dscPath } from './path-policy.js'

/** 一个可对话的模型（能力声明见 core/model-caps.ts）。 */
export interface ModelInfo extends ModelCaps {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

/** 一个模型端点（线上协议由 `api` 选择，缺省 OpenAI 兼容；协议适配器见 llm 插件）。 */
export interface ProviderConfig {
  name: string
  displayName: string
  baseUrl: string
  apiKey: string
  /** 协议适配器 id；缺省 openai-completions。 */
  api?: string
  /**
   * 端点声明支持显式前缀缓存标记（内容块上的 `cache_control`）。
   * 缺省 undefined = 不支持 = 请求体逐字节不变；见 core/llm.ts 的 `applyExplicitCache`。
   */
  cacheControl?: boolean
  models: ModelInfo[]
}

/** 解析后的核心配置。 */
export interface DscCoreConfig {
  providers: Record<string, ProviderConfig>
  defaultProvider: string
  defaultModel: string
  /** 采样参数覆盖（缺省用端点默认）。 */
  temperature?: number
  /**
   * 界面语言（`config.yaml` 的 `language:`）。缺省 'zh-CN'。
   *
   * 现在只影响插件清单那两行字（`pneuma.title` / `pneuma.description` 的译本，
   * 见 core/plugin-locale）：`en` 开头取 `locale/en.json`，其余用清单原文。
   */
  language?: string
}

/**
 * 模型请求的超时与重试（`config.yaml` 顶层的 `llm:` 段）。
 *
 * 为什么要这一层：这三个数以前只能靠环境变量（`DSC_LLM_*`）改，而环境变量只在自检脚本里
 * 好使——用户撞上「某个网关在大提示词下三十秒吐不出响应头」时，手上没有任何可改的地方
 * （2026-11-07 的 PTC 实拍就是这么连挂五次）。端点是用户自己配的，它的脾气也该写在用户
 * 自己那份配置里。
 *
 * 优先级：环境变量（自检要能临时盖一次而不动配置文件）→ 这一段 → 内置默认。
 */
export interface LlmTuning {
  /** 建连 + 响应头的最长等待（毫秒）。 */
  connectTimeoutMs?: number
  /** 流空闲超时（毫秒）：这么久一个字节都没到就判服务端挂起。 */
  streamIdleMs?: number
  /** 一条请求最多发起几次（含首试）。 */
  retryAttempts?: number
}

/** 三个数的合法区间：写得离谱也不该把端点等死，或让重试瞬时间全失败。 */
const TUNING_RANGE = {
  connectTimeoutMs: { min: 1_000, max: 600_000 },
  streamIdleMs: { min: 5_000, max: 600_000 },
  retryAttempts: { min: 1, max: 20 },
} as const

/** 读一个数：认不出或不是正数就当没写；认得出就夹进区间。 */
function readTuningNumber(raw: unknown, min: number, max: number): number | undefined {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.max(Math.round(value), min), max)
}

/** 按「文件 + mtime」缓存：这两个数每次请求都要读，落盘一次就够了。 */
let tuningCache: { file: string; mtimeMs: number; tuning: LlmTuning } | null = null

/**
 * 读 `config.yaml` 的 `llm:` 段。文件不在、没这一段、或者写坏了，一律返回空对象
 * （调用方各自回落到内置默认）——配置读不出来不该让一次对话发不出去。
 */
export function readLlmTuning(): LlmTuning {
  const file = activeConfigFile()
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return {}
  }
  if (tuningCache !== null && tuningCache.file === file && tuningCache.mtimeMs === mtimeMs) return tuningCache.tuning
  let tuning: LlmTuning = {}
  try {
    const doc = parseTolerantYaml(readFileSync(file, 'utf8')) as unknown as FileConfig
    const raw = doc.llm as Record<string, unknown> | undefined
    if (raw !== undefined && raw !== null && typeof raw === 'object') {
      const connectTimeoutMs = readTuningNumber(raw['connectTimeoutMs'], TUNING_RANGE.connectTimeoutMs.min, TUNING_RANGE.connectTimeoutMs.max)
      const streamIdleMs = readTuningNumber(raw['streamIdleMs'], TUNING_RANGE.streamIdleMs.min, TUNING_RANGE.streamIdleMs.max)
      const retryAttempts = readTuningNumber(raw['retryAttempts'], TUNING_RANGE.retryAttempts.min, TUNING_RANGE.retryAttempts.max)
      tuning = {
        ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
        ...(streamIdleMs === undefined ? {} : { streamIdleMs }),
        ...(retryAttempts === undefined ? {} : { retryAttempts }),
      }
    }
  } catch {
    tuning = {}
  }
  tuningCache = { file, mtimeMs, tuning }
  return tuning
}

const DSC_CONFIG_JSON = dscPath('config.json')

/**
 * 把凭据库的 refs 段（env 名 → key 值）注入 process.env：dsc 自己的
 * 凭据文件优先，dsh 的作兼容回退。只注入缺失项。
 */
function loadCredentials(): void {
  for (const file of [DSC_CREDENTIALS, DSH_CREDENTIALS]) {
    if (!existsSync(file)) continue
    try {
      const doc = parseTolerantYaml(readFileSync(file, 'utf8')) as { refs?: Record<string, unknown> }
      for (const [name, value] of Object.entries(doc.refs ?? {})) {
        if (typeof value === 'string' && value !== '' && process.env[name] === undefined) {
          process.env[name] = value
        }
      }
    } catch {
      // 单个凭据文件坏了不影响另一个
    }
  }
}

/** 把文件里的 provider 形状转成运行时形状（key 缺失的端点不注册）。 */
function toProvider(name: string, raw: FileProvider): ProviderConfig | null {
  const apiKey = raw.apiKeyEnv !== undefined ? (process.env[raw.apiKeyEnv] ?? '') : ''
  if (apiKey === '') return null
  // api 字段自给自足（不依赖别的能力声明），写错了当场说，不留到发请求才炸
  if (raw.api !== undefined && (typeof raw.api !== 'string' || raw.api.trim() === '')) {
    throw new Error(`config.yaml 端点 ${name} 的 api 字段写法不对：要填协议适配器 id（如 openai-completions）`)
  }
  return {
    name,
    displayName: raw.displayName ?? name,
    baseUrl: raw.baseURL.replace(/\/+$/, ''),
    apiKey,
    ...(raw.api !== undefined ? { api: raw.api.trim() } : {}),
    // 只有显式写了 true 才算支持（宽容读：写错的值一律按不支持，绝不误伤默认路由）
    ...(raw.cacheControl === true ? { cacheControl: true } : {}),
    models: raw.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 128_000,
      maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : 8_192,
      // 能力字段缺省时等价于旧行为：thinking 开关 + 四档 + 只吃文本
      ...readModelCaps(model),
    })),
  }
}

/**
 * 读配置。缺配置时先尝试从 dsh 迁移；provider 全空时返回空表
 * （boot 会把"没有可用端点"报给 UI，而不是崩溃）。
 */
export function readConfig(): DscCoreConfig {
  const file = activeConfigFile()
  // 从 dsh 迁移只往**出厂那份**里写：换过配置文件的人自己选了一份，不该被迁移结果盖掉。
  if (file === DSC_CONFIG_YAML && !existsSync(DSC_CONFIG_YAML)) migrateFromDsh()
  loadCredentials()

  const providers: Record<string, ProviderConfig> = {}
  let defaultProvider = ''
  let defaultModel = ''
  let temperature: number | undefined
  // 语言没配就是中文：清单原文（pneuma.title/description）本来就是中文写的。
  let language: string = DEFAULT_LANGUAGE

  if (existsSync(file)) {
    const doc = parseTolerantYaml(readFileSync(file, 'utf8')) as unknown as FileConfig
    if (typeof doc.default?.provider === 'string') defaultProvider = doc.default.provider
    if (typeof doc.default?.model === 'string') defaultModel = doc.default.model
    if (typeof doc.temperature === 'number') temperature = doc.temperature
    language = languageOfConfig(doc)
    for (const [name, raw] of Object.entries(doc.providers ?? {})) {
      const provider = toProvider(name, raw)
      if (provider !== null) providers[name] = provider
    }
  }

  if (existsSync(DSC_CONFIG_JSON)) {
    try {
      const overrides = JSON.parse(readFileSync(DSC_CONFIG_JSON, 'utf8')) as {
        provider?: string
        model?: string
        temperature?: number
      }
      if (typeof overrides.provider === 'string') defaultProvider = overrides.provider
      if (typeof overrides.model === 'string') defaultModel = overrides.model
      if (typeof overrides.temperature === 'number') temperature = overrides.temperature
    } catch {
      // 覆盖文件坏了就当没有
    }
  }

  // 默认路由指向不存在的 provider/model 时退回第一个可用组合
  if (providers[defaultProvider] === undefined) {
    const first = Object.keys(providers)[0]
    if (first !== undefined) {
      defaultProvider = first
      defaultModel = providers[first].models[0]?.id ?? ''
    } else {
      defaultProvider = ''
      defaultModel = ''
    }
  } else if (!providers[defaultProvider].models.some((model) => model.id === defaultModel)) {
    defaultModel = providers[defaultProvider].models[0]?.id ?? ''
  }

  return { providers, defaultProvider, defaultModel, temperature, language }
}

