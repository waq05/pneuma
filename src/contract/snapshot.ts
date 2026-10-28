/**
 * 契约分域：snapshot
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/snapshot
 */
import type { ApprovalAnswer } from './approval.js'
import type { ApprovalPolicy, ApprovalReviewer, CollaborationMode, EffortLevel } from './mode.js'
import type { MarketBrowseResult, MarketSource, ModelChoiceView, PluginInfoView, SessionForkResult, SkillInfoView, SkillLoadResult, TeammateView, UiCommandView, UiTrustView } from './plugin.js'
import type { PermissionPresetSurface, PresetDraft, PresetFileView, PresetSurface, RuntimeSurfaces, StatusView, ToolEntryView } from './runtime.js'
import type { ArchivedPage, SessionSummary, UiPrefsView } from './session.js'
import type { ConnectionTestView, ModelConfigView, ProviderDraft, SettingsMutation, SettingsSectionView, SettingsValue, SettingsValues } from './settings.js'
import type { BackgroundOutputView, PlanDecision } from './task.js'
import type { TranscriptEntry } from './transcript.js'
import type { UserFileAttachment } from '../core/attachments.js'
import type { SideAskView, UsageStatsView } from './usage.js'

/**
 * 跨会话运行状态（T21）：侧栏会话行状态点的值域。
 * working = 那个会话正在跑（当前回合进行中，或它是干着活的队友）；
 * awaiting-approval = 挂着等用户批；
 * just-finished = 后台跑完时你没在看（0.6.48 常驻多 agent），点开即熄。
 */
export type SessionRunState = 'working' | 'awaiting-approval' | 'just-finished'

/** UI 每帧读取的运行时快照（useSyncExternalStore 的 getSnapshot 返回）。 */
export interface RuntimeSnapshot {
  entries: TranscriptEntry[]
  status: StatusView
  /** 各功能点自己贡献的界面片段（见 {@link RuntimeSurfaces}）。 */
  surfaces: RuntimeSurfaces
  /** refreshSessions() 填充的会话列表缓存。 */
  sessions: SessionSummary[]
  sessionsLoading: boolean
  /**
   * 跨会话运行状态面（T21）：会话 jsonl 路径 → 运行状态，侧栏状态点的数据源。
   * 收录当前会话（按 turnState）、后台常驻 agent（dsc/agent-status 事件喂进来的，
   * 含「已完成未读」徽标）与正干着活的队友会话；不在场/收工已看的会话不出现。
   */
  sessionStates: Record<string, SessionRunState>
  /**
   * 状态栏右下角的子代理 chip（0.6.65）：只收当前查看会话、还在干活的队友。
   * 别的会话的动态不进状态栏——出口是 /resume 行内状态点（sessionStates）与
   * /agents 浮层；任务收工（settle）或切走会话即从这里消失。
   */
  subagents: Array<{ sessionPath: string; state: SessionRunState }>
  /**
   * 排队中的**用户**输入（0.6.67）：回合跑动中提交、还没被这一轮认领的那些。
   * 输入框下方的队列条照它画（可以编辑 / 撤掉 / 插话）；空数组 = 不画那条。
   *
   * 只含用户来源（`InboxOrigin` 的 `'user'`）——机器发起的唤醒不进这里，见 `notices`。
   */
  queued: QueuedMessageView[]
  /**
   * 待投递的**非用户**通知：回合跑动中到达、还没落到对话历史的机器唤醒
   * （队友汇报、后台作业完成、目标续跑、定时补投……）。输入框**上方**的只读
   * 「待投递通知」条照它画——这些不是人打的字，不给人编辑 / 撤掉 / 插话，
   * 也不把原始标记（`<teammate-report …>` 之类）直接上屏，压成一句含来源的人话。
   * 空数组 = 不画那条。
   *
   * 与 `queued` 同源（会话的 `async-inbox` 状态条目）：出账（drainInbox）后两者
   * 都清掉、落成对话里的一条 user 消息，模型侧对来源无感知。
   */
  notices: NoticeMessageView[]
}

/**
 * 一条排队中的用户输入（对照 dsh 的 InboxState `next-turn` 行）。
 *
 * 它在会话日志里只以 `async-inbox` 状态条目存在，落库（drainInbox）之后才算对话条目——
 * 所以界面不画气泡，画队列条。
 */
