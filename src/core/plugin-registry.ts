/**
 * 插件注册表：目录快照 + 条目树持久化 + 热挂载（runtime 插件与 host 装配层共享）。
 *
 * - 目录（catalog）：宿主装配时注册——内置插件集 + 外部插件扫描结果；
 * - 条目树（~/.dsc/plugins.json）：`{ version, entries: [{ file, disabled, config }] }`，
 *   参照 dsh 的声明式装配（dsh 为 cordis.patch.yml）。兼容旧版
 *   `{ disabled: string[] }` 格式（读取时自动转换）；
 * - 热挂载：外部插件经 cordis `root.plugin(mod, config)` 挂载为独立 Fiber，
 *   启停 = Fiber.dispose() / 重新挂载，无需重启宿主（详见 core/plugin-loader.ts）。
 *
 * @module dsc/core/plugin-registry
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginInfoView } from '../contract.js'
import { dscPath } from './path-policy.js'

/** 目录里的一项（不含运行时 enabled——它由条目树决定）。 */
export interface PluginMeta {
  /** 开关键：外部插件为文件名，内置为插件名。 */
  file: string
  name: string
  description: string
  source: 'builtin' | 'external'
  /** 插件声明的内核 API 版本；未声明时 undefined。 */
  apiVersion?: number
  /** 加载失败/被自动停用的原因（回滚说明），正常时 undefined。 */
  problem?: string
  /**
   * true = 内置但可停用（官方插件，例如智能体团队、电脑操作）。
   * 缺省 false 且 source='builtin' 的就是运行内核，不提供开关。
   */
  toggleable?: boolean
  /**
   * 这个插件贡献的设置分区 id；插件中心据此在详情页渲染它的配置表单。
   * 内置插件在 kernel 清单里声明；外部插件用 `export const settingsSection` 声明。
   */
  settingsSection?: string
  /**
   * true = 条目树还没有这条记录时，默认按「停用」处理。
   * 危险一点的官方插件（电脑操作）用它，装完不主动拿到桌面控制权。
   */
  defaultDisabled?: boolean
  /**
   * 这个插件来自哪个组合包（bundle）。单文件插件没有这一项。
   * 插件中心据此显示「来自组合包 X」，方便用户知道该去哪卸载。
   */
  bundle?: string
  /**
   * 这个插件声明的 **dsh 客户端（界面）能力**，只列不加载。
   *
   * 为什么只列：dsh 的 `dsh.client` 插件要一份 dsh 自己的客户端运行时（cordis 客户端
   * 服务 + 平台模块表），Pneuma 的界面壳是另一套契约。真加载等于在页面里跑第二个框架，
   * 与更严的信任模型冲突。所以这里如实告诉用户「这个插件想让界面做什么」，
   * 但不执行它的界面代码。
   */
  clientCapabilities?: string[]
}

const catalog = new Map<string, PluginMeta>()

/** 注册（或覆盖）一条插件元数据。 */
export function registerPluginMeta(meta: PluginMeta): void {
  catalog.set(meta.file, meta)
}

/** 读取某文件的元数据（无则 undefined）。 */
export function getPluginMeta(file: string): PluginMeta | undefined {
  return catalog.get(file)
}

/**
 * 内核插件 API 版本：外部插件用 `export const apiVersion` 声明兼容的目标版本。
 * 2 = 增加设置分区（`ctx.settings.registerSection`）与技能来源
 * （`ctx.skills.registerProvider` / `registerMarket`）两个扩展点；
 * 3 = 增加请求组装扩展点（`ctx.prompt.register` 附加系统提示、
 * `ctx.prompt.registerProjection` 命名纯投影改写发给模型的消息），并允许外部插件用
 * `export const settingsSection` 声明自己的设置分区 id（插件中心据此在详情页画它的配置表单）；
 * 4 = 增加三个内核扩展点：工具守卫链（`ctx.guards.register` / `registerObserver`，
 * 工具动手之前的闸门与工具输出的改写）、快照片段（`ctx.surfaces.register`，界面每块状态
 * 由那个功能点自己登记）、等人登记（`ctx.waiting.register`，哪张卡片正挂着等用户）；
 * 会话记录也在此版多了按 id 存取状态这一对（`ctx.session.appendState` / `session.state`）。
 * 5 = 新增一个可选服务 `sandbox`（当前档位、强制执行等级、可写根与路径判定；
 * 插件关着时不存在，读它要用 `ctx.get('sandbox')`），并把「命令执行器缝」开给随包发布的
 * 内置插件（`src/core/tools/command-runner.ts`：沙箱的容器后端靠它把本机 shell 换成容器）。
 * 6 = 模型层开两条缝：协议适配器（`ctx.llm.registerAdapter` + 端点配置的 `api` 字段 +
 * `ctx.llm.stream` 派发）与命名投影（`ctx.prompt.registerProjection` 接替 v3 的匿名改写，
 * 内置 fold-system / drop-images 是保留名）；会话多了 `appendNote`（投影往请求里注入的
 * 日志外内容必须落一条，模型可见 ⟺ 已记录）。
 * 1 到 5 的插件照常挂载（版本检查只拦「高于内核」的声明）。
 */
