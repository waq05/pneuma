/**
 * 命令补全库：只做再导出，不放逻辑。
 *
 * 为什么是库包而不是塞进某个功能包：斜杠命令表、补全候选与唯一前缀展开只有一份实现，
 * 却被 commands、runtime、tui 三个功能包与界面输入框共用。塞进 commands，渲染层与
 * runtime 就得 import 功能包；放进库包，换代根（src/core 让位给包）才看得见它。
 *
 * 注意：这个包转出的模块顶层不许出现任何 Node 内置模块——渲染层 Composer 直接
 * import 它，vite 遇到内置模块会白屏（理由写在 commands-completion.ts 抬头）。
 *
 * 没有 cordis.patch.yml、没有行：库包不参与开关，也不进基础包的行清单。
 * 引用方一律写子路径（`@pneuma/commands-core/commands-completion.js` 这种）。
 *
 * @module dsc/packages/commands-core
 */

export * from './commands-completion.js'
