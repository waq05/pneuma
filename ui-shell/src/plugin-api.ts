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
import type { ReactNode } from 'react'
import type {
  FactoryChildrenOf as FactoryChildrenOfMap,
  FactoryInputPropsOf as FactoryInputPropsOfMap,
  FactoryLocalInputPropsOf as FactoryLocalInputPropsOfMap,
  FactoryLocalNameOf as FactoryLocalNameOfMap,
  FactoryStoreOf as FactoryStoreOfMap,
  HostSnapshot,
  PropsStoreOf,
  SlotEntry,
  SlotKind,
  SlotKindOf as SlotKindOfMap,
  SlotMatchedOf as SlotMatchedOfMap,
  SlotOwnerOf as SlotOwnerOfMap,
  SlotRegistry,
  UiHostInfo,
  UiPluginApi as CoreUiPluginApi,
  UiPluginModule,
  UiRuntimeApi,
  UiSlotApi,
} from '@dsc/ui-core'
import {
  subscribeDock,
  type DockReview,
} from '@dsc/ui-dockkit'
import { shellPage, subscribePage } from '@dsc/ui-layout'

// 载体基元与槽名契约：终端壳的对应物在 `src/ui/tui-plugin-api.ts`。
// 槽名两边导出同名常量——插件 import 它写注册目标，字符串字面量不散落。
export { Text } from '@dsc/ui-primitives'
export const TUI_SLOTS = {
  /** 通知盒下方的插件扩展行（list）：插件在这里放一行状态说明。 */
  noticeExtensions: 'tui.notice.extensions',
} as const

/**
 * ── 槽位契约表（D1）────────────────────────────────────────────────────────────
 *
 * 槽名 → `{ kind; owner?; matched? }`。壳与插件都用 `declare module '@dsc/ui'` 往上并键。
 * 为什么表声明在这个模块（而不是 @dsc/ui-core 再转出）：`declare module` 的合并只认
 * **词法相邻**的声明，re-export 不参与——声明必须落在插件 import 的那个模块里。
 * 壳在 `@dsc/ui-slots` 的 `slots.ts` 并进 9 个壳槽（E4 起那个包独立，相对路径退一层），
 * 插件就近并自己开出来的子槽（例：transcript 的 `transcript.toolview`）。
 */
export interface SlotMap {}

/** Factory 契约表（D2）：Factory 名 → `{ props; children?; slots?; store? }`。 */
export interface SlotFactoryMap {}

/** 表里的槽名（联合类型）；写错槽名在调用点就编不过。 */
export type SlotName = keyof SlotMap & string
/** 某个槽的形态。 */
export type SlotKindOf<K extends SlotName> = SlotKindOfMap<SlotMap, K>
/** 某个槽的 owner 份额（父在渲染调用点传的 props）。 */
export type SlotOwnerOf<K extends SlotName> = SlotOwnerOfMap<SlotMap, K>
/** 某个 chain 槽的 matched 类型（选择器返回值，组件 `matched` prop 从它推）。 */
export type SlotMatchedOf<K extends SlotName> = SlotMatchedOfMap<SlotMap, K>

/** Factory 名（表里的键）。 */
export type FactoryName = keyof SlotFactoryMap & string
/** Factory occurrence 的输入 props（父在 renderFactorySlot 调用点传的）。 */
export type FactoryInputProps<F extends FactoryName> = FactoryInputPropsOfMap<SlotFactoryMap, F>
/** 局部位置名。 */
export type FactoryLocalName<F extends FactoryName> = FactoryLocalNameOfMap<SlotFactoryMap, F>
/** 某个局部位置的输入 props。 */
export type FactoryLocalInputProps<F extends FactoryName, N extends FactoryLocalName<F>> =
  FactoryLocalInputPropsOfMap<SlotFactoryMap, F, N>
/** Factory 声明的普通子槽表。 */
export type FactoryChildren<F extends FactoryName> = FactoryChildrenOfMap<SlotFactoryMap, F>
/** Factory 声明的席位句柄（没声明是 undefined）。 */
export type FactoryStore<F extends FactoryName> = FactoryStoreOfMap<SlotFactoryMap, F>

