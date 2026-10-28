/**
 * 数字收敛（全仓库唯一一份）。
 *
 * 为什么单独放一个模块：这段「不是有限数就取缺省，是就四舍五入再夹进区间」的写法
 * 此前在约二十处各抄一遍（各插件的 readConfig、core 的 hooks / spill / image-diet 等），
 * 每处都得同步一遍区间语义。它不依赖任何模块，放 core 谁都能引。
 *
 * 区间以 `{ min, max }` 成对给出时用 {@link clampIntIn}，免得调用点把 .min/.max 摊开。
 *
 * @module dsc/core/clamp
 */

/** 不是有限数就返回缺省；是就四舍五入并夹进 [min, max]。 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
}

/** 有限数字才要（NaN、Infinity、非数字都不要）；类型守卫版，用在解析外部 JSON 时。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 区间以 `{ min, max }` 成对给出时的写法。 */
export function clampIntIn(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  return clampInt(value, bounds.min, bounds.max, fallback)
}