export const KERNEL_API_VERSION = 6

/** 条目树的一项。 */
export interface PluginEntry {
  /** 开关键 = 插件身份（行 id；外部单文件插件为文件名）。 */
  file: string
  disabled: boolean
  /** 透传给插件 apply(ctx, config) 的配置对象。 */
  config: Record<string, unknown>
  /** 不认识的键原样留着（这一份文件被多条体系共用，谁都不许把别人的段吃掉）。 */
  [key: string]: unknown
}

/**
 * 身份 → 它的旧键（0.8.1 用文件名当键，现在用行 id）。
 *
 * 迁移只做「读」这一步：读的时候按行 id 找不到就翻旧键，命中了下次写盘再把新键补上。
 * 旧键不删——回滚到旧版本时它还得读得到自己的开关。
 */
const legacyKeys = new Map<string, Set<string>>()

/** 旧键 → 唯一认领它的身份。 */
const legacyOwners = new Map<string, string>()

/**
 * 被两个身份认领过的旧键。撞车之后谁都不能拿它当线索。
 *
 * 为什么这么严：组合包里的入口十有八九都叫 `index.js`，按文件名迁移必然撞车。
 * 撞车时宁可不迁移（读不到老配置，用户重配一次），也不能让 A 行读到 B 行的开关。
 */
const ambiguousLegacyKeys = new Set<string>()

/** 登记一个身份的旧键（行 id ≠ 入口文件名时由 loader 调用）。 */
export function registerPluginAlias(identity: string, legacyKey: string): void {
  if (identity === '' || legacyKey === '' || identity === legacyKey) return
  if (ambiguousLegacyKeys.has(legacyKey)) return
  const owner = legacyOwners.get(legacyKey)
  if (owner !== undefined && owner !== identity) {
    // 撞车：把先认领的那一份也撤掉，这个旧键从此只当「有歧义」处理
    ambiguousLegacyKeys.add(legacyKey)
    legacyOwners.delete(legacyKey)
    const keys = legacyKeys.get(owner)
    if (keys !== undefined) keys.delete(legacyKey)
    return
  }
  legacyOwners.set(legacyKey, identity)
  const keys = legacyKeys.get(identity) ?? new Set<string>()
  keys.add(legacyKey)
  legacyKeys.set(identity, keys)
}

/**
 * 找某个身份对应的条目下标：先按新键精确找，找不到再按登记过的旧键找。
 * @param entries - 条目树
 * @param file - 行 id（或外部插件文件名）
 * @returns 下标；没有给 -1
 */
function entryIndexOf(entries: readonly PluginEntry[], file: string): number {
  const exact = entries.findIndex((entry) => entry.file === file)
  if (exact >= 0) return exact
  const legacy = legacyKeys.get(file)
  if (legacy === undefined) return -1
  return entries.findIndex((entry) => legacy.has(entry.file))
}

/**
 * 把一条改动落到条目树。
 *
 * 旧键命中时**双写**：旧键那一条跟着改（回滚到旧版本仍读到对的开关），新键再补一条。
 * @param entries - 条目树（就地改）
 * @param file - 新键（行 id）
 * @param patch - 要改的字段
 */
function putEntry(entries: PluginEntry[], file: string, patch: { disabled?: boolean; config?: Record<string, unknown> }): void {
  const index = entryIndexOf(entries, file)
  if (index < 0) {
    entries.push({
      file,
      disabled: patch.disabled ?? catalog.get(file)?.defaultDisabled === true,
      config: patch.config ?? {},
    })
    return
  }
  const found = entries[index]!
  const next: PluginEntry = {
    ...found,
    ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
    ...(patch.config === undefined ? {} : { config: patch.config }),
  }
  entries[index] = next
  if (found.file !== file) entries.push({ ...next, file })
}

