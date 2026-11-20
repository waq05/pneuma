/**
 * `core/git-info.ts` 的缺口补齐：回合首尾快照、git 兜底改动清单、分支/提交候选。
 *
 * 已有 `git-info.int.spec.ts`（integration 层）钉的是 `/review` 主链路与账本；这里只补它
 * 没走到的那几条：`snapshotGitStatus`（回合快照）、`collectGitTurnChanges`（轮尾兜底）、
 * `listReviewBranches` / `listReviewCommits`（候选清单）。
 *
 * ## 夹具口径
 *
 * 全部用真 git 仓库：`collectGitTurnChanges` 的基线靠 `git show HEAD:<path>` 取，改成一坨假
 * 字符串就证明不了「它真的按 HEAD 版本算差异」。仓库建在 `createTempDir()` 里，`DSC_HOME`
 * 也换到临时目录（`collectReviewScope` 的落盘会用到，本文件里只保证不碰真实 `~/.dsc`）。
 *
 * `collectGitTurnChanges` 的 before/after 直接用**手写 porcelain 行**：真实世界里这两份快照
 * 来自两次 `git status`，而它只认字符串，手写才能点名单行、删除、rename、带引号路径这些分支。
 *
 * @module dsc/core/w13-git-info-extra.spec
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'

const HOME = createTempDir('dsc-w13-git-info-')
process.env['DSC_HOME'] = HOME

type GitInfo = typeof import('./git-info.js')
let gi: GitInfo
/** 一个提交过内容的真仓库；各 describe 内部再按需改。 */
let repo = ''

beforeAll(async () => {
  gi = await import('./git-info.js')
  repo = join(HOME, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-b', 'main')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init')
}, 30_000)

/** 在指定目录跑一条 git 命令。 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** 提交当前工作区（临时身份：CI 上没有全局 git 配置）。 */
function commitAll(cwd: string, message: string): void {
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message)
}

