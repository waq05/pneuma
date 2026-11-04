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
 * 二级模型列表是**悬浮飞出**的一张卡（`.model-flyout`，不是并排的右栏）：它的挑边
 * （`chooseFlyoutSide`）与夹高度（`placeFlyout`）两个判定也在本模块，因为「右边还剩多少」
 * 只能量出来，吃不了 CSS 断点——理由见这两条自己的注释。
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

// ── 飞出卡（一级厂商 → 二级模型）的定位：两个纯判定，量到的数由调用方给 ──────────────
// 为什么不做成 CSS 断点：面板宽度随 chip 宽度（模型名长短）变、窗口宽度可拖，右缘对齐那颗
// chip 之后「右边还剩多少」是量出来的，不是断点能算的。ZCode 那边同样不吃断点——Radix 的
// `avoidCollisions` 就是拿实测 rect 挑边（窄窗下二级菜单自己翻到左边）。
// 两个判定都收在这里，界面只负责把 rect 量出来喂进来。

/** 飞出卡的目标宽度（px）。**唯一的数**：CSS 通过 `--flyout-w` 读它，别在样式里再写一份。 */
export const FLYOUT_WIDTH = 264

/** 飞出卡的高度上限（px），对照 ZCode 二级菜单的 `max-h-72`（288px）超出即滚动。 */
export const FLYOUT_MAX_HEIGHT = 288

/** 视口（或裁剪容器）里的一个横向区间。 */
export interface Box {
  left: number
  right: number
}

/** 飞出卡摆在哪一边；两边都放不下时**盖住一级**（overlay）。 */
export type FlyoutSide = 'right' | 'left' | 'overlay'

/**
 * 飞出卡摆在哪一边：右边放得下就走右边（与 ZCode 一致），否则翻到左边；两边都放不下就
 * **盖住一级面板**。
 *
 * @param panel 一级面板的横向区间
 * @param bounds **裁剪容器**的横向区间（不是视口）。这条是被实机走查逼出来的：飞出卡一旦
 *   越出 `.thread-main`（`overflow: auto`）的左边界就被裁掉一条，模型名前缀直接看不见——
 *   看着「飞出去了」，其实是半张卡没了。所以判据要用真会裁它的那个盒子。
 * @param cardWidth 卡片宽
 * @param gap 面板与卡片之间的缝
 * @param margin 与容器边缘留的最小余量
 */
export function chooseFlyoutSide(
  panel: Box,
  bounds: Box,
  cardWidth: number,
  gap = 6,
  margin = 8,
): FlyoutSide {
  const roomRight = bounds.right - margin - panel.right
  const roomLeft = panel.left - bounds.left - margin
  if (roomRight >= cardWidth + gap) return 'right'
  if (roomLeft >= cardWidth + gap) return 'left'
  // 两边都塞不下（窄窗/窄列）：盖住一级。硬飞出去只会被容器裁掉半张卡，那样连模型名都读不全。
  return 'overlay'
}

/**
 * 面板要不要整体横移：贴边时把它推回裁剪容器里。
 *
 * 为什么需要：面板右缘对齐模型 chip（`.model-anchor` 里那个钮），而窄屏上输入行会换行、chip
 * 可能落在很靠左的位置——实机 390px 量到面板左缘 -78px，整块探到视口外，模型名只剩右边那列
 * 读数（走查截图抓到的）。推的是 `translateX`，只动视觉不动布局，所以面板自己的量法
 * （飞出卡的挑边/夹高度）仍然拿得到真位置。
 *
 * @param panel 面板当前（或将要）占的横向区间
 * @param bounds 裁剪容器的横向区间
 * @param margin 与容器边缘留的最小余量
 * @returns 需要平移的像素（0 = 不用动）
 */
export function clampShift(panel: Box, bounds: Box, margin = 4): number {
  const overLeft = bounds.left + margin - panel.left
  if (overLeft > 0) return overLeft
  const overRight = panel.right - (bounds.right - margin)
  if (overRight > 0) return -overRight
  return 0
}

/** 飞出卡的摆放结果：`top` 相对一级面板，`maxHeight` 直接写进 `--flyout-max`。 */
export interface FlyoutPlacement {
  top: number
  maxHeight: number
}

/**
 * 飞出卡摆多高、摆在哪一行的高度上。
 *
 * 口径：卡片顶端对齐**悬浮的那一行**；整张卡夹在一级面板的上下边之间——放不下就整体上移，
 * 再放不下就压高度让它自己滚。为什么必须夹：面板底边只离输入行 10px（`bottom: 100% + 10px`），
 * 模型一多、卡片顺着一行往下铺就会盖住输入框，而它盖住的正是用户马上要接着打字的地方。
 *
 * @param rowTop 悬浮那一行相对面板的顶边
 * @param rowBottom 悬浮那一行相对面板的底边
 * @param panelHeight 一级面板高（含内距）
 * @param cardHeight 卡片内容的自然高（量出来的，不是估的）
 * @param pad 面板上下内距（夹取范围要让它）
 */
export function placeFlyout(
  rowTop: number,
  rowBottom: number,
  panelHeight: number,
  cardHeight: number,
  pad = 12,
): FlyoutPlacement {
  const room = Math.max(0, panelHeight - pad * 2)
  const height = Math.min(cardHeight, FLYOUT_MAX_HEIGHT, room)
  // 下方放得下就对齐那一行的顶边；放不下就把卡片的底边对齐那一行的底边（整体上移），
  // 最多退到面板顶边——退到底了就压高度滚动，绝不越过面板底边去盖输入框。
  const wanted = rowTop + height <= panelHeight - pad ? rowTop : rowBottom - height
  const top = Math.max(pad, Math.min(wanted, panelHeight - pad - height))
  // 上限取**有效高**（而不是面板内高）：`top + maxHeight` 必须自洽，
  // 否则「卡片一定在面板里」这条只有拿卡片内容高一起算才成立，读代码的人验不了。
  return { top, maxHeight: height }
}
