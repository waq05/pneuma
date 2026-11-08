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
  IconActivity, IconBolt, IconBrain, IconBranch, IconCalendar, IconClock, IconCode, IconDatabase, IconEdit, IconFolder, IconGear, IconGlobe,
  IconInfo, IconLayers, IconPackage, IconPuzzle, IconQueue, IconSearch, IconSpark, IconStop, IconTarget, IconTerminal,
  IconTree,
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
  // 后台作业与终端：作业号是这张卡唯一能说清「这一次读了哪个作业」的字段——
  // 2026-11-06 之前它不在表里，未知工具只认固定字段，于是整行只剩「工具调用 · job_output」。
  job_output: ['job_id', 'id', 'jobId', 'job'],
  job_list: ['session', 'status'],
  job_kill: ['job_id', 'id', 'jobId', 'job'],
  terminal: ['command', 'action', 'session'],
  // 定时任务 / 目标 / 团队：动作词与标题各取一个，读作「定时任务 · 创建 · 每日巡检」。
  schedule: ['title', 'action', 'id'],
  goal: ['objective', 'action'],
  team_task: ['task', 'name', 'title'],
  // 工具检索与插件管理：query 先说「找什么」，name 再说「哪个」。
  tool_search: ['query', 'name'],
  tool_describe: ['name', 'tool'],
  tool_call: ['name', 'tool'],
  plugin_manager: ['action', 'name', 'plugin'],
  // 交付 / 记忆 / 技能与经验。
  present: ['path', 'file', 'name'],
  memory: ['query', 'content', 'name'],
  skill_write: ['name'],
  learning: ['title', 'content'],
  // 浏览器 / 电脑 / MCP / 代码符号。
  browser: ['action', 'url', 'ref'],
  browser_look: ['action', 'url'],
  computer: ['action', 'app', 'title'],
  computer_look: ['app', 'title'],
  mcp: ['uri', 'name', 'server'],
  mcp_resources: ['uri', 'server'],
  mcp_prompts: ['name', 'server'],
  lsp: ['symbol', 'query', 'path'],
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
  // 表里那两三个字段都没命中（插件工具、MCP 工具、临时加的工具）时，别再交回空串——
  // 空摘要的那一行只剩「工具调用 · 名字」，正是用户截图里那串说不出干了什么的行。
  // 兜底取参数里第一个短字符串：作业号、查询词、URL 都在这条路上被捡起来。
  if (parts.length === 0) {
    for (const value of Object.values(record)) {
      if (typeof value !== 'string') continue
      const text = oneLine(value, 48)
      if (text === '') continue
      parts.push(text)
      break
    }
  }
  return oneLine(parts.join(' · '), 72)
}