/** 建一个「已跟踪文件 + 一次提交」的新仓库，返回路径。 */
function initRepoWith(files: Record<string, string>, message = 'add files'): string {
  const dir = join(HOME, `repo-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init')
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body, 'utf8')
  commitAll(dir, message)
  return dir
}

describe('snapshotGitStatus：回合起点的 git 快照', () => {
  test('普通目录（不是 git 仓库）返回 null，不抛', async () => {
    const plain = join(HOME, 'not-a-repo')
    mkdirSync(plain, { recursive: true })
    expect(await gi.snapshotGitStatus(plain)).toBeNull()
  })

  test('git 仓库：给出仓库根与 porcelain 行（改动与未跟踪都在）', async () => {
    const dir = initRepoWith({ 'a.txt': 'one\n' })
    writeFileSync(join(dir, 'a.txt'), 'one changed\n', 'utf8')
    writeFileSync(join(dir, 'fresh.txt'), 'new\n', 'utf8')
    const snap = await gi.snapshotGitStatus(dir)
    expect(snap).not.toBeNull()
    if (snap === null) return
    // git 输出的仓库根可能带正斜杠：按绝对路径比，Windows 下大小写不敏感。
    expect(resolve(snap.root).toLowerCase()).toBe(resolve(dir).toLowerCase())
    expect(snap.lines.some((line) => line.includes('a.txt'))).toBe(true)
    expect(snap.lines.some((line) => line.includes('fresh.txt'))).toBe(true)
  })

  test('git 跑不动（cwd 不存在）返回 null，不把回合本身带崩', async () => {
    expect(await gi.snapshotGitStatus(join(HOME, 'definitely-missing-dir', 'x'))).toBeNull()
  })
})

describe('collectGitTurnChanges：对比回合首尾', () => {
  let dir = ''

  beforeAll(() => {
    dir = initRepoWith({ 'tracked.txt': 'one\ntwo\n' })
  }, 30_000)

  test('快照缺失或仓库根变了：一条都不补', async () => {
    expect(await gi.collectGitTurnChanges(dir, null, { root: dir, lines: [] }, [])).toEqual([])
    expect(await gi.collectGitTurnChanges(dir, { root: dir, lines: [] }, null, [])).toEqual([])
    expect(await gi.collectGitTurnChanges(dir, { root: dir, lines: [] }, { root: join(dir, 'elsewhere'), lines: [] }, [])).toEqual([])
  })

  test('已跟踪文件：基线取 HEAD 版本，状态改为 modified', async () => {
    writeFileSync(join(dir, 'tracked.txt'), 'one\nTWO!\n', 'utf8')
    const changes = await gi.collectGitTurnChanges(
      dir,
      { root: dir, lines: [' M tracked.txt'] },
      { root: dir, lines: ['MM tracked.txt'] },
      [],
    )
    const entry = changes.find((item) => item.path.endsWith('tracked.txt'))
    expect(entry).toBeDefined()
    expect(entry?.status).toBe('modified')
    expect(entry?.added).toBe(1)
    expect(entry?.removed).toBe(1)
    // 基线剥掉了：落盘与事件里只留 hunks（stripBaseline 的作用）。
    expect(entry?.baseline).toBeUndefined()
  })

  test('未跟踪的新文件：基线是空串，状态 added', async () => {
    writeFileSync(join(dir, 'fresh.txt'), 'brand new\n', 'utf8')
    const changes = await gi.collectGitTurnChanges(
      dir,
      { root: dir, lines: [' M tracked.txt'] },
      { root: dir, lines: [' M tracked.txt', '?? fresh.txt'] },
      [],
    )
    const entry = changes.find((item) => item.path.endsWith('fresh.txt'))
    expect(entry?.status).toBe('added')
    expect(entry?.added).toBeGreaterThan(0)
  })

  test('状态没变（回合前就脏着）不补：porcelain 码相同就跳过', async () => {
    const changes = await gi.collectGitTurnChanges(
      dir,
      { root: dir, lines: [' M tracked.txt'] },
      { root: dir, lines: [' M tracked.txt'] },
      [],
    )
    expect(changes).toEqual([])
  })

  test('删除行跳过（盘上没有这个文件，diff 面板也没有删除形态）', async () => {
    const changes = await gi.collectGitTurnChanges(
      dir,
      { root: dir, lines: [] },
      { root: dir, lines: [' D gone.txt', 'D  gone2.txt'] },
      [],
    )
    expect(changes).toEqual([])
  })

  test('write/edit 已经记过的路径跳过（already）', async () => {
    writeFileSync(join(dir, 'already.txt'), 'x\n', 'utf8')
    const changes = await gi.collectGitTurnChanges(
      dir,
      { root: dir, lines: [] },
      { root: dir, lines: ['?? already.txt'] },
      [join(dir, 'already.txt')],
    )
    expect(changes).toEqual([])
  })

  test('读不到当前内容的（porcelain 有、盘上没有）跳过', async () => {
    const changes = await gi.collectGitTurnChanges(
      dir,
      { root: dir, lines: [] },
      { root: dir, lines: ['?? vanished.txt'] },
      [],
    )
    expect(changes).toEqual([])
  })

  test('rename 取 new 一侧；带引号的路径去掉引号；坏行忽略', async () => {
    writeFileSync(join(dir, 'renamed.txt'), 'new body\n', 'utf8')
    writeFileSync(join(dir, 'sp ace.txt'), 'space body\n', 'utf8')
    const changes = await gi.collectGitTurnChanges(
      dir,
      { root: dir, lines: ['x', ' M tracked.txt'] },
      { root: dir, lines: ['R  old.txt -> renamed.txt', '?? "sp ace.txt"'] },
      [],
    )
    const paths = changes.map((item) => item.path.replaceAll('\\', '/').toLowerCase())
    expect(paths.some((path) => path.endsWith('/renamed.txt'))).toBe(true)
    expect(paths.some((path) => path.endsWith('/sp ace.txt'))).toBe(true)
  })
})

describe('listReviewBranches / listReviewCommits：审查候选', () => {
  let dir = ''

  beforeAll(() => {
    dir = initRepoWith({ 'a.txt': '1\n' }, 'first')
    writeFileSync(join(dir, 'b.txt'), '2\n', 'utf8')
    commitAll(dir, 'second subject')
    git(dir, 'branch', 'feature-x')
  }, 30_000)

  test('分支清单：本地分支都列出来', async () => {
    const branches = await gi.listReviewBranches(dir)
    expect(branches).toContain('main')
    expect(branches).toContain('feature-x')
  })

  test('不是 git 仓库：分支清单给空数组（用户仍可手填）', async () => {
    const plain = join(HOME, 'plain-branches')
    mkdirSync(plain, { recursive: true })
    expect(await gi.listReviewBranches(plain)).toEqual([])
  })

  test('提交清单：sha + subject 成对，最近的在前', async () => {
    const commits = await gi.listReviewCommits(dir)
    expect(commits.length).toBeGreaterThan(0)
    expect(commits[0]?.subject).toBe('second subject')
    expect(commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('不是 git 仓库：提交清单给空数组', async () => {
    const plain = join(HOME, 'plain-commits')
    mkdirSync(plain, { recursive: true })
    expect(await gi.listReviewCommits(plain)).toEqual([])
  })
})
