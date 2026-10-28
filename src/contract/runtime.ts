/**
 * 契约分域：runtime
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/runtime
 */
import type { ApprovalRequestView } from './approval.js'
import type { ApprovalPolicy, ApprovalReviewer, CollaborationMode, EffortLevel, SandboxMode } from './mode.js'
import type { AskUserView, BackgroundWorkView, GoalView, PlanEntryView, PlanView, ScheduledTaskView, TodoView } from './task.js'
import type { ContextSegmentsView } from './transcript.js'
import type { TokenUsageView } from './usage.js'

/**
 * 底部状态行数据：只放对话引擎自己的事实（哪条会话、哪个模型、这一轮在干什么）。
 * 某个功能点的状态（权限模式、协作模式、审批卡……）不进这里，由那个功能点自己
 * 往 {@link RuntimeSnapshot.surfaces} 里贡献自己那一块。
 */
export interface StatusView {
  sessionId: string | null
  /** 当前模型名；未知时 'unknown'。**裸名**（不带端点前缀）——它属于哪个端点看 {@link provider}。 */
  model: string
  /**
   * 当前模型属于哪个端点（config.yaml 里那一节的 `name`）。
   *
   * 为什么界面需要它：`model` 是裸名，而同一个模型 id 可以挂在两个端点下（`value` 才是
   * `端点/模型`）。光有裸名，界面既画不出「这个模型是从哪来的」，也分不清清单里哪一条
   * 才该打勾——0.6.71 输入区模型菜单的勾选基本不出现，根子就在这儿。
   * 端点信息拿不到时是 undefined：这类值一律原样显示，不猜。
   */
  provider?: string
  effort: EffortLevel
  turnState: 'idle' | 'thinking' | 'working' | 'awaiting-approval'
  usage: TokenUsageView | null
  /** 当前模型的上下文窗口（状态栏 context 进度条的分母；未知 0 = 不画刻度）。 */
  contextWindow: number
  /**
   * 最近一次请求的 prompt_tokens（权威占用读数，读数与空闲段按它算）。
   * 为什么不用 usage 累计：那是整会话的计费和，多轮会把早已滚出窗口的内容也算进去，
   * 条只会虚胖。还没有任何请求回过用量时为 0。
   */
  contextUsed: number
  /** 最近一次请求组装的内容类型分段（估算；没有请求记录时全 0 = 条上只有空闲段）。 */
  contextSegments: ContextSegmentsView
  /**
   * 会话进度：轮数 = 用户消息数（压缩摘要不算），步数 = 助手消息数（每次模型调用一步）。
   *
   * 口径对齐 dsh 的 `sessionStats`（turns：有回复的轮；steps：助手节点数），由宿主数
   * 会话消息得出——界面不再自己按条目猜。还没有任何消息时是 `{0,0}`。
   */
  progress: { turns: number; steps: number }
  /**
   * 会话费用估算（人民币）：只有当 provider 是 DeepSeek 官方且模型在价目表里、
   * 且至少回过一笔用量时才有。峰谷按北京时段分桶计价（见 core/pricing）。
   */
  cost?: { total: number; peakNow: boolean }
  /** 当前会话的工作目录（状态栏显示；快照组装自 session.meta.cwd）。 */
  cwd?: string
  /**
   * 当前会话的 jsonl 绝对路径。sessionId 是 uuid，拿它当文件用会按进程 cwd
   * 解析出 ENOENT（/fork 0.6.65 实锤）——需要落盘路径的命令一律用这个。
   */
  sessionPath?: string
  /**
   * 当前会话一条消息都还没发过（日志还没落盘）。
   *
   * 为什么界面要知道：这种会话没有稳定身份——它一旦不是当前会话就既不进侧栏、路径也换新的，
   * 输入框的草稿按路径分坑就会跟着丢（0.6.70 报障）。壳据此把这类会话的草稿记在工作区名下
   * （见 ui-shell 的 plugins/composer/draft.ts）。
   */
  sessionUnsaved?: boolean
}

/** 档位按钮的一项：档位 id + 按钮文字 + 悬浮说明。 */
export interface TierOption<T extends string> {
  id: T
  label: string
  hint: string
}

