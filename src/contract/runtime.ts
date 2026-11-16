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
import type { ContextSegmentsView, TranscriptEntry } from './transcript.js'
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
   * 正在压缩上下文时的时间戳（毫秒）；没有这个字段 = 此刻没在压。
   *
   * 为什么界面需要它（0.7.2，2026-10-29 报障）：`/compact` 要调一次模型做摘要，快的时候
   * 几秒、慢的时候几十秒，这段时间会话里**一条消息都不动**，用户以为命令没生效。
   * dsh 的做法是在消息流尾部挂一条「compact · 正在压缩…」的活动行；这里只给事实
   * （什么时候开始的），动画与文案由界面自己画。
   */
  compactingSince?: number
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
  /**
   * 工具黑名单：列在这里的工具**不**进这个模式的工具目录（白名单之外的另一半）。
   * 为什么要有它：白名单只能表达「只给这几件」，而 PTC 档的真实口径是「全量减去插件管理」——
   * 全量清单会随插件增减而漂，写死一份白名单第二天就漏工具。
   */
  deny: string[]
  /** true = 正文替换整个系统提示（只留正文；AGENTS.md 与插件贡献段都不进）。 */
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
  /** 允许模式去掉的骨架提示段（界面画勾选框）：名单只在 packages/config-core/presets.ts 里有一份。 */
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
  /** 工具黑名单；省略 = 沿用旧文件里的值（表单还没暴露这一项）。 */
  deny?: string[]
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
 * 一张工单在界面上的阶段（与 superagent 包 `core/stage.ts` 的 `TicketStage` 同构）。
 *
 * 为什么在契约里另写一份而不用 declare module 增强：契约层不得 import `packages/**`
 * （依赖方向只能 packages → contract），所以照形状抄一份。两边一旦漂了，插件侧给
 * `SuperagentTicketView` 赋值那行会编译报错，不会静静错位。
 */
