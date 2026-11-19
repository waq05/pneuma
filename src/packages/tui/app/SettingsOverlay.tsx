/**
 * 设置页（/settings）：整屏浮层、分区卡片 + 字段行，纯展示——焦点、编辑草稿、
 * 回执、滚动窗口全在 App；行几何用 settings-model.ts 的同一份表，App 的鼠标
 * 行号映射与这里画的行永远 1:1。
 *
 * 行规格（对齐 dsh 的 Settings 屏）：卡片顶边 `╭─ 标题 · 副标题 ────╮`、字段行
 * `❯ 标签 … 值右对齐`（switch `[✓]`/`[  ]`、select `‹ 选项 ›`、text/number 编辑态
 * 带 `▌` 光标、button 强调色、info 暗淡），底部恒定两行：notice（成功绿/失败红，
 * 静默时空行防跳动）+ 提示条（聚焦字段的 help + 右侧按键提示）。help 不进卡片行，
 * 聚焦行才在提示条里出现——每行高度恒为 1，行模型才守得住。
 *
 * 多选（`checks`）在行模型里摊成「字段标题 + 组标题 + 每个可勾项一行」：可勾行画
 * `[✓] 标签  副说明`，空格/Enter 翻转（写回在 App），组标题与字段标题不抢焦点。
 *
 * 子页（0.6.62）：带组的分区在根页画组导航行 `❯ 标题 … ›`，传 group 参时整份
 * rows 已是子页内容（settings-model 负责），这里只多两处观感——标题行变面包屑
 * `设置 › 分区 › 组`、提示条 Esc 换「返回」。
 *
 * @module dsc-tui/app/SettingsOverlay
 */
import { Box, Text, useStdout } from 'ink'
import type { JSX } from 'react'
import type { SettingsField, SettingsSectionView, SettingsValues } from '@pneuma/runtime/contract.js'
import { displayWidth } from './display-width.js'
import { checksSelected, focusableRows, tableRecordsOf, type SettingsGroupRef, type SettingsRow } from './settings-model.js'
import { ACCENT, BORDER, GAP, MARK, PAD, PALETTE, SEP, STATUS_COLOR, TEXT } from './theme.js'

/** 设置页固定框架行数：外框上下边 2 + 标题 1 + 底部 notice 1 + 提示条 1。 */
export const SETTINGS_CHROME = 5
/** 列表首行距屏幕顶的行数（鼠标行号映射的固定偏移）：顶边框 1 + 标题 1。 */
export const SETTINGS_LIST_TOP = 2

/** 按显示宽度硬截断（超宽补 …）；CJK 记 2 列，代理对不劈开。 */
const clipToWidth = (text: string, max: number): string => {
  if (max <= 2) return ''
  let width = 0
  let out = ''
  for (const char of text) {
    if (width + displayWidth(char) > max - 1) return `${out}…`
    out += char
    width += displayWidth(char)
  }
  return out
}

/** 编辑中的字段：显示草稿加光标（对齐 dsh 的 ▌）。记录表的单元格带上行号与列 key。 */
export interface SettingsEdit {
  sectionId: string
  key: string
  draft: string
  /** 记录表用：正在编辑第几行（普通字段缺省）。 */
  row?: number
  /** 记录表用：正在编辑哪一列（列 key）。 */
  column?: string
}

/**
 * 字段值区（右对齐段）的文本；编辑中的 text/number 显示草稿加光标，值表没到时
 * 显示 … 占位（打开设置页后 values 异步装填，只差几毫秒但不能闪「未设置」）。
 */
