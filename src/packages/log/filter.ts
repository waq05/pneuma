/**
 * 日志落盘前的两道加工：把 cordis 的结构化消息还原成一行文本，再把凭据抹掉。
 *
 * **为什么脱敏单独成文件**：它是这个插件唯一「错了会出事」的一段。放在这里就能被
 * `node --test` 直接钉住（不需要起 ctx），而不是埋在 apply 里什么都测不到。
 *
 * **为什么按外形抹而不是按字段名抹**：日志是拿 printf 拼出来的字符串，塞进去的是
 * 一整个请求体，没有「这个字段叫 apiKey」这种结构可用。只能认外形，宁可多抹。
 *
 * @module pneuma/log/filter
 */
import { Logger } from '@deepseek-ai/cordis'
import type { Exporter, Message } from '@deepseek-ai/cordis'
import { redact } from '@pneuma/runtime/core/redact.js'

// 脱敏规则住在 core/redact，这里转出去只为让老调用点（测试）不必改导入路径。
// 规则本身只该有一份：日志与诊断包各写一套，早晚会出现「这边抹了、那边没抹」。
export { redact }

/**
 * 级别名，下标就是 cordis 的数值级别（`LoggerLevel`：error=0、warn=1、info=2、debug=3）。
 *
 * 阈值语义见 `Logger` 的派发处：`(levels[name] ?? levels.default ?? 2) < level` 就丢，
 * 所以「放行到 info」要写 2，「连 debug 都要」才写 3。
 */
export const LEVEL_NAMES = ['error', 'warn', 'info', 'debug'] as const

export type LevelName = (typeof LEVEL_NAMES)[number]

/** 名字 → 数值。设置页选的是名字，exporter 的 `levels` 只认数字。 */
export const LEVEL_VALUES: Record<LevelName, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

/** 配置或环境变量里读到的值是不是一个合法级别名。 */
export function isLevelName(value: unknown): value is LevelName {
  return typeof value === 'string' && (LEVEL_NAMES as readonly string[]).includes(value)
}

/**
 * 只用来渲染的假 exporter：`Logger.format` 只读它的 `formatters` 与 `maxLength`，
 * 两项都有缺省值，`export` 永远轮不到被调。声明在这里而不是每次写字面量，是为了
 * 满足 `Exporter` 的必填 `export` 而不用在每个调用点撒 `as`。
 */
const FORMAT_ONLY: Exporter = { export: () => {} }

/**
 * 把一条 cordis 消息还原成一行文本。
 *
 * 为什么不自己拼 `args`：`Logger.format` 处理了 printf 占位符、Error 栈首参、对象用
 * `%o` 展开、以及单行 10240 字符的截断——这些细节自己再写一遍只会写成另一个样子。
 */
export function renderMessage(message: Message): string {
  return Logger.format(FORMAT_ONLY, message)
}

/**
 * 一条落盘记录的形状。
 *
 * 字段名刻意短：一天几千行，字段名重复几千次也是体积。`t` 用 ISO，是因为排障时要和
 * 别处的日志对时，本地格式反而要多一步换算。
 */
export interface LogRecord {
  /** ISO 时间戳。 */
  t: string
  /** 级别名。 */
  lvl: LevelName
  /** 具名 logger 的名字；空串表示匿名。 */
  name: string
  /** 全局序号，用来判断两条日志的先后（同一毫秒内也分得清）。 */
  sn: number
  /** 已脱敏的正文。 */
  msg: string
}

/** 数值级别 → 名字；越界时回落 info（宁可标错级别，也不要丢这一条）。 */
export function levelNameOf(level: number): LevelName {
  return LEVEL_NAMES[level] ?? 'info'
}

/**
 * 结构化消息 → 落盘记录。正文在这里就抹干净，sink 不负责安全。
 *
 * @param message cordis 交给 exporter 的那一条。
 */
export function toRecord(message: Message): LogRecord {
  return {
    t: new Date(message.ts).toISOString(),
    lvl: levelNameOf(message.level),
    name: message.name,
    sn: message.sn,
    msg: redact(renderMessage(message)),
  }
}
