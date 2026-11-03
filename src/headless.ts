/**
 * headless 启动器：内核 + host-stdio 协议桥（无 UI、无终端依赖）。
 * 桌面端 Electron 壳以 ELECTRON_RUN_AS_NODE spawn 本入口（编译产物
 * lib/headless.js），经 stdio JSONL 协议通信；stdin 关闭即退出。
 *
 * @module dsc/headless
 */
import { readConfig } from './core/config.js'
import { migrateFromDsh } from './core/migrate.js'
import { createKernel, emitStartupNotes, loadExternalPlugins, readUiConfig } from './host/kernel.js'

async function main(): Promise<void> {
  // 首次运行：把 dsh 的模型配置迁移到 dsc 自己的文件（幂等，只读 dsh）
  const migration = migrateFromDsh()
  const config = readConfig()
  const ui = readUiConfig()

  const resumeEnv = process.env.DSC_RESUME_SESSION
  const resumeSessionPath =
    resumeEnv === undefined || resumeEnv === '' ? null : resumeEnv === '1' ? 'auto' : resumeEnv

  // 界面形态交给内核：host-stdio 这一行挂不挂由 surface 决定，入口不再自己 import 插件。
  const root = await createKernel({ config, resumeSessionPath, surface: 'headless' })
  await loadExternalPlugins(root, ui.plugins)
  emitStartupNotes(root, migration, config)
}

main().catch((error) => {
  console.error('[numa] headless 启动失败：', error)
  process.exit(1)
})
