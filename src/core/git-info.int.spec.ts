/**
 * `/review` 的范围取数、任务书与状态账本（integration 层，原
 * `scripts/review-scope-test.mjs` 全部 + `scripts/review-approval-test.mjs` 第 7–9 段）。
 *
 * ## 这一层为什么不是 unit
 *
 * 被测的每个函数都要**真 git 仓库**：`collectReviewScope` 跑 `git diff HEAD` / `git merge-base`
 * / `git show`，`writeReviewDiff` 把几十万字节落进 `<数据目录>/cache/review/`。用假 git 或
 * 读源码文本都证明不了「用户点 /review 时队友拿到的 diff 到底是哪一段」——那正是这条功能
 * 唯一的输出。所以这里建四个临时仓库（工作区 / 大 diff / 基准分支 / 提交），断言落盘文件本身。
 *
 * ## 与 unit 层 `src/core/unified-diff.spec.ts` 的分工
 *
 * 那边的 20 条验的是解析器本身（构造文本、行号、CRLF、rename）。这里不重复那些输入，
 * 只在一段**真 `git diff` 的输出**上走一遍 `splitUnifiedDiffByFile`：真 git 会带
 * `index` 行、`---`/`+++` 头、按文件分段，形状与手写夹具不完全一样。
 *
 * ## 隔离
 *
 * HOME 由 integration 层的 `tests/setup/temp-home.ts` 提供（`DSC_HOME` 随之落在临时目录），
 * diff 落盘与账本记录都写在里面，真实 `~/.dsc` 不碰；仓库与账本目录建在系统临时目录下。
 *
 * @module dsc/core/git-info.int.spec
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  assertReviewRef,
  collectReviewScope,
  ReviewJournal,
  reviewStatusText,
  reviewTaskText,
  REVIEW_CANCELED_TEXT,
} from './git-info.js'
import { splitUnifiedDiffByFile } from './unified-diff.js'

/** 本文件的临时根目录：四组夹具各占一个子目录，互不影响。 */
let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsc-git-info-int-'))
})

/** 在指定目录跑一条 git 命令，返回去掉首尾空白的输出。 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** 提交一次（-c 给临时身份：CI 上没有全局 git 配置）。 */
function commit(cwd: string, message: string): string {
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** 建一个空仓库并提交一次初始空提交，返回路径。 */
function initRepo(name: string): string {
  const cwd = join(root, name)
  mkdirSync(cwd, { recursive: true })
  git(cwd, 'init', '-b', 'main')
  commit(cwd, 'init')
  return cwd
}

describe('collectReviewScope：不是 git 仓库就返回 null', () => {
  test('普通目录返回 null（不是抛错，/review 据此提示「这里没有 git」）', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(await collectReviewScope(plain, { kind: 'worktree' })).toBeNull()
  })
})

describe('collectReviewScope：未提交改动', () => {
  let repo: string
  let landed = ''
  let scope: Awaited<ReturnType<typeof collectReviewScope>>

  beforeAll(async () => {
    repo = initRepo('worktree')
    writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n', 'utf8')
    git(repo, 'add', '.')
    commit(repo, 'add tracked')
    writeFileSync(join(repo, 'tracked.txt'), 'one\nTWO!\n', 'utf8')
    writeFileSync(join(repo, 'fresh.txt'), 'brand new\n', 'utf8')
    scope = await collectReviewScope(repo, { kind: 'worktree' })
    landed = scope === null ? '' : readFileSync(scope.diffPath, 'utf8')
  })

  test('返回取数结果，范围标签是「未提交改动」', () => {
    expect(scope?.label).toBe('未提交改动')
  })

  test('完整 diff 落盘：文件存在，字节数与 diffBytes 一致', () => {
    // 断言落盘文件而不是返回值：队友读的是文件，字节数不准它会按错误的 offset 分批读。
    expect(scope === null ? false : statSync(scope.diffPath).size === scope.diffBytes).toBe(true)
  })

  test('落盘内容就是 git diff HEAD（删一行、加一行）', () => {
    expect(landed).toContain('-two')
    expect(landed).toContain('+TWO!')
  })

  test('stat 给出改动清单', () => {
    expect(scope?.stat).toContain('tracked.txt')
  })

  test('未跟踪文件只列名单、不进 diff', () => {
    expect(scope?.untracked).toEqual(['fresh.txt'])
    expect(landed).not.toContain('brand new')
  })

  test('真 git 输出能被切段器认出来（path/增删数）', () => {
    const files = splitUnifiedDiffByFile(landed)
    expect(files.map((file) => file.path)).toEqual(['tracked.txt'])
    expect(files[0]?.added).toBe(1)
    expect(files[0]?.removed).toBe(1)
  })
})

