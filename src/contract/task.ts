/**
 * 契约分域：task
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/task
 */
// @@imports@@

/**
 * 任务清单条目的状态。
 * core/todo.ts 直接用它（不再另写一遍四个字符串），界面与存储因此不可能各说一套。
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** 任务清单里的一条（界面渲染用；正文已被截到 300 字以内）。 */
export interface TodoItemView {
  id: string
  content: string
  status: TodoStatus
  /** 父任务 id；有值表示它是上一条的子任务，界面缩进一级。 */
  parent?: string
}

/** 任务清单投影：整表 + 版本号 + 进度，界面靠 revision 丢掉过期帧。 */
export interface TodoView {
  items: TodoItemView[]
  revision: number
  /** 已完成数（cancelled 不计入分母）。 */
  done: number
  /** 有效任务总数。 */
  total: number
  /** 当前在做的那条正文（清单条上直接显示）。 */
  active: string | null
}

/** 计划评审卡的状态。 */
export type PlanDecision = 'pending' | 'approved' | 'rejected'

/** 一份待批的计划。 */
export interface PlanView {
  /** 计划落盘的文件（相对工作目录显示由界面决定）。 */
  file: string
  title: string
  /** 计划全文（markdown）。 */
  text: string
  /** 用户批没批；pending = 评审卡还挂着。 */
  decision: PlanDecision
}

/**
 * 一张「提交过的计划」的目录项（状态面板的「计划」区）。
 *
 * 与 {@link PlanView} 的区别：PlanView 是**正挂着等批**的那一张（含全文），
 * 这份只是目录里的一行读数。dsc 的计划在提交时就落盘（`.dsc/plans/`），
 * 条目只是「哪份文件、什么标题」的账——这份账按会话记（见 {@link PlanHistoryItem}），
 * 面板只列本会话提交过的计划（与参考实现「计划目录 = 会话自己的终态计划」同一口径）。
 */
export interface PlanEntryView {
  /** 计划文件的绝对路径（点一行在右侧栏打开它）。 */
  file: string
  /** 计划标题（提交时从正文首个 # 标题算好）。 */
  title: string
  /** 提交时刻（目录按它倒序）。 */
  at: number
}

/**
 * 会话计划目录里的一条账（plan 插件的 `plans` 状态条目的元素）。
 *
 * 为什么要这份账：面板的「计划」区只出**本会话**提交过的计划（对齐参考实现：
 * 计划目录是会话投影里的终态计划行，切会话互不可见）。文件系统里的 `.dsc/plans/`
 * 是所有会话共享的回看口、没有归属信息，扫盘分不出谁的——归属只能记在会话自己
 * 的日志里（appendState 追加进 jsonl，跨重启都在）。
 */
export interface PlanHistoryItem extends PlanEntryView {
  /** 这份计划的评审结果（落账用；面板行不显示——参考实现的面板行同样只有标题）。 */
  decision: PlanDecision
}

/**
 * 一项正在跑的后台工作（状态面板的「终端」区）：后台作业或持久终端会话。
 *
 * 只出**运行中**的，且只出**当前查看会话**起的那些（对齐参考实现：后台工作清单
 * 挂在会话快照上、按会话寻址，切会话互不可见）。收工的由通知与台账负责，
 * 面板不摆历史。
 */
export interface BackgroundWorkView {
  /** 作业 id（job-N）/ 终端会话 id（term-N）。 */
  id: string
  kind: 'job' | 'terminal'
  /** 行上的标题：作业 = 命令首行；终端 = 最近发进去的一条命令。 */
  title: string
  startedAt: number
}

/**
 * 一条后台活输出的**只读快照**（状态面板「终端」区点开的那一页）。
 *
 * 形状对准 core/tools/bash.ts 的 `JobOutputView` / `TerminalOutputView`（两者同族），
 * 只保留界面要画的那几个字段。口径与「模型的读口」分开：这是**尾部窗口快照**，
 * 不动模型的增量读游标（见 `JobTable.peek` 的说明），所以界面按秒轮询不会把模型
 * 该读到的输出吃掉。
 *
 * 头部丢字要能报出来（对照参考实现的 `truncated` / `outputPath`）：缓冲是环形的，
 * 超上限时从头部丢；`droppedChars > 0` 就说明现在看到的开头已经不是最初那个开头，
 * 界面据此显示一条「头部已丢弃 N 字符」的提示。
 */
