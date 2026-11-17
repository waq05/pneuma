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
 * 记录表（`rows`）例外，整张表先落本地草稿：加行只加空行，等这一行的必填格都填满、失焦
 * （或按「保存表格」）才把表提交给宿主。空行/半成品行不能交给宿主——宿主按 kind 的 schema
 * 校验时会把它们丢掉，回读后新行就消失了（多列必填的来源表因此加不了行）。
 *
 * @module dsc-ui-shell/superagent/settings
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
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

/** `rows` 字段的一行：列 key → 单元格文本（契约里的 `SettingsRowValue`，`@dsc/ui` 没转出，按结构取）。 */
type RowRecord = Record<string, string>

/**
 * `rows` 的值表：契约给的是 `RowRecord[]`，但旧宿主 / 插件可能给字符串、null，
 * 或数组里混进非对象。非数组按空表，元素不是对象就丢掉——界面永远不崩。
 */
function rowValuesOf(value: SettingsValue | undefined): RowRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is RowRecord => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
}

/** `fact` 的展示文本：只读值只认标量；宿主塞了对象 / 数组就给空串（别画成 `[object Object]`）。 */
function factTextOf(value: SettingsValue | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 改表里某一格：返回新数组，React 状态才认得出变化。 */
function withCellValue(rows: RowRecord[], rowIndex: number, column: string, value: string): RowRecord[] {
  return rows.map((record, index) => (index === rowIndex ? { ...record, [column]: value } : record))
}

/** 校验列的 `pattern`（字符串）：正则写坏了按通过处理（最终校验仍在宿主 save()）。 */
function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return true
  }
}

/** `rows` 字段本身与它的一列：`@dsc/ui` 没转出单列类型，从字段声明上就地取。 */
type RowsFieldSpec = Extract<SettingsField, { type: 'rows' }>
type RowColumn = RowsFieldSpec['columns'][number]

/**
 * 一行能不能交给宿主：文本列没标 `optional` 的都要非空；首列是行的键（宿主按它判空行），
 * 就算标了 `optional` 空着也会被丢掉，所以首列一律算必填。下拉列不受这条限制：
 * 宿主保存时会用第一个选项补空值，空着也是合法的一行。
 */
function rowFilled(row: RowRecord, columns: readonly RowColumn[]): boolean {
  const first = columns[0]?.key ?? ''
  return columns.every((column) => {
    if (column.type !== 'text') return true
    if ((row[column.key] ?? '').trim() !== '') return true
    return column.key !== first && column.optional === true
  })
}

/** 一行里第一处不符合列 `pattern` 的格子：只在非空时提示，最终校验仍在宿主 save()。 */
function firstPatternMiss(row: RowRecord, columns: readonly RowColumn[]): { column: RowColumn; value: string } | null {
  for (const column of columns) {
    if (column.type !== 'text' || column.pattern === undefined) continue
    const value = (row[column.key] ?? '').trim()
    if (value !== '' && !matchesPattern(column.pattern, value)) return { column, value }
  }
  return null
}

/** 两张行表内容是否一样（单元格按去首尾空白比，宿主本来就会 trim）：用来判草稿有没有被再编辑。 */
function sameRows(left: readonly RowRecord[], right: readonly RowRecord[]): boolean {
  if (left.length !== right.length) return false
  return left.every((row, index) => {
    const other = right[index] ?? {}
    const keys = new Set([...Object.keys(row), ...Object.keys(other)])
    for (const key of keys) if ((row[key] ?? '').trim() !== (other[key] ?? '').trim()) return false
    return true
  })
}

/**
 * 提交给宿主的行表：填好的行原样交；半成品行如果宿主本来就有同一行（按首列的值认），
 * 交宿主那份旧值——不能因为另一行的提交把用户还没填完的旧行删掉；新加的半成品行不交
 * （宿主自己也会把空行丢掉，交了还可能被 schema 整表拒掉）。
 */
