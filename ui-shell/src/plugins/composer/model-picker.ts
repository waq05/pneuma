/**
 * 输入区「模型 / 思考档位」两颗 chip 的纯逻辑（对照 ZCode 的模型选择器与档位控件）。
 *
 * 为什么把逻辑从 `ui.tsx` 抽出来：这两颗钮的读数与打勾规则要能被探针逐条钉住，而
 * `.tsx` 读不了（Node 的类型擦除不认识 JSX）。所以这里**零运行时依赖**（只 import type），
 * 与 `draft.ts` / `git-branch.ts` 同一路数——探针直读本模块跑真断言，界面的 tsx 只负责画。
 *
 * 三处与旧版（合并浮层那一版）不同的口径，都是修**看得见的错**：
 *
 * 1. **档位清单恒含「默认」**。宿主把 `default` 当合法且恒可选的档位
 *    （`src/core/model-caps.ts` 的 `hasEffortLevel`），旧版在模型能查到时只列了模型声明的
 *    四档，于是 `status.effort === 'default'` 时四个按钮一个都不亮、选完也回不去默认。
 * 2. **当前模型按「端点 + 裸名」精确定位**。宿主 `status.model` 是裸名（`status.provider`
 *    才是端点），而清单里 `value` 是 `端点/模型`；旧版拿 `value === model` 判勾，除非用户
 *    的 value 恰好等于裸名，勾永远不出现。同一个模型 id 挂两个端点时更要靠端点分辨。
 * 3. **一级只在多端点时出现**。只有一个端点时前缀与一级列表都是噪音，直接扁铺
 *    （ZCode 的 `showProviderLevel` 同款开关）。
 *
 * @module dsc-ui-shell/plugins/composer/model-picker
 */
import type { EffortLevel, ModelChoiceView, ThinkingLevel } from '@dsc/ui'

/** 一级菜单一行：一个端点 + 它名下的模型（顺序照宿主给的清单，不重排）。 */
export interface ProviderGroup {
  /** 端点名（config.yaml 里那一节的 `name`，也是 `value` 的前缀）。 */
  provider: string
  /** 端点显示名；宿主没填时等于端点名。一级行画它。 */
  displayName: string
  models: readonly ModelChoiceView[]
}

/**
 * 档位文案。**与 `src/core/model-caps.ts` 的 `THINKING_LEVEL_LABELS` 是同值镜像**
 * （探针里对着宿主那份断言，别只改一边）：多出来的 `default` 是「不发思考字段」那一档。
 */
export const EFFORT_LABELS: Readonly<Record<EffortLevel, string>> = {
  default: '默认',
  off: '关',
  low: '低',
  high: '高',
  max: '最大',
}

/** 清单里查不到这个模型时给的兜底档位（不锁死用户：真发出去的东西由宿主校验）。 */
export const EFFORT_FALLBACK: readonly EffortLevel[] = ['default', 'off', 'low', 'high', 'max']

/** 按端点归组（同端点的排在一起，第一条出现的顺序即端点的顺序）。 */
export function groupModels(choices: readonly ModelChoiceView[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>()
  const buckets = new Map<string, ModelChoiceView[]>()
  for (const choice of choices) {
    const bucket = buckets.get(choice.provider)
    if (bucket === undefined) buckets.set(choice.provider, [choice])
    else bucket.push(choice)
    if (!groups.has(choice.provider)) {
      groups.set(choice.provider, {
        provider: choice.provider,
        displayName: choice.providerDisplayName === '' ? choice.provider : choice.providerDisplayName,
        models: [],
      })
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    models: buckets.get(group.provider) ?? [],
  }))
}

/** 当前模型在清单里落到了哪一行（`exact` = 端点与裸名都对上，不是猜的）。 */
export interface CurrentModel {
  entry: ModelChoiceView | undefined
  group: ProviderGroup | undefined
  /** 端点与裸名都命中 = true；靠 `value` 或裸名回落命中 = false；没命中 = false。 */
  exact: boolean
}

/**
 * 定位当前模型。
 *
 * 三级判据从硬到软：**端点 + 裸名** → `value` 全等（`status.model` 可能是完整值：
 * 远程页与老记录里存在这种形态）→ 裸名（清单里第一个同名的，可能不是真正在用的那一个，
 * 所以只算软命中）。全都落空时 `entry` 为 undefined，界面据此如实显示「清单里没有」。
 */
