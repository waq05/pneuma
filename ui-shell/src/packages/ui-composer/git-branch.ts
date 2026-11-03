/**
 * 分支钮的两条纯逻辑（零依赖；`scripts/ui-git-branch-test.mjs` 直读这一份验行为）。
 *
 * 为什么要与组件分开：壳的插件是 `.tsx`，探针读不了（Node 的类型擦除只认 `.ts`）；
 * 而「搜索怎么筛」与「哪种失败要补一句往哪儿走」是有对错的判断，值得一条断言钉住。
 *
 * @module dsc-ui-shell/plugins/composer/git-branch
 */

/** 一个本地分支（宿主 `dock git-branches` 回包里的形状）。 */
export interface GitBranchRow {
  name: string
  current: boolean
}

/** 分支清单按搜索词过一遍（大小写不敏感的包含匹配；空词原样返回，保持宿主给的顺序）。 */
export function filteredBranches(rows: readonly GitBranchRow[], query: string): readonly GitBranchRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter((row) => row.name.toLowerCase().includes(needle))
}

/**
 * git 拒掉这次切换，是因为当前改动会被覆盖？
 *
 * 那种情况下 git 的原文已经列了文件名（`Your local changes to the following files would be
 * overwritten by checkout … Please commit your changes or stash them`），界面只要在它后面
 * 补一句「往哪儿走」就够——不必像参考实现那样再开一个「提交后再切」的弹框（dsc 的提交面
 * 在右侧栏「变更」页签里，本来就有完整的暂存 / 提交）。
 */
export function wouldOverwrite(text: string): boolean {
  return /would be overwritten|Please commit your changes or stash/i.test(text)
}
