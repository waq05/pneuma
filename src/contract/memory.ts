/**
 * 契约分域：memory
 *
 * 长期记忆的纯类型（分格、条目、配置、写入选项）。定义从
 * `src/packages/memory/memory.ts` 搬来（逐字未改）：契约层不再依赖功能包，
 * 服务契约（`services/types.ts`）与界面侧都能直接用这些名字。
 *
 * 本文件必须保持 Node-free（浏览器侧会 import）：只有类型，不 import 任何 Node 内置模块。
 *
 * @module dsc/contract/memory
 */

/** 记忆分格。`global` 是跨项目的事实，`user` 是用户本人，`workspace` 只属于当前仓库。 */
export type MemoryTarget = 'global' | 'user' | 'workspace'

/**
 * 记忆条目的类型（照 ZCode 的类型枚举收成三档）：
 *   - `fact`：默认档，客观事实（构建命令、仓库布局这类）；
 *   - `feedback`：用户纠正 / 确认过的做法，正文建议带 Why 与 How to apply；
 *   - `reference`：外部资料 / 出处指针，本身不是结论。
 *
 * 存储形状向后兼容：只有非默认类型才在条目前加 `[feedback] ` / `[reference] ` 前缀，
 * 老的纯文本条目（没有前缀）一律读成 `fact`，文件不必迁移。
 */
export type MemoryType = 'fact' | 'feedback' | 'reference'

/** 一条写入操作。`replace` 与 `remove` 靠 `oldText` 定位条目。 */
export interface MemoryOperation {
  action: 'add' | 'replace' | 'remove'
  target: MemoryTarget
  /** `add` / `replace` 的新内容。 */
  content?: string
  /** `replace` / `remove` 要动的条目里的片段（只允许唯一匹配）。 */
  oldText?: string
  /** 条目类型；不填按 `fact`（`replace` 不填时沿用原条目的类型）。 */
  type?: MemoryType
}

/** 一格现在的样子。 */
export interface MemoryCell {
  target: MemoryTarget
  filePath: string
  /** 磁盘上已有的条目（原样，没过安检）。 */
  entries: string[]
  /** 已用字数（连分隔符一起算）。 */
  used: number
  /** 这一格的字数上限。 */
  limit: number
  /** 文件还不存在（第一次写入时才创建）。 */
  missing: boolean
  /** 读这份文件时发现的毛病（比如被外面改过，已备份）。 */
  problem: string
}

/** 长期记忆的全部可调值（插件配置 `memory` 那一节读出来的形状）。 */
export interface MemoryConfig {
  /** 总开关：关掉之后既不注入也不许写，文件原样留在盘上。 */
  enabled: boolean
  /** `user` 这一格参不参与（关掉等于不认识用户偏好）。 */
  userProfile: boolean
  /** `workspace` 这一格参不参与。 */
  workspace: boolean
  /** 三格各自的中文字数上限（含 `§` 分隔符）。 */
  limits: Record<MemoryTarget, number>
  /** 每次写入都要用户点头（默认关：点头点到模型懒得记，记忆就废了）。 */
  writeApproval: boolean
  /** 每隔多少轮用户发言做一次无人值守复盘。0 = 不做。 */
  reviewEveryTurns: number
  /** 复盘开关。 */
  reviewEnabled: boolean
  /** 会话打开时自动做一次保守整理（只移不删）。 */
  pruneEnabled: boolean
  /** 多久没被引用（也没被用过）算陈旧，整理时移进归档区。0 = 只要没被引用就移。 */
  pruneAfterDays: number
  /** 注入时记忆栏的行数上限（超了截断并说明，不动磁盘）。 */
  maxIndexLines: number
  /** 注入时记忆栏的字符数上限。 */
  maxIndexChars: number
}

/** 一批操作的结果。 */
export interface MemoryWriteResult {
  ok: boolean
  /** 失败原因（给人看的话）。 */
  error: string
  /** 每条操作各自的结果说明，长度与入参一致；失败时是空数组。 */
  notes: string[]
  /** 涉及的格子现在的样子（失败时也回吐，让模型当场看到该合并什么）。 */
  cells: MemoryCell[]
}

/** 落盘的选项。 */
export interface WriteOptions {
  /** 各格上限。 */
  limits?: Partial<Record<MemoryTarget, number>>
  /** 只允许 add：无人值守的自动复盘走这条路，不许删改既有条目。 */
  addOnly?: boolean
  /** 外部改动检测，默认开。关掉就等于允许盖掉别人的编辑。 */
  guardDrift?: boolean
}
