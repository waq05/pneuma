/**
 * 契约分域：session
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/session
 */
// @@imports@@

/** /resume 会话选择器与侧栏的一行。 */
export interface SessionSummary {
  /** jsonl 的绝对路径（UI 侧的会话标识就是它）。 */
  id: string
  cwd: string
  createdAt: number
  /** 最后一次写入日志的时间（文件 mtime），「按最近使用」排序的键。 */
  updatedAt: number
  /** 会话标题：用户改名 → 自动生成（T16）→ 首条用户消息截断；都没有时 undefined。 */
  title?: string
  /** 置顶时间；undefined = 未置顶。 */
  pinnedAt?: number
  /** 归档时间；undefined = 还在活动区。归档不等于删除，恢复后回到列表。 */
  archivedAt?: number
}

/** 归档列表的一行（设置 → 归档）。 */
export interface ArchivedSessionView {
  /** 归档区里那个 jsonl 的绝对路径（恢复与永久删除都以它为准）。 */
  path: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
  /** 归档时间；老数据没记过就退化成文件时间。 */
  archivedAt: number
}

/** 归档页的一页数据：条目 + 回收站情况。 */
export interface ArchivedPage {
  items: ArchivedSessionView[]
  /** 回收站目录：永久删除的会话先进这里，保留 30 天。 */
  trashDir: string
  /** 回收站里现有的文件数（超过 30 天的在下一次读归档页时清掉）。 */
  trashCount: number
}

/** 会话排序方式：手动（工作区按拖动顺序）、按最近写入时间，或按创建时间。 */
export type SessionSortKey = 'manual' | 'recent' | 'created'

/** 列表分组方式：按工作区分组、按工作区目录树嵌套，或平铺成单列表。 */
export type SessionGroupKey = 'workspace' | 'tree' | 'flat'

/** 已归档会话在侧栏里的显隐：隐藏（默认）、并入列表一起看，或只看归档。 */
export type ArchivedFilter = 'hide' | 'show' | 'only'

/** 主题模式：固定深色、固定浅色，或跟着系统的浅色偏好走。 */
export type ThemeMode = 'dark' | 'light' | 'claude' | 'system'

/**
 * 全局字号缩放倍数（1 = 正文 13px 基准）。桌面端把它直接写成 `--dsc-font-scale`。
 *
 * 0.6 之前的存档里这里是 `'sm' | 'md' | 'lg'` 三档字符串，读档时迁移成
 * 0.92 / 1 / 1.12（见 core/prefs.ts 的 readPrefs）。
 */
export type UiFontSize = number

/** 密度档位：行高与纵向内距的整体缩放（紧凑 / 标准 / 宽松）。 */
export type UiDensity = 'compact' | 'standard' | 'roomy'

/**
 * 过程折叠程度：对话流里「思考 / 工具调用」这些过程条目的展示档位。
 *
 * 四档与 dsh 的展示档位一一对应（packages/client/ui-chat/src/client/presentation-policy.ts:24-53），
 * 每档开哪几项能力见 desktop/src/renderer/appearance.ts 的 PROCESS_FOLD_POLICIES：
 *
 * - `compact`：整轮折叠 + 阶段分组 + 不显示思考行摘要 + 组头不带实时详情；
 * - `standard`：整轮折叠 + 阶段分组 + 摘要 + 组头带实时详情（默认）；
 * - `detailed`：整轮折叠，但**只有历史轮**才分组——正在跑的那一轮直接摊开；
 * - `verbose`：整轮不折、阶段也不分组，过程条目逐条摊开。
 *
 * 为什么 `detailed` 和 `verbose` 都要有：dsh 里 `detailed` 是桌面端的实际默认档
 * （ui-chat/src/client/apply.ts 里非 dsh 桌面端走 detailed），它的意思是「想看细节，但不想
 * 每次都把历史摊开」——整轮照折，只有运行中的那一轮摊着。`verbose` 才是「什么都不折」。
 * dsc 0.6.3 的三档里 `detailed` 曾经等于现在的 `verbose`，本次按 dsh 的语义改回
 * 「折叠 + 只折历史轮」，原来那种「全摊开」的行为改由 `verbose` 承担。
 */
