/**
 * 外部插件热挂载管理器（对应 dsh 的 HMR：启停即时生效，无需重启宿主）。
 *
 * 外部插件是 cordis object plugin（命名导出 inject/apply，可选 name/apiVersion/
 * description），经 `root.plugin(mod, config)` 挂载为独立 Fiber；卸载 =
 * `fiber.dispose()`（自动运行插件 apply 返回的 disposer）。文件变更后的重载
 * 通过 mtime 查询参数破坏 ESM 缓存。
 *
 * 版本管理：插件声明 `export const apiVersion = N` 时与内核 KERNEL_API_VERSION
 * 比对，高于内核 → 拒绝挂载并自动停用（回滚到可用状态），避免每次启动报错。
 *
 * @module dsc/core/plugin-loader
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { ensureResolveHook } from './dsh-compat/resolve-hook.js'
import { dshToolsFacade } from './dsh-compat/tools-facade.js'
import {
  checkApiVersion,
  getPluginConfig,
  getPluginMeta,
  isPluginEnabled,
  readPluginEntries,
  registerPluginMeta,
  writePluginEnabled,
  KERNEL_API_VERSION,
  type PluginMeta,
} from './plugin-registry.js'
import { errText as err } from './err-text.js'
import { activeConfigFile } from './config-store.js'
import { parseTolerantYaml } from './migrate.js'
import { describeForeignServices } from './dsh-compat/service-map.js'
import { applyPatchLayers, type PatchLayer, type PluginRow } from './plugin-patch.js'
import { bundleDirOf, enginesProblem, readBundle, readProfile, type BundleInfo } from './plugin-bundle.js'
import { dscPath } from './path-policy.js'

/** 内核插件 API 版本（重导出，供宿主/文档引用）。 */
export { KERNEL_API_VERSION }

/**
 * dsc 自己的全部服务名（services/types.ts 的 Context 声明）。外部插件 inject 里
 * 出现这张表之外的名字，就认定是 dsh 风格的插件，走兼容层挂载路径。
 */
const DSC_SERVICE_NAMES = new Set([
  'llm', 'session', 'approval', 'mode', 'todo', 'plan', 'ask', 'goal', 'tools', 'transcript',
  'commands', 'compact', 'agent', 'prompt', 'guards', 'surfaces', 'waiting', 'skills', 'settings',
  'hooks', 'memory', 'dock', 'ui', 'team', 'mcp', 'sessionSearch', 'approvalFloor', 'interactive',
  'sandbox', 'logger',
])

/**
 * 读插件声明的 dsh 客户端能力名（只读，不加载）。
 *
 * dsh 的 `dsh.client` 是个对象（platform / inject / modules…），我们把**键名**当能力列出来；
 * 数组就给里面的字符串；字符串原样。认不出给空数组（不猜）。
 * @param raw - 插件模块上的 client / dshClient 导出
 * @returns 能力名清单（去重、按出现顺序）
 */
function clientCapabilitiesOf(raw: unknown): string[] {
  const names: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value !== '' && !names.includes(value)) names.push(value)
  }
  if (typeof raw === 'string') push(raw)
  else if (Array.isArray(raw)) for (const item of raw) push(item)
  else if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      // platform / inject 这类字段的值本身就是能力线索，也一并列出（去重靠 push）。
      if (key === 'platform') push(`platform:${String(value)}`)
      else if (key === 'inject' && Array.isArray(value)) for (const item of value) push(`服务:${String(item)}`)
      else push(key)
    }
  }
  return names
}

/** 兼容层开着的判定与说明文案在挂载路径里；这里只留服务名清单。 */

/** 已挂载的外部插件：文件名 → cordis Fiber（dispose 即卸载）。 */
const mounted = new Map<string, Fiber>()

/**
 * 内置但可停用的官方插件（智能体团队、电脑操作）：这里登记它们的插件对象，
 * 于是「打开开关」不必去找 `~/.dsc/plugins/` 下的文件，热挂载直接挂内置对象。
 */
