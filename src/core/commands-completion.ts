/**
 * 斜杠命令的注册表与补全（/help 文本、命令与模型参数候选、唯一前缀展开）。
 *
 * 为什么独立成模块：渲染层 Composer 直接 import 这一份拿补全函数——vite 对
 * `node:child_process` 之类内置模块是「externalize 即炸」（顶层 import 一求值就抛，
 * 0.6.26 白屏教训），所以**这个模块的顶层不许出现任何 node 内置模块**。
 * 插件（plugins/commands.ts）从这里 re-export，终端侧的入口不变。
 *
 * @module dsc/core/commands-completion
 */
import type { CommandSpec, CompletionItem } from '../services/types.js'
import type { ModelChoiceView } from '../contract.js'

/**
 * 内置命令表（spec 单一真源；handler 在插件 apply 时注册）。
 *
 * `shell: true` 那批是**桌面壳输入框里列得出来、也执行得了**的命令（界面通道的
 * `listUiCommands` / `runUiCommand` 只认它们，见 core/ui-methods.ts）。挑的尺子两条，
 * 缺一不可：
 *
 *   1. 动作不出界面通道已有的权力面：`/new` ≈ `openSession`、`/compact` ≈ `compact`、
 *      `/review` ≈ `submit`、`/diff` ≈ `dock` 读类，其余四条只往会话里写一条系统通知；
 *   2. 壳里没有更顺手的替身：权限三根旋钮（`/policy` `/reviewer` `/permission`）与
 *      `/model` `/effort` 的旋钮就长在输入框底栏，`/resume` `/settings` `/agents`
 *      `/plugins` 各有常驻入口——在壳里再列一遍只会多出第二条真源。
 *
 * 硬理由不放的那几条：`/export`（往任意路径写文件）、`/ui-trust`（落第三方界面插件的
 * 信任记录）、`/exit`（宿主生命周期）写完面一律留在原生桥（core/native-bridge.ts），
 * 那是只对装了 preload 的桌面窗口开放的一条路；`/copy` 动的是**宿主**机器的剪贴板，
 * 手机端看着像复制到自己手机上，语义错位。
 */
export const BUILT_IN_COMMANDS: CommandSpec[] = [
  // T44：duringTask = 回合跑着的时候还能不能用。new/resume 会打断挂着审批的回合、
  // compact 会和进行中的落库交错，运行中一律挡下；其余随时可用。
  { name: 'new', args: '', description: '新建会话', duringTask: 'deny', shell: true },
  { name: 'resume', args: '', description: '恢复历史会话（先选工作区再选会话）', duringTask: 'deny' },
  { name: 'agents', args: '', description: '查看子代理与后台会话（转录只读）' },
  { name: 'compact', args: '', description: '压缩上下文', duringTask: 'deny', shell: true },
  {
    name: 'model',
    args: '<[端点/]模型名>',
    description: '切换模型，下一次请求生效（无参数打开选择器）',
  },
  { name: 'policy', args: '[readonly|auto-edit|full-access]', description: '查看或切换权限模式（自动放行集那一轴）' },
  { name: 'reviewer', args: '[user|auto-review]', description: '查看或切换审批审阅者（要问的事先给谁看）' },
  { name: 'permission', args: '[预设名]', description: '查看或切换打包权限预设（沙箱 + 权限模式 + 审阅者三合一）' },
  { name: 'effort', args: '[default|off|low|high|max]', description: '查看或切换思考强度' },
  { name: 'thinking', args: '[on|off]', description: '切换思考块展开显示（无参数 = 翻转，会话内生效）' },
  { name: 'fork', args: '', description: '分叉当前会话为可恢复的副本（当前会话不变）', duringTask: 'deny' },
  { name: 'plugins', args: '', description: '查看已挂载插件清单（启停与详情在桌面端插件中心）' },
  { name: 'ui-trust', args: '<插件目录名>', description: '信任一个第三方界面插件（首次安装的确认动作）' },
  { name: 'update', args: '', description: '检查有没有新版（只查不装）', duringTask: 'deny' },
  { name: 'status', args: '', description: '查看上下文占用与压缩余量', shell: true },
  { name: 'usage', args: '', description: '查看累计用量统计（含缓存命中率）', shell: true },
  { name: 'diff', args: '[文件]', description: '查看工作区未提交改动的 diff', shell: true },
  { name: 'copy', args: '', description: '复制上一条回复到剪贴板' },
  { name: 'export', args: '[文件路径]', description: '导出当前会话为 markdown' },
  { name: 'review', args: '[关注点]', description: '审查工作区未提交改动', shell: true },
  { name: 'settings', args: '', description: '打开设置页' },
  { name: 'help', args: '', description: '查看帮助', shell: true },
  { name: 'exit', args: '', description: '退出' },
]

/** 外部插件注册的命令（补全与唯一前缀展开用；模块级单例，进程内唯一注册表）。 */
const extraSpecs: CommandSpec[] = []

/** 全量 spec：内置 + 外部插件注册的。 */
export const allSpecs = (): CommandSpec[] => [...BUILT_IN_COMMANDS, ...extraSpecs]

/** 外部插件注册成功后把 spec 挂进来（registry 是唯一调用方）。 */
export function addExtraSpec(spec: CommandSpec): void {
  extraSpecs.push(spec)
}