function fieldValueText(field: SettingsField, values: SettingsValues | undefined, editing: SettingsEdit | null): string {
  if (field.type === 'info') return field.text
  if (field.type === 'button') return field.label
  if (editing !== null && editing.key === field.key) return `${editing.draft}▌`
  if (values === undefined) return '…'
  const current = values[field.key]
  switch (field.type) {
    case 'switch':
      return current === true ? '[✓]' : '[  ]'
    case 'select': {
      const label = field.options.find((option) => option.value === String(current))?.label
      return `‹ ${label ?? String(current ?? '')} ›`
    }
    case 'fact': {
      // 只读事实行：值来自 values[key]；片段可能来自部署检查，晚到就是占位。
      if (typeof current === 'string') return current === '' ? '（没有值）' : current
      if (typeof current === 'number' || typeof current === 'boolean') return String(current)
      return '（没有值）'
    }
    case 'rows': {
      // rows 字段本身不占 field 行（行模型里摊成列头/单元格/添加行），这里只兜个底。
      const count = tableRecordsOf(values, field.key).length
      return count === 0 ? '（空表）' : `${String(count)} 行`
    }
    case 'checks': {
      // checks 字段同样摊成多行（标题/组标题/每个可勾项），这里只兜个底。
      const picked = checksSelected(values, field.key).length
      const total = field.groups.reduce((count, group) => count + group.options.length, 0)
      return `已选 ${String(picked)}/${String(total)} 项`
    }
    default:
      // text / number：空值给「未设置」占位（对齐 dsh 的（未设置））
      return current === undefined || current === '' ? '（未设置）' : String(current)
  }
}

/** 值区的颜色：switch 打开是完成绿、button/编辑中是强调系，其余走暗淡档。 */
function fieldValueColor(
  field: SettingsField,
  values: SettingsValues | undefined,
  editing: SettingsEdit | null,
  focused: boolean,
): string | undefined {
  if (field.type === 'button') return ACCENT
  if (field.type === 'info') return undefined
  if (editing !== null && editing.key === field.key) return PALETTE.text
  if (field.type === 'switch') return values?.[field.key] === true ? STATUS_COLOR.done : undefined
  if (field.type === 'select') return focused ? ACCENT : undefined
  return undefined
}

