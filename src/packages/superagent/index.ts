/**
 * superagent 插件入口（W9-1：把包入口切到新树；W9-2：把 DSC 专有宿主面接回来）。
 *
 * 结构照上游 `dsh-superagent/src/index.ts`（26 行）：`name` / `inject` / `apply` 三样，
 * 装配顺序是「读配置 → 建运行期 → 起来源 → 注册面板服务 → 等就绪 → 接宿主面 → 记一行日志」。
 * 旧入口原样备份在同目录的 `index.legacy.ts`（不被任何人 import，旧测试仍可临时指过去），
 * 旧树其余文件本批不动；删旧树留给后续批。
 *
 * ## 与上游 26 行的对应
 *
 * | 上游行 | 本文件 | 差异 |
 * | --- | --- | --- |
 * | `import './deployment.ts'` 的 `Config` / `machineOf` | `machineOfPlugin`（本文件） | 上游配置来自 DSH 的 `cordis.yml`（`stateDir` 必填、POSIX 绝对路径）；DSC 的插件配置在 `plugins.json`，且没有 `stateDir` 这一项——这里按 `paths.ts` 的 `superagentRoot()`（`<DSC_HOME>/superagent`）取同一条落盘坐标，另外三个可调项允许 `plugins.json` 覆盖，越界夹回区间。不导出 `Config`：DSC 的 loader 会拿它校验 `plugins.json`，而那里还是旧键，校验会把插件挡在启动前。 |
 * | `ctx.inject(['settings'], child => settings.configure({auto:false}))` | 无 | 那是 DSH 设置页的开关；DSC 的设置面由 `ui-superagent` 的页面与 `Settings` 块自己画，没有这条自动页。 |
 * | `ctx.fiber.restart()` 做重启回调 | 同句照搬 | DSH 的设置服务在重启后要 `describe()` 一次让表单继续可编辑；DSC 的设置页每次现读，没有这个补丁点。 |
 * | `new Runtime(ctx, machine, restart)` | 同句照搬 | 上游运行期自己起来源（独立 cordis 插件）；本仓来源导出的是 `startGithub` / `startFeishu`（W4 接线口径），在下面两行 `ctx.effect` 里起。 |
 * | `ctx.effect(() => async () => await runtime.stop())` | 同句照搬 | 无。 |
 * | `await runtime.ready` + 一行日志 | 同句照搬 | 日志文案按本仓名（`superagent`）。 |
 * | `export type { Deployment, DeploymentConfig }`、`export * from './core/index.ts'` | 不导出 | 本仓没有任何地方从包入口取这些类型（都直接 import 子路径）；包入口只留插件身份，免得把整棵核心的类型面拖成公开 API。 |
 *
 * ## 工具注册为什么不在这个文件
 *
 * 上游主会话 / 执行者会话的工具由 `app/sessions.ts` 按会话挑（`SessionsHost.tools` 直接收
 * `ToolEntry[]`），本仓新树的 `Runtime` 在构造时就把 `mainTools` / `executorTools` 塞给
 * `Sessions`（`app/runtime.ts:176-179` 的 `tools` 回调、`:217-220` 的 `toolHost`），
 * 工具宿主是运行期的私有成员，入口拿不到也不该拿。旧入口往 `ctx.tools` 注册主会话十二个 /
 * worker 五个工具，是「旧运行期没有会话工具目录」的补丁；新树由运行期自己给，这里不重复注册。
 *
 * ## DSC 专有宿主接线（W9-2：上游没有这些，放在 `host/`）
 *
 * 三块都不属于运行期，而是「宿主半」的接线，所以在这里登记、都在 `runtime.ready` 之后：
 *
 * - `host/settings-section.ts`：设置分区 `superagent`。字段与值现读新树的设置块（执行 / 判定）、
 *   来源 kind（配置字段 / 策略名单）与部署检查结果；保存走 `runtime.settings.save(...)`，
 *   不另开写路径。
 * - `host/command.ts`：`/sa` 命令，读写都走 `PanelApi`（`app/api.ts`），与 `ui-superagent` 同一条路。
 * - `host/health.ts`：doctor 四项体检，读数来自 `runtime.health` / `runtime.store` / `runtime.sources`。
 *
 * 2 秒泵与来源启停不在这里重复：新树 `Passes` 自己每 2 秒一拍（`app/passes.ts:38`），
 * 来源由下面两行 `ctx.effect` 起；宿主面的登记同样包在 `ctx.effect` 里，停用插件即摘掉。
 *
 * @module dsc/packages/superagent
 */
