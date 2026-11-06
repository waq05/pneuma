/**
 * 展开体「输入」区的口径：把一次调用的参数切成一行一字段。
 *
 * 为什么单独一个模块：参数怎么拆是纯逻辑，能脱离 React 直测；而渲染层只管排版。
 * 与 `tool-args.ts` 的分工：那边认「会改文件的工具要藏掉哪些正文字段」，这里管
 * 「所有工具的参数怎么摆成字段表」——两件事互不重叠，渲染层先过那边拿到要剔除的键，
 * 再把剩下的交给这里。
 *
 * 三条规矩：
 * - **不摊 JSON**：对象/数组压成一行 JSON（它们本来就是一个值），整段参数不再整个倒出来；
 * - **多行值只留首行**：正文、脚本体、命令里的多行脚本，展开体只占一行，悬停看全文；
 * - **单行值不折行**：长命令、长路径在字段格子里横向截断，交给 CSS 出省略号。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/tool-detail
 */

/** 输入区里的一格：键 + 原值（可能多行）。 */
export interface ToolDetailField {
  key: string
  /** 原值原文（多行原样保留；渲染层负责取首行与悬停全文）。 */
  value: string
  /** 原值是否多行（渲染层据此给「折叠」标记）。 */
  multiline: boolean
}

/** 一次调用的输入视图。 */
export interface ToolDetailArgs {
  /** 竖排字段（按参数原序；`omit` 里的键剔除）。 */
  fields: ToolDetailField[]
}

/**
 * 把参数 JSON 切成输入字段。
 *
 * 判不出参数（半截 JSON、不是对象）时给空表：调用方据此**整段不画输入区**，
 * 绝不把半截原文当成字段硬塞，也不留一个空标题。
 *
 * @param argsText 模型产出的原始 arguments JSON 字符串
 * @param omit     不摆进字段表的键（会改文件的工具的正文，已经在上面的 diff 里）
 */
export function toolDetailArgs(argsText: string, omit: readonly string[] = []): ToolDetailArgs {
  let args: unknown
  try {
    args = JSON.parse(argsText) as unknown
  } catch {
    return { fields: [] }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { fields: [] }
  }
  const fields: ToolDetailField[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (omit.includes(key)) continue
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
    fields.push({ key, value: text, multiline: text.includes('\n') || text.includes('\r') })
  }
  return { fields }
}

/**
 * 取第一行有内容的文字：多行值在输入区只露这一行。
 *
 * 跳过纯空白行（多行命令常见开头空行），行尾空白一并去掉——它只影响排版。
 */
export function firstLineOf(text: string): string {
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** 把多行值压成一行（首行以外不再露，但悬停用的是另一份原文）。 */
export function flatValueOf(field: ToolDetailField): string {
  return field.multiline ? firstLineOf(field.value) : field.value.trim()
}
