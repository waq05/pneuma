/**
 * @pneuma/superagent 工作树适配的包级测试：钉住「建 / 复用 / 恢复 / 列出 / 清理 / slug」六条不变量。
 *
 * 为什么是这六条：这层一旦错，错的不是报错，而是**改动落在了哪儿**——
 * 目录复用了却没验证，智能体会改在普通目录里；恢复时用了 `-B`，上次的提交静默消失；
 * 删目录时多删一层，用户的主工作区就没了。所以每条都真造一个临时仓库跑真 git，
 * 不拿 mock 替。
 *
 * 全程 `tmpdir()` + `mkdtemp`，且每个用例一份仓库、一个工作树根：绝不碰用户真实的
 * `~/.dsc`，也不改用户的全局 git 配置（身份用仓库局部 `git config` 设，CI 里才有提交可用）。
 *
 * 迁移说明：原文件 import `lib/` 构建产物；现在直接 import 源码，不再要求先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { ensureWorktree, listWorktrees, removeWorktree, slugOf } from '../adapters/worktree.js'

const roots: string[] = []

/**
 * 跑测试用的 git：剥掉继承来的 `GIT_*`。
 *
 * 不剥的话，开发者 shell 里设过 `GIT_DIR`（自己在用 worktree 时很常见）会让这些命令
 * 全落到别的仓库——测试就会在别人的工作区上跑，甚至改到别人的分支。
 */
const cleanEnv: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (key.toUpperCase().startsWith('GIT_') || value === undefined) continue
  cleanEnv[key] = value
}

/** 跑一次 git，返回 stdout。 */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 造一个能提交的临时仓库：`worktree add` 至少要有一次提交，否则没有 HEAD 可当起点。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-worktree-repo-'))
  roots.push(dir)
  git(dir, ['init', '-q'])
  // 只写这个仓库的局部配置：不设的话 CI 里提交会因缺身份直接失败。
  git(dir, ['config', 'user.email', 'superagent-test@example.com'])
  git(dir, ['config', 'user.name', 'Superagent Test'])
  writeFileSync(join(dir, 'README.md'), '# worktree probe\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

/** 单独一个工作树根目录：放在仓库外面，模拟 `<DSC_HOME>/superagent/worktrees/`。 */
function makeRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `superagent-worktree-${label}-`))
  roots.push(dir)
  return dir
}

