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
import { useMemo, type ComponentType, type ReactNode } from 'react'
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
import { NATIVE_BRIDGE_VERSION, type NativeOp } from '@dsc/ui-core'

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

/**
 * ── 原生桥 ─────────────────────────────────────────────────────────────────────
 *
 * 桌面窗口里，preload 会额外挂一个 `window.dscNative`（一条极窄的原生能力通道：
 * 窗口控件区颜色、原生弹层深浅、系统对话框、通知、退出/重启…，规格见
 * `core/native-bridge.ts`，宿主与壳共用那一份）。浏览器与远程壳里**没有**这个对象——
 * 插件因此必须把"没有原生能力"当常态处理，而不是当异常。
 */

/** 桥缺席时给插件的一句话（浏览器里就是这样：没有 Electron，也就没有原生桥）。 */
export const NATIVE_UNAVAILABLE = '这条能力来自桌面外壳的原生桥，浏览器里没有它'

/** 原生桥的调用面。 */
export interface HostNative {
  /** 桥在不在：桌面窗口里 true，浏览器 / 远程壳里 false。 */
  readonly available: boolean
  /** 桥的协议版本；缺席时 null。壳拿它跟自己的规格对一下，不一致可以在诊断区说明白。 */
  readonly version: number | null
  /**
   * 调一个原生操作。
   *
   * 桥缺席时返回**拒绝的 Promise**（而不是同步抛）：调用点因此可以统一写一个 try/catch，
   * 不必先判 available 再包一层。
   */
  invoke<T = unknown>(op: NativeOp, args?: readonly unknown[]): Promise<T>
}

/** `window.dscNative` 在页面上的形状（preload 暴露的那个对象）。 */
interface NativeBridgeGlobal {
  version?: unknown
  call?: (op: string, args: unknown[]) => Promise<unknown>
}

/** 读一次全局对象；形状不对就当桥不在（宁可降级，也不要调到一个半残的对象）。 */
function bridgeGlobal(): NativeBridgeGlobal | null {
  const value = (globalThis as { dscNative?: unknown }).dscNative
  if (value === null || typeof value !== 'object') return null
  const record = value as NativeBridgeGlobal
  return typeof record.call === 'function' ? record : null
}

/**
 * 取原生桥。插件这样用：
 *
 *     const native = useHostNative()
 *     if (!native.available) return <p>这条能力只在桌面版里有</p>
 *     await native.invoke('openPath', ['D:\\dsc'])
 *
 * 每次调用都重新读一遍全局对象：自检会在同一个页面里把桥拿掉再调一次（验证降级那条路），
 * 缓存下来就把结论钉死了。读一个对象引用是常数开销，不值得为它冒这个险。
 */
export function getHostNative(): HostNative {
  const bridge = bridgeGlobal()
  return {
    available: bridge !== null,
    version: bridge === null ? null : typeof bridge.version === 'number' ? bridge.version : NATIVE_BRIDGE_VERSION,
    invoke<T = unknown>(op: NativeOp, args: readonly unknown[] = []): Promise<T> {
      if (bridge === null) return Promise.reject(new Error(NATIVE_UNAVAILABLE))
      return bridge.call!(op, [...args]) as Promise<T>
    },
  }
}

/**
 * {@link getHostNative} 的 hook 形态（桥在页面生命周期内不会出现/消失，所以取一次就够）。
 * 需要"桥回来了要重画"的场景才用它，否则直接调 `getHostNative()` 更省。
 */
export function useHostNative(): HostNative {
  return useMemo(() => getHostNative(), [])
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
