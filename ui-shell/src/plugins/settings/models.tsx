/**
 * 设置 → 模型：左栏端点列表 + 右栏端点详情（两栏），模型逐行配能力。
 *
 * 版式照 ZCode 的「模型设置」页（左侧供应商列表、点一个在右侧看它的配置与模型列表）
 * 与 dsh 的端点卡：左栏一行一个端点（首字头像、显示名、「默认」标、密钥状态点），
 * 右栏是选中端点的全部配置——Base URL、API Key、模型列表。每个模型一行：左边一颗
 * 「设为默认」的圆点，中间是名字 / id / 上下文徽标 / 能力徽标，右边是「测试连接」
 * 与结论点、编辑、删除；点「编辑」在那一行下面展开能力编辑器（思考档位四档、档位
 * 走哪个字段、各档线上值、输入模态三档——与旧版逐项对齐）。
 *
 * 三条口径，改的时候别破坏：
 *
 * 1. **写入口走原生桥**（`saveProvider` / `removeProvider` / `setProviderKey`）：这三个方法
 *    写 config.yaml 与凭据库，界面通道（浏览器与远程页够得着的那条面）持续排除，理由在
 *    `src/core/ui-methods.ts` 的 `UI_EXCLUDED` 里逐条写着；桌面窗口的桥只对主窗口开放，
 *    与旧渲染层的直接 IPC 同一扇门。浏览器里没有桥时整页降级成只读（能看、能选默认模型，
 *    改不动），页首一条说明写清「要用桌面版」。
 * 2. **可选能力对齐旧版**（也是宿主 `core/model-caps.ts` 的字段）：思考档位四档
 *    （关 / 低 / 高 / 最大）、档位走哪个字段（thinking / reasoning_effort / 不发）、
 *    `reasoning_effort` 各档的线上值、输入模态三档（文本 / 照片 / 视频，文本永远勾着）。
 * 3. **一次只开一个编辑器**：端点表单（新增 / 改名）占满右栏，模型能力编辑器展开在
 *    那一行下面，两者互斥。草稿按对象记（端点草稿按端点名、模型草稿按「端点 + 行」），
 *    左栏切走再切回来，没保存的改动还在。
 *
 * 宿主那条硬约束也在这页上体现：**一个端点至少一个模型**（`core/config-store.ts` 的
 * `validateDraft` 会拒收空清单），所以「新增端点」表单里必须填出第一个模型，建好之后
 * 再往列表里加。「删掉最后一个模型」不是入口——那时该删端点。
 *
 * 悬浮说明一律走原生 `title`：壳里的 `data-tip` 气泡层 0.6.37 已下线（见
 * `legacy/primitives.css` 的注释），留着的 data-tip 是不渲染的死属性。
 *
 * @module dsc-ui-shell/plugins/settings/models
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_CAPS,
  EFFORT_WIRE_HINT,
  IconBolt,
  IconCheck,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSwap,
  IconTrash,
  MODALITIES,
  MODALITY_LABELS,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  THINKING_PARAMS,
  THINKING_PARAM_LABELS,
  confirmAction,
  getHostNative,
  toastErr,
  toastOk,
  useHostChannel,
  type ConnectionTestView,
  type EffortMap,
  type Modality,
  type ModelConfigView,
  type ProviderDraft,
  type ProviderModelView,
  type ProviderView,
  type SettingsMutation,
  type ThinkingLevel,
} from '@dsc/ui'
// 基元从平台种子（`@dsc/ui-primitives`）取：与壳内部同一份实现，不再内联（E6）。
import { Select } from '@dsc/ui-primitives'
import { buildKnownIndex, inferModelCaps, type InferredCaps, type KnownModel } from './model-infer'

/** 左栏那条「新增端点」伪条目的键（表单占着右栏时，左栏也得有它的位置）。 */
const NEW_PROVIDER_KEY = '__new__'

/** 拿异常的文字形态。 */
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 连接测试的键：一个「端点 + 模型」一对（同一张列表里多个模型各测各的）。 */
function probeKeyOf(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** 把 `端点/模型` 记的键集按端点切出这一份（键里只剩模型 id）。 */
function scopedSet(source: ReadonlySet<string>, provider: string): ReadonlySet<string> {
  const prefix = `${provider}/`
  return new Set([...source].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)))
}

/** 同上，给结论表用。 */
function scopedMap<T>(source: ReadonlyMap<string, T>, provider: string): ReadonlyMap<string, T> {
  const prefix = `${provider}/`
  return new Map(
    [...source].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]),
  )
}

/** 一次连接测试结论的悬浮说明（图标钮与结论点共用一句话）。 */
function probeTip(result: ConnectionTestView): string {
  if (!result.ok) return `没通：${result.error ?? '未知原因'}`
  const said = result.reply === '' ? '没回正文但流正常收尾' : `回了「${result.reply}」`
  return `通了 · ${result.model} · ${String(result.ms)} ms · ${said}`
}

/** token 数输入：认 `128k` / `1m` / 裸数字；认不出给 NaN（调用点按「没填」处理）。 */
function parseTokenCount(raw: string): number {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return Number.NaN
  const kilo = /^(\d+(?:\.\d+)?)\s*k$/.exec(trimmed)
  if (kilo !== null) return Math.round(Number(kilo[1]) * 1_000)
  const mega = /^(\d+(?:\.\d+)?)\s*m$/.exec(trimmed)
  if (mega !== null) return Math.round(Number(mega[1]) * 1_000_000)
  const plain = Number(trimmed)
  return Number.isFinite(plain) ? plain : Number.NaN
}

