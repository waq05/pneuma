/**
 * 「拉取清单」拿到一个模型 id 之后，按它能查到的信息把**能力**填出来：
 * 上下文窗口、最大输出、思考档位与档位字段、输入模态。
 *
 * 为什么要有它：旧行为是「拉到的模型一律按缺省装」（128k / 8192 / thinking 开关 / 只吃文本），
 * 于是一个 1M 上下文的模型、一个能收图的模型，拉进来都是错的能力——用户得一个个手改
 * （0.6.69 报障第三条）。这里按**四档来源**从强到弱推断，每条都带 `source`，界面照着写提示：
 *
 * 1. `known`：这个 id（或去掉大小写与连字符后同一个 id）**已经在别的端点里配过了**，
 *    直接照抄那份能力。这是最硬的一条——它不是猜的，是用户自己填过一遍的。
 * 2. `marker`：id 里明写着尺寸（`-1m`、`-256k`）或能力词（`-vl`、`vision`）。也是事实，不是猜。
 * 3. `family`：按 id 里的家族名（claude / gemini / glm …）查一张**有限的白名单表**。
 *    这一档是启发式：数字取自各家公开的常见档位，选中率高的那些家族才收，查不到就往下走。
 * 4. `default`：什么都没查到 → 与 `core/model-caps.ts` 的缺省一致（128k / 8192 / 只吃文本），
 *    界面会明说「没查到，按缺省」，别让人以为这是查出来的。
 *
 * 两条口径，改的时候别破坏：
 *
 * - **只推断「填错也不致命」的字段**。上下文窗口、最大输出、输入模态填错只是显示或收窄；
 *   `thinkingParam` 填错会在选了非缺省档位时发一个端点不认的字段（选「默认」档不发字段，
 *   所以不会每条请求都炸）。因此家族表里这一项只在有公开惯例时才写，其余留仓库缺省。
 * - **本模块零运行时依赖**（只 import type），于是探针可以用 Node 的类型擦除直读它。
 *   那几条常量与 `src/core/model-caps.ts` 是同值镜像，探针里对着宿主那份断言，别各写各的。
 *
 * @module dsc-ui-shell/plugins/settings/model-infer
 */
import type { EffortMap, Modality, ProviderModelView, ThinkingLevel, ThinkingParam } from '@dsc/ui'

/** 与 `core/model-caps.ts` 的 `DEFAULT_THINKING_LEVELS` 同值（四档都在）。 */
const DEFAULT_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'high', 'max']
/** 与 `core/model-caps.ts` 的 `DEFAULT_THINKING_PARAM` 同值（DeepSeek 风格的开关）。 */
const DEFAULT_PARAM: ThinkingParam = 'thinking'
/** 与 `core/config.ts` 的模型缺省同值：没写 contextWindow 就是 128000，没写 maxTokens 就是 8192。 */
export const FALLBACK_CONTEXT = 128_000
export const FALLBACK_OUTPUT = 8_192

/** 一份推断结果：能力 + 「从哪来」。 */
export interface InferredCaps {
  contextWindow: number
  maxTokens: number
  thinkingLevels: ThinkingLevel[]
  thinkingParam: ThinkingParam
  effortMap: EffortMap
  modalities: Modality[]
  /** 推断来源（从强到弱）：配过 / id 里写着 / 家族表 / 缺省。 */
  source: 'known' | 'marker' | 'family' | 'default'
  /** 一句人话，界面直接拿去当提示（如「同一个 id 已在「DeepSeek 官方」里配过」）。 */
  note: string
}

/** 家族表里一条：命中即用，`image` / `video` / `param` 没写就不动对应项。 */
interface FamilyRule {
  /** 家族关键词（对着归一化后的 id 做「含」匹配）。 */
  key: string
  contextWindow: number
  maxTokens: number
  image?: boolean
  video?: boolean
  param?: ThinkingParam
  /** 界面提示里那句「这是什么家族」。 */
  label: string
}

/**
 * 家族白名单（启发式，只收能公开查到常见档位的家族；顺序有意义——先匹配的赢，
 * 所以 `deepseek-v4` 必须排在 `deepseek` 前面）。
 */
