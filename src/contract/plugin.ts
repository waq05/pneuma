/**
 * 契约分域：plugin
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/plugin
 */
import type { Modality, ThinkingLevel } from './mode.js'

/** 分叉结果：成功时带新会话的 jsonl 路径，UI 拿它直接切过去。 */
export type SessionForkResult = { ok: true; path: string } | { ok: false; error: string }

/** 插件管理页的一行（内置/外部统一投影；宿主启动时扫描的快照）。 */
export interface PluginInfoView {
  /** 开关键：外部插件为文件名，内置为插件名。 */
  file: string
  /** 显示名（外部插件取其 name 导出，缺省为去后缀文件名）。 */
  name: string
  description: string
  enabled: boolean
  source: 'builtin' | 'external'
  /** true = 有开关可拨（外部插件 + 官方可开关插件）；false = 运行内核，不可停用。 */
  toggleable: boolean
  /** 这个插件贡献的设置分区 id；undefined = 没有可配置项，详情页不画配置表单。 */
  settingsSection?: string
  /** 插件声明的内核 API 版本；未声明时 undefined。 */
  apiVersion?: number
  /** 加载失败/被自动停用的原因（回滚说明），正常时 undefined。 */
  problem?: string
  /** 这个插件来自哪个组合包（bundle）；单文件插件没有这一项。 */
  bundle?: string
  /**
   * 插件声明的 dsh 客户端（界面）能力名，**只列不加载**。
   *
   * dsh 的界面插件要一份 dsh 自己的客户端运行时，Pneuma 的壳是另一套契约，
   * 真加载等于在页面里跑第二个框架。所以插件中心只把「它想让界面做什么」列出来。
   */
  clientCapabilities?: string[]
}

/**
 * 第三方界面插件「装不上」的原因分档（`UiTrustView.problem` 的机器可读标签）：
 *
 *   - `manifest`：plugin.json 缺失、或没写 api（第三方必须声明区间）；
 *   - `clash`：id 与内置插件撞名（第三方这份让路）；
 *   - `version`：api 区间与当前壳不符（含 workspace: 前缀与非法区间）；
 *   - `artifact`：plugin.json 声明齐了，但 ui/client.js 读不到。
 *
 * 为什么要有这一项：`problem` 是给人看的句子，界面按档画「下一步做什么」时**不许去猜
 * 句子里有没有某个词**——档位在判定现场就知道，由判定的人标出来，两处文案才不互相绑架。
 */
export type UiTrustProblemKind = 'manifest' | 'clash' | 'version' | 'artifact'

/**
 * 界面插件的一条状态（插件中心「第三方界面插件」与「组合包界面」两张卡的数据源）。
 *
 * 两类来源，判定与装载的路是同一套，只有「凭什么算同意」不同：
 *
 *   - `third-party`：`~/.dsc/plugins/<目录名>/{plugin.json, ui/client.js}`，手工放进去的，
 *     首次发现要用户在插件中心答一次信任（写 plugins.json 的 `uiTrust`）；
 *   - `package`：profile 里用 `numa plugin add` 装的组合包，`package.json` 的
 *     `dsh.client.platform = 'pneuma'` 声明界面半边——**装它那一步就是同意**，不再问。
 *     启停键是 `<包名>/client`。
 *
 * 与宿主插件（`PluginInfoView`）不是一回事：那些住 `~/.dsc/plugins/*.js`，这份是界面半边。
 */
export interface UiTrustView {
  /** 目录名（第三方）或包名（组合包，可能带 `@scope/`）；启停键的前半段。 */
  name: string
  /**
   * 启停键（plugins.json 条目树的 `file`）：第三方 `<目录名>/ui/client.js`、
   * 组合包 `<包名>/client`。界面别自己拼——两种形状不同，拼错就写成一条没人读的开关。
   */
  key: string
  /** 这一行的来源（决定卡片怎么讲「凭什么算同意」）。 */
  origin: 'third-party' | 'package'
  /**
   * 包的版本号（`package.json` 的 `version`）。只有组合包行有：第三方目录是用户手工放的，
   * 没有版本这个概念，一律 undefined——界面别拿空串占位，那会让「没版本」和「版本是空」混起来。
   */
  version?: string
  /** 装在哪个 profile（profile 目录名，如 `work`）。只有组合包行有；界面用它说清「来源」。 */
  profile?: string
  /** plugin.json / `dsh.client` 声明的 `@dsc/ui` 版本区间；没写/读不到时 undefined。 */
  api?: string
  /** 声明的载体（web/tui）；缺省 `['web']`。 */
  platforms: string[]
  /** 有没有信任记录。组合包恒为 true（装进 profile 就是同意）；第三方看 `uiTrust`。 */
  trusted: boolean
  /** 答应的时刻（毫秒）；组合包与未信任的第三方都没有这一项。 */
  trustedAt?: number
  /** 启停开关（plugins.json entries，键见 `key`）。 */
  enabled: boolean
  /** 现在装不上的原因（缺声明 / 没写 api / 与内置撞名 / api 区间不匹配 / 入口读不到）；能装时 undefined。 */
  problem?: string
  /** `problem` 属于哪一档；没有 problem 时 undefined（界面按档给下一步动作）。 */
  problemKind?: UiTrustProblemKind
}