/**
 * 壳交给插件组件的渲染能力（每个条目、每个 Factory occurrence 都有）。
 *
 * 为什么要交给组件而不是从 `ui.slots` 里直接渲染：槽是**位置**，位置归渲染它的人管。
 * 一个工具卡要在自己尾巴上留个洞，得由它说明「这个洞叫什么」，别人再往里放东西；
 * 这样 `renderSlot` 只能渲染本条目自己声明过的名字，拼错当场报装配错误。
 */
export interface SlotRenderApi<ChildKeys extends string = never> {
  /** 渲染本条目声明过的子槽（没声明过的名字调用会抛装配错误）。 */
  renderSlot: <K extends ChildKeys & SlotName>(name: K, props?: SlotOwnerOf<K>) => ReactNode
  /** 本条目声明出来的子槽名（诊断用）。 */
  childSlots: readonly string[]
  /** 渲染一次 Factory occurrence（定义缺席画 fallback）——D2 的复用面。 */
  renderFactorySlot: RenderFactorySlot
}

/**
 * Factory 定义与局部组件共享的注册面（定义声明的 children 渲染 + Factory 渲染 + 席位）。
 * 局部组件与定义组件收到的是**同一份**，所以局部位置也能开自己的子槽、读同一个席位。
 */
export type FactoryRegistrationShare<F extends FactoryName> = SlotRenderApi<keyof FactoryChildren<F> & string> & PropsStoreOf<FactoryStore<F>>

/** 父按 occurrence 选的局部组件（或定义自己给的 fallback）。 */
export type FactoryLocalProps<F extends FactoryName, N extends FactoryLocalName<F>> = FactoryLocalInputProps<F, N> & FactoryRegistrationShare<F>

export type FactoryLocalComponent<F extends FactoryName, N extends FactoryLocalName<F>> = (
  props: FactoryLocalProps<F, N>,
) => ReactNode

/** 定义内部选局部组件的 hook（返回组件；父没选就用 fallback）。 */
export type UseFactorySlot<F extends FactoryName> = <N extends FactoryLocalName<F>>(
  name: N,
  fallback: FactoryLocalComponent<F, N>,
) => (props: FactoryLocalInputProps<F, N>) => ReactNode

/** Factory 定义组件收到的完整 props：occurrence 输入 + 注册面 + useFactorySlot。 */
export type FactoryComponentProps<F extends FactoryName> = FactoryInputProps<F>
  & FactoryRegistrationShare<F>
  & { useFactorySlot: UseFactorySlot<F> }

/**
 * 渲染一次 Factory occurrence：父传 occurrence 输入，`options.slots` 按本次 occurrence
 * 选局部组件（没选的位置由定义自己的 fallback 顶上）；定义缺席画 `options.fallback`。
 */
export type RenderFactorySlot = <F extends FactoryName>(
  name: F,
  props?: FactoryInputProps<F>,
  options?: {
    slots?: Partial<{ [N in FactoryLocalName<F>]: FactoryLocalComponent<F, N> }>
    fallback?: ReactNode
  },
) => ReactNode

/**
 * 槽条目组件收到的 props：owner 份额 + （chain 的）matched 份额 + 渲染能力 + 席位份额。
 *
 * 写组件时按这个别名声明 props，`register` 的约束就按它校验（拼错槽名、拿错 owner、
 * 漏声明子槽都会在调用点报错）。三个可选参数的缺省就是「无 owner / 无子槽 / 非 chain」。
 */
export type SlotComponentProps<
  Owner = Record<never, never>,
  ChildKeys extends string = never,
  Matched = never,
  Store = undefined,
> = Owner
  & ([Matched] extends [never] ? object : { matched: Matched })
  & SlotRenderApi<ChildKeys>
  & PropsStoreOf<Store>