const FAMILIES: readonly FamilyRule[] = [
  { key: 'deepseekv4', contextWindow: 1_000_000, maxTokens: 65_536, image: true, label: 'DeepSeek V4 家族' },
  { key: 'deepseek', contextWindow: 128_000, maxTokens: 8_192, label: 'DeepSeek 家族' },
  { key: 'claude', contextWindow: 200_000, maxTokens: 64_000, image: true, param: 'reasoning-effort', label: 'Claude 家族' },
  { key: 'gemini', contextWindow: 1_000_000, maxTokens: 65_536, image: true, video: true, param: 'reasoning-effort', label: 'Gemini 家族' },
  { key: 'gpt5', contextWindow: 400_000, maxTokens: 128_000, image: true, param: 'reasoning-effort', label: 'GPT-5 家族' },
  { key: 'gpt4', contextWindow: 128_000, maxTokens: 16_384, image: true, param: 'reasoning-effort', label: 'GPT-4 家族' },
  { key: 'o1', contextWindow: 200_000, maxTokens: 100_000, image: true, param: 'reasoning-effort', label: 'o1' },
  { key: 'o3', contextWindow: 200_000, maxTokens: 100_000, image: true, param: 'reasoning-effort', label: 'o3' },
  { key: 'o4', contextWindow: 200_000, maxTokens: 100_000, image: true, param: 'reasoning-effort', label: 'o4' },
  { key: 'glm', contextWindow: 200_000, maxTokens: 32_768, label: 'GLM 家族' },
  { key: 'qwen', contextWindow: 128_000, maxTokens: 32_768, label: 'Qwen 家族' },
  { key: 'moonshot', contextWindow: 256_000, maxTokens: 32_768, label: 'Kimi / Moonshot 家族' },
  { key: 'kimi', contextWindow: 256_000, maxTokens: 32_768, label: 'Kimi 家族' },
  { key: 'minimax', contextWindow: 1_000_000, maxTokens: 32_768, label: 'MiniMax 家族' },
  { key: 'doubao', contextWindow: 256_000, maxTokens: 32_768, image: true, label: '豆包家族' },
  { key: 'grok', contextWindow: 256_000, maxTokens: 32_768, image: true, param: 'reasoning-effort', label: 'Grok 家族' },
  { key: 'mistral', contextWindow: 128_000, maxTokens: 8_192, label: 'Mistral 家族' },
  { key: 'llama', contextWindow: 128_000, maxTokens: 8_192, label: 'Llama 家族' },
  { key: 'step', contextWindow: 256_000, maxTokens: 32_768, label: 'Step 家族' },
]

/** 归一化：大小写、点、下划线、空格都不算数（`DeepSeek V41 Flash` 与 `deepseek-v4.1-flash` 同一个键）。 */
export function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** id 里明写的尺寸：`-1m` / `-256k` / `_512K`；认不出给 null。 */
export function readSizeMarker(id: string): number | null {
  const match = /(^|[^a-z0-9])(\d+(?:\.\d+)?)\s*([km])(?![a-z0-9])/i.exec(id.toLowerCase())
  if (match === null) return null
  const value = Number(match[2] ?? '')
  if (!Number.isFinite(value) || value <= 0) return null
  const scale = match[3] === 'm' ? 1_000_000 : 1_000
  return Math.round(value * scale)
}

/** id 里明写的能力词：`-vl` / `vision` / `omni` → 照片；`video` / `omni` → 视频。 */
export function readModalityMarkers(id: string): { image: boolean; video: boolean } {
  const text = id.toLowerCase()
  const image = /(^|[^a-z0-9])(vl|vlm|vision|multimodal|omni|image)([^a-z0-9]|$)/.test(text)
  const video = /(^|[^a-z0-9])(video|omni)([^a-z0-9]|$)/.test(text)
  return { image, video }
}

/** 按家族表查一条；查不到给 null。 */
function familyRule(id: string): FamilyRule | null {
  const key = normalizeModelId(id)
  for (const rule of FAMILIES) {
    if (key.includes(rule.key)) return rule
  }
  return null
}

