/**
 * 插件版界面的共用核心：宿主（组清单、发 bundle）与界面壳（建注册表、装插件）
 * 共用这一份，浏览器安全——不 import 任何 node 内置模块。
 *
 * @module dsc/ui
 */
export * from './frames.js'
export * from './manifest.js'
export * from './arrival.js'
export * from './plugin.js'
export * from './slots.js'
export * from './store.js'
export * from './scoped-slots.js'
export * from './services.js'
/**
 * 服务表的 React 订阅面（`ServicesProvider` / `useService`）：壳把装载出来的服务表
 * 经 context 交给条目组件，插件跟着服务的出现/消失换数据源。
 */
export * from './services-react.js'
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
 * 正文 token 粗估（`core/token-estimate.ts`）也进共享面：消息流的「~N tok」回落读数
 * 与宿主自动压缩的阈值必须同源。它与 native-bridge 守同一条约束——纯函数、零 node 依赖、
 * 浏览器安全，所以界面壳可以直接拿这一份，不必在壳里再抄一个口径。
 */
export * from '../core/token-estimate.js'
/**
 * 模型能力枚举（`core/model-caps.ts`）：设置 → 模型页的思考档位 / 档位字段 / 输入模态
 * 三组勾选与这里一字不差——档位清单、中文标签、线上值提示只有一份，宿主发请求的口径
 * 与界面上勾的东西才不会各说各话。同一条约束（type-only import，浏览器安全）。
 */
export * from '../core/model-caps.js'

/**
 * 文本差异算法（`core/diff-text.ts`）同理进共享面：工具卡的「将做的改动」在界面侧
 * 从参数 + 盘上现值推演 diff，用的就是宿主算轮尾差异的同一份算法。
 */
export * from '../core/diff-text.js'

/**
 * 错误文案（`core/err-text.ts`）也进共享面：界面侧到处要写「失败：<一句话>」，
 * 这份实现全仓只能有一份，壳与第三方插件经 `@dsc/ui-primitives` 拿。
 */
export * from '../core/err-text.js'

/**
 * 吞吐读数（`core/throughput.ts`）：速度与首字延迟的口径，界面侧照它算，
 * 免得状态栏各写一份。`@dsc/ui-primitives` 再转出一手给插件。
 */
export * from '../core/throughput.js'

/**
 * git 读数的相等判断（`core/git-surface.ts`）：宿主判断「要不要推这一帧」与输入区判断
 * 「要不要重画」必须是同一条口径——一边认为变了、另一边认为没变，界面就停在旧分支名上。
 * `@dsc/ui-primitives` 再转出一手给插件。
 */
export * from '../core/git-surface.js'

/**
 * 模块级信号（`signal.ts`）：`Set<() => void>` + `subscribe` + 通知这套写法原先在壳里
 * 手抄七遍，抄漏「复制订阅者再遍历」「没变就不通知」这类语义不会报错，只会表现成
 * 「界面停在旧值上」。多字段状态写成**一个对象**、一次 `set` 发出，避免半套新值先渲染。
 * `@dsc/ui-primitives` 再转出一手给插件。
 */
export * from './signal.js'

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
  ConnectionTestOutcome,
  ConnectionTestView,
  ContextSegmentsView,
  DiffHunkView,
  DiffLineView,
  EffortLevel,
  EffortMap,
  GitSurface,
  GoalView,
  LinkShareData,
  ModeSurface,
  ModelChoiceView,
  ModelConfigView,
  Modality,
  NoticeMessageView,
  PairShareData,
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
  RuntimeSnapshot,
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
  UiCommandView,
  UiPrefsView,
  UsageDayView,
  UsageModelView,
  UsageStatsView,
  UserFileAttachment,
} from '../contract.js'