/**
 * 协作模式投影：当前档位 + 可切的档位清单。
 * 清单由 mode 插件给出，界面因此不必自己抄一份四档表。
 */
export interface ModeSurface {
  current: CollaborationMode
  options: TierOption<CollaborationMode>[]
}

/**
 * 权限投影：当前档位 + 可切档位清单 + 当前审阅者 + 可切审阅者清单。
 * 两根轴各给一份清单，界面因此不必自己抄一份档位表（清单只在 approval 插件里有一份）。
 */
export interface PolicySurface {
  current: ApprovalPolicy
  options: TierOption<ApprovalPolicy>[]
  /** 「要问的事」现在给谁答。 */
  reviewer: ApprovalReviewer
  reviewerOptions: TierOption<ApprovalReviewer>[]
}

/**
 * 一个打包权限预设：把**沙箱档位**与**权限模式 + 审阅者**捆成一组，
 * 界面上是「一颗旋钮同时管三件事」——分开选就会出现「完全访问 + 沙箱仍 workspace-write」
 * 这种自相矛盾的组合（参考实现里预设 = 沙箱 + 审批 一对，此处再加上审阅者这一轴）。
 */
export interface PermissionPresetView {
  /** 预设标识（小写字母数字连字符）。 */
  name: string
  /** 界面上的显示名。 */
  label: string
  description: string
  /** 捆进来的沙箱档位。 */
  sandbox: SandboxMode
  /** 捆进来的权限模式。 */
  policy: ApprovalPolicy
  /** 捆进来的审阅者。 */
  reviewer: ApprovalReviewer
  /** 出厂自带（删不掉，改不了）。 */
  builtin: boolean
}

/** 打包权限预设投影：当前生效的 + 新会话默认的 + 全部可选。 */
export interface PermissionPresetSurface {
  /**
   * 当前生效的预设名；两个旋钮的组合不匹配任何预设时为 `'custom'`
   * （推导出来的状态，可以离开它，但不能选它——参考实现同义）。
   */
  current: string
  /** 新会话默认的预设名。 */
  defaultName: string
  options: PermissionPresetView[]
}

/**
 * 一个模式（预设）的投影：`~/.dsc/presets/<名字>.md` 一个文件读出来的那份声明。
 * 界面上「查看配置」看的是文件原文（`readPreset`），这份投影只给卡片要用的字段。
 */
export interface PresetView {
  /** 模式标识（小写字母数字连字符）。 */
  name: string
  /** 界面上的显示名。 */
  label: string
  description: string
  /** 工具白名单；null = 全量，空数组 = 一个工具都不给。 */
  tools: string[] | null
  /** 要去掉的骨架提示段 id。 */
  drop: string[]
  /** true = 正文替换整个系统提示（只留正文与 AGENTS.md 注入）。 */
  replace: boolean
  /** 正文 = 这个模式追加给模型的提示词（编辑表单要拿它当初始值）。 */
  prompt: string
  /** 出厂自带的四个之一（界面标「内置」，删不掉）。 */
  builtin: boolean
  /** 文件有问题时的说明（例如 frontmatter 坏了、drop 里写了不认识的段）。 */
  problem?: string
}

/**
 * 模式投影：当前会话用的 + 新会话默认用的 + 全部可选。
 * 清单由 presets 插件给出，界面因此不必自己抄一份四个模式的名字。
 */
export interface PresetSurface {
  /** 当前会话用的模式名。 */
  current: string
  /** 新会话默认用的模式名。 */
  defaultName: string
  options: PresetView[]
  /** 允许模式去掉的骨架提示段（界面画勾选框）：名单只在 core/presets.ts 里有一份。 */
  droppable: Array<{ id: string; label: string }>
}

/** 一个工具在界面上的投影（设置 → 模式 的工具多选；只读，不带 run）。 */
export interface ToolEntryView {
  name: string
  /** 风险档：read 自动放行，write / exec 要过审批。 */
  risk: 'read' | 'write' | 'exec'
  description: string
  /** 只在列出的模式里露面；不写 = 所有模式都能看见它。 */
  presets?: string[]
}

