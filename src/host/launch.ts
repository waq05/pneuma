/**
 * 启动流程：两个入口（boot = 终端 TUI、headless = 桌面壳的 stdio 桥）共用的那一份。
 *
 * 为什么不塞进 host/startup.ts：那个文件的契约是「启动收尾」——读 config.yaml 的
 * plugins 段、把启动提示写进转录。整条流程搬进去之后，名字（收尾）与内容（从迁移到
 * 建内核）就对不上了，下一个改启动顺序的人还是得先猜哪几行算收尾。
 *
 * 依赖方向是单向的：launch → kernel（createKernel / loadExternalPlugins）+
 * startup（readUiConfig / emitStartupNotes），入口只反过来 import 本文件。
 *
 * 流程不许各写一份：`DSC_RESUME_SESSION` 的三种取值（未设或空串 → null，`'1'` →
 * `'auto'`，其它 → 原值）是 bin/dsc.js 与桌面壳共同的约定，抄第二份就等于允许它
 * 悄悄分叉。
 *
 * @module dsc/host/launch
 */
import { readConfig } from '../core/config.js'
import { migrateFromDsh } from '../core/migrate.js'
import type { ApplicationSurface } from '../core/plugin-loader.js'
import { createKernel, loadExternalPlugins } from './kernel.js'
import { emitStartupNotes, readUiConfig } from './startup.js'

/**
 * 入口能传的界面形态：`ApplicationSurface` 去掉 `'none'`。
 *
 * 用 `Extract` 从 `ApplicationSurface` 派生，而不是另抄一份 `'tui' | 'headless'`：
 * `'none'` 的意思是「自检宿主，界面行都不挂」，它不是入口；将来 surface 改名或删值，
 * 这里会编译报错，而不是留一份没人对得上的复制品。
 */
export type LaunchSurface = Extract<ApplicationSurface, 'tui' | 'headless'>

/**
 * 跑完整条启动流程：迁移 → 读配置 → 算恢复路径 → 建内核 → 装外部插件 → 写启动提示。
 *
 * 失败由本函数自己报并退出，两个入口因此只有报错前缀不同、退出码一定都是 1
 * （入口再各写一份 try/catch 就等于把「失败怎么收场」也复制了两遍）。
 *
 * @param surface 界面形态，决定 `SURFACE_ROW_SKIPS` 里哪些行不挂。
 * @param failureLabel 报错前缀，两个入口靠它区分：
 *   `[numa] 启动失败：`（终端）/ `[numa] headless 启动失败：`（桌面壳）。
 */
export async function launch(surface: LaunchSurface, failureLabel: string): Promise<void> {
  try {
    // 首次运行：把 dsh 的模型配置迁移到 dsc 自己的文件（幂等，只读 dsh）
    const migration = migrateFromDsh()
    const config = readConfig()
    const ui = readUiConfig()

    const resumeEnv = process.env.DSC_RESUME_SESSION
    const resumeSessionPath =
      resumeEnv === undefined || resumeEnv === '' ? null : resumeEnv === '1' ? 'auto' : resumeEnv

    // 界面形态交给内核：哪一行挂不挂由 surface 决定，入口不再自己 import 插件。
    const root = await createKernel({ config, resumeSessionPath, surface })
    await loadExternalPlugins(root, ui.plugins)
    emitStartupNotes(root, migration, config)
  } catch (error) {
    console.error(failureLabel, error)
    process.exit(1)
  }
}
