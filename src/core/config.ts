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
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  DSC_CONFIG_YAML,
  DSC_CREDENTIALS,
  DSH_CREDENTIALS,
  migrateFromDsh,
  parseTolerantYaml,
  type FileConfig,
  type FileProvider,
} from './migrate.js'
import { activeConfigFile, readConfigDoc, writeConfigDoc } from './config-store.js'
import { readModelCaps, type ModelCaps } from './model-caps.js'
import { DEFAULT_LANGUAGE, languageOfConfig } from './plugin-locale.js'
import { dscPath, expandHome } from './path-policy.js'

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

// ── 工作区根（多工作区 / 异根 @ 补全的安全边界） ────────────────────────────────

/** `config.yaml` 里工作区根清单的键名。 */
const WORKSPACE_ROOTS_KEY = 'workspaceRoots'

/** 配置里的工作区根：原文（供设置页回显）、可用根（绝对路径）、被丢弃的原文。 */
export interface WorkspaceRootsConfig {
  /** 配置里的条目原文（已按分号/换行拆开、去空白）。 */
  raw: string[]
  /** 存在且是目录的根，规范化成绝对路径，按大小写不敏感去重。 */
  roots: string[]
  /** 不存在或不是目录的条目原文：留着给设置页提示，不参与授权。 */
  invalid: string[]
}

/**
 * 把配置值拆成条目：认 YAML 数组，也认分号/换行分隔的一段文本；
 * 非字符串（数字、对象、null）一律当没写，绝不抛。
 */
function splitWorkspaceRoots(value: unknown): string[] {
  const out: string[] = []
  const take = (item: unknown): void => {
    if (typeof item !== 'string') return
    for (const part of item.split(/[;\r\n]/)) {
      const text = part.trim()
      if (text !== '') out.push(text)
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) take(item)
  } else {
    take(value)
  }
  return out
}

/** 比较键：大小写不敏感 + 去尾分隔符（Windows 下 `D:\work` 与 `d:\work\` 是同一个根）。 */
function workspaceRootKey(path: string): string {
  return resolve(path).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * 两个路径是不是同一个工作区根。只比「同一个目录」，不判包含关系——
 * 包含关系由调用方（dock 的 `inside`）在授权之后再判一次。
 */
export function sameWorkspaceRoot(left: string, right: string): boolean {
  return workspaceRootKey(left) === workspaceRootKey(right)
}

/**
 * 解析符号链接后的比较键：junction / 8.3 短名 / 大小写不同但实际同一个目录的两个根，
 * 只有走 realpath 才折得到一起（配置里两条写法不同的路径并不罕见）。目录不在时退回
 * 字面路径——不存在的根反正一个文件也列不出来。
 */
function realWorkspaceRootKey(path: string): string {
  try {
    return workspaceRootKey(realpathSync(path))
  } catch {
    return workspaceRootKey(path)
  }
}

/** `child` 与 `parent` 相同，或落在 `parent` 里面（两边都是 {@link workspaceRootKey} 的形态）。 */
function rootContains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 去掉「被另一个根包含」的根（按 realpath 判，路径写法不同不影响）。
 *
 * 为什么保留外层、丢掉内层：外层遍历时内层里的每个文件本来就会列出来，丢掉内层一条候选
 * 都不少；反过来丢掉外层，内层之外的目录就一条都列不出来。
 *
 * 主根（下标 0）是唯一例外，**永远不丢**：它承载「主根用相对路径、其余根用绝对路径」这个
 * 命名空间，也是会话自己的工作目录，丢了整份清单就没了基准。包住主根的额外根也保留
 * （它是更大范围的授权，授权层不能因为「已被主根覆盖」就收回）；列清单时由调用方跳过
 * 主根那棵子树，避免同一批文件算两遍（见 `core/mention.ts`）。
 *
 * 只处理「同一批文件被列两遍」这层：授权集合本身按这个清单给，所以清单必须是不重复的。
 */
export function dedupeContainedWorkspaceRoots(roots: readonly string[]): string[] {
  if (roots.length <= 1) return [...roots]
  const keys = roots.map(realWorkspaceRootKey)
  // 只从下标 1 开始丢：主根不许消失。
  const keep = roots.map(() => true)
  // 完全同一个目录（配置里写了两遍、写法不同）只留靠前的那条。
  const firstByKey = new Map<string, number>()
  for (const [index, key] of keys.entries()) {
    const first = firstByKey.get(key)
    if (first === undefined) firstByKey.set(key, index)
    else if (index > 0) keep[index] = false
  }
  for (let index = 1; index < roots.length; index += 1) {
    if (!keep[index]) continue
    for (let other = 0; other < roots.length; other += 1) {
      if (other === index || !keep[other]) continue
      if (rootContains(keys[other]!, keys[index]!)) {
        keep[index] = false
        break
      }
    }
  }
  return roots.filter((_, index) => keep[index])
}

/** 把原文条目归一成「可用根 + 被丢弃的原文」；不存在/不是目录的条目只进 invalid。 */
function normalizeWorkspaceRoots(raw: readonly string[]): WorkspaceRootsConfig {
  const roots: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const text = entry.trim()
    if (text === '') continue
    const expanded = expandHome(text)
    // 相对路径按用户主目录展开：配置文件是用户的，不是某个进程的启动目录。
    const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(homedir(), expanded)
    let directory = false
    try {
      directory = statSync(absolute).isDirectory()
    } catch {
      directory = false
    }
    if (!directory) {
      invalid.push(text)
      continue
    }
    const key = workspaceRootKey(absolute)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(absolute)
  }
  return { raw: [...raw], roots, invalid }
}

