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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import {
  bumpGeneration,
  currentGeneration,
  ensureResolveHook,
  registerGenerationRoot,
  setResolveHookAppRoot,
  setResolveHookCompat,
} from './dsh-compat/resolve-hook.js'
import { dshToolsFacade } from './dsh-compat/tools-facade.js'
import {
  checkApiVersion,
  getPluginConfig,
  getPluginMeta,
  isPluginEnabled,
  readPluginEntries,
  registerPluginAlias,
  registerPluginMeta,
  writePluginEnabled,
  KERNEL_API_VERSION,
  type PluginMeta,
} from './plugin-registry.js'
import { errText as err } from './err-text.js'
import { activeConfigFile } from './config-store.js'
import { parseTolerantYaml } from './migrate.js'
import { describeForeignServices } from './dsh-compat/service-map.js'
import { compatServiceOf } from './dsh-compat/session-bridge.js'
import { pluginDisplayOf, languageOfConfigFile } from './plugin-locale.js'
import { applyPatchLayers, readPatchFile, type PatchDuplicate, type PatchLayer, type PluginRow } from './plugin-patch.js'
import { bundleDirOf, enginesProblem, pneumaEnginesProblem, readBundle, readProfile, type BundleInfo } from './plugin-bundle.js'
import { dscPath } from './path-policy.js'
import { activeProfileDir } from './profile-dir.js'

/** 内核插件 API 版本（重导出，供宿主/文档引用）。 */
export { KERNEL_API_VERSION }

/**
 * 功能包模块的「代数」重导出（热重挂的机制在 dsh-compat/resolve-hook）。
 *
 * 代数 0 = 启动态（不打戳）；`bumpGeneration()` 之后功能包解析结果带 `?g=`，
 * 下一次 `import` 就会拿到新代码。{@link remountExternalPlugin} 自己会换代，
 * 这里转出是给探针与排障用的。
 */
export { bumpGeneration, currentGeneration }

/**
 * 应用安装目录 = 运行中 Pneuma 的 `package.json` 所在目录。
 *
 * 构建产物住在 `<应用根>/lib/core/plugin-loader.js`，往上两级即是应用根
 * （桌面端是 `dsc-core/`）。应用侧的包统一落在 `<应用根>/lib/node_modules/` 下
 * （运行时适配包与各功能包同住一层，Node 从任何一个包目录向上都能命中同一个
 * `@pneuma/runtime`，单实例由目录唯一性保证）。
 */
export const APP_INSTALL_DIR = fileURLToPath(new URL('../../', import.meta.url))

// 解析钩子（含 dsh-compat 插件的兜底调用）缺省用这个应用根，不必自己按文件深度算。
setResolveHookAppRoot(APP_INSTALL_DIR)

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
 * dsh 的 `pneuma.client` 是个对象（platform / inject / modules…），我们把**键名**当能力列出来；
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

/**
 * 把模块的 `inject` 归成字符串数组。
 *
 * cordis 允许 `inject` 写字符串或字符串数组；dsh 插件偶尔还写对象（可选依赖）。
 * 认不出的部分一律当「没声明」，不猜。
 * @param raw - 模块导出的 inject
 * @returns 服务名清单（保持原顺序）
 */
function injectNamesOf(raw: unknown): string[] {
  if (typeof raw === 'string') return raw === '' ? [] : [raw]
  if (!Array.isArray(raw)) return []
  return raw.filter((name): name is string => typeof name === 'string' && name !== '')
}

/**
 * 已挂载的插件：**身份** → cordis Fiber（dispose 即卸载）。
 *
 * 身份 = 行 id（契约 §4）。外部单文件插件没有行，身份就退回文件名（老行为）；
 * 组合包里的行即使是同一个包的不同子路径，也是各自独立的身份与开关。
 */
const mountedByRoot = new WeakMap<Context, Map<string, Fiber>>()

/** 这个 root 上「身份 → Fiber」的表。按 root 分开：自检会在一个进程里连开多个内核。 */
function mountedOf(root: Context): Map<string, Fiber> {
  let table = mountedByRoot.get(root)
  if (table === undefined) {
    table = new Map<string, Fiber>()
    mountedByRoot.set(root, table)
  }
  return table
}

/**
 * 身份 → 它的磁盘入口文件。
 *
 * 组合包的行 id（例如 `ops`）和入口文件名（例如 `index.js`）不是一个东西，
 * 热启停时要靠这张表把 id 换回文件；默认关的行也要登记，否则用户打开开关时无路可走。
 */
const pluginSources = new Map<string, string>()

/** 登记一个插件身份对应的磁盘入口（组合包默认关的行也要登记）。 */
export function registerPluginSource(identity: string, file: string): void {
  pluginSources.set(identity, file)
}

/**
 * 一个入口文件所属的包目录（自下而上找最近的 `package.json`，最多 8 层）。
 *
 * 热更要盯的是「包目录下所有 .js/.json」，入口文件本身不够——应用自带包的入口是
 * 一层再导出桩（`lib/node_modules/@pneuma/<id>/index.js`），真正的代码在
 * `lib/packages/<id>/` 里，桩的 mtime 永远不会跟着变。
 * @param file - 入口文件绝对路径
 * @returns 包目录；找不到清单（外部单文件插件）给 null
 */
export function pluginPackageDirOf(file: string): string | null {
  let dir = dirname(file)
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * 把一行的包目录登记成「功能包路径」（代数戳的落点）。
 *
 * 只认 `node_modules` 里的包：用户目录里的单文件插件没有包边界，把它的父目录当
 * 「包」登记会让整片目录被戳（连别人的依赖一起换代）。
 * @param file - 入口文件绝对路径
 */
function registerPackageGenerationRoot(file: string): void {
  const pkgDir = pluginPackageDirOf(file)
  if (pkgDir === null) return
  const segments = resolve(pkgDir).split(/[\\/]/)
  if (!segments.includes('node_modules')) return
  registerGenerationRoot(pkgDir)
}

/**
 * 把应用自带的 `@pneuma` 包目录逐个登记成「功能包路径」。
 *
 * 功能包挂载时会顺带登记自己的桩目录（{@link registerPackageGenerationRoot}），
 * **库包没有行、永远不走挂载**，所以它的再导出桩
 * （`lib/node_modules/@pneuma/<id>/index.js`）会一直停在 0 代：引用它的插件换代重挂后，
 * 解析到的仍是第一次加载的那份旧库。这里在装配时把整层 `@pneuma/*` 一次登记完，
 * 库包换代就与功能包走同一套机制。
 *
 * 重复登记由 registerGenerationRoot 自己去重；`@pneuma/runtime` 与 `lib/core` 也在那边
 * 排掉（运行时包一个戳都不许有）。
 * @param appDir - 应用安装目录（自检会指到临时目录）
 */
function registerLibraryGenerationRoots(appDir: string): void {
  const scopeDir = join(appDir, 'lib', 'node_modules', '@pneuma')
  let entries
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true })
  } catch {
    // 还没构建（没有 lib/node_modules）：没有可登记的，照常启动。
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    registerGenerationRoot(join(scopeDir, entry.name))
  }
}

/**
 * 已挂载插件的那一份对象与参数：热重挂失败时用它把旧版本原样放回去。
 *
 * 为什么不能只留 Fiber：Fiber 只能 dispose，不能「重新启用」；要回滚就得留住
 * `root.plugin()` 当时收到的插件对象与配置，再挂一次。
 */
interface MountedDetail {
  plugin: Plugin.Object
  config: Record<string, unknown>
  /** 首次挂载时的行级覆盖（inject / 宿主配置 / native），热重挂要沿用同一份。 */
  options: RowMountOptions
}

const mountDetailsByRoot = new WeakMap<Context, Map<string, MountedDetail>>()

/** 这个 root 上「身份 → 挂载明细」的表（与 {@link mountedOf} 同生命周期）。 */
function mountDetailsOf(root: Context): Map<string, MountedDetail> {
  let table = mountDetailsByRoot.get(root)
  if (table === undefined) {
    table = new Map<string, MountedDetail>()
    mountDetailsByRoot.set(root, table)
  }
  return table
}

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