/**
 * 浏览器壳里「组件」就是 React 组件。
 *
 * 写成 `(props: never) => ReactNode` 是刻意的（D1）：注册位的约束靠参数逆变做起——
 * 任何声明了具体 props 的组件都天然满足「props=never」这个宽形状，而真正的 props
 * 检查发生在 `register` 调用点（约束要求组件装得下组装出来的 props）。写 `any` 会把
 * 那层检查整个挡掉（这正是收窄前的问题）。
 */
export type UiComponent = (props: never) => ReactNode

/** 壳内部的槽位注册表：渲染与诊断都要用到壳的那几个能力（订阅、退位、故障表）。 */
export type UiSlots = SlotRegistry<UiComponent, SlotMap, SlotFactoryMap>

/** 插件 `apply(ui)` 拿到的那一份（核心定义 + 组件类型特化，不再手抄一遍）。 */
export type UiPluginApi = CoreUiPluginApi<UiComponent, SlotMap, SlotFactoryMap>

/** 插件 bundle 要导出的形状。 */
export type UiPlugin = UiPluginModule<UiComponent, SlotMap, SlotFactoryMap>

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
 * ── 原生桥与读色 ───────────────────────────────────────────────────────────────
 *
 * `getHostNative` / `useHostNative` / `HostNative` / `readCssColor` / `readCssValue` /
 * `toHexColor` 的实现住 `@dsc/ui-primitives`（`native.ts` / `css.ts`），由文件尾
 * 那句整包转出交给插件。为什么挪下去：壳自己（`ui-layout` 的 appearance / app）也要用
 * 它们，实现留在这一层就得让 `ui-layout` 反过来引 `@dsc/ui`——包间成环（E4 收尾剪掉的）。
 * 两条路（插件与壳）取到的仍是**同一份实现**（同一个模块实例）。
 */

/**
 * ── 外观改动的请求口（插件写、壳落地）────────────────────────────────────────────
 *
 * 为什么不让插件直接调 `applyAppearance`：那份实现的模块级状态（最近一次报出去的控件条
 * 颜色、跟随系统的监听）**只能有一份**——插件 bundle 里内联一份就会出现两个 applier
 * 各记各的状态。所以插件只说"改成这样"，落地由壳里那一份做。
 *
 * 用法与写入顺序（照旧界面的口径）：先 `requestAppearance(patch)` 让界面立刻跟手，
 * 再 `setUiPrefs(patch)` 落盘；写失败就再 `requestAppearance(原值)` 回滚。
 */
export type AppearancePatch = {
  themeMode?: 'dark' | 'light' | 'system'
  fontSize?: number
  density?: 'compact' | 'standard' | 'roomy'
}

const appearanceListeners = new Set<(patch: AppearancePatch) => void>()

/** 请求壳把外观改成这样（没有监听者时是空操作——插件单独跑时不该崩）。 */
export function requestAppearance(patch: AppearancePatch): void {
  for (const listener of appearanceListeners) listener(patch)
}

/** 壳注册外观落地函数；返回退订。 */
export function onAppearanceRequest(listener: (patch: AppearancePatch) => void): () => void {
  appearanceListeners.add(listener)
  return () => {
    appearanceListeners.delete(listener)
  }
}

/**
 * ── 右侧栏（dock：多页签面板）─────────────────────────────────────────────────
 *
 * 插件这样用：`registerDockTab` 报名自己那种页签（kind → 图标 / 标题 / 渲染组件，
 * 见 `DockTabKindMeta`），壳的页签条与页签体照它画；开合、分栏、全屏、拖拽都归壳。
 * 布局按会话走（`useDockSurface`）；打开动作走 `dockActions` / `openDockTab`。
 */
export {
  setDockPreview,
  setDockReview,
  /** 把某个子智能体的运行记录开到右侧栏（队友行、状态面板点一行都走它）。 */
  setDockSubagent,
  /** 把某个后台活（作业 / 终端会话）的只读输出面开到右侧栏（状态面板「终端」区点一行走它）。 */
  setDockWorkOutput,
  registerDockTab,
  dockActions,
  openDockTab,
  useActivePreviewPath,
  useDockPatchSource,
  useDockReview,
  useDockSurface,
} from '@dsc/ui-dockkit'
export { subscribeDock, dockSurface } from '@dsc/ui-dockkit'
export type { DockReview, DockTabBodyProps, DockTabKindMeta } from '@dsc/ui-dockkit'

