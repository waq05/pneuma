/**
 * dsh 风格插件示例：用 DeepSeek Harness 的工具定义形状（ToolDefinition）注册工具，
 * 经 dsc 的「dsh 兼容层」运行。自包含（不 import 任何 dsh 库），直接可用；
 * 真实的 dsh 插件（import defineTool / z 的那些）走同样的链路，见
 * docs/plugin-development.md 的「dsh 兼容层」一章。
 *
 * 安装与运行：
 *   1. 复制本文件到 ~/.dsc/plugins/；
 *   2. 在插件中心启用「dsh 兼容层」（dsh-compat，默认关）；
 *   3. 启用本插件（dsh-style-clock.js），对话里让模型调 dsh_clock 工具，或 /clock 命令。
 *
 * 与 dsc 原生插件的差异只有两处：ctx.tools.register 收 dsh 的 ToolDefinition
 * （execute 返回规范 JSON 值、output.render 投影模型可见内容），以及 risk 不是
 * dsh 概念——缺省每次调用都过审批卡，可在插件条目配置里用 risk / risks 放宽。
 */
import { readFile, writeFile } from 'node:fs/promises'

/** 读一个文件；不存在当空串（新建文件的 diff 于是画成「新增」）。 */
async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

export const name = 'dsh-style-clock'
export const description = 'dsh 风格示例：ToolDefinition 形状的时钟工具（走 dsh 兼容层）'
export const inject = ['tools', 'commands', 'logger']

export function apply(ctx) {
  // dsh 插件习惯用 logger：warn/error 会被 dsh 兼容层转进对话流，info/debug 不落地
  ctx.logger.info('dsh-style-clock 已挂载')

  const definition = {
    name: 'dsh_clock',
    description: 'Get the current local time. Use it whenever the user asks about time or dates.',
    // dsh 的 parameters 是 JSON Schema 对象（defineTool 会从 schemastery spec 编译出这个形状）
    parameters: {
      type: 'object',
      properties: {
        timezone_note: { type: 'string', description: 'Optional note appended to the result.' },
      },
    },
    timeoutMs: 5_000,
    // dsh 约定：execute 返回「规范 JSON 值」，模型看到什么由 output.render 投影
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `${value.iso}${args.timezone_note ? `\n${args.timezone_note}` : ''}` }],
    },
    execute: async (args, exec) => {
      if (exec.signal.aborted) throw new Error('cancelled')
      return { iso: new Date().toISOString() }
    },
  }

  // 第二件：演示**卡片**。dsh 的工具用 presentCall / presentResult 声明自己那张卡长什么样，
  // 兼容层把卡片数据原样带到工具卡上；壳认得 diff 与 terminal 两种形态，其余回落通用卡。
  // 这一条给的是 diff 卡（"改了哪几行"），落地后展开工具卡就能看见增删两色。
  //
  // 注意 risk：它真的写文件，缺省按 exec 处理（每次过审批卡）。演示时想让流程一口气跑完，
  // 在这个插件条目的 config 里写 { "risks": { "dsh_write_note": "write" } } 放宽一档即可。
  // 每个文件上一次写之前的内容（presentResult 画 diff 要用，见下面那段注释）。
  const lastWrites = new Map()
  const noteDefinition = {
    name: 'dsh_write_note',
    description: 'Write a small note file and report the diff it produced.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the note file.' },
        text: { type: 'string', description: 'New content of the note file.' },
      },
      required: ['path', 'text'],
    },
    timeoutMs: 5_000,
    // 返回值是规范 JSON 值（形状由 schema 保证），模型看到的由 render 投影
    output: {
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } },
        required: ['path', 'before', 'after'],
      },
      render: (args, value) => [{ type: 'text', text: `已写入 ${value.path}` }],
    },
    presentCall: (args) => ({ card: 'generic', title: `写备注：${String(args.path)}` }),
    // diff 卡：每个被改文件一条 { path, oldText, newText }；oldText 为 null 表示新建。
    //
    // 为什么去翻 lastWrites 而不是直接用第二个参数：**兼容层给 presentResult 的第二个
    // 参数是渲染后的结果**（dsh 的 ToolResult：content 块 + 一段文本），不是工具的规范值。
    // 想画「改前 / 改后」，改前那段必须在 execute 里自己记下来——文件那时已经被覆盖了。
    presentResult: (args) => {
      const seen = lastWrites.get(String(args.path))
      const before = seen === undefined ? '' : seen.before
      const after = seen === undefined ? String(args.text) : seen.after
      return {
        card: 'diff',
        title: String(args.path),
        diffs: [{ path: String(args.path), oldText: before === '' ? null : before, newText: after }],
      }
    },
    execute: async (args, exec) => {
      if (exec.signal.aborted) throw new Error('cancelled')
      const file = String(args.path)
      const after = String(args.text)
      const before = await readIfExists(file)
      await writeFile(file, after, 'utf8')
      lastWrites.set(file, { before, after })
      return { path: file, before, after }
    },
  }

  const offTool = ctx.tools.register(definition)
  const offNote = ctx.tools.register(noteDefinition)
  const offCommand = ctx.commands.register(
    { name: 'clock', args: '', description: 'dsh 风格示例工具的自测入口' },
    ({ ui }) => ui.notice(`当前时间：${new Date().toISOString()}（来自 dsh 风格插件）`),
  )

  // 注册一律返回清理函数：热卸载后不留残留
  return () => {
    offTool()
    offNote()
    offCommand()
  }
}
