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
  ModeSurface,
  ModelChoiceView,
  Modality,
  PlanDecision,
  PlanView,
  PolicySurface,
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
  TokenUsageView,
  ToolCallView,
  ToolStatus,
  TranscriptEntry,
  TurnEndReason,
  UiDensity,
  UiFontSize,
  UiPrefsView,
} from '../contract.js'
