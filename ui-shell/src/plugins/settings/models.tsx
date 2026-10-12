/**
 * 设置 → 模型：端点清单的增删改、模型能力编辑、默认模型选择、线上清单拉取。
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
 * 3. **版式照旧桌面端**（class 名与 `legacy/views.css` 的 provider-* / model-row-* / cap-* 逐条
 *    对位），另补两处 dsh 式形态：列表尾的「＋添加端点」虚线卡（新增表单就地长在那里）、
 *    拉取清单弹窗（搜索 + 全选 + 复选 + 一次采用，不是旧版的逐个「+」）。
 *
 * @module dsc-ui-shell/plugins/settings/models
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_CAPS,
  EFFORT_WIRE_HINT,
  IconCheck,
  IconEdit,
  IconKey,
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
  type EffortMap,
  type Modality,
  type ModelConfigView,
  type ProviderDraft,
  type ProviderModelView,
  type ProviderView,
  type SettingsMutation,
  type ThinkingLevel,
} from '@dsc/ui'
import { Select } from '../../platform/select'

/** 拿异常的文字形态。 */
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** 空白端点草稿（新增用）。 */
function blankDraft(): ProviderDraft {
  return { oldName: null, name: '', displayName: '', baseUrl: '', models: [blankModel()] }
}

/** 拉取清单里挑中的一个模型：按缺省能力装进端点（旧版 `defaultDiscoveredModel` 同款）。 */
function discoveredModel(id: string): ProviderModelView {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: [...DEFAULT_CAPS.thinkingLevels],
    thinkingParam: DEFAULT_CAPS.thinkingParam,
    effortMap: {},
    modalities: [...DEFAULT_CAPS.modalities],
  }
}

/**
 * 保存前的校验（宿主也会校验；这里先拦一道是为了把错误当面说清，而不是保存一次才吃回执）。
 *
 * 三条硬规矩：端点名是小写字母 / 数字 / - / _（它是 config.yaml 的键）、模型 id 必填且不重复、
 * 两个 token 数要么留空（0）要么是正整数。
 */
function validateDraft(draft: ProviderDraft, others: readonly ProviderView[]): string | null {
  const name = draft.name.trim()
  if (name === '') return '端点名不能为空（它是 config.yaml 里的键）。'
  if (!/^[a-z0-9_-]+$/.test(name)) return '端点名只能用小写字母、数字、- 或 _。'
  if (draft.baseUrl.trim() === '') return 'Base URL 不能为空。'
  if (others.some((entry) => entry.name === name && entry.name !== draft.oldName)) {
    return `已经有一个叫 ${name} 的端点了。`
  }
  const seen = new Set<string>()
  for (const model of draft.models) {
    const id = model.id.trim()
    if (id === '') return '每个模型都要填 id（请求里发的就是它）。'
    if (seen.has(id)) return `模型 id 重复了：${id}`
    if (model.contextWindow < 0 || !Number.isInteger(model.contextWindow)) return `${id} 的上下文窗口要填正整数。`
    if (model.maxTokens < 0 || !Number.isInteger(model.maxTokens)) return `${id} 的最大输出要填正整数。`
  }
  return null
}

/** 一个模型的能力摘要（端点卡片上模型钮的悬浮提示）。 */
function modelCapsSummary(model: ProviderModelView): string {
  const ctx = model.contextWindow > 0 ? `${String(Math.round(model.contextWindow / 1000))}k 上下文` : '上下文窗口没填'
  const thinking =
    model.thinkingLevels.length === 0 ? '没有思考档位' : `思考档位 ${String(model.thinkingLevels.length)} 档`
  const inputs = model.modalities.join('/')
  return [ctx, thinking, `输入 ${inputs}`].join(' · ')
}

