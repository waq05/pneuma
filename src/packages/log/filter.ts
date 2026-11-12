/**
 * 日志落盘前的两道加工：把 cordis 的结构化消息还原成一行文本，再把凭据抹掉。
 *
 * 级别与脱敏的实现都住在 core（`core/log-config` 与 `core/redact`），这里只做转出与拼装：
 * 面板包要读同一份级别定义，诊断包要抹同一份凭据——各写一份早晚分叉。
 *
 * @module pneuma/log/filter
 */
import { Logger } from '@deepseek-ai/cordis'
import type { Exporter, Message } from '@deepseek-ai/cordis'
import { levelNameOf } from '@pneuma/runtime/core/log-config.js'
import type { LevelName } from '@pneuma/runtime/core/log-config.js'
import { redact } from '@pneuma/runtime/core/redact.js'

// 脱敏与级别口径都只该有一份；转出去，老调用点（测试）不必改导入路径
export { redact }
export { LEVEL_NAMES, LEVEL_VALUES, isLevelName, levelNameOf } from '@pneuma/runtime/core/log-config.js'
export type { LevelName } from '@pneuma/runtime/core/log-config.js'

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
