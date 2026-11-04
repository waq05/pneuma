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
import { createT } from '@dsc/ui-core'
import {
  IconCode, IconEdit, IconFolder, IconGlobe, IconInfo, IconQueue, IconSearch, IconSpark, IconTerminal, IconTree,
} from './icons'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui-core` 的 `createT`）。 */
const t = createT({ zh, en })

/** 各工具的摘要字段；不在表里的走 {@link DEFAULT_FIELDS}。 */
export const SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  bash: ['command', 'description'],
  shell: ['command', 'description'],
  pwsh: ['command', 'description'],
  read: ['file_path', 'path'],
  read_file: ['file_path', 'path'],
  read_image: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path'],
  webfetch: ['url'],
  fetch: ['url'],
  web_search: ['query'],
  session_search: ['query'],
  // run_code 的参数只有一段脚本：取第一行（去掉行首注释）当摘要，见 toolSummary 里的分流。
  run_code: ['code'],
  ask_user: ['question', 'prompt'],
  ask_user_question: ['question', 'prompt'],
  skill: ['name'],
  task: ['description', 'prompt'],
  subagent: ['description', 'prompt'],
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
 * 脚本类参数（`run_code` 的 `code`）的第一行：跳过空行，去掉行首注释标记。
 *
 * 为什么不直接把整段脚本压成一行：脚本动辄十几行，压平后摘要变成一长串没有句读的代码，
 * 前 48 个字往往还停在 import 或注释上。取第一行（通常是模型自己写的一句「这是干什么」）
 * 才是这张卡真正想说的话。
 */
function firstCodeLine(code: string): string {
  for (const raw of code.split('\n')) {
    const line = raw.trim().replace(/^\/\/\s*/, '')
    if (line !== '') return line
  }
  return ''
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
    const text = field === 'url' ? shortUrl(value) : field === 'code' ? firstCodeLine(value) : value
    if (text === '') continue
    parts.push(oneLine(text, 48))
    if (parts.length === 2) break
  }
  return oneLine(parts.join(' · '), 72)
}

/** 工具状态词（旧界面同一套说法）。 */
export const TOOL_STATUS_TEXT: Readonly<Record<string, string>> = {
  preparing: t('primitives.tool.status.preparing'),
  running: t('primitives.tool.status.running'),
  done: t('primitives.tool.status.done'),
  failed: t('primitives.tool.status.failed'),
  rejected: t('primitives.tool.status.rejected'),
}

/**
 * 已知工具的「名字 + 图标」。
 *
 * 口径照 dsh 的工具行（`dsh-client-ui-conversation/lib/client.js` 的 `tool.title.*` 字典）：
 * 一行读作「**这是什么工具** + 一句摘要」，不是「一个动作用了过去式」。
 * 2026-10-27 之前这里是动词（跑 / 读 / 搜 / 写），拼上状态后缀就读成「搜了 …」「正在写了 …」，
 * 中文里这是叙事口吻，一屏几十行显得吵；dsh 那一列是名词短语（读取 / 搜索文件内容 / 运行命令），
 * 状态交给行尾的状态词与状态点，所以这里按 dsh 的词表改。
 *
 * 词表不是新造的：`tool.title.read` = 读取、`tool.title.write` = 写入、`tool.title.edit` = 编辑、
 * `tool.title.bash`/`pwsh` = 运行命令、`tool.title.glob` = 查找文件、
 * `tool.title.grep` = 搜索文件内容、`tool.title.webFetch` = 网页获取、`tool.title.generic` = 工具调用。
 */
export const KNOWN_TOOLS: Readonly<
  Record<string, { verb: string; Icon: ComponentType<{ size?: number; className?: string }> }>
> = {
  bash: { verb: t('primitives.tool.bash'), Icon: IconTerminal },
  shell: { verb: t('primitives.tool.bash'), Icon: IconTerminal },
  // 2026-10-30 补：这台机器的工具表里跑得最多的就是下面这几个，缺一个就退化成
  // 「工具调用 · run_code」——标题没信息，摘要也取不到字段，一屏十几次同样的行。
  run_code: { verb: t('primitives.tool.runCode'), Icon: IconCode },
  pwsh: { verb: t('primitives.tool.bash'), Icon: IconTerminal },
  read_image: { verb: t('primitives.tool.readImage'), Icon: IconFolder },
  web_search: { verb: t('primitives.tool.webSearch'), Icon: IconGlobe },
  session_search: { verb: t('primitives.tool.sessionSearch'), Icon: IconSearch },
  todo_write: { verb: t('primitives.tool.todoWrite'), Icon: IconQueue },
  ask_user: { verb: t('primitives.tool.ask'), Icon: IconInfo },
  ask_user_question: { verb: t('primitives.tool.ask'), Icon: IconInfo },
  skill: { verb: t('primitives.tool.skill'), Icon: IconSpark },
  subagent: { verb: t('primitives.tool.subagent'), Icon: IconTree },
  exit_plan_mode: { verb: t('primitives.tool.exitPlan'), Icon: IconQueue },
  read: { verb: t('primitives.tool.read'), Icon: IconFolder },
  read_file: { verb: t('primitives.tool.read'), Icon: IconFolder },
  write: { verb: t('primitives.tool.write'), Icon: IconEdit },
  edit: { verb: t('primitives.tool.edit'), Icon: IconEdit },
  glob: { verb: t('primitives.tool.glob'), Icon: IconSearch },
  grep: { verb: t('primitives.tool.grep'), Icon: IconSearch },
  webfetch: { verb: t('primitives.tool.fetch'), Icon: IconSearch },
  fetch: { verb: t('primitives.tool.fetch'), Icon: IconSearch },
  task: { verb: t('primitives.tool.subagent'), Icon: IconSpark },
}

/** 认不出的工具的图标。 */
export const UNKNOWN_TOOL_ICON = IconCode

/**
 * 认不出的工具的行首标题（dsh 的 `tool.title.generic`）。
 *
 * 为什么是一句「工具调用」而不是动词：认不出名字就只有原名能说明身份，而原名
 * （`mcp__foo__bar` 这类）不适合当标题的谓语；用一句泛称打头、原名跟在「 · 」后面，
 * 与 dsh 的 `工具调用 · <工具名>` 同一个读法。
 */
export const UNKNOWN_TOOL_TITLE = t('primitives.tool.unknown')

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
    : { Icon: UNKNOWN_TOOL_ICON, known: false, base: UNKNOWN_TOOL_TITLE }
}

/**
 * 行首标题：**只给名字，不随状态变形**。
 *
 * 2026-10-27 之前它按状态拼后缀（`正在${base}` / `准备${base}` / `${base}了`），
 * 于是同一行在三态之间换字，长会话里一屏十几个「搜了」「写了」，读着像叙述而不是读数。
 * dsh 的行模型是「标题不按生命周期阶段变」：今天做什么、做到哪一步，由行尾状态词
 * （进行中 / 失败 / 被拒）与行首状态点说，标题只说「这是哪一类操作」。
 *
 * 保留函数而不是让调用点直接读 `base`：三处渲染（对话页 / 轨迹页 / 工厂）共用一条口径，
 * 将来要按状态微调时只改这里。`_status` 目前不参与拼字，留着是为了别让三处各写一份判断。
 * @param base 工具的名字（见 {@link KNOWN_TOOLS}；认不出的工具是「工具调用」）
 * @param _status 这一次调用的状态（当前不参与标题）
 */
export function toolVerb(base: string, _status: string): string {
  return base
}

/** 参数原文能格式化就格式化，不能就原样——绝不因为格式坏掉而不显示参数。 */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2)
  } catch {
    return text
  }
}