const PLUGINS_JSON = dscPath('plugins.json')

// ── 第三方界面插件的信任记录（阶段 7）─────────────────────────────────────────
//
// 首次发现第三方界面插件时不自动加载：装了什么、能调哪些宿主方法要摊给用户看，答过一次
// 才装（落盘 plugins.json 顶层 `uiTrust` 段，与宿主插件的启停同住一份记录，不是每次问）。
// 键与启停条目同一个 `file` 形状（`<目录名>/ui/client.js`）。

/** 一条界面插件信任记录。 */
export interface UiPluginTrustEntry {
  /** 答应的时刻（毫秒）。 */
  trustedAt: number
  /**
   * 答应时那份界面产物（`ui/client.js`）的 sha256 全文。
   *
   * 为什么要有它：只记「答应过」挡不住「内容换了」——文件被替换以后旧信任仍然成立，等于
   * 用户当初同意的是一份代码、跑起来的却是另一份。加载判定要把这份摘要与当前字节比一遍。
   * 老记录没有这一项（读出来是 undefined），按过期处理（见 core/ui-bundles）。
   */
  digest?: string
}

/** 读全部界面插件信任记录（文件缺失/损坏/形状不对按空处理）。 */
export function readUiPluginTrust(): Record<string, UiPluginTrustEntry> {
  try {
    if (!existsSync(PLUGINS_JSON)) return {}
    const doc = JSON.parse(readFileSync(PLUGINS_JSON, 'utf8')) as { uiTrust?: unknown }
    if (doc.uiTrust === null || typeof doc.uiTrust !== 'object' || Array.isArray(doc.uiTrust)) return {}
    const out: Record<string, UiPluginTrustEntry> = {}
    for (const [key, value] of Object.entries(doc.uiTrust as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const trustedAt = (value as { trustedAt?: unknown }).trustedAt
      if (typeof trustedAt !== 'number') continue
      const digest = (value as { digest?: unknown }).digest
      out[key] = {
        trustedAt,
        ...(typeof digest === 'string' && digest !== '' ? { digest } : {}),
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 落一条信任记录（信任确认动作的终点；重复信任无害）。
 * @param fileKey - 启停键形状的信任键（`<目录名>/ui/client.js`）
 * @param digest - 这次答应的是哪一份字节（sha256 全文）；不传就按信任键去读产物补算
 */
export function trustUiPlugin(fileKey: string, digest?: string): void {
  // 与条目树共用同一份读写：坏文件在这里会抛错，而不是把别人的段覆盖掉。
  const doc = readPluginsDoc() ?? {}
  const uiTrust = isPlainObject(doc.uiTrust) ? doc.uiTrust : {}
  // 不传 digest 的调用点只知道键（命令 /ui-trust 就是这样）：按同一形状把那份产物读出来补算。
  // 不补的话会写出一条「没有摘要、永远过期」的记录，信任按钮等于失效。
  const resolved = digest !== undefined && digest !== '' ? digest : digestOfUiArtifact(fileKey)
  uiTrust[fileKey] = {
    trustedAt: Date.now(),
    ...(resolved === undefined ? {} : { digest: resolved }),
  }
  writePluginsDoc({ ...doc, version: 1, uiTrust })
}

/**
 * 信任键 → 产物字节的 sha256（`<目录名>/ui/client.js` 按 `~/.dsc/plugins/` 定位）。
 *
 * 只服务「调用点拿不到字节」的那一种；读不到给 undefined——宁可留一条没有摘要的记录，
 * 也不伪造一个和内容对不上的摘要（那会让判定层直接把这份信任当过期）。
 */
function digestOfUiArtifact(fileKey: string): string | undefined {
  if (!fileKey.endsWith('/ui/client.js') || fileKey.includes('..') || fileKey.includes('\\')) return undefined
  try {
    const file = join(dscPath('plugins'), ...fileKey.split('/'))
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

/** 判断一个值是不是普通对象（数组也算不是）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 读 `plugins.json` 的原文：文件不存在给 null。
 *
 * 文件存在但读不成 JSON 时**抛错**而不是当空：这一份文件被多条体系共用（开关、配置、
 * 界面信任），当成空再整份写回去等于把用户配过的东西一次抹掉。
 * @returns 顶层对象；文件不存在或内容是空白给 null
 * @throws {Error} 文件存在但解析失败（中文说明，调用方不许吞）
 */
function readPluginsDoc(): Record<string, unknown> | null {
  if (!existsSync(PLUGINS_JSON)) return null
  const text = readFileSync(PLUGINS_JSON, 'utf8')
  // 空白文件没有可丢的内容，按「还没有记录」处理
  if (text.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('顶层不是 JSON 对象')
    return parsed
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `~/.dsc/plugins.json 存在但解析不了（${reason}）。这次不写盘，免得把整份插件开关与配置覆盖成空；` +
        '请修好这个文件（或删掉它重新配置）后再试。',
    )
  }
}

/** 写 `plugins.json`（原子性不追求——个人版单写者）。 */
function writePluginsDoc(doc: Record<string, unknown>): void {
  mkdirSync(dscPath(), { recursive: true })
  writeFileSync(PLUGINS_JSON, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

/** 读取条目树（文件缺失/损坏按空处理；兼容旧版 disabled 数组格式）。 */
export function readPluginEntries(): PluginEntry[] {
  try {
    if (!existsSync(PLUGINS_JSON)) return []
    const doc = JSON.parse(readFileSync(PLUGINS_JSON, 'utf8')) as {
      version?: unknown
      entries?: unknown
      disabled?: unknown
    }
    if (Array.isArray(doc.entries)) {
      return doc.entries
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
        .map((entry) => ({
          // 不认识的键（例如别的版本写的 enabled）原样留着
          ...entry,
          file: String(entry.file ?? ''),
          disabled: entry.disabled === true,
          config: isPlainObject(entry.config) ? entry.config : {},
        }))
        .filter((entry) => entry.file !== '')
    }
    // 旧版：{ disabled: string[] } → 全部条目 disabled=false，仅按列表标记
    if (Array.isArray(doc.disabled)) {
      const disabled = new Set(doc.disabled.filter((entry): entry is string => typeof entry === 'string'))
      return [...disabled].sort().map((file) => ({ file, disabled: true, config: {} }))
    }
    return []
  } catch {
    return []
  }
}

/**
 * 写入条目树。
 *
 * 顶层不认识的段（`uiTrust` 等）原样保留——这份文件被多条体系共用，各写各的段。
 * @throws {Error} 原文件存在但解析失败（拒绝写盘，见 {@link readPluginsDoc}）
 */
export function writePluginEntries(entries: PluginEntry[]): void {
  const previous = readPluginsDoc() ?? {}
  writePluginsDoc({ ...previous, version: 1, entries })
}

export function getPluginConfig(file: string): Record<string, unknown> {
  const entries = readPluginEntries()
  const index = entryIndexOf(entries, file)
  return index < 0 ? {} : entries[index]!.config
}

/**
 * 合并写一个插件的配置对象（插件中心「配置」分区与插件自己共用这一个入口，
 * 落 `~/.dsc/plugins.json` 的条目树）。值传 null 表示删掉这个键，回到插件默认值。
 */
export function writePluginConfig(
  file: string,
  patch: Record<string, unknown | null>,
): Record<string, unknown> {
  const entries = readPluginEntries()
  const index = entryIndexOf(entries, file)
  const config: Record<string, unknown> = index >= 0 ? { ...entries[index]!.config } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === '') continue
    if (value === null) delete config[key]
    else config[key] = value
  }
  // 旧键命中时 putEntry 会双写（旧键同步、新键补一条）；新建时沿用默认开关，
  // 只改配置值不该顺手把插件点亮。
  putEntry(entries, file, { config })
  writePluginEntries(entries)
  return config
}

/**
 * 取一个插件此刻该用的配置：装配时传进来的那份作底，磁盘上那份覆盖它。
 * 为什么要覆盖——设置分区保存走 {@link writePluginConfig} 改的是磁盘，
 * 插件每次用值时现调这个函数，改完配置就不必重启宿主。
 * @param file - 条目树里的插件 file（内置插件就是插件名，例如 `goal`）。
 * @param passed - 装配时传进来的第二参数；不是对象就当没给。
 */
export function resolvePluginConfig(file: string, passed?: unknown): Record<string, unknown> {
  const fromDisk = getPluginConfig(file)
  if (passed === null || typeof passed !== 'object' || Array.isArray(passed)) return fromDisk
  return { ...(passed as Record<string, unknown>), ...fromDisk }
}

/**
 * 一批插件的开关快照：只读一次 `plugins.json`，返回其中**处于启用**的那些 file。
 *
 * 为什么要有批版：界面产物表每次重建都要问一遍内置界面单元（19 个）的开关，
 * 逐个调 {@link isPluginEnabled} 会把同一份 JSON 读 19 遍、解析 19 遍。
 *
 * 判定口径与单条版逐字相同（同走 {@link entryIndexOf}，0.8.1 的旧键别名照样认）。
 * @param files - 要问的插件 file（行 id）
 * @returns 处于启用的 file 集合
 */
export function readEnabledPlugins(files: readonly string[]): Set<string> {
  const entries = readPluginEntries()
  const enabled = new Set<string>()
  for (const file of files) {
    const index = entryIndexOf(entries, file)
    const on = index < 0 ? catalog.get(file)?.defaultDisabled !== true : !entries[index]!.disabled
    if (on) enabled.add(file)
  }
  return enabled
}

/**
 * 这个插件该不该挂载。条目树没记录时回落到元数据声明的默认值
 * （`defaultDisabled` 为 true 的官方插件在用户主动打开之前不挂载）。
 */
export function isPluginEnabled(file: string): boolean {
  return readEnabledPlugins([file]).has(file)
}

/**
 * 更新条目树的 disabled 标记并写盘。
 * @returns false = 该插件不可停用（属于运行内核，即 source='builtin' 且没标 toggleable）。
 */
export function writePluginEnabled(file: string, enabled: boolean): boolean {
  const meta = catalog.get(file)
  const canToggle = meta === undefined || meta.source === 'external' || meta.toggleable === true
  if (!canToggle) return false
  const entries = readPluginEntries()
  putEntry(entries, file, { disabled: !enabled })
  writePluginEntries(entries)
  return true
}

/**
 * 一次性迁移（2026-11-06 合并）：「子智能体」（subagent）与「共享任务板」（team）
 * 合成一个包，行 id 仍是 `subagent`，`team` 那一行已从 base 清单里消失。
 *
 * 条目树里 `team` 明确开着（`disabled === false`）的用户，升级后要在 `subagent` 上拿到
 * 同样的「派活 + 团队」能力，所以把 `subagent` 写成启用；`team` 条目原样留着——回滚到
 * 旧版本时那份开关还在，用户的选择不会丢。条目树里没有 `team`、或 `team` 是关着的，
 * 就尊重那个选择，一个字都不写。
 *
 * 幂等：`subagent` 已经启用时不写盘；`team` 条目永不删除。
 */
export function migrateTeamMerge(): void {
  const entries = readPluginEntries()
  const team = entries.find((entry) => entry.file === 'team')
  if (team === undefined || team.disabled !== false) return
  const subagent = entries.find((entry) => entry.file === 'subagent')
  // subagent 默认关：条目缺失时它仍是关着的，所以这里只认显式的 disabled === false。
  if (subagent !== undefined && subagent.disabled === false) return
  writePluginEnabled('subagent', true)
}

/**
 * 版本管理：检查插件声明的 apiVersion 与内核是否兼容。
 * @returns null = 兼容（或插件未声明）；字符串 = 不兼容的原因。
 */
export function checkApiVersion(apiVersion: number | undefined): string | null {
  if (apiVersion === undefined) return null
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion)) {
    return `apiVersion 非法（${String(apiVersion)}），应为整数`
  }
  if (apiVersion > KERNEL_API_VERSION) {
    return `插件要求内核 API v${apiVersion}，当前内核 v${KERNEL_API_VERSION}（请升级 Pneuma）`
  }
  if (apiVersion < 1) {
    return `apiVersion 必须为正整数，收到 ${apiVersion}`
  }
  return null
}

/** 目录快照 + 条目树合并成 UI 投影（运行内核那一档恒启用）。 */
export function listPluginInfos(): PluginInfoView[] {
  const entries = new Map(readPluginEntries().map((entry) => [entry.file, entry]))
  return [...catalog.values()].map((meta) => {
    const entry = entries.get(meta.file)
    const canToggle = meta.source === 'external' || meta.toggleable === true
    const disabled = canToggle ? (entry?.disabled ?? meta.defaultDisabled === true) : false
    return {
      file: meta.file,
      name: meta.name,
      description: meta.description,
      enabled: !disabled,
      source: meta.source,
      toggleable: canToggle,
      settingsSection: meta.settingsSection,
      apiVersion: meta.apiVersion,
      problem: meta.problem,
      ...(meta.bundle === undefined ? {} : { bundle: meta.bundle }),
      ...(meta.clientCapabilities === undefined ? {} : { clientCapabilities: [...meta.clientCapabilities] }),
    }
  })
}
