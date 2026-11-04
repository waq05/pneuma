/**
 * `@pneuma/ui-runtime` 的宿主半：一个空 apply，只为让包加载器认得这个包。
 *
 * 界面半住在同目录的 `ui/`（宿主通道、RuntimeContext 与读数 hook、页与视图信号、外观落地、
 * 今日用量），由 `ui-shell` 的构建直接编进壳的产物 `lib/ui/`，**本包不产出 `client.js`**：
 * 它是库包（`pneuma.library: true`），没有 `cordis.patch.yml`，也就没有行、没有开关。
 *
 * 为什么这一层必须是库包而不是插件：它装的是**状态**——React context、页与视图的信号、
 * 外观的模块级记录。全页只能有一份，且必须是插件与骨架读到的那一份。可停用的插件做不到
 * 这条（停用后插件读到的会换成另一份）。
 *
 * @module @pneuma/ui-runtime
 */

/** 行身份（库包不占行，这里只是与包名一致的稳定字符串）。 */
export const name = 'ui-runtime'

/** 空实现：这一行没有下发给宿主的行为（见文件头）。 */
export function apply(): void {}
