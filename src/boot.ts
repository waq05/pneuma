/**
 * dsc harness 的终端入口：cordis 内核装配 + ink TUI 插件。
 * 由 bin/dsc.js spawn（bin 键 numa）；编译产物 lib/boot.js。
 *
 * 万物皆插件：本文件只负责声明界面形态——base 服务集见 host/kernel.ts，
 * UI 由 spawn 哪个入口决定（本文件 = TUI；headless.ts = stdio 协议桥）。
 * 启动流程（迁移 → 读配置 → 建内核 → 装外部插件 → 写启动提示）只有一份，
 * 住在 host/launch.ts，外部插件经 ~/.dsc/plugins/*.js 与 config.yaml plugins 段加载。
 *
 * @module dsc/boot
 */
import { launch } from './host/launch.js'

void launch('tui', '[numa] 启动失败：')
