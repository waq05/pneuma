/**
 * 终端显示宽度（全仓库唯一一份）。
 *
 * 为什么单独一个模块：`displayWidth` + `isWideCodePoint` 此前在 `src/app/click.ts` 与
 * `src/app/markdown.ts` 各写一遍（后者注释说是「避免互相 import 循环」，实际是避免让
 * 纯文本模块拖进 React/ink）。抽成第三个无依赖模块，两边都引，谁也不欠谁。
 *
 * 口径：CJK / 全角 / 常用 emoji 记 2 列，其余 1 列。表格列宽、点击命中区、换行计算
 * 必须与渲染同源，否则终端里对不齐。
 *
 * @module dsc-tui/app/display-width
 */

/** 与终端一致的显示宽度：CJK/全角/emoji 记 2 列，其余记 1 列。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    width += isWideCodePoint(code) ? 2 : 1
  }
  return width
}

/** 码位属不属于「双宽」区间。 */
export function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}