/** 上下文窗口的紧凑读数（1M / 256K / 128K，与 dsh、ZCode 的徽标同款）。 */
function contextLabel(tokens: number): string {
  if (tokens <= 0) return ''
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${Number.isInteger(value) ? String(value) : value.toFixed(1)}M`
  }
  return `${String(Math.round(tokens / 1000))}K`
}

/** 头像的色调档数（色在 CSS 里按令牌取，见 `.provider-avatar.av-*`）。 */
const AVATAR_TONES = 3

/** 名称 → 稳定的色调档（同一个端点每次都是同一个色，照插件页那手小把戏，只是取的是令牌）。 */
function avatarTone(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 997
  return `av-${String(hash % AVATAR_TONES)}`
}

/** 头像里的那个字：显示名的首字（英文大写；中文就是那个字）。 */
function initialOf(label: string): string {
  return label.slice(0, 1).toUpperCase()
}

/** 路径取末段（左栏窄，整条路径塞不下；完整路径进 title）。 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts.at(-1) ?? path
}

/** 空白模型行：能力走缺省（四档思考 + thinking 开关 + 只吃文本），与旧版 `blankModel` 同款。 */
function blankModel(): ProviderModelView {
  return {
    id: '',
    name: '',
    contextWindow: 0,
    maxTokens: 0,
    thinkingLevels: [...DEFAULT_CAPS.thinkingLevels],
    thinkingParam: DEFAULT_CAPS.thinkingParam,
    effortMap: {},
    modalities: [...DEFAULT_CAPS.modalities],
  }
}

/** 空白端点草稿（新增用）：宿主要求至少一个模型，所以这里先摆一个空行。 */
function blankDraft(): ProviderDraft {
  return { oldName: null, name: '', displayName: '', baseUrl: '', models: [blankModel()] }
}

/**
 * 拉取清单里挑中的一个模型：能力按 {@link inferModelCaps} 推断的填（不再是「一律按缺省」——
 * 一个 1M 上下文、能收图的模型拉进来都变成 128k / 只吃文本，是 0.6.69 报障的第三条）。
 */
function discoveredModel(id: string, caps: InferredCaps): ProviderModelView {
  return {
    id,
    name: id,
    contextWindow: caps.contextWindow,
    maxTokens: caps.maxTokens,
    thinkingLevels: [...caps.thinkingLevels],
    thinkingParam: caps.thinkingParam,
    effortMap: { ...caps.effortMap },
    modalities: [...caps.modalities],
  }
}

/** http(s) 地址：宿主侧也这么判（`core/config-store.ts` 的 validateDraft），这里先拦一道。 */
const URL_PATTERN = /^https?:\/\/\S+$/

/**
 * 保存前的校验（宿主也会校验；这里先拦一道是为了把错误当面说清，而不是保存一次才吃回执）。
 *
 * 四条硬规矩：端点名是小写字母/数字/`-`/`_`（它是 config.yaml 的键）、Base URL 是完整的
 * http(s) 地址、至少要有一个模型、每个模型 id 必填不重复且上下文窗口是正整数（宿主这两条
 * 都拒收，0 也不行——「不知道就填 128000」）。最大输出允许留空（0）。
 */
function validateDraft(draft: ProviderDraft, others: readonly ProviderView[]): string | null {
  const name = draft.name.trim()
  if (name === '') return '端点名不能为空（它是 config.yaml 里的键）。'
  if (!/^[a-z0-9_-]+$/.test(name)) return '端点名只能用小写字母、数字、- 或 _。'
  if (draft.baseUrl.trim() === '') return 'Base URL 不能为空。'
  if (!URL_PATTERN.test(draft.baseUrl.trim())) return 'Base URL 要写成完整的 http(s) 地址，中间不能有空格。'
  if (others.some((entry) => entry.name === name && entry.name !== draft.oldName)) {
    return `已经有一个叫 ${name} 的端点了。`
  }
  if (draft.models.length === 0) return '至少要有一个模型（模型 id 就是请求里发的名字）。'
  const seen = new Set<string>()
  for (const model of draft.models) {
    const id = model.id.trim()
    if (id === '') return '每个模型都要填 id（请求里发的就是它）。'
    if (seen.has(id)) return `模型 id 重复了：${id}`
    if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) {
      return `${id} 的上下文窗口要填正整数（不知道就填 128000）。`
    }
    if (model.maxTokens < 0 || !Number.isInteger(model.maxTokens)) return `${id} 的最大输出要填正整数。`
  }
  return null
}

/** 一个模型的能力摘要（模型行上那些徽标的悬浮提示）。 */
function modelCapsSummary(model: ProviderModelView): string {
  const ctx = model.contextWindow > 0 ? `${contextLabel(model.contextWindow)} 上下文` : '上下文窗口没填'
  const thinking =
    model.thinkingLevels.length === 0 ? '没有思考档位' : `思考档位 ${String(model.thinkingLevels.length)} 档`
  const inputs = model.modalities.map((entry) => MODALITY_LABELS[entry]).join('/')
  return [ctx, thinking, `输入 ${inputs}`].join(' · ')
}

/** 批量文本：一行一个 `id, 显示名, 上下文窗口, 最大输出`；空列从尾部省掉。 */
function formatModels(models: readonly ProviderModelView[]): string {
  return models
    .filter((model) => model.id !== '')
    .map((model) => {
      const columns = [
        model.id,
        model.name === '' || model.name === model.id ? '' : model.name,
        model.contextWindow > 0 ? String(model.contextWindow) : '',
        model.maxTokens > 0 ? String(model.maxTokens) : '',
      ]
      while (columns.length > 1 && (columns.at(-1) ?? '') === '') columns.pop()
      return columns.join(', ')
    })
    .join('\n')
}

/** 解析批量文本；能力字段先按默认填，再由 {@link mergeCaps} 按 id 从原行接回来。 */
function parseModels(text: string): ProviderModelView[] {
  const models: ProviderModelView[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split(/[,，\t]+/).map((part) => part.trim())
    const id = parts[0] ?? ''
    if (id === '') continue
    const name = parts[1] !== undefined && parts[1] !== '' ? parts[1] : id
    const contextWindow = parseTokenCount(parts[2] ?? '')
    const maxTokens = parseTokenCount(parts[3] ?? '')
    models.push({
      id,
      name,
      contextWindow: Number.isFinite(contextWindow) ? contextWindow : 0,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : 0,
      thinkingLevels: [...DEFAULT_CAPS.thinkingLevels],
      thinkingParam: DEFAULT_CAPS.thinkingParam,
      effortMap: {},
      modalities: [...DEFAULT_CAPS.modalities],
    })
  }
  return models
}

/** 批量文本改完，把原行的思考档位 / 档位字段 / 线上值 / 输入类型接回来（一行一个的文本表达不了这些）。 */
function mergeCaps(base: readonly ProviderModelView[], parsed: ProviderModelView[]): ProviderModelView[] {
  return parsed.map((model) => {
    const old = base.find((entry) => entry.id === model.id)
    if (old === undefined) return model
    return {
      ...model,
      thinkingLevels: old.thinkingLevels,
      thinkingParam: old.thinkingParam,
      effortMap: old.effortMap,
      modalities: old.modalities,
    }
  })
}

/** 一个整份写出去的端点草稿（模型行的增删改都从这里走：写口只有 `saveProvider` 一个）。 */
function draftOf(provider: ProviderView, models: ProviderModelView[]): ProviderDraft {
  return {
    oldName: provider.name,
    name: provider.name,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    models,
  }
}

/** 模型能力编辑器开着的那一行（`index === null` = 末尾要新加一行）。 */
interface ModelDraft {
  provider: string
  index: number | null
  model: ProviderModelView
}

export function ModelsGroup(): ReactNode {
  const channel = useHostChannel()
  /** 原生桥：三处写操作（保存 / 删除 / 写 key）的唯一通路；不在时整页只读。 */
  const native = getHostNative()
  const editable = native.available

  const [config, setConfig] = useState<ModelConfigView | null>(null)
  /** 右栏选中的端点名（`''` = 还没选，落到默认端点 / 第一个；`__new__` = 新增表单）。 */
  const [selected, setSelected] = useState('')
  /** 端点表单草稿（`oldName === null` = 新增）。 */
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  /** 模型能力编辑器：编辑哪一行（`index === null` = 新增一行）。 */
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null)
  /** 批量文本面板：带着它的端点名（换端点 = 换一份草稿，写的是那个端点的模型清单）。 */
  const [bulk, setBulk] = useState<{ provider: string; text: string } | null>(null)
  /** 密钥行是否在录入（「替换」/「填写」点开之后）。 */
  const [keyEdit, setKeyEdit] = useState(false)
  const [keyValue, setKeyValue] = useState('')
  /** 拉取清单弹窗：哪个端点、拉到了什么。 */
  const [discovered, setDiscovered] = useState<{ provider: string; models: string[] } | null>(null)
  /**
   * 正在拉取的端点（按端点记，不是全局一个布尔）。
   *
   * 这里踩过一次：原来是一个 `discovering: boolean` 传给每张卡，于是点一张卡的「拉取清单」，
   * 四张卡的按钮**同时**变成「拉取中…」（0.6.69 报障第二条）。用集合按端点分开之后，
   * 拉取中也允许同时拉另一张卡——两张卡各转各的，谁先回来谁的清单先开。
   */
  const [discovering, setDiscovering] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * 正在测连接的那几个（键是 `端点/模型`）。
   *
   * 测试是**按模型**做的：同一个端点里两个模型各测各的，谁也不许让谁的按钮跟着转
   * （沿用第十八批「忙碌态按对象记」那条教训）。
   */
  const [testing, setTesting] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * 每个「端点/模型」最近一次连接测试的结论（就地留在那个模型后面）。
   *
   * 为什么留着而不是只闪一条提示：「21ms 通了 / 没通：HTTP 401…」是配置页最该看见的一行字，
   * 一闪而过的 Toast 看完就没了；失败也要留（失败原因比成功更需要回头看）。
   */
  const [probed, setProbed] = useState<ReadonlyMap<string, ConnectionTestView>>(() => new Map())
  /** 已经配过的模型（别的端点里同 id 的那份能力），拉清单时优先照抄它。 */
  const known = useMemo<Map<string, KnownModel>>(() => buildKnownIndex(config?.providers ?? []), [config])

  const reload = (): void => {
    void channel
      .invoke<ModelConfigView>('getModelConfig')
      .then((value) => {
        setConfig(value)
      })
      .catch((error: unknown) => {
        toastErr(`读取模型配置失败：${text(error)}`)
      })
  }
  useEffect(reload, [channel])

  /** 写一次默认模型，回执走 Toast；成功与失败都重取（宿主先写文件再校验运行期，失败时文件也可能已变）。 */
  const setDefault = (provider: string, model: string): void => {
    void channel
      .invoke<SettingsMutation>('setDefaultModel', [provider, model])
      .then((result) => {
        if (!result.ok) {
          toastErr(`操作失败：${result.error}`)
          reload()
          return
        }
        toastOk(result.notice ?? '默认模型已更新')
        reload()
      })
      .catch((error: unknown) => {
        toastErr(`操作失败：${text(error)}`)
        reload()
      })
  }

  /**
   * 一次桥写操作：回执照 Toast，成功与失败都重取配置。
   *
   * 为什么失败也重取：宿主那侧常常「先落盘再校验运行期」（`setDefaultModel` 就是），
   * 回执说失败时文件可能已经变了——不重取的话界面会把旧值一直画下去。
   */
  const bridgeWrite = (
    op: 'saveProvider' | 'removeProvider' | 'setProviderKey',
    args: unknown[],
    okText: string,
  ): Promise<boolean> => {
    return native
      .invoke<SettingsMutation>(op, args)
      .then((result) => {
        if (!result.ok) {
          toastErr(`操作失败：${result.error}`)
          reload()
          return false
        }
        toastOk(result.notice ?? okText)
        reload()
        return true
      })
      .catch((error: unknown) => {
        toastErr(`操作失败：${text(error)}`)
        reload()
        return false
      })
  }

  const discover = (provider: string): void => {
    setDiscovering((current) => new Set(current).add(provider))
    void channel
      .invoke<string[]>('discoverModels', [provider])
      .then((models) => {
        setDiscovered({ provider, models })
      })
      .catch((error: unknown) => {
        toastErr(`拉取失败：${text(error)}`)
      })
      .finally(() => {
        setDiscovering((current) => {
          const next = new Set(current)
          next.delete(provider)
          return next
        })
      })
  }

  /**
   * 测一次「这个端点 + 这个模型」的连接：宿主拿它**真发一次**最小对话请求（走与正常对话
   * 同一条链路：同协议适配器、同一份端点要的请求头），所以结论就是「用它发一条消息会不会失败」。
   *
   * 测试按模型做（用户点的是某个模型后面那颗钮），结论也留在这个模型后面。
   */
  const probe = (provider: string, model: string): void => {
    const key = probeKeyOf(provider, model)
    setTesting((current) => new Set(current).add(key))
    void channel
      .invoke<ConnectionTestView>('testConnection', [provider, model])
      .then((result) => {
        setProbed((current) => new Map(current).set(key, result))
        if (result.ok) {
          const said = result.reply === '' ? '没回正文但流正常收尾' : `回了「${result.reply}」`
          toastOk(`${provider}/${model} 通了：${said}（${String(result.ms)} ms）`)
        } else {
          toastErr(`${provider}/${model} 没通：${result.error ?? '未知原因'}`)
        }
      })
      .catch((error: unknown) => {
        // reject = 连请求都没发出去（端点没了 / 没模型 / 没 key）：也留在那个模型后面，别只闪一条提示
        setProbed((current) => new Map(current).set(key, { ok: false, model, ms: 0, reply: '', error: text(error) }))
        toastErr(`测试失败：${text(error)}`)
      })
      .finally(() => {
        setTesting((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      })
  }

  /** 一个 id 的能力：先看别的端点配过没有，再按 id 里写的 / 家族表推断（见 model-infer.ts）。 */
  const infer = (id: string): InferredCaps => inferModelCaps(id, known)

  if (config === null) return <div className="settings-empty">正在读取模型配置…</div>

  const providers = config.providers
  /** 选中的那一个：选过就认；没选过（或被删了）落到默认端点，再落到第一个。 */
  const current =
    providers.find((entry) => entry.name === selected) ??
    providers.find((entry) => entry.name === config.defaultProvider) ??
    providers[0] ??
    null
  const newFormOpen = draft !== null && draft.oldName === null && selected === NEW_PROVIDER_KEY
  const formOpen = newFormOpen || (draft !== null && draft.oldName !== null && current !== null && draft.oldName === current.name)
  const defaultProvider = providers.find((entry) => entry.name === config.defaultProvider)

  /** 切端点：右栏那几处一次性的录入态（密钥行、批量面板）跟着回到干净态。 */
  const selectProvider = (name: string): void => {
    setSelected(name)
    setKeyEdit(false)
    setKeyValue('')
  }

  /** 点「添加端点」：开一张空草稿，左栏同时出现它的位置。 */
  const startNew = (): void => {
    setDraft(blankDraft())
    setSelected(NEW_PROVIDER_KEY)
    setModelDraft(null)
  }

  /** 点某个端点的「编辑」：把当前值抄进草稿（模型清单不进表单，只在右栏列表里改）。 */
  const startEdit = (provider: ProviderView): void => {
    setDraft({
      oldName: provider.name,
      name: provider.name,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      models: provider.models.map((model) => ({ ...model })),
    })
    setModelDraft(null)
  }

  /** 提交一次端点草稿：校验 → 保存 → （填了 key 就）写凭据；失败把原因说出来、表单不收起。 */
  const submitDraft = (currentDraft: ProviderDraft, apiKey: string): void => {
    const problem = validateDraft(currentDraft, providers)
    if (problem !== null) {
      toastErr(problem)
      return
    }
    const payload: ProviderDraft = {
      oldName: currentDraft.oldName,
      name: currentDraft.name.trim(),
      displayName: currentDraft.displayName.trim(),
      baseUrl: currentDraft.baseUrl.trim().replace(/\/+$/, ''),
      models: currentDraft.models.map((model) => ({ ...model, id: model.id.trim(), name: model.name.trim() })),
    }
    void (async () => {
      try {
        const result = await native.invoke<SettingsMutation>('saveProvider', [payload])
        if (!result.ok) {
          toastErr(`保存失败：${result.error}`)
          return
        }
        setDraft(null)
        // 改名之后右栏要跟着落到新名字上，否则一重取就跳回别的端点
        setSelected(payload.name)
        if (apiKey.trim() !== '') {
          const keyResult = await native.invoke<SettingsMutation>('setProviderKey', [payload.name, apiKey.trim()])
          if (!keyResult.ok) {
            toastErr(`端点已保存，但密钥没写成功：${keyResult.error}`)
            reload()
            return
          }
          toastOk(`${result.notice ?? '端点已保存'}；API key 已写进凭据库`)
        } else {
          toastOk(result.notice ?? '端点已保存')
        }
        reload()
      } catch (error: unknown) {
        toastErr(`保存失败：${text(error)}`)
      }
    })()
  }

  /**
   * 存一个模型（改一行 / 加一行）：借着 `saveProvider` 整份写出去——写口就这一个，
   * 所以先把这一行并回端点的模型清单，再走与端点表单同一条校验。
   */
  const submitModel = (provider: ProviderView, index: number | null, model: ProviderModelView): void => {
    const one: ProviderModelView = { ...model, id: model.id.trim(), name: model.name.trim() }
    const models =
      index === null
        ? [...provider.models, one]
        : provider.models.map((entry, at) => (at === index ? one : entry))
    const payload = draftOf(provider, models)
    const problem = validateDraft(payload, providers)
    if (problem !== null) {
      toastErr(problem)
      return
    }
    void bridgeWrite(
      'saveProvider',
      [payload],
      index === null ? `已加入模型 ${one.id}` : `模型 ${one.id} 已保存`,
    ).then((ok) => {
      if (ok) setModelDraft(null)
    })
  }

  /** 删一个模型；删的正好是当前默认模型时，顺手把默认挪到这个端点剩下的第一个。 */
  const removeModel = (provider: ProviderView, index: number): void => {
    const model = provider.models[index]
    if (model === undefined) return
    const rest = provider.models.filter((_, at) => at !== index)
    const wasDefault = config.defaultProvider === provider.name && config.defaultModel === model.id
    const next = rest[0]
    void confirmAction({
      title: `删除模型「${model.id}」？`,
      detail:
        `将从 ${config.configFile} 的这个端点里删掉它。` +
        (wasDefault
          ? next === undefined
            ? '它是当前默认模型；这是这个端点最后一个模型，删完该端点的模型清单就空了。'
            : `它是当前默认模型，删完会把默认模型改成 ${next.id}。`
          : ''),
      confirmLabel: '删除模型',
      danger: true,
    }).then((yes) => {
      if (!yes) return
      void bridgeWrite('saveProvider', [draftOf(provider, rest)], `已删除模型 ${model.id}`).then((ok) => {
        if (!ok || !wasDefault || next === undefined) return
        setDefault(provider.name, next.id)
      })
    })
  }

  /** 批量文本的保存：按 id 把能力接回来，再整份写出去。 */
  const submitBulk = (provider: ProviderView, bulkText: string): void => {
    const payload = draftOf(provider, mergeCaps(provider.models, parseModels(bulkText)))
    const problem = validateDraft(payload, providers)
    if (problem !== null) {
      toastErr(problem)
      return
    }
    void bridgeWrite('saveProvider', [payload], `已按批量文本更新 ${provider.name} 的模型清单`).then((ok) => {
      if (ok) setBulk(null)
    })
  }

  /** 右栏 Base URL 那一行的保存（失焦 / 回车触发）。 */
  const saveBaseUrl = (provider: ProviderView, value: string): void => {
    const next = value.trim().replace(/\/+$/, '')
    if (next === provider.baseUrl) return
    if (!URL_PATTERN.test(next)) {
      toastErr('Base URL 要写成完整的 http(s) 地址，中间不能有空格。')
      reload()
      return
    }
    void bridgeWrite('saveProvider', [{ ...draftOf(provider, provider.models), baseUrl: next }], 'Base URL 已保存')
  }

  /** 写密钥（保存 / 清除）。 */
  const writeKey = (provider: ProviderView, value: string | null, okText: string): void => {
    void bridgeWrite('setProviderKey', [provider.name, value], okText).then((ok) => {
      if (ok && value !== null) {
        setKeyEdit(false)
        setKeyValue('')
      }
    })
  }

  return (
    <div className="settings-fields models models-page">
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">默认模型</div>
          <div className="setting-help">当前会话的下一次请求就用新值。</div>
        </div>
        <div className="setting-control">
          <div className="model-default">
            <Select
              className="setting-select"
              ariaLabel="默认端点"
              value={config.defaultProvider}
              options={
                providers.length === 0
                  ? [{ value: '', label: '暂无端点' }]
                  : providers.map((entry) => ({
                      value: entry.name,
                      label:
                        (entry.displayName === '' ? entry.name : entry.displayName) +
                        (entry.keyConfigured ? '' : '（无密钥）'),
                    }))
              }
              onPick={(next) => {
                const provider = providers.find((entry) => entry.name === next)
                const first = provider?.models[0]?.id ?? ''
                if (first !== '') setDefault(next, first)
              }}
            />
            <Select
              className="setting-select"
              ariaLabel="默认模型"
              value={config.defaultModel}
              disabled={defaultProvider === undefined || !defaultProvider.keyConfigured || defaultProvider.models.length === 0}
              options={(defaultProvider?.models ?? []).map((model) => ({
                value: model.id,
                label: model.name === '' ? model.id : model.name,
              }))}
              onPick={(next) => {
                setDefault(config.defaultProvider, next)
              }}
            />
          </div>
        </div>
      </div>

      {!editable ? (
        <div className="settings-note" data-models-readonly="1">
          浏览器里只能看：增删端点与填写密钥要写 config.yaml 与凭据库，走的是桌面窗口的原生桥
          （界面通道有意没放行这几个方法）。要改配置请用桌面版。
        </div>
      ) : null}

      <div className="models-panes">
        <aside className="models-rail" aria-label="端点列表">
          <div className="models-rail-head">
            <span className="models-rail-title">端点</span>
            <span className="count">{providers.length}</span>
            <button
              type="button"
              className="icon-btn models-refresh"
              title="重新读一遍 config.yaml（外部改过文件时用）"
              aria-label="重新读取模型配置"
              onClick={reload}
            >
              <IconRefresh size={14} />
            </button>
          </div>
          <div className="models-rail-list">
            {draft !== null && draft.oldName === null ? (
              <button
                type="button"
                className={`models-rail-item${selected === NEW_PROVIDER_KEY ? ' on' : ''}`}
                data-provider={NEW_PROVIDER_KEY}
                onClick={() => {
                  selectProvider(NEW_PROVIDER_KEY)
                }}
              >
                <span className="provider-avatar lg av-new" aria-hidden="true">
                  <IconPlus size={13} />
                </span>
                <span className="models-rail-name">新增端点</span>
              </button>
            ) : null}
            {providers.map((provider) => (
              <ProviderRailItem
                key={provider.name}
                provider={provider}
                isDefault={provider.name === config.defaultProvider}
                selected={selected !== NEW_PROVIDER_KEY && current !== null && current.name === provider.name}
                editing={draft !== null && draft.oldName === provider.name}
                onSelect={() => {
                  selectProvider(provider.name)
                }}
              />
            ))}
            {providers.length === 0 && draft === null ? <div className="models-rail-empty">还没有端点</div> : null}
          </div>
          <div className="models-rail-foot">
            {editable && (draft === null || draft.oldName !== null) ? (
              <button type="button" className="models-add-card" data-provider-add="1" data-models-add="1" onClick={startNew}>
                <IconPlus size={14} /> 添加端点
              </button>
            ) : null}
            <div className="models-paths">
              <span className="models-path">
                <span className="models-path-label">配置文件</span>
                <span className="mono" title={config.configFile}>
                  {baseName(config.configFile)}
                </span>
              </span>
              <span className="models-path">
                <span className="models-path-label">凭据</span>
                <span className="mono" title={config.credentialsFile}>
                  {baseName(config.credentialsFile)}
                </span>
              </span>
            </div>
          </div>
        </aside>

        <section className="models-detail">
          {formOpen && draft !== null ? (
            <PaneForm
              draft={draft}
              isNew={draft.oldName === null}
              providers={providers}
              onChange={setDraft}
              onCancel={() => {
                setDraft(null)
              }}
              onSubmit={submitDraft}
            />
          ) : current === null ? (
            <div className="models-detail-empty">
              <div className="models-detail-empty-title">还没有端点</div>
              <p className="models-detail-empty-hint">
                点左下角的「添加端点」建第一个：填上名字、地址与一个模型，建好之后可以用「拉取清单」
                把线上模型一次挑进来，再逐个调能力。
              </p>
            </div>
          ) : (
            <ProviderDetail
              key={current.name}
              provider={current}
              isDefault={current.name === config.defaultProvider}
              defaultModel={config.defaultModel}
              editable={editable}
              discovering={discovering.has(current.name)}
              testing={scopedSet(testing, current.name)}
              probed={scopedMap(probed, current.name)}
              modelDraft={modelDraft !== null && modelDraft.provider === current.name ? modelDraft : null}
              bulkText={bulk !== null && bulk.provider === current.name ? bulk.text : null}
              keyEdit={keyEdit}
              keyValue={keyValue}
              onSelectModelDefault={(model) => {
                setDefault(current.name, model)
              }}
              onProbe={(model) => {
                probe(current.name, model)
              }}
              onDiscover={() => {
                discover(current.name)
              }}
              onOpenBulk={() => {
                setBulk({ provider: current.name, text: formatModels(current.models) })
                setModelDraft(null)
              }}
              onCloseBulk={() => {
                setBulk(null)
              }}
              onBulkText={(value) => {
                setBulk({ provider: current.name, text: value })
              }}
              onBulkSave={(bulkText) => {
                submitBulk(current, bulkText)
              }}
              onEditModel={(index, model) => {
                setBulk(null)
                setModelDraft({ provider: current.name, index, model: { ...model } })
              }}
              onAddModel={() => {
                setBulk(null)
                setModelDraft({ provider: current.name, index: null, model: blankModel() })
              }}
              onModelChange={(model) => {
                setModelDraft((previous) =>
                  previous === null ? previous : { ...previous, model },
                )
              }}
              onModelCancel={() => {
                setModelDraft(null)
              }}
              onModelSave={(index, model) => {
                submitModel(current, index, model)
              }}
              onRemoveModel={(index) => {
                removeModel(current, index)
              }}
              onEditProvider={() => {
                startEdit(current)
              }}
              onRemoveProvider={() => {
                const isDefault = config.defaultProvider === current.name
                void confirmAction({
                  title: `删除端点「${current.displayName === '' ? current.name : current.displayName}」？`,
                  detail:
                    `将从 ${config.configFile} 删除该端点，使用它的会话在下次请求时才会发现不可用；` +
                    `其 API key 仍保留在凭据库中，重新添加同名端点后可继续使用。` +
                    `${isDefault ? '该端点是当前默认端点，删除后默认端点将自动改为第一个可用端点。' : ''}`,
                  confirmLabel: '删除端点',
                  danger: true,
                }).then((yes) => {
                  if (!yes) return
                  void bridgeWrite('removeProvider', [current.name], `已删除端点「${current.name}」`).then(() => {
                    setModelDraft(null)
                    setBulk(null)
                  })
                })
              }}
              onSaveBaseUrl={(value) => {
                saveBaseUrl(current, value)
              }}
              onStartKeyEdit={() => {
                setKeyEdit(true)
                setKeyValue('')
              }}
              onCancelKeyEdit={() => {
                setKeyEdit(false)
                setKeyValue('')
              }}
              onKeyValue={setKeyValue}
              onSaveKey={() => {
                const value = keyValue.trim()
                if (value === '') return
                writeKey(current, value, 'API key 已写进凭据库')
              }}
              onClearKey={() => {
                void confirmAction({
                  title: `清除 ${current.keyRef}？`,
                  detail: `将从凭据库里删掉这个 key（端点与模型清单都不动）。环境变量若仍提供同名 key，运行期照旧可用。`,
                  confirmLabel: '清除密钥',
                  danger: true,
                }).then((yes) => {
                  if (!yes) return
                  writeKey(current, null, 'API key 已从凭据库移除')
                })
              }}
            />
          )}
        </section>
      </div>

      {discovered === null ? null : (
        <DiscoverDialog
          provider={providers.find((entry) => entry.name === discovered.provider) ?? null}
          models={discovered.models}
          infer={infer}
          onClose={() => {
            setDiscovered(null)
          }}
          onAdopt={(ids) => {
            const provider = providers.find((entry) => entry.name === discovered.provider)
            if (provider === undefined || ids.length === 0) {
              setDiscovered(null)
              return
            }
            const models = [...provider.models, ...ids.map((id) => discoveredModel(id, infer(id)))]
            void bridgeWrite('saveProvider', [draftOf(provider, models)], `已加入 ${String(ids.length)} 个模型`).then(() => {
              setDiscovered(null)
            })
          }}
        />
      )}
    </div>
  )
}

/**
 * 左栏的一行：首字头像 + 显示名 + 「默认」标 + 密钥状态点。
 *
 * 悬浮说明里给的是「这个端点还能不能用」的那一句话（密钥从哪来、缺哪个变量）：
 * 这一栏窄，只能放下名字，状态就靠那颗点 + 鼠标停上去看字。
 */
function ProviderRailItem(props: {
  provider: ProviderView
  isDefault: boolean
  selected: boolean
  /** 这个端点正开着编辑表单 / 有没保存的改动（左栏切走了也还记着）。 */
  editing: boolean
  onSelect(): void
}): ReactNode {
  const provider = props.provider
  const label = provider.displayName === '' ? provider.name : provider.displayName
  const keyTip = provider.keyConfigured
    ? `${provider.keyRef} 已就绪（环境变量或凭据库）`
    : `${provider.keyRef} 还没配：这个端点暂时用不了`
  return (
    <button
      type="button"
      className={`models-rail-item${props.selected ? ' on' : ''}`}
      data-provider={provider.name}
      aria-current={props.selected ? 'true' : undefined}
      title={`${label} · ${provider.baseUrl}`}
      onClick={props.onSelect}
    >
      <span className={`provider-avatar ${avatarTone(provider.name)}`} aria-hidden="true">
        {initialOf(label)}
      </span>
      <span className="models-rail-name">{label}</span>
      {props.editing ? <span className="models-rail-editing" title="这个端点有没保存的改动" /> : null}
      {props.isDefault ? <span className="tag">默认</span> : null}
      <span className={`provider-dot${provider.keyConfigured ? ' ok' : ' warn'}`} title={keyTip} />
    </button>
  )
}

/**
 * 右栏本体：一个端点。
 *
 * 三块从上到下——头（名字与端点级动作）、连接卡（Base URL / API Key，都是就地改就地存）、
 * 模型清单（每行一颗「设为默认」、测试连接与编辑/删除，编辑器展开在那一行下面）。
 *
 * 只读档（浏览器里没有桥）里改配置的按钮**不画**（不是画成灰的）——页首已经有一条说明
 * 讲清为什么，摆几颗点不动的按钮只会让人一个个去试。「测试连接」与「拉取清单」不在此列：
 * 它们走界面通道（浏览器里照样能点）。
 */
function ProviderDetail(props: {
  provider: ProviderView
  isDefault: boolean
  defaultModel: string
  editable: boolean
  discovering: boolean
  /** 这张列表上正被测的模型 id。 */
  testing: ReadonlySet<string>
  /** 各模型的最近一次测试结论，键是模型 id；缺 = 那个模型还没测过。 */
  probed: ReadonlyMap<string, ConnectionTestView>
  modelDraft: ModelDraft | null
  /** 批量文本面板的正文（null = 这个端点没开着它）。 */
  bulkText: string | null
  keyEdit: boolean
  keyValue: string
  onSelectModelDefault(model: string): void
  onProbe(model: string): void
  onDiscover(): void
  onOpenBulk(): void
  onCloseBulk(): void
  onBulkText(value: string): void
  onBulkSave(text: string): void
  onEditModel(index: number, model: ProviderModelView): void
  onAddModel(): void
  onModelChange(model: ProviderModelView): void
  onModelCancel(): void
  onModelSave(index: number | null, model: ProviderModelView): void
  onRemoveModel(index: number): void
  onEditProvider(): void
  onRemoveProvider(): void
  onSaveBaseUrl(value: string): void
  onStartKeyEdit(): void
  onCancelKeyEdit(): void
  onKeyValue(value: string): void
  onSaveKey(): void
  onClearKey(): void
}): ReactNode {
  const provider = props.provider
  const label = provider.displayName === '' ? provider.name : provider.displayName
  // 没配密钥的端点不会注册进运行期配置，宿主会拒收「设为默认」——这一类不给可点的钮，
  // 免得用户点了才吃一句奇怪的报错；如实画成不可用，悬浮说明里讲清为什么。
  const usable = provider.keyConfigured
  const keyStatusTip = provider.keyConfigured
    ? `${provider.keyRef} 已就绪，来自环境变量或凭据库`
    : `${provider.keyRef} 尚未配置，该端点暂不可用`
  const draft = props.modelDraft

  return (
    <>
      <div className="provider-head">
        <span className={`provider-avatar lg ${avatarTone(provider.name)}`} aria-hidden="true">
          {initialOf(label)}
        </span>
        <div className="provider-title">
          <span className="provider-title-name">{label}</span>
          <span className="mono provider-id">{provider.name}</span>
          {props.isDefault ? <span className="tag">默认</span> : null}
        </div>
        {props.editable ? (
          <div className="provider-head-acts">
            <button type="button" className="icon-btn" data-provider-edit="1" title="改名字与显示名" onClick={props.onEditProvider}>
              <IconEdit size={14} />
            </button>
            <button type="button" className="icon-btn danger" data-provider-remove="1" title="删除这个端点" onClick={props.onRemoveProvider}>
              <IconTrash size={14} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="conn-card">
        <div className="conn-row">
          <span className="conn-label">Base URL</span>
          {props.editable ? (
            <BaseUrlInput key={`${provider.name}#${provider.baseUrl}`} value={provider.baseUrl} onSave={props.onSaveBaseUrl} />
          ) : (
            <span className="conn-value mono" title={provider.baseUrl}>
              {provider.baseUrl}
            </span>
          )}
        </div>
        <div className="conn-row">
          <span className="conn-label">API Key</span>
          {props.keyEdit && props.editable ? (
            <div className="conn-key-edit">
              <input
                className="setting-input mono"
                type="password"
                autoFocus
                autoComplete="off"
                placeholder={`粘贴 ${provider.keyRef} 的值`}
                aria-label="API key"
                value={props.keyValue}
                onChange={(event) => {
                  props.onKeyValue(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && props.keyValue.trim() !== '') props.onSaveKey()
                  if (event.key === 'Escape') props.onCancelKeyEdit()
                }}
              />
              <button type="button" className="btn-ghost" disabled={props.keyValue.trim() === ''} onClick={props.onSaveKey}>
                保存
              </button>
              <button type="button" className="text-btn" onClick={props.onCancelKeyEdit}>
                取消
              </button>
            </div>
          ) : (
            <div className="conn-key" title={keyStatusTip}>
              <span className={`conn-dot${provider.keyConfigured ? ' ok' : ' warn'}`} aria-hidden="true" />
              <span className="conn-key-text">
                {provider.keyConfigured ? '已配置' : '未配置'} · <span className="mono">{provider.keyRef}</span>
              </span>
              {props.editable ? (
                <>
                  <button type="button" className="text-btn" data-key-edit="1" title="写一个新值覆盖它" onClick={props.onStartKeyEdit}>
                    {provider.keyConfigured ? '替换' : '填写'}
                  </button>
                  {provider.keyConfigured ? (
                    <button type="button" className="text-btn danger" data-key-clear="1" title="从凭据库里删掉这个 key" onClick={props.onClearKey}>
                      清除
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="model-block">
        <div className="model-block-head">
          <span className="model-block-title">模型</span>
          <span className="count">{provider.models.length}</span>
          <div className="model-block-tools">
            <button
              type="button"
              className="icon-btn"
              data-model-bulk="1"
              title="批量文本 · 一行一个模型，一次改一批"
              aria-label="批量文本"
              onClick={props.onOpenBulk}
            >
              <IconSwap size={14} />
            </button>
            <button
              type="button"
              className="btn-ghost"
              data-model-discover="1"
              disabled={props.discovering}
              title="拉取清单 · 从端点拉取线上可用模型清单"
              onClick={props.onDiscover}
            >
              <IconRefresh size={13} className={props.discovering ? 'spin' : undefined} /> 拉取清单
            </button>
            {props.editable ? (
              <button type="button" className="btn-ghost" data-model-add="1" onClick={props.onAddModel}>
                <IconPlus size={13} /> 添加模型
              </button>
            ) : null}
          </div>
        </div>

        {props.bulkText !== null ? (
          <div className="model-edit bulk" data-model-bulk-box="1">
            <textarea
              className="setting-input mono tall"
              autoFocus
              aria-label="批量文本：一行一个模型"
              rows={Math.max(4, provider.models.length + 1)}
              value={props.bulkText}
              placeholder={'deepseek-chat, DeepSeek Chat, 64000, 8192\ndeepseek-reasoner, DeepSeek R1, 64000'}
              onChange={(event) => {
                props.onBulkText(event.target.value)
              }}
            />
            <div className="model-edit-acts">
              <button type="button" className="btn-primary" data-model-bulk-save="1" onClick={() => props.onBulkSave(props.bulkText ?? '')}>
                保存
              </button>
              <button type="button" className="btn-ghost" onClick={props.onCloseBulk}>
                取消
              </button>
              <span className="model-edit-hint">一行一个：id, 显示名, 上下文, 最大输出；思考档位与输入类型按原样保留</span>
            </div>
          </div>
        ) : null}

        <div className="model-list" data-model-list={provider.name}>
          {provider.models.map((model, index) => {
            const rowDraft = draft !== null && draft.index === index ? draft : null
            const editing = rowDraft !== null
            // 正在编辑的那一行画的是草稿（改什么当场看见什么），别的行画配置里那份
            const shown = rowDraft === null ? model : rowDraft.model
            const isDefault = props.isDefault && props.defaultModel === model.id
            const busy = props.testing.has(model.id)
            const result = props.probed.get(model.id)
            const ctx = contextLabel(shown.contextWindow)
            return (
              <div
                key={`${model.id}#${String(index)}`}
                className={`model-item${editing ? ' editing' : ''}`}
                data-model-chip={model.id}
                data-model-default={isDefault ? '1' : null}
              >
                <div className="model-item-main">
                  <button
                    type="button"
                    className="model-pick"
                    data-model-set-default={model.id}
                    aria-pressed={isDefault}
                    disabled={!usable}
                    title={
                      usable
                        ? isDefault
                          ? `${model.id} 是当前默认模型`
                          : `设为默认模型（${model.id}）`
                        : `该端点没配密钥（${provider.keyRef}），暂不能设为默认`
                    }
                    onClick={() => {
                      props.onSelectModelDefault(model.id)
                    }}
                  >
                    <span className="model-pick-dot" aria-hidden="true" />
                  </button>
                  <span className="model-name">{shown.name === '' ? shown.id : shown.name}</span>
                  {shown.name !== '' && shown.name !== shown.id ? <span className="model-id mono">{shown.id}</span> : null}
                  <span className="model-caps-line">
                    {ctx === '' ? null : (
                      <span className="model-ctx mono" title={`上下文窗口 ${String(shown.contextWindow)}`}>
                        {ctx}
                      </span>
                    )}
                    {shown.modalities.includes('image') ? <span className="cap-badge">图</span> : null}
                    {shown.modalities.includes('video') ? <span className="cap-badge">视频</span> : null}
                    {shown.thinkingLevels.length === 0 ? <span className="cap-badge dim">无思考</span> : null}
                  </span>
                  {isDefault ? <span className="tag">默认</span> : null}
                  <span className="model-item-acts">
                    {/* 测试连接挂在**这个模型**后面（不是端点那排动作里）：用户要知道的是「这一条路
                        能不能通」。与「拉取清单」的分工：那个只证明地址可达，这个证明 key / 模型 /
                        协议 / 端点要的头这一整套（走的是与正常对话同一条链路）。结论留在它后面。 */}
                    <button
                      type="button"
                      className={`icon-btn model-probe${busy ? ' busy' : ''}`}
                      data-probe-model={model.id}
                      disabled={!usable || busy}
                      title={
                        !usable
                          ? `该端点没配密钥（${provider.keyRef}），测不了`
                          : busy
                            ? `正在测 ${model.id}…`
                            : `测试连接 · 拿 ${model.id} 真发一次最小请求（与正常对话同一条链路）`
                      }
                      onClick={() => {
                        props.onProbe(model.id)
                      }}
                    >
                      <IconBolt size={12} />
                    </button>
                    {result === undefined ? null : (
                      <span
                        className={`probe-badge${result.ok ? ' ok' : ' bad'}`}
                        data-probe={result.ok ? 'ok' : 'fail'}
                        data-probe-model={model.id}
                        title={probeTip(result)}
                      >
                        {result.ok ? '✓' : '✗'}
                      </span>
                    )}
                    {props.editable ? (
                      <>
                        <button
                          type="button"
                          className={`icon-btn${editing ? ' on' : ''}`}
                          data-model-edit={model.id}
                          aria-pressed={editing}
                          title={editing ? '收起编辑器' : `编辑 ${model.id} 的能力`}
                          onClick={() => {
                            if (editing) {
                              props.onModelCancel()
                              return
                            }
                            props.onEditModel(index, model)
                          }}
                        >
                          <IconEdit size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger"
                          data-model-remove={model.id}
                          title={`删除模型 ${model.id}`}
                          onClick={() => {
                            props.onRemoveModel(index)
                          }}
                        >
                          <IconTrash size={13} />
                        </button>
                      </>
                    ) : null}
                  </span>
                </div>

                {rowDraft === null ? null : (
                  <div className="model-edit" data-model-edit-box={model.id}>
                    <ModelFields
                      model={rowDraft.model}
                      onChange={(patch) => {
                        props.onModelChange({ ...rowDraft.model, ...patch })
                      }}
                      onLevels={(levels) => {
                        props.onModelChange({ ...rowDraft.model, thinkingLevels: levels })
                      }}
                    />
                    <div className="model-edit-acts">
                      <button
                        type="button"
                        className="btn-primary"
                        data-model-save={model.id}
                        onClick={() => {
                          props.onModelSave(rowDraft.index, rowDraft.model)
                        }}
                      >
                        保存
                      </button>
                      <button type="button" className="btn-ghost" onClick={props.onModelCancel}>
                        取消
                      </button>
                      <span className="model-edit-hint">{modelCapsSummary(rowDraft.model)}</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {provider.models.length === 0 ? (
            <div className="model-list-empty">
              这个端点还没有模型{props.editable ? '：点「添加模型」手填一个，或「拉取清单」从线上挑' : ''}。
            </div>
          ) : null}

          {/* 新加的一行：编辑器就长在列表末尾，存下去才真的多一行。 */}
          {draft !== null && draft.index === null ? (
            <div className="model-item editing new" data-model-add-box="1">
              <div className="model-edit">
                <ModelFields
                  model={draft.model}
                  onChange={(patch) => {
                    props.onModelChange({ ...draft.model, ...patch })
                  }}
                  onLevels={(levels) => {
                    props.onModelChange({ ...draft.model, thinkingLevels: levels })
                  }}
                />
                <div className="model-edit-acts">
                  <button type="button" className="btn-primary" data-model-save="new" onClick={() => props.onModelSave(null, draft.model)}>
                    保存
                  </button>
                  <button type="button" className="btn-ghost" onClick={props.onModelCancel}>
                    取消
                  </button>
                  <span className="model-edit-hint">模型 id 就是请求里发的名字</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

/**
 * Base URL 那一行：输入框，失焦或回车保存（与设置页其它文本框同一条规矩——不边打字边写盘）。
 *
 * 值由外面用 `key` 钉住（换端点、或保存回来后重挂），所以这里只管本地的这份原文。
 */
function BaseUrlInput(props: { value: string; onSave(value: string): void }): ReactNode {
  const [value, setValue] = useState(props.value)
  return (
    <input
      className="setting-input mono conn-input"
      value={value}
      spellCheck={false}
      autoComplete="off"
      aria-label="Base URL"
      title="失焦或回车保存"
      onChange={(event) => {
        setValue(event.target.value)
      }}
      onBlur={() => {
        props.onSave(value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setValue(props.value)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * 端点表单（新增 / 改名共用）：占满右栏。
 *
 * 新增时是全量字段（名字、显示名、Base URL、API key、第一个模型）——宿主拒收没有模型的端点，
 * 所以第一个模型就在表单里填；建好之后模型都在右栏清单里加。改名时只剩名字与显示名，
 * 地址与密钥在详情里就地改（表单开着时右栏被它占着，收起就看得见）。
 */
function PaneForm(props: {
  draft: ProviderDraft
  isNew: boolean
  providers: readonly ProviderView[]
  onChange(draft: ProviderDraft): void
  onCancel(): void
  onSubmit(draft: ProviderDraft, apiKey: string): void
}): ReactNode {
  /** 批量文本模式：一行一个快改 id / 显示名 / 上下文 / 最大输出；档位与输入类型按原行保留。 */
  const [bulk, setBulk] = useState(false)
  const [bulkText, setBulkText] = useState(() => formatModels(props.draft.models))
  const [apiKey, setApiKey] = useState('')
  const isNew = props.isNew

  /** 进出批量文本各同步一次，两种录入方式不会各说各话。 */
  const switchBulk = (): void => {
    if (bulk) props.onChange({ ...props.draft, models: mergeCaps(props.draft.models, parseModels(bulkText)) })
    else setBulkText(formatModels(props.draft.models))
    setBulk(!bulk)
  }

  /** 改其中一行模型（其余行原样留着）。 */
  const patchModel = (index: number, patch: Partial<ProviderModelView>): void => {
    props.onChange({
      ...props.draft,
      models: props.draft.models.map((model, at) => (at === index ? { ...model, ...patch } : model)),
    })
  }

  const removeModel = (index: number): void => {
    props.onChange({ ...props.draft, models: props.draft.models.filter((_, at) => at !== index) })
  }

  /** 保存：批量文本模式的改动先合回草稿，再整份交出去（与旧版 `save` 同一顺序）。 */
  const save = (): void => {
    const models = bulk ? mergeCaps(props.draft.models, parseModels(bulkText)) : props.draft.models
    props.onSubmit({ ...props.draft, models }, apiKey)
  }

  return (
    <div className="pane-form" data-provider-form={isNew ? 'new' : String(props.draft.oldName)}>
      <div className="pane-form-title">{isNew ? '新增端点' : `编辑端点「${String(props.draft.oldName)}」`}</div>
      <p className="pane-form-lead">
        {isNew
          ? '端点名是 config.yaml 里的键；至少要填一个模型，建好之后可以「拉取清单」把线上模型一次挑进来。'
          : '这里只改名字与显示名。地址与密钥在上一条详情的连接行里就地改。'}
      </p>
      <div className="pane-form-grid">
        <label className="field">
          <span>名字：小写字母、数字、- 或 _，作为 config.yaml 的键</span>
          <input
            className="setting-input mono"
            value={props.draft.name}
            placeholder="deepseek"
            spellCheck={false}
            onChange={(event) => {
              props.onChange({ ...props.draft, name: event.target.value })
            }}
          />
        </label>
        <label className="field">
          <span>显示名</span>
          <input
            className="setting-input"
            value={props.draft.displayName}
            placeholder="DeepSeek"
            onChange={(event) => {
              props.onChange({ ...props.draft, displayName: event.target.value })
            }}
          />
        </label>
        {isNew ? (
          <>
            <label className="field wide">
              <span>Base URL</span>
              <input
                className="setting-input mono"
                value={props.draft.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                spellCheck={false}
                onChange={(event) => {
                  props.onChange({ ...props.draft, baseUrl: event.target.value })
                }}
              />
            </label>
            <label className="field wide">
              <span>API key（可留空：留空 = 不写凭据库，之后在详情里填）</span>
              <input
                className="setting-input mono"
                type="password"
                value={apiKey}
                placeholder="sk-…"
                autoComplete="off"
                onChange={(event) => {
                  setApiKey(event.target.value)
                }}
              />
            </label>
          </>
        ) : null}
        <div className="field wide">
          <div className="model-rows-head">
            <span>模型：id 是请求里发的名字，上下文窗口必填（不知道就填 128000）</span>
            <div className="model-rows-tools">
              <button type="button" className="text-btn" data-form-bulk="1" title="批量编辑：一行一个模型" onClick={switchBulk}>
                <IconSwap size={13} /> {bulk ? '回到表格' : '批量文本'}
              </button>
              <button
                type="button"
                className="text-btn"
                data-form-model-add="1"
                title="再加一个模型"
                onClick={() => {
                  props.onChange({ ...props.draft, models: [...props.draft.models, blankModel()] })
                }}
              >
                <IconPlus size={13} /> 加模型
              </button>
            </div>
          </div>
          {bulk ? (
            <textarea
              className="setting-input mono tall"
              rows={Math.max(3, props.draft.models.length + 1)}
              value={bulkText}
              placeholder={'deepseek-chat, DeepSeek Chat, 64000, 8192\ndeepseek-reasoner, DeepSeek R1, 64000'}
              onChange={(event) => {
                setBulkText(event.target.value)
              }}
            />
          ) : (
            <>
              {props.draft.models.map((model, index) => (
                <div className="model-row" key={index}>
                  <ModelFields
                    model={model}
                    onChange={(patch) => {
                      patchModel(index, patch)
                    }}
                    onLevels={(levels) => {
                      patchModel(index, { thinkingLevels: levels })
                    }}
                    onRemove={props.draft.models.length > 1 ? () => removeModel(index) : undefined}
                  />
                </div>
              ))}
              {props.draft.models.length === 0 ? (
                <div className="model-rows-empty">这个端点还没有模型，点「加模型」填第一个（模型 id 就是请求里发的名字）。</div>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="pane-form-actions">
        <button type="button" className="btn-primary" data-provider-save="1" onClick={save}>
          {isNew ? '创建端点' : '保存'}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onCancel}>
          取消
        </button>
        <span className="pane-form-hint">API key 只写进凭据库，不进配置文件</span>
      </div>
    </div>
  )
}

/**
 * 一个模型的字段与能力（模型编辑器与端点表单共用同一块）：
 * 上面一行是 id / 显示名 / 上下文 / 最大输出，下面一行是能力（思考档位四档、档位走哪个
 * 字段、线上值、输入模态三档）。
 *
 * 两个 token 数认 `128k` / `1m` 这种写法，所以本地存一份原文、失焦再归一化；其余字段
 * 都是改一下就报给调用方（调用方接的是「这一行的草稿」）。
 */
function ModelFields(props: {
  model: ProviderModelView
  onChange(patch: Partial<ProviderModelView>): void
  onLevels(levels: ThinkingLevel[]): void
  /** 给了才画删除钮（端点表单里用；详情列表里那一行有自己的删除钮）。 */
  onRemove?: (() => void) | undefined
}): ReactNode {
  const model = props.model
  // token 数这两个框让用户手打（128k 也认），所以本地存一份原文，失焦再归一化
  const [ctxText, setCtxText] = useState(model.contextWindow > 0 ? String(model.contextWindow) : '')
  const [outText, setOutText] = useState(model.maxTokens > 0 ? String(model.maxTokens) : '')

  /** 归一化一个 token 数输入；解析不出来就退回模型上已经有的值。 */
  const commit = (
    raw: string,
    field: 'contextWindow' | 'maxTokens',
    fallback: number,
    sync: (value: string) => void,
  ): void => {
    const parsed = parseTokenCount(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      sync(fallback > 0 ? String(fallback) : '')
      return
    }
    props.onChange({ [field]: Math.round(parsed) } as Partial<ProviderModelView>)
    sync(String(Math.round(parsed)))
  }

  /** 改某一档的线上值；清空 = 用内置值（读取时按缺省表补）。 */
  const patchWire = (level: ThinkingLevel, value: string): void => {
    const map: EffortMap = { ...model.effortMap }
    const trimmed = value.trim()
    if (trimmed === '') delete map[level]
    else map[level] = trimmed
    props.onChange({ effortMap: map })
  }

  /** 勾/去勾一档思考（结果始终按固定顺序排，免得勾选顺序随点击跑乱）。 */
  const toggleLevel = (level: ThinkingLevel): void => {
    const wanted = new Set(model.thinkingLevels)
    if (wanted.has(level)) wanted.delete(level)
    else wanted.add(level)
    props.onLevels(THINKING_LEVELS.filter((entry) => wanted.has(entry)))
  }

  /** 勾/去勾一种输入类型；文本永远留着（协议里没有文本就发不出消息）。 */
  const toggleModality = (modality: Modality): void => {
    if (modality === 'text') return
    const wanted = new Set(model.modalities)
    if (wanted.has(modality)) wanted.delete(modality)
    else wanted.add(modality)
    props.onChange({ modalities: MODALITIES.filter((entry) => wanted.has(entry)) })
  }

  return (
    <>
      <div className="model-row-main">
        <label className="model-row-field">
          <span>模型 id</span>
          <input
            className="setting-input mono"
            placeholder="请求里发的名字"
            value={model.id}
            spellCheck={false}
            onChange={(event) => {
              props.onChange({ id: event.target.value })
            }}
          />
        </label>
        <label className="model-row-field">
          <span>显示名</span>
          <input
            className="setting-input"
            placeholder="留空 = 用 id"
            value={model.name === model.id ? '' : model.name}
            onChange={(event) => {
              props.onChange({ name: event.target.value })
            }}
          />
        </label>
        <label className="model-row-field">
          <span>上下文</span>
          <input
            className="setting-input mono"
            inputMode="numeric"
            placeholder="128000"
            value={ctxText}
            onChange={(event) => {
              setCtxText(event.target.value)
            }}
            onBlur={(event) => {
              commit(event.target.value, 'contextWindow', model.contextWindow, setCtxText)
            }}
          />
        </label>
        <label className="model-row-field">
          <span>最大输出</span>
          <input
            className="setting-input mono"
            inputMode="numeric"
            placeholder="8192"
            value={outText}
            onChange={(event) => {
              setOutText(event.target.value)
            }}
            onBlur={(event) => {
              commit(event.target.value, 'maxTokens', model.maxTokens, setOutText)
            }}
          />
        </label>
        {props.onRemove !== undefined ? (
          <button type="button" className="text-btn danger" data-model-remove-row="1" title="删掉这个模型" onClick={props.onRemove}>
            <IconTrash size={13} />
          </button>
        ) : null}
      </div>
      <div className="model-row-caps">
        <span className="cap-label" title="这个模型支持的思考档位；没勾的档位在聊天里不会出现">
          思考档位
        </span>
        <span className="cap-group">
          {THINKING_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`cap-chip${model.thinkingLevels.includes(level) ? ' on' : ''}`}
              data-cap-level={level}
              aria-pressed={model.thinkingLevels.includes(level)}
              title={`思考档位「${THINKING_LEVEL_LABELS[level]}」${model.thinkingLevels.includes(level) ? '，已勾选' : '，没勾选'}`}
              onClick={() => {
                toggleLevel(level)
              }}
            >
              {THINKING_LEVEL_LABELS[level]}
            </button>
          ))}
        </span>
        <Select
          className="setting-select cap-param"
          value={model.thinkingParam}
          options={THINKING_PARAMS.map((param) => ({ value: param, label: THINKING_PARAM_LABELS[param].label }))}
          onPick={(next) => {
            props.onChange({ thinkingParam: next })
          }}
          ariaLabel="思考档位字段"
        />
        {model.thinkingParam === 'reasoning-effort' ? (
          <span className="cap-wire">
            <span className="cap-label" title="发给端点的档位值；留空 = 用内置值">
              线上值
            </span>
            {THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level)).map((level) => (
              <label className="cap-wire-field" key={level}>
                <span>{THINKING_LEVEL_LABELS[level]}</span>
                <input
                  className="setting-input mono cap-wire-input"
                  placeholder={EFFORT_WIRE_HINT[level]}
                  value={model.effortMap[level] ?? ''}
                  data-cap-wire={level}
                  spellCheck={false}
                  title={`发给端点的 ${THINKING_LEVEL_LABELS[level]} 档写这个值；留空 = ${EFFORT_WIRE_HINT[level]}`}
                  onChange={(event) => {
                    patchWire(level, event.target.value)
                  }}
                />
              </label>
            ))}
          </span>
        ) : null}
        <span className="cap-label" title="模型可接收的输入类型；没勾照片就发不出图片">
          输入
        </span>
        <span className="cap-group">
          {MODALITIES.map((modality) => (
            <button
              key={modality}
              type="button"
              className={`cap-chip${model.modalities.includes(modality) ? ' on' : ''}`}
              data-cap-modality={modality}
              disabled={modality === 'text'}
              aria-pressed={model.modalities.includes(modality)}
              title={
                modality === 'text'
                  ? '文本永远要勾（协议里没有文本就发不出消息）'
                  : `${MODALITY_LABELS[modality]}输入${model.modalities.includes(modality) ? '，点一下取消' : '，点一下勾上'}`
              }
              onClick={() => {
                toggleModality(modality)
              }}
            >
              {MODALITY_LABELS[modality]}
            </button>
          ))}
        </span>
      </div>
    </>
  )
}

/**
 * 拉取清单弹窗（dsh 式）：搜索 + 全选/全不选 + 复选 + 一次「采用选中的 N 个」。
 *
 * 默认勾上「尚未加进端点」的那些——拉清单的意图通常就是把新模型补进来；已经在端点里的
 * 不可勾（重复 id 会被宿主的保存校验拒掉）。
 *
 * 每一行右边写着**推断出来的能力**（窗口 / 图 / 视频 / 无思考），鼠标停上去还有一句
 * 「这份能力是从哪来的」——推断不是查表保真，得让用户看得见自己在采纳什么。
 */
function DiscoverDialog(props: {
  provider: ProviderView | null
  models: string[]
  infer(id: string): InferredCaps
  onClose(): void
  onAdopt(ids: string[]): void
}): ReactNode {
  const [query, setQuery] = useState('')
  const provider = props.provider
  /** 端点里已有的 id（弹窗开着时端点清单可能被别处改过，每次渲染现算）。 */
  const existing = new Set(provider?.models.map((model) => model.id) ?? [])
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(props.models.filter((id) => !existing.has(id))))
  const filtered = useMemo(
    () =>
      props.models.filter((id) =>
        query.trim() === '' ? true : id.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [props.models, query],
  )
  /** 当前筛选结果里可勾的那些（全选只作用于看得见的这几条）。 */
  const selectable = filtered.filter((id) => !existing.has(id))
  const chosenVisible = selectable.filter((id) => chosen.has(id)).length

  // Esc 关弹窗：与检查器同一套退路。依赖写成 props.onClose 的「快照」会每次重挂，
  // 这里干脆依赖整个 props（弹窗生命周期很短，多挂几次监听不是问题）。
  const onClose = props.onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (provider === null) return null

  const toggle = (id: string): void => {
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAllVisible = (): void => {
    setChosen((current) => {
      const next = new Set(current)
      if (chosenVisible === selectable.length) {
        for (const id of selectable) next.delete(id)
      } else {
        for (const id of selectable) next.add(id)
      }
      return next
    })
  }

  return (
    <div
      className="dsc-overlay models-discover"
      data-models-discover="1"
      role="dialog"
      aria-modal="true"
      aria-label="拉取线上模型清单"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="dsc-overlay__card models-discover-card">
        <div className="models-discover-head">
          <span className="models-discover-title">
            线上模型清单 · {provider.displayName === '' ? provider.name : provider.displayName}
          </span>
          <span className="models-discover-count">
            {props.models.length} 个，已加 {existing.size} 个
          </span>
          <button type="button" className="text-btn" data-models-discover-close="1" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="models-discover-search">
          <IconSearch size={12} />
          <input
            className="setting-input"
            type="search"
            autoFocus
            placeholder="按 id 过滤…"
            aria-label="过滤线上模型"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
            }}
          />
          <button type="button" className="text-btn" data-models-discover-all="1" onClick={toggleAllVisible}>
            {chosenVisible === selectable.length && selectable.length > 0 ? '全不选' : '全选'}
          </button>
        </div>
        <ul className="models-discover-list">
          {filtered.map((id) => {
            const has = existing.has(id)
            const on = chosen.has(id)
            const caps = props.infer(id)
            return (
              <li key={id}>
                <button
                  type="button"
                  className={`models-discover-item${on ? ' on' : ''}${has ? ' exists' : ''}`}
                  data-discover-item={id}
                  data-discover-source={caps.source}
                  disabled={has}
                  aria-pressed={on}
                  title={
                    has
                      ? '已经在端点里了（重复 id 保存会被拒）'
                      : `${caps.note}${on ? ' · 点一下取消' : ' · 点一下勾上'}`
                  }
                  onClick={() => {
                    toggle(id)
                  }}
                >
                  <span className="models-discover-check">{on ? <IconCheck size={11} /> : null}</span>
                  <span className="mono">{id}</span>
                  <span className="models-discover-caps">
                    <span className="ctx">{contextLabel(caps.contextWindow)}</span>
                    {caps.modalities.includes('image') ? <span className="cap-badge">图</span> : null}
                    {caps.modalities.includes('video') ? <span className="cap-badge">视频</span> : null}
                    {caps.thinkingLevels.length === 0 ? <span className="cap-badge dim">无思考</span> : null}
                  </span>
                  {has ? <span className="models-discover-tag">已有</span> : null}
                </button>
              </li>
            )
          })}
          {filtered.length === 0 ? <li className="models-discover-none">没有匹配「{query.trim()}」的模型。</li> : null}
        </ul>
        <div className="models-discover-actions">
          <button
            type="button"
            className="btn-primary"
            data-models-discover-adopt="1"
            disabled={chosen.size === 0}
            onClick={() => {
              props.onAdopt(props.models.filter((id) => chosen.has(id)))
            }}
          >
            采用选中的 {chosen.size} 个
          </button>
          <span className="pane-form-hint">
            每行的窗口 / 图片 / 视频都是推断出来的（停上去看依据），加完可在列表里逐项改。
          </span>
        </div>
      </div>
    </div>
  )
}