/**
 * 读 `config.yaml` 的 `workspaceRoots:`。文件不在、整份写坏、值类型不对都返回空清单，
 * 不抛——配置读不出来不该让文件面板与 @ 补全起不来。
 *
 * 每次现读（不缓存）：这个清单只在打开面板/敲 @ 时用，且用户改完设置应立刻生效。
 */
export function readWorkspaceRootsConfig(): WorkspaceRootsConfig {
  const file = activeConfigFile()
  let doc: Record<string, unknown> = {}
  try {
    doc = parseTolerantYaml(readFileSync(file, 'utf8'))
  } catch {
    doc = {}
  }
  return normalizeWorkspaceRoots(splitWorkspaceRoots(doc[WORKSPACE_ROOTS_KEY]))
}

/**
 * 已授权的工作区根：**会话 cwd 永远第一个**，后面是配置里存在且去重过的根。
 *
 * 这是「界面能切到哪些根」的唯一真源：dock 的 `fs-list` 只认这份清单里的值，
 * 渲染进程传来的任意路径都不会被当成根。放在 config 模块而不是每个调用方各拼一份，
 * 是为了让授权集合只有一处定义（改口径只改这里）。
 *
 * 互相嵌套的根在这里按 realpath 收成一份（{@link dedupeContainedWorkspaceRoots}）：
 * 被别的根包含的那条不再单独列，否则拿这份清单去遍历时同一批文件会被列两遍、把
 * @ 补全的 4000 条预算吃掉一半。主根与「包住主根的根」都保留，见那个函数的说明。
 */
export function allowedWorkspaceRoots(cwd: string): string[] {
  const main = resolve(cwd)
  const out = [main]
  const seen = new Set([workspaceRootKey(main)])
  for (const root of readWorkspaceRootsConfig().roots) {
    const key = workspaceRootKey(root)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return dedupeContainedWorkspaceRoots(out)
}

/**
 * 把请求的根对到已授权清单里：命中返回清单里的规范路径，不在清单里返回 null。
 * 只认「等于某个已授权根」，不认子目录——界面切根只能切整根，不能借一个子路径扩权。
 */
export function matchWorkspaceRoot(requested: string, cwd: string): string | null {
  for (const root of allowedWorkspaceRoots(cwd)) {
    if (sameWorkspaceRoot(root, requested)) return root
  }
  return null
}

/**
 * 写回 `config.yaml` 的 `workspaceRoots`（设置分区「额外工作区根」的保存路径）。
 * 原文原样落盘（不存在的条目也留着，用户下回还能看见并改），返回值同读取口径。
 */
export function writeWorkspaceRootsConfig(text: string): WorkspaceRootsConfig {
  const raw = splitWorkspaceRoots(text)
  const doc = readConfigDoc()
  const record = doc as unknown as Record<string, unknown>
  if (raw.length === 0) delete record[WORKSPACE_ROOTS_KEY]
  else record[WORKSPACE_ROOTS_KEY] = raw
  writeConfigDoc(doc)
  return normalizeWorkspaceRoots(raw)
}

const DSC_CONFIG_JSON = dscPath('config.json')

/**
 * 按名字取一个凭据：`process.env` → `~/.dsc/credentials.yaml` 的 refs → `~/.dsh/.credentials.yaml`。
 *
 * 与 {@link loadCredentials} 是同一条优先级，区别是这里**现读现取、不往 process.env 里注**：
 * 插件在运行中才用到 key（比如联网搜索每次调用都读一遍），靠「启动时注过 env」这种时序巧合
 * 会出问题——插件比读配置早挂载一个节拍，key 就是空的。任何情况下都不打印 key 本身。
 *
 * @param name 凭据名（就是环境变量的名字，例如 `DEEPSEEK_API_KEY`）
 * @returns 取到的 key；哪一处都没配就是空串
 */
export function resolveCredentialRef(name: string): string {
  const fromEnv = process.env[name]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  for (const file of [DSC_CREDENTIALS, DSH_CREDENTIALS]) {
    if (!existsSync(file)) continue
    try {
      const doc = parseTolerantYaml(readFileSync(file, 'utf8')) as { refs?: Record<string, unknown> }
      const value = doc.refs?.[name]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch {
      // 单个凭据文件坏了不影响另一个
    }
  }
  return ''
}

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