const builtinMounts = new Map<string, Plugin.Object>()

/**
 * 登记一个内置官方插件的挂载对象（宿主装配时调用一次）。
 * @param file - 开关键，与 `registerPluginMeta` 用的名字一致。
 */
export function registerBuiltinMount(file: string, plugin: Plugin.Object): void {
  builtinMounts.set(basename(file), plugin)
}

/** 初始化（宿主启动时调用一次，传入内核 root）。 */
let rootRef: Context | null = null
export function initPluginRuntime(root: Context): void {
  rootRef = root
}

/** 插件模块的最小形状（cordis object plugin + dsc 扩展导出）。 */
interface PluginModule {
  name?: unknown
  description?: unknown
  apiVersion?: unknown
  inject?: unknown
  apply?: unknown
  /** dsh 插件的 schemastery 配置 schema（可调用：传入原始 config，返回校验后的值）。 */
  Config?: unknown
  /**
   * dsh 客户端（界面）能力声明。只读进来列给用户看，**不加载**——见 PluginMeta 的说明。
   * 形状宽松：对象取键名，数组取字符串，字符串原样。
   */
  client?: unknown
  dshClient?: unknown
}

/**
 * 读取插件模块（按 mtime 破坏 ESM 缓存，保证文件变更后重载新代码）。
 * @returns null = 模块不可用（错误已写入 meta.problem）。
 */
async function importPluginModule(file: string, meta: PluginMeta): Promise<PluginModule | null> {
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    meta.problem = '文件不存在或不可读'
    return null
  }
  const url = `${pathToFileURL(file).href}?t=${mtime}`
  try {
    return (await import(url)) as PluginModule
  } catch (error) {
    const message = err(error)
    // dsh 插件在模块顶层就 import @deepseek-ai/*，兼容层没开时导入钩子不在，
    // 于是第一句报错是「找不到包」——不说清楚用户只会以为包坏了。
    const hint =
      message.includes('@deepseek-ai/') && !isPluginEnabled('dsh-compat')
        ? '（这像是 dsh 插件：它 import 的 @deepseek-ai/* 由「dsh 兼容层」提供，请先在插件中心启用 dsh-compat 再试）'
        : ''
    meta.problem = `模块导入失败：${message}${hint}`
    return null
  }
}

/**
 * 挂载一个外部插件（热；已挂载时先卸载旧 fiber）。
 * 失败路径：apiVersion 不兼容 / 模块损坏 / 缺 apply → 元数据记 problem，
 * 自动停用（写盘回滚到可用状态），返回 false。
 */
