/**
 * headless 启动器：内核 + host-stdio 协议桥（无 UI、无终端依赖）。
 * 桌面端 Electron 壳以 ELECTRON_RUN_AS_NODE spawn 本入口（编译产物
 * lib/headless.js），经 stdio JSONL 协议通信；stdin 关闭即退出。
 *
 * 启动流程与 TUI 入口共用一份（host/launch.ts），本文件只声明界面形态。
 *
 * @module dsc/headless
 */
import { launch } from './host/launch.js'

void launch('headless', '[numa] headless 启动失败：')
