/**
 * 工具卡共用的一套口径：入参摘要、状态词、图标与动词、参数美化。
 *
 * 为什么从消息流插件里搬出来：轨迹页也要画工具行（旧的 `TraceView` 与 `ChatView`
 * 共用 `ToolCard` 是同一个道理）。壳里插件之间不能互相 import（各自独立打包），
 * 共用件只能住在平台层，经 `@dsc/ui` 转出去。
 *
 * 口径本身照抄对话页现行实现（不是旧桌面 `ToolCard.toolSummary` 的完整版——那边
 * 会递归取数字/布尔/数组，壳里一直用的就是这一版：字符串字段取前两个，认不出的
 * 工具回落到「目标」类字段）。改这里就是两张脸的摘要一起变，探针与自检跟着看。
 *
 * @module dsc-ui-shell/platform/tool-summary
 */
import type { ComponentType } from 'react'
import { IconCode, IconEdit, IconFolder, IconSearch, IconSpark, IconTerminal } from '../icons'

/** 各工具的摘要字段；不在表里的走 {@link DEFAULT_FIELDS}。 */
export const SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  bash: ['command', 'description'],
  shell: ['command', 'description'],
  read: ['file_path', 'path'],
  read_file: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path'],
  webfetch: ['url'],
  fetch: ['url'],
  task: ['description', 'prompt'],
}

/** 不认识的工具：只挑最像「目标」的几个字段。 */
export const DEFAULT_FIELDS: readonly string[] = [
  'file_path',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'description',
]

/** 换行压成空格，超长截断（按码点算，别把代理对劈成半个字）。 */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

/** URL 只留主机名（旧界面也是这个口径：整条链接太占地方）。 */
export function shortUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 工具调用的入参摘要：从 JSON 参数里挑两个关键字段拼成一行。
 *
 * 参数还没吐全（preparing）时不是合法 JSON，直接把原文当摘要（旧界面同样兜这一手）。
 */
export function toolSummary(name: string, argsText: string): string {
  let args: unknown
  try {
    args = JSON.parse(argsText) as unknown
  } catch {
    return oneLine(argsText, 72)
  }
  if (typeof args !== 'object' || args === null) return ''
  const record = args as Record<string, unknown>
  const picks = SUMMARY_FIELDS[name] ?? DEFAULT_FIELDS
  const parts: string[] = []
  for (const field of picks) {
    const value = record[field]
    if (typeof value !== 'string' || value === '') continue
    parts.push(oneLine(field === 'url' ? shortUrl(value) : value, 48))
    if (parts.length === 2) break
  }
  return oneLine(parts.join(' · '), 72)
}

/** 工具状态词（旧界面同一套说法）。 */
export const TOOL_STATUS_TEXT: Readonly<Record<string, string>> = {
  preparing: '准备中',
  running: '进行中',
  done: '完成',
  failed: '失败',
  rejected: '被拒',
}

/**
 * 已知工具的「动词 + 图标」。
 *
 * 照 codex 的口径（`• Ran <command>`）：行首一枚状态点、一枚图标、一个**加粗动词**，
 * 命令行跟在后面。动词中文化（跑了 / 读了 / 搜了…），状态点与图标承担「这是什么工具」。
 */
export const KNOWN_TOOLS: Readonly<
  Record<string, { verb: string; Icon: ComponentType<{ size?: number; className?: string }> }>
> = {
  bash: { verb: '跑', Icon: IconTerminal },
  shell: { verb: '跑', Icon: IconTerminal },
  read: { verb: '读', Icon: IconFolder },
  read_file: { verb: '读', Icon: IconFolder },
  write: { verb: '写', Icon: IconEdit },
  edit: { verb: '改', Icon: IconEdit },
  glob: { verb: '搜', Icon: IconSearch },
  grep: { verb: '搜', Icon: IconSearch },
  webfetch: { verb: '取', Icon: IconSearch },
  fetch: { verb: '取', Icon: IconSearch },
  task: { verb: '派', Icon: IconSpark },
}

/** 认不出的工具的图标。 */
export const UNKNOWN_TOOL_ICON = IconCode

/** 一次工具匹配的结果：图标 + 基础动词 + 是不是知名工具（决定要不要印原名）。 */
export interface ToolMatch {
  Icon: ComponentType<{ size?: number; className?: string }>
  known: boolean
  base: string
}

/** 按工具名配「图标 + 动词」；认不出的回落到通用图标与「调用」。 */
export function matchTool(name: string): ToolMatch {
  const known = KNOWN_TOOLS[name]
  return known !== undefined
    ? { Icon: known.Icon, known: true, base: known.verb }
    : { Icon: UNKNOWN_TOOL_ICON, known: false, base: '调用' }
}

/**
 * 动词随状态变（codex 的 `Ran` / `Running` 同一套二分）。
 * 失败 / 被拒不改动词——那种情形由行尾的状态词说，不用把动词也拧一遍。
 */
export function toolVerb(base: string, status: string): string {
  if (status === 'running') return `正在${base}`
  if (status === 'preparing') return `准备${base}`
  return `${base}了`
}

/** 参数原文能格式化就格式化，不能就原样——绝不因为格式坏掉而不显示参数。 */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2)
  } catch {
    return text
  }
}