export interface QueuedMessageView {
  /** 在收件箱里的位置（0 在最前）：编辑 / 删除 / 插话都按它定位。 */
  index: number
  text: string
  /** 随消息一起排队的图片（引用或老式 data URL）。 */
  images?: string[]
  /** 随消息一起排队的视频 / 通用文件。 */
  files?: UserFileAttachment[]
}

/**
 * 一条待投递的非用户通知（对照 dsh 带来源的持久消息，落进对话流前的样子）。
 *
 * 与 {@link QueuedMessageView} 同源同生命周期，差别只在**只读**：机器唤醒没有
 * 「编辑 / 撤掉 / 插话」这三件事（它不代表人的意图），界面只显示一句摘要。
 * 刻意单开一个面而不是给 `QueuedMessageView` 加 `origin` 字段：两条带的组件、
 * 动作、样式完全不同（一条可交互、一条只读），分面后壳的两处渲染各自只读自己
 * 那一份，不会在「这条到底能不能编辑」上再判一次来源。
 */
export interface NoticeMessageView {
  /** 在收件箱里的位置（渲染层当 key 用；不用于动作定位）。 */
  index: number
  /** 通知原文（含宿主投递的标记文本）；界面负责压成一行摘要，不直接上屏原文。 */
  text: string
}

/**
 * adapter 实现、UI 消费的唯一运行期接口。
 *
 * 约定：
 *   - subscribe/getSnapshot 遵循 useSyncExternalStore 语义（快照引用在两次
 *     notify 之间稳定）；
 *   - 所有方法不得抛出未捕获异常到 UI；失败经 entries 追加 kind:'system'
 *     条目报告；
 *   - openSession(undefined) 新建会话并切换；openSession(id) 恢复之；
 *     newSessionIn(cwd) 在指定目录新建（目录是会话自己的数据，与宿主进程目录无关）；
 *     切换时清空 entries。
 *   - 0.6.48 起：切换会话**不打断**原来那个会话正在跑的回合（它转入后台
 *     继续跑完，侧栏亮状态点与「已完成」徽标）；打断只发生在显式 interrupt()。
 */