export type UiProcessFold = 'compact' | 'standard' | 'detailed' | 'verbose'

/**
 * TUI 底部状态栏各段的显隐（存在 `~/.dsc/settings.json` 的 `ui.statusBar`）。
 * 全部必填：读档由 {@link normalizeStatusBarPrefs} 补齐，消费方不需要判缺。
 * 出厂口径对齐 dsh 底栏设置的默认——只留「身份 + 在看什么」，effort/模式/
 * Token 累计/会话 ID 这类设定完就不再看的默认收掉，要的在 设置 → 终端界面 →
 * 状态栏 子页里打开。
 */
export interface StatusBarPrefsView {
  /** 模型名。 */
  model: boolean
  /** 思考强度（effort 档位）。 */
  effort: boolean
  /** 缓存命中率。 */
  cache: boolean
  /** Token 累计（input/output）。 */
  tokens: boolean
  /** 本会话费用估算（仅 DeepSeek 官方端点有数据）。 */
  cost: boolean
  /** 会话模式（执行/计划/探索/免打扰）。 */
  mode: boolean
  /** 权限模式。 */
  policy: boolean
  /** 上下文用量百分比。 */
  ctx: boolean
  /** 工作目录。 */
  cwd: boolean
  /** 当前会话短 id。 */
  session: boolean
}

/** 侧栏界面偏好，存在 `~/.dsc/settings.json`，桌面端与以后别的界面共用。 */
export interface UiPrefsView {
  sessionSort: SessionSortKey
  /** 侧栏会话列表的分组方式。 */
  sessionGroup: SessionGroupKey
  /** 已归档会话在侧栏里的显隐。 */
  archivedFilter: ArchivedFilter
  /** 手动拖出来的工作区顺序（cwd 绝对路径）；没拖过是空数组。 */
  workspaceOrder: string[]
  /** 工作区显示名别名：cwd → 想要的名字。 */
  workspaceAliases: Record<string, string>
  /** 主题模式。 */
  themeMode: ThemeMode
  /** 字号缩放倍数（设置页滑杆可调范围 0.85–1.35）。 */
  fontSize: UiFontSize
  /** 按钮缩放倍数（设置页滑杆可调范围 0.9–1.5），桌面端把它写成 `--dsc-btn-scale`。 */
  buttonScale: number
  /** 密度档位。 */
  density: UiDensity
  /** 过程折叠程度（紧凑 / 标准 / 详细 / 逐条摊开），默认 standard。 */
  processFold: UiProcessFold
  /**
   * 定稿的思考行默认展开吗（默认 false = 折叠成一行「思考过程」）。
   *
   * 为什么与 {@link processFold} 分成两套：档位管的是「整轮折不折、阶段要不要分组」这一层
   * 结构，这两项管的是最里层「单条思考 / 单张工具卡默认长什么样」。dsh 没有这两项——它的
   * 可选性只体现在四个档位加上每层手动开合，所以这是 dsc 自己的增量（用户要求「可选折叠
   * 思考、工具调用」）。两条轴正交：档位是粗档，这两项是在档位之上的默认态微调。
   *
   * 只管**定稿**条目：跑动中的那一段思考永远是展开的（它是「现在在干什么」的唯一线索，
   * 见 ThinkingBlock 的 showPreview 那条同样的理由）。用户手点的展开态优先于这里的默认值。
   */
  reasoningDefaultOpen: boolean
  /** 工具卡默认展开吗（默认 false = 只显示一行「工具名 + 状态」）。口径同 {@link reasoningDefaultOpen}。 */
  toolDefaultOpen: boolean
  /**
   * 侧栏各工作区分组的展开状态（cwd → 展开？），对齐 dsh 的 groupExpansion：
   * 点工作区行只切换它自己，别的组不跟着动；关掉再开也记得住。
   * 键缺失 = 用默认（活动组与树模式父组展开，其余收起）。
   */
  sessionExpansion: Record<string, boolean>
  /**
   * 「手动排序」档下各工作区里会话行的顺序（cwd → 会话 jsonl 路径序列），
   * 对齐 dsh 的 sessionOrderByAccount：会话行拖完落在这里，置顶块照旧排最前。
   * 键缺失或表里没有的会话按最近使用排在后面。
   */
  sessionOrder: Record<string, string[]>
  /**
   * 一轮干完（跑动 → 空闲）时播一声完成提示音吗（默认开）。桌面端行为偏好：
   * 声音由桌面渲染层用 Web Audio 现场合成，远程界面（手机浏览器）不消费这几项。
   */
  turnCompleteSound: boolean
  /** 完成提示音的音色编号（1–14，设置里选中即试听）；读档越界时夹回。 */
  turnCompleteSoundVariant: number
  /**
   * 窗口不在前台（最小化 / 缩托盘 / 失焦）时，一轮干完弹一条系统通知吗（默认开）。
   * 通知由桌面主进程创建，点击唤回主窗口；前台时不弹——那时提示音已经足够。
   */
  turnCompleteNotify: boolean
  /** TUI 底部状态栏各段的显隐；读档缺键由 {@link normalizeStatusBarPrefs} 回落默认。 */
  statusBar: StatusBarPrefsView
  /**
   * 窗口几何：侧栏宽 / 正文列宽 / 右侧栏宽 / 并排审查宽 + 侧栏收起。
   *
   * 为什么不能只放 localStorage：宿主每次启动、每次切工作目录都会换一个端口
   * （见 `ui-server` 的 `port ?? 0`），而 localStorage 按**源**隔离——换了端口就是一份
   * 空存储，用户拖出来的宽度每次重开都回默认（外观镜像踩过同一个坑，见 ui-shell 的
   * `appearance.ts`）。所以这一份跟其它界面偏好一起落进 `~/.dsc/settings.json`。
   *
   * 仍是**本机**的窗口几何，不是跨机器偏好；值由壳的世界限夹，读档这里只挡脏值。
   */
  panelWidths: PanelWidthsView
}

