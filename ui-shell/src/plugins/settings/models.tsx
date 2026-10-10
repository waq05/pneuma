/**
 * 设置 → 模型：只读端点清单 + 选默认模型（+ 从端点拉取线上模型清单）。
 *
 * 为什么是「只读 + 选默认」这一档：增删端点（`saveProvider` / `removeProvider`）与写 API key
 * （`setProviderKey`）**被界面通道有意排除**——它们写凭据与配置，属于供应链写入口。壳因此只做
 * 宿主放行的那两件事：**看现在的配置**（`getModelConfig`）与**把默认模型指到哪一个**
 * （`setDefaultModel`），外加 `discoverModels`（只读拉取线上清单）。改端点、换 key 的入口在
 * 旧界面与命令行指令里，面板底下会写清这句。
 *
 * 版式照旧桌面端的 `ModelsPanel`（class 名与 `legacy/views.css` 的 `provider-*` / `model-chip`
 * 逐条对位）。两处适配：下拉用原生 `<select>`（旧界面是自绘 `Select`），回执走面板顶部一条行内说明
 * （旧界面走全局 Toast）。
 *
 * @module dsc-ui-shell/plugins/settings/models
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useHostChannel, type ModelConfigView, type ProviderModelView, type ProviderView, type SettingsMutation } from '@dsc/ui'

/** 拿异常的文字形态。 */
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  const [config, setConfig] = useState<ModelConfigView | null>(null)
  const [discovered, setDiscovered] = useState<{ provider: string; models: string[] } | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const reload = (): void => {
    void channel
      .invoke<ModelConfigView>('getModelConfig')
      .then(setConfig)
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: `读取模型配置失败：${text(error)}` })
      })
  }
  useEffect(reload, [channel])

  /** 写一次默认模型，回执走行内说明；**成功与失败都重取**（宿主是先写文件再校验运行期，失败时文件也可能已变）。 */
  const setDefault = (provider: string, model: string): void => {
    setNote(null)
    void channel
      .invoke<SettingsMutation>('setDefaultModel', [provider, model])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: `操作失败：${result.error}` })
          reload()
          return
        }
        setNote({ tone: 'ok', text: result.notice ?? '默认模型已更新' })
        reload()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: `操作失败：${text(error)}` })
        reload()
      })
  }

  const discover = (provider: string): void => {
    setNote(null)
    setDiscovering(true)
    void channel
      .invoke<string[]>('discoverModels', [provider])
      .then((models) => {
        setDiscovered({ provider, models })
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: `拉取失败：${text(error)}` })
      })
      .finally(() => {
        setDiscovering(false)
      })
  }

  if (config === null) return <div className="settings-empty">{note === null ? '正在读取模型配置…' : note.text}</div>

  const defaultProvider = config.providers.find((entry) => entry.name === config.defaultProvider)

  return (
    <div className="settings-fields models">
      {note === null ? null : (
        <div className={`settings-note${note.tone === 'error' ? ' error' : ''}`}>{note.text}</div>
      )}

      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">默认模型</div>
          <div className="setting-help">当前会话的下一次请求就用新值。</div>
        </div>
        <div className="setting-control">
          <div className="model-default">
            <select
              className="setting-select"
              aria-label="默认端点"
              value={config.defaultProvider}
              onChange={(event) => {
                const provider = config.providers.find((entry) => entry.name === event.target.value)
                const first = provider?.models[0]?.id ?? ''
                if (first !== '') setDefault(event.target.value, first)
              }}
            >
              {config.providers.length === 0 ? (
                <option value="">暂无端点</option>
              ) : (
                config.providers.map((entry) => (
                  <option key={entry.name} value={entry.name} disabled={!entry.keyConfigured}>
                    {(entry.displayName === '' ? entry.name : entry.displayName) +
                      (entry.keyConfigured ? '' : '（无密钥）')}
                  </option>
                ))
              )}
            </select>
            <select
              className="setting-select"
              aria-label="默认模型"
              value={config.defaultModel}
              disabled={defaultProvider === undefined || !defaultProvider.keyConfigured || defaultProvider.models.length === 0}
              onChange={(event) => {
                setDefault(config.defaultProvider, event.target.value)
              }}
            >
              {(defaultProvider?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name === '' ? model.id : model.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="models-head">
        <span>端点</span>
        <span className="count">{config.providers.length}</span>
      </div>

      {config.providers.length === 0 ? (
        <div className="settings-empty">
          还没有端点。配置在 <span className="mono">{config.configFile}</span> 里——壳里不提供增删端点与填写密钥
          （那是写凭据的入口，界面通道有意没放行），要加端点请用桌面端旧界面或命令行的相关指令，改完点上面刷新。
        </div>
      ) : null}

      {config.providers.map((provider) => (
        <ProviderCard
          key={provider.name}
          provider={provider}
          isDefault={config.defaultProvider === provider.name}
          defaultModel={config.defaultModel}
          discovered={discovered !== null && discovered.provider === provider.name ? discovered.models : null}
          discovering={discovering}
          onSetDefault={(model) => {
            setDefault(provider.name, model)
          }}
          onDiscover={() => {
            discover(provider.name)
          }}
          onDismissDiscover={() => {
            setDiscovered(null)
          }}
        />
      ))}

      <div className="settings-note">
        端点与密钥的增删改不在插件壳里做：`saveProvider` / `removeProvider` / `setProviderKey` 都写凭据或配置，
        被界面通道有意排除。这里只让你看现在的配置并把默认模型指到哪一个。要改端点，请用桌面端旧界面
        或命令行的相关指令。
      </div>

      <div className="settings-paths">
        <span>配置文件 </span>
        <span className="mono">{config.configFile}</span>
        <span>凭据 </span>
        <span className="mono">{config.credentialsFile}</span>
      </div>
    </div>
  )
}

/** 一张端点卡片：名字 / 地址 / 密钥状态（只读）+ 拉取清单 + 模型钮（点一下设为默认）。 */
function ProviderCard(props: {
  provider: ProviderView
  isDefault: boolean
  defaultModel: string
  discovered: string[] | null
  discovering: boolean
  onSetDefault(model: string): void
  onDiscover(): void
  onDismissDiscover(): void
}): ReactNode {
  const provider = props.provider
  return (
    <div className="provider-card">
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
          <span
            className={`text-btn${provider.keyConfigured ? ' ok' : ' warn'}`}
            data-tip={
              provider.keyConfigured
                ? `${provider.keyRef} 已就绪，来自环境变量或凭据库`
                : `${provider.keyRef} 尚未配置，该端点暂不可用`
            }
          >
            {provider.keyConfigured ? '密钥已配置' : '密钥未配置'}
          </span>
          <button
            type="button"
            className="text-btn"
            data-tip="从端点拉取线上可用模型清单"
            disabled={props.discovering}
            onClick={props.onDiscover}
          >
            {props.discovering ? '拉取中…' : '拉取清单'}
          </button>
        </div>
      </div>

      {props.discovered === null ? null : (
        <div className="provider-discovered">
          <div className="discovered-head">
            <span>
              线上有 {props.discovered.length} 个模型（只读清单；在壳里加模型要写配置，被有意排除——
              要加请用旧界面）。
            </span>
            <button type="button" className="text-btn" onClick={props.onDismissDiscover}>
              收起
            </button>
          </div>
          <div className="discovered-list">
            {props.discovered.map((id) => {
              const exists = provider.models.some((model) => model.id === id)
              return (
                <span className="discovered-item" key={id}>
                  <span className="mono">{id}</span>
                  <span className="text-btn" data-tip={exists ? '已经在端点里' : '壳里不能加，请用旧界面'}>
                    {exists ? '已有' : '＋'}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
      )}

      <div className="provider-models">
        {provider.models.map((model) => {
          const isDefault = props.isDefault && props.defaultModel === model.id
          // 没配密钥的端点不会注册进运行期配置，宿主会拒收「设为默认」。所以这一类不给可点的钮，
          // 免得用户点了才吃一句奇怪的报错——如实画成不可用，并在悬浮说明里讲清为什么。
          const usable = provider.keyConfigured
          return (
            <button
              key={model.id}
              type="button"
              className={`model-chip${isDefault ? ' on' : ''}`}
              disabled={!usable}
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
          <span className="provider-nomodel">该端点还没有模型（在配置文件里加，或用旧界面加）</span>
        ) : null}
      </div>
    </div>
  )
}
