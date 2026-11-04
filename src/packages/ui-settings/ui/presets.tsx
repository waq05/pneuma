/**
 * 设置 → 模式（预设）：卡片列表 + 就地表单。
 *
 * 一个模式 = `~/.dsc/presets/<名字>.md` 一个文件，页面上做的每一次改动都写回文件，
 * 所以「手写文件」和「在这里点」是同一个东西的两条路：改完刷新页面，两边看到的一样。
 *
 * 版式照旧桌面端的 `PresetsPanel`（内置与自定义分两组，卡片右侧给操作钮，「查看配置」读文件原文，
 * 编辑用就地表单），class 名与 `legacy/views.css` 里那套 `preset-*` 逐条对位。
 *
 * 三处适配（都记在 development-log 的诚实边界）：
 * - 数据走界面通道 `useHostChannel()`（旧界面走 `RuntimeProxy`）；
 * - 成功/失败回执走分区顶部一条行内说明（旧界面走全局 Toast，壳里的播报区是个槽位，插件没有直达 API）；
 * - **删除用行内二次确认**（旧界面用 `confirmAction` 弹层）——两下点完才真删，不弹系统对话框。
 *
 * @module dsc-ui-shell/plugins/settings/presets
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconPlus, IconRefresh, createT } from '@dsc/ui'
import { errText as text, humanErrorText } from '@dsc/ui-primitives'
import {
  useHostChannel,
  type PresetDraft,
  type PresetFileView,
  type PresetSurface,
  type PresetView,
  type SettingsMutation,
  type ToolEntryView,
} from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 模式标识的形状，与 packages/config-core/presets.ts 的 PRESET_NAME 同一张表（表单里先拦一道）。 */
const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

const RISK_LABELS: Record<ToolEntryView['risk'], string> = {
  read: t('settings.presets.risk.read'),
  write: t('settings.presets.risk.write'),
  exec: t('settings.presets.risk.exec'),
}

