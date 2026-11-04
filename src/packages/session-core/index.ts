/**
 * 会话核心库：只做再导出，不放逻辑。
 *
 * 为什么是库包而不是塞进某个功能包：钩子、上下文压缩、系统提示词装配、ReAct 循环
 * 与协作模式这五块被十个功能包共用——agent 与 subagent 用 MiniAgent，hooks 与
 * lifecycle-hooks 用钩子引擎，compact 与 microcompact 用压缩，prompt 用提示词装配，
 * mode 与 plan 用协作模式，commands 用压缩的 token 估算。塞进任何一个包，其余包就得
 * 跨包 import 功能包；放进库包，换代根（src/core 让位给包）才看得见它们，
 * 也才不会在核心里留一份不换代的老副本。
 *
 * 没有 cordis.patch.yml、没有行：库包不参与开关，也不进基础包的行清单。
 * 引用方一律写子路径（`@pneuma/session-core/hooks.js` 这种），不要从聚合入口拿。
 *
 * @module dsc/packages/session-core
 */

export * from './hooks.js'
export * from './compact.js'
export * from './prompt.js'
export * from './loop.js'
export * from './modes.js'
