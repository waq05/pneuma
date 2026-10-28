/**
 * 文件大小的人类读法（界面侧唯一一份）。
 *
 * 文件树、预览面板、输入区附件、对话流附件行此前各写一份：文件树给 `512B`（没有空格），
 * 输入区给 `1.2 MB`（抹掉 `.0`），对话流给 `512 B`——口径写四遍就迟早分叉。合并到基元包，
 * 一律「数字 + 空格 + 单位」，一位小数抹掉 `.0`，两位数以上取整。
 *
 * 宿主那一侧同名同实现的一份在 `src/core/bytes.ts`（层级上不许互相 import），
 * 两份函数体由 `scripts/ui-bytes-test.mjs` 逐字比对。
 *
 * @module dsc-ui-shell/ui-primitives/sizes
 */

/** 1024 进制（KB / MB / GB）：不到 1KB 给整数 B，一位小数但抹掉 `.0`，两位数以上取整；
 *  非有限数或负数给破折号（界面上不显示 NaN）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
  return `${rounded} ${units[unit]}`
}