/** 外部插件注销时摘掉。 */
export function removeExtraSpec(spec: CommandSpec): void {
  const at = extraSpecs.findIndex((entry) => entry.name === spec.name)
  if (at >= 0) extraSpecs.splice(at, 1)
}

/**
 * 壳（桌面 / 手机那份插件化界面）可见也可执行的命令：`shell: true` 那批。
 *
 * 界面通道的 `listUiCommands`（菜单数据源）与 `runUiCommand`（派发闸）都读这一份，
 * 所以「菜单里列出来的」与「真能执行的」不可能各说各话。外部插件默认不在里面
 * （spec 不标 `shell` 就不进）——失败关闭；宿主侧插件本就有完整宿主权力，标了也只是
 * 把它自己的命令摆到菜单里，不多给任何东西。
 */
export const shellCommands = (): CommandSpec[] => allSpecs().filter((spec) => spec.shell === true)

/** 这个名字能不能从壳里执行（`runUiCommand` 的闸；大小写与展开后的名字比）。 */
export function isShellCommand(name: string): boolean {
  return allSpecs().some((spec) => spec.name === name && spec.shell === true)
}

/**
 * 界面通道派发前的那道闸（`runUiCommand` 只做两件事：问它、照原样派发）。
 *
 * 独立成纯函数是为了能直测：它是「壳能跑什么」这句话的可执行版本，而 `runCommand`
 * 那条路（终端与旧桌面渲染层用）**不过这道闸**——两边的差别只在这里。
 *
 * @returns null = 放行；字符串 = 给用户看的原因（调用方原样抛出去）。
 */
export function shellCommandRejection(input: string): string | null {
  if (!input.startsWith('/')) return '界面通道的命令派发只接 `/` 开头的输入'
  // 名字按「唯一前缀展开」算（`/rev` → `/review`），与 TUI 敲一半按回车的口径一致。
  const expanded = expandCommand(input)
  const name = expanded.slice(1).trim().split(/\s+/)[0] ?? ''
  // 裸 `/`（没有名字）落到 /help，与 TUI 同一条出口，不算越界。
  if (name === '') return null
  if (isShellCommand(name)) return null
  return `/${name} 不在桌面壳的命令清单里（输入框打 / 看能用的那几条；权限、模型、退出这些在界面上有旋钮或按钮）`
}

/** /help 文本（命令表驱动）。 */
export function helpText(specs: readonly CommandSpec[]): string {
  return specs
    .map((command) => `/${command.name}${command.args === '' ? '' : ` ${command.args}`}\t${command.description}`)
    .join('\n')
}

/** 兼容导出：v2 的 HELP_TEXT（内置表静态快照）。 */
export const HELP_TEXT = helpText(BUILT_IN_COMMANDS)

/**
 * 命令候选（输入 `/` 或 `/mo` 阶段）。
 * 已进入参数阶段（含空格）或非命令输入返回空。
 */
export function commandCompletions(input: string): CompletionItem[] {
  if (!input.startsWith('/')) return []
  const body = input.slice(1)
  if (body.includes(' ')) return []
  const lower = body.toLowerCase()
  return allSpecs()
    .filter((command) => command.name.startsWith(lower))
    .map((command) => ({
      insert: `/${command.name}${command.args === '' ? '' : ' '}`,
      label: `/${command.name}${command.args === '' ? '' : ` ${command.args}`}`,
      description: command.description,
    }))
}

/**
 * 模型候选（`/model ` 参数阶段）：展示全部可切换模型的 `端点/模型名`。
 * 补全到精确匹配后面板自动关闭；`model 名`本身也可前缀匹配（`/model deep`）。
 */
export function modelCompletions(input: string, models: readonly ModelChoiceView[]): CompletionItem[] {
  if (!input.startsWith('/model')) return []
  const body = input.slice('/model'.length)
  if (!body.startsWith(' ')) return [] // 还没打空格：交给命令候选
  const arg = body.slice(1)
  if (arg.includes(' ')) return [] // 参数已完整（带后续参数不适用于 /model）
  const lower = arg.toLowerCase()
  const matched = models.filter(
    (choice) =>
      choice.value.toLowerCase().startsWith(lower) || choice.model.toLowerCase().startsWith(lower),
  )
  if (matched.length === 1 && matched[0].value.toLowerCase() === lower) return []
  return matched.map((choice) => ({
    insert: `/model ${choice.value}`,
    label: choice.value,
    description: choice.description,
  }))
}

/** 统一补全入口：model 参数阶段优先，否则按命令前缀。 */
export function completionsFor(input: string, models: readonly ModelChoiceView[]): CompletionItem[] {
  const byModel = modelCompletions(input, models)
  return byModel.length > 0 ? byModel : commandCompletions(input)
}

/**
 * 命令名唯一前缀自动展开（`/ne` → `/new`）；多候选或已精确匹配时原样返回。
 * 供 Enter 提交前调用，避免"输了一半按回车报未知命令"。
 */
export function expandCommand(input: string): string {
  if (!input.startsWith('/')) return input
  const body = input.slice(1)
  if (body.includes(' ')) return input
  if (allSpecs().some((command) => command.name === body)) return input
  const matches = allSpecs().filter((command) => command.name.startsWith(body.toLowerCase()))
  return matches.length === 1 ? `/${matches[0].name}` : input
}