/**
 * ── 主区整页（插件中心这类「顶上来的整页」）────────────────────────────────────
 *
 * 页条目注册在 `shell.page` 槽里，自己读 `useShellPage()` 比对自己的 id：
 * 不是自己就返回 null。侧栏入口（或页自己的返回钮）写 `setShellPage`。
 *
 * 三个读 hook（页 / 正文脸 / 聚焦步骤）都**实现**在 `@dsc/ui-layout`（那份状态的
 * 同一个模块里），这里只转出——壳自己也要读它们，实现放这一层就会让 `ui-layout`
 * 反过来引 `@dsc/ui`（包间成环，E4 收尾时沉下去的）。
 */
export { setShellPage, useShellPage } from '@dsc/ui-layout'

/** 槽名常量表也从这里转出去：插件写 `SLOT.header` 比手打字符串不容易错。 */
export { SLOT, type ShellSlot } from '@dsc/ui-slots'
export { subscribePage, shellPage } from '@dsc/ui-layout'

/**
 * ── 正文区的两张脸（对话 / 轨迹）──────────────────────────────────────────────
 *
 * 顶栏页签、会话右键的「查看轨迹」、工具行的「在轨迹中查看」药丸都往这里写；
 * 轨迹插件读 `useThreadView()` 决定画不画、读 `useTraceFocus()` 拿一次性聚焦目标。
 */
import { clearTraceFocus, openTrace, setThreadView, shellThreadView, subscribeThreadView, traceFocusStep } from '@dsc/ui-layout'
export { clearTraceFocus, openTrace, setThreadView, subscribeThreadView, traceFocusStep, shellThreadView }
export { useThreadView, useTraceFocus } from '@dsc/ui-layout'
export type { ThreadView } from '@dsc/ui-layout'


export { useChannelStatus, useHostChannel, useHostError, useHostSelector, useHostSnapshot } from '@dsc/ui-layout'
// 等人的宿主方法（写类 dock op = 过审批卡）要用的长超时：30 秒的默认档会把「等你点卡」
// 报成「宿主超时」。插件里凡是会弹审批卡的调用都该带上它。
export { HUMAN_WAIT_TIMEOUT_MS, type InvokeOptions } from '@dsc/ui-layout'
/**
 * 服务表的 React 订阅面（A1）：插件用它读别的插件提供的服务，并跟着服务的出现/消失
 * 换数据源（D3 的 status 面板靠它从本地轮询切到 team 的共享席位，无需刷新页面）。
 */
export { useService } from '@dsc/ui-core'
/**
 * 席位的读 hook（D3）：拿到实例后按 selector 读（实例缺席给 undefined，调用方自行回落）。
 * 席位契约类型同址转出——插件写 handle 类型、action 表都从这里拿。
 */
export { useSeat } from '@dsc/ui-core'
export { defineStore } from '@dsc/ui-core'
export type { ActionsDecl, BakedActions, PropsStoreOf, SeatInstance, SnapshotSelectorHook, StoreHandle } from '@dsc/ui-core'
export type { ChannelStatus, HostHello } from '@dsc/ui-layout'
export type { SlotEntry, SlotKind, UiHostInfo, UiRuntimeApi, UiSlotApi, HostSnapshot }
// 基元库整包转出（E2 拆包后原来是经 `./icons` 转发壳整包转出的，导出面与那时**逐名相同**）：
// 插件 bundle 里 `import { IconPin } from '@dsc/ui'` 即可，不必各自内联一份 SVG。
// E6 起插件也可以直接按包名 `@dsc/ui-primitives` 取（平台种子，同一份实例）。
export * from '@dsc/ui-primitives'
// 彩色文件图标（vscode-icons 常用子集 + FileIcon 组件）与正文 token 粗估：
// 前者轮尾「文件已更改」卡 / 悬停预览 / 审查面板 / 文件树共用一份，
// 后者与宿主自动压缩同源（见 src/ui/index.ts 的说明）——都在壳里只有一份实现。
export { FileIcon, fileIconName } from '@dsc/ui-primitives'
export { estimateTextTokens } from '@dsc/ui-core'
// 文本差异算法也转出去（工具卡的「将做的改动」要用；与宿主算轮尾差异同一份实现）。
export { diffLines, type DiffResult } from '@dsc/ui-core'
/**
 * 模型能力枚举与中文标签（设置 → 模型页的思考档位 / 档位字段 / 输入模态三组勾选读它）：
 * 与宿主发请求时用的 `core/model-caps.ts` 是**同一份文件**（见 src/ui/index.ts 的说明），
 * 界面上勾的四档与线上真发的字段不会各说各话。
 */
