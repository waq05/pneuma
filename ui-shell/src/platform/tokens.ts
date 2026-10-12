/**
 * token 数的显示口径（状态栏、侧栏、轮尾、轨迹页共用一份）。
 *
 * 口径照抄旧渲染层 `token-estimate.ts`：1000 以下取整，往上缩写成 `46K` / `1.2M`。
 * 为什么非要有这一层：同一个数在四个地方显示成四种写法，用户会以为是四个不同的数。
 *
 * @module dsc-ui-shell/platform/tokens
 */

/** 去掉小数末尾多余的 0：46.0K → 46K，1.00M → 1M（旧渲染层 token-estimate 同款）。 */
function trimZero(value: number): string {
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/**
 * token 数缩写（旧界面的 K/M 口径）：1000 以下四舍五入成整数——估算值可以是小数
 * （中文 0.65 token/字），直接 String() 会把 `~17.970000000000002` 这种浮点尾巴
 * 摊给用户。
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${trimZero(value / 1_000)}K`
  return `${trimZero(value / 1_000_000)}M`
}
