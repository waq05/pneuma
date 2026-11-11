/**
 * 相对路径 → 绝对路径：工具卡里所有「可点路径」共用的一处换算。
 *
 * 为什么要单开一个模块：卡片上的路径有三个来源——工具参数（read / write / edit 的 `path`）、
 * 检索结果（`grep` / `glob` 回的是相对检索根的路径）、以及将来别处再加的入口——但右侧预览
 * 页签只吃绝对路径（`fs-read` 以会话工作目录为基准做包含校验）。各写一遍「是不是绝对路径、
 * 分隔符是哪种」必然长歪，所以收在这里一处。
 *
 * 只做**字符串拼接**，不碰盘：认不出就原样返回，让预览自己报「文件不存在」，比在这里猜好。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/file-path
 */

/** 已经是绝对路径：`/…` 或 `C:\…` / `C:/…`。 */
const ABSOLUTE_RE = /^(?:\/|[A-Za-z]:[\\/])/

/**
 * 按基准目录把相对路径拼成绝对路径。
 *
 * 分隔符跟基准目录走：Windows 基准用 `\`，POSIX 基准用 `/`。基准里两种都出现（`C:/a\b` 这种
 * 混写）时按 `/`——那是产物路径里更常见的一侧。
 *
 * @param raw 工具给的路径原文（可能已经是绝对路径）
 * @param base 基准目录（会话工作目录，或检索根）
 * @returns 绝对路径；`raw` 已是绝对路径或 `base` 为空时原样返回 `raw`
 */
export function absPathOf(raw: string, base: string): string {
  if (raw === '' || ABSOLUTE_RE.test(raw)) return raw
  if (base === '') return raw
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${raw.replace(/^[\\/]+/, '')}`
}