/** Main plugin entry: mounts the new-tree Runtime, starts the Sources, and provides the panel service. */
import type { Context } from '@deepseek-ai/cordis'
import { clampInt } from '@pneuma/runtime/core/clamp.js'
import { resolvePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import { createApi } from './app/api.js'
import { Runtime } from './app/runtime.js'
import { LIMITS } from './core/limits.js'
import type { Machine } from './deployment.js'
import { registerSaCommand } from './host/command.js'
import { createDependenciesHealth, createFeishuHealth, createSuperagentHealth, createTeammatesHealth } from './host/health.js'
import { createSettingsSection } from './host/settings-section.js'
import { superagentRoot } from './paths.js'
import { startFeishu } from './sources/feishu.js'
import { startGithub } from './sources/github.js'

/** 行身份：与 `cordis.patch.yml` 的 `id`、产物目录名三处一致。 */
export const name = 'superagent'

/**
 * 依赖的宿主服务。
 *
 * `llm`：`app/role-models.ts:52` 直接调 `ctx.llm.routeTo`（设置里选角色模型时校验可用性）；
 * `surfaces`：下面把 `superagent` 快照面登记进宿主快照；
 * `settings` / `commands`：W9-2 的宿主接线要用——设置分区没登记就没有面板，命令没注册
 * `/sa` 就不可见，两者都是「没有就少一块能力」，与旧入口的 inject 同一条取舍。
 * 其余能力（tools / guards / skills / jobs / team / agent / prompt / compact / health）新树都用
 * `ctx.get(...)` 现取、缺了降级，不写进 inject——不把可选能力变成硬依赖（旧入口同一条取舍，
 * `index.legacy.ts:70-80`）。doctor 停用时 `ctx.get('health')` 给 undefined，只是少四项体检。
 */
export const inject = ['llm', 'surfaces', 'settings', 'commands']

/** `~/.dsc/plugins.json` 里本插件那一项的 `file` 名（与设置分区、patch 行 id 同一个字符串）。 */
const CONFIG_KEY = 'superagent'

/** 快照失效桥的采样间隔：与旧入口的泵同一条节奏（旧 `index.ts:177` 的 `PUMP_INTERVAL_MS`）。 */
const SURFACE_PULSE_MS = 2000

/** 与上游 `deployment.ts` 的 `Config` 缺省值逐字一致（DSH 那边来自 schemastery 的 `.default()`）。 */
const DEFAULTS = { promptMaxChars: 100_000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15_000 } as const

/**
 * 读插件配置，换成运行期要的 `Machine`。
 *
 * 为什么不直接 `Config.parse` 再 `machineOf`：
 *   1. 上游的 `stateDir` 用 `/^\/` 约束成 POSIX 绝对路径，Windows 的 `C:\...` 会被 schema 拒；
 *   2. `Config` 是 `.loose()` + `machineOf` 点名旧键的组合，DSC 的 `plugins.json` 里恰好还是
 *      旧键（`repoPath` 等），照搬会把插件拦在启动前，而不是带着缺省值跑起来。
 * 所以这里只认本插件用得上的四个键，类型不对用缺省、数值夹回区间——与旧入口
 * `readSuperagentConfig` 的读路径同一条规矩（`index.legacy.ts:342-383`）。
 *
 * @param passed - cordis 装配时传来的行配置（`cordis.patch.yml` 那一行没有 `config`，通常为空）
 */
function machineOfPlugin(passed?: unknown): Machine {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const stateDir = typeof raw.stateDir === 'string' && raw.stateDir.trim() !== '' ? raw.stateDir.trim() : superagentRoot()
  return {
    stateDir,
    promptMaxChars: clampInt(raw.promptMaxChars, LIMITS.promptMaxChars.min, LIMITS.promptMaxChars.max, DEFAULTS.promptMaxChars),
    admissionContextMaxPages: clampInt(raw.admissionContextMaxPages, LIMITS.admissionContextMaxPages.min,
      LIMITS.admissionContextMaxPages.max, DEFAULTS.admissionContextMaxPages),
    admissionContextTimeoutMs: clampInt(raw.admissionContextTimeoutMs, LIMITS.admissionContextTimeoutMs.min,
      LIMITS.admissionContextTimeoutMs.max, DEFAULTS.admissionContextTimeoutMs),
  }
}

/**
 * 装配入口：建运行期、起来源、provide 面板服务与快照面。
 *
 * 与旧入口最大的差别是**不再懒建**：旧入口把开库推迟到有人用（设计文档 §5.4，一条插件挂了
 * 不拖垮宿主），新树照上游在 `apply` 里直接建。代价是状态目录锁在插件启用时就拿到；
 * 好处是来源、面板、泵从启动那刻起就有同一份运行期，不会出现「界面先到、运行期后到」的
 * 两套状态。拿不到锁时 `Runtime` 的构造会抛，cordis 把这一行标成失败——这正是上游的
 * 失败方式（不降级成「看起来能用」）。
 *
 * @param ctx - 插件上下文（`llm` 与 `surfaces` 已就绪）
 * @param passed - 装配时传进来的行配置（`plugins.json` 现读，见 `machineOfPlugin`）
 */
export async function apply(ctx: Context, passed?: unknown): Promise<void> {
  const machine = machineOfPlugin(passed)
  // 运行期重启：与上游同一条回调，设置里换账号 / 换 CLI 后由 Setup 推到下一个 macrotask 调它。
  const restart = (): void => {
    ctx.fiber.restart().catch((error: unknown) => { ctx.logger.error('superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  // 关闭时先停运行期（收会话、关库、放锁）；`stop()` 幂等，重复调用共用同一个 shutdown。
  ctx.effect(() => async () => { await runtime.stop() }, 'superagent: runtime.stop')
  // 两个来源在运行期建好之后起来：它们各自的循环先 `await ctx.ready`，setup 没过就先报暂停。
  // 停止信号用运行期的 `lifetime`：插件停用或运行期关闭都会 abort，循环在秒级内退出。
  ctx.effect(() => startGithub(runtime, runtime.lifetime), 'superagent: sources.startGithub')
  ctx.effect(() => startFeishu(runtime, runtime.lifetime), 'superagent: sources.startFeishu')
  // 面板 RPC：`packages/runtime` 的 superagentPublish 等八条转发到 `ctx.get('superagent')`
  // （契约 `SuperagentService`）。服务只读运行期的公开成员与视图投影，不碰库的写路径。
  const api = createApi(runtime)
  ctx.provide('superagent', api)
  // 快照面：界面每帧调 `api.surface()`；`ctx.effect` 包住登记，停用插件即摘掉这一格。
  ctx.effect(() => ctx.surfaces.register('superagent', () => api.surface()), 'superagent: surfaces.register')
  // 快照失效桥：新树的编排会话是本进程里自己造的 MiniAgent，回合事件不经过 DSC 的会话服务，
  // 宿主收不到 `dsc/changed`。面板读的是快照，没有这条桥只能在别的插件碰巧发事件时重画。
  // 旧入口的 `service.tick`（`index.legacy.ts:1396-1419`）就是这件事；这里只留「可见面变了就发」，
  // 真正的泵（到期 Eval、派工、出站）由新树 `Passes` 自己每 2 秒跑（`app/passes.ts:38`）。
  ctx.effect(() => {
    let last = api.pulse()
    const timer = setInterval(() => {
      const next = api.pulse()
      if (next === last) return
      last = next
      ctx.emit('dsc/changed')
    }, SURFACE_PULSE_MS)
    return () => { clearInterval(timer) }
  }, 'superagent: surface.changed')
  await runtime.ready
  // ── DSC 专有宿主接线（W9-2）：设置分区、/sa 命令、doctor 四项体检 ─────────────
  // 都放在运行期就绪之后：设置分区读的是运行期里的设置块与来源注册表，命令与体检用的也是
  // 同一个运行期。登记一律包在 `ctx.effect` 里，停用插件时由 cordis 统一摘掉。
  ctx.effect(() => ctx.settings.registerSection(createSettingsSection(runtime)), 'superagent: settings.registerSection')
  ctx.effect(() => registerSaCommand(ctx, api), 'superagent: commands.register')
  // doctor 的 pneuma.order 早于本插件，启动到这里它已经 provide 了 `health`；doctor 没开
  // （或将来被换掉）时 `ctx.get` 给 undefined，少四项体检而已。
  const health = ctx.get('health')
  if (health !== undefined) {
    ctx.effect(() => health.register(createSuperagentHealth(runtime)), 'superagent: health.register (orchestrator)')
    ctx.effect(() => health.register(createFeishuHealth(runtime)), 'superagent: health.register (feishu)')
    ctx.effect(() => health.register(createDependenciesHealth(runtime)), 'superagent: health.register (dependencies)')
    ctx.effect(() => health.register(createTeammatesHealth()), 'superagent: health.register (teammates)')
  }
  ctx.logger.info(runtime.configured()
    ? 'superagent ready; the Super Agent panel opens the ticket board'
    : `superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