export function SettingsOverlay({
  sections,
  rows,
  values,
  focusRow,
  windowStart,
  viewport,
  editing,
  notice,
  section,
  group,
}: {
  sections: SettingsSectionView[]
  rows: SettingsRow[]
  /** 分区 id → 值表；分区键缺失 = 值还在装载。 */
  values: Record<string, SettingsValues>
  /** 聚焦的模型行号（buildSettingsRows 下标）。 */
  focusRow: number
  windowStart: number
  viewport: number
  editing: SettingsEdit | null
  notice: { ok: boolean; text: string } | null
  /** 当前展开的分区页（null = 根页）：标题行变面包屑，Esc 提示换「返回」。 */
  section?: string | null
  /** 当前展开的组子页（null = 不在组子页）。 */
  group?: SettingsGroupRef | null
}): JSX.Element {
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 100
  // 内宽 = 终端列 − 整帧页边距 − 外框描边 2 − 框内 padding
  const innerWidth = Math.max(24, columns - PAD.page * 2 - 2 - PAD.inline * 2)
  const sectionById = new Map(sections.map((section) => [section.id, section]))
  const activeSection = section == null ? undefined : sectionById.get(section)
  const groupSection = group == null ? undefined : sectionById.get(group.sectionId)
  const groupSpec = groupSection?.groups?.find((entry) => entry.id === group?.groupId)
  const focusables = focusableRows(rows, sections)
  const focusOrdinal = focusables.indexOf(focusRow)
  const visible = rows.slice(windowStart, windowStart + Math.max(1, viewport))

  const renderRow = (row: SettingsRow, index: number): JSX.Element => {
    const focused = index === focusRow
    switch (row.kind) {
      case 'card-top': {
        const base = ` ${row.title} `
        let head = row.subtitle === undefined ? base : ` ${row.title} · ${row.subtitle} `
        if (displayWidth(head) > innerWidth - 4) head = base // 窄终端先丢副标题（dsh 同序）
        const fill = Math.max(1, innerWidth - 3 - displayWidth(head))
        return (
          <Text key={index} wrap="truncate-end">
            <Text color={BORDER.frame}>╭─</Text>
            <Text bold color={PALETTE.text}>
              {head}
            </Text>
            <Text color={BORDER.frame}>{'─'.repeat(fill)}╮</Text>
          </Text>
        )
      }
      case 'card-bottom':
        return (
          <Text key={index} color={BORDER.frame}>
            ╰{'─'.repeat(Math.max(0, innerWidth - 2))}╯
          </Text>
        )
      case 'spacer':
        return <Text key={index}> </Text>
      case 'section': {
        // 分区导航行（0.6.64，组行同款）：标题 + 暗淡副标题，`›` 贴右缘
        const labelText = clipToWidth(row.title, Math.max(8, innerWidth - 12))
        const subText = row.subtitle === undefined ? '' : clipToWidth(row.subtitle, Math.max(4, Math.floor(innerWidth / 3)))
        // 宽度账：标记「❯ 」2 + 标题 + 空格 1 + 副标题 + pad + › 1 ≤ innerWidth
        const pad = Math.max(1, innerWidth - 4 - displayWidth(labelText) - displayWidth(subText))
        return (
          <Text key={index} wrap="truncate-end">
            {focused ? MARK.selected : MARK.idle}
            <Text bold={focused} color={PALETTE.text}>
              {labelText}
            </Text>
            {subText === '' ? null : (
              <Text {...TEXT.secondary}>
                {' '}
                {subText}
              </Text>
            )}
            {' '.repeat(pad)}
            <Text {...(focused ? {} : TEXT.secondary)} color={focused ? ACCENT : undefined}>
              ›
            </Text>
          </Text>
        )
      }
      case 'group': {
        // 组导航行（dsh GroupRow 同款）：label 左、`›` 贴右缘，聚焦时强调色
        const labelText = clipToWidth(row.title, Math.max(8, innerWidth - 12))
        const pad = Math.max(1, innerWidth - 2 - displayWidth(labelText) - 1)
        return (
          <Text key={index} wrap="truncate-end">
            {focused ? MARK.selected : MARK.idle}
            <Text bold={focused} color={PALETTE.text}>
              {labelText}
            </Text>
            {' '.repeat(pad)}
            <Text {...(focused ? {} : TEXT.secondary)} color={focused ? ACCENT : undefined}>
              ›
            </Text>
          </Text>
        )
      }
      case 'hint':
        return (
          <Text key={index} wrap="truncate-end">
            {focused ? MARK.selected : MARK.idle}
            <Text
              {...(row.jump === undefined ? TEXT.secondary : {})}
              bold={focused}
              color={row.jump === undefined ? undefined : ACCENT}
            >
              {row.text}
            </Text>
          </Text>
        )
      case 'field': {
        const section = sectionById.get(row.sectionId)
        const field = section?.fields[row.fieldIndex]
        if (field === undefined) return <Text key={index}> </Text>
        const sectionValues = values[row.sectionId]
        const valueText = fieldValueText(field, sectionValues, editing !== null && editing.sectionId === row.sectionId ? editing : null)
        const valueColor = fieldValueColor(field, sectionValues, editing !== null && editing.sectionId === row.sectionId ? editing : null, focused)
        const labelText = clipToWidth(field.label ?? '', Math.max(8, innerWidth - 12))
        const clipped = clipToWidth(valueText, Math.max(4, innerWidth - 2 - displayWidth(labelText) - 1))
        const pad = Math.max(1, innerWidth - 2 - displayWidth(labelText) - displayWidth(clipped))
        return (
          <Text key={index} wrap="truncate-end">
            {focused ? MARK.selected : MARK.idle}
            <Text bold={focused} color={PALETTE.text}>
              {labelText}
            </Text>
            {' '.repeat(pad)}
            <Text color={valueColor} {...(valueColor === undefined ? TEXT.secondary : {})}>
              {clipped}
            </Text>
          </Text>
        )
      }
      case 'table-head': {
        // 记录表的列头：字段名 + 各列标题，一行放完（行高恒为 1）。
        const field = sectionById.get(row.sectionId)?.fields[row.fieldIndex]
        if (field === undefined || field.type !== 'rows') return <Text key={index}> </Text>
        const columns = field.columns.map((column) => column.label).join(' · ')
        const title = clipToWidth(`${field.label} `, Math.max(8, innerWidth - 4))
        const clipped = clipToWidth(columns, Math.max(4, innerWidth - displayWidth(title) - 2))
        return (
          <Text key={index} wrap="truncate-end">
            <Text bold color={PALETTE.text}>
              {title}
            </Text>
            <Text {...TEXT.secondary}>{clipped}</Text>
          </Text>
        )
      }
      case 'table-cell': {
        // 一个单元格一行：`行号 列名  值`；编辑态显示草稿与光标。
        const field = sectionById.get(row.sectionId)?.fields[row.fieldIndex]
        if (field === undefined || field.type !== 'rows') return <Text key={index}> </Text>
        const column = field.columns[row.columnIndex]
        const record = tableRecordsOf(values[row.sectionId], field.key)[row.rowIndex] ?? {}
        const stored = column === undefined ? '' : (record[column.key] ?? '')
        // 下拉列按单行 select 的样子画（‹ 选项名 ›）；找不到对应选项就把原值照实显示。
        const shown =
          column !== undefined && column.type === 'select' && stored !== ''
            ? `‹ ${column.options.find((option) => option.value === stored)?.label ?? stored} ›`
            : stored
        const editingHere =
          editing !== null &&
          editing.sectionId === row.sectionId &&
          editing.key === field.key &&
          editing.row === row.rowIndex &&
          editing.column === column?.key
        const valueText = editingHere ? `${editing.draft}▌` : shown === '' ? '（空）' : shown
        const head = ` ${String(row.rowIndex + 1)} ${column?.label ?? ''}  `
        const headText = clipToWidth(head, Math.max(6, Math.floor(innerWidth / 3)))
        const clipped = clipToWidth(valueText, Math.max(4, innerWidth - 2 - displayWidth(headText)))
        return (
          <Text key={index} wrap="truncate-end">
            {focused ? MARK.selected : MARK.idle}
            <Text {...TEXT.secondary}>{headText}</Text>
            <Text color={editingHere ? PALETTE.text : undefined} {...(editingHere ? {} : TEXT.secondary)}>
              {clipped}
            </Text>
          </Text>
        )
      }
      case 'table-add': {
        const field = sectionById.get(row.sectionId)?.fields[row.fieldIndex]
        if (field === undefined || field.type !== 'rows') return <Text key={index}> </Text>
        return (
          <Text key={index} wrap="truncate-end">
            {focused ? MARK.selected : MARK.idle}
            <Text {...(focused ? { color: ACCENT, bold: true } : TEXT.secondary)}>
              {clipToWidth(`＋ 添加一行（${field.label}）`, Math.max(8, innerWidth - 2))}
            </Text>
          </Text>
        )
      }
      case 'checks-head': {
        // 多选字段的标题行：标签左、已选计数右贴边；不可聚焦（焦点落在下面的复选行上）。
        const field = sectionById.get(row.sectionId)?.fields[row.fieldIndex]
        if (field === undefined || field.type !== 'checks') return <Text key={index}> </Text>
        const picked = checksSelected(values[row.sectionId], field.key).length
        const total = field.groups.reduce((count, group) => count + group.options.length, 0)
        const countText = `已选 ${String(picked)}/${String(total)} 项`
        const labelText = clipToWidth(field.label, Math.max(8, innerWidth - 4 - displayWidth(countText)))
        const pad = Math.max(1, innerWidth - 2 - displayWidth(labelText) - displayWidth(countText))
        return (
          <Text key={index} wrap="truncate-end">
            {'  '}
            <Text bold color={PALETTE.text}>
              {labelText}
            </Text>
            {' '.repeat(pad)}
            <Text {...TEXT.secondary}>{countText}</Text>
          </Text>
        )
      }
      case 'checks-group': {
        // 组标题行（如「按提供方分组」的那一家）：缩进在复选行之上，空组给一句占位。
        const field = sectionById.get(row.sectionId)?.fields[row.fieldIndex]
        if (field === undefined || field.type !== 'checks') return <Text key={index}> </Text>
        const titleText = clipToWidth(row.title, Math.max(8, innerWidth - 10))
        return (
          <Text key={index} wrap="truncate-end">
            {'    '}
            <Text bold dimColor>
              {titleText}
            </Text>
            {row.empty ? <Text dimColor>{'（这一组没有选项）'}</Text> : null}
          </Text>
        )
      }
      case 'checks-option': {
        // 一个可勾项一行：`[✓] 模型名  provider/model`；空格/Enter 翻转（App 负责写回）。
        const field = sectionById.get(row.sectionId)?.fields[row.fieldIndex]
        if (field === undefined || field.type !== 'checks') return <Text key={index}> </Text>
        const checked = checksSelected(values[row.sectionId], field.key).includes(row.value)
        const box = checked ? '[✓]' : '[  ]'
        const detailMax = row.detail === undefined ? 0 : Math.max(4, Math.floor(innerWidth / 2))
        const labelText = clipToWidth(row.label, Math.max(8, innerWidth - 8 - detailMax))
        const detailText =
          row.detail === undefined
            ? ''
            : clipToWidth(row.detail, Math.max(4, innerWidth - 8 - displayWidth(labelText)))
        return (
          <Text key={index} wrap="truncate-end">
            {focused ? MARK.selected : MARK.idle}
            <Text color={checked ? STATUS_COLOR.done : undefined} {...(checked ? {} : TEXT.secondary)}>
              {box}
            </Text>
            <Text> </Text>
            <Text {...(focused ? {} : TEXT.secondary)} bold={focused} color={focused ? PALETTE.text : undefined}>
              {labelText}
            </Text>
            {detailText === '' ? null : (
              <>
                <Text {...TEXT.secondary}>{'  '}</Text>
                <Text {...TEXT.secondary}>{detailText}</Text>
              </>
            )}
          </Text>
        )
      }
    }
  }

  // 底部提示条：聚焦字段的 help（可复制的 info 追加复制提示）截断后靠左，按键靠右
  const focusedRow = rows[focusRow]
  const focusedField =
    focusedRow !== undefined &&
    (focusedRow.kind === 'field' ||
      focusedRow.kind === 'table-cell' ||
      focusedRow.kind === 'table-head' ||
      focusedRow.kind === 'table-add' ||
      focusedRow.kind === 'checks-option')
      ? sectionById.get(focusedRow.sectionId)?.fields[focusedRow.fieldIndex]
      : undefined
  let help =
    focusedRow?.kind === 'group'
      ? (focusedRow.description ?? '')
      : focusedRow?.kind === 'section'
        ? (focusedRow.subtitle ?? '')
        : (focusedField?.help ?? '')
  if (focusedField?.type === 'info' && focusedField.copyable === true) {
    help = `${help === '' ? '' : `${help} · `}Enter 复制`
  }
  const keys =
    editing !== null
      ? 'Enter 确认并保存 · Esc 取消'
      : focusedRow?.kind === 'table-cell'
        ? 'Enter 编辑 · Del 删行 · Esc 返回'
        : focusedRow?.kind === 'table-add'
          ? 'Enter 添加一行 · Esc 返回'
          : focusedRow?.kind === 'checks-option'
            ? '空格 切换选中 · Esc 返回'
            : groupSpec !== undefined || activeSection !== undefined
              ? 'Enter 切换/编辑 · Esc 返回'
              : 'Enter 切换/编辑 · Esc 关闭'
  const helpText = clipToWidth(help, Math.max(0, innerWidth - displayWidth(keys) - 2))

  return (
    <Box
      borderStyle="round"
      borderColor={BORDER.active}
      paddingX={PAD.inline}
      flexDirection="column"
      flexGrow={1}
      overflowY="hidden"
      gap={GAP.none}
    >
      <Box flexShrink={0} flexDirection="column" gap={GAP.none}>
        <Text {...TEXT.label} color={ACCENT} wrap="truncate-end">
          {groupSpec !== undefined && groupSection !== undefined ? (
            <>
              设置
              <Text {...TEXT.secondary}>{` › ${groupSection.title} › `}</Text>
              {groupSpec.title}
            </>
          ) : activeSection !== undefined ? (
            <>
              设置
              <Text {...TEXT.secondary}>{' › '}</Text>
              {activeSection.title}
            </>
          ) : (
            `设置（${sections.length} 个分区）`
          )}
          {focusOrdinal >= 0 ? (
            <Text {...TEXT.secondary}>
              {SEP.gap}
              {focusOrdinal + 1}/{focusables.length}
            </Text>
          ) : null}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden" gap={GAP.none}>
        {visible.map((row, offset) => renderRow(row, windowStart + offset))}
      </Box>
      <Box flexShrink={0} flexDirection="column" gap={GAP.none}>
        <Text wrap="truncate-end">
          {notice === null ? (
            <Text> </Text>
          ) : (
            <Text color={notice.ok ? STATUS_COLOR.done : STATUS_COLOR.failed}>
              {notice.ok ? '✓' : '✕'} {notice.text}
            </Text>
          )}
        </Text>
        <Text wrap="truncate-end">
          <Text {...TEXT.secondary}>{helpText}</Text>
          <Text {...TEXT.secondary}>{' '.repeat(Math.max(1, innerWidth - displayWidth(helpText) - displayWidth(keys)))}</Text>
          <Text {...TEXT.label} color={ACCENT}>
            {keys}
          </Text>
        </Text>
      </Box>
    </Box>
  )
}