export interface DscRuntime {
  subscribe(listener: () => void): () => void
  getSnapshot(): RuntimeSnapshot
  /**
   * 提交一条用户消息（走 agent.followup）。
   * @param images - 随消息发送的图片引用（`/api/attachments/<sha>`；老调用点给 data URL）；
   *   当前模型没勾「照片」时发送方要先拦住。
   * @param files - 视频 / 通用文件的落盘元数据（模型侧只看到路径句柄；界面画文件卡）。
   */
  submit(text: string, images?: string[], files?: UserFileAttachment[]): void
  /**
   * 取消在跑的回合。缺省停当前查看的会话；指定会话 jsonl 路径时停那个**后台**
   * 会话（0.6.49：侧栏行右键「停止」）——回合以 aborted 收尾，挂着的审批卡
   * 随信号兜底成 reject。
   */
  interrupt(filePath?: string): void
  /**
   * 改一条排队中的输入（`RuntimeSnapshot.queued` 里的第 index 条）。
   * @returns 是否改到；那条已经出账（越界）时返回 false，界面据此给一句提示。
   */
  editQueued(index: number, text: string): boolean
  /** 撤掉一条排队中的输入：它还没进对话，撤了就等于没发过。 */
  removeQueued(index: number): boolean
  /**
   * 插话（对照 dsh 的 steer）：把第 index 条提到队首并**打断**当前回合，
   * 收尾出账后它作为新一轮的第一条发出去。
   * @param index - 省略则保持原顺序把整队送进去。
   * @returns 是否真的插上了；agent 没在跑（队列马上会自己出账）时返回 false。
   */
  steerQueued(index?: number): boolean
  /**
   * 打开一条会话；不给 id = 新建（落在**当前会话的目录**里）。
   * @param id - 要恢复的会话 jsonl 路径；省略 = 新建。
   */
  openSession(id?: string): Promise<void>
  /**
   * 在指定目录里新建一条会话并切过去。
   *
   * 目录是**会话自己的数据**（宿主把它写进 jsonl 的 meta 行），所以这只是「在那个
   * 目录开一条会话」——不切宿主的工作目录、不重启宿主、不重载页面。工作区行上那颗
   * 「在此新建会话」钮走的就是这条路（早先它走切目录 + 重启宿主，整个界面会闪一下）。
   * @param cwd - 绝对路径，必须存在且是目录；不合法时**抛错**（调用方提示用户）。
   */
  newSessionIn(cwd: string): Promise<void>
  compact(): Promise<void>
  setModel(model: string): Promise<void>
  setEffort(effort: EffortLevel): Promise<void>
  /** 异步刷新 sessions 列表（结果写回快照的 sessions/sessionsLoading）。 */
  refreshSessions(): Promise<void>
  /** 归档一批会话（会话行与工作区行「归档全部」共用一条通道）。 */
  archiveSessions(paths: string[]): Promise<SettingsMutation>
  /** 归档页数据（设置 → 归档；按归档时间倒序，带回收站目录与文件数）。 */
  listArchivedSessions(): Promise<ArchivedPage>
  /** 用量统计（设置「用量统计」分区数据源；聚合 ~/.dsc/usage/usage.jsonl）。 */
  usageStats(): Promise<UsageStatsView>
  /**
   * 旁问：只读的一次性问答（不建会话、不落盘、不带工具），实现见 core/side-ask.ts。
   *
   * @param question 问题（≤ core/side-ask 的 SIDE_ASK_MAX_QUESTION）
   * @param quote 会话里选中的原文（可省；超长由宿主截断）
   * @param requestId 取消用的票据；同一张票据只能取消这一次
   */
  sideAsk(
    question: string,
    quote: string,
    requestId: string,
    provider: string,
    model: string,
  ): Promise<SideAskView>
  /** 取消一次正在进行中的旁问（票据不认识就什么都不做）。 */
  sideAskCancel(requestId: string): Promise<boolean>
  /** 从归档区恢复一批会话。 */
  restoreSessions(paths: string[]): Promise<SettingsMutation>
  /** 永久删除一批会话：移进 `~/.dsc/.trash/`，30 天后自动清。 */
  purgeSessions(paths: string[]): Promise<SettingsMutation>
  /** 改会话显示名（写 meta.json，不动 jsonl 本体）。 */
  renameSession(path: string, title: string): Promise<SettingsMutation>
  /** 置顶或取消置顶一个会话。 */
  setSessionPinned(path: string, pinned: boolean): Promise<SettingsMutation>
  /** 分叉菜单的数据源：这个会话里的用户消息（数组下标就是分叉位置）。 */
  listUserMessages(path: string): Promise<string[]>
  /** 分叉会话：把日志复制到第 index 条用户消息之前，返回新会话路径。 */
  forkSession(path: string, index: number): Promise<SessionForkResult>
  /** 侧栏界面偏好（排序方式、工作区顺序与别名）。 */
  getUiPrefs(): UiPrefsView
  /** 改侧栏界面偏好（写 `~/.dsc/settings.json`）。 */
  setUiPrefs(patch: Partial<UiPrefsView>): Promise<SettingsMutation>
  /** 可切换的模型列表（进程内静态，UI 可在挂载时取一次）。 */
  listModels(): ModelChoiceView[]
  /** 插件清单（内置 + 外部；宿主启动时扫描的快照）。 */
  listPlugins(): PluginInfoView[]
  /** 更新外部插件启用状态（热生效：热挂载/卸载，写 ~/.dsc/plugins.json 持久化）。 */
  setPluginEnabled(file: string, enabled: boolean): void
  /** 第三方界面插件的信任状态清单（插件中心信任卡的数据源）。 */
  listUiTrust(): UiTrustView[]
  /** 落一条第三方界面插件的信任记录（确认动作的终点；写 plugins.json 的 uiTrust 段）。 */
  setUiTrust(name: string): SettingsMutation
  /**
   * 队友清单（智能体团队开着才有内容；关着返回空数组）。
   * UI 在「队友」这一档开着时轮询它。
   */
  listTeammates(): TeammateView[]
  /**
   * 收掉一个队友（用户从界面上动手；等价于 `subagent` 工具的 stop）。
   * 队友名字不存在时返回的那句话就是明确的错误说明，不抛错。
   */
  stopTeammate(name: string): Promise<string>
  /**
   * 给队友投一句话（用户从界面上传话；等价于 `subagent` 工具的 message）。
   * 名字不存在或话是空的，返回的那句话就是明确的错误说明，不抛错。
   */
  messageTeammate(name: string, text: string): Promise<string>
  /**
   * 把一个收工的队友从名册移除（运行记录文件一并删除，名字随之释放）。
   * 还在干活的队友会被拒绝（先停止）；名字不存在时返回的那句话就是明确的错误说明，不抛错。
   */
  removeTeammate(name: string): Promise<string>
  /**
   * 收掉一个正在跑的后台作业（`job-N`）或持久终端会话（`term-N`）——用户在状态面板
   * 的「终端」区按停止时走它。等价于 `job_kill` / `terminal close` 的簿记与进程收尾，
   * 但目标是我们自己的后台表，**不过审批**（与 `stopTeammate` 同一条理由：收自己起的
   * 后台活不是新增动作面，是叫停）。id 不认识时返回的那句话就是明确的错误说明，不抛错。
   */
  stopBackground(id: string): Promise<string>
  /**
   * 只读读一次后台作业 / 终端会话的输出快照（状态面板「终端」区点开输出面后按秒轮询它）。
   * 与 {@link stopBackground} 同一档归属校验：只读当前查看会话起的那条；id 不认识或
   * 属于别的会话时 reject（消息可直接展示）。它**不动**模型的增量读游标（见
   * {@link BackgroundOutputView} 的说明）。
   */
  readBackground(id: string): Promise<BackgroundOutputView>
  /**
   * 只读重放一个会话文件的对话条目（看队友在干什么用）。
   * 它不改那个文件，也不能归档/删除/分叉——校验在 core/session.ts。
   */
  peekTranscript(file: string): Promise<TranscriptEntry[]>
  /**
   * 技能清单（全部来源合并、重名按 rank 裁决、含被停用的条目）。
   * 工作目录取当前会话的 cwd，项目级技能因此随会话变化。
   */
  listSkills(): SkillInfoView[]
  /** 读一个技能的正文（技能中心详情用；不存在返回 ok:false）。 */
  readSkill(name: string): Promise<SkillLoadResult>
  /** 启停技能（写 ~/.dsc/skills.json，下一次请求生效）。 */
  setSkillEnabled(name: string, enabled: boolean): SettingsMutation
  /** 浏览技能市场（source 省略时用第一个源）。 */
  browseMarket(source?: string): Promise<MarketBrowseResult>
  /** 从市场源安装一个技能到 ~/.dsc/skills/。 */
  installMarketSkill(source: string, name: string): Promise<SettingsMutation>
  /** 覆盖市场源清单（写 ~/.dsc/settings.json）。 */
  setMarketSources(sources: MarketSource[]): SettingsMutation
  /** 设置分区清单（内置 + 插件贡献，按 order 排序）。 */
  getSettingsSections(): SettingsSectionView[]
  /** 读一个分区当前控件值。 */
  getSectionValues(id: string): Promise<SettingsValues>
  /** 写一个控件的值（分区自己的 save 回调校验；失败原因回 UI）。 */
  setSettingValue(id: string, key: string, value: SettingsValue): Promise<SettingsMutation>
  /** 执行分区的按钮动作（返回值里的 notice 由插件给出）。 */
  runSettingAction(id: string, action: string): Promise<SettingsMutation>
  /** 模型配置全貌（设置「模型」分区数据源）。 */
  getModelConfig(): ModelConfigView
  /**
   * 拉一个端点线上可用的模型清单（T23，设置 → 模型里「拉取清单」用）。
   * 连不上或应答认不得时 reject（消息可直接展示）。
   */
  discoverModels(provider: string): Promise<string[]>
  /**
   * 测一次端点连接（设置 → 模型里「测试连接」用）：拿这个端点**真发一次**最小的
   * 对话请求，走与正常对话同一条链路（同协议适配器、同一份归因头）。
   *
   * 与 `discoverModels` 的分工：那个只证明地址可达（GET /models），这个证明
   * 「key / 模型 id / 协议 / 端点要的头」这一整套现在能用。
   *
   * 端点不存在、这个端点还没有模型时 reject；请求本身失败**不** reject——
   * 折成 `{ ok: false, error }` 返回，界面就近展示（点一次按钮不该弹两次错）。
   * `model` 缺省用「这个端点平时会用到的那个模型」。
   */
  testConnection(provider: string, model?: string): Promise<ConnectionTestView>
  /** 新增或编辑端点（写 config.yaml；当前会话正在用的端点同步热更新）。 */
  saveProvider(draft: ProviderDraft): Promise<SettingsMutation>
  /** 删除端点（写 config.yaml；默认端点被删时自动改指第一个可用端点）。 */
  removeProvider(name: string): Promise<SettingsMutation>
  /** 写入或清除端点的 API key（写 ~/.dsc/credentials.yaml 的 refs）。 */
  setProviderKey(name: string, apiKey: string | null): Promise<SettingsMutation>
  /** 设为默认端点/模型（写 config.yaml 并对当前会话立即生效）。 */
  setDefaultModel(provider: string, model: string): Promise<SettingsMutation>
  /**
   * 换一份配置文件用（写 settings.json 的 configFile 字段，空串 = 回到出厂那份 ~/.dsc/config.yaml）。
   *
   * 只在原生桥开放（与 saveProvider 那三件同一先例：写类入口不进界面通道）。文件本身不动，
   * 端点清单、模型编辑与后续写入全部改到这一份上；传进来的路径由设置页经系统文件对话框选，
   * 宿主这边仍按「存在 + 是文件 + 能解析出 providers」三道校验把关。
   */
  setConfigFile(path: string): Promise<SettingsMutation>
  /** 切换权限模式（readonly / auto-edit / full-access）。 */
  setPolicy(policy: ApprovalPolicy): void
  /** 切换审阅者（user = 本人点卡 / auto-review = 先给模型判官看一眼）。 */
  setReviewer(reviewer: ApprovalReviewer): void
  /** 打包权限预设投影（沙箱 + 权限模式 + 审阅者三合一）。 */
  listPermissionPresets(): PermissionPresetSurface
  /** 切到某个打包预设：一次写三个旋钮（沙箱 / 权限模式 / 审阅者）。 */
  usePermissionPreset(name: string): SettingsMutation
  /** 设为新会话默认的打包预设（写 `~/.dsc/settings.json`）。 */
  setDefaultPermissionPreset(name: string): SettingsMutation
  /** 派发一条 / 命令到宿主命令注册表（内置 + 外部插件命令统一）。 */
  runCommand(input: string): boolean
  /**
   * 壳 `/` 菜单的数据源：标了 `shell: true` 那批命令的元数据
   * （清单单一真源在 `core/commands-completion.ts`，理由也写在那里）。
   */
  listUiCommands(): UiCommandView[]
  /**
   * 壳的 `/` 命令派发：同一条注册表（内置 + 外部插件），但只放行
   * {@link DscRuntime.listUiCommands} 里那批，其余名字明确报错——界面通道与页面里的
   * 第三方插件都够不着权限旋钮、写文件、落信任、退出这些动作（`runCommand` 仍不进
   * 界面白名单，见 core/ui-methods.ts 的 UI_EXCLUDED）。
   */
  runUiCommand(input: string): boolean
  /**
   * 桌面端 dock 面板的工作区能力（desktop-dock 服务透传）：
   * fs-list / fs-read / git-status / git-stage / git-unstage / git-commit / git-log / git-diff。
   */
  dock(op: string, payload?: Record<string, unknown>): Promise<unknown>
  /**
   * 回答审批（四种决定；scope 语义见 ApprovalAnswer）。
   * @param source - 这个答案从哪儿点下来的：省略 = 宿主界面（桌面端 / 终端），
   *                 `'web'` = 手机浏览器（远程控制）。只影响审计记录里那一栏。
   */
  answerApproval(answer: ApprovalAnswer, source?: 'app' | 'web'): void
  /** 回答模型发起的提问（ask_user）；文本就是答案，一批多题时按题序一次交一题。 */
  answerQuestion(answer: string): void
  /** 回答计划评审卡（批准 = 切回执行模式开工）；拒绝时可附反馈原话，模型按它改方案。 */
  answerPlan(decision: PlanDecision, feedback?: string): void
  /** 切换协作模式（执行 / 计划 / 探索 / 免打扰），写进会话记录。 */
  setMode(mode: CollaborationMode): void
  /**
   * 模式（预设）投影：当前会话用的、新会话默认用的、全部可选。
   * 输入框那颗模式旋钮与设置页「模式」分区都读它。
   */
  listPresets(): PresetSurface
  /** 读一个模式的原文（「查看配置」只读用）；不存在时 ok:false 带一句话。 */
  readPreset(name: string): Promise<PresetFileView>
  /** 切换当前会话的模式（写会话记录，恢复会话时一起恢复）。 */
  usePreset(name: string): SettingsMutation
  /** 新建或覆盖一个模式（写 `~/.dsc/presets/<名字>.md`）。 */
  savePreset(draft: PresetDraft): SettingsMutation
  /** 删掉一个自定义模式（内置四个删不掉）。 */
  removePreset(name: string): SettingsMutation
  /** 设为新会话默认模式（写 `~/.dsc/settings.json`）。 */
  setDefaultPreset(name: string): SettingsMutation
  /**
   * 全部已注册工具（名字 / 风险 / 一行说明 / 归属模式）。
   * 设置 → 模式 的工具多选读它；这也是界面第一次能看见完整工具目录。
   */
  listTools(): ToolEntryView[]
  /** 用户侧目标动作：暂停 / 继续 / 清空 / 放宽轮次上限。 */
  goalAction(action: 'pause' | 'resume' | 'clear' | 'extend'): SettingsMutation
  /** 手动清空任务清单（清单条上的小按钮）。 */
  clearTodos(): void
  /** 退出应用（dispose → 进程结束）。 */
  exit(): void
  /** 释放全部资源（dispose agent、退订）；集成层在 ink unmount 后调用。 */
  dispose(): void
}

