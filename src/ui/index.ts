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
 * 宿主那些**界面要读的**视图类型的再导出。
 *
 * 为什么全是 `export type`：编译期就擦掉了，浏览器壳不会因为这一行把 `contract.ts`
 * 拉进包里，也就不引入任何运行期耦合。为什么值得这么做：消息流要按条目种类分别渲染，
 * 靠 `unknown` 手写类型收窄的话，宿主改一个字段名壳这边不会报错——那恰好是最该被
 * 编译器抓住的一类改动。
 */
export type {
  ChangedFileView,
  ContextSegmentsView,
  PlanView,
  QueuedMessageView,
  RuntimeSnapshot,
  SessionRunState,
  SessionSummary,
  StatusView,
  SubagentCardView,
  TokenUsageView,
  ToolCallView,
  ToolStatus,
  TranscriptEntry,
  TurnEndReason,
} from '../contract.js'
