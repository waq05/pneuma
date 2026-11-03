/**
 * 界面事件协议的版本号：宿主与遥控端握手时对这一个数。
 *
 * 放在 contract 里：webserver 与 remote 两个插件都要用，各写一份迟早不同步。
 *
 * @module dsc/contract/remote
 */
export const UI_EVENTS_PROTOCOL_VERSION = 1