export function ModelsGroup(): ReactNode {
  const channel = useHostChannel()
  /** 原生桥：三处写操作（保存 / 删除 / 写 key）的唯一通路；不在时整页只读。 */
  const native = getHostNative()
  const editable = native.available

  const [config, setConfig] = useState<ModelConfigView | null>(null)
  /** 正在编辑 / 新增的端点草稿（null = 没有表单开着）。 */
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  /** 卡片上快捷填密钥的那一张（null = 没展开）。 */
  const [keyFor, setKeyFor] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState('')
  /** 拉取清单弹窗：哪一张卡、拉到了什么。 */
  const [discovered, setDiscovered] = useState<{ provider: string; models: string[] } | null>(null)
  const [discovering, setDiscovering] = useState(false)

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
    setDiscovering(true)
    void channel
      .invoke<string[]>('discoverModels', [provider])
      .then((models) => {
        setDiscovered({ provider, models })
      })
      .catch((error: unknown) => {
        toastErr(`拉取失败：${text(error)}`)
      })
      .finally(() => {
        setDiscovering(false)
      })
  }

  if (config === null) return <div className="settings-empty">正在读取模型配置…</div>

  const providers = config.providers
  const defaultProvider = providers.find((entry) => entry.name === config.defaultProvider)
  const editingProvider = draft !== null && draft.oldName !== null ? draft.oldName : null

  /** 提交一次端点草稿：校验 → 保存 → （填了 key 就）写凭据；失败把原因说出来、表单不收起。 */
  const submitDraft = (current: ProviderDraft, apiKey: string): void => {
    const problem = validateDraft(current, providers)
    if (problem !== null) {
      toastErr(problem)
      return
    }
    const payload: ProviderDraft = {
      oldName: current.oldName,
      name: current.name.trim(),
      displayName: current.displayName.trim(),
      baseUrl: current.baseUrl.trim(),
      models: current.models.map((model) => ({ ...model, id: model.id.trim(), name: model.name.trim() })),
    }
    void (async () => {
      try {
        const result = await native.invoke<SettingsMutation>('saveProvider', [payload])
        if (!result.ok) {
          toastErr(`保存失败：${result.error}`)
          return
        }
        setDraft(null)
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

  return (
    <div className="settings-fields models">
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

      <div className="models-head">
        <span>端点</span>
        <span className="count">{providers.length}</span>
        <button
          type="button"
          className="text-btn models-refresh"
          data-tip="重新读一遍 config.yaml（外部改过文件时用）"
          onClick={reload}
        >
          <IconRefresh size={13} /> 刷新
        </button>
      </div>

      {!editable ? (
        <div className="settings-note" data-models-readonly="1">
          浏览器里只能看：增删端点与填写密钥要写 config.yaml 与凭据库，走的是桌面窗口的原生桥
          （界面通道有意没放行这几个方法）。要改配置请用桌面版。
        </div>
      ) : null}

      {providers.length === 0 ? (
        <div className="settings-empty">还没有端点。{editable ? '点下面的「添加端点」建第一个。' : ''}</div>
      ) : null}

      {providers.map((provider) => (
        <ProviderCard
          key={provider.name}
          provider={provider}
          isDefault={config.defaultProvider === provider.name}
          defaultModel={config.defaultModel}
          editable={editable}
          discovering={discovering}
          keyOpen={keyFor === provider.name}
          keyValue={keyValue}
          draft={editingProvider === provider.name ? draft : null}
          onChangeDraft={setDraft}
          onCancelDraft={() => {
            setDraft(null)
          }}
          onSubmitDraft={submitDraft}
          onOpenKey={() => {
            setKeyFor(provider.name)
            setKeyValue('')
          }}
          onCloseKey={() => {
            setKeyFor(null)
          }}
          onKeyValue={setKeyValue}
          onSaveKey={() => {
            const value = keyValue.trim()
            if (value === '') return
            void bridgeWrite('setProviderKey', [provider.name, value], 'API key 已写进凭据库').then((ok) => {
              if (ok) setKeyFor(null)
            })
          }}
          onClearKey={() => {
            void bridgeWrite('setProviderKey', [provider.name, null], 'API key 已从凭据库移除').then((ok) => {
              if (ok) setKeyFor(null)
            })
          }}
          onSetDefault={(model) => {
            setDefault(provider.name, model)
          }}
          onDiscover={() => {
            discover(provider.name)
          }}
          onEdit={() => {
            setDraft({
              oldName: provider.name,
              name: provider.name,
              displayName: provider.displayName,
              baseUrl: provider.baseUrl,
              models: provider.models.map((model) => ({ ...model })),
            })
          }}
          onRemove={() => {
            const isDefault = config.defaultProvider === provider.name
            void confirmAction({
              title: `删除端点「${provider.displayName === '' ? provider.name : provider.displayName}」？`,
              detail:
                `将从 ${config.configFile} 删除该端点，使用它的会话在下次请求时才会发现不可用；` +
                `其 API key 仍保留在凭据库中，重新添加同名端点后可继续使用。` +
                `${isDefault ? '该端点是当前默认端点，删除后默认端点将自动改为第一个可用端点。' : ''}`,
              confirmLabel: '删除端点',
              danger: true,
            }).then((yes) => {
              if (!yes) return
              void bridgeWrite('removeProvider', [provider.name], `已删除端点「${provider.name}」`).then(() => {
                if (draft !== null && draft.oldName === provider.name) setDraft(null)
              })
            })
          }}
        />
      ))}

      {/* ＋添加端点卡（dsh 式）：点一下在它自己的位置长出新端点表单。 */}
      {editable ? (
        draft !== null && draft.oldName === null ? (
          <ProviderForm
            draft={draft}
            onChange={setDraft}
            onCancel={() => {
              setDraft(null)
            }}
            onSubmit={submitDraft}
          />
        ) : (
          <button type="button" className="models-add-card" data-models-add="1" onClick={() => setDraft(blankDraft())}>
            <IconPlus size={14} /> 添加端点
          </button>
        )
      ) : null}

      <div className="settings-paths">
        <span>配置文件 </span>
        <span className="mono">{config.configFile}</span>
        <span>凭据 </span>
        <span className="mono">{config.credentialsFile}</span>
      </div>

      {discovered === null ? null : (
        <DiscoverDialog
          provider={providers.find((entry) => entry.name === discovered.provider) ?? null}
          models={discovered.models}
          onClose={() => {
            setDiscovered(null)
          }}
          onAdopt={(ids) => {
            const provider = providers.find((entry) => entry.name === discovered.provider)
            if (provider === undefined || ids.length === 0) {
              setDiscovered(null)
              return
            }
            const models = [...provider.models, ...ids.map((id) => discoveredModel(id))]
            void bridgeWrite(
              'saveProvider',
              [
                {
                  oldName: provider.name,
                  name: provider.name,
                  displayName: provider.displayName,
                  baseUrl: provider.baseUrl,
                  models,
                },
              ],
              `已加入 ${String(ids.length)} 个模型`,
            ).then(() => {
              setDiscovered(null)
            })
          }}
        />
      )}
    </div>
  )
}

/**
 * 一张端点卡片：只读信息（名字 / 地址 / 密钥状态）+ 动作（密钥 / 拉取清单 / 编辑 / 删除）
 * + 就地长出的编辑表单、快捷密钥行。
 *
 * 只读档（浏览器里没有桥）里改配置的按钮**不画**（不是画成灰的）——页首已经有一条说明
 * 讲清为什么，摆四个点不动的按钮只会让人一个个去试。
 */
function ProviderCard(props: {
  provider: ProviderView
  isDefault: boolean
  defaultModel: string
  editable: boolean
  discovering: boolean
  keyOpen: boolean
  keyValue: string
  draft: ProviderDraft | null
  onChangeDraft: (draft: ProviderDraft) => void
  onCancelDraft(): void
  onSubmitDraft(draft: ProviderDraft, apiKey: string): void
  onOpenKey(): void
  onCloseKey(): void
  onKeyValue(value: string): void
  onSaveKey(): void
  onClearKey(): void
  onSetDefault(model: string): void
  onDiscover(): void
  onEdit(): void
  onRemove(): void
}): ReactNode {
  const provider = props.provider
  const keyStatusTip = provider.keyConfigured
    ? `${provider.keyRef} 已就绪，来自环境变量或凭据库`
    : `${provider.keyRef} 尚未配置，该端点暂不可用`
  return (
    <div className="provider-card" data-provider={provider.name}>
      <div className="provider-row">
        <div className="provider-main">
          <div className="provider-name">
            {provider.displayName === '' ? provider.name : provider.displayName}
            <span className="mono provider-id">{provider.name}</span>
            {props.isDefault ? <span className="tag">默认</span> : null}
          </div>
          <div className="provider-sub mono" title={provider.baseUrl}>
            {provider.baseUrl}
          </div>
        </div>
        <div className="provider-actions">
          {props.editable ? (
            <button
              type="button"
              className={`text-btn${provider.keyConfigured ? ' ok' : ' warn'}`}
              data-tip={keyStatusTip}
              onClick={props.onOpenKey}
            >
              <IconKey size={13} /> {provider.keyConfigured ? '密钥已配置' : '填写密钥'}
            </button>
          ) : (
            <span className={`text-btn${provider.keyConfigured ? ' ok' : ' warn'}`} data-tip={keyStatusTip}>
              <IconKey size={13} /> {provider.keyConfigured ? '密钥已配置' : '密钥未配置'}
            </span>
          )}
          <button
            type="button"
            className="text-btn"
            data-tip="从端点拉取线上可用模型清单"
            disabled={props.discovering}
            onClick={props.onDiscover}
          >
            {props.discovering ? '拉取中…' : '拉取清单'}
          </button>
          {props.editable ? (
            <>
              <button type="button" className="text-btn" data-tip="编辑这个端点" onClick={props.onEdit}>
                <IconEdit size={13} /> 编辑
              </button>
              <button type="button" className="text-btn danger" data-tip="删除这个端点" onClick={props.onRemove}>
                <IconTrash size={13} /> 删除
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* 快捷密钥行（旧界面同款）：粘贴 → 保存 / 清除；编辑器里也有一个 API key 字段。 */}
      {props.keyOpen && props.editable ? (
        <div className="provider-key">
          <input
            className="setting-input mono"
            type="password"
            autoFocus
            placeholder={`粘贴 ${provider.keyRef} 的值`}
            value={props.keyValue}
            onChange={(event) => {
              props.onKeyValue(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && props.keyValue.trim() !== '') props.onSaveKey()
            }}
          />
          <button type="button" className="btn-primary" disabled={props.keyValue.trim() === ''} onClick={props.onSaveKey}>
            保存
          </button>
          {provider.keyConfigured ? (
            <button type="button" className="btn-ghost" data-tip="从凭据库里删掉这个 key" onClick={props.onClearKey}>
              清除
            </button>
          ) : null}
          <button type="button" className="text-btn" onClick={props.onCloseKey}>
            取消
          </button>
        </div>
      ) : null}

      {/* 编辑表单就长在点「编辑」的那张卡里（旧界面同款），不再永远掉到列表最底下。 */}
      {props.draft !== null ? (
        <ProviderForm draft={props.draft} onChange={props.onChangeDraft} onCancel={props.onCancelDraft} onSubmit={props.onSubmitDraft} />
      ) : null}

      <div className="provider-models">
        {provider.models.map((model) => {
          const isDefault = props.isDefault && props.defaultModel === model.id
          // 没配密钥的端点不会注册进运行期配置，宿主会拒收「设为默认」——这一类不给可点的钮，
          // 免得用户点了才吃一句奇怪的报错；如实画成不可用，悬浮说明里讲清为什么。
          const usable = provider.keyConfigured
          return (
            <button
              key={model.id}
              type="button"
              className={`model-chip${isDefault ? ' on' : ''}`}
              disabled={!usable}
              data-model-chip={model.id}
              data-tip={
                usable
                  ? `${model.id} · ${modelCapsSummary(model)}${isDefault ? ' · 当前默认模型' : ' · 点一下设为默认模型'}`
                  : `${model.id} · ${modelCapsSummary(model)} · 该端点没配密钥（${provider.keyRef}），暂不能设为默认`
              }
              onClick={() => {
                props.onSetDefault(model.id)
              }}
            >
              {model.name === '' ? model.id : model.name}
              {model.contextWindow > 0 ? <span className="ctx">{Math.round(model.contextWindow / 1000)}k</span> : null}
              {model.modalities.includes('image') ? <span className="cap-badge">图</span> : null}
              {model.modalities.includes('video') ? <span className="cap-badge">视频</span> : null}
              {model.thinkingLevels.length === 0 ? <span className="cap-badge dim">无思考</span> : null}
            </button>
          )
        })}
        {provider.models.length === 0 ? (
          <span className="provider-nomodel">
            该端点还没有模型{props.editable ? '：点「编辑」加一个，或用「拉取清单」从线上挑' : ''}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 端点表单（新增 / 编辑共用）：名字、显示名、Base URL、API key（可留空）、模型与能力。
 *
 * API key 放这里是 dsh 的形态（编辑器里一次改完）；留空 = 不动凭据库，
 * 填了就随这次保存一起写——写失败会把「端点已保存、密钥没写成功」分开报出来。
 */
function ProviderForm(props: {
  draft: ProviderDraft
  onChange(draft: ProviderDraft): void
  onCancel(): void
  onSubmit(draft: ProviderDraft, apiKey: string): void
}): ReactNode {
  /** 批量文本模式：一行一个快改 id / 显示名 / 上下文 / 最大输出；档位与输入类型按原行保留。 */
  const [bulk, setBulk] = useState(false)
  const [bulkText, setBulkText] = useState(() => formatModels(props.draft.models))
  const [apiKey, setApiKey] = useState('')
  const isNew = props.draft.oldName === null

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

  /** 勾/去勾一档思考（结果始终按固定顺序排，免得勾选顺序随点击跑乱）。 */
  const toggleLevel = (index: number, level: ThinkingLevel): void => {
    const model = props.draft.models[index]
    if (model === undefined) return
    const wanted = new Set(model.thinkingLevels)
    if (wanted.has(level)) wanted.delete(level)
    else wanted.add(level)
    patchModel(index, { thinkingLevels: THINKING_LEVELS.filter((entry) => wanted.has(entry)) })
  }

  /** 勾/去勾一种输入类型；文本永远留着（协议里没有文本就发不出消息）。 */
  const toggleModality = (index: number, modality: Modality): void => {
    const model = props.draft.models[index]
    if (model === undefined || modality === 'text') return
    const wanted = new Set(model.modalities)
    if (wanted.has(modality)) wanted.delete(modality)
    else wanted.add(modality)
    patchModel(index, { modalities: MODALITIES.filter((entry) => wanted.has(entry)) })
  }

  /** 保存：批量文本模式的改动先合回草稿，再整份交出去（与旧版 `save` 同一顺序）。 */
  const save = (): void => {
    const models = bulk ? mergeCaps(props.draft.models, parseModels(bulkText)) : props.draft.models
    props.onSubmit({ ...props.draft, models }, apiKey)
  }

  return (
    <div className="provider-form" data-provider-form={isNew ? 'new' : String(props.draft.oldName)}>
      <div className="provider-form-title">{isNew ? '添加端点' : `编辑端点 ${String(props.draft.oldName)}`}</div>
      <div className="provider-form-grid">
        <label className="field">
          <span>名字：小写字母、数字、- 或 _，作为 config.yaml 的键</span>
          <input
            className="setting-input mono"
            value={props.draft.name}
            placeholder="deepseek"
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
        <label className="field wide">
          <span>Base URL</span>
          <input
            className="setting-input mono"
            value={props.draft.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            onChange={(event) => {
              props.onChange({ ...props.draft, baseUrl: event.target.value })
            }}
          />
        </label>
        <label className="field wide">
          <span>API key（留空 = 不动凭据库；填了就随这次保存写进去）</span>
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
        <div className="field wide">
          <div className="model-rows-head">
            <span>模型与能力（不勾的思考档位界面上就不出现；不写的字段按默认：thinking 开关 + 四档 + 只吃文本）</span>
            <div className="model-rows-tools">
              <button
                type="button"
                className="text-btn"
                data-tip="用一行一个的文本快改 id / 显示名 / 上下文窗口 / 最大输出"
                onClick={switchBulk}
              >
                <IconSwap size={13} /> {bulk ? '回到表格' : '批量文本'}
              </button>
              <button
                type="button"
                className="text-btn"
                data-tip="再加一个模型"
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
                <ModelRow
                  key={index}
                  model={model}
                  onPatch={(patch) => {
                    patchModel(index, patch)
                  }}
                  onToggleLevel={(level) => {
                    toggleLevel(index, level)
                  }}
                  onToggleModality={(modality) => {
                    toggleModality(index, modality)
                  }}
                  onRemove={
                    props.draft.models.length > 1
                      ? () => {
                          removeModel(index)
                        }
                      : undefined
                  }
                />
              ))}
              {props.draft.models.length === 0 ? (
                <div className="model-rows-empty">这个端点还没有模型，点「加模型」填第一个（模型 id 就是请求里发的名字）。</div>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="provider-form-actions">
        <button type="button" className="btn-primary" data-provider-save="1" onClick={save}>
          保存
        </button>
        <button type="button" className="btn-ghost" onClick={props.onCancel}>
          取消
        </button>
        <span className="provider-form-hint">API key 只写进凭据库，不进配置文件</span>
      </div>
    </div>
  )
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

/**
 * 表单里的一个模型一行：上面一行是 id / 显示名 / 两个 token 数，
 * 下面一行是能力（思考档位四档、档位走哪个字段、线上值、输入类型三档）。
 */
function ModelRow(props: {
  model: ProviderModelView
  onPatch(patch: Partial<ProviderModelView>): void
  onToggleLevel(level: ThinkingLevel): void
  onToggleModality(modality: Modality): void
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
    props.onPatch({ [field]: Math.round(parsed) } as Partial<ProviderModelView>)
    sync(String(Math.round(parsed)))
  }

  /** 改某一档的线上值；清空 = 用内置值（读取时按缺省表补）。 */
  const patchWire = (level: ThinkingLevel, value: string): void => {
    const map: EffortMap = { ...model.effortMap }
    const trimmed = value.trim()
    if (trimmed === '') delete map[level]
    else map[level] = trimmed
    props.onPatch({ effortMap: map })
  }

  return (
    <div className="model-row">
      <div className="model-row-main">
        <label className="model-row-field">
          <span>模型 id</span>
          <input
            className="setting-input mono"
            placeholder="请求里发的名字"
            value={model.id}
            onChange={(event) => {
              props.onPatch({ id: event.target.value })
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
              props.onPatch({ name: event.target.value })
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
          <button type="button" className="text-btn danger" data-tip="删掉这个模型" onClick={props.onRemove}>
            <IconTrash size={13} />
          </button>
        ) : null}
      </div>
      <div className="model-row-caps">
        <span className="cap-label" data-tip="这个模型支持哪几档思考：思考面板只列勾上的这些">
          思考档位
        </span>
        <span className="cap-group">
          {THINKING_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`cap-chip${model.thinkingLevels.includes(level) ? ' on' : ''}`}
              data-cap-level={level}
              data-tip={`思考档位「${THINKING_LEVEL_LABELS[level]}」${model.thinkingLevels.includes(level) ? '，点一下取消' : '，点一下勾上'}`}
              onClick={() => {
                props.onToggleLevel(level)
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
            props.onPatch({ thinkingParam: next })
          }}
          ariaLabel="思考参数"
        />
        {model.thinkingParam === 'reasoning-effort' ? (
          <span className="cap-wire">
            <span className="cap-label">线上值</span>
            {THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level)).map((level) => (
              <label className="cap-wire-field" key={level}>
                <span>{THINKING_LEVEL_LABELS[level]}</span>
                <input
                  className="setting-input mono cap-wire-input"
                  placeholder={EFFORT_WIRE_HINT[level]}
                  value={model.effortMap[level] ?? ''}
                  data-cap-wire={level}
                  data-tip={`发给端点的 ${THINKING_LEVEL_LABELS[level]} 档写这个值；留空 = ${EFFORT_WIRE_HINT[level]}`}
                  onChange={(event) => {
                    patchWire(level, event.target.value)
                  }}
                />
              </label>
            ))}
          </span>
        ) : null}
        <span className="cap-label" data-tip="这个模型能收什么输入：没勾照片，对话里就发不出图">
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
              data-tip={
                modality === 'text'
                  ? '文本永远要勾（协议里没有文本就发不出消息）'
                  : `${MODALITY_LABELS[modality]}输入${model.modalities.includes(modality) ? '，点一下取消' : '，点一下勾上'}`
              }
              onClick={() => {
                props.onToggleModality(modality)
              }}
            >
              {MODALITY_LABELS[modality]}
            </button>
          ))}
        </span>
      </div>
    </div>
  )
}

/**
 * 拉取清单弹窗（dsh 式）：搜索 + 全选/全不选 + 复选 + 一次「采用选中的 N 个」。
 *
 * 默认勾上「尚未加进端点」的那些——拉清单的意图通常就是把新模型补进来；已经在端点里的
 * 不可勾（重复 id 会被宿主的保存校验拒掉）。
 */
function DiscoverDialog(props: {
  provider: ProviderView | null
  models: string[]
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
            return (
              <li key={id}>
                <button
                  type="button"
                  className={`models-discover-item${on ? ' on' : ''}${has ? ' exists' : ''}`}
                  data-discover-item={id}
                  disabled={has}
                  aria-pressed={on}
                  data-tip={has ? '已经在端点里了（重复 id 保存会被拒）' : on ? '点一下取消' : '点一下勾上'}
                  onClick={() => {
                    toggle(id)
                  }}
                >
                  <span className="models-discover-check">{on ? <IconCheck size={11} /> : null}</span>
                  <span className="mono">{id}</span>
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
          <span className="provider-form-hint">
            按缺省能力加入（128k 窗口 / 四档思考 / 只吃文本），加完可在「编辑」里改。
          </span>
        </div>
      </div>
    </div>
  )
}
