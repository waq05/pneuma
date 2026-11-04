/**
 * `@pneuma/ui-primitives` 的宿主半：一个空 apply，只为让包加载器认得这个包。
 *
 * 界面半住在同目录的 `ui/`（界面基元（图标、载体基元、平台视图、面板几何与格式化口径）），由 `ui-shell` 的构建（vite +
 * build-plugins）直接编进壳的产物 `lib/ui/`，**本包不产出 `client.js`**：它是库包
 * （`pneuma.library: true`），没有 `cordis.patch.yml`，也就没有行、没有开关。
 *
 * 因此下面这个 apply 里**一行都不该加**：这个包没有任何下发给宿主的下发路径，写进去的
 * 逻辑不会比留在壳里更早生效，只会造出一个假的开关——用户点了"停用"，界面纹丝不动。
 *
 * @module @pneuma/ui-primitives
 */
export function apply(): void {}
