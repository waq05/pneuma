/**
 * 工具契约：与 dsh 工具行同构（name/description/JSONSchema/run），外加
 * 个人版的风险分级 `risk`——read 自动放行，write/exec 必须过审批卡。
 *
 * @module dsc/core/tools
 */
import { isAbsolute, resolve } from 'node:path'
import type { DiffHunk } from './diff-text.js'

export type ToolRisk = 'read' | 'write' | 'exec'

/** 一次成功的落盘类调用（write / edit）对单个文件造成的实际改动。 */
export interface FileChangeSummary {
  /** 文件绝对路径。 */
  path: string
  /** 新增行数。 */
  added: number
  /** 删除行数。 */
  removed: number
  /** 算好的 unified 差异段（diff-text 的产物，逐行带新旧行号）。 */
  hunks: DiffHunk[]
  /** true = hunks 超出行数上限被砍过（界面据此提示「只显示前一部分」）。 */
  truncated?: boolean
  /** `added` = 新建文件（改前不存在）；`modified` = 改已有文件。 */
  status: 'added' | 'modified'
  /**
   * 改之前的全文，**只活在内存**：循环拿它给回合基线记账（见 Session.recordTurnChange），
   * 落盘与 `tool/changes` 事件都会剥掉——jsonl 和快照里只留 hunks。
   */
  baseline?: string
}

/**
 * 剥掉 `baseline` 内存字段，得到可落盘 / 可进事件的干净摘要。
 * 事件与 jsonl 里只该有 hunks（改前全文是回合基线记账专用的，带着走会把快照撑爆）。
 */
export function stripBaseline(change: FileChangeSummary): FileChangeSummary {
  const { baseline: _baseline, ...rest } = change
  return rest
}

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /**
   * 发起这次调用的会话身份（meta.id / jsonl 路径）。工具生成的后续产物——后台作业
   * 完成通知这类——按它归属投递（0.6.48 常驻多 agent：不能再看「当前查看的会话」）。
   */
  sessionId: string
  sessionPath: string
  /**
   * 发起这次调用的队友身份。子智能体插件替队友转发团队类工具（team_task）时塞进来，
   * 工具按它署名（任务板认领人、信箱回信）；主会话的调用没有这一项，按「lead」对待。
   */
  caller?: { name: string; depth: number; background: boolean }
}

/**
 * 一次工具调用的呈现数据（可选）。
 *
 * 谁写：dsh 兼容层——它把 dsh 工具的 presentCall / presentResult / presentationMeta
 * 的产物塞进来（形状见 `core/dsh-compat/presentation.ts`）。
 * 谁读：适配层把它缝到工具卡上（`ToolCallView.presentation`），界面按 `card` 标签
 * 挑渲染形态；没认出来的卡片不至于丢数据，界面回落通用工具卡。
 *
 * 为什么放在核心契约而不是兼容层：它是「工具能对界面说什么」的一个槽，Pneuma 自己
 * 的工具将来也可能往里写；词汇（六种卡片）属于 dsh 兼容层，槽本身不属于。
 */
export interface ToolPresentation {
  /** 调用阶段的卡片（还没跑完时长什么样）。 */
  call?: unknown
  /** 完成阶段的卡片（跑完长什么样）。 */
  result?: unknown
  /** 可重放的展示投影（dsh 用它重建卡片，故必须是与值无关的纯数据）。 */
  meta?: unknown
}

/** 工具输出：纯文本，或文本 + 附带图像（data URL；需端点支持视觉）。 */
export interface ToolOutput {
  text: string
  images?: string[]
  /** 给界面的卡片数据（dsh 插件才有；见 {@link ToolPresentation}）。 */
  presentation?: ToolPresentation
  /**
   * 落盘类工具（write / edit）附带的真实改动：循环会把它发成 `tool/changes` 事件、
   * 随工具记录落盘（会话恢复时轮尾「文件已更改」卡据此还原）。执行失败时没有这一项。
   */
  changes?: FileChangeSummary
}