export function PresetsGroup(): ReactNode {
  const channel = useHostChannel()
  const [surface, setSurface] = useState<PresetSurface | null>(null)
  const [tools, setTools] = useState<ToolEntryView[]>([])
  const [draft, setDraft] = useState<PresetDraft | null>(null)
  const [peek, setPeek] = useState<{ name: string; text: string } | null>(null)
  /** 正在等二次确认删除的那个模式名（null = 没在确认）。 */
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  /** 拉一次清单与工具目录；失败说清原因。 */
  const reload = (): void => {
    void channel
      .invoke<PresetSurface>('listPresets')
      .then(setSurface)
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('settings.presets.loadFailed', { message: text(error) }) })
      })
    void channel
      .invoke<ToolEntryView[]>('listTools')
      .then(setTools)
      // 读不到工具目录时说清（空着会让人以为「一个工具都没有」，那不是同一件事）。
      .catch((error: unknown) => {
        setTools([])
        setNote({ tone: 'error', text: t('settings.presets.toolsFailed', { message: text(error) }) })
      })
  }
  useEffect(reload, [channel])

  /** 写一次，回执走行内说明；成功后重取（文件可能已被外部改过）。 */
  const write = (method: string, args: unknown[], okText?: string): void => {
    setNote(null)
    void channel
      .invoke<SettingsMutation>(method, args)
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: t('settings.presets.opFailed', { message: result.error }) })
          return
        }
        setNote({ tone: 'ok', text: result.notice ?? okText ?? t('settings.presets.saved') })
        reload()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('settings.presets.opFailed', { message: text(error) }) })
      })
  }

  /** 表单保存：失败留在表单里让用户改，成功就收起并重取。 */
  const finishDraft = (result: SettingsMutation): void => {
    if (!result.ok) {
      setNote({ tone: 'error', text: t('settings.presets.saveFailed', { message: result.error }) })
      return
    }
    setNote({ tone: 'ok', text: result.notice ?? t('settings.presets.presetSaved') })
    setDraft(null)
    reload()
  }

  /** 「查看配置」：读模式文件原文；失败就把原因摊在说明条里（不把只读面板留在半路上）。 */
  const peekPreset = (name: string): void => {
    setNote(null)
    void channel
      .invoke<PresetFileView>('readPreset', [name])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: t('settings.presets.readFailed', { message: humanErrorText(result.error).text }) })
          return
        }
        setPeek({ name, text: result.text })
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('settings.presets.readFailed', { message: humanErrorText(error).text }) })
      })
  }

  if (surface === null) return <div className="settings-empty">{t('settings.presets.loading')}</div>

  const builtin = surface.options.filter((item) => item.builtin)
  const custom = surface.options.filter((item) => !item.builtin)

  const card = (item: PresetView): ReactNode => (
    <PresetCard
      key={item.name}
      preset={item}
      surface={surface}
      confirming={confirmName === item.name}
      onUse={() => {
        write('usePreset', [item.name])
      }}
      onDefault={() => {
        write('setDefaultPreset', [item.name])
      }}
      onEdit={() => {
        setDraft({ ...toDraft(item), oldName: item.name })
      }}
      onPeek={() => {
        peekPreset(item.name)
      }}
      onAskRemove={
        item.builtin
          ? undefined
          : () => {
              setConfirmName(item.name)
            }
      }
      onRemoveConfirm={() => {
        setConfirmName(null)
        write('removePreset', [item.name])
      }}
      onRemoveCancel={() => {
        setConfirmName(null)
      }}
    />
  )

  return (
    <div className="settings-fields presets">
      <div className="preset-intro">
        {t('settings.presets.intro.a')}<strong>{t('settings.presets.intro.strong')}</strong>{t('settings.presets.intro.b')}
        <span className="mono">/preset {'<'}{t('settings.presets.namePlaceholder')}{'>'}</span>{t('settings.presets.intro.c')}
      </div>

      {note === null ? null : (
        <div className={`settings-note${note.tone === 'error' ? ' error' : ''}`}>{note.text}</div>
      )}

      <div className="models-head">
        <span>{t('settings.presets.builtin')}</span>
        <span className="count">{builtin.length}</span>
        <button className="btn-ghost presets-refresh" data-tip={t('settings.presets.reloadTip')} onClick={reload}>
          <IconRefresh size={14} /> {t('settings.presets.refresh')}
        </button>
      </div>
      {builtin.map(card)}

      <div className="models-head">
        <span>{t('settings.presets.custom')}</span>
        <span className="count">{custom.length}</span>
        <button
          className="btn-primary models-add"
          data-tip={t('settings.presets.newTip')}
          onClick={() => {
            setDraft(blankDraft())
          }}
        >
          <IconPlus size={14} /> {t('settings.presets.new')}
        </button>
      </div>
      {custom.length === 0 ? (
        <div className="settings-empty">
          {t('settings.presets.empty.lead')}<span className="mono">~/.dsc/presets/</span>{t('settings.presets.empty.mid')}
          <span className="mono">{'<'}{t('settings.presets.namePlaceholder')}{'>'}.md</span>{t('settings.presets.empty.tail')}
        </div>
      ) : null}
      {custom.map(card)}

      {peek === null ? null : (
        <div className="preset-raw">
          <div className="preset-raw-head">
            <span className="mono">{peek.name}.md</span>
            <span className="preset-raw-hint">{t('settings.presets.rawHint')}</span>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                setPeek(null)
              }}
            >
              {t('settings.presets.close')}
            </button>
          </div>
          <pre>{peek.text}</pre>
        </div>
      )}

      {draft === null ? null : (
        <PresetForm
          key={draft.oldName ?? 'new'}
          draft={draft}
          tools={tools}
          droppable={surface.droppable}
          known={surface.options.map((item) => item.name)}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null)
          }}
          onSave={(result) => {
            finishDraft(result)
          }}
          save={(next) => channel.invoke<SettingsMutation>('savePreset', [next])}
        />
      )}

      <div className="settings-paths">
        <span>{t('settings.presets.pathLabel')}</span>
        <span className="mono">~/.dsc/presets/</span>
        <span>{t('settings.presets.pathCount', { count: surface.options.length })}</span>
      </div>
    </div>
  )
}

