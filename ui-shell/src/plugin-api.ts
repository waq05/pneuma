/**
 * 插件作者看到的那个模块：`import { defineUiPlugin } from '@dsc/ui'`。
 *
 * 加载器把这一份**原样**交给插件（`require('@dsc/ui')` 拿到它），
 * 所以插件 bundle 里不要内联它——只能当外部模块引用，这样壳与插件共用同一套类型与
 * 同一份实现（按类型写代码，按依赖换实现）。
 *
 * 这一份刻意只放"写插件需要的东西"：槽位类型、宿主身份、defineUiPlugin。
 * React 与 react-dom 也从白名单里拿（插件 bundle 里是 `require('react')`），
 * 不另开端口——否则 React 会有两份，hooks 立刻崩。
 *
 * @module dsc-ui-shell/plugin-api
 */
import type { ComponentType } from 'react'
import type {
  SlotEntry,
  SlotKind,
  SlotRegistry,
  UiHostInfo,
  UiPluginModule,
} from '@dsc/ui-core'

/** 浏览器壳里「组件」就是 React 组件。 */
export type UiComponent = ComponentType

/** 壳里的槽位注册表。 */
export type UiSlots = SlotRegistry<UiComponent>

/** 插件 `apply(ui)` 拿到的那一份。 */
export interface UiPluginApi {
  /** 这个插件的 id（宿主清单里那一条）。 */
  id: string
  /** 槽位注册表：只能往已声明的槽里注册，拼错槽名当场报错。 */
  slots: UiSlots
  /** 宿主身份（要显示版本号之类的用）。 */
  host: UiHostInfo
}

/** 插件 bundle 要导出的形状。 */
export type UiPlugin = UiPluginModule<UiComponent>

/**
 * 标识函数：`export default defineUiPlugin({ apply })`。
 * 作用只是让类型检查提前发现「apply 写错了」「组件类型不对」这类笔误。
 */
export function defineUiPlugin(module: UiPlugin): UiPlugin {
  return module
}

export type { SlotEntry, SlotKind, UiHostInfo }
