/**
 * 插件作者看到的那个模块：`import { defineUiPlugin, useHostSnapshot } from '@dsc/ui'`。
 *
 * 加载器把这一份**原样**交给插件（`require('@dsc/ui')` 拿到它），
 * 所以插件 bundle 里不要内联它——只能当外部模块引用，这样壳与插件共用同一套类型与
 * 同一份实现（按类型写代码，按依赖换实现）。
 *
 * 刻意只放"写插件需要的东西"：槽位类型、宿主身份、运行时 hook、defineUiPlugin。
 * React 与 react-dom 也从白名单里拿（插件 bundle 里是 `require('react')`），
 * 不另开端口——否则 React 会有两份，hooks 立刻崩。
 *
 * @module dsc-ui-shell/plugin-api
 */
import type { ComponentType } from 'react'
import type {
  HostSnapshot,
  SlotEntry,
  SlotKind,
  SlotRegistry,
  UiHostInfo,
  UiPluginModule,
  UiRuntimeApi,
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
  /** 运行时通道：看状态、调方法。 */
  runtime: UiRuntimeApi
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

/** 宿主状态的那几个字段（快照里的 status）；宿主换形状时这里是唯一要改的地方。 */
export interface HostStatusView {
  sessionId: string | null
  model: string
  effort: string | null
  turnState: string
  usage: { inputTokens: number; outputTokens: number } | null
  contextWindow?: number
}

/**
 * 从快照里取状态字段。取不到就给 null——插件不必自己写一遍防御式解构。
 * @param snapshot - `useHostSnapshot()` 的返回值
 */
export function hostStatus(snapshot: HostSnapshot | null): HostStatusView | null {
  if (snapshot === null) return null
  const status = snapshot['status']
  if (status === null || typeof status !== 'object') return null
  const record = status as Record<string, unknown>
  const usage = record['usage']
  return {
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : null,
    model: typeof record['model'] === 'string' ? record['model'] : '',
    effort: typeof record['effort'] === 'string' ? record['effort'] : null,
    turnState: typeof record['turnState'] === 'string' ? record['turnState'] : 'unknown',
    usage:
      usage !== null && typeof usage === 'object'
        ? {
            inputTokens: Number((usage as Record<string, unknown>)['inputTokens'] ?? 0),
            outputTokens: Number((usage as Record<string, unknown>)['outputTokens'] ?? 0),
          }
        : null,
    ...(typeof record['contextWindow'] === 'number' ? { contextWindow: record['contextWindow'] } : {}),
  }
}

export { useChannelStatus, useHostChannel, useHostHello, useHostSnapshot } from './runtime-context'
export type { ChannelStatus, HostHello } from './host-channel'
export type { SlotEntry, SlotKind, UiHostInfo, UiRuntimeApi, HostSnapshot }
