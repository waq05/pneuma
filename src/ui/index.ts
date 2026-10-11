/**
 * 插件版界面的共用核心：宿主（组清单、发 bundle）与界面壳（建注册表、装插件）
 * 共用这一份，浏览器安全——不 import 任何 node 内置模块。
 *
 * @module dsc/ui
 */
export * from './frames.js'
export * from './manifest.js'
export * from './plugin.js'
export * from './slots.js'
/**
 * 槽位注册表的 React 订阅面（useSlot / useSlotFaults）：浏览器壳与终端壳共用。
 * 为什么在共享层：两个壳的「组件」都是 React 组件，订阅语义只有一份；
 * 渲染出口（SlotOutlet）各壳自持——条目外层的包装是载体自己的事。
 */
export * from './slots-react.js'
/**
 * 原生桥的规格（操作名 + 实参形状 + 校验）也从这里转出去。
 *
 * 为什么宿主侧的一份 `core` 模块能进界面壳的入口：`core/native-bridge.ts` 与上面几份
 * 守同一个约束——**零 node 依赖、浏览器安全**。桌面主进程与界面壳因此读的是同一份规格：
 * 加一个原生操作，两侧同时知道；漂移在编译期就暴露（而不是等线上某个插件调到 undefined）。
 */
export * from '../core/native-bridge.js'

/**
 * 宿主那些**界面要读的**视图类型的再导出。
 *
 * 为什么全是 `export type`：编译期就擦掉了，浏览器壳不会因为这一行把 `contract.ts`
 * 拉进包里，也就不引入任何运行期耦合。为什么值得这么做：消息流要按条目种类分别渲染，
 * 靠 `unknown` 手写类型收窄的话，宿主改一个字段名壳这边不会报错——那恰好是最该被
 * 编译器抓住的一类改动。
 */
export type {
  ApprovalAnswer,
  ArchivedPage,
  ArchivedSessionView,
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
  GoalView,
  ModeSurface,
  ModelChoiceView,
  ModelConfigView,
  Modality,
  PlanDecision,
  PlanView,
  PolicySurface,
  PresetDraft,
  PresetFileView,
  PresetSurface,
  PresetView,
  ProviderModelView,
  ProviderView,
  QueuedMessageView,
  RuntimeSnapshot,
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
  ThemeMode,
  ThinkingLevel,
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
} from '../contract.js'
