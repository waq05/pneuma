/**
 * 配置核心库：只做再导出，不放逻辑。
 *
 * 为什么是库包而不是塞进某个功能包：用户级模式（preset）文件的读写与技能市场条目的
 * 浏览安装，被 presets、runtime-api、skills、plugin-manager 四个功能包共用。
 * 塞进 presets 或 skills 任意一家，另外三家就得跨包 import 功能包；放进库包，
 * 换代根（src/core 让位给包）才看得见它们，也才不会在核心里留老副本。
 *
 * 没有 cordis.patch.yml、没有行：库包不参与开关，也不进基础包的行清单。
 * 引用方一律写子路径（`@pneuma/config-core/presets.js` 这种）。
 *
 * @module dsc/packages/config-core
 */

export * from './presets.js'
export * from './market.js'