export interface ToolEntry {
  name: string
  description: string
  /** JSON Schema（OpenAI 协议的 function 参数）。 */
  parameters: Record<string, unknown>
  risk: ToolRisk
  /**
   * 这个工具属于哪些模式（模式名清单）。不写 = 所有模式都能看见它。
   *
   * 用途：模式专属的工具不该在标准模式里冒出来——`run_code` 只属于 PTC 模式，
   * `runtime_api` 只属于创造模式。它不是权限声明：模式白名单里显式写了这个工具名
   * 也能看见它；真正的安全边界在守卫链与审批卡，跟这个字段无关。
   */
  presets?: readonly string[]
  /**
   * 这次调用的超时预算（毫秒）。dsh 插件声明了 `timeoutMs` 时由兼容层填进来；
   * 真正的到点放弃在兼容层的 `run` 里做（协作式：工具自己看 signal 才是真取消）。
   */
  timeoutMs?: number
  /**
   * 这个工具跑起来是在**等人**（提问卡、审批卡这类，人答完才返回）。
   *
   * 只有 PTC 的脚本时限认这一位：等人的时间不算脚本的时间。不声明的话，用户在卡上
   * 想了三分钟，120 秒的脚本时限先把脚本掐死，答案再交回来也没有人接了
   * （2026-10-29 报障：提问卡超时后答了，对话不动）。它不是权限声明，也不影响
   * 单次调用本身的行为——工具自己怎么等、等多久，仍由工具决定。
   */
  waitsForHuman?: boolean
  /**
   * 这次调用能不能与同轮别的工具并行（dsh 的 `isConcurrencySafe(args)`）。
   *
   * 只认明确的 `true`：缺省、抛错、返回非 true 一律当独占（与 dsh 同一口径）。
   * 现在只是把这个事实记下来，循环还没有并行调度器。
   */
  isConcurrencySafe?(args: Record<string, unknown>): boolean
  /** 执行并返回给模型的结果；失败时抛错（loop 转成 error 结果）。 */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolOutput>
}

/**
 * 从工具参数里认出「这次调用要动哪个目标 / 跑哪条命令」。
 *
 * 各工具用的参数名不一样（file_path / path / target / file，command / cmd），
 * 这段兜底原先在循环与审批里各写了一份，现在收在工具层——参数名是工具契约的一部分，
 * 只有这一层该认识它们。路径在这里就绝对化，后面的护栏不必各自再拼一次。
 *
 * @param args - 模型给的参数（已 JSON.parse）。
 * @param cwd - 会话工作目录（相对路径按它展开）。
 */
export function callFacts(
  args: Record<string, unknown>,
  cwd: string,
): { target?: string; command?: string } {
  const out: { target?: string; command?: string } = {}
  for (const key of ['file_path', 'path', 'target', 'file']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') {
      out.target = isAbsolute(value) ? resolve(value) : resolve(cwd, value)
      break
    }
  }
  const command = args.command ?? args.cmd
  if (typeof command === 'string' && command.trim() !== '') out.command = command
  return out
}

/** 卡片上那行参数摘要的最长字符数（再长就是把整篇正文塞进按钮旁边）。 */
const ARGS_SUMMARY_MAX = 160

/**
 * 把一次工具调用的参数压成一行文字，给审批卡、审计日志这类给人看的地方用。
 *
 * 参数是 JSON.parse 出来的，不会带循环引用，所以这里不需要兜底。
 *
 * @param args - 模型给的参数（已 JSON.parse）。
 * @returns 扁平 JSON 文本，超过 160 字符截断并补省略号
 */
export function argsSummary(args: Record<string, unknown>): string {
  const text = JSON.stringify(args)
  return text.length > ARGS_SUMMARY_MAX ? `${text.slice(0, ARGS_SUMMARY_MAX)}…` : text
}