/**
 * 登记一个“启动时就挂上”的官方插件 fiber（宿主装配时调用一次）。
 *
 * 为什么需要：createKernel 不走 mountExternalPlugin（启动失败应该响亮，不能静默停用），
 * 但热停用只认 {@link mounted} 这张表。不登记的话，停用只写盘、fiber 照跑；
 * 再启用又会挂第二份，带 provide 的插件还会因服务重名直接失败。
 * @param file - 开关键，与 registerBuiltinMount 用的名字一致。
 * @param fiber - root.plugin() 返回的 fiber；卸载时由 unmountExternalPlugin 统一 dispose。
 */
export function trackBuiltinMount(file: string, fiber: Fiber): void {
  const fiberRoot = rootRef
  if (fiberRoot !== null) mountedOf(fiberRoot).set(basename(file), fiber)
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
  /** 插件贡献的设置分区 id（外部单文件插件用它声明；组合包以 package.json 为准）。 */
  settingsSection?: unknown
  /** dsh 插件的 schemastery 配置 schema（可调用：传入原始 config，返回校验后的值）。 */
  Config?: unknown
  /**
   * dsh 客户端（界面）能力声明。只读进来列给用户看，**不加载**——见 PluginMeta 的说明。
   * 形状宽松：对象取键名，数组取字符串，字符串原样。
   */
  client?: unknown
  dshClient?: unknown
  /** 包入口的默认导出：Pneuma 功能包用它导出插件对象（对象插件，不是模块级 apply）。 */
  default?: unknown
}

/**
 * 从模块里认出插件对象。
 *
 * 为什么要有这一层：dsh 插件把 `apply` 直接写在模块上（`export function apply`），
 * 而 Pneuma 的功能包导出的是 `export const xxxPlugin: Plugin.Object = { apply }`——
 * 名字随包不同，不能靠猜。规则按优先级：
 *   1. 默认导出带 `apply` → 用它；
 *   2. 恰好一个命名导出带 `apply` → 用它（多于一个说明模块没说清，报错让人补默认导出）；
 *   3. 模块自身带 `apply`（dsh 形状） → 用它。
 * 找到之后与模块级字段合并：模块上还能写 `Config` / `client` / `apiVersion` 这类旁挂声明。
 * @param mod - 导入到的模块
 * @returns 插件对象；认不出给 null
 */
