/**
 * 错误文案（`errText`）在基元包里的出口。
 *
 * 为什么要有这么一层：壳内七个界面插件此前各自写了一遍
 * `error instanceof Error ? error.message : String(error)`（settings 五处、plugins、skills），
 * 与宿主 `core/err-text.ts` 是同一份实现。界面插件按插件规范只能值引用平台种子
 * （`@dsc/ui` / `@dsc/ui-primitives` / `@dsc/ui-slots` / `@dsc/ui-dockkit`），
 * `@dsc/ui-core` 不在种子里，所以这里做一次转出：实现仍只有 core 那一份。
 *
 * @module dsc-ui-shell/ui-primitives/error-text
 */

export { errText } from '@dsc/ui-core'