// ── 电脑操作（Computer Use）的跨层契约（0.6.68 补 parity 时追加；只追加、不重排上文） ──
//
// 这些类型原先只在 `src/core/desktop-control.ts` 里，模型可见的工具 schema、
// 无障碍观察结果、审计行都要用到同一份形状，故提升到这里做单一真源。
// 桌面端界面（若将来展示这些）与内核工具层都按这份形状对齐。

/**
 * 一个动作的目标。两种二选一（判别字段 `type`，与 ZCode 的 target 语义一致）：
 *   - `coordinate`：最近一张返回栅格上的整数像素（`frame_id` 用于对账是哪张图）；
 *   - `element`：该窗口最近一次无障碍观察里的控件索引（`state_id` 用于对账是哪次观察）。
 * 元素索引在该窗口的**最近一次观察**作用域内有效；元素消失必须 fail-closed（报错，绝不退化到坐标）。
 */
export type DesktopTarget =
  | { type: 'coordinate'; x: number; y: number; frame_id?: string }
  | { type: 'element'; index: number; state_id?: string }

/** 一次无障碍（UIA）观察里的一个控件。 */
export interface DesktopElement {
  /** 该次观察内的下标；元素作用域 = 该窗口最近一次观察。 */
  index: number
  /** 控件类型（UIA ControlType，去掉 `ControlType.` 前缀，例如 Button / Edit）。 */
  controlType: string
  /** 无障碍名称（按钮文案、输入框标签这类）。 */
  title: string
  /** UIA AutomationId（开发者给的稳定标识，可能为空）。 */
  automaid: string
  /** 控件的值（ValuePattern 可读时；否则空串）。 */
  value: string
  /** 屏幕物理像素矩形；读不到时为 null。 */
  bounds: { x: number; y: number; width: number; height: number } | null
  /** 支持的 UIA 模式名（Invoke / Toggle / SelectionItem / ExpandCollapse / Value / Scroll / RangeValue / Text）。 */
  patterns: string[]
  /** 是否可用（灰掉的控件为 false）。 */
  enabled: boolean
  /** 是否在屏外（最小化/滚动出视口）。 */
  offscreen: boolean
}

/** 观察绑定的窗口。 */
export interface DesktopWindowRef {
  /** 顶层窗口句柄（list_windows 里的 window_id 就是它）。 */
  id: number
  title: string
  bounds: { x: number; y: number; width: number; height: number } | null
}

/** 一次无障碍观察的完整结果。 */
export interface DesktopFrame {
  /** 这次观察的编号（element 目标的 state_id 对账用）。 */
  state_id: string
  /** 窗口归属进程名。 */
  app: string
  window: DesktopWindowRef
  /** 观察到的控件（按遍历顺序，index 与数组下标一致）。 */
  elements: DesktopElement[]
  /** 文本树（缩进的 `[index] ControlType "title" = "value"` 行）。 */
  text: string
  /** full = 全树；diff = 相对 base_state_id 的增量。 */
  snapshot_mode: 'full' | 'diff'
  /** diff 模式下的基线观察编号。 */
  base_state_id?: string
  /** diff 模式的增量结论（索引仍按基线有效）。 */
  diff?: { removed: number[]; added: number[]; changed: number[] }
}

/** 电脑操作的危险分级：只读观察 / 输入动作 / 系统级动作。 */
export type DesktopRiskTier = 'read' | 'input' | 'system'

