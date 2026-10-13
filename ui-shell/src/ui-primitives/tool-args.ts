/**
 * 「一次工具调用的参数怎么摆」的纯口径：哪些工具算「会改文件」、正文之外的字段是什么。
 *
 * 为什么单独一个模块（而不是塞进 `tool-summary.ts`）：那边 import 了图标组件（.tsx），
 * 于是整个模块在 Node 里加载不了——而这里的规则要能被探针**直读断言**
 * （`scripts/ui-transcript-render-test.mjs` 用 Node 的类型擦除直接 import 本文件）。
 * 本模块零依赖：不引 React、不引图标、不碰 DOM。
 *
 * 规则对照参考实现（dsh）：`write` / `edit` 的展开体**只画 diff、不摊原始参数**——
 * 它的 `FileMutationRow` 只给 `diff`（`toolviews/file-mutation-row.tsx:33-57`，
 * 渲染在 `components/ToolRow.tsx:254-268`）；整篇 `content` 缩在一行 JSON 字符串里全是
 * `\n` 转义，而读者要的是「改了哪几行」。只有**认不出的**工具才落到通用卡摊参数
 * （`GenericToolCard`，同一份 `tool-call-model.ts:291` 的 `JSON.stringify(args, null, 2)`）
 * ——壳照同一口径分流（0.6.67 报障：「点开编辑卡看到的是原始 JSON 参数」）。
 *
 * @module dsc-ui-shell/ui-primitives/tool-args
 */

/**
 * 会改文件的那几个工具：参数里属于**文件正文**的字段。
 *
 * 表里带上别家写文件工具的常见命名：MCP 系的 `str_replace_editor` 与 apply_patch 系
 * 参数名不是 `content` / `old` / `new`，漏了它们就会掉回原始 JSON 那一支。
 */
export const MUTATION_CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  write: ['content'],
  edit: ['old', 'new'],
  str_replace_editor: ['file_text', 'old_str', 'new_str'],
  apply_patch: ['patch', 'content'],
}

/** 参数表里的一格。 */
export interface ToolArgField {
  key: string
  /** 值已压成一行（换行折成空格）；对象/数组按一行 JSON 走。 */
  value: string
}

/** {@link toolArgFields} 的分流结果。 */
export interface ToolArgFields {
  /** 这个工具认不认成「会改文件」的那几个。 */
  mutating: boolean
  /** 文件正文之外的字段（按参数原序）；不是一个认得出的对象就是空表。 */
  fields: ToolArgField[]
  /** 属于文件正文、因此不进字段表的键（自检与注释用）。 */
  omitted: string[]
}

/** 值压成一行：空白折成一个空格。字段表是「这张卡打算干什么」的一行读法。 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 把一次调用的参数切成「参数表」：会改文件的工具返回正文之外的字段，其余一律 `mutating: false`。
 *
 * 判不出参数（流式途中的半截 JSON、参数不是对象）时仍然报 `mutating: true` 但给空表——
 * 调用方据此知道「这个工具不该摊原始 JSON」，而不会把半截参数渲染成一堆字段行。
 *
 * @param name 工具名（`write` / `edit` / …）
 * @param argsText 模型产出的原始 arguments JSON 字符串
 */
export function toolArgFields(name: string, argsText: string): ToolArgFields {
  const bodyFields = MUTATION_CONTENT_FIELDS[name.toLowerCase()]
  if (bodyFields === undefined) return { mutating: false, fields: [], omitted: [] }
  let args: unknown
  try {
    args = JSON.parse(argsText) as unknown
  } catch {
    return { mutating: true, fields: [], omitted: [] }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { mutating: true, fields: [], omitted: [] }
  }
  const fields: ToolArgField[] = []
  const omitted: string[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (bodyFields.includes(key)) {
      omitted.push(key)
      continue
    }
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
    fields.push({ key, value: flatten(text) })
  }
  return { mutating: true, fields, omitted }
}