/** 面板几何（px；缺键 = 这一项没拖过，用样式表默认）。 */
export interface PanelWidthsView {
  /** 侧栏宽（200–420）。 */
  sidebar?: number
  /** 正文列宽（≥480）。 */
  thread?: number
  /** 右侧栏宽（300–820）。 */
  dock?: number
  /** 并排审查面板宽。 */
  diff?: number
  /** 侧栏收起（Ctrl+B）。 */
  collapsed?: boolean
}

/** 状态栏段显隐的出厂默认（口径见 {@link StatusBarPrefsView}）。 */
export const DEFAULT_STATUS_BAR_PREFS: StatusBarPrefsView = {
  model: true,
  effort: false,
  cache: true,
  tokens: false,
  cost: true,
  mode: false,
  policy: true,
  ctx: true,
  cwd: true,
  session: false,
}

/**
 * 把老存档 / 老宿主 / 手改坏档里的 `ui.statusBar` 归一成全键视图：对象缺失或
 * 单键缺失都回落出厂默认（与 prefs.ts 的读档白名单同一口径，坏档不拦启动）。
 * 桌面渲染层与 TUI 共用这一份——prefs.ts 带着 node 内置模块，渲染层 import 不得。
 */
export function normalizeStatusBarPrefs(value: unknown): StatusBarPrefsView {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const merged = { ...DEFAULT_STATUS_BAR_PREFS }
  for (const key of Object.keys(DEFAULT_STATUS_BAR_PREFS) as (keyof StatusBarPrefsView)[]) {
    if (typeof source[key] === 'boolean') merged[key] = source[key] as boolean
  }
  return merged
}