export {
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  THINKING_PARAMS,
  THINKING_PARAM_LABELS,
  MODALITIES,
  MODALITY_LABELS,
  EFFORT_WIRE_HINT,
  DEFAULT_CAPS,
} from '@dsc/ui-core'
// 壳内置平台层转出（web 值面独有；终端壳的 @dsc/ui 不导出 DOM 组件）：
// shiki / react-markdown / pdfjs 这些重依赖只在壳 vendor 里有一份（平台模块表里
// 没有它们，插件 bundle 不许自带），插件经这里用壳的实现，实现只有一份。
export { highlightLines, langForPath, type HighlightedLine } from '@dsc/ui-primitives'
export { DiffRows } from '@dsc/ui-primitives'
export { CodeView } from '@dsc/ui-primitives'
export { MarkdownView, type FsRead } from '@dsc/ui-primitives'
export { PdfView } from '@dsc/ui-primitives'
export { CsvView, XlsxView } from '@dsc/ui-primitives'
// 一次性反馈与确认框（桌面端 components/toast.ts / confirm.ts 的同构移植）：
// 插件的失败不能再「静默什么都没发生」，破坏性动作动手前先过确认框。
export { toastOk, toastErr } from '@dsc/ui-primitives'
export { confirmAction, type ConfirmSpec } from '@dsc/ui-primitives'
// 宿主视图类型原样转出去：插件按它们写渲染，宿主改字段时插件这边编不过（而不是线上画空）。
export type {
  ApprovalAnswer,
  ArchivedPage,
  ArchivedSessionView,
  ApprovalDiffView,
  ApprovalPolicy,
  ApprovalReviewer,
  PermissionPresetSurface,
  PermissionPresetView,
  ApprovalRequestView,
  AskOptionView,
  AskUserView,
  BackgroundOutputView,
  BackgroundWorkView,
  ChangedFileView,
  CollaborationMode,
  ContextSegmentsView,
  DiffHunkView,
  DiffLineView,
  EffortLevel,
  EffortMap,
  GitSurface,
  GoalView,
  ModeSurface,
  ModelChoiceView,
  ModelConfigView,
  Modality,
  PlanDecision,
  PlanEntryView,
  PlanView,
  PolicySurface,
  PresetDraft,
  PresetFileView,
  PresetSurface,
  PresetView,
  ProviderDraft,
  ProviderModelView,
  ProviderView,
  QueuedMessageView,
  ScheduledTaskView,
  SessionRunState,
  SessionSummary,
  SettingsField,
  SettingsGroupView,
  SettingsMutation,
  SettingsSectionView,
  SettingsValue,
  SettingsValues,
  StatusView,
  SubagentCardView,
  TeammateView,
  ThemeMode,
  ThinkingLevel,
  ThinkingParam,
  TierOption,
  TodoItemView,
  TodoStatus,
  TodoView,
  TokenUsageView,
  ToolCallView,
  ToolEntryView,
  ToolStatus,
  TranscriptEntry,
  TurnEndReason,
  UiDensity,
  UiFontSize,
  UiPrefsView,
  UsageDayView,
  UsageModelView,
  UsageStatsView,
} from '@dsc/ui-core'
