/**
 * 探针读界面源码时用的 `@dsc/ui` / `@dsc/ui-primitives` 桩：把「纯逻辑模块顺带 import 的
 * 那几样」原样转出，其余给空实现。
 *
 * 为什么需要：`round-fold.tsx` 里的 `buildRoundFolds` 是纯计算（整轮折叠区间的预算），
 * 用 Node 直接 import 它比读源码文本结实得多。但它的模块图里有两处 Node 解析不了的依赖：
 *   - `@dsc/ui`：取词器（`createT`）与一个图标。`_i18n-alias.mjs` 只把 `@dsc/ui` 指到
 *     取词器那一个文件，缺 `IconChevronDown` 这个名字，ESM 链接期就报错；
 *   - `@dsc/ui-primitives`：`timing.ts` 从整包里取 `entryTs` / `formatClock` /
 *     `formatDuration`，而整包入口会把图标库、markdown、PDF 视图一起拖进来（Node 里跑不动）。
 *
 * 所以这里只转出这几样实现（不复制实现：取词器与时间口径都还是产品源码），图标给一个
 * 不渲染的空组件——探针只调纯函数，组件树与 DOM 一概不碰。
 *
 * @module dsc/scripts/_ui-probe-stub
 */
export * from '../src/packages/ui-core/i18n.ts'
export * from '../src/packages/ui-primitives/ui/time.ts'

/** `round-fold.tsx` 的总开关行用的箭头：探针不渲染组件，给个空实现即可。 */
export function IconChevronDown() {
  return null
}
