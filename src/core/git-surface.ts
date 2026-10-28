/**
 * 工作区 git 读数的相等判断（全仓库唯一一份）。
 *
 * 同一份读数有两个地方要「比一比」：
 *   - 宿主侧 `plugins/git.ts`：读数没变就别推帧（干净仓库每 30 秒白推一帧是纯浪费）；
 *   - 界面侧 `composer/ui.tsx`：读数没变就别重画输入区底栏。
 * 两处原先各写一份四字段比较。它们**必须**同口径：一边认为变了、另一边认为没变，
 * 界面就会停在旧分支名上且再也不刷新——这类 bug 只在分支切换时出现，最难查。
 *
 * 只比 `GitSurface` 这四个字段（repo / branch / detached / dirtyFileCount）。
 * 状态栏那份 `GitSummary`（branch / added / removed / files）是另一种读数，不在这里合并。
 *
 * @module dsc/core/git-surface
 */
import type { GitSurface } from '../contract.js'

/** 两份读数是不是同一份（四个字段逐个比，比让界面每帧重画便宜）。 */
export function sameGitSurface(left: GitSurface, right: GitSurface): boolean {
  return (
    left.repo === right.repo &&
    left.branch === right.branch &&
    left.detached === right.detached &&
    left.dirtyFileCount === right.dirtyFileCount
  )
}