function pickPluginObject(mod: PluginModule): Record<string, unknown> | null {
  const hasApply = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && typeof (value as { apply?: unknown }).apply === 'function'
  const base = mod as Record<string, unknown>
  if (hasApply(mod.default)) return { ...base, ...mod.default }
  const named: Array<[string, Record<string, unknown>]> = []
  for (const [key, value] of Object.entries(base)) {
    if (key !== 'default' && hasApply(value)) named.push([key, value as Record<string, unknown>])
  }
  if (named.length === 1) return { ...base, ...named[0]![1] }
  if (hasApply(base)) return base
  return null
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

/** 行级覆盖项：patch 行（或宿主）说了就盖过插件模块自带的声明。 */
export interface RowMountOptions {
  /**
   * 行上的 `inject`。写了就**盖过**模块导出的 inject——行的依赖关系以 profile 为准，
   * 模块里的那份只是包作者的缺省。
   */
  inject?: readonly string[]
  /**
   * 宿主直接给的那份配置：**整份替代** `plugins.json` 里那一条（不做深合并）。
   *
   * 为什么需要：llm / session / settings 这几行拿的是宿主现组装的配置
   * （providers、resume 路径、cwd），plugins.json 里根本没有这些；不整份替代的话，
   * 包化之后它们的配置会在第一次挂载时就丢掉。
   */
  config?: Record<string, unknown>
  /**
   * 这是 Pneuma 自己的功能包（`@pneuma/*`）。
   *
   * 原生包不按 dsh 插件口径处理：不做「inject 里有陌生服务名 = dsh 插件」的判定，
   * 也不套 `dshToolsFacade`。否则 `inject: ['presets']` 这种自己的服务名会被误判，
   * 工具注册会被换成 dsh 形状，原生插件当场挂不上。
   */
  native?: boolean
}

/** 一次「导入 + 校验」的结果：返回挂载要用的全部材料。 */
interface InspectedModule {
  /** 插件对象（默认导出 / 唯一带 apply 的命名导出 / 模块自身）。 */
  entry: Record<string, unknown>
  /** 整个模块（apply 与 inject 的回落来源）。 */
  mod: PluginModule
  /** 校验过的配置（宿主给的整份替代磁盘；跑了 Config 就用返回值）。 */
  configForApply: Record<string, unknown>
  /** 行级 inject（没写就是 undefined，挂载时回落到模块自带的那份）。 */
  inject: readonly string[] | undefined
  /** 要不要套 dsh 兼容的 ctx 视图（决定 apply 收到哪个 ctx）。 */
  needsCompat: boolean
}

/** {@link inspectPluginModule} 的结果：成功给材料，失败给一句人话。 */
type InspectResult = { ok: true; value: InspectedModule } | { ok: false; problem: string }

/**
 * 导入一个插件模块并做全部挂载前校验（首次挂载与热重挂共用）。
 *
 * 为什么拆出来：热重挂必须「先导入 + 校验，全过了才动旧 fiber」；两条路径各写一遍
 * 判定迟早会漂移（比如一边认 apiVersion 一边不认）。这里只做判定与读元数据，
 * **不卸载任何东西**——回滚语义由调用方决定（首次挂载失败 = 停用；热重挂失败 = 保旧）。
 * @param file - 入口文件绝对路径
 * @param identity - 运行时身份（行 id）
 * @param rowOptions - 行级覆盖（inject / 宿主配置 / native）
 * @param meta - 这一行的元数据（模块声明的展示字段会写进来）
 */
async function inspectPluginModule(
  file: string,
  identity: string,
  rowOptions: RowMountOptions,
  meta: PluginMeta,
): Promise<InspectResult> {
  const native = rowOptions.native === true
  const needsCompat = !native && isPluginEnabled('dsh-compat')
  // 解析钩子必须在**导入之前**就位：插件在模块顶层就 import @pneuma/runtime 与
  // @deepseek-ai/* 的东西，等 apply 时再注册已经太晚（import 早就抛 ERR_MODULE_NOT_FOUND 了）。
  // 注册**不再依赖 dsh-compat 开关**：dsh 兼容层只是"能不能跑 dsh 插件"的判定，
  // 而 @pneuma/runtime 的重定向与开关无关。
  ensureResolveHook([DSC_PLUGINS_DIR], APP_INSTALL_DIR)
  // 钩子永远在（@pneuma/runtime 要单实例），但 @deepseek-ai/* 的重定向跟着开关走：
  // 关掉兼容层时让 dsh 插件在 import 阶段就失败，用户才看得到「先启用 dsh-compat」。
  setResolveHookCompat(isPluginEnabled('dsh-compat'))
  if (needsCompat) normalizeDshHome()
  // 代数戳的落点：这一行的包目录算「功能包路径」，换代后 import 到的才是新代码。
  // 0 代不加戳，所以首次挂载登记它没有任何副作用（启动态与探针仍是同一实例）。
  registerPackageGenerationRoot(file)

  const mod = await importPluginModule(file, meta)
  if (mod === null) return { ok: false, problem: meta.problem ?? '模块导入失败' }
  // 包入口导出插件对象（默认导出或唯一一个带 apply 的命名导出）；dsh 插件则是模块自带 apply。
  const entry = pickPluginObject(mod)
  if (entry === null) {
    return { ok: false, problem: '模块里找不到插件对象：既没有默认导出，也没有唯一一个带 apply 的命名导出' }
  }
  if (typeof entry.name === 'string' && entry.name !== '') meta.name = entry.name
  else if (typeof mod.name === 'string' && mod.name !== '') meta.name = mod.name
  if (typeof entry.description === 'string' && entry.description !== '') meta.description = entry.description
  else if (typeof mod.description === 'string' && mod.description !== '') meta.description = mod.description
  if (typeof entry.apiVersion === 'number') meta.apiVersion = entry.apiVersion
  else if (typeof mod.apiVersion === 'number') meta.apiVersion = mod.apiVersion
  // 外部单文件插件没有 package.json 可读，设置分区只能靠模块导出（契约 §2 的缺省口径）。
  if (typeof mod.settingsSection === 'string' && mod.settingsSection !== '') meta.settingsSection = mod.settingsSection
  const capabilities = clientCapabilitiesOf(mod.client ?? mod.dshClient)
  if (capabilities.length > 0) meta.clientCapabilities = capabilities

  // ---- 版本管理：不兼容自动回滚（停用并写盘） ----
  const problem = checkApiVersion(meta.apiVersion)
  if (problem !== null) return { ok: false, problem }
  if (typeof entry.apply !== 'function') return { ok: false, problem: '缺少 apply（不是 cordis object plugin）' }

  // ---- 行级 inject：行上写了就盖过模块自带的（依赖关系属于装配，不属于包本身） ----
  const rowInject = rowOptions.inject === undefined ? undefined : [...rowOptions.inject]

  // ---- dsh 风格识别 ----
  // inject 里有 dsc 不认识的服务名 = dsh 生态的插件。兼容层没开就提示先开它；开了也
  // 垫不起的（sessionProjections、agents 这类要整个 dsh 会话语义的），话说明白再回滚。
  const injectNames = rowInject ?? injectNamesOf(entry.inject ?? mod.inject)
  const foreign = native ? [] : injectNames.filter((n) => !DSC_SERVICE_NAMES.has(n))
  if (foreign.length > 0) {
    // 一句「超出范围」帮不到插件作者：这张表给每个常见 dsh 服务名一句判定
    // （有对应但语义不同 / 根本没有），见 core/dsh-compat/service-map.ts。
    const detail = describeForeignServices(foreign)
    if (!isPluginEnabled('dsh-compat')) {
      return {
        ok: false,
        problem:
          `插件需要 dsc 不认识的服务：${detail}。若这是 dsh（DeepSeek Harness）风格的插件，` +
          '请先在插件中心启用「dsh 兼容层」（dsh-compat）再打开本插件',
      }
    }
    return {
      ok: false,
      problem:
        `这个 dsh 插件要的服务 Pneuma 没有或对不上：${detail}。` +
        '依赖这些语义的插件在 Pneuma 上跑不起来，需要改写（或等对应服务做出来）',
    }
  }

  // ---- 配置校验（dsh 插件用 schemastery 导出 Config；有就调一次，失败响亮回滚） ----
  // 宿主给了配置就整份用它（不深合并）：宿主知道的那几项磁盘上根本没有。
  let configForApply = rowOptions.config ?? getPluginConfig(identity)
  const configSchema = mod.Config ?? entry.Config
  if (typeof (configSchema as unknown) === 'function') {
    try {
      const validated = (configSchema as (raw: unknown) => unknown)(configForApply)
      if (validated !== null && typeof validated === 'object') configForApply = validated as Record<string, unknown>
    } catch (error) {
      return { ok: false, problem: `插件配置校验失败：${err(error)}（检查 ~/.dsc/plugins.json 里这条目目的 config）` }
    }
  }

  return { ok: true, value: { entry, mod, configForApply, inject: rowInject, needsCompat } }
}

/**
 * 挂载一个外部插件（热；已挂载时先卸载旧 fiber）。
 * 失败路径：apiVersion 不兼容 / 模块损坏 / 缺 apply → 元数据记 problem，
 * 自动停用（写盘回滚到可用状态），返回 false。
 * @param file - 入口文件绝对路径
 * @param identity - 运行时身份（行 id）。不传 = 退回文件名（外部单文件插件的老行为）
 * @param rowOptions - 行级覆盖（目前只有 inject）
 */
export async function mountExternalPlugin(
  file: string,
  identity?: string,
  rowOptions: RowMountOptions = {},
): Promise<boolean> {
  const root = rootRef
  if (root === null) throw new Error('plugin runtime 未初始化')
  // 身份 = 行 id（契约 §4）：mounted / plugins.json / 插件中心 / settingsSection 全按它。
  const base = identity !== undefined && identity !== '' ? identity : basename(file)
  // 行 id 与文件名不一致时登记旧键：0.8.1 写的 plugins.json 里是文件名，双查才能读到老配置。
  if (base !== basename(file)) registerPluginAlias(base, basename(file))
  registerPluginSource(base, file)

  // 内置官方插件：对象已在宿主装配时登记，不必读文件；与内核同源，跳过 apiVersion 检查。
  const builtin = builtinMounts.get(base)
  if (builtin !== undefined) {
    await unmountExternalPlugin(base)
    try {
      const config = getPluginConfig(base)
      const fiber = root.plugin(builtin, config)
      await fiber
      mountedOf(root).set(base, fiber)
      mountDetailsOf(root).set(base, { plugin: builtin, config, options: rowOptions })
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

  // 导入 + 校验：与热重挂（remountExternalPlugin）共用同一套判定，避免两条路径各判一遍。
  const inspected = await inspectPluginModule(file, base, rowOptions, meta)
  if (!inspected.ok) {
    meta.problem = inspected.problem
    await disableSilently(base)
    return false
  }
  const { entry, mod, configForApply, inject: rowInject, needsCompat } = inspected.value

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
      inject: rowInject ?? ((entry.inject ?? mod.inject) as string[] | undefined),
      apply: (innerCtx: Context, config: Record<string, unknown>): unknown =>
        (entry.apply as (ctx: Context, config: Record<string, unknown>) => unknown)(
          needsCompat ? compatCtx(innerCtx, base, asked) : innerCtx,
          config,
        ),
    }
    const fiber = root.plugin(pluginObject, configForApply)
    await fiber
    mountedOf(root).set(base, fiber)
    // 留住插件对象与配置：热重挂失败时要靠它把旧版本原样放回去（Fiber 只能 dispose）。
    mountDetailsOf(root).set(base, { plugin: pluginObject, config: configForApply, options: rowOptions })
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

/** 热重挂的结果。 */
export interface RemountResult {
  ok: boolean
  /** 这次热重挂用的代数（失败也给，方便对照日志与探针）。 */
  generation: number
  problem?: string
}

/**
 * 把一行**已挂载**的插件换成磁盘上的新代码（改代码不重启即生效）。
 *
 * 时序（与 dsh 的有意差异：dsh 是先逐出、失败即失败；我们要保旧的）：
 *   1. 换代（{@link bumpGeneration}）——之后功能包的解析结果都带 `?g=<新代数>`；
 *   2. **先**导入新模块并做与首次挂载同一套校验（插件对象 / apiVersion / Config）；
 *   3. 全过了才 dispose 旧 fiber，再用新对象挂载；
 *   4. 挂载这一步失败 → 用留住的旧对象与配置再挂一次（回滚），原因写 meta.problem。
 *
 * 任何一步失败都**不碰** `plugins.json`（不 disableSilently）：用户装的东西不能被
 * 一次手滑的语法错误停掉。失败只写 meta.problem 并返回 false。
 *
 * 一次要换多行时走 {@link remountExternalPlugins}：它保证同一批只换一代。
 * @param identity - 行 id（首次挂载时的身份；不是文件路径）
 */
export async function remountExternalPlugin(identity: string): Promise<RemountResult> {
  const [result] = await remountExternalPlugins([identity])
  return result ?? { ok: false, generation: currentGeneration(), problem: '没有可重挂的行' }
}

/**
 * 批量重挂一组行：**一次调用只换代一次**（库包变更命中多行时用）。
 *
 * 为什么必须批量换一代：代数戳是解析结果的一部分，同一个库包在同一代里只解析出
 * 一个实例。如果两行各换各的代，它们会各自 import 一份新的库对象——模块级单例
 * （计数器、缓存、注册表）当场裂成两份。一次库变更命中两行时，两行必须落在同一个
 * 代数上，才能拿到同一个库。
 *
 * 失败语义与单行重挂完全一致（复用 {@link remountOne}）：
 *   - 先做前置检查（没挂载 / 内置 / 文件不在）——这些行不参与换代，返回失败；
 *   - 有任何一行值得重挂才 bump 一次，再逐行导入、校验、换 fiber；
 *   - 单行导入失败或挂载失败不拖累同批其余行，失败的行保留旧 fiber 与旧元数据。
 * @param identities - 行 id 列表（重复项自动去重；结果按入参顺序返回）
 * @returns 与 identities 一一对应的结果
 */
export async function remountExternalPlugins(
  identities: readonly string[],
): Promise<RemountResult[]> {
  const root = rootRef
  const unique: string[] = []
  for (const identity of identities) if (!unique.includes(identity)) unique.push(identity)
  /** 身份 → 结果；最后按入参顺序摊平，重复项拿到同一份。 */
  const results = new Map<string, RemountResult>()
  if (root === null) {
    for (const identity of unique) {
      results.set(identity, { ok: false, generation: currentGeneration(), problem: '插件运行时还没初始化' })
    }
    return identities.map((identity) => results.get(identity)!)
  }

  const table = mountedOf(root)
  /** 过了前置检查、真的需要重挂的行。 */
  const queue: Array<{ identity: string; file: string }> = []
  for (const identity of unique) {
    // 幂等判断（mountRow 用的那一处）只拦「首次挂载」；热重挂走的正是「已经挂上了」这一支。
    if (!table.has(identity)) {
      results.set(identity, {
        ok: false,
        generation: currentGeneration(),
        problem: '这一行当前没有挂载，热重挂只对已挂载的行生效',
      })
      continue
    }
    // 内置官方插件的对象随内核编译，磁盘上没有它的产物：没有新旧版本可言。
    if (builtinMounts.has(identity)) {
      results.set(identity, {
        ok: false,
        generation: currentGeneration(),
        problem: '内置插件随内核编译，没有可重挂的磁盘产物',
      })
      continue
    }
    const file = pluginSources.get(identity) ?? resolveEntryPath(identity)
    if (file === null || !existsSync(file)) {
      const problem = `找不到这一行的入口文件（${identity}），无法热重挂`
      const missing = getPluginMeta(identity)
      if (missing !== undefined) missing.problem = problem
      results.set(identity, { ok: false, generation: currentGeneration(), problem })
      continue
    }
    queue.push({ identity, file })
  }

  // 换代只做一次：同一批（例如一次库包变更命中的两行）落在同一个代数上。
  const generation = queue.length > 0 ? bumpGeneration() : currentGeneration()
  for (const item of queue) {
    try {
      results.set(item.identity, await remountOne(root, item.identity, item.file, generation))
    } catch (error) {
      // 单行出事不拖累同批其余行：记下这一行的失败，后面的照常换新。
      results.set(item.identity, {
        ok: false,
        generation,
        problem: `热重挂出错：${err(error)}（旧版本继续运行）`,
      })
    }
  }
  return identities.map((identity) => results.get(identity)!)
}

/**
 * 重挂一行（单行与批量路径共用）。代数由调用方给：这里不再自己 bump，
 * 否则批量重挂会变成「几行几个代」。
 * @param root - 内核 root
 * @param identity - 行 id
 * @param file - 已确认存在的入口文件
 * @param generation - 这一批用的代数
 */
async function remountOne(
  root: Context,
  identity: string,
  file: string,
  generation: number,
): Promise<RemountResult> {
  const table = mountedOf(root)
  const meta: PluginMeta = getPluginMeta(identity) ?? {
    file: identity,
    name: identity.replace(/\.js$/, ''),
    description: '',
    source: 'external',
  }
  const details = mountDetailsOf(root)
  const previous = details.get(identity)
  // 失败时连元数据一起还原：新模块可能已经把 name/apiVersion 改成新值，旧 fiber 却还在跑。
  const metaBefore: PluginMeta = { ...meta }
  // 行级 inject / 宿主配置沿用首次挂载那一份（重挂不是重新装配）。
  const inspected = await inspectPluginModule(file, identity, previous?.options ?? {}, meta)
  if (!inspected.ok) {
    restoreMeta(meta, metaBefore)
    meta.problem = `热重挂失败：${inspected.problem}（旧版本继续运行）`
    return { ok: false, generation, problem: meta.problem }
  }

  const { entry, mod, configForApply, inject, needsCompat } = inspected.value
  /** 插件运行时直接 `ctx.get` 过的服务名（诊断用）。 */
  const asked: string[] = []
  const pluginObject = {
    name: meta.name,
    inject: inject ?? ((entry.inject ?? mod.inject) as string[] | undefined),
    apply: (innerCtx: Context, config: Record<string, unknown>): unknown =>
      (entry.apply as (ctx: Context, config: Record<string, unknown>) => unknown)(
        needsCompat ? compatCtx(innerCtx, identity, asked) : innerCtx,
        config,
      ),
  }
  // 导入与校验都过了，才动旧 fiber：cordis 里两份同时 provide 同一个服务会直接失败，
  // 所以顺序只能是「先卸再挂」。
  await unmountExternalPlugin(identity)
  try {
    const fiber = root.plugin(pluginObject, configForApply)
    await fiber
    table.set(identity, fiber)
    details.set(identity, { plugin: pluginObject, config: configForApply, options: previous?.options ?? {} })
    meta.problem = undefined
    return { ok: true, generation }
  } catch (error) {
    const failure = `新版本挂载失败：${err(error)}`
    let restored = false
    if (previous !== undefined) {
      try {
        const fiber = root.plugin(previous.plugin, previous.config)
        await fiber
        table.set(identity, fiber)
        restored = true
      } catch {
        // 旧版本也起不来：下面的文案会说清「没能恢复」，不留一句假安慰。
      }
    }
    restoreMeta(meta, metaBefore)
    meta.problem = restored
      ? `${failure}；已回滚到旧版本（${identity} 仍在运行）`
      : `${failure}；旧版本也没能恢复`
    return { ok: false, generation, problem: meta.problem }
  }
}

/**
 * 把元数据还原成热重挂之前的样子。
 *
 * `Object.assign` 只覆盖、不删除：新模块可能新增过 apiVersion / clientCapabilities，
 * 不先删掉新键的话，插件中心会显示一份并不在跑的声明。
 */
function restoreMeta(meta: PluginMeta, before: PluginMeta): void {
  for (const key of Object.keys(meta) as Array<keyof PluginMeta>) {
    if (!(key in before)) delete (meta as unknown as Record<string, unknown>)[key]
  }
  Object.assign(meta, before)
}

/**
 * 当前已挂载、且从磁盘加载的行（行 id → 入口文件）。功能包热更轮询用。
 *
 * 内置插件（对象在内存里）与已卸载的行不在名单里；组合包默认关的行虽然登记了来源，
 * 但没挂载，也不该被轮询。
 */
export function listMountedPluginSources(): Array<{ identity: string; file: string }> {
  const root = rootRef
  if (root === null) return []
  const table = mountedOf(root)
  const sources: Array<{ identity: string; file: string }> = []
  for (const [identity, file] of pluginSources) {
    if (!table.has(identity)) continue
    if (builtinMounts.has(identity)) continue
    sources.push({ identity, file })
  }
  return sources
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
        // 先问 cordis（原样转发）；真没有就看服务桥有没有**只读**的对应物。
        // 为什么在这里兜底而不是 ctx.provide：桥是按插件现造的视图（每次 get 拿到的是
        // 同一份磁盘状态的读口，不是全局单例），provide 出去会变成所有插件共享一个可变对象。
        return (name: unknown): unknown => {
          if (typeof name === 'string') asked.push(name)
          const direct = (target.get as (key: string) => unknown)(String(name))
          if (direct !== undefined) return direct
          return compatServiceOf(String(name))
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

/** 卸载外部插件（未挂载时静默；只动当前 root 上的那份）。 */
export async function unmountExternalPlugin(file: string): Promise<void> {
  const current = rootRef
  if (current === null) return
  const table = mountedOf(current)
  const fiber = table.get(file)
  if (fiber === undefined) return
  table.delete(file)
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
    // 内置官方插件没有磁盘文件，登记过的对象直接挂；组合包的行按行 id 找回它原来那个入口；
    // 其余（外部单文件插件）仍按 ~/.dsc/plugins/ 里的文件找。
    const entryFile = builtinMounts.has(basename(file))
      ? file
      : (pluginSources.get(file) ?? resolveEntryPath(file))
    if (entryFile === null) return { ok: false, problem: `找不到插件文件 ${file}（检查 ~/.dsc/plugins/）` }
    // 身份 = 行 id：文件与 id 不同时才显式传，单文件插件仍走文件名（兼容现状）。
    const ok = await mountExternalPlugin(entryFile, file === basename(entryFile) ? undefined : file)
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
 * 实现在 `core/profile-dir`：界面产物表也要用它，放这里会把整个宿主装载器拖进界面壳的
 * 编译单元。这里转出保持既有 import 不变。
 */
export { activeProfileDir }

/** 组合包挂载的额外选项。 */
export interface BundleMountOptions {
  /**
   * 应用安装目录（运行中 Pneuma 的 package.json 所在目录）。
   *
   * 缺省按构建产物位置推算（{@link APP_INSTALL_DIR}）。自检把它指到临时目录，
   * 免得为了造「应用侧也有一份包」往真 node_modules 里塞夹具。
   */
  appDir?: string
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
 * @param options - 应用锚点（自检用；缺省按构建产物位置推算）
 * @returns 挂载失败清单（与 mountAllExternalPlugins 同形）+ 告警
 * @throws {Error} 行 id 重复、同一包名解析出两个物理目录（都是配置错误，带着跑只会更糟）
 */
export async function mountBundlePlugins(
  root: Context,
  profileDir: string,
  options: BundleMountOptions = {},
): Promise<{ failures: PluginMountFailure[]; warnings: string[] }> {
  initPluginRuntime(root)
  const appDir = options.appDir ?? APP_INSTALL_DIR
  // 组合包的插件代码在 profile 自己的 node_modules 里，它们 import @pneuma/runtime 与
  // @deepseek-ai/* 时要把这个目录也当成「允许重定向的插件根」——只认 ~/.dsc/plugins/ 的话，
  // 真装一个组合包会在 import 阶段就 ERR_MODULE_NOT_FOUND。
  // 无条件注册：@pneuma/runtime 的重定向与 dsh-compat 开关无关。
  ensureResolveHook([join(profileDir, 'node_modules')], appDir)
  setResolveHookCompat(isPluginEnabled('dsh-compat'))
  const profile = readProfile(profileDir)
  const layers: PatchLayer[] = []
  const warnings: string[] = []
  /** 每一层是哪个包的（解析相对路径时按它来）。 */
  const layerOwner = new Map<string, string>()
  /** 包名 → 读盘结果（挂上之后要拿它的 `pneuma.client` 给插件中心看）。 */
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
  // 行 id 重复是配置错误：dsh 那边静默让后写覆盖前写，两个来源抢一个身份，出问题查不出来。
  if (applied.duplicates.length > 0) throw duplicateRowsError(applied.duplicates, '组合包')

  const failures: PluginMountFailure[] = []
  const ctx: RowMountContext = {
    profileDir,
    appDir,
    overrideDir: profileDir,
    where: '组合包',
    layerOwner,
    ownerOf,
    bundleInfoOf,
    hostConfig: undefined,
    exemptions: profile.exemptions,
    warnings,
    root,
    language: languageOfConfigFile(activeConfigFile()),
  }
  for (const row of applied.rows) {
    const failure = await mountRow(row, ctx)
    if (failure !== null) failures.push(failure)
  }
  return { failures, warnings }
}

/** 本进程的界面形态。 */
export type ApplicationSurface = 'tui' | 'headless' | 'none'

/**
 * 界面形态 → 不挂的行 id。
 *
 * **这是「界面形态决定哪些行不挂」的唯一出处**：kernel / boot / headless 只把 surface
 * 传进来，不许各自再写一遍判断；patch 里也不表达这件事（同一份 patch 要能同时喂给三种壳）。
 * 未传 surface 时这张表不生效（都挂），留给自检与单进程调试。
 */
export const SURFACE_ROW_SKIPS: Readonly<Record<ApplicationSurface, readonly string[]>> = {
  // 终端界面：交互式宿主那条 stdio 行不该起来（它会把 stdio 抢走）
  tui: ['host-stdio'],
  // 无界面（桌面宿主）：TUI 行不该起来
  headless: ['tui'],
  // 不传 surface 的默认值：三个「界面/外部连接」行都不挂。
  //
  // 为什么要这个默认值：探针会直接 createKernel。TUI 行一挂就起 ink 渲染与定时器，
  // 进程不退出；host-stdio 会抢 stdin。以前这两行由入口挂，探针天然没有；
  // 包化之后必须由 surface 表达「这是测试宿主」。
  none: ['tui', 'host-stdio', 'remote'],
}

/** {@link mountApplicationRows} 的选项。 */
export interface ApplicationRowsOptions {
  /** 应用安装目录；缺省 {@link APP_INSTALL_DIR}。 */
  appDir?: string
  /** 本进程的界面形态，决定 {@link SURFACE_ROW_SKIPS} 里哪些行跳过；不传 = 'none'。 */
  surface?: ApplicationSurface
  /**
   * 由宿主直接组装的配置：键是行 id，值**整份替代** `plugins.json` 里的 config。
   *
   * 不做深合并——宿主说了算（providers、resume 路径、cwd 这些磁盘上本来就没有）。
   */
  hostConfig?: Record<string, unknown>
  /**
   * 包级覆盖的锚点（用户 profile 目录）；缺省读 {@link activeProfileDir}，传 `null` 表示不查。
   *
   * 自检要造「profile 里有覆盖版」又不想动真实 profile 时用这个入口。
   */
  overrideDir?: string | null
  /**
   * 版本闸的豁免名单（包名）；缺省读当前 profile 的 `compatibility.json`。
   *
   * 自检要造「要求下一代契约的包」又不想铺 profile，所以留了这个入口。
   */
  exemptions?: readonly string[]
}

/**
 * 一个 profile 里登记豁免的包名；没有 profile 就是空名单。
 *
 * 每次挂应用自带行现读一次：内核只在启动时调一次，省不到什么，反而会和
 * `numa plugin add` 刚写完的 compatibility.json 漂移。
 * @param dir - profile 目录（null = 没有 profile）
 */
function profileExemptionsOf(dir: string | null): readonly string[] {
  if (dir === null || !existsSync(join(dir, 'package.json'))) return []
  return readProfile(dir).exemptions
}

/**
 * 挂「应用自带行」：`<appDir>/lib/node_modules/@pneuma/base/cordis.patch.yml` 里的 insert 行。
 *
 * 内核自己的 llm / session / tools 这些行将来都从这份 patch 来，走的是与 profile 组合包
 * **同一条**「解析 → 身份 → 挂载」路径，差别只有三处：不叠 profile 层；界面形态决定跳过
 * 哪些行；已经挂上的身份跳过（这个入口会被重复调用）。
 *
 * 「文件不存在」是 P3 期间的正常状态（base 包还没生成）：不报错，返回空数组，记一条 warning。
 * @param root - 内核 root
 * @param options - 应用安装目录与界面形态
 * @returns 挂载失败清单（与 mountAllExternalPlugins 同形）
 * @throws {Error} 行 id 重复、同一包名解析出两个物理目录、patch 含 `!!js`（都是配置错误）
 */
export async function mountApplicationRows(
  root: Context,
  options: ApplicationRowsOptions = {},
): Promise<PluginMountFailure[]> {
  initPluginRuntime(root)
  const appDir = options.appDir ?? APP_INSTALL_DIR
  // 代数戳的落点：应用自带包的真实文件住在 <应用根>/lib/packages/**。钩子按 appRootHint
  // 也能推出来，但自检把 appDir 指到临时目录时它推不到——显式登记一次，两条路都成立。
  const appPackagesDir = join(appDir, 'lib', 'packages')
  if (existsSync(appPackagesDir)) registerGenerationRoot(appPackagesDir)
  // 库包没有行、不会走 mountRow，它的桩目录也就没人登记——单独补一遍。
  registerLibraryGenerationRoots(appDir)
  const baseDir = join(appDir, 'lib', 'node_modules', '@pneuma', 'base')
  const patchFile = join(baseDir, 'cordis.patch.yml')
  if (!existsSync(patchFile)) {
    warnApplicationRow(root, `应用自带的插件清单还没生成（${patchFile} 不存在），这次不挂任何内置行`)
    return []
  }
  // 读失败（!!js / 坏 YAML）照常抛：构建产物写错了，带着跑只会更糟。
  const layer = readPatchFile(patchFile, '@pneuma/base')
  if (layer === null) return []

  const applied = applyPatchLayers([], [layer])
  for (const warning of applied.warnings) warnApplicationRow(root, `应用自带行：${warning}`)
  if (applied.duplicates.length > 0) throw duplicateRowsError(applied.duplicates, '应用自带行')

  // 不传 surface = 'none'：探针/自检直接 createKernel 时不该把 TUI 或 stdio 行拉起来。
  const surface = options.surface ?? 'none'
  const skipped = new Set(SURFACE_ROW_SKIPS[surface])
  const warnings: string[] = []
  // 应用自带行的相对路径按 base 包算；包级覆盖去用户 profile 里找。
  // 两条解析链必须分开：混用会让「./x」这种相对路径跑进 profile，或者覆盖永远不生效。
  const overrideDir = options.overrideDir === undefined ? activeProfileDir() : options.overrideDir
  // profile 里的覆盖版会 import @pneuma/runtime，那个说明符要能重定向到应用内那一份。
  if (overrideDir !== null) ensureResolveHook([join(overrideDir, 'node_modules')], appDir)
  const ctx: RowMountContext = {
    profileDir: baseDir,
    appDir,
    overrideDir,
    where: '应用自带行',
    layerOwner: new Map([[layer.label, baseDir]]),
    ownerOf: new Map(),
    bundleInfoOf: new Map(),
    hostConfig: options.hostConfig,
    // 覆盖版是 profile 给的，豁免名单也读同一份 profile（不能各读一个目录）。
    exemptions: options.exemptions ?? profileExemptionsOf(overrideDir),
    warnings,
    root,
    language: languageOfConfigFile(activeConfigFile()),
  }
  const failures: PluginMountFailure[] = []
  for (const row of applied.rows) {
    if (skipped !== undefined && typeof row.id === 'string' && skipped.has(row.id)) continue
    const failure = await mountRow(row, ctx)
    if (failure !== null) failures.push(failure)
  }
  for (const warning of warnings) warnApplicationRow(root, `应用自带行：${warning}`)
  // 热更轮询在这里拉起：内核装配每次都走这个入口，「默认开」不必宿主再记一条调用。
  // 失败不影响启动（探针/自检里通常是空转：夹具文件在挂载后不再变化）。
  await startPluginHotUpdate(root, appDir)
  return failures
}

/**
 * 启动功能包热更轮询（幂等，`DSC_HOT=0` 关闭）。
 *
 * 为什么由加载器自己拉起而不是内核显式调用：{@link mountApplicationRows} 是每次装配
 * 的必经之路（连探针都走它），默认开就落在这一处；宿主想自己控制时调
 * `plugin-watch` 的 `startPluginWatch` 也是幂等的。
 *
 * `appDir` 要跟着传下去：轮询器要靠它读「哪些是库包」（`<appDir>/lib/node_modules/@pneuma`），
 * 自检把应用指到临时目录时不能去扫真实安装目录。
 *
 * 动态 import 而不是静态：plugin-watch 反过来要用本模块的
 * `listMountedPluginSources` / `remountExternalPlugin`，静态 import 会成环。
 */
async function startPluginHotUpdate(root: Context, appDir: string): Promise<void> {
  if (process.env['DSC_HOT'] === '0') return
  try {
    const watch = await import('./plugin-watch.js')
    watch.startPluginWatch(root, { appDir })
  } catch (error) {
    warnApplicationRow(root, `功能包热更没起来：${err(error)}（不影响启动）`)
  }
}

/** 应用自带行的告警走对话流；没有 transcript 的宿主（自检里的裸 Context）就只丢一条。 */
function warnApplicationRow(root: Context, text: string): void {
  const transcript = root.get('transcript') as { system?: (text: string) => void } | undefined
  if (transcript !== undefined && typeof transcript.system === 'function') transcript.system(text)
}

/** 挂一行的上下文：组合包与应用自带行的差异都收在这里。 */
interface RowMountContext {
  /** 解析相对路径与「profile 锚点」用的目录。 */
  profileDir: string
  /** 应用安装目录。 */
  appDir: string
  /** 包级覆盖的锚点（用户 profile）；null = 这些行不接受 profile 覆盖。 */
  overrideDir: string | null
  /** 告警文案里怎么称呼这批行（组合包 / 应用自带行）。 */
  where: string
  /** 层标签 → 包目录（相对路径按写它的那层算）。 */
  layerOwner: ReadonlyMap<string, string>
  /** 行 id → 组合包名（插件中心显示来源）。 */
  ownerOf: ReadonlyMap<string, string>
  /** 包名 → 读盘结果（界面能力声明）。 */
  bundleInfoOf: ReadonlyMap<string, BundleInfo>
  /** 宿主直给的配置（键是行 id）；没命中就走 plugins.json。 */
  hostConfig: Readonly<Record<string, unknown>> | undefined
  /** compatibility.json 里登记过豁免的包名（版本闸不满足也照挂）。 */
  exemptions: readonly string[]
  /** 收集要写进对话流的告警。 */
  warnings: string[]
  /** 这份行属于哪个 root：已挂身份按 root 记（一个进程可以有多个内核）。 */
  root: Context
  /**
   * 显示语言（`config.yaml` 的 `language`）：插件中心那两行字按它取译本。
   *
   * 一批行只读一次配置：一次启动要挂几十行，逐行读盘没有意义。
   */
  language: string
}

/**
 * 挂 patch 里的一行：解析目标 → 登记目录 → 按身份挂载。
 *
 * 组合包与应用自带行走同一条路，差异由 {@link RowMountContext} 收口——
 * 以后再加一种「行从哪来」时只补上下文，不要再把这段抄一遍。
 * @param row - patch 里的行
 * @param ctx - 挂载上下文
 * @returns 失败信息；挂上或被跳过给 null
 */
async function mountRow(row: PluginRow, ctx: RowMountContext): Promise<PluginMountFailure | null> {
  const target = typeof row.name === 'string' ? row.name : undefined
  if (target === undefined) {
    ctx.warnings.push(`${ctx.where}里有一行没有 name（不知道加载什么），已跳过`)
    return null
  }
  const resolved = resolveBundleTarget(ctx.profileDir, target, ctx.layerOwner, ctx.appDir, ctx.overrideDir)
  if (resolved === null) {
    // 缺包不是「静默跳过」：目录里要留一条带 problem 的记录，插件中心看得见，
    // 内核也会把它当失败条目报出来（契约 §5）。
    const rowId = typeof row.id === 'string' && row.id !== '' ? row.id : target
    const problem = `${ctx.where}里的「${target}」找不到对应文件（包没装，或者 exports 里没有这一路）`
    registerPluginMeta({ file: rowId, name: rowId, description: '', source: 'external', problem })
    ctx.warnings.push(problem + '，已跳过')
    return { file: rowId, name: rowId, problem }
  }
  ctx.warnings.push(...resolved.warnings)
  const file = resolved.file
  // 身份 = 行 id（契约 §4）；没有 id 的行退回文件名，老行为不变。
  const rowId = typeof row.id === 'string' && row.id !== '' ? row.id : basename(file)
  // 幂等：已经挂上的身份直接返回（应用自带行重复调用不该再挂一份）
  if (mountedOf(ctx.root).has(rowId)) return null
  const owner = typeof row.id === 'string' ? ctx.ownerOf.get(row.id) : undefined
  const found = manifestOfFile(file, ctx.profileDir)
  const manifest = found?.manifest ?? null
  const pneuma = pneumaFieldsOf(manifest)
  // 给用户看的两行字走译本：locale/en.json 优先，没译过就回落 pneuma.title/description。
  const display = pluginDisplayOf(manifest, found?.dir ?? dirname(file), ctx.language)
  const rowName = display.title ?? basename(file).replace(/\.js$/, '')
  // 版本闸（契约 §7）：判的是**这一行实际解析到的包**，不是组合包自己写的要求——
  // overridable 的行会被 profile 里的副本换掉，换上来那份要求哪一代契约只有它自己知道。
  const engineProblem = pneumaEnginesProblem(manifest)
  const exempt = engineProblem !== null && isEngineExempt(manifest, target, ctx.exemptions)
  const skippedByGate = engineProblem !== null && !exempt
  registerPluginSource(rowId, file)
  // 旧键（= 文件名）登记进来：0.8.1 的 plugins.json 按文件名写，双查才读得到老配置。
  registerPluginAlias(rowId, basename(file))
  // 目录先登记：默认关的行也要在插件中心看得见（只是不 import、不挂载）。
  registerPluginMeta({
    file: rowId,
    name: rowName,
    description: display.description ?? '',
    source: 'external',
    ...(pneuma.settingsSection === undefined ? {} : { settingsSection: pneuma.settingsSection }),
    ...(row.disabled === true ? { defaultDisabled: true } : {}),
    ...(owner === undefined ? {} : { bundle: owner }),
    ...(skippedByGate ? { problem: String(engineProblem) } : {}),
  })
  // 开关：plugins.json 里有这条记录就按记录，没有才按行的 disabled（行只是默认值）。
  if (!isPluginEnabled(rowId)) return null
  // 闸放在开关之后：用户已经关掉的行不该每次启动都报一条失败。
  if (exempt) ctx.warnings.push(`${ctx.where}：「${rowName}」的版本闸没过（${engineProblem}），已在 compatibility.json 登记豁免，照常挂载`)
  if (skippedByGate) {
    const problem = `${engineProblem}；这一行已跳过（在 profile 的 compatibility.json 里登记豁免可以强行启用）`
    ctx.warnings.push(`${ctx.where}：「${rowName}」的版本闸没过：${problem}`)
    return { file: rowId, name: rowName, problem }
  }
  // 行上的 inject 盖过模块自带的（依赖关系属于装配，不属于包）；
  // 宿主直给的配置整份替代 plugins.json（没命中才读磁盘）。
  const hostConfig = ctx.hostConfig === undefined ? undefined : ctx.hostConfig[rowId]
  const ok = await mountExternalPlugin(file, rowId, {
    inject: rowInjectOf(row),
    native: typeof row.name === 'string' && row.name.startsWith('@pneuma/'),
    ...(hostConfig !== null && typeof hostConfig === 'object' && !Array.isArray(hostConfig)
      ? { config: hostConfig as Record<string, unknown> }
      : {}),
  })
  const meta = getPluginMeta(rowId)
  if (meta !== undefined) {
    // package.json 是插件中心的显示口径；模块导出只作缺省（外部单文件插件没有清单）。
    // 译本算在「清单」这一侧：它和清单同源，模块导出的那两行字不翻译。
    if (display.title !== undefined) meta.name = display.title
    if (display.description !== undefined) meta.description = display.description
    if (pneuma.settingsSection !== undefined) meta.settingsSection = pneuma.settingsSection
    if (owner !== undefined) meta.bundle = owner
    // 有的包把界面能力写在 package.json 的 pneuma.client（不在模块导出里）。
    // 只列不加载，但要列得出来，否则用户在插件中心看不到「它还想改界面」。
    //
    // 例外：platform = 'pneuma' 的是**我们自己会加载**的界面半（见 core/ui-bundles 的
    // discoverPackageUiArtifacts）。把它列成「dsh 客户端插件 · 只列不加载」是假话。
    const declared = owner === undefined ? undefined : ctx.bundleInfoOf.get(owner)?.client
    const platform = (declared as { platform?: unknown } | undefined)?.platform
    if (meta.clientCapabilities === undefined && declared !== undefined && platform !== 'pneuma') {
      meta.clientCapabilities = clientCapabilitiesOf(declared)
    }
  }
  if (!ok && meta?.problem !== undefined) return { file: rowId, name: meta.name, problem: meta.problem }
  return null
}

/**
 * 行 id 重复的启动失败文案（组合包与应用自带行共用）。
 * @param duplicates - 重复清单
 * @param where - 哪一批行（组合包 / 应用自带行）
 */
function duplicateRowsError(duplicates: readonly PatchDuplicate[], where: string): Error {
  const detail = duplicates.map((item) => `「${item.id}」分别来自 ${item.first} 与 ${item.second}`).join('；')
  return new Error(
    `${where}的行 id 重复：${detail}。行 id 是运行时身份（开关、配置、设置分区都按它），` +
      '同一个 id 只能出现一次，请改掉重复的那一行。',
  )
}

/** 一次行目标解析的结果。 */
interface RowTarget {
  /** 入口文件的绝对路径。 */
  file: string
  /** 解析过程中要说给用户听的话（pinned 包被 profile 副本让路之类）。 */
  warnings: string[]
}

/**
 * 一个包的解析口径（`pneuma.resolution`）。
 *
 * 只认 `pinned`，其余（含 dsh.* 包与没写的）都是 `overridable`——缺省值必须是可覆盖，
 * 否则 profile 里装的新版本永远不生效。
 */
type ResolutionPolicy = 'pinned' | 'overridable'

/**
 * 全进程一张解析表：包名 → 已选定的物理目录。
 *
 * 同一个包名第二次解析出另一个目录就启动失败：两份实体 = 两份服务实例，出问题只会表现成
 * 「一边的配置改了、另一边没动」。pinned / overridable 的「两边都有」由口径裁决，不算冲突。
 */
const resolvedDirs = new Map<string, string>()

/** 每个锚点一个 `createRequire`（解析起点固定，不必每次重建）。 */
const requires = new Map<string, ReturnType<typeof createRequire>>()

/** 解析一个行目标用的锚点。 */
interface Anchor {
  /** 诊断里怎么称呼它（应用安装目录 / profile）。 */
  label: string
  /** `createRequire` 的起点文件（不必存在，只用它的目录做解析起点）。 */
  requireFrom: string
  /** 这个锚点上该包的实际目录（不存在给 null）。 */
  pkgDir: string | null
  /** Node 解析不出来时，退回「猜入口」的 node_modules 目录。 */
  lookup: string
}

/** 物理目录（解开 pnpm 的软链）；解不开就用原路径。 */
function physicalDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

/**
 * 把行里的 `name` 解析成文件路径。
 *
 * 三种写法：绝对路径、以 `./` `../` 开头（相对 profile 目录）、或包名。包名**交给
 * Node 自己解析**（`createRequire(锚点/package.json).resolve(name)`）：`pkg/sub` 因此
 * 走包自己的 `exports` 子路径、conditions 与通配——这些手写展开一定会漏。
 * @param profileDir - 相对路径的基准目录（组合包 = profile，应用自带行 = base 包）
 * @param target - 行上的 name
 * @param layerOwner - 层标签 → 包目录（相对路径按写它的那层算）
 * @param appDir - 应用安装目录
 * @param overrideDir - 包级覆盖的锚点（用户 profile）；null = 不查 profile
 * @returns 入口文件 + 告警；解析不出来给 null（调用方记一条「缺包」告警并跳过该行）
 * @throws {Error} 同一包名解析出两个物理目录
 */
function resolveBundleTarget(
  profileDir: string,
  target: string,
  layerOwner: ReadonlyMap<string, string>,
  appDir: string,
  overrideDir: string | null,
): RowTarget | null {
  if (isAbsolute(target)) {
    const file = entryFileOf(target)
    return file === null ? null : { file, warnings: [] }
  }
  if (target.startsWith('./') || target.startsWith('../')) {
    // 相对路径按「哪一层的 patch 写的」算：bundle 的 patch 相对它自己的包目录。
    const owner = [...layerOwner.values()].find((dir) => existsSync(join(dir, target)))
    const candidate = owner === undefined ? join(profileDir, target) : join(owner, target)
    const file = entryFileOf(candidate)
    return file === null ? null : { file, warnings: [] }
  }
  return resolvePackageRow(profileDir, target, appDir, overrideDir)
}

/**
 * 按包名解析一行：先定口径（pinned / overridable），再按顺序在两个锚点上解析。
 *
 * 应用侧的包住在 `<应用根>/lib/node_modules/`（运行时适配包与功能包同一层）。两边都有
 * 同名包时由包自己的 `pneuma.resolution` 裁决，不报冲突；只有「同一个包名在一次启动里
 * 被解析成两个目录」才失败。
 */
function resolvePackageRow(
  profileDir: string,
  target: string,
  appDir: string,
  overrideDir: string | null,
): RowTarget | null {
  const pkgName = packageNameOf(target)
  if (pkgName === null) return null
  const parts = pkgName.split('/')
  // 覆盖锚点与「相对路径基准」不是一回事：应用自带行的相对路径按 base 包算，
  // 但它的包级覆盖要去用户 profile 里找（契约 §5：overridable 的用户副本优先）。
  const overrideRoot = overrideDir ?? profileDir
  const profilePkgDir = join(overrideRoot, 'node_modules', ...parts)
  const appPkgDir = appPackageDir(appDir, parts)
  const profileManifest = existsSync(profilePkgDir) ? readJsonObject(join(profilePkgDir, 'package.json')) : null
  const appManifest = appPkgDir === null ? null : readJsonObject(join(appPkgDir, 'package.json'))
  // 两份都在时先看应用那份：pinned 的那一份才该决定口径。
  const policy = resolutionOf(appManifest ?? profileManifest)
  const profileAnchor: Anchor = {
    label: 'profile',
    requireFrom: join(overrideRoot, 'package.json'),
    pkgDir: existsSync(profilePkgDir) ? profilePkgDir : null,
    lookup: join(overrideRoot, 'node_modules'),
  }
  const appAnchor: Anchor = {
    label: '应用安装目录',
    requireFrom: join(appDir, 'lib', 'node_modules', '_.js'),
    pkgDir: appPkgDir,
    lookup: join(appDir, 'lib', 'node_modules'),
  }
  const anchors = policy === 'pinned' ? [appAnchor, profileAnchor] : [profileAnchor, appAnchor]

  for (const anchor of anchors) {
    if (anchor.pkgDir === null) continue
    const file = entryFromAnchor(anchor, target)
    if (file === null) continue
    rememberResolvedDir(pkgName, anchor.pkgDir)
    const warnings: string[] = []
    // pinned 包在 profile 里也有同名副本：用应用那份，并把「你不生效的那份在哪」说出来。
    if (policy === 'pinned' && anchor === appAnchor && profileAnchor.pkgDir !== null) {
      warnings.push(
        `「${pkgName}」声明为 pinned：profile 里的同名副本（${profilePkgDir}）不生效，` +
          `用的是应用安装目录里的 ${String(anchor.pkgDir)}`,
      )
    }
    return { file, warnings }
  }
  return null
}

/** 应用侧的包目录：优先 `<应用根>/lib/node_modules/<包名>`，再退回仓库根的 node_modules。 */
function appPackageDir(appDir: string, parts: readonly string[]): string | null {
  for (const root of [join(appDir, 'lib', 'node_modules'), join(appDir, 'node_modules')]) {
    const candidate = join(root, ...parts)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 从锚点解析一个行目标；Node 解析不出来再退回原来的「猜入口」逻辑。 */
function entryFromAnchor(anchor: Anchor, target: string): string | null {
  try {
    let require = requires.get(anchor.requireFrom)
    if (require === undefined) {
      require = createRequire(anchor.requireFrom)
      requires.set(anchor.requireFrom, require)
    }
    // 交给 Node 自己解析：exports 子路径、conditions、通配都由它算，不手写展开。
    return require.resolve(target)
  } catch {
    // Node 解析不出来（老包没有 exports，或只写了目录）→ 退回下面的入口猜测
  }
  return entryFileOf(join(anchor.lookup, ...target.split('/')))
}

/**
 * 登记一个包名的物理目录；第二次解析出别的目录就抛错。
 * @param pkgName - 包名
 * @param dir - 这次选定的包目录
 */
function rememberResolvedDir(pkgName: string, dir: string): void {
  const physical = physicalDir(dir)
  const previous = resolvedDirs.get(pkgName)
  if (previous === undefined) {
    resolvedDirs.set(pkgName, physical)
    return
  }
  if (previous === physical) return
  throw new Error(
    `包「${pkgName}」在这次启动里解析出两个不同的目录：${previous} 与 ${physical}。` +
      '同一个包名只能有一份实体（否则会挂出两份服务实例），请检查 profile 与应用安装目录里是不是各装了一份。',
  )
}

/** 从包名/子路径里取出包名（`@scope/name/sub` → `@scope/name`）。 */
function packageNameOf(target: string): string | null {
  if (target === '' || target.startsWith('.') || isAbsolute(target)) return null
  const parts = target.split('/')
  if (target.startsWith('@')) return parts.length >= 2 && parts[1] !== '' ? `${parts[0]}/${parts[1]}` : null
  return parts[0] === '' ? null : parts[0]
}

/** 包清单里的 `pneuma.resolution`（缺省 overridable；`dsh.*` 包没这个字段，同样是 overridable）。 */
function resolutionOf(manifest: Record<string, unknown> | null): ResolutionPolicy {
  const raw = manifest?.['pneuma']
  if (raw === null || typeof raw !== 'object') return 'overridable'
  return (raw as Record<string, unknown>)['resolution'] === 'pinned' ? 'pinned' : 'overridable'
}

/**
 * 这一行的包名在不在版本闸豁免名单里（profile 的 `compatibility.json`）。
 *
 * 包名优先取行目标（`@p2/foo/sub` → `@p2/foo`）；相对路径的行没有包名，
 * 退回它自己 package.json 的 `name`。
 * @param manifest - 行的包清单（可能没有）
 * @param target - 行上的 name
 * @param exemptions - 豁免包名
 */
function isEngineExempt(
  manifest: Record<string, unknown> | null,
  target: string,
  exemptions: readonly string[],
): boolean {
  if (exemptions.length === 0) return false
  const declared = manifest?.['name']
  const pkgName = packageNameOf(target) ?? (typeof declared === 'string' && declared !== '' ? declared : null)
  return pkgName !== null && exemptions.includes(pkgName)
}

/** 插件中心要显示的那几项（`pneuma.title/description/settingsSection`）。 */
interface PneumaFields {
  title?: string
  description?: string
  settingsSection?: string
}

/** 读包清单里的 `pneuma` 展示字段（不加载代码也能列进插件中心）。 */
function pneumaFieldsOf(manifest: Record<string, unknown> | null): PneumaFields {
  const raw = manifest?.['pneuma']
  if (raw === null || typeof raw !== 'object') return {}
  const record = raw as Record<string, unknown>
  const pick = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  return { title: pick('title'), description: pick('description'), settingsSection: pick('settingsSection') }
}

/**
 * 从入口文件往上找它所属包的 package.json（最多 8 层，走到 profile 目录为止）。
 *
 * 绝对/相对路径的行没有包名可查，但它们的展示字段仍写在最近的 package.json 里。
 * 目录一起返回：清单里的两行字要按**这个目录**去查 `locale/<语言>.json`。
 * @returns `{ dir, manifest }`；没找到给 null
 */
function manifestOfFile(file: string, stopAt: string): { dir: string; manifest: Record<string, unknown> } | null {
  let dir = dirname(file)
  const stop = resolve(stopAt)
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = readJsonObject(join(dir, 'package.json'))
    if (manifest !== null) return { dir, manifest }
    if (resolve(dir) === stop) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * 行上的 `inject`（字符串或数组）；没写给 undefined = 用模块自带的那份。
 * @param row - patch 行
 */
function rowInjectOf(row: PluginRow): readonly string[] | undefined {
  const raw = row['inject']
  if (typeof raw === 'string') return raw === '' ? [] : [raw]
  if (!Array.isArray(raw)) return undefined
  return raw.filter((name): name is string => typeof name === 'string' && name !== '')
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