describe('collectReviewScope：大 diff 不再截断', () => {
  let scope: Awaited<ReturnType<typeof collectReviewScope>>

  beforeAll(async () => {
    const repo = initRepo('big')
    // 2000 行、每行约 50 字符：整篇替换后的 diff 远超旧实现的 60000 字符阈值。
    const before = Array.from({ length: 2_000 }, (_, at) => `line ${String(at)} ${'x'.repeat(40)}`)
    writeFileSync(join(repo, 'big.txt'), `${before.join('\n')}\n`, 'utf8')
    git(repo, 'add', '.')
    commit(repo, 'add big')
    const after = before.map((line, at) => `line ${String(at)} CHANGED ${'y'.repeat(40)}`)
    writeFileSync(join(repo, 'big.txt'), `${after.join('\n')}\n`, 'utf8')
    scope = await collectReviewScope(repo, { kind: 'worktree' })
  })

  test('落盘超过旧截断阈值 60000 字符', () => {
    expect(scope === null ? 0 : scope.diffBytes).toBeGreaterThan(70_000)
  })

  test('首尾都在（不是只留开头）', () => {
    const landed = scope === null ? '' : readFileSync(scope.diffPath, 'utf8')
    expect(landed).toContain('line 0 CHANGED')
    expect(landed).toContain('line 1999 CHANGED')
  })
})

describe('collectReviewScope：对比基准分支按共同祖先取', () => {
  let repo: string
  let firstSha = ''
  let featureSha = ''
  let scope: Awaited<ReturnType<typeof collectReviewScope>>

  beforeAll(async () => {
    repo = initRepo('base')
    writeFileSync(join(repo, 'base.txt'), 'v1\n', 'utf8')
    git(repo, 'add', '.')
    firstSha = commit(repo, 'init base')
    git(repo, 'checkout', '-b', 'feature')
    writeFileSync(join(repo, 'feature.txt'), 'feature change\n', 'utf8')
    git(repo, 'add', '.')
    featureSha = commit(repo, 'add feature')
    // 基准分支从共同祖先另开一条：它自己的改动不该进 feature 的审查。
    git(repo, 'checkout', '-b', 'release', firstSha)
    writeFileSync(join(repo, 'base.txt'), 'base only\n', 'utf8')
    git(repo, 'add', '.')
    commit(repo, 'base branch change')
    git(repo, 'checkout', 'feature')
    scope = await collectReviewScope(repo, { kind: 'base', ref: 'release' })
  })

  test('算出共同祖先（merge-base），不是分支尖', () => {
    expect(scope?.base).toBe(firstSha)
  })

  test('diff 含本分支的改动', () => {
    expect(readFileSync(scope?.diffPath ?? '', 'utf8')).toContain('+feature change')
  })

  test('diff 不含基准分支自己的改动', () => {
    expect(readFileSync(scope?.diffPath ?? '', 'utf8')).not.toContain('+base only')
  })

  test('范围标签写明基准分支与共同祖先', () => {
    expect(scope?.label).toContain('release')
    expect(scope?.label).toContain('共同祖先')
  })

  test('审查某次提交：diff 是那一次，标签写短 SHA 与标题', async () => {
    const commitScope = await collectReviewScope(repo, { kind: 'commit', ref: featureSha, title: 'add feature' })
    const landed = readFileSync(commitScope?.diffPath ?? '', 'utf8')
    expect(landed).toContain(featureSha)
    expect(landed).toContain('+feature change')
    expect(commitScope?.label).toContain(featureSha.slice(0, 10))
    expect(commitScope?.label).toContain('add feature')
  })
})

describe('collectReviewScope：自定义要求也带原文', () => {
  test('自定义范围的标签与任务书都带上用户那句要求', async () => {
    const repo = initRepo('custom')
    const scope = await collectReviewScope(repo, { kind: 'custom', instructions: '只看接口兼容性' })
    expect(scope?.label).toBe('未提交改动（自定义审查要求）')
    expect(reviewTaskText(scope!, '')).toContain('只看接口兼容性')
  })
})

describe('reviewTaskText：队友拿到的任务书', () => {
  let repo: string
  let scope: NonNullable<Awaited<ReturnType<typeof collectReviewScope>>>
  let task = ''

  beforeAll(async () => {
    repo = initRepo('task')
    writeFileSync(join(repo, 'tracked.txt'), 'one\n', 'utf8')
    git(repo, 'add', '.')
    commit(repo, 'add')
    writeFileSync(join(repo, 'tracked.txt'), 'two\n', 'utf8')
    writeFileSync(join(repo, 'fresh.txt'), 'x\n', 'utf8')
    scope = (await collectReviewScope(repo, { kind: 'worktree' }))!
    task = reviewTaskText(scope, '只看安全')
  })

  test('带范围与落盘路径 + 分批读法', () => {
    expect(task).toContain('未提交改动')
    expect(task).toContain(scope.diffPath)
    expect(task).toContain('offset')
  })

  test('带改动清单与未跟踪名单', () => {
    expect(task).toContain('## 改动清单')
    expect(task).toContain('tracked.txt')
    expect(task).toContain('- fresh.txt')
  })

  test('带关注点；没写关注点时不留空段', () => {
    expect(task).toContain('## 关注点')
    expect(task).toContain('只看安全')
    expect(reviewTaskText(scope, '')).not.toContain('## 关注点')
  })

  test('给 P0–P3 分级与整体结论的唯一两种写法', () => {
    expect(task).toContain('### [P0]')
    expect(task).toContain('整体结论：可提交')
    expect(task).toContain('整体结论：需修改后提交')
  })
})

