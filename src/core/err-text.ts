/**
 * error → 文案（全仓库唯一一份）。
 *
 * 为什么在 core 单独放这么小的一个模块：这句话此前抄了五份（adapter/transcript、
 * core/loop、core/market、core/plugin-loader、渲染层 SettingsModal 各一份）。内核层
 * 不能反向 import adapter，渲染层只能 import 纯 core 模块——放 core 两头都够得着
 * （渲染层照 diff-text 的先例经 `@dsc/runtime/err-text.js` 取用；adapter/transcript
 * 保留同名 re-export，既有 18 处 import 不断）。
 *
 * 2026-10-28 第三批复审：另有十处把它叫成 `errorText` 各写一遍（core/mcp、core 的
 * sandbox/win 四份、core/remote 两份、core/schedule/store、plugins/lsp、plugins/mcp）。
 * 那些地方已改成 `import { errText as errorText }`——名字留着是为了不动调用点，
 * 实现只能有这一份。
 *
 * @module dsc/core/err-text
 */

/** 把抛出来的东西压成一句话（Error 取 message，其余 String 化）。 */
export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
