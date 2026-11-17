/**
 * 设置页行模型：SettingsOverlay 画几行、App 的鼠标点击换算成哪一行，共用这一份
 * 几何表——两边都从 buildSettingsRows 拿同一条 flat 行数组，行号永远不错位。
 *
 * 行高恒为 1：卡片顶边/底边各占一行、字段占一行、分区之间空一行，help 文案
 * 不进卡片行（聚焦行的 help 走底部提示条，对齐 dsh 的布局）。
 *
 * 两级导航（0.6.64，把 0.6.62 的组子页机制上提一层）：根页每分区只画一行导航
 * （`❯ 标题 · 副标题 … ›`），Enter 进分区页——分区页渲染该分区的内容（custom
 * 分区的指引行 / 普通分区块内字段，带组的分区画组导航行）；组子页（0.6.62）原样
 * 保留，恰好两级。Esc 由 App 逐级退栈：组 → 分区 → 根 → 关页。
 *
 * @module dsc-tui/app/settings-model
 */
import type { SettingsField, SettingsSectionView, SettingsValues } from '@pneuma/runtime/contract.js'

/** 当前展开的组子页（null/缺省 = 不在组子页）。 */
export interface SettingsGroupRef {
  sectionId: string
  groupId: string
}

/**
 * 设置页的一行；section/field/table-head/table-cell/table-add/hint/group 可聚焦，其余是结构行。
 *
 * `rows` 字段（记录表）在行模型里摊成三种行：一行列头（`table-head`，不可聚焦）、
 * 每个单元格一行（`table-cell`，可聚焦、Enter 编辑/删除）、末尾一行「添加」（`table-add`）。
 * 为什么按单元格而不是按记录摊：本页的行高恒为 1，一行只放得下一个输入框/下拉。
 *
 * `checks` 字段（分组多选）同样摊成多行：一行标题（`checks-head`，带已选计数）、每组
 * 一行组标题（`checks-group`）、每个可勾项一行（`checks-option`，可聚焦）。行高同样是 1：
 * 复选行写成 `[✓] 模型名  provider/model`，副说明并到同一行的右侧，不换行。
 */
export type SettingsRow =
  | { kind: 'card-top'; sectionId: string; title: string; subtitle?: string }
  | { kind: 'card-bottom' }
  | { kind: 'spacer' }
  | { kind: 'section'; sectionId: string; title: string; subtitle?: string }
  | { kind: 'field'; sectionId: string; fieldIndex: number }
  | { kind: 'table-head'; sectionId: string; fieldIndex: number }
  | { kind: 'table-cell'; sectionId: string; fieldIndex: number; rowIndex: number; columnIndex: number }
  | { kind: 'table-add'; sectionId: string; fieldIndex: number }
  | { kind: 'checks-head'; sectionId: string; fieldIndex: number }
  | { kind: 'checks-group'; sectionId: string; fieldIndex: number; title: string; empty: boolean }
  | { kind: 'checks-option'; sectionId: string; fieldIndex: number; value: string; label: string; detail?: string }
  | { kind: 'group'; sectionId: string; groupId: string; title: string; description?: string }
  | { kind: 'hint'; sectionId: string; text: string; jump?: 'model-picker' | 'usage' }

/**
 * `rows` 字段的当前记录表：值不是对象数组时按空表算（旧宿主 / 手改过的值不让界面崩）。
 */
export function tableRecordsOf(values: SettingsValues | undefined, key: string): Record<string, string>[] {
  const value = values?.[key]
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is Record<string, string> => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  )
}

/**
 * `checks` 字段的选中值：契约说好是 `string[]`，但旧宿主 / 手改过的值可能别的形状
 * （没给、给了字符串、数组里混进非字符串）。统一收成安全的字符串数组：界面不崩，
 * 非字符串元素丢掉——它们画不出来，也就没法在界面上取消。
 *
 * 与桌面端 `checkValuesOf`（ui-settings/ui/ui.tsx）同一条口径，两边的「未选」永远一致。
 */
