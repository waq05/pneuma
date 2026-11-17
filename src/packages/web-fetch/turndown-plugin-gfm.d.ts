/**
 * `@joplin/turndown-plugin-gfm` 没有类型、DefinitelyTyped 上也没有同名包，这里补一条环境声明。
 *
 * 只声明复合插件 `gfm`（表格、删除线、任务列表、高亮代码块四合一）：包里另外几个单独插件
 * （`tables` / `strikethrough` …）等真有人 import 时再补，声明多了反而会掩盖「我们其实只用
 * 了其中一个」这件事。
 */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  /** GitHub 风格扩展：表格、删除线、任务列表、高亮代码块。 */
  export const gfm: TurndownService.Plugin
}
