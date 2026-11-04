/**
 * git diff 解析（`parseUnifiedDiff` / `splitUnifiedDiffByFile`）在基元包里的出口。
 *
 * 为什么要有这么一层：实现只有宿主 `core/unified-diff.ts` 一份（旧渲染层那份已改成
 * 从它转出），而界面插件按插件规范只能引用平台种子，`@dsc/ui-core` 不在种子里，
 * 所以这里做一次转出——同 `error-text.ts`、`throughput.ts` 的写法。
 *
 * @module dsc-ui-shell/ui-primitives/unified-diff
 */

export {
  parseUnifiedDiff,
  splitUnifiedDiffByFile,
  type DiffHunkView,
  type DiffLineView,
  type UnifiedFileDiff,
} from '@dsc/ui-core'
