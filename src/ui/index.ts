/**
 * 插件版界面的共用核心：宿主（组清单、发 bundle）与界面壳（建注册表、装插件）
 * 共用这一份，浏览器安全——不 import 任何 node 内置模块。
 *
 * @module dsc/ui
 */
export * from './manifest.js'
export * from './plugin.js'
export * from './slots.js'
