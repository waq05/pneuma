/**
 * `core/git-info.ts` 的缺口补齐：超大 diff 的读数提示、改动的基线在 HEAD 里取不到时退回空串。
 *
 * 用真 git 仓库（临时目录）：20 MB 以上 diff 这条只有真跑 `git diff` 才证明得了「阈值之后
 * 真的多写了一句话」；`DSC_HOME` 指到临时目录（diff 落盘会用到）。
 *
 * @module dsc/core/w14b-git-info-edges.spec
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-git-'))
process.env['DSC_HOME'] = HOME

type Gi = typeof import('./git-info.js')
let gi: Gi

beforeAll(async () => {
  gi = await import('./git-info.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

/** 在指定目录跑一条 git 命令。 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** 建一个提交过内容的真仓库。 */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(HOME, 'repo-'))
  git(dir, 'init', '-b', 'main')
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init')
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body, 'utf8')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'files')
  return dir
}

describe('collectReviewScope：超大 diff 的读数提示', () => {
  test('diff 超过 20 MB：改动清单末尾补一句「分批读」', async () => {
    const line = 'x'.repeat(11 * 1024 * 1024)
    const dir = repo({ 'huge.txt': `${line}\n` })
    // 改一整行：diff 里同时有 -11MB 与 +11MB 两条，稳稳超过 20 MB。
    writeFileSync(join(dir, 'huge.txt'), `${line}y\n`, 'utf8')
    const scope = await gi.collectReviewScope(dir, { kind: 'worktree' }, 'w14b-huge')
    expect(scope).not.toBeNull()
    if (scope === null) return
    expect(scope.diffBytes).toBeGreaterThan(20 * 1024 * 1024)
    expect(scope.stat).toContain('diff 很大')
    expect(scope.stat).toContain('offset/limit')
  }, 60_000)
})

describe('collectGitTurnChanges：基线在 HEAD 里取不到', () => {
  test('状态码变了但 HEAD 里没有这个路径：基线按空串算，条目仍然补出来', async () => {
    const dir = repo({ 'seed.txt': 'seed\n' })
    // 回合开始时它是「已跟踪的修改」，但 HEAD 里根本没有这个路径（手写 porcelain 才造得出）。
    writeFileSync(join(dir, 'late.txt'), 'late body\n', 'utf8')
    const changes = await gi.collectGitTurnChanges(
      dir,
      { root: dir, lines: [' M late.txt'] },
      { root: dir, lines: ['MM late.txt'] },
      [],
    )
    const entry = changes.find((item) => item.path.endsWith('late.txt'))
    expect(entry).toBeDefined()
    expect(entry?.status).toBe('added')
    expect(entry?.added).toBeGreaterThan(0)
  })
})
