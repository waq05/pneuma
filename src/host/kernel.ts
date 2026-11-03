/**
 * 内核装配：只做四件事——建 Context、挂应用自带的行、挂外部插件、启动收尾。
 *
 * 为什么这个文件里没有任何插件的 import：所有功能（含 llm/session/tools 这些核心服务）
 * 都是 `src/packages/<id>/` 里的包，行清单由 `scripts/build-packages.mjs` 合成到
 * `@pneuma/base`。装配顺序不再写在这里：行序由各包的 `pneuma.order` 决定，
 * 依赖关系由行/插件的 `inject` 表达。
 *
 * 三个入口只决定「界面形态」（surface），不决定挂哪些插件：
 * boot = tui，headless = headless，测试不传 = 全挂。
 *
 * @module dsc/host/kernel
 */
import { dirname, isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { DscCoreConfig } from '../core/config.js'
import { activeConfigFile } from '../core/config-store.js'
import { migrateTeamSplit } from '../core/plugin-registry.js'
import { ensureDefaultProfile } from '../core/profile-bootstrap.js'
import {
  initPluginRuntime,
  mountAllExternalPlugins,
  mountApplicationRows,
  type ApplicationSurface,
  type PluginMountFailure,
} from '../core/plugin-loader.js'

export interface KernelOptions {
  config: DscCoreConfig
  /** 'auto' = last-session 指针；路径 = 指定 jsonl；null = 新建。 */
  resumeSessionPath?: string | null
  /** 界面形态：决定 `tui` / `host-stdio` 这两行挂不挂（见 loader 的 SURFACE_ROW_SKIPS）。 */
  surface?: ApplicationSurface
}

/**
 * 由宿主直接组装的配置：这三个插件拿的是宿主对象，不是 plugins.json。
 *
 * llm 与 settings 收整个 `DscCoreConfig`（providers / 凭据都在里面）；
 * session 收恢复路径与启动目录；desktop-dock 收工作目录。
 * 写成一张表传下去，是为了让「行」这条路径对所有插件一视同仁。
 */
function hostConfigOf(options: KernelOptions): Record<string, unknown> {
  return {
    llm: options.config,
    settings: options.config,
    session: { resumeSessionPath: options.resumeSessionPath ?? null, cwd: process.cwd() },
    'desktop-dock': { cwd: process.cwd() },
  }
}

/** 把挂载失败写成一条人能看懂的话；transcript 还没起来时退到 stderr。 */
function reportFailures(root: Context, failures: readonly PluginMountFailure[]): void {
  if (failures.length === 0) return
  const transcript = root.get('transcript') as { system?: (text: string, level?: string) => void } | undefined
  for (const failure of failures) {
    const line = `插件 ${failure.name}（${failure.file}）未能加载：${failure.problem}`
    if (typeof transcript?.system === 'function') transcript.system(line, 'error')
    else console.error('[numa] ' + line)
  }
}

/** 创建内核：应用自带的全部行挂好，外部插件由调用方再追加。 */
export async function createKernel(options: KernelOptions): Promise<Context> {
  const root = new Context()
  initPluginRuntime(root)
  // 首启铺默认 profile：用户装的包与覆盖版官方包都住这里，解析顺序才有落点。
  // 已有清单时一个字节都不动。
  ensureDefaultProfile()
  // 老版本把「团队」拆成两个开关，这里把旧的启用状态迁到新键上（幂等）。
  migrateTeamSplit()
  const failures = await mountApplicationRows(root, {
    ...(options.surface === undefined ? {} : { surface: options.surface }),
    hostConfig: hostConfigOf(options),
  })
  reportFailures(root, failures)
  return root
}

/**
 * 外部插件发现与挂载：`~/.dsc/plugins/*.js` 自动发现（按文件名排序）
 * + config.yaml `plugins` 段显式声明（相对路径基于**这份 config.yaml 所在的目录**
 * 解析——它就在 DSC_HOME 下。早先按进程 cwd 解析，多工作区并用之后那个目录只是
 * 「上一次切过的工作区」，拿它当基准等于随机）。
 * 走 core/plugin-loader 的热挂载：启停即时生效；条目树
 * （~/.dsc/plugins.json）驱动 disabled/config；apiVersion 不兼容自动停用回滚。
 * 单个插件失败不影响其余插件，失败原因写 system 条目。
 */
export async function loadExternalPlugins(root: Context, configured: string[]): Promise<void> {
  // 外部插件清单里的相对路径按**活动配置文件**所在目录解析（换过配置文件就跟着它走）
  const configDir = dirname(activeConfigFile())
  const extraPaths = configured.map((entry) => (isAbsolute(entry) ? entry : resolve(configDir, entry)))
  const failures = await mountAllExternalPlugins(root, extraPaths)
  for (const failure of failures) {
    root.transcript.system(
      `外部插件 ${failure.name}（${failure.file}）未能加载：${failure.problem}，已自动停用`,
      'error',
    )
  }
}

// 启动收尾（读 plugins 段、写启动提示）住在 host/startup.ts；这里转出保持入口的 import 不变。
export { readUiConfig, emitStartupNotes, type UiConfig } from './startup.js'
