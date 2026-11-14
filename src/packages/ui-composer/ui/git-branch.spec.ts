/**
 * 输入框分支钮的两条纯逻辑与 op 分档（ui 层）。
 *
 * 来源：`scripts/ui-git-branch-test.mjs` 第 [1] 段（搜索怎么筛、哪种失败要补一句）与
 * 第 [3] 段（切 / 建过审批、清单直接放行、审批卡文案）。`git-branch.ts` 零依赖；
 * op 分档真读宿主常量 `src/core/dock-ops.ts`——这颗钮能不能发出去由那张表裁决。
 *
 * 不迁的部分（原探针）：
 * - 第 [2][4] 段：`ui.tsx` / `branch-menu.tsx` / `model-controls.tsx` 的接线、host-channel 的
 *   超时口径、desktop-dock 与 git 插件的实现位置——渲染体与宿主源码文本钉，无行为接缝，
 *   归组件渲染批（缺口清单）；其中 desktop-dock 的 op 实现属内核探针面，由内核批覆盖。
 *
 * @module dsc-ui-composer/ui/git-branch.spec
 */
import { expect, test } from 'vitest'
import { DOCK_READ_OPS, DOCK_WRITE_LABEL, DOCK_WRITE_OPS } from '@pneuma/runtime/core/dock-ops.js'
import { filteredBranches, wouldOverwrite, type GitBranchRow } from './git-branch.js'

/** 三条分支：main 是当前的，宿主已把它排第一。 */
const rows: GitBranchRow[] = [
  { name: 'main', current: true },
  { name: 'feat/ui', current: false },
  { name: 'fix-bug', current: false },
]

// ── 搜索怎么筛 ───────────────────────────────────────────────────────────────

test('空搜索词（含纯空白）原样返回——顺序不动，宿主已把当前分支排第一', () => {
  expect(filteredBranches(rows, '')).toBe(rows)
  expect(filteredBranches(rows, '   ')).toBe(rows)
})

test('包含匹配、大小写不敏感', () => {
  const ui = filteredBranches(rows, 'ui')
  expect(ui).toHaveLength(1)
  expect(ui[0]?.name).toBe('feat/ui')
  const main = filteredBranches(rows, 'MAIN')
  expect(main).toHaveLength(1)
  expect(main[0]?.name).toBe('main')
})

test('搜不到给空表（菜单里说「没有匹配的分支」）', () => {
  expect(filteredBranches(rows, 'zzz')).toHaveLength(0)
})

// ── 哪种失败要补一句「往哪儿走」 ─────────────────────────────────────────────

test('git 拒切换的原文（改动会被覆盖）认得出来', () => {
  expect(
    wouldOverwrite(
      'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.',
    ),
  ).toBe(true)
})

test('另一种写法（stash 那句单独出现）也认得', () => {
  expect(wouldOverwrite('Please commit your changes or stash them')).toBe(true)
})

test('别的失败不误判（例如分支名不合法）；空串不误判', () => {
  expect(wouldOverwrite("fatal: 'bad name' is not a valid branch name")).toBe(false)
  expect(wouldOverwrite('')).toBe(false)
})

// ── op 分档：切 / 建过审批，清单直接放行（真读宿主常量） ─────────────────────

test('git-branches 是读类（界面通道直接放行）', () => {
  expect(DOCK_READ_OPS.includes('git-branches')).toBe(true)
})

test('git-checkout 与 git-branch-create 是写类（过审批那一档）', () => {
  expect(DOCK_WRITE_OPS.includes('git-checkout')).toBe(true)
  expect(DOCK_WRITE_OPS.includes('git-branch-create')).toBe(true)
})

test('审批卡文案写清了切到哪条 / 新建哪条', () => {
  expect(DOCK_WRITE_LABEL['git-checkout'].toolName).toBe('git: 切换分支')
  expect(DOCK_WRITE_LABEL['git-checkout'].summary({ branch: 'feat/x' })).toBe('切到 feat/x')
  expect(DOCK_WRITE_LABEL['git-branch-create'].summary({ branch: 'feat/x' })).toBe('新建并切到 feat/x')
})

test('没给分支名时卡片也说得清（不留空）', () => {
  expect(DOCK_WRITE_LABEL['git-checkout'].summary({})).toBe('切到 （没有指定分支名）')
})