export interface BackgroundOutputView {
  /** 作业 / 终端会话 id（与 {@link BackgroundWorkView.id} 同口径）。 */
  id: string
  kind: 'job' | 'terminal'
  /** 运行状态：作业 running/completed/failed/killed；终端 running/closed。 */
  status: string
  /** 这次快照给到的文本（已遮红）。 */
  text: string
  /** 输出绝对总长（含已丢弃头部）。 */
  totalChars: number
  /** 这次快照文本的绝对起点。 */
  from: number
  /** 头部被环形缓冲丢掉的字符数；0 = 从头都在。 */
  droppedChars: number
  /** true = 这次快照已经追上现存输出的末尾（在跑的活会继续长）。 */
  atEnd: boolean
}

/**
 * 一条定点任务（状态面板的「工作流」区；schedule 插件贡献）。
 *
 * dsc 没有工作流引擎，这一区绑的是最接近的「按规则自动跑一轮」——定时任务。
 * 插件默认关着，关着时这份投影整个缺席（界面按空处理，整区不渲染）。
 */
export interface ScheduledTaskView {
  id: string
  title: string
  enabled: boolean
  /** 下一次该跑的绝对时刻；null = 不再跑（一次性任务已跑过 / 还没排期）。 */
  nextRunAt: number | null
  /** 最近一次执行结果：never / running / ok / failed / blocked / skipped / done。 */
  lastStatus: string
  /** 最近一次失败 / 阻塞的原因原文（行上的提示词用它）。 */
  lastError: string | null
}

/**
 * 目标阶段。
 * `core/goal.ts` 直接 import 这个类型（那里只留别名），界面与存储因此共用一份声明。
 */
export type GoalPhaseView = 'active' | 'paused' | 'blocked' | 'complete'

/** 会话目标投影（界面顶部那条 goal 条的数据源）。 */
export interface GoalView {
  objective: string
  phase: GoalPhaseView
  rounds: number
  maxRounds: number
  /** phase=blocked 时说明卡在哪。 */
  blockedReason?: string
  /** 自动续跑开关（进程本地；重启后为 false）。 */
  armed: boolean
}

/** 模型问用户的一个问题（ask_user 工具的数据）。 */
export interface AskOptionView {
  label: string
  description?: string
}

/**
 * 一批提问里的一题：字段与单题视图完全相同，只是没有 `id`——
 * 题目在自己那一批里的位置就是它的标识。
 */
export interface AskQuestionItem {
  question: string
  header?: string
  options: AskOptionView[]
  multiSelect: boolean
  /** 「其他」自由输入是否允许。 */
  allowFreeText: boolean
}

/**
 * 模型发起的一次提问；界面渲染成带按钮的卡片，答案回给模型。
 *
 * 一次提问可以带好几题：`questions` 有内容时界面按「一张卡列出全部题目」渲染
 * （逐题作答、统一提交，一次调用把全部答案交回）；界面不认 `questions` 时
 * 就退回下面那几个单题字段，仍然能渲染出第 1 题。
 *
 * 单题字段因此是「第 1 题的投影」，和 `questions[0]` 必须同源：
 * 老会话回放里存下的单题视图没有 `questions`，也不需要迁移。
 */
export interface AskUserView {
  id: string
  question: string
  header?: string
  options: AskOptionView[]
  multiSelect: boolean
  /** 「其他」自由输入是否允许。 */
  allowFreeText: boolean
  /** 这一批的全部题目（含第 1 题）；单题提问可以不写，写了就必须与单题字段一致。 */
  questions?: AskQuestionItem[]
}

/** 提一个单题提问的入参：`id` 由服务发，`questions` 由服务按这一题的字段补出来。 */
export type AskUserViewInput = Omit<AskUserView, 'id' | 'questions'>