export type SuperagentStage =
  | { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' }
  | { stage: 'idle' }
  | { stage: 'ended' }

/** 一张工单的界面投影（Super Agent 工单列表与详情页的数据源）。 */
export interface SuperagentTicketView {
  /** 工单 id（32 位十六进制）；界面的停 / 重试 / 清理 / 看会话都拿它当入参。 */
  id: string
  title: string
  /** 当前阶段；界面按它分「需要你 / 进行中 / 已完成」三组（见 `SuperagentSurface.counts`）。 */
  stage: SuperagentStage
  /**
   * 建单时刻（ISO 8601）。
   *
   * 名字与命令层 `TicketView.createdAt` 不同是有意的：界面契约统一叫 `at`
   * （`recent` 里的每一条也叫 `at`），插件侧映射时填同一个值。
   */
  at: string
  /** 工作树分支名（执行器建树时记的 `agent/<slug>`）；还没建树时没有这一项。 */
  branch?: string
  /** 改动的文件路径；P0 领域层还没记这份清单，先留字段不填。 */
  changedFiles?: string[]
  /** 最近一份 worker 报告的摘要（它说干了什么）；一次都没报过时没有这一项。 */
  summary?: string
  /**
   * 工单等人回答的那个问题原话（`stage.action === 'answer'` 时有）。
   *
   * 界面据此在回话输入框上面写清「它在问什么」；没有问题的档位不带这一项，
   * 与「有但为空」区分开（前者整块不画）。
   */
  question?: string
}

/**
 * 一个来源的轮询状态（GitHub / 飞书各一条）。
 *
 * **为什么没有 `label`**：快照面属于宿主侧，宿主不夹带人类语言——同一份快照要同时喂给
 * 中文与英文界面。名称由界面按 {@link SuperagentSourceView.id} 取词（`github` / `feishu`），
 * 认不出的 id 原样显示；将来加来源不必改契约，也不必让宿主猜界面语言。留一个没人用的
 * `label` 字段比没有更糟：两处文案一旦不一致，谁也不知道该信哪一份。
 */
export interface SuperagentSourceView {
  /** 来源 id：`github` / `feishu`。界面按它取词与排序，宿主不认识任何显示名。 */
  id: string
  /** 设置里开着没有（关着的来源也列出来，界面画成「未启用」）。 */
  enabled: boolean
  /**
   * 上次轮询的时刻（ISO 8601）；还一轮都没跑过就没有这一项。
   *
   * 注意：两个适配器都在**每轮开始时**记这一笔（`github/source.ts:495`、
   * `feishu/loops.ts:502`），失败的那一轮也会更新它。所以它不是「上次成功」，界面文案
   * 按「上次轮询」写；要真正的「上次成功」得改适配器，或在接线层另记一笔。
   */
  lastPollAt?: string
  /** 上次失败的原文；成功之后清掉。 */
  lastError?: string
}

/**
 * Super Agent 的快照面（§8.2）。
 *
 * 宿主插件 `@pneuma/superagent` 默认关着：关着时这一格整个缺席，界面按「未启动」画，
 * 不要拿缺字段当错误（与 `scheduled?` 同一约定）。开着但库还没打开时是
 * `ready: false` + 一句 `problem`，界面据此说清卡在哪。
 */
/**
 * 一条等人拍板的推断候选（backlog G1）。
 *
 * 只放界面画卡片要的几项：判定结果本身（`AssessmentOutcome`）留在库里，人点「接单」
 * 时由宿主原样交给引擎，不经界面转手——那是最容易改坏的形状。
 */
export interface SuperagentCandidateView {
  /** 候选 id（接单 / 忽略时回传它）。 */
  id: string
  /** 卡片标题（模型给的工单标题）。 */
  title: string
  /** 模型给的理由：为什么它被判成可以接。 */
  reason: string
  /** 工单范围。 */
  scope: string
  /** 来源（`github` / `feishu` / `manual`）。 */
  source: string
  /** 判定出来的时间（ISO）。 */
  at: string
}

/**
 * 一条设置变更（设置页「最近变更」块的一行）。对应上游管理面板的设置修订历史
 * （`app/settings-history.ts`），按 DSC 逐字段的保存方式裁成一行一字段。
 */
export interface SuperagentSettingsChangeView {
  /** 自增序号，新的在前。 */
  version: number
  /** 改动时间（ISO）。 */
  at: string
  /** 设置键（与设置分区的字段键同名；界面按 locale 的 `field.<key>.label` 显示）。 */
  key: string
  /** 改前值的显示形态（数组已拼成逗号分隔；缺省 = 该键此前没有）。 */
  from?: string
  /** 改后值的显示形态；缺省 = 回到了缺省（键被删）。 */
  to?: string
}

export interface SuperagentSurface {
  /** 运行期是否可用：false = 还没启动（懒建）或建库失败，看 `problem`。 */
  ready: boolean
  /** 不可用的原因；`ready: true` 时没有这一项。 */
  problem?: { code: string; detail: string }
  /** 三组计数（侧栏徽标与列表分组头）；三组之和等于 `tickets.length`。 */
  counts: { needsYou: number; running: number; done: number }
  /** 工单清单，新的在前。 */
  tickets: SuperagentTicketView[]
  /** 面板「最近动态」：工单结束那类通知，最旧在前（上限 20 条，由适配层截）。 */
  recent: { at: string; text: string }[]
  /**
   * 两个外部来源的轮询状态（GitHub / 飞书各一条，顺序固定）。
   *
   * **可选**：旧快照（或旧宿主）没有这一格，界面读到 `undefined` 时整块不画——
   * 「没有这一格」与「有但为空」是两件事，不要拿空数组冒充。
   * 关着的来源也列出来（`enabled: false`）：否则用户分不清「没配这个来源」与
   * 「配了但令牌过期 / CLI 挂了」，而这两种情况要做的操作完全不同。
   */
  sources?: SuperagentSourceView[]
  /**
   * 等人拍板的推断候选，新的在前。
   *
   * **可选**：「推断候选先等我确认」关着时这一格缺席（判定即接单，没有待确认的东西）。
   * 「没有这一格」与「有但为空」是两件事——界面按 `undefined` 整块不画，按空数组画一句
   * 「暂时没有待确认的候选」。
   */
  candidates?: SuperagentCandidateView[]
  /**
   * 设置变更历史，新的在前（最多 30 条，写入侧裁剪）。
   *
   * **可选**：旧快照没有这一格时界面整块不画。设置页保存成功且值真的变了才记一条，
   * 所以空数组 = 「记起之后还没改过设置」，不是「功能没做」。
   */
  settingsHistory?: SuperagentSettingsChangeView[]
}

/** 发布一张工单的入参（`superagentPublish` 的唯一实参）。 */
export interface SuperagentPublishInput {
  /** 标题（界面上的工单名）。 */
  title: string
  /** 正文 = 派给 worker 的需求原文。 */
  body: string
  /** 工作树起点 ref；省略 = HEAD。 */
  base?: string
}

/**
 * 面板上回一句工单当前问题的入参（`superagentAnswer` 的唯一实参）。
 *
 * 为什么是「一张工单 + 一段话」而不是「线程 + 一段话」：界面上人看见的是工单，
 * 线程是工单内部的挂接关系（哪条 issue / 哪个群），不该让界面知道。
 */
export interface SuperagentAnswerInput {
  /** 要回答的工单 id。 */
  ticketId: string
  /** 回答正文；原样作为一条人的消息走 `Engine.receive`，与 GitHub 评论进来同一条路。 */
  text: string
}

/** 按工单 id 操作（停 / 重试 / 清理 / 看执行会话）的入参。 */
export interface SuperagentTicketRef {
  id: string
}

/**
 * superagent 插件提供的服务（`ctx.superagent`）。
 *
 * 为什么这些动作要有服务：内核的 runtime 包不能 import 插件的类，界面通道只能经
 * `ctx.get('superagent')` 转发。契约声明在这里（而不是 `services/types.ts`），是因为
 * `DscRuntime` 的签名与快照面同属这一个域文件，界面侧只认这一个来源。
 */
export interface SuperagentService {
  /** 发布一条需求，返回工单 id。 */
  publish(input: SuperagentPublishInput): Promise<string>
  /** 停止一张工单（先让领域收尾，再停 worker）。 */
  stop(id: string): Promise<void>
  /** 重试一张失败 / 卡住的工单。 */
  retry(id: string): Promise<void>
  /**
   * 回答工单当前的那个问题（它停在「等你回答」时用）。
   *
   * 走的是与 GitHub 评论 / 飞书消息**同一条**路：造一条人的 Trigger，挂到这张工单的
   * 线程上，交给 `Engine.receive`。所以「面板上回的话」与「来源里回的话」在核心里
   * 没有第二条分支。
   */
  answer(input: SuperagentAnswerInput): Promise<void>
  /** 清理一张**已结束**工单的工作树。 */
  clean(id: string): Promise<void>
  /** 只读读一张工单的执行会话转录（不落盘、不拿写租约）。 */
  peekSession(id: string): Promise<TranscriptEntry[]>
  /**
   * 接一条等人拍板的推断候选（backlog G1），返回建出来的工单 id。
   *
   * `title` 可选：界面允许人在接单时改个更清楚的名字；不给就用判定时那个。
   */
  acceptCandidate(id: string, title?: string): Promise<string>
  /** 忽略一条等人拍板的推断候选（它就此结束，不再进工单）。 */
  ignoreCandidate(id: string, reason?: string): Promise<void>
  /** 当前快照面（`ctx.surfaces.register('superagent', …)` 读它）。 */
  surface(): SuperagentSurface
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
  /**
   * Super Agent 工单（superagent 贡献）。**非可选**是因为界面侧按 §8.2 的契约直接读
   * `snapshot.surfaces.superagent`；但宿主插件默认关着——关着时这一格缺席，
   * 界面读到 `undefined` 按「未启动」画（与 `scheduled` 的缺席约定一致）。
   */
  superagent: SuperagentSurface
}

/**
 * `DscRuntime` 上的 Super Agent 通道。
 *
 * 为什么写在这里而不是 `snapshot.ts`：`DscRuntime` 的本体在 `snapshot.ts:115`，而这份
 * 契约的改动面按分工只开 `runtime.ts`。模块增强（`declare module './snapshot.js'`）
 * 与写在原文件里对类型系统等价——`INVOKABLE_METHODS` / `bridge` 那些按 `keyof DscRuntime`
 * 推导的清单照样看得到这些方法，漏一条编译就红。
 *
 * 参数为什么是对象而不是裸字符串：界面通道的实参规格用 `json`（个数 1 / 可序列化 /
 * 长度上限），对象与裸字符串都能过校验；实现层两种形状都收（见 `packages/runtime`），
 * 这样并行在做的界面半用哪种写法都不会在运行期被拒。
 */
declare module './snapshot.js' {
  interface DscRuntime {
    /** 发布一张工单，返回工单 id。 */
    superagentPublish(input: SuperagentPublishInput): Promise<string>
    /** 停止一张工单。 */
    superagentStopTicket(input: SuperagentTicketRef | string): Promise<void>
    /** 重试一张失败 / 卡住的工单。 */
    superagentRetryTicket(input: SuperagentTicketRef | string): Promise<void>
    /**
     * 回答工单当前的那个问题（它停在「等你回答」时用）。
     *
     * 只收 `{ ticketId, text }`：不认裸字符串——「回答」是两个字段，不是一个 id。
     */
    superagentAnswer(input: SuperagentAnswerInput): Promise<void>
    /** 清理一张已结束工单的工作树。 */
    superagentCleanWorktree(input: SuperagentTicketRef | string): Promise<void>
    /** 只读读一张工单的执行会话转录。 */
    superagentPeekSession(input: SuperagentTicketRef | string): Promise<TranscriptEntry[]>
    /**
     * 接一条等人拍板的推断候选，返回建出来的工单 id。
     *
     * `title` 可选：界面允许人在接单时改个更清楚的名字；不给就用判定时那个。
     */
    superagentAcceptCandidate(input: { id: string; title?: string } | string): Promise<string>
    /** 忽略一条等人拍板的推断候选（它就此结束，不再进工单）。 */
    superagentIgnoreCandidate(input: { id: string; reason?: string } | string): Promise<void>
  }
}