export async function mountExternalPlugin(file: string): Promise<boolean> {
  const root = rootRef
  if (root === null) throw new Error('plugin runtime 未初始化')
  const base = basename(file)

  // 内置官方插件：对象已在宿主装配时登记，不必读文件；与内核同源，跳过 apiVersion 检查。
  const builtin = builtinMounts.get(base)
  if (builtin !== undefined) {
    await unmountExternalPlugin(base)
    try {
      const fiber = root.plugin(builtin, getPluginConfig(base))
      await fiber
      mounted.set(base, fiber)
      const own = getPluginMeta(base)
      if (own !== undefined) own.problem = undefined
      return true
    } catch (error) {
      const own = getPluginMeta(base)
      if (own !== undefined) own.problem = `挂载失败：${err(error)}`
      await disableSilently(base)
      return false
    }
  }

  const meta: PluginMeta = { file: base, name: base.replace(/\.js$/, ''), description: '', source: 'external' }
  registerPluginMeta(meta)

  // 解析钩子必须在**导入之前**就位：dsh 插件在模块顶层就 import @deepseek-ai/* 的东西，
  // 等 apply 时再注册已经太晚（import 早就抛 ERR_MODULE_NOT_FOUND 了）。
  const needsCompat = isPluginEnabled('dsh-compat')
  if (needsCompat) {
    ensureResolveHook([DSC_PLUGINS_DIR])
    normalizeDshHome()
  }

  const mod = await importPluginModule(file, meta)
  if (mod === null) {
    await disableSilently(base)
    return false
  }
  if (typeof mod.name === 'string' && mod.name !== '') meta.name = mod.name
  if (typeof mod.description === 'string' && mod.description !== '') meta.description = mod.description
  if (typeof mod.apiVersion === 'number') meta.apiVersion = mod.apiVersion
  const capabilities = clientCapabilitiesOf(mod.client ?? mod.dshClient)
  if (capabilities.length > 0) meta.clientCapabilities = capabilities

  // ---- 版本管理：不兼容自动回滚（停用并写盘） ----
  const problem = checkApiVersion(meta.apiVersion)
  if (problem !== null) {
    meta.problem = problem
    await disableSilently(base)
    return false
  }
  if (typeof mod.apply !== 'function') {
    meta.problem = '缺少 apply 导出（不是 cordis object plugin）'
    await disableSilently(base)
    return false
  }

  // ---- dsh 风格识别 ----
  // inject 里有 dsc 不认识的服务名 = dsh 生态的插件。兼容层没开就提示先开它；开了也
  // 垫不起的（sessionProjections、agents 这类要整个 dsh 会话语义的），话说明白再回滚。
  const injectNames = Array.isArray(mod.inject) ? mod.inject.filter((n): n is string => typeof n === 'string') : []
  const foreign = injectNames.filter((n) => !DSC_SERVICE_NAMES.has(n))
  if (foreign.length > 0) {
    // 一句「超出范围」帮不到插件作者：这张表给每个常见 dsh 服务名一句判定
    // （有对应但语义不同 / 根本没有），见 core/dsh-compat/service-map.ts。
    const detail = describeForeignServices(foreign)
    if (!isPluginEnabled('dsh-compat')) {
      meta.problem =
        `插件需要 dsc 不认识的服务：${detail}。若这是 dsh（DeepSeek Harness）风格的插件，` +
        '请先在插件中心启用「dsh 兼容层」（dsh-compat）再打开本插件'
    } else {
      meta.problem =
        `这个 dsh 插件要的服务 Pneuma 没有或对不上：${detail}。` +
        '依赖这些语义的插件在 Pneuma 上跑不起来，需要改写（或等对应服务做出来）'
    }
    await disableSilently(base)
    return false
  }

  // ---- 配置校验（dsh 插件用 schemastery 导出 Config；有就调一次，失败响亮回滚） ----
  let configForApply = getPluginConfig(base)
  if (typeof (mod.Config as unknown) === 'function') {
    try {
      const validated = (mod.Config as (raw: unknown) => unknown)(configForApply)
      if (validated !== null && typeof validated === 'object') configForApply = validated as Record<string, unknown>
    } catch (error) {
      meta.problem = `插件配置校验失败：${err(error)}（检查 ~/.dsc/plugins.json 里这条目目的 config）`
      await disableSilently(base)
      return false
    }
  }

  // ---- 挂载 ----
  await unmountExternalPlugin(base)
  // 兼容层开着：外部插件的 ctx.tools 换成双形状兼容面（dsc ToolEntry 与 dsh
  // ToolDefinition 都收），dsh 插件 inject ['tools'] 时不再需要任何特判。
  // 解析钩子同步注册（registerHooks），这里先确保它在，插件导入 @deepseek-ai/* 才走得通。
  /** 插件运行时直接 `ctx.get` 过的服务名（诊断用：它可能不声明 inject）。 */
  const asked: string[] = []
  try {
    const pluginObject = {
      name: meta.name,
      inject: mod.inject as string[] | undefined,
      apply: (innerCtx: Context, config: Record<string, unknown>): unknown =>
        (mod.apply as (ctx: Context, config: Record<string, unknown>) => unknown)(
          needsCompat ? compatCtx(innerCtx, base, asked) : innerCtx,
          config,
        ),
    }
    const fiber = root.plugin(pluginObject, configForApply)
    await fiber
    mounted.set(base, fiber)
    meta.problem = undefined
    return true
  } catch (error) {
    // 很多 dsh 插件不声明 inject，而是在 apply 里 ctx.get('sessions') 现取。取到
    // undefined 再调方法就只剩一句 "Cannot read properties of undefined"，等于没说话。
    // 这里把「它取过、但我们没有或对不上」的服务名一并写进诊断。
    const missing = missingServicesOf(asked)
    meta.problem =
      missing === null
        ? `挂载失败：${err(error)}`
        : `挂载失败：${err(error)}。它在运行时直接取这些服务，Pneuma 没有或对不上：${missing}`
    await disableSilently(base)
    return false
  }
}

