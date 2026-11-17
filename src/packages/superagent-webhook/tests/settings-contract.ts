/**
 * 设置契约的类型层验收：把 webhook kind 的 `rows` / `fact` 字段投影成 `SettingsField`。
 *
 * ## 为什么放在 tests/ 而不是实现里
 *
 * 投影是**宿主设置页**的职责（主包 `host/settings-section.ts` 的 `sourceFieldOf` 做同一件事），
 * 来源插件自己不该画界面。这份文件只做两件事：
 *   1. 编译期：`settingsFieldOf` 的返回类型是 `SettingsField`，`rows` / `fact` 两支写错时
 *      `pnpm run build` 的 tsc 当场报错——这是「这两种字段能过设置契约」的静态证据；
 *   2. 运行期：`contractRows` / `contractFact` 给 `webhook.test.mjs` 断言用，形状与
 *      `src/contract/settings.ts` 的两个分支逐字段对得上。
 *
 * 语言固定取中文一份：这里只是类型/形状探针，不是界面取词逻辑（真界面按宿主语言选一份）。
 *
 * @module dsc/packages/superagent-webhook/tests/settings-contract
 */
import type { SettingsField } from '@pneuma/runtime/contract.js'
import type { FieldSpec, Localized } from '@pneuma/superagent/sources/kind.js'
import { webhookKind } from '../webhook.js'

/** 本地化文案取中文一份；只用于形状断言。 */
const text = (value: Localized): string => value.zh

/**
 * 一个 `FieldSpec` → 设置契约的 `SettingsField`。
 *
 * 与主包 `host/settings-section.ts:178-193` 的 `sourceFieldOf` 同一套边界，但保留
 * `rows` / `fact` 两支的原始形状（主包那一份为了兼容旧界面把两支都降成了 text）。
 *
 * @param field - 来源 kind 声明的字段
 * @returns 设置分区的控件声明；返回类型由 tsc 强制与 `SettingsField` 一致
 */
export function settingsFieldOf(field: FieldSpec): SettingsField {
  switch (field.type) {
    case 'text':
      return { type: 'text', key: field.key, label: text(field.label), ...field.hint === undefined ? {} : { help: text(field.hint) } }
    case 'number':
      return { type: 'number', key: field.key, label: text(field.label), min: field.min, max: field.max, ...field.hint === undefined ? {} : { help: text(field.hint) } }
    case 'switch':
      return { type: 'switch', key: field.key, label: text(field.label), ...field.hint === undefined ? {} : { help: text(field.hint) } }
    case 'select':
      return {
        type: 'select', key: field.key, label: text(field.label),
        options: field.options.map(option => ({ value: option.value, label: text(option.label) })),
        ...field.hint === undefined ? {} : { help: text(field.hint) },
      }
    case 'rows':
      return {
        type: 'rows', key: field.key, label: text(field.label),
        columns: field.columns.map(column => column.type === 'text'
          ? {
              key: column.key, label: text(column.label), type: 'text' as const,
              ...column.pattern === undefined ? {} : { pattern: column.pattern },
              ...column.optional === true ? { optional: true } : {},
              ...column.choose === undefined ? {} : { choose: true },
              ...column.refresh === undefined ? {} : { refresh: true },
            }
          : {
              key: column.key, label: text(column.label), type: 'select' as const,
              options: column.options.map(option => ({ value: option.value, label: text(option.label) })),
            }),
        ...field.hint === undefined ? {} : { help: text(field.hint) },
        ...field.advanced === true ? { advanced: true } : {},
      }
    case 'fact':
      return {
        type: 'fact', key: field.key, label: text(field.label),
        ...field.hint === undefined ? {} : { help: text(field.hint) },
        ...field.settings === undefined ? {} : { settings: field.settings },
        ...field.advanced === true ? { advanced: true } : {},
      }
  }
}

/** 按类型取 webhook kind 的一个字段；声明漏了就在加载时抛，测试不用猜。 */
function fieldOf<T extends FieldSpec['type']>(type: T): Extract<FieldSpec, { type: T }> {
  const found = webhookKind.fields.find(field => field.type === type)
  if (found === undefined) throw new Error(`The webhook kind declares no ${type} field`)
  return found as Extract<FieldSpec, { type: T }>
}

/**
 * 编译期验收：这两个常量各自要被 `SettingsField` 的 `rows` / `fact` 分支接住。
 * 构图一律从 `webhookKind.fields` 来，改声明改坏了这里先红。
 */
export const contractRows = settingsFieldOf(fieldOf('rows')) satisfies SettingsField
export const contractFact = settingsFieldOf(fieldOf('fact')) satisfies SettingsField
