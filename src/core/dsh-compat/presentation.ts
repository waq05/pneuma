/**
 * dsh 的两样「呈现」数据：卡片视图（presentCall / presentResult）与规范值校验。
 *
 * 为什么单开一个文件：这两件事都只在兼容层出现——Pneuma 自己的工具直接返回文本或
 * 文本+图像，没有卡片视图概念，也不需要校验返回值（返回值就是给人看的文本）。
 *
 * 卡片词汇照 dsh 的 `packages/core/tools/src/presentation.ts` 抄一份（**不引它的包**：
 * 兼容层与 dsh 源码零耦合，抄的是形状）。它用 `card` 标签区分六种：
 *   - `generic`：标题 + 可选内容块 + 可跟随的文件位置（默认卡）
 *   - `terminal`：一条命令 + 工作目录 + 输出（终端卡）
 *   - `diff`：每个被改文件一条 `{ path, oldText, newText }`（内联 diff 卡）
 *   - `search` / `read` / `web`：搜索结果、按行号的文件窗口、网页抓取结果
 *
 * 我们**不重画**六种卡：宿主把卡片 JSON 原样落盘、界面按 `card` 取用（现在只认
 * `diff` 与 `terminal` 两种，其余回落通用工具卡），没认出来的数据也不会丢。
 *
 * @module dsc/core/dsh-compat/presentation
 */
import type { ToolPresentation } from '../tools.js'

export type { ToolPresentation }

/** dsh 卡片标签（六种结果卡 + 三种调用卡的并集）。 */
export type DshCardTag = 'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web'

/** 一张卡片视图（字段按 dsh 的契约取，未列出的字段原样保留）。 */
export interface DshCardView {
  card: DshCardTag
  title?: string
  /** generic / terminal 的正文内容块（dsh 的 ContentBlock[]；这里不解释，原样留给界面）。 */
  content?: unknown
  /** terminal 卡：命令、说明、工作目录。 */
  command?: string
  description?: string
  cwd?: string
  output?: string
  exitCode?: number
  /** diff 卡：每个被改文件一条。 */
  diffs?: readonly { path: string; oldText: string | null; newText: string }[]
  /** read 卡：按行号的文件窗口。 */
  path?: string
  lines?: readonly { number: number; text: string }[]
  /** 其余字段原样保留（dsh 加字段时不至于丢数据）。 */
  [key: string]: unknown
}

const CARDS: ReadonlySet<string> = new Set(['generic', 'terminal', 'diff', 'search', 'read', 'web'])

/**
 * 把 dsh 的 presentCall / presentResult 返回值收敛成一张卡片视图。
 *
 * 收敛口径：必须是个对象、`card` 是认识的标签，否则返回 undefined（当作没有卡片，
 * 界面回落通用工具卡）。**不做深校验**——卡片是展示用的，展示错了比崩了强。
 * @param raw - presentCall / presentResult 的返回值
 * @returns 卡片视图；认不出就是 undefined
 */
export function asCardView(raw: unknown): DshCardView | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const card = record['card']
  if (typeof card !== 'string' || !CARDS.has(card)) return undefined
  return record as DshCardView
}


/** JSON Schema 节点（dsh 的 output.schema 是它；这里只认常用的那几个关键字）。 */
export type JsonSchemaNode =
  | boolean
  | {
      type?: string | readonly string[]
      properties?: Record<string, JsonSchemaNode>
      required?: readonly string[]
      items?: JsonSchemaNode
      enum?: readonly unknown[]
      const?: unknown
      additionalProperties?: boolean | JsonSchemaNode
      anyOf?: readonly JsonSchemaNode[]
      oneOf?: readonly JsonSchemaNode[]
      allOf?: readonly JsonSchemaNode[]
    }

/** 一个值的 JSON 类型名（与 JSON Schema 的 type 取值对齐）。 */
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/**
 * 按 dsh 的 output.schema 校验一次工具返回值（「规范值」契约）。
 *
 * 只实现 dsh 用到的那一小撮关键字：type / properties / required / items / enum /
 * const / additionalProperties / anyOf / oneOf / allOf。校验失败**返回违规清单**
 * （JSON Pointer 形式，空串表示根），由调用方决定怎么报——dsh 是抛 ToolArgsError，
 * 我们抛一条中文 Error，让模型看到「工具的返回值不合自己声明的 schema」。
 * @param schema - 工具声明的 schema（boolean 形式的 schema 也认：true 放行、false 一律拒）
 * @param value - 工具返回的规范值
 * @param path - 当前 JSON Pointer（递归用）
 * @returns 违规清单（空数组 = 通过）
 */
export function validateOutput(schema: JsonSchemaNode, value: unknown, path = ''): string[] {
  if (schema === true) return []
  if (schema === false) return [`${path === '' ? '/' : path}：schema 声明为 false，任何值都不许返回`]
  const where = path === '' ? '/' : path
  const violations: string[] = []

  if (schema.type !== undefined) {
    const wanted = typeof schema.type === 'string' ? [schema.type] : schema.type
    const actual = jsonTypeOf(value)
    // JSON Schema 的 number 也接受整数；integer 不接受小数。
    const ok =
      wanted.includes(actual) ||
      (actual === 'integer' && wanted.includes('number'))
    if (!ok) {
      violations.push(`${where}：期望类型 ${wanted.join('|')}，实际是 ${actual}`)
      return violations
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    violations.push(`${where}：取值不在枚举 ${JSON.stringify(schema.enum)} 里`)
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    violations.push(`${where}：取值应当恒为 ${JSON.stringify(schema.const)}`)
  }

  for (const [index, branch] of (schema.allOf ?? []).entries()) {
    violations.push(...validateOutput(branch, value, path).map((item) => `allOf[${String(index)}] ${item}`))
  }
  if (schema.anyOf !== undefined && !schema.anyOf.some((branch) => validateOutput(branch, value, path).length === 0)) {
    violations.push(`${where}：不满足 anyOf 里的任何一支`)
  }
  if (schema.oneOf !== undefined && schema.oneOf.filter((branch) => validateOutput(branch, value, path).length === 0).length !== 1) {
    violations.push(`${where}：oneOf 要求恰好满足一支`)
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      violations.push(...validateOutput(schema.items, item, `${path}/${String(index)}`))
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const name of schema.required ?? []) {
      if (!(name in record)) violations.push(`${path}/${name}：缺少必填字段`)
    }
    for (const [name, node] of Object.entries(schema.properties ?? {})) {
      if (name in record) violations.push(...validateOutput(node, record[name], `${path}/${name}`))
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const name of Object.keys(record)) {
        if (!known.has(name)) violations.push(`${path}/${name}：schema 没声明的多余字段`)
      }
    } else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object') {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const name of Object.keys(record)) {
        if (!known.has(name)) violations.push(...validateOutput(schema.additionalProperties, record[name], `${path}/${name}`))
      }
    }
  }

  return violations
}