/**
 * dsh 兼容的 ctx 视图：`ctx.tools` 换成双形状的兼容面（risk 的映射每次 register
 * 时现读插件条目配置），其余服务原样透传。logger 是 cordis 内置服务，不用垫。
 */
function compatCtx(innerCtx: Context, file: string, asked: string[]): Context {
  return new Proxy(innerCtx, {
    get(target, prop, receiver) {
      if (prop === 'tools') {
        return dshToolsFacade((entry) => target.tools.register(entry), () => resolveRiskConfig(file))
      }
      if (prop === 'get') {
        // 原样转发（缺服务仍然给 undefined，与 cordis 一致），只顺手记一笔名字。
        return (name: unknown): unknown => {
          if (typeof name === 'string') asked.push(name)
          return (target.get as (key: string) => unknown)(String(name))
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * 把 `$DSH_HOME` 定到 Pneuma 的家（用户设过就不动）。
 *
 * 为什么要在**导入之前**做：dsh 插件里有一半的路径不走 home-paths 包，而是在模块
 * 顶层直接算 `process.env.DSH_HOME || join(homedir(), '.dsh')`（cost-meter 的
 * store.js 就是），算完存成常量。等 apply 时再设已经晚了，账本照样写进 dsh 的家目录。
 */
function normalizeDshHome(): void {
  // 一律覆盖，包括继承来的值：`DSH_HOME` 是 dsh 的内部开关，不是 Pneuma 用户的设置项。
  // 从 dsh 终端里启动 Pneuma 时会继承到 `~/.dsh`，照抄就等于让插件写进 dsh 的家目录；
  // 想换 Pneuma 的家请设 `DSC_HOME`，那条路我们本来就认。
  process.env['DSH_HOME'] = dscPath()
}

/**
 * 把「插件取过、Pneuma 没有或对不上」的服务名折成一句人话。
 * @param asked - 插件运行时 `ctx.get` 过的名字（按调用顺序，可能重复）
 * @returns 说明；没有缺失给 null
 */
function missingServicesOf(asked: readonly string[]): string | null {
  const foreign = [...new Set(asked)].filter((name) => !DSC_SERVICE_NAMES.has(name))
  if (foreign.length === 0) return null
  return describeForeignServices(foreign)
}

/** 从条目树现读 risk 映射：`risk` 是这份插件全部工具的缺省，`risks` 按工具名覆盖。 */
function resolveRiskConfig(file: string): { risk?: unknown; risks?: Record<string, unknown> } {
  const raw = getPluginConfig(file)
  return { risk: raw.risk, risks: raw.risks as Record<string, unknown> | undefined }
}

/** 卸载外部插件（未挂载时静默）。 */
export async function unmountExternalPlugin(file: string): Promise<void> {
  const fiber = mounted.get(file)
  if (fiber === undefined) return
  mounted.delete(file)
  try {
    await fiber.dispose()
  } catch {
    // 卸载失败不阻塞流程（插件 disposer 的错误由 cordis 记录）
  }
}

/** 自动停用：卸载 + 写盘（保留原 config），宿主下次启动也不再加载。 */
async function disableSilently(file: string): Promise<void> {
  await unmountExternalPlugin(file)
  writePluginEnabled(file, false)
}

/**
 * 热启停：enabled = 挂载，否则卸载；结果写盘持久化。
 * @returns ok=false 时 problem 说明原因（UI / system 条目展示）。
 */
export async function setPluginEnabledHot(file: string, enabled: boolean): Promise<{ ok: boolean; problem?: string }> {
  if (enabled) {
    // 内置官方插件没有磁盘文件，登记过的对象直接挂；其余仍按 ~/.dsc/plugins/ 里的文件找。
    const entryFile = builtinMounts.has(basename(file)) ? file : resolveEntryPath(file)
    if (entryFile === null) return { ok: false, problem: `找不到插件文件 ${file}（检查 ~/.dsc/plugins/）` }
    const ok = await mountExternalPlugin(entryFile)
    if (!ok) return { ok: false, problem: getPluginMeta(file)?.problem ?? '挂载失败' }
    // 挂载成功后确保条目树里是启用状态
    writePluginEnabled(file, true)
    return { ok: true }
  }
  await unmountExternalPlugin(file)
  writePluginEnabled(file, false)
  return { ok: true }
}

/** 加载失败信息（宿主启动后写 system 条目展示）。 */
export interface PluginMountFailure {
  file: string
  name: string
  problem: string
}

/** 外部插件目录（桌面端「添加插件」的复制目标，也是这里发现 `.js` 的地方）。 */
export const DSC_PLUGINS_DIR = dscPath('plugins')

/** 加载全部外部插件（宿主启动时调用）：条目树驱动，含热挂载与回滚语义。 */
export async function mountAllExternalPlugins(
  root: Context,
  extraPaths: string[],
): Promise<PluginMountFailure[]> {
  initPluginRuntime(root)
  const dir = DSC_PLUGINS_DIR
  const files = new Map<string, string>()
  try {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.js')) files.set(name, join(dir, name))
    }
  } catch {
    // 目录不存在：只有 extraPaths
  }
  for (const extra of extraPaths) files.set(basename(extra), extra)

  const failures: PluginMountFailure[] = []
  for (const [base, file] of files) {
    if (isDisabledByEntry(base)) continue
    const ok = await mountExternalPlugin(file)
    if (!ok) {
      const meta = getPluginMeta(base)
      if (meta?.problem !== undefined) failures.push({ file: base, name: meta.name, problem: meta.problem })
    }
  }

  // 组合包（dsh 的安装形态）：只在这一份配置指定了 profile 时才走。
  // 没配 profile 的用户启动路径与以前一个字节都不差。
  const profileDir = activeProfileDir()
  if (profileDir !== null && existsSync(profileDir)) {
    const bundles = await mountBundlePlugins(root, profileDir)
    failures.push(...bundles.failures)
    for (const warning of bundles.warnings) {
      root.transcript.system(`组合包：${warning}`, 'error')
    }
  }
  return failures
}

/**
 * 当前生效的 profile 目录（没配就是 null = 不加载组合包）。
 *
 * 从哪来：环境变量 `DSC_PROFILE` 优先（自检与多环境用它），否则看 `~/.dsc/config.yaml`
 * 的 `profile:` 字段。没配就完全不碰这条路径——现有用户的启动行为一个字节都不变。
 * @returns profile 目录的绝对路径，或 null
 */
export function activeProfileDir(): string | null {
  const fromEnv = process.env['DSC_PROFILE']
  const name = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : readProfileNameFromConfig()
  if (name === null) return null
  return dscPath('profiles', name)
}

function readProfileNameFromConfig(): string | null {
  try {
    const file = activeConfigFile()
    if (!existsSync(file)) return null
    const doc = parseTolerantYaml(readFileSync(file, 'utf8')) as { profile?: unknown }
    return typeof doc.profile === 'string' && doc.profile.trim() !== '' ? doc.profile.trim() : null
  } catch {
    return null
  }
}

/**
 * 装一个 profile 里的组合包插件（dsh 的安装形态）。
 *
 * 流程与 dsh 同形：profile 的 `dsh.profile.bundles` 给出层序 → 每个包读自己的
 * `dsh.bundle.patch` 成一层 → 所有层按顺序套到「行」上（patch 里 insert 的行就是
 * 要加载的插件）→ 每一行解析成文件路径后走与外置插件同一条挂载路径。
 *
 * 版本闸：包的 `engines.dsh` 不满足就先跳过并记一条告警（除非 profile 的
 * compatibility.json 里登记了豁免）。
 * @param root - 内核 root（组合包也走同一条热挂载路径）
 * @param profileDir - profile 目录
 * @returns 挂载失败清单（与 mountAllExternalPlugins 同形）+ 告警
 */
export async function mountBundlePlugins(
  root: Context,
  profileDir: string,
): Promise<{ failures: PluginMountFailure[]; warnings: string[] }> {
  initPluginRuntime(root)
  // 组合包的插件代码在 profile 自己的 node_modules 里，它们 import @deepseek-ai/* 时
  // 要把这个目录也当成「允许重定向的插件根」——只认 ~/.dsc/plugins/ 的话，真装一个
  // dsh 组合包会在 import 阶段就 ERR_MODULE_NOT_FOUND。
  if (isPluginEnabled('dsh-compat')) ensureResolveHook([join(profileDir, 'node_modules')])
  const profile = readProfile(profileDir)
  const layers: PatchLayer[] = []
  const warnings: string[] = []
  /** 每一层是哪个包的（解析相对路径时按它来）。 */
  const layerOwner = new Map<string, string>()
  /** 包名 → 读盘结果（挂上之后要拿它的 `dsh.client` 给插件中心看）。 */
  const bundleInfoOf = new Map<string, BundleInfo>()

  for (const name of profile.bundles) {
    const dir = bundleDirOf(profileDir, name)
    if (!existsSync(dir)) {
      warnings.push(`profile 里列了包「${name}」，但 ${dir} 不存在（先 pnpm install？），已跳过`)
      continue
    }
    let info
    try {
      info = readBundle(dir)
    } catch (error) {
      warnings.push(err(error))
      continue
    }
    if (info === null) {
      warnings.push(`${dir} 里没有 package.json，不是插件包，已跳过`)
      continue
    }
    bundleInfoOf.set(info.name, info)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    const engineProblem = enginesProblem(manifest)
    if (engineProblem !== null && !profile.exemptions.includes(info.name)) {
      warnings.push(`${info.name}：${engineProblem}`)
      continue
    }
    if (info.patch !== null) {
      layers.push(info.patch)
      layerOwner.set(info.patch.label, dir)
    }
  }
  if (profile.patch !== null) layers.push(profile.patch)

  // 行 id → 是哪个包的行（插件中心显示「来自组合包 X」用）
  const ownerOf = new Map<string, string>()
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index]
    const owner = layerOwner.get(layer.label)
    if (owner === undefined) continue
    const name = basename(owner)
    for (const patch of layer.patches) {
      for (const row of patch.insert ?? []) {
        if (typeof row.id === 'string' && row.id !== '') ownerOf.set(row.id, name)
      }
    }
  }

  const base: PluginRow[] = []
  const applied = applyPatchLayers(base, layers)
  warnings.push(...applied.warnings)

  const failures: PluginMountFailure[] = []
  for (const row of applied.rows) {
    const target = typeof row.name === 'string' ? row.name : undefined
    if (target === undefined) {
      warnings.push(`组合包里有一行没有 name（不知道加载什么），已跳过`)
      continue
    }
    const file = resolveBundleTarget(profileDir, target, layerOwner)
    if (file === null) {
      warnings.push(`组合包里的「${target}」找不到对应文件，已跳过`)
      continue
    }
    if (row.disabled === true) continue
    const ok = await mountExternalPlugin(file)
    const meta = getPluginMeta(basename(file))
    const owner = typeof row.id === 'string' ? ownerOf.get(row.id) : undefined
    if (ok && meta !== undefined) {
      if (owner !== undefined) meta.bundle = owner
      // 有的包把界面能力写在 package.json 的 dsh.client（不在模块导出里）。
      // 只列不加载，但要列得出来，否则用户在插件中心看不到「它还想改界面」。
      const declared = owner === undefined ? undefined : bundleInfoOf.get(owner)?.client
      if (meta.clientCapabilities === undefined && declared !== undefined) {
        meta.clientCapabilities = clientCapabilitiesOf(declared)
      }
    }
    if (!ok && meta?.problem !== undefined) {
      failures.push({ file: basename(file), name: meta.name, problem: meta.problem })
    }
  }
  return { failures, warnings }
}

/**
 * 把行里的 `name` 解析成文件路径。
 *
 * 三种写法：绝对路径、以 `./` `../` 开头（相对 profile 目录）、或包名（从 profile 的
 * node_modules 解析）。解析不出来给 null（调用方记告警）。
 */
function resolveBundleTarget(profileDir: string, target: string, layerOwner: ReadonlyMap<string, string>): string | null {
  if (isAbsolute(target)) return entryFileOf(target)
  if (target.startsWith('./') || target.startsWith('../')) {
    // 相对路径按「哪一层的 patch 写的」算：bundle 的 patch 相对它自己的包目录。
    const owner = [...layerOwner.values()].find((dir) => existsSync(join(dir, target)))
    const candidate = owner === undefined ? join(profileDir, target) : join(owner, target)
    return entryFileOf(candidate)
  }
  return entryFileOf(join(profileDir, 'node_modules', ...target.split('/')))
}

/**
 * 把一个「可能是包目录」的路径落成真正的入口文件。
 *
 * dsh 的 patch 行写的是**包名**，pnpm 装上来的 `node_modules/<包名>` 是目录，
 * 而 ESM 的 `import()` 不吃目录（`ERR_UNSUPPORTED_DIR_IMPORT`）。dsh 那边由 Node
 * 的包解析负责找入口，我们这一层自己补：先看 `exports["."]`，再看 `main`，
 * 最后退回 `index.js`。
 * @param candidate - 绝对路径（文件或包目录）
 * @returns 入口文件的绝对路径；路径不存在或目录里找不到入口给 null
 */
function entryFileOf(candidate: string): string | null {
  if (!existsSync(candidate)) return null
  let stats
  try {
    stats = statSync(candidate)
  } catch {
    return null
  }
  if (!stats.isDirectory()) return candidate

  const manifest = readJsonObject(join(candidate, 'package.json'))
  const fromExports = exportsEntry(manifest?.exports)
  for (const relative of [fromExports, typeof manifest?.main === 'string' ? manifest.main : null, 'index.js']) {
    if (relative === null || relative === '') continue
    const file = join(candidate, relative)
    if (existsSync(file)) return file
  }
  return null
}

/** `exports` 字段里 `"."` 那一路的入口（字符串或条件对象）。 */
function exportsEntry(exports: unknown): string | null {
  const root =
    typeof exports === 'string'
      ? exports
      : exports !== null && typeof exports === 'object' && '.' in (exports as Record<string, unknown>)
        ? (exports as Record<string, unknown>)['.']
        : exports
  if (typeof root === 'string') return root
  if (root === null || typeof root !== 'object') return null
  const conditions = root as Record<string, unknown>
  for (const key of ['default', 'import', 'node', 'require']) {
    const value = conditions[key]
    if (typeof value === 'string') return value
  }
  return null
}

/** 松读一个 JSON 文件：不存在/坏掉给 null（入口解析按「没有」处理）。 */
function readJsonObject(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function isDisabledByEntry(file: string): boolean {
  return readPluginEntries().find((entry) => entry.file === file)?.disabled ?? false
}

/** 解析条目树里的文件名 → 绝对路径（仅 ~/.dsc/plugins/ 下的外部插件）。 */
function resolveEntryPath(file: string): string | null {
  const candidate = dscPath('plugins', file)
  try {
    if (statSync(candidate).isFile()) return candidate
  } catch {
    // fallthrough
  }
  return null
}
