/**
 * 浏览器两条链共用的输出口径与事件条目。
 *
 * 「两条链」指 `plugins/browser.ts` 那台一次性 Chrome 与 `plugins/dock-browser.ts` 那台
 * 侧栏浏览器。两者的启动、生命周期、信任口径都不一样（见 `docs/dock-browser-control.md`），
 * 所以是两个插件；但**模型读到的输出**必须一样——同一个错误在两处说成两种话，
 * 模型就学不会。
 *
 * 这几个函数原先在两处逐字各写一份（`report` / `describeRef` / `safeStringify` / `clock`），
 * 连注释都写着「照 browser.ts 的」——靠注释维持一致，迟早分叉。合到一处后：
 * （时间戳另有一份 `core/clock.ts`：它原先在这里输出 UTC、而沙箱日志输出本地时间。）
 *   - 输出形状只有一份定义；
 *   - 控制台、网络两行渲染也只有一份，不会一边改了格式另一边没跟上。
 *
 * 只收**输出形状**，不收业务判断：URL 守卫、ref 代际校验、进程清理都留在各自插件里。
 *
 * @module dsc/core/cdp/report
 */
import { clockText } from '../clock.js'
import { neutralizeInline } from '../untrusted.js'
import type { SnapshotRef } from './snapshot.js'

/** 一条控制台事件（含异常，异常压在 level='exception' 上）。 */
export interface ConsoleEntry {
  ts: number
  level: string
  text: string
}

/** 一条网络事件：请求发出时建条目，响应/失败时按 requestId 回填。 */
export interface NetworkEntry {
  ts: number
  requestId: string
  method: string
  url: string
  status: number
  mimeType: string
  failed: string
}

/** 一行人类可读摘要 + 一行结构化 JSON。 */
export function report(summary: string, data: Record<string, unknown>): string {
  return `${summary}\n${JSON.stringify(data)}`
}

/** ref 的人类可读描述（输出与报错里用）。 */
export function describeRef(ref: SnapshotRef): string {
  return `${ref.role}${ref.name === '' ? '' : ` "${ref.name}"`}`
}

/** 变量值的兜底字符串化（控制台参数可能是对象或循环引用）。 */
export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/** 控制台条目 → 一行 `[时间] 级别: 文本`（时间走 `core/clock.ts`，本地时间）。 */
export function consoleLine(entry: ConsoleEntry): string {
  return `[${clockText(entry.ts)}] ${entry.level}: ${entry.text}`
}

/** 网络条目 → 一行 `[时间] 方法 状态 mime 地址`（地址过 neutralizer 防注入）。 */
export function networkLine(entry: NetworkEntry): string {
  const status = entry.failed === '' ? String(entry.status === 0 ? '进行中' : entry.status) : `失败：${entry.failed}`
  const mime = entry.mimeType === '' ? '' : ` ${entry.mimeType}`
  return `[${clockText(entry.ts)}] ${entry.method} ${status}${mime} ${neutralizeInline(entry.url, 240)}`
}
