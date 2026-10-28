/**
 * 字节数的人话读法（宿主侧唯一一份）。
 *
 * 同一件事此前散在五处，差异只在单位、标点与小数位：附件的「512 B」、暂存清理的
 * 「1536 字节」、输入区附件的「1.2 MB」（把 `.0` 抹掉了）、对话流附件行自己又抄的一份、
 * 文件树的「512B」（没有空格）。合并成两份：宿主这一份，与壳里 `ui-primitives/sizes.ts`
 * 的同名函数——**层级上两边不许互相 import**（壳只经 `@dsc/ui*` 拿宿主的类型，不拿运行期
 * 实现），所以各存一份实现，由 `scripts/ui-bytes-test.mjs` 逐字比对两份函数体，漂了要红。
 *
 * @module dsc/core/bytes
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