/** 路径比较的规范形：git 报的是正斜杠、Windows 大小写不敏感，直接比字符串会假失败。 */
function samePath(a: string, b: string): boolean {
  const norm = (value: string): string => {
    const absolute = resolve(value).replace(/\\/g, '/')
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return norm(a) === norm(b)
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('1. 建出目录与分支：created 为 true，HEAD 在 agent/<slug> 上', () => {
  const repo = makeRepo()
  const root = makeRoot('create')
  const handle = ensureWorktree({ repo, name: 'fix login copy', root })

  expect(handle.created).toBe(true)
  expect(handle.path).toBe(join(root, 'fix-login-copy'))
  expect(handle.branch).toBe('agent/fix-login-copy')
  expect(existsSync(handle.path), '工作树目录应当存在').toBe(true)
  // 分支真被 checkout 出来了，而不只是名字对：git 自己说的话才算数。
  expect(git(handle.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('agent/fix-login-copy')
})

test('2. 再调一次：目录已存在就复用，created 为 false、不报错、路径不变', () => {
  const repo = makeRepo()
  const root = makeRoot('reuse')
  const first = ensureWorktree({ repo, name: 'fix login copy', root })
  // 在里面放一个未跟踪文件：如果实现又跑了一次 add/checkout，这个文件会消失或报错。
  const marker = join(first.path, 'keep.txt')
  writeFileSync(marker, 'still here\n')

  const second = ensureWorktree({ repo, name: 'fix login copy', root })

  expect(second.created).toBe(false)
  expect(second.path).toBe(first.path)
  expect(second.branch).toBe(first.branch)
  expect(readFileSync(marker, 'utf8')).toBe('still here\n')
})

test('3. 目录删了但分支还在：重新 add 回来，分支上的提交还在', () => {
  const repo = makeRepo()
  const root = makeRoot('restore')
  const first = ensureWorktree({ repo, name: 'restore me', root })
  // 在这个工作树里真提交一次，拿它的 sha 当判据。
  writeFileSync(join(first.path, 'work.txt'), 'agent change\n')
  git(first.path, ['add', 'work.txt'])
  git(first.path, ['commit', '-q', '-m', 'work commit'])
  const sha = git(first.path, ['rev-parse', 'HEAD']).trim()

  // 模拟用户手工 rm -rf：git 的 `.git/worktrees/<name>` 登记还在，这是一条真实会遇到的路径。
  rmSync(first.path, { recursive: true, force: true })
  expect(existsSync(first.path)).toBe(false)

  const again = ensureWorktree({ repo, name: 'restore me', root })

  expect(again.created, '目录没了要重新 add，不是复用').toBe(true)
  expect(again.path).toBe(first.path)
  // 用 `-B` 的话这里会回到 init 那个提交，sha 与文件都对不上。
  expect(git(again.path, ['rev-parse', 'HEAD']).trim()).toBe(sha)
  // 只断言内容，不逐字节比换行：Windows 上 `core.autocrlf` 会把 checkout 出来的文件转成 CRLF。
  expect(readFileSync(join(again.path, 'work.txt'), 'utf8')).toMatch(/agent change/)
})

test('4. listWorktrees：主工作区与新工作树都在，分支名去掉 refs/heads/', () => {
  const repo = makeRepo()
  const root = makeRoot('list')
  const handle = ensureWorktree({ repo, name: 'list me', root })

  const entries = listWorktrees(repo)

  expect(entries.length).toBe(2)
  expect(entries.some((entry) => samePath(entry.path, repo)), '主工作区也要列出来').toBe(true)
  const added = entries.find((entry) => entry.branch === 'agent/list-me')
  expect(added, '新工作树的分支应当是 agent/list-me').toBeDefined()
  expect(samePath(added?.path ?? '', handle.path)).toBe(true)
  // porcelain 里是 `branch refs/heads/agent/list-me`，解析后不该留着前缀。
  expect(entries.every((entry) => entry.branch === undefined || !entry.branch.startsWith('refs/heads/'))).toBe(true)
})

test('5. removeWorktree：目录消失、listWorktrees 里也没有（再清一次不报错）', () => {
  const repo = makeRepo()
  const root = makeRoot('remove')
  const handle = ensureWorktree({ repo, name: 'remove me', root })

  removeWorktree({ repo, path: handle.path })

  expect(existsSync(handle.path), '清理后目录应当消失').toBe(false)
  expect(listWorktrees(repo).some((entry) => samePath(entry.path, handle.path))).toBe(false)
  // 清理按钮被点两下是常事：第二次只当「已经清过」，不该抛。
  expect(() => removeWorktree({ repo, path: handle.path })).not.toThrow()
})

test('6. slugOf：全中文、带空格、带 /、带 ..、超长都安全', () => {
  // 全中文是本插件最常见的输入：没有音译，只能折成空串后兜底。
  expect(slugOf('改登录页文案')).toBe('ticket')
  expect(slugOf('fix login copy')).toBe('fix-login-copy')
  expect(slugOf('a/b/c')).toBe('a-b-c')

  // `..\..\x`（反斜杠在 Windows 上就是路径分隔符）：绝不能留下上跳或隐藏目录的写法。
  const traversal = slugOf('..\\..\\x')
  expect(traversal.startsWith('.'), `不能以点开头：${traversal}`).toBe(false)
  expect(traversal.includes('..'), `不能含 ..：${traversal}`).toBe(false)
  expect(traversal).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

  // 超长：截到 60，且截断后不能留下尾部的 - 或 .（分支名与目录名都不许这么结尾）。
  const long = slugOf('x'.repeat(200))
  expect(long).toBe('x'.repeat(60))
  expect(slugOf(`fix ${'y'.repeat(200)}`).length).toBe(60)
  expect(/[-.]$/.test(slugOf(`fix ${'y'.repeat(200)}`))).toBe(false)

  // 几个边界：只有符号、开头的点、连续的 .. 与 -。
  expect(slugOf('')).toBe('ticket')
  expect(slugOf('...')).toBe('ticket')
  expect(slugOf('.hidden')).toBe('hidden')
  expect(slugOf('fix..copy')).toBe('fix.copy')
  expect(slugOf('--fix--copy--')).toBe('fix-copy')
})