/** 工具状态词（旧界面同一套说法）。 */
export const TOOL_STATUS_TEXT: Readonly<Record<string, string>> = {
  preparing: t('primitives.tool.status.preparing'),
  running: t('primitives.tool.status.running'),
  done: t('primitives.tool.status.done'),
  failed: t('primitives.tool.status.failed'),
  // 与 failed 分开：用户按停止不是「工具失败」，文案与配色都不该走错误那一档。
  aborted: t('primitives.tool.status.aborted'),
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
  // ── 2026-11-06 补齐：dsh 的 tool.title.* 词表覆盖后台作业、终端、定时、目标、团队、
  //    工具检索、插件、交付、记忆、浏览器、电脑、MCP、代码符号这一整片。这里按同一口径
  //    补上，免得它们全退回「工具调用 · <原名>」——用户截图里那串重复行就是这么来的。
  // 后台作业与终端（dsh 的 listJobs / readJob / killJob / openTerminal）。
  job_output: { verb: t('primitives.tool.jobOutput'), Icon: IconActivity },
  job_list: { verb: t('primitives.tool.jobList'), Icon: IconActivity },
  job_kill: { verb: t('primitives.tool.jobKill'), Icon: IconStop },
  terminal: { verb: t('primitives.tool.terminal'), Icon: IconTerminal },
  // 定时任务、会话目标、团队任务。
  schedule: { verb: t('primitives.tool.schedule'), Icon: IconCalendar },
  goal: { verb: t('primitives.tool.goal'), Icon: IconTarget },
  team_task: { verb: t('primitives.tool.teamTask'), Icon: IconTree },
  // 工具检索与插件管理。
  tool_search: { verb: t('primitives.tool.toolSearch'), Icon: IconSearch },
  tool_describe: { verb: t('primitives.tool.toolDescribe'), Icon: IconInfo },
  tool_call: { verb: t('primitives.tool.toolCall'), Icon: IconBolt },
  plugin_manager: { verb: t('primitives.tool.pluginManager'), Icon: IconPuzzle },
  // 交付文件、记忆、写技能、记录经验。
  present: { verb: t('primitives.tool.present'), Icon: IconPackage },
  memory: { verb: t('primitives.tool.memory'), Icon: IconDatabase },
  skill_write: { verb: t('primitives.tool.skillWrite'), Icon: IconSpark },
  learning: { verb: t('primitives.tool.learning'), Icon: IconBrain },
  // 浏览器与电脑操作：动作用 IconGlobe / IconBolt，看图用同族（不另造图形）。
  browser: { verb: t('primitives.tool.browser'), Icon: IconGlobe },
  browser_look: { verb: t('primitives.tool.browserLook'), Icon: IconGlobe },
  computer: { verb: t('primitives.tool.computer'), Icon: IconBolt },
  computer_look: { verb: t('primitives.tool.computerLook'), Icon: IconBolt },
  // MCP 资源与代码符号：MCP 走分层图标，LSP 走代码图标。
  mcp: { verb: t('primitives.tool.mcp'), Icon: IconLayers },
  mcp_resources: { verb: t('primitives.tool.mcpResources'), Icon: IconLayers },
  mcp_prompts: { verb: t('primitives.tool.mcpPrompts'), Icon: IconLayers },
  lsp: { verb: t('primitives.tool.lsp'), Icon: IconCode },
  // ── 2026-11-07：补齐 dsh 的 tool.title.* 词表里剩下没登记的那批名字（dsh 的
  //    ui-tool/src/client/tool/models/tool-call-model.ts 是那张表的正本）。这些名字
  //    多半来自 dsh 兼容层加载的插件工具：不登记就退化成「工具调用 · <原名>」，
  //    一屏十几行同样的字，读者认不出这是哪一类操作。词与图标都照 dsh 的对照关系走。
  apply_patch: { verb: t('primitives.tool.applyPatch'), Icon: IconEdit },
  subagent_fork: { verb: t('primitives.tool.subagentFork'), Icon: IconTree },
  list_agents: { verb: t('primitives.tool.listAgents'), Icon: IconTree },
  send_message: { verb: t('primitives.tool.sendMessage'), Icon: IconTree },
  interrupt_agent: { verb: t('primitives.tool.interruptAgent'), Icon: IconTree },
  list_subagent_models: { verb: t('primitives.tool.listModels'), Icon: IconInfo },
  wait_agent: { verb: t('primitives.tool.waitAgent'), Icon: IconTree },
  session_trace: { verb: t('primitives.tool.sessionTrace'), Icon: IconSearch },
  session_event_read: { verb: t('primitives.tool.sessionEventRead'), Icon: IconQueue },
  session_event_search: { verb: t('primitives.tool.sessionEventSearch'), Icon: IconSearch },
  session_event_trace: { verb: t('primitives.tool.sessionEventTrace'), Icon: IconSearch },
  terminal_open: { verb: t('primitives.tool.terminalOpen'), Icon: IconCode },
  terminal_read: { verb: t('primitives.tool.terminalRead'), Icon: IconCode },
  terminal_list: { verb: t('primitives.tool.terminalList'), Icon: IconCode },
  terminal_signal: { verb: t('primitives.tool.terminalSignal'), Icon: IconCode },
  terminal_close: { verb: t('primitives.tool.terminalClose'), Icon: IconCode },
  schedule_create: { verb: t('primitives.tool.scheduleCreate'), Icon: IconClock },
  schedule_list: { verb: t('primitives.tool.scheduleList'), Icon: IconClock },
  schedule_view: { verb: t('primitives.tool.scheduleView'), Icon: IconClock },
  schedule_edit: { verb: t('primitives.tool.scheduleEdit'), Icon: IconClock },
  schedule_delete: { verb: t('primitives.tool.scheduleDelete'), Icon: IconClock },
  schedule_update: { verb: t('primitives.tool.scheduleUpdate'), Icon: IconClock },
  create_goal: { verb: t('primitives.tool.goalCreate'), Icon: IconTarget },
  get_goal: { verb: t('primitives.tool.goalGet'), Icon: IconTarget },
  update_goal: { verb: t('primitives.tool.goalUpdate'), Icon: IconTarget },
  team_task_create: { verb: t('primitives.tool.teamTaskCreate'), Icon: IconQueue },
  team_task_get: { verb: t('primitives.tool.teamTaskGet'), Icon: IconQueue },
  team_task_update: { verb: t('primitives.tool.teamTaskUpdate'), Icon: IconQueue },
  team_task_list: { verb: t('primitives.tool.teamTaskList'), Icon: IconQueue },
  spawn_teammate: { verb: t('primitives.tool.spawnTeammate'), Icon: IconTree },
  find_definition: { verb: t('primitives.tool.findDefinition'), Icon: IconCode },
  find_references: { verb: t('primitives.tool.findReferences'), Icon: IconCode },
  find_implementation: { verb: t('primitives.tool.findImplementation'), Icon: IconCode },
  hover_symbol: { verb: t('primitives.tool.hoverSymbol'), Icon: IconInfo },
  cordis_package_inspect: { verb: t('primitives.tool.cordisInspect'), Icon: IconPuzzle },
  cordis_inspect_list: { verb: t('primitives.tool.cordisInspectList'), Icon: IconPuzzle },
  cordis_inspect_query: { verb: t('primitives.tool.cordisInspectQuery'), Icon: IconPuzzle },
  cordis_inspect_self: { verb: t('primitives.tool.cordisInspectSelf'), Icon: IconPuzzle },
  cordis_runtime_inspect: { verb: t('primitives.tool.cordisInspect'), Icon: IconPuzzle },
  cordis_run: { verb: t('primitives.tool.cordisRun'), Icon: IconPuzzle },
  cordis_stop: { verb: t('primitives.tool.cordisStop'), Icon: IconPuzzle },
  cordis_undefine: { verb: t('primitives.tool.cordisRemove'), Icon: IconPuzzle },
  workflow: { verb: t('primitives.tool.workflow'), Icon: IconBranch },
  ralph: { verb: t('primitives.tool.ralph'), Icon: IconBranch },
}

