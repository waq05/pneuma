/**
 * /review 的「先选范围、读完整 diff」自检（T45）。
 *
 * 钉的是五件事，全部在临时目录里跑，绝不碰真实的 `~/.dsc` 与当前仓库：
 *   1. 三种范围（未提交改动 / 对比基准分支 / 某次提交）各自取到什么；
 *   2. 大 diff 不再截断——落盘文件的字节数要大于旧实现的 6 万字符阈值；
 *   3. 非 git 目录返回 null；
 *   4. 任务书里必须有范围、落盘路径、改动清单、关注点；
 *   5. 审查记录账本：无记录时 status=null、不在跑时 cancel=false、取消与收工各写什么、
 *      换一个实例（模拟重启）还读不读得回来。
 *
 * 运行：pnpm build && node scripts/review-scope-test.mjs
 *
 * @module dsc/scripts/review-scope-test
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// diff 落盘走 DSC_HOME，而 core/path-policy 在模块加载时就把这个值读死了；本进程内再改环境
// 变量已经晚了（模块缓存）。所以先设一个临时 HOME 重新跑一遍自己，子进程里 DSC_HOME 有值。
if (process.env['DSC_HOME'] === undefined) {
  const home = mkdtempSync(join(tmpdir(), 'dsc-review-home-'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, DSC_HOME: home },
  })
  rmSync(home, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}

const {
  assertReviewRef,
  collectReviewScope,
  reviewTaskText,
  reviewStatusText,
  ReviewJournal,
  REVIEW_CANCELED_TEXT,
} = await import('../lib/core/git-info.js')

let failures = 0
/** 断言一条：名字写清「期望什么」，失败时把实测值带出来。 */
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsc-review-scope-'))
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const commit = (cwd, message) =>
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', message)

console.log('范围取数（collectReviewScope）')

// ── 1. 未提交改动：完整 diff 落盘，字节数超过旧截断阈值 ──
const big = join(root, 'big')
mkdirSync(big)
git(big, 'init', '-b', 'main')
commit(big, 'init')
// 2000 行、每行 50 来个字符：整篇替换后的 diff 远超 7 万字符（旧实现会从 6 万处截断）
const before = Array.from({ length: 2000 }, (_, at) => `line ${String(at)} ${'x'.repeat(40)}`)
writeFileSync(join(big, 'big.txt'), `${before.join('\n')}\n`, 'utf8')
git(big, 'add', '.')
commit(big, 'add big')
const after = before.map((line, at) => `line ${String(at)} CHANGED ${'y'.repeat(40)}`)
writeFileSync(join(big, 'big.txt'), `${after.join('\n')}\n`, 'utf8')

const worktreeScope = await collectReviewScope(big, { kind: 'worktree' }, 'session-under-test')
check('未提交改动范围返回取数结果', worktreeScope !== null)
if (worktreeScope !== null) {
  const landed = readFileSync(worktreeScope.diffPath, 'utf8')
  check('diff 落盘文件存在且字节数与 diffBytes 一致', existsSync(worktreeScope.diffPath) && statSync(worktreeScope.diffPath).size === worktreeScope.diffBytes, `${String(worktreeScope.diffBytes)} 字节`)
  check('落盘 diff 大于旧截断阈值 60000 字符（不再截断）', worktreeScope.diffBytes > 70_000, `${String(worktreeScope.diffBytes)} 字节`)
  check('落盘 diff 首尾都在（不是只留开头）', landed.includes('line 0 CHANGED') && landed.includes('line 1999 CHANGED'))
  check('改动清单里列出被改的文件', worktreeScope.stat.includes('big.txt'), worktreeScope.stat.slice(0, 120))
  check('范围标签是「未提交改动」', worktreeScope.label === '未提交改动', worktreeScope.label)
}

