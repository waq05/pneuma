/**
 * 契约分域：usage
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/usage
 */
// @@imports@@

/**
 * 会话累计 token 用量。
 * 缓存命中两项只在端点上报过明细的请求上累计（命中率 = 命中 /（命中 + 未命中）），
 * 没上报明细的请求既不加命中也不加未命中——命中率才不会被稀释（口径与 usage-log 一致）。
 */
export interface TokenUsageView {
  inputTokens: number
  outputTokens: number
  /** 输入里的前缀缓存命中 tokens 合计；端点从未上报过明细时缺省。 */
  cacheHitTokens?: number
  /** 输入里的前缀缓存未命中 tokens 合计；同上。 */
  cacheMissTokens?: number
}

/** 用量统计的单日投影（本地时区的自然日）。 */
export interface UsageDayView {
  /** 本地时区的 YYYY-MM-DD。 */
  date: string
  inputTokens: number
  outputTokens: number
  /** 这一天的模型请求轮数。 */
  turns: number
  /** 按 `provider/model` 拆分的 token 总量（输入+输出）。 */
  byModel: Record<string, number>
  /**
   * 这一天的估算花费（人民币元，按 DeepSeek 官方单价换算）。
   *
   * 只有至少一笔记录能计价（provider 是 DeepSeek、模型在价目表里）时才有值；
   * 零日、以及用别家端点的日子都没有这一项——缺省表示「算不出来」，不是「花了 0 元」。
   */
  costCny?: number
}

/** 一个模型的用量汇总。 */
export interface UsageModelView {
  /** `provider/model`，与 daily byModel 的键一致。 */
  key: string
  inputTokens: number
  outputTokens: number
  turns: number
  /** 输入里的前缀缓存命中 / 未命中 tokens（端点没上报这项的记录按 0 计）。 */
  cacheHitTokens: number
  cacheMissTokens: number
}

/**
 * 用量统计（设置「用量统计」分区数据源）。
 * 宿主从 `~/.dsc/usage/usage.jsonl`（每次模型请求追加一条）聚合而来；
 * 这份日志从该功能上线那刻开始积累，更早的会话没有记录。
 */
export interface SideAskView {
  text: string
  model: string
  ms: number
  /** true = 用户按了停止（text 是半截）。 */
  stopped: boolean
}

export interface UsageStatsView {
  /** 最早一条记录的时间戳；一条都没有时 null。 */
  sinceTs: number | null
  totalInputTokens: number
  totalOutputTokens: number
  /**
   * 输入里的前缀缓存命中 / 未命中 tokens 合计（2026-10-03 起记录；更早的行没有这项，
   * 按 0 计）。两个数都只统计端点上报了明细的请求，命中率 = 前者 /（前者 + 后者）。
   */
  totalCacheHitTokens: number
  totalCacheMissTokens: number
  totalTurns: number
  /** 有记录的自然日数。 */
  activeDays: number
  /** 当前连续活跃天数（今天没活动就从昨天起算）。 */
  currentStreakDays: number
  longestStreakDays: number
  /** 单日 token 总量最高的那天；还没有记录时 null。 */
  peakDay: UsageDayView | null
  /** 首条记录所在日到今天（含零日）的逐日投影，按日期升序；跨度封顶 370 天。 */
  days: UsageDayView[]
  /** 按模型汇总，总量降序。 */
  models: UsageModelView[]
  /** 全部记录的估算花费合计（人民币元）；一笔都算不出来时缺省。 */
  totalCostCny?: number
}

/**
 * 单条会话的用量与耗时投影：壳进程读 `~/.dsc/usage/usage.jsonl` 后按会话 id 汇总
 * （折叠口径的唯一原件在 core/usage-log.ts 的 readSessionUsage，宿主与壳进程共用）。
 *
 * 为什么由壳进程读文件、而不是问宿主：这份日志本来就是纯数据文件，读它只多一次 IO，
 * 宿主忙着跑回合或正在重启时这段读数照样在。
 */
export interface SessionUsageView {
  /** 这个会话的模型请求条数（含切到本进程之前的历史请求）。 */
  requests: number
  inputTokens: number
  outputTokens: number
  /**
   * 前缀缓存读取（日志的 ch）与未缓存输入（日志的 cm）。
   *
   * 只有 0.6.46 起、且服务端真回了缓存明细的请求进这两个数：老行没有这两栏，
   * 把它们塞进分母会把命中率算低——宁缺不假（与设置页「前缀缓存命中」同口径）。
   */
  cacheHitTokens: number
  cacheMissTokens: number
  /**
   * 最后一次请求的输入 token：每次请求都会重发完整上下文，
   * 所以这就是此刻的上下文占用（服务端真值，不是估算）。
   */
  lastInputTokens: number
  /** 最后一次请求落盘的时刻（毫秒）；没有时间戳的行记 0。 */
  lastAt: number
  /**
   * 这一步的墙钟读数（毫秒，日志的 lm/ft/d，0.6.67 起；口径见 core/throughput.ts）：
   * `llmMs` 发出 → 定稿、`ttftMs` 首字延迟（配 `ttftSteps` 算平均）、
   * `decodeMs` 纯解码时间、`decodeTokens` 与它成对的那批请求的输出 token。
   *
   * 输出速度 = decodeTokens ÷ (decodeMs / 1000)，整个会话累计——不是「本轮」。
   * 老行没这三项：它们既不进分子也不进分母（宁缺不假）。
   */
  llmMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  /** 工具调用的累计耗时与次数（日志的 `k: 'tool'` 行）。 */
  toolMs: number
  toolCalls: number
}