/** 一个队友（智能体团队派出去的子智能体）；侧栏「队友」这一档看到的行。 */
export interface TeammateView {
  /** 队友名，例如 writer-1。 */
  name: string
  /** 角色名，例如 writer。 */
  role: string
  /** working = 正在干；idle = 干完待命；stopped = 被打断；failed = 出错。 */
  state: 'working' | 'idle' | 'stopped' | 'failed'
  /** 派给它的任务（截短了的）。 */
  task: string
  /** 它的运行记录文件（只读查看用）。 */
  file: string
  /** 谁派了它：'lead' = 主会话派的。 */
  parent: string
  /** 第几层：1 = Lead 的直属队友。 */
  depth: number
  /** 已发起的模型请求轮数。 */
  rounds: number
  startedAt: number
  finishedAt?: number
  /**
   * 出生会话 id（派它的那个会话，名册持久化下来的）。
   * roster.json 是跨重启的台账，字段后加；老记录没有这一项，读档时按 undefined 处理。
   */
  sessionId?: string
}

/** 可切换的模型（/model 补全与校验的数据源）。 */
export interface ModelChoiceView {
  /** 可直接传给 /model 的完整值：`[端点/]模型名`。 */
  value: string
  provider: string
  /** 端点的显示名（`displayName`；用户没填时等于 `provider`）——选择器的一级行画它。 */
  providerDisplayName: string
  model: string
  /** 面板展示用说明（端点显示名 · 上下文窗口）。 */
  description: string
  /** 上下文窗口（面板右侧标注用）。 */
  contextWindow: number
  /** 这个模型支持的思考档位；思考面板据此收起不支持的档位。 */
  thinkingLevels: ThinkingLevel[]
  /** 这个模型能接受的输入类型。 */
  modalities: Modality[]
}

// ── 壳的 `/` 命令菜单 ─────────────────────────────────────────────────────────

/**
 * 壳 `/` 菜单的一行。
 *
 * 只带元数据（名字 / 参数占位 / 说明 / 回合中能否用），handler 留在宿主注册表里——
 * 壳不需要、也拿不到执行的实现，它只把名字回给 {@link DscRuntime.runUiCommand}。
 */
export interface UiCommandView {
  name: string
  /** 参数占位提示（空串 = 无参数）。 */
  args: string
  description: string
  /**
   * 中文短名（2–4 字），菜单第一列；缺省 = 这一行只显示英文名。
   *
   * 三端（桌面壳 / 手机 / TUI）都从这一份读，菜单文案就不会各写各的。菜单里**不再**
   * 显示参数占位：命令选中后宿主已补一个空格，接着打就行，用法在 `/help` 里。
   */
  label?: string
  /** 回合跑着时能不能用（`deny` 的行在菜单里标出来，派发那一步也由宿主再挡一次）。 */
  duringTask: 'allow' | 'deny'
}

// ── 技能中心 ──────────────────────────────────────────────────────────────────

/** 技能来源标签（rank 小者赢得重名）。 */
export type SkillSourceLabel =
  | 'project-dsc'
  | 'project-agents'
  | 'custom'
  | 'user-agents'
  | 'user-dsc'
  | 'user-dsh'
  | (string & {})

/** 技能清单一行（技能中心页与设置「技能」分区共用）。 */
export interface SkillInfoView {
  /** kebab-case 名，同时是启停键。 */
  name: string
  description: string
  /** frontmatter when-to-use（技能卡片第二行）。 */
  whenToUse?: string
  source: SkillSourceLabel
  /** SKILL.md 绝对路径；插件注册的虚拟技能没有路径。 */
  path?: string
  enabled: boolean
  /** 是否出现在模型可见目录里。 */
  modelInvocable: boolean
  /** 是否注册成 `/技能名` 命令。 */
  userInvocable: boolean
  /** false = 由插件注册、不可启停。 */
  toggleable: boolean
  /** 发现或解析问题（名字非法、frontmatter 缺字段等），正常时 undefined。 */
  problem?: string
  /** 项目技能还是全局技能：技能页按它分「全局 / 项目」两组（与 dsh 设置页同口径）。 */
  scope?: 'project' | 'global'
  /** 发现根目录（分组头显示「这批技能来自哪个目录」）。 */
  root?: string
}

/** 技能详情（正文按需读，不进模型目录）。 */
export interface SkillDetail extends SkillInfoView {
  /** SKILL.md 去掉 frontmatter 之后的 markdown 正文。 */
  content: string
}

/** 技能读取结果。 */
export type SkillLoadResult = { ok: true; skill: SkillDetail } | { ok: false; error: string }

/** 一个技能市场源。 */
export interface MarketSource {
  name: string
  url: string
}

/** 市场源的健康投影（失败源保留错误原因，UI 才看得见为什么空）。 */
export interface MarketSourceView extends MarketSource {
  ok: boolean
  error?: string
}

/** 市场里的一条可安装技能。 */
export interface MarketSkillView {
  name: string
  description: string
  /** 所属市场源名。 */
  source: string
  version?: string
  /** 本地 ~/.dsc/skills 里是否已有同名技能。 */
  installed: boolean
}

/** 一次市场浏览的结果（当前源的条目 + 全部源的状态）。 */
export interface MarketBrowseResult {
  sources: MarketSourceView[]
  /** 本次条目来自哪个源。 */
  source: string
  items: MarketSkillView[]
  error?: string
}