export function checksSelected(values: SettingsValues | undefined, key: string): string[] {
  const value = values?.[key]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** 取某一行里的字段声明（下标越界返回 undefined）。 */
function fieldAt(section: SettingsSectionView, fieldIndex: number): SettingsField | undefined {
  return section.fields[fieldIndex]
}

/**
 * 一个字段在行模型里占的行：普通字段一行；`rows` 字段摊成「列头 + 每格一行 + 添加行」；
 * `checks` 字段摊成「标题 + 每组标题 + 每个可勾项一行」。
 * values 还没装填到时按 0 条记录画（列头与添加行仍在，不会白屏）。
 */
function fieldRows(
  section: SettingsSectionView,
  fieldIndex: number,
  values: Record<string, SettingsValues> | undefined,
): SettingsRow[] {
  const field = fieldAt(section, fieldIndex)
  if (field !== undefined && field.type === 'rows') {
    const rows: SettingsRow[] = [{ kind: 'table-head', sectionId: section.id, fieldIndex }]
    const records = tableRecordsOf(values?.[section.id], field.key)
    records.forEach((_, rowIndex) => {
      field.columns.forEach((__, columnIndex) => {
        rows.push({ kind: 'table-cell', sectionId: section.id, fieldIndex, rowIndex, columnIndex })
      })
    })
    rows.push({ kind: 'table-add', sectionId: section.id, fieldIndex })
    return rows
  }
  if (field !== undefined && field.type === 'checks') {
    const rows: SettingsRow[] = [{ kind: 'checks-head', sectionId: section.id, fieldIndex }]
    const selected = checksSelected(values?.[section.id], field.key)
    const listed = new Set<string>()
    for (const group of field.groups) {
      for (const option of group.options) listed.add(option.value)
      rows.push({
        kind: 'checks-group',
        sectionId: section.id,
        fieldIndex,
        title: group.title,
        empty: group.options.length === 0,
      })
      for (const option of group.options) {
        rows.push({
          kind: 'checks-option',
          sectionId: section.id,
          fieldIndex,
          value: option.value,
          label: option.label,
          ...(option.detail === undefined ? {} : { detail: option.detail }),
        })
      }
    }
    // 选了、但清单里没有的值（授权列表里的模型被删了 / 提供方改名）：单独收一行组标题，
    // 让用户看得见也取消得掉——同 GUI 的「其他（不在清单里）」那一组。
    const stray = selected.filter((value) => !listed.has(value))
    if (stray.length > 0) {
      rows.push({ kind: 'checks-group', sectionId: section.id, fieldIndex, title: '其他（不在清单里）', empty: false })
      for (const value of stray) {
        rows.push({ kind: 'checks-option', sectionId: section.id, fieldIndex, value, label: value })
      }
    }
    return rows
  }
  return [{ kind: 'field', sectionId: section.id, fieldIndex }]
}

/**
 * custom 分区在 TUI 的指引内容：管理界面在桌面端自己画，TUI 只给入口与去处——
 * 带 jump 的是可聚焦行（Enter 触发跳转），纯文案行只作说明。
 */
const CUSTOM_HINTS: Record<string, { text: string; jump?: 'model-picker' | 'usage' }[]> = {
  models: [
    { text: '打开模型选择器', jump: 'model-picker' },
    { text: '端点与 API key 在桌面端设置或 ~/.dsc/config.yaml 管理' },
  ],
  presets: [{ text: '会话内 /preset <名> 切换；默认模式在桌面端设置' }],
  skills: [{ text: '技能目录 ~/.dsc/skills；开关管理在桌面端' }],
  usage: [{ text: '查看用量统计', jump: 'usage' }],
  archive: [{ text: '/resume 的已归档页可恢复会话' }],
}

/** 单个分区的正文行（卡片顶边之后、底边之前的那段）；根页与分区页共用一份装配。 */
function sectionBodyRows(
  section: SettingsSectionView,
  values: Record<string, SettingsValues> | undefined,
): SettingsRow[] {
  const rows: SettingsRow[] = []
  const hints = CUSTOM_HINTS[section.id]
  if (section.custom) {
    for (const hint of hints ?? []) rows.push({ kind: 'hint', sectionId: section.id, ...hint })
    return rows
  }
  // 带组的字段收进子页，组行在其第一个字段的位置就地出现（只出现一次）；
  // 组没声明或组内没字段就不画导航行。
  const emitted = new Set<string>()
  section.fields.forEach((field, fieldIndex) => {
    const spec = field.group === undefined ? undefined : section.groups?.find((entry) => entry.id === field.group)
    if (spec === undefined) {
      rows.push(...fieldRows(section, fieldIndex, values))
      return
    }
    if (emitted.has(spec.id)) return
    emitted.add(spec.id)
    rows.push({ kind: 'group', sectionId: section.id, groupId: spec.id, title: spec.title, description: spec.description })
  })
  return rows
}

/**
 * 分区列表 → flat 行数组。三种模式：
 *   group != null          → 组子页（只渲染该组字段，卡片标题 = 组名、副标题 = 分区名）；
 *   section != null        → 分区页（该分区一张卡片：字段/组导航/指引行）；
 *   两者都空               → 根页（每分区一行导航，不画卡片——名字本身就是入口）。
 * 分区/组没声明或没了就给空表（App 侧 Esc 兜底回上级，不会停在白屏）。
 *
 * `values` 只有 `rows` / `checks` 字段用得到（记录表的行数、多选项的选中态）；没装填到时
 * 按「0 条记录 / 一个都没选」画。
 */
export function buildSettingsRows(
  sections: SettingsSectionView[],
  sectionId?: string | null,
  group?: SettingsGroupRef | null,
  values?: Record<string, SettingsValues>,
): SettingsRow[] {
  if (group != null) {
    const section = sections.find((entry) => entry.id === group.sectionId)
    const spec = section?.groups?.find((entry) => entry.id === group.groupId)
    if (section === undefined || spec === undefined) return []
    const rows: SettingsRow[] = [{ kind: 'card-top', sectionId: section.id, title: spec.title, subtitle: section.title }]
    section.fields.forEach((field, fieldIndex) => {
      if (field.group === group.groupId) rows.push(...fieldRows(section, fieldIndex, values))
    })
    rows.push({ kind: 'card-bottom' })
    return rows
  }
  if (sectionId != null) {
    const section = sections.find((entry) => entry.id === sectionId)
    if (section === undefined) return []
    return [
      { kind: 'card-top', sectionId: section.id, title: section.title, subtitle: section.subtitle },
      ...sectionBodyRows(section, values),
      { kind: 'card-bottom' },
    ]
  }
  return sections.map((section) => ({
    kind: 'section' as const,
    sectionId: section.id,
    title: section.title,
    ...(section.subtitle === undefined ? {} : { subtitle: section.subtitle }),
  }))
}

/**
 * 该行能不能拿到焦点（有 Enter/←→ 动作才给焦点：`fact` 只读不聚焦，info 仅 copyable
 * 可聚焦，分区/组行恒可聚焦，记录表的单元格与「添加」行可聚焦，`checks` 的可勾项可聚焦）。
 */
export function isFocusableRow(row: SettingsRow, fields: SettingsSectionView['fields']): boolean {
  if (row.kind === 'section' || row.kind === 'group') return true
  if (row.kind === 'table-cell' || row.kind === 'table-add') return true
  if (row.kind === 'checks-option') return true
  if (row.kind === 'field') {
    const field = fields[row.fieldIndex]
    if (field === undefined) return false
    if (field.type === 'fact') return false
    return field.type !== 'info' || field.copyable === true
  }
  return row.kind === 'hint' && row.jump !== undefined
}

/** 焦点可落的行号表（buildSettingsRows 顺序里的下标；↑↓ 与滚轮在其上移动）。 */
export function focusableRows(rows: SettingsRow[], sections: SettingsSectionView[]): number[] {
  const byId = new Map(sections.map((section) => [section.id, section]))
  const result: number[] = []
  rows.forEach((row, index) => {
    if (row.kind === 'section' || row.kind === 'group') {
      result.push(index)
      return
    }
    if (
      row.kind !== 'field' &&
      row.kind !== 'hint' &&
      row.kind !== 'table-cell' &&
      row.kind !== 'table-add' &&
      row.kind !== 'checks-option'
    ) {
      return
    }
    const fields = byId.get(row.sectionId)?.fields ?? []
    if (isFocusableRow(row, fields)) result.push(index)
  })
  return result
}

/**
 * 焦点跟随窗口（dsh windowStart 同语义）：保证聚焦行落在视口内，越过下缘窗口
 * 跟进一行、顶回上缘窗口钉住；行数不足一屏时窗口恒为 0。纯函数——组件与
 * App 的鼠标映射各自调用，结果一致。
 */
export function settingsWindowStart(focusRow: number, viewport: number, total: number): number {
  if (viewport <= 0 || total <= viewport) return 0
  return Math.max(0, Math.min(focusRow - viewport + 1, focusRow, total - viewport))
}
