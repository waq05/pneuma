/**
 * 文件大小的人类读法（界面侧唯一一份）。
 *
 * 文件树与预览面板此前各写一份逐字相同的实现（注释都写着「与文件树那份同口径」）——
 * 口径这种东西写两遍就迟早分叉，合并到基元包。
 *
 * @module dsc-ui-shell/ui-primitives/sizes
 */

/** 1024 进制：B / KB（至少 1，免得 0.4KB 显示成 0KB）/ MB（一位小数）。 */
export function formatSize(size: number): string {
  if (size < 1024) return `${String(size)}B`
  if (size < 1024 * 1024) return `${String(Math.max(1, Math.round(size / 1024)))}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}