// ── 2. 对比基准分支：先算共同祖先，再按祖先取 diff ──
const repo = join(root, 'repo')
mkdirSync(repo)
git(repo, 'init', '-b', 'main')
writeFileSync(join(repo, 'base.txt'), 'v1\n', 'utf8')
git(repo, 'add', '.')
commit(repo, 'init')
const first = git(repo, 'rev-parse', 'HEAD')
git(repo, 'checkout', '-b', 'feature')
writeFileSync(join(repo, 'feature.txt'), 'feature change\n', 'utf8')
git(repo, 'add', '.')
commit(repo, 'add feature')
const featureCommit = git(repo, 'rev-parse', 'HEAD')
// 基准分支从共同祖先另开一条：它自己也有改动，但那部分不该进 feature 的审查
git(repo, 'checkout', '-b', 'release', first)
writeFileSync(join(repo, 'base.txt'), 'base only\n', 'utf8')
git(repo, 'add', '.')
commit(repo, 'base branch change')
git(repo, 'checkout', 'feature')

const baseScope = await collectReviewScope(repo, { kind: 'base', ref: 'release' })
check('对比基准分支返回取数结果', baseScope !== null)
if (baseScope !== null) {
  const landed = readFileSync(baseScope.diffPath, 'utf8')
  check('算出共同祖先（merge-base）', baseScope.base === first, `${String(baseScope.base)} vs ${first}`)
  check('diff 含本分支的改动', landed.includes('+feature change'))
  check('diff 不含基准分支自己的改动（对比的是共同祖先，不是分支尖）', !landed.includes('+base only'), landed.slice(0, 400))
  check('范围标签写明基准分支与共同祖先', baseScope.label.includes('release') && baseScope.label.includes('共同祖先'), baseScope.label)
}

// ── 3. 审查某次提交：按提交取它改了什么 ──
const commitScope = await collectReviewScope(repo, { kind: 'commit', ref: featureCommit, title: 'add feature' })
check('某次提交返回取数结果', commitScope !== null)
if (commitScope !== null) {
  const landed = readFileSync(commitScope.diffPath, 'utf8')
  check('diff 就是这个提交的改动', landed.includes(featureCommit) && landed.includes('+feature change'))
  check('范围标签写提交 SHA 与标题', commitScope.label.includes(featureCommit.slice(0, 10)) && commitScope.label.includes('add feature'), commitScope.label)
}

// ── 4. 非 git 目录 → null ──
const plain = join(root, 'plain')
mkdirSync(plain)
check('非 git 目录返回 null', (await collectReviewScope(plain, { kind: 'worktree' })) === null)

// ── 5. 任务书：范围、落盘路径、清单、关注点 ──
if (worktreeScope !== null) {
  const task = reviewTaskText(worktreeScope, '只看安全')
  check('任务书带范围', task.includes('未提交改动'))
  check('任务书带落盘路径与读法', task.includes(worktreeScope.diffPath) && task.includes('offset'))
  check('任务书带改动清单', task.includes('## 改动清单') && task.includes('big.txt'))
  check('任务书带关注点', task.includes('## 关注点') && task.includes('只看安全'))
  check('没有关注点时不留空段', !reviewTaskText(worktreeScope, '').includes('## 关注点'))
  check('任务书给 P0–P3 分级与整体结论', task.includes('### [P0]') && task.includes('整体结论：可提交'))
}

// 自定义要求：要求本身进任务书，diff 仍按未提交改动取
const customScope = await collectReviewScope(repo, { kind: 'custom', instructions: '只看接口兼容性' })
check('自定义要求范围带要求原文', customScope !== null && reviewTaskText(customScope, '').includes('只看接口兼容性'))

console.log('状态回看（reviewStatusText / ReviewJournal）')

// ── 6. 没有记录时的文案 ──
check('/review-status 无记录文案', reviewStatusText(null) === '还没有审查记录。', reviewStatusText(null))

