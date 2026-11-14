/**
 * 设置页：读宿主的设置分区清单，把 `id === 'superagent'` 那一段就地画出来。
 *
 * **不造第二套存储**：分区清单、当前值、写入与按钮动作全走壳已有的四个界面方法
 * （`getSettingsSections` / `getSectionValues` / `setSettingValue` / `runSettingAction`），
 * 宿主插件停着时它自己就不登记分区，这一页据此说「去插件中心打开」。
 *
 * 控件渲染与插件中心 / 设置面板是同一张声明表（`SettingsField`）：下拉与开关**选了就写**，
 * 文本框**失焦或回车才写**（避免边打字边写盘），写完整块回读一次（宿主可能夹取非法值）。
 *
 * @module dsc-ui-shell/superagent/settings
 */
import { useCallback, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  Select,
  createT,
  humanErrorText,
  useHostChannel,
  type SettingsField,
  type SettingsMutation,
  type SettingsSectionView,
  type SettingsValue,
  type SettingsValues,
} from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'
import type { SuperagentView } from './state'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/** 宿主登记的分区 id（与 `packages/superagent/index.ts:78` 同一把钥匙）。 */
const SECTION_ID = 'superagent'

/** 设置页：找分区 → 读值 → 画字段 → 底部一条「最近变更」。 */
export function SettingsPage({ surface }: { surface: SuperagentView | null }): ReactNode {
  const channel = useHostChannel()
  /** `undefined` = 还在读；`null` = 没有这个分区（宿主插件没开）。 */
  const [section, setSection] = useState<SettingsSectionView | null | undefined>(undefined)
  const [values, setValues] = useState<SettingsValues>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [loadError, setLoadError] = useState('')

  /** 回读这一段的当前值（写入可能被宿主夹取，写完要对上）。 */
  const readValues = useCallback(
    (id: string): void => {
      void channel
        .invoke<SettingsValues>('getSectionValues', [id])
        .then((next) => {
          setValues(next ?? {})
        })
        .catch((error: unknown) => {
          setNote({ tone: 'error', text: t('superagent.settings.loadFailed', { message: humanErrorText(error).text }) })
        })
    },
    [channel],
  )

  /** 取分区清单，挑出 superagent 这一段。 */
  const load = useCallback((): void => {
    setLoadError('')
    void channel
      .invoke<SettingsSectionView[]>('getSettingsSections')
      .then((all) => {
        const found = (Array.isArray(all) ? all : []).find((item) => item.id === SECTION_ID) ?? null
        setSection(found)
        setDraft({})
        setNote(null)
        if (found !== null) readValues(found.id)
      })
      .catch((error: unknown) => {
        setSection(null)
        setLoadError(humanErrorText(error).text)
      })
  }, [channel, readValues])

  useEffect(() => {
    load()
    // 只认这两个：load 每次渲染都是新函数。
  }, [channel, load])

  /** 写一个值；成功把宿主给的回执显示出来，失败说清原因。 */
  const commit = (key: string, value: SettingsValue): void => {
    if (section === null || section === undefined) return
    setNote(null)
    void channel
      .invoke<SettingsMutation>('setSettingValue', [section.id, key, value])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: t('superagent.settings.saveFailed', { message: humanErrorText(result.error).text }) })
          return
        }
        if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
        readValues(section.id)
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('superagent.settings.saveFailed', { message: humanErrorText(error).text }) })
      })
  }

  /** 跑一个按钮字段声明的动作（分区自己有实现时才有效）。 */
  const act = (action: string): void => {
    if (section === null || section === undefined) return
    setNote(null)
    void channel
      .invoke<SettingsMutation>('runSettingAction', [section.id, action])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: t('superagent.settings.actionFailed', { message: humanErrorText(result.error).text }) })
          return
        }
        if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
        load()
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('superagent.settings.actionFailed', { message: humanErrorText(error).text }) })
      })
  }

  if (section === undefined) {
    return (
      <div className="settings-loading" role="status">
        {t('superagent.settings.loading')}
      </div>
    )
  }

  if (section === null) {
    return (
      <div className="settings-empty">
        {loadError === ''
          ? t('superagent.settings.missing')
          : t('superagent.settings.loadFailed', { message: loadError })}
      </div>
    )
  }

  return (
    <div>
      <div className="settings-group-title">{section.title}</div>
      {section.subtitle === undefined ? null : <div className="setting-help">{section.subtitle}</div>}
      <div className="settings-fields">
        {section.fields.length === 0 ? (
          <div className="settings-empty">{t('superagent.settings.noFields')}</div>
        ) : (
          section.fields.map((field) => (
            <FieldRow
              key={field.type === 'info' ? `info-${field.text}` : field.type === 'button' ? `btn-${field.action}` : field.key}
              field={field}
              values={values}
              draft={draft}
              setDraft={setDraft}
              onCommit={commit}
              onAction={act}
            />
          ))
        )}
      </div>
      {note === null ? null : (
        <div className={`settings-note${note.tone === 'error' ? ' error' : ''}`}>{note.text}</div>
      )}
      <HistoryBlock surface={surface} />
    </div>
  )
}