describe('assertReviewRef：用户填的 ref 不许变成 git 选项', () => {
  test('正常分支名、SHA、rev 语法放行', () => {
    expect(assertReviewRef('main')).toBe('main')
    expect(assertReviewRef('abc1234')).toBe('abc1234')
    expect(assertReviewRef('HEAD~2')).toBe('HEAD~2')
  })

  test('--output=… 这类选项注入被拒', () => {
    // 注入成功 = 补丁被写进任意文件；execFile 没有 shell 也挡不住选项注入。
    expect(() => assertReviewRef('--output=D:/tmp/x.diff')).toThrow(/不像一个分支或提交引用/)
  })

  test('短横线开头、带空格的注入串、空值都被拒', () => {
    expect(() => assertReviewRef('-n')).toThrow(/不像一个分支或提交引用/)
    expect(() => assertReviewRef('main --output=x')).toThrow(/不像一个分支或提交引用/)
    expect(() => assertReviewRef('   ')).toThrow(/不像一个分支或提交引用/)
  })
})

describe('ReviewJournal 与 reviewStatusText', () => {
  let home: string

  beforeAll(() => {
    home = join(root, 'journal')
    mkdirSync(home, { recursive: true })
  })

  test('没有记录：状态文案是「还没有审查记录。」', () => {
    expect(reviewStatusText(null)).toBe('还没有审查记录。')
  })

  test('没有记录时 status 为 null、cancel 返回 false', () => {
    const journal = new ReviewJournal(home)
    expect(journal.status('s-empty')).toBeNull()
    expect(journal.cancel('s-empty')).toBe(false)
  })

  test('派出去之后是 running，记录里有队友名，文案提示可取消', () => {
    const journal = new ReviewJournal(home)
    journal.begin('s1', { target: '未提交改动', handle: 'reviewer-1' })
    expect(journal.status('s1')?.state).toBe('running')
    expect(journal.running('s1')?.handle).toBe('reviewer-1')
    const text = reviewStatusText(journal.status('s1'))
    expect(text).toContain('审查进行中')
    expect(text).toContain('/review-cancel')
  })

  test('取消后变 finished 并写「审查被取消」，随后收工不许覆盖它', () => {
    const journal = new ReviewJournal(home)
    journal.begin('s2', { target: '未提交改动', handle: 'reviewer-2' })
    journal.cancel('s2')
    expect(journal.status('s2')?.state).toBe('finished')
    expect(journal.status('s2')?.findings).toBe(REVIEW_CANCELED_TEXT)
    journal.finish('s2', '这段收工结论不该覆盖取消')
    expect(journal.status('s2')?.findings).toBe(REVIEW_CANCELED_TEXT)
  })

  test('换一个账本实例（模拟重启）还能读回记录', () => {
    expect(new ReviewJournal(home).status('s2')?.findings).toBe(REVIEW_CANCELED_TEXT)
  })

  test('正常收工：结论落盘，状态文案带范围与结论；之后再取消仍是 false', () => {
    const journal = new ReviewJournal(home)
    journal.begin('s3', { target: '提交 abc1234567 修一个空指针', handle: 'reviewer-3' })
    journal.finish('s3', '## 结论\n整体结论：可提交')
    const finished = new ReviewJournal(home).status('s3')
    expect(finished?.state).toBe('finished')
    expect(finished?.target).toContain('abc1234567')
    expect(finished?.findings).toBe('## 结论\n整体结论：可提交')
    const text = reviewStatusText(finished)
    expect(text).toContain('审查已完成')
    expect(text).toContain('整体结论：可提交')
    expect(new ReviewJournal(home).cancel('s3')).toBe(false)
  })

  test('同一会话叠两次：旧那次收工不改新那次的状态', () => {
    const journal = new ReviewJournal(home)
    journal.begin('s4', { target: '第一次', handle: 'reviewer-4' })
    journal.begin('s4', { target: '第二次', handle: 'reviewer-5' })
    journal.finish('s4', '第一次的结论', 'reviewer-4')
    expect(journal.status('s4')?.state).toBe('running')
    expect(journal.status('s4')?.target).toBe('第二次')
    journal.finish('s4', '第二次的结论', 'reviewer-5')
    expect(journal.status('s4')?.state).toBe('finished')
    expect(journal.status('s4')?.findings).toBe('第二次的结论')
  })
})