/** 认不出的工具的图标。 */
export const UNKNOWN_TOOL_ICON = IconGear

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

/**
 * 按名字前缀归类的工具族：精确表没命中时先看它。
 *
 * 为什么按前缀而不是逐个登记：ops_ 这一族在桌面上有十三个动作（读文件 / 读表格 /
 * 读 docx / 复制 / 移动 / 删除…），逐个列一遍既读不完也维护不动；归成「文件操作」
 * 一族、原名仍跟在「 · 」后面，读作「文件操作 · ops_read_table」，比「工具调用 · …」清楚。
 * 同一条理由给 MCP 兜底（mcp__<server>__<tool> 这类名字）。
 */
const TOOL_PREFIXES: Readonly<Record<string, { verb: string; Icon: ComponentType<{ size?: number; className?: string }> }>> = {
  ops_: { verb: t('primitives.tool.ops'), Icon: IconFolder },
  mcp_: { verb: t('primitives.tool.mcp'), Icon: IconLayers },
}

/** 按工具名配「图标 + 动词」；认不出的回落到通用图标与「工具调用」。 */
export function matchTool(name: string): ToolMatch {
  const known = KNOWN_TOOLS[name]
  if (known !== undefined) return { Icon: known.Icon, known: true, base: known.verb }
  // 前缀族照旧 known: false：标题是族名，原名得留在后面，否则分不清是读还是删。
  for (const [prefix, entry] of Object.entries(TOOL_PREFIXES)) {
    if (name.startsWith(prefix)) return { Icon: entry.Icon, known: false, base: entry.verb }
  }
  return { Icon: UNKNOWN_TOOL_ICON, known: false, base: UNKNOWN_TOOL_TITLE }
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