export function findCurrent(
  groups: readonly ProviderGroup[],
  provider: string,
  model: string,
): CurrentModel {
  if (model === '') return { entry: undefined, group: undefined, exact: false }
  if (provider !== '') {
    const group = groups.find((item) => item.provider === provider)
    const entry = group?.models.find((item) => item.model === model)
    if (entry !== undefined && group !== undefined) return { entry, group, exact: true }
  }
  for (const group of groups) {
    const entry = group.models.find((item) => item.value === model)
    if (entry !== undefined) return { entry, group, exact: group.provider === provider }
  }
  for (const group of groups) {
    const entry = group.models.find((item) => item.model === model)
    if (entry !== undefined) return { entry, group, exact: false }
  }
  return { entry: undefined, group: undefined, exact: false }
}

/** 模型 chip 上那两段字：前缀（端点）可能被窄屏收掉，名字永远留着。 */
export interface ModelChipText {
  /** `显示名/`；只有一个端点、或端点未知时是空串。 */
  prefix: string
  /** 模型名；清单里查不到时原样显示宿主给的那个值，不吞也不改。 */
  name: string
  /** 一并给出悬浮说明用的全称（窄屏把前缀收掉后还能悬停看全）。 */
  full: string
}

/**
 * 模型 chip 显示什么。
 *
 * 只有一个端点时不带前缀：那是纯粹的噪音（ZCode 也只在非内置连接上拼前缀）。
 * 端点未知（老快照没有 `provider`）或清单空时同样不带前缀，名字一律照实显示。
 */
export function modelChipText(
  groups: readonly ProviderGroup[],
  provider: string,
  model: string,
): ModelChipText {
  const current = findCurrent(groups, provider, model)
  const name = current.entry?.model ?? (model === '' ? '未知模型' : model)
  const displayName =
    current.group?.displayName ?? groups.find((item) => item.provider === provider)?.displayName ?? provider
  const usable = groups.length > 1 && displayName !== '' && name !== '未知模型'
  const prefix = usable ? `${displayName}/` : ''
  return { prefix, name, full: `${prefix}${name}` }
}

/** 这个模型的档位清单：`['default', ...它声明的档位]`。 */
export function effortChoices(entry: ModelChoiceView | undefined): readonly EffortLevel[] {
  if (entry === undefined) return EFFORT_FALLBACK
  const levels: readonly ThinkingLevel[] = entry.thinkingLevels
  const rest: EffortLevel[] = []
  for (const level of levels) {
    // 清单是宿主数据，理论上都是合法档位；出现没听过的值就丢掉（画一个点不动的按钮更糟）。
    if (level === 'off' || level === 'low' || level === 'high' || level === 'max') rest.push(level)
  }
  // 声明为空数组 = 这个模型没有思考开关：只留「默认」（它恒可选，也是唯一发得出去的形态）。
  return ['default', ...rest]
}

/** 档位可不可切：只有一档就别给浮层与箭头（ZCode 的单档模型同款）。 */
export function effortSwitchable(options: readonly EffortLevel[]): boolean {
  return options.length > 1
}

/** 档位按钮上的字。不在清单里的档位照实显示原值，改成一个假名字更糟。 */
export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort as EffortLevel] ?? effort
}

/** 模型行右侧的能力徽标（文本不吃标：那是默认，标出来只添噪音）。 */
export function modelBadges(entry: ModelChoiceView): string[] {
  const badges: string[] = []
  if (entry.modalities.includes('image')) badges.push('图')
  if (entry.modalities.includes('video')) badges.push('视频')
  return badges
}

/** 上下文窗口的短读数（面板右侧那句），与旧版同一个取整口径。 */
export function contextLabel(contextWindow: number): string {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return ''
  return `${Math.round(contextWindow / 1000)}k`
}

/** 一级菜单要不要出现（多端点才有得选；单端点直接列模型）。 */
export function shouldShowProviderLevel(groups: readonly ProviderGroup[]): boolean {
  return groups.length > 1
}

/**
 * 一级行的尾注：**当前模型就在这个端点下**时给出模型名，否则空串。
 *
 * 为什么留着它（ZCode 的一级行只有组名 + 勾）：勾只说「选了这一家」，尾注直接说
 * 「这一家选的是哪一个」——用户报的正是「看不出来当前选的是哪个模型」。
 */
export function providerHint(group: ProviderGroup, current: CurrentModel): string {
  if (current.group === undefined || current.group.provider !== group.provider) return ''
  if (current.entry === undefined) return ''
  return current.entry.model
}

/** 搜索过滤（一级行是按端点选，不搜；二级列模型时按名字与 value 过滤）。 */
export function filterModels(
  models: readonly ModelChoiceView[],
  query: string,
): readonly ModelChoiceView[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return models
  return models.filter(
    (item) => item.model.toLowerCase().includes(wanted) || item.value.toLowerCase().includes(wanted),
  )
}