/**
 * 「最近变更」块：设置页保存成功且值真的变了才记一条（宿主 `settings_history` 表），
 * 新的在前，最多 30 条。对应上游管理面板的设置修订历史（`app/settings-history.ts`）。
 *
 * 数据从快照面来（`surfaces.superagent.settingsHistory`），不是设置分区自己给的——
 * 运行期没起来（快照缺席）或旧宿主（格缺席）时整块不画，别画成空占位。
 */
function HistoryBlock({ surface }: { surface: SuperagentView | null }): ReactNode {
  if (surface === null || surface.ready !== true) return null
  const history = surface.settingsHistory
  if (history === undefined) return null
  const rows = history.slice(0, 8)
  return (
    <div className="settings-group-title">
      {t('superagent.settings.history.title')}
      {rows.length === 0 ? (
        <div className="settings-empty">{t('superagent.settings.history.empty')}</div>
      ) : (
        rows.map((change) => (
          <div key={change.version} className="settings-note">
            {t('superagent.settings.history.row', {
              at: change.at.slice(0, 19).replace('T', ' '),
              label: fieldLabel(change.key),
              from: change.from ?? t('superagent.settings.history.unset'),
              to: change.to ?? t('superagent.settings.history.unset'),
            })}
          </div>
        ))
      )}
    </div>
  )
}

/** 变更行的字段名：按设置键取 locale 的 `field.<key>.label`，没有的字段显示键名本身。 */
function fieldLabel(key: string): string {
  const label = t(`field.${key}.label`, undefined)
  return label === '' || label.startsWith('field.') ? key : label
}

/** 一行控件：按 `SettingsField` 的四种可写类型 + info / button 各画一套。 */
function FieldRow({
  field,
  values,
  draft,
  setDraft,
  onCommit,
  onAction,
}: {
  field: SettingsField
  values: SettingsValues
  draft: Record<string, string>
  setDraft: Dispatch<SetStateAction<Record<string, string>>>
  onCommit: (key: string, value: SettingsValue) => void
  onAction: (action: string) => void
}): ReactNode {
  if (field.type === 'info') {
    return (
      <div className="setting-row info">
        <div className="setting-text">
          {field.label === undefined ? null : <div className="setting-label">{field.label}</div>}
          {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
        </div>
        <div className="setting-info">
          <span className={field.mono === true ? 'mono' : ''}>{field.text}</span>
        </div>
      </div>
    )
  }

  if (field.type === 'button') {
    return (
      <div className="setting-row action">
        <div className="setting-text">
          {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
        </div>
        <button
          type="button"
          className={field.style === 'ghost' ? 'btn-ghost' : 'btn-primary'}
          onClick={() => {
            onAction(field.action)
          }}
        >
          {field.label}
        </button>
      </div>
    )
  }

  if (field.type === 'select') {
    const current = String(values[field.key] ?? '')
    const listed = current === '' || field.options.some((option) => option.value === current)
    // 派生值（宿主给显示名）选不了：这一行置灰只读，与设置面板那份同构。
    const derived = field.derivedLabelKey === undefined ? '' : String(values[field.derivedLabelKey] ?? '')
    const locked = !listed && derived !== ''
    const options = listed
      ? field.options
      : [...field.options, { value: current, label: t('superagent.settings.unknown', { value: current }) }]
    return (
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{field.label}</div>
          {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
        </div>
        <div className="setting-control">
          <Select
            className="setting-select"
            ariaLabel={field.label}
            value={current}
            options={options}
            disabled={locked}
            {...(locked ? { displayLabel: derived } : {})}
            onPick={(next) => {
              if (next === current) return
              onCommit(field.key, next)
            }}
          />
        </div>
      </div>
    )
  }

  if (field.type === 'switch') {
    const on = values[field.key] === true
    return (
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{field.label}</div>
          {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
        </div>
        <div className="setting-control">
          <button
            type="button"
            className={`switch${on ? ' on' : ''}`}
            role="switch"
            aria-checked={on}
            aria-label={field.label}
            onClick={() => {
              onCommit(field.key, !on)
            }}
          />
        </div>
      </div>
    )
  }

  // text / number：失焦或回车才提交，避免边打字边写盘。
  const stored = values[field.key]
  const shown = draft[field.key] ?? (stored === undefined ? '' : String(stored))
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{field.label}</div>
        {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
      </div>
      <div className="setting-control">
        <input
          className={`setting-input${field.type === 'text' && field.mono === true ? ' mono' : ''}`}
          type={field.type === 'number' ? 'number' : 'text'}
          aria-label={field.label}
          value={shown}
          placeholder={field.type === 'text' ? field.placeholder : undefined}
          min={field.type === 'number' ? field.min : undefined}
          max={field.type === 'number' ? field.max : undefined}
          step={field.type === 'number' ? field.step : undefined}
          onChange={(event) => {
            const next = event.target.value
            setDraft((current) => ({ ...current, [field.key]: next }))
          }}
          onBlur={() => {
            const before = stored === undefined ? '' : String(stored)
            if (shown === before) return
            onCommit(field.key, field.type === 'number' ? Number(shown) : shown)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      </div>
    </div>
  )
}
