/**
 * CDP 底层库：只做再导出，不放逻辑。
 *
 * 为什么是库包而不是塞进某个功能包：这套代码被三个功能包共用——browser 用全部七个
 * 模块、dock-browser 用其中五个、host-stdio 只要 transport 的类型。塞进任何一个包，
 * 另外两个就得跨包直接 import 功能包，装配顺序与开关语义都会打架。
 *
 * 没有 cordis.patch.yml、没有行：库包不参与开关，也不进基础包的行清单。
 * 引用方一律写子路径（`@pneuma/cdp/actions.js` 这种），不要从 `@pneuma/cdp` 聚合入口
 * 拿——子路径让依赖面看得见，也让构建产物只带真正用到的模块。
 *
 * @module dsc/packages/cdp
 */

export * from './actions.js'
export * from './cloud-metadata.js'
export * from './launch.js'
export * from './report.js'
export * from './ring-buffer.js'
export * from './snapshot.js'
export * from './transport.js'
