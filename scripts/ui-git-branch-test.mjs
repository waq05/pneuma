/**
 * 输入框上那颗分支钮（`ui-shell/src/plugins/composer`）的探针。
 *
 * 三组断言：
 *
 *   1. **纯逻辑**（`plugins/composer/git-branch.ts`，零依赖 `.ts`，Node 类型擦除直读）：
 *      搜索怎么筛、哪种失败要补一句「往哪儿走」。
 *   2. **接线**（读 `ui.tsx` 文本）：读数来自宿主快照面 `surfaces.git`（壳不自己拍 git）、
 *      不是仓库时整行不画、两个写口走 `dock` 的写类 op、切完关菜单。
 *   3. **档位与令牌**：两个 op 真在 `DOCK_WRITE_OPS` 里（= 必过审批）、清单 op 是读类
 *      （= 界面通道直接放行）、审批卡文案在表里；新加的 CSS 只用 `--dsc-*` 令牌
 *      （拼错的幽灵令牌会静默透明，差集扫描能查）。
 *
 * 运行：npx tsc -p tsconfig.json && node scripts/ui-git-branch-test.mjs
 *
 * @module dsc/scripts/ui-git-branch-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
}

// ── [1] 纯逻辑：搜索与「要不要补一句」 ──────────────────────────────────────────
console.log('[1] 分支钮的纯逻辑（git-branch.ts）')
{
  // 零依赖 `.ts`，Node 的类型擦除直读（与 ui-paging-test 同一套写法；`.tsx` 读不了）。
  const { filteredBranches, wouldOverwrite } = await import(
    new URL('../ui-shell/src/plugins/composer/git-branch.ts', import.meta.url).href
  )
  const rows = [
    { name: 'main', current: true },
    { name: 'feat/ui', current: false },
    { name: 'fix-bug', current: false },
  ]
  check('空搜索词原样返回（顺序不动：宿主已把当前分支排第一）', filteredBranches(rows, '') === rows)
  check('空格也只算空词（trim 之后为空）', filteredBranches(rows, '   ') === rows)
  check('包含匹配', filteredBranches(rows, 'ui').length === 1 && filteredBranches(rows, 'ui')[0].name === 'feat/ui')
  check('大小写不敏感', filteredBranches(rows, 'MAIN').length === 1 && filteredBranches(rows, 'MAIN')[0].name === 'main')
  check('搜不到给空表（菜单里说「没有匹配的分支」）', filteredBranches(rows, 'zzz').length === 0)
  check('git 拒切换的原文（改动会被覆盖）认得出来', wouldOverwrite('error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.'))
  check('另一种写法（stash 那句单独出现）也认得', wouldOverwrite('Please commit your changes or stash them'))
  check('别的失败不误判（例如分支名不合法）', !wouldOverwrite("fatal: 'bad name' is not a valid branch name"))
  check('空串不误判', !wouldOverwrite(''))
}

// ── [2] 壳侧接线（composer 插件文本）───────────────────────────────────────────
console.log('[2] 输入框那颗钮的接线')
{
  const composer = read('ui-shell/src/plugins/composer/ui.tsx')
  const shellCss = read('ui-shell/src/styles.css')

  check('读数取宿主快照面 surfaces.git（壳不自己拍 git）', composer.includes("(surfaces as Record<string, unknown>)['git']") && !composer.includes('git-status'))
  check('投影缺席 / 不是仓库时回落空读数（repo: false）', composer.includes('const EMPTY_GIT: GitSurface') && composer.includes('repo: false'))
  check('不是仓库时整行不画', /\{git\.repo \? \(\s*<div className="composer-git">/.test(composer))
  check('钮上显示分支名 + 箭头（无菜单时也读得出在哪条分支）', composer.includes('className="git-branch-name">{git.branch}') && composer.includes('<IconBranch size={13} />'))
  check('菜单展开即重读清单（不复用上次的快照）', /channel\s+\.invoke<GitBranchList>\('dock', \['git-branches', \{\}\]\)/.test(composer))
  check('当前分支滚进视野（分支多的仓库里不必自己找）', composer.includes("querySelector<HTMLElement>('[data-branch-current=\"true\"]')") && composer.includes("scrollIntoView({ block: 'nearest' })"))
  check('切分支走 dock 的写类 op（过审批那一档）', composer.includes("invoke('dock', ['git-checkout', { branch: name }])"))
  check('新建分支走 dock 的写类 op', composer.includes("invoke('dock', ['git-branch-create', { branch: name }])"))
  check('失败写进输入区下面那行 fault（不是静默）', composer.includes('setFault(wouldOverwrite(text) ?') && composer.includes('右侧栏「变更」页签可以提交'))
  check('四颗旋钮的浮层互斥（开一颗收掉另外三颗）', (composer.match(/setBranchOpen\(false\)/g) ?? []).length >= 4)

  // CSS：新加的规则只用 --dsc-* 令牌（拼错的幽灵令牌会静默透明）
  const gitCss = shellCss.slice(shellCss.indexOf('.composer-git'), shellCss.indexOf('.git-create button:disabled'))
  check('新加的样式在壳的 styles.css 里（不是硬编码色值）', gitCss.includes('.composer-git') && gitCss.includes('.model-pop.git-pop'))
  // 令牌表在 legacy/tokens.css：把壳那一摞 CSS 合起来查，差集里的就是幽灵。
  const allCss = ['styles.css', 'legacy/tokens.css', 'legacy/base.css', 'legacy/primitives.css', 'legacy/views.css']
    .map((file) => read(`ui-shell/src/${file}`))
    .join('\n')
  const ghost = [...gitCss.matchAll(/var\((--dsc-[a-z0-9-]+)/g)]
    .map((match) => match[1])
    .filter((token, index, all) => all.indexOf(token) === index)
    .filter((token) => !allCss.includes(`${token}:`))
  check('样式里没有幽灵令牌（每个 var 都在令牌表里定义过）', ghost.length === 0, ghost.join('、'))
  check('菜单在输入框**左端**展开（右缘对齐会探出窗口）', /\.model-pop\.git-pop \{[^}]*left: 0[^}]*right: auto/.test(shellCss))
}

// ── [3] op 分档与审批文案（真读宿主常量）────────────────────────────────────────
console.log('[3] op 分档：切 / 建过审批，清单直接放行')
{
  const { DOCK_READ_OPS, DOCK_WRITE_OPS, DOCK_WRITE_LABEL } = await import('../lib/core/dock-ops.js')
  check('git-branches 是读类（界面通道直接放行）', DOCK_READ_OPS.includes('git-branches'))
  check('git-checkout 是写类（过审批）', DOCK_WRITE_OPS.includes('git-checkout'))
  check('git-branch-create 是写类（过审批）', DOCK_WRITE_OPS.includes('git-branch-create'))
  check('切换的卡片文案写清了切到哪条', DOCK_WRITE_LABEL['git-checkout'].toolName === 'git: 切换分支' && DOCK_WRITE_LABEL['git-checkout'].summary({ branch: 'feat/x' }) === '切到 feat/x')
  check('新建的卡片文案写清了新建哪条', DOCK_WRITE_LABEL['git-branch-create'].summary({ branch: 'feat/x' }) === '新建并切到 feat/x')
  check('没给分支名时卡片也说得清（不留空）', DOCK_WRITE_LABEL['git-checkout'].summary({}) === '切到 （没有指定分支名）')
}

// ── [4] 宿主侧：三个 op 都真接了（desktop-dock 的 switch 分支）────────────────────────
console.log('[4] 宿主 desktop-dock 的三个 op')
{
  const dock = read('src/plugins/desktop-dock.ts')
  check('git-branches 真有实现（for-each-ref refs/heads）', dock.includes("case 'git-branches':") && dock.includes("'for-each-ref'"))
  check('git-checkout 真有实现（switch --no-guess，避开 checkout 的分支/路径歧义）', dock.includes("case 'git-checkout':") && dock.includes("'switch', '--no-guess'"))
  check('git-branch-create 真有实现（switch -c）', dock.includes("case 'git-branch-create':") && dock.includes("'-c'"))
  check('写类落盘后催一拍 git 读数（那颗钮当场跟上）', dock.includes("if (write) ctx.get('git')?.refresh()"))
  const gitPlugin = read('src/plugins/git.ts')
  check('快照面登记为 surfaces.git（一片轻读：分支 + 改动条数）', gitPlugin.includes("ctx.surfaces.register('git'") && gitPlugin.includes("['status', '--porcelain=v1', '-z']"))
  check('「没人看就不拍」：只在这片最近被读过时才跑 git', gitPlugin.includes('const INTEREST_MS') && gitPlugin.includes('if (Date.now() - lastReadAt > INTEREST_MS)'))
  check('事件催拍：回合收工 + 换会话', gitPlugin.includes("ctx.on('dsc/turn-end', refresh)") && gitPlugin.includes("ctx.on('dsc/session-open', refresh)"))
}

if (failures === 0) {
  console.log('\n全部通过')
} else {
  console.log(`\n${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
