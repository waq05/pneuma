/**
 * 「这是不是一个普通对象」的判定（全仓库唯一一份）。
 *
 * 为什么单独放一个模块：`asRecord` / `isRecord` 这对判断此前在 core/mcp、plugins/mcp、
 * ui/frames、core/lsp/normalize、core/lifecycle-hooks、core/remote/push、core/web-http
 * 各写一遍，写法一样、注释各说各话，改一处口径（比如要不要排除数组）得靠人肉搜。
 *
 * 两个名字是同一件事的两种用法：返回对象的用于取值（取不到就 null），返回布尔的用于
 * 类型守卫（if 之后 TS 自动收窄）。
 *
 * @module dsc/core/records
 */

/** 认得出是个普通对象就返回它，否则 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 类型守卫版：认得出是个普通对象就 true。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