/** 读一个模式文件原文的结果（「查看配置」用；失败时 error 是给用户看的一句话）。 */
export type PresetFileView = { ok: true; name: string; text: string } | { ok: false; error: string }

/** 新建或编辑一个模式的入参。 */
export interface PresetDraft {
  /** null = 新建；否则是被编辑模式的原名（支持改名）。 */
  oldName: string | null
  name: string
  label: string
  description: string
  /** 工具白名单；null = 全量。 */
  tools: string[] | null
  drop: string[]
  /** 省略 = 沿用旧文件里的值（表单还没暴露这一项）。 */
  replace?: boolean
  /** 正文 = 这个模式追加给模型的提示词。 */
  prompt: string
}

/**
 * 当前工作区的 git 读数（git 插件贡献）：在哪个分支、脏不脏。
 *
 * 输入框上那颗分支钮（壳 `plugins/composer`）与状态面板的分支行都读它。宿主**轻读**
 * （一条分支名 + 一条 `git status --porcelain -z` 数条数）；状态面板那条重读（每文件
 * 增删行数、未跟踪文件按内容数行）留在壳里自己按更松的节奏走。
 */
export interface GitSurface {
  /** 当前会话工作目录是不是 git 仓库。false 时其余字段按空处理，界面整块不画。 */
  repo: boolean
  /** 分支名；HEAD 分离时给短 hash；仓库里一次提交都还没有时给 `(无提交)`。 */
  branch: string
  /** true = HEAD 分离（`branch` 那一栏是 hash，不是分支名）。 */
  detached: boolean
  /** 工作目录内有改动的文件数（含未跟踪；口径与「变更」页签一致）。 */
  dirtyFileCount: number
}

/**
 * 快照里由各功能点贡献的界面片段。
 *
 * 内置那几项由对应插件自己登记（`ctx.surfaces.register`），组装快照的那一层不认识任何具体功能。
 * 外部插件要加自己那一块就用声明合并，不要往上面塞字段：
 * `declare module '@dsc/runtime/contract.js' { interface RuntimeSurfaces { memory: MyView } }`。
 */
export interface RuntimeSurfaces {
  /** 当前分支与改动计数（git 贡献）；输入框那颗分支钮与状态面板的分支行读它。 */
  git: GitSurface
  /** 挂起的审批卡（approval 贡献）；同一时刻至多一张。 */
  pendingApproval: ApprovalRequestView | null
  /** 权限模式与可切档位（approval 贡献）。 */
  policy: PolicySurface
  /**
   * 打包权限预设（permission-presets 贡献）：沙箱 + 权限模式 + 审阅者 三合一。
   * 输入框那颗权限旋钮与设置页都读它——分开选会出现「完全访问 + 沙箱仍工作区可写」
   * 这种自相矛盾的组合，预设把它们锁在一起。
   */
  permissionPresets: PermissionPresetSurface
  /** 协作模式与可切档位（mode 贡献）。 */
  mode: ModeSurface
  /** 模式（预设）与可切清单（presets 贡献）。 */
  preset: PresetSurface
  /** 任务清单（todo 贡献）；没有任务时 items 为空数组。 */
  todos: TodoView
  /** 挂着等用户批的计划（plan 贡献）；null = 无。 */
  pendingPlan: PlanView | null
  /** 会话目标（goal 贡献）；null = 没设目标。 */
  goal: GoalView | null
  /** 模型发起的提问（ask 贡献）；同一时刻至多一个，它自己可能带一批题目（见 AskUserView.questions）。 */
  pendingQuestion: AskUserView | null
  /** 正在跑的后台作业与终端会话（tools-default 贡献）：只出当前查看会话起的，没有就是空数组。 */
  backgroundWorks: BackgroundWorkView[]
  /** 本会话提交过的计划目录（plan 贡献）：最新在前，上限 12；待批的那份不在其中。 */
  planDirectory: PlanEntryView[]
  /**
   * 定点任务（schedule 贡献）。**可选**：schedule 插件默认关着，
   * 关着时这份投影整个缺席（界面按空处理，与「未登记的键缺席」同一约定）。
   */
  scheduled?: ScheduledTaskView[]
}