/** 把一份能力清单（宿主那份缺省 or 已配的模型）摊成推断结果。 */
function fromModel(model: ProviderModelView, source: InferredCaps['source'], note: string): InferredCaps {
  return {
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevels: [...model.thinkingLevels],
    thinkingParam: model.thinkingParam,
    effortMap: { ...model.effortMap },
    modalities: [...model.modalities],
    source,
    note,
  }
}

/** 端点清单里已经配过的模型（按归一化 id 索引），供 {@link inferModelCaps} 复用。 */
export interface KnownModel {
  /** 这份能力是哪个端点里配的（提示里报名字用）。 */
  provider: string
  model: ProviderModelView
}

/**
 * 把「所有端点已经配过的模型」建成一张查表。
 *
 * 同 id 出现在多个端点时取第一个「填了上下文窗口」的——都是用户自己填的，取哪份都对，
 * 但没填过窗口的那份（0）没有参考价值。
 */
export function buildKnownIndex(providers: readonly { name: string; displayName: string; models: readonly ProviderModelView[] }[]): Map<string, KnownModel> {
  const index = new Map<string, KnownModel>()
  for (const provider of providers) {
    for (const model of provider.models) {
      const key = normalizeModelId(model.id)
      if (key === '') continue
      const label = provider.displayName === '' ? provider.name : provider.displayName
      const seen = index.get(key)
      if (seen === undefined) {
        index.set(key, { provider: label, model })
        continue
      }
      if (seen.model.contextWindow <= 0 && model.contextWindow > 0) index.set(key, { provider: label, model })
    }
  }
  return index
}

/**
 * 推断一个模型 id 的能力。四档来源从强到弱：配过的 > id 里写着 > 家族表 > 缺省。
 *
 * @param id - 线上拉到的模型 id。
 * @param known - {@link buildKnownIndex} 的产物（省略 = 没有可复用的配置）。
 */
export function inferModelCaps(id: string, known?: ReadonlyMap<string, KnownModel>): InferredCaps {
  const reused = known?.get(normalizeModelId(id))
  if (reused !== undefined) {
    return fromModel(reused.model, 'known', `同一个 id 已在「${reused.provider}」里配过，照抄那份能力`)
  }

  const rule = familyRule(id)
  const marker = readSizeMarker(id)
  const modal = readModalityMarkers(id)
  const contextWindow = marker ?? rule?.contextWindow ?? FALLBACK_CONTEXT
  const maxTokens = rule?.maxTokens ?? FALLBACK_OUTPUT
  const modalities: Modality[] = ['text']
  if (rule?.image === true || modal.image) modalities.push('image')
  if (rule?.video === true || modal.video) modalities.push('video')
  const thinkingParam = rule?.param ?? DEFAULT_PARAM

  if (marker !== null || modal.image || modal.video) {
    const bits: string[] = []
    if (marker !== null) bits.push(`id 里写着 ${String(Math.round(marker / 1000))}k`)
    if (modal.image) bits.push('id 里有视觉词')
    if (modal.video) bits.push('id 里有视频词')
    return {
      contextWindow,
      maxTokens,
      thinkingLevels: [...DEFAULT_LEVELS],
      thinkingParam,
      effortMap: {},
      modalities,
      source: 'marker',
      note: `按 ${bits.join('、')} 填的`,
    }
  }

  if (rule !== null) {
    return {
      contextWindow,
      maxTokens,
      thinkingLevels: [...DEFAULT_LEVELS],
      thinkingParam,
      effortMap: {},
      modalities,
      source: 'family',
      note: `按家族猜的（${rule.label}）：数字是常见档位，拉进来后建议核一眼`,
    }
  }

  return {
    contextWindow: FALLBACK_CONTEXT,
    maxTokens: FALLBACK_OUTPUT,
    thinkingLevels: [...DEFAULT_LEVELS],
    thinkingParam: DEFAULT_PARAM,
    effortMap: {},
    modalities: ['text'],
    source: 'default',
    note: '没查到这个 id 的家族，按缺省填（128k / 8192 / 只吃文本），加完请自己核',
  }
}