// ── 7. 账本边界：没有在跑时 cancel=false、status=null ──
const home = join(root, 'journal-home')
const journal = new ReviewJournal(home)
check('没有记录时 status 为 null', journal.status('s1') === null)
check('没有在跑时 cancel 返回 false', journal.cancel('s1') === false)

// ── 8. 派出去 → 取消 → 收工 → 重启读回 ──
journal.begin('s1', { target: '未提交改动', handle: 'reviewer-1' })
check('派出去之后 status 是 running', journal.status('s1')?.state === 'running')
check('在跑的记录里有队友名（取消要靠它）', journal.running('s1')?.handle === 'reviewer-1')
const runningText = reviewStatusText(journal.status('s1'))
check('running 的文案提示可以取消', runningText.includes('审查进行中') && runningText.includes('/review-cancel'))
journal.cancel('s1')
check('取消后记录变 finished 且写「审查被取消」', journal.status('s1')?.state === 'finished' && journal.status('s1')?.findings === REVIEW_CANCELED_TEXT)
journal.finish('s1', '这段收工结论不该覆盖取消')
check('收工不把取消结论覆盖掉', journal.status('s1')?.findings === REVIEW_CANCELED_TEXT)
const reloaded = new ReviewJournal(home)
check('换一个账本实例（模拟重启）还能读回记录', reloaded.status('s1')?.findings === REVIEW_CANCELED_TEXT && reloaded.status('s1')?.state === 'finished')

// ── 9. 正常收工：findings 落盘，且状态文案带结论 ──
journal.begin('s2', { target: '提交 abc1234567 修一个空指针', handle: 'reviewer-2' })
journal.finish('s2', '## 结论\n整体结论：可提交')
const finished = new ReviewJournal(home).status('s2')
check('收工记录落盘且字段完整', finished?.state === 'finished' && finished.target.includes('abc1234567') && finished.findings === '## 结论\n整体结论：可提交')
check('收工后的状态文案带范围与结论', reviewStatusText(finished).includes('审查已完成') && reviewStatusText(finished).includes('整体结论：可提交'))
check('收工之后再取消仍是 false', new ReviewJournal(home).cancel('s2') === false)

// ── 10. 同一会话叠两次：旧那次收工不该把新那次的状态说成已完成 ──
journal.begin('s3', { target: '第一次', handle: 'reviewer-3' })
journal.begin('s3', { target: '第二次', handle: 'reviewer-4' })
journal.finish('s3', '第一次的结论', 'reviewer-3')
check('旧的一次收工不改新一次的状态', journal.status('s3')?.state === 'running' && journal.status('s3')?.target === '第二次')
journal.finish('s3', '第二次的结论', 'reviewer-4')
check('新那次收工照常落记录', journal.status('s3')?.state === 'finished' && journal.status('s3')?.findings === '第二次的结论')

// ── 11. 引用校验：用户填的 ref 不许变成 git 选项 ──
// `/review` 的「某次提交 / 基准分支」是自由输入，`--output=<路径>` 这种值会被 git 当选项
// 执行（把补丁写进任意文件）；execFile 没有 shell 也挡不住选项注入。
console.log('引用校验（assertReviewRef）')
check('正常分支名放行', assertReviewRef('main') === 'main')
check('正常 SHA 放行', assertReviewRef('abc1234') === 'abc1234')
check('rev 语法放行（HEAD~2）', assertReviewRef('HEAD~2') === 'HEAD~2')
const rejectOf = (ref) => {
  try {
    assertReviewRef(ref)
    return ''
  } catch (error) {
    return String(error?.message ?? error)
  }
}
check('--output 选项被拒', rejectOf('--output=D:/tmp/x.diff') !== '')
check('短横线开头的引用被拒', rejectOf('-n') !== '')
check('带空格的注入串被拒', rejectOf('main --output=x') !== '')
check('空引用被拒', rejectOf('   ') !== '')

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exit(failures === 0 ? 0 : 1)
