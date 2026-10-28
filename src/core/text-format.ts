/**
 * 展示用的文本压缩（全仓库各一份）：把大数字缩成 M / k，把长路径缩成末两级。
 *
 * 两处此前各抄两份，抄在 TUI 的界面文件里（状态栏、欢迎页、两个用量展示）。同一份
 * 口径抄开之后最容易出现的不是崩溃，而是「同一个数字在两个地方长得不一样」——
 * 排查时没人会怀疑到格式化上。
 *
 * @module dsc/core/text-format
 */

/**
 * 大数字缩写：1234 → `1.2k`，1234567 → `1.2M`，999 原样。
 * 保留一位小数、不做万/亿换算——用量统计另有一份中文口径（万 / 亿），那是给人读的大数，
 * 这两个函数不共用一个名字，免得哪天有人把它们「顺便合并」。
 */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** 路径缩成末两级：`/a/b/c/d` → `…/c/d`；两级以内原样给（短路径缩了反而看不懂）。 */
export function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '')
  return parts.length <= 2 ? cwd : `…${parts.slice(-2).join('/')}`
}
