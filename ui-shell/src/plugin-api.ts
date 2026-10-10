/**
 * 插件作者看到的那个模块：`import { defineUiPlugin, useHostSnapshot } from '@dsc/ui'`。
 *
 * 加载器把这一份**原样**交给插件（`require('@dsc/ui')` 拿到它），
 * 所以插件 bundle 里不要内联它——只能当外部模块引用，这样壳与插件共用同一套类型与
 * 同一份实现（按类型写代码，按依赖换实现）。
 *
 * 刻意只放"写插件需要的东西"：槽位类型、组件 props 契约、宿主身份、运行时 hook、
 * defineUiPlugin。React 与 react-dom 也从白名单里拿（插件 bundle 里是 `require('react')`），
 * 不另开端口——否则 React 会有两份，hooks 立刻崩。
 *
 * @module dsc-ui-shell/plugin-api
 */
import type { ComponentType, ReactNode } from 'react'
import type {
  HostSnapshot,
  SlotEntry,
  SlotKind,
  SlotRegistry,
  UiHostInfo,
  UiPluginApi as CoreUiPluginApi,
  UiPluginModule,
  UiRuntimeApi,
  UiSlotApi,
} from '@dsc/ui-core'

/**
 * 壳交给插件组件的渲染能力（每个条目都有）。
 *
 * 为什么要交给组件而不是从 `ui.slots` 里直接渲染：槽是**位置**，位置归渲染它的人管。
 * 一个工具卡要在自己尾巴上留个洞，得由它说明「这个洞叫什么」，别人再往里放东西；
 * 这样 `renderSlot` 只能渲染本条目自己声明过的名字，拼错当场报装配错误。
 */
export interface SlotRenderApi {
  /** 渲染本条目声明过的子槽（没声明过的名字调用会抛装配错误）。 */
  renderSlot(name: string, props?: Record<string, unknown>): ReactNode
  /** 本条目声明出来的子槽名（诊断用）。 */
  childSlots: readonly string[]
}

/** 槽条目组件收到的 props：渲染位置给的 owner 值（展开在顶层）+ 渲染能力。 */
export type SlotComponentProps<Owner = Record<string, never>> = Owner & SlotRenderApi

/**
 * 浏览器壳里「组件」就是 React 组件。
 *
 * 这里用 `any` 是刻意的：owner props 的形态由每个槽自己定（消息流的组件要知道
 * 「我在渲染哪条消息」），注册表只把它们当「能渲染的东西」；写 `unknown` 会把
 * 插件作者的类型全部挡掉，注册一个组件都得先做类型断言。
 */
export type UiComponent = ComponentType<any>

/** 壳内部的槽位注册表：渲染与诊断都要用到壳的那几个能力（订阅、退位、故障表）。 */
export type UiSlots = SlotRegistry<UiComponent>

/** 插件 `apply(ui)` 拿到的那一份（核心定义 + 组件类型特化，不再手抄一遍）。 */
export type UiPluginApi = CoreUiPluginApi<UiComponent>

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

export { useChannelStatus, useHostChannel, useHostError, useHostSelector, useHostSnapshot } from './runtime-context'
export type { ChannelStatus, HostHello } from './host-channel'
export type { SlotEntry, SlotKind, UiHostInfo, UiRuntimeApi, UiSlotApi, HostSnapshot }
// 图标集原样转出去：插件 bundle 里 `import { IconPin } from '@dsc/ui'` 即可，
// 不必各自内联一份 SVG（同一枚图标在多个插件里内联，改一次要改好几处）。
export * from './icons'
// 宿主视图类型原样转出去：插件按它们写渲染，宿主改字段时插件这边编不过（而不是线上画空）。
export type {
  ApprovalAnswer,
  ApprovalDiffView,
  ApprovalPolicy,
  ApprovalRequestView,
  AskOptionView,
  AskUserView,
  ChangedFileView,
  CollaborationMode,
  ContextSegmentsView,
  DiffHunkView,
  EffortLevel,
  ModeSurface,
  ModelChoiceView,
  Modality,
  PlanDecision,
  PlanView,
  PolicySurface,
  QueuedMessageView,
  SessionRunState,
  SessionSummary,
  StatusView,
  SubagentCardView,
  ThemeMode,
  ThinkingLevel,
  TierOption,
  TokenUsageView,
  ToolCallView,
  ToolStatus,
  TranscriptEntry,
  TurnEndReason,
  UiDensity,
  UiFontSize,
  UiPrefsView,
} from '@dsc/ui-core'
