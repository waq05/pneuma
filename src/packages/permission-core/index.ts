/**
 * 权限核心库：只做再导出，不放逻辑。
 *
 * 为什么是库包而不是塞进某个功能包：会话级权限三项（沙箱档位 / 权限模式 / 审阅者）
 * 的读写与预设推导，被 approval、sandbox、settings、permission-presets 四个功能包
 * 共用。任何一家单独持有，另外三家就得 import 功能包，装配顺序与开关语义都会打架；
 * 放进库包，换代根（src/core 让位给包）才看得见它们，也才不会在核心里留老副本。
 *
 * 没有 cordis.patch.yml、没有行：库包不参与开关，也不进基础包的行清单。
 * 引用方一律写子路径（`@pneuma/permission-core/permission-scope.js` 这种）。
 *
 * @module dsc/packages/permission-core
 */

export * from './permission-scope.js'
export * from './permission-presets.js'