/** 一张模式卡片：显示名 + 标识 + 工牌摘要 + 操作按钮（+ 删除的行内二次确认）。 */
function PresetCard(props: {
  preset: PresetView
  surface: PresetSurface
  confirming: boolean
  onUse(): void
  onDefault(): void
  onEdit(): void
  onPeek(): void
  onAskRemove?(): void
  onRemoveConfirm(): void
  onRemoveCancel(): void
}): ReactNode {
  const item = props.preset
  const isCurrent = props.surface.current === item.name
  const isDefault = props.surface.defaultName === item.name
  return (
    <div className={`preset-card${isCurrent ? ' on' : ''}`}>
      <div className="preset-row">
        <div className="preset-main">
          <div className="preset-name">
            {item.label}
            <span className="mono preset-id">{item.name}</span>
            {isCurrent ? <span className="tag">{t('settings.presets.current')}</span> : null}
            {isDefault ? <span className="tag dim">{t('settings.presets.defaultTag')}</span> : null}
          </div>
          <div className="preset-sub">{item.description === '' ? t('settings.presets.noDescription') : item.description}</div>
          <div className="preset-badge-line">
            <span className="preset-badge">
              {t('settings.presets.toolsLabel')}
              {item.tools === null
                ? t('settings.presets.toolsAll')
                : item.tools.length === 0
                  ? t('settings.presets.toolsNone')
                  : item.tools.join(t('settings.presets.listSeparator'))}
            </span>
            {item.drop.length > 0 ? <span className="preset-badge warn">{t('settings.presets.dropLabel')}{item.drop.join(t('settings.presets.listSeparator'))}</span> : null}
            {item.prompt.trim() !== '' ? (
              <span className="preset-badge">{t('settings.presets.promptBadge', { count: item.prompt.trim().length })}</span>
            ) : null}
          </div>
          {item.problem === undefined ? null : <div className="preset-problem">{item.problem}</div>}
        </div>
        <div className="preset-actions">
          {props.confirming ? (
            <>
              <button
                type="button"
                className="text-btn danger"
                data-tip={t('settings.presets.deleteTip')}
                onClick={props.onRemoveConfirm}
              >
                {t('settings.presets.confirmDelete')}
              </button>
              <button type="button" className="text-btn" onClick={props.onRemoveCancel}>
                {t('settings.presets.cancel')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={isCurrent ? 'text-btn preset-use' : 'btn-ghost preset-use'}
                disabled={isCurrent}
                data-tip={isCurrent ? t('settings.presets.inUseTip') : t('settings.presets.useTip')}
                onClick={props.onUse}
              >
                {isCurrent ? t('settings.presets.inUse') : t('settings.presets.use')}
              </button>
              <button
                type="button"
                className="text-btn"
                disabled={isDefault}
                data-tip={isDefault ? t('settings.presets.defaultTip') : t('settings.presets.setDefaultTip')}
                onClick={props.onDefault}
              >
                {isDefault ? t('settings.presets.isDefault') : t('settings.presets.setDefault')}
              </button>
              <button type="button" className="text-btn" data-tip={t('settings.presets.editTip')} onClick={props.onEdit}>
                {t('settings.presets.edit')}
              </button>
              <button type="button" className="text-btn" data-tip={t('settings.presets.peekTip')} onClick={props.onPeek}>
                {t('settings.presets.peek')}
              </button>
              {props.onAskRemove === undefined ? null : (
                <button type="button" className="text-btn danger" data-tip={t('settings.presets.removeTip')} onClick={props.onAskRemove}>
                  {t('settings.presets.remove')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 模式编辑表单：新建与编辑共用，保存时整份写回文件。 */
function PresetForm(props: {
  draft: PresetDraft
  tools: ToolEntryView[]
  droppable: Array<{ id: string; label: string }>
  known: string[]
  save(draft: PresetDraft): Promise<SettingsMutation>
  onChange(draft: PresetDraft): void
  onCancel(): void
  onSave(result: SettingsMutation): void
}): ReactNode {
  const draft = props.draft
  const isNew = draft.oldName === null
  const patch = (next: Partial<PresetDraft>): void => {
    props.onChange({ ...draft, ...next })
  }
  const nameOk = PRESET_NAME.test(draft.name)
  const renameClash = !isNew && draft.name !== draft.oldName && props.known.includes(draft.name)

  /** 勾 / 取消一个工具：勾第一个时从「全量」切到「白名单」，取消到空也是空（一个工具都不给）。 */
  const toggleTool = (name: string, checked: boolean): void => {
    const list = draft.tools ?? []
    patch({ tools: checked ? [...list, name] : list.filter((item) => item !== name) })
  }

  const save = (): void => {
    void props.save(draft).then(props.onSave)
  }

  return (
    <div className="provider-form preset-form">
      <div className="provider-form-title">{isNew ? t('settings.presets.form.new') : t('settings.presets.form.edit', { name: String(draft.oldName) })}</div>
      <div className="provider-form-grid">
        <label className="preset-field">
          <span>{t('settings.presets.form.nameLabel')}</span>
          <input
            className="setting-input mono"
            value={draft.name}
            placeholder={t('settings.presets.form.namePlaceholder')}
            onChange={(event) => {
              patch({ name: event.target.value.trim() })
            }}
          />
        </label>
        <label className="preset-field">
          <span>{t('settings.presets.form.displayName')}</span>
          <input
            className="setting-input"
            value={draft.label}
            placeholder={t('settings.presets.form.labelPlaceholder')}
            onChange={(event) => {
              patch({ label: event.target.value })
            }}
          />
        </label>
        <label className="preset-field preset-field-wide">
          <span>{t('settings.presets.form.description')}</span>
          <input
            className="setting-input"
            value={draft.description}
            placeholder={t('settings.presets.form.descriptionPlaceholder')}
            onChange={(event) => {
              patch({ description: event.target.value })
            }}
          />
        </label>
      </div>
      {nameOk ? null : (
        <div className="preset-problem">
          {t('settings.presets.form.nameProblem.lead')}
          {draft.name === '' ? t('settings.presets.form.nameProblem.empty') : draft.name}
          {t('settings.presets.form.nameProblem.tail')}
        </div>
      )}
      {renameClash ? <div className="preset-problem">{t('settings.presets.form.nameClash', { name: draft.name })}</div> : null}

      <div className="preset-field-block">
        <div className="preset-field-head">
          <span>{t('settings.presets.form.toolsTitle')}</span>
          <label className="preset-switch">
            <input
              type="checkbox"
              checked={draft.tools === null}
              onChange={(event) => {
                patch({ tools: event.target.checked ? null : [] })
              }}
            />
            {t('settings.presets.form.toolsAll')}
          </label>
        </div>
        {draft.tools === null ? null : (
          <>
            <div className="preset-tool-grid">
              {props.tools.map((tool) => (
                <label className="preset-tool" key={tool.name} data-tip={tool.description}>
                  <input
                    type="checkbox"
                    checked={draft.tools?.includes(tool.name) === true}
                    onChange={(event) => {
                      toggleTool(tool.name, event.target.checked)
                    }}
                  />
                  <span className="mono">{tool.name}</span>
                  <span className={`preset-risk ${tool.risk}`}>{RISK_LABELS[tool.risk]}</span>
                  {tool.presets === undefined ? null : (
                    <span className="preset-risk mode">{t('settings.presets.form.onlyIn', { presets: tool.presets.join('/') })}</span>
                  )}
                </label>
              ))}
            </div>
            <div className="setting-help">
              {t('settings.presets.form.toolsHint')}
            </div>
          </>
        )}
      </div>

      <div className="preset-field-block">
        <div className="preset-field-head">
          <span>{t('settings.presets.form.dropTitle')}</span>
          <span className="setting-help">{t('settings.presets.form.dropHint')}</span>
        </div>
        <div className="preset-drop-list">
          {props.droppable.map((section) => (
            <label className="preset-tool" key={section.id}>
              <input
                type="checkbox"
                checked={draft.drop.includes(section.id)}
                onChange={(event) => {
                  patch({
                    drop: event.target.checked ? [...draft.drop, section.id] : draft.drop.filter((id) => id !== section.id),
                  })
                }}
              />
              <span className="mono">{section.id}</span>
              <span className="preset-drop-label">{section.label}</span>
            </label>
          ))}
        </div>
      </div>

      <label className="preset-field preset-field-block">
        <span>{t('settings.presets.form.promptLabel')}</span>
        <textarea
          className="preset-prompt"
          value={draft.prompt}
          placeholder={t('settings.presets.form.promptPlaceholder')}
          onChange={(event) => {
            patch({ prompt: event.target.value })
          }}
        />
      </label>

      <div className="provider-form-actions">
        <button type="button" className="btn-primary" disabled={!nameOk || renameClash} onClick={save}>
          {isNew ? t('settings.presets.form.create') : t('settings.presets.form.save')}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onCancel}>
          {t('settings.presets.cancel')}
        </button>
        <span className="provider-form-hint">{t('settings.presets.form.hint')}</span>
      </div>
    </div>
  )
}

function blankDraft(): PresetDraft {
  return { oldName: null, name: '', label: '', description: '', tools: null, drop: [], prompt: '' }
}

function toDraft(preset: PresetView): PresetDraft {
  return {
    oldName: preset.name,
    name: preset.name,
    label: preset.label,
    description: preset.description,
    tools: preset.tools === null ? null : [...preset.tools],
    drop: [...preset.drop],
    prompt: preset.prompt,
  }
}