function rowsForHost(table: readonly RowRecord[], host: readonly RowRecord[], columns: readonly RowColumn[]): RowRecord[] {
  const first = columns[0]?.key ?? ''
  const payload: RowRecord[] = []
  for (const row of table) {
    if (rowFilled(row, columns)) {
      payload.push(row)
      continue
    }
    const keyed = (row[first] ?? '').trim()
    const stored = keyed === '' ? undefined : host.find((item) => (item[first] ?? '').trim() === keyed)
    if (stored !== undefined) payload.push(stored)
  }
  return payload
}

/** 表格字段的本地草稿：整张表就是草稿，与标量字段的单格文本草稿（`draft`）分开放。 */
interface RowsDraft {
  /** 各表正在显示的行（含还没提交的新行 / 半成品行）；没有条目 = 直接看宿主那份。 */
  tables: Record<string, RowRecord[]>
  /** 换一份本地行表：输入、增行、删行都走这里，只有 `commit` 才惊动宿主。 */
  set: (key: string, rows: RowRecord[]) => void
  /** 把一张表交给宿主（整表还是只交填好的行，由调用方定）。 */
  commit: (key: string, rows: RowRecord[]) => void
}

/** 设置页：找分区 → 读值 → 画字段 → 底部一条「最近变更」。 */
export function SettingsPage({ surface }: { surface: SuperagentView | null }): ReactNode {
  const channel = useHostChannel()
  /** `undefined` = 还在读；`null` = 没有这个分区（宿主插件没开）。 */
  const [section, setSection] = useState<SettingsSectionView | null | undefined>(undefined)
  const [values, setValues] = useState<SettingsValues>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  /** 记录表的本地草稿，按字段 key 分开；没有条目 = 直接看宿主那份（见 {@link RowsDraft}）。 */
  const [rowTables, setRowTables] = useState<Record<string, RowRecord[]>>({})
  /** 刚提交成功、等宿主回读确认的表：存提交时的 JSON，回读时本地没再改才收下宿主那份。 */
  const acceptedTables = useRef<Record<string, string>>({})
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [loadError, setLoadError] = useState('')

  /**
   * 收下宿主回读的值。记录表要按规矩对账，别把用户正在编辑的草稿冲掉：
   *   - 刚成功提交过（`acceptedTables` 有记录）：本地内容与提交时一样 = 用户没再改，
   *     换成宿主那份（夹取单元格、下拉补默认值都以它为准）；改过就保留本地。
   *   - 没提交过（别的字段的写入、重新加载）：本地与宿主内容一致才清草稿，否则保留。
   */
  const acceptValues = useCallback((next: SettingsValues): void => {
    setValues(next)
    setRowTables((current) => {
      let dropped = false
      const kept: Record<string, RowRecord[]> = {}
      for (const [key, table] of Object.entries(current)) {
        const sent = acceptedTables.current[key]
        delete acceptedTables.current[key]
        const settled = sent !== undefined ? sent === JSON.stringify(table) : sameRows(table, rowValuesOf(next[key]))
        if (settled) {
          dropped = true
          continue
        }
        kept[key] = table
      }
      return dropped ? kept : current
    })
  }, [])

  /** 回读这一段的当前值（写入可能被宿主夹取，写完要对上）。 */
  const readValues = useCallback(
    (id: string): void => {
      void channel
        .invoke<SettingsValues>('getSectionValues', [id])
        .then((next) => {
          acceptValues(next ?? {})
        })
        .catch((error: unknown) => {
          setNote({ tone: 'error', text: t('superagent.settings.loadFailed', { message: humanErrorText(error).text }) })
        })
    },
    [acceptValues, channel],
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
        setRowTables({})
        acceptedTables.current = {}
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

  /** 写一个标量值：成功把宿主给的回执显示出来，失败说清原因；成功后回读一次对上夹取值。 */
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

  /**
   * 提交一张记录表：整表单写，没有「只写一格」的入口。
   *
   * 成败都回读一次：成功时让宿主那份收下（夹取/丢行以它为准），失败时本地草稿与宿主
   * 内容不同，`acceptValues` 会把用户填了一半的行留住，只报错不冲掉输入。
   */
  const commitRows = (key: string, rows: RowRecord[]): void => {
    if (section === null || section === undefined) return
    setNote(null)
    void channel
      .invoke<SettingsMutation>('setSettingValue', [section.id, key, rows])
      .then((result) => {
        if (!result.ok) {
          setNote({ tone: 'error', text: t('superagent.settings.saveFailed', { message: humanErrorText(result.error).text }) })
        } else {
          if (result.notice !== undefined) setNote({ tone: 'ok', text: result.notice })
          // 成功才登记「等回读确认」：失败时草稿留着让用户改，不按宿主那份收。
          acceptedTables.current[key] = JSON.stringify(rows)
        }
        readValues(section.id)
      })
      .catch((error: unknown) => {
        setNote({ tone: 'error', text: t('superagent.settings.saveFailed', { message: humanErrorText(error).text }) })
        readValues(section.id)
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

  /** 记录表字段的草稿与提交入口：整页一份，按字段 key 分开存。 */
  const rowsDraft: RowsDraft = {
    tables: rowTables,
    set: (key: string, rows: RowRecord[]): void => {
      setRowTables((current) => ({ ...current, [key]: rows }))
    },
    commit: commitRows,
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
              rowsDraft={rowsDraft}
              onCommit={commit}
              onAction={act}
              onNote={setNote}
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

/** 一行控件：按 `SettingsField` 的字段类型各画一套。 */
function FieldRow({
  field,
  values,
  draft,
  setDraft,
  rowsDraft,
  onCommit,
  onAction,
  onNote,
}: {
  field: SettingsField
  values: SettingsValues
  draft: Record<string, string>
  setDraft: Dispatch<SetStateAction<Record<string, string>>>
  rowsDraft: RowsDraft
  onCommit: (key: string, value: SettingsValue) => void
  onAction: (action: string) => void
  onNote: (note: { tone: 'ok' | 'error'; text: string }) => void
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

  if (field.type === 'fact') {
    // 只读事实行：值就在 values 里，缺了给占位。宿主不收它的写入，这里也不画输入框。
    const shown = factTextOf(values[field.key])
    return (
      <div className="setting-row info">
        <div className="setting-text">
          <div className="setting-label">{field.label}</div>
          {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
        </div>
        <div className="setting-info">
          <span>{shown === '' ? t('superagent.settings.fact.empty') : shown}</span>
        </div>
      </div>
    )
  }

  if (field.type === 'rows') {
    const host = rowValuesOf(values[field.key])
    return (
      <RowsField
        field={field}
        host={host}
        table={rowsDraft.tables[field.key] ?? host}
        rowsDraft={rowsDraft}
        onNote={onNote}
      />
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

/**
 * 记录表字段：整张表是一份本地草稿，一行填满必填格并失焦（或按「保存表格」）时才写回宿主。
 *
 * 为什么不能「加一行就先提交空行」：宿主按 kind 的 schema 校验时会把空行 / 半成品行丢掉，
 * 回读后新行又消失——多列必填的来源表（如 webhook 的 targets）因此根本加不了行。
 * 所以空行只落本地；提交时也只交填好的行，半成品行交宿主那份旧值或干脆不交（见 `rowsForHost`）。
 *
 * 为什么输入时不直接提交：用户打到一半的地址（如 `http://`）会被宿主的 URL 正则拒掉，
 * 提交失败再按宿主回读就会把整行冲掉。失焦才是「这一格填完了」的信号。
 */
function RowsField({
  field,
  host,
  table,
  rowsDraft,
  onNote,
}: {
  field: RowsFieldSpec
  host: RowRecord[]
  table: RowRecord[]
  rowsDraft: RowsDraft
  onNote: (note: { tone: 'ok' | 'error'; text: string }) => void
}): ReactNode {
  const key = field.key
  const columns = field.columns
  /** 最新一次渲染的行表：失焦可能紧跟在输入事件后面，闭包里的 `table` 未必已经更新。 */
  const latest = useRef(table)
  latest.current = table

  /** 这一行填好了就把整张表（半成品行按 `rowsForHost` 的规则）交给宿主；没填好只留草稿。 */
  const commitFilled = (rows: RowRecord[], rowIndex: number): void => {
    const row = rows[rowIndex]
    if (row === undefined || !rowFilled(row, columns)) return
    const miss = firstPatternMiss(row, columns)
    if (miss !== null) {
      onNote({ tone: 'error', text: t('superagent.settings.rows.invalid', { column: miss.column.label, value: miss.value }) })
      return
    }
    const payload = rowsForHost(rows, host, columns)
    // 和宿主内容一样就不必写：多半是用户改了又改回去。
    if (sameRows(payload, host)) return
    rowsDraft.commit(key, payload)
  }

  return (
    <div className="setting-row" style={{ alignItems: 'flex-start' }}>
      <div className="setting-text">
        <div className="setting-label">{field.label}</div>
        {field.help === undefined ? null : <div className="setting-help">{field.help}</div>}
      </div>
      <div
        className="setting-control"
        style={{ alignItems: 'stretch', flex: '1 1 auto', gap: 8, maxWidth: '68%', minWidth: 0 }}
      >
        {table.length === 0 ? <div className="setting-help">{t('superagent.settings.rows.empty')}</div> : null}
        {table.map((record, rowIndex) => (
          <div
            key={`row-${String(rowIndex)}`}
            style={{ alignItems: 'center', display: 'flex', gap: 6, minWidth: 0 }}
          >
            {columns.map((column) => {
              const cellAria = t('superagent.settings.rows.cellAria', { row: String(rowIndex + 1), column: column.label })
              if (column.type === 'select') {
                const current = record[column.key] ?? ''
                // 宿主给了选项外的值也要看得见（与单行下拉同一条口径）。
                const options =
                  current === '' || column.options.some((option) => option.value === current)
                    ? column.options
                    : [...column.options, { value: current, label: t('superagent.settings.unknown', { value: current }) }]
                return (
                  <select
                    key={column.key}
                    className="setting-input"
                    aria-label={cellAria}
                    style={{ flex: '0 0 auto', minWidth: 0, width: 'auto' }}
                    value={current}
                    onChange={(event) => {
                      // 下拉是「一次选定」的控件：先落草稿，这一行填满了就顺手提交。
                      const next = withCellValue(table, rowIndex, column.key, event.target.value)
                      rowsDraft.set(key, next)
                      commitFilled(next, rowIndex)
                    }}
                  >
                    {current === '' ? <option value="">{t('superagent.settings.rows.pick')}</option> : null}
                    {options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )
              }
              return (
                <input
                  key={column.key}
                  className="setting-input"
                  style={{ flex: '1 1 0', minWidth: 0 }}
                  aria-label={cellAria}
                  value={record[column.key] ?? ''}
                  placeholder={column.placeholder}
                  onChange={(event) => {
                    // 行内输入只落草稿；提交等失焦 / 回车，避免把打到一半的值送去校验。
                    rowsDraft.set(key, withCellValue(table, rowIndex, column.key, event.target.value))
                  }}
                  onBlur={() => {
                    commitFilled(latest.current, rowIndex)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                />
              )
            })}
            <button
              type="button"
              className="text-btn"
              aria-label={t('superagent.settings.rows.removeTip')}
              data-tip={t('superagent.settings.rows.removeTip')}
              onClick={() => {
                const next = table.filter((_, index) => index !== rowIndex)
                rowsDraft.set(key, next)
                const payload = rowsForHost(next, host, columns)
                // 删掉的只是一行还没提交的草稿：本地回收即可，和宿主一样就不用写。
                if (sameRows(payload, host)) return
                rowsDraft.commit(key, payload)
              }}
            >
              {t('superagent.settings.rows.remove')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-btn"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            // 新行先落草稿：空行交给宿主只会被 schema 丢掉，回读后行又没了。
            rowsDraft.set(key, [...table, {}])
          }}
        >
          {t('superagent.settings.rows.add')}
        </button>
        {sameRows(table, host) ? null : (
          <button
            type="button"
            className="text-btn"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              // 用户点「保存表格」= 连没填满的行一起交，让宿主的校验说话。
              rowsDraft.commit(key, table)
            }}
          >
            {t('superagent.settings.rows.save')}
          </button>
        )}
      </div>
    </div>
  )
}
